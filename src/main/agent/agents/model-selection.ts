/**
 * Chooses a specialist session's model from its declared selectors.
 * The caller supplies the same resolver the main session uses; this function
 * only applies the contract's order and fallback.
 */
export interface AgentModelSelection<T> {
  model?: T
  /** Set when selectors were declared and none of them resolved. */
  warning?: string
}

export async function selectAgentModel<T>(
  agentName: string,
  selectors: readonly string[] | undefined,
  resolve: (selector: string) => Promise<T | undefined> | T | undefined,
  parentModel?: T
): Promise<AgentModelSelection<T>> {
  if (!selectors || selectors.length === 0) {
    return parentModel === undefined ? {} : { model: parentModel }
  }

  for (const selector of selectors) {
    const resolved = await resolve(selector)
    if (resolved !== undefined) return { model: resolved }
  }

  const warning = `Phi agent ${agentName}: model ${selectors.join(', ')} not available; using the conversation's model`
  return parentModel === undefined ? { warning } : { model: parentModel, warning }
}
