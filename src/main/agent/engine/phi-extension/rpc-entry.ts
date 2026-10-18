import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'
import { AgentLifecycleManager } from '@oh-my-pi/pi-coding-agent/registry/agent-lifecycle'

import { createProjectToolBoundaryExtension } from './extensions/project-boundary'
import { createRemoteUrlGuardExtension } from './extensions/remote-url-guard'
import { createRpcModelSelectionExtension } from './extensions/rpc-model-selection'
import { createRpcCompactionExtension } from './extensions/rpc-compaction-control'
import { createRpcPromptExtension } from './extensions/rpc-prompt'
import { createRpcExecutionAuthorityExtension } from './extensions/rpc-execution-authority'
import { createRpcToolApprovalExtension } from './extensions/rpc-tool-approval'
import {
  createRpcHostResultExtension,
  type RpcHostResultReadiness
} from './extensions/rpc-host-result'
import { createRpcNativeStreamExtension } from './extensions/rpc-native-stream'
import { registerRpcSessionVerification } from './extensions/rpc-session-verification'
import { createRpcSubagentsExtension } from './extensions/rpc-subagents'
import {
  createRpcChildControlExtension,
  createRpcChildControlScopes
} from './extensions/rpc-child-control'
import { createRpcChildSteerPermits } from './extensions/rpc-child-steer-permit'
import { createRpcChildModelHeader, RPC_CHILD_MODEL_HEADER } from './lib/rpc-child-model-authority'
import {
  createCursorStreamRecoveryExtension,
  hasOwnedCursorContinuation
} from './extensions/cursor-stream-recovery'
import {
  createRpcTaskAdmissionExtension,
  type RpcVerifiedChildDispatch
} from './extensions/rpc-task-admission'
import { rpcTaskDefinitionConflictReason } from './extensions/rpc-task-definition-verifier'
import {
  loadRpcChildRuntimeConfig,
  childConfigDigest,
  makeRpcChildAttestation,
  CHILD_ATTEST_COMMAND,
  CHILD_ATTEST_DESCRIPTION
} from './lib/rpc-child-config'
import {
  sameRpcChildRoot,
  validateRpcChildRoot,
  type RpcChildRootScope
} from './lib/rpc-child-protocol'
import { executionRoster } from './lib/rpc-execution-protocol'
import {
  loadRpcRuntimeConfig,
  RPC_RUNTIME_COMMAND,
  RPC_RUNTIME_DESCRIPTION,
  rpcRuntimeConfigDigest
} from './lib/rpc-runtime-config'
import { loadRpcModelMetadata } from './lib/rpc-model-metadata'
import { resolveInsideProject } from './lib/project-path'
import { classifyXdevCall } from './lib/rpc-xdev'
import {
  loadRpcBootstrapConfig,
  RPC_BOOTSTRAP_COMMAND,
  RPC_BOOTSTRAP_CONFIG_ENV,
  RPC_BOOTSTRAP_DESCRIPTION,
  type RpcBootstrapAttestation
} from './lib/rpc-config'

// Native read can invoke format converters, model summaries and URL/internal handlers.
// Until R5 bridges those capabilities, only explicit existing text files are admitted.
// Like the legacy remote read, text is decided by content (no NUL, valid UTF-8), not by extension,
// so .ipynb, Dockerfile, Makefile, .smk, .nf and extensionless files stay readable.
const BINARY_SNIFF_BYTES = 8192
// Formats the native reader would convert or sniff as media; refused even if the bytes look textual.
const nonTextExtensions = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.epub',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.ico',
  '.heic',
  '.svgz',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.parquet',
  '.h5',
  '.h5ad',
  '.rds'
])

function isTextFile(path: string): boolean {
  if (nonTextExtensions.has(extname(path).toLowerCase())) return false
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(BINARY_SNIFF_BYTES)
    const length = readSync(fd, head, 0, BINARY_SNIFF_BYTES, 0)
    const bytes = head.subarray(0, length)
    if (bytes.includes(0)) return false
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
    } catch {
      return false
    }
    return true
  } finally {
    closeSync(fd)
  }
}

function unsupportedPath(path: string): boolean {
  return (
    // SDK18.10.3 expandPath rewrites these Unicode spaces before resolving reads.
    // Reject altered spellings in both requested and canonical paths. Literal
    // backslashes are also unsupported: Bun1.3.14 realpath cannot bind them,
    // and rejecting them removes the SDK's entire shell-unescaped base family.
    /[:;?\\\u00A0\u2000-\u200A\u202F\u205F\u3000]/u.test(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
}

/** Fixed18.10.3 sync/async resolvers try these variants before parsing :raw. */
function rawLiteralCollision(rawPath: string): boolean {
  const nfd = rawPath.normalize('NFD')
  const candidates = new Set([
    rawPath,
    rawPath.replace(/ (AM|PM)\./gu, '\u202f$1.'),
    nfd,
    rawPath.replace(/'/gu, '\u2019'),
    nfd.replace(/'/gu, '\u2019')
  ])
  for (const candidate of candidates) {
    try {
      lstatSync(candidate)
      return true
    } catch (error) {
      // SDK literal probes preserve ambiguous POSIX errors; refuse those too.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true
    }
  }
  return false
}
// One process generation owns child lifetime across its real per-session extension instances.
const childGenerations = new Map<
  string,
  {
    digest: string
    controller: AbortController
    steerPermits: ReturnType<typeof createRpcChildSteerPermits>
    controlScopes: ReturnType<typeof createRpcChildControlScopes>
    taskOwner?: {
      root: RpcChildRootScope
      tasks: ReturnType<typeof createRpcTaskAdmissionExtension>
    }
  }
>()

const rpcExtension: ExtensionFactory = async (pi) => {
  const config = loadRpcBootstrapConfig(process.env[RPC_BOOTSTRAP_CONFIG_ENV])
  if (realpathSync(process.cwd()) !== config.projectRoot)
    throw new Error('Phi RPC bootstrap cwd does not match its project')
  const modelMetadata = loadRpcModelMetadata(process.env.PI_CODING_AGENT_DIR, config)
  const runtime = loadRpcRuntimeConfig(process.env[RPC_BOOTSTRAP_CONFIG_ENV]!, config)
  const childConfig =
    runtime?.childRuntimeRequired === true
      ? loadRpcChildRuntimeConfig(
          process.env[RPC_BOOTSTRAP_CONFIG_ENV]!,
          {
            nonce: config.nonce,
            phiSessionId: config.sessionId,
            projectId: config.projectId,
            projectRoot: config.projectRoot,
            generation: runtime.generation
          },
          {
            required: true,
            otherCapabilities: [runtime.execution.capability, runtime.result.capability]
          }
        )
      : undefined
  let childPreflight: RpcVerifiedChildDispatch | undefined
  let childGeneration: ReturnType<typeof childGenerations.get>
  if (
    process.env.PHI_RPC_RUNTIME !== undefined &&
    (process.env.PHI_RPC_RUNTIME !== '1' || !runtime || !modelMetadata)
  )
    throw new Error('Phi composed RPC runtime configuration is missing')

  // Refuse unsupported native spellings before the shared guard's realpath.
  pi.on('tool_call', async (event, ctx) => {
    if (ctx.agent.kind !== 'main')
      return (
        childPreflight?.(event, ctx) ?? {
          block: true,
          reason: 'Phi child execution is unavailable'
        }
      )
    // xd:// device discovery is read-only documentation, not a file read. Dispatch (write) is
    // judged by the execution authority; every other spelling of the scheme is refused here.
    const xdev = classifyXdevCall(event.toolName, event.input)
    if (xdev?.kind === 'refused')
      return { block: true as const, reason: 'Phi RPC refuses this xd:// device path' }
    if (runtime && xdev?.kind === 'discovery') return undefined
    if (runtime && event.toolName !== 'read') return undefined
    const deny = {
      block: true as const,
      reason: 'Phi RPC bootstrap denies unbridged tools before R5'
    }
    if (event.toolName !== 'read') return deny
    const input = event.input as Record<string, unknown>
    if (
      !input ||
      typeof input.path !== 'string' ||
      Object.keys(input).some((key) => key !== 'path')
    )
      return deny
    const requested = input.path
    // Avoid native selector/list/URI parsing, tilde expansion and missing-file fuzzy recovery.
    if (!requested || unsupportedPath(requested) || requested.startsWith('~')) return deny
    try {
      const decision = resolveInsideProject(config.projectRoot, requested, 'RPC read')
      if (!decision.ok) return { block: true, reason: decision.error }
      const path = realpathSync(resolve(config.projectRoot, requested))
      if (unsupportedPath(path)) return deny
      if (!statSync(path).isFile())
        return {
          block: true,
          reason:
            'Phi RPC read supports regular text files only; list directories with glob or bash'
        }
      if (!isTextFile(path))
        return {
          block: true,
          reason:
            'Phi RPC read supports text files only; this file looks binary, inspect it with bash'
        }
      const rawPath = `${path}:raw`
      // The SDK probes fallback spellings as literal names before interpreting
      // :raw. No candidate may substitute for the exact authorized file.
      if (rawLiteralCollision(rawPath)) return deny
      // Raw suppresses native media sniffing, IDA, summarization and Markdown rendering.
      return { input: { path: rawPath } }
    } catch {
      return deny
    }
  })

  await createProjectToolBoundaryExtension(config.projectRoot)(pi)
  await createRemoteUrlGuardExtension()(pi)
  await createCursorStreamRecoveryExtension((ctx) => {
    const ref = pi.pi.AgentRegistry.global().get(ctx.agent.id)
    const current = ref?.session
    return ref?.kind === ctx.agent.kind && current?.sessionManager === ctx.sessionManager
      ? current.agent
      : undefined
  })(pi)
  if (modelMetadata) await createRpcModelSelectionExtension(modelMetadata)(pi)

  if (runtime) {
    const lifetime = new AbortController()
    const prompt = createRpcPromptExtension(runtime, lifetime.signal)
    await prompt.extension(pi)
    const compaction = createRpcCompactionExtension(runtime, lifetime.signal)
    await compaction.extension(pi)
    let childController: ReturnType<typeof createRpcSubagentsExtension> | undefined
    let taskAdmission: ReturnType<typeof createRpcTaskAdmissionExtension> | undefined
    if (childConfig) {
      const digest = childConfigDigest(childConfig)
      let generation = childGenerations.get(config.nonce)
      if (generation && (generation.digest !== digest || generation.controller.signal.aborted))
        throw new Error('Phi child generation is retired or differs')
      if (!generation) {
        generation = {
          digest,
          controller: new AbortController(),
          steerPermits: createRpcChildSteerPermits(),
          controlScopes: createRpcChildControlScopes()
        }
        childGenerations.set(config.nonce, generation)
      }
      const ownedGeneration = generation
      childGeneration = ownedGeneration
      const root = (): RpcChildRootScope | undefined => {
        if (ownedGeneration.controller.signal.aborted) return undefined
        const ref = pi.pi.AgentRegistry.global().get('Main')
        const session = ref?.session
        if (
          ref?.kind !== 'main' ||
          !session?.sessionFile ||
          realpathSync(session.sessionManager.getCwd()) !== config.projectRoot
        )
          return undefined
        return validateRpcChildRoot({
          phiSessionId: config.sessionId,
          projectId: config.projectId,
          cwd: config.projectRoot,
          generation: runtime.generation,
          rootAgentId: ref.id,
          rootOmpSessionId: session.sessionId,
          rootSessionFile: session.sessionFile
        })
      }
      childController = createRpcSubagentsExtension({
        resources: childConfig.resources,
        agentDir: process.env.PI_CODING_AGENT_DIR!,
        hostResult: {
          generationDirectory: runtime.generationDirectory,
          directory: runtime.result.directory,
          capability: runtime.result.capability,
          leaseId: runtime.result.leaseId
        },
        steerPermits: ownedGeneration.steerPermits,
        controlScopes: ownedGeneration.controlScopes,
        readiness: () => {
          const identity = root()
          return identity
            ? {
                identity,
                capability: childConfig.capability,
                profiles: childConfig.profiles,
                signal: ownedGeneration.controller.signal
              }
            : undefined
        }
      })
      const children = childController
      childPreflight = (event, ctx) =>
        children.preflight(event.toolCallId, event.toolName, event.input, ctx)
      taskAdmission = createRpcTaskAdmissionExtension({
        config: childConfig,
        signal: ownedGeneration.controller.signal,
        root,
        parentRun: () => execution.taskParent(),
        onChildAborted: (run) => execution.revokeTaskParent(run),
        verifyResolvedDefinition: rpcTaskDefinitionConflictReason,
        assertPublication: () => {
          const fresh = loadRpcChildRuntimeConfig(
            process.env[RPC_BOOTSTRAP_CONFIG_ENV]!,
            childConfig,
            {
              required: true,
              otherCapabilities: [runtime.execution.capability, runtime.result.capability]
            }
          )
          if (!fresh || childConfigDigest(fresh) !== digest)
            throw new Error('Phi child publication changed')
        }
      })
      const tasks = taskAdmission
      await createRpcChildControlExtension({
        config: childConfig,
        root,
        signal: ownedGeneration.controller.signal,
        steerPermits: ownedGeneration.steerPermits,
        queuedCancellation: {
          lifecycle: AgentLifecycleManager.global(),
          owns: hasOwnedCursorContinuation,
          verify: ownedGeneration.controlScopes.verify
        },
        assertPublication: () => {
          const fresh = loadRpcChildRuntimeConfig(
            process.env[RPC_BOOTSTRAP_CONFIG_ENV]!,
            childConfig,
            {
              required: true,
              otherCapabilities: [runtime.execution.capability, runtime.result.capability]
            }
          )
          if (!fresh || childConfigDigest(fresh) !== digest)
            throw new Error('Phi child publication changed')
        }
      })(pi)
      pi.registerCommand(CHILD_ATTEST_COMMAND, {
        description: CHILD_ATTEST_DESCRIPTION,
        handler: async (args, ctx) => {
          if (args !== config.nonce || ctx.agent.kind !== 'main' || !ctx.isIdle())
            throw new Error('Phi child attestation refused')
          tasks.assertInstalled(ctx)
          const identity = root()
          if (!identity) throw new Error('Phi child root identity is unavailable')
          ownedGeneration.taskOwner = { root: identity, tasks }
          ctx.ui.notify(JSON.stringify(makeRpcChildAttestation(childConfig, identity)), 'info')
        }
      })
      pi.on('session_shutdown', (_event, ctx) => {
        if (ctx.agent.kind === 'main') {
          ownedGeneration.controller.abort()
          children.dispose()
          tasks.dispose()
        }
      })
    }
    const execution = createRpcExecutionAuthorityExtension({
      identity: {
        nonce: config.nonce,
        phiSessionId: config.sessionId,
        projectId: config.projectId,
        cwd: config.projectRoot,
        generation: runtime.generation
      },
      capability: runtime.execution.capability,
      roster: runtime.execution.tools,
      allowNativeTask: childConfig !== undefined,
      admitTask: taskAdmission?.preflight,
      childPreflight
    })
    const roster = executionRoster(runtime.execution.tools, {
      allowNativeTask: childConfig !== undefined
    })
    const hostNames = new Set(
      roster.tools.filter((tool) => tool.site === 'host').map((tool) => tool.name)
    )
    const native = createRpcNativeStreamExtension(
      {
        generation: runtime.generation,
        endpoint: runtime.native.endpoint,
        models: runtime.native.models,
        signal: lifetime.signal,
        isActive: () =>
          !lifetime.signal.aborted &&
          (compaction.isActive() || (taskAdmission?.isStreamActive() ?? true))
      },
      (ctx, expectedNativeWrapper) => {
        if (ctx.agent.kind === 'main') return undefined
        const childScope = childController?.modelScope(ctx, expectedNativeWrapper)
        const owner = childGeneration?.taskOwner
        if (
          !childConfig ||
          !childScope ||
          !childGeneration ||
          childGenerations.get(config.nonce) !== childGeneration ||
          childGeneration.controller.signal.aborted ||
          !owner ||
          !sameRpcChildRoot(owner.root, childScope) ||
          !owner.tasks.isChildStreamActive(childScope.nativeAgentId)
        )
          throw new Error('Child model authority is unavailable')
        return {
          [RPC_CHILD_MODEL_HEADER]: createRpcChildModelHeader(childScope, childConfig.capability)
        }
      }
    )
    await native.extension(pi)
    if (childController && taskAdmission) {
      await childController.extension(pi)
      await taskAdmission.extension(pi)
    }
    // All input rewriting and both project/URL guards precede the signed origin.
    await execution.extension(pi)
    await createRpcToolApprovalExtension({
      readiness: execution.readiness,
      xdevDispatching: execution.xdevDispatching,
      admitTask: taskAdmission?.preflight,
      childPreflight,
      mainNegativeApproval: taskAdmission
        ? {
            parentRun: execution.taskParent,
            sealParent: (run, ctx) => {
              if (taskAdmission?.sealParent(run, ctx)) execution.revokeTaskParent(run)
            }
          }
        : undefined,
      classifyTool: (name) =>
        name === 'task' && childConfig
          ? 'delegate'
          : hostNames.has(name)
            ? 'host'
            : ['write', 'edit'].includes(name)
              ? 'write'
              : ['bash', 'powershell'].includes(name)
                ? 'exec'
                : roster.tools.some((tool) => tool.name === name && tool.site === 'native')
                  ? 'read'
                  : undefined
    })(pi)
    let cached: Readonly<RpcHostResultReadiness> | undefined
    const readiness = (): Readonly<RpcHostResultReadiness> | undefined => {
      const current = execution.readiness()
      if (!current) {
        cached = undefined
        return undefined
      }
      if (
        !cached ||
        cached.runId !== current.runId ||
        cached.signal !== current.signal ||
        cached.ompSessionId !== current.ompSessionId
      )
        cached = Object.freeze({ ...current, leaseId: runtime.result.leaseId })
      return cached
    }
    await createRpcHostResultExtension({
      generationDirectory: runtime.generationDirectory,
      directory: runtime.result.directory,
      capability: runtime.result.capability,
      readiness,
      isHostTool: (name) => hostNames.has(name)
    })(pi)
    registerRpcSessionVerification(pi, {
      nonce: config.nonce,
      phiSessionId: config.sessionId,
      projectId: config.projectId,
      generation: runtime.generation,
      projectRoot: config.projectRoot,
      directory: runtime.directory,
      journals: runtime.journals,
      blobs: runtime.blobs,
      signal: lifetime.signal,
      assertActive: () => {
        if (lifetime.signal.aborted || execution.readiness())
          throw new Error('RPC verification requires exclusive idle authority')
      }
    })
    pi.registerCommand(RPC_RUNTIME_COMMAND, {
      description: RPC_RUNTIME_DESCRIPTION,
      handler: async (args, ctx) => {
        if (
          args !== config.nonce ||
          ctx.agent.kind !== 'main' ||
          realpathSync(ctx.cwd) !== config.projectRoot ||
          !ctx.isIdle()
        )
          throw new Error('Phi RPC runtime challenge refused')
        await pi.setActiveTools([...runtime.activeTools])
        if (
          JSON.stringify([...pi.getActiveTools()].sort()) !==
          JSON.stringify([...runtime.activeTools].sort())
        )
          throw new Error('Phi RPC exact tool roster is not active')
        native.assertInstalled(ctx)
        prompt.assertInstalled(ctx)
        ctx.ui.notify(
          JSON.stringify({
            type: 'phi_rpc_runtime_attestation',
            nonce: config.nonce,
            phiSessionId: config.sessionId,
            projectId: config.projectId,
            projectRoot: config.projectRoot,
            generation: runtime.generation,
            ompSessionId: ctx.sessionManager.getSessionId(),
            rosterHash: roster.hash,
            configHash: rpcRuntimeConfigDigest(runtime),
            components: ['execution', 'approval', 'host-result', 'verification', 'native-stream']
          }),
          'info'
        )
      }
    })
  }

  // Registration is last: the Node attester must prove this exact command exists first.
  pi.registerCommand(RPC_BOOTSTRAP_COMMAND, {
    description: RPC_BOOTSTRAP_DESCRIPTION,
    handler: async (args, ctx) => {
      if (args !== config.nonce || realpathSync(ctx.cwd) !== config.projectRoot)
        throw new Error('Phi RPC bootstrap challenge or project does not match')
      const attestation: RpcBootstrapAttestation = {
        type: 'phi_rpc_bootstrap_attestation',
        protocolVersion: 1,
        nonce: config.nonce,
        sessionId: config.sessionId,
        projectId: config.projectId,
        projectRoot: config.projectRoot,
        ompVersion: config.ompVersion,
        contentHash: config.contentHash,
        guards: { projectBoundary: true, remoteUrl: true, writes: 'deny' }
      }
      ctx.ui.notify(JSON.stringify(attestation), 'info')
    }
  })
}

export default rpcExtension
