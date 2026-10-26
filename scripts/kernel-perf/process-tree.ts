import { execFileSync } from 'node:child_process'

export interface ProcessSample {
  readonly pid: number
  readonly ppid: number
  readonly rssMb: number
  readonly command: string
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
  const result = await run("ps -A -o 'pid=,ppid=,rss=,command='")
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
    this.peakMb = Math.max(this.peakMb, rss)
    return rss
  }

  private async loop(): Promise<void> {
    while (this.active) {
      await this.once()
      await new Promise((resolve) => setTimeout(resolve, this.intervalMs))
    }
  }
}
