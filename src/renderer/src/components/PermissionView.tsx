import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
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
  edit: '修改文件'
}
const ApproveIcon = PhiIcons.action.approve
const DenyIcon = PhiIcons.state.denied
const ShieldIcon = PhiIcons.settings.permissions
const AskPermissionIcon = PhiIcons.state.ask
const AutoPermissionIcon = PhiIcons.state.auto
const FullPermissionIcon = PhiIcons.state.full

function permissionLabel(mode: PermissionMode): string {
  if (mode === 'ask') return '询问'
  if (mode === 'full') return '完全访问'
  return '自动'
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
                {TOOL_LABELS[pendingApproval.toolName] ?? pendingApproval.toolName}
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
                批准
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
        <Alert severity="info">当前没有待审批操作</Alert>
      )}

      <Paper variant="outlined" sx={{ borderRadius: 1, overflow: 'hidden' }}>
        <Box sx={{ px: 2.5, py: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            项目权限
          </Typography>
        </Box>
        <Divider />

        {projects.length === 0 ? (
          <Box sx={{ p: 3 }}>
            <Typography color="text.secondary">还没有项目</Typography>
          </Box>
        ) : (
          <List disablePadding>
            {projects.map((project, index) => {
              const permissionIcon = PERMISSION_MODE_ICON_META[project.permissionMode]
              const PermissionIcon = permissionIcon.Icon

              return (
                <ListItem
                  key={project.id}
                  divider={index < projects.length - 1}
                  sx={{
                    alignItems: { xs: 'flex-start', md: 'center' },
                    gap: 2,
                    py: 2,
                    flexDirection: { xs: 'column', md: 'row' }
                  }}
                >
                  <Box
                    sx={{
                      width: 34,
                      height: 34,
                      borderRadius: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      bgcolor:
                        project.permissionMode === 'ask'
                          ? 'success.main'
                          : project.permissionMode === 'full'
                            ? 'error.main'
                            : 'warning.main',
                      color:
                        project.permissionMode === 'ask'
                          ? 'success.contrastText'
                          : project.permissionMode === 'full'
                            ? 'error.contrastText'
                            : 'warning.contrastText',
                      flexShrink: 0
                    }}
                  >
                    <PermissionIcon aria-label={permissionIcon.label} fontSize="small" />
                  </Box>
                  <ListItemText
                    primary={project.name}
                    secondary={project.workingDirectory}
                    slotProps={{
                      primary: { sx: { fontWeight: 700 } },
                      secondary: {
                        sx: {
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.78rem',
                          overflowWrap: 'anywhere'
                        }
                      }
                    }}
                    sx={{ minWidth: 0, flex: 1, my: 0 }}
                  />
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
                    sx={{ flexShrink: 0 }}
                  >
                    <ToggleButton value="ask" sx={{ minWidth: 96 }}>
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                        <AskPermissionIcon fontSize="small" />
                        <span>询问</span>
                      </Stack>
                    </ToggleButton>
                    <ToggleButton value="auto" sx={{ minWidth: 96 }}>
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                        <AutoPermissionIcon fontSize="small" />
                        <span>自动</span>
                      </Stack>
                    </ToggleButton>
                    <ToggleButton value="full" sx={{ minWidth: 116, color: 'error.main' }}>
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                        <FullPermissionIcon fontSize="small" />
                        <span>完全访问</span>
                      </Stack>
                    </ToggleButton>
                  </ToggleButtonGroup>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ flexShrink: 0 }}>
                    <Select
                      size="small"
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
                      sx={{ minWidth: 180 }}
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
                    <Select
                      size="small"
                      displayEmpty
                      value={project.defaultThinkingLevel ?? ''}
                      onChange={(event) => {
                        onUpdateProjectDefaults(project.id, {
                          defaultThinkingLevel: (event.target.value || null) as ThinkingLevel | null
                        })
                      }}
                      sx={{ minWidth: 130 }}
                    >
                      <MenuItem value="">跟随全局</MenuItem>
                      {(
                        ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as ThinkingLevel[]
                      ).map((level) => (
                        <MenuItem key={level} value={level}>
                          {level}
                        </MenuItem>
                      ))}
                    </Select>
                  </Stack>
                  <Chip
                    size="small"
                    icon={<PermissionIcon />}
                    label={permissionLabel(project.permissionMode)}
                  />
                </ListItem>
              )
            })}
          </List>
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
