import { posix } from 'node:path'

import { isRemotePathInside } from '../remote-path-containment'

export interface RemoteOutputRoot {
  path: string
  external: boolean
}

/** Resolve the output directory once, before a remote run is submitted. */
export function resolveRemoteOutputRoot(
  runDir: string,
  workspaceRoot: string,
  value: unknown,
  allowExternal: boolean
): RemoteOutputRoot {
  if (!posix.isAbsolute(runDir) || !posix.isAbsolute(workspaceRoot)) {
    throw new Error('远端运行目录必须是绝对路径')
  }
  const outdir = typeof value === 'string' && value !== '' ? value : 'output'
  if (
    Buffer.byteLength(outdir, 'utf8') > 4096 ||
    outdir.includes('\0') ||
    outdir.includes('\uFFFD') ||
    [...outdir].some((character) => character.charCodeAt(0) < 32) ||
    outdir.split('/').includes('..') ||
    outdir.startsWith('~/') ||
    /^ssh:\/\//i.test(outdir)
  ) {
    throw new Error('远端输出目录无效或包含父目录跳转')
  }
  const path = posix.resolve(runDir, outdir)
  if (path === '/') throw new Error('不能将服务器根目录作为 Wrapper 输出目录')
  if (Buffer.byteLength(path, 'utf8') > 4096) throw new Error('远端输出目录过长')
  const external = !isRemotePathInside(posix.normalize(workspaceRoot), path)
  if (external && !allowExternal) {
    throw new Error(`输出目录 ${path} 在远程项目根目录外；组合式运行暂不支持外部输出授权`)
  }
  return { path, external }
}
