import assert from 'node:assert/strict'
import test from 'node:test'

import {
  installPlugin,
  isRuntimeSupportedPluginSource,
  removePlugin
} from '../src/main/agent/plugins'

test('plugin source validation allows runtime-supported package sources', () => {
  assert.equal(isRuntimeSupportedPluginSource('@phi/example'), true)
  assert.equal(isRuntimeSupportedPluginSource('npm:@phi/example'), true)
  assert.equal(isRuntimeSupportedPluginSource('phi-plugin'), true)
  assert.equal(isRuntimeSupportedPluginSource('git:https://example.com/phi/plugin.git'), true)
})

test('plugin source validation rejects arbitrary URLs and local archives', () => {
  assert.equal(isRuntimeSupportedPluginSource(''), false)
  assert.equal(isRuntimeSupportedPluginSource('https://example.com/plugin.tgz'), false)
  assert.equal(isRuntimeSupportedPluginSource('file:///tmp/plugin.zip'), false)
  assert.equal(isRuntimeSupportedPluginSource('/tmp/plugin.zip'), false)
  assert.equal(isRuntimeSupportedPluginSource('../plugin.zip'), false)
  assert.equal(isRuntimeSupportedPluginSource('npm:https://example.com/plugin.tgz'), false)
})

test('plugin operations reject unsupported sources before runtime install or removal', async () => {
  await assert.rejects(installPlugin('https://example.com/plugin.tgz'), /开发者扩展源格式不受支持/)
  await assert.rejects(removePlugin('/tmp/plugin.zip'), /开发者扩展源格式不受支持/)
})
