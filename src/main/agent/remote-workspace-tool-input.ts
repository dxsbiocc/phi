/**
 * The agent harness adds bookkeeping fields (for example the `i` intent note) to every tool
 * call, while the remote workspace boundary rejects any key it does not know. Forward only the
 * fields a tool declares in its own schema so a harmless extra field can never fail a request.
 */
export function pickDeclaredToolInput(
  params: unknown,
  schema: { properties: Record<string, unknown> }
): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return {}
  const declared = new Set(Object.keys(schema.properties))
  return Object.fromEntries(
    Object.entries(params as Record<string, unknown>).filter(([key]) => declared.has(key))
  )
}
