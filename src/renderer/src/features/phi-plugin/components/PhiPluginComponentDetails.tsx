import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material'

import type { PhiPluginDisplayItem } from '../hooks/usePhiPlugins'
import { phiPluginComponentName } from '../lib/phiPlugins'

type ComponentDescriptionProps = {
  description: string
}

function ComponentDescription({
  description
}: ComponentDescriptionProps): React.JSX.Element | null {
  if (!description) return null
  return (
    <Tooltip title={description} placement="top-start">
      <Typography
        variant="body2"
        color="text.secondary"
        noWrap
        data-phi-description-truncated="true"
        sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {description}
      </Typography>
    </Tooltip>
  )
}

function DetailRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Box
      component="section"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: '160px minmax(0, 1fr)' },
        columnGap: 2,
        rowGap: 0.75,
        alignItems: 'start'
      }}
    >
      <Typography
        variant="overline"
        color="text.secondary"
        sx={{ fontWeight: 700, lineHeight: '24px' }}
      >
        {label}
      </Typography>
      {children}
    </Box>
  )
}

function ComponentItem({
  name,
  description,
  metadata,
  monoName = false
}: {
  name: string
  description: string
  metadata?: React.ReactNode
  monoName?: boolean
}): React.JSX.Element {
  return (
    <Box sx={{ minWidth: 0, py: 0.25 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 650,
            minWidth: 0,
            ...(monoName ? { fontFamily: 'var(--font-mono)' } : {})
          }}
        >
          {name}
        </Typography>
        {metadata}
      </Stack>
      <ComponentDescription description={description} />
    </Box>
  )
}

const APPROVAL_LABELS = {
  read: '只读',
  write: '写入',
  execute: '执行'
} as const

function AgentDetails({ plugin }: { plugin: PhiPluginDisplayItem }): React.JSX.Element {
  const agents =
    plugin.agentDetails?.map((agent) => ({ ...agent })) ??
    (plugin.agents ?? []).map((name) => ({ name: phiPluginComponentName(name), description: '' }))
  return (
    <DetailRow label="智能体">
      {agents.length > 0 ? (
        <Stack spacing={0.75} sx={{ minWidth: 0 }}>
          {agents.map((agent) => (
            <ComponentItem key={agent.name} {...agent} />
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          无专属智能体（由主智能体按技能调用）
        </Typography>
      )}
    </DetailRow>
  )
}

function SkillDetails({ plugin }: { plugin: PhiPluginDisplayItem }): React.JSX.Element {
  const skills =
    plugin.skillDetails?.map((skill) => ({ ...skill })) ??
    (plugin.skills ?? []).map((name) => ({
      name: phiPluginComponentName(name),
      description: '',
      enabled: undefined
    }))
  return (
    <DetailRow label="技能">
      {skills.length > 0 ? (
        <Stack spacing={0.75} sx={{ minWidth: 0 }}>
          {skills.map((skill) => (
            <ComponentItem
              key={skill.name}
              name={skill.name}
              description={skill.description}
              metadata={
                <Chip
                  size="small"
                  variant="outlined"
                  color={skill.enabled === true ? 'success' : 'default'}
                  label={
                    skill.enabled === undefined ? '状态未知' : skill.enabled ? '已启用' : '已停用'
                  }
                />
              }
            />
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          无插件技能
        </Typography>
      )}
    </DetailRow>
  )
}

function ScriptToolDetails({ plugin }: { plugin: PhiPluginDisplayItem }): React.JSX.Element {
  const tools =
    plugin.scriptToolDetails?.map((tool) => ({ ...tool })) ??
    (plugin.scriptTools ?? []).map((name) => ({
      name,
      description: '',
      approval: undefined,
      skillName: undefined
    }))
  return (
    <DetailRow label="脚本工具（最终名称）">
      {tools.length > 0 ? (
        <Stack spacing={0.75} sx={{ minWidth: 0 }}>
          {tools.map((tool) => (
            <ComponentItem
              key={tool.name}
              name={tool.name}
              description={tool.description}
              monoName
              metadata={
                tool.approval || tool.skillName ? (
                  <Typography variant="caption" color="text.secondary">
                    {tool.approval ? `审批：${APPROVAL_LABELS[tool.approval]}` : ''}
                    {tool.approval && tool.skillName ? ' · ' : ''}
                    {tool.skillName ? `所属技能：${tool.skillName}` : ''}
                  </Typography>
                ) : undefined
              }
            />
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          无脚本工具
        </Typography>
      )}
    </DetailRow>
  )
}

export function PhiPluginComponentDetails({
  plugin
}: {
  plugin: PhiPluginDisplayItem
}): React.JSX.Element {
  return (
    <Stack spacing={2} data-phi-plugin-component-details="true">
      <AgentDetails plugin={plugin} />
      <SkillDetails plugin={plugin} />
      <ScriptToolDetails plugin={plugin} />
    </Stack>
  )
}
