import { alpha, type ThemeOptions } from '@mui/material'

import { pxToRem } from './typography'
import { MINIMAL_GREY, SEMANTIC_SCALES, type SemanticColor } from './tokens'

const SEMANTIC_COLORS = Object.keys(SEMANTIC_SCALES) as SemanticColor[]

/**
 * Component overrides for the Minimal style. Coverage is driven by what the
 * app actually renders (see the component-usage survey in the style reference
 * doc), not by an exhaustive component list.
 */
export function buildMinimalComponents(isDark: boolean): ThemeOptions['components'] {
  const inkPrimary = isDark ? '#FFFFFF' : MINIMAL_GREY[800]
  const inkOnDark = isDark ? MINIMAL_GREY[800] : '#FFFFFF'

  return {
    MuiCssBaseline: {
      styleOverrides: {
        '::-webkit-scrollbar': { width: 6, height: 6 },
        '::-webkit-scrollbar-thumb': {
          backgroundColor: alpha(MINIMAL_GREY[500], 0.32),
          borderRadius: 8
        },
        '::-webkit-scrollbar-track': { backgroundColor: 'transparent' }
      }
    },

    // -- Surfaces -----------------------------------------------------------

    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none' }
      }
    },
    MuiCard: {
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: 16,
          boxShadow: theme.customShadows.card
        })
      }
    },
    MuiCardHeader: {
      styleOverrides: {
        root: { padding: '24px 24px 0' },
        title: { fontSize: pxToRem(18), fontWeight: 600 },
        subheader: { fontSize: pxToRem(14) }
      }
    },
    MuiCardContent: {
      styleOverrides: {
        root: { padding: 24, '&:last-child': { paddingBottom: 24 } }
      }
    },
    MuiAccordion: {
      styleOverrides: {
        root: ({ theme }) => ({
          boxShadow: 'none',
          border: `1px solid ${theme.palette.divider}`,
          // Connected stacking: only the outer ends are rounded.
          borderRadius: 0,
          '&:first-of-type': {
            borderTopLeftRadius: 12,
            borderTopRightRadius: 12
          },
          '&:last-of-type': {
            borderBottomLeftRadius: 12,
            borderBottomRightRadius: 12
          },
          '&:not(:last-child)': { borderBottom: 0 },
          '&:before': { display: 'none' },
          '&.Mui-expanded': { margin: 0 }
        })
      }
    },
    MuiAccordionSummary: {
      styleOverrides: {
        root: ({ theme }) => ({
          minHeight: 48,
          padding: '0 16px',
          borderRadius: 'inherit',
          transition: theme.transitions.create(['background-color']),
          '&:hover': { backgroundColor: theme.palette.action.hover },
          '&.Mui-expanded': { minHeight: 48 }
        }),
        content: {
          margin: '12px 0',
          '&.Mui-expanded': { margin: '12px 0' }
        },
        expandIconWrapper: ({ theme }) => ({
          color: theme.palette.action.active
        })
      }
    },
    MuiAccordionDetails: {
      styleOverrides: {
        root: { padding: '0 16px 16px' }
      }
    },

    // -- Buttons ------------------------------------------------------------

    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 700,
          borderRadius: 8
        },
        sizeMedium: { padding: '6px 12px', fontSize: pxToRem(14) },
        sizeSmall: { padding: '4px 8px', fontSize: pxToRem(13) },
        sizeLarge: { padding: '10px 20px', fontSize: pxToRem(15) }
      },
      variants: [
        // The style's default "primary action" is a dark charcoal button,
        // not a colored one — colored contained buttons are used sparingly.
        {
          props: { variant: 'contained', color: 'inherit' },
          style: {
            backgroundColor: inkPrimary,
            color: inkOnDark,
            '&:hover': {
              backgroundColor: isDark ? MINIMAL_GREY[300] : MINIMAL_GREY[700]
            }
          }
        },
        {
          props: { variant: 'outlined', color: 'inherit' },
          style: {
            borderColor: alpha(MINIMAL_GREY[500], 0.32),
            color: inkPrimary,
            '&:hover': {
              borderColor: inkPrimary,
              backgroundColor: 'transparent'
            }
          }
        },
        // Soft button: tinted background + dark-shade text.
        ...SEMANTIC_COLORS.map((color) => ({
          props: { variant: 'soft' as const, color },
          style: {
            backgroundColor: isDark
              ? alpha(SEMANTIC_SCALES[color].main, 0.16)
              : SEMANTIC_SCALES[color].lighter,
            color: isDark ? SEMANTIC_SCALES[color].light : SEMANTIC_SCALES[color].darker,
            '&:hover': {
              backgroundColor: isDark
                ? alpha(SEMANTIC_SCALES[color].main, 0.32)
                : SEMANTIC_SCALES[color].light
            }
          }
        }))
      ]
    },
    MuiIconButton: {
      styleOverrides: {
        root: ({ theme }) => ({
          color: isDark ? MINIMAL_GREY[500] : theme.palette.action.active,
          '&:hover': { backgroundColor: theme.palette.action.hover }
        })
      }
    },
    MuiToggleButton: {
      styleOverrides: {
        root: ({ theme }) => ({
          textTransform: 'none',
          fontWeight: 600,
          borderColor: theme.palette.divider,
          color: theme.palette.text.secondary,
          '&.Mui-selected': {
            backgroundColor: inkPrimary,
            color: inkOnDark,
            '&:hover': {
              backgroundColor: isDark ? MINIMAL_GREY[300] : MINIMAL_GREY[700]
            }
          }
        })
      }
    },

    // -- Chips & labels -----------------------------------------------------

    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 10, fontWeight: 500 }
      },
      variants: [
        // Soft chip — the status-label look: light tint + dark-shade text.
        {
          props: { variant: 'soft', color: 'default' },
          style: {
            backgroundColor: alpha(MINIMAL_GREY[500], 0.16),
            color: isDark ? MINIMAL_GREY[300] : MINIMAL_GREY[700]
          }
        },
        ...SEMANTIC_COLORS.map((color) => ({
          props: { variant: 'soft' as const, color },
          style: {
            backgroundColor: isDark
              ? alpha(SEMANTIC_SCALES[color].main, 0.16)
              : SEMANTIC_SCALES[color].lighter,
            color: isDark ? SEMANTIC_SCALES[color].light : SEMANTIC_SCALES[color].darker
          }
        }))
      ]
    },

    // -- Overlays: menus, popovers, dialogs, tooltips ------------------------

    MuiMenu: {
      styleOverrides: {
        paper: ({ theme }) => ({
          borderRadius: 12,
          boxShadow: theme.customShadows.dropdown,
          // Frosted glass: translucent surface + backdrop blur.
          backgroundColor: alpha(theme.palette.background.paper, isDark ? 0.85 : 0.9),
          backdropFilter: 'blur(20px) saturate(1.5)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.5)'
        }),
        list: { padding: 8 }
      }
    },
    MuiPopover: {
      styleOverrides: {
        paper: ({ theme }) => ({
          borderRadius: 12,
          boxShadow: theme.customShadows.dropdown,
          backgroundColor: alpha(theme.palette.background.paper, isDark ? 0.85 : 0.9),
          backdropFilter: 'blur(20px) saturate(1.5)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.5)'
        })
      }
    },
    MuiMenuItem: {
      styleOverrides: {
        root: ({ theme }) => ({
          fontSize: pxToRem(14),
          minHeight: 'auto',
          padding: '8px 12px',
          borderRadius: 8,
          '&:hover': { backgroundColor: theme.palette.action.hover },
          '&.Mui-selected': {
            color: theme.palette.primary.main,
            backgroundColor: alpha(theme.palette.primary.main, 0.08),
            '&:hover': {
              backgroundColor: alpha(theme.palette.primary.main, 0.16)
            }
          }
        })
      }
    },
    MuiDialog: {
      styleOverrides: {
        paper: ({ theme }) => ({
          borderRadius: 16,
          boxShadow: theme.customShadows.dialog
        })
      }
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: {
          fontSize: pxToRem(18),
          fontWeight: 600,
          padding: '24px 24px 16px'
        }
      }
    },
    MuiDialogContent: {
      styleOverrides: {
        root: {
          padding: 24,
          '.MuiDialogTitle-root + &': { paddingTop: 8 }
        }
      }
    },
    MuiDialogContentText: {
      styleOverrides: {
        root: ({ theme }) => ({
          fontSize: pxToRem(14),
          color: theme.palette.text.secondary
        })
      }
    },
    MuiDialogActions: {
      styleOverrides: {
        root: { padding: '16px 24px 24px' }
      }
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: inkPrimary,
          color: inkOnDark,
          fontSize: pxToRem(12),
          fontWeight: 500,
          borderRadius: 8,
          padding: '6px 10px'
        },
        arrow: { color: inkPrimary }
      }
    },
    MuiSnackbarContent: {
      styleOverrides: {
        root: {
          backgroundColor: inkPrimary,
          color: inkOnDark,
          fontWeight: 500,
          borderRadius: 8
        }
      }
    },

    // -- Feedback ------------------------------------------------------------

    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 8 }
      },
      // Alert only supports the four feedback colors.
      variants: (['success', 'info', 'warning', 'error'] as const).map((color) => ({
        props: { variant: 'standard' as const, color },
        style: {
          backgroundColor: isDark
            ? alpha(SEMANTIC_SCALES[color].main, 0.16)
            : SEMANTIC_SCALES[color].lighter,
          color: isDark ? SEMANTIC_SCALES[color].light : SEMANTIC_SCALES[color].darker,
          '& .MuiAlert-icon': {
            color: isDark ? SEMANTIC_SCALES[color].light : SEMANTIC_SCALES[color].main
          }
        }
      }))
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { height: 6, borderRadius: 6 },
        colorPrimary: ({ theme }) => ({
          backgroundColor: alpha(theme.palette.primary.main, 0.16)
        }),
        bar: { borderRadius: 6 }
      }
    },

    // -- Inputs ----------------------------------------------------------------

    MuiInputBase: {
      styleOverrides: {
        root: { fontSize: pxToRem(14) }
      }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: 8,
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: theme.palette.divider
          },
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: alpha(MINIMAL_GREY[500], 0.48)
          }
        })
      }
    },
    MuiFilledInput: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          backgroundColor: alpha(MINIMAL_GREY[500], 0.08),
          '&:before, &:after': { display: 'none' },
          '&:hover': { backgroundColor: alpha(MINIMAL_GREY[500], 0.16) }
        }
      }
    },
    MuiInputLabel: {
      styleOverrides: {
        root: { fontSize: pxToRem(15), color: MINIMAL_GREY[500] }
      }
    },
    MuiSelect: {
      styleOverrides: {
        icon: ({ theme }) => ({ color: theme.palette.action.active })
      }
    },

    // -- Navigation & lists -----------------------------------------------------

    MuiTabs: {
      styleOverrides: {
        indicator: {
          height: 4,
          borderRadius: 4,
          backgroundColor: inkPrimary
        }
      }
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontSize: pxToRem(14),
          fontWeight: 600,
          minHeight: 48,
          minWidth: 'auto',
          padding: '12px 0',
          '&:not(:last-of-type)': { marginRight: 24 },
          '&.Mui-selected': { color: inkPrimary }
        }
      }
    },
    MuiListItemButton: {
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: 8,
          padding: '8px 12px',
          '&.Mui-selected': {
            color: theme.palette.primary.main,
            backgroundColor: alpha(theme.palette.primary.main, 0.08),
            '&:hover': {
              backgroundColor: alpha(theme.palette.primary.main, 0.16)
            },
            '& .MuiListItemIcon-root': { color: 'inherit' }
          }
        })
      }
    },
    MuiListItemIcon: {
      styleOverrides: {
        root: { minWidth: 36 }
      }
    },
    MuiListItemText: {
      styleOverrides: {
        primary: { fontSize: pxToRem(14), fontWeight: 500 },
        secondary: { fontSize: pxToRem(12) }
      }
    },
    MuiListSubheader: {
      styleOverrides: {
        root: ({ theme }) => ({
          fontSize: pxToRem(12),
          fontWeight: 700,
          lineHeight: '30px',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: theme.palette.text.secondary,
          backgroundColor: 'transparent'
        })
      }
    },
    MuiLink: {
      defaultProps: { underline: 'hover' }
    },

    // -- Data display -----------------------------------------------------------

    MuiTableCell: {
      styleOverrides: {
        root: ({ theme }) => ({
          fontSize: pxToRem(14),
          padding: 16,
          // Signature detail: dashed row dividers instead of solid lines.
          borderBottom: `1px dashed ${theme.palette.divider}`
        }),
        head: ({ theme }) => ({
          fontWeight: 600,
          lineHeight: '24px',
          color: theme.palette.text.secondary,
          backgroundColor: isDark ? alpha(MINIMAL_GREY[500], 0.08) : MINIMAL_GREY[200],
          borderBottom: 'none'
        })
      }
    },
    MuiTableRow: {
      styleOverrides: {
        root: ({ theme }) => ({
          '&:hover': { backgroundColor: theme.palette.action.hover }
        })
      }
    }
  }
}
