import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

// Every location comes from the environment so the driver carries no machine-specific paths.
export const PACKAGED_APP =
  process.env.G4_APP || path.join(REPO_ROOT, 'dist/mac-arm64/Phi.app/Contents/MacOS/Phi')
export const SOURCE_HOME = process.env.G4_SOURCE_HOME || ''
export const SOURCE_USERDATA = process.env.G4_SOURCE_USERDATA || ''
export const RUNS_ROOT = process.env.G4_RUNS_ROOT || path.join(REPO_ROOT, '.phi-acceptance/g4-runs')

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

async function requirePath(target, label) {
  try {
    await stat(target)
  } catch {
    throw new Error(`${label} does not exist: ${target}`)
  }
}

async function runClone(source, destination, timeoutMs = 2 * 60_000) {
  const child = Bun.spawn(['cp', '-c', '-R', source, destination], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The clone may have exited between the timeout and the signal.
      }
      reject(new Error(`APFS clone timed out: ${source}`))
    }, timeoutMs)
  })
  try {
    const exitCode = await Promise.race([child.exited, timeout])
    if (exitCode !== 0) {
      const error = await new Response(child.stderr).text()
      throw new Error(`APFS clone failed (${exitCode}): ${error.trim()}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

async function removeChromiumLocks(userdata) {
  const entries = await readdir(userdata, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'DevToolsActivePort' || entry.name.startsWith('Singleton')) {
      await rm(path.join(userdata, entry.name), { recursive: entry.isDirectory(), force: true })
    }
  }
}

export async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a TCP port')))
        return
      }
      const port = address.port
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

export async function prepareRun() {
  if (!SOURCE_HOME || !SOURCE_USERDATA) {
    throw new Error('Set G4_SOURCE_HOME and G4_SOURCE_USERDATA to the HOME and user-data copies to clone')
  }
  await Promise.all([
    requirePath(PACKAGED_APP, 'Packaged Phi executable'),
    requirePath(SOURCE_HOME, 'Acceptance HOME source'),
    requirePath(SOURCE_USERDATA, 'Acceptance user-data source')
  ])

  await mkdir(RUNS_ROOT, { recursive: true, mode: 0o700 })
  const runDir = path.join(RUNS_ROOT, timestampForPath())
  const home = path.join(runDir, 'home')
  const userdata = path.join(runDir, 'userdata')
  const project = path.join(runDir, 'project')
  const shots = path.join(runDir, 'shots')
  await mkdir(runDir, { recursive: true, mode: 0o700 })
  await mkdir(shots, { recursive: true, mode: 0o700 })

  await Promise.all([runClone(SOURCE_HOME, home), runClone(SOURCE_USERDATA, userdata)])
  await removeChromiumLocks(userdata)

  await mkdir(project, { recursive: true, mode: 0o700 })
  const marker = `g4-readme-${randomBytes(8).toString('hex')}`
  const readme = [`# G4 acceptance project`, marker, 'This file belongs to the isolated acceptance run.'].join(
    '\n'
  )
  await writeFile(path.join(project, 'README.md'), `${readme}\n`, { mode: 0o600 })

  return {
    runDir,
    home,
    userdata,
    project,
    shots,
    marker,
    resultsPath: path.join(runDir, 'results.json'),
    summaryPath: path.join(runDir, 'summary.md'),
    consolePath: path.join(runDir, 'console.log'),
    metadataPath: path.join(runDir, 'run-metadata.json')
  }
}

export function launchPackagedApp(run, port) {
  const inherited = {}
  for (const key of [
    'PATH',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SHELL',
    'USER',
    'LOGNAME',
    'SSH_AUTH_SOCK',
    '__CF_USER_TEXT_ENCODING'
  ]) {
    if (process.env[key]) inherited[key] = process.env[key]
  }
  const processHandle = Bun.spawn(
    [
      PACKAGED_APP,
      `--user-data-dir=${run.userdata}`,
      `--remote-debugging-port=${port}`
    ],
    {
      cwd: run.runDir,
      env: {
        ...inherited,
        HOME: run.home
      },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true
    }
  )
  return processHandle
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch {
    return false
  }
}

export async function terminateOwnedProcessTree(processHandle) {
  if (!processHandle?.pid) return
  const pid = processHandle.pid
  let signalledGroup = false
  try {
    process.kill(-pid, 'SIGTERM')
    signalledGroup = true
  } catch {
    if (processExists(pid)) {
      try {
        processHandle.kill('SIGTERM')
      } catch {
        return
      }
    }
  }
  const deadline = Date.now() + 5_000
  while (
    Date.now() < deadline &&
    (signalledGroup ? processGroupExists(pid) : processExists(pid))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (signalledGroup ? !processGroupExists(pid) : !processExists(pid)) return
  try {
    if (signalledGroup) process.kill(-pid, 'SIGKILL')
    else processHandle.kill('SIGKILL')
  } catch {
    // The process tree exited between checks.
  }
}

export async function writeRunMetadata(run, values) {
  await writeFile(
    run.metadataPath,
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        packagedApp: PACKAGED_APP,
        homeClone: run.home,
        userDataClone: run.userdata,
        project: run.project,
        ...values
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
}
