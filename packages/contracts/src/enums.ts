import { z } from 'zod';

/**
 * Enumerations of the Vision Lens domain model (spec 002).
 *
 * Every enum here is part of the public contract surface: a value removed from
 * one of them is a breaking change and requires a MAJOR `CONTRACTS_VERSION`
 * bump (see `src/version-guard.ts`).
 */

/** Who produced a record: a person, a model, or an agent. Constitution II. */
export const ACTOR_KINDS = ['human', 'model', 'agent'] as const;
export const ActorKindSchema = z
  .enum(ACTOR_KINDS)
  .describe('Who produced a record: a person, a model, or an agent.');
export type ActorKind = z.infer<typeof ActorKindSchema>;

/** Tool surface a record was produced through (CLI / Studio / API / MCP / agent). */
export const SURFACES = ['cli', 'studio', 'api', 'mcp', 'agent'] as const;
export const SurfaceSchema = z
  .enum(SURFACES)
  .describe('Tool surface a record was produced through (CLI / Studio / API / MCP / agent).');
export type Surface = z.infer<typeof SurfaceSchema>;

/** Lifecycle state of any long-running job (experiment, evaluation, agent run). */
export const JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'abstained',
] as const;
export const JobStateSchema = z
  .enum(JOB_STATES)
  .describe('Lifecycle state of any long-running job (experiment, evaluation, agent run).');
export type JobState = z.infer<typeof JobStateSchema>;

/** Dataset split a sample belongs to; `unassigned` means "not yet split". */
export const SPLIT_KINDS = ['train', 'val', 'test', 'holdout', 'unassigned'] as const;
export const SplitKindSchema = z
  .enum(SPLIT_KINDS)
  .describe('Dataset split a sample belongs to; `unassigned` means "not yet split".');
export type SplitKind = z.infer<typeof SplitKindSchema>;

/** Publication state of a model version in the registry. */
export const REGISTRY_STATES = [
  'draft',
  'candidate',
  'registered',
  'deprecated',
  'legacy',
] as const;
export const RegistryStateSchema = z
  .enum(REGISTRY_STATES)
  .describe('Publication state of a model version in the registry.');
export type RegistryState = z.infer<typeof RegistryStateSchema>;

/**
 * Permission tier of an agent tool call (constitution VI): agents escalate
 * read → analyze → propose → gated-execute → approval-required.
 */
export const AGENT_TOOL_TIERS = [
  'read',
  'analyze',
  'propose',
  'gated-execute',
  'approval-required',
] as const;
export const AgentToolTierSchema = z
  .enum(AGENT_TOOL_TIERS)
  .describe('Permission tier of an agent tool call (constitution VI).');
export type AgentToolTier = z.infer<typeof AgentToolTierSchema>;

/** Kind of work an `ExperimentRun` records (spec 002 plan: classify/train/eval/arena/al/agent). */
export const RUN_KINDS = ['classify', 'train', 'eval', 'arena', 'al', 'agent'] as const;
export const RunKindSchema = z
  .enum(RUN_KINDS)
  .describe('Kind of work an `ExperimentRun` records (classify/train/eval/arena/al/agent).');
export type RunKind = z.infer<typeof RunKindSchema>;

/** Kind of feedback captured for a sample (correction / flag / production signal). */
export const FEEDBACK_KINDS = ['correction', 'flag', 'production'] as const;
export const FeedbackKindSchema = z
  .enum(FEEDBACK_KINDS)
  .describe('Kind of feedback captured for a sample (correction / flag / production signal).');
export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;

/**
 * Registry of every enum in the contract surface, keyed by its public name.
 * Consumed by the contract manifest generator (`src/manifest.ts`) so that a
 * removed enum value is detected as a breaking change.
 */
export const ENUM_SCHEMAS = {
  ActorKind: ActorKindSchema,
  Surface: SurfaceSchema,
  JobState: JobStateSchema,
  SplitKind: SplitKindSchema,
  RegistryState: RegistryStateSchema,
  AgentToolTier: AgentToolTierSchema,
  RunKind: RunKindSchema,
  FeedbackKind: FeedbackKindSchema,
} as const;

export type EnumName = keyof typeof ENUM_SCHEMAS;
