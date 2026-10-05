import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  MenuItem,
  Paper,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import { toolApprovalLabel } from '../lib/toolActions'
import { PERMISSION_MODE_ICON_META, PhiIcons } from '../icons'
import type {
  ModelOption,
  PermissionMode,
  Project,
  ThinkingLevel,
  ToolApprovalRequest
} from '../types'

type PermissionViewProps = {
  projects: Project[]
  models: ModelOption[]
  pendingApproval: ToolApprovalRequest | null
  updatingProjectId: string | null
  onUpdateProjectPermissionMode: (projectId: string, mode: PermissionMode) => void
  onUpdateProjectDefaults: (
    projectId: string,
    defaults: {
      defaultModel?: { providerId: string; modelId: string } | null
      defaultThinkingLevel?: ThinkingLevel | null
    }
  ) => void
  onOpenApprovalSession: (path: string) => void
  onRespondApproval: (requestId: string, approved: boolean) => void
}

const TOOL_LABELS: Record<string, string> = {
  bash: '终端命令',
  powershell: 'PowerShell',
  write: '写入文件',
  edit: '修改文件',
  office_apply: '修改 Office 文档',
  office_deliver: '交付 Office 文件',
  browser: '浏览器操作'
}
const ApproveIcon = PhiIcons.action.approve
const DenyIcon = PhiIcons.state.denied
const ShieldIcon = PhiIcons.settings.permissions
const AskPermissionIcon = PhiIcons.state.ask
const AutoPermissionIcon = PhiIcons.state.auto
const FullPermissionIcon = PhiIcons.state.full

const PERMISSION_MODE_DETAILS = {
  ask: {
    label: '询问',
    description: '执行命令、写入或修改文件前暂停，等待你批准。'
  },
  auto: {
    label: '自动',
    description: '自动执行常规允许工具；遇到受限操作仍会被运行时拦截。'
  },
  full: {
    label: '完全访问',
    description: '放宽项目工具限制，只适合你信任的本地任务。'
  }
} satisfies Record<PermissionMode, { label: string; description: string }>

const THINKING_LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max'
}

function permissionColor(mode: PermissionMode): 'success' | 'warning' | 'error' {
  if (mode === 'ask') return 'success'
  if (mode === 'full') return 'error'
  return 'warning'
}

export function PermissionSettingsSection({
  projects,
  models,
  pendingApproval,
  updatingProjectId,
  onUpdateProjectPermissionMode,
  onUpdateProjectDefaults,
  onOpenApprovalSession,
  onRespondApproval
}: PermissionViewProps): React.JSX.Element {
  const askCount = projects.filter((project) => project.permissionMode === 'ask').length
  const fullCount = projects.filter((project) => project.permissionMode === 'full').length
  const autoCount = projects.length - askCount - fullCount

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">权限</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 760 }}>
          控制项目会话执行命令、写入文件和修改文件时的审批策略。项目策略会影响后续运行；默认模型和思考等级只作为新会话起点。
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
          <Chip size="small" label={`${projects.length} 个项目`} />
          <Chip
            size="small"
            color="success"
            icon={<AskPermissionIcon />}
            variant="outlined"
            label={`${askCount} 询问`}
          />
          <Chip
            size="small"
            color="warning"
            icon={<AutoPermissionIcon />}
            variant="outlined"
            label={`${autoCount} 自动`}
          />
          <Chip
            size="small"
            color="error"
            icon={<FullPermissionIcon />}
            variant="outlined"
            label={`${fullCount} 完全访问`}
          />
        </Stack>
      </Box>

      {pendingApproval ? (
        <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 1 }}>
          <Stack
            direction="row"
            sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 1.5 }}
          >
            <Box>
              <Typography variant="overline" sx={{ letterSpacing: 0, fontWeight: 700 }}>
                待审批
              </Typography>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                {toolApprovalLabel(pendingApproval.toolName, pendingApproval.summary) ??
                  TOOL_LABELS[pendingApproval.toolName] ??
                  pendingApproval.toolName}
              </Typography>
            </Box>
            <Stack direction="row" spacing={1}>
              {pendingApproval.sessionPath && (
                <Button
                  variant="outlined"
                  onClick={() => onOpenApprovalSession(pendingApproval.sessionPath as string)}
                >
                  打开会话
                </Button>
              )}
              <Button
                color="error"
                variant="outlined"
                startIcon={<DenyIcon />}
                onClick={() => onRespondApproval(pendingApproval.requestId, false)}
              >
                拒绝
              </Button>
              <Button
                variant="contained"
                startIcon={<ApproveIcon />}
                onClick={() => onRespondApproval(pendingApproval.requestId, true)}
              >
                {pendingApproval.toolName === 'browser' ? '仅允许这一次' : '批准'}
              </Button>
            </Stack>
          </Stack>
          <Typography
            component="pre"
            sx={{
              m: 0,
              p: 1.5,
              borderRadius: 1,
              bgcolor: 'action.hover',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.85rem',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere'
            }}
          >
            {pendingApproval.summary}
          </Typography>
        </Paper>
      ) : (
        <Alert severity="info" variant="outlined" sx={{ borderRadius: 1 }}>
          当前没有待审批操作
        </Alert>
      )}

      <Paper variant="outlined" sx={{ borderRadius: 1, overflow: 'hidden' }}>
        <Box sx={{ px: 2.5, py: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            项目权限
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            安全策略放在最前面；模型设置会在项目中新建会话时作为默认值。
          </Typography>
        </Box>
        <Divider />

        {projects.length === 0 ? (
          <Box sx={{ p: 3 }}>
            <Typography color="text.secondary">还没有项目</Typography>
          </Box>
        ) : (
          <Stack divider={<Divider flexItem />}>
            {projects.map((project, index) => {
              const permissionIcon = PERMISSION_MODE_ICON_META[project.permissionMode]
              const PermissionIcon = permissionIcon.Icon
              const details = PERMISSION_MODE_DETAILS[project.permissionMode]
              const modeColor = permissionColor(project.permissionMode)

              return (
                <Box
                  key={project.id}
                  sx={{
                    p: 2.5,
                    bgcolor: index % 2 === 0 ? 'background.paper' : 'action.hover'
                  }}
                >
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
                    <Box
                      sx={{
                        width: 38,
                        height: 38,
                        borderRadius: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        bgcolor: `${modeColor}.main`,
                        color: `${modeColor}.contrastText`,
                        flexShrink: 0
                      }}
                    >
                      <PermissionIcon aria-label={permissionIcon.label} fontSize="small" />
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
                      >
                        <Typography variant="subtitle1" sx={{ fontWeight: 700, minWidth: 0 }}>
                          {project.name}
                        </Typography>
                        <Chip
                          size="small"
                          color={modeColor}
                          variant="outlined"
                          icon={<PermissionIcon />}
                          label={details.label}
                        />
                      </Stack>
                      <Tooltip title={project.workingDirectory} placement="bottom-start">
                        <Typography
                          variant="body2"
                          component="div"
                          sx={{
                            mt: 0.25,
                            color: 'text.secondary',
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.78rem',
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {project.workingDirectory}
                        </Typography>
                      </Tooltip>
                    </Box>
                  </Stack>

                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: {
                        xs: '1fr',
                        lg: 'minmax(320px, 360px) minmax(220px, 1fr) minmax(150px, 170px)'
                      },
                      gap: 1.5,
                      mt: 2
                    }}
                  >
                    <Box>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mb: 0.75 }}
                      >
                        安全策略
                      </Typography>
                      <ToggleButtonGroup
                        exclusive
                        size="small"
                        value={project.permissionMode}
                        disabled={updatingProjectId === project.id}
                        onChange={(_, next: PermissionMode | null) => {
                          if (next && next !== project.permissionMode) {
                            onUpdateProjectPermissionMode(project.id, next)
                          }
                        }}
                        sx={{
                          display: 'flex',
                          width: '100%',
                          '& .MuiToggleButton-root': {
                            flex: '1 1 0',
                            minWidth: 0,
                            minHeight: 38,
                            px: 1
                          }
                        }}
                      >
                        <ToggleButton value="ask">
                          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                            <AskPermissionIcon fontSize="small" />
                            <Typography component="span" variant="body2" noWrap>
                              询问
                            </Typography>
                          </Stack>
                        </ToggleButton>
                        <ToggleButton value="auto">
                          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                            <AutoPermissionIcon fontSize="small" />
                            <Typography component="span" variant="body2" noWrap>
                              自动
                            </Typography>
                          </Stack>
                        </ToggleButton>
                        <ToggleButton value="full" sx={{ color: 'error.main' }}>
                          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                            <FullPermissionIcon fontSize="small" />
                            <Typography component="span" variant="body2" noWrap>
                              完全访问
                            </Typography>
                          </Stack>
                        </ToggleButton>
                      </ToggleButtonGroup>
                    </Box>

                    <Box sx={{ minWidth: 0 }}>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mb: 0.75 }}
                      >
                        默认模型
                      </Typography>
                      <Select
                        size="small"
                        fullWidth
                        displayEmpty
                        value={
                          project.defaultModel
                            ? `${project.defaultModel.providerId}/${project.defaultModel.modelId}`
                            : ''
                        }
                        onChange={(event) => {
                          const value = event.target.value
                          const model = models.find(
                            (item) => `${item.providerId}/${item.modelId}` === value
                          )
                          onUpdateProjectDefaults(project.id, {
                            defaultModel: model
                              ? { providerId: model.providerId, modelId: model.modelId }
                              : null
                          })
                        }}
                        sx={{
                          minWidth: 0,
                          '& .MuiSelect-select': {
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }
                        }}
                      >
                        <MenuItem value="">跟随全局模型</MenuItem>
                        {models.map((model) => (
                          <MenuItem
                            key={`${model.providerId}/${model.modelId}`}
                            value={`${model.providerId}/${model.modelId}`}
                          >
                            {model.name}
                          </MenuItem>
                        ))}
                      </Select>
                    </Box>

                    <Box sx={{ minWidth: 0 }}>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mb: 0.75 }}
                      >
                        思考等级
                      </Typography>
                      <Select
                        size="small"
                        fullWidth
                        displayEmpty
                        value={project.defaultThinkingLevel ?? ''}
                        onChange={(event) => {
                          onUpdateProjectDefaults(project.id, {
                            defaultThinkingLevel: (event.target.value ||
                              null) as ThinkingLevel | null
                          })
                        }}
                      >
                        <MenuItem value="">跟随全局</MenuItem>
                        {THINKING_LEVELS.map((level) => (
                          <MenuItem key={level} value={level}>
                            {THINKING_LEVEL_LABELS[level]}
                          </MenuItem>
                        ))}
                      </Select>
                    </Box>
                  </Box>

                  <Typography
                    variant="body2"
                    color={project.permissionMode === 'full' ? 'error.main' : 'text.secondary'}
                    sx={{ mt: 1.25 }}
                  >
                    {details.description}
                  </Typography>
                </Box>
              )
            })}
          </Stack>
        )}
      </Paper>
    </Stack>
  )
}

export default function PermissionView(props: PermissionViewProps): React.JSX.Element {
  return (
    <Box component="main" sx={{ flex: 1, minWidth: 0, height: '100vh', overflow: 'auto' }}>
      <Box sx={{ maxWidth: 980, px: { xs: 3, md: 5 }, py: 5 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 3 }}>
          <Box
            sx={{
              width: 42,
              height: 42,
              borderRadius: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'primary.main',
              color: 'primary.contrastText'
            }}
          >
            <ShieldIcon />
          </Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            权限
          </Typography>
        </Stack>
        <PermissionSettingsSection {...props} />
      </Box>
    </Box>
  )
}
