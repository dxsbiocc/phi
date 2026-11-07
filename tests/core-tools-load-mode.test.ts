import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildEnvRequestTool } from '../src/main/agent/content/env-request-tool'
import { buildSkillRunTool } from '../src/main/agent/content/skill-tools'
import { toOmpCustomTool } from '../src/main/agent/engine/tool-adapter'
import type { PhiTool } from '../src/main/agent/engine/types'
import { buildNotebookCustomTools } from '../src/main/agent/notebook/notebook-tools'
import { buildWrapperCompositionTools } from '../src/main/agent/wrappers/composition/tools'
import type { WrapperJobClient } from '../src/main/agent/wrappers/composition/job-types'

const noRequest = async (): Promise<unknown> => ({})

function coreTools(): PhiTool[] {
  return [
    ...buildNotebookCustomTools(noRequest),
    buildSkillRunTool(noRequest),
    buildEnvRequestTool(noRequest, { requireEnvironment: false } as never),
    ...buildWrapperCompositionTools({} as WrapperJobClient)
  ]
}

test('core research tools are essential in the shared kernel runtime', () => {
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

  for (const tool of tools) {
    assert.equal(tool.loadMode, 'essential', `${tool.name} must be essential`)
    assert.equal(toOmpCustomTool(tool).loadMode, 'essential', `${tool.name} in-process`)
  }
})

test('the retained MCP host adapter keeps its tools discoverable', () => {
  const source = readFileSync('src/main/agent/engine/rpc/desktop-mcp-adapter.ts', 'utf8')
  assert.match(source, /loadMode: 'discoverable'/)
  assert.doesNotMatch(source, /loadMode: 'essential'/)
})
