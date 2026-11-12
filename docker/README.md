# Docker images

Two local development images, one directory each. Neither is a deployment
artifact; both are seams for running the real code paths without credentials
or external services.

| Image | Directory | Base | What it is |
|---|---|---|---|
| `visionlens-worker-runtime` | `docker/runtime/` | `python:3.11-slim` | the `visionlens` wheel installed and proven at build time; runs the JSONL worker on stdio, no Node |
| `visionlens-mock-provider` | `docker/mock-provider/` | `python:3.11-slim` | deterministic OpenAI-compatible mock, the `OPENAI_BASE_URL` seam |

## Build

```sh
docker build -t visionlens-worker-runtime docker/runtime
docker build -t visionlens-mock-provider docker/mock-provider
```

The worker runtime build proves itself: the last build step spawns the
installed worker, asserts its unprompted `hello` frame speaks
`visionlens.worker.v1`, then closes stdin. A build that succeeds is a wheel
that handshakes. The runtime stage installs only the wheel built by the
builder stage; no Node and no build tools ship in the final image.

The wheel source is vendored at `docker/runtime/python/visionlens` because
BuildKit cannot follow a symlink out of the build context. After editing
`python/visionlens`, refresh the copy and rebuild:

```sh
sh docker/runtime/sync-visionlens.sh
```

## Run the worker over stdio

The image entrypoint is the same one the package's own tests spawn:
`python -m visionlens.worker`. Frames are JSONL, one JSON object per line.
The worker writes its `hello` first, then serves host frames from stdin and
exits 0 when stdin closes.

```sh
docker run --rm -i visionlens-worker-runtime < /dev/null
```

That prints the `hello` frame and exits. Keep stdin open to drive a session:

```sh
docker run --rm -i visionlens-worker-runtime
```

## Point the TypeScript host at a local interpreter

`@vision-lens/core` spawns the worker as
`$VISION_LENS_WORKER_INTERPRETER $VISION_LENS_WORKER_SCRIPT [scriptArgs...]`.
The worker must start as a module (its imports are package relative), so with
the package installed locally you need a small file face, for example
`worker-main.py`:

```python
from visionlens.worker import main

if __name__ == "__main__":
    raise SystemExit(main())
```

```sh
python3 -m pip install python/visionlens
export VISION_LENS_WORKER_INTERPRETER=python3
export VISION_LENS_WORKER_SCRIPT="$PWD/worker-main.py"
```

`WorkerClient.launch()` with no options then spawns that pair; the same two
variables point at any virtualenv interpreter or script.

## Point the provider layer at the mock

```sh
docker run --rm -p 8080:8080 visionlens-mock-provider
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1
```

The mock serves `POST /v1/chat/completions`, `POST /v1/embeddings`,
`GET /v1/models` and `GET /healthz`. Responses are a pure function of the
request body. Failure scripting is server side through `MOCK_SCRIPT`, a comma
separated cycle applied to consecutive requests and repeated forever:

| Behavior | Effect |
|---|---|
| `ok` | normal deterministic response |
| `429`, `500`, `503` | that status with an OpenAI-shaped error body |
| `delay:N` | sleep N milliseconds, then answer `ok` |

```sh
docker run --rm -p 8080:8080 -e MOCK_SCRIPT=429,500,delay:200,ok visionlens-mock-provider
```
