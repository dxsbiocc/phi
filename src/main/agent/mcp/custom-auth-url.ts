/** Custom connector authorization must open a plain https URL without embedded credentials. */
export function customMcpAuthUrl(value: unknown): URL {
  try {
    if (typeof value !== 'string') throw new Error('Invalid URL')
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('Invalid URL')
    return url
  } catch {
    throw new Error('Invalid Connector authorization URL')
  }
}
