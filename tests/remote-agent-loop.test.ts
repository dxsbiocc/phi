import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'

const bunAvailable = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0

test(
  'a real agent loop runs remote file, command, skill, plugin skill and MCP tools',
  { skip: !bunAvailable },
  () => {
    const result = spawnSync(
      'bun',
      [join(process.cwd(), 'tests', 'helpers', 'remoteAgentLoopSmoke.ts')],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024
      }
    )
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      toolResults: Array<{ toolName: string; isError: boolean; text: string }>
      requests: string[]
      file: string | null
      modelCalls: number
    }
    const failures = output.toolResults.filter((entry) => entry.isError)
    assert.deepEqual(failures, [], 'every scripted tool call succeeds')
    assert.deepEqual(output.toolResults.map((entry) => entry.toolName).sort(), [
      'bash',
      'edit',
      'glob',
      'grep',
      'mcp__fixture_first',
      'plg_json',
      'read',
      'remotedemo_json',
      'skill_run',
      'skill_run',
      'write'
    ])
    // Each tool reached its main-process handler; none ran in the local session anchor.
    assert.deepEqual([...new Set(output.requests)].sort(), [
      'remoteWorkspace.bash',
      'remoteWorkspace.edit',
      'remoteWorkspace.glob',
      'remoteWorkspace.grep',
      'remoteWorkspace.read',
      'remoteWorkspace.write',
      'skills.run',
      'skills.scriptTool'
    ])
    const text = (name: string): string =>
      output.toolResults.find((entry) => entry.toolName === name)?.text ?? ''
    assert.match(text('read'), /^alpha/)
    assert.match(text('bash'), /beta/)
    assert.match(text('glob'), /notes\/a\.txt/)
    assert.match(text('grep'), /notes\/a\.txt:1:beta/)
    const skillRuns = output.toolResults.filter((entry) => entry.toolName === 'skill_run')
    assert.ok(skillRuns.some((entry) => /\|hello\|dependency/.test(entry.text)))
    assert.ok(skillRuns.some((entry) => /\|plugin\|dependency/.test(entry.text)))
    assert.match(text('remotedemo_json'), /"message": "hi"/)
    // A plugin skill's script tool takes the plugin's prefix and runs on the server too.
    assert.match(text('plg_json'), /"message": "from-plugin"/)
    assert.equal(output.file, 'beta\n')
    // The application MCP server receives exactly the model's arguments, without the intent field.
    assert.deepEqual(JSON.parse(text('mcp__fixture_first')), {
      tool: 'fixture_first',
      arguments: { query: 'from-mcp' }
    })
    assert.equal(output.modelCalls, 8)
  }
)
