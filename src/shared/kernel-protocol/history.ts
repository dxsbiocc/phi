import { z } from 'zod'

const nonEmptyString = z.string().min(1)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const historyMigrationStateSchema = z.enum(['started', 'copied', 'verified', 'complete'])

export const sessionAdoptParamsSchema = z
  .object({
    source: z
      .object({
        kind: z.literal('omp-journal'),
        path: nonEmptyString,
        cwd: nonEmptyString,
        origin: z.enum(['desktop-local', 'rpc-remote']),
        phiSessionId: nonEmptyString,
        expected: z
          .object({
            sha256: sha256Schema.optional(),
            size: z.number().int().nonnegative().optional()
          })
          .strict()
          .optional()
      })
      .strict(),
    title: nonEmptyString.optional(),
    model: z
      .object({
        provider: nonEmptyString,
        id: nonEmptyString
      })
      .strict()
      .optional(),
    thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
  })
  .strict()

export const sessionAdoptResultSchema = z
  .object({
    sessionId: nonEmptyString,
    migration: z
      .object({
        state: historyMigrationStateSchema,
        sourceSha256: sha256Schema
      })
      .strict()
  })
  .strict()

export type HistoryMigrationState = z.infer<typeof historyMigrationStateSchema>
export type SessionAdoptParams = z.infer<typeof sessionAdoptParamsSchema>
export type SessionAdoptResult = z.infer<typeof sessionAdoptResultSchema>
