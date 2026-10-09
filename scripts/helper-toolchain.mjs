/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureGoToolchain,
  GO_RELEASE,
  goArchivePlatform,
  goBinaryPath,
  goCacheRoot,
  goToolchainEnvironment
} from './runtime/fetch-go.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export {
  ensureGoToolchain,
  GO_RELEASE,
  goArchivePlatform,
  goBinaryPath,
  goCacheRoot,
  goToolchainEnvironment
}

export function runGo(args, options = {}) {
  const binary = ensureGoToolchain()
  const cacheRoot = goCacheRoot()
  const environment = goToolchainEnvironment({ ...process.env, ...(options.env ?? {}) }, cacheRoot)
  return execFileSync(binary, args, {
    cwd: options.cwd ?? path.join(repoRoot, 'helper'),
    encoding: options.encoding ?? 'utf8',
    env: environment,
    stdio: options.stdio ?? 'inherit'
  })
}

function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) throw new Error('helper-toolchain: expected Go arguments')
  runGo(args)
}

const entry = process.argv[1]
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
