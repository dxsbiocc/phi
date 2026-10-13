import type { ServerResponse } from 'node:http'

export interface ChildProviderToolCall {
  readonly name: string
  readonly args: unknown
  readonly id: string
}
export function childBatchStream(
  res: ServerResponse,
  calls?: readonly ChildProviderToolCall[]
): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = calls
    ? {
        role: 'assistant',
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) }
        }))
      }
    : { role: 'assistant', content: 'PRIVATE_CHILD_COMPLETE' }
  for (const [part, finish] of [
    [delta, null],
    [{}, calls ? 'tool_calls' : 'stop']
  ])
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'private-response',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: part, finish_reason: finish }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }) +
        '\n\n'
    )
  res.end('data: [DONE]\n\n')
}
export function childStream(res: ServerResponse, name?: string, args?: unknown, id?: string): void {
  childBatchStream(res, name ? [{ name, args, id: id ?? 'private-tool-call' }] : undefined)
}
