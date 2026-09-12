import assert from 'node:assert/strict'
import test from 'node:test'

import { detectAnalysisKernels } from '../src/main/agent/notebook/analysis-kernels'

test('detectAnalysisKernels normalizes Python and R kernelspecs', () => {
  const calls: string[] = []
  const diagnostics = detectAnalysisKernels((command, args) => {
    calls.push([command, ...args].join(' '))
    if (args.join(' ') === 'server --version') return '2.14.0\n'
    return JSON.stringify({
      kernelspecs: {
        ir: {
          resource_dir: '/kernels/ir',
          spec: { display_name: 'R 4.4', language: 'R', argv: ['R', '--slave'] }
        },
        python3: {
          resource_dir: '/kernels/python3',
          spec: {
            display_name: 'Python 3',
            language: 'python',
            argv: ['python', '-m', 'ipykernel_launcher']
          }
        },
        bash: {
          resource_dir: '/kernels/bash',
          spec: { display_name: 'Bash', language: 'bash', argv: ['bash'] }
        }
      }
    })
  })

  assert.deepEqual(calls, ['jupyter server --version', 'jupyter kernelspec list --json'])
  assert.equal(diagnostics.jupyterServer.available, true)
  assert.equal(diagnostics.jupyterServer.version, '2.14.0')
  assert.equal(diagnostics.preferredKernelName, 'python3')
  assert.equal(diagnostics.hasPythonKernel, true)
  assert.equal(diagnostics.hasRKernel, true)
  assert.deepEqual(
    diagnostics.kernels.map((kernel) => [kernel.name, kernel.displayName, kernel.language]),
    [
      ['python3', 'Python 3', 'python'],
      ['ir', 'R 4.4', 'r'],
      ['bash', 'Bash', 'other']
    ]
  )
  assert.deepEqual(diagnostics.messages, [])
})

test('detectAnalysisKernels reports missing Jupyter without probing kernels', () => {
  const calls: string[] = []
  const diagnostics = detectAnalysisKernels((command, args) => {
    calls.push([command, ...args].join(' '))
    throw new Error('ENOENT jupyter')
  })

  assert.deepEqual(calls, ['jupyter server --version'])
  assert.equal(diagnostics.jupyterServer.available, false)
  assert.match(diagnostics.jupyterServer.error ?? '', /ENOENT jupyter/)
  assert.deepEqual(diagnostics.kernels, [])
  assert.equal(diagnostics.hasPythonKernel, false)
  assert.equal(diagnostics.hasRKernel, false)
  assert.match(diagnostics.messages.join('\n'), /未检测到可用的 Jupyter Server/)
})

test('detectAnalysisKernels reports invalid kernelspec output', () => {
  const diagnostics = detectAnalysisKernels((_, args) => {
    if (args.join(' ') === 'server --version') return '2.14.0'
    return JSON.stringify({ kernelspecs: [] })
  })

  assert.equal(diagnostics.jupyterServer.available, true)
  assert.deepEqual(diagnostics.kernels, [])
  assert.equal(diagnostics.hasPythonKernel, false)
  assert.equal(diagnostics.hasRKernel, false)
  assert.match(diagnostics.messages.join('\n'), /无法读取 Jupyter kernelspec/)
  assert.match(diagnostics.messages.join('\n'), /未检测到 Python kernel/)
  assert.match(diagnostics.messages.join('\n'), /未检测到 R kernel/)
})
