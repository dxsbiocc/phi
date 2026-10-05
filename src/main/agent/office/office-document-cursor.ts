import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface OfficeDocumentCursorPayload {
  readonly artifactId: string
  readonly revision: number
  readonly nextIndex: number
  readonly limit: number
}

export class OfficeDocumentCursorCodec {
  private readonly secret: Buffer

  constructor(secret: Buffer = randomBytes(32)) {
    this.secret = secret
  }

  encode(payload: OfficeDocumentCursorPayload): string {
    const body = Buffer.from(JSON.stringify({ version: 1, ...payload })).toString('base64url')
    const signature = createHmac('sha256', this.secret).update(body).digest('base64url')
    return `${body}.${signature}`
  }

  decode(
    value: string,
    validLimit: (value: unknown) => value is number
  ): OfficeDocumentCursorPayload {
    try {
      const [body, signature, extra] = value.split('.')
      if (!body || !signature || extra) throw new Error('shape')
      this.assertSignature(body, signature)
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >
      if (!validPayload(parsed, validLimit)) throw new Error('payload')
      return {
        artifactId: parsed.artifactId,
        revision: parsed.revision,
        nextIndex: parsed.nextIndex,
        limit: parsed.limit
      }
    } catch {
      throw new Error('invalid_cursor')
    }
  }

  private assertSignature(body: string, signature: string): void {
    const expected = createHmac('sha256', this.secret).update(body).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error('signature')
    }
  }
}

function validPayload(
  value: Record<string, unknown>,
  validLimit: (value: unknown) => value is number
): value is Record<string, unknown> & OfficeDocumentCursorPayload {
  return (
    value.version === 1 &&
    typeof value.artifactId === 'string' &&
    validIndex(value.revision) &&
    validIndex(value.nextIndex) &&
    validLimit(value.limit)
  )
}

function validIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
