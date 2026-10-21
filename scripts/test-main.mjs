/**
 * Focused entry for the frozen main-integration suite.
 *
 * The suite is one large file with a shared harness, so splitting it costs more
 * than it saves. Use a name pattern for day-to-day feedback and run the whole
 * suite before merging.
 *
 * Usage:
 *   node scripts/test-main.mjs              run the whole suite
 *   node scripts/test-main.mjs <pattern>    run only matching test names
 */
import { spawn } from 'node:child_process'

const pattern = process.argv[2]
const args = ['--import', './scripts/test-loader.mjs', '--test']
if (pattern) args.push(`--test-name-pattern=${pattern}`)
args.push('--test-timeout=300000', '--test-force-exit', './tests/main-integration.test.ts')

const child = spawn(process.execPath, args, { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
