/**
 * The agent harness adds bookkeeping fields (for example the `i` intent note) to every tool
 * call, while the remote workspace boundary rejects any key it does not know. Forward only the
 * fields a tool declares in its own schema so a harmless extra field can never fail a request.
 */
export function pickDeclaredToolInput(
  params: unknown,
  schema: Record<string, unknown>
): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return {}
  const declared = new Set<string>()
  const seen = new Set<object>()
  const collect = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return
    if (seen.has(candidate)) return
    seen.add(candidate)
    const record = candidate as Record<string, unknown>
    if (
      typeof record.properties === 'object' &&
      record.properties !== null &&
      !Array.isArray(record.properties)
    ) {
      for (const key of Object.keys(record.properties)) declared.add(key)
    }
    // Browser tools declare their top-level fields in object union branches.
    // Do not descend into property values: nested objects are tool-owned data.
    for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
      const branches = record[keyword]
      if (Array.isArray(branches)) for (const branch of branches) collect(branch)
    }
  }
  collect(schema)
  return Object.fromEntries(
    Object.entries(params as Record<string, unknown>).filter(([key]) => declared.has(key))
  )
}
