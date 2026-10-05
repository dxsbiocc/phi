import type { CustomTool } from '@oh-my-pi/pi-coding-agent'

import {
  normalizeOfficeApplyParams,
  OFFICE_APPLY_DESCRIPTION,
  OFFICE_APPLY_PARAMETERS
} from './office-apply-tool-contract'
import { officeApplyToolResult, transportFailure } from './office-apply-tool-result'
import type { OfficeHostRequest } from './office-tools'

export function buildOfficeApplyTool(requestHost: OfficeHostRequest): CustomTool {
  return {
    name: 'office_apply',
    label: '修改关联表格',
    description: OFFICE_APPLY_DESCRIPTION,
    loadMode: 'essential',
    approval: 'write',
    parameters: OFFICE_APPLY_PARAMETERS,
    async execute(toolCallId, params) {
      try {
        const result = await requestHost('office.apply', normalizeOfficeApplyParams(params), {
          toolCallId
        })
        return officeApplyToolResult(result)
      } catch {
        return transportFailure()
      }
    }
  }
}
