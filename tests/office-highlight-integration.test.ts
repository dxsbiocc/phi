import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { get as getHttp } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { OFFICE_HIGHLIGHT_EVENT } from '../src/main/agent/office/office-preview-control'
import {
  OFFICE_RANGE_ORIGIN_SESSION_ID,
  createOfficeRangeHostFixture,
  officeRangeIntegrationOptions
} from './helpers/officeRangeIntegrationHarness'

interface ControlStream {
  readonly next: () => Promise<{ event: string; data: unknown }>
  readonly close: () => void
}

test(
  'real A1:B3 write publishes a temporary highlight without another file or revision change',
  officeRangeIntegrationOptions,
  async () => {
    const fixture = await createOfficeRangeHostFixture()
    let controls: ControlStream | undefined
    try {
      await fixture.preparePreview()
      controls = await connectControlStream(`${fixture.previewUrl}__phi/preview-events`)
      const result = (await fixture.apply(
        {
          operation: {
            type: 'set_range',
            sheet: 'Sheet1',
            range: 'A1:B3',
            values: [
              ['a', 'b'],
              ['c', 'd'],
              ['e', 'f']
            ]
          },
          baseRevision: 0
        },
        'highlight-real-range'
      )) as { ok: true; value: { previewConfirmed: boolean; revision: number } }
      assert.equal(result.ok, true)
      assert.equal(result.value.previewConfirmed, true)
      assert.equal(result.value.revision, 1)
      assert.deepEqual(await controls.next(), {
        event: OFFICE_HIGHLIGHT_EVENT,
        data: { sheet: 'Sheet1', range: 'A1:B3' }
      })

      const hashAfterWrite = fileHash(fixture.draftPath)
      await delay(250)
      const afterMarker = (await fixture.read(
        { sheet: 'Sheet1', range: 'A1:B3' },
        { originSessionId: OFFICE_RANGE_ORIGIN_SESSION_ID }
      )) as { ok: true; value: { revision: number } }
      assert.equal(afterMarker.value.revision, 1)
      assert.equal(fileHash(fixture.draftPath), hashAfterWrite)
    } finally {
      controls?.close()
      await fixture.cleanup()
    }
  }
)

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function connectControlStream(url: string): Promise<ControlStream> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const frames: Array<{ event: string; data: unknown }> = []
    const waiters: Array<(frame: { event: string; data: unknown }) => void> = []
    const request = getHttp(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`preview control status ${String(response.statusCode)}`))
        response.resume()
        return
      }
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        buffer = `${buffer}${chunk}`.replaceAll('\r\n', '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = parsedFrame(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
          if (frame) {
            const waiter = waiters.shift()
            if (waiter) waiter(frame)
            else frames.push(frame)
          }
          boundary = buffer.indexOf('\n\n')
        }
      })
      resolve({
        next: () => {
          const frame = frames.shift()
          return frame
            ? Promise.resolve(frame)
            : new Promise((resolveFrame) => waiters.push(resolveFrame))
        },
        close: () => request.destroy()
      })
    })
    request.once('error', reject)
  })
}

function parsedFrame(frame: string): { event: string; data: unknown } | undefined {
  const event = frame.match(/^event:\s*(.+)$/mu)?.[1]
  const data = frame.match(/^data:\s*(.+)$/mu)?.[1]
  if (!event || !data) return undefined
  return { event, data: JSON.parse(data) as unknown }
}
