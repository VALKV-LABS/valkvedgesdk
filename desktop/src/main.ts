import { invoke } from '@tauri-apps/api/core'
import { asHex, asText, explain, formatBytes, formatTime, fromBase64, fromHex, lagText, nameProblem, show, toBase64 } from './format'
import './styles.css'

// What the native half answers with. See src-tauri/src/client.rs.
interface ConnectionInfo {
  api_url: string
  control_url: string
  connected: boolean
  key_hint: string | null
}
interface Database {
  id: string
  name: string
  region: string
  status: string
  status_reason: string | null
  created_at: string
  stored_bytes: number | null
}
interface Replica {
  id: string
  last_seen_at: string
  lsn: number | null
  pushed_seq: number | null
  lag: number | null
  connected: boolean
}
interface Entry {
  key: string
  value: string
}
interface Failure {
  code: string
  message: string
  status: number
}

/** The database being looked at. `id` is absent when it was opened by name. */
interface Open {
  id: string | null
  name: string
  details: Database | null
  replicas: Replica[]
  lsn: number | null
  tab: 'data' | 'replicas'
  prefix: string
  entries: Entry[]
  nextPageToken: string | null
  /** The entry in the editor: a key (base64) being edited, `''` for a new one, `null` for none. */
  editing: string | null
  confirmingDelete: boolean
}

const state = {
  connection: null as ConnectionInfo | null,
  /** `null` until listed. */
  databases: null as Database[] | null,
  /** False when the key may not list databases: they are then opened by name. */
  canManage: true,
  regions: [] as string[],
  open: null as Open | null,
  creating: false,
  busy: false,
  notice: null as { kind: 'error' | 'ok'; text: string } | null,
}

const app = document.querySelector<HTMLDivElement>('#app')!

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const isFailure = (error: unknown): error is Failure =>
  typeof error === 'object' && error !== null && 'code' in error && 'message' in error

/** Runs something that talks to the service, showing that it is busy and what went wrong. */
async function attempt<T>(work: () => Promise<T>, done?: string): Promise<T | undefined> {
  state.busy = true
  state.notice = null
  render()
  try {
    const result = await work()
    if (done) state.notice = { kind: 'ok', text: done }
    return result
  } catch (error) {
    state.notice = { kind: 'error', text: isFailure(error) ? explain(error) : String(error) }
    return undefined
  } finally {
    state.busy = false
    render()
  }
}

// ---------------------------------------------------------------- actions

async function start() {
  state.connection = await invoke<ConnectionInfo>('connection')
  render()
  if (state.connection.connected) await loadDatabases()
}

async function loadDatabases() {
  await attempt(async () => {
    try {
      state.databases = await invoke<Database[]>('list_databases')
      state.canManage = true
      state.regions = await invoke<string[]>('list_regions')
    } catch (error) {
      // A key that reads and writes data but may not manage databases.
      if (isFailure(error) && error.code === 'FORBIDDEN') {
        state.databases = []
        state.canManage = false
        return
      }
      throw error
    }
  })
}

async function connect(form: HTMLFormElement) {
  const data = new FormData(form)
  // Keep what was typed, so a failed attempt does not empty the addresses.
  if (state.connection) {
    state.connection.api_url = String(data.get('api_url') ?? '')
    state.connection.control_url = String(data.get('control_url') ?? '')
  }
  const info = await attempt(() =>
    invoke<ConnectionInfo>('connect', {
      apiUrl: String(data.get('api_url') ?? ''),
      controlUrl: String(data.get('control_url') ?? ''),
      apiKey: String(data.get('api_key') ?? '') || null,
    }),
  )
  if (!info) return
  state.connection = info
  state.open = null
  await loadDatabases()
}

async function disconnect() {
  const info = await attempt(() => invoke<ConnectionInfo>('disconnect'))
  if (!info) return
  state.connection = info
  state.databases = null
  state.open = null
  render()
}

async function openDatabase(id: string | null, name: string) {
  state.open = {
    id,
    name,
    details: null,
    replicas: [],
    lsn: null,
    tab: 'data',
    prefix: '',
    entries: [],
    nextPageToken: null,
    editing: null,
    confirmingDelete: false,
  }
  await refreshOpen()
}

/** Reads the open database again. `done` is what to say once it has. */
async function refreshOpen(done?: string) {
  const open = state.open
  if (!open) return
  await attempt(async () => {
    if (open.id) {
      const details = await invoke<{ database: Database; replicas: Replica[]; lsn: number | null }>('database_details', { id: open.id })
      open.details = details.database
      open.replicas = details.replicas
      open.lsn = details.lsn
    } else {
      open.lsn = await invoke<number>('probe_database', { name: open.name })
    }
    const page = await invoke<{ items: Entry[]; next_page_token: string | null }>('scan', {
      database: open.name,
      prefix: open.prefix,
      pageToken: null,
    })
    open.entries = page.items
    open.nextPageToken = page.next_page_token
  }, done)
}

async function loadMore() {
  const open = state.open
  if (!open?.nextPageToken) return
  await attempt(async () => {
    const page = await invoke<{ items: Entry[]; next_page_token: string | null }>('scan', {
      database: open.name,
      prefix: open.prefix,
      pageToken: open.nextPageToken,
    })
    open.entries.push(...page.items)
    open.nextPageToken = page.next_page_token
  })
}

async function createDatabase(form: HTMLFormElement) {
  const data = new FormData(form)
  const name = String(data.get('name') ?? '').trim()
  const problem = nameProblem(name)
  if (problem) {
    state.notice = { kind: 'error', text: problem }
    return render()
  }
  const created = await attempt(() => invoke<Database>('create_database', { name, region: String(data.get('region') ?? '') }), `Created ${name}.`)
  if (!created) return
  state.creating = false
  state.databases = [...(state.databases ?? []), created]
  render()
  // A new database takes a moment to become usable for data.
  for (let i = 0; i < 40; i += 1) {
    try {
      await invoke('probe_database', { name })
      break
    } catch (error) {
      if (!isFailure(error) || error.code !== 'NOT_FOUND') break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  await openDatabase(created.id, created.name)
}

async function deleteDatabase() {
  const open = state.open
  if (!open?.id) return
  const done = await attempt(() => invoke('delete_database', { id: open.id }).then(() => true), `Deleted ${open.name}. Its data is being removed.`)
  if (!done) return
  state.databases = (state.databases ?? []).filter((database) => database.id !== open.id)
  state.open = null
  render()
}

/** The bytes a person typed, read as text or as hex. */
function typed(text: string, asBinary: boolean): Uint8Array | null {
  return asBinary ? fromHex(text) : new TextEncoder().encode(text)
}

async function saveEntry(form: HTMLFormElement) {
  const open = state.open
  if (!open) return
  const data = new FormData(form)
  const keyBytes = open.editing ? fromBase64(open.editing) : typed(String(data.get('key') ?? ''), data.get('key_hex') === 'on')
  const valueBytes = typed(String(data.get('value') ?? ''), data.get('value_hex') === 'on')
  if (!keyBytes || keyBytes.length === 0) {
    state.notice = { kind: 'error', text: 'Give the entry a key. In hex mode a key is pairs of hex digits.' }
    return render()
  }
  if (!valueBytes) {
    state.notice = { kind: 'error', text: 'In hex mode a value is pairs of hex digits, such as "ff 00 1a".' }
    return render()
  }
  const saved = await attempt(() => invoke<number>('put_entry', { database: open.name, key: toBase64(keyBytes), value: toBase64(valueBytes) }))
  if (saved === undefined) return
  open.editing = null
  await refreshOpen('Saved.')
}

async function deleteEntry(key: string) {
  const open = state.open
  if (!open) return
  const done = await attempt(() => invoke<number>('delete_entry', { database: open.name, key }))
  if (done === undefined) return
  await refreshOpen('Deleted.')
}

// ---------------------------------------------------------------- rendering

function connectionScreen(info: ConnectionInfo): string {
  return `
  <main class="center">
    <form class="card connect" data-form="connect" aria-label="Connect">
      <h1>ValkvEdgeKV Desktop</h1>
      <p class="muted">Browse your databases and what is in them.</p>
      <label>Data API address
        <input name="api_url" required placeholder="https://api.example.com" value="${escape(info.api_url)}" data-testid="api-url" />
      </label>
      <label>Management address
        <input name="control_url" required placeholder="https://cp.example.com" value="${escape(info.control_url)}" data-testid="control-url" />
      </label>
      <label>API key
        <input name="api_key" type="password" required placeholder="ekv_…" autocomplete="off" data-testid="api-key" />
      </label>
      <p class="hint">Create a key in the portal. To create and delete databases here, tick
      &ldquo;Can create and delete databases&rdquo; when you create it. The key is kept in your
      system&rsquo;s credential store, not in a file.</p>
      <button class="primary" type="submit" ${state.busy ? 'disabled' : ''} data-testid="connect">${state.busy ? 'Connecting…' : 'Connect'}</button>
    </form>
  </main>`
}

function sidebar(): string {
  const open = state.open
  const list =
    state.databases === null
      ? '<p class="muted pad">Loading…</p>'
      : !state.canManage
        ? `<div class="pad">
            <p class="muted">This key cannot list databases. Open one by name.</p>
            <form data-form="open-by-name" class="row">
              <input name="name" required placeholder="database name" data-testid="open-name" />
              <button type="submit" data-testid="open-by-name">Open</button>
            </form>
          </div>`
        : state.databases.length === 0
          ? '<p class="muted pad" data-testid="no-databases">No databases yet.</p>'
          : `<ul class="databases" data-testid="databases">${state.databases
              .map(
                (database) => `
              <li>
                <button class="database ${open?.id === database.id ? 'selected' : ''}" data-open="${escape(database.id)}" data-name="${escape(database.name)}">
                  <span class="mono">${escape(database.name)}</span>
                  <span class="tag ${database.status === 'active' ? 'ok' : ''}">${escape(database.status)}</span>
                </button>
              </li>`,
              )
              .join('')}</ul>`
  const create = !state.canManage
    ? ''
    : state.creating
      ? `<form class="pad create" data-form="create" aria-label="New database">
          <label>Name <input name="name" required placeholder="orders" data-testid="new-name" /></label>
          <label>Region
            <select name="region" data-testid="new-region">${state.regions.map((region) => `<option>${escape(region)}</option>`).join('')}</select>
          </label>
          <div class="row">
            <button class="primary" type="submit" ${state.busy ? 'disabled' : ''} data-testid="create">Create</button>
            <button type="button" data-action="cancel-create">Cancel</button>
          </div>
        </form>`
      : `<div class="pad"><button data-action="new-database" data-testid="new-database">New database</button></div>`
  return `
  <aside>
    <div class="aside-head">
      <strong>Databases</strong>
      <button class="link" data-action="refresh-databases" title="Refresh the list">Refresh</button>
    </div>
    ${list}
    ${create}
    <div class="aside-foot">
      <div class="muted">${escape(state.connection?.key_hint ?? '')}</div>
      <button class="link" data-action="disconnect" data-testid="disconnect">Disconnect</button>
    </div>
  </aside>`
}

function editor(open: Open): string {
  if (open.editing === null) return ''
  const existing = open.editing ? open.entries.find((entry) => entry.key === open.editing) : undefined
  const keyBytes = open.editing ? fromBase64(open.editing) : new Uint8Array()
  const keyText = asText(keyBytes)
  const value = existing ? show(fromBase64(existing.value)) : null
  const valueIsBinary = value?.kind === 'binary'
  return `
  <form class="card editor" data-form="entry" aria-label="${open.editing ? 'Edit entry' : 'New entry'}">
    <h3>${open.editing ? 'Edit entry' : 'New entry'}</h3>
    <label>Key
      ${
        open.editing
          ? `<input class="mono" disabled value="${escape(keyText ?? asHex(keyBytes))}" />`
          : `<input class="mono" name="key" required placeholder="order/1001" data-testid="entry-key" />
             <span class="check"><input type="checkbox" name="key_hex" /> key is hex</span>`
      }
    </label>
    <label>Value
      <textarea class="mono" name="value" rows="8" data-testid="entry-value">${escape(value?.full ?? '')}</textarea>
      <span class="check"><input type="checkbox" name="value_hex" ${valueIsBinary ? 'checked' : ''} /> value is hex</span>
    </label>
    <div class="row">
      <button class="primary" type="submit" ${state.busy ? 'disabled' : ''} data-testid="save-entry">Save</button>
      <button type="button" data-action="cancel-edit">Cancel</button>
    </div>
  </form>`
}

function dataTab(open: Open): string {
  const rows = open.entries
    .map((entry) => {
      const keyBytes = fromBase64(entry.key)
      const valueBytes = fromBase64(entry.value)
      const shown = show(valueBytes)
      return `
      <tr data-key="${escape(entry.key)}">
        <td class="mono key">${escape(asText(keyBytes) ?? asHex(keyBytes))}</td>
        <td class="mono value"><span class="kind">${shown.kind}</span> ${escape(shown.preview)}</td>
        <td class="num">${formatBytes(valueBytes.length)}</td>
        <td class="actions">
          <button class="link" data-edit="${escape(entry.key)}">Edit</button>
          <button class="link danger" data-delete-entry="${escape(entry.key)}">Delete</button>
        </td>
      </tr>`
    })
    .join('')
  return `
  <div class="toolbar">
    <form data-form="filter" class="row grow">
      <input name="prefix" placeholder="Keys starting with…" value="${escape(open.prefix)}" data-testid="prefix" />
      <button type="submit" data-testid="filter">Filter</button>
    </form>
    <button data-action="new-entry" data-testid="new-entry">New entry</button>
    <button data-action="refresh-open" data-testid="refresh">Refresh</button>
  </div>
  ${editor(open)}
  ${
    open.entries.length === 0
      ? `<p class="muted pad" data-testid="no-entries">${open.prefix ? 'No keys start with that.' : 'This database is empty.'}</p>`
      : `<table data-testid="entries">
          <thead><tr><th>Key</th><th>Value</th><th class="num">Size</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="muted pad" data-testid="entry-count">${open.entries.length} ${open.entries.length === 1 ? 'entry' : 'entries'} shown${open.nextPageToken ? '' : ', and that is all of them'}.
          ${open.nextPageToken ? '<button class="link" data-action="load-more" data-testid="load-more">Load more</button>' : ''}
        </p>`
  }`
}

function replicasTab(open: Open): string {
  if (!open.id) return '<p class="muted pad">Replicas are listed for keys that can manage databases.</p>'
  if (open.replicas.length === 0) {
    return '<p class="muted pad" data-testid="no-replicas">No replica has synced this database yet. A replica is listed once it syncs with the library.</p>'
  }
  return `
  <table data-testid="replicas">
    <thead><tr><th>Replica</th><th>Status</th><th>Behind</th><th>Last seen</th></tr></thead>
    <tbody>${open.replicas
      .map(
        (replica) => `
      <tr>
        <td class="mono">${escape(replica.id)}</td>
        <td><span class="tag ${replica.connected ? 'ok' : ''}">${replica.connected ? 'connected' : 'offline'}</span></td>
        <td>${lagText(replica.lag)}</td>
        <td class="muted">${escape(formatTime(replica.last_seen_at))}</td>
      </tr>`,
      )
      .join('')}</tbody>
  </table>`
}

function content(): string {
  const open = state.open
  if (!open) {
    return `<section class="empty"><p class="muted">${state.canManage ? 'Choose a database, or create one.' : 'Open a database by name.'}</p></section>`
  }
  const details = open.details
  return `
  <section>
    <header>
      <div>
        <h2 class="mono" data-testid="open-name-title">${escape(open.name)}</h2>
        <p class="muted">
          ${details ? `<span class="tag ${details.status === 'active' ? 'ok' : ''}">${escape(details.status)}</span> ${escape(details.region)} · created ${escape(formatTime(details.created_at))}` : ''}
          ${details?.stored_bytes != null ? ` · ${formatBytes(details.stored_bytes)} stored` : ''}
          ${open.lsn != null ? ` · ${open.lsn.toLocaleString('en-US')} writes` : ''}
        </p>
        ${details?.status_reason ? `<p class="error">${escape(details.status_reason)}</p>` : ''}
      </div>
      ${
        open.id
          ? open.confirmingDelete
            ? `<div class="confirm" role="alertdialog" aria-label="Delete database">
                <span>Delete <strong>${escape(open.name)}</strong> and all its data? This cannot be undone.</span>
                <button class="danger" data-action="confirm-delete-database" ${state.busy ? 'disabled' : ''} data-testid="confirm-delete-database">Delete</button>
                <button data-action="cancel-delete-database">Keep</button>
              </div>`
            : `<button class="danger" data-action="delete-database" data-testid="delete-database">Delete database</button>`
          : ''
      }
    </header>
    <nav class="tabs">
      <button class="${open.tab === 'data' ? 'selected' : ''}" data-tab="data">Data</button>
      <button class="${open.tab === 'replicas' ? 'selected' : ''}" data-tab="replicas" data-testid="replicas-tab">Replicas${open.replicas.length ? ` (${open.replicas.length})` : ''}</button>
    </nav>
    ${open.tab === 'data' ? dataTab(open) : replicasTab(open)}
  </section>`
}

function render() {
  const info = state.connection
  if (!info) {
    app.innerHTML = '<main class="center"><p class="muted">Starting…</p></main>'
    return
  }
  const notice = state.notice
    ? `<div class="notice ${state.notice.kind}" role="${state.notice.kind === 'error' ? 'alert' : 'status'}" data-testid="notice">${escape(state.notice.text)}
        <button class="link" data-action="dismiss">Dismiss</button></div>`
    : ''
  app.innerHTML = info.connected
    ? `<div class="layout ${state.busy ? 'busy' : ''}" data-testid="main">${sidebar()}<div class="main">${notice}${content()}</div></div>`
    : `${notice}${connectionScreen(info)}`
}

// ---------------------------------------------------------------- events

app.addEventListener('submit', (event) => {
  event.preventDefault()
  const form = event.target as HTMLFormElement
  switch (form.dataset.form) {
    case 'connect':
      void connect(form)
      break
    case 'create':
      void createDatabase(form)
      break
    case 'open-by-name':
      void openDatabase(null, String(new FormData(form).get('name') ?? '').trim())
      break
    case 'filter':
      if (state.open) {
        state.open.prefix = String(new FormData(form).get('prefix') ?? '')
        void refreshOpen()
      }
      break
    case 'entry':
      void saveEntry(form)
      break
  }
})

app.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button')
  if (!target) return
  const open = state.open
  if (target.dataset.open) return void openDatabase(target.dataset.open, target.dataset.name ?? '')
  if (target.dataset.tab && open) {
    open.tab = target.dataset.tab as Open['tab']
    return render()
  }
  if (target.dataset.edit !== undefined && open) {
    open.editing = target.dataset.edit
    return render()
  }
  if (target.dataset.deleteEntry !== undefined) return void deleteEntry(target.dataset.deleteEntry)
  switch (target.dataset.action) {
    case 'dismiss':
      state.notice = null
      return render()
    case 'disconnect':
      return void disconnect()
    case 'refresh-databases':
      return void loadDatabases()
    case 'new-database':
      state.creating = true
      return render()
    case 'cancel-create':
      state.creating = false
      return render()
    case 'refresh-open':
      return void refreshOpen()
    case 'load-more':
      return void loadMore()
    case 'new-entry':
      if (open) open.editing = ''
      return render()
    case 'cancel-edit':
      if (open) open.editing = null
      return render()
    case 'delete-database':
      if (open) open.confirmingDelete = true
      return render()
    case 'cancel-delete-database':
      if (open) open.confirmingDelete = false
      return render()
    case 'confirm-delete-database':
      return void deleteDatabase()
  }
})

void start().catch((error) => {
  app.innerHTML = `<main class="center"><p class="error">The app could not start: ${escape(String(error))}</p></main>`
})

