import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CustomTool } from '@oh-my-pi/pi-coding-agent'
import { parse as parseYaml } from 'yaml'

import { getBundledPalettesDir } from '../runtime/runtime-adapter'

export type PaletteUse = 'categorical' | 'heatmap' | 'diverging' | 'sequential_warm' | 'product'

type Palette = {
  id: string
  title: string
  kind: 'categorical' | 'sequential' | 'diverging'
  use_when: string
  colors: string[]
}

type PaletteCatalog = {
  defaults: Record<PaletteUse, string>
  recommended: Palette[]
}

const DEFAULT_IDS: Record<PaletteUse, string> = {
  categorical: 'Qualitative.Safe',
  heatmap: 'Quantitative.BluGrn',
  diverging: 'Diverging.RdBu',
  sequential_warm: 'Gradient.YlOrRd',
  product: 'Brand.Algolia'
}

const USE_KINDS: Record<PaletteUse, Palette['kind']> = {
  categorical: 'categorical',
  heatmap: 'sequential',
  diverging: 'diverging',
  sequential_warm: 'sequential',
  product: 'categorical'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCatalog(path: string): PaletteCatalog {
  const raw: unknown = parseYaml(readFileSync(path, 'utf8'))
  if (!isRecord(raw) || !isRecord(raw.defaults) || !Array.isArray(raw.recommended)) {
    throw new Error('Phi 内置配色表格式无效。')
  }
  const rawDefaults = raw.defaults

  const recommended = raw.recommended.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.use_when !== 'string' ||
      typeof item.kind !== 'string' ||
      !['categorical', 'sequential', 'diverging'].includes(item.kind) ||
      !Array.isArray(item.colors) ||
      item.colors.length === 0 ||
      !item.colors.every((color) => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color))
    ) {
      throw new Error('Phi 内置配色表包含无效条目。')
    }
    return {
      id: item.id,
      title: item.title,
      kind: item.kind as Palette['kind'],
      use_when: item.use_when.trim(),
      colors: item.colors as string[]
    }
  })

  const defaults = Object.fromEntries(
    (Object.keys(DEFAULT_IDS) as PaletteUse[]).map((use) => {
      const catalogKey =
        use === 'heatmap' ? 'heatmap' : use === 'product' ? 'categorical_product' : use
      const id = rawDefaults[catalogKey]
      return [use, typeof id === 'string' ? id : DEFAULT_IDS[use]]
    })
  ) as Record<PaletteUse, string>

  return { defaults, recommended }
}

export function suggestPalettes(
  catalog: PaletteCatalog,
  request: { use?: PaletteUse; id?: string; limit?: number }
): Palette[] {
  if (request.id) {
    const match = catalog.recommended.find(
      (palette) => palette.id.toLowerCase() === request.id?.toLowerCase()
    )
    if (!match) throw new Error(`未找到内置配色：${request.id}`)
    return [match]
  }

  const use = request.use ?? 'categorical'
  const defaultId = catalog.defaults[use]
  const limit = Math.min(4, Math.max(1, request.limit ?? 3))
  return catalog.recommended
    .filter((palette) => {
      if (palette.kind !== USE_KINDS[use]) return false
      if (use === 'product') return palette.id.startsWith('Brand.')
      if (use === 'sequential_warm') {
        return palette.id === 'Gradient.YlOrRd' || palette.id === 'Quantitative.Sunset'
      }
      return true
    })
    .sort((left, right) => Number(right.id === defaultId) - Number(left.id === defaultId))
    .slice(0, limit)
}

export function buildPaletteRecommendationTool(
  catalogPath = join(getBundledPalettesDir(), 'palettes.yaml')
): CustomTool {
  return {
    name: 'palette_suggest',
    label: 'Suggest Built-in Color Palettes',
    description:
      'Recommend named Phi-bundled palettes for color-scheme requests without delegating a figure task. Choose use= categorical for groups, heatmap for continuous cool values, diverging for signed values, sequential_warm for warm magnitudes, or product for OmicsAgent branding. Return each palette ID and ordered hex colors to the user so the chat can show swatches. Do not invent colors or claim that a palette alone guarantees readable UI contrast. Use id to retrieve one exact recommended palette.',
    parameters: {
      type: 'object',
      properties: {
        use: {
          type: 'string',
          enum: ['categorical', 'heatmap', 'diverging', 'sequential_warm', 'product'],
          description: 'What the colors encode. Defaults to categorical.'
        },
        id: { type: 'string', description: 'Exact palette ID from a previous suggestion.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 4,
          description: 'Maximum suggestions; default 3.'
        }
      }
    },
    approval: 'read',
    async execute(_toolCallId, params) {
      try {
        const input = isRecord(params) ? params : {}
        const use = input.use === undefined ? undefined : String(input.use)
        if (use !== undefined && !(use in USE_KINDS)) throw new Error('无效的配色用途。')
        if (input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim())) {
          throw new Error('配色 ID 不能为空。')
        }
        if (
          input.limit !== undefined &&
          (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 4)
        ) {
          throw new Error('limit 必须为 1 到 4 的整数。')
        }
        const catalog = readCatalog(catalogPath)
        const palettes = suggestPalettes(catalog, {
          ...(use ? { use: use as PaletteUse } : {}),
          ...(typeof input.id === 'string' ? { id: input.id.trim() } : {}),
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {})
        })
        const details = {
          kind: 'palette_suggestions',
          source: 'resources/palettes/palettes.yaml',
          palettes
        }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true
        }
      }
    }
  }
}
