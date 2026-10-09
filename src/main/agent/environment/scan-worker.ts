import type { EnvironmentWorkerRequest, EnvironmentWorkerResponse } from './background'
import {
  dismissEnvironmentSummary,
  getEnvironment,
  redetectEnvironment,
  setEnvironmentToolPath
} from './store'

process.once('message', (request: EnvironmentWorkerRequest) => {
  let response: EnvironmentWorkerResponse
  try {
    switch (request.operation) {
      case 'get':
        response = { result: getEnvironment(request.agentDir) }
        break
      case 'redetect':
        response = { result: redetectEnvironment(request.agentDir) }
        break
      case 'dismissSummary':
        response = { result: dismissEnvironmentSummary(request.agentDir) }
        break
      case 'setToolPath':
        response = {
          result: setEnvironmentToolPath(request.toolId, request.path, request.agentDir)
        }
        break
      default:
        throw new Error('Unknown environment operation')
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    response = { error: { name: error.name, message: error.message, stack: error.stack } }
  }
  process.send?.(response, (error) => {
    if (error) process.exitCode = 1
    if (process.connected) process.disconnect()
  })
})
