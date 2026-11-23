import {
  FAST_PROBE_END_SENTINEL,
  FAST_PROBE_START_SENTINEL,
  SLOW_PROBE_END_SENTINEL,
  SLOW_PROBE_START_SENTINEL
} from '../../src/main/agent/workspace-host/probe-script'

export function completeProbeOutput(rows: string): string {
  return [
    FAST_PROBE_START_SENTINEL,
    rows.trim(),
    'probe.fast_complete=1',
    FAST_PROBE_END_SENTINEL,
    SLOW_PROBE_START_SENTINEL,
    'probe.slow_complete=1',
    SLOW_PROBE_END_SENTINEL
  ].join('\n')
}

export function fastProbeOutput(rows: string, complete = true): string {
  return [
    FAST_PROBE_START_SENTINEL,
    rows.trim(),
    ...(complete ? ['probe.fast_complete=1'] : []),
    FAST_PROBE_END_SENTINEL
  ].join('\n')
}
