#!/usr/bin/env node
// Runs the server over stdio, set up from environment variables (see
// config.ts). Standard output carries the protocol, so messages go to
// standard error.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EdgeKV } from '@valkvlabs/edgekv';
import { configFromEnv, type Config } from './config.js';
import { createServer } from './server.js';

let config: Config;
try {
  config = configFromEnv(process.env);
} catch (error) {
  console.error(`edgekv-mcp: ${(error as Error).message.replace(/\n/g, '\nedgekv-mcp: ')}`);
  process.exit(2);
}

const kv = new EdgeKV({ apiKey: config.apiKey, url: config.url, controlUrl: config.controlUrl });
await createServer(kv, config).connect(new StdioServerTransport());

const scope = config.database ? `database ${config.database}` : 'every database the key reaches';
console.error(`edgekv-mcp: ready: ${scope}; values ${config.encryptionKey ? 'encrypted' : 'not encrypted'}${config.readOnly ? '; read-only' : ''}`);
