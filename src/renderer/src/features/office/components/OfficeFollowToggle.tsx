import { Box, FormControlLabel, Switch } from '@mui/material'

export function OfficeFollowToggle({
  enabled,
  onChange
}: {
  readonly enabled: boolean
  readonly onChange: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    <Box
      data-phi-office-follow-toggle="true"
      sx={{ px: 1.5, py: 0.25, borderBottom: 1, borderColor: 'divider' }}
    >
      <FormControlLabel
        control={
          <Switch
            checked={enabled}
            onChange={(_event, checked) => onChange(checked)}
            size="small"
            slotProps={{ input: { 'aria-label': '跟随 AI' } }}
          />
        }
        label="跟随 AI"
        sx={{ m: 0 }}
      />
    </Box>
  )
}
