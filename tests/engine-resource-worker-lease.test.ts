import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { OmpBridge } from '../src/main/agent/engine/omp-bridge'

test(
  'resource worker holds are generation-bound and release cannot retire another owner',
  { timeout: 15000 },
  async (t) => {
    // The simulated crash is logged by the bridge; keep it out of the real ~/.phi/logs.
    const agentDir = mkdtempSync(join(tmpdir(), 'phi-lease-'))
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    t.after(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
      rmSync(agentDir, { recursive: true, force: true })
    })
    const bridge = new OmpBridge(() =>
      spawn(process.execPath, [join(process.cwd(), 'tests/helpers/fakeOmpWorker.mjs')], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
    )
    t.after(() => bridge.stop())
    const a = bridge.retainResourceWorker(),
      b = bridge.retainResourceWorker()
    const first = await bridge.request<{ pid: number }>('inspect')
    a.release()
    a.release()
    await delay(2200)
    assert.equal((await bridge.request<{ pid: number }>('inspect')).pid, first.pid)
    await bridge.stop()
    assert.equal(b.signal.aborted, true)
    const replacement = bridge.retainResourceWorker()
    const second = await bridge.request<{ pid: number }>('inspect')
    b.release()
    await delay(2200)
    assert.equal(replacement.signal.aborted, false)
    assert.equal((await bridge.request<{ pid: number }>('inspect')).pid, second.pid)
    await assert.rejects(bridge.request('crash'))
    assert.equal(replacement.signal.aborted, true)
    replacement.release()
  }
)
