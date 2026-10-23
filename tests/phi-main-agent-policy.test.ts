import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPhiMainSystemPrompt,
  buildPhiRemoteProjectSystemPrompt,
  filterPersonaContextFile
} from '../src/main/agent/main-system-prompt'
import { parseAgentReport } from '../src/main/agent/agents/report'
import {
  projectToolBoundaryDecision,
  remoteUrlGuardDecision
} from '../src/main/agent/engine/phi-extension'

test('Phi owns the main system identity while retaining OMP runtime instructions', () => {
  const defaults = [
    [
      '<system-conventions>runtime</system-conventions>',
      '§ Role',
      'Helpful, trusted assistant for load-bearing changes in Oh My Pi coding harness.',
      '§ Runtime',
      'Keep this operational tool contract.'
    ].join('\n')
  ]
  const prompt = buildPhiMainSystemPrompt(defaults, {
    personaMarkdown: '# 助手人设\n\n名字叫星河，回答简洁。'
  })
  const rendered = prompt.join('\n\n')

  assert.match(prompt[0], /^§ Phi Role/)
  assert.match(prompt[2], /Keep this operational tool contract/)
  assert.match(rendered, /You are the assistant running in Phi/i)
  assert.match(rendered, /scientific research assistant/i)
  assert.match(rendered, /interpret the user's request before choosing tools or delegation/i)
  assert.match(rendered, /名字叫星河/)
  assert.match(rendered, /Keep this operational tool contract/)
  assert.match(rendered, /present_files/)
  assert.match(rendered, /render_blocks/)
  assert.match(
    rendered,
    /use capability_search.*Phi-provided wrappers, connectors, skills or plugins first/
  )
  assert.match(rendered, /explicit user approval.*automatic permission mode/)
  assert.match(rendered, /Only when the application catalog has no suitable module.*find_skills/)
  assert.match(rendered, /tabular results.*QC metrics.*progress/i)
  assert.match(rendered, /otherwise use Markdown/i)
  assert.match(rendered, /A parent directory alone is not a file list/)
  assert.match(rendered, /delivery card supplements the closing reply/)
  assert.doesNotMatch(rendered, /assistant for load-bearing changes in Oh My Pi/i)
  assert.ok(rendered.indexOf('Phi') < rendered.indexOf('名字叫星河'))
})

test('remote project prompt presents the server root without exposing the SDK anchor', () => {
  const anchor = '/home/user/.phi/remote-project-anchors/project-1'
  const remoteRoot = '/cluster/project'
  const prompt = buildPhiRemoteProjectSystemPrompt(
    [`Today; current working directory: '${anchor}'.`, `Workspace: ${anchor}`],
    anchor,
    remoteRoot
  ).join('\n')
  assert.doesNotMatch(prompt, /remote-project-anchors/)
  assert.match(prompt, /\/cluster\/project/)
  assert.match(prompt, /Delegate Wrapper runs and run control/)
  assert.match(prompt, /temporarily unavailable/)
  assert.match(prompt, /interactive SSH shell/u)
  assert.match(prompt, /writes nothing to the PTY until the user explicitly sends/u)
  assert.match(prompt, /not automatically reconnected/u)
})

test('the Phi-managed persona file is removed from generic context after explicit injection', () => {
  const result = filterPersonaContextFile(
    {
      agentsFiles: [
        { path: '/home/user/.phi/AGENTS.md', content: 'persona' },
        { path: '/project/AGENTS.md', content: 'project rules' }
      ]
    },
    '/home/user/.phi/AGENTS.md'
  )
  assert.deepEqual(result.agentsFiles, [{ path: '/project/AGENTS.md', content: 'project rules' }])
})

test('project boundary blocks explicit shell and file paths outside the project', () => {
  const cwd = process.cwd()
  assert.equal(
    projectToolBoundaryDecision(cwd, 'bash', {
      command: `mkdir -p ${cwd}/../GSE180012`
    }).allowed,
    false
  )
  assert.equal(
    projectToolBoundaryDecision(cwd, 'write', { path: '../GSE180012/result.csv' }).allowed,
    false
  )
  assert.equal(projectToolBoundaryDecision(cwd, 'bash', { command: 'cd ..' }).allowed, false)
  assert.equal(
    projectToolBoundaryDecision(cwd, 'bash', { command: 'mkdir -p results/GSE180012' }).allowed,
    true
  )
  assert.equal(
    projectToolBoundaryDecision(cwd, 'bash', { command: "sed -n '/error/p' output.log" }).allowed,
    true
  )
})

test('raw SDK ssh URLs are blocked before file or shell tools route them', () => {
  assert.equal(
    remoteUrlGuardDecision('read', { path: 'ssh://unconfigured-host/etc/hosts' }).allowed,
    false
  )
  assert.equal(
    remoteUrlGuardDecision('write', { path: 'ssh://other-host/tmp/x', content: 'x' }).allowed,
    false
  )
  assert.equal(remoteUrlGuardDecision('grep', { paths: ['ssh://other-host/tmp/x'] }).allowed, false)
  assert.equal(
    remoteUrlGuardDecision('bash', { command: 'cat ssh://other-host/tmp/x' }).allowed,
    false
  )
  assert.equal(
    remoteUrlGuardDecision('write', { path: 'notes.md', content: 'ssh://example/path' }).allowed,
    true
  )
})

test('structured specialist reports preserve prose and expose blocked state', () => {
  const parsed = parseAgentReport(`
<phi_agent_result>{"status":"blocked","missingInputs":["NCBI API key"],"fallbackReason":"rate limited","nextAgent":null}</phi_agent_result>

NCBI refused the request after the connector retry policy was exhausted.
`)
  assert.equal(parsed.status, 'blocked')
  assert.equal(parsed.structured, true)
  assert.deepEqual(parsed.missingInputs, ['NCBI API key'])
  assert.equal(parsed.fallbackReason, 'rate limited')
  assert.match(parsed.text, /connector retry policy/)
  assert.doesNotMatch(parsed.text, /phi_agent_result/)
})

test('legacy specialist prose remains a completed report for compatibility', () => {
  assert.deepEqual(parseAgentReport('  Retrieved Q92748.  '), {
    status: 'completed',
    text: 'Retrieved Q92748.',
    missingInputs: [],
    structured: false
  })
})
