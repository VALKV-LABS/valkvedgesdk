import { describe, expect, it } from 'vitest'
import {
  asHex,
  asText,
  explain,
  formatBytes,
  fromBase64,
  fromHex,
  lagText,
  nameProblem,
  show,
  textToBase64,
  toBase64,
} from './format'

const bytes = (...values: number[]) => new Uint8Array(values)

describe('base64 and hex', () => {
  it('round-trips bytes, including ones that are not text', () => {
    const all = new Uint8Array(256).map((_, i) => i)
    expect(fromBase64(toBase64(all))).toEqual(all)
    expect(toBase64(bytes(0, 255))).toBe('AP8=')
    expect(textToBase64('naïve 日本')).toBe(toBase64(new TextEncoder().encode('naïve 日本')))
  })

  it('reads hex with or without spaces and refuses what is not hex', () => {
    expect(fromHex('ff 00 1a')).toEqual(bytes(255, 0, 26))
    expect(fromHex('FF001A')).toEqual(bytes(255, 0, 26))
    expect(fromHex('')).toEqual(bytes())
    expect(fromHex('f')).toBeNull()
    expect(fromHex('zz')).toBeNull()
    expect(asHex(bytes(255, 0, 26))).toBe('ff 00 1a')
    expect(asHex(bytes(1, 2, 3, 4), 2)).toBe('01 02 …')
  })
})

describe('showing a value', () => {
  it('shows text as text and keeps tabs and line breaks', () => {
    expect(asText(new TextEncoder().encode('line one\n\tline two'))).toBe('line one\n\tline two')
    const shown = show(new TextEncoder().encode('hello   world\nagain'))
    expect(shown).toEqual({ kind: 'text', full: 'hello   world\nagain', preview: 'hello world again' })
  })

  it('pretty-prints JSON, and treats almost-JSON as text', () => {
    const shown = show(new TextEncoder().encode('{"total":42,"items":[1,2]}'))
    expect(shown.kind).toBe('json')
    expect(shown.full).toBe('{\n  "total": 42,\n  "items": [\n    1,\n    2\n  ]\n}')
    expect(shown.preview).toBe('{"total":42,"items":[1,2]}')
    expect(show(new TextEncoder().encode('{not json')).kind).toBe('text')
    // A bare number or word is valid JSON but is shown as the text it is.
    expect(show(new TextEncoder().encode('42')).kind).toBe('text')
  })

  it('shows bytes that are not text as hex', () => {
    expect(asText(bytes(0xff, 0xfe))).toBeNull()
    expect(asText(bytes(0x68, 0x00, 0x69))).toBeNull()
    const shown = show(bytes(0xde, 0xad, 0xbe, 0xef))
    expect(shown).toEqual({ kind: 'binary', full: 'de ad be ef', preview: 'de ad be ef' })
  })

  it('cuts a long preview and says so', () => {
    const shown = show(new TextEncoder().encode('x'.repeat(500)), 20)
    expect(shown.preview).toBe(`${'x'.repeat(20)}…`)
    expect(shown.full).toHaveLength(500)
    expect(show(new Uint8Array(100).fill(0xff), 30).preview.endsWith('…')).toBe(true)
  })

  it('shows an empty value as empty text', () => {
    expect(show(bytes())).toEqual({ kind: 'text', full: '', preview: '' })
  })
})

describe('sizes, names and lag', () => {
  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(812)).toBe('812 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB')
    expect(formatBytes(3.2 * 1024 ** 3)).toBe('3.2 GB')
  })

  it('checks a database name the way the service does', () => {
    expect(nameProblem('orders')).toBeNull()
    expect(nameProblem('a1')).toBeNull()
    expect(nameProblem('a-b-c')).toBeNull()
    expect(nameProblem('')).toMatch(/name/)
    expect(nameProblem('a')).toMatch(/2 to 48/)
    expect(nameProblem('a'.repeat(49))).toMatch(/2 to 48/)
    expect(nameProblem('Orders')).toMatch(/lowercase letter/)
    expect(nameProblem('1orders')).toMatch(/starts with/)
    expect(nameProblem('my_db')).toMatch(/only lowercase/)
  })

  it('puts lag into words', () => {
    expect(lagText(null)).toBe('not known')
    expect(lagText(0)).toBe('up to date')
    expect(lagText(1)).toBe('1 write behind')
    expect(lagText(1234)).toBe('1,234 writes behind')
  })
})

describe('explaining a failure', () => {
  it('says what to do for the codes a person can act on', () => {
    expect(explain({ code: 'UNAUTHENTICATED', message: 'x' })).toMatch(/not accepted/)
    expect(explain({ code: 'NAME_CONFLICT', message: 'x' })).toMatch(/already have/)
    expect(explain({ code: 'TIMEOUT', message: 'x' })).toMatch(/may or may not/)
    expect(explain({ code: 'NETWORK', message: 'connection refused' })).toMatch(/connection refused/)
  })

  it('falls back to the service message, then to the code', () => {
    expect(explain({ code: 'INVALID_NAME', message: 'name must be 2 to 48 characters' })).toBe('name must be 2 to 48 characters')
    expect(explain({ code: 'SOMETHING_NEW', message: '' })).toBe('SOMETHING_NEW')
  })
})
