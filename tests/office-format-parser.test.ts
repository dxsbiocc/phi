import assert from 'node:assert/strict'
import test from 'node:test'

import { parseOfficeRange } from '../src/main/agent/office/office-read'
import { parseRangeCells } from '../src/main/agent/office/office-read-parser'

test('OfficeCLI format fields are normalized without changing values or formulas', () => {
  const cells = parseRangeCells(
    {
      data: {
        results: [
          {
            children: [
              {
                path: '/Sheet1/A1',
                text: 'Title',
                format: {
                  type: 'String',
                  'font.bold': true,
                  fill: '#ffeeaa',
                  'alignment.horizontal': 'center',
                  numberformat: '0.00'
                }
              },
              {
                path: '/Sheet1/B1',
                text: '13.345',
                format: {
                  type: 'Number',
                  formula: 'SUM(A2,1)',
                  computedValue: '13.345',
                  evaluated: true,
                  'font.bold': true,
                  fill: '#FFEEAA',
                  'alignment.horizontal': 'center',
                  numberformat: '0.00'
                }
              }
            ]
          }
        ]
      }
    },
    parseOfficeRange('A1:B1')
  )

  assert.deepEqual(cells, [
    {
      ref: 'A1',
      value: 'Title',
      valueType: 'string',
      format: {
        bold: true,
        fill: '#FFEEAA',
        horizontalAlign: 'center',
        numberFormat: '0.00'
      }
    },
    {
      ref: 'B1',
      value: 13.345,
      valueType: 'number',
      formula: '=SUM(A2,1)',
      evaluated: true,
      format: {
        bold: true,
        fill: '#FFEEAA',
        horizontalAlign: 'center',
        numberFormat: '0.00'
      }
    }
  ])
})

test('default formatting remains omitted so existing read results stay compact', () => {
  const cells = parseRangeCells(
    {
      data: {
        results: [
          {
            children: [{ path: '/Sheet1/A1', text: 'x', format: { type: 'String', font: {} } }]
          }
        ]
      }
    },
    parseOfficeRange('A1')
  )
  assert.deepEqual(cells, [{ ref: 'A1', value: 'x', valueType: 'string' }])
})
