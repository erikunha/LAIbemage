import { z } from 'zod';
import { strict } from '../base.js';
import {
  WorkerOperationSchema,
  WorkerProtocolIdSchema,
  WorkerSemverSchema,
} from './protocol.js';

/**
 * The `hello` envelope, spoken in two shapes. The schema below is the WORKER's
 * hello: the worker emits it unprompted as its first frame, because only the
 * worker knows its build, extras, device and frame size. The host answers with
 * its own hello carrying ONLY the version fields and `maxFrameBytes`
 * ({@link HostHelloFrameSchema}); the worker's validator rejects any extra
 * field, so the answer never advertises operations or capabilities.
 */

/** Build, extras, device and model capabilities of the worker. */
export const WorkerCapabilitiesSchema = strict({
  device: z.string().min(1),
  extras: z.array(z.string().min(1)),
  models: z.array(z.string().min(1)),
}).describe('Device, installed extras and model capabilities of the worker.');

/** The worker's `hello` frame, spoken unprompted as its first frame. */
export const WorkerHelloFrameSchema = strict({
  protocol: WorkerProtocolIdSchema,
  kind: z.literal('hello'),
  protocolVersion: WorkerSemverSchema,
  contractVersion: WorkerSemverSchema,
  /** The operations the worker implements. */
  supportedOperations: z.array(WorkerOperationSchema),
  capabilities: WorkerCapabilitiesSchema,
  /** The maximum frame size in bytes the worker accepts. */
  maxFrameBytes: z.number().int().positive(),
}).describe("The worker's hello, spoken unprompted as its first frame.");

/**
 * The host's answering `hello`: exactly the protocol identity, the kind, both
 * version fields and the frame cap. Strict like every frame, and
 * host-outbound only, so it deliberately stays out of the worker frame union
 * and the manifest registries: the host is the only emitter and the only
 * validator of this shape is the worker.
 */
export const HostHelloFrameSchema = strict({
  protocol: WorkerProtocolIdSchema,
  kind: z.literal('hello'),
  protocolVersion: WorkerSemverSchema,
  contractVersion: WorkerSemverSchema,
  /** The maximum frame size in bytes the host accepts. */
  maxFrameBytes: z.number().int().positive(),
}).describe('The host hello answering the worker hello: versions and frame cap only.');

export type WorkerCapabilities = z.infer<typeof WorkerCapabilitiesSchema>;
export type WorkerHelloFrame = z.infer<typeof WorkerHelloFrameSchema>;
export type HostHelloFrame = z.infer<typeof HostHelloFrameSchema>;
