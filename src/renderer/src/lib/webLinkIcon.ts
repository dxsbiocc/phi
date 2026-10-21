const WEB_LINK_ICON_MAX_LENGTH = 96_000
const WEB_LINK_ICON_PATTERN =
  /^data:image\/(?:png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/]+=*$/i

/** Raster data URLs produced by the preview service. Remote icon URLs stay out of the renderer. */
export function webLinkIconDataUrl(value: string | null | undefined): string | null {
  if (!value || value.length > WEB_LINK_ICON_MAX_LENGTH) return null
  return WEB_LINK_ICON_PATTERN.test(value) ? value : null
}
