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
  if (!api) throw new Error('分子结构预览服务不可用')
  return api.renderMoleculeSvg(value, width, height)
}
