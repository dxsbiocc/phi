const activeDeployments = new Map<string, Promise<void>>()

async function waitForDeployment(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!signal) return previous
  let aborted!: () => void
  try {
    await Promise.race([
      previous,
      new Promise<never>((_resolve, reject) => {
        aborted = () => reject(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) aborted()
      })
    ])
  } finally {
    signal.removeEventListener('abort', aborted)
  }
}

/** Serialize a complete remote prepare/upload/activate transaction per managed artifact. */
export async function withDeploymentLock<T>(
  key: string,
  signal: AbortSignal | undefined,
  deploy: () => Promise<T>
): Promise<T> {
  const previous = activeDeployments.get(key) ?? Promise.resolve()
  let release!: () => void
  const finished = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = previous.then(() => finished)
  activeDeployments.set(key, current)
  void current.then(() => {
    if (activeDeployments.get(key) === current) activeDeployments.delete(key)
  })
  try {
    await waitForDeployment(previous, signal)
    signal?.throwIfAborted()
    return await deploy()
  } finally {
    release()
  }
}
