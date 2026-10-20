import { chmod, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { warmExecutable } from './firstExec'

/** Makes a fake command exit at once, so fixtures can pay macOS's first-exec scan up front. */
const WARM_ARG = '--phi-warm'
const WARM_LINE = `[[ "\${1-}" == ${WARM_ARG} ]] && exit 0`

export async function writeRemoteJupyterTestExecutables(
  ssh: string,
  jupyter: string
): Promise<void> {
  const ps = join(dirname(ssh), 'ps')
  await writeFile(
    ssh,
    [
      '#!/bin/bash',
      WARM_LINE,
      'printf "%s\\n" "$@" >> "$PHI_FAKE_JUPYTER_SSH_ARGS"',
      'printf "%s\\n" "---" >> "$PHI_FAKE_JUPYTER_SSH_ARGS"',
      '[[ -z "$PHI_FAKE_JUPYTER_RECONCILE_FAIL" || " $* " == *" -L "* ]] || exit 255',
      'command="${!#}"',
      'exec /bin/bash -c "$command"',
      ''
    ].join('\n')
  )
  await writeFile(
    jupyter,
    [
      '#!/bin/bash',
      WARM_LINE,
      'printf "%s\\n" "$@" >> "$PHI_FAKE_JUPYTER_ARGS"',
      'printf "%s\\n" "---" >> "$PHI_FAKE_JUPYTER_ARGS"',
      'echo "stdout token=$JUPYTER_TOKEN"',
      'echo "stderr token=$JUPYTER_TOKEN" >&2',
      'printf "split=%s" "${JUPYTER_TOKEN:0:12}"',
      'sleep 0.02',
      'printf "%s\\n" "${JUPYTER_TOKEN:12}"',
      '[[ ${#JUPYTER_TOKEN} -ge 43 ]] || exit 64',
      '[[ -z "$PHI_FAKE_JUPYTER_ALWAYS_FAIL" ]] || { printf "unterminated"; echo "Address already in use" >&2; exit 98; }',
      "trap 'exit 0' TERM INT",
      "( trap 'exit 0' TERM INT; while :; do sleep 0.05; done ) &",
      'printf "%s %s\\n" "$$" "$!" > "$PHI_FAKE_JUPYTER_PIDS"',
      'wait',
      ''
    ].join('\n')
  )
  await writeFile(
    ps,
    [
      '#!/bin/bash',
      WARM_LINE,
      // The cleanup's live-member listing needs the host's real process table.
      'if [[ "$*" == "-A -o pgid= -o stat=" ]]; then',
      '  for real in /bin/ps /usr/bin/ps; do [[ -x "$real" ]] && exec "$real" "$@"; done',
      '  exit 1',
      'fi',
      // The launch script's resource monitor samples every 5 s. A sample it cannot read stops
      // Jupyter, so a slow (loaded) start would lose the server. macOS ps has no nlwp: report 1.
      'if [[ "$*" == "-eo pgid=,rss=,nlwp=,time=" ]]; then',
      "  exec /bin/ps -eo pgid=,rss=,time= | awk '{ print $1, $2, 1, $3 }'",
      'fi',
      'pid="${!#}"',
      'kill -0 "$pid" 2>/dev/null || exit 1',
      'case "$*" in',
      '  *"pgid="*) printf " %s\\n" "$pid" ;;',
      '  *"lstart="*) printf " Thu Jan  1 00:00:%02d 1970\\n" "$((pid % 60))" ;;',
      '  *"command="*) printf "sh -c phi-jupyter-lease-%s\\n" "$PHI_RECONCILE_EXPECTED_LEASE" ;;',
      '  *"rss="*) printf "1 1 00:00:00\\n" ;;',
      '  *) exit 1 ;;',
      'esac',
      ''
    ].join('\n')
  )
  await Promise.all([chmod(ssh, 0o755), chmod(jupyter, 0o755), chmod(ps, 0o755)])
  // Every fixture writes these into a fresh directory; the product's 15 s ssh deadline must not
  // absorb their first-exec scans.
  for (const path of [ssh, jupyter, ps]) warmExecutable(path, [WARM_ARG])
}

export async function installBlockingRemoteJupyterSetsid(root: string): Promise<void> {
  const path = join(root, 'setsid')
  await writeFile(
    path,
    [
      '#!/bin/bash',
      WARM_LINE,
      'echo "$$" > "$PHI_SETSID_PID"',
      'while [[ ! -e "$PHI_SETSID_GATE" ]]; do sleep 0.02; done',
      'exec "$@"',
      ''
    ].join('\n')
  )
  await chmod(path, 0o755)
  warmExecutable(path, [WARM_ARG])
}

export async function installRemoteJupyterSetsid(root: string): Promise<void> {
  const path = join(root, 'setsid')
  await writeFile(
    path,
    ['#!/usr/bin/perl', 'use POSIX;', 'POSIX::setsid();', 'exec @ARGV or die "exec: $!";', ''].join(
      '\n'
    )
  )
  await chmod(path, 0o755)
  warmExecutable(path, ['/usr/bin/true'])
}
