import { join } from 'node:path'

import { prepareEnvironmentCommand, type EnvHandle } from '../envs'
import { wslProcessSupervisorArgs } from '../envs/wsl-process-supervisor'

// Jupyter replaces the leading `python` with the server's own interpreter. Its Windows
// interrupt/parent handles cannot be inherited by a Linux kernel. Keep the stdin pipe
// open while the kernel is owned by Jupyter, and forward Jupyter interrupts over it.
const WINDOWS_BRIDGE = String.raw`
import os
import subprocess
import sys
import _winapi

def run():
    env = {key: value for key, value in os.environ.items() if key.upper() != 'WSLENV'}
    with subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE,
                          env=env, creationflags=subprocess.CREATE_NO_WINDOW) as child:
        handles = [child._handle]
        parent = os.environ.get('JPY_PARENT_PID')
        interrupt = os.environ.get('JPY_INTERRUPT_EVENT')
        if parent:
            handles.append(int(parent))
        if interrupt:
            handles.append(int(interrupt))
        while True:
            signaled = _winapi.WaitForMultipleObjects(handles, False, _winapi.INFINITE)
            if signaled == 0:
                return child.wait()
            if parent and signaled == 1:
                break
            try:
                child.stdin.write(b'INT\n')
                child.stdin.flush()
            except BrokenPipeError:
                break
        try:
            child.stdin.close()
        except BrokenPipeError:
            pass
        return child.wait()

sys.exit(run())
`

const CONNECTION_FILE = '{connection_file}'

export function wslKernelArgv(
  handle: EnvHandle,
  argv: readonly string[],
  options: { baseEnv: NodeJS.ProcessEnv; extraEnv?: Record<string, string> }
): string[] {
  const position = argv.indexOf(CONNECTION_FILE)
  if (position < 1) throw new Error('WSL kernel arguments are missing the Jupyter connection file')
  const plan = prepareEnvironmentCommand(handle, [join(handle.prefix, 'bin', 'python')], {
    ...options,
    hostPlatform: 'win32'
  })
  if (!plan.wsl) throw new Error('WSL kernel requires a WSL environment')
  return [
    'python',
    '-c',
    WINDOWS_BRIDGE,
    plan.executable,
    ...plan.args,
    ...wslProcessSupervisorArgs(argv, {
      graceMs: 2000,
      distro: plan.wsl.distro,
      connectionIndex: position
    })
  ]
}
