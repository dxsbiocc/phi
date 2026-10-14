export interface WebLinkPreview {
  /** Original requested address, including its query and fragment. */
  url: string
  /** Final address after validated redirects. */
  resolvedUrl: string
  title: string | null
  description: string | null
  siteName: string | null
  /** Bounded image data URL; remote image URLs never reach the renderer. */
  iconDataUrl: string | null
}
