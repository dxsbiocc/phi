import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { messageContentTitleText } from '../../../shared/sessionTitle'
import { getProject } from '../projects'
import { isRemoteProjectAnchorPath } from '../remote-project-anchor'
import { resolveRemoteWorkspaceHostBinding } from '../remote-workspace-boundary'
import { findPhiSessionById, type PhiSessionManifest } from '../session/session-store'
import { phiOnlySessionPath } from '../session/sessions'
import { createLocalExecution } from '../workspace-host/local-exec'
import { CHAT_SHELL_MAX_OUTPUT_BYTES, type ChatShellOrigin } from './chat-shell-jobs'

const BASH = ['/bin/bash', '--noprofile', '--norc', '-c'] as const
const SHELL_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME'] as const

function shellEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: '/usr/local/bin:/usr/bin:/bin' }
  for (const key of SHELL_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

function isRemoteOrigin(session: PhiSessionManifest): boolean {
  return Boolean(
    session.projectLocation?.kind === 'ssh' ||
    session.remoteRuntime ||
    session.runtimeRef ||
    session.kernelRuntimeRef?.host.kind === 'ssh' ||
    isRemoteProjectAnchorPath(session.cwd)
  )
}

function shellTarget(session: PhiSessionManifest): ChatShellOrigin['run'] {
  const { sessionId } = session
  const project = session.projectId ? getProject(session.projectId) : undefined
  if (isRemoteOrigin(session) || project?.location.kind === 'ssh') {
    if (!session.projectId) throw new Error('The SSH project is unavailable')
    const identity = { sessionId, projectId: session.projectId }
    const binding = resolveRemoteWorkspaceHostBinding(identity)
    return async (command, signal) => {
      const { remoteWorkspaceHosts } = await import('../workspace-host/remote-registry')
      return remoteWorkspaceHosts.runSessionCommand(
        identity,
        binding.cacheKey,
        [...BASH, command],
        {
          maxOutputBytes: CHAT_SHELL_MAX_OUTPUT_BYTES,
          // The job's AbortSignal enforces its own deadline across connection and execution.
          timeoutMs: 24 * 60 * 60 * 1000,
          signal
        }
      )
    }
  }

  if (process.platform === 'win32') {
    throw new Error('Background Bash is unavailable in local Windows conversations')
  }
  if (!isAbsolute(session.cwd)) throw new Error('The conversation directory is invalid')
  const cwd = realpathSync(session.cwd)
  const checkLocalOrigin = (): void => {
    const current = findPhiSessionById(sessionId)
    const currentProject = session.projectId ? getProject(session.projectId) : undefined
    if (
      !current ||
      current.cwd !== session.cwd ||
      current.projectId !== session.projectId ||
      isRemoteOrigin(current) ||
      isRemoteProjectAnchorPath(cwd) ||
      realpathSync(current.cwd) !== cwd
    ) {
      throw new Error('The conversation directory changed')
    }
    if (
      session.projectId &&
      (currentProject?.location.kind !== 'local' ||
        currentProject.location.realPath !== cwd ||
        current.cwdRealPath !== cwd)
    )
      throw new Error('The local project directory changed')
  }
  checkLocalOrigin()
  const execution = createLocalExecution(cwd, shellEnvironment())
  return (command, signal) =>
    execution.run([...BASH, command], {
      cwd,
      beforeExec: checkLocalOrigin,
      maxOutputBytes: CHAT_SHELL_MAX_OUTPUT_BYTES,
      signal
    })
}

export function resolveChatShellOrigin(sessionId: string): ChatShellOrigin {
  const session = findPhiSessionById(sessionId)
  if (!session) throw new Error('The conversation is unavailable')
  return {
    sessionPath: phiOnlySessionPath(sessionId),
    sessionTitle: messageContentTitleText(session.title) || 'Chat',
    run: shellTarget(session)
  }
}
