#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Removes the dev app's "Phi Safe Storage" keychain entries (macOS only).
//
// Why: in dev, the Electron binary is re-signed ad-hoc on every upgrade or
// reinstall (see scripts/sync-electron-dev-icon.mjs). The keychain item's ACL
// trusts the old binary's code signature, so the new binary triggers repeated
// password prompts on every safeStorage access. Deleting the entry lets the
// current binary recreate one it owns.
//
// Side effect: credentials previously stored via safeStorage (MCP API keys,
// connector tokens, ...) become undecryptable and must be re-entered in the
// dev app. Production builds with a stable Developer ID signature never need
// this.
import { execFileSync } from 'node:child_process'

const SERVICE = 'Phi Safe Storage'

if (process.platform !== 'darwin') {
  console.log('fix:keychain is only needed on macOS.')
  process.exit(0)
}

function run(args) {
  try {
    execFileSync('security', args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let removed = 0
// Multiple entries with the same service name can accumulate; delete them all.
for (let i = 0; i < 10; i++) {
  if (!run(['find-generic-password', '-s', SERVICE])) break
  if (!run(['delete-generic-password', '-s', SERVICE])) break
  removed++
}

if (removed > 0) {
  console.log(
    `Removed ${removed} "${SERVICE}" keychain ${removed === 1 ? 'entry' : 'entries'}. ` +
      'Restart the dev app and re-enter stored credentials.'
  )
} else {
  console.log(`No "${SERVICE}" keychain entry found. Nothing to do.`)
}
