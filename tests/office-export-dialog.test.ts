import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chooseOfficeExportTarget } from '../src/main/agent/office/office-export-dialog'

test('export dialog uses format-specific labels and ignores destroyed windows', async () => {
  const calls: unknown[] = []
  const result = await chooseOfficeExportTarget(
    { projectRoot: '/project', fileName: '预算表-数据.tsv', format: 'tsv' },
    {
      officeDev: true,
      isPackaged: false,
      getWindow: () => ({ isDestroyed: () => true }),
      showSaveDialog: async (window, options) => {
        calls.push({ window, options })
        return { canceled: false, filePath: '/project/预算表-数据.tsv' }
      }
    }
  )

  assert.equal(result, '/project/预算表-数据.tsv')
  assert.deepEqual(calls, [
    {
      window: undefined,
      options: {
        title: '导出为 TSV',
        defaultPath: '/project/预算表-数据.tsv',
        filters: [{ name: 'TSV', extensions: ['tsv'] }]
      }
    }
  ])
})

test('export dialog smoke injection is dev-only and cancellation writes nothing', async () => {
  let dialogs = 0
  assert.equal(
    await chooseOfficeExportTarget(
      { projectRoot: '/project', fileName: 'book.csv', format: 'csv' },
      {
        officeDev: true,
        isPackaged: false,
        smokePath: '/project/injected.csv',
        getWindow: () => undefined,
        showSaveDialog: async () => {
          dialogs += 1
          return { canceled: true }
        }
      }
    ),
    '/project/injected.csv'
  )
  assert.equal(dialogs, 0)
  assert.equal(
    await chooseOfficeExportTarget(
      { projectRoot: '/project', fileName: 'book.csv', format: 'csv' },
      {
        officeDev: true,
        isPackaged: false,
        getWindow: () => undefined,
        showSaveDialog: async () => ({ canceled: true })
      }
    ),
    null
  )
})
