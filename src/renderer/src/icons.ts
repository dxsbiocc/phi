import { Box } from '@mui/material'
import type { SxProps, Theme } from '@mui/material/styles'
import {
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  CircleX,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Gauge,
  Globe,
  GraduationCap,
  KeyRound,
  LockKeyhole,
  LockKeyholeOpen,
  LogIn,
  LogOut,
  MessageCircle,
  MessageSquarePlus,
  MoreHorizontal,
  Network,
  Palette,
  Pencil,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Send,
  Settings,
  Shield,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X,
  Zap,
  type LucideIcon,
  type LucideProps
} from 'lucide-react'
import {
  createElement,
  forwardRef,
  type CSSProperties,
  type ElementType,
  type ForwardRefExoticComponent,
  type RefAttributes
} from 'react'
import type { PermissionMode } from './types'

type PhiIconFontSize = 'inherit' | 'small' | 'medium' | 'large'

export type PhiIconProps = Omit<
  LucideProps,
  'absoluteStrokeWidth' | 'children' | 'color' | 'ref' | 'size' | 'style'
> & {
  color?: string
  fontSize?: PhiIconFontSize
  htmlColor?: string
  size?: number | string
  style?: CSSProperties
  sx?: SxProps<Theme>
}

export type PhiIconComponent = ForwardRefExoticComponent<
  PhiIconProps & RefAttributes<HTMLSpanElement>
>

const PHI_STROKE_WIDTH = 1.85

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

function createPhiIcon(name: string, Icon: LucideIcon): PhiIconComponent {
  const PhiIcon = forwardRef<HTMLSpanElement, PhiIconProps>(
    ({ className, color, fontSize, htmlColor, size, strokeWidth, style, sx, ...rest }, ref) =>
      createElement(
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
        createElement(Icon, {
          'aria-hidden': rest['aria-label'] ? undefined : true,
          color: 'currentColor',
          fill: 'none',
          focusable: 'false',
          size: '1em',
          strokeWidth: strokeWidth ?? PHI_STROKE_WIDTH
        })
      )
  )

  PhiIcon.displayName = `Phi${name}Icon`
  return PhiIcon
}

export const PhiIcons = {
  action: {
    add: createPhiIcon('Add', Plus),
    addSession: createPhiIcon('AddSession', MessageSquarePlus),
    approve: createPhiIcon('Approve', CircleCheck),
    back: createPhiIcon('Back', ChevronRight),
    cancel: createPhiIcon('Cancel', CircleX),
    close: createPhiIcon('Close', X),
    collapse: createPhiIcon('Collapse', ChevronUp),
    copy: createPhiIcon('Copy', Copy),
    delete: createPhiIcon('Delete', Trash2),
    download: createPhiIcon('Download', Download),
    edit: createPhiIcon('Edit', Pencil),
    expand: createPhiIcon('Expand', ChevronDown),
    login: createPhiIcon('Login', LogIn),
    logout: createPhiIcon('Logout', LogOut),
    more: createPhiIcon('More', MoreHorizontal),
    openDefault: createPhiIcon('OpenDefault', ExternalLink),
    openExternal: createPhiIcon('OpenExternal', ExternalLink),
    quick: createPhiIcon('Quick', Zap),
    refresh: createPhiIcon('Refresh', RefreshCw),
    saveKey: createPhiIcon('SaveKey', KeyRound),
    search: createPhiIcon('Search', Search),
    send: createPhiIcon('Send', Send),
    stop: createPhiIcon('Stop', Square)
  },
  entity: {
    apiKey: createPhiIcon('ApiKey', KeyRound),
    agent: createPhiIcon('Agent', BrainCircuit),
    directoryTree: createPhiIcon('DirectoryTree', FolderOpen),
    folder: createPhiIcon('Folder', Folder),
    mcp: createPhiIcon('Mcp', Network),
    plugin: createPhiIcon('Plugin', Puzzle),
    project: createPhiIcon('Project', FolderOpen),
    provider: createPhiIcon('Provider', Network),
    skill: createPhiIcon('Skill', GraduationCap)
  },
  nav: {
    analysis: createPhiIcon('NavAnalysis', FileText),
    chat: createPhiIcon('NavChat', MessageCircle),
    mcp: createPhiIcon('NavMcp', Network),
    plugins: createPhiIcon('NavPlugins', Puzzle),
    projects: createPhiIcon('NavProjects', Folder),
    settings: createPhiIcon('NavSettings', Settings),
    skills: createPhiIcon('NavSkills', GraduationCap)
  },
  settings: {
    appearance: createPhiIcon('Appearance', Palette),
    diagnostics: createPhiIcon('Diagnostics', Copy),
    permissions: createPhiIcon('Permissions', Shield),
    persona: createPhiIcon('Persona', BrainCircuit),
    providers: createPhiIcon('Providers', Network)
  },
  file: {
    archive: createPhiIcon('FileArchive', FileText),
    astro: createPhiIcon('FileAstro', FileText),
    audio: createPhiIcon('FileAudio', FileText),
    binary: createPhiIcon('FileBinary', FileText),
    bun: createPhiIcon('FileBun', FileText),
    c: createPhiIcon('FileC', Terminal),
    clojure: createPhiIcon('FileClojure', Terminal),
    code: createPhiIcon('FileCode', Terminal),
    config: createPhiIcon('FileConfig', Wrench),
    cpp: createPhiIcon('FileCpp', Terminal),
    csharp: createPhiIcon('FileCSharp', Terminal),
    css: createPhiIcon('FileCss', FileText),
    dart: createPhiIcon('FileDart', Terminal),
    data: createPhiIcon('FileData', FileText),
    deno: createPhiIcon('FileDeno', Terminal),
    directory: createPhiIcon('FileDirectory', Folder),
    docker: createPhiIcon('FileDocker', Wrench),
    dotenv: createPhiIcon('FileDotenv', KeyRound),
    elixir: createPhiIcon('FileElixir', Terminal),
    erlang: createPhiIcon('FileErlang', Terminal),
    fish: createPhiIcon('FileFish', Terminal),
    go: createPhiIcon('FileGo', Terminal),
    haskell: createPhiIcon('FileHaskell', Terminal),
    html: createPhiIcon('FileHtml', FileText),
    image: createPhiIcon('FileImage', FileText),
    java: createPhiIcon('FileJava', Terminal),
    javascript: createPhiIcon('FileJavaScript', Terminal),
    jupyter: createPhiIcon('FileJupyter', FileText),
    json: createPhiIcon('FileJson', FileText),
    julia: createPhiIcon('FileJulia', Terminal),
    kotlin: createPhiIcon('FileKotlin', Terminal),
    lock: createPhiIcon('FileLock', LockKeyhole),
    lua: createPhiIcon('FileLua', Terminal),
    markdown: createPhiIcon('FileMarkdown', FileText),
    node: createPhiIcon('FileNode', Terminal),
    pdf: createPhiIcon('FilePdf', FileText),
    perl: createPhiIcon('FilePerl', Terminal),
    php: createPhiIcon('FilePhp', Terminal),
    python: createPhiIcon('FilePython', Terminal),
    r: createPhiIcon('FileR', Terminal),
    react: createPhiIcon('FileReact', Terminal),
    ruby: createPhiIcon('FileRuby', Terminal),
    rust: createPhiIcon('FileRust', Terminal),
    sass: createPhiIcon('FileSass', FileText),
    scala: createPhiIcon('FileScala', Terminal),
    shell: createPhiIcon('FileShell', Terminal),
    solidity: createPhiIcon('FileSolidity', Terminal),
    spreadsheet: createPhiIcon('FileSpreadsheet', FileText),
    svelte: createPhiIcon('FileSvelte', Terminal),
    swift: createPhiIcon('FileSwift', Terminal),
    text: createPhiIcon('FileText', FileText),
    toml: createPhiIcon('FileToml', FileText),
    typescript: createPhiIcon('FileTypeScript', Terminal),
    type: createPhiIcon('FileType', FileText),
    video: createPhiIcon('FileVideo', FileText),
    vue: createPhiIcon('FileVue', Terminal),
    yaml: createPhiIcon('FileYaml', FileText),
    zig: createPhiIcon('FileZig', Terminal)
  },
  state: {
    ask: createPhiIcon('Ask', LockKeyhole),
    auto: createPhiIcon('Auto', Gauge),
    check: createPhiIcon('Check', Check),
    denied: createPhiIcon('Denied', CircleX),
    done: createPhiIcon('Done', CircleCheck),
    full: createPhiIcon('FullAccess', LockKeyholeOpen),
    thinking: createPhiIcon('Thinking', BrainCircuit)
  },
  tool: {
    command: createPhiIcon('ToolCommand', Terminal),
    edit: createPhiIcon('ToolEdit', Pencil),
    generic: createPhiIcon('ToolGeneric', Wrench),
    read: createPhiIcon('ToolRead', FileText),
    search: createPhiIcon('ToolSearch', Search),
    web: createPhiIcon('ToolWeb', Globe)
  }
} as const satisfies Record<string, Record<string, PhiIconComponent>>

export type PhiIconMeta = {
  label: string
  Icon: PhiIconComponent
  color?: string
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
  'nav.settings': { label: '设置', Icon: PhiIcons.nav.settings },
  'nav.skills': { label: '技能', Icon: PhiIcons.nav.skills },
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
  'file.code': { label: '代码文件', Icon: PhiIcons.file.code, color: 'primary.main' },
  'file.config': { label: '配置文件', Icon: PhiIcons.file.config, color: 'warning.main' },
  'file.css': { label: 'CSS 文件', Icon: PhiIcons.file.css, color: '#2965F1' },
  'file.dart': { label: 'Dart 文件', Icon: PhiIcons.file.dart, color: '#0175C2' },
  'file.data': { label: '数据文件', Icon: PhiIcons.file.data, color: 'info.main' },
  'file.deno': { label: 'Deno 文件', Icon: PhiIcons.file.deno, color: 'text.primary' },
  'file.directory': { label: '文件夹', Icon: PhiIcons.file.directory, color: 'info.main' },
  'file.docker': { label: 'Docker 文件', Icon: PhiIcons.file.docker, color: '#2496ED' },
  'file.dotenv': { label: 'Dotenv 文件', Icon: PhiIcons.file.dotenv, color: '#ECD53F' },
  'file.elixir': { label: 'Elixir 文件', Icon: PhiIcons.file.elixir, color: '#4B275F' },
  'file.erlang': { label: 'Erlang 文件', Icon: PhiIcons.file.erlang, color: '#A90533' },
  'file.fish': { label: 'Fish 文件', Icon: PhiIcons.file.fish, color: '#34C534' },
  'file.go': { label: 'Go 文件', Icon: PhiIcons.file.go, color: '#00ADD8' },
  'file.haskell': { label: 'Haskell 文件', Icon: PhiIcons.file.haskell, color: '#5D4F85' },
  'file.html': { label: 'HTML 文件', Icon: PhiIcons.file.html, color: '#E34F26' },
  'file.image': { label: '图片文件', Icon: PhiIcons.file.image, color: 'success.main' },
  'file.java': { label: 'Java 文件', Icon: PhiIcons.file.java, color: '#B07219' },
  'file.javascript': { label: 'JavaScript 文件', Icon: PhiIcons.file.javascript, color: '#B7791F' },
  'file.jupyter': { label: 'Jupyter Notebook', Icon: PhiIcons.file.jupyter, color: '#F37626' },
  'file.json': { label: 'JSON 文件', Icon: PhiIcons.file.json, color: 'warning.main' },
  'file.julia': { label: 'Julia 文件', Icon: PhiIcons.file.julia, color: '#9558B2' },
  'file.kotlin': { label: 'Kotlin 文件', Icon: PhiIcons.file.kotlin, color: '#7F52FF' },
  'file.lock': { label: '锁定文件', Icon: PhiIcons.file.lock, color: 'error.main' },
  'file.lua': { label: 'Lua 文件', Icon: PhiIcons.file.lua, color: '#000080' },
  'file.markdown': {
    label: 'Markdown 文件',
    Icon: PhiIcons.file.markdown,
    color: 'text.secondary'
  },
  'file.node': { label: 'Node.js 文件', Icon: PhiIcons.file.node, color: '#5FA04E' },
  'file.pdf': { label: 'PDF 文件', Icon: PhiIcons.file.pdf, color: 'error.main' },
  'file.perl': { label: 'Perl 文件', Icon: PhiIcons.file.perl, color: '#39457E' },
  'file.php': { label: 'PHP 文件', Icon: PhiIcons.file.php, color: '#777BB4' },
  'file.python': { label: 'Python 文件', Icon: PhiIcons.file.python, color: '#3572A5' },
  'file.r': { label: 'R 文件', Icon: PhiIcons.file.r, color: '#276DC3' },
  'file.react': { label: 'React 文件', Icon: PhiIcons.file.react, color: '#087EA4' },
  'file.ruby': { label: 'Ruby 文件', Icon: PhiIcons.file.ruby, color: '#CC342D' },
  'file.rust': { label: 'Rust 文件', Icon: PhiIcons.file.rust, color: '#B7410E' },
  'file.sass': { label: 'Sass 文件', Icon: PhiIcons.file.sass, color: '#CC6699' },
  'file.scala': { label: 'Scala 文件', Icon: PhiIcons.file.scala, color: '#DC322F' },
  'file.shell': { label: '脚本文件', Icon: PhiIcons.file.shell, color: 'success.main' },
  'file.solidity': { label: 'Solidity 文件', Icon: PhiIcons.file.solidity, color: '#363636' },
  'file.spreadsheet': { label: '表格文件', Icon: PhiIcons.file.spreadsheet, color: 'success.main' },
  'file.svelte': { label: 'Svelte 文件', Icon: PhiIcons.file.svelte, color: '#FF3E00' },
  'file.swift': { label: 'Swift 文件', Icon: PhiIcons.file.swift, color: '#F05138' },
  'file.text': { label: '文本文件', Icon: PhiIcons.file.text, color: 'text.secondary' },
  'file.toml': { label: 'TOML 文件', Icon: PhiIcons.file.toml, color: '#9C4221' },
  'file.typescript': { label: 'TypeScript 文件', Icon: PhiIcons.file.typescript, color: '#3178C6' },
  'file.type': { label: '字体文件', Icon: PhiIcons.file.type, color: 'secondary.main' },
  'file.video': { label: '视频文件', Icon: PhiIcons.file.video, color: 'secondary.main' },
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
  | 'dart'
  | 'data'
  | 'deno'
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
  dart: { ...PHI_ICON_META['file.dart'], kind: 'dart' },
  data: { ...PHI_ICON_META['file.data'], kind: 'data' },
  deno: { ...PHI_ICON_META['file.deno'], kind: 'deno' },
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

const DOTENV_FILE_NAME_PATTERN = /^\.env(?:\.|$)/

const EXTENSION_FILE_ICON: Record<string, FileIconKind> = {
  '7z': 'archive',
  aac: 'audio',
  ai: 'image',
  app: 'binary',
  astro: 'astro',
  avi: 'video',
  avif: 'image',
  bash: 'shell',
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
  csv: 'spreadsheet',
  dart: 'dart',
  dmg: 'binary',
  doc: 'text',
  docx: 'text',
  env: 'dotenv',
  erl: 'erlang',
  epub: 'text',
  ex: 'elixir',
  exe: 'binary',
  exs: 'elixir',
  fig: 'image',
  fish: 'fish',
  flac: 'audio',
  gif: 'image',
  go: 'go',
  gz: 'archive',
  h: 'c',
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
  lua: 'lua',
  md: 'markdown',
  mdx: 'react',
  mjs: 'javascript',
  mov: 'video',
  mp3: 'audio',
  mp4: 'video',
  mpeg: 'video',
  mpg: 'video',
  ods: 'spreadsheet',
  ogg: 'audio',
  otf: 'type',
  pdf: 'pdf',
  pem: 'lock',
  pl: 'perl',
  pm: 'perl',
  php: 'php',
  plist: 'config',
  png: 'image',
  ppt: 'text',
  pptx: 'text',
  py: 'python',
  r: 'r',
  rar: 'archive',
  rb: 'ruby',
  rs: 'rust',
  rst: 'text',
  sass: 'sass',
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
  toml: 'toml',
  ts: 'typescript',
  tsx: 'react',
  tsv: 'spreadsheet',
  ttf: 'type',
  txt: 'text',
  wav: 'audio',
  webm: 'video',
  webp: 'image',
  woff: 'type',
  woff2: 'type',
  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  vue: 'vue',
  xml: 'html',
  yaml: 'yaml',
  yml: 'yaml',
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

export function fileIconForPath(path: string): FileIconMeta {
  const fileName = fileNameFromPath(path).toLowerCase()
  if (LOCK_FILE_NAMES.has(fileName)) return FILE_TYPE_ICON_META.lock
  const fileNameKind = FILE_NAME_ICON[fileName]
  if (fileNameKind) return FILE_TYPE_ICON_META[fileNameKind]
  if (DOTENV_FILE_NAME_PATTERN.test(fileName)) return FILE_TYPE_ICON_META.dotenv
  if (CONFIG_FILE_NAMES.has(fileName)) return FILE_TYPE_ICON_META.config
  if (CONFIG_NAME_PATTERNS.some((pattern) => pattern.test(fileName))) {
    return FILE_TYPE_ICON_META.config
  }

  const extension = extensionFromFileName(fileName)
  const kind = extension ? EXTENSION_FILE_ICON[extension] : undefined
  return FILE_TYPE_ICON_META[kind ?? 'text']
}

type ToolIconKey = 'command' | 'python' | 'read' | 'edit' | 'search' | 'web' | 'generic'

export const TOOL_ACTION_ICON_META = {
  command: PHI_ICON_META['tool.command'],
  python: PHI_ICON_META['tool.python'],
  read: PHI_ICON_META['tool.read'],
  edit: PHI_ICON_META['tool.edit'],
  search: PHI_ICON_META['tool.search'],
  web: PHI_ICON_META['tool.web'],
  generic: PHI_ICON_META['tool.generic']
} satisfies Record<ToolIconKey, PhiIconMeta>

export function iconFor(name: PhiIconName): PhiIconComponent {
  return PHI_ICON_META[name].Icon
}
