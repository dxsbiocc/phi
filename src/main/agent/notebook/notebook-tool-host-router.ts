import type {
  NotebookRemoteProjectIdentity,
  NotebookToolDispatchControl,
  NotebookToolHostExecutor,
  NotebookToolRequest
} from './notebook-tools'

type RemoteNotebookToolBackend = {
  projectCwd: string
  execute: NotebookToolHostExecutor
}

type NotebookToolHostRouterOptions = {
  local: NotebookToolHostExecutor
  isRemoteCwd: (cwd: string) => boolean
  resolveRemote: (
    identity: NotebookRemoteProjectIdentity
  ) => Promise<RemoteNotebookToolBackend | null | undefined>
}

export class NotebookToolHostRouter {
  constructor(private readonly options: NotebookToolHostRouterOptions) {}

  async execute(
    request: NotebookToolRequest,
    control: NotebookToolDispatchControl = {}
  ): Promise<unknown> {
    control.signal?.throwIfAborted()
    if (request.remoteProject) return this.executeRemote(request, request.remoteProject, control)
    if (this.options.isRemoteCwd(request.cwd)) {
      throw new Error('远程 Notebook 请求缺少经过验证的远程 Notebook 后端；没有读取本机项目锚点。')
    }
    control.beforeDispatch?.()
    return this.options.local(request, control)
  }

  private async executeRemote(
    request: NotebookToolRequest,
    identity: NotebookRemoteProjectIdentity,
    control: NotebookToolDispatchControl
  ): Promise<unknown> {
    if (![identity.runtimeSessionId, identity.sessionId, identity.projectId].every(validIdentity)) {
      throw new Error('远程 Notebook 请求身份无效；没有回退到本机执行。')
    }
    const backend = await this.options.resolveRemote(identity)
    if (!backend) {
      throw new Error('远程 Notebook 后端不可用；没有回退到本机执行或本机项目锚点。')
    }
    control.signal?.throwIfAborted()
    control.beforeDispatch?.()
    return backend.execute({ ...request, cwd: backend.projectCwd }, control)
  }
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value)
}
