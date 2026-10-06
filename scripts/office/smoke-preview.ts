import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const buildDir = mkdtempSync(join(tmpdir(), 'phi-office-smoke-build-'))
const workDir = mkdtempSync(join(tmpdir(), 'phi-office-smoke-work-'))
const screenshotDir = mkdtempSync(join(tmpdir(), 'phi-office-smoke-shots-'))
const hostOutput = join(buildDir, 'smoke-preview-host.mjs')
const signedElectronApp = join(buildDir, 'Electron.app')

function run(command: string, args: string[], env = process.env): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolveOutput(stdout)
      else
        reject(
          new Error(
            `${command} exited ${String(code)} signal=${String(signal)}\n${stdout}\n${stderr}`
          )
        )
    })
  })
}

async function main(): Promise<void> {
  let completed = false
  try {
    await run('bun', [
      'build',
      'scripts/office/smoke-preview-host.ts',
      '--target=node',
      '--format=esm',
      `--outfile=${hostOutput}`,
      '--external=electron'
    ])
    await run('/usr/bin/ditto', [
      resolve(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app'),
      signedElectronApp
    ])
    await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', signedElectronApp])
    const stdout = await run(
      join(signedElectronApp, 'Contents', 'MacOS', 'Electron'),
      [hostOutput],
      {
        ...process.env,
        PHI_OFFICE_TEST_HOOKS: '1',
        PI_CODING_AGENT_DIR: join(workDir, 'phi'),
        PHI_OFFICE_SMOKE_SOURCE: join(repoRoot, 'tests', 'fixtures', 'office', 'sample.xlsx'),
        PHI_OFFICE_SMOKE_BINARY: join(
          repoRoot,
          'resources',
          'office',
          'officecli',
          'darwin-arm64',
          'officecli'
        ),
        PHI_OFFICE_SMOKE_SCREENSHOTS: screenshotDir,
        PHI_OFFICE_SMOKE_WORKDIR: workDir
      }
    )
    const resultLine = stdout.split('\n').find((line) => line.startsWith('OFFICE_SMOKE_RESULT '))
    if (!resultLine) throw new Error(`Smoke result missing\n${stdout}`)
    process.stdout.write(`${resultLine}\n`)
    completed = true
  } finally {
    rmSync(buildDir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
    if (!completed) rmSync(screenshotDir, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
