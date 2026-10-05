import { createHmac, timingSafeEqual } from 'node:crypto'

import { OfficeReadError } from './office-read-contract'

const CURSOR_VERSION = 1
const CURSOR_TTL_MS = 15 * 60 * 1_000

export interface OfficeReadCursorPayload {
  readonly artifactId: string
  readonly sheet: string
  readonly range: string
  readonly revision: number
  readonly nextRow: number
  readonly issuedAt: number
}

function invalidCursor(): OfficeReadError {
  return new OfficeReadError(
    'invalid_cursor',
    '继续读取标记无效、已过期或不属于当前文档，请重新指定范围'
  )
}

function validPayload(value: unknown): value is OfficeReadCursorPayload & { version: number } {
  const payload = value as Partial<OfficeReadCursorPayload> & { version?: unknown }
  return (
    payload.version === CURSOR_VERSION &&
    typeof payload.artifactId === 'string' &&
    typeof payload.sheet === 'string' &&
    typeof payload.range === 'string' &&
    Number.isSafeInteger(payload.revision) &&
    Number.isSafeInteger(payload.nextRow) &&
    Number.isSafeInteger(payload.issuedAt)
  )
}

export class OfficeReadCursorCodec {
  constructor(
    private readonly secret: Buffer,
    private readonly now: () => number
  ) {}

  encode(payload: Omit<OfficeReadCursorPayload, 'issuedAt'>): string {
    const body = Buffer.from(
      JSON.stringify({ version: CURSOR_VERSION, ...payload, issuedAt: this.now() }),
      'utf8'
    ).toString('base64url')
    return `${body}.${this.sign(body)}`
  }

  decode(cursor: string): OfficeReadCursorPayload {
    try {
      if (cursor.length > 2_048) throw invalidCursor()
      const [body, signature, extra] = cursor.split('.')
      if (!body || !signature || extra) throw invalidCursor()
      const expected = Buffer.from(this.sign(body), 'utf8')
      const actual = Buffer.from(signature, 'utf8')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw invalidCursor()
      }
      const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown
      if (!validPayload(value)) throw invalidCursor()
      if (value.issuedAt > this.now() || this.now() - value.issuedAt > CURSOR_TTL_MS) {
        throw invalidCursor()
      }
      return Object.freeze({
        artifactId: value.artifactId,
        sheet: value.sheet,
        range: value.range,
        revision: value.revision,
        nextRow: value.nextRow,
        issuedAt: value.issuedAt
      })
    } catch (error) {
      if (error instanceof OfficeReadError) throw error
      throw invalidCursor()
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url')
  }
}
