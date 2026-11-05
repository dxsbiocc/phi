import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  posixJoin,
  wslProcessEnvironment,
  wslRuntimeDirectory,
  type WslRuntime,
  type WslSpawnPlan
} from './wsl'

const START_GROUP = `
set -eu
receipt=$1
shift
printf '%s\n' "$$" > "$receipt.pid"
test ! -e "$receipt.cancel" || exit 143
trap ':' TERM INT
exec 3<&0
"$@" <&3 3<&- &
child=$!
while :; do
  status=0
  wait "$child" || status=$?
  kill -0 "$child" 2>/dev/null || exit "$status"
done
`

const SIGNAL_GROUP = `
set -eu
touch -- "$1.cancel"
test -f "$1.pid" || exit 0
read -r pid < "$1.pid"
case "$pid" in ''|*[!0-9]*) exit 1 ;; esac
test -r "/proc/$pid/environ" || exit 0
tr '\\000' '\\n' < "/proc/$pid/environ" | grep -Fxq -- "PHI_WSL_GROUP=$2" || exit 0
/bin/kill -s "$3" -- "-$pid" || test ! -d "/proc/$pid"
`

export interface WslProcess {
  child: ChildProcess
  signal: (signal: 'SIGTERM' | 'SIGKILL') => void
}

/** Relay cancellation to just the Linux process group started for this invocation. */
export function spawnWslProcess(
  runtime: WslRuntime,
  plan: WslSpawnPlan,
  options: SpawnOptions
): WslProcess {
  const executeAt = plan.args.indexOf('--exec')
  if (executeAt < 0) throw new Error('WSL invocation is missing --exec')
  const token = randomBytes(16).toString('hex')
  const receipt = posixJoin(runtime.linuxRoot, 'processes', token)
  const child = spawn(
    plan.executable,
    [
      ...plan.args.slice(0, executeAt + 1),
      '/usr/bin/env',
      '-i',
      `PHI_WSL_GROUP=${token}`,
      '/usr/bin/setsid',
      '--fork',
      '--wait',
      '/bin/sh',
      '-c',
      START_GROUP,
      'phi-run',
      receipt,
      ...plan.args.slice(executeAt + 1)
    ],
    { ...options, windowsHide: true }
  )
  const pending = new Set<ChildProcess>()
  let closed = false
  const clean = (): void => {
    if (!closed || pending.size) return
    for (const suffix of ['pid', 'cancel']) {
      try {
        rmSync(join(wslRuntimeDirectory(runtime), 'processes', `${token}.${suffix}`), {
          force: true
        })
      } catch {
        // A disconnected distribution will no longer have a running launcher.
      }
    }
  }
  child.once('close', () => {
    closed = true
    clean()
  })
  const signal = (name: 'SIGTERM' | 'SIGKILL'): void => {
    if (closed) return
    const relay = execFile(
      plan.executable,
      [
        '-d',
        runtime.ready.distro,
        '--exec',
        '/usr/bin/env',
        '-i',
        'PATH=/usr/bin:/bin',
        '/bin/sh',
        '-c',
        SIGNAL_GROUP,
        'phi-signal',
        receipt,
        token,
        name.slice(3)
      ],
      { env: wslProcessEnvironment(options.env), windowsHide: true, timeout: 8_000 },
      (error) => {
        pending.delete(relay)
        if (error && !closed) child.kill(name)
        clean()
      }
    )
    pending.add(relay)
  }
  return { child, signal }
}
