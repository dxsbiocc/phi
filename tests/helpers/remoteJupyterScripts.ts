import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function writeRemoteJupyterTestExecutables(
  ssh: string,
  jupyter: string
): Promise<void> {
  await writeFile(
    ssh,
    [
      '#!/bin/bash',
      'printf "%s\\n" "$@" >> "$PHI_FAKE_JUPYTER_SSH_ARGS"',
      'printf "%s\\n" "---" >> "$PHI_FAKE_JUPYTER_SSH_ARGS"',
      'command="${!#}"',
      'exec /bin/bash -c "$command"',
      ''
    ].join('\n')
  )
  await writeFile(
    jupyter,
    [
      '#!/bin/bash',
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
  await Promise.all([chmod(ssh, 0o755), chmod(jupyter, 0o755)])
}

export async function installBlockingRemoteJupyterSetsid(root: string): Promise<void> {
  const path = join(root, 'setsid')
  await writeFile(
    path,
    [
      '#!/bin/bash',
      'echo "$$" > "$PHI_SETSID_PID"',
      'while [[ ! -e "$PHI_SETSID_GATE" ]]; do sleep 0.02; done',
      'exec "$@"',
      ''
    ].join('\n')
  )
  await chmod(path, 0o755)
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
}
