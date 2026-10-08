import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { LocalHost } from '../src/main/agent/workspace-host/local-host'
import { runWorkspaceHostContract } from './workspace-host-contract'

runWorkspaceHostContract((root) => new LocalHost(root))

test('WorkspaceHost types stay independent of transport-specific concepts', async () => {
  const path = fileURLToPath(new URL('../src/main/agent/workspace-host/types.ts', import.meta.url))
  const source = await readFile(path, 'utf8')

  for (const forbidden of [/\bssh\b/i, /\bhostAlias\b/i, /\bperl\b/i, /\bshell\b/i]) {
    assert.doesNotMatch(source, forbidden)
  }
})
