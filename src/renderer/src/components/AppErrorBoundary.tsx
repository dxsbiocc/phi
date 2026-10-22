/* eslint-disable react-refresh/only-export-components -- React error boundaries still require a class component. */
import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { appCopy } from '../lib/appCopy'
import { useUiLanguage } from '../lib/i18n'
import { createPaletteTheme } from '../theme'
import { readStoredThemeSelection } from '../useThemeMode'

function crashSurface(): {
  page: CSSProperties
  card: CSSProperties
  muted: string
  body: string
  pre: CSSProperties
  primary: CSSProperties
  secondary: CSSProperties
} {
  const selection = readStoredThemeSelection()
  const theme = createPaletteTheme(selection.effectiveMode, selection.palette)
  const text = theme.palette.text.primary
  const muted = theme.palette.text.secondary
  return {
    page: {
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      background: theme.palette.background.default,
      color: text,
      fontFamily: theme.typography.fontFamily
    },
    card: {
      width: 'min(720px, 100%)',
      border: `1px solid ${theme.palette.divider}`,
      borderRadius: theme.shape.borderRadius,
      background: theme.palette.background.paper,
      padding: 24,
      boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)'
    },
    muted,
    body: muted,
    pre: {
      maxHeight: 240,
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      margin: '0 0 18px',
      padding: 14,
      borderRadius: 6,
      background: theme.palette.mode === 'dark' ? 'rgba(0, 0, 0, 0.28)' : 'rgba(28, 37, 46, 0.06)',
      color: text,
      fontSize: 12,
      lineHeight: 1.5
    },
    primary: {
      minHeight: 36,
      border: 0,
      borderRadius: 6,
      padding: '0 14px',
      background: theme.palette.primary.main,
      color: theme.palette.primary.contrastText,
      fontWeight: 700,
      cursor: 'pointer'
    },
    secondary: {
      minHeight: 36,
      border: `1px solid ${theme.palette.divider}`,
      borderRadius: 6,
      padding: '0 14px',
      background: 'transparent',
      color: text,
      cursor: 'pointer'
    }
  }
}

type AppErrorBoundaryProps = {
  children: ReactNode
}

type AppErrorBoundaryState = {
  error: Error | null
  componentStack: string
}

function errorFromUnknown(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === 'string' ? value : 'Unknown renderer error')
}

function AppErrorFallback({
  error,
  componentStack,
  onRetry,
  onReload
}: {
  error: Error
  componentStack: string
  onRetry: () => void
  onReload: () => void
}): React.JSX.Element {
  useUiLanguage()
  const surface = crashSurface()
  const details = [componentStack, error.stack || error.message].filter(Boolean).join('\n\n')

  return (
    <main style={surface.page}>
      <section role="alert" aria-live="assertive" style={surface.card}>
        <p style={{ margin: 0, fontSize: 14, color: surface.muted }}>{appCopy.crashLabel}</p>
        <h1 style={{ margin: '8px 0 12px', fontSize: 22, fontWeight: 700 }}>
          {appCopy.crashTitle}
        </h1>
        <p style={{ margin: '0 0 18px', color: surface.body, lineHeight: 1.6 }}>
          {appCopy.crashBody}
        </p>
        <pre style={surface.pre}>{details || error.message}</pre>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button type="button" onClick={onRetry} style={surface.primary}>
            {appCopy.retryRender}
          </button>
          <button type="button" onClick={onReload} style={surface.secondary}>
            {appCopy.reloadWindow}
          </button>
        </div>
      </section>
    </main>
  )
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
    componentStack: ''
  }

  static getDerivedStateFromError(error: unknown): Partial<AppErrorBoundaryState> {
    return { error: errorFromUnknown(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer render error:', error, info)
    this.setState({ componentStack: info.componentStack ?? '' })
  }

  private readonly retryRender = (): void => {
    this.setState({ error: null, componentStack: '' })
  }

  private readonly reloadWindow = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    const { error, componentStack } = this.state
    if (error) {
      return (
        <AppErrorFallback
          error={error}
          componentStack={componentStack}
          onRetry={this.retryRender}
          onReload={this.reloadWindow}
        />
      )
    }

    return this.props.children
  }
}
