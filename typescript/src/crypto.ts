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
