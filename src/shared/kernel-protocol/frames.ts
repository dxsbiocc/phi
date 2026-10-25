import { z } from 'zod'

import { protocolErrorSchema } from './errors'
import { jsonValueSchema } from './json'

const nonEmptyIdSchema = z.string().min(1)

export const kernelRequestFrameSchema = z
  .object({
    kind: z.literal('request'),
    id: nonEmptyIdSchema,
    method: z.string().min(1),
    params: jsonValueSchema,
    generation: z.number().int().nonnegative(),
    sessionId: nonEmptyIdSchema.optional(),
    runId: nonEmptyIdSchema.optional(),
    conversationId: nonEmptyIdSchema.optional(),
    taskId: nonEmptyIdSchema.optional()
  })
  .strict()

const successResponseFrameSchema = z
  .object({
    kind: z.literal('response'),
    id: nonEmptyIdSchema,
    ok: z.literal(true),
    result: jsonValueSchema
  })
  .strict()

const errorResponseFrameSchema = z
  .object({
    kind: z.literal('response'),
    id: nonEmptyIdSchema,
    ok: z.literal(false),
    error: protocolErrorSchema
  })
  .strict()

export const kernelResponseFrameSchema = z.discriminatedUnion('ok', [
  successResponseFrameSchema,
  errorResponseFrameSchema
])

export const kernelEventFrameSchema = z
  .object({
    kind: z.literal('event'),
    seq: z.number().int().positive(),
    type: z.string().min(1),
    payload: jsonValueSchema,
    sessionId: nonEmptyIdSchema.optional(),
    runId: nonEmptyIdSchema.optional()
  })
  .strict()

export const hostRequestFrameSchema = z
  .object({
    kind: z.literal('host.request'),
    id: nonEmptyIdSchema,
    capability: z.string().min(1),
    params: jsonValueSchema
  })
  .strict()

const hostSuccessResponseFrameSchema = z
  .object({
    kind: z.literal('host.response'),
    id: nonEmptyIdSchema,
    ok: z.literal(true),
    result: jsonValueSchema
  })
  .strict()

const hostErrorResponseFrameSchema = z
  .object({
    kind: z.literal('host.response'),
    id: nonEmptyIdSchema,
    ok: z.literal(false),
    error: protocolErrorSchema
  })
  .strict()

export const hostResponseFrameSchema = z.discriminatedUnion('ok', [
  hostSuccessResponseFrameSchema,
  hostErrorResponseFrameSchema
])

export const parsedFrameSchema = z.union([
  kernelRequestFrameSchema,
  kernelResponseFrameSchema,
  kernelEventFrameSchema,
  hostRequestFrameSchema,
  hostResponseFrameSchema
])

export type KernelRequestFrame = z.infer<typeof kernelRequestFrameSchema>
export type KernelResponseFrame = z.infer<typeof kernelResponseFrameSchema>
export type KernelEventFrame = z.infer<typeof kernelEventFrameSchema>
export type HostRequestFrame = z.infer<typeof hostRequestFrameSchema>
export type HostResponseFrame = z.infer<typeof hostResponseFrameSchema>
export type ParsedFrame = z.infer<typeof parsedFrameSchema>

export type RequestFrame = KernelRequestFrame
export type ResponseFrame = KernelResponseFrame
export type EventFrame = KernelEventFrame
