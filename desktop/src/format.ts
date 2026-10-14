// Pure helpers: turning what the service sends into what a person reads, and
// back. Nothing here touches the window or the network.

/** Base64 to bytes. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Bytes to base64. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Text to base64, as UTF-8. */
export function textToBase64(text: string): string {
  return toBase64(new TextEncoder().encode(text))
}

/** The bytes as text, or `null` if they are not valid UTF-8 or hold control characters. */
export function asText(bytes: Uint8Array): string | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  // Tabs and line breaks are text; other control characters mean binary.
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) ? null : text
}

/** Bytes as spaced hex pairs: `ff 00 1a`. */
export function asHex(bytes: Uint8Array, limit = Infinity): string {
  const shown = bytes.length > limit ? bytes.subarray(0, limit) : bytes
  const hex = Array.from(shown, (byte) => byte.toString(16).padStart(2, '0')).join(' ')
  return bytes.length > limit ? `${hex} …` : hex
}

/** Hex, with or without spaces, to bytes. `null` if it is not hex. */
export function fromHex(text: string): Uint8Array | null {
  const compact = text.replace(/\s+/g, '')
  if (compact.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(compact)) return null
  const bytes = new Uint8Array(compact.length / 2)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export type Kind = 'json' | 'text' | 'binary'

export interface Shown {
  kind: Kind
  /** The whole value for a person to read or edit: text, pretty JSON, or hex. */
  full: string
  /** One line for a table cell. */
  preview: string
}

/** How a value is shown: as JSON if it is JSON, as text if it is text, as hex otherwise. */
export function show(bytes: Uint8Array, previewLength = 120): Shown {
  const text = asText(bytes)
  if (text === null) {
    return { kind: 'binary', full: asHex(bytes), preview: asHex(bytes, Math.floor(previewLength / 3)) }
  }
  const oneLine = text.replace(/\s+/g, ' ').trim()
  const preview = oneLine.length > previewLength ? `${oneLine.slice(0, previewLength)}…` : oneLine
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { kind: 'json', full: JSON.stringify(JSON.parse(text), null, 2), preview }
    } catch {
      // Looks like JSON and is not: plain text.
    }
  }
  return { kind: 'text', full: text, preview }
}

/** A size for a person: `812 B`, `1.4 KB`, `3.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** A time for a person, in their own time zone. Empty for nothing. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

/** Why a database name would be refused, or `null` if it is fine. */
export function nameProblem(name: string): string | null {
  if (name.length === 0) return 'Give the database a name.'
  if (!/^[a-z]/.test(name)) return 'A name starts with a lowercase letter.'
  if (!/^[a-z0-9-]+$/.test(name)) return 'A name has only lowercase letters, digits and -.'
  if (name.length < 2 || name.length > 48) return 'A name is 2 to 48 characters.'
  return null
}

/** How far behind a device is, in words. */
export function lagText(lag: number | null): string {
  if (lag === null) return 'not known'
  if (lag === 0) return 'up to date'
  return `${lag.toLocaleString('en-US')} ${lag === 1 ? 'write' : 'writes'} behind`
}

/** What to tell a person about a failure, by its code. */
export function explain(error: { code: string; message: string }): string {
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return 'The API key was not accepted. It may be mistyped or revoked.'
    case 'FORBIDDEN':
      return 'This API key is not allowed to do that.'
    case 'NETWORK':
      return `The service could not be reached. Check the address and your connection. (${error.message})`
    case 'TIMEOUT':
      return 'The service did not answer in time. If you were saving, it may or may not have been saved: check, then try again.'
    case 'PLAN_LIMIT_EXCEEDED':
      return `Your plan allows no more databases. (${error.message})`
    case 'STORAGE_QUOTA_EXCEEDED':
      return 'The account is over its storage limit. Delete data or change plan; reading and deleting still work.'
    case 'NAME_CONFLICT':
      return 'You already have a database with that name.'
    case 'ACCOUNT_SUSPENDED':
      return 'This account is suspended.'
    case 'RATE_LIMITED':
      return 'Too many requests. Wait a moment and try again.'
    default:
      return error.message || error.code
  }
}
