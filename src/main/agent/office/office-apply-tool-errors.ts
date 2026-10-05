const APPLY_ERROR_MESSAGES = {
  no_target: '当前运行没有关联的 Office 文档，请先在右侧打开表格并在输入框里关联它',
  target_missing: '关联的 Office 文档已不可用，请在右侧重新打开并重新关联后再试',
  session_mismatch: '关联的 Office 文档不属于当前会话，请重新关联正确文档',
  invalid_sheet:
    '工作表名称无效；请先用 office_read 确认已有工作表名称。新名称必须为 1 到 31 个字符，不能含 \\ / ? * [ ] : 或控制字符，不能有前后空白或首尾单引号',
  sheet_exists: '工作表名称已存在，请改用其它名称',
  too_many_sheets: '每个工作簿最多 20 个工作表，请不要继续新建',
  invalid_cell: '单元格无效，请使用单个有效 A1 地址，例如 A1',
  invalid_value:
    '值或参数无效。普通写入只支持文本、数字或布尔值；format_range 只支持 bold 布尔值、fill #RRGGBB、horizontalAlign left/center/right、numberFormat General/0/0.00/#,##0/#,##0.00；不支持字体、字号、边框、列宽、行高、合并、条件格式或图表',
  range_out_of_bounds: '范围超出可写边界，请缩小到 A1:J1000 内',
  range_too_large: '范围或命令体过大；单次最多 2000 格且命令体不超过 256 KiB，请缩小范围',
  formula_not_supported:
    '字面 = 文本当前不支持；要写公式请使用 set_formula，并确保 formula 以 = 开头',
  revision_conflict: '文档已更新，请先用 office_read 重新读取并使用最新 revision',
  document_frozen:
    '该文档有待核对的写入结果，已尝试自动核对；请告知用户在右侧面板点击“重新核对”，不要重复写入',
  unsupported_document_kind: '当前关联的文档类型暂不支持通过 Office 工具读取或修改',
  operation_not_supported_for_kind:
    '该写入操作不适用于当前文档类型；请先用 office_read 确认目标文档',
  paragraph_not_found: '目标段落已不存在；请先用 office_read 重新读取并使用最新 paraId',
  paragraph_not_plain:
    '目标段落包含多个文本片段或复杂结构，不能安全修改；请选择 editable:true 的段落',
  slide_not_found: '目标幻灯片已不存在；请先用 office_read 重新读取并使用最新 slideId',
  element_not_found: '目标文本元素已不存在；请先用 office_read 重新读取并使用最新 elementId',
  element_not_plain:
    '目标文本元素包含多个文本片段或复杂结构，不能安全修改；请选择 editable:true 的元素',
  too_many_slides: '每个演示文稿最多 200 张幻灯片，请不要继续新增',
  stale_target: '目标文本已变化；请先用 office_read 重新读取并更新 expectedText',
  write_unknown:
    '该文档有待核对的写入结果，已尝试自动核对；请告知用户在右侧面板点击“重新核对”，不要重复写入',
  write_verification_failed:
    '该文档有待核对的写入结果，已尝试自动核对；请告知用户在右侧面板点击“重新核对”，不要重复写入',
  write_not_applied: '已核对该次写入未生效；请先重新读取并使用新的调用重试',
  reconcile_indeterminate:
    '该文档有待核对的写入结果；请告知用户在右侧面板点击“重新核对”，不要重复写入',
  reconcile_failed: '核对未能可靠完成，请不要重复写入',
  write_failed: 'Office 写入未确认成功，请不要声称修改已完成',
  write_cancelled: '写入已取消，未做任何修改',
  approval_denied: '用户未批准，未做任何修改',
  approval_cancelled: '用户未批准，未做任何修改',
  approval_changed: '写入参数未获本次批准，未做任何修改；请重新审批当前参数',
  missing_operation_id: '写入请求缺少可信操作编号，未做任何修改',
  operation_conflict: '操作编号已用于不同的写入请求，未做任何修改',
  operation_log_corrupt: '写入结果未能确认，请停止继续修改并告知用户需要核对'
} as const

export function officeApplyToolError(code: unknown): { code: string; message: string } {
  if (typeof code !== 'string' || !Object.hasOwn(APPLY_ERROR_MESSAGES, code)) {
    return { code: 'write_failed', message: APPLY_ERROR_MESSAGES.write_failed }
  }
  return { code, message: APPLY_ERROR_MESSAGES[code as keyof typeof APPLY_ERROR_MESSAGES] }
}
