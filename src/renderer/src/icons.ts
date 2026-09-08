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
  Power,
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
    folder: createPhiIcon('Folder', Folder),
    mcp: createPhiIcon('Mcp', Network),
    plugin: createPhiIcon('Plugin', Puzzle),
    project: createPhiIcon('Project', FolderOpen),
    provider: createPhiIcon('Provider', Power),
    skill: createPhiIcon('Skill', GraduationCap)
  },
  nav: {
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
    providers: createPhiIcon('Providers', Power)
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
  'action.openExternal': { label: '打开外部链接', Icon: PhiIcons.action.openExternal },
  'action.quick': { label: '快速', Icon: PhiIcons.action.quick },
  'action.refresh': { label: '刷新', Icon: PhiIcons.action.refresh },
  'action.saveKey': { label: '保存 API Key', Icon: PhiIcons.action.saveKey },
  'action.search': { label: '搜索', Icon: PhiIcons.action.search },
  'action.send': { label: '发送', Icon: PhiIcons.action.send },
  'action.stop': { label: '停止', Icon: PhiIcons.action.stop, color: 'error.main' },
  'entity.apiKey': { label: 'API Key', Icon: PhiIcons.entity.apiKey },
  'entity.folder': { label: '文件夹', Icon: PhiIcons.entity.folder },
  'entity.mcp': { label: 'MCP', Icon: PhiIcons.entity.mcp },
  'entity.plugin': { label: '插件', Icon: PhiIcons.entity.plugin },
  'entity.project': { label: '项目', Icon: PhiIcons.entity.project },
  'entity.provider': { label: 'Provider', Icon: PhiIcons.entity.provider },
  'entity.skill': { label: '技能', Icon: PhiIcons.entity.skill },
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
  'state.ask': { label: '询问', Icon: PhiIcons.state.ask, color: 'success.main' },
  'state.auto': { label: '自动', Icon: PhiIcons.state.auto, color: 'warning.main' },
  'state.check': { label: '已选中', Icon: PhiIcons.state.check },
  'state.denied': { label: '拒绝', Icon: PhiIcons.state.denied, color: 'error.main' },
  'state.done': { label: '完成', Icon: PhiIcons.state.done, color: 'success.main' },
  'state.full': { label: '完全访问', Icon: PhiIcons.state.full, color: 'error.main' },
  'state.thinking': { label: '思考', Icon: PhiIcons.state.thinking },
  'tool.command': { label: '运行命令', Icon: PhiIcons.tool.command, color: 'text.secondary' },
  'tool.read': { label: '读取文件', Icon: PhiIcons.tool.read, color: 'info.main' },
  'tool.edit': { label: '编辑文件', Icon: PhiIcons.tool.edit, color: 'warning.main' },
  'tool.search': { label: '搜索', Icon: PhiIcons.tool.search, color: 'secondary.main' },
  'tool.web': { label: '访问网页', Icon: PhiIcons.tool.web, color: 'primary.main' },
  'tool.generic': { label: '工具调用', Icon: PhiIcons.tool.generic, color: 'text.secondary' }
} as const satisfies Record<string, PhiIconMeta>

export type PhiIconName = keyof typeof PHI_ICON_META

export const PERMISSION_MODE_ICON_META = {
  ask: PHI_ICON_META['state.ask'],
  auto: PHI_ICON_META['state.auto'],
  full: PHI_ICON_META['state.full']
} satisfies Record<PermissionMode, PhiIconMeta>

type ToolIconKey = 'command' | 'read' | 'edit' | 'search' | 'web' | 'generic'

export const TOOL_ACTION_ICON_META = {
  command: PHI_ICON_META['tool.command'],
  read: PHI_ICON_META['tool.read'],
  edit: PHI_ICON_META['tool.edit'],
  search: PHI_ICON_META['tool.search'],
  web: PHI_ICON_META['tool.web'],
  generic: PHI_ICON_META['tool.generic']
} satisfies Record<ToolIconKey, PhiIconMeta>

export function iconFor(name: PhiIconName): PhiIconComponent {
  return PHI_ICON_META[name].Icon
}
