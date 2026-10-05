export type ActiveTool = {
  name: string
  execute(
    id: string,
    input: unknown,
    signal: AbortSignal
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>
}

export type SdkAgent = {
  state: { tools: ActiveTool[] }
  beforeToolCall?: (context: unknown, signal: AbortSignal) => Promise<unknown> | unknown
}

type HostCall = { method: string; params: unknown; context?: unknown }

export function deliverHostResponse(params: unknown): unknown {
  if ((params as { outputName?: unknown }).outputName === '拒绝样例') {
    return { ok: false, error: { code: 'approval_denied' } }
  }
  return {
    ok: true,
    value: {
      fileName: '交付成果.xlsx',
      outputPath: '交付成果.xlsx',
      kind: 'xlsx',
      revision: 9,
      sha256: 'a'.repeat(64),
      size: 4096,
      warnings: ['布局截图检查不可用'],
      checks: [
        { name: 'schema', status: 'passed' },
        { name: 'xlsx_content', status: 'passed', sampled: 1 }
      ]
    }
  }
}

export async function exerciseOfficeDeliverTool(
  permissionMode: string,
  agent: SdkAgent,
  tool: ActiveTool,
  calls: HostCall[]
): Promise<Record<string, unknown>> {
  const deliver = await executeTool(agent, tool, `office-${permissionMode}-deliver`, {
    outputName: '交付成果',
    artifactId: 'model-must-not-select-artifact',
    outputPath: '../model-must-not-select-path.xlsx'
  })
  const deliverDenied = await executeTool(agent, tool, `office-${permissionMode}-deliver-denied`, {
    outputName: '拒绝样例'
  })
  const deliverCalls = calls.filter((call) => call.method === 'office.deliver')
  return {
    deliver,
    deliverDenied,
    deliverParams: deliverCalls[0]?.params,
    deliverContext: deliverCalls[0]?.context,
    deliverDeniedContext: deliverCalls[1]?.context
  }
}

export async function executeTool(
  agent: SdkAgent,
  tool: ActiveTool,
  id: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const signal = new AbortController().signal
  const toolCall = { type: 'toolCall', id, name: tool.name, arguments: input }
  await agent.beforeToolCall?.(
    {
      assistantMessage: { role: 'assistant', content: [toolCall] },
      toolCall,
      tool,
      args: input,
      context: { systemPrompt: '', messages: [], tools: agent.state.tools }
    },
    signal
  )
  const result = await tool.execute(id, input, signal)
  return {
    payload: JSON.parse(result.content[0]?.text ?? '{}') as unknown,
    ...(result.isError === undefined ? {} : { isError: result.isError })
  }
}
