/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withBuildLock } from './build-lock.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDirectory, '../..')
const manifestPath = path.join(scriptDirectory, 'go-manifest.json')

export const GO_RELEASE = Object.freeze(JSON.parse(readFileSync(manifestPath, 'utf8')))

export function goArchivePlatform(platform = process.platform, arch = process.arch) {
  const goArch = arch === 'x64' ? 'amd64' : arch
  const platformId = `${platform}-${goArch}`
  return GO_RELEASE.platforms[platformId] ? platformId : undefined
}

export function goCacheRoot(root = repoRoot) {
  return path.join(root, 'node_modules', '.cache', 'phi-go', GO_RELEASE.version)
}

export function goBinaryPath(cacheRoot = goCacheRoot()) {
  return path.join(cacheRoot, 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go')
}

export function goToolchainEnvironment(baseEnv = process.env, cacheRoot = goCacheRoot()) {
  return {
    ...baseEnv,
    GOCACHE: path.join(cacheRoot, 'gocache'),
    GOENV: 'off',
    GOFLAGS: '-mod=readonly',
    GOMODCACHE: path.join(cacheRoot, 'gopath', 'pkg', 'mod'),
    GOPATH: path.join(cacheRoot, 'gopath'),
    GOPROXY: 'off',
    GOSUMDB: 'off',
    GOTOOLCHAIN: 'local',
    GOWORK: 'off'
  }
}

export function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

export function verifyFileSha256(filePath, expectedSha256) {
  return existsSync(filePath) && fileSha256(filePath) === expectedSha256
}

function errorText(error) {
  if (typeof error !== 'object' || error === null) return String(error)
  const stderr = 'stderr' in error ? error.stderr : ''
  const stderrText = Buffer.isBuffer(stderr)
    ? stderr.toString('utf8')
    : typeof stderr === 'string'
      ? stderr
      : ''
  if (stderrText.trim()) return stderrText.trim()
  return 'message' in error ? String(error.message) : String(error)
}

function fail(message) {
  throw new Error(`fetch-go: ${message}`)
}

function archivePath(cacheRoot, release) {
  return path.join(cacheRoot, path.basename(new URL(release.url).pathname))
}

function goVersionMatches(binary, cacheRoot) {
  if (!existsSync(binary)) return false
  try {
    const output = execFileSync(binary, ['version'], {
      encoding: 'utf8',
      env: goToolchainEnvironment(process.env, cacheRoot),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return output.startsWith(`go version go${GO_RELEASE.version} `)
  } catch {
    return false
  }
}

function downloadArchive(release, target) {
  const partial = `${target}.${process.pid}.partial`
  try {
    execFileSync(
      'curl',
      ['-fsSL', '--retry', '5', '--retry-all-errors', '-o', partial, release.url],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe']
      }
    )
    if (!verifyFileSha256(partial, release.sha256)) {
      fail(`sha256 mismatch for ${path.basename(target)}`)
    }
    renameSync(partial, target)
  } catch (error) {
    rmSync(partial, { force: true })
    fail(`download failed for ${release.url}: ${errorText(error)}`)
  }
}

function extractToolchain(archive, cacheRoot) {
  const staging = path.join(cacheRoot, `.extract.${process.pid}`)
  const extracted = path.join(staging, 'go')
  const target = path.join(cacheRoot, 'go')
  rmSync(staging, { force: true, recursive: true })
  mkdirSync(staging, { recursive: true })
  try {
    execFileSync('tar', ['-xzf', archive, '-C', staging], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe']
    })
    rmSync(target, { force: true, recursive: true })
    renameSync(extracted, target)
    chmodSync(goBinaryPath(cacheRoot), 0o755)
  } catch (error) {
    fail(`extraction failed: ${errorText(error)}`)
  } finally {
    rmSync(staging, { force: true, recursive: true })
  }
}

export function ensureGoToolchain({
  platform = process.platform,
  arch = process.arch,
  cacheRoot = goCacheRoot(),
  verifyArchive = verifyFileSha256,
  versionMatches = goVersionMatches,
  download = downloadArchive,
  extract = extractToolchain,
  lockTimeoutMs = 120_000
} = {}) {
  const platformId = goArchivePlatform(platform, arch)
  if (!platformId) fail(`unsupported host platform ${platform}-${arch}`)
  const release = GO_RELEASE.platforms[platformId]
  const binary = goBinaryPath(cacheRoot)
  const archive = archivePath(cacheRoot, release)
  mkdirSync(cacheRoot, { recursive: true })
  mkdirSync(path.join(cacheRoot, 'gocache'), { recursive: true })
  mkdirSync(path.join(cacheRoot, 'gopath'), { recursive: true })
  const isReady = () => verifyArchive(archive, release.sha256) && versionMatches(binary, cacheRoot)
  if (isReady()) return binary
  return withBuildLock(
    path.join(cacheRoot, 'install.lock'),
    () => {
      // A competing architecture may have completed installation while this caller waited.
      if (isReady()) return binary
      if (!verifyArchive(archive, release.sha256)) {
        rmSync(archive, { force: true })
        download(release, archive)
      }
      extract(archive, cacheRoot)
      if (!versionMatches(binary, cacheRoot))
        fail(`extracted toolchain is not Go ${GO_RELEASE.version}`)
      console.log(`fetch-go: ready ${platformId} (go${GO_RELEASE.version})`)
      return binary
    },
    { timeoutMs: lockTimeoutMs, description: 'Go toolchain installation' }
  )
}

function main() {
  if (process.argv.length > 2) fail(`unknown argument ${process.argv[2]}`)
  ensureGoToolchain()
}

const entry = process.argv[1]
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(errorText(error))
    process.exit(1)
  }
}
