/** Catalog shapes seen from real MCP servers: many tools, wordy schemas, deeply nested inputs. */
export const REALISTIC_MCP_TOOL_COUNT = 40
export const REALISTIC_MCP_NESTING = 40

function nested(depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'string', description: 'Innermost value' }
  for (let level = depth; level > 0; level--)
    schema = {
      type: 'object',
      description: `Nesting level ${level}`,
      properties: { child: schema },
      additionalProperties: false
    }
  return schema
}

export function realisticMcpTools(): Array<Record<string, unknown>> {
  return Array.from({ length: REALISTIC_MCP_TOOL_COUNT }, (_, index) => ({
    name: `bulk_${String(index).padStart(2, '0')}`,
    description: `Realistic server tool ${index}. `.concat('Detailed behaviour notes. '.repeat(30)),
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string' },
        deep: nested(REALISTIC_MCP_NESTING),
        ...Object.fromEntries(
          Array.from({ length: 30 }, (_, field) => [
            `option_${field}`,
            { type: 'string', description: `Option ${field} of tool ${index}. `.repeat(4) }
          ])
        )
      },
      required: ['operation'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  }))
}
