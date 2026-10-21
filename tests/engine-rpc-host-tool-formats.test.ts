import assert from 'node:assert/strict'
import test from 'node:test'
import { registeredHostTools } from '../src/main/agent/engine/rpc/host-tool-validation'

test('RPC host-tool date and UUID schema formats validate without warning spam', () => {
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]): void => {
    warnings.push(args)
  }
  try {
    const tools = registeredHostTools([
      {
        name: 'filter_records',
        label: 'Filter records',
        description: 'Filter records by date and page ID',
        site: 'host',
        parameters: {
          type: 'object',
          properties: {
            start_date: { type: 'string', format: 'date' },
            page_id: { type: 'string', format: 'uuid' }
          },
          required: ['start_date', 'page_id']
        },
        execute: async () => ({ content: [] })
      }
    ])
    const validate = tools.get('filter_records')?.validate
    assert.ok(validate)
    const pageId = '63201ad3-a48b-4f1c-9ab6-3c61cf2d5b6d'
    assert.equal(
      validate({ start_date: '2026-10-21', page_id: pageId }),
      true
    )
    assert.equal(validate({ start_date: '2024-02-29', page_id: pageId }), true)
    assert.equal(validate({ start_date: '2026-02-30', page_id: pageId }), false)
    assert.equal(validate({ start_date: '2026-10-21', page_id: 'not-a-uuid' }), false)
    assert.deepEqual(warnings, [])
  } finally {
    console.warn = originalWarn
  }
})
