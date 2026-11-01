import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { foregroundScript } from '../src/main/agent/workspace-host/ssh-host-foreground'
import { installSetsidShim } from './helpers/localShellSession'

test("ending the liveness watcher never reaches the command's stderr", async (t) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'phi-foreground-script-')))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  mkdirSync(join(cwd, '.shim'))
  t.after(installSetsidShim(join(cwd, '.shim')))
  const script = foregroundScript(cwd, ['bash', '-c', 'echo out; echo err >&2; exit 3'])
  assert.ok(script.endsWith('exit $code'))
  // bash reports a job killed by a signal between commands; the pause makes that moment certain.
  const child = spawn(
    'bash',
    ['-c', `${script.slice(0, -'exit $code'.length)}sleep 0.2\nexit $code`],
    {
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += String(chunk)))
  child.stderr.on('data', (chunk) => (stderr += String(chunk)))
  const code = await new Promise((resolve) => child.once('close', resolve))
  assert.equal(stdout, 'out\n')
  assert.equal(stderr, 'err\n')
  assert.equal(code, 3)
})
