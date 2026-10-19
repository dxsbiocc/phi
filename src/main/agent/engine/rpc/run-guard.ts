import { CodedError, type ErrorCode } from '../../../../shared/errorCodes'
import { shellQuote as q } from '../../wrappers/remote-ssh-session'

/**
 * SSH-04: the session-storage writer lock lives with the OMP process.
 *
 * Two server-side locks cooperate:
 *  - `lease.lock` (startup channel): serialises desktops while a launch is being
 *    prepared. It is held until OMP has been launched, so the run lock below can
 *    never be contested during handover.
 *  - `run.lock` (OMP itself): opened on fd 8 by the launch shell, flocked, then
 *    inherited across `exec`. It is released only when OMP and every descendant
 *    holding fd 8 are gone, so an SSH drop cannot free it while OMP still runs.
 */
export const RUN_LOCK_FD = 8
export const RUN_RECORD_PROTOCOL = 'PHI_RUN_V1'
export const RUN_NONCE_ENV = 'PHI_RUN_NONCE'
export const RUN_TERM_WAIT_SECONDS = 10
export const RUN_KILL_WAIT_SECONDS = 5
export const RUN_STOPPED_NOTICE = '已停止上一次未结束的远端运行'
export const RUN_HELD_MESSAGE =
  '该会话仍被另一个进程占用，且无法确认它属于 Phi，已停止恢复且没有终止任何进程。请确认没有其他 Phi 正在使用此会话后重试。'

/**
 * Launch wrapper, independent of the user's login shell: the login shell only
 * sees `exec /bin/sh -c '<script>' phi-run` followed by plain words (the
 * caller appends `env -i … <omp> <args>`), so no POSIX-only syntax reaches
 * csh/fish. `exec` keeps the pid, and sshd's no-pty exec already made that
 * process its own session/process-group leader, so `$$` is the final OMP pid
 * and pgid. The script takes the run lock on fd 8 (inherited across every
 * following exec), records pid/pgid/nonce/start time (mode 0600 via the
 * caller's `umask 077`) and then `exec "$@"`. It refuses to start when the
 * process is not a group leader, because the whole group must be signalable.
 */
export function buildRunGuardWrapper(input: {
  readonly runLock: string
  readonly runRecord: string
  readonly nonce: string
}): string {
  if (!/^[0-9a-f]{32}$/u.test(input.nonce)) throw new Error('Invalid run nonce')
  // Paths travel as positional arguments so the script itself contains no single
  // quotes: nested quoting would not survive csh.
  const script = [
    '[ -f "$1" ] && [ ! -L "$1" ] || exit 77',
    `exec ${RUN_LOCK_FD}<>"$1"`,
    `flock -x -n ${RUN_LOCK_FD} || { echo PHI_LAUNCH:RUN_LOCK_BUSY >&2; exit 75; }`,
    '[ "$(ps -o pgid= -p $$ | tr -d "[:space:]")" = "$$" ] || { echo PHI_LAUNCH:NOT_GROUP_LEADER >&2; exit 78; }',
    `printf "${RUN_RECORD_PROTOCOL}\\t%s\\t%s\\t${input.nonce}\\t%s\\n" "$$" "$$" "$(date +%s)" > "$2.tmp" && mv -f "$2.tmp" "$2" || exit 79`,
    'shift 2',
    'exec "$@"'
  ].join('; ')
  return `exec /bin/sh -c ${q(script)} phi-run ${q(input.runLock)} ${q(input.runRecord)} `
}

/**
 * Takeover section of the startup script, run while `lease.lock` is held.
 * Expects `lock_parent`, `run_exe`, and the startup helpers (`fail`, `owner_of`,
 * `mode_of`, `links_of`, `private_file`). Sets `run_stopped` to the stopped pid.
 * Conservative: anything that does not verify as Phi's own OMP is never signalled.
 */
export const RUN_GUARD_SCRIPT = String.raw`run_stopped=''
run_unverified() { fail RUN_HELD_UNVERIFIED; }
run_wait() {
  run_deadline=$(($(date +%s) + $1))
  while :; do
    if flock -x -n 8; then return 0; fi
    [ "$(date +%s)" -lt "$run_deadline" ] || return 1
    sleep 0.1
  done
}
run_takeover() {
  [ -f "$run_record" ] && [ ! -L "$run_record" ] || run_unverified
  [ "$(owner_of "$run_record")" = "$(id -u)" ] || run_unverified
  [ "$(links_of "$run_record")" = 1 ] || run_unverified
  [ "$(mode_of "$run_record")" = 600 ] || run_unverified
  record_line=$(head -c 512 "$run_record" | head -n 1) || run_unverified
  IFS="$tab" read -r rtag rpid rpgid rnonce rstart <<RUN_RECORD_EOF
$record_line
RUN_RECORD_EOF
  [ "$rtag" = PHI_RUN_V1 ] || run_unverified
  case "$rpid" in ''|*[!0-9]*) run_unverified ;; esac
  case "$rpgid" in ''|*[!0-9]*) run_unverified ;; esac
  case "$rnonce" in ''|*[!0-9a-f]*) run_unverified ;; esac
  [ "$(printf '%s' "$rnonce" | wc -c | tr -d ' ')" = 32 ] || run_unverified
  [ "$rpid" -gt 1 ] && [ "$rpid" = "$rpgid" ] || run_unverified
  kill -s 0 "$rpid" 2>/dev/null || run_unverified
  [ "$(ps -o pgid= -p "$rpid" 2>/dev/null | tr -d ' ')" = "$rpgid" ] || run_unverified
  if [ -r "/proc/$rpid/cmdline" ]; then
    run_actual=$(tr '\0' '\n' < "/proc/$rpid/cmdline" | head -n 1) || run_unverified
  else
    run_actual=$(ps -o args= -p "$rpid" 2>/dev/null | sed 's/^ *//') || run_unverified
  fi
  case "$run_actual" in "$run_exe"|"$run_exe "*) ;; *) run_unverified ;; esac
  if [ -d /proc/self ]; then
    [ -r "/proc/$rpid/environ" ] || run_unverified
    tr '\0' '\n' < "/proc/$rpid/environ" | grep -qx "PHI_RUN_NONCE=$rnonce" || run_unverified
  fi
  kill -s TERM -- "-$rpgid" 2>/dev/null || :
  if ! run_wait __PHI_RUN_TERM_WAIT__; then
    kill -s KILL -- "-$rpgid" 2>/dev/null || :
    run_wait __PHI_RUN_KILL_WAIT__ || fail RUN_STOP_FAILED
  fi
  rm -f -- "$run_record"
  run_stopped=$rpid
}
run_guard() {
  run_lock=$lock_parent/run.lock
  run_record=$lock_parent/run.record
  if [ ! -e "$run_lock" ] && [ ! -L "$run_lock" ]; then (umask 077; set -C; : > "$run_lock") 2>/dev/null || :; fi
  private_file "$run_lock"
  exec 8<>"$run_lock"
  if ! flock -x -n 8; then run_takeover; fi
  exec 8>&-
}
if [ -n "$run_exe" ]; then run_guard; fi`
  .replace('__PHI_RUN_TERM_WAIT__', String(RUN_TERM_WAIT_SECONDS))
  .replace('__PHI_RUN_KILL_WAIT__', String(RUN_KILL_WAIT_SECONDS))

/**
 * SSH-12: the launcher reports every refusal on stderr as `PHI_LAUNCH:<reason>`
 * and exits, but nothing used to read it, so a refused launch reached the caller
 * as a bare "RPC output stream ended". Map the markers to an actionable error.
 *
 * The markers name the failed check, not the cause: `RUN_LOCK_BUSY` also happens
 * when the flock binary itself is missing, so the surrounding stderr decides
 * between "another run holds it" and "this server cannot take the lock at all".
 */
export interface RunGuardRefusal {
  readonly code: ErrorCode
  readonly message: string
}

const MISSING_FLOCK = /flock(?:: |:)(?:command )?not found|flock: No such file or directory/i
const MISSING_PS = /ps(?:: |:)(?:command )?not found|ps: .*Operation not permitted|ps: not found/i

export function parseRunGuardRefusal(stderr: string): RunGuardRefusal | undefined {
  if (stderr.includes('PHI_LAUNCH:RUN_LOCK_BUSY')) {
    return MISSING_FLOCK.test(stderr)
      ? {
          code: 'DOMAIN_INVALID',
          message:
            '服务器缺少 flock,无法为远端运行建立写者锁。请在服务器安装 util-linux(提供 flock)后重试。'
        }
      : {
          code: 'DOMAIN_CONFLICT',
          message:
            '该会话仍被上一次未结束的远端运行占用。请等它结束后重试;Phi 不会终止无法确认归属的进程。'
        }
  }
  if (stderr.includes('PHI_LAUNCH:NOT_GROUP_LEADER')) {
    return MISSING_PS.test(stderr)
      ? {
          code: 'DOMAIN_INVALID',
          message:
            '服务器无法确认远端运行的进程组(ps 不可用或受限),Phi 不能安全停止该运行。请检查服务器上的 ps 权限后重试。'
        }
      : {
          code: 'DOMAIN_INVALID',
          message:
            '远端启动进程不是进程组组长,Phi 无法安全停止该运行。请检查服务器 sshd 是否以 no-pty exec 启动后重试。'
        }
  }
  return undefined
}

/** `describeTransportEnd` hook for RpcConnection: undefined keeps the generic transport error. */
export function runGuardRefusalError(stderrTail: string): Error | undefined {
  const refusal = parseRunGuardRefusal(stderrTail)
  return refusal ? new CodedError(refusal.code, refusal.message) : undefined
}
