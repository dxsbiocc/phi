import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { PhiSessionCreateParams } from '../../src/main/agent/engine/types'
import type { ProcessSample } from './process-tree'
import { localProcessTree, PeakTreeSampler } from './process-tree'

export interface LegacyFourSessionMeasurement {
  readonly peakRssMb: number | null
  readonly failure: string | null
  readonly processTree: readonly ProcessSample[]
  readonly mcpSessionsVerified: number
}

const execFileAsync = promisify(execFile)

interface McpSnapshot {
  readonly pid: number
  readonly methods: readonly string[]
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause === undefined ? '' : `; caused by ${describeError(error.cause)}`
  return `${error.name}: ${error.message}${cause}`
}

function verifiedMcpPids(
  paths: readonly string[],
  processTree: readonly ProcessSample[]
): number[] {
  const snapshots = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as McpSnapshot)
  const missingHandshake = snapshots.filter(
    (snapshot) =>
      !snapshot.methods.includes('initialize') || !snapshot.methods.includes('tools/list')
  )
  if (missingHandshake.length > 0) {
    throw new Error(`${missingHandshake.length} legacy stdio MCP servers did not finish discovery.`)
  }
  const processIds = new Set(processTree.map((entry) => entry.pid))
  const missing = snapshots.map((snapshot) => snapshot.pid).filter((pid) => !processIds.has(pid))
  if (missing.length > 0) {
    throw new Error(
      `Legacy stdio MCP PIDs were absent from the worker process tree: ${missing.join(', ')}.`
    )
  }
  return snapshots.map((snapshot) => snapshot.pid)
}

/** Runs under Node because the legacy fixture imports the Node-only `node:sqlite` module. */
async function measureLegacyInNode(
  projectFiles: number,
  rounds: number
): Promise<LegacyFourSessionMeasurement> {
  try {
    const { stdout } = await execFileAsync(
      process.env.PHI_NODE_BINARY ?? 'node',
      [
        '--import',
        resolve('scripts/test-loader.mjs'),
        resolve('scripts/kernel-perf/legacy-worker.ts'),
        String(projectFiles),
        String(rounds),
        process.execPath
      ],
      { cwd: resolve('.'), encoding: 'utf8', maxBuffer: 1024 * 1024 }
    )
    return JSON.parse(stdout) as LegacyFourSessionMeasurement
  } catch (error) {
    return {
      peakRssMb: null,
      failure: describeError(error),
      processTree: [],
      mcpSessionsVerified: 0
    }
  }
}

/** Same-run legacy-route comparison. Failure is recorded exactly, never converted to a bare null. */
export async function measureSameRunLegacyFourSession(
  projectFiles: number,
  rounds: number
): Promise<LegacyFourSessionMeasurement> {
  return process.versions.bun
    ? measureLegacyInNode(projectFiles, rounds)
    : measureSameRunLegacyFourSessionInProcess(projectFiles, rounds, process.execPath)
}

export async function measureSameRunLegacyFourSessionInProcess(
  projectFiles: number,
  rounds: number,
  mcpExecutable: string
): Promise<LegacyFourSessionMeasurement> {
  try {
    const { createInProcessFixture } =
      await import('../../tests/engine-contract/in-process-factory')
    const fixture = await createInProcessFixture()
    for (let index = 0; index < projectFiles; index += 1) {
      const directory = join(fixture.cwd, `group-${Math.floor(index / 100)}`)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, `file-${index}.txt`), `candidate fixture ${index}\n`)
    }
    const skill = join(fixture.cwd, '.phi', 'skills', 'candidate-perf', 'SKILL.md')
    mkdirSync(dirname(skill), { recursive: true })
    writeFileSync(skill, '# Candidate perf\n\nLegacy comparison fixture.\n')
    const runnerPid = process.pid
    const sampler = new PeakTreeSampler(() =>
      localProcessTree(runnerPid).filter((entry) => entry.pid !== runnerPid)
    )
    let mcpSessionsVerified = 0
    sampler.start()
    try {
      for (let round = 0; round < rounds; round += 1) {
        const ids = Array.from({ length: 4 }, (_, index) => `legacy-a20-${round}-${index}`)
        const snapshots = ids.map((sessionId) =>
          join(dirname(fixture.cwd), `${sessionId}-mcp.json`)
        )
        await Promise.all(
          ids.map((sessionId, index) => {
            const params: PhiSessionCreateParams = {
              sessionId,
              cwd: fixture.cwd,
              agentDir: fixture.agentDir,
              model: fixture.model,
              sessionManager: { kind: 'memory', cwd: fixture.cwd },
              enableToolApproval: false,
              autoCompaction: { enabled: false },
              resourceOptions: {
                noExtensions: true,
                noSkills: false,
                noContextFiles: true,
                noPromptTemplates: true,
                noThemes: true
              },
              mcpServers: [
                {
                  name: `candidate-${sessionId}`,
                  config: {
                    type: 'stdio',
                    command: mcpExecutable,
                    args: [
                      resolve('tests/helpers/fixtureMcpServer.mjs'),
                      snapshots[index],
                      'success'
                    ],
                    cwd: fixture.cwd
                  }
                }
              ]
            }
            return fixture.engine.sessions.create(params)
          })
        )
        await sampler.once()
        mcpSessionsVerified += verifiedMcpPids(snapshots, sampler.latest).length
        fixture.provider.enqueue(...ids.map((sessionId) => ({ text: `legacy ${sessionId}` })))
        await Promise.all(
          ids.map((sessionId) =>
            fixture.engine.sessions.prompt({ sessionId, text: 'Legacy A20 comparison.' })
          )
        )
        await sampler.once()
        await Promise.all(ids.map((sessionId) => fixture.engine.sessions.dispose({ sessionId })))
      }
      return {
        peakRssMb: Math.round(sampler.peakMb * 10) / 10,
        failure: null,
        processTree: sampler.peakTree,
        mcpSessionsVerified
      }
    } finally {
      await sampler.stop().catch(() => undefined)
      await fixture.close()
    }
  } catch (error) {
    return {
      peakRssMb: null,
      failure: describeError(error),
      processTree: [],
      mcpSessionsVerified: 0
    }
  }
}
