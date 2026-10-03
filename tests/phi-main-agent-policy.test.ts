import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPhiMainSystemPrompt,
  buildPhiRemoteProjectSystemPrompt,
  filterPersonaContextFile
} from '../src/main/agent/main-system-prompt'
import { parseAgentReport } from '../src/main/agent/agents/report'
import { projectToolBoundaryDecision } from '../src/main/agent/agents/project-tool-boundary'
import { remoteUrlGuardDecision } from '../src/main/agent/agents/remote-url-guard'
import {
  createRemoteProjectToolGuardExtension,
  remoteProjectToolDecision
} from '../src/main/agent/agents/remote-project-tool-guard'
import { PHI_REMOTE_READ_DESCRIPTION } from '../src/main/agent/remote-workspace-read-tool'
import { PHI_REMOTE_BASH_DESCRIPTION } from '../src/main/agent/remote-workspace-bash-tool'
import { PHI_REMOTE_WRITE_DESCRIPTION } from '../src/main/agent/remote-workspace-write-tool'
import { PHI_REMOTE_EDIT_DESCRIPTION } from '../src/main/agent/remote-workspace-edit-tool'
import {
  PHI_REMOTE_GLOB_DESCRIPTION,
  PHI_REMOTE_GREP_DESCRIPTION
} from '../src/main/agent/remote-workspace-search-tools'

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
})

test('remote project guard blocks built-in and Phi custom tools before local execution', async () => {
  for (const name of ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'powershell', 'Wrapper']) {
    const decision = remoteProjectToolDecision(name)
    assert.ok(decision)
    assert.equal(decision.block, true)
    assert.match(decision.reason, /没有在本机执行/)
  }
  let handler: ((event: { toolName: string }) => Promise<unknown>) | undefined
  createRemoteProjectToolGuardExtension()({
    on: (event: string, callback: typeof handler) => {
      if (event === 'tool_call') handler = callback
    },
    getAllTools: () => [
      { name: 'read', description: 'Local Read', sourceInfo: { source: 'builtin' } }
    ]
  } as never)
  assert.ok(handler)
  assert.deepEqual(await handler({ toolName: 'read' }), remoteProjectToolDecision('read'))

  let verifiedHandler: typeof handler
  createRemoteProjectToolGuardExtension()({
    on: (event: string, callback: typeof handler) => {
      if (event === 'tool_call') verifiedHandler = callback
    },
    getAllTools: () => [
      {
        name: 'read',
        description: PHI_REMOTE_READ_DESCRIPTION,
        sourceInfo: { source: 'extension' }
      },
      {
        name: 'bash',
        description: PHI_REMOTE_BASH_DESCRIPTION,
        sourceInfo: { source: 'extension' }
      },
      {
        name: 'glob',
        description: PHI_REMOTE_GLOB_DESCRIPTION,
        sourceInfo: { source: 'extension' }
      },
      {
        name: 'grep',
        description: PHI_REMOTE_GREP_DESCRIPTION,
        sourceInfo: { source: 'extension' }
      },
      {
        name: 'write',
        description: PHI_REMOTE_WRITE_DESCRIPTION,
        sourceInfo: { source: 'extension' }
      },
      {
        name: 'edit',
        description: PHI_REMOTE_EDIT_DESCRIPTION,
        sourceInfo: { source: 'extension' }
      },
      ...[
        'Wrapper',
        'agent_status',
        'agent_wait',
        'agent_steer',
        'agent_stop',
        'wrapper_search',
        'wrapper_inspect'
      ].map((name) => ({ name, description: 'Phi safe tool', sourceInfo: { source: 'extension' } }))
    ]
  } as never)
  assert.ok(verifiedHandler)
  assert.equal(await verifiedHandler({ toolName: 'read' }), undefined)
  assert.equal(remoteProjectToolDecision('read', true), undefined)
  assert.equal(await verifiedHandler({ toolName: 'bash' }), undefined)
  assert.equal(remoteProjectToolDecision('bash', false, true), undefined)
  assert.equal(await verifiedHandler({ toolName: 'glob' }), undefined)
  assert.equal(await verifiedHandler({ toolName: 'grep' }), undefined)
  assert.equal(await verifiedHandler({ toolName: 'write' }), undefined)
  assert.equal(remoteProjectToolDecision('write', false, false, false, false, true), undefined)
  assert.equal(await verifiedHandler({ toolName: 'edit' }), undefined)
  assert.equal(
    remoteProjectToolDecision('edit', false, false, false, false, false, true),
    undefined
  )
  for (const name of [
    'Wrapper',
    'agent_status',
    'agent_wait',
    'agent_steer',
    'agent_stop',
    'wrapper_search',
    'wrapper_inspect'
  ]) {
    assert.equal(await verifiedHandler({ toolName: name }), undefined)
  }
  for (const name of [
    'wrapper_run',
    'wrapper_cancel',
    'ast_edit',
    'project_download',
    'powershell'
  ]) {
    assert.equal((await verifiedHandler({ toolName: name }))?.block, true)
  }

  let builtinHandler: typeof handler
  createRemoteProjectToolGuardExtension()({
    on: (event: string, callback: typeof handler) => {
      if (event === 'tool_call') builtinHandler = callback
    },
    getAllTools: () => [
      { name: 'read', description: PHI_REMOTE_READ_DESCRIPTION, sourceInfo: { source: 'builtin' } }
    ]
  } as never)
  assert.ok(builtinHandler)
  assert.equal((await builtinHandler({ toolName: 'read' }))?.block, true)
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
