import { writeFile } from 'node:fs/promises'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function redactConsoleText(value) {
  return String(value ?? '')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '$1-[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh_[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, 'xox-[REDACTED]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, 'AKIA[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|token|secret|code)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret)"?\s*[:=]\s*)[^,}\s]+/gi, '$1[REDACTED]')
}

function remoteObjectText(argument) {
  if (typeof argument?.value === 'string') return argument.value
  if (argument?.value !== undefined) {
    try {
      return JSON.stringify(argument.value)
    } catch {
      return String(argument.value)
    }
  }
  return argument?.description ?? argument?.unserializableValue ?? argument?.type ?? ''
}

export class ConsoleEvidence {
  constructor() {
    this.lines = []
  }

  add(kind, text) {
    const line = `[${new Date().toISOString()}] ${kind}: ${redactConsoleText(text)}`
    this.lines.push(line)
  }

  async flush(path) {
    const body = this.lines.length ? `${this.lines.join('\n')}\n` : ''
    await writeFile(path, body, { mode: 0o600 })
  }
}

export class CdpClient {
  constructor(webSocketUrl, consoleEvidence) {
    this.webSocketUrl = webSocketUrl
    this.consoleEvidence = consoleEvidence
    this.socket = null
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
  }

  async connect(timeoutMs = 15_000) {
    const socket = new WebSocket(this.webSocketUrl)
    this.socket = socket
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connection timed out')), timeoutMs)
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('CDP WebSocket connection failed'))
        },
        { once: true }
      )
    })
    socket.addEventListener('message', (event) => this.#onMessage(event.data))
    socket.addEventListener('close', (event) => {
      this.closed = true
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error('CDP connection closed'))
      }
      this.pending.clear()
    })

    this.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error' && params.type !== 'warning') return
      const text = (params.args ?? []).map(remoteObjectText).join(' ')
      this.consoleEvidence.add(`console.${params.type}`, text)
    })
    this.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails ?? {}
      const text = details.exception?.description ?? details.text ?? 'Renderer exception'
      this.consoleEvidence.add('exception', text)
    })
    this.on('Log.entryAdded', ({ entry }) => {
      if (entry?.level !== 'error' && entry?.level !== 'warning') return
      this.consoleEvidence.add(`log.${entry.level}`, entry.text ?? '')
    })
    await Promise.all([
      this.send('Runtime.enable'),
      this.send('Page.enable'),
      this.send('Log.enable')
    ])
  }

  #onMessage(raw) {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    if (message.id) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    const callbacks = this.listeners.get(message.method)
    if (!callbacks) return
    for (const callback of callbacks) callback(message.params ?? {})
  }

  on(method, callback) {
    const callbacks = this.listeners.get(method) ?? new Set()
    callbacks.add(callback)
    this.listeners.set(method, callbacks)
    return () => callbacks.delete(callback)
  }

  send(method, params = {}, timeoutMs = 20_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP is not connected (${method})`))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, options = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: options.awaitPromise !== false,
        returnByValue: options.returnByValue !== false,
        userGesture: options.userGesture !== false
      },
      options.timeoutMs ?? 30_000
    ).catch((error) => {
      // Name the failing script so a driver failure points at its source, not just CDP.
      const head = String(expression).replace(/\s+/g, ' ').trim().slice(0, 160)
      throw new Error(`${error instanceof Error ? error.message : String(error)} [in: ${head}]`)
    })
    if (result.exceptionDetails) {
      const details = result.exceptionDetails
      throw new Error(
        details.exception?.description ?? details.text ?? 'Renderer evaluation threw an exception'
      )
    }
    return result.result?.value
  }

  async waitForValue(expression, options = {}) {
    const timeoutMs = options.timeoutMs ?? 20_000
    const intervalMs = options.intervalMs ?? 250
    const description = options.description ?? 'renderer condition'
    const deadline = Date.now() + timeoutMs
    let lastValue
    let lastError
    while (Date.now() < deadline) {
      if (this.closed) throw new Error(`CDP connection closed while waiting for ${description}`)
      try {
        lastValue = await this.evaluate(expression, { timeoutMs: Math.min(10_000, timeoutMs) })
        if (lastValue) return lastValue
        lastError = undefined
      } catch (error) {
        if (this.closed) throw error
        lastError = error
      }
      await delay(intervalMs)
    }
    const suffix = lastError
      ? `; last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
      : lastValue !== undefined
        ? `; last value: ${JSON.stringify(lastValue)}`
        : ''
    throw new Error(`Timed out waiting for ${description}${suffix}`)
  }

  async screenshot(path) {
    const result = await this.send(
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: false },
      30_000
    )
    await writeFile(path, Buffer.from(result.data, 'base64'), { mode: 0o600 })
  }

  close() {
    this.closed = true
    try {
      this.socket?.close()
    } catch {
      // The app may already have closed.
    }
  }
}

export async function discoverPageTarget(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error('Acceptance workflow aborted before CDP connected')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const targets = await response.json()
      const target = targets.find(
        (item) =>
          item.type === 'page' &&
          typeof item.webSocketDebuggerUrl === 'string' &&
          // The startup splash is an inline data: page that closes once the app window loads.
          !/^(?:devtools|data):/.test(String(item.url ?? ''))
      )
      if (target) return target
      lastError = new Error('No renderer page target is available yet')
    } catch (error) {
      lastError = error
    }
    await delay(300)
  }
  throw new Error(
    `Unable to discover Phi's CDP page target on port ${port}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  )
}

export async function dispatchSelectAllAndInsert(client, text) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 4,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 0
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 4,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 0
  })
  await client.send('Input.insertText', { text })
}

export async function sleep(ms) {
  await delay(ms)
}
