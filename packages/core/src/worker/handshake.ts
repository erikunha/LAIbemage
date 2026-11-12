import {
  WORKER_PROTOCOL_ID,
  WORKER_PROTOCOL_MAJOR,
  WORKER_PROTOCOL_VERSION,
  HostHelloFrameSchema,
  WorkerHelloFrameSchema,
  type HostHelloFrame,
  type WorkerHelloFrame,
} from '@vision-lens/contracts';
import { WorkerProtocolError } from './errors.js';

/**
 * The handshake gate.
 *
 * The worker emits `hello` unprompted as its FIRST frame, because only the
 * worker knows its build, extras, device and frame size. The host validates it
 * BEFORE any operation is accepted, then answers with its own hello carrying
 * the host protocol and contract major. A worker that never answers within the
 * handshake timeout is a LAUNCH failure, never a protocol error.
 */

/** Extracts the major of a `major.minor.patch` version string. */
export function majorOf(version: string): number {
  const match = /^(\d+)\.\d+\.\d+$/.exec(version);
  if (!match) {
    throw new WorkerProtocolError(
      'MALFORMED_FRAME',
      `version "${version}" is not of the form major.minor.patch`,
    );
  }
  return Number(match[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates the worker's hello line.
 *
 * A hello that names ANOTHER protocol id is refused as `UNSUPPORTED_PROTOCOL`
 * with both protocol ids in the message, so the refusal names both sides. Any
 * other invalid shape is `MALFORMED_FRAME`.
 */
export function parseWorkerHello(rawLine: string): WorkerHelloFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    throw new WorkerProtocolError(
      'MALFORMED_FRAME',
      'the worker handshake line is not valid JSON',
    );
  }
  if (!isRecord(parsed)) {
    throw new WorkerProtocolError(
      'MALFORMED_FRAME',
      'the worker handshake line is not a JSON object',
    );
  }
  const announcedProtocol = parsed.protocol;
  if (typeof announcedProtocol === 'string' && announcedProtocol !== WORKER_PROTOCOL_ID) {
    throw new WorkerProtocolError(
      'UNSUPPORTED_PROTOCOL',
      `the worker speaks "${announcedProtocol}" while the host speaks "${WORKER_PROTOCOL_ID}"`,
    );
  }
  const hello = WorkerHelloFrameSchema.safeParse(parsed);
  if (!hello.success) {
    const firstIssue = hello.error.issues[0];
    const where = firstIssue?.path?.join('.') ?? '(root)';
    throw new WorkerProtocolError(
      'MALFORMED_FRAME',
      `the worker hello frame is invalid at ${where}: ${firstIssue?.message ?? 'unknown issue'}`,
    );
  }
  return hello.data;
}

/**
 * Compares the worker's protocol and contract majors with the host's.
 *
 * Both majors move independently; either mismatch is `UNSUPPORTED_PROTOCOL`
 * naming both values, and it fails closed BEFORE any operation is accepted.
 */
export function assertMajorsCompatible(
  workerHello: WorkerHelloFrame,
  hostContractVersion: string,
): void {
  const workerProtocolMajor = majorOf(workerHello.protocolVersion);
  if (workerProtocolMajor !== WORKER_PROTOCOL_MAJOR) {
    throw new WorkerProtocolError(
      'UNSUPPORTED_PROTOCOL',
      `the worker speaks protocol major ${workerProtocolMajor} while the host speaks ${WORKER_PROTOCOL_MAJOR}`,
    );
  }
  const workerContractMajor = majorOf(workerHello.contractVersion);
  const hostContractMajor = majorOf(hostContractVersion);
  if (workerContractMajor !== hostContractMajor) {
    throw new WorkerProtocolError(
      'UNSUPPORTED_PROTOCOL',
      `the worker speaks contract major ${workerContractMajor} while the host speaks ${hostContractMajor}`,
    );
  }
}

/** Values the host puts into its answering hello. */
export interface HostHelloInput {
  contractVersion: string;
  maxFrameBytes: number;
}

/**
 * Builds the host hello frame answering the worker's.
 *
 * The answer carries ONLY the version fields and the frame cap: the worker's
 * validator rejects any extra field, so the host never advertises operations
 * or capabilities here.
 */
export function buildHostHello(input: HostHelloInput): HostHelloFrame {
  return HostHelloFrameSchema.parse({
    protocol: WORKER_PROTOCOL_ID,
    kind: 'hello',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    contractVersion: input.contractVersion,
    maxFrameBytes: input.maxFrameBytes,
  });
}
