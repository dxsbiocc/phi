import { useId, useMemo } from 'react'
import {
  alpha,
  Box,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useTheme
} from '@mui/material'
import { createAppTheme, type ThemeMode } from '../../../theme'
import { createMinimalTheme } from '../../../minimalTheme'
import type { ThemeFamily } from '../../../useThemeMode'

interface AppearanceSettingsSectionProps {
  mode: ThemeMode
  onSelectMode: (mode: ThemeMode) => void
  family: ThemeFamily
  onSelectFamily: (family: ThemeFamily) => void
}

export function AppearanceSettingsSection({
  mode,
  onSelectMode,
  family,
  onSelectFamily
}: AppearanceSettingsSectionProps): React.JSX.Element {
  const theme = useTheme()
  const familyLabelId = useId()
  const previews = useMemo(() => {
    return [
      { family: 'default' as const, label: '默认', theme: createAppTheme(theme.palette.mode) },
      {
        family: 'minimal' as const,
        label: 'Minimal 风格',
        theme: createMinimalTheme(theme.palette.mode)
      }
    ]
  }, [theme.palette.mode])

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">外观</Typography>
        <Typography variant="body2" color="text.secondary">
          选择界面主题。
        </Typography>
      </Box>

      <FormControl sx={{ width: '100%', maxWidth: 440 }}>
        <FormLabel id={familyLabelId} sx={{ mb: 1.25, typography: 'body2' }}>
          主题风格
        </FormLabel>
        <RadioGroup
          aria-labelledby={familyLabelId}
          name="theme-family"
          value={family}
          onChange={(_, next) => {
            if (next === 'default' || next === 'minimal') onSelectFamily(next)
          }}
          sx={{ gap: 1.25 }}
        >
          {previews.map(({ family: optionFamily, label, theme: preview }) => (
            <FormControlLabel
              key={optionFamily}
              value={optionFamily}
              control={<Radio size="small" sx={{ p: 0.75 }} />}
              label={
                <Stack
                  direction="row"
                  spacing={1.5}
                  sx={{ alignItems: 'center', justifyContent: 'space-between', width: '100%' }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {label}
                  </Typography>
                  <Stack direction="row" spacing={0.75} aria-hidden="true" sx={{ flexShrink: 0 }}>
                    {[
                      preview.palette.primary.main,
                      preview.palette.background.default,
                      preview.palette.info.main,
                      preview.palette.warning.main,
                      preview.palette.error.main
                    ].map((color, index) => (
                      <Box
                        key={index}
                        sx={{
                          width: 18,
                          height: 18,
                          borderRadius: '50%',
                          bgcolor: color,
                          border: '1px solid',
                          borderColor: alpha(preview.palette.text.primary, 0.14)
                        }}
                      />
                    ))}
                  </Stack>
                </Stack>
              }
              sx={{
                m: 0,
                px: 1.25,
                py: 1,
                minHeight: 60,
                border: '1px solid',
                borderRadius: 1.5,
                borderColor: family === optionFamily ? 'primary.main' : 'divider',
                bgcolor:
                  family === optionFamily ? alpha(theme.palette.primary.main, 0.06) : 'transparent',
                '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.08) },
                '&:has(input:focus-visible)': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 2
                },
                '& .MuiFormControlLabel-label': { flex: 1, minWidth: 0, ml: 0.75 }
              }}
            />
          ))}
        </RadioGroup>
      </FormControl>

      <Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          明暗
        </Typography>
        <ToggleButtonGroup
          exclusive
          value={mode}
          onChange={(_, next: ThemeMode | null) => {
            if (next) onSelectMode(next)
          }}
        >
          <ToggleButton value="light" sx={{ minHeight: 44, px: 2 }}>
            浅色
          </ToggleButton>
          <ToggleButton value="dark" sx={{ minHeight: 44, px: 2 }}>
            深色
          </ToggleButton>
          <ToggleButton value="system" sx={{ minHeight: 44, px: 2 }}>
            跟随系统
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>
    </Stack>
  )
}
