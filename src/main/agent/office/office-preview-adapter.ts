import { officePreviewAiScript } from './office-preview-ai-adapter'

export function adaptOfficePreviewHtml(html: string, readOnly: boolean, aiControls = true): string {
  const adapter = `<script data-phi-office-adapter>${adapterScript(readOnly, aiControls)}</script>`
  const head = /<head(?:\s[^>]*)?>/iu.exec(html)
  if (!head || head.index === undefined) return `${adapter}${html}`
  const insertion = head.index + head[0].length
  return `${html.slice(0, insertion)}${adapter}${html.slice(insertion)}`
}

function adapterScript(readOnly: boolean, aiControls: boolean): string {
  return `(()=>{${escapeGuardScript()}${aiControls ? officePreviewAiScript() : ''}const originalFetch=window.fetch.bind(window);const reload=()=>queueMicrotask(()=>window.location.reload());window.fetch=async(input,init)=>{const raw=typeof input==='string'?input:input.url;const method=String(init?.method??(typeof input==='string'?'GET':input.method??'GET')).toUpperCase();const url=new URL(raw,window.location.href);const edit=method==='POST'&&url.origin===new URL(window.location.href).origin&&url.pathname==='/api/send';try{const response=await originalFetch(input,init);if(edit&&!response.ok)reload();return response}catch(error){if(edit)reload();throw error}};if(${readOnly ? 'true' : 'false'})window.addEventListener('dblclick',event=>{event.preventDefault();event.stopImmediatePropagation()},true)})();`
}

// The upstream page's cancel() removes the focused input before clearing its editing flag, and
// Chromium fires blur on that removal, so commit() runs and Escape posts the edit. Restoring the
// input's original text first makes the page see "no change" and send nothing.
function escapeGuardScript(): string {
  return `const initialText=new WeakMap();window.addEventListener('focusin',event=>{const target=event.target;if(target&&target.tagName==='INPUT'&&!initialText.has(target))initialText.set(target,target.value)},true);window.addEventListener('keydown',event=>{if(event.key!=='Escape')return;const target=event.target;if(target&&target.tagName==='INPUT'&&initialText.has(target))target.value=initialText.get(target)},true);`
}
