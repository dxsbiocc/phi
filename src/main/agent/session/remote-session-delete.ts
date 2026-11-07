import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'

import { remoteWorkspaceBindingHash } from '../remote-workspace-boundary'
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
  assertKernelRuntimeReferenceProject,
  assertRuntimeReferenceProject,
  assertRuntimeScope,
  parseRuntimeReference,
  RuntimeReferenceError,
  type RemoteOmpRuntimeRef
} from './runtime-reference'
import type { KernelRemoteRuntimeRef } from './runtime-reference'
import { deletePhiSession, findPhiSessionById, type PhiSessionManifest } from './session-store'

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
  const tombstonePrefix = `${paths.directory}.deleting-`
  const tombstone = `${tombstonePrefix}${randomUUID()}`
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
      ? `[ ! -e ${q(tombstone)} ] && [ ! -L ${q(tombstone)} ] || storage_fail PERSISTENCE_FAILED
mv -- ${q(paths.directory)} ${q(tombstone)} || storage_fail PERSISTENCE_FAILED
exec 8>&-
exec 9>&-
for attempt in 1 2 3 4 5; do
  rm -rf -- ${q(tombstone)} 2>/dev/null || :
  [ ! -e ${q(tombstone)} ] && [ ! -L ${q(tombstone)} ] && break
  sleep 1
done
[ ! -e ${q(tombstone)} ] && [ ! -L ${q(tombstone)} ] || storage_fail PERSISTENCE_FAILED
[ ! -e ${q(paths.directory)} ] && [ ! -L ${q(paths.directory)} ] || storage_fail PERSISTENCE_FAILED
printf '${DELETED.trim()}\\n'`
      : `printf '${VERIFIED.trim()}\\n'`

  return `cd -- ${q(scope.runtimeRoot)} || exit 1
${privateRemotePrefix(scope.runtimeRoot)}
${STORAGE_REMOTE_FUNCTIONS}
[ -d ${q(scope.projectRoot)} ] && [ "$(cd -- ${q(scope.projectRoot)} && pwd -P)" = ${q(scope.projectRoot)} ] || storage_fail IDENTITY_MISMATCH
storage_dir ${q(posix.join(scope.runtimeRoot, 'omp-sessions'))} existing
storage_dir ${q(posix.dirname(paths.directory))} existing
for stale in ${q(tombstonePrefix)}*; do
  [ ! -e "$stale" ] && [ ! -L "$stale" ] || storage_fail PERSISTENCE_FAILED
done
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

export function buildRemoteKernelSessionDeleteCommand(
  reference: KernelRemoteRuntimeRef,
  mode: 'verify' | 'delete' = 'delete'
): string {
  const root = reference.host.runtimeRoot
  // The kernel keeps sessions under its agent directory, not the runtime root.
  const sessionsRoot = posix.join(reference.host.agentDir, 'phi-kernel', 'sessions')
  const target = posix.join(sessionsRoot, reference.kernelSessionId)
  const tombstone = `${target}.deleting-${randomUUID()}`
  return `cd -- ${q(root)} || exit 1
${privateRemotePrefix(root)}
target=${q(target)}
if [ ! -e "$target" ]; then printf '${ABSENT.trim()}\\n'; exit 0; fi
[ -d "$target" ] && [ ! -L "$target" ] || { printf 'PHI_STORAGE:PATH_INVALID\\n' >&2; exit 1; }
[ "$(cd -- "$target" && pwd -P)" = "$target" ] || { printf 'PHI_STORAGE:PATH_INVALID\\n' >&2; exit 1; }
[ "$(stat -c %u -- "$target")" = "$(id -u)" ] || { printf 'PHI_STORAGE:PERMISSION_DENIED\\n' >&2; exit 1; }
if [ ${q(mode)} = verify ]; then printf '${VERIFIED.trim()}\\n'; exit 0; fi
lock="$target/writer.lock"
if [ -e "$lock" ]; then
  command -v flock >/dev/null 2>&1 || { printf 'PHI_STORAGE:LOCK_UNPROVABLE\\n' >&2; exit 1; }
  ( exec 9<>"$lock"; flock -n 9 ) || { printf 'PHI_STORAGE:LOCK_HELD\\n' >&2; exit 1; }
fi
mv -- "$target" ${q(tombstone)}
rm -rf -- ${q(tombstone)}
printf '${DELETED.trim()}\\n'`
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
  if (code === 'SESSION_BUSY' || code === 'LOCK_HELD')
    throw new Error('远程会话仍在运行，请等待结束后重试删除')
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

async function prepareRemoteKernelPhiDeletion(
  sessionId: string,
  reference: KernelRemoteRuntimeRef,
  dependencies: RemoteDeletionDependencies
): Promise<PreparedRemotePhiDeletion> {
  const manifest = findPhiSessionById(sessionId)
  const project = manifest?.projectId
    ? (dependencies.getProject ?? getProject)(manifest.projectId)
    : undefined
  if (!manifest || !project || project.location.kind !== 'ssh') {
    throw new RuntimeReferenceError('PROJECT_MISMATCH', '远程项目绑定已改变，不能删除服务器历史')
  }
  assertKernelRuntimeReferenceProject(manifest, reference)
  let remote: Pick<RemoteSshSession, 'exec' | 'execBounded' | 'close'>
  try {
    remote = await (
      dependencies.connect ?? ((request) => remoteWorkspaceHosts.connectIsolated(request))
    )({ sessionId, projectId: project.id })
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
    await runCommand(remote, buildRemoteKernelSessionDeleteCommand(reference, 'verify'), 'verify')
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
  return {
    async delete() {
      const latest = findPhiSessionById(sessionId)
      if (
        !latest?.kernelRuntimeRef ||
        JSON.stringify(latest.kernelRuntimeRef) !== JSON.stringify(reference)
      ) {
        throw new RuntimeReferenceError('STALE_GENERATION', '会话身份在删除期间改变，请刷新后重试')
      }
      await runCommand(remote, buildRemoteKernelSessionDeleteCommand(reference), 'delete')
      deletePhiSession(sessionId)
      await (dependencies.releaseSession ?? ((id) => remoteWorkspaceHosts.releaseSession(id)))(
        sessionId
      ).catch(() => undefined)
    },
    close
  }
}

/** Read-only server verification runs before the caller stops or switches the conversation. */
async function prepareRpcRemotePhiDeletion(
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
    bindingHash: remoteWorkspaceBindingHash(binding),
    projectId: project.id,
    projectRoot: binding.canonicalRoot,
    runtimeRoot: reference.runtimeRoot,
    phiSessionId: sessionId
  }
  assertRuntimeReferenceProject(manifest, scope)
  assertRuntimeScope(reference, scope)
  let remote: Pick<RemoteSshSession, 'exec' | 'execBounded' | 'close'>
  try {
    remote = await (
      dependencies.connect ?? ((request) => remoteWorkspaceHosts.connectIsolated(request))
    )({
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
        remoteWorkspaceBindingHash(currentBinding) !== scope.bindingHash
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

/** Read-only server verification runs before the caller stops or switches the conversation. */
/** Whether deleting this session has to go through the server that holds its history. */
export function deletesOnServer(
  manifest: Pick<PhiSessionManifest, 'runtimeRef' | 'kernelRuntimeRef' | 'runtimeRecoveryError'>
): boolean {
  return Boolean(
    manifest.runtimeRef ||
    manifest.runtimeRecoveryError ||
    manifest.kernelRuntimeRef?.host.kind === 'ssh'
  )
}

export async function prepareRemotePhiDeletion(
  sessionId: string,
  dependencies: RemoteDeletionDependencies = {}
): Promise<PreparedRemotePhiDeletion> {
  const kernelReference = findPhiSessionById(sessionId)?.kernelRuntimeRef
  return kernelReference?.host.kind === 'ssh'
    ? prepareRemoteKernelPhiDeletion(
        sessionId,
        kernelReference as KernelRemoteRuntimeRef,
        dependencies
      )
    : prepareRpcRemotePhiDeletion(sessionId, dependencies)
}
