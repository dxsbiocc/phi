import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import { shellQuote } from '../wrappers/remote-ssh-session'
import type { MissingToolHostExecution } from './missing-tool-discovery'

function remoteCommand(command: readonly string[], cwd: string): string {
  return `cd ${shellQuote(cwd)} && ${command.map(shellQuote).join(' ')}`
}

/** Adapts an already-authorized SSH session to the bounded argv execution used by tool discovery. */
export function remoteSessionMissingToolExecution(
  session: RemoteSshSession
): MissingToolHostExecution {
  return {
    run: async (command, options) => {
      options.signal?.throwIfAborted()
      const invocation = remoteCommand(command, options.cwd)
      if (session.execBounded) {
        const result = await session.execBounded(invocation, {
          timeoutMs: options.timeoutMs ?? 3_000,
          maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
          ...(options.signal ? { signal: options.signal } : {})
        })
        options.signal?.throwIfAborted()
        return {
          ...result,
          truncated: result.stdoutTruncated || result.stderrTruncated
        }
      }
      const result = await session.exec(invocation)
      options.signal?.throwIfAborted()
      return { ...result, truncated: false }
    }
  }
}
