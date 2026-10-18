import { defineCopy } from './lib/i18n'

const paletteCopy = defineCopy(
  { minimal: 'Minimal (default)', watercolor: 'Chinese Watercolor', yourName: 'Your Name' },
  { minimal: 'Minimal（默认）', watercolor: '中国水墨画', yourName: '你的名字' }
)

export const THEME_PALETTE_IDS = [
  'minimal',
  'plotdb',
  'aiesec',
  'asana',
  'wufoo',
  'zendesk',
  'elastic-search',
  'chinese-watercolor',
  'happiness-cyanide',
  'your-name'
] as const

export type ThemePaletteId = (typeof THEME_PALETTE_IDS)[number]

export interface ThemePaletteDefinition {
  id: ThemePaletteId
  label: string
  colors: readonly string[]
  primary: string
  secondary: string
  info: string
  success: string
  warning: string
  error: string
  darkBackground: string
  darkPaper: string
  sourceUrl?: string
}

export const THEME_PALETTES: readonly ThemePaletteDefinition[] = [
  {
    id: 'minimal',
    get label() {
      return paletteCopy.minimal
    },
    colors: ['#00A76F', '#FFFFFF', '#00B8D9', '#FFAB00', '#FF5630'],
    primary: '#00A76F',
    secondary: '#8E33FF',
    info: '#00B8D9',
    success: '#22C55E',
    warning: '#FFAB00',
    error: '#FF5630',
    darkBackground: '#0D1218',
    darkPaper: '#141A21'
  },
  {
    id: 'plotdb',
    label: 'PlotDB',
    colors: ['#ED6CA4', '#FBB05B', '#ACD372', '#7BC4E2'],
    primary: '#ED6CA4',
    secondary: '#7BC4E2',
    info: '#7BC4E2',
    success: '#ACD372',
    warning: '#FBB05B',
    error: '#D94D78',
    darkBackground: '#241820',
    darkPaper: '#30202B',
    sourceUrl: 'https://loading.io/color/feature/PlotDB/'
  },
  {
    id: 'aiesec',
    label: 'AIESEC',
    colors: [
      '#037EF3',
      '#F85A40',
      '#30C39E',
      '#0A8EA0',
      '#F48924',
      '#FFC846',
      '#52565E',
      '#CBCDD1',
      '#F3F4F7'
    ],
    primary: '#037EF3',
    secondary: '#0A8EA0',
    info: '#037EF3',
    success: '#30C39E',
    warning: '#FFC846',
    error: '#F85A40',
    darkBackground: '#0A1C33',
    darkPaper: '#112845',
    sourceUrl: 'https://loading.io/color/feature/aiesec/'
  },
  {
    id: 'asana',
    label: 'Asana',
    colors: ['#3BE8B0', '#1AAFD0', '#6A67CE', '#FFB900', '#FC636B'],
    primary: '#6A67CE',
    secondary: '#1AAFD0',
    info: '#1AAFD0',
    success: '#3BE8B0',
    warning: '#FFB900',
    error: '#FC636B',
    darkBackground: '#19182A',
    darkPaper: '#24223A',
    sourceUrl: 'https://loading.io/color/feature/asana/'
  },
  {
    id: 'wufoo',
    label: 'Wufoo',
    colors: ['#E66760', '#8C88CD', '#69C5E4', '#FFDF8B', '#61E064'],
    primary: '#8C88CD',
    secondary: '#69C5E4',
    info: '#69C5E4',
    success: '#61E064',
    warning: '#FFDF8B',
    error: '#E66760',
    darkBackground: '#181726',
    darkPaper: '#24223A',
    sourceUrl: 'https://loading.io/color/feature/wufoo/'
  },
  {
    id: 'zendesk',
    label: 'Zendesk',
    colors: [
      '#00363D',
      '#F79A3E',
      '#EB6651',
      '#30AABC',
      '#EB4962',
      '#37B8AF',
      '#78A300',
      '#F0CA28'
    ],
    primary: '#37B8AF',
    secondary: '#30AABC',
    info: '#30AABC',
    success: '#78A300',
    warning: '#F0CA28',
    error: '#EB4962',
    darkBackground: '#0B2024',
    darkPaper: '#123136',
    sourceUrl: 'https://loading.io/color/feature/zendesk/'
  },
  {
    id: 'elastic-search',
    label: 'Elastic Search',
    colors: ['#66B5AE', '#D7689D', '#F3D337', '#5DA4DC', '#A0C443', '#40769E'],
    primary: '#A0C443',
    secondary: '#66B5AE',
    info: '#5DA4DC',
    success: '#A0C443',
    warning: '#F3D337',
    error: '#D7689D',
    darkBackground: '#142532',
    darkPaper: '#1D3443',
    sourceUrl: 'https://loading.io/color/feature/ElasticSearch/'
  },
  {
    id: 'chinese-watercolor',
    get label() {
      return paletteCopy.watercolor
    },
    colors: ['#832F0E', '#0C0A08', '#594A40', '#8E7967', '#E3C2A0', '#DEAA6E', '#81947A'],
    primary: '#832F0E',
    secondary: '#81947A',
    info: '#8E7967',
    success: '#81947A',
    warning: '#DEAA6E',
    error: '#832F0E',
    darkBackground: '#0C0A08',
    darkPaper: '#1D1814',
    sourceUrl:
      'https://loading.io/color/feature/ChineseWaterColor-%E4%B8%AD%E5%9C%8B%E6%B0%B4%E5%A2%A8%E7%95%AB/'
  },
  {
    id: 'happiness-cyanide',
    label: 'Happiness & Cyanide',
    colors: ['#FACD9E', '#389798', '#459448', '#F19D3B', '#923F2B'],
    primary: '#389798',
    secondary: '#F19D3B',
    info: '#389798',
    success: '#459448',
    warning: '#F19D3B',
    error: '#923F2B',
    darkBackground: '#172423',
    darkPaper: '#203332',
    sourceUrl: 'https://loading.io/color/feature/HappinessandCyanide/'
  },
  {
    id: 'your-name',
    get label() {
      return paletteCopy.yourName
    },
    colors: ['#8CD0E5', '#376888', '#826B88', '#DE786A', '#F8B976', '#FCDDC9'],
    primary: '#376888',
    secondary: '#826B88',
    info: '#8CD0E5',
    success: '#6B9B87',
    warning: '#F8B976',
    error: '#DE786A',
    darkBackground: '#171D28',
    darkPaper: '#222A38',
    sourceUrl: 'https://loading.io/color/feature/YourName-%E5%90%9B%E3%81%AE%E5%90%8D%E3%81%AF/'
  }
] as const

const PALETTE_BY_ID = new Map(THEME_PALETTES.map((palette) => [palette.id, palette]))

export function isThemePaletteId(value: unknown): value is ThemePaletteId {
  return typeof value === 'string' && PALETTE_BY_ID.has(value as ThemePaletteId)
}

export function themePaletteDefinition(id: ThemePaletteId): ThemePaletteDefinition {
  return PALETTE_BY_ID.get(id) ?? THEME_PALETTES[0]
}

export function themePalettePreviewColors(palette: ThemePaletteDefinition): readonly string[] {
  return [
    ...new Set([
      palette.primary,
      palette.secondary,
      palette.info,
      palette.success,
      palette.warning,
      palette.error
    ])
  ]
}
