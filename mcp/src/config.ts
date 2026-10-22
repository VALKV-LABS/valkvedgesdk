import { readFileSync } from 'node:fs';

/** The server's settings, from environment variables. */
export interface Config {
  /** `EDGEKV_API_KEY`: an API key from the portal, `ekv_…`. */
  apiKey: string;
  /** `EDGEKV_URL`: where the data API is. */
  url: string;
  /** `EDGEKV_CONTROL_URL`: where databases are managed. Without it, there are no tools to list or create databases. */
  controlUrl?: string;
  /** `EDGEKV_DATABASE`: use only this database; the tools then take no database name. */
  database?: string;
  /** `EDGEKV_REGION`: where `create_database` puts a database. Default: the first region the service offers. */
  region?: string;
  /**
   * `EDGEKV_ENCRYPTION_KEY`, or the contents of the file named by
   * `EDGEKV_ENCRYPTION_KEY_FILE`: 64 hexadecimal characters. Values are
   * encrypted with it before they leave this process, so the service stores
   * only ciphertext. Without it, values are sent as they are. A file keeps
   * the key out of the MCP host's configuration, which is often plain text.
   */
  encryptionKey?: string;
  /** `EDGEKV_READ_ONLY=1`: only the tools that read. */
  readOnly: boolean;
  /** `EDGEKV_ALLOW_DELETE=1`: also the tool that deletes a key. Off by default so an agent cannot wipe its memory by mistake. */
  allowDelete: boolean;
}

const yes = (value: string | undefined) => value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());

/** The settings, or every problem with them, one per line. */
export function configFromEnv(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Config {
  const problems: string[] = [];
  const text = (name: string) => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };

  const apiKey = text('EDGEKV_API_KEY');
  if (!apiKey) problems.push('EDGEKV_API_KEY is missing: an API key from the portal, ekv_...');
  else if (!apiKey.startsWith('ekv_')) problems.push('EDGEKV_API_KEY must be an API key from the portal: ekv_...');

  const url = text('EDGEKV_URL');
  if (!url) problems.push('EDGEKV_URL is missing: where the data API is, for example https://api.example.com');

  let encryptionKey = text('EDGEKV_ENCRYPTION_KEY');
  const keyFile = text('EDGEKV_ENCRYPTION_KEY_FILE');
  if (encryptionKey !== undefined && keyFile !== undefined) {
    problems.push('set EDGEKV_ENCRYPTION_KEY or EDGEKV_ENCRYPTION_KEY_FILE, not both');
  } else if (keyFile !== undefined) {
    try {
      encryptionKey = readFile(keyFile).trim();
    } catch (error) {
      problems.push(`EDGEKV_ENCRYPTION_KEY_FILE could not be read: ${(error as Error).message}`);
    }
  }
  if (encryptionKey !== undefined && !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    problems.push(
      `${keyFile !== undefined ? 'the key in EDGEKV_ENCRYPTION_KEY_FILE' : 'EDGEKV_ENCRYPTION_KEY'} must be 64 hexadecimal characters (32 bytes); make one with: openssl rand -hex 32`,
    );
  }

  const database = text('EDGEKV_DATABASE');
  if (database !== undefined && !/^[a-z][a-z0-9-]{1,47}$/.test(database)) {
    problems.push('EDGEKV_DATABASE must be a database name: 2 to 48 lowercase letters, digits and -, starting with a letter');
  }

  if (problems.length > 0) throw new Error(problems.join('\n'));
  return {
    apiKey: apiKey!,
    url: url!,
    controlUrl: text('EDGEKV_CONTROL_URL'),
    database,
    region: text('EDGEKV_REGION'),
    encryptionKey,
    readOnly: yes(env.EDGEKV_READ_ONLY),
    allowDelete: yes(env.EDGEKV_ALLOW_DELETE),
  };
}
