import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

// The real runtime closes its channels before rethrowing a stop-ACK failure.
// Exercise the facade's additional application-owned lease on both close paths.
const source = `
import assert from 'node:assert/strict';
const { RemoteSessionRuntime } = await import('./src/main/agent/engine/rpc/remote-session-runtime.ts');
const { facadeMetadataFixture } = await import('./tests/helpers/facadeMetadataFixture.ts');
const originalCreate = RemoteSessionRuntime.create;
let runtime, ownedDisposerCalls = 0, disposerFailure;
RemoteSessionRuntime.create = async function (...args) {
  runtime = await originalCreate.apply(this, args);
  return runtime;
};
const fixture = await facadeMetadataFixture({ isolatedProject: true, select: selected => ({
  ...selected,
  dispose: () => {
    ownedDisposerCalls += 1;
    if (disposerFailure) throw disposerFailure;
  }
}) });
try {
  const primary = new Error('injected cancellation acknowledgement failure');
  await fixture.engine.sessions.create(fixture.params('selected-close-error'));
  runtime.stopExecution = () => Promise.reject(primary);
  await assert.rejects(fixture.engine.sessions.dispose({ sessionId: 'selected-close-error' }), error => error === primary);
  assert.equal(ownedDisposerCalls, 1, 'owned SSH/workspace must retire after runtime close rejects');
  await assert.rejects(fixture.engine.sessions.dispose({ sessionId: 'selected-close-error' }), error => error === primary);
  assert.equal(ownedDisposerCalls, 1, 'repeated disposal must release its selection exactly once');

  fixture.resume();
  await fixture.engine.sessions.create(fixture.params('selected-interrupted-error'));
  disposerFailure = new Error('secondary selected disposer failure');
  runtime.stopExecution = () => Promise.reject(primary);
  await assert.rejects(runtime.interrupt(new Error('injected transport interruption')), error => error === primary);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ownedDisposerCalls, 2, 'interrupted close must release its selection even after rejection');
  await assert.rejects(fixture.engine.sessions.dispose({ sessionId: 'selected-interrupted-error' }), error => error === primary);
  assert.equal(ownedDisposerCalls, 2, 'interrupt and disposal share one selection cleanup');
  assert.equal(fixture.provider.requests.length, 0);
  console.log('real runtime close rejection retained its original error and released both owned selections once');
} finally {
  RemoteSessionRuntime.create = originalCreate;
  fixture.disableRouting();
  await fixture.engine.stop().catch(() => undefined);
  await Promise.allSettled(fixture.tunnels.map(tunnel => tunnel.close()));
  await fixture.provider.close();
  await fixture.f.cleanup();
}
`

test(
  'real facade releases owned selection after close rejection and preserves the original failure',
  { timeout: 60000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'phi-facade-regression-close-')))
    for (const dir of ['home', 'agent', 'tmp']) await mkdir(join(root, dir), { mode: 0o700 })
    const child = spawn(
      process.execPath,
      ['--import', './scripts/test-loader.mjs', '--input-type=module', '-e', source],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: join(root, 'home'),
          PI_CODING_AGENT_DIR: join(root, 'agent'),
          TMPDIR: join(root, 'tmp'),
          XDG_DATA_HOME: join(root, 'home/.local/share'),
          XDG_CACHE_HOME: join(root, 'home/.cache'),
          PHI_TEST_REAL_BUN: resolveBunExecutable(),
          PHI_OMP_WORKER_PATH: join(process.cwd(), 'src/main/agent/engine/in-process/main.ts')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    t.signal.addEventListener('abort', () => child.kill(), { once: true })
    let output = ''
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-32768)
      })
    try {
      const exit = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      assert.equal(exit, 0, output)
    } finally {
      child.kill()
      await rm(root, { recursive: true, force: true })
    }
  }
)
