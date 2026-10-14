import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
if (process.env.PHI_TEST_SEARCH_LEDGER)
  appendFileSync(
    process.env.PHI_TEST_SEARCH_LEDGER,
    JSON.stringify({ pid: process.pid, cwd: process.cwd() }) + '\n'
  )
// Network transport fixture only. All SDK selection, auth, query and response code stays real.
const original = globalThis.fetch
const endpoint = process.env.PHI_TEST_SEARCH_ENDPOINT!
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const crash = process.env.PHI_TEST_SEARCH_CRASH_ONCE
  if (crash && !existsSync(crash)) {
    writeFileSync(crash, 'crashed')
    process.exit(17)
  }
  if (process.env.PHI_TEST_SEARCH_IGNORE_ABORT) init = { ...init, signal: undefined }
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin === 'https://api.search.brave.com')
    return original(new URL(url.pathname + url.search, endpoint), init)
  if (url.origin === new URL(endpoint).origin) return original(input, init)
  throw new Error('External network is disabled in the desktop search fixture')
}) as typeof fetch
