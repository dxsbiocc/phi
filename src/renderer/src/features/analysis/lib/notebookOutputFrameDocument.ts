const htmlFrameMessageSource = 'phi:notebook-html-output'

export function htmlFrameResizeScript(frameId: string): string {
  return `<script data-phi-notebook-output-resize="true">
(() => {
  const frameId = ${JSON.stringify(frameId)};
  const sendHeight = () => {
    const body = document.body;
    const root = document.documentElement;
    const height = Math.ceil(Math.max(
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      root ? root.scrollHeight : 0,
      root ? root.offsetHeight : 0
    ));
    parent.postMessage({ source: ${JSON.stringify(htmlFrameMessageSource)}, frameId, height }, '*');
  };
  const scheduleHeight = () => requestAnimationFrame(sendHeight);
  window.addEventListener('load', scheduleHeight);
  if ('ResizeObserver' in window) {
    new ResizeObserver(scheduleHeight).observe(document.documentElement);
  } else {
    setInterval(scheduleHeight, 500);
  }
  scheduleHeight();
})();
</script>`
}

export function notebookOutputBaseHref(notebookPath?: string | null): string | undefined {
  if (!notebookPath) return undefined
  const normalizedPath = notebookPath.replace(/\\/g, '/')
  const lastSlashIndex = normalizedPath.lastIndexOf('/')
  if (lastSlashIndex < 0) return undefined
  const directory = normalizedPath.slice(0, lastSlashIndex + 1)
  if (!directory || (!directory.startsWith('/') && !/^[A-Za-z]:\//.test(directory))) {
    return undefined
  }

  const encodedPath = directory
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return directory.startsWith('/') ? `file://${encodedPath}` : `file:///${encodedPath}`
}

function htmlFrameHeadContent(baseHref?: string): string {
  const baseHrefAttribute = baseHref ? ` href="${baseHref}"` : ''
  return `<base${baseHrefAttribute} target="_blank">
  <style>
    html, body { margin: 0; background: transparent; color: inherit; }
    body { font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    img { max-width: 100%; }
    iframe { border: 0; max-width: 100%; }
  </style>`
}

// Jupyter's JavaScript display API expects RequireJS plus a jQuery-like
// `element`. Dynamic plots call require([...], fn) and then write into element.
export function notebookOutputRuntimeScript(): string {
  return `<script data-phi-notebook-output-script-runtime="true">
(() => {
  const modules = Object.create(null);
  const paths = Object.create(null);
  const loading = Object.create(null);

  function scriptUrl(name) {
    if (typeof name !== 'string' || !name) return null;
    if (/^(https?:)?\\/\\//.test(name)) return /\\.js(?:$|\\?)/.test(name) ? name : name + '.js';
    const mapped = Object.prototype.hasOwnProperty.call(paths, name) ? paths[name] : null;
    if (typeof mapped !== 'string') return null;
    return /\\.js(?:$|\\?)/.test(mapped) ? mapped : mapped + '.js';
  }

  function load(url) {
    if (Object.prototype.hasOwnProperty.call(modules, url)) return Promise.resolve(modules[url]);
    if (loading[url]) return loading[url];
    loading[url] = new Promise((resolve, reject) => {
      const before = new Set(Object.getOwnPropertyNames(window));
      const script = document.createElement('script');
      script.src = url;
      script.async = false;
      script.onload = () => {
        const added = Object.getOwnPropertyNames(window).filter((key) => !before.has(key));
        const exported = added.length === 1 ? window[added[0]] : undefined;
        modules[url] = exported;
        resolve(exported);
      };
      script.onerror = () => reject(new Error('Failed to load ' + url));
      document.head.appendChild(script);
    });
    return loading[url];
  }

  function lookup(dep) {
    if (Object.prototype.hasOwnProperty.call(modules, dep)) return Promise.resolve(modules[dep]);
    const url = scriptUrl(dep);
    if (url) {
      return load(url).then((exported) => {
        if (exported !== undefined) return exported;
        if (modules[dep] !== undefined) return modules[dep];
        return window[dep];
      });
    }
    if (window[dep] !== undefined) return Promise.resolve(window[dep]);
    return Promise.resolve(undefined);
  }

  function require(deps, callback, errback) {
    const list = Array.isArray(deps) ? deps : [deps];
    const pending = Promise.all(list.map(lookup));
    pending.then(
      (values) => {
        if (typeof callback === 'function') callback.apply(null, values);
      },
      (error) => {
        if (typeof errback === 'function') errback(error);
        else console.error(error);
      }
    );
    return pending;
  }

  require.config = (options) => {
    if (options && options.paths && typeof options.paths === 'object') {
      Object.assign(paths, options.paths);
    }
  };
  require.undef = (name) => {
    delete modules[name];
  };
  window.require = window.require || require;
  window.requirejs = window.requirejs || require;

  function define(name, deps, factory) {
    if (typeof name !== 'string') {
      factory = deps;
      deps = name;
      name = undefined;
    }
    if (typeof deps === 'function') {
      factory = deps;
      deps = [];
    }
    require(Array.isArray(deps) ? deps : [], function () {
      const exported = typeof factory === 'function' ? factory.apply(null, arguments) : factory;
      if (typeof name === 'string') modules[name] = exported;
      return exported;
    });
  }
  define.amd = {};
  window.define = window.define || define;
})();
</script>`
}

function injectAfterOpeningTag(html: string, tag: 'head' | 'body', content: string): string {
  const openingTag = new RegExp(`<${tag}\\b[^>]*>`, 'i')
  if (openingTag.test(html)) {
    return html.replace(openingTag, (match) => `${match}${content}`)
  }
  return html
}

function injectBeforeClosingTag(html: string, tag: 'head' | 'body', content: string): string {
  const closingTag = new RegExp(`</${tag}>`, 'i')
  if (closingTag.test(html)) {
    return html.replace(closingTag, `${content}</${tag}>`)
  }
  return `${content}${html}`
}

export function htmlDocument(
  html: string,
  frameId: string,
  baseHref?: string,
  options?: { includeRuntime?: boolean }
): string {
  const resizeScript = htmlFrameResizeScript(frameId)
  const runtimeScript = options?.includeRuntime ? notebookOutputRuntimeScript() : ''
  const headContent = htmlFrameHeadContent(baseHref)
  if (/<html[\s>]/i.test(html)) {
    let next = html
    if (!/<head[\s>]/i.test(next)) {
      next = next.replace(/<html\b[^>]*>/i, (match) => `${match}<head></head>`)
    }
    if (!/<body[\s>]/i.test(next)) {
      next = next.replace(/<\/head>/i, '</head><body></body>')
    }
    if (runtimeScript) next = injectAfterOpeningTag(next, 'head', runtimeScript)
    next = injectBeforeClosingTag(next, 'head', headContent)
    return injectBeforeClosingTag(next, 'body', resizeScript)
  }

  return `<!doctype html>
<html>
<head>
  ${runtimeScript}
  ${headContent}
</head>
<body>${html}${resizeScript}</body>
</html>`
}

function escapeScriptText(script: string): string {
  return script.replace(/<\/script/gi, '<\\/script')
}

function javascriptElementBridge(): string {
  return `(() => {
  const outputElement = document.getElementById('phi-js-output');
  const toNode = (value) => {
    if (value instanceof Node) return value;
    if (typeof value !== 'string') return document.createTextNode(value == null ? '' : String(value));
    const template = document.createElement('template');
    template.innerHTML = value;
    return template.content;
  };
  const element = [outputElement];
  element.get = (index = 0) => (index === 0 ? outputElement : undefined);
  element.empty = () => {
    outputElement.replaceChildren();
    return element;
  };
  element.append = (...items) => {
    outputElement.append(...items.map(toNode));
    return element;
  };
  element.html = (value) => {
    if (value === undefined) return outputElement.innerHTML;
    outputElement.innerHTML = value;
    return element;
  };
  element.text = (value) => {
    if (value === undefined) return outputElement.textContent;
    outputElement.textContent = value;
    return element;
  };
  element.css = (property, value) => {
    if (property && typeof property === 'object') {
      Object.assign(outputElement.style, property);
      return element;
    }
    if (value === undefined) return getComputedStyle(outputElement)[property];
    outputElement.style[property] = value;
    return element;
  };
  element.attr = (name, value) => {
    if (value === undefined) return outputElement.getAttribute(name);
    outputElement.setAttribute(name, value);
    return element;
  };
  element.width = (value) => {
    if (value === undefined) return outputElement.getBoundingClientRect().width;
    outputElement.style.width = typeof value === 'number' ? value + 'px' : value;
    return element;
  };
  element.height = (value) => {
    if (value === undefined) return outputElement.getBoundingClientRect().height;
    outputElement.style.height = typeof value === 'number' ? value + 'px' : value;
    return element;
  };
  element.on = (eventName, handler) => {
    outputElement.addEventListener(eventName, handler);
    return element;
  };
  element.find = (selector) => outputElement.querySelector(selector);
  window.outputElement = outputElement;
  window.element = element;
})();`
}

export function javascriptDocument(script: string, frameId: string, baseHref?: string): string {
  return htmlDocument(
    `<div id="phi-js-output"></div><script>${javascriptElementBridge()}
${escapeScriptText(script)}</script>`,
    frameId,
    baseHref,
    { includeRuntime: true }
  )
}

export function notebookOutputFrameDocument(input: {
  html: string
  frameId: string
  frameKind: 'html' | 'javascript'
  notebookPath?: string | null
}): string {
  const baseHref = notebookOutputBaseHref(input.notebookPath)
  return input.frameKind === 'javascript'
    ? javascriptDocument(input.html, input.frameId, baseHref)
    : htmlDocument(input.html, input.frameId, baseHref)
}
