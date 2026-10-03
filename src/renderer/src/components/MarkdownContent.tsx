import { Box, Button, Divider, Link, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { Fragment, isValidElement, memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import { PhiIcons } from '../icons'
import { useMarkdownPlugins } from '../lib/markdownMathPlugins'
import {
  remotePathInsideRoot,
  remotePathWithinProjectUri,
  tokenizeRemoteWorkspaceUris
} from '../../../shared/remoteWorkspacePath'
import {
  useRemoteProjectFileContext,
  type RemoteProjectFileContextValue
} from '../lib/remoteProjectFileContext'
import { collectLocalPathTokenPaths, tokenizeLocalPaths } from '../lib/localPaths'
import { highlightLine, type SyntaxLanguage } from '../lib/syntaxHighlight'
import { syntaxTokenColor } from '../lib/syntaxTheme'
import { smilesExpressionFromInlineCode } from '../lib/moleculeExpressions'
import type { FilePreview } from '../types'
import {
  collectBareFileReferencePaths,
  inlineCodeBareFilePath,
  inlineCodeFilePath,
  localHrefToPath,
  localPathKindForReference,
  matchedBareFileReference,
  stripLineReference,
  tokenizeBareFileReferences,
  type LocalPathKind
} from '../lib/markdownLocalPathReferences'
import { normalizeHexColor, tokenizeMarkdownColors } from '../lib/markdownColors'
import { ColorCode, InlineCodeShell, MarkdownColorTokenView } from './markdown/MarkdownColorToken'
import { LocalPathButton } from './markdown/LocalPathButton'
import { MarkdownSmilesTokenView } from './markdown/MarkdownSmilesToken'
import { useLocalPathKinds } from '../lib/markdownLocalPathPreview'

export type { LocalPathKind } from '../lib/markdownLocalPathReferences'
const ContentCopyIcon = PhiIcons.action.copy

const MARKDOWN_CODE_LANGUAGE_ALIASES: Record<string, SyntaxLanguage> = {
  bash: 'shell',
  cjs: 'javascript',
  console: 'shell',
  css: 'css',
  javascript: 'javascript',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  none: 'plain',
  plaintext: 'plain',
  py: 'python',
  python: 'python',
  python3: 'python',
  r: 'r',
  rs: 'rust',
  rscript: 'r',
  rust: 'rust',
  sh: 'shell',
  shell: 'shell',
  text: 'plain',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell'
}

function textFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromNode).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children)
  return ''
}

function languageFromCodeChild(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children
  if (!isValidElement<{ className?: string }>(child)) return null

  const match = /language-([^\s]+)/.exec(child.props.className ?? '')
  return match?.[1] ?? null
}

function normalizeDirectoryPath(path: string): string {
  return path.replace(/\/+$/, '')
}

function isPathInsideDirectory(path: string, directory: string): boolean {
  const normalizedDirectory = normalizeDirectoryPath(directory)
  if (!normalizedDirectory) return false
  return path === normalizedDirectory || path.startsWith(`${normalizedDirectory}/`)
}

function renderableLocalPathKind(
  text: string,
  absolutePath: string,
  cwd: string,
  localPathKinds: ReadonlyMap<string, LocalPathKind>,
  remoteProject?: RemoteProjectFileContextValue | null
): LocalPathKind | null {
  if (remoteProject) {
    return remoteProject.hostAlias &&
      remotePathInsideRoot(absolutePath, remoteProject.canonicalRoot)
      ? text.trim().endsWith('/') || absolutePath === remoteProject.canonicalRoot
        ? 'directory'
        : 'file'
      : null
  }
  if (isPathInsideDirectory(absolutePath, cwd)) {
    return localPathKindForReference(text, absolutePath, cwd, true)
  }
  return localPathKinds.get(absolutePath) ?? null
}

function syntaxLanguageForMarkdownCode(language: string | null): SyntaxLanguage {
  if (!language) return 'plain'
  return MARKDOWN_CODE_LANGUAGE_ALIASES[language.trim().toLowerCase()] ?? 'plain'
}

function HighlightedCodeContent({
  codeText,
  language
}: {
  codeText: string
  language: SyntaxLanguage
}): React.JSX.Element {
  const lines = useMemo(
    () => codeText.split('\n').map((line) => highlightLine(line, language)),
    [codeText, language]
  )

  return (
    <Box
      component="code"
      data-phi-markdown-code={language === 'plain' ? 'plain' : 'highlighted'}
      data-phi-markdown-code-language={language}
      sx={{ color: 'text.primary' }}
    >
      {lines.map((tokens, lineIndex) => (
        <Fragment key={lineIndex}>
          {tokens.map((token, tokenIndex) => (
            <Box
              key={`${lineIndex}-${tokenIndex}`}
              component="span"
              data-phi-syntax-token={token.kind}
              sx={{ color: (theme) => syntaxTokenColor(theme, token.kind) }}
            >
              {token.value}
            </Box>
          ))}
          {lineIndex < lines.length - 1 ? '\n' : null}
        </Fragment>
      ))}
    </Box>
  )
}

function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const language = languageFromCodeChild(children)
  const languageLabel = language ?? '代码'
  const syntaxLanguage = syntaxLanguageForMarkdownCode(language)
  const codeText = textFromNode(children).replace(/\n$/, '')

  const copyCode = async (): Promise<void> => {
    await navigator.clipboard.writeText(codeText)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Box
      sx={{
        my: 1,
        borderRadius: 2,
        bgcolor: (theme) =>
          theme.palette.mode === 'dark'
            ? alpha(theme.palette.common.white, 0.04)
            : alpha(theme.palette.primary.main, 0.035),
        border: 1,
        borderColor: 'divider',
        overflow: 'hidden',
        maxWidth: '100%',
        color: 'text.primary'
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          px: 1.5,
          py: 0.75,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: (theme) =>
            theme.palette.mode === 'dark'
              ? alpha(theme.palette.common.white, 0.035)
              : alpha(theme.palette.primary.main, 0.06)
        }}
      >
        <Typography
          variant="caption"
          sx={{
            minWidth: 0,
            maxWidth: 160,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'text.secondary',
            fontFamily: 'var(--font-mono)'
          }}
          title={languageLabel}
        >
          {languageLabel}
        </Typography>
        <Button
          size="small"
          variant="text"
          startIcon={<ContentCopyIcon sx={{ fontSize: 15 }} />}
          onClick={() => {
            void copyCode().catch((error) => {
              console.error('Failed to copy code block:', error)
            })
          }}
          sx={{ minHeight: 28, textTransform: 'none', color: 'text.secondary' }}
        >
          {copied ? '已复制' : '复制'}
        </Button>
      </Box>
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 1.5,
          overflowX: 'auto',
          maxWidth: '100%',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.82rem',
          lineHeight: 1.6,
          color: 'text.primary',
          '& code': {
            color: 'inherit',
            fontWeight: 400
          }
        }}
      >
        <HighlightedCodeContent codeText={codeText} language={syntaxLanguage} />
      </Box>
    </Box>
  )
}

function MarkdownImage({
  src,
  alt,
  cwd,
  localPathKinds,
  onOpenLocalPath
}: {
  src?: string
  alt?: string
  cwd: string
  localPathKinds: ReadonlyMap<string, LocalPathKind>
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
}): React.JSX.Element | null {
  const remoteProject = useRemoteProjectFileContext()
  const explicitRemotePath =
    remoteProject && src
      ? remotePathWithinProjectUri(src, remoteProject.hostAlias, remoteProject.canonicalRoot)
      : null
  const localPath = explicitRemotePath ?? localHrefToPath(src, cwd)
  const pathKind = localPath
    ? renderableLocalPathKind(alt || localPath, localPath, cwd, localPathKinds, remoteProject)
    : null
  const [previewState, setPreviewState] = useState<{ path: string; preview: FilePreview } | null>(
    null
  )
  const preview = previewState?.path === localPath ? previewState.preview : null
  const bundledTemplatePreview = Boolean(
    localPath
      ?.replaceAll('\\', '/')
      .match(/\/skills\/omics-visualization\/scripts\/[^/]+\/[^/]+\/preview\.png$/)
  )

  useEffect(() => {
    if (
      remoteProject ||
      !localPath ||
      pathKind !== 'file' ||
      typeof window === 'undefined' ||
      !window.api?.previewFile
    ) {
      return
    }

    let cancelled = false

    window.api
      .previewFile(localPath)
      .then((result) => {
        if (!cancelled) setPreviewState({ path: localPath, preview: result })
      })
      .catch((error) => {
        console.error('Failed to preview markdown image:', error)
      })

    return () => {
      cancelled = true
    }
  }, [localPath, pathKind, remoteProject])

  if (remoteProject) {
    return localPath && pathKind ? (
      <LocalPathButton
        text={alt || src || localPath}
        absolutePath={localPath}
        pathKind={pathKind}
      />
    ) : (
      <InlineCodeShell>{alt || src || ''}</InlineCodeShell>
    )
  }

  if (!localPath) {
    if (!src) return null
    return (
      <Box
        component="img"
        src={src}
        alt={alt ?? ''}
        sx={{
          display: 'block',
          maxWidth: '100%',
          maxHeight: 360,
          my: 1,
          borderRadius: 1,
          objectFit: 'contain'
        }}
      />
    )
  }

  if (!pathKind) {
    return <InlineCodeShell>{alt || localPath}</InlineCodeShell>
  }

  const fallback = (
    <LocalPathButton
      text={alt || localPath}
      absolutePath={localPath}
      pathKind={pathKind}
      onOpenLocalPath={onOpenLocalPath}
    />
  )

  return (
    <Box
      component="span"
      data-phi-slot="local-markdown-image"
      data-phi-path={localPath}
      data-phi-example-preview={bundledTemplatePreview || undefined}
      sx={{ display: 'block', my: 1, maxWidth: '100%' }}
    >
      {preview?.kind === 'image' ? (
        <Box
          component="button"
          type="button"
          aria-label={`打开文件 ${localPath}`}
          onClick={() => {
            if (onOpenLocalPath) {
              onOpenLocalPath(localPath, 'file')
              return
            }

            void window.api.revealPath(localPath).catch((error) => {
              console.error('Failed to reveal markdown image:', error)
            })
          }}
          sx={{
            display: 'block',
            p: 0,
            maxWidth: '100%',
            border: 0,
            bgcolor: 'transparent',
            cursor: 'pointer',
            textAlign: 'left',
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2
            }
          }}
        >
          <Box
            component="img"
            src={preview.dataUrl}
            alt={alt ?? preview.name}
            sx={{
              display: 'block',
              maxWidth: '100%',
              maxHeight: 360,
              objectFit: 'contain',
              borderRadius: 1,
              border: 1,
              borderColor: 'divider',
              bgcolor: bundledTemplatePreview ? '#fff' : 'background.default'
            }}
          />
        </Box>
      ) : (
        fallback
      )}
    </Box>
  )
}

function renderDecoratedText(
  text: string,
  cwd: string,
  keyPrefix: string,
  localPathKinds: ReadonlyMap<string, LocalPathKind>,
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void,
  remoteProject?: RemoteProjectFileContextValue | null
): ReactNode[] {
  const nodes: ReactNode[] = []
  const remoteTokens = remoteProject
    ? tokenizeRemoteWorkspaceUris(text, remoteProject.hostAlias, remoteProject.canonicalRoot)
    : [{ kind: 'text' as const, text }]
  remoteTokens.forEach((remoteToken, remoteIndex) => {
    if (remoteToken.kind === 'path') {
      nodes.push(
        <LocalPathButton
          key={`${keyPrefix}-remote-${remoteIndex}`}
          text={remoteToken.text}
          absolutePath={remoteToken.path}
          pathKind={remoteToken.text.endsWith('/') ? 'directory' : 'file'}
          onOpenLocalPath={onOpenLocalPath}
        />
      )
      return
    }
    tokenizeLocalPaths(remoteToken.text, cwd).forEach((token, pathIndex) => {
      if (token.kind === 'path') {
        const pathKind = renderableLocalPathKind(
          token.text,
          token.absolutePath,
          cwd,
          localPathKinds,
          remoteProject
        )
        nodes.push(
          pathKind ? (
            <LocalPathButton
              key={`${keyPrefix}-path-${remoteIndex}-${pathIndex}-${token.absolutePath}`}
              text={token.text}
              absolutePath={token.absolutePath}
              pathKind={pathKind}
              onOpenLocalPath={onOpenLocalPath}
            />
          ) : (
            token.text
          )
        )
        return
      }
      tokenizeBareFileReferences(token.text, cwd, localPathKinds).forEach(
        (fileToken, fileIndex) => {
          if (fileToken.kind === 'path') {
            nodes.push(
              <LocalPathButton
                key={`${keyPrefix}-file-${remoteIndex}-${pathIndex}-${fileIndex}-${fileToken.absolutePath}`}
                text={fileToken.text}
                absolutePath={fileToken.absolutePath}
                pathKind={fileToken.pathKind}
                onOpenLocalPath={onOpenLocalPath}
              />
            )
            return
          }
          nodes.push(
            ...tokenizeMarkdownColors(fileToken.text).map((colorToken, colorIndex) => (
              <MarkdownColorTokenView
                key={`${keyPrefix}-color-${remoteIndex}-${pathIndex}-${fileIndex}-${colorIndex}`}
                token={colorToken}
              />
            ))
          )
        }
      )
    })
  })

  return nodes
}

function renderInlineChildren(
  children: ReactNode,
  cwd: string,
  localPathKinds: ReadonlyMap<string, LocalPathKind>,
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void,
  remoteProject?: RemoteProjectFileContextValue | null
): ReactNode {
  if (typeof children === 'string') {
    return renderDecoratedText(
      children,
      cwd,
      'inline',
      localPathKinds,
      onOpenLocalPath,
      remoteProject
    )
  }
  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <Fragment key={index}>
        {renderInlineChildren(child, cwd, localPathKinds, onOpenLocalPath, remoteProject)}
      </Fragment>
    ))
  }
  return children
}

function InlineCode({
  children,
  cwd,
  localPathKinds,
  onOpenLocalPath,
  remoteProject
}: {
  children?: ReactNode
  cwd: string
  localPathKinds: ReadonlyMap<string, LocalPathKind>
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
  remoteProject?: RemoteProjectFileContextValue | null
}): React.JSX.Element {
  const codeText = textFromNode(children)
  const color = normalizeHexColor(codeText)
  if (color) return <ColorCode color={color} />
  const explicitRemotePath = remoteProject
    ? remotePathWithinProjectUri(codeText, remoteProject.hostAlias, remoteProject.canonicalRoot)
    : null
  if (explicitRemotePath) {
    return <LocalPathButton text={codeText} absolutePath={explicitRemotePath} pathKind="file" />
  }
  const localPath = inlineCodeFilePath(codeText, cwd)
  if (localPath) {
    const pathKind = renderableLocalPathKind(
      codeText,
      localPath,
      cwd,
      localPathKinds,
      remoteProject
    )
    if (pathKind) {
      return (
        <LocalPathButton
          text={codeText}
          absolutePath={localPath}
          pathKind={pathKind}
          onOpenLocalPath={onOpenLocalPath}
        />
      )
    }
  }

  const bareLocalPath = inlineCodeBareFilePath(codeText, cwd)
  const bareReference = bareLocalPath
    ? matchedBareFileReference(stripLineReference(codeText.trim()), cwd, localPathKinds)
    : null
  if (bareReference) {
    return (
      <LocalPathButton
        text={codeText}
        absolutePath={bareReference.absolutePath}
        pathKind={bareReference.pathKind}
        onOpenLocalPath={onOpenLocalPath}
      />
    )
  }

  const smiles = smilesExpressionFromInlineCode(codeText)
  if (smiles) return <MarkdownSmilesTokenView smiles={smiles} />

  return <InlineCodeShell>{children}</InlineCodeShell>
}

type MarkdownContentProps = {
  text: string
  cwd?: string
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
  enableMath?: boolean // off by default -- see markdownMathPlugins.ts for why
}

function MarkdownContentImpl({
  text,
  cwd = '',
  onOpenLocalPath,
  enableMath = false
}: MarkdownContentProps): React.JSX.Element {
  const remoteProject = useRemoteProjectFileContext()
  const localPathReferencePaths = useMemo(
    () => [
      ...new Set([
        ...collectBareFileReferencePaths(text, cwd),
        ...collectLocalPathTokenPaths(text, cwd)
      ])
    ],
    [cwd, text]
  )
  const statPathKinds = useLocalPathKinds(cwd, localPathReferencePaths, !remoteProject)
  const localPathKinds = useMemo<ReadonlyMap<string, LocalPathKind>>(() => {
    if (!remoteProject) return statPathKinds
    const kinds = new Map<string, LocalPathKind>()
    for (const path of collectBareFileReferencePaths(text, cwd)) {
      if (remotePathInsideRoot(path, remoteProject.canonicalRoot)) kinds.set(path, 'file')
    }
    return kinds
  }, [cwd, remoteProject, statPathKinds, text])
  const { remarkPlugins, rehypePlugins } = useMarkdownPlugins(enableMath)

  const components = useMemo<Components>(
    () => ({
      p: ({ children }) => (
        <Typography variant="body1" sx={{ my: 1, fontSize: 'inherit', lineHeight: 'inherit' }}>
          {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath, remoteProject)}
        </Typography>
      ),
      h1: ({ children }) => (
        <Typography variant="h6" component="h1" sx={{ mt: 2.5, mb: 1, fontWeight: 700 }}>
          {children}
        </Typography>
      ),
      h2: ({ children }) => (
        <Typography variant="subtitle1" component="h2" sx={{ mt: 2, mb: 1, fontWeight: 700 }}>
          {children}
        </Typography>
      ),
      h3: ({ children }) => (
        <Typography variant="subtitle2" component="h3" sx={{ mt: 1.5, mb: 0.5, fontWeight: 700 }}>
          {children}
        </Typography>
      ),
      ul: ({ children }) => (
        <Box component="ul" sx={{ my: 1, pl: 3, '& li': { mb: 0.5 } }}>
          {children}
        </Box>
      ),
      ol: ({ children }) => (
        <Box component="ol" sx={{ my: 1, pl: 3, '& li': { mb: 0.5 } }}>
          {children}
        </Box>
      ),
      li: ({ children }) => (
        <Typography component="li" sx={{ fontSize: 'inherit', lineHeight: 'inherit' }}>
          {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath, remoteProject)}
        </Typography>
      ),
      strong: ({ children }) => (
        <Box component="strong" sx={{ fontWeight: 700 }}>
          {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath, remoteProject)}
        </Box>
      ),
      em: ({ children }) => (
        <Box component="em" sx={{ fontStyle: 'italic' }}>
          {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath, remoteProject)}
        </Box>
      ),
      a: ({ href, children }) => {
        if (remoteProject && !href) return <InlineCodeShell>{children}</InlineCodeShell>
        if (remoteProject && typeof href === 'string') {
          const remotePath = remotePathWithinProjectUri(
            href,
            remoteProject.hostAlias,
            remoteProject.canonicalRoot
          )
          if (remotePath) {
            return (
              <LocalPathButton
                text={textFromNode(children) || href}
                absolutePath={remotePath}
                pathKind={href.endsWith('/') ? 'directory' : 'file'}
              />
            )
          }
          if (href.startsWith('ssh://')) return <InlineCodeShell>{children}</InlineCodeShell>
        }
        const localPath = localHrefToPath(href, cwd)
        if (localPath) {
          const label = textFromNode(children)
          const pathKind = renderableLocalPathKind(
            label,
            localPath,
            cwd,
            localPathKinds,
            remoteProject
          )
          if (pathKind) {
            return (
              <LocalPathButton
                text={label}
                absolutePath={localPath}
                pathKind={pathKind}
                onOpenLocalPath={onOpenLocalPath}
              />
            )
          }
          return (
            <>
              {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath, remoteProject)}
            </>
          )
        }

        return (
          <Link href={href} target="_blank" rel="noreferrer" sx={{ color: 'primary.light' }}>
            {children}
          </Link>
        )
      },
      img: ({ src, alt }) => (
        <MarkdownImage
          src={src}
          alt={alt}
          cwd={cwd}
          localPathKinds={localPathKinds}
          onOpenLocalPath={onOpenLocalPath}
        />
      ),
      hr: () => <Divider sx={{ my: 1.5 }} />,
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      code: ({ className, children }) =>
        className ? (
          <Box component="code" sx={{ fontFamily: 'var(--font-mono)', fontSize: 'inherit' }}>
            {children}
          </Box>
        ) : (
          <InlineCode
            cwd={cwd}
            localPathKinds={localPathKinds}
            onOpenLocalPath={onOpenLocalPath}
            remoteProject={remoteProject}
          >
            {children}
          </InlineCode>
        ),
      blockquote: ({ children }) => (
        <Box
          component="blockquote"
          sx={{
            m: 0,
            my: 1,
            pl: 2,
            borderLeft: 3,
            borderColor: 'grey.700',
            color: 'text.secondary'
          }}
        >
          {children}
        </Box>
      ),
      table: ({ children }) => (
        <Box sx={{ overflowX: 'auto', my: 1 }}>
          <Box
            component="table"
            sx={{
              borderCollapse: 'collapse',
              '& th, & td': {
                border: 1,
                borderColor: 'grey.800',
                px: 1.5,
                py: 0.5,
                fontSize: '0.88rem',
                textAlign: 'left'
              },
              '& th': { bgcolor: 'rgba(148, 163, 184, 0.08)', fontWeight: 700 }
            }}
          >
            {children}
          </Box>
        </Box>
      ),
      th: ({ children }) => (
        <Box component="th" sx={{ fontWeight: 700 }}>
          {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath, remoteProject)}
        </Box>
      ),
      td: ({ children }) => (
        <Box component="td">
          {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath, remoteProject)}
        </Box>
      )
    }),
    [cwd, localPathKinds, onOpenLocalPath, remoteProject]
  )

  return (
    <Box
      sx={{
        fontSize: '0.95rem',
        lineHeight: 1.7,
        minWidth: 0,
        maxWidth: '100%',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        '& > :first-of-type': { mt: 0 },
        '& > :last-child': { mb: 0 }
      }}
    >
      <ReactMarkdown
        skipHtml
        urlTransform={(value, key) =>
          remoteProject &&
          key === 'href' &&
          remotePathWithinProjectUri(value, remoteProject.hostAlias, remoteProject.canonicalRoot)
            ? value
            : defaultUrlTransform(value)
        }
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </Box>
  )
}

// `onOpenLocalPath` is intentionally excluded from the comparison: callers
// often pass a fresh closure each render, but it doesn't capture render-local
// state that would go stale, and including it would defeat memoization for
// every historical chat message while a later one streams in.
function markdownContentPropsEqual(
  prev: MarkdownContentProps,
  next: MarkdownContentProps
): boolean {
  return prev.text === next.text && prev.cwd === next.cwd && prev.enableMath === next.enableMath
}

const MarkdownContent = memo(MarkdownContentImpl, markdownContentPropsEqual)

export default MarkdownContent
