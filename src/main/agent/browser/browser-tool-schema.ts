import {
  BROWSER_MAX_SCREENSHOT_COORDINATE,
  BROWSER_MAX_SCROLL_DELTA,
  BROWSER_SAFE_KEYS,
  BROWSER_SAFE_MODIFIERS
} from '../../../shared/browserTypes'

export const BROWSER_TOOL_MAX_URL_BYTES = 16 * 1024
export const BROWSER_TOOL_MAX_ID_BYTES = 256

export function browserToolParameters(): Record<string, unknown> {
  return {
    oneOf: [
      {
        type: 'object',
        required: ['action', 'url'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['open'] },
          url: { type: 'string', minLength: 1, maxLength: BROWSER_TOOL_MAX_URL_BYTES },
          target: { type: 'string', enum: ['dedicated'] }
        }
      },
      {
        type: 'object',
        required: ['action', 'url', 'target', 'tabId', 'expectedDocumentRevision'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['open'] },
          url: { type: 'string', minLength: 1, maxLength: BROWSER_TOOL_MAX_URL_BYTES },
          target: { type: 'string', enum: ['current'] },
          tabId: { type: 'string', minLength: 1, maxLength: BROWSER_TOOL_MAX_ID_BYTES },
          expectedDocumentRevision: {
            type: 'integer',
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER
          }
        }
      },
      {
        type: 'object',
        required: ['action', 'tabId'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['snapshot'] },
          tabId: { type: 'string', minLength: 1, maxLength: BROWSER_TOOL_MAX_ID_BYTES },
          target: { type: 'string', enum: ['dedicated'] }
        }
      },
      {
        type: 'object',
        required: ['action', 'target', 'tabId', 'expectedDocumentRevision'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['snapshot'] },
          target: { type: 'string', enum: ['current'] },
          tabId: { type: 'string', minLength: 1, maxLength: BROWSER_TOOL_MAX_ID_BYTES },
          expectedDocumentRevision: {
            type: 'integer',
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER
          }
        }
      },
      ...(['click', 'typeText', 'scroll', 'keypress'] as const).flatMap((action) => {
        const actionProperties = {
          action: { type: 'string', enum: [action] },
          tabId: { type: 'string', minLength: 1, maxLength: BROWSER_TOOL_MAX_ID_BYTES },
          expectedDocumentRevision: {
            type: 'integer',
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER
          },
          target: { type: 'string', enum: ['dedicated'] }
        }
        const actionSpecific =
          action === 'click'
            ? {
                x: {
                  type: 'number',
                  minimum: 0,
                  maximum: BROWSER_MAX_SCREENSHOT_COORDINATE
                },
                y: {
                  type: 'number',
                  minimum: 0,
                  maximum: BROWSER_MAX_SCREENSHOT_COORDINATE
                },
                consequence: { type: 'string', enum: ['read'] }
              }
            : action === 'typeText'
              ? { text: { type: 'string' } }
              : action === 'scroll'
                ? {
                    deltaX: {
                      type: 'integer',
                      minimum: -BROWSER_MAX_SCROLL_DELTA,
                      maximum: BROWSER_MAX_SCROLL_DELTA
                    },
                    deltaY: {
                      type: 'integer',
                      minimum: -BROWSER_MAX_SCROLL_DELTA,
                      maximum: BROWSER_MAX_SCROLL_DELTA
                    }
                  }
                : {
                    key: { type: 'string', enum: [...BROWSER_SAFE_KEYS] },
                    modifiers: {
                      type: 'array',
                      items: { type: 'string', enum: [...BROWSER_SAFE_MODIFIERS] },
                      maxItems: 1,
                      uniqueItems: true
                    }
                  }
        const required = [
          'action',
          'tabId',
          'expectedDocumentRevision',
          ...(action === 'click'
            ? ['x', 'y', 'consequence']
            : action === 'typeText'
              ? ['text']
              : action === 'scroll'
                ? ['deltaX', 'deltaY']
                : ['key'])
        ]
        return [
          {
            type: 'object',
            required,
            additionalProperties: false,
            properties: { ...actionProperties, ...actionSpecific }
          },
          {
            type: 'object',
            required: [...required, 'target'],
            additionalProperties: false,
            properties: {
              ...actionProperties,
              ...actionSpecific,
              target: { type: 'string', enum: ['current'] }
            }
          }
        ]
      })
    ]
  }
}
