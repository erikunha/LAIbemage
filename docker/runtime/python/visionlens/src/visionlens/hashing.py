"""The one way this package hashes bytes.

A digest is a promise, and a promise that is computed differently in two
places is two promises. Every sha256 of a file in this package is computed
here, in bounded blocks, so a file larger than the memory of the machine is
never held whole and every digest of the same bytes is the same digest.

The block size is the unit of work: a megabyte at a time, which keeps the
resident memory of the hash flat no matter how large the file is.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Iterable

#: The block size every digest reads in.
BLOCK_BYTES = 1024 * 1024


def sha256_of_file(path: Path) -> str:
    """The sha256 of the bytes of a file, read in bounded blocks.

    The file is never held in memory: one block at a time.
    """
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(BLOCK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_of_blocks(blocks: Iterable[bytes]) -> str:
    """The sha256 of a stream of blocks, read as they arrive.

    The blocks are never collected: one block at a time.
    """
    digest = hashlib.sha256()
    for block in blocks:
        digest.update(block)
    return digest.hexdigest()


def sha256_of_bytes(payload: bytes) -> str:
    """The sha256 of the bytes that are already in memory."""
    return hashlib.sha256(payload).hexdigest()
