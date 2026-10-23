import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { posix } from 'node:path'

import {
  connectRemoteSshSession,
  shellQuote as q,
  type RemoteSshSession
} from '../../src/main/agent/wrappers/remote-ssh-session'
import { remoteConnectionConfigForProfile } from '../../src/main/agent/remote-hosts'
import { observeAttestation } from './attestation-observer'
import { bounded, REMOTE_WORK_PARENT, type R8Input } from './types'
import type { DisconnectResult, R8Workspace, RpcGeneration, TimedOperation } from './workspace'

export interface SshR8Workspace extends R8Workspace {
  /** Opens one more owned SSH session; the application uses it as its connector. */
  connect(): Promise<RemoteSshSession>
}

interface OwnedRpc extends RpcGeneration {
  readonly master: ChildProcessWithoutNullStreams
}

/** `candidate` is a shell expression for the configured runtime root. */
function candidateExpression(configured: string): string {
  return configured.startsWith('~/') ? `"$HOME"/${q(configured.slice(2))}` : q(configured)
}

/** Creates (when missing) and verifies the runtime root and this run's work tree. */
export function prepareScript(input: R8Input): string {
  return `set -eu
umask 077
candidate=${candidateExpression(input.runtimeRoot)}
created=0
if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
  ${
    input.runtimeRootExplicit
      ? '[ -d "$(dirname -- "$candidate")" ]\n  mkdir -- "$candidate"'
      : 'mkdir -p -- "$candidate"'
  }
  created=1
fi
[ -d "$candidate" ] && [ ! -L "$candidate" ]
root=$(CDPATH= cd -P -- "$candidate" && pwd -P)
case "$root" in /*) ;; *) exit 22;; esac
${input.runtimeRootExplicit ? '[ "$root" = "$candidate" ]' : ':'}
parent="$root/${REMOTE_WORK_PARENT}"
[ ! -L "$parent" ]
[ -e "$parent" ] || mkdir -- "$parent"
for p in "$root" "$parent"; do
  [ -d "$p" ] && [ ! -L "$p" ]
  [ "$(stat -c %u -- "$p")" = "$(id -u)" ]
  mode=$(stat -c %a -- "$p")
  case "$mode" in ''|*[!0-7]*) exit 21;; esac
  [ "$((0$mode & 0022))" = 0 ]
done
${input.runtimeRootExplicit ? '[ "$(stat -c %a -- "$root")" = 700 ]' : ':'}
work="$root/${REMOTE_WORK_PARENT}/${input.runId}"
[ ! -e "$work" ] && [ ! -L "$work" ]
mkdir -- "$work"
mkdir -- "$work/project"
printf '%s\\n' ${q(input.runId)} > "$work/owner-token"
printf '%s\\n' ${q('R8_SEED_' + input.runId)} > "$work/project/input.txt"
printf '__R8_ROOT__%s\\n__R8_CREATED__%s\\n__R8_PROJECT__%s\\n' "$root" "$created" "$(CDPATH= cd -P -- "$work/project" && pwd -P)"`
}

export function parsePreparation(
  output: string,
  runId: string
): { runtimeRoot: string; projectRoot: string; rootCreated: boolean } {
  const fields = Object.fromEntries(
    [...output.matchAll(/^__R8_(ROOT|CREATED|PROJECT)__(.*)$/gm)].map((m) => [m[1], m[2]])
  )
  const runtimeRoot = fields.ROOT
  assert.ok(runtimeRoot?.startsWith('/'), 'Runtime root could not be verified')
  const projectRoot = posix.join(runtimeRoot, REMOTE_WORK_PARENT, runId, 'project')
  assert.equal(fields.PROJECT, projectRoot)
  return { runtimeRoot, projectRoot, rootCreated: fields.CREATED === '1' }
}

export function cleanupScript(runtimeRoot: string, runId: string): string {
  return `set -eu
root=${q(runtimeRoot)}
work="$root/${REMOTE_WORK_PARENT}/${runId}"
[ -d "$work" ] && [ ! -L "$work" ]
[ "$(CDPATH= cd -P -- "$work" && pwd -P)" = "$work" ]
[ "$(stat -c %u -- "$work")" = "$(id -u)" ]
[ "$(stat -c %a -- "$work")" = 700 ]
marker="$work/owner-token"
[ -f "$marker" ] && [ ! -L "$marker" ]
[ "$(stat -c %u -- "$marker")" = "$(id -u)" ]
[ "$(stat -c %h -- "$marker")" = 1 ]
[ "$(stat -c %a -- "$marker")" = 600 ]
[ "$(cat -- "$marker")" = ${q(runId)} ]
rm -rf --one-file-system -- "$work"
[ ! -e "$work" ] && [ ! -L "$work" ]
printf 'OWNED_TESTROOT_REMOVED\\n'`
}

export async function openSshWorkspace(
  input: R8Input,
  signal: AbortSignal
): Promise<SshR8Workspace> {
  const sessions = new Set<RemoteSshSession>()
  const channels: OwnedRpc['channel'][] = []
  const generations: string[] = []
  const rpc: OwnedRpc[] = []
  const metrics: TimedOperation[] = []
  const children = new Set<ChildProcessWithoutNullStreams>()
  const childClosures: Promise<void>[] = []
  const tunnelCounts = { opened: 0, closed: 0 }
  const config = {
    ...remoteConnectionConfigForProfile({ id: input.runId, label: input.host, ...input.profile }),
    userInitiated: true
  }

  const connect = async (): Promise<RemoteSshSession> => {
    signal.throwIfAborted()
    let master: ChildProcessWithoutNullStreams | undefined
    const started = performance.now()
    const session = await connectRemoteSshSession(config, {
      spawnImpl(binary, args, options) {
        // Observation only: the production argv/options and real OpenSSH, with no substitution.
        const child = spawn(binary, args, options)
        children.add(child)
        childClosures.push(
          new Promise<void>((resolve) =>
            child.once('close', () => {
              children.delete(child)
              resolve()
            })
          )
        )
        if (binary === 'ssh' && args.includes('-M')) {
          assert.equal(master, undefined, 'Only this connector owns this SSH master')
          master = child
        }
        return child
      }
    })
    metrics.push({ kind: 'ssh-connect', elapsedMs: performance.now() - started })
    assert.ok(master)
    const owned = master
    if (session.uploadFile) {
      const upload = session.uploadFile.bind(session)
      session.uploadFile = async (...args) => {
        const at = performance.now()
        try {
          await upload(...args)
        } finally {
          metrics.push({ kind: 'canonical-upload', elapsedMs: performance.now() - at })
        }
      }
    }
    sessions.add(session)
    const close = session.close.bind(session)
    let closing: Promise<void> | undefined
    session.close = () => (closing ??= close().finally(() => sessions.delete(session)))
    if (session.openReverseTunnel) {
      const open = session.openReverseTunnel.bind(session)
      session.openReverseTunnel = async (options) => {
        const tunnel = await open(options)
        tunnelCounts.opened++
        // A killed SSH master invalidates its tunnel without a successful
        // control-socket cancel. Count the lease's closed signal; close() below
        // separately waits for every owned OpenSSH process to exit.
        void tunnel.closed.then(
          () => {
            tunnelCounts.closed++
          },
          () => undefined
        )
        return tunnel
      }
    }
    if (session.openStdio) {
      const open = session.openStdio.bind(session)
      session.openStdio = async (command) => {
        const openedAt = performance.now()
        const channel = await open(command)
        if (command.includes("'--mode' 'rpc'")) {
          channels.push(channel)
          const record: OwnedRpc = { channel, master: owned, openedAt }
          rpc.push(record)
          observeAttestation(record, channel, input.bundleHash, generations)
        }
        return channel
      }
    }
    if (signal.aborted) {
      await session.close()
      signal.throwIfAborted()
    }
    return session
  }

  const session = await connect()
  const command = async (script: string): Promise<string> => {
    signal.throwIfAborted()
    assert.ok(session.execBounded)
    const reply = await session.execBounded(script, {
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      signal
    })
    assert.equal(reply.code, 0, `Audit command failed on ${input.host}`)
    assert.equal(reply.stdoutTruncated, false)
    assert.equal(reply.stderrTruncated, false)
    return reply.stdout
  }

  try {
    assert.ok(
      session.execBounded && session.execWithInput && session.openStdio && session.openReverseTunnel
    )
    const prepared = await command(prepareScript(input))
    const { runtimeRoot, projectRoot, rootCreated } = parsePreparation(prepared, input.runId)

    return {
      connect,
      command,
      projectRoot,
      runtimeRoot,
      rootCreated,
      rpc,
      generations,
      metrics,
      hasOpenChannels: () => channels.length > 0,
      tunnelCounts: () => Promise.resolve({ ...tunnelCounts }),
      async awaitRpcClosed() {
        await Promise.all(
          rpc.map(async ({ channel, master }) => {
            await bounded(channel.closed, 10_000, 'RPC physical close before work removal')
            if (master.exitCode === null && master.signalCode === null) {
              await bounded(
                new Promise<void>((resolve) => master.once('close', () => resolve())),
                10_000,
                'RPC SSH master physical close before work removal'
              )
            }
          })
        )
      },
      async abruptDisconnectLatest(): Promise<DisconnectResult> {
        const owned = rpc.at(-1)
        assert.ok(owned?.nonce && owned.attestedAt, 'Only an attested RPC connection is killed')
        const master = owned.master
        assert.ok(
          master.pid &&
            children.has(master) &&
            master.exitCode === null &&
            master.signalCode === null
        )
        const at = performance.now()
        const exited = new Promise<string | null>((resolve) =>
          master.once('close', (_code, exitSignal) => resolve(exitSignal))
        )
        assert.equal(master.kill('SIGKILL'), true, 'Owned SSH master must receive the signal')
        const signalName = await bounded(exited, 10_000, 'killed SSH master physical close')
        assert.equal(signalName, 'SIGKILL')
        await bounded(owned.channel.closed, 10_000, 'lost RPC channel physical close')
        return {
          transport: 'ssh-master',
          pid: master.pid,
          signal: 'SIGKILL',
          physicalRpcClosed: true,
          elapsedMs: performance.now() - at
        }
      },
      async cleanupOwnedWork() {
        // A fresh connection: cleanup must work after cancellation and after the master was killed.
        const cleanup = await connectRemoteSshSession(config)
        sessions.add(cleanup)
        let failure: unknown
        try {
          assert.ok(cleanup.execBounded)
          const reply = await cleanup.execBounded(cleanupScript(runtimeRoot, input.runId), {
            timeoutMs: 30_000,
            maxOutputBytes: 4096
          })
          assert.equal(reply.code, 0, 'Owned test tree cleanup refused')
          assert.equal(reply.stdout.trim(), 'OWNED_TESTROOT_REMOVED')
        } catch (error) {
          failure = error
        }
        try {
          await cleanup.close()
        } catch (error) {
          failure ??= error
        }
        sessions.delete(cleanup)
        if (failure) throw failure
      },
      async close() {
        const results = await Promise.allSettled([
          ...[...sessions].map((s) => bounded(s.close(), 10_000, 'owned SSH close')),
          ...channels.map((c) => bounded(c.closed, 10_000, 'RPC physical close')),
          ...childClosures.map((closed) => bounded(closed, 10_000, 'owned OpenSSH process close'))
        ])
        const failure = results.find((x) => x.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      }
    }
  } catch (error) {
    const settled = await Promise.allSettled([...sessions].map((s) => s.close()))
    const failures = settled.flatMap((x) => (x.status === 'rejected' ? [x.reason] : []))
    if (failures.length)
      throw new AggregateError([error, ...failures], 'R8 setup/cleanup failed', { cause: error })
    throw error
  }
}
