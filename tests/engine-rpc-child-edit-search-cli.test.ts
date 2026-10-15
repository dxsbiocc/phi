import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { childAuthorityCli, childUntil } from './helpers/rpcChildAuthorityCli'
import type { ChildProviderToolCall } from './helpers/rpcChildAuthorityProvider'

const sequence = (cwd: string): readonly ChildProviderToolCall[] => [
  { name: 'read', args: { path: join(cwd, 'read-input.txt') }, id: 'resource-read' },
  {
    name: 'edit',
    args: {
      path: join(cwd, 'read-input.txt'),
      old_string: 'REAL_PRODUCTION_CHILD_READ',
      new_string: 'CHILD_EDIT_CONFIRMED'
    },
    id: 'resource-edit'
  },
  { name: 'glob', args: { path: join(cwd, '*.txt') }, id: 'resource-glob' },
  {
    name: 'grep',
    args: { path: join(cwd, 'read-input.txt'), pattern: 'CHILD_EDIT_CONFIRMED' },
    id: 'resource-grep'
  }
]
for (const mode of ['approve', 'deny', 'stop'] as const)
  test(`genuine child native edit/search: ${mode}`, { timeout: 30000 }, async () => {
    let release!: (value: 'approved') => void
    const f = await childAuthorityCli({
      nativeSequence: sequence,
      nativeTools: ['read', 'edit', 'glob', 'grep'],
      editMode: 'replace',
      decision:
        mode === 'approve'
          ? () => 'approved'
          : mode === 'deny'
            ? () => 'denied'
            : () =>
                new Promise((resolve) => {
                  release = resolve
                })
    })
    try {
      const pending = f.connection.prompt('Read, edit and search only the trusted project file')
      if (mode === 'stop') {
        await childUntil(() => f.approvals.length === 1, 'owned pending edit approval')
        await f.authority.cancelParent('private-parent-run')
        release('approved')
      }
      await pending
      const content = await readFile(join(f.cwd, 'read-input.txt'), 'utf8')
      assert.equal(
        content,
        mode === 'approve' ? 'CHILD_EDIT_CONFIRMED\n' : 'REAL_PRODUCTION_CHILD_READ\n'
      )
      assert.equal(f.approvals.length, 1)
      assert.equal(f.approvals[0].toolName, 'edit')
      if (mode === 'approve') {
        const child = f.requests.filter((request) => request.actor === 'child')
        assert.equal(child.length, 5)
        assert.ok(
          child.some((request) =>
            JSON.stringify(request.body.messages).includes('CHILD_EDIT_CONFIRMED')
          )
        )
        assert.deepEqual(child[0].body.tools.map((tool) => tool.function.name).sort(), [
          'edit',
          'glob',
          'grep',
          'read'
        ])
      }
    } finally {
      await f.close()
    }
  })
