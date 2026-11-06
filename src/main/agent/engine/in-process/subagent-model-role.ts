/**
 * Built-in subagents ask for role models such as `@smol`, which inherit the `default` role and
 * otherwise fall back to OMP's built-in priority list. Phi picks a model per conversation and
 * never sets that role, so subagents could land on any configured provider (a rate-limited
 * Cursor model under a DeepSeek conversation, say). Each session owns a cloned Settings, so
 * keeping its runtime `default` role on the conversation's model makes subagents follow it.
 * The override lives only in memory; explicitly configured roles such as `smol` still win.
 */
interface SessionModelSource {
  readonly model?: { readonly provider: string; readonly id: string }
  subscribe(listener: (event: unknown) => void): () => void
}

interface RoleOverrides {
  overrideModelRoles(roles: Readonly<Record<string, string>>): void
}

export function followSessionModelForSubagents(
  session: SessionModelSource,
  settings: RoleOverrides
): () => void {
  let applied: string | undefined
  const sync = (): void => {
    const model = session.model
    if (!model) return
    const selector = `${model.provider}/${model.id}`
    if (selector === applied) return
    applied = selector
    settings.overrideModelRoles({ default: selector })
  }
  sync()
  return session.subscribe(sync)
}
