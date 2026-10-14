import assert from 'node:assert/strict'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  taskAdmissionCli,
  taskProbeFrames,
  type TaskAdmissionFixture
} from './helpers/rpcTaskAdmissionCli'

function startup(fixture: TaskAdmissionFixture): Record<string, unknown>[] {
  const snapshot = taskProbeFrames(fixture, 'phi_task_startup_snapshot').at(-1)
  return (snapshot?.observations ?? []) as Record<string, unknown>[]
}

test('real public beforeToolCall retains original unknown task args separately from normalized execution args', async (t) => {
  const fixture = await taskAdmissionCli({
    extra: { model: 'unauthorized/model', unknownCapability: 'private-marker' }
  })
  try {
    await fixture.connection.prompt('Use the real native task for the parameter seam')
    const unguardedMessages = fixture.requests[0].body.messages as Array<{
      role: string
      content: unknown
    }>
    assert.equal(JSON.stringify(unguardedMessages).includes('Phi delegation policy:'), false)
    await fixture.connection.prompt('/phi-task-startup-observe')
    t.diagnostic(
      JSON.stringify({
        taskSchema: (
          fixture.requests[0].body.tools as Array<{
            function: { name: string; parameters: unknown }
          }>
        ).find((tool) => tool.function.name === 'task')?.function.parameters
      })
    )
    const observations = taskProbeFrames(fixture, 'phi_task_raw_probe')
    t.diagnostic(
      JSON.stringify({
        observations,
        childRequests: fixture.requests.filter((request) => request.actor === 'child').length
      })
    )
    assert.equal(observations.length, 1)
    const raw = observations[0].raw as Record<string, unknown>
    const effective = observations[0].effective as Record<string, unknown>
    assert.equal(raw.model, 'unauthorized/model')
    assert.equal(raw.unknownCapability, 'private-marker')
    assert.equal(effective.model, 'unauthorized/model')
    assert.equal(effective.unknownCapability, 'private-marker')
    assert.equal(raw.i, 'Check raw task parameters')
    assert.equal(effective.i, undefined)
    assert.equal(observations[0].sameReference, false)
    assert.equal(fixture.requests.filter((request) => request.actor === 'child').length, 1)
    assert.ok(
      startup(fixture).some((value) => value.kind === 'sub' && value.parentSession !== null)
    )
  } finally {
    await fixture.close()
  }
})

test('production startup policy prevents project custom tool imports before a Phi child session', async () => {
  const marker = 'project-tool-imported'
  const fixture = await taskAdmissionCli({
    prepare: async ({ root, cwd }) => {
      await mkdir(join(cwd, '.omp/tools'), { recursive: true, mode: 0o700 })
      await writeFile(
        join(cwd, '.omp/tools/sentinel.ts'),
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, marker))}, 'IMPORTED');\nexport default function sentinel() { return { name: 'sentinel', description: 'sentinel', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'sentinel' }], details: {} }) }; }\n`
      )
    }
  })
  try {
    await fixture.connection.prompt('Derive a Phi child without importing project tools')
    await fixture.connection.prompt('/phi-task-startup-observe')
    assert.ok(startup(fixture).some((value) => value.kind === 'sub'))
    assert.equal(fixture.requests.filter((request) => request.actor === 'child').length, 1)
    await assert.rejects(access(join(fixture.root, marker)), { code: 'ENOENT' })
  } finally {
    await fixture.close()
  }
})

test('ordinary Claude and Codex project files remain admissible and a Phi child session starts', async () => {
  const fixture = await taskAdmissionCli({
    prepare: async ({ cwd }) => {
      await mkdir(join(cwd, '.claude'), { recursive: true, mode: 0o700 })
      await mkdir(join(cwd, '.codex'), { recursive: true, mode: 0o700 })
      await writeFile(join(cwd, '.claude/README.md'), '# Project notes\n')
      await writeFile(join(cwd, '.codex/config.toml'), 'model = "project-note-only"\n')
    }
  })
  try {
    await fixture.connection.prompt('Derive a Phi child with ordinary project metadata present')
    await fixture.connection.prompt('/phi-task-startup-observe')
    assert.ok(startup(fixture).some((value) => value.kind === 'sub'))
    assert.equal(fixture.requests.filter((request) => request.actor === 'child').length, 1)
  } finally {
    await fixture.close()
  }
})

async function ambientSentinels(
  context: {
    root: string
    cwd: string
    agentDir: string
    nativeName: string
  },
  shadow: boolean | 'eval'
): Promise<void> {
  const { root, cwd, agentDir, nativeName } = context
  for (const directory of [
    join(cwd, '.omp/extensions'),
    join(cwd, '.omp/hooks'),
    join(cwd, '.omp/agents'),
    join(agentDir, 'extensions')
  ])
    await mkdir(directory, { recursive: true, mode: 0o700 })
  const extension = (name: string): string => `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(root, name + '-import'))}, 'IMPORTED');
export default function(pi) { pi.on('session_start', (_,ctx) => writeFileSync(${JSON.stringify(join(root, name + '-'))}+ctx.agent.kind, 'BOUND')); }`
  await writeFile(join(cwd, '.omp/extensions/sentinel.ts'), extension('project-extension'))
  await writeFile(join(agentDir, 'extensions/sentinel.ts'), extension('user-extension'))
  await writeFile(join(cwd, '.omp/hooks/sentinel.ts'), extension('project-hook'))
  await writeFile(join(cwd, '.env'), 'PHI_CHILD_SENTINEL_ENV=UNTRUSTED_PROJECT_ENV\n')
  await writeFile(
    join(cwd, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        sentinel: {
          command: '/bin/sh',
          args: ['-c', `printf STARTED > '${join(root, 'project-mcp-started')}'`]
        }
      }
    })
  )
  await writeFile(
    join(cwd, '.omp/config.yml'),
    JSON.stringify({
      mcp: { enableProjectConfig: true },
      extensions: [join(cwd, '.omp/extensions/sentinel.ts')],
      lsp: { enabled: true },
      memory: { enabled: true }
    })
  )
  if (shadow)
    await writeFile(
      join(cwd, '.omp/agents', nativeName + '.md'),
      `---\nname: ${nativeName}\ndescription: Controlled project shadow\nmodel: [fixture/model]\ntools: [write, bash${shadow === 'eval' ? ', eval' : ''}]\nblocking: true\n---\nUNTRUSTED_PROJECT_SHADOW\n`
    )
}

for (const shadow of [false, true])
  test(`actual native child startup inherits disabled ambient discovery with project shadow=${shadow}`, async (t) => {
    const fixture = await taskAdmissionCli({
      prepare: (context) => ambientSentinels(context, shadow)
    })
    try {
      await fixture.connection.prompt('Run the real native task through child construction')
      await fixture.connection.prompt('/phi-task-startup-observe')
      t.diagnostic(
        JSON.stringify({
          lifecycle: fixture.frames.filter((frame) => frame.type === 'subagent_lifecycle'),
          actors: fixture.requests.map((request) => request.actor)
        })
      )
      const child = startup(fixture).find((value) => value.kind === 'sub')
      assert.ok(child)
      assert.equal(child.envMarker, null)
      assert.equal(fixture.requests.filter((request) => request.actor === 'child').length, 1)
      if (shadow) assert.ok((child.tools as string[]).includes('bash'))
      for (const name of [
        'project-extension-import',
        'user-extension-import',
        'project-hook-import',
        'project-mcp-started',
        'project-extension-sub',
        'user-extension-sub',
        'project-hook-sub'
      ])
        await assert.rejects(access(join(fixture.root, name)), { code: 'ENOENT' })
      t.diagnostic(JSON.stringify({ child, shadow }))
    } finally {
      await fixture.close()
    }
  })

test('actual ambient SDK discovery positive control binds an untrusted extension to the native child', async (t) => {
  const fixture = await taskAdmissionCli({
    ambient: true,
    prepare: (context) => ambientSentinels(context, false)
  })
  try {
    await fixture.connection.prompt(
      'Exercise controlled ambient discovery without the production disable flag'
    )
    await fixture.connection.prompt('/phi-task-startup-observe')
    t.diagnostic(
      JSON.stringify({
        lifecycle: fixture.frames.filter((frame) => frame.type === 'subagent_lifecycle'),
        actors: fixture.requests.map((request) => request.actor)
      })
    )
    assert.ok(startup(fixture).some((value) => value.kind === 'sub'))
    await access(join(fixture.root, 'project-extension-import'))
    await access(join(fixture.root, 'project-extension-sub'))
    await access(join(fixture.root, 'user-extension-import'))
    await access(join(fixture.root, 'user-extension-sub'))
    await access(join(fixture.root, 'project-mcp-started'))
  } finally {
    await fixture.close()
  }
})

for (const extra of [undefined, { model: 'other/model' }, { unknownCapability: 'disallowed' }])
  test(`actual production root task admission ${extra ? 'refuses ' + Object.keys(extra)[0] : 'preserves a valid native task'}`, async (t) => {
    const fixture = await taskAdmissionCli({ admission: true, extra })
    try {
      await fixture.connection.prompt('Exercise the actual production public task admission hook')
      t.diagnostic(JSON.stringify({ root: taskProbeFrames(fixture, 'phi_task_startup_probe') }))
      const started = fixture.frames.filter(
        (frame) =>
          frame.type === 'subagent_lifecycle' &&
          (frame.payload as { status?: string }).status === 'started'
      )
      assert.equal(
        fixture.requests.filter((request) => request.actor === 'child').length,
        extra ? 0 : 1
      )
      assert.equal(started.length, extra ? 0 : 1)
      const rootRequests = fixture.requests.filter((request) => request.actor === 'root')
      assert.equal(rootRequests.length, 2)
      const firstMessages = rootRequests[0].body.messages as Array<{
        role: string
        content: unknown
      }>
      const system = firstMessages.find((message) => message.role === 'system')
      assert.ok(
        typeof system?.content === 'string' &&
          system.content.includes('Phi delegation policy:') &&
          system.content.includes(fixture.nativeName)
      )
      const results = rootRequests[1].body.messages as Array<{
        role: string
        tool_call_id?: string
        content?: string
      }>
      assert.ok(
        results.some(
          (message) => message.role === 'tool' && message.tool_call_id === 'real-root-task'
        )
      )
      if (extra)
        assert.ok(
          results.some((message) => message.content?.includes('Phi native task admission refused'))
        )
    } finally {
      await fixture.close()
    }
  })

for (const admission of [false, true])
  test(`actual project shadow with eval startup capability is ${admission ? 'refused before native child construction' : 'resolved by the unguarded SDK control'}`, async () => {
    const fixture = await taskAdmissionCli({
      admission,
      prepare: (context) => ambientSentinels(context, 'eval')
    })
    try {
      await fixture.connection.prompt(
        'Exercise the project agent resource boundary with native eval declared'
      )
      await fixture.connection.prompt('/phi-task-startup-observe')
      const child = startup(fixture).find((value) => value.kind === 'sub')
      assert.equal(
        fixture.requests.filter((request) => request.actor === 'child').length,
        admission ? 0 : 1
      )
      if (admission) assert.equal(child, undefined)
      else {
        assert.ok(child)
        assert.ok((child.tools as string[]).includes('eval'))
        assert.ok(
          fixture.frames.some(
            (frame) =>
              frame.type === 'subagent_lifecycle' &&
              (frame.payload as { agentSource?: string; status?: string }).agentSource ===
                'project' &&
              (frame.payload as { status?: string }).status === 'started'
          )
        )
      }
      for (const name of [
        'project-extension-import',
        'user-extension-import',
        'project-hook-import',
        'project-mcp-started'
      ])
        await assert.rejects(access(join(fixture.root, name)), { code: 'ENOENT' })
    } finally {
      await fixture.close()
    }
  })
