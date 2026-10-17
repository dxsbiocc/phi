import assert from 'node:assert/strict'
import { posix } from 'node:path'

import { shellQuote as q } from '../../src/main/agent/wrappers/remote-ssh-session'
import { findPhiSessionById } from '../../src/main/agent/session/session-store'
import { readColdChildRuns } from '../../src/main/agent/session/child-run-recovery'
import type { RpcChildRuntimeConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import { toolResultText, type CaseContext } from './case-context'
import { INSPECTOR_AGENT } from './types'

/** Case 2: one real blocking child, read-only, with the verified completed child snapshot. */
export async function runChildCase(c: CaseContext): Promise<void> {
  const { remote, app, markers } = c
  const proxy = c.proxy
  assert.ok(proxy)
  const nonce = remote.rpc.at(-1)?.nonce
  assert.ok(nonce)
  const config = JSON.parse(
    await remote.command(
      `cat -- ${q(posix.join(remote.runtimeRoot, 'rpc-sessions', nonce, 'child-runtime.json'))}`
    )
  ) as RpcChildRuntimeConfig
  assert.equal(config.phiSessionId, c.phiSessionId)
  assert.equal(config.projectId, app.projectId)
  assert.equal(config.projectRoot, remote.projectRoot)
  const selected = config.profiles.filter(
    (profile) => profile.definition.phiName === INSPECTOR_AGENT && profile.definition.blocking
  )
  assert.equal(selected.length, 1)
  assert.deepEqual(
    selected[0].definition.tools.map((tool) => tool.name),
    ['read']
  )
  const before = app.provider.requests.length
  const childBefore = app.purposes.child
  const childText = 'R8_CHILD_READ_CONFIRMED ' + markers.edited
  app.provider.enqueue(
    {
      tool: {
        name: 'task',
        id: 'r8-task',
        args: {
          i: 'Inspect the edited file once',
          agent: selected[0].definition.nativeName,
          name: 'r8-inspector',
          task: 'Read input.txt once and report the unique R8_EDITED marker.',
          solutionSpace: 'Read only the owned project input.txt and finish.'
        }
      }
    },
    {
      tool: {
        name: 'read',
        id: 'r8-child-read',
        args: { path: posix.join(remote.projectRoot, 'input.txt') }
      }
    },
    { text: childText },
    { text: 'Original parent received the one child inspection.' }
  )
  const at = performance.now()
  const parent = c.run(
    proxy,
    'Delegate one blocking inspection to the trusted R8Inspector, receive its result, then finish.'
  )
  await parent.done
  assert.equal(parent.outcome, 'completed')
  const requests = app.provider.requests
  assert.equal(requests.length, before + 4)
  assert.equal(
    app.purposes.child - childBefore,
    2,
    'A genuine child must make its own model/tool requests'
  )
  assert.match(toolResultText(requests[before + 2], 'r8-child-read'), new RegExp(markers.edited))
  assert.match(toolResultText(requests[before + 3], 'r8-task'), new RegExp(childText))
  const ref = findPhiSessionById(c.phiSessionId)?.runtimeRef
  assert.ok(ref)
  const children = readColdChildRuns({ phiSessionId: c.phiSessionId, reference: ref })
  assert.equal(children.length, 1)
  const child = children[0]
  assert.equal(child.agent, INSPECTOR_AGENT)
  assert.equal(child.status, 'completed')
  assert.equal(child.verified, true)
  assert.equal(child.background, false)
  assert.equal(child.generation, config.generation)
  assert.equal(child.parentRunId, parent.runId)
  assert.equal(child.parentToolCallId, 'r8-task')
  assert.ok(child.childOmpSessionId && child.childOmpSessionId !== ref.ompSessionId)
  assert.ok(child.childSessionFile)
  const persisted = await remote.command(`cat -- ${q(child.childSessionFile)}`)
  assert.match(persisted, new RegExp(markers.edited))
  assert.equal(proxy.hasActiveAgentRuns?.(), false)
  assert.deepEqual(
    c.tools.filter((t) => t.name === 'task').map((t) => t.isError),
    [false]
  )
  c.complete({
    case: 'one-actual-blocking-child',
    phiSessionId: c.phiSessionId,
    parentRunId: parent.runId,
    childId: child.id,
    childOmpSessionId: child.childOmpSessionId,
    verifiedCompleted: true,
    onlyReadCapability: true,
    providerRequests: 4,
    childProviderRequests: 2,
    elapsedMs: performance.now() - at,
    taskRoundTrip: c.tools.find((t) => t.name === 'task')
  })
}
