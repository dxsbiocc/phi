import assert from 'node:assert/strict'
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import {
  createPhiExtensionBundle,
  resolvePhiExtensionSourceRoot,
  validatePhiExtensionBundle
} from '../src/main/agent/engine/rpc/extension-deployment'
import { createPhiExtensionDeploymentFixture } from './helpers/phiExtensionDeploymentFixture'

test('development and packaged source assets are the same complete closure with the configured extraResources filter', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'phi-extension-assets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const development = resolvePhiExtensionSourceRoot({
    appPath: process.cwd(),
    resourcesPath: root,
    isPackaged: false
  })
  const packaged = resolvePhiExtensionSourceRoot({
    appPath: join(root, 'app.asar'),
    resourcesPath: root,
    isPackaged: true
  })
  await cp(development, packaged, { recursive: true })
  const [dev, production] = await Promise.all([
    createPhiExtensionBundle(development),
    createPhiExtensionBundle(packaged)
  ])
  assert.equal(production.contentHash, dev.contentHash)
  assert.deepEqual(
    production.files.map((file) => file.path),
    dev.files.map((file) => file.path)
  )
  assert.ok(dev.files.length >= 23)
  assert.ok(dev.files.some((file) => file.path === 'rpc-entry.ts'))
  assert.ok(dev.files.some((file) => file.path === 'lib/rpc-config.ts'))
  const config = parse(await readFile(join(process.cwd(), 'electron-builder.yml'), 'utf8'))
  const asset = config.extraResources.find((entry: { to: string }) => entry.to === 'phi-extension')
  assert.deepEqual(asset, {
    from: 'src/main/agent/engine/phi-extension',
    to: 'phi-extension',
    filter: ['**/*.ts', 'package.json']
  })
})

test('content identity includes every relative file name and exact bytes; mutation is rejected', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  await writeFile(join(fixture.sourceRoot, 'unused.ts'), 'export const unused = 1\n')
  const expanded = await createPhiExtensionBundle(fixture.sourceRoot)
  assert.notEqual(expanded.contentHash, fixture.bundle.contentHash)
  await writeFile(join(fixture.sourceRoot, 'unused.ts'), 'export const unused = 1\r\n')
  assert.notEqual(
    (await createPhiExtensionBundle(fixture.sourceRoot)).contentHash,
    expanded.contentHash
  )
  const changed = {
    ...fixture.bundle,
    files: fixture.bundle.files.map((file, index) =>
      index ? file : { ...file, bytes: Buffer.from('changed') }
    )
  }
  assert.throws(() => validatePhiExtensionBundle(changed), /Invalid Phi extension bundle file/)
  assert.throws(
    () =>
      validatePhiExtensionBundle({
        ...fixture.bundle,
        files: [...fixture.bundle.files, fixture.bundle.files[0]]
      }),
    /Invalid Phi extension bundle file/
  )
})

test('closure rejects missing relatives, escape paths, runtime SDK imports and dynamic loaders', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  for (const source of [
    "import './missing'",
    "export { thing } from '../outside'",
    "export { thing as interface } from 'outside'",
    "import { thing } from '@oh-my-pi/pi-coding-agent'",
    "import('node:fs')",
    "require('node:fs')",
    "require.resolve('./lib/guard')",
    "const value = `${import('outside')}`",
    "const load = require; load('third-party-not-in-bundle'); export default function() {}",
    "import { createRequire as load } from 'node:module'; const dependency = load(import.meta.url)('outside')",
    "import * as modules from 'node:module'; modules['create' + 'Require'](import.meta.url)('outside')",
    "import * as vm from 'node:vm'; vm.runInThisContext('import(\"outside\")')",
    "const value = `${(load = require, load('outside'))}`",
    "const value = `${eval('imp' + 'ort(\"outside\")')}`",
    "const value = `${Function('return imp' + 'ort(\"outside\")')()}`"
  ]) {
    await writeFile(join(fixture.sourceRoot, 'rpc-entry.ts'), source)
    await assert.rejects(createPhiExtensionBundle(fixture.sourceRoot), /dependency|import|loader/)
  }
  await writeFile(
    join(fixture.sourceRoot, 'rpc-entry.ts'),
    "import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'\nimport { test } from 'node:test'\nexport { guard } from './lib/guard'\n"
  )
  await createPhiExtensionBundle(fixture.sourceRoot)
})

test('source symlinks, hard links and unexpected assets cannot enter the content bundle', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const outside = join(fixture.root, 'outside.ts')
  await writeFile(outside, 'export {}')
  const alias = join(fixture.sourceRoot, 'alias.ts')
  await symlink(outside, alias)
  await assert.rejects(createPhiExtensionBundle(fixture.sourceRoot), /Symbolic extension source/)
  await rm(alias)
  await link(outside, alias)
  await assert.rejects(createPhiExtensionBundle(fixture.sourceRoot), /Unsafe extension source file/)
  await rm(alias)
  await writeFile(join(fixture.sourceRoot, 'credentials.json'), '{}')
  await assert.rejects(
    createPhiExtensionBundle(fixture.sourceRoot),
    /Unexpected extension source asset/
  )
  await mkdir(join(fixture.root, 'linked-source'))
  const rootAlias = join(fixture.root, 'source-alias')
  await symlink(fixture.sourceRoot, rootAlias)
  await assert.rejects(createPhiExtensionBundle(rootAlias), /Unsafe extension source directory/)
})

test('only the pinned host event-stream module is accepted as a runtime SDK dependency', async (t) => {
  const fixture = await createPhiExtensionDeploymentFixture()
  t.after(fixture.cleanup)
  const entry = join(fixture.sourceRoot, 'rpc-entry.ts')
  await writeFile(
    entry,
    "import { AssistantMessageEventStream } from '@oh-my-pi/pi-ai/utils/event-stream'\nimport type { AssistantMessageEvent } from '@oh-my-pi/pi-ai'\nimport type { StreamFn } from '@oh-my-pi/pi-agent-core'\nexport const stream = new AssistantMessageEventStream()\n"
  )
  await createPhiExtensionBundle(fixture.sourceRoot)
  for (const source of [
    "import type from '@oh-my-pi/pi-coding-agent'",
    "import type, { createAgentSession } from '@oh-my-pi/pi-coding-agent'",
    "import type, * as coding from '@oh-my-pi/pi-coding-agent'",
    "import type from '@oh-my-pi/pi-ai'",
    "import type, { streamSimple } from '@oh-my-pi/pi-ai'",
    "import type, * as ai from '@oh-my-pi/pi-ai'",
    "import type from '@oh-my-pi/pi-agent-core'",
    "import type, { Agent } from '@oh-my-pi/pi-agent-core'",
    "import type, * as core from '@oh-my-pi/pi-agent-core'",
    "import { streamSimple } from '@oh-my-pi/pi-ai'",
    "import { Agent } from '@oh-my-pi/pi-agent-core'",
    "import * as stream from '@oh-my-pi/pi-ai/utils/event-stream/other'",
    "import * as stream from '@oh-my-pi/pi-ai/utils/../utils/event-stream'",
    "import * as stream from '@oh-my-pi/pi-ai/utils/event-stream.ts'",
    "import('@oh-my-pi/pi-ai/utils/event-stream')",
    "require('@oh-my-pi/pi-ai/utils/event-stream')"
  ]) {
    await writeFile(entry, source)
    await assert.rejects(createPhiExtensionBundle(fixture.sourceRoot), /dependency|import|loader/)
  }
})
