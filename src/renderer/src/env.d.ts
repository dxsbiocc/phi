/// <reference types="vite/client" />

declare module 'plotly.js-dist-min' {
  type PlotlyElement = HTMLElement
  type PlotlyData = unknown[]
  type PlotlyLayout = Record<string, unknown>
  type PlotlyConfig = Record<string, unknown>

  const Plotly: {
    react: (
      element: PlotlyElement,
      data: PlotlyData,
      layout?: PlotlyLayout,
      config?: PlotlyConfig
    ) => Promise<unknown>
    addFrames: (element: PlotlyElement, frames: unknown[]) => Promise<unknown>
    purge: (element: PlotlyElement) => void
  }

  export default Plotly
}
