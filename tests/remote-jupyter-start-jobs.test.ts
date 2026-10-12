import assert from 'node:assert/strict'
import test from 'node:test'

import { RemoteNotebookRuntimeController } from '../src/main/agent/notebook/remote-analysis-notebook-backend'
import type {
  JupyterRuntimeBackend,
  JupyterRuntimeStatus
} from '../src/main/agent/notebook/jupyter-runtime-backend'
import {
  describeRemoteJupyterError,
  RemoteJupyterStartJobs
} from '../src/main/agent/notebook/remote-jupyter-start-jobs'
import { REMOTE_JUPYTER_JOB_MAX_ENTRIES } from '../src/shared/remoteJupyterJobTypes'

const project = { projectId: 'p1', projectName: 'GPU', serverLabel: 'gpu-login' }

test('a startup job records steps, server output and the failure with its causes', () => {
  const jobs = new RemoteJupyterStartJobs()
  const seen: string[] = []
  jobs.subscribe((job) => seen.push(job.state))
  const job = jobs.begin(project)
  job.step('正在检测服务器上已有的 Jupyter')
  job.state('starting_lease')
  job.output('ModuleNotFoundError: jupyter_server\n')
  job.state('preparing_environment')
  job.fail(new Error('远程 Jupyter 在 3 次尝试后仍未就绪', { cause: new Error('进程提前退出') }))
  job.output('late line is ignored')

  const [recorded] = jobs.list()
  assert.equal(recorded?.state, 'failed')
  assert.equal(recorded?.error, '远程 Jupyter 在 3 次尝试后仍未就绪：进程提前退出')
  assert.deepEqual(
    recorded?.entries.map((entry) => [entry.kind, entry.text]),
    [
      ['step', '正在检测服务器上已有的 Jupyter'],
      ['step', '通过 SSH 启动 Jupyter Server'],
      ['output', 'ModuleNotFoundError: jupyter_server'],
      ['error', '远程 Jupyter 在 3 次尝试后仍未就绪：进程提前退出']
    ]
  )
  assert.ok(recorded?.finishedAt)
  assert.equal(seen.at(-1), 'failed')
})

test('job logs are capped and only the newest finished jobs are kept', () => {
  const jobs = new RemoteJupyterStartJobs()
  const chatty = jobs.begin(project)
  for (let index = 0; index < REMOTE_JUPYTER_JOB_MAX_ENTRIES + 50; index += 1) {
    chatty.output(`line ${index}`)
  }
  assert.equal(jobs.list()[0]?.entries.length, REMOTE_JUPYTER_JOB_MAX_ENTRIES)
  assert.equal(jobs.list()[0]?.entries.at(-1)?.text, `line ${REMOTE_JUPYTER_JOB_MAX_ENTRIES + 49}`)
  chatty.succeed()
  for (let index = 0; index < 30; index += 1) jobs.begin(project).cancel()
  assert.equal(jobs.list().length, 20)
})

test('error descriptions follow the cause chain without repeating messages', () => {
  const inner = new Error('probe timed out')
  assert.equal(
    describeRemoteJupyterError(
      new Error('start failed', { cause: new Error('retry', { cause: inner }) })
    ),
    'start failed：retry：probe timed out'
  )
  assert.equal(describeRemoteJupyterError(new Error('same', { cause: new Error('same') })), 'same')
})

function failingRuntime(error: Error): JupyterRuntimeBackend {
  const status: JupyterRuntimeStatus = {
    kind: 'ssh',
    projectCwd: '/server/project',
    state: 'stopped',
    hasConnection: false
  }
  return {
    kind: 'ssh',
    status: () => status,
    start: async () => {
      throw error
    },
    stop: async () => undefined,
    connection: () => null
  } as unknown as JupyterRuntimeBackend
}

test('a failed start keeps the cause in the runtime status and finishes its job', async () => {
  const jobs = new RemoteJupyterStartJobs()
  const controller = new RemoteNotebookRuntimeController({
    projectCwd: '/server/project',
    serverLabel: 'gpu-login',
    runtime: failingRuntime(
      new Error('远程 Jupyter 在 3 次尝试后仍未就绪', { cause: new Error('进程提前退出') })
    ),
    beginJob: () => jobs.begin(project)
  })
  controller.start()
  await controller.waitForStart()
  assert.equal(controller.status().state, 'error')
  assert.equal(controller.status().message, '远程 Jupyter 在 3 次尝试后仍未就绪：进程提前退出')
  const [job] = jobs.list()
  assert.equal(job?.state, 'failed')
  assert.match(job?.entries[0]?.text ?? '', /连接 gpu-login/)
})
