import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MIN_NEXTFLOW_VERSION,
  isNextflowVersionSupported,
  parseNextflowVersion
} from '../src/main/agent/wrappers/composition/nextflow-version'

test('the Nextflow version is read from -version output and compared numerically', () => {
  assert.equal(
    parseNextflowVersion('      N E X T F L O W\n      version 26.04.6 build 12646'),
    '26.04.6'
  )
  assert.equal(parseNextflowVersion('Downloading nextflow dependencies'), undefined)
  assert.equal(isNextflowVersionSupported(MIN_NEXTFLOW_VERSION), true)
  assert.equal(isNextflowVersionSupported('25.10.0'), true)
  assert.equal(isNextflowVersionSupported('26.04.6'), true)
  assert.equal(isNextflowVersionSupported('24.10.5'), false)
  assert.equal(isNextflowVersionSupported('22.10.6'), false)
  assert.equal(isNextflowVersionSupported('25.3.9'), false)
})
