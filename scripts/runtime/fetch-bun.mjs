/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MAX_BUN_BINARY_BYTES = 128 * 1024 * 1024

// Phi ids are `${process.platform}-${process.arch}`. The manifest can add more
// targets without changing the download/extraction flow.
export const BUN_PLATFORM_IDS = ['darwin-arm64']

export function bunPlatformId(platform = process.platform, arch = process.arch) {
  const id = `${platform}-${arch}`
  return BUN_PLATFORM_IDS.includes(id) ? id : undefined
}

export function lookupBunPlatform(manifest, platformId) {
  const entry = manifest?.bun?.platforms?.[platformId]
  if (
    !entry ||
    typeof entry.url !== 'string' ||
    typeof entry.sha256 !== 'string' ||
    typeof entry.executableSha256 !== 'string' ||
    typeof entry.archivePath !== 'string'
  ) {
    return undefined
  }
  return {
    url: entry.url,
    sha256: entry.sha256,
    executableSha256: entry.executableSha256,
    archivePath: entry.archivePath
  }
}

export function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function loadManifest() {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'resources', 'runtime', 'manifest.json'), 'utf8')
  )
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
  console.error(message)
  process.exit(1)
}

// `build` runs this script; unsupported hosts should not fail a source build.
function skipUnsupported(platformId) {
  console.warn(
    `fetch-bun: skipping unsupported platform ${platformId} (bundled: ${BUN_PLATFORM_IDS.join(', ')})`
  )
  process.exit(0)
}

function selectedPlatforms(argv) {
  let all = false
  let platformId
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--all') {
      all = true
      continue
    }
    if (arg === '--platform') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail('fetch-bun: --platform requires a platform id')
      platformId = value
      index += 1
      continue
    }
    fail(`fetch-bun: unknown argument ${arg}`)
  }
  if (all && platformId) fail('fetch-bun: use either --all or --platform')
  if (all) return BUN_PLATFORM_IDS
  if (platformId) {
    if (!BUN_PLATFORM_IDS.includes(platformId)) skipUnsupported(platformId)
    return [platformId]
  }
  const current = bunPlatformId()
  if (!current) skipUnsupported(`${process.platform}-${process.arch}`)
  return [current]
}

function bunFileName(platformId) {
  return platformId.startsWith('win32-') ? 'bun.exe' : 'bun'
}

function extractExecutable(archive, archivePath) {
  try {
    return execFileSync('unzip', ['-p', archive, archivePath], {
      encoding: 'buffer',
      maxBuffer: MAX_BUN_BINARY_BYTES,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    throw new Error(`fetch-bun: failed to extract ${archivePath}: ${errorText(error)}`)
  }
}

function fetchPlatform(manifest, platformId) {
  const release = lookupBunPlatform(manifest, platformId)
  if (!release) {
    fail(`fetch-bun: resources/runtime/manifest.json has no Bun release for ${platformId}`)
  }

  const target = path.join(
    repoRoot,
    'resources',
    'runtime',
    'bun',
    platformId,
    bunFileName(platformId)
  )
  if (existsSync(target) && fileSha256(target) === release.executableSha256) {
    chmodSync(target, 0o755)
    return
  }

  const directory = path.dirname(target)
  mkdirSync(directory, { recursive: true })
  const archive = path.join(directory, `.bun.${platformId}.${process.pid}.zip.partial`)
  const partial = path.join(directory, `.bun.${platformId}.${process.pid}.partial`)
  rmSync(archive, { force: true })
  rmSync(partial, { force: true })

  try {
    execFileSync(
      'curl',
      ['-fsSL', '--retry', '5', '--retry-all-errors', '-o', archive, release.url],
      { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }
    )
  } catch (error) {
    rmSync(archive, { force: true })
    fail(`fetch-bun: download failed for ${platformId}: ${errorText(error)}`)
  }

  const archiveDigest = fileSha256(archive)
  if (archiveDigest !== release.sha256) {
    rmSync(archive, { force: true })
    fail(
      `fetch-bun: archive sha256 mismatch for ${platformId}: expected ${release.sha256}, got ${archiveDigest}`
    )
  }

  let executable
  try {
    executable = extractExecutable(archive, release.archivePath)
  } catch (error) {
    rmSync(archive, { force: true })
    fail(errorText(error))
  }
  rmSync(archive, { force: true })
  writeFileSync(partial, executable)
  const executableDigest = fileSha256(partial)
  if (executableDigest !== release.executableSha256) {
    rmSync(partial, { force: true })
    fail(
      `fetch-bun: executable sha256 mismatch for ${platformId}: expected ${release.executableSha256}, got ${executableDigest}`
    )
  }

  chmodSync(partial, 0o755)
  renameSync(partial, target)
  const version = typeof manifest.bun?.version === 'string' ? manifest.bun.version : 'unknown'
  console.log(`fetch-bun: downloaded ${platformId} (${version})`)
}

function main() {
  const manifest = loadManifest()
  for (const platformId of selectedPlatforms(process.argv.slice(2))) {
    fetchPlatform(manifest, platformId)
  }
}

const entry = process.argv[1]
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main()
}
