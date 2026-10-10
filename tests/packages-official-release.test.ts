import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { prepareOfficialRelease } from '../scripts/packages/prepare-official-release'
import { readRegistry } from '../src/main/agent/packages/registry'
import { registryKeyId } from '../src/main/agent/packages/signature'
import { readRegistryManifestAsset } from '../src/main/agent/packages/manifest-assets'
import { parseTarGz } from '../src/main/agent/packages/archive'

test('official release publishes flat signed sidecars and explicitly versioned wrappers', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-official-release-'))
  try {
    const sourceRoot = join(root, 'source')
    mkdirSync(sourceRoot)
    execFileSync('git', ['init', '--quiet'], { cwd: sourceRoot })
    const connectorDir = join(sourceRoot, 'resources', 'connectors', 'demo-connector')
    mkdirSync(connectorDir, { recursive: true })
    writeFileSync(
      join(connectorDir, 'phi-package.yaml'),
      `schemaVersion: 1\nid: demo-connector\ntype: mcp\nversion: 1.0.1\ntitle: Demo\nsummary: Demo connector\nconnector:\n  transport: http\n  publisher: Phi\n  category: 科研数据\n  homepage: https://example.test\n  url: https://example.test/mcp\n  auth: none\n`
    )
    writeFileSync(join(connectorDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const wrapperDir = join(
      sourceRoot,
      'resources',
      'wrappers',
      'modules',
      'nf-core',
      'fastqc',
      'run'
    )
    mkdirSync(wrapperDir, { recursive: true })
    writeFileSync(join(wrapperDir, 'main.nf'), 'process RUN {}\n')
    execFileSync('git', ['add', 'resources'], { cwd: sourceRoot })
    const keys = generateKeyPairSync('ed25519')
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const privateKeyFile = join(root, 'test-release-key.pem')
    writeFileSync(privateKeyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const result = prepareOfficialRelease({
      sourceRoot,
      outDir: join(root, 'output'),
      privateKeyFile,
      generatedAt: '2026-10-08T00:00:00Z'
    })
    const registry = readRegistry(result.assetsDir, {
      trustedKeys: [{ keyId: registryKeyId(publicKey), publicKey }]
    })
    assert.equal(registry.trust, 'official')
    const mcp = registry.packages.find((entry) => entry.type === 'mcp')!
    const wrapper = registry.packages.find((entry) => entry.type === 'wrapper')!
    // Must match the bundled wrapper tree version, or every online wrapper looks like a downgrade.
    assert.equal(wrapper.version, '1.0.0')
    for (const dependency of wrapper.dependsOn) assert.equal(dependency.version, '^1.0.0')
    assert.equal(mcp.iconAsset?.path, basename(mcp.iconAsset!.path))
    assert.equal(mcp.manifestAsset?.path, basename(mcp.manifestAsset!.path))
    assert.equal(readRegistryManifestAsset(registry.dir, mcp)?.id, 'demo-connector')
    for (const filename of result.assetFiles) {
      assert.equal(filename, basename(filename))
      assert.equal(existsSync(join(result.assetsDir, filename)), true)
    }
    const manifest = parseTarGz(readFileSync(join(registry.dir, wrapper.archive))).find(
      (entry) => entry.path === 'phi-package.yaml'
    )!
    assert.match(manifest.data.toString(), /version: 1\.0\.0/)
    assert.equal(result.assetFiles.includes('index.json'), true)
    assert.equal(result.assetFiles.includes('index.sig.json'), true)
    assert.equal(
      result.assetFiles.some((name) => /\.pem$/.test(name)),
      false
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
