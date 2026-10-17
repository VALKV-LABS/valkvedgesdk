// An in-memory stand-in for the service's data and management APIs, as a
// `fetch`: enough of them for the MCP tools, keeping exactly the bytes it is sent.

interface Stored {
  value: Uint8Array;
  version: string;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const failure = (status: number, code: string, message = code) => json(status, { error: { code, message } });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

export class FakeService {
  /** Database name to its keys (as UTF-8 text) and values, exactly as sent. */
  readonly databases = new Map<string, Map<string, Stored>>();
  readonly regions = ['us-west-2', 'eu-west-1'];
  /** Every request, as `METHOD /path`. */
  readonly requests: string[] = [];
  private lsn = 0;

  constructor(names: string[] = []) {
    for (const name of names) this.databases.set(name, new Map());
  }

  /** Every stored value, as raw bytes, for checking what the service was given. */
  allValues(): Uint8Array[] {
    return [...this.databases.values()].flatMap((keys) => [...keys.values()].map((stored) => stored.value));
  }

  readonly fetch = async (input: URL | RequestInfo, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}`);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body as string | Uint8Array | undefined;

    if (url.pathname === '/v1/regions') return json(200, { items: this.regions.map((region) => ({ region })) });
    if (url.pathname === '/v1/databases') {
      if (method === 'GET') {
        const items = [...this.databases.keys()].map((name) => raw(name));
        return json(200, { items, next_page_token: null });
      }
      const { name, region } = JSON.parse(String(body)) as { name: string; region: string };
      if (this.databases.has(name)) return failure(409, 'NAME_CONFLICT', `a database named ${name} exists`);
      this.databases.set(name, new Map());
      return json(201, raw(name, region));
    }

    const match = /^\/v1\/db\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!match) return failure(404, 'NOT_FOUND', 'no such route');
    const keys = this.databases.get(decodeURIComponent(match[1]!));
    if (!keys) return failure(404, 'NOT_FOUND', 'database not found');
    const rest = match[2]!;

    if (rest === '/commit') {
      const { ops } = JSON.parse(String(body)) as { ops: { op: string; key: string; value?: string }[] };
      this.lsn += 1;
      const versions = ops.map((op, index) => {
        const key = Buffer.from(unb64(op.key)).toString('utf8');
        const version = `v${this.lsn}.${index}`;
        if (op.op === 'put') keys.set(key, { value: unb64(op.value!), version });
        else keys.delete(key);
        return version;
      });
      return json(200, { lsn: this.lsn, versions });
    }

    if (rest === '/kv') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const from = Number(url.searchParams.get('page_token') ?? 0);
      const matching = [...keys.keys()].filter((key) => key.startsWith(prefix)).sort();
      const items = matching.slice(from, from + limit).map((key) => ({
        key: b64(Buffer.from(key)),
        value: b64(keys.get(key)!.value),
        version: keys.get(key)!.version,
      }));
      return json(200, { items, next_page_token: from + limit < matching.length ? String(from + limit) : null });
    }

    if (!rest.startsWith('/kv/')) return failure(404, 'NOT_FOUND', 'no such route');
    const key = rest.slice(4).split('/').map(decodeURIComponent).join('/');
    const current = keys.get(key);
    if (method === 'GET') {
      if (!current) return failure(404, 'KEY_NOT_FOUND', 'no such key');
      return new Response(current.value as BodyInit, { headers: { 'x-edgekv-version': current.version } });
    }
    const ifMatch = headers['if-match'];
    if ((ifMatch !== undefined && current?.version !== ifMatch) || (headers['if-none-match'] === '*' && current)) {
      return failure(412, 'CONDITION_FAILED', `the condition on ${key} did not hold`);
    }
    this.lsn += 1;
    if (method === 'DELETE') {
      keys.delete(key);
      return json(200, { lsn: this.lsn });
    }
    const version = `v${this.lsn}`;
    keys.set(key, { value: typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body!), version });
    return json(200, { lsn: this.lsn, version });
  };
}

function raw(name: string, region = 'us-west-2') {
  return {
    id: `id-${name}`,
    region,
    status: 'active',
    status_reason: null,
    created_at: '2026-10-17T00:00:00Z',
    spec: { name },
  };
}
