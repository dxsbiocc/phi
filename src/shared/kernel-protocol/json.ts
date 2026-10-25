import { z } from 'zod'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
)

const RESERVED_IDENTITY_FIELDS = new Set([
  'role',
  'member',
  'identity',
  'principal',
  'executor',
  'permissions'
])

/** Checks only this structural object's own keys; opaque descendants are intentionally ignored. */
export function containsReservedIdentityField(value: JsonValue): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).some((key) => RESERVED_IDENTITY_FIELDS.has(key.toLowerCase()))
}
