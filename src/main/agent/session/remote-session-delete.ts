import { posix } from 'node:path'

import { facadeBindingHash } from '../engine/rpc/facade-session-driver'
import { deriveRemoteSessionPaths } from '../engine/rpc/session-storage/paths'
import {
  STORAGE_REMOTE_FUNCTIONS,
  storagePrefix
} from '../engine/rpc/session-storage/remote-preflight'
import type { RemoteSessionScope } from '../engine/rpc/session-storage/types'
import { privateRemotePrefix } from '../engine/rpc/extension-deployment/remote-commands'
import { getProject } from '../projects'
import {
  resolveRemoteWorkspaceHostBinding,
  type RemoteWorkspaceHostBinding
} from '../remote-workspace-boundary'
import { remoteWorkspaceHosts } from '../workspace-host/remote-registry'
import { shellQuote as q, type RemoteSshSession } from '../wrappers/remote-ssh-session'
import {
  assertRuntimeReferenceProject,
  assertRuntimeScope,
  parseRuntimeReference,
  RuntimeReferenceError,
  type RemoteOmpRuntimeRef
} from './runtime-reference'
import { deletePhiSession, findPhiSessionById } from './session-store'

const DELETED = 'PHI_STORAGE_SESSION_DELETED\n'
const ABSENT = 'PHI_STORAGE_SESSION_ABSENT\n'
const VERIFIED = 'PHI_STORAGE_SESSION_VERIFIED\n'

export class RemoteSessionDeleteUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('无法确认服务器会话状态；本地记录已保留，请连接后核对并重试', { cause })
    this.name = 'RemoteSessionDeleteUnavailableError'
  }
}

/** All paths and expected bytes come from a validated durable reference, never renderer input. */
export function buildRemoteSessionDeleteCommand(
  scope: RemoteSessionScope,
  reference: RemoteOmpRuntimeRef,
  mode: 'verify' | 'delete' = 'delete'
): string {
  const paths = deriveRemoteSessionPaths(scope)
  const journal = posix.join(paths.journals, reference.journalBasename)
  const manifest = `${JSON.stringify({
    ...scope,
    kind: reference.kind,
    version: reference.version,
    durableSessionKey: reference.durableSessionKey,
    ompVersion: reference.ompVersion,
    ompSessionId: reference.ompSessionId,
    journalBasename: reference.journalBasename,
    schemaVersion: 1
  })}\n`
  const checkHeader = `use strict; use warnings; use JSON::PP; use Encode qw(decode FB_CROAK); open my $fh, '<:raw', $ARGV[0] or exit 1; read($fh, my $data, 16385) or exit 1; my @lines = split /\\n/, $data, 3; my $header = eval { decode_json($lines[0]) }; $header = eval { decode_json($lines[1]) } if ref($header) eq 'HASH' && ($header->{type} // '') eq 'title'; my $cwd = eval { decode('UTF-8', $ARGV[2], FB_CROAK) }; exit 1 unless ref($header) eq 'HASH' && defined($cwd) && ($header->{type} // '') eq 'session' && ($header->{version} // 0) == 3 && ($header->{id} // '') eq $ARGV[1] && ($header->{cwd} // '') eq $cwd;`

  const locks =
    mode === 'delete'
      ? `storage_file ${q(paths.lock)}
storage_file ${q(paths.runLock)}
command -v flock >/dev/null 2>&1 || storage_fail PERSISTENCE_FAILED
exec 9<>${q(paths.lock)}
flock -x -n 9 || storage_fail SESSION_BUSY
exec 8<>${q(paths.runLock)}
flock -x -n 8 || storage_fail SESSION_BUSY`
      : ''
  const finish =
    mode === 'delete'
      ? `rm -rf -- ${q(paths.directory)} || storage_fail PERSISTENCE_FAILED
[ ! -e ${q(paths.directory)} ] && [ ! -L ${q(paths.directory)} ] || storage_fail PERSISTENCE_FAILED
printf '${DELETED.trim()}\\n'`
      : `printf '${VERIFIED.trim()}\\n'`

  return `cd -- ${q(scope.runtimeRoot)} || exit 1
${privateRemotePrefix(scope.runtimeRoot)}
${STORAGE_REMOTE_FUNCTIONS}
[ -d ${q(scope.projectRoot)} ] && [ "$(cd -- ${q(scope.projectRoot)} && pwd -P)" = ${q(scope.projectRoot)} ] || storage_fail IDENTITY_MISMATCH
storage_dir ${q(posix.join(scope.runtimeRoot, 'omp-sessions'))} existing
storage_dir ${q(posix.dirname(paths.directory))} existing
if [ ! -e ${q(paths.directory)} ] && [ ! -L ${q(paths.directory)} ]; then
  printf '${ABSENT.trim()}\\n'
  exit 0
fi
${storagePrefix(scope, paths)}
${locks}
storage_file ${q(paths.manifest)}
printf '%s' ${q(manifest)} | cmp -s - ${q(paths.manifest)} || storage_fail IDENTITY_MISMATCH
storage_file ${q(journal)}
perl -MJSON::PP -e ${q(checkHeader)} -- ${q(journal)} ${q(reference.ompSessionId)} ${q(scope.projectRoot)} || storage_fail FILE_INVALID
storage_file ${q(paths.manifest)}
printf '%s' ${q(manifest)} | cmp -s - ${q(paths.manifest)} || storage_fail IDENTITY_MISMATCH
${finish}`
}

type ConnectRemoteSession = (request: {
  sessionId: string
  projectId: string
}) => Promise<Pick<RemoteSshSession, 'exec' | 'execBounded' | 'close'>>

export interface RemoteDeletionDependencies {
  connect?: ConnectRemoteSession
  getProject?: typeof getProject
  resolveBinding?: (request: { sessionId: string; projectId: string }) => RemoteWorkspaceHostBinding
  releaseSession?: (sessionId: string) => Promise<void>
}

function assertRemoteResponse(
  result: Awaited<ReturnType<RemoteSshSession['exec']>>,
  mode: 'verify' | 'delete'
): void {
  const expected = mode === 'verify' ? VERIFIED : DELETED
  const truncated =
    ('stdoutTruncated' in result && result.stdoutTruncated) ||
    ('stderrTruncated' in result && result.stderrTruncated)
  if (
    result.code === 0 &&
    !result.signal &&
    !truncated &&
    [expected, ABSENT].includes(result.stdout)
  )
    return
  const code = result.stderr.match(/PHI_STORAGE:([A-Z_]+)/)?.[1]
  if (code === 'SESSION_BUSY') throw new Error('远程会话仍在运行，请等待结束后重试删除')
  if (code === 'IDENTITY_MISMATCH' || code === 'FILE_INVALID' || code === 'PATH_INVALID') {
    throw new RuntimeReferenceError(
      'INVALID_RUNTIME_REFERENCE',
      '服务器会话身份或文件校验失败，已停止删除'
    )
  }
  throw new RemoteSessionDeleteUnavailableError()
}

async function runCommand(
  remote: Pick<RemoteSshSession, 'exec' | 'execBounded'>,
  command: string,
  mode: 'verify' | 'delete'
): Promise<void> {
  let result: Awaited<ReturnType<RemoteSshSession['exec']>>
  try {
    result = remote.execBounded
      ? await remote.execBounded(command, { timeoutMs: 30_000, maxOutputBytes: 4096 })
      : await remote.exec(command)
  } catch (cause) {
    throw new RemoteSessionDeleteUnavailableError(cause)
  }
  assertRemoteResponse(result, mode)
}

export interface PreparedRemotePhiDeletion {
  delete(): Promise<void>
  close(): Promise<void>
}

/** Read-only server verification runs before the caller stops or switches the conversation. */
export async function prepareRemotePhiDeletion(
  sessionId: string,
  dependencies: RemoteDeletionDependencies = {}
): Promise<PreparedRemotePhiDeletion> {
  const manifest = findPhiSessionById(sessionId)
  if (!manifest?.runtimeRef || manifest.runtimeRecoveryError || !manifest.projectId) {
    throw new RuntimeReferenceError(
      'REMOTE_OPERATION_REQUIRED',
      '远程会话身份尚未验证，不能删除服务器历史'
    )
  }
  const reference = parseRuntimeReference(manifest.runtimeRef, sessionId)
  const project = (dependencies.getProject ?? getProject)(manifest.projectId)
  const binding = (dependencies.resolveBinding ?? resolveRemoteWorkspaceHostBinding)({
    sessionId,
    projectId: manifest.projectId
  })
  if (!project || project.location.kind !== 'ssh') {
    throw new RuntimeReferenceError('PROJECT_MISMATCH', '远程项目绑定已改变，不能删除服务器历史')
  }
  const scope: RemoteSessionScope = {
    hostProfileId: project.location.hostProfileId,
    bindingHash: facadeBindingHash(binding),
    projectId: project.id,
    projectRoot: binding.canonicalRoot,
    runtimeRoot: reference.runtimeRoot,
    phiSessionId: sessionId
  }
  assertRuntimeReferenceProject(manifest, scope)
  assertRuntimeScope(reference, scope)
  let remote: Pick<RemoteSshSession, 'exec' | 'execBounded' | 'close'>
  try {
    remote = await (dependencies.connect ?? ((request) => remoteWorkspaceHosts.connect(request)))({
      sessionId,
      projectId: project.id
    })
  } catch (cause) {
    throw new RemoteSessionDeleteUnavailableError(cause)
  }
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await remote.close()
  }
  try {
    await runCommand(remote, buildRemoteSessionDeleteCommand(scope, reference, 'verify'), 'verify')
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
  return {
    async delete() {
      const latest = findPhiSessionById(sessionId)
      const currentProject = (dependencies.getProject ?? getProject)(project.id)
      const currentBinding = (dependencies.resolveBinding ?? resolveRemoteWorkspaceHostBinding)({
        sessionId,
        projectId: project.id
      })
      if (
        !latest?.runtimeRef ||
        JSON.stringify(latest.runtimeRef) !== JSON.stringify(manifest.runtimeRef) ||
        JSON.stringify(currentProject?.location) !== JSON.stringify(project.location) ||
        facadeBindingHash(currentBinding) !== scope.bindingHash
      ) {
        throw new RuntimeReferenceError('STALE_GENERATION', '会话身份在删除期间改变，请刷新后重试')
      }
      await runCommand(remote, buildRemoteSessionDeleteCommand(scope, reference), 'delete')
      deletePhiSession(sessionId)
      await (dependencies.releaseSession ?? ((id) => remoteWorkspaceHosts.releaseSession(id)))(
        sessionId
      ).catch(() => undefined)
    },
    close
  }
}
