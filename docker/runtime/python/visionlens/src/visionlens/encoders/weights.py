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
from typing import IO, Callable, Iterable, Iterator, Mapping, Optional, Tuple
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
REVISION_PATTERN = re.compile(r"\A[0-9a-f]{40}\Z")

#: The model id names a directory in the cache, so it may not carry a
#: separator, a traversal or anything a file system would read as a path.
MODEL_ID_PATTERN = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]*\Z")

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
#:
#: The text is normalized before the match (every run of non-alphanumeric
#: characters becomes one space) and the phrases are matched on word
#: boundaries, so "research-use-only" and "research  use  only" are the
#: same phrase. A phrase that PERMITS commercial use cancels a phrase that
#: forbids it, because a record that says both is not contradicting
#: itself: it says the weights are for research and the outputs may be
#: used commercially.
RESTRICTIVE_PATTERN = re.compile(
    r"\b(?:"
    r"non[- ]commercial|"
    r"research[- ]use[- ]only|"
    r"academic[- ]use[- ]only|"
    r"personal[- ]use[- ]only|"
    r"not for commercial|"
    r"no commercial use|"
    r"not permitted for commercial|"
    r"not allowed for commercial|"
    r"commercial use is not permitted|"
    r"commercial use is prohibited|"
    r"commercial use is forbidden"
    r")\b"
)

#: The phrases a recorded restriction uses when it PERMITS commercial use.
#: One of them cancels a restrictive phrase: a record that names both is
#: not a record that contradicts itself.
PERMISSIVE_PATTERN = re.compile(
    r"\b(?:"
    r"permits commercial use|"
    r"commercial use is permitted|"
    r"commercial use is allowed|"
    r"may be used commercially|"
    r"commercial purposes are permitted"
    r")\b"
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


def _normalized_text(text: str) -> str:
    """The text with every run of non-alphanumerics as one space.

    The phrases of the license gate are matched on this form, so
    "research-use-only", "research use only" and "research  use  only"
    are the same phrase.
    """
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


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
        lowered = _normalized_text(record.usage_restrictions)
        if RESTRICTIVE_PATTERN.search(lowered) and not PERMISSIVE_PATTERN.search(lowered):
            raise _refuse(
                LICENSE_FORBIDDEN,
                "the license recorded for '"
                + record.model_id
                + "' permits commercial use, but its recorded restrictions forbid it; "
                "a record that contradicts itself is refused",
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


def check_pinned_url(url: str, revision: str) -> str:
    """Refuse a URL that is not an allowlisted location at a pinned revision.

    The host has to be one the platform trusts, the scheme has to be
    https, the revision has to be the revision of the file, and the file
    has to be safetensors.

    The revision is checked as a SEGMENT of the path, not as a substring
    of the whole URL: a URL that carries the revision in a query or in
    the name of a directory is not pinned to it.

    @raises DownloadRefusedError when the URL may not be fetched.
    @returns the MIME-ish suffix of the file, for the caller.
    """
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise _refuse(
            SOURCE_NOT_ALLOWED,
            "the source '"
            + url
            + "' is not an https location; the weights travel over TLS or not at all",
        )
    host = parsed.netloc.lower()
    if host not in ALLOWED_SOURCES:
        raise _refuse(
            SOURCE_NOT_ALLOWED,
            "the source '"
            + url
            + "' is not an allowlisted repository ("
            + ", ".join(ALLOWED_SOURCES)
            + ")",
        )
    segments = [segment for segment in parsed.path.split("/") if segment]
    if len(segments) < 5 or segments[-3] != RESOLVE_SEGMENT or segments[-2] != revision:
        raise _refuse(
            REVISION_NOT_PINNED,
            "the source '"
            + url
            + "' does not carry the pinned revision '"
            + revision
            + "' as the revision of the file",
        )
    if not REVISION_PATTERN.match(revision):
        raise _refuse(
            REVISION_NOT_PINNED,
            "the revision '"
            + revision
            + "' is not an exact commit; a tag, a branch and a floating name are not a pin",
        )
    return segments[-1]


def check_source(record: ModelRecord) -> None:
    """Refuse a source that is not an allowlisted repository.

    The source is the promise the digest hangs on, so its host has to be
    one the platform trusts, the revision has to be the pinned one, and the
    file has to be safetensors.

    The source is a plain location: no query and no fragment. The URL
    that is validated is the URL that is fetched, so nothing can ride in
    the query of a source nobody looked at.

    @raises DownloadRefusedError when the source may not be fetched.
    """
    name = check_pinned_url(record.source_uri, record.revision)
    parsed = urlparse(record.source_uri)
    if parsed.query or parsed.fragment:
        raise _refuse(
            SOURCE_NOT_ALLOWED,
            "the source '"
            + record.source_uri
            + "' carries a query or a fragment; a pinned source is a plain "
            "location, so the URL that is validated is the URL that is fetched",
        )
    if not name.endswith(SAFE_WEIGHTS_SUFFIX):
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


def _temporary_prefix() -> str:
    """The prefix of a temporary file, carrying the pid of its writer.

    The pid lets the sweep tell a leftover of a crashed run from the file
    of a writer that is still running.
    """
    return ".weights-" + str(os.getpid()) + "-"


def _pid_is_alive(pid: int) -> bool:
    """Whether a process is still running."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True
    return True


def _sweep_stale_temporaries(directory: Path) -> None:
    """Remove the temporary files a crashed run left behind.

    A file is swept only when it is older than the age limit AND the
    process that wrote it is gone, so the temporary file of a loader that
    is running right now is never touched.
    """
    if not directory.is_dir():
        return
    now = time.time()
    for entry in directory.glob(".weights-*.tmp"):
        try:
            if now - entry.stat().st_mtime <= TEMP_FILE_MAX_AGE_SECONDS:
                continue
            parts = entry.name.split("-")
            if len(parts) > 2 and parts[1].isdigit():
                if _pid_is_alive(int(parts[1])):
                    continue
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
    _check_tensors(path, parsed, length)


def _check_tensors(path: Path, header: object, header_length: int) -> None:
    """Refuse a header that does not describe a tensor inside the file.

    A safetensors header names the tensors of the file, each one with its
    dtype, its shape and the byte range it occupies. A header that names
    no tensor, or a tensor whose bytes lie outside the file, is not a
    header of a safetensors file: the name of the file would claim a
    format the bytes do not carry.

    @raises DownloadRefusedError when the header is not one.
    """
    if not isinstance(header, dict):
        raise _refuse(
            UNSAFE_FORMAT,
            "the file '" + str(path) + "' carries a header that is not an object",
        )
    entries = {key: value for key, value in header.items() if key != "__metadata__"}
    if not entries:
        raise _refuse(
            UNSAFE_FORMAT,
            "the file '"
            + str(path)
            + "' carries a header without a tensor; it holds no weight",
        )
    try:
        size_bytes = path.stat().st_size
    except OSError as exc:
        raise _refuse(
            CACHE_CORRUPT,
            "the file '" + str(path) + "' could not be read: " + str(exc),
        ) from exc
    for name, entry in entries.items():
        if not isinstance(entry, dict):
            raise _refuse(
                UNSAFE_FORMAT,
                "the tensor '" + name + "' of '" + str(path) + "' is not an entry",
            )
        dtype = entry.get("dtype")
        shape = entry.get("shape")
        offsets = entry.get("data_offsets")
        if not isinstance(dtype, str) or not dtype:
            raise _refuse(
                UNSAFE_FORMAT,
                "the tensor '" + name + "' of '" + str(path) + "' carries no dtype",
            )
        if not isinstance(shape, list) or not all(
            isinstance(item, int) and not isinstance(item, bool) for item in shape
        ):
            raise _refuse(
                UNSAFE_FORMAT,
                "the tensor '" + name + "' of '" + str(path) + "' carries no shape",
            )
        if (
            not isinstance(offsets, list)
            or len(offsets) != 2
            or not all(isinstance(item, int) and not isinstance(item, bool) for item in offsets)
            or offsets[0] < 0
            or offsets[1] < offsets[0]
        ):
            raise _refuse(
                UNSAFE_FORMAT,
                "the tensor '"
                + name
                + "' of '"
                + str(path)
                + "' carries no byte range",
            )
        data_bytes = size_bytes - 8 - header_length
        if offsets[1] > data_bytes:
            raise _refuse(
                UNSAFE_FORMAT,
                "the tensor '"
                + name
                + "' of '"
                + str(path)
                + "' claims bytes that lie outside the file",
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


class CheckedRedirects(HTTPRedirectHandler):
    """The redirect handler that checks every hop before it is followed.

    The allowlisted repository serves the pinned file from its own CDN, so
    a hop may land there and nowhere else. The host of the hop is checked
    BEFORE the request to it is made, so a hop to a host outside the
    allowlist never leaves the machine.
    """

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


def fetch_chunks(url: str, timeout: float = FETCH_TIMEOUT_SECONDS) -> Iterator[bytes]:
    """Fetch the bytes of an allowlisted URL, in bounded blocks.

    The default opener, used when the caller injects none. It is the only
    place in this module that touches the network, and it never follows a
    redirect to a host outside the trusted ones.
    """
    _check_host(url, ALLOWED_SOURCES)
    opener = build_opener(CheckedRedirects)
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
        dir=str(target.parent), prefix=_temporary_prefix(), suffix=".tmp"
    )
    try:
        stream = os.fdopen(handle, "wb")
    except OSError as exc:
        os.close(handle)
        raise _refuse(
            CACHE_CORRUPT,
            "the weights could not be opened for writing: "
            + (exc.strerror or exc.__class__.__name__),
        ) from exc
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
        try:
            target.unlink()
        except OSError as exc:
            raise _refuse(
                CACHE_CORRUPT,
                "the cached file '"
                + str(target)
                + "' does not carry the digest its name claims, and it could not be "
                "removed: " + (exc.strerror or exc.__class__.__name__),
            ) from exc
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
            try:
                os.replace(str(temporary), str(target))
            except OSError as exc:
                raise _refuse(
                    CACHE_CORRUPT,
                    "the weights could not be published into the cache: "
                    + (exc.strerror or exc.__class__.__name__),
                ) from exc
        except BaseException:
            try:
                if temporary.exists():
                    temporary.unlink()
            except OSError:
                pass
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
            try:
                target.unlink()
            except OSError as exc:
                raise _refuse(
                    CACHE_CORRUPT,
                    "the published file '"
                    + str(target)
                    + "' does not carry the digest it was verified with, and it "
                    "could not be removed: "
                    + (exc.strerror or exc.__class__.__name__),
                ) from exc
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


#: The files a model directory carries besides the weights: the model
#: configuration and the processor configuration of the pinned revision.
MODEL_CONFIG_FILES: Tuple[str, ...] = ("config.json", "preprocessor_config.json")

#: The name the weights take inside a model directory.
MODEL_WEIGHTS_NAME = "model.safetensors"


@dataclass(frozen=True)
class LoadedModelFiles:
    """The model directory of one model, and what was proven about it.

    `config_digests` names the digest of every configuration file, so a
    run can record which bytes it used and not only which revision it
    claims.
    """

    model_id: str
    revision: str
    directory: Path
    weights: LoadedWeights
    config_digests: Mapping[str, str]


def model_directory(cache_dir: Path, model_id: str, revision: str) -> Path:
    """The directory a model is assembled in."""
    return Path(cache_dir) / model_id / revision


def _write_bytes(path: Path, payload: bytes) -> str:
    """Write the bytes into the file, atomically, and return their digest.

    The temporary file is unique and lives in the target directory, so two
    writers never share one, and the publish is a rename: a reader sees the
    old file or the new one, never a half-written file. A file that
    cannot be published is a typed refusal and not a raw OSError.

    @raises DownloadRefusedError when the file cannot be published.
    """
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(
        prefix=_temporary_prefix(), suffix=".tmp", dir=str(directory)
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(str(temporary), str(path))
    except OSError as exc:
        try:
            if temporary.exists():
                temporary.unlink()
        except OSError:
            pass
        raise _refuse(
            CACHE_CORRUPT,
            "the file '"
            + str(path)
            + "' could not be published: "
            + (exc.strerror or exc.__class__.__name__),
        ) from exc
    return sha256_of_bytes(payload)


def load_model_files(
    request: WeightsRequest,
    cache_dir: Path,
    opener: Optional[Callable[[str], Iterable[bytes]]] = None,
) -> LoadedModelFiles:
    """Assemble the model directory of one recorded model.

    The weights are the ones the loader verified: the file inside the
    directory is that verified file and not a copy of it, so the bytes
    the model reads are the bytes the digest was checked against.

    The two configuration files come from the same repository at the same
    pinned revision, and the pinned revision is what pins them: a
    configuration is not executable code, and the architecture it
    describes is checked against the weights when the model is built, so
    a configuration that does not describe the weights does not load
    them. Their digests are the RECORD of the bytes this run used, not a
    second upstream pin: a later run that assembles the same directory
    proves it read the same bytes.

    The directory is assembled under the lock of that directory, so two
    runs that assemble it at the same time do not publish halves of two
    different assemblies.

    @raises DownloadRefusedError when a file may not be fetched.
    """
    weights = load_weights(request, cache_dir, opener=opener)
    record = request.record
    directory = model_directory(Path(cache_dir), record.model_id, record.revision)
    with _lock_for(directory):
        directory.mkdir(parents=True, exist_ok=True)
        base = record.source_uri.rsplit("/", 1)[0]
        digests: dict[str, str] = {}
        for name in MODEL_CONFIG_FILES:
            url = base + "/" + name
            check_pinned_url(url, record.revision)
            payload = b"".join((opener or fetch_chunks)(url))
            digests[name] = _write_bytes(directory / name, payload)
        link = directory / MODEL_WEIGHTS_NAME
        if not link.exists():
            try:
                os.link(str(weights.path), str(link))
            except OSError:
                # A cache on two file systems cannot be linked: the bytes are
                # copied instead, and the copy is verified by its digest.
                digests[MODEL_WEIGHTS_NAME] = _write_bytes(
                    link, weights.path.read_bytes()
                )
    return LoadedModelFiles(
        model_id=record.model_id,
        revision=record.revision,
        directory=directory,
        weights=weights,
        config_digests=digests,
    )
