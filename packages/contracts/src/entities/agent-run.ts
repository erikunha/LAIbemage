import { z } from 'zod';
import { EntityIdSchema, JsonValueSchema, TimestampSchema, strict } from '../base.js';
import { AgentToolTierSchema, JobStateSchema } from '../enums.js';

/**
 * One tool invocation performed by an agent.
 *
 * The `tier` is the permission tier the call ran under (constitution VI:
 * read → analyze → propose → gated-execute → approval-required); it travels
 * with the call so the audit trail shows the authority used, not just the
 * outcome.
 */
export const ToolCallSchema = strict({
  tool: z.string().min(1),
  tier: AgentToolTierSchema,
  at: TimestampSchema,
  args: JsonValueSchema.optional(),
  ok: z.boolean().optional(),
}).describe('One tool invocation performed by an agent.');

/**
 * A human decision about a gated action.
 *
 * Constitution VI: an agent never escalates past `approval-required` on its
 * own — the approval is a first-class, queryable record of who decided what.
 */
export const ApprovalSchema = strict({
  tool: z.string().min(1),
  tier: AgentToolTierSchema,
  decision: z.enum(['approved', 'denied']),
  decidedBy: z.string().min(1),
  at: TimestampSchema,
}).describe('A human decision about a gated action.');

/**
 * One agent investigation: a goal, a budget, the tool calls it made, the
 * approvals it needed and the report it produced.
 *
 * Constitutional invariants encoded here:
 *  - **Budgets are explicit (VI)**: `budgetJson` is mandatory, so a run
 *    without a budget cannot be recorded.
 *  - **Approvals are recorded (VI)**: `approvals` keeps the decision trail.
 *  - **Abstention is representable (V)**: `status` includes `abstained`.
 */
export const AgentRunSchema = strict({
  id: EntityIdSchema,
  goal: z.string().min(1),
  status: JobStateSchema,
  budgetJson: JsonValueSchema,
  toolCalls: z.array(ToolCallSchema),
  approvals: z.array(ApprovalSchema),
  reportPath: z.string().min(1).optional(),
  createdAt: TimestampSchema,
}).describe(
  'One agent investigation: a goal, a budget, the tool calls it made, the approvals it needed and the report it produced.',
);

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;
