import { randomUUID } from 'node:crypto'
import {
  childAuthority,
  childActual,
  childCapability,
  childProfile,
  childScope,
  childStarted
} from './rpcChildAuthorityFixture'
import {
  createRpcChildCall,
  type RpcChildCall,
  type RpcChildRequest
} from '../../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import type { RpcChildAuthorityOptions } from '../../src/main/agent/engine/rpc/subagents/child-authority'
import { hostResultPlaceholder } from '../../src/main/agent/engine/phi-extension/lib/rpc-host-result-protocol'

type DecisionRequest = Exclude<RpcChildRequest, { operation: 'cancel' }>
type RequestFields = {
  [K in DecisionRequest['operation']]: Omit<
    Extract<DecisionRequest, { operation: K }>,
    'schema' | 'id' | 'capability' | 'sequence' | 'scope'
  >
}[DecisionRequest['operation']]

/** Unit-only private protocol fixture; real SDK host acceptance is tested separately. */
export async function childHostControlFixture(
  options: Partial<RpcChildAuthorityOptions> = {}
): Promise<
  ReturnType<typeof childAuthority> & {
    signal: AbortSignal
    request(fields: RequestFields): DecisionRequest
    call(id?: string): RpcChildCall
    executed: string[]
    consumed: string[]
  }
> {
  const profile = {
    ...childProfile,
    definition: {
      ...childProfile.definition,
      resourcesDigest: 'c'.repeat(64),
      tools: [...childProfile.definition.tools, { name: 'notebook_run', site: 'host' as const }]
    }
  }
  const executed: string[] = [],
    consumed: string[] = []
  const f = childAuthority({
    profiles: [profile],
    approval: {
      classifyTool: () => 'exec',
      shouldGate: () => true,
      requestToolApproval: () => 'approved'
    },
    executeHost: async (_run, _call, id) => {
      executed.push(id)
      return hostResultPlaceholder()
    },
    hostResultConsumed: (_run, _call, id) => {
      consumed.push(id)
    },
    ...options
  })
  const signal = f.controller.signal
  let sequence = 0
  const request = (fields: RequestFields): DecisionRequest =>
    ({
      schema: 1,
      id: randomUUID(),
      capability: childCapability,
      sequence: ++sequence,
      scope: childScope,
      ...fields
    }) as DecisionRequest
  f.authority.observe(childStarted())
  await f.authority.accept(request({ operation: 'register' }), signal)
  await f.authority.accept(
    request({
      operation: 'activate',
      actual: {
        ...childActual,
        tools: ['write', 'notebook_run'],
        resourcesDigest: profile.definition.resourcesDigest
      }
    }),
    signal
  )
  const call = (id = 'host-call'): RpcChildCall =>
    createRpcChildCall(childScope, id, 'notebook_run', { code: 'bounded_test()' })
  return { ...f, signal, request, call, executed, consumed }
}
