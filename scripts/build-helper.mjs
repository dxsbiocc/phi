/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGo } from './helper-toolchain.mjs'
import { fileSha256, verifyFileSha256 } from './runtime/fetch-go.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const HELPER_TARGETS = Object.freeze([
  Object.freeze({ id: 'linux-amd64', goos: 'linux', goarch: 'amd64' }),
  Object.freeze({ id: 'linux-arm64', goos: 'linux', goarch: 'arm64' })
])

export { verifyFileSha256 }

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
      .map(({ id, sha256, size }) => [
        id,
        {
          path: path.posix.join(version, id, 'phi-helper'),
          sha256,
          size
        }
      ])
  )
  return { version, platforms }
}

function buildTarget(version, target) {
  const directory = path.join(helperResourceRoot(), version, target.id)
  const output = path.join(directory, 'phi-helper')
  const partial = `${output}.${process.pid}.partial`
  mkdirSync(directory, { recursive: true })
  rmSync(partial, { force: true })
  try {
    runGo(['build', '-trimpath', '-ldflags', '-s -w', '-o', partial, '.'], {
      cwd: path.join(repoRoot, 'helper'),
      env: {
        CGO_ENABLED: '0',
        GOARCH: target.goarch,
        GOOS: target.goos
      }
    })
    chmodSync(partial, 0o755)
    renameSync(partial, output)
  } finally {
    rmSync(partial, { force: true })
  }
  return { id: target.id, sha256: fileSha256(output), size: statSync(output).size }
}

function writeManifest(manifest) {
  const root = helperResourceRoot()
  const target = path.join(root, 'manifest.json')
  const partial = `${target}.${process.pid}.partial`
  mkdirSync(root, { recursive: true })
  writeFileSync(partial, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  renameSync(partial, target)
}

export function buildHelper() {
  const version = readHelperVersion()
  const entries = HELPER_TARGETS.map((target) => buildTarget(version, target))
  const manifest = buildHelperManifest(version, entries)
  writeManifest(manifest)
  console.log(
    `build-helper: built phi-helper ${version} for ${entries.map(({ id }) => id).join(', ')}`
  )
  return manifest
}

const entry = process.argv[1]
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    buildHelper()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
