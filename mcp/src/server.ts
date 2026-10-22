/**
 * An MCP server that gives an AI agent a ValkvEdgeKV database to keep memory
 * in: read, list and write keys, and, with a key that may manage databases,
 * list and create databases. With an encryption key, values are encrypted
 * before they leave this process and the service stores only ciphertext.
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EdgeKVError, type Database, type EdgeKV } from '@valkvlabs/edgekv';
import { z } from 'zod';
import type { Config } from './config.js';

export { configFromEnv, type Config } from './config.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const DATABASE_NAME = /^[a-z][a-z0-9-]{1,47}$/;
const strictText = new TextDecoder('utf-8', { fatal: true });

/** What to do about a failure, for the codes an agent can act on. */
const HINTS: Record<string, string> = {
  NOT_FOUND: 'There is no database by that name (or this key may not reach it). A new database needs a few seconds before it answers.',
  CONDITION_FAILED: 'The key changed since you read it: get it again, and retry with its new version.',
  INVALID_ENCRYPTION_KEY:
    'This value was written without this server’s encryption key, or with another one. Each database should be written either always with the same key or never with one.',
  NAME_CONFLICT: 'A database by that name already exists.',
  FORBIDDEN: 'The API key this server uses is not allowed to do that.',
  WRITE_QUOTA_EXCEEDED: 'The account has used its writes for this month. Reads still work.',
  STORAGE_QUOTA_EXCEEDED: 'The account is over its storage. Deleting keys frees space; reads still work.',
  TRANSFER_QUOTA_EXCEEDED: 'The account has used its transfer for this month.',
  RATE_LIMITED: 'Too many requests: wait a moment and try again.',
  NETWORK: 'The service could not be reached: check EDGEKV_URL and the network.',
  UNAUTHENTICATED: 'The API key was refused: check EDGEKV_API_KEY.',
};

const reply = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

/** A tool's work, with service failures returned to the agent as tool errors it can read. */
async function run(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return reply(await work());
  } catch (error) {
    if (!(error instanceof EdgeKVError)) throw error;
    const hint = HINTS[error.code];
    return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}${hint ? `\n${hint}` : ''}` }] };
  }
}

/** A value as the agent sees it: text, or base64 for bytes that are not text. */
function shown(value: Uint8Array): { value: string } | { value_base64: string } {
  try {
    return { value: strictText.decode(value) };
  } catch {
    return { value_base64: Buffer.from(value).toString('base64') };
  }
}

function instructions(config: Config): string {
  const where = config.database ? `the ValkvEdgeKV database "${config.database}"` : 'ValkvEdgeKV databases';
  const lines = [
    `Memory that lasts between conversations, kept in ${where}.`,
    '- Keys are paths: facts/<topic>, preferences/<name>, tasks/<id>/<step>. List a branch with scan and a prefix before reading keys one by one.',
    '- Values are text. Use JSON for anything structured.',
  ];
  if (!config.readOnly) {
    lines.push(
      '- Each put is one write against the account’s monthly allowance: store several keys at once with put_many.',
      '- To change a value without losing someone else’s change, get it, then put with if_version set to the version you read.',
    );
  }
  lines.push(
    config.encryptionKey
      ? '- Values are encrypted before they leave this machine. Key names are not: keep secrets out of them.'
      : '- Values are stored as sent, not encrypted by this server. Keep secrets out of keys and values.',
  );
  if (config.encryptionKey && !config.readOnly) {
    lines.push(
      '- Only the encryption key can read this memory. Before relying on it, call create_recovery_key once and give the result to the user to keep: if the key is lost without one, the memory is gone.',
    );
  }
  return lines.join('\n');
}

/** The MCP server for `kv`, set up by `config`. Connect it to a transport to use it. */
export function createServer(kv: EdgeKV, config: Config): McpServer {
  const server = new McpServer({ name: 'edgekv', version }, { instructions: instructions(config) });

  const handles = new Map<string, Database>();
  const open = (name: string | undefined): Database => {
    const chosen = config.database ?? name;
    if (!chosen) throw new EdgeKVError('BAD_REQUEST', 'name the database to use', 0);
    let db = handles.get(chosen);
    if (!db) {
      db = kv.database(chosen, config.encryptionKey ? { encryptionKey: config.encryptionKey } : {});
      handles.set(chosen, db);
    }
    return db;
  };

  // With EDGEKV_DATABASE, every tool works on that database and takes no name.
  const database: z.ZodRawShape = config.database
    ? {}
    : { database: z.string().regex(DATABASE_NAME).describe('The database to use.') };
  const key = z.string().min(1).max(1024).describe('The key, written like a path: facts/name, tasks/2026-10-17/step-3.');
  const value = z.string().describe('The value, as text. Use JSON for structured data.');
  type WithDatabase = { database?: string };

  server.registerTool(
    'get',
    {
      title: 'Read a key',
      description: 'Reads the value stored under a key, with its version. Says found: false when there is none.',
      inputSchema: { ...database, key },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args: WithDatabase & { key: string }) =>
      run(async () => {
        const found = await open(args.database).getVersioned(args.key);
        return found ? { key: args.key, found: true, ...shown(found.value), version: found.version } : { key: args.key, found: false };
      }),
  );

  server.registerTool(
    'scan',
    {
      title: 'List keys',
      description:
        'Lists keys in order, with their values, optionally only those starting with a prefix. Returns next_cursor when there are more: pass it back as cursor to continue.',
      inputSchema: {
        ...database,
        prefix: z.string().optional().describe('Only keys that start with this, for example facts/.'),
        limit: z.number().int().min(1).max(200).optional().describe('At most this many entries. Default 50.'),
        cursor: z.string().optional().describe('next_cursor from the previous call, to continue.'),
        values: z.boolean().optional().describe('Include the values. Default true; false lists only keys and versions.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args: WithDatabase & { prefix?: string; limit?: number; cursor?: string; values?: boolean }) =>
      run(async () => {
        const page = await open(args.database).scanPage({ prefix: args.prefix, pageSize: args.limit ?? 50, pageToken: args.cursor });
        const entries = page.items.map((entry) => ({
          key: entry.key,
          ...(args.values === false ? {} : shown(entry.value)),
          ...(entry.version === undefined ? {} : { version: entry.version }),
        }));
        return { entries, next_cursor: page.nextPageToken };
      }),
  );

  if (!config.readOnly) {
    server.registerTool(
      'put',
      {
        title: 'Write a key',
        description:
          'Stores a value under a key, replacing any value it had. Returns once the service has stored it. With if_version, only if the key is still at that version (from get); with if_absent, only if the key has no value. Otherwise it fails with CONDITION_FAILED and writes nothing.',
        inputSchema: {
          ...database,
          key,
          value,
          if_version: z.string().optional().describe('Write only if the key is still at this version.'),
          if_absent: z.boolean().optional().describe('Write only if the key has no value yet.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      (args: WithDatabase & { key: string; value: string; if_version?: string; if_absent?: boolean }) =>
        run(async () => {
          const result = await open(args.database).put(args.key, args.value, {
            ...(args.if_version === undefined ? {} : { ifVersion: args.if_version }),
            ...(args.if_absent ? { ifAbsent: true } : {}),
          });
          return { key: args.key, version: result.version, lsn: result.lsn };
        }),
    );

    server.registerTool(
      'put_many',
      {
        title: 'Write several keys',
        description:
          'Stores several keys in one write: all of them or none. Counts as a single write against the monthly allowance, so prefer it to several puts.',
        inputSchema: {
          ...database,
          entries: z.array(z.object({ key, value })).min(1).max(500).describe('The keys and values to store.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      (args: WithDatabase & { entries: { key: string; value: string }[] }) =>
        run(async () => {
          const result = await open(args.database).commit(args.entries.map((entry) => ({ op: 'put' as const, ...entry })));
          return { written: args.entries.length, versions: result.versions, lsn: result.lsn };
        }),
    );

    if (config.encryptionKey) {
      server.registerTool(
        'create_recovery_key',
        {
          title: 'Make a recovery key',
          description:
            'Returns a key that opens this encrypted database, as 64 hexadecimal characters, shown only this once. It works in place of the encryption key this server uses. Give it to the user, or store it with your secrets: if every key is lost, the database cannot be read again, by anyone. A new database made by this server already has one, which this returns the first time it is called.',
          inputSchema: { ...database },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        (args: WithDatabase) =>
          run(async () => {
            const db = open(args.database);
            const recovery = (await db.takeRecoveryKey()) ?? (await db.addRecoveryKey());
            return {
              recovery_key: recovery,
              key_count: (await db.keyIds()).length,
              store_it: 'Shown once. Store it where secrets are kept, apart from the encryption key.',
            };
          }),
      );
    }

    if (config.allowDelete) {
      server.registerTool(
        'delete',
        {
          title: 'Delete a key',
          description: 'Removes a key and its value. With if_version, only if the key is still at that version.',
          inputSchema: { ...database, key, if_version: z.string().optional().describe('Delete only if the key is still at this version.') },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        (args: WithDatabase & { key: string; if_version?: string }) =>
          run(async () => {
            const result = await open(args.database).delete(args.key, args.if_version === undefined ? {} : { ifVersion: args.if_version });
            return { key: args.key, deleted: true, lsn: result.lsn };
          }),
      );
    }
  }

  // Managing databases needs the control URL, and a key allowed to manage
  // them. A server pinned to one database has no use for it.
  if (config.controlUrl && !config.database) {
    server.registerTool(
      'list_databases',
      {
        title: 'List databases',
        description: 'Lists the databases in the account.',
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      () =>
        run(async () => {
          const databases = [];
          for await (const info of kv.databases.list()) {
            databases.push({ name: info.name, status: info.status, region: info.region, created_at: info.createdAt });
          }
          return { databases };
        }),
    );

    if (!config.readOnly) {
      server.registerTool(
        'create_database',
        {
          title: 'Create a database',
          description:
            'Creates a database, for example one per user or per project. Says created: false if it already exists. A new database answers a few seconds after it is created.',
          inputSchema: {
            name: z
              .string()
              .regex(DATABASE_NAME)
              .describe('2 to 48 characters: lowercase letters, digits and -, starting with a letter. It cannot be changed later.'),
          },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        (args: { name: string }) =>
          run(async () => {
            const region = config.region ?? (await kv.regions())[0];
            if (!region) throw new EdgeKVError('UNAVAILABLE', 'the service offers no region to create a database in', 0);
            try {
              const info = await kv.databases.create({ name: args.name, region });
              return { name: info.name, created: true, region: info.region, status: info.status };
            } catch (error) {
              if (error instanceof EdgeKVError && error.code === 'NAME_CONFLICT') return { name: args.name, created: false };
              throw error;
            }
          }),
      );
    }
  }

  return server;
}
