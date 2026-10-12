#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Packaged-app worker smoke test (macOS and Linux), headless. Run after packaging:
//   node scripts/smoke-packaged-worker.mjs --resources <app resources directory>
// e.g. dist/linux-unpacked/resources or dist/mac-arm64/Phi.app/Contents/Resources.
//
// A clean machine has no system bun, so this starts the OMP worker the way the app
// does, with the bundled bun and the unpacked worker, on a PATH that holds no bun, and
// waits for one real request to answer. It also runs the bundled micromamba. HOME and
// the agent directory are temporary, so no user data is read or written.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const RESPONSE_TIMEOUT_MS = 90_000
const CLEAN_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

function parseArgs(argv) {
  const args = { resources: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--resources') args.resources = resolve(argv[(i += 1)])
  }
  if (!args.resources) throw new Error('usage: smoke-packaged-worker.mjs --resources <dir>')
  return args
}

function platformId() {
  return `${process.platform}-${process.arch}`
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`)
  return path
}

function findWorker(resources) {
  const bundleDir = join(resources, 'app.asar.unpacked', 'out', 'main')
  const candidates = [
    join(bundleDir, 'agent', 'omp', 'omp-sdk-worker.ts'),
    join(bundleDir, 'omp', 'omp-sdk-worker.ts')
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`unpacked OMP worker is missing under ${bundleDir}`)
  return found
}

function checkMicromamba(resources, env) {
  const micromamba = requireFile(
    join(resources, 'runtime', 'micromamba', platformId(), 'micromamba'),
    'bundled micromamba'
  )
  const result = spawnSync(micromamba, ['--version'], { env, encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) {
    throw new Error(`bundled micromamba failed: ${result.stderr || result.error?.message}`)
  }
  console.log(`micromamba ${result.stdout.trim()}`)
}

function requestOnce(bun, worker, env, request) {
  return new Promise((resolveResponse, reject) => {
    const child = spawn(bun, [worker], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`worker did not answer within ${RESPONSE_TIMEOUT_MS} ms\n${stderr}`))
    }, RESPONSE_TIMEOUT_MS)
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`worker exited early (code ${code}, signal ${signal})\n${stderr}`))
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message?.id !== request.id) return
      clearTimeout(timer)
      child.removeAllListeners('exit')
      child.kill('SIGTERM')
      if (message.ok) resolveResponse(message.result)
      else reject(new Error(`worker request failed: ${message.error}\n${stderr}`))
    })
    child.stdin.write(`${JSON.stringify(request)}\n`)
  })
}

async function main() {
  const { resources } = parseArgs(process.argv.slice(2))
  const bun = requireFile(join(resources, 'runtime', 'bun', platformId(), 'bun'), 'bundled bun')
  const worker = findWorker(resources)
  const home = mkdtempSync(join(tmpdir(), 'phi-packaged-worker-'))
  const agentDir = join(home, '.phi')
  // The app adds the bundled bun's directory to the worker's PATH; nothing else.
  const env = {
    HOME: home,
    PATH: `${resolve(bun, '..')}:${CLEAN_PATH}`,
    PI_CODING_AGENT_DIR: agentDir,
    OMP_APP_NAME: 'Phi',
    LANG: 'C.UTF-8'
  }
  try {
    const system = spawnSync('sh', ['-c', 'command -v bun'], {
      env: { PATH: CLEAN_PATH },
      encoding: 'utf8'
    })
    if (system.status === 0) {
      console.warn(
        `note: ${system.stdout.trim()} is on the clean PATH; the bundled bun is used anyway`
      )
    }
    checkMicromamba(resources, env)
    const result = await requestOnce(bun, worker, env, {
      id: 'packaged-smoke',
      method: 'settings.autoCompactionDefaults',
      params: { agentDir, cwd: home }
    })
    console.log(`OMP worker answered: ${JSON.stringify(result)}`)
    console.log('packaged worker smoke passed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
