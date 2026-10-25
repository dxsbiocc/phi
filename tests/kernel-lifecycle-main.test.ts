import assert from 'node:assert/strict'
import test from 'node:test'

import { parseKernelCommandLine } from '../src/kernel/lifecycle/command-line'

test('kernel command line keeps stdio default and validates socket lifecycle flags', () => {
  assert.deepEqual(parseKernelCommandLine([]), { mode: 'stdio' })
  assert.deepEqual(
    parseKernelCommandLine([
      '--listen',
      '/tmp/phi-k-501/abc.sock',
      '--token-file',
      '/tmp/phi-k-501/abc.token',
      '--grace-ms',
      '2500'
    ]),
    {
      mode: 'listen',
      socketPath: '/tmp/phi-k-501/abc.sock',
      tokenFilePath: '/tmp/phi-k-501/abc.token',
      graceMs: 2500
    }
  )
  assert.throws(() => parseKernelCommandLine(['--listen', '/tmp/kernel.sock']), /token-file/)
  assert.throws(
    () =>
      parseKernelCommandLine([
        '--listen',
        '/tmp/kernel.sock',
        '--token-file',
        '/tmp/kernel.token',
        '--grace-ms',
        '0'
      ]),
    /grace-ms/
  )
})
