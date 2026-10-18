import { environmentUi } from '../lib/environmentUi'
import { useUiLanguage } from '../../../lib/i18n'
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
  if (dependency.status === 'ready') return { label: environmentUi.available, color: 'success' }
  if (dependency.status === 'unavailable')
    return { label: environmentUi.unavailable, color: 'warning' }
  return { label: environmentUi.notDetected, color: 'default' }
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
  useUiLanguage()
  if (dependencies.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {environmentUi.containerRuntimeDetectionHasNotFinished}
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
            summary={summary || environmentUi.noUsablePathDetected}
            status={status}
          />
        )
      })}
    </Stack>
  )
}
