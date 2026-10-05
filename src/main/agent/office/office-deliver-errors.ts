const MESSAGES: Readonly<Record<string, string>> = {
  no_target: '当前任务没有关联 Office 文档，无法交付',
  target_missing: '关联的 Office 文档已关闭，请重新关联后再交付',
  session_mismatch: '关联的 Office 文档不属于当前会话',
  missing_operation_id: '交付请求缺少可信操作编号，未创建文件',
  invalid_name: '输出文件名无效；只能提供文件名，不能提供路径',
  invalid_extension: '输出扩展名必须与当前 Office 文档类型一致',
  target_exists: '同名输出文件已存在；Phi 不会覆盖已有文件',
  outside_project: '输出目标必须位于当前会话工作区内',
  unsafe_path: '输出路径包含符号链接或私有草稿目录',
  permission_denied: '当前工作区不可写，未创建交付文件',
  remote_not_supported: '远程项目暂不支持 Office 文件交付',
  document_frozen: '写入结果待核对，不能交付 Office 文件',
  document_read_only: '只读 Office 文档不能生成交付文件',
  document_not_deliverable: 'Office 草稿尚未可靠写盘，不能交付',
  save_failed: 'Office 草稿保存失败，未创建交付文件',
  copy_failed: '无法创建 Office 交付文件',
  copy_verification_failed: 'Office 输出结构校验失败，未创建交付文件',
  delivery_check_failed: 'Office 输出内容检查失败，未创建交付文件',
  presentation_validation_failed: 'Office 输出未通过交付路径校验，未创建交付文件',
  output_log_corrupt: 'Office 输出记录无法验证，未创建交付文件',
  output_hash_mismatch: 'Office 输出已被更改，交付入口已失效',
  output_integrity_failed: 'Office 输出已被更改，交付入口已失效',
  operation_conflict: '同一操作编号携带了不同的交付参数',
  approval_changed: '交付参数与批准内容不一致，未创建文件',
  approval_denied: '用户未批准交付，未创建文件',
  approval_cancelled: '用户未批准交付，未创建文件',
  operation_cancelled: 'Office 文件交付已取消',
  save_as_cancelled: 'Office 文件交付已取消'
}

export function safeOfficeDeliverMessage(code: string): string {
  return MESSAGES[code] ?? 'Office 文件交付失败，请稍后重试'
}
