/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// Phi ids are `${process.platform}-${process.arch}`. OfficeCLI ships macOS first;
// Linux and Windows binaries exist upstream but are not validated for Phi yet.
export const OFFICECLI_PLATFORM_IDS = ['darwin-arm64', 'darwin-x64']

export function officePlatformId(platform = process.platform, arch = process.arch) {
  const id = `${platform}-${arch}`
  return OFFICECLI_PLATFORM_IDS.includes(id) ? id : undefined
}

export function lookupOfficeCliPlatform(manifest, platformId) {
  const entry = manifest?.officecli?.platforms?.[platformId]
  if (!entry || typeof entry.url !== 'string' || typeof entry.sha256 !== 'string') return undefined
  return { url: entry.url, sha256: entry.sha256 }
}

export function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function loadManifest() {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'resources', 'office', 'manifest.json'), 'utf8')
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

// predev / prestart / build run this script; an unsupported host must not fail them.
function skipUnsupported(platformId) {
  console.warn(
    `fetch-officecli: skipping unsupported platform ${platformId} (bundled: ${OFFICECLI_PLATFORM_IDS.join(', ')})`
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
      if (!value || value.startsWith('--'))
        fail('fetch-officecli: --platform requires a platform id')
      platformId = value
      index += 1
      continue
    }
    fail(`fetch-officecli: unknown argument ${arg}`)
  }
  if (all && platformId) fail('fetch-officecli: use either --all or --platform')
  if (all) return OFFICECLI_PLATFORM_IDS
  if (platformId) {
    if (!OFFICECLI_PLATFORM_IDS.includes(platformId)) skipUnsupported(platformId)
    return [platformId]
  }
  const current = officePlatformId()
  if (!current) skipUnsupported(`${process.platform}-${process.arch}`)
  return [current]
}

function fetchPlatform(manifest, platformId) {
  const release = lookupOfficeCliPlatform(manifest, platformId)
  if (!release) {
    fail(
      `fetch-officecli: resources/office/manifest.json has no officecli release for ${platformId}`
    )
  }

  const target = path.join(repoRoot, 'resources', 'office', 'officecli', platformId, 'officecli')
  if (existsSync(target) && fileSha256(target) === release.sha256) return

  const directory = path.dirname(target)
  mkdirSync(directory, { recursive: true })
  // Same directory as the destination so the final rename does not cross filesystems.
  const partial = path.join(directory, `.officecli.${platformId}.${process.pid}.partial`)
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
    fail(`fetch-officecli: download failed for ${platformId}: ${errorText(error)}`)
  }

  const digest = fileSha256(partial)
  if (digest !== release.sha256) {
    rmSync(partial, { force: true })
    fail(
      `fetch-officecli: sha256 mismatch for ${platformId}: expected ${release.sha256}, got ${digest}`
    )
  }
  chmodSync(partial, 0o755)
  renameSync(partial, target)
  const version =
    typeof manifest.officecli?.version === 'string' ? manifest.officecli.version : 'unknown'
  console.log(`fetch-officecli: downloaded ${platformId} (${version})`)
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
