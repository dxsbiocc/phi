import { z } from 'zod'

import { jsonValueSchema, type JsonValue } from './json'

const nonEmptyStringSchema = z.string().min(1)
const boundedIdSchema = nonEmptyStringSchema.max(512)
const jsonObjectSchema: z.ZodType<{ [key: string]: JsonValue }> = z
  .record(z.string(), jsonValueSchema)
  .refine((value) => Object.keys(value).length <= 256, 'JSON object has too many fields')
const emptyObjectSchema = z.object({}).strict()
const nullResultSchema = z.null()
const desktopMcpSkipReasonSchema = z.enum([
  'unavailable',
  'stdio_not_allowed',
  'env_not_ready',
  'profile_changed',
  'api_key_missing',
  'api_key_unavailable',
  'prepare_failed',
  'connect_failed',
  'startup_failed',
  'startup_pending',
  'not_connected',
  'backoff'
])

const desktopMcpToolResultSchema = z
  .object({
    content: z
      .array(
        z.union([
          z.object({ type: z.literal('text'), text: z.string() }).strict(),
          z
            .object({
              type: z.literal('image'),
              data: z.string(),
              mimeType: z.string().min(1)
            })
            .strict()
        ])
      )
      .max(4096),
    details: jsonValueSchema.optional(),
    isError: z.boolean().optional()
  })
  .strict()

const desktopMcpToolMetadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(512)
      .regex(/^mcp__/),
    label: z.string(),
    description: z.string(),
    parameters: jsonObjectSchema,
    signature: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()

const recentUserImagesSchema = z
  .array(
    z
      .object({
        type: z.literal('image'),
        data: nonEmptyStringSchema,
        mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
      })
      .strict()
  )
  .max(5)
  .refine(
    (images) =>
      images.reduce((bytes, image) => bytes + new TextEncoder().encode(image.data).byteLength, 0) <=
      768 * 1024,
    'Recent user images exceed the bounded host-call payload'
  )

const nativeTaskNoticeParamsSchema = z
  .object({
    originSessionId: boundedIdSchema,
    nativeTaskId: boundedIdSchema,
    agent: nonEmptyStringSchema.max(512),
    createdAt: z.string().max(64).optional()
  })
  .strict()

const nativeTaskStepSchema = z
  .object({
    id: boundedIdSchema,
    toolName: nonEmptyStringSchema.max(512),
    status: z.enum(['running', 'done', 'error']),
    args: jsonValueSchema.optional(),
    output: z
      .string()
      .max(512 * 1024)
      .optional(),
    error: z
      .string()
      .max(64 * 1024)
      .optional(),
    createdAt: z.string().max(64).optional(),
    completedAt: z.string().max(64).optional(),
    durationMs: z.number().finite().nonnegative().optional()
  })
  .strict()

const service = (
  timeoutMs: number,
  runScoped: boolean | 'optional'
): { interaction: 'service'; timeoutMs: number; runScoped: boolean | 'optional' } => ({
  interaction: 'service' as const,
  timeoutMs,
  runScoped
})

const user = (
  runScoped: boolean | 'optional' = true
): { interaction: 'user'; runScoped: boolean | 'optional' } => ({
  interaction: 'user' as const,
  runScoped
})

const DEFAULT_SERVICE_TIMEOUT_MS = 30_000
const NETWORK_SERVICE_TIMEOUT_MS = 60_000

const planStepSchema = z
  .object({
    id: nonEmptyStringSchema.max(40),
    title: nonEmptyStringSchema.max(80),
    instructions: nonEmptyStringSchema.max(4_000),
    acceptance: nonEmptyStringSchema.max(1_000),
    dependsOn: z.array(nonEmptyStringSchema),
    access: z.enum(['read', 'write']),
    writes: z.array(nonEmptyStringSchema).optional(),
    agent: nonEmptyStringSchema.optional()
  })
  .strict()

const planSpecSchema = z
  .object({
    version: z.literal(1),
    goal: nonEmptyStringSchema,
    steps: z.array(planStepSchema).min(1).max(20)
  })
  .strict()

const interactionOptionSchema = z
  .object({
    label: nonEmptyStringSchema.max(60),
    description: nonEmptyStringSchema,
    preview: z.string().optional()
  })
  .strict()

const interactionQuestionSchema = z
  .object({
    question: nonEmptyStringSchema,
    header: nonEmptyStringSchema.max(16),
    options: z.array(interactionOptionSchema).min(2).max(4),
    multiSelect: z.boolean().optional()
  })
  .strict()

const interactionAnswerSchema = z
  .object({
    questionIndex: z.number().int().nonnegative(),
    question: nonEmptyStringSchema,
    kind: z.enum(['option', 'custom', 'multi']),
    answer: z.string().nullable(),
    selected: z.array(z.string()).optional(),
    notes: z.string().optional(),
    preview: z.string().optional()
  })
  .strict()

const interactionResponseSchema = z
  .object({
    requestId: nonEmptyStringSchema,
    answers: z.array(interactionAnswerSchema),
    cancelled: z.boolean().optional(),
    globalNote: z.string().optional(),
    error: z.string().optional()
  })
  .strict()

const browserRequestIdentitySchema = z
  .object({
    originSessionId: boundedIdSchema,
    requestId: boundedIdSchema,
    toolCallId: boundedIdSchema
  })
  .strict()

const presentedFileSchema = z
  .object({
    path: z.string(),
    displayPath: z.string(),
    bytes: z.number().int().nonnegative(),
    description: z.string().optional(),
    artifact: z
      .object({
        kind: nonEmptyStringSchema,
        title: nonEmptyStringSchema,
        envId: nonEmptyStringSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict()

const remoteProjectIdentitySchema = z
  .object({
    runtimeSessionId: boundedIdSchema,
    sessionId: boundedIdSchema,
    projectId: boundedIdSchema
  })
  .strict()

const environmentBindingParamsSchema = z
  .object({
    runtimeSessionId: boundedIdSchema,
    ref: nonEmptyStringSchema,
    agent: nonEmptyStringSchema,
    cwd: nonEmptyStringSchema,
    remoteSessionId: boundedIdSchema.optional(),
    projectId: boundedIdSchema.optional(),
    pluginId: nonEmptyStringSchema.optional()
  })
  .strict()

const environmentBindingResultSchema = z.union([
  z
    .object({
      ref: nonEmptyStringSchema,
      envId: nonEmptyStringSchema,
      variables: z.record(z.string(), z.string()),
      warnings: z.array(z.string()).optional(),
      name: nonEmptyStringSchema.optional(),
      prefix: nonEmptyStringSchema.optional(),
      packages: z.array(z.string()).optional(),
      channels: z.array(z.string()).optional()
    })
    .strict(),
  z
    .object({
      notReady: z
        .object({
          ref: nonEmptyStringSchema,
          envId: nonEmptyStringSchema,
          message: nonEmptyStringSchema
        })
        .strict()
    })
    .strict()
])

const environmentRequestIdentitySchema = z
  .object({
    requestId: boundedIdSchema,
    runtimeSessionId: boundedIdSchema.optional(),
    remoteSessionId: boundedIdSchema.optional(),
    projectId: boundedIdSchema.optional()
  })
  .strict()

const environmentRequestResultSchema = z.union([
  z
    .object({
      ref: nonEmptyStringSchema,
      envId: nonEmptyStringSchema,
      name: nonEmptyStringSchema,
      added: z.array(z.string()),
      notice: z.string().optional()
    })
    .strict(),
  z.object({ declined: z.literal(true) }).strict(),
  z.object({ error: nonEmptyStringSchema }).strict()
])

const scriptToolDescriptorSchema = z
  .object({
    name: nonEmptyStringSchema,
    description: z.string(),
    parameters: jsonObjectSchema,
    attachTo: z.array(nonEmptyStringSchema),
    skill: nonEmptyStringSchema,
    approval: z.enum(['read', 'write'])
  })
  .strict()

const skillRequestIdentitySchema = z
  .object({
    requestId: boundedIdSchema,
    runtimeSessionId: boundedIdSchema.optional(),
    remoteSessionId: boundedIdSchema.optional(),
    projectId: boundedIdSchema.optional()
  })
  .strict()

const skillNotReadySchema = z
  .object({
    notReady: z
      .object({
        ref: nonEmptyStringSchema,
        envId: nonEmptyStringSchema,
        message: nonEmptyStringSchema
      })
      .strict()
  })
  .strict()

const skillRunResultSchema = z
  .object({
    envId: nonEmptyStringSchema,
    resolvedCommand: z.string(),
    exitCode: z.number().int().nullable(),
    terminated: z.enum(['timeout', 'aborted']).optional(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() }).strict(),
    durationMs: z.number().nonnegative(),
    warnings: z.array(z.string())
  })
  .strict()

const scriptToolResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      output: jsonObjectSchema,
      envId: nonEmptyStringSchema,
      warnings: z.array(z.string()),
      presented: z.array(z.string()).optional(),
      presentedArtifacts: z
        .array(z.object({ title: z.string(), path: z.string() }).strict())
        .optional()
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: nonEmptyStringSchema,
      envId: nonEmptyStringSchema.optional(),
      warnings: z.array(z.string())
    })
    .strict()
])

const capabilityIdentitySchema = z
  .object({
    runtimeSessionId: boundedIdSchema,
    toolCallId: boundedIdSchema,
    requestId: boundedIdSchema
  })
  .strict()

const wrapperRunIdSchema = nonEmptyStringSchema.max(256).regex(/^[A-Za-z0-9_-]+$/)
const wrapperStatusSchema = jsonObjectSchema
const desktopServiceSessionSchema = z
  .object({
    runtimeSessionId: boundedIdSchema,
    cwd: nonEmptyStringSchema.max(8192)
  })
  .strict()
const decisionModelSchema = z
  .object({ providerId: nonEmptyStringSchema, modelId: nonEmptyStringSchema })
  .strict()
const decisionRequestSchema = z
  .object({
    purpose: z.enum(['task_routing', 'evidence_review', 'recovery']),
    context: z.string().max(32 * 1024),
    question: nonEmptyStringSchema.max(4096),
    options: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
            description: nonEmptyStringSchema.max(2048)
          })
          .strict()
      )
      .min(2)
      .max(12)
  })
  .strict()
const decisionResultSchema = z
  .object({
    choice: nonEmptyStringSchema,
    source: z.enum(['native', 'model']),
    model: decisionModelSchema,
    confidence: z.number().min(0).max(1).optional(),
    fallbackReason: z.enum(['not_configured', 'unavailable']).optional()
  })
  .strict()
const memoryRunSourceSchema = z
  .object({
    kind: z.enum(['journal', 'session']),
    sessionId: boundedIdSchema,
    journalPath: z.string().max(8192).optional()
  })
  .strict()
const projectMemorySnapshotSchema = z
  .object({
    summary: z.string(),
    summaryUpdatedAt: z.string().nullable(),
    lessons: z.array(z.object({ index: z.number().int().nonnegative(), text: z.string() }).strict())
  })
  .strict()

const modelAccessOAuthCredentialSchema = z
  .object({
    type: z.literal('oauth'),
    refresh: z.literal('__remote__'),
    access: z.string(),
    expires: z.number(),
    enterpriseUrl: z.string().optional(),
    projectId: z.string().optional(),
    email: z.string().optional(),
    accountId: z.string().optional(),
    apiEndpoint: z.string().optional(),
    orgId: z.string().optional(),
    orgName: z.string().optional(),
    region: z.string().optional(),
    inferenceRegion: z.enum(['global', 'eu', 'us']).optional(),
    activeOrganizationId: z.string().optional(),
    authorizedAt: z.number().optional()
  })
  .strict()

export const modelAccessCredentialEntrySchema = z
  .object({
    id: z.number().int().positive(),
    provider: nonEmptyStringSchema,
    credential: z.union([
      z
        .object({
          type: z.literal('api_key'),
          key: nonEmptyStringSchema,
          source: z.literal('login').optional()
        })
        .strict(),
      modelAccessOAuthCredentialSchema
    ]),
    identityKey: z.string().nullable()
  })
  .strict()

export const KERNEL_HOST_CAPABILITIES = [
  'agentInteraction.request',
  'planReview.request',
  'browser.execute',
  'browser.cancel',
  'deliverables.present',
  'notebookTool.execute',
  'decisions.evaluate',
  'libraryTool.execute',
  'palette.suggest',
  'memory.read',
  'memory.learn',
  'memory.ingest',
  'memory.deleteLesson',
  'memory.clear',
  'environments.bindSession',
  'environments.request',
  'environments.cancel',
  'workMode.selected',
  'settings.nextActionSuggestionsEnabled',
  'skills.scriptTools',
  'skills.run',
  'skills.scriptTool',
  'skills.cancel',
  'mcp.featuredApiKey',
  'mcp.openAuthUrl',
  'mcp.openCustomAuthUrl',
  'mcp.desktop.list',
  'mcp.desktop.call',
  'mcp.desktop.cancel',
  'mcp.desktop.close',
  'modelAccess.credentials',
  'modelAccess.refresh',
  'cursorBridge.ensure',
  'capabilities.search',
  'capabilities.install',
  'capabilities.findSkills',
  'capabilities.cancel',
  'wrapperCatalog.search',
  'wrapperCatalog.inspect',
  'wrapperJob.start',
  'wrapperJob.status',
  'wrapperJob.list',
  'wrapperJob.cancel',
  'wrapperJob.wait',
  'agentRun.finished',
  'agentRun.step',
  'agentRun.reported',
  'agentRun.nativeTaskStarted',
  'agentRun.nativeTaskBackground',
  'agentRun.nativeTaskStep',
  'agentRun.nativeTaskFinished'
] as const

export type KernelHostCapabilityName = (typeof KERNEL_HOST_CAPABILITIES)[number]

type KernelHostCapabilityDefinition = {
  readonly params: z.ZodType
  readonly result: z.ZodType
  readonly interaction: 'user' | 'service'
  readonly timeoutMs?: number
  readonly runScoped: boolean | 'optional'
  readonly sensitiveResult?: boolean
  readonly progress?: boolean
}

export const KERNEL_HOST_CAPABILITY_REGISTRY = {
  'agentInteraction.request': {
    params: z
      .object({
        runtimeSessionId: boundedIdSchema,
        questions: z.array(interactionQuestionSchema).min(1).max(4)
      })
      .strict(),
    result: interactionResponseSchema,
    ...user()
  },
  'planReview.request': {
    params: z
      .object({
        runtimeSessionId: boundedIdSchema,
        title: nonEmptyStringSchema.max(120),
        planContent: nonEmptyStringSchema.max(64 * 1024),
        planFilePath: z.string().regex(/^local:\/\/[A-Za-z0-9_-]+\.md$/),
        steps: planSpecSchema.optional(),
        replanRequestId: nonEmptyStringSchema.max(200).optional()
      })
      .strict(),
    result: z
      .object({
        decision: z.enum(['approve', 'revise', 'cancel']),
        note: z.string().max(2_000).optional(),
        planRunId: boundedIdSchema.optional()
      })
      .strict(),
    ...user()
  },
  'browser.execute': {
    params: browserRequestIdentitySchema.extend({ command: jsonObjectSchema }).strict(),
    result: jsonObjectSchema,
    ...user()
  },
  'browser.cancel': {
    params: browserRequestIdentitySchema,
    result: nullResultSchema,
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, true)
  },
  'deliverables.present': {
    params: z
      .object({
        runtimeSessionId: boundedIdSchema,
        toolCallId: boundedIdSchema,
        files: jsonValueSchema
      })
      .strict(),
    result: z.object({ files: z.array(presentedFileSchema).max(4) }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, true)
  },
  'notebookTool.execute': {
    params: z
      .object({
        action: nonEmptyStringSchema,
        cwd: nonEmptyStringSchema,
        params: jsonObjectSchema,
        remoteProject: remoteProjectIdentitySchema.optional()
      })
      .strict(),
    result: jsonValueSchema,
    ...user()
  },
  'decisions.evaluate': {
    params: z
      .object({
        runtimeSessionId: boundedIdSchema,
        model: decisionModelSchema,
        request: decisionRequestSchema
      })
      .strict(),
    result: decisionResultSchema,
    ...service(NETWORK_SERVICE_TIMEOUT_MS, true)
  },
  'libraryTool.execute': {
    params: desktopServiceSessionSchema
      .extend({
        action: z.enum(['save', 'update', 'remove', 'list', 'find', 'audit']),
        params: jsonObjectSchema
      })
      .strict(),
    result: z.object({ summary: z.string(), details: jsonObjectSchema }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, true)
  },
  'palette.suggest': {
    params: z
      .object({
        runtimeSessionId: boundedIdSchema,
        use: z
          .enum(['categorical', 'heatmap', 'diverging', 'sequential_warm', 'product'])
          .optional(),
        id: nonEmptyStringSchema.max(256).optional(),
        limit: z.number().int().min(1).max(4).optional()
      })
      .strict(),
    result: z.object({ palettes: z.array(jsonObjectSchema).max(4) }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, true)
  },
  'memory.read': {
    params: desktopServiceSessionSchema,
    result: z
      .object({
        memoryBlock: z
          .string()
          .max(64 * 1024)
          .optional(),
        snapshot: projectMemorySnapshotSchema.optional()
      })
      .strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'memory.learn': {
    params: desktopServiceSessionSchema
      .extend({
        input: z
          .object({
            content: nonEmptyStringSchema.max(2000),
            context: z.string().max(400).optional()
          })
          .strict()
      })
      .strict(),
    result: z.object({ stored: z.number().int().nonnegative() }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, true)
  },
  'memory.ingest': {
    params: desktopServiceSessionSchema
      .extend({
        runId: boundedIdSchema,
        status: z.literal('completed'),
        source: memoryRunSourceSchema
      })
      .strict(),
    result: z.object({ accepted: z.boolean(), duplicate: z.boolean().optional() }).strict(),
    ...service(2 * NETWORK_SERVICE_TIMEOUT_MS, false)
  },
  'memory.deleteLesson': {
    params: desktopServiceSessionSchema
      .extend({ index: z.number().int().nonnegative(), text: z.string().max(2000) })
      .strict(),
    result: z.object({ snapshot: projectMemorySnapshotSchema }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'memory.clear': {
    params: desktopServiceSessionSchema,
    result: nullResultSchema,
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'environments.bindSession': {
    params: environmentBindingParamsSchema,
    result: environmentBindingResultSchema,
    ...user('optional')
  },
  'environments.request': {
    params: z
      .object({
        runtimeSessionId: boundedIdSchema,
        cwd: nonEmptyStringSchema,
        packages: z.array(nonEmptyStringSchema).min(1).max(20),
        reason: nonEmptyStringSchema.max(500),
        environment: nonEmptyStringSchema,
        requestId: boundedIdSchema.optional(),
        remoteSessionId: boundedIdSchema.optional(),
        projectId: boundedIdSchema.optional(),
        pluginId: nonEmptyStringSchema.optional()
      })
      .strict(),
    result: environmentRequestResultSchema,
    ...user()
  },
  'environments.cancel': {
    params: environmentRequestIdentitySchema,
    result: nullResultSchema,
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, true)
  },
  'workMode.selected': {
    params: z.object({ execute: z.boolean(), reason: nonEmptyStringSchema.max(200) }).strict(),
    result: z
      .object({
        ok: z.literal(true),
        mode: z.enum(['plan', 'plan_execute']),
        reason: nonEmptyStringSchema.max(200)
      })
      .strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, true)
  },
  'settings.nextActionSuggestionsEnabled': {
    params: emptyObjectSchema,
    result: z.boolean(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'skills.scriptTools': {
    params: z
      .object({
        cwd: nonEmptyStringSchema,
        runtimeSessionId: boundedIdSchema.optional(),
        remoteSessionId: boundedIdSchema.optional(),
        projectId: boundedIdSchema.optional()
      })
      .strict(),
    result: z
      .object({
        tools: z.array(scriptToolDescriptorSchema),
        problems: z.array(z.string()).optional()
      })
      .strict(),
    ...service(NETWORK_SERVICE_TIMEOUT_MS, false)
  },
  'skills.run': {
    params: z
      .object({
        requestId: boundedIdSchema,
        cwd: nonEmptyStringSchema,
        skill: nonEmptyStringSchema,
        script: nonEmptyStringSchema,
        args: z.array(z.string()).optional(),
        runCwd: z.string().optional(),
        runtimeSessionId: boundedIdSchema.optional(),
        allowedSkills: z.array(nonEmptyStringSchema).optional(),
        sessionEnvironment: nonEmptyStringSchema.optional(),
        pluginId: nonEmptyStringSchema.optional(),
        remoteSessionId: boundedIdSchema.optional(),
        projectId: boundedIdSchema.optional()
      })
      .strict(),
    result: z.union([skillRunResultSchema, skillNotReadySchema]),
    ...user()
  },
  'skills.scriptTool': {
    params: z
      .object({
        requestId: boundedIdSchema,
        cwd: nonEmptyStringSchema,
        tool: nonEmptyStringSchema,
        args: jsonValueSchema,
        runtimeSessionId: boundedIdSchema.optional(),
        sessionEnvironment: nonEmptyStringSchema.optional(),
        pluginId: nonEmptyStringSchema.optional(),
        remoteSessionId: boundedIdSchema.optional(),
        projectId: boundedIdSchema.optional(),
        toolCallId: boundedIdSchema.optional()
      })
      .strict(),
    result: scriptToolResultSchema,
    ...user()
  },
  'skills.cancel': {
    params: skillRequestIdentitySchema,
    result: nullResultSchema,
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, true)
  },
  'mcp.featuredApiKey': {
    params: z.object({ id: nonEmptyStringSchema }).strict(),
    result: nonEmptyStringSchema.nullable(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false),
    sensitiveResult: true
  },
  'mcp.openAuthUrl': {
    params: z.object({ id: nonEmptyStringSchema, url: z.string().url() }).strict(),
    result: nullResultSchema,
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'mcp.openCustomAuthUrl': {
    params: z
      .object({
        name: nonEmptyStringSchema,
        attemptId: boundedIdSchema,
        url: z.string().url()
      })
      .strict(),
    result: nullResultSchema,
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'mcp.desktop.list': {
    params: z
      .object({
        bindingId: boundedIdSchema,
        cwd: nonEmptyStringSchema,
        registeredToolNames: z.array(nonEmptyStringSchema.max(512)).max(8192)
      })
      .strict(),
    result: z
      .object({
        tools: z.array(desktopMcpToolMetadataSchema).max(4096),
        skipped: z
          .array(
            z
              .object({
                name: nonEmptyStringSchema.max(512),
                reason: desktopMcpSkipReasonSchema
              })
              .strict()
          )
          .max(256)
      })
      .strict(),
    ...service(NETWORK_SERVICE_TIMEOUT_MS, 'optional')
  },
  'mcp.desktop.call': {
    params: z
      .object({
        bindingId: boundedIdSchema,
        toolCallId: boundedIdSchema,
        name: nonEmptyStringSchema.max(512),
        signature: z.string().regex(/^[a-f0-9]{64}$/),
        input: jsonObjectSchema,
        recentUserImages: recentUserImagesSchema.optional()
      })
      .strict(),
    result: desktopMcpToolResultSchema,
    ...service(2 * NETWORK_SERVICE_TIMEOUT_MS, true),
    progress: true
  },
  'mcp.desktop.cancel': {
    params: z.object({ bindingId: boundedIdSchema, toolCallId: boundedIdSchema }).strict(),
    result: nullResultSchema,
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, 'optional')
  },
  'mcp.desktop.close': {
    params: z.object({ bindingId: boundedIdSchema }).strict(),
    result: nullResultSchema,
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, 'optional')
  },
  'modelAccess.credentials': {
    params: z.object({ provider: nonEmptyStringSchema.optional() }).strict(),
    result: z.object({ credentials: z.array(modelAccessCredentialEntrySchema).max(1024) }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false),
    sensitiveResult: true
  },
  'modelAccess.refresh': {
    params: z
      .object({
        credentialId: z.number().int().positive(),
        reason: z.literal('auth-recovery').optional()
      })
      .strict(),
    result: modelAccessCredentialEntrySchema,
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false),
    sensitiveResult: true
  },
  'cursorBridge.ensure': {
    params: emptyObjectSchema,
    result: z.object({ baseUrl: z.string().url() }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'capabilities.search': {
    params: capabilityIdentitySchema
      .extend({
        query: nonEmptyStringSchema.max(500),
        limit: z.number().int().min(1).max(20).optional(),
        type: z.enum(['wrapper', 'mcp', 'skill', 'plugin']).optional()
      })
      .strict(),
    result: jsonObjectSchema,
    ...service(NETWORK_SERVICE_TIMEOUT_MS, true)
  },
  'capabilities.install': {
    params: capabilityIdentitySchema
      .extend({
        candidateId: nonEmptyStringSchema.max(200),
        reason: nonEmptyStringSchema.max(500)
      })
      .strict(),
    result: jsonObjectSchema,
    ...user()
  },
  'capabilities.findSkills': {
    params: capabilityIdentitySchema
      .extend({
        query: nonEmptyStringSchema.max(500),
        limit: z.number().int().min(1).max(20).optional()
      })
      .strict(),
    result: jsonObjectSchema,
    ...service(NETWORK_SERVICE_TIMEOUT_MS, true)
  },
  'capabilities.cancel': {
    params: capabilityIdentitySchema,
    result: z.object({ cancelled: z.boolean() }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, true)
  },
  'wrapperCatalog.search': {
    params: z.object({ query: z.string().max(500) }).strict(),
    result: desktopMcpToolResultSchema,
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'wrapperCatalog.inspect': {
    params: z.object({ id: nonEmptyStringSchema.max(512) }).strict(),
    result: desktopMcpToolResultSchema,
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'wrapperJob.start': {
    params: z
      .object({
        id: nonEmptyStringSchema,
        overrides: jsonObjectSchema,
        profile: nonEmptyStringSchema.optional(),
        target: z.enum(['local', 'remote']).optional(),
        originSessionId: boundedIdSchema.optional(),
        workflow: jsonObjectSchema.optional(),
        continueWhenDone: z.boolean().optional(),
        resources: jsonValueSchema.optional()
      })
      .strict(),
    result: z.union([
      z.object({ ok: z.literal(true), status: wrapperStatusSchema }).strict(),
      z.object({ ok: z.literal(false), error: nonEmptyStringSchema }).strict()
    ]),
    ...user()
  },
  'wrapperJob.status': {
    params: z.object({ runId: wrapperRunIdSchema }).strict(),
    result: wrapperStatusSchema.nullable(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'wrapperJob.list': {
    params: z.object({ limit: z.number().int().positive().optional() }).strict(),
    result: z.array(jsonObjectSchema),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'wrapperJob.cancel': {
    params: z.object({ runId: wrapperRunIdSchema }).strict(),
    result: z.union([
      z.object({ ok: z.literal(true), status: wrapperStatusSchema }).strict(),
      z.object({ ok: z.literal(false), error: nonEmptyStringSchema }).strict()
    ]),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'wrapperJob.wait': {
    params: z
      .object({
        runId: wrapperRunIdSchema,
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .max(10 * 60_000)
      })
      .strict(),
    result: wrapperStatusSchema.nullable(),
    ...service(11 * 60_000, false)
  },
  'agentRun.finished': {
    params: z.object({ originSessionId: boundedIdSchema, run: jsonObjectSchema }).strict(),
    result: z.object({ ok: z.literal(true) }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'agentRun.step': {
    params: z
      .object({
        originSessionId: boundedIdSchema,
        run: z
          .object({
            id: boundedIdSchema,
            agent: nonEmptyStringSchema,
            toolCallId: boundedIdSchema.optional()
          })
          .strict(),
        step: jsonObjectSchema
      })
      .strict(),
    result: z.object({ ok: z.literal(true) }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'agentRun.reported': {
    params: z.object({ originSessionId: boundedIdSchema, runId: boundedIdSchema }).strict(),
    result: z.object({ ok: z.literal(true) }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'agentRun.nativeTaskStarted': {
    params: nativeTaskNoticeParamsSchema
      .extend({
        task: nonEmptyStringSchema.max(64 * 1024),
        parentToolCallId: boundedIdSchema
      })
      .strict(),
    result: z.object({ ok: z.literal(true) }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'agentRun.nativeTaskBackground': {
    params: nativeTaskNoticeParamsSchema,
    result: z.object({ ok: z.literal(true) }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'agentRun.nativeTaskStep': {
    params: nativeTaskNoticeParamsSchema.extend({ step: nativeTaskStepSchema }).strict(),
    result: z.object({ ok: z.literal(true) }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  },
  'agentRun.nativeTaskFinished': {
    params: nativeTaskNoticeParamsSchema
      .extend({
        state: z.enum(['done', 'error', 'cancelled']),
        report: z
          .string()
          .max(256 * 1024)
          .optional(),
        error: z
          .string()
          .max(64 * 1024)
          .optional(),
        durationMs: z.number().finite().nonnegative().optional(),
        toolCalls: z.number().int().nonnegative().optional()
      })
      .strict(),
    result: z.object({ ok: z.literal(true) }).strict(),
    ...service(DEFAULT_SERVICE_TIMEOUT_MS, false)
  }
} as const satisfies Record<KernelHostCapabilityName, KernelHostCapabilityDefinition>

export type KernelHostCapabilityParams<Name extends KernelHostCapabilityName> = z.input<
  (typeof KERNEL_HOST_CAPABILITY_REGISTRY)[Name]['params']
>

export type KernelHostCapabilityResult<Name extends KernelHostCapabilityName> = z.output<
  (typeof KERNEL_HOST_CAPABILITY_REGISTRY)[Name]['result']
>

const kernelHostCapabilityNames = new Set<string>(KERNEL_HOST_CAPABILITIES)

export function isKernelHostCapabilityName(value: string): value is KernelHostCapabilityName {
  return kernelHostCapabilityNames.has(value)
}
