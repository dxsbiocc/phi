import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildEnvRequestTool } from '../src/main/agent/content/env-request-tool'
import { buildSkillRunTool } from '../src/main/agent/content/skill-tools'
import { toOmpCustomTool } from '../src/main/agent/engine/tool-adapter'
import { registeredHostTools } from '../src/main/agent/engine/rpc/host-tool-validation'
import type { PhiTool } from '../src/main/agent/engine/types'
import { buildNotebookCustomTools } from '../src/main/agent/notebook/notebook-tools'
import { buildWrapperCompositionTools } from '../src/main/agent/wrappers/composition/tools'
import type { WrapperJobClient } from '../src/main/agent/wrappers/composition/job-host-client'

const noRequest = async (): Promise<unknown> => ({})

function coreTools(): PhiTool[] {
  return [
    ...buildNotebookCustomTools(noRequest),
    buildSkillRunTool(noRequest),
    buildEnvRequestTool(noRequest, { requireEnvironment: false } as never),
    ...buildWrapperCompositionTools({} as WrapperJobClient)
  ]
}

test('core research tools are essential in the in-process and RPC host registries', () => {
  const tools = coreTools()
  const names = tools.map((tool) => tool.name)
  for (const expected of [
    'notebook_list',
    'notebook_read',
    'notebook_insert_cell',
    'notebook_update_cell',
    'notebook_delete_cell',
    'notebook_run_cell',
    'notebook_save',
    'skill_run',
    'env_request',
    'wrapper_search',
    'wrapper_run',
    'wrapper_cancel'
  ])
    assert.ok(names.includes(expected), `missing ${expected}`)

  const registered = registeredHostTools(tools)
  for (const tool of tools) {
    assert.equal(tool.loadMode, 'essential', `${tool.name} must be essential`)
    assert.equal(toOmpCustomTool(tool).loadMode, 'essential', `${tool.name} in-process`)
    assert.equal(registered.get(tool.name)?.definition.loadMode, 'essential', `${tool.name} rpc`)
  }
})

test('MCP and web search adapters keep their tools discoverable', () => {
  for (const file of ['desktop-mcp-adapter.ts', 'desktop-websearch-adapter.ts']) {
    const source = readFileSync(`src/main/agent/engine/rpc/${file}`, 'utf8')
    assert.match(source, /loadMode: 'discoverable'/, file)
    assert.doesNotMatch(source, /loadMode: 'essential'/, file)
  }
})
