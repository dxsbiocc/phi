import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ModelRegistry,
  SessionManager,
  Settings,
  discoverAuthStorage
} from '@oh-my-pi/pi-coding-agent'
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager
} from '@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim'

import { installSpecialistToolCallExtensions } from '../../src/main/agent/agents/specialist-tool-call-extensions'
import { specialistToolCallFactories } from '../../src/main/agent/omp/omp-sdk-worker'

type ActiveTool = {
  name: string
  execute(id: string, input: unknown, signal: AbortSignal): Promise<unknown>
}

const root = mkdtempSync(join(tmpdir(), 'phi-specialist-approval-'))
let session: { dispose(): Promise<void> } | undefined
async function main(): Promise<void> {
  try {
    const authStorage = await discoverAuthStorage(root)
    const settings = await Settings.init({ cwd: root, agentDir: root })
    const factories = specialistToolCallFactories({
      sessionId: 'parent-session',
      agentRunId: 'specialist-run',
      enableToolApproval: true,
      parent: () => undefined
    })
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: SettingsManager.create(root, root),
      extensionFactories: factories
    })
    await loader.reload()
    const result = await createAgentSession({
      agentId: 'phi-specialist-approval-smoke',
      agentDisplayName: 'Specialist',
      cwd: root,
      agentDir: root,
      settings,
      authStorage,
      modelRegistry: new ModelRegistry(authStorage),
      sessionManager: SessionManager.inMemory(root),
      resourceLoader: loader,
      toolNames: ['bash', 'edit', 'write', 'read'],
      restrictToolNames: true,
      allowRestrictedCustomTools: true,
      enableMCP: false,
      enableLsp: false
    })
    session = result.session
    const runner = result.session.extensionRunner
    assert.ok(runner)
    assert.equal(runner.hasHandlers('tool_call'), false)

    await installSpecialistToolCallExtensions(result.session, factories, root)
    assert.equal(runner.hasHandlers('tool_call'), true)

    const activeTools = (result.session as unknown as { agent: { state: { tools: ActiveTool[] } } })
      .agent.state.tools
    const execute = async (name: string, input: unknown): Promise<void> => {
      const tool = activeTools.find((candidate) => candidate.name === name)
      assert.ok(tool, `missing ${name} tool`)
      await assert.rejects(
        tool.execute(`${name}-call`, input, new AbortController().signal),
        /specialist approval denied/
      )
    }

    const bashTarget = join(root, 'bash-ran.txt')
    const writeTarget = join(root, 'write-ran.txt')
    const editTarget = join(root, 'edit-target.txt')
    writeFileSync(editTarget, 'before')
    await execute('bash', { command: `printf ran > ${JSON.stringify(bashTarget)}` })
    await execute('write', { path: writeTarget, content: 'written' })
    await execute('edit', { path: editTarget, old_string: 'before', new_string: 'after' })
    assert.equal(existsSync(bashTarget), false)
    assert.equal(existsSync(writeTarget), false)
    assert.equal(readFileSync(editTarget, 'utf8'), 'before')

    const read = activeTools.find((candidate) => candidate.name === 'read')
    assert.ok(read)
    await assert.rejects(
      read.execute(
        'remote-read-call',
        { path: 'ssh://unapproved-host/project/secret.txt' },
        new AbortController().signal
      ),
      /未经项目授权/
    )

    await result.session.dispose()
    session = undefined

    let disposed = false
    const brokenSession = {
      extensionRunner: {
        extensions: [] as unknown[],
        hasHandlers: () => false
      },
      async dispose(): Promise<void> {
        disposed = true
      }
    }
    await assert.rejects(
      installSpecialistToolCallExtensions(brokenSession, [() => undefined], root),
      /specialist tool guards could not be installed/
    )
    assert.equal(disposed, true)

    await new Promise<void>((resolve, reject) => {
      process.stdout.write(
        `${JSON.stringify({ handlers: true, sideEffectsBlocked: true, remoteUrlBlocked: true, disposed })}\n`,
        (error) => (error ? reject(error) : resolve())
      )
    })
  } finally {
    await session?.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

void main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exit(1)
  }
)
