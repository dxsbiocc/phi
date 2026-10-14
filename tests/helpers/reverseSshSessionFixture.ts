import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connectRemoteSshSession,
  type RemoteSshSession
} from '../../src/main/agent/wrappers/remote-ssh-session'
import { createRemoteSshAuthGate } from '../../src/main/agent/wrappers/remote-ssh-auth-gate'

export function socketTable(ports: readonly number[], wildcard = false): string {
  const header =
    '  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode'
  const rows = ports.map(
    (port, index) =>
      ` ${index}: ${wildcard ? '00000000' : '0100007F'}:${port.toString(16).padStart(4, '0').toUpperCase()} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 123`
  )
  return `PHI_TCP4\n${header}\n${rows.join('\n')}\nPHI_TCP6\n${header}\n`
}

export async function createReverseSshFixture(
  options: {
    forwardDelayMs?: number
    portOutput?: string
    wildcard?: boolean
    inspectOutput?: string
    cancelFails?: boolean
  } = {}
): Promise<{
  session: RemoteSshSession
  master: ChildProcessWithoutNullStreams
  records: Array<{ args: string[]; input?: string }>
  forwards: Map<string, number>
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'phi-reverse-ssh-'))
  const records: Array<{ args: string[]; input?: string }> = []
  const forwards = new Map<string, number>()
  let master!: ChildProcessWithoutNullStreams
  let nextPort = 41000
  const session = await connectRemoteSshSession(
    { host: 'synthetic-host', user: 'synthetic-user', port: 2222 },
    {
      tempRoot: root,
      authGate: createRemoteSshAuthGate(),
      resolveIdentityFiles: async () => [],
      spawnImpl(_binary, args, spawnOptions) {
        records.push({ args: [...args] })
        if (args.includes('-M')) {
          master = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], spawnOptions)
          return master
        }
        if (args.includes('-O')) {
          const action = args[args.indexOf('-O') + 1]
          const specification = args[args.indexOf('-R') + 1]
          if (action === 'forward') {
            const port = forwards.get(specification) ?? ++nextPort
            forwards.set(specification, port)
            return spawn(
              process.execPath,
              [
                '-e',
                'setTimeout(()=>{process.stdout.write(process.argv[1])},Number(process.argv[2]))',
                options.portOutput ?? `${port}\n`,
                String(options.forwardDelayMs ?? 0)
              ],
              spawnOptions
            )
          }
          if (action === 'cancel') {
            if (!options.cancelFails) forwards.delete(specification)
            return spawn('/bin/sh', ['-c', options.cancelFails ? 'exit 1' : 'exit 0'], spawnOptions)
          }
          return spawn('/bin/sh', ['-c', 'exit 0'], spawnOptions)
        }
        if (args.at(-1)?.includes('/proc/net/tcp'))
          return spawn(
            process.execPath,
            [
              '-e',
              'process.stdout.write(process.argv[1])',
              options.inspectOutput ?? socketTable([...forwards.values()], options.wildcard)
            ],
            spawnOptions
          )
        return spawn('/bin/sh', ['-c', args.at(-1) ?? ''], spawnOptions)
      }
    }
  )
  return {
    session,
    master,
    records,
    forwards,
    async cleanup() {
      await session.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}
