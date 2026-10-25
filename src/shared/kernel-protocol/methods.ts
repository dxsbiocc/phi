import { z } from 'zod'

import { MAX_CLIENT_RUN_KEY_LENGTH, type KernelV1Method } from './constants'
import { jsonValueSchema } from './json'

export const protocolVersionSchema = z
  .object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative()
  })
  .strict()

export type ProtocolVersion = z.infer<typeof protocolVersionSchema>

const nonEmptyIdSchema = z.string().min(1)
const thinkingLevelSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export const runCompletionStatusSchema = z.enum(['completed', 'failed', 'cancelled', 'unknown'])
const modelSelectorSchema = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1)
  })
  .strict()
const imageSchema = z
  .object({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string().min(1)
  })
  .strict()

export const kernelHelloParamsSchema = z
  .object({
    protocol: protocolVersionSchema,
    client: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1)
      })
      .strict(),
    hostCapabilities: z.array(z.string().min(1)).optional(),
    takeover: z.boolean().optional()
  })
  .strict()

export const kernelHelloResultSchema = z
  .object({
    protocol: protocolVersionSchema,
    kernel: z
      .object({
        version: z.string().min(1),
        ompVersion: z.string().min(1)
      })
      .strict(),
    kernelInstanceId: nonEmptyIdSchema,
    controllerGeneration: z.number().int().positive(),
    capabilities: z.array(z.string().min(1)),
    lastSeq: z.number().int().nonnegative()
  })
  .strict()

export const sessionCreateParamsSchema = z
  .object({
    cwd: z.string().min(1),
    model: modelSelectorSchema,
    thinkingLevel: thinkingLevelSchema.optional(),
    sessionManager: z
      .object({
        kind: z.enum(['memory', 'persistent'])
      })
      .strict(),
    enableToolApproval: z.boolean().optional(),
    autoCompaction: z
      .object({
        enabled: z.boolean()
      })
      .strict()
      .optional(),
    resourceOptions: z
      .object({
        noExtensions: z.boolean(),
        noSkills: z.boolean(),
        noContextFiles: z.boolean(),
        noPromptTemplates: z.boolean(),
        noThemes: z.boolean()
      })
      .strict()
      .optional(),
    noTools: z.union([z.literal('all'), z.boolean()]).optional()
  })
  .strict()
export const sessionCreateResultSchema = z.object({ sessionId: nonEmptyIdSchema }).strict()

export const sessionOpenParamsSchema = z.object({ sessionId: nonEmptyIdSchema }).strict()
export const sessionOpenResultSchema = sessionCreateResultSchema

export const sessionLastRunSchema = z
  .object({
    runId: nonEmptyIdSchema,
    status: runCompletionStatusSchema
  })
  .strict()

export const sessionSummarySchema = z
  .object({
    sessionId: nonEmptyIdSchema,
    cwd: z.string().min(1),
    title: z.string().min(1).optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    loaded: z.boolean(),
    lastRun: sessionLastRunSchema.optional()
  })
  .strict()

export const corruptSessionSummarySchema = z
  .object({
    sessionId: nonEmptyIdSchema,
    error: z
      .object({
        code: z.literal('CORRUPT_SESSION'),
        message: z.string().min(1)
      })
      .strict()
  })
  .strict()

export const sessionListEntrySchema = z.union([sessionSummarySchema, corruptSessionSummarySchema])

export const sessionsListParamsSchema = z.object({}).strict()
export const sessionsListResultSchema = z
  .object({ sessions: z.array(sessionListEntrySchema) })
  .strict()

export const sessionPromptParamsSchema = z
  .object({
    text: z.string(),
    images: z.array(imageSchema).optional(),
    clientRunKey: z.string().min(1).max(MAX_CLIENT_RUN_KEY_LENGTH).optional()
  })
  .strict()
export const sessionPromptResultSchema = z
  .object({ accepted: z.literal(true), runId: nonEmptyIdSchema })
  .strict()

/** Run targeting remains in the request correlation fields until K1-2 wires worker cancellation. */
export const sessionAbortParamsSchema = z.object({}).strict()
export const sessionAbortResultSchema = z.object({ cancelled: z.literal(true) }).strict()

export const sessionSnapshotParamsSchema = z.object({}).strict()
export const sessionSnapshotResultSchema = z
  .object({
    sessionId: nonEmptyIdSchema,
    messages: z.array(jsonValueSchema),
    model: modelSelectorSchema.optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
    cwd: z.string().min(1),
    activeRunId: nonEmptyIdSchema.optional(),
    lastRun: sessionLastRunSchema.optional()
  })
  .strict()

export const sessionCloseParamsSchema = z.object({}).strict()
export const sessionCloseResultSchema = z.object({ closed: z.literal(true) }).strict()

export const eventsSubscribeParamsSchema = z
  .object({ afterSeq: z.number().int().nonnegative() })
  .strict()
export const eventsSubscribeResultSchema = z
  .object({ subscribed: z.literal(true), lastSeq: z.number().int().nonnegative() })
  .strict()

/** Future actor metadata belongs in trusted call context, not this approval DTO. */
export const approvalRespondParamsSchema = z
  .object({
    approvalId: nonEmptyIdSchema,
    decision: z.enum(['approved', 'denied'])
  })
  .strict()
export const approvalRespondResultSchema = z.object({ accepted: z.literal(true) }).strict()

export const runCompletedPayloadSchema = z
  .object({
    runId: nonEmptyIdSchema,
    status: runCompletionStatusSchema,
    detail: z.string().optional()
  })
  .strict()

export const approvalRequestedPayloadSchema = z
  .object({
    approvalId: nonEmptyIdSchema,
    toolCallId: nonEmptyIdSchema,
    toolName: z.string(),
    input: jsonValueSchema,
    agentRunId: nonEmptyIdSchema.optional()
  })
  .strict()

export type KernelHelloParams = z.infer<typeof kernelHelloParamsSchema>
export type KernelHelloResult = z.infer<typeof kernelHelloResultSchema>
export type SessionCreateParams = z.infer<typeof sessionCreateParamsSchema>
export type SessionCreateResult = z.infer<typeof sessionCreateResultSchema>
export type SessionOpenParams = z.infer<typeof sessionOpenParamsSchema>
export type SessionOpenResult = z.infer<typeof sessionOpenResultSchema>
export type SessionLastRun = z.infer<typeof sessionLastRunSchema>
export type SessionSummary = z.infer<typeof sessionSummarySchema>
export type CorruptSessionSummary = z.infer<typeof corruptSessionSummarySchema>
export type SessionListEntry = z.infer<typeof sessionListEntrySchema>
export type SessionsListParams = z.infer<typeof sessionsListParamsSchema>
export type SessionsListResult = z.infer<typeof sessionsListResultSchema>
export type SessionPromptParams = z.infer<typeof sessionPromptParamsSchema>
export type SessionPromptResult = z.infer<typeof sessionPromptResultSchema>
export type SessionAbortParams = z.infer<typeof sessionAbortParamsSchema>
export type SessionAbortResult = z.infer<typeof sessionAbortResultSchema>
export type SessionSnapshotParams = z.infer<typeof sessionSnapshotParamsSchema>
export type SessionSnapshotResult = z.infer<typeof sessionSnapshotResultSchema>
export type SessionCloseParams = z.infer<typeof sessionCloseParamsSchema>
export type SessionCloseResult = z.infer<typeof sessionCloseResultSchema>
export type EventsSubscribeParams = z.infer<typeof eventsSubscribeParamsSchema>
export type EventsSubscribeResult = z.infer<typeof eventsSubscribeResultSchema>
export type ApprovalRespondParams = z.infer<typeof approvalRespondParamsSchema>
export type ApprovalRespondResult = z.infer<typeof approvalRespondResultSchema>
export type RunCompletedPayload = z.infer<typeof runCompletedPayloadSchema>
export type ApprovalRequestedPayload = z.infer<typeof approvalRequestedPayloadSchema>

export const kernelMethodParamsSchemas = {
  'kernel.hello': kernelHelloParamsSchema,
  'session.create': sessionCreateParamsSchema,
  'session.open': sessionOpenParamsSchema,
  'sessions.list': sessionsListParamsSchema,
  'session.prompt': sessionPromptParamsSchema,
  'session.abort': sessionAbortParamsSchema,
  'session.snapshot': sessionSnapshotParamsSchema,
  'session.close': sessionCloseParamsSchema,
  'events.subscribe': eventsSubscribeParamsSchema,
  'approval.respond': approvalRespondParamsSchema
} satisfies Record<KernelV1Method, z.ZodType>

export const kernelMethodResultSchemas = {
  'kernel.hello': kernelHelloResultSchema,
  'session.create': sessionCreateResultSchema,
  'session.open': sessionOpenResultSchema,
  'sessions.list': sessionsListResultSchema,
  'session.prompt': sessionPromptResultSchema,
  'session.abort': sessionAbortResultSchema,
  'session.snapshot': sessionSnapshotResultSchema,
  'session.close': sessionCloseResultSchema,
  'events.subscribe': eventsSubscribeResultSchema,
  'approval.respond': approvalRespondResultSchema
} satisfies Record<KernelV1Method, z.ZodType>
