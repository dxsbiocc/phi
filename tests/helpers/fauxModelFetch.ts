const FAUX_ORIGIN = 'http://phi-faux.invalid'
const FAUX_REPLY = 'node main launched the kernel without loading the SDK'

function completionStream(): string {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
    `data: ${JSON.stringify({
      id: 'phi-faux-completion',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'faux-model',
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`
  return [
    chunk({ role: 'assistant', content: '' }),
    chunk({ content: FAUX_REPLY }),
    chunk({}, 'stop'),
    'data: [DONE]\n\n'
  ].join('')
}

const fauxFetch = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin !== FAUX_ORIGIN || url.pathname !== '/v1/chat/completions') {
    throw new Error(`Faux model blocked unexpected fetch: ${url.href}`)
  }
  return new Response(completionStream(), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}) as typeof fetch

Object.defineProperty(fauxFetch, 'preconnect', {
  value: (value: string | URL): void => {
    const url = new URL(value)
    if (url.origin !== FAUX_ORIGIN) {
      throw new Error(`Faux model blocked unexpected preconnect: ${url.href}`)
    }
  }
})

globalThis.fetch = fauxFetch
