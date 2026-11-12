# Deterministic OpenAI-compatible mock provider.
#
# The seam is OPENAI_BASE_URL: point the repository's provider layer at this
# server and the real client code path runs with no credentials and no network.
# The image is Python-only on purpose: no Node, no SDK, no keys.

FROM python:3.11-slim

WORKDIR /app
COPY server.py .

EXPOSE 8080

ENV MOCK_HOST=0.0.0.0 \
    MOCK_PORT=8080 \
    MOCK_SCRIPT=ok

HEALTHCHECK --interval=5s --timeout=3s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).status == 200 else 1)"

ENTRYPOINT ["python", "server.py"]
