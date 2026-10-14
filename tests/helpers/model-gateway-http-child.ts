import { createInterface } from 'node:readline'
import { createGatewayHttpListener } from '../../src/main/agent/engine/in-process/model-gateway-http'

const total = 64 * 1024 * 1024
const chunk = new Uint8Array(64 * 1024).fill(120)
const state = { produced: 0, canceled: 0, aborted: 0, finished: 0 }
const listener = await createGatewayHttpListener(
  (head) => (head.method === 'POST' ? undefined : new Response('Invalid fixture', { status: 404 })),
  async (request) => {
    await request.text()
    request.signal.addEventListener('abort', () => state.aborted++, { once: true })
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (state.produced === total) {
              state.finished++
              controller.close()
            } else {
              state.produced += chunk.byteLength
              controller.enqueue(chunk)
            }
          },
          cancel() {
            state.canceled++
          }
        },
        { highWaterMark: 0 }
      ),
      { headers: { 'content-type': 'application/octet-stream', 'content-length': String(total) } }
    )
  }
)
console.log(JSON.stringify({ ready: true, port: listener.port }))
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  void (async () => {
    const command = JSON.parse(line) as { id: number; stop?: boolean }
    if (command.stop) await listener.close()
    console.log(JSON.stringify({ id: command.id, ...state }))
    if (command.stop) input.close()
  })().catch(() => {
    process.exitCode = 1
    input.close()
  })
})
input.once('close', () => {
  void listener.close().catch(() => {
    process.exitCode = 1
  })
})
