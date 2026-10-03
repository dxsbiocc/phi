import {
  TERMINAL_MAX_FRAME_BYTES,
  encodeProtocolFrame,
  parseProtocolLine
} from './terminal-protocol'

interface ProtocolRequest {
  id: string
}

interface ProtocolRequestStreamOptions<Request extends ProtocolRequest> {
  name: string
  fallbackErrorMessage: string
  parseRequest: (value: unknown) => Request
}

export function createProtocolRequestStream<Request extends ProtocolRequest>(
  options: ProtocolRequestStreamOptions<Request>
): {
  diagnostic: (message: string) => void
  errorMessage: (error: unknown) => string
  writeFrame: (frame: unknown) => void
  start: (handleRequest: (request: Request) => Promise<unknown>) => void
} {
  const diagnostic = (message: string): void => {
    process.stderr.write(`[${options.name}] ${message}\n`)
  }

  const errorMessage = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error)
    return (message || options.fallbackErrorMessage).slice(0, 4_096)
  }

  const writeFrame = (frame: unknown): void => {
    process.stdout.write(encodeProtocolFrame(frame))
  }

  const processLine = async (
    line: string,
    handleRequest: (request: Request) => Promise<unknown>
  ): Promise<void> => {
    let request: Request
    try {
      request = options.parseRequest(parseProtocolLine(line))
    } catch {
      diagnostic('discarded an invalid protocol frame')
      return
    }

    try {
      const result = await handleRequest(request)
      writeFrame({ id: request.id, ok: true, result })
    } catch (error) {
      writeFrame({ id: request.id, ok: false, error: errorMessage(error) })
    }
  }

  const start = (handleRequest: (request: Request) => Promise<unknown>): void => {
    let buffered = Buffer.alloc(0)
    let discarding = false

    process.stdin.on('data', (value: Buffer | string) => {
      const chunk = typeof value === 'string' ? Buffer.from(value) : value
      let offset = 0
      while (offset < chunk.byteLength) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.byteLength : newline
        const segment = chunk.subarray(offset, end)

        if (!discarding) {
          if (buffered.byteLength + segment.byteLength > TERMINAL_MAX_FRAME_BYTES) {
            buffered = Buffer.alloc(0)
            discarding = newline < 0
            diagnostic('discarded an oversized protocol frame')
          } else {
            buffered = Buffer.concat([buffered, segment])
            if (newline >= 0) {
              const lineBuffer = buffered.at(-1) === 13 ? buffered.subarray(0, -1) : buffered
              void processLine(lineBuffer.toString('utf8'), handleRequest).catch(() =>
                diagnostic('request processing failed')
              )
              buffered = Buffer.alloc(0)
            }
          }
        } else if (newline >= 0) {
          discarding = false
        }

        if (newline < 0) break
        offset = newline + 1
      }
    })
  }

  return { diagnostic, errorMessage, writeFrame, start }
}
