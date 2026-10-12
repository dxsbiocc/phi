import { after } from 'node:test'

/**
 * Keeps this test file's event loop alive until its tests finish. Production timers that guard
 * a hung remote call are unref()ed because Electron always keeps the loop alive; in a test file
 * nothing else does, so a test awaiting such a timeout would otherwise end as "still pending".
 */
export function holdEventLoopForTests(): void {
  const timer = setInterval(() => undefined, 60_000)
  after(() => clearInterval(timer))
}
