"""Model weights: the fetch, and every refusal that comes before it.

The weights of a model are never fetched implicitly. Before a single byte is
fetched, the loader proves five things:

  - the USE is permitted by the recorded license (the license gate);
  - the CALLER granted an explicit permission (the opt-in);
  - the SOURCE is an allowlisted repository, at the pinned revision, and the
    file is safetensors (never a pickle);
  - the POLICY the record declares is the one this loader implements;
  - the DIGEST of the bytes that arrive is the digest the registry recorded.

The order matters: the license gate runs FIRST, so a use the license
forbids is refused before the permission is even asked about, and every
refusal happens before any network access. A refusal that arrives after the
bytes are on the disk is not a refusal.

The loader writes into a local cache and never redistributes the weights:
the bytes land in a cache directory, and the file name carries the digest,
so a cached file can be verified again without the network.

The bytes are never held in memory: the fetch is read in bounded blocks and
written straight into the cache, and every digest is computed from a file on
the disk, block by block.

The supply-chain rules this implements are the pack's
(docs/vnext/19-SECURITY-PRIVACY-SUPPLY-CHAIN.md:10, :15).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
from dataclasses import dataclass
from http.client import HTTPMessage
from pathlib import Path
from typing import IO, Callable, Iterable, Iterator, Tuple
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from ..downloads import (
    DownloadProvenance,
    DownloadRefusedError,
    authorize_download,
)
from ..hashing import sha256_of_bytes, sha256_of_file
from ..registry.record import ModelRecord

#: The repositories the platform may fetch weights from. A source outside
#: this list is refused before the fetch.
ALLOWED_SOURCES: Tuple[str, ...] = ("huggingface.co",)

#: The hosts a redirect of an allowlisted source may land on. The allowlisted
#: repository serves the pinned file from its own CDN, and every hop is
#: checked before it is followed.
ALLOWED_REDIRECT_HOSTS: Tuple[str, ...] = ("huggingface.co", "hf.co")

#: The only weight format the loader accepts. A pickle checkpoint is code,
#: and this loader never loads code.
SAFE_WEIGHTS_SUFFIX = ".safetensors"

#: The uses the loader understands. A use it does not know is refused.
MODEL_USES: Tuple[str, ...] = ("inference", "commercial", "redistribution")

#: The path layout of an allowlisted source:
#: /<owner>/<repository>/resolve/<revision>/<file>
RESOLVE_SEGMENT = "resolve"

#: The revision of an allowlisted source is a commit: 40 lowercase hex
#: characters. A tag, a branch and a floating name are not a pin.
REVISION_PATTERN = re.compile(r"^[0-9a-f]{40}$")

#: The model id names a directory in the cache, so it may not carry a
#: separator, a traversal or anything a file system would read as a path.
MODEL_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

#: The block size every digest and every fetch reads in.
BLOCK_BYTES = 1024 * 1024

#: The timeout of the default fetch, in seconds. A source that never answers
#: must not hold the runtime forever.
FETCH_TIMEOUT_SECONDS = 30.0

#: The largest safetensors header the loader accepts, in bytes.
MAX_HEADER_BYTES = 100 * 1024 * 1024

#: A temporary file older than this, in seconds, is a leftover of a crashed
#: run and is swept before a new write.
TEMP_FILE_MAX_AGE_SECONDS = 3600.0

#: The trust policies this loader implements. A record that declares any
#: other policy is refused: the loader applies the gates it declares, not
#: the gates of a policy it does not know.
SUPPORTED_TRUST_POLICIES: Tuple[str, ...] = ("allowlisted-pinned-safetensors-only",)

#: The phrases a recorded restriction uses when it forbids a use. The gate
#: reads the FACTS the registry recorded and never parses a licence text;
#: these phrases only catch a record that CONTRADICTS its own structured
#: fact, so a record cannot permit commercial use and forbid it at the
#: same time.
RESTRICTIVE_PHRASES: Tuple[str, ...] = (
    "non-commercial",
    "noncommercial",
    "not for commercial",
    "no commercial",
    "research use only",
    "research-only",
    "academic use only",
    "personal use only",
)

#: The reason codes of the refusals this module adds. The permission and the
#: provenance reasons are the ones `visionlens.downloads` already names.
LICENSE_FORBIDDEN = "LICENSE_FORBIDDEN"
SOURCE_NOT_ALLOWED = "SOURCE_NOT_ALLOWED"
REVISION_NOT_PINNED = "REVISION_NOT_PINNED"
UNSAFE_FORMAT = "UNSAFE_FORMAT"
DIGEST_MISMATCH = "DIGEST_MISMATCH"
USE_NOT_KNOWN = "USE_NOT_KNOWN"
CACHE_CORRUPT = "CACHE_CORRUPT"
TRUST_POLICY_UNSUPPORTED = "TRUST_POLICY_UNSUPPORTED"
MODEL_ID_UNSAFE = "MODEL_ID_UNSAFE"

#: The locks that keep two loaders of the same file from fetching it twice.
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


@dataclass(frozen=True)
class DownloadPermission:
    """An explicit permission to fetch bytes, and who granted it.

    The permission is an object and not a flag on its own: a request nobody
    granted is refused, and a grant names the actor that allowed it. There
    is no default, and there is no truthy value: a permission is granted or
    refused, and nothing else.
    """

    granted: bool
    granted_by: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.granted, bool):
            raise ValueError("a permission is granted or refused, never truthy")
        if self.granted and not self.granted_by:
            raise ValueError("a granted permission names the actor that granted it")

    @classmethod
    def grant(cls, actor: str) -> "DownloadPermission":
        """A permission the named actor granted."""
        return cls(granted=True, granted_by=actor)

    @classmethod
    def deny(cls) -> "DownloadPermission":
        """The absence of a permission."""
        return cls(granted=False)


@dataclass(frozen=True)
class WeightsRequest:
    """One request for the weights of a recorded model.

    `permission` is an explicit opt-in, never a default: a caller that did
    not grant it asks for a refusal.
    """

    record: ModelRecord
    use: str
    permission: DownloadPermission


@dataclass(frozen=True)
class AuthorizedWeights:
    """A request that passed every gate. Carrying the proof."""

    record: ModelRecord
    use: str
    source: str
    revision: str
    digest: str
    license: str


@dataclass(frozen=True)
class LoadedWeights:
    """The weights on disk, and what was proven about them."""

    model_id: str
    path: Path
    digest: str
    revision: str
    size_bytes: int
    from_cache: bool


def _refuse(reason: str, message: str) -> DownloadRefusedError:
    return DownloadRefusedError(reason, message)


def check_license(record: ModelRecord, use: str) -> None:
    """Refuse a use the recorded license does not permit.

    The gate runs before anything else, and it never parses the licence
    text: it reads the FACTS the registry recorded.

      - `inference` is permitted by any recorded licence: the model may be
        run locally.
      - `commercial` is permitted only when the record says the licence
        permits commercial use, and only when the recorded restrictions do
        not contradict that fact.
      - `redistribution` is refused: this loader writes into a local cache
        and never ships the weights, so a redistribution is outside what it
        can decide. A person who wants to redistribute reads the licence
        text, which the record names in `licenseUrl`.

    @raises DownloadRefusedError when the use is not permitted.
    """
    if use not in MODEL_USES:
        raise _refuse(
            USE_NOT_KNOWN,
            "the use '"
            + use
            + "' is not one the weights loader knows ("
            + ", ".join(MODEL_USES)
            + ")",
        )
    if use == "commercial" and not record.commercial_use:
        raise _refuse(
            LICENSE_FORBIDDEN,
            "the license recorded for '"
            + record.model_id
            + "' does not permit commercial use, so the use '"
            + use
            + "' is refused",
        )
    if use == "commercial":
        lowered = record.usage_restrictions.lower()
        contradicting = [phrase for phrase in RESTRICTIVE_PHRASES if phrase in lowered]
        if contradicting:
            raise _refuse(
                LICENSE_FORBIDDEN,
                "the license recorded for '"
                + record.model_id
                + "' permits commercial use, but its recorded restrictions forbid it ('"
                + ", ".join(contradicting)
                + "'); a record that contradicts itself is refused",
            )
    if use == "redistribution":
        raise _refuse(
            LICENSE_FORBIDDEN,
            "the weights loader writes into a local cache and never redistributes the "
            "weights, so the use '"
            + use
            + "' is refused; the license text is at '"
            + record.license_url
            + "'",
        )


def check_trust_policy(record: ModelRecord) -> None:
    """Refuse a record whose trust policy this loader does not implement.

    The policy a record declares is the set of rules the platform runs it
    under. This loader implements one policy, and a record that declares
    another one is refused rather than run under rules it did not ask for.

    @raises DownloadRefusedError when the policy is not implemented here.
    """
    if record.trust_policy not in SUPPORTED_TRUST_POLICIES:
        raise _refuse(
            TRUST_POLICY_UNSUPPORTED,
            "the record for '"
            + record.model_id
            + "' declares the trust policy '"
            + record.trust_policy
            + "', which the weights loader does not implement ("
            + ", ".join(SUPPORTED_TRUST_POLICIES)
            + ")",
        )


def check_source(record: ModelRecord) -> None:
    """Refuse a source that is not an allowlisted repository.

    The source is the promise the digest hangs on, so its host has to be
    one the platform trusts, the revision has to be the pinned one, and the
    file has to be safetensors.

    The revision is checked as a SEGMENT of the path, not as a substring of
    the whole URL: a URL that carries the revision in a query or in the
    name of a directory is not pinned to it.

    @raises DownloadRefusedError when the source may not be fetched.
    """
    parsed = urlparse(record.source_uri)
    if parsed.scheme != "https":
        raise _refuse(
            SOURCE_NOT_ALLOWED,
            "the source '"
            + record.source_uri
            + "' is not an https location; the weights travel over TLS or not at all",
        )
    host = parsed.netloc.lower()
    if host not in ALLOWED_SOURCES:
        raise _refuse(
            SOURCE_NOT_ALLOWED,
            "the source '"
            + record.source_uri
            + "' is not an allowlisted repository ("
            + ", ".join(ALLOWED_SOURCES)
            + ")",
        )
    segments = [segment for segment in parsed.path.split("/") if segment]
    if (
        len(segments) < 5
        or segments[-3] != RESOLVE_SEGMENT
        or segments[-2] != record.revision
    ):
        raise _refuse(
            REVISION_NOT_PINNED,
            "the source '"
            + record.source_uri
            + "' does not carry the pinned revision '"
            + record.revision
            + "' as the revision of the file",
        )
    if not REVISION_PATTERN.match(record.revision):
        raise _refuse(
            REVISION_NOT_PINNED,
            "the revision '"
            + record.revision
            + "' is not an exact commit; a tag, a branch and a floating name are not a pin",
        )
    if not segments[-1].endswith(SAFE_WEIGHTS_SUFFIX):
        raise _refuse(
            UNSAFE_FORMAT,
            "the source '"
            + record.source_uri
            + "' is not a "
            + SAFE_WEIGHTS_SUFFIX
            + " file; a pickle checkpoint is code and is never loaded here",
        )


def check_model_id(record: ModelRecord) -> None:
    """Refuse a model id that may not name a directory in the cache.

    The model id is a path element. An id that carries a separator or a
    traversal would place the weights outside the cache, so it is refused
    before a single byte is fetched.

    @raises DownloadRefusedError when the id may not name a directory.
    """
    if not MODEL_ID_PATTERN.match(record.model_id):
        raise _refuse(
            MODEL_ID_UNSAFE,
            "the model id '"
            + record.model_id
            + "' may not name a directory in the cache; it may only carry letters, "
            "digits, dots, dashes and underscores",
        )


def authorize_weights_download(request: WeightsRequest) -> AuthorizedWeights:
    """Authorize one weights download, or refuse it with a typed error.

    Every refusal happens here, before any network access: the license
    gate, the opt-in, the provenance, the trust policy, the allowlist, the
    pinned revision, the format and the model id.

    @raises DownloadRefusedError when the request may not be served.
    """
    record = request.record
    check_license(record, request.use)
    authorized = authorize_download(
        "model",
        record.model_id,
        permitted=request.permission.granted,
        provenance=DownloadProvenance(
            source=record.source_uri,
            revision=record.revision,
            license=record.license,
            sha256=record.source_digest,
        ),
    )
    check_trust_policy(record)
    check_source(record)
    check_model_id(record)
    return AuthorizedWeights(
        record=record,
        use=request.use,
        source=authorized.provenance.source,
        revision=authorized.provenance.revision,
        digest=authorized.provenance.sha256,
        license=authorized.provenance.license,
    )


def digest_of_bytes(payload: bytes) -> str:
    """Return the sha256 hex digest of the bytes."""
    return sha256_of_bytes(payload)


def cache_path(cache_dir: Path, model_id: str, digest: str) -> Path:
    """The path a cached weight file occupies.

    The name carries the digest, so a cached file names the bytes it holds.
    """
    return Path(cache_dir) / model_id / (digest + SAFE_WEIGHTS_SUFFIX)


def _lock_for(target: Path) -> threading.Lock:
    """The lock that guards one cached file."""
    key = str(target)
    with _LOCKS_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _LOCKS[key] = lock
        return lock


def _sweep_stale_temporaries(directory: Path) -> None:
    """Remove the temporary files a crashed run left behind.

    Only a file older than the age limit is swept, so the temporary file of
    a loader that is running right now is never touched.
    """
    if not directory.is_dir():
        return
    now = time.time()
    for entry in directory.glob(".weights-*.tmp"):
        try:
            if now - entry.stat().st_mtime > TEMP_FILE_MAX_AGE_SECONDS:
                entry.unlink()
        except OSError:
            continue


def check_safetensors(path: Path) -> None:
    """Refuse a file whose bytes are not safetensors.

    The name of a cached file claims a format, and the bytes have to carry
    it: a safetensors file starts with the length of its JSON header and
    then the header itself. A pickle checkpoint starts with a protocol
    marker and a length that is not a header at all.

    @raises DownloadRefusedError when the bytes are not safetensors.
    """
    try:
        with path.open("rb") as handle:
            raw_length = handle.read(8)
            if len(raw_length) != 8:
                raise _refuse(
                    UNSAFE_FORMAT,
                    "the file '"
                    + str(path)
                    + "' is too short to carry a safetensors header",
                )
            length = int.from_bytes(raw_length, "little")
            if length <= 0 or length > MAX_HEADER_BYTES:
                raise _refuse(
                    UNSAFE_FORMAT,
                    "the file '"
                    + str(path)
                    + "' declares a safetensors header of "
                    + str(length)
                    + " bytes, which no safetensors file carries",
                )
            header = handle.read(length)
    except OSError as exc:
        raise _refuse(
            CACHE_CORRUPT,
            "the file '" + str(path) + "' could not be read: " + str(exc),
        ) from exc
    if len(header) != length:
        raise _refuse(
            UNSAFE_FORMAT,
            "the file '"
            + str(path)
            + "' is shorter than the safetensors header it declares",
        )
    try:
        parsed = json.loads(header.decode("utf8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _refuse(
            UNSAFE_FORMAT,
            "the file '"
            + str(path)
            + "' does not carry a safetensors header; a pickle checkpoint is code "
            "and is never loaded here",
        ) from exc
    if not isinstance(parsed, dict) or not parsed:
        raise _refuse(
            UNSAFE_FORMAT,
            "the file '"
            + str(path)
            + "' carries an empty safetensors header; it holds no tensor",
        )


def _check_host(url: str, hosts: Tuple[str, ...]) -> None:
    """Refuse a URL whose host is not one of the trusted ones.

    @raises DownloadRefusedError when the host is not trusted.
    """
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise _refuse(
            SOURCE_NOT_ALLOWED,
            "the url '" + url + "' is not an https location",
        )
    host = parsed.netloc.lower()
    for allowed in hosts:
        if host == allowed or host.endswith("." + allowed):
            return
    raise _refuse(
        SOURCE_NOT_ALLOWED,
        "the url '"
        + url
        + "' does not name a trusted host ("
        + ", ".join(hosts)
        + ")",
    )


def fetch_chunks(url: str, timeout: float = FETCH_TIMEOUT_SECONDS) -> Iterator[bytes]:
    """Fetch the bytes of an allowlisted URL, in bounded blocks.

    The default opener, used when the caller injects none. It is the only
    place in this module that touches the network, and it never follows a
    redirect to a host outside the trusted ones.
    """

    class _CheckedRedirects(HTTPRedirectHandler):
        def redirect_request(
            self,
            req: Request,
            fp: IO[bytes],
            code: int,
            msg: str,
            headers: HTTPMessage,
            newurl: str,
        ) -> Request | None:
            _check_host(newurl, ALLOWED_REDIRECT_HOSTS)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    _check_host(url, ALLOWED_SOURCES)
    opener = build_opener(_CheckedRedirects)
    # The host was allowlisted above, and every redirect is checked too.
    with opener.open(url, timeout=timeout) as response:
        while True:
            block = response.read(BLOCK_BYTES)
            if not block:
                break
            yield block


def _write_stream(target: Path, blocks: Iterable[bytes]) -> Tuple[str, int, Path]:
    """Write the blocks into a temporary file and digest them on the way.

    The bytes are never held in memory: one block at a time. The digest is
    computed from the bytes that are written, and the file is flushed to
    the disk before it is closed.

    @raises DownloadRefusedError when the bytes cannot be written.
    """
    digest = hashlib.sha256()
    written = 0
    handle, temporary = tempfile.mkstemp(
        dir=str(target.parent), prefix=".weights-", suffix=".tmp"
    )
    try:
        stream = os.fdopen(handle, "wb")
    except BaseException:
        os.close(handle)
        raise
    try:
        with stream:
            for block in blocks:
                digest.update(block)
                stream.write(block)
                written += len(block)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as exc:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise _refuse(
            CACHE_CORRUPT,
            "the weights could not be written to the cache: "
            + (exc.strerror or exc.__class__.__name__),
        ) from exc
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise
    return digest.hexdigest(), written, Path(temporary)


def _reuse_cached(target: Path, authorized: AuthorizedWeights) -> LoadedWeights:
    """Use a cached file, after proving it carries the digest it names."""
    try:
        actual = sha256_of_file(target)
        size_bytes = target.stat().st_size
    except OSError as exc:
        raise _refuse(
            CACHE_CORRUPT,
            "the cached file '"
            + str(target)
            + "' could not be read: "
            + (exc.strerror or exc.__class__.__name__),
        ) from exc
    if actual != authorized.digest:
        # A cached file that does not match its own name is not trusted: it
        # is removed, and the caller is told the cache was corrupt.
        target.unlink()
        try:
            target.parent.rmdir()
        except OSError:
            pass
        raise _refuse(
            CACHE_CORRUPT,
            "the cached file '"
            + str(target)
            + "' does not carry the digest its name claims; it was removed",
        )
    return LoadedWeights(
        model_id=authorized.record.model_id,
        path=target,
        digest=authorized.digest,
        revision=authorized.revision,
        size_bytes=size_bytes,
        from_cache=True,
    )


def load_weights(
    request: WeightsRequest,
    cache_dir: Path,
    opener: Callable[[str], Iterable[bytes]] | None = None,
) -> LoadedWeights:
    """Load the weights of a recorded model into the local cache.

    The file is verified before it is published: the bytes that arrive must
    carry the recorded digest and must be safetensors, and the file that
    lands in the cache is read back from the disk and verified once more,
    so the file the caller receives is the file that was verified. A cached
    file whose digest matches is reused without any fetch.

    @raises DownloadRefusedError when the request may not be served, or
        when the bytes that arrived are not the bytes that were recorded.
    """
    authorized = authorize_weights_download(request)
    record = authorized.record
    root = Path(cache_dir).expanduser().resolve()
    target = cache_path(root, record.model_id, authorized.digest)
    if not target.resolve().is_relative_to(root):
        raise _refuse(
            MODEL_ID_UNSAFE,
            "the weights of '"
            + record.model_id
            + "' would land outside the cache directory '"
            + str(root)
            + "'",
        )
    with _lock_for(target):
        _sweep_stale_temporaries(target.parent)
        if target.exists():
            return _reuse_cached(target, authorized)
        target.parent.mkdir(parents=True, exist_ok=True)
        streamed, written, temporary = _write_stream(
            target, (opener or fetch_chunks)(authorized.source)
        )
        try:
            if streamed != authorized.digest:
                raise _refuse(
                    DIGEST_MISMATCH,
                    "the bytes fetched for '"
                    + record.model_id
                    + "' carry the digest "
                    + streamed
                    + ", not the recorded "
                    + authorized.digest,
                )
            check_safetensors(temporary)
            os.replace(str(temporary), str(target))
        except BaseException:
            if temporary.exists():
                temporary.unlink()
            raise
        try:
            published = sha256_of_file(target)
        except OSError as exc:
            raise _refuse(
                CACHE_CORRUPT,
                "the published file '"
                + str(target)
                + "' could not be read: "
                + (exc.strerror or exc.__class__.__name__),
            ) from exc
        if published != authorized.digest:
            target.unlink()
            raise _refuse(
                CACHE_CORRUPT,
                "the published file '"
                + str(target)
                + "' does not carry the digest it was verified with; it was removed",
            )
        return LoadedWeights(
            model_id=record.model_id,
            path=target,
            digest=authorized.digest,
            revision=authorized.revision,
            size_bytes=written,
            from_cache=False,
        )
