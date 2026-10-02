export interface McpServerSummary {
  id: string
  name: string
  connectorId?: string
  packageId?: string
  category?: string
  command?: string
  args?: string[]
  envKeys?: string[]
  url?: string
  transport?: string
  sourcePath?: string
  managed?: boolean
  enabled?: boolean
  status: 'configured'
}
