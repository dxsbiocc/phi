import type { GithubPackageDiscovery } from './github-source'

export class NoGithubMcpPackagesError extends Error {
  constructor(
    readonly srcDir: string,
    readonly discovery: GithubPackageDiscovery
  ) {
    super('GitHub 仓库没有可导入的 MCP 连接器')
    this.name = 'NoGithubMcpPackagesError'
  }
}
