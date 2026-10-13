const MAX_PROBE_DETAIL_LENGTH = 4096

export class ConfiguredStdioProbeError extends Error {
  readonly detail?: string

  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'ConfiguredStdioProbeError'
    if (detail) this.detail = detail.slice(0, MAX_PROBE_DETAIL_LENGTH)
  }
}
