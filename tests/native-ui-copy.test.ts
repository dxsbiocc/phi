import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeUiCopy } from '../src/main/native-ui-copy'

test('native recovery and save dialogs use complete semantic copy for both languages', () => {
  const english = nativeUiCopy('en')
  const chinese = nativeUiCopy('zh-CN')
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort())
  for (const [language, title, reload, close, save, result, remote, reproduction] of [
    [
      'en',
      'Phi could not finish loading the interface',
      'Reload',
      'Close',
      'Save',
      'Save remote result',
      'Save remote file',
      'Export Wrapper reproducibility record'
    ],
    [
      'zh-CN',
      'Phi 界面未能完成加载',
      '重新加载',
      '关闭',
      '保存',
      '保存远程结果',
      '保存远程文件',
      '导出 Wrapper 复现记录'
    ]
  ] as const) {
    const copy = nativeUiCopy(language)
    assert.equal(copy.startupFailed, title)
    assert.equal(copy.reload, reload)
    assert.equal(copy.close, close)
    assert.equal(copy.save, save)
    assert.equal(copy.saveResult, result)
    assert.equal(copy.saveRemoteFile, remote)
    assert.equal(copy.exportReproducibility, reproduction)
  }
  assert.equal(nativeUiCopy('en').save, 'Save')
})
