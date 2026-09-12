import { Alert, Box, Button, Chip, Divider, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { PhiIcons, fileIconForPath } from '../../icons'
import { formatBytes } from '../../lib/toolOutputPresentation'
import type { FilePreview } from '../../types'

export interface GoslingWorkbenchViewProps {
  projectCwd?: string
  projectName?: string
  selectedFile: FilePreview | null
  isLoadingFile?: boolean
  error?: string | null
  onPickFile: () => void
  onOpenFile?: (path: string) => void
  onRevealFile?: (path: string) => void
}

type ParsedJson =
  | { status: 'empty' }
  | { status: 'ok'; value: unknown }
  | { status: 'error'; message: string }

const SelectFileIcon = PhiIcons.action.add
const OpenIcon = PhiIcons.action.openDefault
const RevealIcon = PhiIcons.entity.folder
const VisualizationIcon = PhiIcons.nav.visualization
const isMac = typeof window !== 'undefined' && window.platform === 'darwin'
const macTitlebarHeight = 44

function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
  const dot = name.lastIndexOf('.')
  return dot > -1 ? name.slice(dot + 1).toLowerCase() : ''
}

function parseJsonFile(file: FilePreview | null): ParsedJson {
  if (!file || file.kind !== 'text') return { status: 'empty' }
  if (fileExtension(file.path) !== 'json') return { status: 'empty' }
  try {
    return { status: 'ok', value: JSON.parse(file.content) }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : '无法解析 JSON'
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function goslingSpecKind(value: unknown): 'gosling-spec' | 'json-data' {
  if (!isRecord(value)) return 'json-data'
  if (
    Array.isArray(value.tracks) ||
    Array.isArray(value.views) ||
    typeof value.alignment === 'string' ||
    isRecord(value.data)
  ) {
    return 'gosling-spec'
  }
  return 'json-data'
}

function countSpecItems(value: unknown, key: 'tracks' | 'views'): number | null {
  if (!isRecord(value)) return null
  const items = value[key]
  return Array.isArray(items) ? items.length : null
}

function fileRoleLabel(file: FilePreview | null, parsedJson: ParsedJson): string {
  if (!file) return '未选择'
  const extension = fileExtension(file.path)
  if (parsedJson.status === 'ok' && goslingSpecKind(parsedJson.value) === 'gosling-spec') {
    return 'Gosling spec'
  }
  if (['csv', 'tsv', 'bed', 'bedgraph', 'bigwig', 'bw', 'bigbed', 'bb'].includes(extension)) {
    return '数据源'
  }
  if (extension === 'json') return 'JSON 数据'
  return '文件'
}

function previewText(file: FilePreview | null): string {
  if (!file) return ''
  if (file.kind !== 'text') return `${file.mimeType} · ${formatBytes(file.bytes)}`
  return file.content.slice(0, 1400)
}

export default function GoslingWorkbenchView({
  projectCwd = '',
  projectName,
  selectedFile,
  isLoadingFile = false,
  error = null,
  onPickFile,
  onOpenFile,
  onRevealFile
}: GoslingWorkbenchViewProps): React.JSX.Element {
  const parsedJson = parseJsonFile(selectedFile)
  const roleLabel = fileRoleLabel(selectedFile, parsedJson)
  const fileIcon = selectedFile ? fileIconForPath(selectedFile.path) : null
  const FileIcon = fileIcon?.Icon
  const tracks = parsedJson.status === 'ok' ? countSpecItems(parsedJson.value, 'tracks') : null
  const views = parsedJson.status === 'ok' ? countSpecItems(parsedJson.value, 'views') : null
  const isGoslingSpec =
    parsedJson.status === 'ok' && goslingSpecKind(parsedJson.value) === 'gosling-spec'

  return (
    <Box
      component="main"
      data-phi-gosling-workbench="true"
      sx={{
        flex: 1,
        minWidth: 0,
        height: '100vh',
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        pt: isMac ? `${macTitlebarHeight}px` : 0
      }}
    >
      <Box
        sx={{
          minHeight: 56,
          borderBottom: 1,
          borderColor: 'divider',
          px: { xs: 2, md: 3 },
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <VisualizationIcon color="primary" fontSize="small" />
            <Typography variant="subtitle1" sx={{ fontWeight: 800, lineHeight: 1.2 }}>
              Gosling 可视化
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
            {projectName ? `${projectName} · ` : ''}
            {projectCwd || '选择项目或本地文件后浏览数据'}
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<SelectFileIcon />}
          disabled={isLoadingFile}
          onClick={onPickFile}
          sx={{ flexShrink: 0, textTransform: 'none', fontWeight: 800 }}
        >
          选择数据
        </Button>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: { xs: 2, md: 3 }, py: 3 }}>
        <Stack spacing={2.5} sx={{ width: '100%', maxWidth: 1120, mx: 'auto' }}>
          {error ? (
            <Alert severity="error" variant="outlined">
              {error}
            </Alert>
          ) : null}

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', lg: '320px minmax(0, 1fr)' },
              gap: 2.5,
              alignItems: 'stretch'
            }}
          >
            <Stack spacing={2}>
              <Box
                sx={{
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 2,
                  bgcolor: 'background.paper',
                  p: 2
                }}
              >
                <Stack spacing={1.25}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <VisualizationIcon color="primary" fontSize="small" />
                    <Typography sx={{ fontWeight: 800 }}>工作流</Typography>
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    在这里选择 Gosling spec 或基因组数据文件，预览结构后进入交互式图形渲染。
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                    <Chip size="small" label="JSON spec" variant="outlined" />
                    <Chip size="small" label="CSV / TSV" variant="outlined" />
                    <Chip size="small" label="BED / BigWig" variant="outlined" />
                  </Stack>
                </Stack>
              </Box>

              <Box
                sx={{
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 2,
                  bgcolor: 'background.paper',
                  overflow: 'hidden'
                }}
              >
                <Box sx={{ px: 2, py: 1.5 }}>
                  <Typography sx={{ fontWeight: 800 }}>当前输入</Typography>
                </Box>
                <Divider />
                {selectedFile ? (
                  <Box sx={{ p: 2 }}>
                    <Stack spacing={1.25}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
                        {FileIcon ? (
                          <FileIcon
                            fontSize="small"
                            sx={{ color: fileIcon?.color, flexShrink: 0 }}
                          />
                        ) : null}
                        <Typography noWrap sx={{ fontWeight: 750, minWidth: 0 }}>
                          {selectedFile.name}
                        </Typography>
                      </Stack>
                      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                        <Chip size="small" color={isGoslingSpec ? 'primary' : 'default'} label={roleLabel} />
                        <Chip size="small" variant="outlined" label={formatBytes(selectedFile.bytes)} />
                        {selectedFile.truncated ? (
                          <Chip size="small" color="warning" variant="outlined" label="预览已截断" />
                        ) : null}
                      </Stack>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ overflowWrap: 'anywhere' }}
                      >
                        {selectedFile.path}
                      </Typography>
                      <Stack direction="row" spacing={1}>
                        {onOpenFile ? (
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<OpenIcon />}
                            onClick={() => onOpenFile(selectedFile.path)}
                            sx={{ textTransform: 'none' }}
                          >
                            打开文件
                          </Button>
                        ) : null}
                        {onRevealFile ? (
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<RevealIcon />}
                            onClick={() => onRevealFile(selectedFile.path)}
                            sx={{ textTransform: 'none' }}
                          >
                            显示位置
                          </Button>
                        ) : null}
                      </Stack>
                    </Stack>
                  </Box>
                ) : (
                  <Box sx={{ p: 2 }}>
                    <Typography variant="body2" color="text.secondary">
                      还没有选择数据文件。
                    </Typography>
                  </Box>
                )}
              </Box>
            </Stack>

            <Box
              sx={{
                minHeight: 520,
                border: 1,
                borderColor: 'divider',
                borderRadius: 2,
                bgcolor: 'background.paper',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              <Box
                sx={{
                  px: 2,
                  py: 1.5,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 800 }}>预览</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {selectedFile ? roleLabel : '等待选择数据'}
                  </Typography>
                </Box>
                {tracks !== null || views !== null ? (
                  <Stack direction="row" spacing={1}>
                    {tracks !== null ? <Chip size="small" label={`${tracks} tracks`} /> : null}
                    {views !== null ? <Chip size="small" label={`${views} views`} /> : null}
                  </Stack>
                ) : null}
              </Box>
              <Divider />
              <Box
                sx={{
                  flex: 1,
                  minHeight: 0,
                  p: 2,
                  display: 'grid',
                  gridTemplateRows: 'minmax(220px, 1fr) auto',
                  gap: 2
                }}
              >
                <Box
                  data-phi-gosling-preview-stage="true"
                  sx={{
                    border: 1,
                    borderStyle: 'dashed',
                    borderColor: isGoslingSpec ? 'primary.light' : 'divider',
                    borderRadius: 2,
                    bgcolor: (theme) =>
                      alpha(
                        isGoslingSpec ? theme.palette.primary.main : theme.palette.text.primary,
                        theme.palette.mode === 'dark' ? 0.1 : 0.045
                      ),
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textAlign: 'center',
                    px: 3
                  }}
                >
                  <Stack spacing={1.25} sx={{ alignItems: 'center', maxWidth: 520 }}>
                    <VisualizationIcon color={isGoslingSpec ? 'primary' : 'disabled'} size={44} />
                    <Typography sx={{ fontWeight: 850 }}>
                      {isGoslingSpec
                        ? 'Gosling spec 已识别'
                        : selectedFile
                          ? '数据已就绪'
                          : '选择 spec 或数据文件开始'}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {isGoslingSpec
                        ? '下一步将在此处挂载 gosling.js 渲染器，保留当前页面作为专用可视化工作台。'
                        : selectedFile
                          ? '该文件可作为 Gosling 数据源；选择或生成 spec 后即可渲染图形。'
                          : '此页面独立于 notebook 文件 tab，可用于浏览和可视化项目中的数据。'}
                    </Typography>
                  </Stack>
                </Box>

                {selectedFile ? (
                  <Box
                    component="pre"
                    sx={{
                      m: 0,
                      maxHeight: 220,
                      overflow: 'auto',
                      borderRadius: 1.5,
                      bgcolor: (theme) =>
                        theme.palette.mode === 'dark'
                          ? 'rgba(255, 255, 255, 0.055)'
                          : 'rgba(15, 23, 42, 0.045)',
                      p: 1.5,
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.8rem',
                      lineHeight: 1.55,
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere'
                    }}
                  >
                    {parsedJson.status === 'error'
                      ? `JSON 解析失败：${parsedJson.message}`
                      : previewText(selectedFile)}
                  </Box>
                ) : null}
              </Box>
            </Box>
          </Box>
        </Stack>
      </Box>
    </Box>
  )
}
