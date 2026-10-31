import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

const AI = 'node_modules/@oh-my-pi/pi-ai/src/providers/cursor.ts'
const AGENT = 'node_modules/@oh-my-pi/pi-coding-agent/src/cursor.ts'
const OUTPUT = 'node_modules/@oh-my-pi/pi-coding-agent/src/task/output-manager.ts'

function source(path: string): string {
  return readFileSync(path, 'utf8')
}

// The bridge lives in patches/. An OMP upgrade that drops it must fail here, not in a user's chat.
it('keeps the OMP patch that runs Cursor Task through the task tool', () => {
  const pkg = JSON.parse(source('package.json')) as {
    patchedDependencies?: Record<string, string>
    dependencies: Record<string, string>
  }
  const version = pkg.dependencies['@oh-my-pi/pi-coding-agent']
  assert.ok(pkg.patchedDependencies?.[`@oh-my-pi/pi-ai@${version}`])
  assert.ok(pkg.patchedDependencies?.[`@oh-my-pi/pi-coding-agent@${version}`])

  const provider = source(AI)
  assert.match(provider, /execHandlers\?\.subagent && requestContextTools\.some/)
  assert.match(provider, /execHandlers\?\.subagentAwait && requestContextTools\.some/)
  const bridge = source(AGENT)
  assert.match(bridge, /executeTool\(this\.options, "task", call\.toolCallId, call\.args\)/)
  assert.match(bridge, /CURSOR_TASK_WAIT_ATTEMPTS/)
  assert.match(bridge, /executeTool\(this\.options, "wait", call\.toolCallId, call\.args\)/)
  assert.match(source(OUTPUT), /AgentRegistry\.global\(\)\.get/)
})

it('maps Cursor subagent types onto Phi agents', () => {
  const output = execFileSync(
    'bun',
    [
      '--eval',
      `import { cursorSubagentTaskArgs as map } from '@oh-my-pi/pi-ai/providers/cursor'
      console.log(JSON.stringify([map('explore', 'look'), map('generalPurpose', 'do it')]))`
    ],
    { encoding: 'utf8' }
  )
  const [explore, general] = JSON.parse(output) as Array<Record<string, unknown>>
  assert.equal(explore.agent, 'scout')
  assert.equal(general.agent, 'task')
  assert.equal(general.task, 'do it')
  assert.equal(typeof general.solutionSpace, 'string')
})

it('keeps agents of one kernel process inside their own session', () => {
  const output = execFileSync(
    'bun',
    [
      '--eval',
      `import { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry'
      const registry = new AgentRegistry()
      const add = (id, kind, sessionFile) =>
        registry.register({ id, displayName: id, kind, session: null, sessionFile, status: 'running' })
      add('main-a', 'main', '/s/a/journal.jsonl')
      add('main-b', 'main', '/s/b/journal.jsonl')
      add('child-a', 'sub', '/s/a/journal/child-a.jsonl')
      add('peer-a', 'sub', '/s/a/journal/peer-a.jsonl')
      add('child-b', 'sub', '/s/b/journal/child-b.jsonl')
      console.log(JSON.stringify(registry.listVisibleTo('child-a').map((ref) => ref.id).sort()))`
    ],
    { encoding: 'utf8' }
  )
  assert.deepEqual(JSON.parse(output), ['main-a', 'peer-a'])
})

it('avoids a child name another session in the process already uses', () => {
  const output = execFileSync(
    'bun',
    [
      '--eval',
      `import { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry'
      import { AgentOutputManager } from '@oh-my-pi/pi-coding-agent/task/output-manager'
      AgentRegistry.global().register({ id: 'ReadmeHead', displayName: 'x', kind: 'sub', session: null, sessionFile: null, status: 'running' })
      const manager = new AgentOutputManager(() => null)
      console.log(await manager.allocate('ReadmeHead'))`
    ],
    { encoding: 'utf8' }
  )
  assert.equal(output.trim(), 'ReadmeHead-2')
})
