import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import {
  createRpcChildModelHeader,
  RPC_CHILD_MODEL_HEADER,
  verifyRpcChildModelHeader
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-model-authority'
import { childCapability, childScope } from './helpers/rpcChildAuthorityFixture'

test('child model authority signs the complete immutable scope with a distinct protocol domain', () => {
  assert.equal(RPC_CHILD_MODEL_HEADER, 'x-phi-child-model')
  const header = createRpcChildModelHeader(childScope, childCapability)
  const verified = verifyRpcChildModelHeader(header, childCapability)
  assert.deepEqual(verified, childScope)
  assert.ok(Object.isFrozen(verified))
  assert.ok(header.length <= 8192)
  assert.equal(verifyRpcChildModelHeader(childScope.nativeAgentId, childCapability), undefined)
  assert.equal(verifyRpcChildModelHeader(header, 'e'.repeat(64)), undefined)
  const reordered = Object.fromEntries(Object.entries(childScope).reverse())
  assert.equal(
    createRpcChildModelHeader(reordered as unknown as typeof childScope, childCapability),
    header
  )
})

test('forged child, generation, binding, envelope and signature are rejected', () => {
  const header = createRpcChildModelHeader(childScope, childCapability)
  const original = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  for (const scope of [
    { ...childScope, nativeAgentId: 'peer' },
    { ...childScope, generation: 2 },
    { ...childScope, childSessionFile: '/srv/history/root/peer.jsonl' },
    { ...childScope, definitionHash: 'b'.repeat(64) }
  ])
    assert.equal(
      verifyRpcChildModelHeader(encode({ ...original, scope }), childCapability),
      undefined
    )
  for (const value of [
    { ...original, version: 2 },
    { ...original, extra: true },
    { ...original, hmac: '0'.repeat(64) },
    { ...original, hmac: 'not-a-signature' },
    { ...original, scope: { ...childScope, extra: true } }
  ])
    assert.equal(verifyRpcChildModelHeader(encode(value), childCapability), undefined)
})

test('only the exact bounded canonical header encoding is accepted', () => {
  const header = createRpcChildModelHeader(childScope, childCapability)
  const json = Buffer.from(header, 'base64url').toString('utf8')
  const original = JSON.parse(json)
  const alternatives = [
    undefined,
    ['duplicate', header],
    '',
    `${header}=`,
    `${header}\n`,
    'a'.repeat(8193),
    Buffer.from(` ${json}`).toString('base64url'),
    Buffer.from(
      JSON.stringify({ scope: original.scope, version: 1, hmac: original.hmac })
    ).toString('base64url'),
    Buffer.from(json.replace('{"version":1,', '{"version":1,"version":1,')).toString('base64url'),
    Buffer.from([0xff]).toString('base64url')
  ]
  for (const value of alternatives)
    assert.equal(verifyRpcChildModelHeader(value, childCapability), undefined)
  assert.throws(() => createRpcChildModelHeader(childScope, 'invalid'))
  assert.equal(verifyRpcChildModelHeader(header, 'invalid'), undefined)
  assert.throws(() =>
    createRpcChildModelHeader(
      {
        ...childScope,
        cwd: `/${'a'.repeat(4000)}`,
        childSessionFile: `/${'b'.repeat(4000)}`
      },
      childCapability
    )
  )
})

test('native request actor headers preserve peer isolation and reject SDK collisions on pinned Bun', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-child-model-unit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['home', 'agent', 'project']) await mkdir(join(root, name), { mode: 0o700 })
  const result = await promisify(execFile)(
    resolveBunExecutable(),
    [fileURLToPath(new URL('./helpers/rpcChildModelAuthorityUnit.ts', import.meta.url))],
    {
      cwd: join(root, 'project'),
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        PI_CODING_AGENT_DIR: join(root, 'agent'),
        TMPDIR: root
      },
      timeout: 15000,
      maxBuffer: 32768
    }
  )
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout) as { passed: number; names: string[] }
  assert.equal(report.passed, report.names.length)
  assert.equal(report.passed, 11)
  t.diagnostic(`${report.passed} native actor-header contract scenarios passed`)
})
