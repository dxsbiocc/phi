import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { TbContainer } from 'react-icons/tb'

import type {
  EnvironmentHostDependency,
  EnvironmentHostDependencyId
} from '../../../../../shared/environmentTypes'
import { PhiIcons } from '../../../icons'
import { HostEnvironmentItem } from './HostEnvironmentItem'

function dependencyStatus(dependency: EnvironmentHostDependency): {
  label: string
  color: 'success' | 'warning' | 'default'
} {
  if (dependency.status === 'ready') return { label: '可用', color: 'success' }
  if (dependency.status === 'unavailable') return { label: '不可用', color: 'warning' }
  return { label: '未检测到', color: 'default' }
}

function dependencyIcon(id: EnvironmentHostDependencyId): React.JSX.Element {
  if (id === 'docker') return <PhiIcons.file.docker size={22} />
  return <TbContainer aria-hidden size={22} />
}

export function HostDependenciesList({
  dependencies
}: {
  dependencies: readonly EnvironmentHostDependency[]
}): React.JSX.Element {
  if (dependencies.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        尚未完成容器运行时检测。
      </Typography>
    )
  }
  return (
    <Stack spacing={1}>
      {dependencies.map((dependency) => {
        const status = dependencyStatus(dependency)
        const summary = [
          dependency.version,
          dependency.detail,
          dependency.path,
          ...(dependency.messages ?? [])
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <HostEnvironmentItem
            key={dependency.id}
            id={dependency.id}
            icon={dependencyIcon(dependency.id)}
            title={dependency.label}
            summary={summary || '未检测到可用路径'}
            status={status}
          />
        )
      })}
    </Stack>
  )
}
