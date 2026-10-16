// Drives the built application through its real window, against a running
// service: connects, creates a database, writes, edits, filters and deletes
// entries, checks the replicas list, restarts, and deletes the database.
//
// Windows only: it reaches the window through the debugging port of the
// system web view. Needs Node 22 or later.
//
//   EDGEKV_URL          the data API, e.g. http://localhost:8894
//   EDGEKV_CONTROL_URL  where databases are managed, e.g. http://localhost:4100
//   EDGEKV_API_KEY      a key that may manage databases
//   EDGEKV_DESKTOP_EXE  the built app (default: src-tauri/target/release/edgekv-desktop.exe)
//
//   npm run test:ui
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const env = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const API = env('EDGEKV_URL')
const CONTROL = env('EDGEKV_CONTROL_URL')
const KEY = env('EDGEKV_API_KEY')
const EXE = process.env.EDGEKV_DESKTOP_EXE ?? resolve(here, '../src-tauri/target/release/edgekv-desktop.exe')
const PORT = 9333
const OUT = resolve(here, 'out')
mkdirSync(OUT, { recursive: true })

let failures = 0
function pass(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`)
  else {
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`)
    failures += 1
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ------------------------------------------------------------ the window

let child
let socket
let nextId = 1
const waiting = new Map()

/** Starts the app with its own profile, so a real saved connection is left alone. */
async function launch() {
  child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      EDGEKV_DESKTOP_PROFILE: 'uitest',
    },
    stdio: 'ignore',
  })
  let target
  for (let i = 0; i < 100 && !target; i += 1) {
    await sleep(300)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      target = pages.find((page) => page.type === 'page')
    } catch {
      // Not listening yet.
    }
  }
  if (!target) throw new Error('the app window never appeared')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    socket.addEventListener('open', done)
    socket.addEventListener('error', fail)
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const resolver = waiting.get(message.id)
    if (resolver) {
      waiting.delete(message.id)
      resolver(message)
    }
  })
}

async function quit() {
  socket?.close()
  if (child && child.exitCode === null) {
    child.kill()
    await new Promise((done) => child.once('exit', done))
  }
  // The web view's own processes hold the debugging port for a moment.
  for (let i = 0; i < 30; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json`)
      await sleep(200)
    } catch {
      return
    }
  }
}

function send(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((done) => waiting.set(id, done))
}

/** Runs an expression in the window and returns its value. */
async function page(expression) {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (reply.result?.exceptionDetails) {
    throw new Error(`in the window: ${reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text}`)
  }
  return reply.result?.result?.value
}

const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`
const exists = (selector) => page(`Boolean(${q(selector)})`)
const text = (selector) => page(`${q(selector)}?.textContent?.replace(/\\s+/g, ' ').trim() ?? null`)

/** Waits until `check` returns something truthy, and returns it. */
async function until(check, what, seconds = 20) {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(150)
  }
}
const appears = (selector, seconds) => until(() => exists(selector), selector, seconds)
/** Waits for the app to finish what it is doing. */
const settled = () => until(() => page(`!document.querySelector('.layout.busy') && !document.querySelector('button[type=submit][disabled]')`), 'the app to settle')

async function fill(selector, value) {
  await appears(selector)
  await page(`(() => { const el = ${q(selector)}; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
}
async function click(selector) {
  await appears(selector)
  await page(`${q(selector)}.click()`)
}
async function submit(formSelector) {
  await page(`${q(formSelector)}.requestSubmit()`)
}
async function screenshot(name) {
  const reply = await send('Page.captureScreenshot', { format: 'png' })
  if (reply.result?.data) writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(reply.result.data, 'base64'))
}
const notice = () => text('[data-testid=notice]')
const rows = () =>
  page(`[...document.querySelectorAll('[data-testid=entries] tbody tr')].map((row) => [row.querySelector('.key').textContent.trim(), row.querySelector('.value').textContent.replace(/\\s+/g, ' ').trim()])`)

// ------------------------------------------------------------ the service, directly

const service = (base, path, options = {}) =>
  fetch(`${base}${path}`, { ...options, headers: { authorization: `Bearer ${KEY}`, ...(options.headers ?? {}) } })

// ------------------------------------------------------------ the test

const name = `desktop-ui-${Date.now()}`
let databaseId

async function run() {
  await launch()
  // A run that failed part way can leave this profile connected: start clean.
  await until(async () => (await exists('[data-form=connect]')) || (await exists('[data-testid=main]')), 'the window to show something')
  if (await exists('[data-testid=main]')) {
    await click('[data-testid=disconnect]')
    await appears('[data-form=connect]')
  }
  pass('the app opens on the connection screen', true)
  await screenshot('1-connect')

  // A wrong key is refused, with a reason, and the addresses typed are kept.
  await fill('[data-testid=api-url]', API)
  await fill('[data-testid=control-url]', CONTROL)
  await fill('[data-testid=api-key]', 'ekv_this-key-was-never-issued-000000')
  await submit('[data-form=connect]')
  await until(notice, 'a notice')
  pass('a wrong key is refused with a reason', (await notice()).includes('not accepted'), await notice())
  pass('the addresses typed are still there', (await page(`${q('[data-testid=api-url]')}.value`)) === API)
  pass('still on the connection screen', await exists('[data-form=connect]'))

  await fill('[data-testid=api-key]', KEY)
  await submit('[data-form=connect]')
  await appears('[data-testid=main]')
  await settled()
  pass('the right key connects', true)
  pass('the key is shown only as a hint', (await text('.aside-foot .muted')) === `${KEY.slice(0, 10)}…`)
  pass('the whole key is nowhere in the window', !(await page('document.documentElement.outerHTML')).includes(KEY))

  // Create a database: a bad name is caught, a good one is created and opened.
  await click('[data-testid=new-database]')
  await fill('[data-testid=new-name]', 'Bad Name')
  await submit('[data-form=create]')
  await until(notice, 'a notice')
  pass('a name that cannot be used is explained', /lowercase/.test(await notice()), await notice())
  await fill('[data-testid=new-name]', name)
  await submit('[data-form=create]')
  await until(async () => (await text('[data-testid=open-name-title]')) === name, 'the new database to open', 40)
  await settled()
  pass('a database is created and opened', true)
  pass('it starts empty', (await text('[data-testid=no-entries]')) === 'This database is empty.')
  const listed = await (await service(CONTROL, '/v1/databases')).json()
  databaseId = listed.items.find((database) => database.spec.name === name)?.id
  pass('the service has the database the app created', Boolean(databaseId))

  // Write entries: JSON, text, and bytes typed as hex.
  const add = async (key, value, hex = false) => {
    await click('[data-testid=new-entry]')
    await fill('[data-testid=entry-key]', key)
    await fill('[data-testid=entry-value]', value)
    if (hex) await page(`${q('[data-form=entry] [name=value_hex]')}.checked = true`)
    await submit('[data-form=entry]')
    await until(async () => (await notice())?.startsWith("Saved."), `"${key}" to be saved`)
    await settled()
  }
  await add('order/1001', '{"total":42,"items":["widget"]}')
  await add('order/1002', 'plain text value')
  await add('blob/1', 'de ad be ef', true)
  const afterAdds = await rows()
  pass('three entries are listed in key order', JSON.stringify(afterAdds.map((row) => row[0])) === JSON.stringify(['blob/1', 'order/1001', 'order/1002']), JSON.stringify(afterAdds))
  pass('JSON is recognised', afterAdds[1][1].startsWith('json {"total":42'), afterAdds[1][1])
  pass('bytes are shown as hex', afterAdds[0][1] === 'binary de ad be ef', afterAdds[0][1])
  await screenshot('2-entries')

  // What the app wrote is what the service holds.
  const stored = await service(API, `/v1/db/${name}/kv/order/1001`)
  pass('the service holds the value the app saved', (await stored.text()) === '{"total":42,"items":["widget"]}')
  const blob = new Uint8Array(await (await service(API, `/v1/db/${name}/kv/blob/1`)).arrayBuffer())
  pass('hex was stored as bytes, not as text', blob.length === 4 && blob[0] === 0xde && blob[3] === 0xef, String(blob))

  // Edit: the editor shows the value pretty-printed; saving replaces it.
  await page(`document.querySelector('[data-edit]')?.closest('tr') && [...document.querySelectorAll('[data-edit]')].find((b) => b.closest('tr').querySelector('.key').textContent.trim() === 'order/1001').click()`)
  await appears('[data-testid=entry-value]')
  pass('the editor shows JSON pretty-printed', (await page(`${q('[data-testid=entry-value]')}.value`)).includes('\n  "total": 42'))
  await fill('[data-testid=entry-value]', '{"total":43}')
  await submit('[data-form=entry]')
  await until(async () => (await rows()).some((row) => row[1].includes('"total":43')), 'the edit to show')
  pass('an edit replaces the value', true)

  // Something written elsewhere appears after a refresh.
  await service(API, `/v1/db/${name}/kv/order/1003`, { method: 'PUT', body: 'from elsewhere' })
  await click('[data-testid=refresh]')
  await until(async () => (await rows()).length === 4, 'the outside write to show')
  pass('a write made outside the app appears on refresh', true)

  // Filter by prefix.
  await fill('[data-testid=prefix]', 'order/')
  await submit('[data-form=filter]')
  await until(async () => (await rows()).length === 3, 'the filter to apply')
  pass('filtering by prefix shows only matching keys', (await rows()).every((row) => row[0].startsWith('order/')))
  pass('the count says that is all of them', (await text('[data-testid=entry-count]')).startsWith('3 entries shown, and that is all of them'))
  await fill('[data-testid=prefix]', 'nothing-here/')
  await submit('[data-form=filter]')
  await until(() => exists('[data-testid=no-entries]'), 'the empty result')
  pass('a prefix that matches nothing says so', (await text('[data-testid=no-entries]')) === 'No keys start with that.')
  await fill('[data-testid=prefix]', '')
  await submit('[data-form=filter]')
  await until(async () => (await rows()).length === 4, 'the filter to clear')

  // Delete an entry.
  await page(`[...document.querySelectorAll('[data-delete-entry]')].find((b) => b.closest('tr').querySelector('.key').textContent.trim() === 'order/1002').click()`)
  await until(async () => (await rows()).length === 3, 'the entry to go')
  pass('an entry is deleted', !(await rows()).some((row) => row[0] === 'order/1002'))
  pass('and is gone from the service', (await service(API, `/v1/db/${name}/kv/order/1002`)).status === 404)

  // Replicas: none yet, then one that pushed.
  await click('[data-testid=replicas-tab]')
  pass('no replicas at first', await exists('[data-testid=no-replicas]'))
  const replica = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f'
  const b64 = (value) => Buffer.from(value).toString('base64')
  const pushed = await service(API, `/v1/db/${name}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replica_id: replica, entries: [{ seq: 1, ops: [{ op: 'put', key: b64('from-replica'), value: b64('hi'), hlc: { ms: Date.now() } }] }] }),
  })
  pass('a replica pushes a write to the service', pushed.status === 200, String(pushed.status))
  // The service learns of replicas in the background; ask again until it has.
  await page(`document.querySelector('[data-tab=data]').click()`)
  let seen = false
  for (let i = 0; i < 40 && !seen; i += 1) {
    await click('[data-testid=refresh]')
    await settled()
    await click('[data-testid=replicas-tab]')
    seen = await exists('[data-testid=replicas]')
    if (!seen) {
      await page(`document.querySelector('[data-tab=data]').click()`)
      await sleep(500)
    }
  }
  pass('the replica is listed', seen && (await text('[data-testid=replicas] tbody tr td')) === replica)
  await screenshot('3-replicas')

  // Restart: the connection is remembered, and the key was not typed again.
  await quit()
  await launch()
  await appears('[data-testid=main]', 30)
  await settled()
  pass('after a restart the app is still connected', true)
  pass('and lists the database', (await page(`[...document.querySelectorAll('[data-open]')].map((b) => b.dataset.name)`)).includes(name))

  // Delete the database, with a confirmation.
  await page(`[...document.querySelectorAll('[data-open]')].find((b) => b.dataset.name === ${JSON.stringify(name)}).click()`)
  await until(async () => (await text('[data-testid=open-name-title]')) === name, 'the database to open')
  await settled()
  await click('[data-testid=delete-database]')
  pass('deleting asks first', (await text('.confirm span')).includes('cannot be undone'))
  pass('nothing is deleted until confirmed', (await service(CONTROL, `/v1/databases/${databaseId}`)).status === 200)
  await click('[data-testid=confirm-delete-database]')
  await until(async () => !(await page(`[...document.querySelectorAll('[data-open]')].map((b) => b.dataset.name)`)).includes(name), 'the database to leave the list')
  pass('the database leaves the list', true)
  const after = await service(CONTROL, `/v1/databases/${databaseId}`)
  const gone = after.status === 404 || (await after.json()).status === 'deleting'
  pass('the service is deleting it', gone)
  databaseId = undefined

  // Disconnect forgets the key.
  await click('[data-testid=disconnect]')
  await appears('[data-form=connect]')
  pass('disconnecting returns to the connection screen', true)
  pass('the addresses are kept for next time', (await page(`${q('[data-testid=api-url]')}.value`)) === API)
  await quit()
  await launch()
  await appears('[data-form=connect]', 30)
  pass('after disconnecting, a restart asks for a key again', !(await exists('[data-testid=main]')))
}

try {
  await run()
} catch (error) {
  console.log(`FAIL ${error instanceof Error ? error.message : error}`)
  failures += 1
  try {
    await screenshot('failure')
    console.log(`     window at the time: ${await page('document.body.innerText.slice(0, 400)')}`)
  } catch {
    // The window is gone.
  }
} finally {
  await quit().catch(() => {})
  if (databaseId) await service(CONTROL, `/v1/databases/${databaseId}`, { method: 'DELETE' }).catch(() => {})
}
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
