import { markdownCopy } from '../components/markdown/markdownUiCopy'
function moleculeRendererApi(): {
  renderMoleculeSvg: (value: string, width: number, height: number) => Promise<string>
} | null {
  if (typeof window === 'undefined') return null

  const api = (window as unknown as { api?: { renderMoleculeSvg?: unknown } }).api
  return typeof api?.renderMoleculeSvg === 'function'
    ? {
        renderMoleculeSvg: api.renderMoleculeSvg as (
          value: string,
          width: number,
          height: number
        ) => Promise<string>
      }
    : null
}

export async function renderMoleculeSvg(
  value: string,
  width: number,
  height: number
): Promise<string> {
  const api = moleculeRendererApi()
  if (!api) throw new Error(markdownCopy.structureServiceUnavailable)
  return api.renderMoleculeSvg(value, width, height)
}
