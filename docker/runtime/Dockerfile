# Python worker runtime image: the visionlens wheel, installed and proven, no Node.
#
# The build context is this directory. BuildKit does not follow a symlink out
# of the context, so the wheel source is vendored at python/visionlens (real
# files, refreshed by sync-visionlens.sh from the canonical python/visionlens).
# The builder stage compiles the wheel; the runtime stage installs ONLY that
# wheel, then proves it during the build: the smoke RUN spawns the installed
# worker, asserts the unprompted hello frame speaks visionlens.worker.v1, and
# fails the build otherwise. An image that builds is an image whose wheel
# handshakes without Node. At run time the image is the same entrypoint the
# package's own tests spawn, python -m visionlens.worker: stdio JSONL, so the
# host drives it with docker run -i.

FROM python:3.11-slim AS builder

WORKDIR /build
COPY python/visionlens ./python/visionlens
RUN python -m pip wheel --no-deps --wheel-dir /dist ./python/visionlens

FROM python:3.11-slim

RUN --mount=type=bind,from=builder,source=/dist,target=/wheels \
    python -m pip install --no-index --find-links=/wheels visionlens

# Build-time smoke proof: the installed wheel must handshake without Node.
# Spawns the worker, reads its unprompted hello, closes stdin, exits 0.
RUN python -c "import json,subprocess,sys; p=subprocess.Popen([sys.executable,'-m','visionlens.worker'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL); hello=json.loads(p.stdout.readline()); assert hello['kind']=='hello' and hello['protocol']=='visionlens.worker.v1', hello; p.stdin.close(); sys.exit(p.wait(timeout=30))"

WORKDIR /app

ENTRYPOINT ["python", "-m", "visionlens.worker"]
