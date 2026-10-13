import assert from 'node:assert/strict'
import test from 'node:test'
import { RpcHostToolBridge } from '../src/main/agent/engine/rpc/host-tool-bridge'
import { hostToolCli } from './helpers/rpc-host-tool-cli'
import { desktopToolsFixture, PNG } from './helpers/rpcDesktopToolsFixture'
import { NotebookToolHostRouter } from '../src/main/agent/notebook/notebook-tool-host-router'
import type { NotebookToolRequest } from '../src/main/agent/notebook/notebook-tools'
import { createInProcessFixture } from './engine-contract/in-process-factory'

test(
  'actual private OMP CLI accepts the existing dotted notebook tool names',
  { timeout: 30000 },
  async (t) => {
    const cli = await hostToolCli()
    t.after(() => cli.close())
    const f = desktopToolsFixture({ cwd: cli.cwd })
    t.after(() => f.close())
    await cli.connection.start()
    const notebook = f.tool('notebook.list')
    let selected = 0
    const router = new NotebookToolHostRouter({
      local: async () => {
        throw new Error('local fallback forbidden')
      },
      isRemoteCwd: () => true,
      resolveRemote: async (identity) => {
        assert.deepEqual(identity, {
          runtimeSessionId: 'runtime-session',
          sessionId: 'phi-session',
          projectId: 'project'
        })
        return {
          projectCwd: cli.cwd,
          execute: async () => {
            selected++
            return { summary: 'real selected router result', notebooks: ['selected.ipynb'] }
          }
        }
      }
    })
    f.services.register('notebookTool.execute', (params) =>
      router.execute(params as NotebookToolRequest)
    )
    const channel = cli.connection.bindControl()
    const executions: Promise<void>[] = []
    const detach = channel.onFrame((frame) => {
      if (frame.type !== 'host_tool_call') return
      assert.equal(frame.toolName, 'notebook.list')
      const execution = f
        .call('notebook.list', frame.arguments as Record<string, unknown>, String(frame.toolCallId))
        .then((result) =>
          channel.sendControl({ type: 'host_tool_result', id: String(frame.id), result })
        )
      executions.push(execution)
      void execution.catch(() => undefined)
    })
    t.after(detach)
    const registered = await cli.connection.request({
      type: 'set_host_tools',
      tools: [
        {
          name: notebook.name,
          label: notebook.label,
          description: notebook.description,
          parameters: notebook.parameters
        }
      ]
    })
    assert.deepEqual(registered, { toolNames: ['notebook.list'] })
    cli.provider.enqueue(
      { tool: { id: 'dotted-call', name: 'notebook.list', args: {} } },
      { text: 'Notebook result received' }
    )
    assert.equal(
      (await cli.connection.prompt('List selected notebooks')).status,
      'completed',
      cli.stderr()
    )
    await Promise.all(executions)
    assert.equal(selected, 1)
    const tools = cli.provider.requests[0].tools as Array<{ function: { name: string } }>
    assert.ok(tools.some((tool) => tool.function.name === 'notebook.list'))
    assert.ok(
      cli.frames.some(
        (frame) =>
          frame.type === 'tool_execution_end' &&
          frame.toolName === 'notebook.list' &&
          frame.toolCallId === 'dotted-call'
      )
    )
    const messages = await cli.connection.request<{ messages: Array<Record<string, unknown>> }>({
      type: 'get_messages'
    })
    assert.deepEqual(
      messages.messages.find(
        (message) => message.toolCallId === 'dotted-call' && message.role === 'toolResult'
      )?.details,
      { summary: 'real selected router result', notebooks: ['selected.ipynb'] }
    )
    await cli.connection.close()
    assert.equal(cli.running(), false)
  }
)

test(
  'actual private CLI and real Bun worker browser tool share one real registered desktop service',
  { timeout: 30000 },
  async (t) => {
    const cli = await hostToolCli()
    t.after(() => cli.close())
    const f = desktopToolsFixture({ cwd: cli.cwd })
    t.after(() => f.close())
    const worker = await createInProcessFixture()
    t.after(() => worker.close())
    worker.engine.host.register('browser.execute', f.browserHandler)
    await worker.engine.sessions.create({
      sessionId: 'runtime-session',
      cwd: worker.cwd,
      agentDir: worker.agentDir,
      model: worker.model,
      sessionManager: { kind: 'memory', cwd: worker.cwd },
      enableToolApproval: false,
      autoCompaction: { enabled: false },
      resourceOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true
      }
    })
    worker.provider.enqueue(
      {
        tool: { id: 'desktop-call', name: 'browser', args: { action: 'snapshot', tabId: 'tab-1' } }
      },
      { text: 'Worker screenshot received' }
    )
    const state = await worker.engine.sessions.prompt({
      sessionId: 'runtime-session',
      text: 'Take the fixture browser snapshot once'
    })
    const workerResult = state.messages?.find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        message.role === 'toolResult' &&
        'toolCallId' in message &&
        message.toolCallId === 'desktop-call'
    ) as { content?: unknown } | undefined
    assert.ok(workerResult)
    assert.equal(JSON.stringify(workerResult.content).includes(PNG), true)
    await cli.connection.start()
    const run = {
      id: 'oracle-main-run',
      signal: new AbortController().signal,
      authorizeCall: (id: string, name: string) =>
        id === 'desktop-call' && name === 'browser' ? ('main' as const) : undefined
    }
    const bridge = await RpcHostToolBridge.create({
      connection: cli.connection,
      tools: f.scope.tools,
      scope: {
        sessionId: 'phi-session',
        projectId: 'project',
        cwd: cli.cwd,
        currentRun: () => run,
        recentUserImages: () => f.scope.recentUserImages()
      }
    })
    t.after(() => bridge.dispose())
    cli.provider.enqueue(
      {
        tool: {
          id: 'desktop-call',
          name: 'browser',
          args: { action: 'snapshot', tabId: 'tab-1', i: 'undeclared harness intent' }
        }
      },
      { text: 'Observed the screenshot' }
    )
    const prompt = await cli.connection.prompt('Take the fixture browser snapshot once')
    assert.equal(prompt.status, 'completed', cli.stderr())
    assert.equal(f.observed.length, 2)
    // The legacy browser worker carries identity in the body; RPC additionally supplies the
    // new trusted out-of-band context. Both reach the identical handler/coordinator binding.
    assert.deepEqual(f.observed[0].context, {})
    assert.deepEqual(f.observed[1].context, {
      originSessionId: 'runtime-session',
      toolCallId: 'desktop-call'
    })
    for (const { params } of f.observed) {
      assert.equal((params as { originSessionId: string }).originSessionId, 'runtime-session')
      assert.equal((params as { toolCallId: string }).toolCallId, 'desktop-call')
    }
    const ended = cli.frames.find(
      (frame) => frame.type === 'tool_execution_end' && frame.toolCallId === 'desktop-call'
    )
    const output = ended?.result as {
      content: Array<{ type: string; data?: string }>
      details?: unknown
    }
    assert.equal(
      output.content.some((part) => part.type === 'image' && part.data === PNG),
      true
    )
    const saved = await cli.connection.request<{ messages: Array<Record<string, unknown>> }>({
      type: 'get_messages'
    })
    assert.deepEqual(
      saved.messages.find(
        (message) => message.toolCallId === 'desktop-call' && message.role === 'toolResult'
      )?.details,
      output.details
    )
    assert.equal(
      JSON.stringify(cli.provider.requests[1].messages).includes(`data:image/png;base64,${PNG}`),
      true
    )
    await cli.connection.close()
    assert.equal(cli.running(), false)
  }
)
