import { z } from 'zod'

import { MAX_CLIENT_RUN_KEY_LENGTH, type KernelV1Method } from './constants'
import { sessionAdoptParamsSchema, sessionAdoptResultSchema } from './history'
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

const contextFileSchema = z
  .object({
    path: z.string().min(1).max(8192),
    content: z.string().max(512 * 1024)
  })
  .strict()

const phiAgentDefinitionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    tools: z.array(z.string().min(1)),
    skills: z.array(z.string().min(1)),
    environment: z.string().min(1).optional(),
    pluginId: z.string().min(1).optional(),
    model: z.array(z.string().min(1)).optional(),
    thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    delegation: z.string().optional(),
    delegationMode: z.enum(['required-first', 'preferred', 'optional']).optional(),
    fallback: z
      .object({
        afterFailures: z.number().int().positive(),
        tools: z.array(z.string().min(1)),
        match: z.array(z.string().min(1))
      })
      .strict()
      .optional(),
    invocation: z.literal('host').optional(),
    visibility: z.literal('entry'),
    warnings: z.array(z.string()),
    systemPrompt: z.string(),
    source: z.enum(['phi', 'compat']),
    filePath: z.string().min(1)
  })
  .strict()

const mcpCommonSchema = {
  enabled: z.boolean().optional(),
  timeout: z.number().finite().nonnegative().optional(),
  requestIdFormat: z.enum(['string', 'number']).optional(),
  instructions: z.boolean().optional()
}
const mcpServerConfigSchema = z.union([
  z
    .object({
      ...mcpCommonSchema,
      type: z.literal('stdio').optional(),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      envPolicy: z.literal('literal').optional(),
      envLiteralKeys: z.array(z.string()).optional(),
      cwd: z.string().optional()
    })
    .strict(),
  z
    .object({
      ...mcpCommonSchema,
      type: z.enum(['http', 'sse']),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
      headerPolicy: z.literal('origin-locked').optional()
    })
    .strict()
])

/** Public prompt controls. Host-internal synthetic/userInitiated flags never cross this boundary. */
export const sessionPromptOptionsV1Schema = z
  .object({
    version: z.literal(1),
    images: z.array(imageSchema).optional(),
    expandPromptTemplates: z.boolean().optional(),
    skipCompactionCheck: z.boolean().optional()
  })
  .strict()

// TODO(K2-3 merge): replace transport trust with the shared trusted-field mechanism.
export const sessionPromptTrustedOptionsV1Schema = z
  .object({
    version: z.literal(1),
    synthetic: z.boolean().optional(),
    userInitiated: z.boolean().optional()
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

export const sessionPolicyParamsSchema = z
  .object({
    workMode: z.enum(['direct', 'plan', 'plan_execute', 'auto']).optional(),
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
    phiAgents: z.array(phiAgentDefinitionSchema).max(64).optional(),
    personaMarkdown: z
      .string()
      .max(64 * 1024)
      .optional(),
    projectBound: z.boolean().optional(),
    memory: z.object({ enabled: z.boolean(), learn: z.boolean() }).strict().optional(),
    contextFiles: z.array(contextFileSchema).max(64).optional(),
    mcpServers: z
      .array(z.object({ name: z.string().min(1).max(128), config: mcpServerConfigSchema }).strict())
      .max(256)
      .optional(),
    environment: z
      .object({ ref: z.string().min(1), pluginId: z.string().min(1).optional() })
      .strict()
      .optional(),
    noTools: z.union([z.literal('all'), z.boolean()]).optional()
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
    ...sessionPolicyParamsSchema.shape
  })
  .strict()
export const sessionCreateResultSchema = z.object({ sessionId: nonEmptyIdSchema }).strict()

export const sessionOpenParamsSchema = z
  .object({
    sessionId: nonEmptyIdSchema,
    resources: sessionPolicyParamsSchema.optional()
  })
  .strict()
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
    options: sessionPromptOptionsV1Schema.optional(),
    trustedOptions: sessionPromptTrustedOptionsV1Schema.optional(),
    /** Kept for additive compatibility with the initial v1 prompt shape. */
    images: z.array(imageSchema).optional(),
    clientRunKey: z.string().min(1).max(MAX_CLIENT_RUN_KEY_LENGTH).optional()
  })
  .strict()
export const sessionPromptResultSchema = z
  .object({ accepted: z.literal(true), runId: nonEmptyIdSchema })
  .strict()

// K3-2 fork source identity is carried by the trusted request context.
export const sessionForkParamsSchema = z.object({}).strict()
export const sessionForkResultSchema = sessionCreateResultSchema

// K3-2 resources and OMP async shell jobs. `agentDir` remains adapter-owned.
export const resourcesReloadParamsSchema = z
  .object({
    cwd: z.string().min(1),
    additionalExtensionPaths: z.array(z.string().min(1)).optional(),
    additionalPromptTemplatePaths: z.array(z.string().min(1)).optional(),
    additionalSkillPaths: z.array(z.string().min(1)).optional(),
    additionalSkillFiles: z.array(z.string().min(1)).optional(),
    additionalThemePaths: z.array(z.string().min(1)).optional(),
    noExtensions: z.boolean().optional(),
    noSkills: z.boolean().optional(),
    noPromptTemplates: z.boolean().optional(),
    noThemes: z.boolean().optional(),
    noContextFiles: z.boolean().optional(),
    personaMarkdown: z
      .string()
      .max(64 * 1024)
      .optional(),
    contextFiles: z.array(contextFileSchema).max(64).optional(),
    systemPrompt: z.string().optional(),
    appendSystemPrompt: z.union([z.string(), z.array(z.string())]).optional()
  })
  .strict()

export const resourcesReloadResultSchema = z
  .object({
    extensions: jsonValueSchema.optional(),
    skills: z
      .object({
        skills: z.array(jsonValueSchema),
        diagnostics: z.array(jsonValueSchema)
      })
      .strict(),
    prompts: jsonValueSchema.optional(),
    themes: jsonValueSchema.optional(),
    agentsFiles: jsonValueSchema.optional(),
    systemPrompt: z.string().optional(),
    appendSystemPrompt: z.array(z.string()).optional()
  })
  .strict()

export const shellJobSchema = z
  .object({
    agentSessionId: nonEmptyIdSchema,
    jobId: nonEmptyIdSchema,
    state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    command: z.string(),
    startedAt: z.number().finite().nonnegative(),
    output: z.string().optional()
  })
  .strict()

export const shellJobsListParamsSchema = z.object({}).strict()
export const shellJobsListResultSchema = z.array(shellJobSchema)
export const shellJobsCancelParamsSchema = z.object({ jobId: nonEmptyIdSchema }).strict()
export const shellJobsCancelResultSchema = z.object({ ok: z.boolean() }).strict()

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
export type SessionPolicyParams = z.infer<typeof sessionPolicyParamsSchema>
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
export type SessionPromptOptionsV1 = z.infer<typeof sessionPromptOptionsV1Schema>
export type SessionPromptTrustedOptionsV1 = z.infer<typeof sessionPromptTrustedOptionsV1Schema>
export type SessionPromptResult = z.infer<typeof sessionPromptResultSchema>
export type SessionForkParams = z.infer<typeof sessionForkParamsSchema>
export type SessionForkResult = z.infer<typeof sessionForkResultSchema>
export type ResourcesReloadParams = z.infer<typeof resourcesReloadParamsSchema>
export type ResourcesReloadResult = z.infer<typeof resourcesReloadResultSchema>
export type ShellJob = z.infer<typeof shellJobSchema>
export type ShellJobsListParams = z.infer<typeof shellJobsListParamsSchema>
export type ShellJobsListResult = z.infer<typeof shellJobsListResultSchema>
export type ShellJobsCancelParams = z.infer<typeof shellJobsCancelParamsSchema>
export type ShellJobsCancelResult = z.infer<typeof shellJobsCancelResultSchema>
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
  'session.adopt': sessionAdoptParamsSchema,
  'sessions.list': sessionsListParamsSchema,
  'session.prompt': sessionPromptParamsSchema,
  'resources.reload': resourcesReloadParamsSchema,
  'shellJobs.list': shellJobsListParamsSchema,
  'shellJobs.cancel': shellJobsCancelParamsSchema,
  'session.fork': sessionForkParamsSchema,
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
  'session.adopt': sessionAdoptResultSchema,
  'sessions.list': sessionsListResultSchema,
  'session.prompt': sessionPromptResultSchema,
  'resources.reload': resourcesReloadResultSchema,
  'shellJobs.list': shellJobsListResultSchema,
  'shellJobs.cancel': shellJobsCancelResultSchema,
  'session.fork': sessionForkResultSchema,
  'session.abort': sessionAbortResultSchema,
  'session.snapshot': sessionSnapshotResultSchema,
  'session.close': sessionCloseResultSchema,
  'events.subscribe': eventsSubscribeResultSchema,
  'approval.respond': approvalRespondResultSchema
} satisfies Record<KernelV1Method, z.ZodType>
