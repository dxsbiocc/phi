import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRemoteWorkspaceBashTool } from '../src/main/agent/remote-workspace-bash-tool'
import { buildRemoteWorkspaceEditTool } from '../src/main/agent/remote-workspace-edit-tool'
import {
  buildRemoteWorkspaceGlobTool,
  buildRemoteWorkspaceGrepTool
} from '../src/main/agent/remote-workspace-search-tools'
import { pickDeclaredToolInput } from '../src/main/agent/remote-workspace-tool-input'

// The agent harness adds an `i` intent note to every tool call; the remote boundary rejects it.
const HARNESS_FIELDS = { i: 'List all project files', intent: 'x', extra: 1 }

async function executeTool(
  tool: ReturnType<typeof buildRemoteWorkspaceGlobTool>,
  params: Record<string, unknown>
): Promise<void> {
  const execute = tool.execute as unknown as (
    toolCallId: string,
    params: Record<string, unknown>,
    onUpdate?: unknown,
    ctx?: unknown,
    signal?: AbortSignal
  ) => Promise<unknown>
  await execute('call-1', params, undefined, undefined, undefined)
}

test('pickDeclaredToolInput keeps declared keys only and tolerates non-objects', () => {
  const schema = { properties: { path: {}, limit: {} } }
  assert.deepEqual(pickDeclaredToolInput({ path: '/a', limit: 5, i: 'note' }, schema), {
    path: '/a',
    limit: 5
  })
  assert.deepEqual(pickDeclaredToolInput(null, schema), {})
  assert.deepEqual(pickDeclaredToolInput(['path'], schema), {})
})

test('remote glob forwards only its declared fields', async () => {
  let received: Record<string, unknown> | undefined
  const tool = buildRemoteWorkspaceGlobTool(async (input) => {
    received = input as Record<string, unknown>
    return {
      paths: [],
      content: '',
      truncated: false,
      engine: 'find',
      gitignoreApplied: false
    }
  })
  await executeTool(tool, { path: '/p', hidden: true, limit: 200, ...HARNESS_FIELDS })
  assert.deepEqual(received, { path: '/p', hidden: true, limit: 200 })
})

test('remote grep forwards only its declared fields', async () => {
  let received: Record<string, unknown> | undefined
  const tool = buildRemoteWorkspaceGrepTool(async (input) => {
    received = input as Record<string, unknown>
    return {
      matches: [],
      content: '',
      fileCount: 0,
      matchCount: 0,
      truncated: false,
      engine: 'find',
      gitignoreApplied: false
    }
  })
  await executeTool(tool, { pattern: 'abc', path: '/p', case: true, ...HARNESS_FIELDS })
  assert.deepEqual(received, { pattern: 'abc', path: '/p', case: true })
})

test('remote edit forwards only its declared fields', async () => {
  let received: Record<string, unknown> | undefined
  const tool = buildRemoteWorkspaceEditTool(async (_id, input) => {
    received = input as Record<string, unknown>
    return { status: 'updated', path: '/p/a', oldText: 'a', newText: 'b' } as never
  })
  await executeTool(tool, {
    path: '/p/a',
    old_string: 'a',
    new_string: 'b',
    replace_all: false,
    ...HARNESS_FIELDS
  })
  assert.deepEqual(received, {
    path: '/p/a',
    old_string: 'a',
    new_string: 'b',
    replace_all: false
  })
})

test('remote bash forwards only its declared fields', async () => {
  let received: Record<string, unknown> | undefined
  const tool = buildRemoteWorkspaceBashTool(async (_id, input) => {
    received = input as Record<string, unknown>
    return {
      status: 'completed',
      hostAlias: 'h',
      cwd: '/p',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
      wallTimeMs: 1
    } as never
  })
  await executeTool(tool, { command: 'ls', timeout: 5, ...HARNESS_FIELDS })
  assert.deepEqual(received, { command: 'ls', timeout: 5 })
})
