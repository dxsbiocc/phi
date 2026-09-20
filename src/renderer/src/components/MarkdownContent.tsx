import { Box, Button, Divider, Link, Tooltip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { Fragment, isValidElement, memo, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { PhiIcons, directoryIconForPath, fileIconForPath } from '../icons'
import { useMarkdownPlugins } from '../lib/markdownMathPlugins'
import { tokenizeLocalPaths } from '../lib/localPaths'
import { highlightLine, type SyntaxLanguage } from '../lib/syntaxHighlight'
import { syntaxTokenColor } from '../lib/syntaxTheme'
import { smilesExpressionFromInlineCode } from '../lib/moleculeExpressions'
import { databaseWebPreviewKindFromString } from '../../../shared/databaseWebPreview'
import {
  collectBareFileReferencePaths,
  inlineCodeBareFilePath,
  inlineCodeFilePath,
  localHrefToPath,
  localPathKindForReference,
  localPathLabel,
  matchedBareFileReference,
  stripLineReference,
  tokenizeBareFileReferences,
  type LocalPathKind
} from '../lib/markdownLocalPathReferences'
import { normalizeHexColor, tokenizeMarkdownColors } from '../lib/markdownColors'
import { ColorCode, InlineCodeShell, MarkdownColorTokenView } from './markdown/MarkdownColorToken'
import { LocalFileHoverPreview } from './markdown/MarkdownHoverPreview'
import { MarkdownSmilesTokenView } from './markdown/MarkdownSmilesToken'
import { StringNetworkPreview } from './markdown/StringNetworkPreview'
import { KeggPathwayPreview } from './markdown/KeggPathwayPreview'
import {
  HOVER_PREVIEW_OPEN_DELAY_MS,
  localPathTooltipSlotProps,
  useLocalPathKinds
} from '../lib/markdownLocalPathPreview'

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

function LocalPathButton({
  text,
  absolutePath,
  pathKind = 'file',
  onOpenLocalPath
}: {
  text: string
  absolutePath: string
  pathKind?: LocalPathKind
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
}): React.JSX.Element {
  const label = localPathLabel(text, absolutePath)
  const pathIcon =
    pathKind === 'directory' ? directoryIconForPath(absolutePath) : fileIconForPath(absolutePath)
  const LocalFileIcon = pathIcon.Icon
  const supportsHoverPreview = pathKind === 'file'
  const [hoverPreviewActive, setHoverPreviewActive] = useState(false)
  const button = (
    <Tooltip
      title={
        supportsHoverPreview ? (
          <LocalFileHoverPreview absolutePath={absolutePath} shouldLoad={hoverPreviewActive} />
        ) : (
          absolutePath
        )
      }
      placement="top-start"
      arrow
      slotProps={localPathTooltipSlotProps}
      enterDelay={HOVER_PREVIEW_OPEN_DELAY_MS}
      leaveDelay={80}
      onOpen={() => {
        if (supportsHoverPreview) setHoverPreviewActive(true)
      }}
      onClose={() => {
        if (supportsHoverPreview) setHoverPreviewActive(false)
      }}
    >
      <Box
        component="button"
        type="button"
        data-phi-slot="local-file-link"
        data-phi-file-kind={pathIcon.kind}
        data-phi-path={absolutePath}
        aria-label={`${pathKind === 'directory' ? '打开目录' : '打开文件'} ${absolutePath}`}
        onClick={() => {
          if (onOpenLocalPath) {
            onOpenLocalPath(absolutePath, pathKind)
            return
          }

          void window.api.revealPath(absolutePath).catch((error) => {
            console.error('Failed to reveal local path:', error)
          })
        }}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.45,
          maxWidth: '100%',
          minWidth: 0,
          px: 0.25,
          py: 0,
          mx: 0.1,
          border: 0,
          borderRadius: 0.75,
          bgcolor: 'transparent',
          color: 'primary.main',
          font: 'inherit',
          fontWeight: 500,
          lineHeight: 'inherit',
          verticalAlign: 'baseline',
          cursor: 'pointer',
          overflowWrap: 'normal',
          textDecoration: 'none',
          '&:hover': {
            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.08),
            color: 'primary.dark'
          },
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2
          }
        }}
      >
        <LocalFileIcon fontSize="inherit" sx={{ color: pathIcon.color, fontSize: '1em' }} />
        <Box
          component="span"
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {label}
        </Box>
      </Box>
    </Tooltip>
  )

  if (!supportsHoverPreview) return button

  return (
    <Box
      component="span"
      data-phi-slot="local-file-hover-preview"
      data-phi-hover-preview-path={absolutePath}
      sx={{
        display: 'inline',
        maxWidth: '100%',
        minWidth: 0
      }}
    >
      {button}
    </Box>
  )
}

function renderDecoratedText(
  text: string,
  cwd: string,
  keyPrefix: string,
  localPathKinds: ReadonlyMap<string, LocalPathKind>,
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
): ReactNode[] {
  const nodes: ReactNode[] = []

  tokenizeLocalPaths(text, cwd).forEach((token, pathIndex) => {
    if (token.kind === 'path') {
      nodes.push(
        <LocalPathButton
          key={`${keyPrefix}-path-${pathIndex}-${token.absolutePath}`}
          text={token.text}
          absolutePath={token.absolutePath}
          pathKind={localPathKindForReference(token.text, token.absolutePath, cwd, true)}
          onOpenLocalPath={onOpenLocalPath}
        />
      )
      return
    }

    tokenizeBareFileReferences(token.text, cwd, localPathKinds).forEach((fileToken, fileIndex) => {
      if (fileToken.kind === 'path') {
        nodes.push(
          <LocalPathButton
            key={`${keyPrefix}-file-${pathIndex}-${fileIndex}-${fileToken.absolutePath}`}
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
            key={`${keyPrefix}-color-${pathIndex}-${fileIndex}-${colorIndex}`}
            token={colorToken}
          />
        ))
      )
    })
  })

  return nodes
}

function renderInlineChildren(
  children: ReactNode,
  cwd: string,
  localPathKinds: ReadonlyMap<string, LocalPathKind>,
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
): ReactNode {
  if (typeof children === 'string') {
    return renderDecoratedText(children, cwd, 'inline', localPathKinds, onOpenLocalPath)
  }
  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <Fragment key={index}>
        {renderInlineChildren(child, cwd, localPathKinds, onOpenLocalPath)}
      </Fragment>
    ))
  }
  return children
}

function InlineCode({
  children,
  cwd,
  localPathKinds,
  onOpenLocalPath
}: {
  children?: ReactNode
  cwd: string
  localPathKinds: ReadonlyMap<string, LocalPathKind>
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
}): React.JSX.Element {
  const codeText = textFromNode(children)
  const color = normalizeHexColor(codeText)
  if (color) return <ColorCode color={color} />
  const localPath = inlineCodeFilePath(codeText, cwd)
  if (localPath) {
    const pathKind = localPathKindForReference(codeText, localPath, cwd, true)
    return (
      <LocalPathButton
        text={codeText}
        absolutePath={localPath}
        pathKind={pathKind}
        onOpenLocalPath={onOpenLocalPath}
      />
    )
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
  const bareFileReferencePaths = useMemo(
    () => collectBareFileReferencePaths(text, cwd),
    [cwd, text]
  )
  const localPathKinds = useLocalPathKinds(cwd, bareFileReferencePaths)
  const { remarkPlugins, rehypePlugins } = useMarkdownPlugins(enableMath)

  const components = useMemo<Components>(
    () => ({
      p: ({ children }) => (
        <Typography variant="body1" sx={{ my: 1, fontSize: 'inherit', lineHeight: 'inherit' }}>
          {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath)}
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
          {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath)}
        </Typography>
      ),
      strong: ({ children }) => (
        <Box component="strong" sx={{ fontWeight: 700 }}>
          {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath)}
        </Box>
      ),
      em: ({ children }) => (
        <Box component="em" sx={{ fontStyle: 'italic' }}>
          {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath)}
        </Box>
      ),
      a: ({ href, children }) => {
        const localPath = localHrefToPath(href, cwd)
        if (localPath) {
          const pathKind = localPathKindForReference(textFromNode(children), localPath, cwd, true)
          return (
            <LocalPathButton
              text={textFromNode(children)}
              absolutePath={localPath}
              pathKind={pathKind}
              onOpenLocalPath={onOpenLocalPath}
            />
          )
        }

        if (typeof href === 'string') {
          const databasePreviewKind = databaseWebPreviewKindFromString(href)
          if (databasePreviewKind === 'string-network') {
            return <StringNetworkPreview href={href} label={textFromNode(children) || href} />
          }
          if (databasePreviewKind === 'kegg-pathway') {
            return <KeggPathwayPreview href={href} label={textFromNode(children) || href} />
          }
        }

        return (
          <Link href={href} target="_blank" rel="noreferrer" sx={{ color: 'primary.light' }}>
            {children}
          </Link>
        )
      },
      hr: () => <Divider sx={{ my: 1.5 }} />,
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      code: ({ className, children }) =>
        className ? (
          <Box component="code" sx={{ fontFamily: 'var(--font-mono)', fontSize: 'inherit' }}>
            {children}
          </Box>
        ) : (
          <InlineCode cwd={cwd} localPathKinds={localPathKinds} onOpenLocalPath={onOpenLocalPath}>
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
          {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath)}
        </Box>
      ),
      td: ({ children }) => (
        <Box component="td">
          {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath)}
        </Box>
      )
    }),
    [cwd, localPathKinds, onOpenLocalPath]
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
