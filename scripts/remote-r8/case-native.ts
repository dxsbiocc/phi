import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { shellQuote as q } from '../../src/main/agent/wrappers/remote-ssh-session'
import { readSessionEvents } from '../../src/main/agent/session/session-store'
import { journal, toolResultText, type CaseContext } from './case-context'

/** Case 1: native search, read, edit and bash with real ask-mode approvals and remote effects. */
export async function runNativeCase(c: CaseContext): Promise<void> {
  const { remote, app, markers } = c
  const proxy = await c.attach(c.phiSessionId, false)
  c.proxy = proxy
  await writeFile(join(app.anchor, 'bash.txt'), 'LOCAL_BASH_SENTINEL', { mode: 0o600, flag: 'wx' })
  const before = app.provider.requests.length
  app.provider.enqueue(
    { tool: { name: 'glob', id: 'r8-glob', args: { path: '*.txt' } } },
    {
      tool: {
        name: 'grep',
        id: 'r8-grep',
        args: { pattern: markers.original, path: 'input.txt' }
      }
    },
    { tool: { name: 'read', id: 'r8-read', args: { path: 'input.txt' } } },
    {
      tool: {
        name: 'edit',
        id: 'r8-edit',
        args: { path: 'input.txt', old_string: markers.original, new_string: markers.edited }
      }
    },
    {
      tool: {
        name: 'bash',
        id: 'r8-bash',
        args: {
          command: `cat input.txt; printf '%s\\n' ${q(markers.bash)} > bash.txt; cat bash.txt`
        }
      }
    },
    { text: 'Native search, read, edit and bounded run completed.' }
  )
  const at = performance.now()
  const work = c.run(
    proxy,
    'Search the owned text file, read it, edit only its unique marker and run the bounded confirmation.'
  )
  await work.done
  assert.equal(work.outcome, 'completed')
  const requests = app.provider.requests
  assert.equal(requests.length, before + 6)
  assert.match(toolResultText(requests[before + 1], 'r8-glob'), /input\.txt/)
  assert.match(toolResultText(requests[before + 2], 'r8-grep'), new RegExp(markers.original))
  assert.match(toolResultText(requests[before + 3], 'r8-read'), new RegExp(markers.original))
  assert.match(toolResultText(requests[before + 5], 'r8-bash'), new RegExp(markers.edited))
  assert.match(toolResultText(requests[before + 5], 'r8-bash'), new RegExp(markers.bash))
  assert.doesNotMatch(JSON.stringify(requests), /LOCAL_ANCHOR_SENTINEL|LOCAL_BASH_SENTINEL/)
  assert.deepEqual(
    c.tools.map((t) => t.name),
    ['glob', 'grep', 'read', 'edit', 'bash']
  )
  assert.ok(
    c.tools.every((t) => !t.isError),
    'Every native tool must really succeed'
  )
  assert.equal(
    await remote.command(`cat -- ${q(posix.join(remote.projectRoot, 'input.txt'))}`),
    markers.edited + '\n'
  )
  assert.equal(
    await remote.command(`cat -- ${q(posix.join(remote.projectRoot, 'bash.txt'))}`),
    markers.bash + '\n'
  )
  assert.equal(await readFile(join(app.anchor, 'input.txt'), 'utf8'), 'LOCAL_ANCHOR_SENTINEL')
  assert.equal(await readFile(join(app.anchor, 'bash.txt'), 'utf8'), 'LOCAL_BASH_SENTINEL')
  assert.deepEqual(
    readSessionEvents(c.phiSessionId)
      .filter((e) => e.runId === work.runId && e.type.startsWith('approval_'))
      .map((e) => e.type),
    ['approval_requested', 'approval_approved', 'approval_requested', 'approval_approved']
  )
  const saved = await journal(remote, c.phiSessionId)
  c.complete({
    case: 'native-search-read-edit-bash',
    phiSessionId: c.phiSessionId,
    ompSessionId: saved.ompSessionId,
    journalPath: saved.path,
    providerRequests: 6,
    elapsedMs: performance.now() - at,
    toolRoundTrips: c.tools.slice(),
    remoteEffects: true,
    localAnchorUnchanged: true,
    approvalsPersistedOnce: true
  })
}
