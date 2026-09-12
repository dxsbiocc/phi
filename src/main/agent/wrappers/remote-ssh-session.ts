import { Client, type ConnectConfig } from 'ssh2'

/**
 * Already-resolved connection material for one remote host. Callers resolve
 * `privateKey`/`passphrase` from the OS keychain (safeStorage) before
 * building this — this module never reads, stores, or logs credentials
 * itself, and a `RemoteConnectionConfig` should never be persisted as-is.
 */
export interface RemoteConnectionConfig {
  host: string
  port?: number
  username: string
  privateKey: string | Buffer
  passphrase?: string
  /** Defaults to 15s — long enough for a slow login node, short enough to fail fast on a dead host. */
  readyTimeoutMs?: number
  /**
   * Defaults to 30s. Bounds each individual `exec()` call, not just the
   * initial handshake — without this, a connection that goes half-open
   * mid-command (TCP still "open" per the OS, but no data flowing — the
   * exact failure mode of a flaky VPN link to a real cluster, confirmed
   * against one) leaves `exec()`'s promise pending forever: no error, no
   * timeout, nothing, since ssh2 never fires `close` on a channel whose
   * underlying connection just silently died. `readyTimeoutMs` alone does
   * NOT cover this — it only guards the handshake before `ready` fires.
   */
  execTimeoutMs?: number
}

export interface RemoteExecResult {
  stdout: string
  stderr: string
  code: number | null
  signal: string | null
}

/**
 * The primitive remote operations `executor-remote.ts`'s runners are built
 * from. Kept minimal and POSIX-shell-shaped (no native SFTP directory
 * recursion, no streaming) — everything here assumes a Linux/macOS remote,
 * matching the shell commands (`setsid`, `kill -0`, …) the design doc uses.
 */
export interface RemoteSshSession {
  exec(command: string): Promise<RemoteExecResult>
  readTextFile(remotePath: string): Promise<string>
  writeTextFile(remotePath: string, content: string): Promise<void>
  mkdirp(remotePath: string): Promise<void>
  exists(remotePath: string): Promise<boolean>
  close(): Promise<void>
}

/** POSIX single-quote escaping for safe shell interpolation of untrusted-ish paths/content. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// --- pure command builders ---------------------------------------------
//
// Split out from `buildSession` below so they're runnable against a real
// local `bash` in tests (see tests/wrapper-remote-ssh-session.test.ts) —
// exactly the gap that let two real bugs (an invalid `& &&` sequence in
// executor-remote.ts, and this file's own writeTextFile silently adding a
// spurious trailing newline to any content that already ended in one) ship
// with a fully green test suite: every existing test drove these through an
// in-memory fake session that never actually invoked a shell.

export function buildMkdirpCommand(remotePath: string): string {
  return `mkdir -p ${shellQuote(remotePath)}`
}

export function buildExistsCommand(remotePath: string): string {
  return `test -e ${shellQuote(remotePath)}`
}

export function buildReadTextFileCommand(remotePath: string): string {
  return `cat ${shellQuote(remotePath)}`
}

export interface WriteTextFileCommand {
  /** Writes `content`, plus possibly one extra trailing newline — see `needsTruncate`. */
  script: string
  /**
   * True when `content` didn't already end in `\n`: the heredoc's marker
   * line forces one extra trailing newline onto the file that a follow-up
   * `truncate -s -1` (this module's `buildTruncateLastByteCommand`) must
   * strip for the write to be byte-exact.
   */
  needsTruncate: boolean
}

/**
 * Builds the heredoc script that writes `content` to `remotePath`.
 * Quoting the delimiter (`<<'MARKER'`) disables all shell expansion inside
 * the body, so `content` is written byte-for-byte regardless of `$`,
 * backticks, or quotes in it — only a line matching the marker itself
 * would confuse it, so the marker is picked to not collide.
 */
export function buildWriteTextFileCommand(
  remotePath: string,
  content: string
): WriteTextFileCommand {
  let heredocMarker = '__PHI_EOF__'
  while (content.includes(heredocMarker)) {
    heredocMarker = `${heredocMarker}_${Math.random().toString(36).slice(2, 8)}`
  }
  // The marker must start its own line, so the heredoc body needs a
  // trailing newline regardless of whether `content` has one. When it
  // already does, that's a no-op; when it doesn't, this writes one byte
  // more than `content` actually has — the caller corrects that with
  // `buildTruncateLastByteCommand` when `needsTruncate` is true.
  const endsWithNewline = content.endsWith('\n')
  const body = endsWithNewline ? content : `${content}\n`
  const script = `cat > ${shellQuote(remotePath)} <<'${heredocMarker}'\n${body}${heredocMarker}\n`
  return { script, needsTruncate: !endsWithNewline }
}

export function buildTruncateLastByteCommand(remotePath: string): string {
  return `truncate -s -1 ${shellQuote(remotePath)}`
}

/**
 * Real `ssh2`-backed implementation. Exported separately from the
 * `RemoteSshSession` interface so runners can accept an injected fake in
 * tests instead — see `executor-remote.ts`'s `RemoteControllerOptions.connectImpl`.
 */
export function connectRemoteSshSession(config: RemoteConnectionConfig): Promise<RemoteSshSession> {
  const client = new Client()
  const connectConfig: ConnectConfig = {
    host: config.host,
    port: config.port ?? 22,
    username: config.username,
    privateKey: config.privateKey,
    passphrase: config.passphrase,
    readyTimeout: config.readyTimeoutMs ?? 15_000,
    // Belt-and-suspenders alongside execTimeoutMs below: an SSH-level
    // keepalive lets ssh2 itself notice a dead connection (no response to
    // 3 keepalive probes 15s apart) and emit a real `error`/`close` event,
    // rather than relying solely on each exec() call's own timer.
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3
  }

  return new Promise<RemoteSshSession>((resolveSession, reject) => {
    client.once('error', reject)
    client.once('ready', () => {
      client.removeListener('error', reject)
      resolveSession(buildSession(client, config.execTimeoutMs ?? 30_000))
    })
    client.connect(connectConfig)
  })
}

/**
 * Exported (not just used internally by `connectRemoteSshSession`) so the
 * exec-timeout behavior is unit-testable against a minimal fake `Client`,
 * without needing a real flaky network to reproduce a hung connection —
 * see tests/wrapper-remote-ssh-session.test.ts.
 */
export function buildSession(client: Client, execTimeoutMs: number): RemoteSshSession {
  function exec(command: string): Promise<RemoteExecResult> {
    return new Promise((resolveExec, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(
          new Error(
            `远程命令执行超时（${execTimeoutMs}ms 内无响应，连接可能已失效）: ${command.slice(0, 200)}`
          )
        )
      }, execTimeoutMs)

      client.exec(command, (err, stream) => {
        if (err) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(err)
          return
        }
        let stdout = ''
        let stderr = ''
        stream
          .on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf-8')
          })
          .on('close', (code: number | null, signal: string | null) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolveExec({ stdout, stderr, code, signal })
          })
          .stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf-8')
          })
      })
    })
  }

  async function mkdirp(remotePath: string): Promise<void> {
    const result = await exec(buildMkdirpCommand(remotePath))
    if (result.code !== 0) {
      throw new Error(`远程创建目录失败: ${remotePath}\n${result.stderr || result.stdout}`)
    }
  }

  async function exists(remotePath: string): Promise<boolean> {
    const result = await exec(buildExistsCommand(remotePath))
    return result.code === 0
  }

  async function readTextFile(remotePath: string): Promise<string> {
    // `cat` over the exec channel rather than a raw SFTP stream — these
    // files (launch.sh, params.json, exit_code, logs) are all small and
    // this avoids opening a second (SFTP) channel for the common path.
    const result = await exec(buildReadTextFileCommand(remotePath))
    if (result.code !== 0) {
      throw new Error(`远程读取文件失败: ${remotePath}\n${result.stderr}`)
    }
    return result.stdout
  }

  async function writeTextFile(remotePath: string, content: string): Promise<void> {
    // Heredoc via exec keeps this on the same channel as everything else
    // and sidesteps SFTP write-stream lifecycle entirely.
    const { script, needsTruncate } = buildWriteTextFileCommand(remotePath, content)
    const result = await exec(script)
    if (result.code !== 0) {
      throw new Error(`远程写入文件失败: ${remotePath}\n${result.stderr}`)
    }
    if (needsTruncate) {
      // Verified against a real (loopback) SSH server: without this, any
      // content not already ending in `\n` round-trips with one silently
      // appended — see buildWriteTextFileCommand's doc comment.
      const trimResult = await exec(buildTruncateLastByteCommand(remotePath))
      if (trimResult.code !== 0) {
        throw new Error(`远程写入文件失败（截断多余换行符）: ${remotePath}\n${trimResult.stderr}`)
      }
    }
  }

  async function close(): Promise<void> {
    await new Promise<void>((resolveClose) => {
      client.once('close', () => resolveClose())
      client.end()
    })
  }

  return { exec, readTextFile, writeTextFile, mkdirp, exists, close }
}
