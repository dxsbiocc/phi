import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { taskAdmissionCli, taskProbeFrames } from './helpers/rpcTaskAdmissionCli'

function shellLiteral(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

for (const admission of [false, true])
  test(`actual Python availability preflight ${admission ? 'has zero executable effects under production task admission' : 'executes a project interpreter before native eval child startup'}`, async (t) => {
    const fixture = await taskAdmissionCli({
      admission,
      pythonOnlyPreflight: true,
      prepare: async ({ root, cwd, nativeName }) => {
        const bin = join(cwd, '.venv/bin')
        const agents = join(cwd, '.omp/agents')
        await mkdir(bin, { recursive: true, mode: 0o700 })
        await mkdir(agents, { recursive: true, mode: 0o700 })
        // A real executable candidate, launched by the SDK's availability probe.
        // No eval cell is requested; this script need not implement a kernel.
        await writeFile(
          join(bin, 'python'),
          '#!/bin/sh\nprintf \'%s\\n\' "$@" >> ' +
            shellLiteral(join(root, 'python-preflight-argv')) +
            '\nexit 0\n',
          { mode: 0o700 }
        )
        await writeFile(
          join(agents, nativeName + '.md'),
          `---\nname: ${nativeName}\ndescription: Controlled native eval startup sentinel\nmodel: [fixture/model]\ntools: [eval]\nblocking: true\n---\nPROJECT_EVAL_PREFLIGHT_SENTINEL\n`,
          { mode: 0o600 }
        )
      }
    })
    try {
      const marker = join(fixture.root, 'python-preflight-argv')
      // Root's real startup has already completed with tools=[task].
      await assert.rejects(access(marker), { code: 'ENOENT' })
      await fixture.connection.prompt('Use the real native task for the startup interpreter seam')
      await fixture.connection.prompt('/phi-task-startup-observe')
      const snapshot = taskProbeFrames(fixture, 'phi_task_startup_snapshot').at(-1)
      const observations = snapshot?.observations as Array<Record<string, unknown>>
      const child = observations.find((value) => value.kind === 'sub')
      const starts = fixture.frames.filter(
        (frame) =>
          frame.type === 'subagent_lifecycle' &&
          (frame.payload as { status?: string }).status === 'started'
      )
      const childRequests = fixture.requests.filter((request) => request.actor === 'child')
      assert.equal(childRequests.length, admission ? 0 : 1)
      assert.equal(starts.length, admission ? 0 : 1)
      if (admission) {
        assert.equal(child, undefined)
        await assert.rejects(access(marker), { code: 'ENOENT' })
      } else {
        assert.ok(child)
        assert.ok((child.tools as string[]).includes('eval'))
        assert.ok(child.parentSession)
        assert.equal((starts[0].payload as { agentSource?: string }).agentSource, 'project')
        // Exactly one real SDK -c probe; no Python kernel/eval execution follows.
        assert.equal(await readFile(marker, 'utf8'), '-c\nimport sys;sys.exit(0)\n')
      }
      t.diagnostic(
        JSON.stringify({
          admission,
          nativeChildStarts: starts.length,
          childProviderRequests: childRequests.length
        })
      )
    } finally {
      await fixture.close()
    }
  })
