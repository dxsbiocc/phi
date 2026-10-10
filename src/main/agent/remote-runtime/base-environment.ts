import { describeEnvironment } from '../content/environment-refs'
import { parseEnvironmentRef } from '../envs'

export async function resolveRemoteBaseEnvironment(
  ref: string,
  pluginId: string | undefined,
  agentDir: string
): Promise<{ packages: readonly string[]; channels: readonly string[] }> {
  const parsed = parseEnvironmentRef(ref)
  if (parsed.kind === 'project') {
    throw new Error(
      '远程 env_request 无法安全读取本机项目级环境声明；请改用 phi: 基础环境，或先在可联网机器构建并迁移。没有回退到本机项目目录。'
    )
  }
  if (parsed.kind === 'plugin' && !pluginId) {
    throw new Error(
      '远程主会话不能推断 plugin: 环境的所属插件；请在对应插件专家会话中调用 env_request，或改用 phi: 基础环境。没有回退到本机。'
    )
  }
  const descriptor = describeEnvironment(ref, {
    agentDir,
    ...(pluginId ? { pluginId } : {})
  })
  if (descriptor.spec.dependencies.some((dependency) => typeof dependency !== 'string')) {
    throw new Error('远程 env_request 暂不支持含 pip 依赖的基础环境；请先在可联网机器构建后迁移。')
  }
  if (descriptor.spec.sourcePackages?.length) {
    throw new Error(
      '远程 env_request 暂不支持需要额外源码包的基础环境；请先在可联网机器构建后迁移，且没有回退到本机。'
    )
  }
  return {
    packages: descriptor.spec.dependencies as string[],
    channels: descriptor.spec.channels
  }
}
