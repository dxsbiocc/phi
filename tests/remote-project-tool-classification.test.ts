import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRemoteProjectToolGuardExtension,
  remoteProjectToolDecision
} from '../src/main/agent/agents/remote-project-tool-guard'
import { PHI_REMOTE_DOWNLOAD_DESCRIPTION } from '../src/main/agent/download/remote-project-download-tool'
import { PHI_REMOTE_PRESENT_FILES_DESCRIPTION } from '../src/main/agent/deliverables/remote-present-tool'
import { PHI_ENV_REQUEST_DESCRIPTION } from '../src/main/agent/content/env-request-tool'
import { PHI_SKILL_RUN_DESCRIPTION } from '../src/main/agent/content/skill-tools'
import {
  NOTEBOOK_TOOL_DESCRIPTIONS,
  NOTEBOOK_TOOL_NAMES
} from '../src/main/agent/notebook/notebook-tools'

type ToolInfo = { name: string; description: string; sourceInfo: { source: string } }

function guard(
  tools: ToolInfo[],
  dynamicSkillToolNames: ReadonlySet<string> = new Set(),
  dynamicAgentToolNames: ReadonlySet<string> = new Set(),
  dynamicAgentToolDescriptions: ReadonlyMap<string, string> = new Map(
    [...dynamicAgentToolNames].map((name) => [
      name,
      tools.find((tool) => tool.name === name)?.description ?? ''
    ])
  )
): (event: { toolName: string }) => Promise<unknown> {
  let handler: ((event: { toolName: string }) => Promise<unknown>) | undefined
  createRemoteProjectToolGuardExtension({
    dynamicSkillToolNames: () => dynamicSkillToolNames,
    dynamicAgentToolNames: () => dynamicAgentToolNames,
    dynamicAgentToolDescriptions: () => dynamicAgentToolDescriptions
  })({
    on: (event: string, callback: typeof handler) => {
      if (event === 'tool_call') handler = callback
    },
    getAllTools: () => tools
  } as never)
  assert.ok(handler)
  return handler
}

test('remote guard releases a dynamic agent only for one registered non-builtin tool', async () => {
  const extension = {
    name: 'Researcher',
    description: 'Remote Researcher agent',
    sourceInfo: { source: 'extension' }
  }
  assert.equal(
    await guard([extension], new Set(), new Set(['Researcher']))({ toolName: 'Researcher' }),
    undefined
  )

  for (const tools of [
    [{ ...extension, sourceInfo: { source: 'builtin' } }],
    [{ ...extension, sourceInfo: { source: 'mcp' } }],
    [extension, { ...extension }]
  ]) {
    const decision = await guard(
      tools,
      new Set(),
      new Set(['Researcher'])
    )({ toolName: 'Researcher' })
    assert.equal((decision as { block?: boolean }).block, true)
  }
  const undeclared = await guard([extension])({ toolName: 'Researcher' })
  assert.equal((undeclared as { block?: boolean }).block, true)

  const changedDescription = await guard(
    [{ ...extension, description: 'Changed description' }],
    new Set(),
    new Set(['Researcher']),
    new Map([['Researcher', extension.description]])
  )({ toolName: 'Researcher' })
  assert.equal((changedDescription as { block?: boolean }).block, true)

  const duplicateWrapper = await guard(
    [
      { ...extension, name: 'Wrapper' },
      { ...extension, name: 'Wrapper' }
    ],
    new Set(),
    new Set(['Wrapper'])
  )({ toolName: 'Wrapper' })
  assert.equal((duplicateWrapper as { block?: boolean }).block, true)
})

test('remote guard releases verified project-independent tools one by one', async () => {
  const handler = guard(
    [
      ...[
        'browser',
        'ask_user_question',
        'palette_suggest',
        'render_blocks',
        'Wrapper',
        'agent_status'
      ].map((name) => ({
        name,
        description: `Phi ${name}`,
        sourceInfo: { source: 'extension' }
      })),
      { name: 'web_search', description: 'Web search', sourceInfo: { source: 'builtin' } }
    ],
    new Set(),
    new Set(['Wrapper'])
  )

  assert.equal(await handler({ toolName: 'web_search' }), undefined)
  for (const name of [
    'browser',
    'ask_user_question',
    'palette_suggest',
    'render_blocks',
    'Wrapper',
    'agent_status'
  ]) {
    assert.equal(await handler({ toolName: name }), undefined, name)
  }
})

test('remote guard releases only verified runtime and declared dynamic skill backends', async () => {
  const verified = guard(
    [
      {
        name: 'skill_run',
        description: PHI_SKILL_RUN_DESCRIPTION,
        sourceInfo: { source: 'extension' }
      },
      {
        name: 'env_request',
        description: PHI_ENV_REQUEST_DESCRIPTION,
        sourceInfo: { source: 'extension' }
      },
      {
        name: 'demo_analyze',
        description: 'Remote dynamic tool',
        sourceInfo: { source: 'extension' }
      }
    ],
    new Set(['demo_analyze'])
  )
  assert.equal(await verified({ toolName: 'skill_run' }), undefined)
  assert.equal(await verified({ toolName: 'env_request' }), undefined)
  assert.equal(await verified({ toolName: 'demo_analyze' }), undefined)

  const impostor = guard(
    [
      {
        name: 'skill_run',
        description: PHI_SKILL_RUN_DESCRIPTION,
        sourceInfo: { source: 'builtin' }
      },
      {
        name: 'env_request',
        description: 'local environment tool',
        sourceInfo: { source: 'extension' }
      },
      {
        name: 'demo_analyze',
        description: 'Builtin impostor',
        sourceInfo: { source: 'builtin' }
      }
    ],
    new Set(['demo_analyze'])
  )
  for (const name of ['skill_run', 'env_request', 'demo_analyze', 'unknown_dynamic']) {
    assert.equal(((await impostor({ toolName: name })) as { block?: boolean }).block, true, name)
  }

  const sdkImpostor = guard(
    [
      {
        name: 'skill_run',
        description: PHI_SKILL_RUN_DESCRIPTION,
        sourceInfo: { source: 'sdk' }
      },
      {
        name: 'env_request',
        description: PHI_ENV_REQUEST_DESCRIPTION,
        sourceInfo: { source: 'sdk' }
      },
      {
        name: 'demo_analyze',
        description: 'SDK impostor',
        sourceInfo: { source: 'sdk' }
      }
    ],
    new Set(['demo_analyze'])
  )
  for (const name of ['skill_run', 'env_request', 'demo_analyze']) {
    assert.equal(((await sdkImpostor({ toolName: name })) as { block?: boolean }).block, true, name)
  }
})

test('web_search release verifies the builtin without resolving project paths', async () => {
  let registrationsRead = 0
  let handler: ((event: { toolName: string }) => Promise<unknown>) | undefined
  createRemoteProjectToolGuardExtension()({
    on: (_event: string, callback: typeof handler) => {
      handler = callback
    },
    getAllTools: () => {
      registrationsRead += 1
      return [{ name: 'web_search', description: 'Web search', sourceInfo: { source: 'builtin' } }]
    }
  } as never)
  assert.ok(handler)
  assert.equal(await handler({ toolName: 'web_search' }), undefined)
  assert.equal(registrationsRead, 1)

  const impostor = guard([
    { name: 'web_search', description: 'Plugin search', sourceInfo: { source: 'extension' } }
  ])
  assert.equal(((await impostor({ toolName: 'web_search' })) as { block?: boolean }).block, true)
})

test('remote guard requires an exact verified backend for file-backed B tools', async () => {
  const verified = guard([
    {
      name: 'download_file',
      description: PHI_REMOTE_DOWNLOAD_DESCRIPTION,
      sourceInfo: { source: 'extension' }
    },
    {
      name: 'present_files',
      description: PHI_REMOTE_PRESENT_FILES_DESCRIPTION,
      sourceInfo: { source: 'extension' }
    }
  ])
  assert.equal(await verified({ toolName: 'download_file' }), undefined)
  assert.equal(await verified({ toolName: 'present_files' }), undefined)

  const impostors = guard([
    {
      name: 'download_file',
      description: PHI_REMOTE_DOWNLOAD_DESCRIPTION,
      sourceInfo: { source: 'builtin' }
    },
    {
      name: 'present_files',
      description: 'local presentation',
      sourceInfo: { source: 'extension' }
    }
  ])
  assert.equal(
    ((await impostors({ toolName: 'download_file' })) as { block?: boolean }).block,
    true
  )
  assert.equal(
    ((await impostors({ toolName: 'present_files' })) as { block?: boolean }).block,
    true
  )
})

test('remote guard releases only the seven exactly registered notebook backends', async () => {
  const registrations = NOTEBOOK_TOOL_NAMES.map((name) => ({
    name,
    description: NOTEBOOK_TOOL_DESCRIPTIONS.get(name)!,
    sourceInfo: { source: 'extension' }
  }))
  const verified = guard(registrations)
  for (const name of NOTEBOOK_TOOL_NAMES) {
    assert.equal(await verified({ toolName: name }), undefined, name)
  }

  for (const name of NOTEBOOK_TOOL_NAMES) {
    const expected = NOTEBOOK_TOOL_DESCRIPTIONS.get(name)!
    for (const tools of [
      registrations.filter((tool) => tool.name !== name),
      registrations.map((tool) =>
        tool.name === name ? { ...tool, description: `${expected} changed` } : tool
      ),
      registrations.map((tool) =>
        tool.name === name ? { ...tool, sourceInfo: { source: 'builtin' } } : tool
      ),
      [...registrations, { name, description: expected, sourceInfo: { source: 'builtin' } }]
    ]) {
      const decision = await guard(tools)({ toolName: name })
      assert.equal((decision as { block?: boolean }).block, true, name)
    }
  }

  for (const name of ['notebook.unknown', 'lib.save', 'lib.list']) {
    const decision = await verified({ toolName: name })
    assert.equal((decision as { block?: boolean }).block, true, name)
  }

  const dynamicImpostor = guard(
    [
      {
        name: 'notebook.run_cell',
        description: 'Skill-defined notebook impostor',
        sourceInfo: { source: 'extension' }
      }
    ],
    new Set(['notebook.run_cell'])
  )
  assert.equal(
    ((await dynamicImpostor({ toolName: 'notebook.run_cell' })) as { block?: boolean }).block,
    true
  )
})

test('remote guard explains local-only tools and never blanket-allows MCP or task', () => {
  assert.match(remoteProjectToolDecision('office_apply')?.reason ?? '', /本机 Office/)
  assert.match(remoteProjectToolDecision('office_apply')?.reason ?? '', /下载到本机|服务器/)
  assert.match(remoteProjectToolDecision('notebook.run_cell')?.reason ?? '', /本机 Jupyter/)
  assert.match(remoteProjectToolDecision('lib.save')?.reason ?? '', /本机项目文献库/)
  for (const name of ['task', 'mcp__server_tool', 'skill_run', 'env_request']) {
    const decision = remoteProjectToolDecision(name)
    assert.equal(decision?.block, true, name)
    assert.match(decision?.reason ?? '', /没有在本机执行/)
  }
  assert.match(remoteProjectToolDecision('task')?.reason ?? '', /Wrapper.*agent_\*/)
  assert.match(remoteProjectToolDecision('mcp__server_tool')?.reason ?? '', /WorkspaceHost/)
  assert.match(remoteProjectToolDecision('lsp')?.reason ?? '', /远程 read\/grep\/edit\/bash/)
})

test('terminal draft IPC stays available outside the guard while same-named tools are refused', async () => {
  for (const source of ['extension', 'builtin']) {
    const handler = guard([
      {
        name: 'terminal:generateDraft',
        description: 'Impostor terminal draft tool',
        sourceInfo: { source }
      }
    ])
    const decision = (await handler({ toolName: 'terminal:generateDraft' })) as {
      block?: boolean
      reason?: string
    }
    assert.equal(decision.block, true)
    assert.match(decision.reason ?? '', /renderer\/main IPC/u)
    assert.match(decision.reason ?? '', /同名或伪造/u)
  }
})
