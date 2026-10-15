import type { Stats } from 'node:fs'
import { link, lstat, mkdir, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

import type {
  WorkspaceFileOperationTarget,
  WorkspaceFileRenameRequest
} from '../shared/workspaceFileOperations'
import { remoteWorkspaceUri } from '../shared/remoteWorkspacePath'
import {
  resolveRemoteWorkspaceHostBinding,
  withAuthorizedRemoteWorkspacePath,
  type RemoteWorkspaceBoundaryDependencies
} from './agent/remote-workspace-boundary'
import { shellQuote } from './agent/wrappers/remote-ssh-session'
import { getPhiAgentDir } from './agent/runtime-paths'

export function validateWorkspaceFileOperation(
  input: unknown,
  renaming = false
): WorkspaceFileOperationTarget | WorkspaceFileRenameRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('文件操作请求无效')
  }
  const value = input as Record<string, unknown>
  const allowed = [
    'kind',
    'path',
    ...(value.kind === 'local' ? ['rootPath'] : ['sessionId', 'projectId']),
    ...(renaming ? ['newName'] : [])
  ]
  if (
    !['local', 'remote'].includes(value.kind as string) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    typeof value.path !== 'string' ||
    !value.path ||
    value.path.includes('\0') ||
    value.path.includes('\uFFFD') ||
    value.path.split(/[\\/]/).includes('..') ||
    !(value.kind === 'local' ? isAbsolute(value.path) : posix.isAbsolute(value.path)) ||
    (value.kind === 'local'
      ? typeof value.rootPath !== 'string' || !isAbsolute(value.rootPath)
      : typeof value.sessionId !== 'string' ||
        !value.sessionId ||
        typeof value.projectId !== 'string' ||
        !value.projectId)
  ) {
    throw new Error('文件操作只能指定当前工作区中的绝对路径')
  }
  if (
    renaming &&
    (typeof value.newName !== 'string' ||
      !value.newName.trim() ||
      value.newName === '.' ||
      value.newName === '..' ||
      value.newName.includes('\uFFFD') ||
      Buffer.from(value.newName, 'utf8').toString('utf8') !== value.newName ||
      /[\\/]/.test(value.newName) ||
      [...value.newName].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      Buffer.byteLength(value.newName, 'utf8') > 255)
  ) {
    throw new Error('文件名称无效；不能包含路径分隔符')
  }
  return value as unknown as WorkspaceFileOperationTarget | WorkspaceFileRenameRequest
}

async function localTarget(
  request: Extract<WorkspaceFileOperationTarget, { kind: 'local' }>,
  agentDir = getPhiAgentDir()
): Promise<{ target: string; info: Stats }> {
  const displayRoot = resolve(request.rootPath)
  const displayPath = resolve(request.path)
  const suffix = relative(displayRoot, displayPath)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('不能修改工作区根目录或目录外的文件')
  }
  const root = await realpath(displayRoot)
  let target = root
  for (const part of suffix.split(sep)) {
    target = join(target, part)
    const info = await lstat(target)
    if (info.isSymbolicLink()) throw new Error('不能修改符号链接或经过符号链接的路径')
  }
  if ((await realpath(target)) !== target) throw new Error('文件路径已变化，请刷新后重试')
  const anchorStorage = join(agentDir, 'remote-project-anchors')
  const anchors = await realpath(anchorStorage).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return resolve(anchorStorage)
    throw error
  })
  const inside = (parent: string, child: string): boolean => {
    const suffix = relative(parent, child)
    return !suffix || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  }
  if (inside(anchors, root) || inside(anchors, target) || inside(target, anchors)) {
    throw new Error('不能修改远程项目的本地锚点或包含锚点的目录')
  }
  const info = await lstat(target)
  if (!info.isFile() && !info.isDirectory()) throw new Error('只能修改普通文件或文件夹')
  return { target, info }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('同名文件或文件夹已存在；不会覆盖')
}

/** A regular file is published with link(2), so concurrent creators cannot be overwritten. */
async function renameLocal(
  request: Extract<WorkspaceFileRenameRequest, { kind: 'local' }>,
  agentDir?: string
): Promise<{ path: string }> {
  const { target, info } = await localTarget(request, agentDir)
  const destination = join(dirname(target), request.newName)
  if (basename(target) === request.newName) return { path: request.path }
  await assertAbsent(destination)
  if (info.isFile()) {
    await link(target, destination)
    try {
      await unlink(target)
    } catch (error) {
      await unlink(destination).catch(() => undefined)
      throw error
    }
  } else {
    // Reserve an empty directory instead of letting rename replace another user's directory.
    await mkdir(destination)
    try {
      await rename(target, destination)
    } catch (error) {
      await rmdir(destination).catch(() => undefined)
      throw error
    }
  }
  return { path: join(dirname(request.path), request.newName) }
}

function remoteOperationCommand(root: string, path: string, newName?: string): string {
  const parent = posix.dirname(path)
  const leaf = posix.basename(path)
  const renameScript = [
    'use strict; use warnings;',
    'my ($source, $destination) = @ARGV;',
    '(-l $source) and exit 82;',
    '(-f $source || -d $source) or exit 83;',
    '(-e $destination || -l $destination) and exit 84;',
    'if (-f $source) {',
    '  link($source, $destination) or exit($!{EEXIST} ? 84 : 85);',
    '  unless (unlink($source)) { unlink($destination); exit 85; }',
    '} else {',
    '  mkdir($destination) or exit($!{EEXIST} ? 84 : 85);',
    '  unless (rename($source, $destination)) { rmdir($destination); exit 85; }',
    '}'
  ].join('\n')
  const script = [
    'set -eu',
    `cd -P -- ${shellQuote(parent)} || exit 81`,
    `[ "$PWD" = ${shellQuote(parent)} ] || exit 81`,
    `root=${shellQuote(root)}`,
    'if [ "$root" != / ]; then case "$PWD" in "$root"|"$root"/*) ;; *) exit 81 ;; esac; fi',
    `leaf=${shellQuote(leaf)}`,
    '[ ! -L "$leaf" ] || exit 82',
    '[ -f "$leaf" ] || [ -d "$leaf" ] || exit 83',
    ...(newName === undefined
      ? ['rm -r -- "$leaf"']
      : [
          'command -v perl >/dev/null 2>&1 || exit 86',
          `perl -e ${shellQuote(renameScript)} -- "$leaf" ${shellQuote(newName)}`
        ])
  ].join('\n')
  return `bash -c ${shellQuote(script)}`
}

async function mutateRemote(
  request: Extract<WorkspaceFileOperationTarget, { kind: 'remote' }>,
  newName: string | undefined,
  dependencies: RemoteWorkspaceBoundaryDependencies
): Promise<{ path: string }> {
  const binding = resolveRemoteWorkspaceHostBinding(
    { sessionId: request.sessionId, projectId: request.projectId },
    dependencies
  )
  return withAuthorizedRemoteWorkspacePath(
    {
      sessionId: request.sessionId,
      projectId: request.projectId,
      path: request.path,
      mode: 'existing'
    },
    async (authorized, session) => {
      if (
        resolveRemoteWorkspaceHostBinding(
          { sessionId: request.sessionId, projectId: request.projectId },
          dependencies
        ).cacheKey !== binding.cacheKey
      ) {
        throw new Error('远程项目连接已变化，请刷新后重试')
      }
      const expected =
        request.path === authorized.remoteRoot ||
        request.path.startsWith(`${authorized.remoteRoot}/`)
          ? posix.join(
              authorized.canonicalRoot,
              posix.relative(authorized.remoteRoot, request.path)
            )
          : posix.normalize(request.path)
      if (authorized.path === authorized.canonicalRoot) throw new Error('不能修改工作区根目录')
      if (expected !== authorized.path) throw new Error('不能修改符号链接或经过符号链接的路径')
      if (newName === posix.basename(authorized.path)) {
        return { path: remoteWorkspaceUri(authorized.hostAlias, authorized.path) }
      }
      const command = remoteOperationCommand(authorized.canonicalRoot, authorized.path, newName)
      const result = session.execBounded
        ? await session.execBounded(command, { timeoutMs: 30_000, maxOutputBytes: 8192 })
        : await session.exec(command)
      if (result.code !== 0) {
        const reasons: Record<number, string> = {
          81: '文件的父目录已变化或不可访问',
          82: '不能修改符号链接',
          83: '文件不存在或不是普通文件、文件夹',
          84: '同名文件或文件夹已存在；不会覆盖',
          85: '服务器无法重命名该文件',
          86: '服务器缺少安全重命名所需的 Perl'
        }
        throw new Error(reasons[result.code ?? -1] ?? '远程文件操作失败')
      }
      return {
        path: remoteWorkspaceUri(
          authorized.hostAlias,
          newName === undefined
            ? authorized.path
            : posix.join(posix.dirname(authorized.path), newName)
        )
      }
    },
    { ...dependencies, userInitiated: true, execTimeoutMs: 30_000 }
  )
}

export async function renameWorkspaceFile(
  input: unknown,
  dependencies: RemoteWorkspaceBoundaryDependencies = {}
): Promise<{ path: string }> {
  const request = validateWorkspaceFileOperation(input, true) as WorkspaceFileRenameRequest
  return request.kind === 'local'
    ? renameLocal(request, dependencies.agentDir)
    : mutateRemote(request, request.newName, dependencies)
}

export async function deleteWorkspaceFile(
  input: unknown,
  dependencies: RemoteWorkspaceBoundaryDependencies & { trashItem: (path: string) => Promise<void> }
): Promise<void> {
  const request = validateWorkspaceFileOperation(input)
  if (request.kind === 'remote') {
    await mutateRemote(request, undefined, dependencies)
  } else {
    const { target } = await localTarget(request, dependencies.agentDir)
    await dependencies.trashItem(target)
  }
}
