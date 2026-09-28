export const HTML_REPORT_FRAME_NAME = 'phi-html-report-preview'

const HTML_REPORT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  'img-src data:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

export function htmlReportSrcDoc(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${HTML_REPORT_CSP}">`
  const doctype = /^\s*<!doctype\s+html[^>]*>/i.exec(html)?.[0]
  return doctype ? `${doctype}${policy}${html.slice(doctype.length)}` : `${policy}${html}`
}

export function shouldBlockHtmlReportNavigation(input: {
  isMainFrame: boolean
  frameName: string | undefined
  url: string
}): boolean {
  return (
    !input.isMainFrame &&
    input.frameName === HTML_REPORT_FRAME_NAME &&
    input.url !== 'about:blank' &&
    input.url !== 'about:srcdoc'
  )
}
