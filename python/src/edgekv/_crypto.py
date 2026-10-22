"""Value encryption in the valkvedge library's format.

A value written here opens on a local replica with the same key, and the other
way round::

    stored = nonce (12 random bytes) || ChaCha20-Poly1305 ciphertext and tag
    associated data = database name length (u32, little-endian) || database name || key

Binding the database name and the key means a value copied to another key or
database does not open. Needs the ``cryptography`` package:
``pip install "valkv-edgekv[encryption]"``.
"""

from __future__ import annotations

import os
import struct
from typing import Any, Dict, List, Mapping, Optional, Union

NONCE_LENGTH = 12
#: What encryption adds to each value: the nonce and the tag.
ENCRYPTION_OVERHEAD = NONCE_LENGTH + 16


def encryption_key_bytes(key: Union[bytes, bytearray, memoryview, str]) -> bytes:
    """A key as 32 bytes, from bytes or 64 hexadecimal characters. Raises ``ValueError``."""
    if isinstance(key, str):
        if len(key) != 64:
            raise ValueError("encryption_key must be 32 bytes, or 64 hexadecimal characters")
        try:
            return bytes.fromhex(key)
        except ValueError:
            raise ValueError("encryption_key must be 32 bytes, or 64 hexadecimal characters") from None
    key = bytes(key)
    if len(key) != 32:
        raise ValueError(f"encryption_key must be 32 bytes, not {len(key)}")
    return key


class ValueCipher:
    """Seals and opens the values of one database."""

    def __init__(self, key: Union[bytes, bytearray, memoryview, str], database: str) -> None:
        try:
            from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
        except ImportError:
            raise ImportError(
                'encryption needs the cryptography package: pip install "valkv-edgekv[encryption]"'
            ) from None
        self._key = encryption_key_bytes(key)
        self._aead = ChaCha20Poly1305(self._key)
        self._database = database.encode("utf-8")

    @property
    def data_key(self) -> bytes:
        """The key values are sealed with: the database's data key."""
        return self._key

    def _aad(self, key: bytes) -> bytes:
        return struct.pack("<I", len(self._database)) + self._database + key

    def seal(self, key: bytes, value: bytes, nonce: Optional[bytes] = None) -> bytes:
        """``key`` is the entry's key as stored. ``nonce`` is for tests only."""
        nonce = os.urandom(NONCE_LENGTH) if nonce is None else nonce
        return nonce + self._aead.encrypt(nonce, value, self._aad(key))

    def open(self, key: bytes, stored: bytes) -> Optional[bytes]:
        """The value, or ``None`` when it does not open: a wrong key, or a value that was not encrypted."""
        from cryptography.exceptions import InvalidTag

        if len(stored) < ENCRYPTION_OVERHEAD:
            return None
        try:
            return self._aead.decrypt(stored[:NONCE_LENGTH], stored[NONCE_LENGTH:], self._aad(key))
        except InvalidTag:
            return None


# Key slots: a database's values are sealed with its data key, and each key
# that may open it holds the data key sealed with it. Any one opens it. A
# database encrypted before key slots has none: its one key is its data key.
#
#   key id = hex of the first 8 bytes of the ChaCha20-Poly1305 tag over an
#            empty message, all-zero nonce, associated data b"valkvedge/key-id"
#   slot   = {"id", "wrapped": hex(nonce || sealed data key)}, associated data
#            b"valkvedge/data-key" || database name length (u32 LE) || name

KEY_ID_AAD = b"valkvedge/key-id"
SLOT_AAD = b"valkvedge/data-key"


def _aead(key: bytes) -> Any:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
    except ImportError:
        raise ImportError(
            'encryption needs the cryptography package: pip install "valkv-edgekv[encryption]"'
        ) from None
    return ChaCha20Poly1305(key)


def key_id(key: Union[bytes, bytearray, memoryview, str]) -> str:
    """Names a key without revealing it."""
    return _aead(encryption_key_bytes(key)).encrypt(bytes(NONCE_LENGTH), b"", KEY_ID_AAD)[:8].hex()


def new_key() -> str:
    """A new random key, as 64 hexadecimal characters."""
    return os.urandom(32).hex()


def _slot_aad(database: str) -> bytes:
    name = database.encode("utf-8")
    return SLOT_AAD + struct.pack("<I", len(name)) + name


def wrap_data_key(data_key: bytes, key: Union[bytes, str], database: str) -> Dict[str, str]:
    """The data key sealed with ``key``, for the database named ``database``."""
    nonce = os.urandom(NONCE_LENGTH)
    sealed = _aead(encryption_key_bytes(key)).encrypt(nonce, data_key, _slot_aad(database))
    return {"id": key_id(key), "wrapped": (nonce + sealed).hex()}


def unwrap_data_key(slots: List[Mapping[str, str]], key: Union[bytes, str], database: str) -> Optional[bytes]:
    """The data key, if one of ``slots`` opens with ``key``."""
    from cryptography.exceptions import InvalidTag

    raw = encryption_key_bytes(key)
    aead, ident = _aead(raw), key_id(raw)
    ordered = [s for s in slots if s.get("id") == ident] + [s for s in slots if s.get("id") != ident]
    for slot in ordered:
        try:
            wrapped = bytes.fromhex(slot.get("wrapped", ""))
        except ValueError:
            continue
        if len(wrapped) < NONCE_LENGTH:
            continue
        try:
            data_key = aead.decrypt(wrapped[:NONCE_LENGTH], wrapped[NONCE_LENGTH:], _slot_aad(database))
        except InvalidTag:
            continue
        if len(data_key) == 32:
            return data_key
    return None
