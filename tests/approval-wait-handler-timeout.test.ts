import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'

const NAME = 'a tool_call handler waiting on user approval is not cut off by the handler budget'

if ('Bun' in globalThis) {
  test(NAME, async () => {
    const { Settings } = await import('@oh-my-pi/pi-coding-agent')
    const { ExtensionRunner } = await import('@oh-my-pi/pi-coding-agent/extensibility/extensions')
    const { allowApprovalWaits } = await import('../src/main/agent/engine/in-process/settings')
    // Stands in for OMP's 30s default so the test does not wait that long.
    const settings = Settings.isolated({ 'extensionHandlers.toolCallTimeoutMs': 50 })
    const approvalWait = async (): Promise<undefined> => {
      await new Promise((done) => setTimeout(done, 200))
      return undefined
    }
    const extension = {
      path: '<phi-approval>',
      resolvedPath: '<phi-approval>',
      handlers: new Map([['tool_call', [approvalWait]]]),
      tools: new Map(),
      assistantThinkingRenderers: [],
      fileWriteFallbackHandlers: [],
      fileDeleteFallbackHandlers: [],
      messageRenderers: new Map(),
      composerShapes: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map()
    }
    const runner = (): InstanceType<typeof ExtensionRunner> =>
      new ExtensionRunner(
        [extension] as never,
        {} as never,
        '/tmp',
        { getCwd: () => '/tmp' } as never,
        {} as never,
        undefined,
        settings
      )
    const event = { type: 'tool_call', toolName: 'write', toolCallId: 'call-1', input: {} }

    const unpatched = await runner().emitToolCall(event as never)
    assert.equal(unpatched?.block, true, 'the short budget must reproduce the timeout')

    allowApprovalWaits(settings)
    assert.equal(await runner().emitToolCall(event as never), undefined)
  })
} else {
  test(NAME, () => {
    execFileSync(resolveBunExecutable(), ['test', fileURLToPath(import.meta.url)], {
      cwd: resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe']
    })
  })
}
