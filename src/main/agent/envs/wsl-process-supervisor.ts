// The stdin pipe represents desktop ownership of this Linux process group. EOF
// stops the group even if the Windows caller was terminated without a shutdown hook.
// Only the notebook bridge writes interrupt requests; user stdin travels via Jupyter.
const SUPERVISOR = String.raw`
import os
import re
import signal
import subprocess
import sys
import threading

def connection_path(path, distro):
    unc = re.fullmatch(r'\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)\\(.+)', path, re.IGNORECASE)
    if unc:
        if unc[1].casefold() != distro.casefold():
            raise ValueError('Jupyter connection file is in a different WSL distribution')
        return '/' + unc[2].replace('\\', '/')
    return subprocess.check_output(['wslpath', '-a', '-u', path], text=True).rstrip('\n')

def run():
    grace, distro, index, *argv = sys.argv[1:]
    if index != '-1':
        position = int(index)
        argv[position] = connection_path(argv[position], distro)
    child = subprocess.Popen(argv, start_new_session=True, stdin=subprocess.DEVNULL)
    done = threading.Event()

    def signal_group(sig):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass

    def relay():
        pending = b''
        while True:
            data = os.read(0, 64)
            if not data:
                break
            *messages, pending = (pending + data).split(b'\n')
            for message in messages:
                if message == b'INT':
                    signal_group(signal.SIGINT)
        signal_group(signal.SIGTERM)
        if not done.wait(float(grace) / 1000):
            signal_group(signal.SIGKILL)

    threading.Thread(target=relay, daemon=True).start()
    try:
        code = child.wait()
        return code if code >= 0 else 128 - code
    finally:
        signal_group(signal.SIGKILL)
        done.set()

sys.exit(run())
`

export function wslProcessSupervisorArgs(
  argv: readonly string[],
  options: { graceMs: number; distro: string; connectionIndex?: number }
): string[] {
  return [
    '-c',
    SUPERVISOR,
    String(options.graceMs),
    options.distro,
    String(options.connectionIndex ?? -1),
    ...argv
  ]
}
