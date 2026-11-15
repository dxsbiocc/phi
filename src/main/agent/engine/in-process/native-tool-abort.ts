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

const wrappedTools = new WeakSet<object>()

/**
 * Cursor's exec bridge calls local tools with an undefined signal. For native shell
 * tools that means Phi's abort never reaches the process-group killer. Inject the
 * owning host-agent signal on the tool object before any Cursor tool frame arrives.
 */
export function injectNativeToolAbortSignal(
  session: { getToolByName: (name: string) => unknown },
  signal?: AbortSignal
): void {
  if (!signal) return
  for (const name of ['bash', 'powershell']) {
    const tool = session.getToolByName(name) as AbortAwareTool | undefined
    if (!tool || typeof tool.execute !== 'function' || wrappedTools.has(tool)) continue
    const original = tool.execute.bind(tool)
    tool.execute = (toolCallId, args, supplied, onUpdate, context) => {
      const effective =
        supplied && supplied !== signal ? AbortSignal.any([supplied, signal]) : (supplied ?? signal)
      return original(toolCallId, args, effective, onUpdate, context)
    }
    wrappedTools.add(tool)
  }
}
