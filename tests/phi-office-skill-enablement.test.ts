import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { getEnablementSnapshot, setEnabled } from '../src/main/agent/enablement'
import {
  filterOfficeSkillForAvailability,
  initializePhiOfficeSkillDefault
} from '../src/main/agent/office/office-skill-enablement'

const silentLogger = {
  info(): void {
    // Intentionally silent in filesystem-state tests.
  },
  warn(): void {
    // Intentionally silent in filesystem-state tests.
  }
}

function withAgentDir(run: (agentDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'phi-office-skill-enable-'))
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir)
  try {
    run(agentDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('phi-office is seeded on when Office is available without changing other skills', () => {
  withAgentDir((agentDir) => {
    initializePhiOfficeSkillDefault(true, { agentDir, logger: silentLogger })

    assert.deepEqual(getEnablementSnapshot({ agentDir, logger: silentLogger }).global, {
      'skill:phi-office': true
    })
  })
})

test('phi-office preserves an explicit user disable and does not seed while unavailable', () => {
  withAgentDir((agentDir) => {
    initializePhiOfficeSkillDefault(false, { agentDir, logger: silentLogger })
    assert.deepEqual(getEnablementSnapshot({ agentDir, logger: silentLogger }).global, {})

    setEnabled('skill:phi-office', false, { agentDir, logger: silentLogger })
    initializePhiOfficeSkillDefault(true, { agentDir, logger: silentLogger })
    assert.equal(
      getEnablementSnapshot({ agentDir, logger: silentLogger }).global['skill:phi-office'],
      false
    )
  })
})

test('phi-office is hidden from sessions when Office is unavailable', () => {
  const skills = [{ name: 'phi-office' }, { name: 'scanpy' }]

  assert.deepEqual(filterOfficeSkillForAvailability(skills, false), [{ name: 'scanpy' }])
  assert.deepEqual(filterOfficeSkillForAvailability(skills, true), skills)
})
