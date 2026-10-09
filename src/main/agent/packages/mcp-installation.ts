import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildEnvironment } from '../content/environment-refs'
import { acquireEnvironmentLease, type EnvironmentLease } from '../envs/leases'
import { getRuntimeRoot } from '../envs/runtime'
import { managedStdioServer } from '../mcp/stdio-environment'
import { describeMcpPackageEnvironment } from '../mcp/package-environment'
import { readPackageManifest } from './manifest'
import type { InstallerOptions, StagedPackage } from './installer-types'

/** Provision and prove a new application before any installed version is switched. */
export async function prepareStagedMcpApplication(
  staged: StagedPackage,
  options: InstallerOptions & { agentDir: string }
): Promise<EnvironmentLease | undefined> {
  if (staged.entry.type !== 'mcp') return
  const manifest = readPackageManifest(staged.dir)
  if (manifest.type !== 'mcp' || manifest.connector.transport !== 'stdio') return
  const environment = describeMcpPackageEnvironment(manifest, staged.dir, options)
  if (!environment?.descriptor.spec.installation) return
  if (!options.verifyMcpStdio) throw new Error('托管连接器安装需要 MCP 启动验证器')
  const snapshot = packageFingerprint(staged.dir)
  const root = options.runtimeRoot ?? getRuntimeRoot(options.agentDir)
  const build = options.buildMcpEnvironment ?? ((descriptor) => buildEnvironment(root, descriptor))
  const built = await build(environment.descriptor)
  const lease = await acquireEnvironmentLease({ root, envId: built.envId })
  try {
    const { entry } = managedStdioServer({
      root,
      agentDir: options.agentDir,
      environmentsDir: options.environmentsDir,
      platform: options.platform,
      ref: manifest.connector.environment,
      command: manifest.connector.command,
      args: manifest.connector.args ?? [],
      cwd: staged.dir,
      packageId: manifest.id,
      packageDir: staged.dir,
      baseEnv: options.baseEnv
    })
    await options.verifyMcpStdio({
      name: manifest.id,
      entry: { ...entry, phiPackage: manifest.id },
      environment: {
        root,
        agentDir: options.agentDir,
        ...(options.environmentsDir ? { environmentsDir: options.environmentsDir } : {}),
        ...(options.platform ? { platform: options.platform } : {})
      }
    })
    if (packageFingerprint(staged.dir) !== snapshot) {
      throw new Error('连接器启动验证修改了已校验的内容包；不会激活这个版本')
    }
    // The installer retains this claim through dependency activation and rollback.
    return lease
  } catch (error) {
    lease.release()
    throw error
  }
}

function packageFingerprint(root: string): string {
  const hash = createHash('sha256')
  let count = 0
  let bytes = 0
  function visit(dir: string, relative: string): void {
    for (const name of readdirSync(dir).sort()) {
      if (++count > 20_000) throw new Error('连接器文件数超过验证限制')
      const path = join(dir, name)
      const key = relative ? `${relative}/${name}` : name
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('连接器验证内容不能包含符号链接')
      if (stat.isDirectory()) visit(path, key)
      else if (stat.isFile()) {
        bytes += stat.size
        if (bytes > 512 * 1024 * 1024) throw new Error('连接器内容超过验证大小限制')
        hash.update(`${key}\0${stat.size}\0`)
        hash.update(readFileSync(path))
      } else throw new Error('连接器验证内容包含特殊文件')
    }
  }
  visit(root, '')
  return hash.digest('hex')
}
