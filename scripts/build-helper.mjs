/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GO_RELEASE, goToolchainEnvironment, runGo } from './helper-toolchain.mjs'
import { fileSha256, verifyFileSha256 } from './runtime/fetch-go.mjs'
import { withBuildLock } from './runtime/build-lock.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const HELPER_TARGETS = Object.freeze([
  Object.freeze({ id: 'linux-amd64', goos: 'linux', goarch: 'amd64' }),
  Object.freeze({ id: 'linux-arm64', goos: 'linux', goarch: 'arm64' })
])

export { verifyFileSha256 }

const BUILD_FLAGS = Object.freeze(['build', '-trimpath', '-ldflags', '-s -w'])

function helperTargetEnvironment(target) {
  return {
    CGO_ENABLED: '0',
    GOOS: target.goos,
    GOARCH: target.goarch,
    GOAMD64: 'v1',
    GOARM64: 'v8.0',
    GOEXPERIMENT: ''
  }
}

export function helperResourceRoot(root = repoRoot) {
  return path.join(root, 'resources', 'remote-helper')
}

export function readHelperVersion(root = repoRoot) {
  const version = readFileSync(path.join(root, 'helper', 'VERSION'), 'utf8').trim()
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) {
    throw new Error('build-helper: helper/VERSION must be a non-empty portable path segment')
  }
  return version
}

export function buildHelperManifest(version, entries) {
  const platforms = Object.fromEntries(
    [...entries]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, sha256, size, fingerprint }) => [
        id,
        {
          path: path.posix.join(version, id, 'phi-helper'),
          sha256,
          size,
          ...(fingerprint ? { fingerprint } : {})
        }
      ])
  )
  return { version, platforms }
}

function sourceFiles(directory, relative = '') {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const name = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) return sourceFiles(path.join(directory, entry.name), name)
      if (
        entry.isFile() &&
        (name.endsWith('.go') || ['go.mod', 'go.sum', 'VERSION'].includes(name))
      ) {
        return [name]
      }
      return []
    })
    .sort()
}

export function helperBuildFingerprint(root, target) {
  const helperRoot = path.join(root, 'helper')
  const environment = goToolchainEnvironment({}, '')
  const inputs = {
    schema: 1,
    toolchain: GO_RELEASE,
    flags: BUILD_FLAGS,
    environment: {
      ...helperTargetEnvironment(target),
      GOENV: environment.GOENV,
      GOFLAGS: environment.GOFLAGS,
      GOPROXY: environment.GOPROXY,
      GOSUMDB: environment.GOSUMDB,
      GOTOOLCHAIN: environment.GOTOOLCHAIN,
      GOWORK: environment.GOWORK
    },
    files: sourceFiles(helperRoot).map((name) => [name, fileSha256(path.join(helperRoot, name))])
  }
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
}

function readManifest(root) {
  try {
    return JSON.parse(readFileSync(path.join(helperResourceRoot(root), 'manifest.json'), 'utf8'))
  } catch {
    return undefined
  }
}

function cachedEntry(manifest, version, target, fingerprint, root) {
  const entry = manifest?.version === version ? manifest.platforms?.[target.id] : undefined
  const expectedPath = path.posix.join(version, target.id, 'phi-helper')
  if (
    !entry ||
    entry.path !== expectedPath ||
    entry.fingerprint !== fingerprint ||
    !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size <= 0
  ) {
    return undefined
  }
  try {
    const output = path.join(helperResourceRoot(root), expectedPath)
    const stat = statSync(output)
    if (!stat.isFile() || stat.size !== entry.size || !verifyFileSha256(output, entry.sha256)) {
      return undefined
    }
    return { id: target.id, sha256: entry.sha256, size: entry.size, fingerprint }
  } catch {
    return undefined
  }
}

function selectTargets(targetId) {
  if (targetId === undefined) return HELPER_TARGETS
  const target = HELPER_TARGETS.find(({ id }) => id === targetId)
  if (!target) throw new Error(`build-helper: unsupported target ${String(targetId)}`)
  return [target]
}

export function parseHelperBuildArgs(args) {
  if (args.length === 0) return {}
  if (args.length !== 2 || args[0] !== '--target') {
    throw new Error('build-helper: expected --target linux-amd64 or --target linux-arm64')
  }
  selectTargets(args[1])
  return { target: args[1] }
}

function buildTarget(version, target, fingerprint, root, goRunner) {
  const directory = path.join(helperResourceRoot(root), version, target.id)
  const output = path.join(directory, 'phi-helper')
  const partial = `${output}.${process.pid}.partial`
  mkdirSync(directory, { recursive: true })
  rmSync(partial, { force: true })
  try {
    goRunner([...BUILD_FLAGS, '-o', partial, '.'], {
      cwd: path.join(root, 'helper'),
      env: helperTargetEnvironment(target)
    })
    chmodSync(partial, 0o755)
    renameSync(partial, output)
  } finally {
    rmSync(partial, { force: true })
  }
  return { id: target.id, sha256: fileSha256(output), size: statSync(output).size, fingerprint }
}

function writeManifest(manifest, repo) {
  if (JSON.stringify(readManifest(repo)) === JSON.stringify(manifest)) return
  const root = helperResourceRoot(repo)
  const target = path.join(root, 'manifest.json')
  const partial = `${target}.${process.pid}.partial`
  mkdirSync(root, { recursive: true })
  try {
    writeFileSync(partial, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
    renameSync(partial, target)
  } finally {
    rmSync(partial, { force: true })
  }
}

function publishManifest(root, version, selected, fingerprints, timeoutMs) {
  return withBuildLock(
    path.join(helperResourceRoot(root), 'manifest.json.lock'),
    () => {
      const latest = readManifest(root)
      const selectedManifest = buildHelperManifest(version, selected)
      const entries = HELPER_TARGETS.flatMap((target) => {
        const fingerprint = fingerprints.get(target.id)
        const entry =
          cachedEntry(selectedManifest, version, target, fingerprint, root) ??
          cachedEntry(latest, version, target, fingerprint, root)
        if (!entry && selected.some(({ id }) => id === target.id)) {
          throw new Error(`build-helper: ${target.id} changed before manifest publication`)
        }
        return entry ? [entry] : []
      })
      const manifest = buildHelperManifest(version, entries)
      writeManifest(manifest, root)
      return manifest
    },
    { timeoutMs, description: 'helper manifest publication' }
  )
}

export function buildHelper({
  root = repoRoot,
  goRunner = runGo,
  target: targetId,
  lockTimeoutMs = 10_000
} = {}) {
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new Error('build-helper: lockTimeoutMs must be positive')
  }
  const targets = selectTargets(targetId)
  const version = readHelperVersion(root)
  const fingerprints = new Map(
    HELPER_TARGETS.map((target) => [target.id, helperBuildFingerprint(root, target)])
  )
  const previous = readManifest(root)
  const built = []
  const selected = targets.map((target) => {
    const fingerprint = fingerprints.get(target.id)
    const cached = cachedEntry(previous, version, target, fingerprint, root)
    if (cached) return cached
    built.push(target.id)
    return buildTarget(version, target, fingerprint, root, goRunner)
  })
  const manifest = publishManifest(root, version, selected, fingerprints, lockTimeoutMs)
  console.log(
    `build-helper: ${built.length ? `built ${built.join(', ')}` : 'reused checked artifacts'} (phi-helper ${version})`
  )
  return manifest
}

const entry = process.argv[1]
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    buildHelper(parseHelperBuildArgs(process.argv.slice(2)))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
