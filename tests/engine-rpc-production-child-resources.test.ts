import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  createProductionChildConfig,
  publishProductionChildConfig
} from '../src/main/agent/engine/rpc/subagents/production-child-config'
import {
  loadRpcChildRuntimeConfig,
  readRpcChildSkill
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import {
  childProfileResourceDigest,
  rpcChildEffectivePrompt
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-resources'
import { rpcChildPromptDigest } from '../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import type { RpcRuntimePreparationContext } from '../src/main/agent/engine/rpc/ssh-stdio-factory'
import type { RpcAgentEnvironmentDescriptor } from '../src/main/agent/engine/rpc/subagents/types'
import { productionChildOptions } from './helpers/productionChildNodeFixture'
import { definition } from './helpers/rpcAgentDefinitionFixture'
import { prepareRemoteSessionStorageFixture } from './helpers/remoteSessionStorageFixture'

const markdown = '# Trusted method\nSCIENTIFIC_SKILL_CONTENT Ω\n'
const resources = (): {
  hostTools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  skills: Array<{ name: string; description: string; markdown: string }>
} => ({
  hostTools: [
    {
      name: 'web_search',
      description: 'Selected scientific search',
      parameters: { type: 'object', properties: { query: { type: 'string' } } }
    }
  ],
  skills: [{ name: 'paper-lookup', description: 'Selected paper method', markdown }]
})

function environment(): RpcAgentEnvironmentDescriptor {
  return {
    ref: 'phi:r@1',
    environmentId: 'managed-r',
    lockSha256: 'e'.repeat(64),
    status: 'ready',
    binding: productionChildOptions().binding,
    execution: {
      runtimeRoot: '/srv/runtime',
      micromambaPath: '/srv/runtime/bin/micromamba',
      prefixPath: '/srv/runtime/envs/managed-r',
      markerPath: '/srv/runtime/envs/managed-r/.phi-remote-env.json',
      markerSha256: 'd'.repeat(64)
    }
  }
}

test('background and parallel policy are opt-in while the existing 32-profile budget remains enforced', async () => {
  const original = await createProductionChildConfig(productionChildOptions())
  assert.equal(original.config.profiles.length, 1)
  assert.equal(original.config.policy.allowBackground, undefined)
  const enabled = await createProductionChildConfig(
    productionChildOptions({ allowBackground: true, allowParallel: true })
  )
  assert.deepEqual(
    enabled.config.profiles.map((profile) => profile.definition.blocking),
    [true, false]
  )
  assert.equal(enabled.config.policy.allowBackground, true)
  assert.equal(enabled.config.policy.allowParallel, true)
  assert.equal(enabled.config.files.length, 3)
  await assert.rejects(
    createProductionChildConfig(
      productionChildOptions({
        allowBackground: true,
        definitions: Array.from({ length: 17 }, (_, index) =>
          definition({ name: 'Expert' + index, tools: ['read'], skills: [] })
        )
      })
    ),
    /count budget/
  )
})

test('one shared selected catalogue binds real host schema, skill bytes, environment, and both effective profiles', async () => {
  const input = resources(),
    ready = environment()
  const prepared = await createProductionChildConfig(
    productionChildOptions({
      allowBackground: true,
      allowParallel: true,
      definitions: [
        definition({
          name: 'Scientist',
          tools: ['read', 'web_search'],
          skills: ['paper-lookup'],
          environment: ready.ref
        })
      ],
      availableTools: [
        { name: 'read', site: 'native' },
        { name: 'web_search', site: 'host' }
      ],
      resources: input,
      availableSkills: ['paper-lookup'],
      resolveEnvironment: () => ready
    })
  )
  const catalog = prepared.config.resources!
  assert.equal(catalog.hostTools.length, 1)
  assert.equal(catalog.skills.length, 1)
  assert.equal(catalog.environments.length, 1)
  const sha = createHash('sha256').update(markdown).digest('hex')
  assert.equal(catalog.skills[0].sha256, sha)
  assert.deepEqual(
    prepared.config.files.filter((file) => file.path.startsWith('phi-child-skills/')),
    [{ path: `phi-child-skills/${sha}.md`, sha256: sha }]
  )
  assert.ok(!JSON.stringify(prepared.config).includes('SCIENTIFIC_SKILL_CONTENT'))
  for (const profile of prepared.config.profiles) {
    assert.equal(
      profile.definition.resourcesDigest,
      childProfileResourceDigest(profile.definition, catalog)
    )
    assert.equal(
      profile.effectivePromptDigest,
      rpcChildPromptDigest(
        rpcChildEffectivePrompt(
          profile.systemPrompt,
          [{ name: 'paper-lookup', markdown }],
          catalog.environments[0]
        )
      )
    )
    assert.equal(profile.definition.environment?.ref, ready.ref)
  }
})

test('catalogue schemas and Markdown detach before the asynchronous resolver can observe caller mutations', async () => {
  const input = resources(),
    ready = environment()
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
      reached = resolve
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
  const pending = createProductionChildConfig(
    productionChildOptions({
      definitions: [
        definition({
          name: 'Scientist',
          tools: ['read', 'web_search'],
          skills: ['paper-lookup'],
          environment: ready.ref
        })
      ],
      availableTools: [
        { name: 'read', site: 'native' },
        { name: 'web_search', site: 'host' }
      ],
      resources: input,
      availableSkills: ['paper-lookup'],
      resolveEnvironment: async () => {
        reached()
        await gate
        return ready
      }
    })
  )
  await entered
  input.skills[0].markdown = 'UNTRUSTED_CHANGED_CONTENT'
  input.hostTools[0].parameters.properties = { query: { type: 'number' } }
  release()
  const prepared = await pending
  assert.equal(
    prepared.config.resources!.skills[0].sha256,
    createHash('sha256').update(markdown).digest('hex')
  )
  assert.deepEqual(prepared.config.resources!.hostTools[0].parameters.properties, {
    query: { type: 'string' }
  })
})

test('independent Markdown files do not consume the sidecar byte budget and the original artifact limit is retained', async () => {
  const skills = Array.from({ length: 3 }, (_, index) => ({
    name: 'method-' + index,
    description: 'method',
    markdown: ('M' + index).repeat(24 * 1024)
  }))
  const definitions = skills.map((skill, index) =>
    definition({ name: 'Expert' + index, tools: ['read'], skills: [skill.name] })
  )
  const prepared = await createProductionChildConfig(
    productionChildOptions({ definitions, resources: { hostTools: [], skills } })
  )
  assert.equal(prepared.config.resources!.skills.length, 3)
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.config)) < 128 * 1024)
  const tooMany = Array.from({ length: 17 }, (_, index) => ({
    name: 'method-' + index,
    description: 'method',
    markdown: String.fromCharCode(65 + index).repeat(64 * 1024)
  }))
  await assert.rejects(
    createProductionChildConfig(
      productionChildOptions({
        definitions: tooMany.map((skill, index) =>
          definition({ name: 'Expert' + index, tools: ['read'], skills: [skill.name] })
        ),
        resources: { hostTools: [], skills: tooMany }
      })
    )
  )
  await assert.rejects(
    createProductionChildConfig(
      productionChildOptions({
        definitions: [
          definition({
            name: 'Large',
            tools: ['read'],
            skills: [],
            systemPrompt: 'X'.repeat(120000)
          })
        ],
        allowBackground: true
      })
    )
  )
})

test('missing actual resource content, oversized skill files, and recursive tool capability fail closed', async () => {
  const selected = definition({ name: 'Scientist', tools: ['read'], skills: ['paper-lookup'] })
  await assert.rejects(
    createProductionChildConfig(
      productionChildOptions({ definitions: [selected], availableSkills: ['paper-lookup'] })
    ),
    /content is unavailable/
  )
  await assert.rejects(
    createProductionChildConfig(
      productionChildOptions({
        definitions: [selected],
        resources: {
          hostTools: [],
          skills: [
            { name: 'paper-lookup', description: 'paper', markdown: 'X'.repeat(64 * 1024 + 1) }
          ]
        }
      })
    ),
    /oversized/
  )
  await assert.rejects(
    createProductionChildConfig(
      productionChildOptions({
        definitions: [definition({ name: 'Recursive', tools: ['task'], skills: [] })],
        availableTools: [{ name: 'task', site: 'native' }]
      })
    )
  )
})

test(
  'registered private publication writes the original skill bytes with validated modes and rejects later tampering',
  { timeout: 30000 },
  async (t) => {
    const f = await prepareRemoteSessionStorageFixture(t)
    const nonce = '12345678-1234-4234-8234-123456789012'
    const identity = {
      nonce,
      phiSessionId: f.scope.phiSessionId,
      projectId: f.scope.projectId,
      projectRoot: f.scope.projectRoot,
      generation: 1
    }
    const prepared = await createProductionChildConfig(
      productionChildOptions({
        identity,
        binding: {
          serverId: f.scope.hostProfileId,
          serverIdentitySha256: f.scope.bindingHash,
          projectId: f.scope.projectId,
          projectRoot: f.scope.projectRoot
        },
        definitions: [
          definition({ name: 'Scientist', tools: ['read', 'web_search'], skills: ['paper-lookup'] })
        ],
        availableTools: [
          { name: 'read', site: 'native' },
          { name: 'web_search', site: 'host' }
        ],
        resources: resources(),
        allowBackground: true
      })
    )
    const generationDirectory = join(f.runtimeRoot, 'rpc-sessions', nonce),
      homePath = join(generationDirectory, 'home'),
      agentDir = join(homePath, '.omp/agent')
    for (const path of [
      join(f.runtimeRoot, 'rpc-sessions'),
      generationDirectory,
      homePath,
      join(homePath, '.omp'),
      agentDir
    ])
      await mkdir(path, { mode: 0o700 })
    const context: RpcRuntimePreparationContext = {
      params: {
        sessionId: f.scope.phiSessionId,
        cwd: f.scope.projectRoot,
        agentDir: '/private-desktop'
      },
      bootstrap: {
        schema: 1,
        nonce,
        sessionId: f.scope.phiSessionId,
        projectId: f.scope.projectId,
        projectRoot: f.scope.projectRoot,
        ompVersion: '18.10.3',
        contentHash: 'a'.repeat(64)
      },
      generation: 1,
      generationDirectory,
      homePath,
      agentDir,
      storage: f.preparation,
      signal: new AbortController().signal
    }
    await publishProductionChildConfig({
      prepared,
      context,
      host: f.host,
      uploadOptions: { agentDir: join(f.root, 'local-state'), hostKey: f.root }
    })
    const skill = prepared.config.resources!.skills[0],
      path = join(agentDir, skill.path)
    assert.equal((await stat(join(agentDir, 'phi-child-skills'))).mode & 0o777, 0o700)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal(await readFile(path, 'utf8'), markdown)
    assert.equal(readRpcChildSkill(agentDir, skill), markdown)
    assert.deepEqual(
      loadRpcChildRuntimeConfig(join(generationDirectory, 'config.json'), identity, {
        required: true
      }),
      prepared.config
    )
    await writeFile(path, 'TAMPERED', { mode: 0o600 })
    assert.throws(() => readRpcChildSkill(agentDir, skill), /content changed/)
    assert.throws(
      () =>
        loadRpcChildRuntimeConfig(join(generationDirectory, 'config.json'), identity, {
          required: true
        }),
      /artifact differs/
    )
  }
)
