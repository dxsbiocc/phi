interface ImportMeta {
  readonly dir: string
  readonly path: string
}

declare namespace Bun {
  const argv: string[]
  const version: string

  namespace Build {
    type CompileTarget = 'bun-darwin-arm64' | 'bun-linux-x64-baseline'
  }

  interface PluginBuilder {
    onResolve(
      options: { filter: RegExp },
      callback: () => { path: string; namespace: string }
    ): void
    onLoad(
      options: { filter: RegExp; namespace: string },
      callback: () => { contents: string; loader: string }
    ): void
  }

  interface BunPlugin {
    name: string
    setup(build: PluginBuilder): void
  }

  class Glob {
    constructor(pattern: string)
    scan(options: { cwd: string; onlyFiles: boolean }): AsyncIterable<string>
  }

  function file(path: string): {
    exists(): Promise<boolean>
    json(): Promise<unknown>
  }

  function write(path: string, data: string | ArrayBuffer | Uint8Array): Promise<number>

  function spawn(
    command: string[],
    options: {
      cwd?: string
      env?: NodeJS.ProcessEnv
      stdin?: 'ignore' | 'inherit' | 'pipe'
      stdout?: 'inherit' | 'pipe'
      stderr?: 'inherit' | 'pipe'
    }
  ): { exited: Promise<number> }

  function build(options: Record<string, unknown>): Promise<{
    success: boolean
    logs: Array<{ message: string }>
  }>

  function sleep(milliseconds: number): Promise<void>
}
