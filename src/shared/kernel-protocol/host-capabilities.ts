import { z } from 'zod'

import { jsonValueSchema, type JsonValue } from './json'

const nonEmptyStringSchema = z.string().min(1)
const boundedIdSchema = nonEmptyStringSchema.max(512)
const jsonObjectSchema: z.ZodType<{ [key: string]: JsonValue }> = z
  .record(z.string(), jsonValueSchema)
  .refine((value) => Object.keys(value).length <= 256, 'JSON object has too many fields')
const emptyObjectSchema = z.object({}).strict()
const nullResultSchema = z.null()

const service = (
  timeoutMs: number,
  runScoped: boolean
): { interaction: 'service'; timeoutMs: number; runScoped: boolean } => ({
  interaction: 'service' as const,
  timeoutMs,
  runScoped
})

const user = (runScoped = true): { interaction: 'user'; runScoped: boolean } => ({
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

const modelAccessCredentialEntrySchema = z
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
  'modelAccess.credentials',
  'modelAccess.refresh',
  'cursorBridge.ensure',
  'capabilities.search',
  'capabilities.install',
  'capabilities.findSkills',
  'capabilities.cancel',
  'wrapperJob.start',
  'wrapperJob.status',
  'wrapperJob.list',
  'wrapperJob.cancel',
  'wrapperJob.wait',
  'agentRun.finished',
  'agentRun.step',
  'agentRun.reported'
] as const

export type KernelHostCapabilityName = (typeof KERNEL_HOST_CAPABILITIES)[number]

type KernelHostCapabilityDefinition = {
  readonly params: z.ZodType
  readonly result: z.ZodType
  readonly interaction: 'user' | 'service'
  readonly timeoutMs?: number
  readonly runScoped: boolean
  readonly sensitiveResult?: boolean
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
  'environments.bindSession': {
    params: environmentBindingParamsSchema,
    result: environmentBindingResultSchema,
    ...user()
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
    ...service(2 * NETWORK_SERVICE_TIMEOUT_MS, true)
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
