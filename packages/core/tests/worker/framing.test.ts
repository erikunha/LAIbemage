import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerLaunchError } from '../../src/worker/index.js';
import {
  encodeFrame,
  LineDecoder,
  redactSecrets,
  WorkerStderrLog,
} from '../../src/worker/index.js';
import { FrameSizeError } from '../../src/worker/framing.js';
import { launchFixture, readLog, teardown, TEST_BUDGET, until } from './helpers.js';

/**
 * Task 1.6 (FR-001): stdout carries frames and nothing else; stderr is
 * captured as STRUCTURED logs with secret redaction.
 *
 * The redaction patterns are pure functions, so each is pinned by a table
 * test; the structured capture is bounded and timestamped; and one live test
 * drives a fixture worker that logs a secret on stderr before dying, so the
 * redaction is proven on the real channel, not only in isolation.
 */
vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  await teardown();
});

describe('redactSecrets', () => {
  it('redacts key/value and assignment forms of secret-bearing names', () => {
    expect(redactSecrets('api_key=abc123')).toBe('api_key=[redacted]');
    expect(redactSecrets('API_KEY="abc123"')).toBe('API_KEY=[redacted]');
    expect(redactSecrets('token: deadbeef00')).toBe('token: [redacted]');
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: [redacted]',
    );
    expect(redactSecrets('password=hunter2')).toBe('password=[redacted]');
    expect(redactSecrets('client_secret: shhhh')).toBe('client_secret: [redacted]');
  });

  it('redacts bearer tokens and provider key shapes on their own', () => {
    expect(redactSecrets('Bearer abc.def.ghi')).toBe('Bearer [redacted]');
    expect(redactSecrets('found sk-proj-0123456789abcdef in env')).toBe(
      'found [redacted] in env',
    );
  });

  it('keeps non-secret content intact, including digests', () => {
    const line = 'embedded 2 images, artifact sha256 0000000000000000000000000000000000000000000000000000000000000000 in 12ms';
    expect(redactSecrets(line)).toBe(line);
    expect(redactSecrets('device=cpu model=siglip2-base')).toBe(
      'device=cpu model=siglip2-base',
    );
  });

  it('redacts every occurrence, not only the first', () => {
    expect(redactSecrets('token=a token=b')).toBe('token=[redacted] token=[redacted]');
  });

  it('redacts quoted-key forms: compact JSON, spaced JSON and Python repr', () => {
    // The key's closing quote (and any space) may sit between the name and
    // the separator; the value may itself be quoted.
    expect(redactSecrets('{"access_token":"tokenvalue42"}')).toBe(
      '{"access_token":[redacted]}',
    );
    expect(redactSecrets('{"api_key": "abc123"}')).toBe('{"api_key": [redacted]}');
    expect(redactSecrets("{'client_secret': 'shhhh'}")).toBe("{'client_secret': [redacted]}");
    expect(redactSecrets('{"auth":{"token":"supersecret"}}')).toBe(
      '{"auth":{"token":[redacted]}}',
    );
  });

  it('keeps routine token-count and tokenizer diagnostics intact', () => {
    expect(redactSecrets('tokens=1234')).toBe('tokens=1234');
    expect(redactSecrets('token_count=42')).toBe('token_count=42');
    expect(redactSecrets('tokenizer=bert-base-uncased')).toBe('tokenizer=bert-base-uncased');
    expect(redactSecrets('max_tokens=8192 used_tokens=1200 total_tokens=9392')).toBe(
      'max_tokens=8192 used_tokens=1200 total_tokens=9392',
    );
    // ...while the secret-bearing compounds stay redacted.
    expect(redactSecrets('access_token=eyJ123')).toBe('access_token=[redacted]');
    expect(redactSecrets('token_value=supersecret')).toBe('token_value=[redacted]');
    expect(redactSecrets('refresh_token=xyz')).toBe('refresh_token=[redacted]');
  });
});

describe('WorkerStderrLog', () => {
  it('captures each stderr line as a timestamped, redacted record', () => {
    const log = new WorkerStderrLog();
    log.push(Buffer.from('loading model\n', 'utf8'));
    log.push(Buffer.from('api_key=abc123\n', 'utf8'));

    const records = log.records();
    expect(records).toHaveLength(2);
    expect(records[0]!.line).toBe('loading model');
    expect(records[1]!.line).toBe('api_key=[redacted]');
    for (const record of records) {
      expect(Date.parse(record.at)).not.toBeNaN();
    }
  });

  it('is bounded: the tail is kept, the head is dropped', () => {
    const log = new WorkerStderrLog();
    for (let index = 0; index < 200; index += 1) {
      log.push(Buffer.from(`line-${index}\n`, 'utf8'));
    }
    const lines = log.records().map((record) => record.line);
    expect(lines.length).toBeLessThanOrEqual(128);
    expect(lines[lines.length - 1]).toBe('line-199');
    expect(lines).not.toContain('line-0');
  });

  it('a huge unterminated chunk is capped and marked, never buffered whole', () => {
    const log = new WorkerStderrLog();
    // A newline-free 64 MiB blob (a runaway progress bar, a crash dump, a
    // hostile worker) must not accumulate: the unterminated remainder is
    // capped, and the line it eventually completes is marked as truncated.
    log.push(Buffer.from(`${'x'.repeat(64 * 1024 * 1024)}partial`, 'utf8'));
    log.push(Buffer.from(' tail\nmore\n', 'utf8'));

    const records = log.records();
    const truncatedLine = records[records.length - 2]!;
    expect(truncatedLine.line.length).toBeLessThanOrEqual(1024);
    expect(truncatedLine.line.endsWith('[truncated]')).toBe(true);
    // The channel keeps serving after the cap: the next line is intact.
    expect(records[records.length - 1]!.line).toBe('more');
  });

  it('redacts a secret near the end of an over-cap complete line before keeping the tail', () => {
    const log = new WorkerStderrLog();
    // Truncation must keep the tail of the REDACTED line: keeping the tail of
    // the raw line first would cut the secret's name out of the window and
    // leave its value readable in the kept tail.
    const line = `context ${'x'.repeat(1100)} api_key=SECRETVALUE9911`;
    log.push(Buffer.from(`${line}\n`, 'utf8'));

    const records = log.records();
    expect(records).toHaveLength(1);
    expect(records[0]!.line.length).toBeLessThanOrEqual(1024);
    expect(records[0]!.line.endsWith('[truncated]')).toBe(true);
    expect(records[0]!.line).not.toContain('SECRETVALUE9911');
  });

  it('carries a partial line across chunks and truncates huge lines', () => {
    const log = new WorkerStderrLog();
    log.push(Buffer.from('partial', 'utf8'));
    log.push(Buffer.from(' line\n', 'utf8'));
    expect(log.records().map((record) => record.line)).toEqual(['partial line']);

    log.push(Buffer.from(`${'x'.repeat(10_000)}\n`, 'utf8'));
    const last = log.records()[log.records().length - 1]!;
    expect(last.line.length).toBeLessThanOrEqual(1024);
  });

  it('the excerpt joins the redacted tail for error messages', () => {
    const log = new WorkerStderrLog();
    log.push(Buffer.from('boom: api_key=abc123\n', 'utf8'));
    expect(log.excerpt()).toContain('api_key=[redacted]');
    expect(log.excerpt()).not.toContain('abc123');
  });
});

describe('stdout discipline', () => {
  it('the decoder still refuses an oversized line without buffering it whole', () => {
    const decoder = new LineDecoder(64);
    expect(() => decoder.push(Buffer.from(`${'x'.repeat(65)}`, 'utf8'))).toThrow(FrameSizeError);
  });

  it('encodeFrame writes exactly one trailing newline', () => {
    const buffer = encodeFrame({ hello: 'world' });
    expect(buffer[buffer.byteLength - 1]).toBe(0x0a);
    expect(buffer.subarray(0, buffer.byteLength - 1).toString('utf8')).toBe('{"hello":"world"}');
  });
});

describe('the live channel', () => {
  it('a worker logging a secret on stderr is captured redacted, never leaked', async () => {
    const { client, logPath } = await launchFixture('stderr-secret');

    // The mode logs the secret and dies when the first request lands.
    const failure = await client
      .request({
        operation: 'vision.embed',
        workspaceId: 'ws-test',
        params: {},
        budget: { ...TEST_BUDGET },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(WorkerLaunchError);
    const launch = failure as WorkerLaunchError;
    expect(launch.message).not.toMatch(/abc123/);
    expect(launch.message).toContain('api_key=[redacted]');
    await until(() => client.workerLogs().length > 0 && client.clientState === 'dead');

    const records = client.workerLogs();
    expect(records.length).toBeGreaterThan(0);
    const text = records.map((record) => record.line).join('\n');
    expect(text).toContain('api_key=[redacted]');
    expect(text).not.toContain('abc123');
    // The redacted line also reaches the failure message, never the secret.
    // The fixture also proves stdout stayed frames-only: its own log (a file,
    // not stdout) records the crash.
    const events = readLog(logPath).map((entry) => entry.event);
    expect(events).toContain('crashing');
  });
});
