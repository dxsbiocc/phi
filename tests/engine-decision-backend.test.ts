import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

test(
  'decision backend uses the actual locked SDK with isolated native/chat providers',
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phi-decision-backend-'))
    const home = join(root, 'home')
    const agentDir = join(root, 'agent')
    await mkdir(home)
    await mkdir(agentDir)
    try {
      const { stdout, stderr } = await promisify(execFile)(
        resolveBunExecutable(),
        [fileURLToPath(new URL('./helpers/decisionBackendFixture.ts', import.meta.url))],
        {
          cwd: root,
          timeout: 55_000,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            USERPROFILE: home,
            TMPDIR: root,
            XDG_CONFIG_HOME: join(home, '.config'),
            XDG_CACHE_HOME: join(home, '.cache'),
            XDG_DATA_HOME: join(home, '.local/share'),
            PI_CODING_AGENT_DIR: agentDir,
            PHI_DECISION_FIXTURE: '1',
            OMP_AUTH_BROKER_URL: '',
            OMP_AUTH_BROKER_TOKEN: ''
          }
        }
      )
      assert.match(stdout, /PASS 15 decision backend checks/)
      assert.doesNotMatch(stderr, /secret-provider-diagnostic|fixture-native-credential/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
