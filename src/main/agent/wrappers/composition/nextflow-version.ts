import { execFile } from 'node:child_process'
import { dirname } from 'node:path'

/**
 * The oldest Nextflow the bundled wrappers run on. Nearly every vendored nf-core
 * module declares `topic: versions` outputs, which only work without a preview
 * flag from 25.04 on; older releases fail at parse time with the unhelpful
 * "No such variable: versions" (seen on a cluster whose default was 22.10.6).
 */
export const MIN_NEXTFLOW_VERSION = '25.04.0'

/** The version from `nextflow -version` output ("version 25.04.6 build 5954"), if present. */
export function parseNextflowVersion(output: string): string | undefined {
  return /version\s+(\d+\.\d+\.\d+)/.exec(output)?.[1]
}

function parts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

export function isNextflowVersionSupported(version: string): boolean {
  const have = parts(version)
  const need = parts(MIN_NEXTFLOW_VERSION)
  for (let i = 0; i < need.length; i++) {
    if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) > need[i]
  }
  return true
}

export function nextflowTooOldMessage(version: string, where: string): string {
  return (
    `${where}的 Nextflow 版本是 ${version}，Wrapper 需要 ${MIN_NEXTFLOW_VERSION} 或更新的版本` +
    '（旧版本会报 "No such variable: versions"）。请安装新版 Nextflow，并在连接设置里填写它的路径，' +
    '或在启动前执行的命令里加载新版本。'
  )
}

const LOCAL_VERSION_TIMEOUT_MS = 120_000
const localVersions = new Map<string, Promise<string | undefined>>()

/**
 * The version of a local Nextflow launcher, asked once per path and cached.
 * Resolves `undefined` when it cannot be read (a failed or odd `-version`),
 * which callers treat as "let the run report the real problem".
 */
export function readLocalNextflowVersion(nextflowBin: string): Promise<string | undefined> {
  const cached = localVersions.get(nextflowBin)
  if (cached) return cached
  const pending = new Promise<string | undefined>((resolve) => {
    execFile(
      nextflowBin,
      ['-version'],
      {
        timeout: LOCAL_VERSION_TIMEOUT_MS,
        env: {
          ...process.env,
          PATH: `${dirname(nextflowBin)}:${process.env.PATH ?? ''}`,
          NXF_DISABLE_CHECK_LATEST: 'true',
          NXF_ANSI_LOG: 'false'
        }
      },
      (_error, stdout, stderr) => resolve(parseNextflowVersion(`${stdout}\n${stderr}`))
    )
  })
  localVersions.set(nextflowBin, pending)
  return pending
}
