import { DatabaseHoverImagePreviewLink } from './DatabaseHoverImagePreviewLink'

export function StringNetworkPreview({
  href,
  label
}: {
  href: string
  label: string
}): React.JSX.Element {
  return <DatabaseHoverImagePreviewLink href={href} label={label} kind="string-network" />
}
