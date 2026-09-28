import assert from 'node:assert/strict'
import test from 'node:test'

import { cancelRemoteController } from '../src/main/agent/wrappers/remote-cancel'
import type {
  RemoteExecResult,
  RemoteSshSession
} from '../src/main/agent/wrappers/remote-ssh-session'

const runDir = '/remote/wrappers/runs/wrun_a'
const handle = { runId: 'wrun_a', remoteRunDir: runDir, pid: 4242 }

class StubbornDetachedHost implements RemoteSshSession {
  commands: string[] = []
  alive = true
  exitCode: string | undefined

  async exec(command: string): Promise<RemoteExecResult> {
    this.commands.push(command)
    if (command.startsWith('kill -KILL -')) this.alive = false
    return {
      stdout: command.startsWith('kill -0 ')
        ? this.alive
          ? 'alive\n'
          : 'dead\n'
        : command.startsWith('ps -ww -o args= -p ')
          ? `bash ${runDir}/launch.sh\n`
          : '',
      stderr: '',
      code: 0,
      signal: null
    }
  }

  async readTextFile(path: string): Promise<string> {
    if (path === `${runDir}/.phi-launch-claim/run-id`) return 'wrun_a\n'
    if (path === `${runDir}/pid`) return '4242\n'
    if (path === `${runDir}/exit_code` && this.exitCode !== undefined) return this.exitCode
    throw new Error(`unexpected read: ${path}`)
  }

  async writeTextFile(): Promise<void> {
    // Cancellation never writes remote files.
  }
  async mkdirp(): Promise<void> {
    // Cancellation never creates remote directories.
  }
  async exists(path: string): Promise<boolean> {
    return (
      path === `${runDir}/.phi-launch-claim/run-id` ||
      path === `${runDir}/pid` ||
      (path === `${runDir}/exit_code` && this.exitCode !== undefined)
    )
  }
  async close(): Promise<void> {
    // No transport to close in the fake.
  }
}

test('remote cancellation escalates TERM to KILL only after the grace period', async () => {
  const host = new StubbornDetachedHost()
  const result = await cancelRemoteController(host, handle, 0)
  assert.equal(result.kind, 'confirmed')
  const term = host.commands.findIndex((command) => command.startsWith('kill -TERM -4242'))
  const kill = host.commands.findIndex((command) => command.startsWith('kill -KILL -4242'))
  assert.ok(term >= 0 && kill > term)
})

test('cancel of an already finished remote process sends no signal', async () => {
  const host = new StubbornDetachedHost()
  host.exitCode = '0\n'
  const result = await cancelRemoteController(host, handle, 0)
  assert.equal(result.kind, 'already-ended')
  assert.ok(host.commands.every((command) => !command.startsWith('kill -TERM -')))
})
