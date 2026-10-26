import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { PhiSessionCreateParams } from '../../src/main/agent/engine/types'
import { localProcessTree, PeakTreeSampler } from './process-tree'

/** Same-run legacy-route comparison. Failure is evidence absence, never a synthetic pass. */
export async function measureSameRunLegacyFourSession(
  projectFiles: number
): Promise<number | null> {
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
    sampler.start()
    try {
      const ids = Array.from({ length: 4 }, (_, index) => `legacy-a20-${index}`)
      for (const sessionId of ids) {
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
                command: process.execPath,
                args: [
                  resolve('tests/helpers/fixtureMcpServer.mjs'),
                  join(dirname(fixture.cwd), `${sessionId}-mcp.json`),
                  'success'
                ],
                cwd: fixture.cwd
              }
            }
          ]
        }
        await fixture.engine.sessions.create(params)
      }
      fixture.provider.enqueue(...ids.map((sessionId) => ({ text: `legacy ${sessionId}` })))
      await Promise.all(
        ids.map((sessionId) =>
          fixture.engine.sessions.prompt({ sessionId, text: 'Legacy A20 comparison.' })
        )
      )
      await sampler.once()
      return Math.round(sampler.peakMb * 10) / 10
    } finally {
      await sampler.stop().catch(() => undefined)
      await fixture.close()
    }
  } catch {
    return null
  }
}
