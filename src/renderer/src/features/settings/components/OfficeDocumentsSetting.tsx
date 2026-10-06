import { Box, FormControlLabel, Switch, Typography } from '@mui/material'
import type { OfficeAvailability } from '../../../../../shared/officeAvailability'

const unavailableReason: Partial<Record<NonNullable<OfficeAvailability['reason']>, string>> = {
  'unsupported-platform': '当前平台暂不支持 Office 文档功能',
  'runtime-missing': '未找到 OfficeCLI 运行时',
  'runtime-invalid': 'OfficeCLI 运行时校验失败',
  'forced-disabled': 'Office 文档功能已由排障开关强制关闭'
}

export function OfficeDocumentsSetting({
  availability,
  saving,
  onChange
}: {
  availability: OfficeAvailability
  saving: boolean
  onChange: (enabled: boolean) => void
}): React.JSX.Element {
  const reason = availability.reason ? unavailableReason[availability.reason] : undefined
  const disabled = saving || reason !== undefined

  return (
    <Box data-phi-office-availability={availability.enabled ? 'enabled' : availability.reason}>
      <FormControlLabel
        disabled={disabled}
        control={
          <Switch
            checked={availability.userEnabled}
            data-phi-office-enabled-setting="true"
            name="officeEnabled"
            onChange={(event) => onChange(event.target.checked)}
          />
        }
        label="Office 文档（Excel / Word / PowerPoint）实时预览与编辑"
      />
      <Typography variant="caption" color="text.secondary" component="div" sx={{ ml: 5.25 }}>
        在应用内预览并编辑 Excel、Word 与 PowerPoint 文档。更改后需重启应用生效。
      </Typography>
      {reason ? (
        <Typography variant="caption" color="warning.main" component="div" sx={{ ml: 5.25 }}>
          {reason}
        </Typography>
      ) : null}
    </Box>
  )
}
