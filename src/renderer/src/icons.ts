import { Box } from '@mui/material'
import { SvgIcon } from '@mui/material'
import { useTheme, type SxProps, type Theme } from '@mui/material/styles'
import materialIconManifestJson from 'material-icon-theme/dist/material-icons.json' with { type: 'json' }
import type { Manifest } from 'material-icon-theme'
import materialArchiveSvg from '../../../node_modules/material-icon-theme/icons/zip.svg?raw'
import materialAdobeIllustratorSvg from '../../../node_modules/material-icon-theme/icons/adobe-illustrator.svg?raw'
import materialAdobePhotoshopSvg from '../../../node_modules/material-icon-theme/icons/adobe-photoshop.svg?raw'
import materialAstroSvg from '../../../node_modules/material-icon-theme/icons/astro.svg?raw'
import materialAudioSvg from '../../../node_modules/material-icon-theme/icons/audio.svg?raw'
import materialBinarySvg from '../../../node_modules/material-icon-theme/icons/hex.svg?raw'
import materialBunSvg from '../../../node_modules/material-icon-theme/icons/bun.svg?raw'
import materialCSvg from '../../../node_modules/material-icon-theme/icons/c.svg?raw'
import materialCertificateSvg from '../../../node_modules/material-icon-theme/icons/certificate.svg?raw'
import materialClojureSvg from '../../../node_modules/material-icon-theme/icons/clojure.svg?raw'
import materialCodeSvg from '../../../node_modules/material-icon-theme/icons/javascript.svg?raw'
import materialConfigSvg from '../../../node_modules/material-icon-theme/icons/settings.svg?raw'
import materialConsoleSvg from '../../../node_modules/material-icon-theme/icons/console.svg?raw'
import materialCppSvg from '../../../node_modules/material-icon-theme/icons/cpp.svg?raw'
import materialCsharpSvg from '../../../node_modules/material-icon-theme/icons/csharp.svg?raw'
import materialCssSvg from '../../../node_modules/material-icon-theme/icons/css.svg?raw'
import materialDartSvg from '../../../node_modules/material-icon-theme/icons/dart.svg?raw'
import materialDataSvg from '../../../node_modules/material-icon-theme/icons/database.svg?raw'
import materialDenoSvg from '../../../node_modules/material-icon-theme/icons/deno.svg?raw'
import materialDirectorySvg from '../../../node_modules/material-icon-theme/icons/folder.svg?raw'
import materialDirectoryOpenSvg from '../../../node_modules/material-icon-theme/icons/folder-open.svg?raw'
import materialDockerSvg from '../../../node_modules/material-icon-theme/icons/docker.svg?raw'
import materialDocumentSvg from '../../../node_modules/material-icon-theme/icons/document.svg?raw'
import materialDotenvSvg from '../../../node_modules/material-icon-theme/icons/tune.svg?raw'
import materialElixirSvg from '../../../node_modules/material-icon-theme/icons/elixir.svg?raw'
import materialErlangSvg from '../../../node_modules/material-icon-theme/icons/erlang.svg?raw'
import materialFileSvg from '../../../node_modules/material-icon-theme/icons/file.svg?raw'
import materialFolderTestSvg from '../../../node_modules/material-icon-theme/icons/folder-test.svg?raw'
import materialFolderTestOpenSvg from '../../../node_modules/material-icon-theme/icons/folder-test-open.svg?raw'
import materialFontSvg from '../../../node_modules/material-icon-theme/icons/font.svg?raw'
import materialGoSvg from '../../../node_modules/material-icon-theme/icons/go.svg?raw'
import materialHaskellSvg from '../../../node_modules/material-icon-theme/icons/haskell.svg?raw'
import materialHtmlSvg from '../../../node_modules/material-icon-theme/icons/html.svg?raw'
import materialImageSvg from '../../../node_modules/material-icon-theme/icons/image.svg?raw'
import materialJavaSvg from '../../../node_modules/material-icon-theme/icons/java.svg?raw'
import materialJavascriptSvg from '../../../node_modules/material-icon-theme/icons/javascript.svg?raw'
import materialJsonSvg from '../../../node_modules/material-icon-theme/icons/json.svg?raw'
import materialJuliaSvg from '../../../node_modules/material-icon-theme/icons/julia.svg?raw'
import materialJupyterSvg from '../../../node_modules/material-icon-theme/icons/jupyter.svg?raw'
import materialKeySvg from '../../../node_modules/material-icon-theme/icons/key.svg?raw'
import materialKotlinSvg from '../../../node_modules/material-icon-theme/icons/kotlin.svg?raw'
import materialLockSvg from '../../../node_modules/material-icon-theme/icons/lock.svg?raw'
import materialLuaSvg from '../../../node_modules/material-icon-theme/icons/lua.svg?raw'
import materialMarkdownSvg from '../../../node_modules/material-icon-theme/icons/markdown.svg?raw'
import materialNodeSvg from '../../../node_modules/material-icon-theme/icons/nodejs.svg?raw'
import materialPdfSvg from '../../../node_modules/material-icon-theme/icons/pdf.svg?raw'
import materialPerlSvg from '../../../node_modules/material-icon-theme/icons/perl.svg?raw'
import materialPhpSvg from '../../../node_modules/material-icon-theme/icons/php.svg?raw'
import materialPythonMiscSvg from '../../../node_modules/material-icon-theme/icons/python-misc.svg?raw'
import materialPythonSvg from '../../../node_modules/material-icon-theme/icons/python.svg?raw'
import materialPowerpointSvg from '../../../node_modules/material-icon-theme/icons/powerpoint.svg?raw'
import materialRSvg from '../../../node_modules/material-icon-theme/icons/r.svg?raw'
import materialReactSvg from '../../../node_modules/material-icon-theme/icons/react_ts.svg?raw'
import materialReadmeSvg from '../../../node_modules/material-icon-theme/icons/readme.svg?raw'
import materialRubySvg from '../../../node_modules/material-icon-theme/icons/ruby.svg?raw'
import materialRustSvg from '../../../node_modules/material-icon-theme/icons/rust.svg?raw'
import materialSasSvg from '../../../node_modules/material-icon-theme/icons/sas.svg?raw'
import materialSassSvg from '../../../node_modules/material-icon-theme/icons/sass.svg?raw'
import materialScalaSvg from '../../../node_modules/material-icon-theme/icons/scala.svg?raw'
import materialSoliditySvg from '../../../node_modules/material-icon-theme/icons/solidity.svg?raw'
import materialSvelteSvg from '../../../node_modules/material-icon-theme/icons/svelte.svg?raw'
import materialSwiftSvg from '../../../node_modules/material-icon-theme/icons/swift.svg?raw'
import materialTableSvg from '../../../node_modules/material-icon-theme/icons/table.svg?raw'
import materialTomlSvg from '../../../node_modules/material-icon-theme/icons/toml.svg?raw'
import materialTypescriptSvg from '../../../node_modules/material-icon-theme/icons/typescript.svg?raw'
import materialUvSvg from '../../../node_modules/material-icon-theme/icons/uv.svg?raw'
import materialVideoSvg from '../../../node_modules/material-icon-theme/icons/video.svg?raw'
import materialVueSvg from '../../../node_modules/material-icon-theme/icons/vue.svg?raw'
import materialWordSvg from '../../../node_modules/material-icon-theme/icons/word.svg?raw'
import materialXmlSvg from '../../../node_modules/material-icon-theme/icons/xml.svg?raw'
import materialYamlSvg from '../../../node_modules/material-icon-theme/icons/yaml.svg?raw'
import materialZigSvg from '../../../node_modules/material-icon-theme/icons/zig.svg?raw'
import {
  FiCheck,
  FiCheckCircle,
  FiChevronDown,
  FiChevronRight,
  FiChevronUp,
  FiCopy,
  FiDownload,
  FiEdit3,
  FiExternalLink,
  FiFileText,
  FiBarChart2,
  FiGlobe,
  FiKey,
  FiLock,
  FiLogIn,
  FiLogOut,
  FiMessageCircle,
  FiMessageSquare,
  FiMoreHorizontal,
  FiPlay,
  FiPlus,
  FiRefreshCw,
  FiSave,
  FiSearch,
  FiSend,
  FiSettings,
  FiShield,
  FiSquare,
  FiTerminal,
  FiTool,
  FiTrash2,
  FiUnlock,
  FiX,
  FiXCircle,
  FiZap
} from 'react-icons/fi'
import type { IconType } from 'react-icons'
import {
  TbBrain,
  TbFolderOpen,
  TbGauge,
  TbListTree,
  TbNetwork,
  TbPalette,
  TbPuzzle,
  TbRoute,
  TbSchool,
  TbServer
} from 'react-icons/tb'
import { SiJupyter } from 'react-icons/si'
import {
  createElement,
  forwardRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ElementType,
  type ForwardRefExoticComponent,
  type RefAttributes
} from 'react'
import type { PermissionMode } from './types'

type PhiIconFontSize = 'inherit' | 'small' | 'medium' | 'large'

export type PhiIconProps = Omit<
  ComponentPropsWithoutRef<'span'>,
  'children' | 'color' | 'ref' | 'size' | 'style'
> & {
  color?: string
  fontSize?: PhiIconFontSize
  htmlColor?: string
  size?: number | string
  strokeWidth?: number | string
  style?: CSSProperties
  sx?: SxProps<Theme>
}

export type PhiIconComponent = ForwardRefExoticComponent<
  PhiIconProps & RefAttributes<HTMLSpanElement>
>

const PHI_STROKE_WIDTH = 1.85
const PYTHON_BLUE = '#3776AB'
const FILE_ICON_GREEN = '#217346'
const FILE_ICON_MARKDOWN = '#6B7280'
const FILE_ICON_JSON = '#F2C94C'
const MATERIAL_ICON_ASSET_PREFIX = '../../../node_modules/material-icon-theme/icons/'
const MATERIAL_ICON_MANIFEST = materialIconManifestJson as Manifest
const MATERIAL_ICON_SVG_MODULES =
  typeof import.meta.glob === 'function'
    ? import.meta.glob('../../../node_modules/material-icon-theme/icons/*.svg', {
        eager: true,
        import: 'default',
        query: '?raw'
      })
    : {}
const MATERIAL_ICON_SVG_MARKUP = MATERIAL_ICON_SVG_MODULES as Record<string, string>
const MATERIAL_ICON_COMPONENT_CACHE = new Map<string, PhiIconComponent>()
const MATERIAL_ICON_DIRECT_SVG_MARKUP: Record<string, string> = {
  'adobe-illustrator': materialAdobeIllustratorSvg,
  'adobe-photoshop': materialAdobePhotoshopSvg,
  astro: materialAstroSvg,
  audio: materialAudioSvg,
  bun: materialBunSvg,
  c: materialCSvg,
  certificate: materialCertificateSvg,
  clojure: materialClojureSvg,
  code: materialCodeSvg,
  console: materialConsoleSvg,
  cpp: materialCppSvg,
  csharp: materialCsharpSvg,
  css: materialCssSvg,
  dart: materialDartSvg,
  database: materialDataSvg,
  deno: materialDenoSvg,
  docker: materialDockerSvg,
  document: materialDocumentSvg,
  elixir: materialElixirSvg,
  erlang: materialErlangSvg,
  file: materialFileSvg,
  folder: materialDirectorySvg,
  'folder-open': materialDirectoryOpenSvg,
  'folder-test': materialFolderTestSvg,
  'folder-test-open': materialFolderTestOpenSvg,
  font: materialFontSvg,
  go: materialGoSvg,
  haskell: materialHaskellSvg,
  hex: materialBinarySvg,
  html: materialHtmlSvg,
  image: materialImageSvg,
  java: materialJavaSvg,
  javascript: materialJavascriptSvg,
  json: materialJsonSvg,
  julia: materialJuliaSvg,
  jupyter: materialJupyterSvg,
  key: materialKeySvg,
  kotlin: materialKotlinSvg,
  lock: materialLockSvg,
  lua: materialLuaSvg,
  markdown: materialMarkdownSvg,
  nodejs: materialNodeSvg,
  pdf: materialPdfSvg,
  perl: materialPerlSvg,
  php: materialPhpSvg,
  python: materialPythonSvg,
  'python-misc': materialPythonMiscSvg,
  powerpoint: materialPowerpointSvg,
  r: materialRSvg,
  react_ts: materialReactSvg,
  readme: materialReadmeSvg,
  ruby: materialRubySvg,
  rust: materialRustSvg,
  sas: materialSasSvg,
  sass: materialSassSvg,
  scala: materialScalaSvg,
  settings: materialConfigSvg,
  solidity: materialSoliditySvg,
  svelte: materialSvelteSvg,
  swift: materialSwiftSvg,
  table: materialTableSvg,
  toml: materialTomlSvg,
  tune: materialDotenvSvg,
  typescript: materialTypescriptSvg,
  uv: materialUvSvg,
  video: materialVideoSvg,
  vue: materialVueSvg,
  word: materialWordSvg,
  xml: materialXmlSvg,
  yaml: materialYamlSvg,
  zig: materialZigSvg,
  zip: materialArchiveSvg
}

type NodeLikeProcess = {
  getBuiltinModule?: (moduleName: string) => unknown
  versions?: {
    node?: string
  }
}

type ParsedMaterialSvg = {
  content: string
  fill?: string
  stroke?: string
  viewBox: string
}

type CreatePhiIconOptions = {
  defaultStrokeWidth?: number | string | null
  scale?: number
}

function lowerCaseRecord(record?: Record<string, string>): Record<string, string> {
  if (!record) return {}
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key.toLowerCase(), value])
  )
}

const MATERIAL_FILE_NAME_ICONS = lowerCaseRecord(MATERIAL_ICON_MANIFEST.fileNames)
const MATERIAL_FILE_EXTENSION_ICONS = lowerCaseRecord(MATERIAL_ICON_MANIFEST.fileExtensions)
const MATERIAL_FOLDER_NAME_ICONS = lowerCaseRecord(MATERIAL_ICON_MANIFEST.folderNames)
const MATERIAL_FOLDER_EXPANDED_NAME_ICONS = lowerCaseRecord(
  MATERIAL_ICON_MANIFEST.folderNamesExpanded
)
const MATERIAL_ROOT_FOLDER_NAME_ICONS = lowerCaseRecord(MATERIAL_ICON_MANIFEST.rootFolderNames)
const MATERIAL_ROOT_FOLDER_EXPANDED_NAME_ICONS = lowerCaseRecord(
  MATERIAL_ICON_MANIFEST.rootFolderNamesExpanded
)
const MATERIAL_FILE_EXTENSION_KEYS = Object.keys(MATERIAL_FILE_EXTENSION_ICONS).sort(
  (a, b) => b.length - a.length
)
const MATERIAL_FILE_EXTENSION_ICON_OVERRIDES: Record<string, string> = {
  arrow: 'database',
  bam: 'database',
  bed: 'database',
  db: 'database',
  docm: 'word',
  dotx: 'word',
  dta: 'database',
  fa: 'database',
  fasta: 'database',
  fastq: 'database',
  feather: 'database',
  fq: 'database',
  gff: 'database',
  gtf: 'database',
  h5: 'database',
  h5ad: 'database',
  hdf5: 'database',
  loom: 'database',
  numbers: 'table',
  pages: 'document',
  parquet: 'database',
  rda: 'database',
  rds: 'database',
  sam: 'database',
  sav: 'database',
  vcf: 'database',
  xlsb: 'table',
  xlt: 'table',
  xltx: 'table',
  zarr: 'database'
}
const MATERIAL_FILE_EXTENSION_OVERRIDE_KEYS = Object.keys(
  MATERIAL_FILE_EXTENSION_ICON_OVERRIDES
).sort((a, b) => b.length - a.length)
const MATERIAL_FILE_NAME_ICON_OVERRIDES: Record<string, string> = {
  '.venv': 'folder-environment'
}
const VIRTUAL_ENV_DIRECTORY_NAMES = new Set(['.venv', 'venv'])

function fontSizeValue(fontSize?: PhiIconFontSize, size?: number | string): string | number {
  if (size !== undefined) return size
  if (fontSize === 'inherit') return 'inherit'
  if (fontSize === 'small') return '1.25rem'
  if (fontSize === 'large') return '2.1875rem'
  return '1.5rem'
}

function colorValue(color?: string, htmlColor?: string): string | undefined {
  if (htmlColor) return htmlColor
  if (!color || color === 'inherit') return color
  const paletteColor: Record<string, string> = {
    action: 'action.active',
    disabled: 'action.disabled',
    error: 'error.main',
    info: 'info.main',
    primary: 'primary.main',
    secondary: 'secondary.main',
    success: 'success.main',
    warning: 'warning.main'
  }
  return paletteColor[color] ?? color
}

function mergeSx(base: SxProps<Theme>, sx?: SxProps<Theme>): SxProps<Theme> {
  if (!sx) return base
  return Array.isArray(sx) ? ([base, ...sx] as SxProps<Theme>) : ([base, sx] as SxProps<Theme>)
}

function createPhiIcon(
  name: string,
  Icon: IconType,
  options: CreatePhiIconOptions = {}
): PhiIconComponent {
  const PhiIcon = forwardRef<HTMLSpanElement, PhiIconProps>(
    ({ className, color, fontSize, htmlColor, size, strokeWidth, style, sx, ...rest }, ref) => {
      const iconProps: Record<string, unknown> = {
        'aria-hidden': rest['aria-label'] ? undefined : true,
        color: 'currentColor',
        focusable: 'false',
        size: '1em'
      }
      if (options.scale) {
        iconProps.style = { transform: `scale(${options.scale})`, transformOrigin: 'center' }
      }
      if (strokeWidth !== undefined) {
        iconProps.strokeWidth = strokeWidth
      } else if (options.defaultStrokeWidth !== null) {
        iconProps.strokeWidth = options.defaultStrokeWidth ?? PHI_STROKE_WIDTH
      }

      return createElement(
        Box as ElementType,
        {
          ...rest,
          className,
          component: 'span',
          ref,
          style,
          sx: mergeSx(
            {
              alignItems: 'center',
              color: colorValue(color, htmlColor),
              display: 'inline-flex',
              flexShrink: 0,
              fontSize: fontSizeValue(fontSize, size),
              height: '1em',
              justifyContent: 'center',
              lineHeight: 0,
              width: '1em'
            },
            sx
          )
        },
        createElement(Icon, iconProps)
      )
    }
  )

  PhiIcon.displayName = `Phi${name}Icon`
  return PhiIcon
}

function materialIconFileName(iconName: string): string | null {
  const iconPath = MATERIAL_ICON_MANIFEST.iconDefinitions?.[iconName]?.iconPath
  return iconPath?.split('/').pop() ?? null
}

function nodeProcess(): NodeLikeProcess | null {
  const process = (globalThis as { process?: NodeLikeProcess }).process
  return process?.versions?.node ? process : null
}

function readMaterialIconMarkupFromDisk(fileName: string): string | null {
  const process = nodeProcess()
  if (!process?.getBuiltinModule) return null

  try {
    const fs = process.getBuiltinModule('node:fs') as
      { readFileSync?: (path: string, encoding: 'utf8') => string } | undefined
    const url = process.getBuiltinModule('node:url') as
      { fileURLToPath?: (url: URL) => string } | undefined
    if (!fs?.readFileSync || !url?.fileURLToPath) return null

    return fs.readFileSync(
      url.fileURLToPath(new URL(`${MATERIAL_ICON_ASSET_PREFIX}${fileName}`, import.meta.url)),
      'utf8'
    )
  } catch {
    return null
  }
}

function materialIconMarkup(iconName: string): string | null {
  const directMarkup = MATERIAL_ICON_DIRECT_SVG_MARKUP[iconName]
  if (directMarkup) return directMarkup

  const fileName = materialIconFileName(iconName)
  if (!fileName) return null

  const bundledMarkup = MATERIAL_ICON_SVG_MARKUP[`${MATERIAL_ICON_ASSET_PREFIX}${fileName}`]
  if (bundledMarkup) return bundledMarkup

  return readMaterialIconMarkupFromDisk(fileName)
}

function parseMaterialSvg(svgMarkup: string): ParsedMaterialSvg {
  const trimmed = svgMarkup.trim()
  const rootAttributes = trimmed.match(/<svg\b([^>]*)>/i)?.[1] ?? ''
  const fill = rootAttributes.match(/\sfill=(["'])(.*?)\1/i)?.[2]
  const stroke = rootAttributes.match(/\sstroke=(["'])(.*?)\1/i)?.[2]
  const viewBox = trimmed.match(/\sviewBox=(["'])(.*?)\1/i)?.[2] ?? '0 0 24 24'
  const content = trimmed.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/i)?.[1] ?? trimmed
  return { content, fill, stroke, viewBox }
}

function materialLightIconName(iconName: string): string | null {
  const lightIconName = `${iconName}_light`
  return materialIconMarkup(lightIconName) ? lightIconName : null
}

function createMaterialSvgIcon(name: string, iconName: string): PhiIconComponent {
  const svgMarkup = materialIconMarkup(iconName)
  if (!svgMarkup) return createMissingMaterialIcon(name, iconName)
  const defaultSvg = parseMaterialSvg(svgMarkup)
  const lightIconName = materialLightIconName(iconName)
  const lightSvgMarkup = lightIconName ? materialIconMarkup(lightIconName) : null
  const lightSvg = lightSvgMarkup ? parseMaterialSvg(lightSvgMarkup) : null

  const PhiIcon = forwardRef<HTMLSpanElement, PhiIconProps>(
    ({ className, color, fontSize, htmlColor, size, style, sx, ...rest }, ref) => {
      const theme = useTheme()
      const activeIconName = theme.palette.mode === 'light' && lightSvg ? lightIconName : iconName
      const activeSvg = theme.palette.mode === 'light' && lightSvg ? lightSvg : defaultSvg

      return createElement(
        Box as ElementType,
        {
          ...rest,
          className,
          component: 'span',
          ref,
          style,
          sx: mergeSx(
            {
              alignItems: 'center',
              color: colorValue(color, htmlColor),
              display: 'inline-flex',
              flexShrink: 0,
              fontSize: fontSizeValue(fontSize, size),
              height: '1em',
              justifyContent: 'center',
              lineHeight: 0,
              width: '1em'
            },
            sx
          )
        },
        createElement(
          SvgIcon as ElementType,
          {
            'aria-hidden': true,
            'data-phi-material-icon': activeIconName,
            focusable: 'false',
            htmlColor: undefined,
            inheritViewBox: false,
            viewBox: activeSvg.viewBox,
            sx: {
              display: 'block',
              fontSize: '1em',
              height: '1em',
              width: '1em'
            }
          },
          createElement('g', {
            dangerouslySetInnerHTML: { __html: activeSvg.content },
            fill: activeSvg.fill,
            stroke: activeSvg.stroke
          })
        )
      )
    }
  )

  PhiIcon.displayName = `Phi${name}MaterialIcon`
  return PhiIcon
}

function createMissingMaterialIcon(name: string, iconName: string): PhiIconComponent {
  const PhiIcon = forwardRef<HTMLSpanElement, PhiIconProps>(
    ({ className, color, fontSize, htmlColor, size, style, sx, ...rest }, ref) =>
      createElement(
        Box as ElementType,
        {
          ...rest,
          className,
          component: 'span',
          'data-phi-missing-material-icon': iconName,
          ref,
          style,
          sx: mergeSx(
            {
              alignItems: 'center',
              color: colorValue(color, htmlColor),
              display: 'inline-flex',
              flexShrink: 0,
              fontSize: fontSizeValue(fontSize, size),
              height: '1em',
              justifyContent: 'center',
              lineHeight: 0,
              width: '1em'
            },
            sx
          )
        },
        createElement(FiFileText, {
          'aria-hidden': true,
          color: 'currentColor',
          focusable: 'false',
          size: '1em',
          strokeWidth: PHI_STROKE_WIDTH
        })
      )
  )

  PhiIcon.displayName = `Phi${name}MissingMaterialIcon`
  return PhiIcon
}

function materialIconComponentForName(iconName: string): PhiIconComponent | null {
  const cached = MATERIAL_ICON_COMPONENT_CACHE.get(iconName)
  if (cached) return cached

  const safeIconName = iconName.replace(/[^A-Za-z0-9]/g, '')
  const Icon = materialIconMarkup(iconName)
    ? createMaterialSvgIcon(`Material${safeIconName}`, iconName)
    : createMissingMaterialIcon(`Material${safeIconName}`, iconName)
  MATERIAL_ICON_COMPONENT_CACHE.set(iconName, Icon)
  return Icon
}

const MATERIAL_ICON_NAME_BY_KIND = {
  archive: 'zip',
  astro: 'astro',
  audio: 'audio',
  binary: 'hex',
  bun: 'bun',
  c: 'c',
  clojure: 'clojure',
  code: 'javascript',
  config: 'settings',
  cpp: 'cpp',
  csharp: 'csharp',
  css: 'css',
  csv: 'table',
  dart: 'dart',
  data: 'database',
  deno: 'deno',
  document: 'word',
  directory: 'folder',
  docker: 'docker',
  dotenv: 'tune',
  elixir: 'elixir',
  erlang: 'erlang',
  fish: 'console',
  go: 'go',
  haskell: 'haskell',
  html: 'html',
  image: 'image',
  java: 'java',
  javascript: 'javascript',
  jupyter: 'jupyter',
  json: 'json',
  julia: 'julia',
  kotlin: 'kotlin',
  lock: 'lock',
  lua: 'lua',
  markdown: 'markdown',
  node: 'nodejs',
  pdf: 'pdf',
  perl: 'perl',
  php: 'php',
  presentation: 'powerpoint',
  python: 'python',
  r: 'r',
  react: 'react_ts',
  ruby: 'ruby',
  rust: 'rust',
  sass: 'sass',
  scala: 'scala',
  shell: 'console',
  solidity: 'solidity',
  spreadsheet: 'table',
  svelte: 'svelte',
  swift: 'swift',
  text: 'document',
  toml: 'toml',
  typescript: 'typescript',
  type: 'font',
  video: 'video',
  vue: 'vue',
  yaml: 'yaml',
  zig: 'zig'
} as const

export const PhiIcons = {
  action: {
    add: createPhiIcon('Add', FiPlus),
    addSession: createPhiIcon('AddSession', FiMessageSquare),
    approve: createPhiIcon('Approve', FiCheckCircle),
    back: createPhiIcon('Back', FiChevronRight),
    cancel: createPhiIcon('Cancel', FiXCircle),
    close: createPhiIcon('Close', FiX),
    collapse: createPhiIcon('Collapse', FiChevronUp),
    copy: createPhiIcon('Copy', FiCopy),
    delete: createPhiIcon('Delete', FiTrash2),
    download: createPhiIcon('Download', FiDownload),
    edit: createPhiIcon('Edit', FiEdit3),
    expand: createPhiIcon('Expand', FiChevronDown),
    format: createPhiIcon('Format', FiTool),
    login: createPhiIcon('Login', FiLogIn),
    logout: createPhiIcon('Logout', FiLogOut),
    more: createPhiIcon('More', FiMoreHorizontal),
    openDefault: createPhiIcon('OpenDefault', FiExternalLink),
    openExternal: createPhiIcon('OpenExternal', FiExternalLink),
    quick: createPhiIcon('Quick', FiZap),
    run: createPhiIcon('Run', FiPlay),
    refresh: createPhiIcon('Refresh', FiRefreshCw),
    save: createPhiIcon('Save', FiSave),
    saveKey: createPhiIcon('SaveKey', FiKey),
    search: createPhiIcon('Search', FiSearch),
    send: createPhiIcon('Send', FiSend),
    stop: createPhiIcon('Stop', FiSquare)
  },
  entity: {
    apiKey: createPhiIcon('ApiKey', FiKey),
    agent: createPhiIcon('Agent', TbBrain),
    directoryTree: createPhiIcon('DirectoryTree', TbListTree),
    folder: createPhiIcon('Folder', TbFolderOpen),
    mcp: createPhiIcon('Mcp', TbNetwork),
    plugin: createPhiIcon('Plugin', TbPuzzle),
    project: createPhiIcon('Project', TbFolderOpen),
    provider: createPhiIcon('Provider', TbNetwork),
    skill: createPhiIcon('Skill', TbSchool),
    wrapper: createPhiIcon('Wrapper', TbRoute)
  },
  nav: {
    analysis: createPhiIcon('NavAnalysis', FiFileText),
    chat: createPhiIcon('NavChat', FiMessageCircle),
    mcp: createPhiIcon('NavMcp', TbNetwork),
    plugins: createPhiIcon('NavPlugins', TbPuzzle),
    projects: createPhiIcon('NavProjects', TbFolderOpen),
    runtime: createPhiIcon('NavRuntime', SiJupyter),
    settings: createPhiIcon('NavSettings', FiSettings),
    skills: createPhiIcon('NavSkills', TbSchool),
    visualization: createPhiIcon('NavVisualization', FiBarChart2),
    wrappers: createPhiIcon('NavWrappers', TbRoute)
  },
  settings: {
    appearance: createPhiIcon('Appearance', TbPalette),
    diagnostics: createPhiIcon('Diagnostics', FiCopy),
    permissions: createPhiIcon('Permissions', FiShield),
    persona: createPhiIcon('Persona', TbBrain),
    providers: createPhiIcon('Providers', TbNetwork),
    remoteExecution: createPhiIcon('RemoteExecution', TbServer)
  },
  file: {
    archive: createMaterialSvgIcon('FileArchive', MATERIAL_ICON_NAME_BY_KIND.archive),
    astro: createMaterialSvgIcon('FileAstro', MATERIAL_ICON_NAME_BY_KIND.astro),
    audio: createMaterialSvgIcon('FileAudio', MATERIAL_ICON_NAME_BY_KIND.audio),
    binary: createMaterialSvgIcon('FileBinary', MATERIAL_ICON_NAME_BY_KIND.binary),
    bun: createMaterialSvgIcon('FileBun', MATERIAL_ICON_NAME_BY_KIND.bun),
    c: createMaterialSvgIcon('FileC', MATERIAL_ICON_NAME_BY_KIND.c),
    clojure: createMaterialSvgIcon('FileClojure', MATERIAL_ICON_NAME_BY_KIND.clojure),
    code: createMaterialSvgIcon('FileCode', MATERIAL_ICON_NAME_BY_KIND.code),
    config: createMaterialSvgIcon('FileConfig', MATERIAL_ICON_NAME_BY_KIND.config),
    cpp: createMaterialSvgIcon('FileCpp', MATERIAL_ICON_NAME_BY_KIND.cpp),
    csharp: createMaterialSvgIcon('FileCSharp', MATERIAL_ICON_NAME_BY_KIND.csharp),
    css: createMaterialSvgIcon('FileCss', MATERIAL_ICON_NAME_BY_KIND.css),
    csv: createMaterialSvgIcon('FileCsv', MATERIAL_ICON_NAME_BY_KIND.csv),
    dart: createMaterialSvgIcon('FileDart', MATERIAL_ICON_NAME_BY_KIND.dart),
    data: createMaterialSvgIcon('FileData', MATERIAL_ICON_NAME_BY_KIND.data),
    deno: createMaterialSvgIcon('FileDeno', MATERIAL_ICON_NAME_BY_KIND.deno),
    document: createMaterialSvgIcon('FileDocument', MATERIAL_ICON_NAME_BY_KIND.document),
    directory: createMaterialSvgIcon('FileDirectory', MATERIAL_ICON_NAME_BY_KIND.directory),
    docker: createMaterialSvgIcon('FileDocker', MATERIAL_ICON_NAME_BY_KIND.docker),
    dotenv: createMaterialSvgIcon('FileDotenv', MATERIAL_ICON_NAME_BY_KIND.dotenv),
    elixir: createMaterialSvgIcon('FileElixir', MATERIAL_ICON_NAME_BY_KIND.elixir),
    erlang: createMaterialSvgIcon('FileErlang', MATERIAL_ICON_NAME_BY_KIND.erlang),
    fish: createMaterialSvgIcon('FileFish', MATERIAL_ICON_NAME_BY_KIND.fish),
    go: createMaterialSvgIcon('FileGo', MATERIAL_ICON_NAME_BY_KIND.go),
    haskell: createMaterialSvgIcon('FileHaskell', MATERIAL_ICON_NAME_BY_KIND.haskell),
    html: createMaterialSvgIcon('FileHtml', MATERIAL_ICON_NAME_BY_KIND.html),
    image: createMaterialSvgIcon('FileImage', MATERIAL_ICON_NAME_BY_KIND.image),
    java: createMaterialSvgIcon('FileJava', MATERIAL_ICON_NAME_BY_KIND.java),
    javascript: createMaterialSvgIcon('FileJavaScript', MATERIAL_ICON_NAME_BY_KIND.javascript),
    jupyter: createMaterialSvgIcon('FileJupyter', MATERIAL_ICON_NAME_BY_KIND.jupyter),
    json: createMaterialSvgIcon('FileJson', MATERIAL_ICON_NAME_BY_KIND.json),
    julia: createMaterialSvgIcon('FileJulia', MATERIAL_ICON_NAME_BY_KIND.julia),
    kotlin: createMaterialSvgIcon('FileKotlin', MATERIAL_ICON_NAME_BY_KIND.kotlin),
    lock: createMaterialSvgIcon('FileLock', MATERIAL_ICON_NAME_BY_KIND.lock),
    lua: createMaterialSvgIcon('FileLua', MATERIAL_ICON_NAME_BY_KIND.lua),
    markdown: createMaterialSvgIcon('FileMarkdown', MATERIAL_ICON_NAME_BY_KIND.markdown),
    node: createMaterialSvgIcon('FileNode', MATERIAL_ICON_NAME_BY_KIND.node),
    pdf: createMaterialSvgIcon('FilePdf', MATERIAL_ICON_NAME_BY_KIND.pdf),
    perl: createMaterialSvgIcon('FilePerl', MATERIAL_ICON_NAME_BY_KIND.perl),
    php: createMaterialSvgIcon('FilePhp', MATERIAL_ICON_NAME_BY_KIND.php),
    presentation: createMaterialSvgIcon(
      'FilePresentation',
      MATERIAL_ICON_NAME_BY_KIND.presentation
    ),
    python: createMaterialSvgIcon('FilePython', MATERIAL_ICON_NAME_BY_KIND.python),
    r: createMaterialSvgIcon('FileR', MATERIAL_ICON_NAME_BY_KIND.r),
    react: createMaterialSvgIcon('FileReact', MATERIAL_ICON_NAME_BY_KIND.react),
    ruby: createMaterialSvgIcon('FileRuby', MATERIAL_ICON_NAME_BY_KIND.ruby),
    rust: createMaterialSvgIcon('FileRust', MATERIAL_ICON_NAME_BY_KIND.rust),
    sass: createMaterialSvgIcon('FileSass', MATERIAL_ICON_NAME_BY_KIND.sass),
    scala: createMaterialSvgIcon('FileScala', MATERIAL_ICON_NAME_BY_KIND.scala),
    shell: createMaterialSvgIcon('FileShell', MATERIAL_ICON_NAME_BY_KIND.shell),
    solidity: createMaterialSvgIcon('FileSolidity', MATERIAL_ICON_NAME_BY_KIND.solidity),
    spreadsheet: createMaterialSvgIcon('FileSpreadsheet', MATERIAL_ICON_NAME_BY_KIND.spreadsheet),
    svelte: createMaterialSvgIcon('FileSvelte', MATERIAL_ICON_NAME_BY_KIND.svelte),
    swift: createMaterialSvgIcon('FileSwift', MATERIAL_ICON_NAME_BY_KIND.swift),
    text: createMaterialSvgIcon('FileText', MATERIAL_ICON_NAME_BY_KIND.text),
    toml: createMaterialSvgIcon('FileToml', MATERIAL_ICON_NAME_BY_KIND.toml),
    typescript: createMaterialSvgIcon('FileTypeScript', MATERIAL_ICON_NAME_BY_KIND.typescript),
    type: createMaterialSvgIcon('FileType', MATERIAL_ICON_NAME_BY_KIND.type),
    video: createMaterialSvgIcon('FileVideo', MATERIAL_ICON_NAME_BY_KIND.video),
    vue: createMaterialSvgIcon('FileVue', MATERIAL_ICON_NAME_BY_KIND.vue),
    yaml: createMaterialSvgIcon('FileYaml', MATERIAL_ICON_NAME_BY_KIND.yaml),
    zig: createMaterialSvgIcon('FileZig', MATERIAL_ICON_NAME_BY_KIND.zig)
  },
  state: {
    ask: createPhiIcon('Ask', FiLock),
    auto: createPhiIcon('Auto', TbGauge, { scale: 1.16 }),
    check: createPhiIcon('Check', FiCheck),
    denied: createPhiIcon('Denied', FiXCircle),
    done: createPhiIcon('Done', FiCheckCircle),
    full: createPhiIcon('FullAccess', FiUnlock),
    thinking: createPhiIcon('Thinking', TbBrain)
  },
  tool: {
    command: createPhiIcon('ToolCommand', FiTerminal),
    edit: createPhiIcon('ToolEdit', FiEdit3),
    generic: createPhiIcon('ToolGeneric', FiTool),
    read: createPhiIcon('ToolRead', FiFileText),
    search: createPhiIcon('ToolSearch', FiSearch),
    web: createPhiIcon('ToolWeb', FiGlobe)
  }
} as const satisfies Record<string, Record<string, PhiIconComponent>>

export type PhiIconMeta = {
  label: string
  Icon: PhiIconComponent
  color?: string
  materialIconName?: string
}

export const PHI_ICON_META = {
  'action.add': { label: '新增', Icon: PhiIcons.action.add },
  'action.addSession': { label: '新建会话', Icon: PhiIcons.action.addSession },
  'action.approve': { label: '批准', Icon: PhiIcons.action.approve, color: 'success.main' },
  'action.back': { label: '返回', Icon: PhiIcons.action.back },
  'action.cancel': { label: '取消', Icon: PhiIcons.action.cancel, color: 'error.main' },
  'action.close': { label: '关闭', Icon: PhiIcons.action.close },
  'action.copy': { label: '复制', Icon: PhiIcons.action.copy },
  'action.delete': { label: '删除', Icon: PhiIcons.action.delete, color: 'error.main' },
  'action.download': { label: '下载', Icon: PhiIcons.action.download },
  'action.edit': { label: '编辑', Icon: PhiIcons.action.edit },
  'action.expand': { label: '展开', Icon: PhiIcons.action.expand },
  'action.collapse': { label: '收起', Icon: PhiIcons.action.collapse },
  'action.login': { label: '登录', Icon: PhiIcons.action.login },
  'action.logout': { label: '退出登录', Icon: PhiIcons.action.logout },
  'action.more': { label: '更多', Icon: PhiIcons.action.more },
  'action.openDefault': { label: '默认应用打开', Icon: PhiIcons.action.openDefault },
  'action.openExternal': { label: '打开外部链接', Icon: PhiIcons.action.openExternal },
  'action.quick': { label: '快速', Icon: PhiIcons.action.quick },
  'action.refresh': { label: '刷新', Icon: PhiIcons.action.refresh },
  'action.saveKey': { label: '保存 API Key', Icon: PhiIcons.action.saveKey },
  'action.search': { label: '搜索', Icon: PhiIcons.action.search },
  'action.send': { label: '发送', Icon: PhiIcons.action.send },
  'action.stop': { label: '停止', Icon: PhiIcons.action.stop, color: 'error.main' },
  'entity.apiKey': { label: 'API Key', Icon: PhiIcons.entity.apiKey },
  'entity.directoryTree': { label: '目录树', Icon: PhiIcons.entity.directoryTree },
  'entity.folder': { label: '文件夹', Icon: PhiIcons.entity.folder },
  'entity.mcp': { label: 'MCP', Icon: PhiIcons.entity.mcp },
  'entity.plugin': { label: '插件', Icon: PhiIcons.entity.plugin },
  'entity.project': { label: '项目', Icon: PhiIcons.entity.project },
  'entity.provider': { label: 'Provider', Icon: PhiIcons.entity.provider },
  'entity.skill': { label: '技能', Icon: PhiIcons.entity.skill },
  'nav.analysis': { label: '分析', Icon: PhiIcons.nav.analysis },
  'nav.chat': { label: '对话', Icon: PhiIcons.nav.chat },
  'nav.mcp': { label: 'MCP', Icon: PhiIcons.nav.mcp },
  'nav.plugins': { label: '插件', Icon: PhiIcons.nav.plugins },
  'nav.projects': { label: '项目', Icon: PhiIcons.nav.projects },
  'nav.runtime': { label: '运行时', Icon: PhiIcons.nav.runtime },
  'nav.settings': { label: '设置', Icon: PhiIcons.nav.settings },
  'nav.skills': { label: '技能', Icon: PhiIcons.nav.skills },
  'nav.visualization': { label: '可视化', Icon: PhiIcons.nav.visualization },
  'settings.appearance': { label: '外观', Icon: PhiIcons.settings.appearance },
  'settings.diagnostics': { label: '诊断', Icon: PhiIcons.settings.diagnostics },
  'settings.permissions': { label: '权限', Icon: PhiIcons.settings.permissions },
  'settings.persona': { label: '助手人设', Icon: PhiIcons.settings.persona },
  'settings.providers': { label: 'Provider 配置', Icon: PhiIcons.settings.providers },
  'file.archive': { label: '压缩包', Icon: PhiIcons.file.archive, color: 'text.secondary' },
  'file.audio': { label: '音频文件', Icon: PhiIcons.file.audio, color: 'secondary.main' },
  'file.binary': { label: '二进制文件', Icon: PhiIcons.file.binary, color: 'text.secondary' },
  'file.astro': { label: 'Astro 文件', Icon: PhiIcons.file.astro, color: '#BC52EE' },
  'file.bun': { label: 'Bun 文件', Icon: PhiIcons.file.bun, color: '#8A5A44' },
  'file.c': { label: 'C 文件', Icon: PhiIcons.file.c, color: '#5E6AD2' },
  'file.clojure': { label: 'Clojure 文件', Icon: PhiIcons.file.clojure, color: '#5881D8' },
  'file.cpp': { label: 'C++ 文件', Icon: PhiIcons.file.cpp, color: '#00599C' },
  'file.csharp': { label: 'C# 文件', Icon: PhiIcons.file.csharp, color: '#512BD4' },
  'file.code': { label: '代码文件', Icon: PhiIcons.file.code, color: '#64748B' },
  'file.config': { label: '配置文件', Icon: PhiIcons.file.config, color: '#64748B' },
  'file.css': { label: 'CSS 文件', Icon: PhiIcons.file.css, color: '#2965F1' },
  'file.csv': { label: 'CSV 文件', Icon: PhiIcons.file.csv, color: FILE_ICON_GREEN },
  'file.dart': { label: 'Dart 文件', Icon: PhiIcons.file.dart, color: '#0175C2' },
  'file.data': { label: '数据文件', Icon: PhiIcons.file.data, color: 'info.main' },
  'file.deno': { label: 'Deno 文件', Icon: PhiIcons.file.deno, color: 'text.primary' },
  'file.document': { label: '文档文件', Icon: PhiIcons.file.document, color: '#01579B' },
  'file.directory': { label: '文件夹', Icon: PhiIcons.file.directory, color: 'info.main' },
  'file.docker': { label: 'Docker 文件', Icon: PhiIcons.file.docker, color: '#2496ED' },
  'file.dotenv': { label: 'Dotenv 文件', Icon: PhiIcons.file.dotenv, color: '#ECD53F' },
  'file.elixir': { label: 'Elixir 文件', Icon: PhiIcons.file.elixir, color: '#4B275F' },
  'file.erlang': { label: 'Erlang 文件', Icon: PhiIcons.file.erlang, color: '#A90533' },
  'file.fish': { label: 'Fish 文件', Icon: PhiIcons.file.fish, color: '#34C534' },
  'file.go': { label: 'Go 文件', Icon: PhiIcons.file.go, color: '#00ADD8' },
  'file.haskell': { label: 'Haskell 文件', Icon: PhiIcons.file.haskell, color: '#5D4F85' },
  'file.html': { label: 'HTML 文件', Icon: PhiIcons.file.html, color: '#E34F26' },
  'file.image': { label: '图片文件', Icon: PhiIcons.file.image, color: '#22A06B' },
  'file.java': { label: 'Java 文件', Icon: PhiIcons.file.java, color: '#B07219' },
  'file.javascript': { label: 'JavaScript 文件', Icon: PhiIcons.file.javascript, color: '#B7791F' },
  'file.jupyter': { label: 'Jupyter Notebook', Icon: PhiIcons.file.jupyter, color: '#F37626' },
  'file.json': { label: 'JSON 文件', Icon: PhiIcons.file.json, color: FILE_ICON_JSON },
  'file.julia': { label: 'Julia 文件', Icon: PhiIcons.file.julia, color: '#9558B2' },
  'file.kotlin': { label: 'Kotlin 文件', Icon: PhiIcons.file.kotlin, color: '#7F52FF' },
  'file.lock': { label: '锁定文件', Icon: PhiIcons.file.lock, color: '#EF4444' },
  'file.lua': { label: 'Lua 文件', Icon: PhiIcons.file.lua, color: '#000080' },
  'file.markdown': {
    label: 'Markdown 文件',
    Icon: PhiIcons.file.markdown,
    color: FILE_ICON_MARKDOWN
  },
  'file.node': { label: 'Node.js 文件', Icon: PhiIcons.file.node, color: '#5FA04E' },
  'file.pdf': { label: 'PDF 文件', Icon: PhiIcons.file.pdf, color: 'error.main' },
  'file.perl': { label: 'Perl 文件', Icon: PhiIcons.file.perl, color: '#39457E' },
  'file.php': { label: 'PHP 文件', Icon: PhiIcons.file.php, color: '#777BB4' },
  'file.presentation': {
    label: '演示文稿',
    Icon: PhiIcons.file.presentation,
    color: '#E64A19'
  },
  'file.python': { label: 'Python 文件', Icon: PhiIcons.file.python, color: PYTHON_BLUE },
  'file.r': { label: 'R 文件', Icon: PhiIcons.file.r, color: '#276DC3' },
  'file.react': { label: 'React 文件', Icon: PhiIcons.file.react, color: '#087EA4' },
  'file.ruby': { label: 'Ruby 文件', Icon: PhiIcons.file.ruby, color: '#CC342D' },
  'file.rust': { label: 'Rust 文件', Icon: PhiIcons.file.rust, color: '#B7410E' },
  'file.sass': { label: 'Sass 文件', Icon: PhiIcons.file.sass, color: '#CC6699' },
  'file.scala': { label: 'Scala 文件', Icon: PhiIcons.file.scala, color: '#DC322F' },
  'file.shell': { label: '脚本文件', Icon: PhiIcons.file.shell, color: '#22A06B' },
  'file.solidity': { label: 'Solidity 文件', Icon: PhiIcons.file.solidity, color: '#363636' },
  'file.spreadsheet': {
    label: '表格文件',
    Icon: PhiIcons.file.spreadsheet,
    color: FILE_ICON_GREEN
  },
  'file.svelte': { label: 'Svelte 文件', Icon: PhiIcons.file.svelte, color: '#FF3E00' },
  'file.swift': { label: 'Swift 文件', Icon: PhiIcons.file.swift, color: '#F05138' },
  'file.text': { label: '文本文件', Icon: PhiIcons.file.text, color: '#6B7280' },
  'file.toml': { label: 'TOML 文件', Icon: PhiIcons.file.toml, color: '#9C4221' },
  'file.typescript': { label: 'TypeScript 文件', Icon: PhiIcons.file.typescript, color: '#3178C6' },
  'file.type': { label: '字体文件', Icon: PhiIcons.file.type, color: '#7C3AED' },
  'file.video': { label: '视频文件', Icon: PhiIcons.file.video, color: '#7C3AED' },
  'file.vue': { label: 'Vue 文件', Icon: PhiIcons.file.vue, color: '#42B883' },
  'file.yaml': { label: 'YAML 文件', Icon: PhiIcons.file.yaml, color: '#CB171E' },
  'file.zig': { label: 'Zig 文件', Icon: PhiIcons.file.zig, color: '#F7A41D' },
  'state.ask': { label: '询问', Icon: PhiIcons.state.ask, color: 'success.main' },
  'state.auto': { label: '自动', Icon: PhiIcons.state.auto, color: 'warning.main' },
  'state.check': { label: '已选中', Icon: PhiIcons.state.check },
  'state.denied': { label: '拒绝', Icon: PhiIcons.state.denied, color: 'error.main' },
  'state.done': { label: '完成', Icon: PhiIcons.state.done, color: 'success.main' },
  'state.full': { label: '完全访问', Icon: PhiIcons.state.full, color: 'error.main' },
  'state.thinking': { label: '思考', Icon: PhiIcons.state.thinking },
  'tool.command': { label: '运行命令', Icon: PhiIcons.tool.command, color: 'text.secondary' },
  'tool.python': { label: '执行 Python 代码', Icon: PhiIcons.file.python, color: '#3572A5' },
  'tool.read': { label: '读取文件', Icon: PhiIcons.tool.read, color: 'info.main' },
  'tool.edit': { label: '编辑文件', Icon: PhiIcons.tool.edit, color: 'warning.main' },
  'tool.search': { label: '搜索', Icon: PhiIcons.tool.search, color: 'secondary.main' },
  'tool.web': { label: '访问网页', Icon: PhiIcons.tool.web, color: 'primary.main' },
  'tool.generic': { label: '工具调用', Icon: PhiIcons.tool.generic, color: 'text.secondary' }
} as const satisfies Record<string, PhiIconMeta>

export type PhiIconName = keyof typeof PHI_ICON_META

export type FileIconKind =
  | 'archive'
  | 'astro'
  | 'audio'
  | 'binary'
  | 'bun'
  | 'c'
  | 'clojure'
  | 'code'
  | 'config'
  | 'cpp'
  | 'csharp'
  | 'css'
  | 'csv'
  | 'dart'
  | 'data'
  | 'deno'
  | 'document'
  | 'directory'
  | 'docker'
  | 'dotenv'
  | 'elixir'
  | 'erlang'
  | 'fish'
  | 'go'
  | 'haskell'
  | 'html'
  | 'image'
  | 'java'
  | 'javascript'
  | 'jupyter'
  | 'json'
  | 'julia'
  | 'kotlin'
  | 'lock'
  | 'lua'
  | 'markdown'
  | 'node'
  | 'pdf'
  | 'perl'
  | 'php'
  | 'presentation'
  | 'python'
  | 'r'
  | 'react'
  | 'ruby'
  | 'rust'
  | 'sass'
  | 'scala'
  | 'shell'
  | 'solidity'
  | 'spreadsheet'
  | 'svelte'
  | 'swift'
  | 'text'
  | 'toml'
  | 'typescript'
  | 'type'
  | 'video'
  | 'vue'
  | 'yaml'
  | 'zig'

export type FileIconMeta = PhiIconMeta & {
  kind: FileIconKind
}

export const FILE_TYPE_ICON_META = {
  archive: { ...PHI_ICON_META['file.archive'], kind: 'archive' },
  astro: { ...PHI_ICON_META['file.astro'], kind: 'astro' },
  audio: { ...PHI_ICON_META['file.audio'], kind: 'audio' },
  binary: { ...PHI_ICON_META['file.binary'], kind: 'binary' },
  bun: { ...PHI_ICON_META['file.bun'], kind: 'bun' },
  c: { ...PHI_ICON_META['file.c'], kind: 'c' },
  clojure: { ...PHI_ICON_META['file.clojure'], kind: 'clojure' },
  code: { ...PHI_ICON_META['file.code'], kind: 'code' },
  config: { ...PHI_ICON_META['file.config'], kind: 'config' },
  cpp: { ...PHI_ICON_META['file.cpp'], kind: 'cpp' },
  csharp: { ...PHI_ICON_META['file.csharp'], kind: 'csharp' },
  css: { ...PHI_ICON_META['file.css'], kind: 'css' },
  csv: { ...PHI_ICON_META['file.csv'], kind: 'csv' },
  dart: { ...PHI_ICON_META['file.dart'], kind: 'dart' },
  data: { ...PHI_ICON_META['file.data'], kind: 'data' },
  deno: { ...PHI_ICON_META['file.deno'], kind: 'deno' },
  document: { ...PHI_ICON_META['file.document'], kind: 'document' },
  directory: { ...PHI_ICON_META['file.directory'], kind: 'directory' },
  docker: { ...PHI_ICON_META['file.docker'], kind: 'docker' },
  dotenv: { ...PHI_ICON_META['file.dotenv'], kind: 'dotenv' },
  elixir: { ...PHI_ICON_META['file.elixir'], kind: 'elixir' },
  erlang: { ...PHI_ICON_META['file.erlang'], kind: 'erlang' },
  fish: { ...PHI_ICON_META['file.fish'], kind: 'fish' },
  go: { ...PHI_ICON_META['file.go'], kind: 'go' },
  haskell: { ...PHI_ICON_META['file.haskell'], kind: 'haskell' },
  html: { ...PHI_ICON_META['file.html'], kind: 'html' },
  image: { ...PHI_ICON_META['file.image'], kind: 'image' },
  java: { ...PHI_ICON_META['file.java'], kind: 'java' },
  javascript: { ...PHI_ICON_META['file.javascript'], kind: 'javascript' },
  jupyter: { ...PHI_ICON_META['file.jupyter'], kind: 'jupyter' },
  json: { ...PHI_ICON_META['file.json'], kind: 'json' },
  julia: { ...PHI_ICON_META['file.julia'], kind: 'julia' },
  kotlin: { ...PHI_ICON_META['file.kotlin'], kind: 'kotlin' },
  lock: { ...PHI_ICON_META['file.lock'], kind: 'lock' },
  lua: { ...PHI_ICON_META['file.lua'], kind: 'lua' },
  markdown: { ...PHI_ICON_META['file.markdown'], kind: 'markdown' },
  node: { ...PHI_ICON_META['file.node'], kind: 'node' },
  pdf: { ...PHI_ICON_META['file.pdf'], kind: 'pdf' },
  perl: { ...PHI_ICON_META['file.perl'], kind: 'perl' },
  php: { ...PHI_ICON_META['file.php'], kind: 'php' },
  presentation: { ...PHI_ICON_META['file.presentation'], kind: 'presentation' },
  python: { ...PHI_ICON_META['file.python'], kind: 'python' },
  r: { ...PHI_ICON_META['file.r'], kind: 'r' },
  react: { ...PHI_ICON_META['file.react'], kind: 'react' },
  ruby: { ...PHI_ICON_META['file.ruby'], kind: 'ruby' },
  rust: { ...PHI_ICON_META['file.rust'], kind: 'rust' },
  sass: { ...PHI_ICON_META['file.sass'], kind: 'sass' },
  scala: { ...PHI_ICON_META['file.scala'], kind: 'scala' },
  shell: { ...PHI_ICON_META['file.shell'], kind: 'shell' },
  solidity: { ...PHI_ICON_META['file.solidity'], kind: 'solidity' },
  spreadsheet: { ...PHI_ICON_META['file.spreadsheet'], kind: 'spreadsheet' },
  svelte: { ...PHI_ICON_META['file.svelte'], kind: 'svelte' },
  swift: { ...PHI_ICON_META['file.swift'], kind: 'swift' },
  text: { ...PHI_ICON_META['file.text'], kind: 'text' },
  toml: { ...PHI_ICON_META['file.toml'], kind: 'toml' },
  typescript: { ...PHI_ICON_META['file.typescript'], kind: 'typescript' },
  type: { ...PHI_ICON_META['file.type'], kind: 'type' },
  video: { ...PHI_ICON_META['file.video'], kind: 'video' },
  vue: { ...PHI_ICON_META['file.vue'], kind: 'vue' },
  yaml: { ...PHI_ICON_META['file.yaml'], kind: 'yaml' },
  zig: { ...PHI_ICON_META['file.zig'], kind: 'zig' }
} satisfies Record<FileIconKind, FileIconMeta>

export const PERMISSION_MODE_ICON_META = {
  ask: PHI_ICON_META['state.ask'],
  auto: PHI_ICON_META['state.auto'],
  full: PHI_ICON_META['state.full']
} satisfies Record<PermissionMode, PhiIconMeta>

const LOCK_FILE_NAMES = new Set([
  'bun.lock',
  'cargo.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'yarn.lock'
])

const CONFIG_FILE_NAMES = new Set([
  '.babelrc',
  '.dockerignore',
  '.editorconfig',
  '.eslintrc',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  '.python-version',
  'dockerfile',
  'makefile',
  'tsconfig.json'
])

const FILE_NAME_ICON: Record<string, FileIconKind> = {
  'bunfig.toml': 'bun',
  containerfile: 'docker',
  'deno.json': 'deno',
  'deno.jsonc': 'deno',
  dockerfile: 'docker'
}

const CONFIG_NAME_PATTERNS = [
  /^.+[.-]config\.(cjs|js|json|mjs|ts|tsx|yaml|yml)$/,
  /(^|[.-])rc\.(cjs|js|json|mjs|ts|yaml|yml)$/
]

const DOTENV_FILE_NAME_PATTERN = /^\.(?:env|venv)(?:\.|$)/

const EXTENSION_FILE_ICON: Record<string, FileIconKind> = {
  '7z': 'archive',
  aac: 'audio',
  ai: 'image',
  app: 'binary',
  arrow: 'data',
  astro: 'astro',
  avi: 'video',
  avif: 'image',
  bam: 'data',
  bash: 'shell',
  bed: 'data',
  bin: 'binary',
  bmp: 'image',
  bz2: 'archive',
  c: 'c',
  cjs: 'javascript',
  clj: 'clojure',
  cljc: 'clojure',
  cljs: 'clojure',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  csv: 'csv',
  dart: 'dart',
  db: 'data',
  dmg: 'binary',
  doc: 'document',
  docm: 'document',
  docx: 'document',
  dotx: 'document',
  dta: 'data',
  env: 'dotenv',
  eps: 'image',
  erl: 'erlang',
  epub: 'document',
  ex: 'elixir',
  exe: 'binary',
  exs: 'elixir',
  fa: 'data',
  fasta: 'data',
  fastq: 'data',
  feather: 'data',
  fig: 'image',
  fish: 'fish',
  flac: 'audio',
  fq: 'data',
  gff: 'data',
  gtf: 'data',
  gif: 'image',
  go: 'go',
  gz: 'archive',
  h: 'c',
  h5: 'data',
  h5ad: 'data',
  hdf5: 'data',
  hrl: 'erlang',
  heic: 'image',
  hs: 'haskell',
  hpp: 'cpp',
  html: 'html',
  ico: 'image',
  ini: 'config',
  ipynb: 'jupyter',
  java: 'java',
  jpeg: 'image',
  jpg: 'image',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsonl: 'json',
  jsx: 'react',
  jl: 'julia',
  key: 'lock',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'css',
  lock: 'lock',
  log: 'text',
  loom: 'data',
  lua: 'lua',
  md: 'markdown',
  mdx: 'react',
  mjs: 'javascript',
  mov: 'video',
  mp3: 'audio',
  mp4: 'video',
  mpeg: 'video',
  mpg: 'video',
  numbers: 'spreadsheet',
  ods: 'spreadsheet',
  ogg: 'audio',
  otf: 'type',
  pages: 'document',
  parquet: 'data',
  pdf: 'pdf',
  pem: 'lock',
  pl: 'perl',
  pm: 'perl',
  php: 'php',
  plist: 'config',
  png: 'image',
  ppt: 'presentation',
  pptm: 'presentation',
  pptx: 'presentation',
  potx: 'presentation',
  pps: 'presentation',
  ppsx: 'presentation',
  psd: 'image',
  py: 'python',
  r: 'r',
  rar: 'archive',
  rda: 'data',
  rds: 'data',
  rb: 'ruby',
  rs: 'rust',
  rst: 'text',
  sam: 'data',
  sass: 'sass',
  sas7bdat: 'data',
  sav: 'data',
  sbt: 'scala',
  scala: 'scala',
  scss: 'sass',
  sh: 'shell',
  sqlite: 'data',
  sqlite3: 'data',
  sql: 'data',
  sol: 'solidity',
  svg: 'image',
  svelte: 'svelte',
  swift: 'swift',
  tar: 'archive',
  tif: 'image',
  tiff: 'image',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'react',
  tsv: 'csv',
  ttf: 'type',
  txt: 'text',
  wav: 'audio',
  webm: 'video',
  webp: 'image',
  woff: 'type',
  woff2: 'type',
  xls: 'spreadsheet',
  xlsb: 'spreadsheet',
  xlsm: 'spreadsheet',
  xlsx: 'spreadsheet',
  xlt: 'spreadsheet',
  xltx: 'spreadsheet',
  vue: 'vue',
  vcf: 'data',
  xml: 'html',
  yaml: 'yaml',
  yml: 'yaml',
  zarr: 'data',
  zig: 'zig',
  zsh: 'shell',
  zip: 'archive'
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function extensionFromFileName(fileName: string): string {
  const normalized = fileName.toLowerCase()
  const match = /\.([a-z0-9]+)$/.exec(normalized)
  return match?.[1] ?? ''
}

function materialIconNameForFileName(fileName: string): string {
  const normalized = fileName.toLowerCase()
  const override = MATERIAL_FILE_NAME_ICON_OVERRIDES[normalized]
  if (override) return override

  const fileNameIcon = MATERIAL_FILE_NAME_ICONS[normalized]
  if (fileNameIcon) return fileNameIcon

  for (const extension of MATERIAL_FILE_EXTENSION_OVERRIDE_KEYS) {
    if (normalized === extension || normalized.endsWith(`.${extension}`)) {
      return MATERIAL_FILE_EXTENSION_ICON_OVERRIDES[extension]
    }
  }

  for (const extension of MATERIAL_FILE_EXTENSION_KEYS) {
    if (normalized === extension || normalized.endsWith(`.${extension}`)) {
      return MATERIAL_FILE_EXTENSION_ICONS[extension]
    }
  }

  return MATERIAL_ICON_MANIFEST.file ?? 'file'
}

function materialIconNameForDirectoryPath(path: string, expanded = false, root = false): string {
  const directoryName = fileNameFromPath(path).toLowerCase()
  const names = root
    ? expanded
      ? MATERIAL_ROOT_FOLDER_EXPANDED_NAME_ICONS
      : MATERIAL_ROOT_FOLDER_NAME_ICONS
    : expanded
      ? MATERIAL_FOLDER_EXPANDED_NAME_ICONS
      : MATERIAL_FOLDER_NAME_ICONS
  const namedIcon = names[directoryName]
  if (namedIcon) return namedIcon

  if (root) {
    return expanded
      ? (MATERIAL_ICON_MANIFEST.rootFolderExpanded ??
          MATERIAL_ICON_MANIFEST.folderExpanded ??
          'folder-open')
      : (MATERIAL_ICON_MANIFEST.rootFolder ?? MATERIAL_ICON_MANIFEST.folder ?? 'folder')
  }

  return expanded
    ? (MATERIAL_ICON_MANIFEST.folderExpanded ?? 'folder-open')
    : (MATERIAL_ICON_MANIFEST.folder ?? 'folder')
}

function materialFileIconMeta(kind: FileIconKind, iconName: string): FileIconMeta | null {
  const Icon = materialIconComponentForName(iconName)
  if (!Icon) return null
  return { ...FILE_TYPE_ICON_META[kind], Icon, materialIconName: iconName }
}

function fileIconKindForPath(path: string): FileIconKind {
  const fileName = fileNameFromPath(path).toLowerCase()
  if (LOCK_FILE_NAMES.has(fileName)) return 'lock'
  const fileNameKind = FILE_NAME_ICON[fileName]
  if (fileNameKind) return fileNameKind
  if (VIRTUAL_ENV_DIRECTORY_NAMES.has(fileName)) return 'directory'
  if (DOTENV_FILE_NAME_PATTERN.test(fileName)) return 'dotenv'
  if (CONFIG_FILE_NAMES.has(fileName)) return 'config'
  if (CONFIG_NAME_PATTERNS.some((pattern) => pattern.test(fileName))) {
    return 'config'
  }

  const extension = extensionFromFileName(fileName)
  const kind = extension ? EXTENSION_FILE_ICON[extension] : undefined
  return kind ?? 'text'
}

export function fileIconForPath(path: string): FileIconMeta {
  const kind = fileIconKindForPath(path)
  const fileName = fileNameFromPath(path)
  return (
    materialFileIconMeta(kind, materialIconNameForFileName(fileName)) ?? FILE_TYPE_ICON_META[kind]
  )
}

export function directoryIconForPath(path: string, expanded = false, root = false): FileIconMeta {
  return (
    materialFileIconMeta('directory', materialIconNameForDirectoryPath(path, expanded, root)) ??
    FILE_TYPE_ICON_META.directory
  )
}

type ToolIconKey =
  'command' | 'python' | 'read' | 'edit' | 'search' | 'web' | 'notebook' | 'generic'

export const TOOL_ACTION_ICON_META = {
  command: PHI_ICON_META['tool.command'],
  python: PHI_ICON_META['tool.python'],
  read: PHI_ICON_META['tool.read'],
  edit: PHI_ICON_META['tool.edit'],
  search: PHI_ICON_META['tool.search'],
  web: PHI_ICON_META['tool.web'],
  notebook: PHI_ICON_META['nav.analysis'],
  generic: PHI_ICON_META['tool.generic']
} satisfies Record<ToolIconKey, PhiIconMeta>

export function iconFor(name: PhiIconName): PhiIconComponent {
  return PHI_ICON_META[name].Icon
}
