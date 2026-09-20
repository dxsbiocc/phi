import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RemoteSshSession } from '../remote-ssh-session'
import { shellQuote } from '../remote-ssh-session'

/**
 * Ships the wrapper source tree (`resources/wrappers`) to the cluster once per
 * version. Wrappers include sources by relative path — a subworkflow reaches
 * `../../../../modules/...` — so the remote needs the same tree layout, not just
 * one component. The tree is content-addressed: an unchanged tree is uploaded once
 * and shared by every run, and a changed one lands beside the old bundle so runs
 * still using it keep working.
 */

const BUNDLE_ROOTS = ['modules', 'subworkflows', 'workflows']
/** Directories that are test fixtures or leftovers of local runs, never part of a runnable wrapper. */
const SKIPPED_DIRS = new Set(['tests', 'work', 'results', '.git', 'node_modules', '__pycache__'])
const SKIPPED_FILES = new Set(['.DS_Store', 'dag.mmd'])
const COMPLETE_MARKER = '.phi-bundle-complete'

function isSkipped(name: string, isDirectory: boolean, inFixtures: boolean): boolean {
  if (inFixtures) return name === '.DS_Store'
  if (name.startsWith('.nextflow')) return true
  if (isDirectory) return SKIPPED_DIRS.has(name)
  return SKIPPED_FILES.has(name) || name.endsWith('.log')
}

/** A component's default params can point at its own fixtures (`tests/data/...`); those must ship. */
function usesTestFixtures(root: string, componentRel: string): boolean {
  const params = join(root, componentRel, 'wrapper', 'params.json')
  if (!existsSync(params)) return false
  try {
    return readFileSync(params, 'utf-8').includes('"tests/')
  } catch {
    return false
  }
}

/** Every file that belongs in the bundle, as sorted POSIX paths relative to `root`. */
export function collectBundleFiles(root: string): string[] {
  const files: string[] = []
  const walk = (relDir: string, filesOnlyBelowData = false): void => {
    let entries
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true })
    } catch {
      return
    }
    if (!filesOnlyBelowData && usesTestFixtures(root, relDir)) walk(`${relDir}/tests/data`, true)
    for (const entry of entries) {
      if (isSkipped(entry.name, entry.isDirectory(), filesOnlyBelowData)) continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(rel, filesOnlyBelowData)
      else if (entry.isFile()) files.push(rel)
    }
  }
  for (const bundleRoot of BUNDLE_ROOTS) walk(bundleRoot)
  return files.sort()
}

/** 12 hex chars over the file list and contents; timestamps and permissions do not count. */
export function hashBundleFiles(root: string, files: string[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`${file}\0`)
    hash.update(readFileSync(join(root, file)))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

function buildArchive(root: string, files: string[], archivePath: string): Promise<void> {
  const listPath = `${archivePath}.list`
  writeFileSync(listPath, `${files.join('\n')}\n`)
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      ['-czf', archivePath, '-C', root, '-T', listPath],
      // macOS tar otherwise adds ._ AppleDouble files that would land in the bundle.
      { env: { ...process.env, COPYFILE_DISABLE: '1' } },
      (error, _stdout, stderr) => {
        rmSync(listPath, { force: true })
        if (error) reject(new Error(`打包 wrapper 源码失败: ${stderr || error.message}`))
        else resolve()
      }
    )
  })
}

export interface RemoteBundle {
  hash: string
  bundleDir: string
}

export async function ensureRemoteBundle(
  session: RemoteSshSession,
  input: { localRoot: string; workspaceRoot: string }
): Promise<RemoteBundle> {
  const files = collectBundleFiles(input.localRoot)
  if (files.length === 0) throw new Error(`没有可上传的 wrapper 源码: ${input.localRoot}`)
  const hash = hashBundleFiles(input.localRoot, files)
  const bundlesDir = `${input.workspaceRoot.replace(/\/+$/, '')}/wrappers/bundles`
  const bundleDir = `${bundlesDir}/${hash}`
  const bundle = { hash, bundleDir }
  if (await session.exists(`${bundleDir}/${COMPLETE_MARKER}`)) return bundle

  await session.mkdirp(bundlesDir)
  const tmp = mkdtempSync(join(tmpdir(), 'phi-bundle-'))
  try {
    const localArchive = join(tmp, `${hash}.tar.gz`)
    await buildArchive(input.localRoot, files, localArchive)
    const remoteArchive = `${bundleDir}.tar.gz`
    await session.uploadFile(localArchive, remoteArchive)

    // Unpack beside the final path and move it in, so a half-unpacked bundle is never
    // mistaken for a complete one. If another run got there first, keep theirs.
    const partial = `${bundleDir}.partial`
    const script = [
      'set -e',
      `rm -rf ${shellQuote(partial)}`,
      `mkdir -p ${shellQuote(partial)}`,
      `tar -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(partial)}`,
      `touch ${shellQuote(`${partial}/${COMPLETE_MARKER}`)}`,
      `if [ -e ${shellQuote(bundleDir)} ]; then rm -rf ${shellQuote(partial)}; else mv ${shellQuote(partial)} ${shellQuote(bundleDir)}; fi`,
      `rm -f ${shellQuote(remoteArchive)}`
    ].join('\n')
    const result = await session.exec(script)
    if (result.code !== 0) {
      throw new Error(`远程解压 wrapper 源码失败: ${result.stderr || result.stdout}`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return bundle
}
