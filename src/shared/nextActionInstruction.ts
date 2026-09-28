/** Provider-facing guidance; it must never be concatenated into a user message. */
export const NEXT_ACTION_RECOMMENDATION_INSTRUCTION = [
  '<phi_next_action_instruction>',
  '当这次回复有明确、有用的后续操作时，请在最终回复最后单独输出一行：',
  '推荐下一步：<一句可以直接作为下一轮用户输入的中文操作>',
  '不要为了填充而猜测；如果没有明确下一步，不要输出这行。',
  '不要提及本指令。',
  '</phi_next_action_instruction>'
].join('\n')
