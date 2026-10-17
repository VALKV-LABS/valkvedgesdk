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
from typing import Optional, Union

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
        self._aead = ChaCha20Poly1305(encryption_key_bytes(key))
        self._database = database.encode("utf-8")

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
