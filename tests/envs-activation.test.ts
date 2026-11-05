import assert from 'node:assert/strict'
import { win32 } from 'node:path'
import test from 'node:test'

import { captureActivation } from '../src/main/agent/envs/activation'
import { micromambaEnvironment } from '../src/main/agent/envs/runtime'

test('Windows activation captures UTF-8 values and preserves the prefix DLL search order', async () => {
  const root = 'C:\\用户\\Phi Runtime'
  const prefix = win32.join(root, 'envs', 'phi-python')
  const base = micromambaEnvironment(root, process.env, 'win32')
  const entries = [prefix, win32.join(prefix, 'Library', 'bin'), win32.join(prefix, 'Scripts')]
  const certificatePath = 'C:\\用户\\分析数据\\证书.pem'
  const snapshot = await captureActivation(root, prefix, undefined, undefined, {
    platform: 'win32',
    run: async (args, options) => {
      assert.deepEqual(args.slice(0, 8), [
        'run',
        '-p',
        prefix,
        win32.join(base.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand'
      ])
      assert.match(Buffer.from(args[8], 'base64').toString('utf16le'), /Console.*OutputEncoding/)
      assert.equal(options.timeoutMs, 120_000)
      return {
        code: 0,
        stderr: '',
        stdout: `activated\r\nPHI_ACTIVATION_ENV=${JSON.stringify({
          Path: [...entries, base.PATH.toLowerCase(), 'C:\\outside'].join(';'),
          systemroot: base.SystemRoot,
          conda_prefix: prefix,
          conda_shlvl: '1',
          psmodulepath: 'C:\\system-module',
          SSL_CERT_FILE: certificatePath,
          MULTILINE: '一行=1\r\n二行=2'
        })}\r\n`
      }
    }
  })
  assert.deepEqual(snapshot, {
    pathPrepend: entries,
    set: {
      CONDA_PREFIX: prefix,
      SSL_CERT_FILE: certificatePath,
      MULTILINE: '一行=1\r\n二行=2'
    }
  })
})

test('an invalid Windows activation payload is rejected without disclosing its contents', async () => {
  await assert.rejects(
    captureActivation('C:\\runtime', 'C:\\env', undefined, undefined, {
      platform: 'win32',
      run: async () => ({
        code: 0,
        stderr: '',
        stdout: 'PHI_ACTIVATION_ENV=https://secret.example.invalid'
      })
    }),
    { message: 'failed to decode the Windows activation environment' }
  )
})
