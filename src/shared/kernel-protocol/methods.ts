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
export const thinkingLevelSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export const runCompletionStatusSchema = z.enum(['completed', 'failed', 'cancelled', 'unknown'])
export const modelSelectorSchema = z
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

const phiAgentSnapshotSchema = z
  .array(phiAgentDefinitionSchema)
  .max(64)
  .refine(
    (definitions) =>
      new Set(definitions.map((definition) => definition.name)).size === definitions.length,
    'Agent names must be unique'
  )

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

/** Public prompt controls. Trusted host-internal fields remain top-level protocol fields. */
export const sessionPromptOptionsV1Schema = z
  .object({
    version: z.literal(1),
    images: z.array(imageSchema).optional(),
    expandPromptTemplates: z.boolean().optional(),
    skipCompactionCheck: z.boolean().optional()
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
    lastSeq: z.number().int().nonnegative(),
    runtime: z
      .object({
        home: z.string(),
        agentDir: z.string(),
        /** Process identity is optional for compatibility with older test and attach fixtures. */
        pid: z.number().int().positive().optional()
      })
      .strict()
  })
  .strict()

export const sessionPolicyParamsSchema = z
  .object({
    resourceVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
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
    phiAgents: phiAgentSnapshotSchema.optional(),
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
    desktopMcp: z
      .object({ bindingId: z.string().min(1).max(512) })
      .strict()
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
export const sessionCreateResultSchema = z
  .object({ sessionId: nonEmptyIdSchema, sessionFile: z.string().min(1).optional() })
  .strict()

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
    /** Kept for additive compatibility with the initial v1 prompt shape. */
    images: z.array(imageSchema).optional(),
    clientRunKey: z.string().min(1).max(MAX_CLIENT_RUN_KEY_LENGTH).optional(),
    modelSelection: z.literal('automatic').optional(),
    synthetic: z.boolean().optional(),
    userInitiated: z.boolean().optional()
  })
  .strict()
export const sessionPromptResultSchema = z
  .object({ accepted: z.literal(true), runId: nonEmptyIdSchema })
  .strict()

const planStepSchema = z
  .object({
    id: z.string().min(1).max(40),
    title: z.string().min(1).max(80),
    instructions: z.string().min(1).max(4_000),
    acceptance: z.string().min(1).max(1_000),
    dependsOn: z.array(z.string().min(1).max(40)).max(20),
    access: z.enum(['read', 'write']),
    writes: z.array(z.string().min(1)).optional(),
    agent: z.string().min(1).optional()
  })
  .strict()

const planSpecSchema = z
  .object({
    version: z.literal(1),
    goal: z.string().min(1).max(4_000),
    steps: z.array(planStepSchema).min(1).max(20)
  })
  .strict()

const planStepReportSchema = z
  .object({
    status: z.enum(['completed', 'partial', 'not_found', 'blocked', 'failed']),
    text: z.string(),
    missingInputs: z.array(z.string())
  })
  .strict()

const planStepStateSchema = z
  .object({
    status: z.enum([
      'pending',
      'launching',
      'running',
      'unknown',
      'done',
      'failed',
      'skipped',
      'cancelled',
      'interrupted'
    ]),
    attempts: z.number().int().nonnegative(),
    agentRunId: nonEmptyIdSchema.optional(),
    requestId: nonEmptyIdSchema.optional(),
    report: planStepReportSchema.optional(),
    error: z.string().optional(),
    startedAt: z.string().min(1).optional(),
    finishedAt: z.string().min(1).optional()
  })
  .strict()

export const planRunStateSchema = z
  .object({
    id: nonEmptyIdSchema,
    sessionId: nonEmptyIdSchema,
    spec: planSpecSchema,
    status: z.enum(['running', 'paused', 'completed', 'stopped']),
    steps: z.record(z.string(), planStepStateSchema),
    pause: z
      .object({
        reason: z.enum(['user', 'step_failed', 'interrupted', 'needs_input', 'unknown']),
        stepId: nonEmptyIdSchema.optional()
      })
      .strict()
      .optional(),
    replans: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1)
  })
  .strict()

export const sessionPlanEnterParamsSchema = z.object({ execute: z.boolean().optional() }).strict()
export const sessionPlanEnterResultSchema = z.object({ enabled: z.literal(true) }).strict()
export const sessionPlanCancelParamsSchema = z
  .object({ replanRequestId: nonEmptyIdSchema.max(200).optional() })
  .strict()
export const sessionPlanCancelResultSchema = z.object({ cancelled: z.boolean() }).strict()

export const planRunsListParamsSchema = z.object({}).strict()
export const planRunsListResultSchema = z.array(planRunStateSchema)
export const planRunsGetParamsSchema = z.object({ runId: nonEmptyIdSchema }).strict()
export const planRunsGetResultSchema = planRunStateSchema.nullable()
const planRunStepMutationParamsSchema = z
  .object({ runId: nonEmptyIdSchema, stepId: nonEmptyIdSchema })
  .strict()
export const planRunsRetryStepParamsSchema = planRunStepMutationParamsSchema
export const planRunsRetryStepResultSchema = planRunStateSchema
export const planRunsSkipStepParamsSchema = planRunStepMutationParamsSchema
export const planRunsSkipStepResultSchema = planRunStateSchema
export const planRunsReplanParamsSchema = z.object({ runId: nonEmptyIdSchema }).strict()
export const planRunsReplanResultSchema = z
  .object({ requestId: nonEmptyIdSchema, runId: nonEmptyIdSchema, prompt: z.string().min(1) })
  .strict()
export const planRunsStopParamsSchema = z.object({ runId: nonEmptyIdSchema }).strict()
export const planRunsStopResultSchema = planRunStateSchema

export const agentRunStateSchema = z.enum([
  'accepted',
  'started',
  'queued',
  'running',
  'done',
  'error',
  'cancelled',
  'unknown'
])
export const agentRunSnapshotSchema = z
  .object({
    requestId: nonEmptyIdSchema,
    runId: nonEmptyIdSchema.optional(),
    agent: z.string().min(1),
    task: z.string(),
    state: agentRunStateSchema,
    origin: z.enum(['tool', 'host']),
    background: z.boolean(),
    acceptedAt: z.string().min(1),
    startedAt: z.number().finite().nonnegative().optional(),
    completedAt: z.number().finite().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    report: z.string().optional(),
    reportStatus: z.enum(['completed', 'partial', 'not_found', 'blocked', 'failed']).optional(),
    missingInputs: z.array(z.string()).optional(),
    error: z.string().optional(),
    lastStep: z.string().optional(),
    reported: z.boolean().optional(),
    toolCallId: nonEmptyIdSchema.optional()
  })
  .strict()

export const agentRunsStartParamsSchema = z
  .object({
    requestId: nonEmptyIdSchema.max(MAX_CLIENT_RUN_KEY_LENGTH),
    agent: z.string().min(1).max(128).optional(),
    task: z
      .string()
      .min(1)
      .max(32 * 1024)
  })
  .strict()
export const agentRunsStartResultSchema = agentRunSnapshotSchema
export const agentRunsListParamsSchema = z.object({}).strict()
export const agentRunsListResultSchema = z.array(agentRunSnapshotSchema)
export const agentRunsWaitParamsSchema = z
  .object({
    runId: nonEmptyIdSchema,
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(10 * 60_000)
      .optional()
  })
  .strict()
export const agentRunsWaitResultSchema = z
  .object({ run: agentRunSnapshotSchema, timedOut: z.boolean() })
  .strict()
export const agentRunsSteerParamsSchema = z
  .object({
    runId: nonEmptyIdSchema,
    message: z
      .string()
      .min(1)
      .max(32 * 1024)
  })
  .strict()
export const agentRunsSteerResultSchema = z.object({ ok: z.literal(true) }).strict()
export const agentRunsStopParamsSchema = z.object({ runId: nonEmptyIdSchema }).strict()
export const agentRunsStopResultSchema = z.object({ ok: z.boolean() }).strict()

export const planRunUpdatedPayloadSchema = z
  .object({ event: z.enum(['plan_run_updated', 'plan_run_finished']), state: planRunStateSchema })
  .strict()
export const agentRunStartedPayloadSchema = agentRunSnapshotSchema
export const agentRunStepPayloadSchema = z
  .object({ run: agentRunSnapshotSchema, step: jsonValueSchema })
  .strict()
export const agentRunFinishedPayloadSchema = agentRunSnapshotSchema
export const agentRunReportedPayloadSchema = z
  .object({ requestId: nonEmptyIdSchema, runId: nonEmptyIdSchema })
  .strict()

// Fork source identity stays in trusted request context. `cut` is optional so
// v1 clients that send `{}` retain the K3-2 full-history behavior.
export const sessionForkCutSchema = z
  .object({
    userMessages: z.array(z.string()).min(1),
    selectedIndex: z.number().int().nonnegative()
  })
  .strict()
  .refine((cut) => cut.selectedIndex < cut.userMessages.length, {
    message: 'selectedIndex must identify a user message',
    path: ['selectedIndex']
  })
export const sessionForkParamsSchema = z.object({ cut: sessionForkCutSchema.optional() }).strict()
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
    phiAgents: phiAgentSnapshotSchema.optional(),
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
    appendSystemPrompt: z.array(z.string()).optional(),
    agents: z
      .union([
        z.object({ applied: z.literal(true), added: z.array(z.string()) }).strict(),
        z
          .object({
            applied: z.literal(false),
            reason: z.literal('requires_session_refresh'),
            changed: z.array(z.string())
          })
          .strict()
      ])
      .optional()
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

export const projectMemorySnapshotSchema = z
  .object({
    summary: z.string(),
    summaryUpdatedAt: z.string().nullable(),
    lessons: z.array(z.object({ index: z.number().int().nonnegative(), text: z.string() }).strict())
  })
  .strict()
export const memoryReadParamsSchema = z.object({}).strict()
export const memoryReadResultSchema = projectMemorySnapshotSchema
export const memoryDeleteLessonParamsSchema = z
  .object({ index: z.number().int().nonnegative(), text: z.string().max(2000) })
  .strict()
export const memoryDeleteLessonResultSchema = projectMemorySnapshotSchema
export const memoryClearParamsSchema = z.object({}).strict()
export const memoryClearResultSchema = z.object({ cleared: z.literal(true) }).strict()

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

export const kernelModelDescriptorSchema = modelSelectorSchema.extend({
  name: z.string().min(1),
  reasoning: z.boolean(),
  input: z
    .array(z.enum(['text', 'image']))
    .min(1)
    .max(2),
  contextWindow: z.number().int().positive().nullable(),
  maxTokens: z.number().int().positive().nullable(),
  cost: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      cacheWrite: z.number().nonnegative()
    })
    .strict()
    .optional()
})

export const modelAccessStatusSchema = z.enum(['available', 'unreachable', 'unauthenticated'])

export const sessionSetModelParamsSchema = z.object({ model: modelSelectorSchema }).strict()
export const sessionSetModelResultSchema = sessionSnapshotResultSchema

export const sessionSetThinkingLevelParamsSchema = z.object({ level: thinkingLevelSchema }).strict()
export const sessionSetThinkingLevelResultSchema = sessionSnapshotResultSchema

const contextUsageCategorySchema = z
  .object({
    id: z.enum([
      'systemPrompt',
      'toolDefinitions',
      'systemTools',
      'mcpTools',
      'systemContext',
      'skills',
      'conversation'
    ]),
    tokens: z.number().nonnegative()
  })
  .strict()

export const sessionContextUsageParamsSchema = z.object({}).strict()
export const sessionContextUsageResultSchema = z
  .object({
    tokens: z.number().nonnegative(),
    contextWindow: z.number().nonnegative(),
    percent: z.number().nonnegative(),
    categories: z.array(contextUsageCategorySchema).optional(),
    deferredMcpTokens: z.number().nonnegative().optional()
  })
  .strict()
  .nullable()

export const sessionCompactParamsSchema = z.object({}).strict()
export const sessionCompactResultSchema = z
  .object({
    summary: z
      .object({
        summary: z.string(),
        shortSummary: z.string().optional(),
        tokensBefore: z.number().nonnegative(),
        tokensAfter: z.number().nonnegative().optional()
      })
      .strict(),
    state: sessionSnapshotResultSchema
  })
  .strict()

const autoCompactionResultSchema = z
  .object({
    enabled: z.boolean(),
    // -1 is OMP's default: inherit the reserve-based threshold instead of a percentage.
    thresholdPercent: z.number().min(-1).max(100),
    thresholdTokens: z.number().int().min(-1)
  })
  .strict()

export const sessionGetAutoCompactionParamsSchema = z.object({}).strict()
export const sessionGetAutoCompactionResultSchema = autoCompactionResultSchema
export const sessionSetAutoCompactionParamsSchema = z
  .object({
    enabled: z.boolean().optional(),
    thresholdPercent: z.union([z.literal(70), z.literal(80), z.literal(90)]).optional()
  })
  .strict()
export const sessionSetAutoCompactionResultSchema = autoCompactionResultSchema

export const modelsCatalogParamsSchema = z.object({}).strict()
export const modelsCatalogResultSchema = z
  .object({
    models: z.array(kernelModelDescriptorSchema),
    providers: z.array(
      z.object({ provider: z.string().min(1), status: modelAccessStatusSchema }).strict()
    )
  })
  .strict()

export const modelAccessConfigureParamsSchema = z
  .object({
    endpoint: z.string().url(),
    bearerToken: z
      .string()
      .min(32)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    models: z.array(kernelModelDescriptorSchema).min(1).max(256),
    cursor: z
      .object({
        baseUrl: z.string().url(),
        bearerToken: z
          .string()
          .min(32)
          .max(256)
          .regex(/^[A-Za-z0-9_-]+$/)
      })
      .strict()
      .optional()
  })
  .strict()
export const modelAccessConfigureResultSchema = z.object({ configured: z.literal(true) }).strict()

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
    decision: z.enum(['approved', 'denied']),
    reason: z.string().min(1).optional()
  })
  .strict()
export const approvalRespondResultSchema = z.object({ accepted: z.literal(true) }).strict()

export const runCompletedPayloadSchema = z
  .object({
    runId: nonEmptyIdSchema,
    status: runCompletionStatusSchema,
    detail: z.string().optional(),
    model: modelSelectorSchema.optional(),
    resourceVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict()

export const approvalRequestedPayloadSchema = z
  .object({
    approvalId: nonEmptyIdSchema,
    toolCallId: nonEmptyIdSchema,
    toolName: z.string(),
    input: jsonValueSchema,
    agentRunId: nonEmptyIdSchema.optional(),
    // The path a read or search reaches outside the project, shown in the approval dialog.
    outsideProject: z.string().min(1).max(4096).optional()
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
export type SessionPromptResult = z.infer<typeof sessionPromptResultSchema>
export type PlanRunStateDto = z.infer<typeof planRunStateSchema>
export type AgentRunSnapshotDto = z.infer<typeof agentRunSnapshotSchema>
export type SessionForkCut = z.infer<typeof sessionForkCutSchema>
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
export type MemoryReadParams = z.infer<typeof memoryReadParamsSchema>
export type MemoryReadResult = z.infer<typeof memoryReadResultSchema>
export type MemoryDeleteLessonParams = z.infer<typeof memoryDeleteLessonParamsSchema>
export type MemoryDeleteLessonResult = z.infer<typeof memoryDeleteLessonResultSchema>
export type MemoryClearParams = z.infer<typeof memoryClearParamsSchema>
export type MemoryClearResult = z.infer<typeof memoryClearResultSchema>
export type SessionSnapshotParams = z.infer<typeof sessionSnapshotParamsSchema>
export type SessionSnapshotResult = z.infer<typeof sessionSnapshotResultSchema>
export type KernelModelDescriptor = z.infer<typeof kernelModelDescriptorSchema>
export type ModelAccessStatus = z.infer<typeof modelAccessStatusSchema>
export type SessionSetModelParams = z.infer<typeof sessionSetModelParamsSchema>
export type SessionSetThinkingLevelParams = z.infer<typeof sessionSetThinkingLevelParamsSchema>
export type ModelAccessConfigureParams = Readonly<{
  endpoint: string
  bearerToken: string
  models: readonly Readonly<
    Omit<KernelModelDescriptor, 'input' | 'cost'> & {
      input: readonly ('text' | 'image')[]
      cost?: Readonly<NonNullable<KernelModelDescriptor['cost']>>
    }
  >[]
  /** Cursor stays on its native protocol, so it reaches the desktop through its own tunnel. */
  cursor?: Readonly<{ baseUrl: string; bearerToken: string }>
}>
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
  'session.plan.enter': sessionPlanEnterParamsSchema,
  'session.plan.cancel': sessionPlanCancelParamsSchema,
  'planRuns.list': planRunsListParamsSchema,
  'planRuns.get': planRunsGetParamsSchema,
  'planRuns.retryStep': planRunsRetryStepParamsSchema,
  'planRuns.skipStep': planRunsSkipStepParamsSchema,
  'planRuns.replan': planRunsReplanParamsSchema,
  'planRuns.stop': planRunsStopParamsSchema,
  'agentRuns.start': agentRunsStartParamsSchema,
  'agentRuns.list': agentRunsListParamsSchema,
  'agentRuns.wait': agentRunsWaitParamsSchema,
  'agentRuns.steer': agentRunsSteerParamsSchema,
  'agentRuns.stop': agentRunsStopParamsSchema,
  'resources.reload': resourcesReloadParamsSchema,
  'shellJobs.list': shellJobsListParamsSchema,
  'shellJobs.cancel': shellJobsCancelParamsSchema,
  'session.fork': sessionForkParamsSchema,
  'session.abort': sessionAbortParamsSchema,
  'session.snapshot': sessionSnapshotParamsSchema,
  'session.setModel': sessionSetModelParamsSchema,
  'session.setThinkingLevel': sessionSetThinkingLevelParamsSchema,
  'session.contextUsage': sessionContextUsageParamsSchema,
  'session.compact': sessionCompactParamsSchema,
  'session.getAutoCompaction': sessionGetAutoCompactionParamsSchema,
  'session.setAutoCompaction': sessionSetAutoCompactionParamsSchema,
  'memory.read': memoryReadParamsSchema,
  'memory.deleteLesson': memoryDeleteLessonParamsSchema,
  'memory.clear': memoryClearParamsSchema,
  'session.close': sessionCloseParamsSchema,
  'models.catalog': modelsCatalogParamsSchema,
  'modelAccess.configure': modelAccessConfigureParamsSchema,
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
  'session.plan.enter': sessionPlanEnterResultSchema,
  'session.plan.cancel': sessionPlanCancelResultSchema,
  'planRuns.list': planRunsListResultSchema,
  'planRuns.get': planRunsGetResultSchema,
  'planRuns.retryStep': planRunsRetryStepResultSchema,
  'planRuns.skipStep': planRunsSkipStepResultSchema,
  'planRuns.replan': planRunsReplanResultSchema,
  'planRuns.stop': planRunsStopResultSchema,
  'agentRuns.start': agentRunsStartResultSchema,
  'agentRuns.list': agentRunsListResultSchema,
  'agentRuns.wait': agentRunsWaitResultSchema,
  'agentRuns.steer': agentRunsSteerResultSchema,
  'agentRuns.stop': agentRunsStopResultSchema,
  'resources.reload': resourcesReloadResultSchema,
  'shellJobs.list': shellJobsListResultSchema,
  'shellJobs.cancel': shellJobsCancelResultSchema,
  'session.fork': sessionForkResultSchema,
  'session.abort': sessionAbortResultSchema,
  'session.snapshot': sessionSnapshotResultSchema,
  'session.setModel': sessionSetModelResultSchema,
  'session.setThinkingLevel': sessionSetThinkingLevelResultSchema,
  'session.contextUsage': sessionContextUsageResultSchema,
  'session.compact': sessionCompactResultSchema,
  'session.getAutoCompaction': sessionGetAutoCompactionResultSchema,
  'session.setAutoCompaction': sessionSetAutoCompactionResultSchema,
  'memory.read': memoryReadResultSchema,
  'memory.deleteLesson': memoryDeleteLessonResultSchema,
  'memory.clear': memoryClearResultSchema,
  'session.close': sessionCloseResultSchema,
  'models.catalog': modelsCatalogResultSchema,
  'modelAccess.configure': modelAccessConfigureResultSchema,
  'events.subscribe': eventsSubscribeResultSchema,
  'approval.respond': approvalRespondResultSchema
} satisfies Record<KernelV1Method, z.ZodType>
