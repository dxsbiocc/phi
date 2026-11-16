type AbortAwareTool = {
  name?: string
  execute: (
    toolCallId: string,
    args: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: unknown
  ) => unknown
}

type OwnerSignal = { current: AbortSignal }
const installed = new WeakMap<object, OwnerSignal>()

/**
 * Cursor's exec bridge calls local tools with an undefined signal. For native shell
 * tools that means Phi's abort never reaches the process-group killer. Inject the
 * owning host-agent signal on the tool object before any Cursor tool frame arrives.
 *
 * A persistent session installs a fresh prompt scope on every prompt. Re-installing
 * updates the signal behind the existing wrapper, so an aborted earlier prompt can
 * never leak into the next one (and a wrapper is never nested per prompt).
 */
export function injectNativeToolAbortSignal(
  session: { getToolByName: (name: string) => unknown },
  signal?: AbortSignal
): void {
  if (!signal) return
  for (const name of ['bash', 'powershell']) {
    const tool = session.getToolByName(name) as AbortAwareTool | undefined
    if (!tool || typeof tool.execute !== 'function') continue
    const existing = installed.get(tool)
    if (existing) {
      existing.current = signal
      continue
    }
    const owner: OwnerSignal = { current: signal }
    const original = tool.execute.bind(tool)
    tool.execute = (toolCallId, args, supplied, onUpdate, context) => {
      const current = owner.current
      const effective =
        supplied && supplied !== current
          ? AbortSignal.any([supplied, current])
          : (supplied ?? current)
      return original(toolCallId, args, effective, onUpdate, context)
    }
    installed.set(tool, owner)
  }
}
