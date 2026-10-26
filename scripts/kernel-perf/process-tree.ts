import { execFileSync } from 'node:child_process'

export interface ProcessSample {
  readonly pid: number
  readonly ppid: number
  readonly rssMb: number
  readonly command: string
}

export function selectRemoteKernelPid(input: {
  readonly runtimePid?: number
  readonly helperPid?: number
}): number {
  if (Number.isSafeInteger(input.runtimePid) && input.runtimePid! > 0) return input.runtimePid!
  if (Number.isSafeInteger(input.helperPid) && input.helperPid! > 0) return input.helperPid!
  throw new Error('Remote kernel did not report a usable runtime or helper PID.')
}

function parseProcesses(output: string): ProcessSample[] {
  return output
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssMb: Number(match[3]) / 1024,
      command: match[4]
    }))
}

export function descendants(processes: readonly ProcessSample[], rootPid: number): ProcessSample[] {
  const seen = new Set<number>([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const process of processes) {
      if (seen.has(process.ppid) && !seen.has(process.pid)) {
        seen.add(process.pid)
        changed = true
      }
    }
  }
  return processes.filter((process) => process.pid !== rootPid && seen.has(process.pid))
}

export function localProcessTree(rootPid: number): ProcessSample[] {
  const output = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const all = parseProcesses(output)
  return [...all.filter((process) => process.pid === rootPid), ...descendants(all, rootPid)].filter(
    (process) => !/(^|\/)ps(?:\s|$)/u.test(process.command)
  )
}

export async function remoteProcessTree(
  rootPid: number,
  run: (command: string) => Promise<{ stdout: string; stderr: string; code: number | null }>
): Promise<ProcessSample[]> {
  // Separate -o columns: older procps (CentOS 7) reads `pid=,ppid=,...` as one PID column.
  const result = await run('ps -u "$(id -u)" -o pid= -o ppid= -o rss= -o args=')
  if (result.code !== 0) throw new Error(result.stderr || 'remote ps failed')
  const all = parseProcesses(result.stdout)
  return [...all.filter((process) => process.pid === rootPid), ...descendants(all, rootPid)].filter(
    (process) => !/(^|\/)ps(?:\s|$)/u.test(process.command)
  )
}

export function treeRssMb(processes: readonly ProcessSample[], root?: ProcessSample): number {
  return (
    Math.round(
      ((root?.rssMb ?? 0) + processes.reduce((sum, process) => sum + process.rssMb, 0)) * 10
    ) / 10
  )
}

export class PeakTreeSampler {
  private active = false
  private running?: Promise<void>
  peakMb = 0
  peakTree: ProcessSample[] = []
  latest: ProcessSample[] = []

  constructor(
    private readonly sample: () => ProcessSample[] | Promise<ProcessSample[]>,
    private readonly rootPid?: number,
    private readonly intervalMs = 50
  ) {}

  start(): void {
    if (this.active) return
    this.active = true
    this.running = this.loop()
  }

  async stop(): Promise<void> {
    this.active = false
    await this.running
  }

  async once(): Promise<number> {
    const processes = await this.sample()
    this.latest = processes
    const root = this.rootPid
      ? processes.find((process) => process.pid === this.rootPid)
      : undefined
    if (this.rootPid && !root) {
      throw new Error(`Process-tree root ${this.rootPid} was not present in the ps sample.`)
    }
    const rss = treeRssMb(
      root ? processes.filter((process) => process.pid !== root.pid) : processes,
      root
    )
    if (rss > this.peakMb || (rss === this.peakMb && processes.length > this.peakTree.length)) {
      this.peakMb = rss
      this.peakTree = [...processes]
    }
    return rss
  }

  private async loop(): Promise<void> {
    while (this.active) {
      await this.once()
      await new Promise((resolve) => setTimeout(resolve, this.intervalMs))
    }
  }
}
