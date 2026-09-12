import type { RendererApi } from '../types'

export function getRendererApi(): RendererApi {
  return (window as unknown as { api: RendererApi }).api
}
