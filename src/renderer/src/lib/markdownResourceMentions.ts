import type { ChatResourceMention, createChatResourceMatcher } from './chatResourceMentions'

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

function resourceLink(resource: ChatResourceMention): MarkdownNode {
  return {
    type: 'link',
    url: `${resource.kind}://${encodeURIComponent(resource.id)}`,
    children: [{ type: 'text', value: resource.name }]
  }
}

/** Work on prose nodes so links, images, math and fenced code keep their own semantics. */
export function createResourceMentionRemarkPlugin(
  matcher: ReturnType<typeof createChatResourceMatcher>
): () => (tree: MarkdownNode) => void {
  return () => {
    const visit = (node: MarkdownNode): void => {
      if (
        !node.children ||
        [
          'link',
          'linkReference',
          'code',
          'html',
          'image',
          'imageReference',
          'math',
          'inlineMath'
        ].includes(node.type)
      )
        return
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text' && child.value) {
          return matcher
            .tokenize(child.value)
            .map((token) =>
              token.kind === 'resource'
                ? resourceLink(token.resource)
                : { ...child, value: token.text }
            )
        }
        if (child.type === 'inlineCode' && child.value) {
          const resource = matcher.resolveExact(child.value)
          if (resource) return [resourceLink(resource)]
        }
        visit(child)
        return [child]
      })
    }
    return visit
  }
}
