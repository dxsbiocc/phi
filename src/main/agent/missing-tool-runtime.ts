import { dirname, join } from 'node:path'

import type { MissingToolPrompt } from '../../shared/agentInteractionTypes'
import type { RemoteContainerRuntime } from '../../shared/wrapperRemoteTypes'
import type { ConfirmBuildRequest } from './content/environment-gate'
import { formatDownloadBytes } from './content/environment-build-prompt'
import { getRuntimeRoot } from './envs/runtime'
import { getCustomToolPath, setEnvironmentToolPath } from './environment'
import type { ResolvedMissingToolChoice } from './host-requests/missing-tool-prompt'
import type { ResolveMissingRemoteJupyter } from './notebook/remote-kernelspec-adapter'
import type { Project } from './projects'
import { remoteDoctor } from './remote-doctor'
import { readHostRemoteEnvironmentPaths } from './remote-environment-store'
import { installRemoteNextflow } from './remote-nextflow-install'
import { saveRemoteEnvironmentSetting } from './remote-runtime-root-settings'
import { readHostRuntimeRoot } from './remote-runtime-root-store'
import type { RemoteSshSession } from './wrappers/remote-ssh-session'
import { connectRemoteSshSession } from './wrappers/remote-ssh-session'
import type { WrapperExecutionProfile } from './wrappers/composition/executor'
import type { WrapperTargetDoctorSnapshot } from './wrappers/target-policy'
import type { ResolvedRemoteTarget } from './wrappers/remote-connection-resolver'
import {
  recoverRemoteWrapperTools,
  type MissingToolCandidate as WrapperMissingToolCandidate
} from './wrappers/missing-tool-recovery'
import {
  discoverMissingToolCandidates,
  resolveMissingToolPath,
  type MissingToolCandidate as HostMissingToolCandidate
} from './workspace-host/missing-tool-discovery'
import { LocalHost } from './workspace-host/local-host'
import { remoteSessionMissingToolExecution } from './workspace-host/remote-session-execution'

type PromptRun = {
  phiSessionId: string
  cwd: string
  projectId?: string
}

type RuntimeRootResolution = { configured: string }

export interface MissingToolRuntimeDependencies {
  agentDir: string
  prompt(input: MissingToolPrompt): Promise<ResolvedMissingToolChoice>
  confirmEnvironmentBuild(request: ConfirmBuildRequest): Promise<boolean>
  findActivePromptRun(runtimeSessionId: string): PromptRun | null
  getProject(projectId: string): Project | undefined
  projectRemoteRuntimeRoot(project: Project): RuntimeRootResolution
  connectRemoteWorkspaceHost(request: {
    sessionId: string
    projectId: string
    execTimeoutMs: number
  }): Promise<RemoteSshSession>
}

export interface MissingToolRuntime {
  confirmManagedToolBuild(request: ConfirmBuildRequest): Promise<boolean>
  containerRuntimePath(profile: string | undefined): string | undefined
  checkLocalWrapperEnvironment(input: {
    profile: WrapperExecutionProfile
    runtimeSessionId?: string
  }): Promise<void | { blocked: string }>
  checkRemoteWrapperEnvironment(input: {
    project: Project
    resolved: ResolvedRemoteTarget
    profile: WrapperExecutionProfile
    runtimeSessionId?: string
  }): Promise<WrapperTargetDoctorSnapshot | { blocked: string }>
  resolveMissingJupyter: ResolveMissingRemoteJupyter
}

function candidateSource(
  source: HostMissingToolCandidate['source']
): WrapperMissingToolCandidate['source'] {
  if (source === 'saved') return 'saved'
  if (source === 'login-path') return 'path'
  if (source === 'conda-env') return 'conda'
  if (source === 'micromamba-env') return 'micromamba'
  if (source === 'phi-micromamba-env') return 'phi'
  return 'common'
}

function toolNames(tool: 'nextflow' | 'docker' | 'singularity'): string[] {
  return tool === 'singularity' ? ['singularity', 'apptainer'] : [tool]
}

function promptCandidates(
  candidates: readonly HostMissingToolCandidate[]
): WrapperMissingToolCandidate[] {
  const unique = new Map<string, WrapperMissingToolCandidate>()
  for (const candidate of candidates) {
    if (!unique.has(candidate.path)) {
      unique.set(candidate.path, {
        path: candidate.path,
        source: candidateSource(candidate.source)
      })
    }
  }
  return [...unique.values()]
}

async function withRemoteExecution<T>(
  resolved: ResolvedRemoteTarget,
  operation: (execution: ReturnType<typeof remoteSessionMissingToolExecution>) => Promise<T>
): Promise<T> {
  const connect = resolved.target.connectImpl ?? connectRemoteSshSession
  const session = await connect({ ...resolved.target.connection, execTimeoutMs: 15_000 })
  try {
    return await operation(remoteSessionMissingToolExecution(session))
  } finally {
    await session.close().catch(() => undefined)
  }
}

// This is a dependency-closing composition module; behavior lives in the tested discovery,
// prompt, environment, and recovery modules it wires together.
// eslint-disable-next-line max-lines-per-function
export function createMissingToolRuntime(deps: MissingToolRuntimeDependencies): MissingToolRuntime {
  async function confirmManagedToolBuild(request: ConfirmBuildRequest): Promise<boolean> {
    const definition =
      request.ref === 'phi:nextflow@1'
        ? {
            id: 'nextflow' as const,
            label: 'Nextflow',
            environment: 'phi-nextflow',
            packages: ['nextflow', 'openjdk>=17'],
            versionArgs: ['-version']
          }
        : request.ref === 'phi:jupyter@1'
          ? {
              id: 'jupyter' as const,
              label: 'Jupyter',
              environment: 'phi-jupyter',
              packages: ['jupyter-server', 'ipykernel'],
              versionArgs: ['server', '--version']
            }
          : undefined
    if (!definition) return deps.confirmEnvironmentBuild(request)
    const run = deps.findActivePromptRun(request.runtimeSessionId)
    if (!run) return false
    const host = new LocalHost(run.cwd)
    const discovered = await discoverMissingToolCandidates({
      tool: definition.id,
      cwd: run.cwd,
      execution: host.exec,
      savedPath: getCustomToolPath(definition.id, deps.agentDir),
      phiRuntimeRoots: [getRuntimeRoot()]
    })
    const remaining = request.estimate.remainingBytes
    const choice = await deps.prompt({
      runtimeSessionId: request.runtimeSessionId,
      tool: { id: definition.id, label: definition.label },
      candidates: promptCandidates(discovered),
      install: {
        environment: definition.environment,
        location: join(getRuntimeRoot(), 'envs'),
        packages: definition.packages,
        approximateSize:
          remaining === undefined
            ? 'download size unknown'
            : `about ${formatDownloadBytes(remaining)}`
      }
    })
    if (choice.action === 'install') return true
    if (choice.action !== 'path') return false
    const selected = await resolveMissingToolPath({
      enteredPath: choice.path,
      tool: definition.id,
      cwd: run.cwd,
      execution: host.exec,
      timeoutMs: 10_000
    })
    if (!selected.ok) {
      throw new Error(`${definition.label} path is invalid: ${selected.reason}`)
    }
    const version = await host.exec.run(
      definition.id === 'nextflow'
        ? [
            'sh',
            '-c',
            'PATH="$(dirname "$1"):$PATH" NXF_DISABLE_CHECK_LATEST=true NXF_ANSI_LOG=false "$1" -version',
            'phi-local-nextflow-version',
            selected.path
          ]
        : [selected.path, ...definition.versionArgs],
      { cwd: run.cwd, timeoutMs: 15_000, maxOutputBytes: 16 * 1024 }
    )
    if (version.code !== 0 || version.terminationReason) {
      throw new Error(
        `${definition.label} path is invalid: the executable did not report a version`
      )
    }
    setEnvironmentToolPath(definition.id, selected.path, deps.agentDir)
    return false
  }

  // The explicit branches mirror the user-visible path/install/cancel state machine.
  // eslint-disable-next-line complexity
  async function checkLocalWrapperEnvironment(input: {
    profile: WrapperExecutionProfile
    runtimeSessionId?: string
  }): Promise<void | { blocked: string }> {
    if (input.profile === 'conda') return undefined
    const tool = input.profile === 'docker' ? ('docker' as const) : ('singularity' as const)
    const label = tool === 'docker' ? 'Docker' : 'Singularity / Apptainer'
    const run = input.runtimeSessionId
      ? deps.findActivePromptRun(input.runtimeSessionId)
      : undefined
    const cwd = run?.cwd ?? process.cwd()
    const host = new LocalHost(cwd)
    const names = toolNames(tool)
    const groups = await Promise.all(
      names.map((name) =>
        discoverMissingToolCandidates({
          tool: name,
          cwd,
          execution: host.exec,
          savedPath: getCustomToolPath(tool, deps.agentDir),
          phiRuntimeRoots: [getRuntimeRoot()]
        })
      )
    )
    const discovered = groups.flat()
    if (discovered.some((candidate) => ['saved', 'login-path'].includes(candidate.source))) {
      return undefined
    }
    if (!input.runtimeSessionId) {
      return { blocked: `${label} is missing and no active chat can request a path.` }
    }
    const choice = await deps.prompt({
      runtimeSessionId: input.runtimeSessionId,
      tool: { id: tool, label },
      candidates: promptCandidates(discovered)
    })
    if (choice.action !== 'path') {
      return { blocked: `${label} is missing and the user declined to choose it.` }
    }
    let selected: Awaited<ReturnType<typeof resolveMissingToolPath>> | undefined
    for (const name of names) {
      selected = await resolveMissingToolPath({
        enteredPath: choice.path,
        tool: name,
        cwd,
        execution: host.exec,
        timeoutMs: 10_000
      })
      if (selected.ok) break
    }
    if (!selected?.ok) {
      return {
        blocked: `${label} path is invalid: ${selected?.reason ?? 'path could not be checked'}`
      }
    }
    const version = await host.exec.run([selected.path, '--version'], {
      cwd,
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024
    })
    if (version.code !== 0 || version.terminationReason) {
      return { blocked: `${label} path is invalid: the executable did not report a version.` }
    }
    setEnvironmentToolPath(tool, selected.path, deps.agentDir)
    return undefined
  }

  // Keep the remote session lifetime around discovery, validation, persistence, and cleanup.
  // eslint-disable-next-line max-lines-per-function
  const resolveMissingJupyter: ResolveMissingRemoteJupyter = async ({
    runtimeSessionId,
    signal
  }) => {
    const run = deps.findActivePromptRun(runtimeSessionId)
    const project = run?.projectId ? deps.getProject(run.projectId) : undefined
    if (!run || !project || project.location.kind !== 'ssh') return { choice: 'cancel' }
    signal?.throwIfAborted()
    const session = await deps.connectRemoteWorkspaceHost({
      sessionId: run.phiSessionId,
      projectId: project.id,
      execTimeoutMs: 15_000
    })
    try {
      const execution = remoteSessionMissingToolExecution(session)
      const saved = readHostRemoteEnvironmentPaths(
        project.location.hostProfileId,
        deps.agentDir
      ).jupyter
      const root = deps.projectRemoteRuntimeRoot(project).configured
      const candidates = await discoverMissingToolCandidates({
        tool: 'jupyter',
        cwd: project.location.canonicalRoot,
        execution,
        savedPath: saved,
        ...(root.startsWith('/') ? { phiRuntimeRoots: [root] } : {})
      })
      const choice = await deps.prompt({
        runtimeSessionId,
        tool: { id: 'jupyter', label: 'Jupyter' },
        candidates: promptCandidates(candidates),
        install: {
          environment: 'phi-jupyter',
          location: `${root}/envs`,
          packages: ['jupyter-server', 'ipykernel'],
          approximateSize: 'about 75 MiB download'
        }
      })
      if (choice.action === 'cancel') return { choice: 'cancel' }
      if (choice.action === 'install') return { choice: 'install' }
      const selected = await resolveMissingToolPath({
        enteredPath: choice.path,
        tool: 'jupyter',
        cwd: project.location.canonicalRoot,
        execution,
        timeoutMs: 10_000
      })
      if (!selected.ok) return { choice: 'path', path: choice.path }
      const compatible = await execution.run(
        [
          'sh',
          '-c',
          [
            'jupyter=$1',
            '"$jupyter" server --version >/dev/null 2>&1 || exit 1',
            'dir=$(dirname "$jupyter")',
            'python="$dir/python"',
            '[ -x "$python" ] || python="$dir/python3"',
            '[ -x "$python" ] || exit 1',
            '"$python" -c "import ipykernel" >/dev/null 2>&1'
          ].join('\n'),
          'phi-jupyter-version',
          selected.path
        ],
        {
          cwd: project.location.canonicalRoot,
          timeoutMs: 15_000,
          maxOutputBytes: 16 * 1024,
          ...(signal ? { signal } : {})
        }
      )
      if (compatible.code !== 0 || compatible.terminationReason) {
        return { choice: 'path', path: selected.path }
      }
      const paths = readHostRemoteEnvironmentPaths(project.location.hostProfileId, deps.agentDir)
      const runtimeRootSetting = readHostRuntimeRoot(project.location.hostProfileId, deps.agentDir)
      saveRemoteEnvironmentSetting(
        project.location.hostProfileId,
        {
          ...(runtimeRootSetting ? { runtimeRoot: runtimeRootSetting } : {}),
          toolPaths: { ...paths, jupyter: selected.path }
        },
        deps.agentDir
      )
      return { choice: 'path', path: selected.path }
    } finally {
      await session.close().catch(() => undefined)
    }
  }

  // The recovery transaction deliberately keeps doctor → prompt → save → doctor in one scope.
  // eslint-disable-next-line max-lines-per-function
  async function checkRemoteWrapperEnvironment(input: {
    project: Project
    resolved: ResolvedRemoteTarget
    profile: WrapperExecutionProfile
    runtimeSessionId?: string
  }): Promise<WrapperTargetDoctorSnapshot | { blocked: string }> {
    const remoteConnection = input.project.remoteConnections?.find(
      (connection) => connection.id === input.resolved.connectionId
    )
    const hostProfileId =
      input.project.location.kind === 'ssh'
        ? input.project.location.hostProfileId
        : remoteConnection?.hostProfileId
    if (!hostProfileId) throw new Error('找不到 Wrapper 运行连接的服务器档案')
    const runtimeRootOverride = remoteConnection?.runtimeRoot
      ? { source: 'project' as const, configured: remoteConnection.runtimeRoot }
      : undefined
    const runDoctor = async (): Promise<Awaited<ReturnType<typeof remoteDoctor>>> => {
      const hpc = input.resolved.target.hpc ?? { scheduler: 'local' as const }
      return remoteDoctor(
        hostProfileId,
        input.resolved.target.workspaceRoot,
        {
          scope: 'full',
          scheduler: hpc.scheduler,
          controller: hpc.controller ?? 'login',
          runtime: input.profile,
          ...(runtimeRootOverride ? { runtimeRootOverride } : {}),
          ...(hpc.nextflowBin ? { nextflowBin: hpc.nextflowBin } : {}),
          ...(hpc.containerRuntimeBin ? { containerRuntimeBin: hpc.containerRuntimeBin } : {})
        },
        { deferToolChecksToLaunch: Boolean(hpc.setupCommands?.length) }
      )
    }
    let report = await runDoctor()
    if (input.runtimeSessionId) {
      const runtimeRoot = report.runtimeRootCheck?.expandedPath
      const recovery = await recoverRemoteWrapperTools(
        {
          runtimeSessionId: input.runtimeSessionId,
          hostProfileId,
          profile: input.profile as RemoteContainerRuntime,
          report,
          installLocation: runtimeRoot ? `${runtimeRoot}/envs` : '~/.phi/runtime/envs'
        },
        {
          search: async (tool) => {
            const saved = readHostRemoteEnvironmentPaths(hostProfileId, deps.agentDir)
            const groups = await withRemoteExecution(input.resolved, (execution) =>
              Promise.all(
                toolNames(tool).map((name) =>
                  discoverMissingToolCandidates({
                    tool: name,
                    cwd: input.resolved.target.workspaceRoot,
                    execution,
                    savedPath: saved[tool],
                    ...(runtimeRoot ? { phiRuntimeRoots: [runtimeRoot] } : {})
                  })
                )
              )
            )
            return promptCandidates(groups.flat())
          },
          prompt: deps.prompt,
          validate: async (tool, enteredPath) =>
            withRemoteExecution(input.resolved, async (execution) => {
              let selected: Awaited<ReturnType<typeof resolveMissingToolPath>> | undefined
              for (const name of toolNames(tool)) {
                selected = await resolveMissingToolPath({
                  enteredPath,
                  tool: name,
                  cwd: input.resolved.target.workspaceRoot,
                  execution,
                  timeoutMs: 10_000
                })
                if (selected.ok) break
              }
              if (!selected?.ok) {
                return { ok: false as const, error: selected?.reason ?? 'host-check-failed' }
              }
              const version = await execution.run(
                tool === 'nextflow'
                  ? [
                      'sh',
                      '-c',
                      // The env's own bin goes first, as at launch, so its Java 17+ is used.
                      'PATH="$(dirname "$1"):$PATH" NXF_DISABLE_CHECK_LATEST=true NXF_ANSI_LOG=false "$1" -version',
                      'phi-nextflow-version',
                      selected.path
                    ]
                  : [selected.path, '--version'],
                {
                  cwd: input.resolved.target.workspaceRoot,
                  timeoutMs: 15_000,
                  maxOutputBytes: 16 * 1024
                }
              )
              if (version.code !== 0 || version.terminationReason) {
                return { ok: false as const, error: 'no-version' as const }
              }
              if (tool === 'nextflow') {
                const javaPath = join(dirname(selected.path), 'java')
                const java = await execution.run([javaPath, '-version'], {
                  cwd: input.resolved.target.workspaceRoot,
                  timeoutMs: 10_000,
                  maxOutputBytes: 16 * 1024
                })
                const major = `${java.stdout}\n${java.stderr}`.match(
                  /(?:openjdk|java) version\s+"?(?:1\.)?(\d+)/i
                )?.[1]
                if (java.code !== 0 || !major || Number(major) < 17) {
                  return { ok: false as const, error: 'java-too-old' as const }
                }
              }
              return { ok: true as const, path: selected.path }
            }),
          save: async (tool, path) => {
            const paths = readHostRemoteEnvironmentPaths(hostProfileId, deps.agentDir)
            const runtimeRootSetting = readHostRuntimeRoot(hostProfileId, deps.agentDir)
            saveRemoteEnvironmentSetting(
              hostProfileId,
              {
                ...(runtimeRootSetting ? { runtimeRoot: runtimeRootSetting } : {}),
                toolPaths: { ...paths, [tool]: path }
              },
              deps.agentDir
            )
            const hpc = input.resolved.target.hpc ?? { scheduler: 'local' as const }
            input.resolved.target.hpc = {
              ...hpc,
              ...(tool === 'nextflow' ? { nextflowBin: path } : { containerRuntimeBin: path })
            }
          },
          installNextflow: async () => {
            if (!runtimeRoot) {
              throw new Error('The remote Phi runtime root could not be resolved for installation.')
            }
            const installed = await installRemoteNextflow(hostProfileId, {
              agentDir: deps.agentDir,
              ...(input.resolved.target.connectImpl
                ? { connectImpl: input.resolved.target.connectImpl }
                : {}),
              resolveRuntimeRoot: async () => runtimeRoot
            })
            return installed.path
          },
          rerun: runDoctor
        }
      )
      if (recovery.status === 'blocked') return { blocked: recovery.error }
      report = recovery.report
    }
    const hpc = input.resolved.target.hpc ?? { scheduler: 'local' as const }
    return {
      report,
      remotePath: input.resolved.target.workspaceRoot,
      scheduler: hpc.scheduler,
      controller: hpc.controller ?? 'login',
      runtime: input.profile,
      deferToolChecksToLaunch: Boolean(hpc.setupCommands?.length)
    }
  }

  return {
    confirmManagedToolBuild,
    containerRuntimePath: (profile) =>
      profile === 'docker' || profile === 'singularity'
        ? getCustomToolPath(profile, deps.agentDir)
        : undefined,
    checkLocalWrapperEnvironment,
    checkRemoteWrapperEnvironment,
    resolveMissingJupyter
  }
}
