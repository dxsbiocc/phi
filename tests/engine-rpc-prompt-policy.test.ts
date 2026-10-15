import assert from 'node:assert/strict'
import test from 'node:test'
import { rpcPromptPolicy } from '../src/main/agent/engine/phi-extension/lib/rpc-prompt-policy'
const base = {
  schema: 1,
  nonce: 'owned',
  phiSessionId: 'phi',
  projectId: 'project',
  projectRoot: '/remote/work',
  contextRoot: '/remote/work',
  hostAlias: 'fixture-host',
  generation: 1,
  contextFiles: [
    { path: 'ssh://fixture-host/remote/work/AGENTS.md', content: 'Project instructions' }
  ]
}
test('trusted prompt policy is bounded and keeps remote paths distinct from a local anchor', () => {
  const policy = rpcPromptPolicy(base)
  assert.ok(Object.isFrozen(policy.contextFiles[0]))
  for (const path of [
    'ssh://peer/remote/work/AGENTS.md',
    'ssh://fixture-host/remote/work/../peer/AGENTS.md',
    '/remote/work/AGENTS.md',
    'ssh://fixture-host/remote/work-other/AGENTS.md'
  ])
    assert.throws(() => rpcPromptPolicy({ ...base, contextFiles: [{ path, content: 'spoof' }] }))
  assert.throws(() =>
    rpcPromptPolicy({ ...base, contextFiles: [...base.contextFiles, ...base.contextFiles] })
  )
  assert.throws(() => rpcPromptPolicy({ ...base, personaMarkdown: 'x'.repeat(65537) }))
  assert.throws(() => rpcPromptPolicy({ ...base, permissionMode: 'auto' }))
})

test('instruction display roots may retain the registered SSH symlink while tool cwd is canonical', () => {
  const policy = rpcPromptPolicy({
    ...base,
    projectRoot: '/canonical/work',
    contextRoot: '/remote/work'
  })
  assert.equal(policy.projectRoot, '/canonical/work')
  assert.equal(policy.contextFiles[0].path, 'ssh://fixture-host/remote/work/AGENTS.md')
})

test('private prompt publication rejects changed hash, peer generation, shared modes, and symlinks', async (t) => {
  const { mkdtemp, realpath, writeFile, rm, chmod, symlink } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadRpcPromptPolicy } =
    await import('../src/main/agent/engine/phi-extension/lib/rpc-prompt-policy-reader')
  const { rpcPromptPolicyHash } =
    await import('../src/main/agent/engine/phi-extension/lib/rpc-prompt-policy')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-prompt-policy-reader-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'prompt-policy.json'),
    policy = rpcPromptPolicy(base)
  await writeFile(path, JSON.stringify(policy), { mode: 0o600 })
  const runtime = {
    ...base,
    generationDirectory: root,
    promptPolicyHash: rpcPromptPolicyHash(policy)
  } as unknown as import('../src/main/agent/engine/phi-extension/lib/rpc-runtime-config').RpcRuntimeConfig
  assert.deepEqual(loadRpcPromptPolicy(runtime), policy)
  assert.throws(() => loadRpcPromptPolicy({ ...runtime, generation: 2 }), /identity changed/)
  await writeFile(path, JSON.stringify({ ...policy, personaMarkdown: 'changed' }))
  assert.throws(() => loadRpcPromptPolicy(runtime), /identity changed/)
  await writeFile(path, JSON.stringify(policy))
  await chmod(path, 0o644)
  assert.throws(() => loadRpcPromptPolicy(runtime), /Invalid private/)
  await chmod(path, 0o600)
  const target = join(root, 'other.json')
  await writeFile(target, JSON.stringify(policy), { mode: 0o600 })
  await rm(path)
  await symlink(target, path)
  assert.throws(() => loadRpcPromptPolicy(runtime), /canonical/)
})
