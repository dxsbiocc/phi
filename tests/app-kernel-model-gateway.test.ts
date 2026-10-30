import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { selectRemoteKernelGatewayModels } from '../src/main/agent/app-kernel-session-launchers'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import { resolveRuntimeModelSelection } from '../src/main/agent/runtime/runtime-model-selection'
import { OmpModelRuntimeFacade } from '../src/main/agent/runtime/model-runtime-facade'
import type { RuntimeSnapshot } from '../src/main/agent/engine/types'

const REAL_REGISTRY_TEST =
  'remote gateway admits a registry-resolvable auth alias used by explicit desktop selection'
const REAL_REGISTRY_CHILD = 'PHI_APP_KERNEL_MODEL_GATEWAY_BUN_CHILD'
const bunRuntime = 'Bun' in globalThis

if (!bunRuntime) {
  test(REAL_REGISTRY_TEST, () => {
    execFileSync(
      resolveBunExecutable(),
      ['test', fileURLToPath(import.meta.url), '--test-name-pattern', REAL_REGISTRY_TEST],
      {
        cwd: resolve('.'),
        env: { ...process.env, [REAL_REGISTRY_CHILD]: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  })
} else if (
  process.env[REAL_REGISTRY_CHILD] === '1' ||
  process.env[REAL_REGISTRY_CHILD] === undefined
) {
  test(REAL_REGISTRY_TEST, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'phi-app-kernel-model-gateway-'))
    const previousKey = process.env.XAI_API_KEY
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.XAI_API_KEY = 'fixture-borrowed-xai-key'
    const { getContext, serializeModel } =
      await import('../src/main/agent/engine/in-process/runtime-context')
    const { contexts } = await import('../src/main/agent/engine/in-process/state')
    const { ModelGatewayManager } =
      await import('../src/main/agent/engine/in-process/model-gateway')
    const context = await getContext(root)
    const { auth, authStorage, modelRegistry: registry } = context
    const rejectionLogs: Array<{
      event: string
      sessionId?: string
      metadata?: Record<string, unknown>
    }> = []
    const gateway = new ModelGatewayManager({
      context: async () => context,
      model: async (context, ref) => context.modelRegistry.find(ref.provider, ref.id),
      log: (entry) => rejectionLogs.push(entry)
    })
    t.after(async () => {
      await gateway.closeAll()
      authStorage.close()
      contexts.delete(root)
      if (previousKey === undefined) delete process.env.XAI_API_KEY
      else process.env.XAI_API_KEY = previousKey
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    })

    const registryModel = registry.getAll().find((model) => model.provider === 'xai-oauth')
    assert.ok(registryModel, 'the actual bundled registry must contain xai-oauth')
    assert.equal(auth.credentialStatus(registryModel.provider).available, false)
    assert.equal(auth.listCredentials(registryModel.provider).length, 0)
    assert.equal(registry.hasConfiguredAuth(registryModel), true)
    assert.equal(
      registry
        .getAvailable()
        .some(
          (model) => model.provider === registryModel.provider && model.id === registryModel.id
        ),
      false,
      'default availability intentionally ignores the cross-provider env alias'
    )

    const selected = serializeModel(registryModel)
    const snapshot: RuntimeSnapshot = {
      providers: [
        {
          id: selected.provider,
          name: selected.provider,
          status: { configured: false }
        }
      ],
      credentials: [],
      models: [selected]
    }
    const refs = selectRemoteKernelGatewayModels(snapshot, selected, {
      disabledProviders: [],
      disabledModels: []
    })
    const lease = await gateway.create({ sessionId: 'registry-alias', generation: 1, models: refs })

    assert.deepEqual(
      lease.models.map(({ provider, id }) => ({ provider, id })),
      refs
    )

    const secretValue = 'must-not-reach-model-gateway-logs'
    const rejected = await fetch(`http://127.0.0.1:${lease.localPort}/v1/pi/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${lease.bearerToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        modelId: `${registryModel.provider}/${registryModel.id}`,
        context: { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] },
        options: { unknownCredentialOverride: secretValue },
        stream: true
      })
    })
    assert.equal(rejected.status, 400)
    assert.deepEqual(rejectionLogs, [
      {
        event: 'model_gateway_request_rejected',
        level: 'warn',
        sessionId: 'registry-alias',
        metadata: {
          status: 400,
          reason: 'options_unknown_field',
          field: 'unknownCredentialOverride'
        }
      }
    ])
    assert.equal(JSON.stringify(rejectionLogs).includes(secretValue), false)
  })
}

test('remote kernel keeps a desktop-resolved selected model when auth is registry-backed', () => {
  const selected = {
    provider: 'custom-deepseek',
    id: 'deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    reasoning: true
  }
  const snapshot: RuntimeSnapshot = {
    providers: [
      {
        id: selected.provider,
        name: 'Custom DeepSeek',
        // Registry-backed custom and aliased auth can resolve a concrete model even
        // when the serialised provider/credential summary has no matching evidence.
        status: { configured: false }
      }
    ],
    credentials: [],
    models: [selected]
  }
  const runtime = new OmpModelRuntimeFacade({} as never, '/unused', snapshot)
  const resolved = resolveRuntimeModelSelection(runtime, {
    providerId: selected.provider,
    modelId: selected.id
  })

  assert.deepEqual(resolved?.model, selected)
  assert.deepEqual(
    selectRemoteKernelGatewayModels(snapshot, resolved!.model, {
      disabledProviders: [],
      disabledModels: []
    }),
    [{ provider: selected.provider, id: selected.id }]
  )
})

test('remote kernel accepts stored API-key, OAuth, and models config provider shapes', () => {
  const models = ['api-key', 'oauth', 'models-config'].map((provider) => ({
    provider,
    id: `${provider}-model`,
    name: provider,
    reasoning: false
  }))
  const snapshot: RuntimeSnapshot = {
    providers: [
      { id: 'api-key', name: 'API key', status: { configured: false } },
      { id: 'oauth', name: 'OAuth', status: { configured: false } },
      {
        id: 'models-config',
        name: 'models.yml',
        status: { configured: true, source: 'models_json_key' }
      }
    ],
    credentials: [
      { id: 'api-key-login', providerId: 'api-key', type: 'api_key', label: 'api-key' },
      { id: 'oauth-account', providerId: 'oauth', type: 'oauth', label: 'user@example.test' }
    ],
    models
  }

  assert.deepEqual(
    selectRemoteKernelGatewayModels(snapshot, models[2]!, {
      disabledProviders: [],
      disabledModels: []
    }),
    [models[2]!, models[0]!, models[1]!].map(({ provider, id }) => ({ provider, id }))
  )
})

test('remote kernel bounds the raw desktop catalog before requesting a model gateway lease', () => {
  const selected = {
    provider: 'configured',
    id: 'selected',
    name: 'Selected',
    reasoning: false
  }
  const snapshot: RuntimeSnapshot = {
    providers: [
      { id: 'configured', name: 'Configured', status: { configured: true } },
      { id: 'unconfigured', name: 'Unconfigured', status: { configured: false } },
      { id: 'cursor', name: 'Cursor', status: { configured: true } }
    ],
    credentials: [],
    models: [
      ...Array.from({ length: 5_410 }, (_, index) => ({
        provider: 'unconfigured',
        id: `unconfigured-${index}`,
        name: `Unconfigured ${index}`,
        reasoning: false
      })),
      ...Array.from({ length: 123 }, (_, index) => ({
        provider: 'cursor',
        id: `cursor-${index}`,
        name: `Cursor ${index}`,
        reasoning: false
      })),
      ...Array.from({ length: 300 }, (_, index) => ({
        provider: 'configured',
        id: `configured-${index}`,
        name: `Configured ${index}`,
        reasoning: false
      })),
      selected
    ]
  }

  const oldRequest = {
    sessionId: 'kernel-ssh-config:yzhang-node3',
    generation: 1,
    models: snapshot.models
      .filter((model) => model.provider !== 'cursor')
      .map(({ provider, id }) => ({ provider, id }))
  }
  const refs = selectRemoteKernelGatewayModels(snapshot, selected, {
    disabledProviders: [],
    disabledModels: []
  })

  assert.deepEqual(Object.keys(oldRequest), ['sessionId', 'generation', 'models'])
  assert.equal(oldRequest.sessionId, 'kernel-ssh-config:yzhang-node3')
  assert.equal(oldRequest.generation, 1)
  assert.equal(snapshot.models.length, 5_834)
  assert.equal(oldRequest.models.length, 5_711)
  assert.ok(oldRequest.models.length > 256, 'the old request is rejected by validateCreate')
  assert.equal(refs.length, 256)
  assert.deepEqual(refs[0], { provider: selected.provider, id: selected.id })
  assert.deepEqual(refs.at(-1), { provider: 'configured', id: 'configured-254' })
})
