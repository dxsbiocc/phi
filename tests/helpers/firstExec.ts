import { execFileSync } from 'node:child_process'

/** Generous, loud deadline for the one warm-up run. */
const FIRST_EXEC_TIMEOUT_MS = 60_000

/**
 * Run a freshly written or copied executable once before product code times it.
 *
 * macOS scans every new executable file on its first exec (XProtect), and the scans queue
 * machine-wide: 60 new scripts started together waited a median of 7 s on a loaded host, while
 * the same files ran in 10 ms afterwards. Product deadlines such as a 5 s `--version` probe must
 * not absorb that one-off cost, so fixtures pay it here, under a deadline that fails loudly.
 * The arguments must make the executable exit without side effects.
 */
export function warmExecutable(path: string, args: readonly string[]): void {
  execFileSync(path, args, {
    stdio: 'ignore',
    timeout: FIRST_EXEC_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  })
}
