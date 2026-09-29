/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// Phi ids are `${process.platform}-${process.arch}` for the platforms we ship.
// conda-forge subdirs differ (osx-arm64, osx-64, linux-64) and are encoded in
// the manifest URLs.
export const MICROMAMBA_PLATFORM_IDS = ['darwin-arm64', 'darwin-x64', 'linux-x64']

export function phiPlatformId(platform = process.platform, arch = process.arch) {
  const id = `${platform}-${arch}`
  return MICROMAMBA_PLATFORM_IDS.includes(id) ? id : undefined
}

export function lookupMicromambaPlatform(manifest, platformId) {
  const entry = manifest?.micromamba?.platforms?.[platformId]
  if (!entry || typeof entry.url !== 'string' || typeof entry.sha256 !== 'string') return undefined
  return { url: entry.url, sha256: entry.sha256 }
}

export function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function loadManifest() {
  const manifestPath = path.join(repoRoot, 'resources', 'runtime', 'manifest.json')
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
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

// predev / prestart / build run this script. An unbundled host (win32, linux-arm64, …)
// must not fail those installs.
function skipUnsupported(platformId) {
  console.warn(
    `fetch-micromamba: skipping unsupported platform ${platformId} ` +
      `(bundled: ${MICROMAMBA_PLATFORM_IDS.join(', ')})`
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
      if (!value || value.startsWith('--')) {
        fail('fetch-micromamba: --platform requires a platform id')
      }
      platformId = value
      index += 1
      continue
    }
    fail(`fetch-micromamba: unknown argument ${arg}`)
  }
  if (all && platformId) fail('fetch-micromamba: use either --all or --platform')
  if (all) return MICROMAMBA_PLATFORM_IDS
  if (platformId) {
    if (!MICROMAMBA_PLATFORM_IDS.includes(platformId)) skipUnsupported(platformId)
    return [platformId]
  }
  const current = phiPlatformId()
  if (!current) skipUnsupported(`${process.platform}-${process.arch}`)
  return [current]
}

function fetchPlatform(manifest, platformId) {
  const release = lookupMicromambaPlatform(manifest, platformId)
  if (!release) {
    fail(
      `fetch-micromamba: resources/runtime/manifest.json has no micromamba release for ${platformId}`
    )
  }

  const target = path.join(repoRoot, 'resources', 'runtime', 'micromamba', platformId, 'micromamba')
  if (existsSync(target) && fileSha256(target) === release.sha256) return

  const directory = path.dirname(target)
  mkdirSync(directory, { recursive: true })
  // Same directory as the destination so the final rename does not cross filesystems.
  const partial = path.join(directory, `.micromamba.${platformId}.${process.pid}.partial`)
  try {
    execFileSync(
      'curl',
      ['-fsSL', '--retry', '5', '--retry-all-errors', '-o', partial, release.url],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe']
      }
    )
  } catch (error) {
    rmSync(partial, { force: true })
    fail(`fetch-micromamba: download failed for ${platformId}: ${errorText(error)}`)
  }

  const digest = fileSha256(partial)
  if (digest !== release.sha256) {
    rmSync(partial, { force: true })
    fail(
      `fetch-micromamba: sha256 mismatch for ${platformId}: expected ${release.sha256}, got ${digest}`
    )
  }
  chmodSync(partial, 0o755)
  renameSync(partial, target)
  const version =
    typeof manifest.micromamba?.version === 'string' ? manifest.micromamba.version : 'unknown'
  console.log(`fetch-micromamba: downloaded ${platformId} (${version})`)
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
