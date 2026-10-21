import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  listSshHostAvailability,
  saveSshHostAvailability
} from '../src/main/agent/ssh-host-availability'

test('SSH host availability records replace the previous status for the same server', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-ssh-availability-'))
  try {
    assert.deepEqual(listSshHostAvailability(root), [])
    const first = saveSshHostAvailability(
      { hostId: 'ssh-config:gpu', status: 'unavailable', checkedAt: '2026-10-21T00:00:00.000Z' },
      root
    )
    assert.equal(first.length, 1)
    const next = saveSshHostAvailability(
      { hostId: 'ssh-config:gpu', status: 'available', checkedAt: '2026-10-21T01:00:00.000Z' },
      root
    )
    assert.deepEqual(next, [
      { hostId: 'ssh-config:gpu', status: 'available', checkedAt: '2026-10-21T01:00:00.000Z' }
    ])
    writeFileSync(join(root, 'ssh-host-availability.json'), '{', 'utf-8')
    assert.deepEqual(listSshHostAvailability(root), [])
    assert.throws(() =>
      saveSshHostAvailability(
        { hostId: '', status: 'available', checkedAt: '2026-10-21T01:00:00.000Z' },
        root
      )
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
