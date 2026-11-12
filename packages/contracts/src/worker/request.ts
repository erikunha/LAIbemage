import { z } from 'zod';
import { strict } from '../base.js';
import {
  WorkerOperationSchema,
  WorkerProtocolIdSchema,
  WorkerRequestIdSchema,
  WorkerSemverSchema,
} from './protocol.js';

/**
 * The `request` envelope (host to worker).
 *
 * `params` is free-form. The only optional field in the whole frame is
 * `budget.maxTokens`.
 */

/**
 * The budget of one request: wall clock, cost and (optionally) tokens.
 *
 * A budget of zero cost or tokens (`maxUsdMicro: 0`, `maxTokens: 0`) is VALID
 * and means no paid or token-backed call is permitted. Unknown properties are
 * forbidden.
 */
export const WorkerBudgetSchema = strict({
  /** Wall-clock ceiling in seconds: 1 to 86400 (one day). */
  maxSeconds: z.number().int().min(1).max(86400),
  /** Cost ceiling in micro-USD: 0 or more. */
  maxUsdMicro: z.number().int().nonnegative(),
  /** Token ceiling: 0 or more, optional. */
  maxTokens: z.number().int().nonnegative().optional(),
}).describe('The resource budget of a request; unknown properties are forbidden.');

/** The `request` frame. */
export const WorkerRequestFrameSchema = strict({
  protocol: WorkerProtocolIdSchema,
  kind: z.literal('request'),
  requestId: WorkerRequestIdSchema,
  operation: WorkerOperationSchema,
  contractVersion: WorkerSemverSchema,
  workspaceId: z.string().min(1),
  params: z.record(z.string(), z.json()),
  budget: WorkerBudgetSchema,
}).describe('The request envelope: exactly one per requestId, host to worker.');

export type WorkerBudget = z.infer<typeof WorkerBudgetSchema>;
export type WorkerRequestFrame = z.infer<typeof WorkerRequestFrameSchema>;
