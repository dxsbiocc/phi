import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { officePlatformId } from '../../scripts/office/fetch-officecli.mjs'
import { runOfficeCli } from '../../src/main/agent/office/office-driver'
import { releaseTransientOfficeResident } from '../../src/main/agent/office/office-process'
import { officeBinaryCandidates } from '../../src/main/agent/office/office-runtime'
import { createPhiSession } from '../../src/main/agent/session/session-store'

const platformId = officePlatformId()
const bundledOfficeDir = join(process.cwd(), 'resources', 'office')
const binary = platformId ? officeBinaryCandidates(platformId, { bundledOfficeDir })[0] : undefined
const enabled = process.env.PHI_OFFICE_INTEGRATION === '1' && !!binary && existsSync(binary)

export const officeRecoveryIntegrationOptions = {
  skip: enabled ? false : 'set PHI_OFFICE_INTEGRATION=1 and run bun run office:fetch'
}

export function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export async function cliJson(args: readonly string[]): Promise<Record<string, unknown>> {
  const result = await runOfficeCli(binary!, [...args, '--json'], { timeoutMs: 30_000 })
  assert.equal(result.exitCode, 0, result.stderr || result.stdout)
  const body = JSON.parse(result.stdout) as Record<string, unknown>
  assert.equal(body.success, true)
  return body
}

export async function closeTransient(path: string): Promise<void> {
  await releaseTransientOfficeResident(binary!, path)
}

export async function formatSource(path: string): Promise<void> {
  const commands = JSON.stringify([
    {
      command: 'set',
      path: '/Sheet1/A1:B1',
      props: { bold: true, fill: '#FFEEAA' }
    },
    { command: 'set', path: '/Sheet1/B2:B3', props: { numfmt: '0.00' } }
  ])
  await cliJson(['batch', path, '--commands', commands])
  await cliJson(['save', path])
  await closeTransient(path)
}

export async function workbookEvidence(path: string): Promise<readonly unknown[]> {
  const results = await Promise.all([
    cliJson(['get', path, '/', '--depth', '1']),
    cliJson(['get', path, '/Sheet1/A1:B4']),
    cliJson(['get', path, '/说明/A1:A2'])
  ])
  return results.map((result) => result.data)
}

export function createOfficeRecoverySession(root: string): ReturnType<typeof createPhiSession> {
  return createPhiSession({
    kind: 'ordinary',
    cwd: root,
    cwdRealPath: root,
    permissionMode: 'auto'
  })
}

export function artifactDirectories(sessionDir: string): string[] {
  const root = join(sessionDir, 'artifacts', 'office')
  return existsSync(root) ? readdirSync(root).sort() : []
}

export function psAvailable(): boolean {
  try {
    execFileSync('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'command='], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface ResidentProcess {
  readonly pid: number
  readonly command: string
}

/** Live `__resident-serve__` daemons whose command line mentions every given fragment. */
export function residentProcesses(...fragments: string[]): ResidentProcess[] {
  const listing = execFileSync('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'command='], {
    encoding: 'utf8'
  })
  return listing
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }))
    .filter(
      (process) =>
        process.command.includes('__resident-serve__') &&
        fragments.every((fragment) => process.command.includes(fragment))
    )
}
