// Fixture worker for the host client tests. It speaks the frozen
// visionlens.worker.v1 protocol and is scripted per test through FIXTURE_MODE.
// Frames go to stdout; logs go to the FIXTURE_LOG jsonl file (never stdout).
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { clearInterval, setInterval, setTimeout } from 'node:timers';

const MODE = process.env.FIXTURE_MODE ?? 'happy';
const LOG_PATH = process.env.FIXTURE_LOG;
const OPERATIONS = (process.env.FIXTURE_OPERATIONS ?? 'vision.embed')
  .split(',')
  .filter((entry) => entry.length > 0);
const PROTOCOL = process.env.FIXTURE_PROTOCOL ?? 'visionlens.worker.v1';
const MAX_FRAME_BYTES = Number(process.env.FIXTURE_MAX_FRAME_BYTES ?? 1048576);

function log(event) {
  if (LOG_PATH) appendFileSync(LOG_PATH, `${JSON.stringify(event)}\n`);
}

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function sendHello() {
  send({
    protocol: PROTOCOL,
    kind: 'hello',
    protocolVersion: '1.0.0',
    contractVersion: '1.0.0',
    supportedOperations: OPERATIONS,
    capabilities: { device: 'cpu', extras: [], models: [] },
    maxFrameBytes: MAX_FRAME_BYTES,
  });
  log({ event: 'hello-sent', protocol: PROTOCOL });
}

const seqs = new Map();
function nextSeq(requestId) {
  const current = seqs.get(requestId) ?? 0;
  seqs.set(requestId, current + 1);
  return current;
}

const timers = new Set();
function every(ms, fn) {
  const timer = setInterval(fn, ms);
  timers.add(timer);
  return () => {
    clearInterval(timer);
    timers.delete(timer);
  };
}

function progress(requestId, completed, total) {
  send({
    protocol: 'visionlens.worker.v1',
    kind: 'progress',
    requestId,
    seq: nextSeq(requestId),
    completed,
    total,
  });
}

function result(requestId, payload) {
  send({
    protocol: 'visionlens.worker.v1',
    kind: 'result',
    requestId,
    seq: nextSeq(requestId),
    result: payload,
  });
}

function errorFrame(requestId, code, message) {
  send({
    protocol: 'visionlens.worker.v1',
    kind: 'error',
    requestId,
    seq: nextSeq(requestId),
    code,
    message,
    retryable: false,
  });
}

function handleCancel(frame) {
  log({ event: 'cancel-received', requestId: frame.requestId });
  if (MODE === 'cancel-slow' || MODE === 'hang') {
    errorFrame(frame.requestId, 'CANCELLED', `cancelled by request ${frame.requestId}`);
  }
  // cancel-ignore deliberately does nothing with the frame.
}

function handleRequest(frame) {
  const { requestId } = frame;
  if (MODE === 'happy') {
    progress(requestId, 1, 2);
    progress(requestId, 2, 2);
    result(requestId, { operation: frame.operation, params: frame.params, echoed: true });
    return;
  }
  if (MODE === 'hang') {
    progress(requestId, 0, 10);
    return; // stays silent until cancelled
  }
  if (MODE === 'cancel-slow') {
    progress(requestId, 0, 100);
    let done = 1;
    every(40, () => {
      progress(requestId, Math.min(done, 100), 100);
      done += 1;
    });
    return;
  }
  if (MODE === 'cancel-ignore') {
    progress(requestId, 0, 100);
    every(40, () => undefined); // pending work so the process stays busy
    return;
  }
  if (MODE === 'stderr-secret') {
    // Logs a secret on STDERR (never stdout) and then dies, so the host's
    // structured stderr capture is exercised on the real channel.
    process.stderr.write('starting embed with api_key=abc123\n');
    log({ event: 'crashing', requestId });
    process.exit(1);
    return;
  }
  if (MODE === 'crash') {
    log({ event: 'crashing', requestId });
    process.exit(1);
    return;
  }
  if (MODE === 'oversized') {
    const bytes = Number(process.env.FIXTURE_OVERSIZED_BYTES ?? 100_000);
    process.stdout.write(`${'x'.repeat(bytes)}\n`);
    return;
  }
  if (MODE === 'malformed') {
    process.stdout.write('this line is not json\n');
    result(requestId, { tooLate: true });
    return;
  }
  if (MODE === 'bad-seq') {
    progress(requestId, 1, 10); // seq 0, valid
    // The same seq again: a deliberate violation of the monotonicity rule.
    send({
      protocol: 'visionlens.worker.v1',
      kind: 'progress',
      requestId,
      seq: 0,
      completed: 2,
      total: 10,
    });
    return;
  }
  if (MODE === 'seq-not-zero') {
    send({
      protocol: 'visionlens.worker.v1',
      kind: 'progress',
      requestId,
      seq: 3,
      completed: 1,
      total: 10,
    });
    return;
  }
  if (MODE === 'duplicate-result') {
    result(requestId, { value: 'first' });
    result(requestId, { value: 'second' });
    return;
  }
}

log({ event: 'start', mode: MODE, pid: process.pid });

if (MODE === 'die-before-hello') {
  process.exit(3);
}

if (MODE === 'mismatch') {
  // PROTOCOL env carries the wrong protocol id on purpose.
}

if (MODE === 'late-hello') {
  const delay = Number(process.env.FIXTURE_DELAY_MS ?? 5000);
  setTimeout(() => {
    sendHello();
    readStdin();
  }, delay);
  // No stdin processing until the hello was sent.
} else {
  sendHello();
  readStdin();
}

function readStdin() {
  const reader = createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    log({ event: 'stdin', line });
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      log({ event: 'stdin-not-json' });
      return;
    }
    if (frame.kind === 'hello') {
      log({ event: 'host-hello-received', protocolVersion: frame.protocolVersion });
      return;
    }
    if (frame.kind === 'request') {
      handleRequest(frame);
      return;
    }
    if (frame.kind === 'cancel') {
      handleCancel(frame);
    }
  });
}

if (MODE === 'cancel-ignore' && process.env.FIXTURE_IGNORE_SIGTERM === '1') {
  // Ignores the graceful terminate on purpose so the host must escalate to kill.
  process.on('SIGTERM', () => log({ event: 'sigterm-ignored' }));
}

process.on('exit', () => {
  for (const timer of timers) clearInterval(timer);
  log({ event: 'exit' });
});
