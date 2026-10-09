import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stringify } from 'yaml'

import {
  buildEnvironment,
  describeEnvironment,
  readyEnvironment
} from '../src/main/agent/content/environment-refs'
import {
  currentPlatform,
  ensureEnvironment,
  removeTree,
  runInEnvironment
} from '../src/main/agent/envs'
import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import type { JavaScriptBunInstallation } from '../src/main/agent/envs/applications/types'

const platform = currentPlatform()
const archivePath = '/tmp/phi-bun-bootstrap-bun-v1.3.14-arm64.tgz'
const toolUrl =
  'https://registry.npmjs.org/@oven/bun-darwin-aarch64/-/bun-darwin-aarch64-1.3.14.tgz'
const toolSha256 = '603d327a393c32fec5d9e7165c5f57afc28f1c84ef85593448870ccc41bda636'
const skip = platform !== 'darwin-arm64' || !existsSync(archivePath)
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

test(
  'pure JavaScript builds bootstrap official pinned Bun, launch privately, and validate/rebuild offline',
  { skip, timeout: 120_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'phi-app-bun-bootstrap-'))
    try {
      const source = join(root, 'source')
      const runtime = join(root, 'runtime')
      mkdirSync(join(source, 'locks'), { recursive: true })
      const runtimeArchive = readFileSync(archivePath)
      assert.equal(runtimeArchive.length, 24_310_637)
      assert.equal(sha256(runtimeArchive), toolSha256)
      const pkgUrl = 'https://registry.npmjs.org/bootstrap-fixture/-/bootstrap-fixture-1.0.0.tgz'
      const pkg = createDeterministicTarGz([
        {
          path: 'package/package.json',
          data: Buffer.from(
            JSON.stringify({
              name: 'bootstrap-fixture',
              version: '1.0.0',
              bin: { 'bootstrap-server': 'cli.js' }
            })
          )
        },
        {
          path: 'package/cli.js',
          data: Buffer.from(
            'console.log(JSON.stringify({ executable: process.execPath, args: process.argv.slice(2) }))\n'
          )
        }
      ])
      const manifest = Buffer.from(
        JSON.stringify({
          name: 'private-bootstrap',
          version: '1.0.0',
          dependencies: { 'bootstrap-fixture': '1.0.0' }
        })
      )
      const lock = Buffer.from(
        JSON.stringify({
          name: 'private-bootstrap',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: {
            '': {
              name: 'private-bootstrap',
              version: '1.0.0',
              dependencies: { 'bootstrap-fixture': '1.0.0' }
            },
            'node_modules/bootstrap-fixture': {
              name: 'bootstrap-fixture',
              version: '1.0.0',
              resolved: pkgUrl,
              integrity: `sha512-${createHash('sha512').update(pkg).digest('base64')}`,
              bin: { 'bootstrap-server': 'cli.js' }
            }
          }
        })
      )
      const installation: JavaScriptBunInstallation = {
        backend: 'javascript-bun',
        manifest: './package.json',
        manifestSha256: sha256(manifest),
        lock: './package-lock.json',
        lockSha256: sha256(lock),
        executable: 'bootstrap-server',
        bun: {
          version: '1.3.14',
          artifacts: {
            'darwin-arm64': {
              url: toolUrl,
              sha256: toolSha256,
              size: runtimeArchive.length,
              format: 'tar.gz',
              member: 'package/bin/bun'
            }
          }
        }
      }
      writeFileSync(join(source, 'package.json'), manifest)
      writeFileSync(join(source, 'package-lock.json'), lock)
      writeFileSync(
        join(source, 'environment.yml'),
        stringify({ name: 'bootstrap-js', channels: [], dependencies: [], installation })
      )
      writeFileSync(join(source, 'locks', `${platform}.txt`), '@EXPLICIT\n')
      const descriptor = describeEnvironment('./environment.yml', {
        mcpPackage: { id: 'bootstrap-fixture', dir: source },
        platform
      })
      const requests: string[] = []
      const fetcher: typeof fetch = async (input) => {
        const url = String(input)
        requests.push(url)
        assert.ok([toolUrl, pkgUrl].includes(url))
        return new Response(Uint8Array.from(url === toolUrl ? runtimeArchive : pkg))
      }
      const handle = await buildEnvironment(runtime, descriptor, { fetch: fetcher })
      assert.equal(handle.metadata.runtimeEngine, 'native')
      assert.equal(handle.metadata.micromambaVersion, undefined)
      assert.equal(existsSync(join(runtime, 'mambarc')), false)
      assert.deepEqual(handle.metadata.installation?.installer, { name: 'bun', version: '1.3.14' })
      assert.ok(
        handle.metadata.installation!.artifacts.some((artifact) => artifact.sha256 === toolSha256)
      )
      const launched = await runInEnvironment(handle, ['bootstrap-server', 'hello'], {
        cwd: source
      })
      assert.equal(launched.exitCode, 0, launched.stderr)
      assert.deepEqual(JSON.parse(launched.stdout), {
        executable: join(handle.prefix, 'bin', 'bun'),
        args: ['hello']
      })
      const offline = { ...descriptor, sourceDir: source }
      const reused = await ensureEnvironment({
        root: runtime,
        scope: offline.scope,
        owner: offline.owner,
        kind: offline.kind,
        spec: offline.spec,
        lockText: offline.lockText,
        sourceDir: source,
        platform,
        fetch: async () => {
          throw new Error('cached readiness must never download')
        }
      })
      assert.equal(reused.created, false)
      readyEnvironment(runtime, descriptor)
      assert.deepEqual(requests.sort(), [pkgUrl, toolUrl].sort())
      const tool = join(handle.prefix, 'bin', 'bun')
      chmodSync(tool, 0o700)
      writeFileSync(tool, 'corrupt runtime')
      assert.throws(
        () => readyEnvironment(runtime, descriptor),
        /runtime.*artifact|declared artifact/i
      )
      const repaired = await buildEnvironment(runtime, descriptor, {
        fetch: async () => {
          throw new Error('rebuild must use owned verified artifacts')
        }
      })
      assert.equal(
        (await runInEnvironment(repaired, ['bootstrap-server'], { cwd: source })).exitCode,
        0
      )
    } finally {
      removeTree(root)
    }
  }
)
