#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Packaged-app worker smoke test (macOS, Linux, and Windows), headless. Run after packaging:
//   node scripts/smoke-packaged-worker.mjs --resources <app resources directory>
// e.g. dist/linux-unpacked/resources, dist/win-unpacked/resources, or
// dist/mac-arm64/Phi.app/Contents/Resources.
//
// A clean machine has no system bun, so this starts the OMP worker the way the app
// does, with the bundled bun and the unpacked worker, on a PATH that holds no bun, and
// waits for one real request to answer. It also runs the bundled micromamba. HOME and
// the agent directory are temporary, so no user data is read or written.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { assertBundledWindowsRuntimes } from './build/after-pack.mjs'
import { OMP_WORKER_ENTRY } from './build/omp-worker-closure.mjs'

const RESPONSE_TIMEOUT_MS = 90_000
const UNIX_CLEAN_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

function bunFileName() {
  return process.platform === 'win32' ? 'bun.exe' : 'bun'
}

function micromambaFileName() {
  return process.platform === 'win32' ? 'micromamba.exe' : 'micromamba'
}

function cleanPath() {
  if (process.platform !== 'win32') return UNIX_CLEAN_PATH
  const root = process.env.SystemRoot || 'C:\\Windows'
  return join(root, 'System32')
}

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
  // The packaged worker sits where the build copies OMP_WORKER_ENTRY: src/ becomes out/.
  const worker = join(resources, 'app.asar.unpacked', OMP_WORKER_ENTRY.replace(/^src\//u, 'out/'))
  if (!existsSync(worker)) throw new Error(`unpacked OMP worker is missing: ${worker}`)
  return worker
}

function checkMicromamba(resources, env) {
  const micromamba = requireFile(
    join(resources, 'runtime', 'micromamba', platformId(), micromambaFileName()),
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
    let failure
    let response
    const timer = setTimeout(() => {
      failure ??= new Error(`worker did not exit within ${RESPONSE_TIMEOUT_MS} ms\n${stderr}`)
      child.kill('SIGKILL')
    }, RESPONSE_TIMEOUT_MS)
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000)
    })
    child.on('error', (error) => {
      failure ??= error
    })
    child.stdin.on('error', (error) => {
      if (!response) failure ??= error
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (!response) {
        reject(new Error(`worker exited early (code ${code}, signal ${signal})\n${stderr}`))
      } else if (!response.ok)
        reject(new Error(`worker request failed: ${response.error}\n${stderr}`))
      else resolveResponse(response.result)
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (response || message?.id !== request.id) return
      response = message
      child.kill('SIGTERM')
    })
    child.stdin.write(`${JSON.stringify(request)}\n`)
  })
}

async function main() {
  const { resources } = parseArgs(process.argv.slice(2))
  if (process.platform === 'win32') assertBundledWindowsRuntimes(resources)
  const bun = requireFile(
    join(resources, 'runtime', 'bun', platformId(), bunFileName()),
    'bundled bun'
  )
  const worker = findWorker(resources)
  const home = mkdtempSync(join(tmpdir(), 'phi-packaged-worker-'))
  const agentDir = join(home, '.phi')
  const pathValue = `${resolve(bun, '..')}${delimiter}${cleanPath()}`
  // The app adds the bundled bun's directory to the worker's PATH; nothing else.
  const env = {
    HOME: home,
    ...(process.platform === 'win32'
      ? {
          USERPROFILE: home,
          SystemRoot: process.env.SystemRoot || 'C:\\Windows',
          windir: process.env.windir || 'C:\\Windows',
          TEMP: process.env.TEMP || join(home, 'Temp'),
          TMP: process.env.TMP || join(home, 'Temp')
        }
      : {}),
    PATH: pathValue,
    PI_CODING_AGENT_DIR: agentDir,
    OMP_APP_NAME: 'Phi',
    LANG: 'C.UTF-8'
  }
  try {
    const system =
      process.platform === 'win32'
        ? { status: 1, stdout: '' }
        : spawnSync('sh', ['-c', 'command -v bun'], {
            env: { PATH: UNIX_CLEAN_PATH },
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
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
