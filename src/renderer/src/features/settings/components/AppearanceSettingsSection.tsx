import { useId } from 'react'
import {
  alpha,
  Box,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  Typography,
  useTheme
} from '@mui/material'

import type { ThemeMode } from '../../../theme'
import {
  isThemePaletteId,
  THEME_PALETTES,
  themePalettePreviewColors,
  type ThemePaletteId
} from '../../../themePalettes'

interface AppearanceSettingsSectionProps {
  mode: ThemeMode
  onSelectMode: (mode: ThemeMode) => void
  palette: ThemePaletteId
  onSelectPalette: (palette: ThemePaletteId) => void
}

const MODE_OPTIONS: readonly { value: ThemeMode; label: string; description: string }[] = [
  { value: 'light', label: '浅色', description: '始终使用浅色界面' },
  { value: 'dark', label: '深色', description: '始终使用深色界面' },
  { value: 'system', label: '跟随系统', description: '自动匹配系统外观' }
]

export function AppearanceSettingsSection({
  mode,
  onSelectMode,
  palette,
  onSelectPalette
}: AppearanceSettingsSectionProps): React.JSX.Element {
  const theme = useTheme()
  const paletteLabelId = useId()
  const modeLabelId = useId()

  return (
    <Stack spacing={3} sx={{ width: '100%', maxWidth: 760 }}>
      <Box>
        <Typography variant="h5">外观</Typography>
        <Typography variant="body2" color="text.secondary">
          选择 Minimal 界面配色与明暗模式。
        </Typography>
      </Box>

      <FormControl sx={{ width: '100%' }}>
        <FormLabel id={paletteLabelId} sx={{ mb: 1.25, typography: 'body2' }}>
          配色
        </FormLabel>
        <RadioGroup
          aria-labelledby={paletteLabelId}
          name="theme-palette"
          value={palette}
          onChange={(_, next) => {
            if (isThemePaletteId(next)) onSelectPalette(next)
          }}
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
            gap: 1
          }}
        >
          {THEME_PALETTES.map((option) => (
            <FormControlLabel
              key={option.id}
              value={option.id}
              control={<Radio size="small" sx={{ p: 0.75 }} />}
              label={
                <Stack
                  direction="row"
                  spacing={1.25}
                  sx={{ alignItems: 'center', justifyContent: 'space-between', width: '100%' }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {option.label}
                  </Typography>
                  <Stack direction="row" spacing={0.5} aria-hidden="true" sx={{ flexShrink: 0 }}>
                    {themePalettePreviewColors(option).map((color) => (
                      <Box
                        key={color}
                        sx={{
                          width: 16,
                          height: 16,
                          borderRadius: '50%',
                          bgcolor: color,
                          border: '1px solid',
                          borderColor: alpha(theme.palette.text.primary, 0.15)
                        }}
                      />
                    ))}
                  </Stack>
                </Stack>
              }
              sx={{
                m: 0,
                px: 1.25,
                py: 0.75,
                minHeight: 56,
                border: '1px solid',
                borderRadius: 1.5,
                borderColor: palette === option.id ? 'primary.main' : 'divider',
                bgcolor:
                  palette === option.id ? alpha(theme.palette.primary.main, 0.07) : 'transparent',
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

      <FormControl sx={{ width: '100%' }}>
        <FormLabel id={modeLabelId} sx={{ mb: 1.25, typography: 'body2' }}>
          明暗
        </FormLabel>
        <RadioGroup
          row
          aria-labelledby={modeLabelId}
          name="theme-mode"
          value={mode}
          onChange={(_, next) => {
            if (next === 'light' || next === 'dark' || next === 'system') onSelectMode(next)
          }}
          sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1 }}
        >
          {MODE_OPTIONS.map((option) => (
            <FormControlLabel
              key={option.value}
              value={option.value}
              control={<Radio size="small" sx={{ p: 0.75 }} />}
              label={
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {option.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {option.description}
                  </Typography>
                </Box>
              }
              sx={{
                m: 0,
                px: 1.25,
                py: 0.75,
                minHeight: 58,
                border: '1px solid',
                borderRadius: 1.5,
                borderColor: mode === option.value ? 'primary.main' : 'divider',
                bgcolor:
                  mode === option.value ? alpha(theme.palette.primary.main, 0.07) : 'transparent',
                '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.08) },
                '&:has(input:focus-visible)': {
                  outline: '2px solid',
                  outlineColor: 'primary.main',
                  outlineOffset: 2
                },
                '& .MuiFormControlLabel-label': { ml: 0.75, minWidth: 0 }
              }}
            />
          ))}
        </RadioGroup>
      </FormControl>
    </Stack>
  )
}
