import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

import { REMOTE_OMP_MANIFEST } from '../../src/main/agent/engine/rpc/runtime-deployment'
import type { RemoteOmpManifest } from '../../src/main/agent/engine/rpc/runtime-deployment/types'
import { resolveBunExecutable } from '../../src/main/agent/engine/bun-executable'
import { getRemoteHostProfile, sshConfigHostProfileId } from '../../src/main/agent/remote-hosts'
import type { R8Args } from './args'
import {
  ASSET_CACHE_DIRECTORY,
  EMPTY_ASSET_CACHE_REPORT,
  seedRunAssetCache,
  storeRunAssetCache,
  type AssetCacheReport
} from './asset-cache'
import { productionBundleHash } from './bundle'
import { readPrivateJson } from './private-json'
import { buildReceipt, renderSummary, type R8Receipt } from './receipt'
import type { R8RunResult } from './runner'
import { assertTrackedTreeClean, currentCommit, modifiedTrackedFiles, type GitRunner } from './tree'
import { SCRATCH_DIRECTORY, totalMsFor, type R8Input } from './types'

export interface ParentDependencies {
  readonly repoRoot: string
  readonly git: GitRunner
  readonly bundleHash: () => Promise<string>
  readonly resolveProfile: (host: string) => Promise<R8Input['profile']>
  /** Runs the isolated child to completion and resolves with its exit code. */
  readonly runChild: (inputPath: string, input: R8Input) => Promise<number | null>
  readonly now: () => Date
  readonly print: (text: string) => void
  /** The release manifest the production code uses; defaults to the real one. */
  readonly assetManifest?: RemoteOmpManifest
}

export function defaultParentDependencies(repoRoot: string, git: GitRunner): ParentDependencies {
  return {
    repoRoot,
    git,
    bundleHash: () => productionBundleHash(repoRoot),
    resolveProfile,
    runChild: (inputPath, input) => spawnChild(inputPath, input),
    now: () => new Date(),
    print: (text) => console.log(text)
  }
}

/**
 * The managed identity must be resolved with the real HOME: the isolated child has a private
 * HOME, where the connector's own `~` expansion would point at the wrong directory.
 * `ssh -G` is a local configuration query; it opens no connection.
 */
async function resolveProfile(host: string): Promise<R8Input['profile']> {
  const selected = getRemoteHostProfile(sshConfigHostProfileId(host))
  if (!selected || selected.hostAlias !== host)
    throw new Error(`"${host}" is not a host alias in your ~/.ssh/config`)
  const profile = {
    hostAlias: selected.hostAlias,
    ...(selected.user ? { user: selected.user } : {}),
    ...(selected.port ? { port: selected.port } : {}),
    ...(selected.identityFile ? { identityFile: selected.identityFile } : {})
  }
  if (profile.identityFile) return profile
  const output = await promisify(execFile)(
    'ssh',
    [
      '-G',
      ...(profile.user ? ['-l', profile.user] : []),
      ...(profile.port ? ['-p', String(profile.port)] : []),
      host
    ],
    { timeout: 3000, maxBuffer: 65_536 }
  )
  const identities = output.stdout.split(/\r?\n/).flatMap((line) => {
    const raw = /^identityfile\s+(.+)$/i.exec(line.trim())?.[1]?.trim()
    if (!raw) return []
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
    const path = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
    return isAbsolute(path) && basename(path) === `phi_${host}_ed25519` ? [path] : []
  })
  assert.ok(identities.length <= 1, 'Ambiguous managed SSH identity')
  return identities[0] ? { ...profile, identityFile: identities[0] } : profile
}

function spawnChild(inputPath: string, input: R8Input): Promise<number | null> {
  const child = spawn(
    'node',
    [
      '--import',
      './scripts/test-loader.mjs',
      join(input.repoRoot, 'scripts/remote-r8/child.ts'),
      inputPath
    ],
    {
      cwd: input.repoRoot,
      env: {
        PATH: process.env.PATH,
        HOME: join(input.localRoot, 'home'),
        PI_CODING_AGENT_DIR: join(input.localRoot, 'agent'),
        TMPDIR: join(input.localRoot, 'tmp'),
        XDG_DATA_HOME: join(input.localRoot, 'home/.local/share'),
        XDG_CACHE_HOME: join(input.localRoot, 'home/.cache'),
        SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
        PHI_PACKAGES_ROOT: process.env.PHI_PACKAGES_ROOT,
        PHI_TEST_REAL_BUN: input.realBun,
        PHI_OMP_WORKER_PATH: join(input.repoRoot, 'src/main/agent/engine/in-process/main.ts')
      },
      stdio: ['ignore', 'inherit', 'inherit']
    }
  )
  const stop = (): void => {
    child.kill('SIGTERM')
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const timer = setTimeout(stop, totalMsFor(input.prepareMs) + 60_000)
  return new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  }).finally(() => {
    clearTimeout(timer)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  })
}

async function readResult(localRoot: string): Promise<R8RunResult | undefined> {
  try {
    return (await readPrivateJson(join(localRoot, 'result.json'))) as R8RunResult
  } catch {
    return undefined
  }
}

export interface ExecuteOutcome {
  readonly receipt: R8Receipt
  readonly receiptPath: string
  readonly exitCode: number
}

/** `--execute`: guard the tree, record the commit and bundle, run the isolated child, write the receipt. */
export async function executeParent(
  args: R8Args,
  deps: ParentDependencies
): Promise<ExecuteOutcome> {
  assertTrackedTreeClean(deps.git)
  const commit = currentCommit(deps.git)
  const bundleHash = await deps.bundleHash()
  const profile = await deps.resolveProfile(args.host)
  const startedAt = deps.now()
  const runId = `r8-${randomUUID()}`
  const scratch = join(deps.repoRoot, SCRATCH_DIRECTORY)
  const localRoot = join(scratch, 'runs', runId)
  await mkdir(join(scratch, 'runs'), { recursive: true, mode: 0o700 })
  await mkdir(join(scratch, 'receipts'), { recursive: true, mode: 0o700 })
  await mkdir(localRoot, { mode: 0o700 })
  assert.equal(await realpath(localRoot), localRoot)
  for (const sub of ['home', 'agent', 'tmp']) await mkdir(join(localRoot, sub), { mode: 0o700 })
  const input: R8Input = {
    runId,
    repoRoot: deps.repoRoot,
    localRoot,
    host: args.host,
    profile,
    runtimeRoot: args.runtimeRoot,
    runtimeRootExplicit: args.runtimeRootExplicit,
    bundleHash,
    commit,
    realBun: resolveBunExecutable(),
    prepareMs: args.prepareTimeoutMinutes * 60_000
  }
  const inputPath = join(localRoot, 'input.json')
  await writeFile(inputPath, JSON.stringify(input) + '\n', { mode: 0o600, flag: 'wx' })

  // Persistent assets are reused only after their SHA-256 matches the production manifest.
  const manifest = deps.assetManifest ?? REMOTE_OMP_MANIFEST
  const persistentDir = join(scratch, ASSET_CACHE_DIRECTORY)
  const agentDir = join(localRoot, 'agent')
  let assetCache: AssetCacheReport = EMPTY_ASSET_CACHE_REPORT
  let assetCacheFailure: string | undefined
  let seeded: readonly string[] = []
  try {
    const seed = await seedRunAssetCache({ persistentDir, agentDir, manifest })
    seeded = seed.reused
    assetCache = { ...assetCache, ...seed }
  } catch (error) {
    assetCacheFailure = error instanceof Error ? error.message : 'Asset cache seeding failed'
  }

  let childExitCode: number | null = null
  let childFailure: string | undefined
  try {
    childExitCode = await deps.runChild(inputPath, input)
  } catch (error) {
    childFailure = error instanceof Error ? error.message : 'The run process failed to start'
  }
  const result = await readResult(localRoot)
  try {
    assetCache = {
      ...assetCache,
      ...(await storeRunAssetCache({ persistentDir, agentDir, manifest, seeded }))
    }
  } catch (error) {
    assetCacheFailure ??= error instanceof Error ? error.message : 'Asset cache save failed'
  }
  const commitAfter = currentCommit(deps.git)
  const bundleHashAfter = await deps.bundleHash()
  const trackedFilesModifiedAfter = modifiedTrackedFiles(deps.git).length
  const finishedAt = deps.now()

  const succeeded = Boolean(result?.ok) && childExitCode === 0
  // The verified asset now lives in the persistent cache; everything else is synthetic.
  await rm(join(localRoot, 'agent/cache'), { recursive: true, force: true })
  let localRunDirectoryRemoved = false
  if (succeeded && commit === commitAfter && bundleHash === bundleHashAfter) {
    await rm(localRoot, { recursive: true, force: true })
    localRunDirectoryRemoved = true
  }
  const receipt = buildReceipt({
    result,
    runId,
    host: args.host,
    runtimeRootConfigured: args.runtimeRoot,
    startedAt,
    finishedAt,
    commit,
    commitAfter,
    bundleHash,
    bundleHashAfter,
    trackedFilesModifiedAfter,
    childExitCode,
    childFailure,
    localRunDirectoryRemoved,
    assetCache: { ...assetCache, ...(assetCacheFailure ? { failure: assetCacheFailure } : {}) }
  })
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  const receiptPath = join(scratch, 'receipts', `${stamp}-${args.host}-${runId}.json`)
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  deps.print(renderSummary(receipt, receiptPath))
  return { receipt, receiptPath, exitCode: receipt.ok ? 0 : 1 }
}
