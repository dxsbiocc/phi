#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Packaged-app quit smoke test (macOS). Run after `bun run build:unpack`:
//   bun run smoke:packaged-quit [--app <path/to/pi-desktop.app>]
//
// Copies the app to a temp dir outside the repo and launches it with an isolated
// HOME and --user-data-dir, so real user data is untouched. It signals only the
// PID it started: the packaged app shares bundle id com.electron.app with the dev
// Electron app, so quitting by bundle id could hit a running dev instance.
// The app-quit case asks AppKit to terminate that PID (NSRunningApplication), which
// goes through applicationShouldTerminate: like the Cmd+Q menu item, without
// needing Accessibility/System Events permission.
// The idle cases request quit once the main process has gone idle and the first-launch
// bundled wrapper install has written its tree; the first-run case sends SIGTERM while
// that install is still running, which must not delay the quit.
import { spawn, execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const STARTUP_MIN_WAIT_MS = 5_000
const STARTUP_IDLE_TIMEOUT_MS = 90_000
const IDLE_SAMPLE_MS = 1_000
const IDLE_CPU_MS_PER_SAMPLE = 100
const IDLE_SAMPLES_REQUIRED = 3
const EXIT_DEADLINE_MS = 3_000
const APP_STARTED_TIMEOUT_MS = 30_000
const FIRST_RUN_QUIT_DELAY_MS = 1_000

function parseArgs(argv) {
  const args = { app: resolve('dist/mac-arm64/pi-desktop.app') }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app') args.app = resolve(argv[(i += 1)])
  }
  return args
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid, deadlineMs) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    if (!isAlive(pid)) return Date.now() - started
    await sleep(100)
  }
  return null
}

function cpuTimeMs(pid) {
  // `ps -o time=` prints cumulative CPU time as [[dd-]hh:]mm:ss.cc.
  const text = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text]
  const seconds = clock
    .split(':')
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0)
  return (Number(days) * 86_400 + seconds) * 1_000
}

async function waitForStartupIdle(pid, label) {
  await sleep(STARTUP_MIN_WAIT_MS)
  const started = Date.now()
  let previous = cpuTimeMs(pid)
  let idleSamples = 0
  while (idleSamples < IDLE_SAMPLES_REQUIRED) {
    if (Date.now() - started > STARTUP_IDLE_TIMEOUT_MS) {
      throw new Error(`${label}: app did not go idle within ${STARTUP_IDLE_TIMEOUT_MS} ms`)
    }
    await sleep(IDLE_SAMPLE_MS)
    if (!isAlive(pid)) throw new Error(`${label}: app exited before quit was requested`)
    const current = cpuTimeMs(pid)
    idleSamples = current - previous < IDLE_CPU_MS_PER_SAMPLE ? idleSamples + 1 : 0
    previous = current
  }
}

const wrapperTreeOwnershipPath = (home) => join(home, '.phi', 'wrappers', 'tree.json')

function hasLoggedAppStarted(home) {
  const logs = join(home, '.phi', 'logs')
  if (!existsSync(logs)) return false
  return readdirSync(logs)
    .filter((name) => name.endsWith('.jsonl'))
    .some((name) => readFileSync(join(logs, name), 'utf8').includes('"event":"app_started"'))
}

async function waitForIdleWithWrappers(pid, home, label) {
  // The install runs in a utility process, so main-process idleness alone does not mean
  // first-run setup is over: wait for the wrapper tree first, then for the main process.
  const started = Date.now()
  while (!existsSync(wrapperTreeOwnershipPath(home))) {
    if (Date.now() - started > STARTUP_IDLE_TIMEOUT_MS) {
      throw new Error(
        `${label}: bundled wrappers not installed within ${STARTUP_IDLE_TIMEOUT_MS} ms`
      )
    }
    if (!isAlive(pid)) throw new Error(`${label}: app exited before quit was requested`)
    await sleep(250)
  }
  await waitForStartupIdle(pid, label)
}

async function waitForFirstRunSetup(pid, home, label) {
  const started = Date.now()
  while (!hasLoggedAppStarted(home)) {
    if (Date.now() - started > APP_STARTED_TIMEOUT_MS) {
      throw new Error(`${label}: app_started was not logged within ${APP_STARTED_TIMEOUT_MS} ms`)
    }
    if (!isAlive(pid)) throw new Error(`${label}: app exited before quit was requested`)
    await sleep(100)
  }
  await sleep(FIRST_RUN_QUIT_DELAY_MS)
  if (existsSync(wrapperTreeOwnershipPath(home))) {
    throw new Error(`${label}: bundled wrapper install finished before quit; case did not run`)
  }
}

function requestAppQuit(pid) {
  const script = `ObjC.import('AppKit');
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
    if (!app || !app.terminate) throw new Error('terminate request was not delivered');`
  execFileSync('osascript', ['-l', 'JavaScript', '-e', script])
}

async function runCase(appPath, label, waitBeforeQuit, triggerQuit) {
  const root = mkdtempSync(join(tmpdir(), 'phi-quit-smoke-'))
  let child = null
  try {
    const home = join(root, 'home')
    const userData = join(root, 'ud')
    mkdirSync(home)
    mkdirSync(userData)
    const appCopy = join(root, 'pi-desktop.app')
    cpSync(appPath, appCopy, { recursive: true, verbatimSymlinks: true })

    child = spawn(join(appCopy, 'Contents/MacOS/pi-desktop'), [`--user-data-dir=${userData}`], {
      env: { ...process.env, HOME: home },
      stdio: 'ignore'
    })
    await waitBeforeQuit(child.pid, home, label)

    triggerQuit(child.pid)
    const elapsed = await waitForExit(child.pid, EXIT_DEADLINE_MS)
    if (elapsed === null) {
      throw new Error(`${label}: app still running ${EXIT_DEADLINE_MS} ms after quit`)
    }
    console.log(`ok   ${label}: exited in ${elapsed} ms`)
  } finally {
    if (child && isAlive(child.pid)) process.kill(child.pid, 'SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('skip: packaged quit smoke test is macOS-only')
    return
  }
  const args = parseArgs(process.argv.slice(2))
  const sigterm = (pid) => process.kill(pid, 'SIGTERM')
  await runCase(args.app, 'SIGTERM during first-run setup', waitForFirstRunSetup, sigterm)
  await runCase(args.app, 'SIGTERM', waitForIdleWithWrappers, sigterm)
  await runCase(args.app, 'app quit (Cmd+Q path)', waitForIdleWithWrappers, requestAppQuit)
}

main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
