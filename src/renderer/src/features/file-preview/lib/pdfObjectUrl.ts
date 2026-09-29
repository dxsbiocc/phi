export function pdfObjectUrlFromDataUrl(dataUrl: string): string {
  const prefix = 'data:application/pdf;base64,'
  if (!dataUrl.startsWith(prefix)) throw new Error('PDF 数据无效')
  const bytes = Uint8Array.from(atob(dataUrl.slice(prefix.length)), (char) => char.charCodeAt(0))
  return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
}
