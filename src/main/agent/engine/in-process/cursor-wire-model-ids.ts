import type { RuntimeModel } from './common'

/** Bind a logical Cursor row to only its configured thinking-level wire IDs. */
export function cursorWireModelIds(model: RuntimeModel): readonly string[] {
  const ids = new Set<string>([model.id])
  if (model.requestModelId) ids.add(model.requestModelId)
  if (model.thinking?.mode === 'effort') {
    for (const route of Object.values(model.thinking.effortRouting ?? {})) {
      if (typeof route === 'string' && route) ids.add(route)
    }
  }
  return [...ids]
}
