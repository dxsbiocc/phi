export interface WrapperResultReadControlOptions {
  observeRemote: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>
  remoteRequestProjectId: (request: unknown) => string
}

export function createWrapperResultReadControl(options: WrapperResultReadControlOptions): {
  controllers: Map<string, AbortController>
  run<T>(
    request: unknown,
    read: (request: unknown, options: { signal: AbortSignal }) => Promise<T>
  ): Promise<T>
} {
  const wrapperResultReadControllers = new Map<string, AbortController>()
  const remoteConnectionTracker = { observe: options.observeRemote }
  const remoteRequestProjectId = options.remoteRequestProjectId

  async function runWrapperResultRead<T>(
    request: unknown,
    read: (request: unknown, options: { signal: AbortSignal }) => Promise<T>
  ): Promise<T> {
    const requestId =
      typeof request === 'object' && request !== null
        ? (request as Record<string, unknown>).requestId
        : undefined
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
      throw new Error('Wrapper 结果读取请求 ID 无效')
    }
    if (wrapperResultReadControllers.has(requestId)) {
      throw new Error('Wrapper 结果读取请求 ID 正在使用')
    }
    const controller = new AbortController()
    wrapperResultReadControllers.set(requestId, controller)
    try {
      return await remoteConnectionTracker.observe(remoteRequestProjectId(request), async () => {
        try {
          const result = await read(request, { signal: controller.signal })
          controller.signal.throwIfAborted()
          return result
        } catch (error) {
          if (controller.signal.aborted) throw new Error('Wrapper 结果读取已取消')
          throw error
        }
      })
    } finally {
      wrapperResultReadControllers.delete(requestId)
    }
  }

  return { controllers: wrapperResultReadControllers, run: runWrapperResultRead }
}
