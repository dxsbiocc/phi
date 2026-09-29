/* eslint-disable react-refresh/only-export-components -- React error boundaries still require a class component. */
import { Component, type ErrorInfo, type ReactNode } from 'react'

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
  const details = [componentStack, error.stack || error.message].filter(Boolean).join('\n\n')

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: '#0B262D',
        color: '#F1F6F6',
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
      }}
    >
      <section
        role="alert"
        aria-live="assertive"
        style={{
          width: 'min(720px, 100%)',
          border: '1px solid rgba(241, 246, 246, 0.18)',
          borderRadius: 8,
          background: '#123640',
          padding: 24,
          boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)'
        }}
      >
        <p style={{ margin: 0, fontSize: 14, color: '#9FB8BC' }}>Renderer crashed</p>
        <h1 style={{ margin: '8px 0 12px', fontSize: 22, fontWeight: 700 }}>界面渲染遇到错误</h1>
        <p style={{ margin: '0 0 18px', color: '#C9D8DA', lineHeight: 1.6 }}>
          Phi 没有退出，但当前窗口的 React
          界面被运行时异常中断了。可以先重试渲染，若仍失败请重新载入窗口。
        </p>
        <pre
          style={{
            maxHeight: 240,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            margin: '0 0 18px',
            padding: 14,
            borderRadius: 6,
            background: 'rgba(0, 0, 0, 0.22)',
            color: '#F1F6F6',
            fontSize: 12,
            lineHeight: 1.5
          }}
        >
          {details || error.message}
        </pre>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onRetry}
            style={{
              minHeight: 36,
              border: 0,
              borderRadius: 6,
              padding: '0 14px',
              background: '#2E9FB3',
              color: '#FFFFFF',
              fontWeight: 700,
              cursor: 'pointer'
            }}
          >
            重试渲染
          </button>
          <button
            type="button"
            onClick={onReload}
            style={{
              minHeight: 36,
              border: '1px solid rgba(241, 246, 246, 0.24)',
              borderRadius: 6,
              padding: '0 14px',
              background: 'transparent',
              color: '#F1F6F6',
              cursor: 'pointer'
            }}
          >
            重新载入窗口
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
