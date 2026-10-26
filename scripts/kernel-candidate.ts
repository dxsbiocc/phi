#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'

import { verifyLocalKernelPackage } from '../src/main/agent/engine/kernel-client/local-package'

const DEFAULT_EVIDENCE_ROOT = '.phi-acceptance/k4-2'
const BUILD_TARGETS = ['darwin-arm64', 'linux-x64'] as const

export interface CandidateContext {
  readonly candidateId: string
  readonly head: string
  readonly directory: string
}

interface PackageVersion {
  readonly version?: unknown
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function validateAllowedDoc(path: string): string {
  const normalized = posix.normalize(path)
  if (
    path.includes('\\') ||
    normalized !== path ||
    !path.startsWith('docs/') ||
    path.endsWith('/') ||
    path.includes('\0') ||
    path.includes('\n') ||
    path.includes('\r')
  ) {
    throw new Error(`Allowed untracked candidate docs must be under docs/: ${path}`)
  }
  return path
}

export function assertCandidateWorktreeClean(
  statusEntries: readonly string[],
  allowedUntrackedDocs: readonly string[]
): string[] {
  const allowed = new Set(allowedUntrackedDocs.map(validateAllowedDoc))
  const accepted: string[] = []
  const dirty: string[] = []
  for (const entry of statusEntries.filter(Boolean)) {
    const path = entry.slice(3)
    if (entry.startsWith('?? ') && allowed.has(path)) accepted.push(path)
    else dirty.push(entry)
  }
  if (dirty.length > 0) {
    throw new Error(
      `Candidate requires a clean worktree; disallowed entries:\n${dirty.map((entry) => `  ${entry}`).join('\n')}`
    )
  }
  return accepted.sort()
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256')
  await new Promise<void>((resolveDigest, reject) => {
    const input = createReadStream(path)
    input.on('data', (chunk) => digest.update(chunk))
    input.once('error', reject)
    input.once('end', resolveDigest)
  })
  return digest.digest('hex')
}

async function version(path: string, label: string): Promise<string> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as PackageVersion
  if (typeof parsed.version !== 'string' || !parsed.version) {
    throw new Error(`${label} package does not declare a version: ${path}`)
  }
  return parsed.version
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

async function builtTargets(repoRoot: string, phiVersion: string): Promise<unknown[]> {
  const results: unknown[] = []
  for (const target of BUILD_TARGETS) {
    const directory = join(repoRoot, '.phi-build', 'kernel', phiVersion, target)
    if (!(await exists(join(directory, 'manifest.json')))) continue
    const verified = await verifyLocalKernelPackage({ directory, target, phiVersion })
    results.push({
      target,
      manifestSha256: await sha256(verified.manifestPath),
      files: verified.manifest.files.map((file) => ({
        name: file.name,
        role: file.role,
        ...(file.variant ? { variant: file.variant } : {}),
        sha256: file.sha256,
        size: file.size
      }))
    })
  }
  return results
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

export function candidateContext(
  options: {
    readonly repoRoot?: string
    readonly evidenceRoot?: string
    readonly candidateId?: string
  } = {}
): CandidateContext {
  const repoRoot = resolve(options.repoRoot ?? '.')
  const head = git(repoRoot, ['rev-parse', 'HEAD'])
  const currentId = git(repoRoot, ['rev-parse', '--short=12', 'HEAD'])
  const candidateId = options.candidateId ?? currentId
  if (!/^[a-f0-9]{7,40}$/u.test(candidateId) || !head.startsWith(candidateId)) {
    throw new Error(`Candidate id ${candidateId} does not identify current HEAD ${head}.`)
  }
  return {
    candidateId,
    head,
    directory: resolve(repoRoot, options.evidenceRoot ?? DEFAULT_EVIDENCE_ROOT, candidateId)
  }
}

export async function writeKernelCandidate(
  options: {
    readonly repoRoot?: string
    readonly evidenceRoot?: string
    readonly candidateId?: string
    readonly allowedUntrackedDocs?: readonly string[]
  } = {}
): Promise<{ context: CandidateContext; manifest: Record<string, unknown> }> {
  const repoRoot = resolve(options.repoRoot ?? '.')
  const context = candidateContext({
    repoRoot,
    evidenceRoot: options.evidenceRoot,
    candidateId: options.candidateId
  })
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const allowedUntrackedDocs = assertCandidateWorktreeClean(
    status.split('\0'),
    options.allowedUntrackedDocs ?? []
  )
  const phiVersion = await version(join(repoRoot, 'package.json'), 'Phi')
  const ompVersion = await version(
    join(repoRoot, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'package.json'),
    'OMP'
  )
  const nativeVersion = await version(
    join(repoRoot, 'node_modules', '@oh-my-pi', 'pi-natives', 'package.json'),
    'pi-natives'
  )
  const bunVersion =
    (process.versions as Record<string, string | undefined>).bun ??
    execFileSync('bun', ['--version'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    candidateId: context.candidateId,
    generatedAt: new Date().toISOString(),
    git: {
      head: context.head,
      clean: true,
      allowedUntrackedDocs
    },
    versions: {
      phi: phiVersion,
      omp: ompVersion,
      native: nativeVersion,
      bun: bunVersion
    },
    machine: {
      node: process.version,
      os: platform(),
      osRelease: release(),
      arch: arch()
    },
    kernelBuilds: await builtTargets(repoRoot, phiVersion)
  }
  await atomicJson(join(context.directory, 'candidate.json'), manifest)
  return { context, manifest }
}

export async function reserveEvidencePath(
  candidateDirectory: string,
  category: string,
  extension: string
): Promise<{ path: string; attempt: number }> {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(category)) {
    throw new Error(`Invalid evidence category: ${category}`)
  }
  if (!/^[a-z0-9]+$/u.test(extension)) throw new Error(`Invalid evidence extension: ${extension}`)
  const directory = join(candidateDirectory, category)
  await mkdir(directory, { recursive: true })
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const path = join(directory, `attempt-${String(attempt).padStart(3, '0')}.${extension}`)
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.close()
      return { path, attempt }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error(`Candidate evidence attempt limit reached for ${category}.`)
}

function parseArgs(argv: string[]): {
  candidateId?: string
  evidenceRoot?: string
  allowedUntrackedDocs: string[]
} {
  const result: {
    candidateId?: string
    evidenceRoot?: string
    allowedUntrackedDocs: string[]
  } = { allowedUntrackedDocs: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`)
    if (key === '--candidate') result.candidateId = value
    else if (key === '--evidence-root') result.evidenceRoot = value
    else if (key === '--allow-untracked-doc') result.allowedUntrackedDocs.push(value)
    else throw new Error(`Unknown argument: ${key}`)
  }
  return result
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const result = await writeKernelCandidate(options)
  process.stdout.write(
    `${JSON.stringify({ directory: result.context.directory, ...result.manifest })}\n`
  )
}

if (import.meta.main) await main()
