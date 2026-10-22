/**
 * Value encryption for the remote client, in the valkvedge library's format,
 * so a value written here opens on a local replica with the same key, and
 * the other way round:
 *
 *   stored = nonce (12 random bytes) || ChaCha20-Poly1305 ciphertext and tag
 *   associated data = database name length (u32, little-endian) || database name || key
 *
 * Binding the database name and the key means a value copied to another key
 * or database does not open.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from '@noble/ciphers/webcrypto';

const NONCE_LENGTH = 12;
/** What encryption adds to each value: the nonce and the tag. */
export const ENCRYPTION_OVERHEAD = NONCE_LENGTH + 16;

const encoder = new TextEncoder();

/** A key as 32 bytes, from bytes or 64 hexadecimal characters. Throws `Error` with the reason. */
export function encryptionKeyBytes(key: Uint8Array | string): Uint8Array {
  if (typeof key === 'string') {
    if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('encryptionKey must be 32 bytes, or 64 hexadecimal characters');
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  if (key.byteLength !== 32) throw new Error(`encryptionKey must be 32 bytes, not ${key.byteLength}`);
  return new Uint8Array(key);
}

/** Seals and opens the values of one database. */
export class ValueCipher {
  private readonly key: Uint8Array;
  private readonly database: Uint8Array;

  constructor(key: Uint8Array | string, database: string) {
    this.key = encryptionKeyBytes(key);
    this.database = encoder.encode(database);
  }

  /** @internal The key values are sealed with: the database's data key. */
  get dataKey(): Uint8Array {
    return this.key;
  }

  private aad(key: Uint8Array): Uint8Array {
    const aad = new Uint8Array(4 + this.database.length + key.length);
    new DataView(aad.buffer).setUint32(0, this.database.length, true);
    aad.set(this.database, 4);
    aad.set(key, 4 + this.database.length);
    return aad;
  }

  /** `key` is the entry's key as stored. `nonce` is for tests only. */
  seal(key: Uint8Array, value: Uint8Array, nonce: Uint8Array = randomBytes(NONCE_LENGTH)): Uint8Array {
    const sealed = chacha20poly1305(this.key, nonce, this.aad(key)).encrypt(value);
    const out = new Uint8Array(NONCE_LENGTH + sealed.length);
    out.set(nonce);
    out.set(sealed, NONCE_LENGTH);
    return out;
  }

  /** The value, or `null` when it does not open: a wrong key, or a value that was not encrypted. */
  open(key: Uint8Array, stored: Uint8Array): Uint8Array | null {
    if (stored.length < ENCRYPTION_OVERHEAD) return null;
    try {
      return chacha20poly1305(this.key, stored.subarray(0, NONCE_LENGTH), this.aad(key)).decrypt(stored.subarray(NONCE_LENGTH));
    } catch {
      return null;
    }
  }
}

/**
 * Key slots: a database's values are sealed with its data key, and each key
 * that may open it holds the data key sealed with it. Any one opens it. A
 * database encrypted before key slots has none: its one key is its data key.
 *
 *   key id = hex of the first 8 bytes of the ChaCha20-Poly1305 tag over an
 *            empty message, all-zero nonce, associated data "valkvedge/key-id"
 *   slot   = { id, wrapped: hex(nonce || sealed data key) }, associated data
 *            "valkvedge/data-key" || database name length (u32 LE) || name
 */
export interface KeySlot {
  id: string;
  wrapped: string;
}

const KEY_ID_AAD = encoder.encode('valkvedge/key-id');
const SLOT_AAD = encoder.encode('valkvedge/data-key');

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function unhex(text: string): Uint8Array | null {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Names a key without revealing it. */
export function keyId(key: Uint8Array | string): string {
  const tag = chacha20poly1305(encryptionKeyBytes(key), new Uint8Array(NONCE_LENGTH), KEY_ID_AAD).encrypt(new Uint8Array(0));
  return hex(tag.subarray(0, 8));
}

/** A new random key, as 64 hexadecimal characters. */
export function newKey(): string {
  return hex(randomBytes(32));
}

function slotAad(database: string): Uint8Array {
  const name = encoder.encode(database);
  const aad = new Uint8Array(SLOT_AAD.length + 4 + name.length);
  aad.set(SLOT_AAD);
  new DataView(aad.buffer).setUint32(SLOT_AAD.length, name.length, true);
  aad.set(name, SLOT_AAD.length + 4);
  return aad;
}

/** The data key sealed with `key`, for the database named `database`. */
export function wrapDataKey(dataKey: Uint8Array, key: Uint8Array | string, database: string): KeySlot {
  const nonce = randomBytes(NONCE_LENGTH);
  const sealed = chacha20poly1305(encryptionKeyBytes(key), nonce, slotAad(database)).encrypt(dataKey);
  const wrapped = new Uint8Array(NONCE_LENGTH + sealed.length);
  wrapped.set(nonce);
  wrapped.set(sealed, NONCE_LENGTH);
  return { id: keyId(key), wrapped: hex(wrapped) };
}

/** The data key, if one of `slots` opens with `key`. */
export function unwrapDataKey(slots: KeySlot[], key: Uint8Array | string, database: string): Uint8Array | null {
  const bytes = encryptionKeyBytes(key);
  const id = keyId(bytes);
  const ordered = [...slots.filter((s) => s.id === id), ...slots.filter((s) => s.id !== id)];
  for (const slot of ordered) {
    const wrapped = unhex(slot.wrapped);
    if (!wrapped || wrapped.length < NONCE_LENGTH) continue;
    try {
      const dataKey = chacha20poly1305(bytes, wrapped.subarray(0, NONCE_LENGTH), slotAad(database)).decrypt(
        wrapped.subarray(NONCE_LENGTH),
      );
      if (dataKey.length === 32) return dataKey;
    } catch {
      // Not this slot.
    }
  }
  return null;
}
