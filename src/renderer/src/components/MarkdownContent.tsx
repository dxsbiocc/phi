import { markdownCopy } from './markdown/markdownUiCopy'
import { useUiLanguage } from '../lib/i18n'
import { Box, Divider, Typography } from '@mui/material'
import {
  cloneElement,
  Fragment,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import { useMarkdownPlugins } from '../lib/markdownMathPlugins'
import {
  remotePathWithinProjectUri,
  tokenizeRemoteWorkspaceUris
} from '../../../shared/remoteWorkspacePath'
import {
  useRemoteProjectFileContext,
  type RemoteProjectFileContextValue
} from '../lib/remoteProjectFileContext'
import { collectLocalPathTokenPaths, tokenizeLocalPaths } from '../lib/localPaths'
import { smilesExpressionFromInlineCode } from '../lib/moleculeExpressions'
import type { FilePreview } from '../types'
import {
  collectBareFileReferencePaths,
  collectRemoteProjectReferencePaths,
  inlineCodeBareFilePath,
  inlineCodeFilePath,
  isInlinePreviewImagePath,
  isLocalPathHref,
  localHrefToPath,
  localPathKindForReference,
  matchedBareFileReference,
  matchedRemoteProjectPathReference,
  stripLineReference,
  tokenizeBareFileReferences,
  tokenizeRemoteProjectBareFileReferences,
  type LocalPathKind
} from '../lib/markdownLocalPathReferences'
import {
  normalizeHexColor,
  paletteColorsFromText,
  tokenizeMarkdownColors
} from '../lib/markdownColors'
import {
  ColorCode,
  ColorPalette,
  InlineCodeShell,
  MarkdownColorTokenView
} from './markdown/MarkdownColorToken'
import { LocalPathButton } from './markdown/LocalPathButton'
import { MarkdownSmilesTokenView } from './markdown/MarkdownSmilesToken'
import {
  canStatLocalPaths,
  useLocalPathKinds,
  useRemotePathKinds
} from '../lib/markdownLocalPathPreview'
import { MarkdownWebLink } from './markdown/MarkdownWebLink'
import { MarkdownCodeBlock } from './markdown/MarkdownCodeBlock'
import { ResourceMention } from './ResourceMention'
import { useChatResourceMatcher } from '../lib/chatResourceMentionContext'
import { createResourceMentionRemarkPlugin } from '../lib/markdownResourceMentions'
import { textFromNode } from '../lib/markdownText'

export type { LocalPathKind } from '../lib/markdownLocalPathReferences'

function omitHexColorNodes(node: ReactNode): ReactNode {
  if (typeof node === 'string') {
    const next = node
      .replace(
        /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g,
        ''
      )
      .replace(/[ \t]{2,}/g, ' ')
    return next.trim() ? next : null
  }
  if (Array.isArray(node)) return node.map(omitHexColorNodes)
  if (!isValidElement<{ children?: ReactNode }>(node)) return node
  if (normalizeHexColor(textFromNode(node).trim())) return null
  if (node.props.children == null) return node
  return cloneElement(node, undefined, omitHexColorNodes(node.props.children))
}

function renderPaletteLine(colors: string[]): React.JSX.Element {
  return (
    <Box component="span" sx={{ display: 'block' }}>
      <ColorPalette colors={colors} />
    </Box>
  )
}

function listPaletteColors(children: ReactNode): string[] {
  const items = Array.isArray(children) ? children : children == null ? [] : [children]
  const leftover: string[] = []
  for (const item of items) {
    const text = textFromNode(item)
    if (paletteColorsFromText(text).length >= 3) continue
    leftover.push(text)
  }
  return paletteColorsFromText(leftover.join('\n'))
}

function normalizeDirectoryPath(path: string): string {
  return path.replace(/\/+$/, '')
}

function isPathInsideDirectory(path: string, directory: string): boolean {
  const normalizedDirectory = normalizeDirectoryPath(directory)
  if (!normalizedDirectory) return false
  return path === normalizedDirectory || path.startsWith(`${normalizedDirectory}/`)
}

function renderableLocalPath(
  text: string,
  absolutePath: string,
  cwd: string,
  localPathKinds: ReadonlyMap<string, LocalPathKind>,
  remoteProject?: RemoteProjectFileContextValue | null
): { absolutePath: string; pathKind: LocalPathKind } | null {
  if (remoteProject) {
    return matchedRemoteProjectPathReference(text, absolutePath, cwd, remoteProject, localPathKinds)
  }
  const confirmedKind = localPathKinds.get(absolutePath)
  if (confirmedKind) return { absolutePath, pathKind: confirmedKind }
  if (canStatLocalPaths()) return null
  let pathKind: LocalPathKind
  if (isPathInsideDirectory(absolutePath, cwd)) {
    pathKind = localPathKindForReference(text, absolutePath, cwd, true)
  } else {
    pathKind = localPathKindForReference(text, absolutePath, cwd, false)
  }
  return { absolutePath, pathKind }
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
  useUiLanguage()
  const remoteProject = useRemoteProjectFileContext()
  const explicitRemotePath =
    remoteProject && src
      ? remotePathWithinProjectUri(src, remoteProject.hostAlias, remoteProject.canonicalRoot)
      : null
  const localPath = explicitRemotePath ?? localHrefToPath(src, cwd)
  const renderablePath = localPath
    ? renderableLocalPath(src || localPath, localPath, cwd, localPathKinds, remoteProject)
    : null
  const pathKind = renderablePath?.pathKind ?? null
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
    return renderablePath ? (
      <LocalPathButton
        text={alt || src || renderablePath.absolutePath}
        absolutePath={renderablePath.absolutePath}
        pathKind={renderablePath.pathKind}
      />
    ) : (
      <InlineCodeShell>{alt || src || ''}</InlineCodeShell>
    )
  }

  if (!localPath) {
    if (!src) return null
    if (isLocalPathHref(src)) return <InlineCodeShell>{alt || src}</InlineCodeShell>
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
          aria-label={markdownCopy.openFileAt(localPath)}
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

function LocalPathReference({
  text,
  absolutePath,
  pathKind,
  cwd,
  localPathKinds,
  onOpenLocalPath
}: {
  text: string
  absolutePath: string
  pathKind: LocalPathKind
  cwd: string
  localPathKinds: ReadonlyMap<string, LocalPathKind>
  onOpenLocalPath?: (absolutePath: string, pathKind: LocalPathKind) => void
}): React.JSX.Element {
  const remoteProject = useRemoteProjectFileContext()
  if (!remoteProject && pathKind === 'file' && isInlinePreviewImagePath(absolutePath)) {
    return (
      <MarkdownImage
        src={absolutePath}
        alt={text}
        cwd={cwd}
        localPathKinds={localPathKinds}
        onOpenLocalPath={onOpenLocalPath}
      />
    )
  }
  return (
    <LocalPathButton
      text={text}
      absolutePath={absolutePath}
      pathKind={pathKind}
      onOpenLocalPath={onOpenLocalPath}
    />
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
      const renderablePath = renderableLocalPath(
        remoteToken.text,
        remoteToken.path,
        cwd,
        localPathKinds,
        remoteProject
      )
      nodes.push(
        renderablePath ? (
          <LocalPathButton
            key={`${keyPrefix}-remote-${remoteIndex}`}
            text={remoteToken.text}
            absolutePath={renderablePath.absolutePath}
            pathKind={renderablePath.pathKind}
            onOpenLocalPath={onOpenLocalPath}
          />
        ) : (
          remoteToken.text
        )
      )
      return
    }
    tokenizeLocalPaths(remoteToken.text, cwd).forEach((token, pathIndex) => {
      if (token.kind === 'path') {
        const renderablePath = renderableLocalPath(
          token.text,
          token.absolutePath,
          cwd,
          localPathKinds,
          remoteProject
        )
        nodes.push(
          renderablePath ? (
            <LocalPathReference
              key={`${keyPrefix}-path-${remoteIndex}-${pathIndex}-${token.absolutePath}`}
              text={token.text}
              absolutePath={renderablePath.absolutePath}
              pathKind={renderablePath.pathKind}
              cwd={cwd}
              localPathKinds={localPathKinds}
              onOpenLocalPath={onOpenLocalPath}
            />
          ) : (
            token.text
          )
        )
        return
      }
      ;(remoteProject
        ? tokenizeRemoteProjectBareFileReferences(token.text, cwd, remoteProject, localPathKinds)
        : tokenizeBareFileReferences(token.text, cwd, localPathKinds)
      ).forEach((fileToken, fileIndex) => {
        if (fileToken.kind === 'path') {
          nodes.push(
            <LocalPathReference
              key={`${keyPrefix}-file-${remoteIndex}-${pathIndex}-${fileIndex}-${fileToken.absolutePath}`}
              text={fileToken.text}
              absolutePath={fileToken.absolutePath}
              pathKind={fileToken.pathKind}
              cwd={cwd}
              localPathKinds={localPathKinds}
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
      })
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
  useUiLanguage()
  const codeText = textFromNode(children)
  const color = normalizeHexColor(codeText)
  if (color) return <ColorCode color={color} />
  const explicitRemotePath = remoteProject
    ? remotePathWithinProjectUri(codeText, remoteProject.hostAlias, remoteProject.canonicalRoot)
    : null
  const localPath = explicitRemotePath ?? inlineCodeFilePath(codeText, cwd)
  if (localPath) {
    const renderablePath = renderableLocalPath(
      codeText,
      localPath,
      cwd,
      localPathKinds,
      remoteProject
    )
    if (renderablePath) {
      return (
        <LocalPathReference
          text={codeText}
          absolutePath={renderablePath.absolutePath}
          pathKind={renderablePath.pathKind}
          cwd={cwd}
          localPathKinds={localPathKinds}
          onOpenLocalPath={onOpenLocalPath}
        />
      )
    }
  }

  const bareLocalPath = inlineCodeBareFilePath(codeText, cwd)
  const bareReference = bareLocalPath
    ? remoteProject
      ? matchedRemoteProjectPathReference(
          stripLineReference(codeText.trim()),
          bareLocalPath,
          cwd,
          remoteProject,
          localPathKinds
        )
      : matchedBareFileReference(stripLineReference(codeText.trim()), cwd, localPathKinds)
    : null
  if (bareReference) {
    return (
      <LocalPathReference
        text={codeText}
        absolutePath={bareReference.absolutePath}
        pathKind={bareReference.pathKind}
        cwd={cwd}
        localPathKinds={localPathKinds}
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
  onOpenWebUrl?: (url: string) => void
  enableMath?: boolean // off by default -- see markdownMathPlugins.ts for why
  showColorPalettes?: boolean
}

function MarkdownContentImpl({
  text,
  cwd = '',
  onOpenLocalPath,
  onOpenWebUrl,
  enableMath = false,
  showColorPalettes = false
}: MarkdownContentProps): React.JSX.Element {
  useUiLanguage()
  const remoteProject = useRemoteProjectFileContext()
  const pathReferencePaths = useMemo(
    () =>
      remoteProject
        ? collectRemoteProjectReferencePaths(text, cwd, remoteProject)
        : [
            ...new Set([
              ...collectBareFileReferencePaths(text, cwd),
              ...collectLocalPathTokenPaths(text, cwd)
            ])
          ],
    [cwd, remoteProject, text]
  )
  const localStatPathKinds = useLocalPathKinds(cwd, pathReferencePaths, !remoteProject)
  const remoteStatPathKinds = useRemotePathKinds(remoteProject, pathReferencePaths)
  const localPathKinds = remoteProject ? remoteStatPathKinds : localStatPathKinds
  const { remarkPlugins, rehypePlugins } = useMarkdownPlugins(enableMath)
  const resourceMentions = useChatResourceMatcher()
  const plugins = useMemo(
    () => [...remarkPlugins, createResourceMentionRemarkPlugin(resourceMentions)],
    [remarkPlugins, resourceMentions]
  )

  const components = useMemo<Components>(
    () => ({
      p: ({ children }) => {
        const colors = showColorPalettes ? paletteColorsFromText(textFromNode(children)) : []
        const content = colors.length > 0 ? omitHexColorNodes(children) : children
        return (
          <Typography variant="body1" sx={{ my: 1, fontSize: 'inherit', lineHeight: 'inherit' }}>
            {renderInlineChildren(content, cwd, localPathKinds, onOpenLocalPath, remoteProject)}
            {colors.length > 0 && renderPaletteLine(colors)}
          </Typography>
        )
      },
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
      ul: ({ children }) => {
        const colors = showColorPalettes ? listPaletteColors(children) : []
        return (
          <>
            {colors.length > 0 && <ColorPalette colors={colors} />}
            <Box component="ul" sx={{ my: 1, pl: 3, '& li': { mb: 0.5 } }}>
              {children}
            </Box>
          </>
        )
      },
      ol: ({ children }) => {
        const colors = showColorPalettes ? listPaletteColors(children) : []
        return (
          <>
            {colors.length > 0 && <ColorPalette colors={colors} />}
            <Box component="ol" sx={{ my: 1, pl: 3, '& li': { mb: 0.5 } }}>
              {children}
            </Box>
          </>
        )
      },
      li: ({ children }) => {
        const ownsPalette = !isValidElement(children)
        const colors =
          showColorPalettes && ownsPalette ? paletteColorsFromText(textFromNode(children)) : []
        const content = colors.length > 0 ? omitHexColorNodes(children) : children
        return (
          <Typography component="li" sx={{ fontSize: 'inherit', lineHeight: 'inherit' }}>
            {renderInlineChildren(content, cwd, localPathKinds, onOpenLocalPath, remoteProject)}
            {colors.length > 0 && renderPaletteLine(colors)}
          </Typography>
        )
      },
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
        const resource = resourceMentions.resolveHref(href)
        if (resource) return <ResourceMention resource={resource} />
        if (remoteProject && !href) return <InlineCodeShell>{children}</InlineCodeShell>
        if (remoteProject && typeof href === 'string') {
          const remotePath = remotePathWithinProjectUri(
            href,
            remoteProject.hostAlias,
            remoteProject.canonicalRoot
          )
          if (remotePath) {
            const renderablePath = renderableLocalPath(
              href,
              remotePath,
              cwd,
              localPathKinds,
              remoteProject
            )
            if (!renderablePath) return <>{children}</>
            return (
              <LocalPathButton
                text={textFromNode(children) || href}
                absolutePath={renderablePath.absolutePath}
                pathKind={renderablePath.pathKind}
              />
            )
          }
          if (href.startsWith('ssh://')) return <InlineCodeShell>{children}</InlineCodeShell>
        }
        const localPath = localHrefToPath(href, cwd)
        if (localPath) {
          const label = textFromNode(children)
          const renderablePath = renderableLocalPath(
            href ?? label,
            localPath,
            cwd,
            localPathKinds,
            remoteProject
          )
          if (renderablePath) {
            return (
              <LocalPathReference
                text={label}
                absolutePath={renderablePath.absolutePath}
                pathKind={renderablePath.pathKind}
                cwd={cwd}
                localPathKinds={localPathKinds}
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
        if (isLocalPathHref(href)) {
          return (
            <>
              {renderInlineChildren(children, cwd, localPathKinds, onOpenLocalPath, remoteProject)}
            </>
          )
        }

        return (
          <MarkdownWebLink href={href} onOpenWebUrl={onOpenWebUrl}>
            {children}
          </MarkdownWebLink>
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
      pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
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
      table: ({ children }) => {
        const colors = showColorPalettes ? paletteColorsFromText(textFromNode(children)) : []
        return (
          <Box sx={{ my: 1 }}>
            {colors.length > 0 && <ColorPalette colors={colors} />}
            <Box sx={{ overflowX: 'auto' }}>
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
          </Box>
        )
      },
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
    [
      cwd,
      localPathKinds,
      onOpenLocalPath,
      onOpenWebUrl,
      remoteProject,
      showColorPalettes,
      resourceMentions
    ]
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
          key === 'href' && resourceMentions.resolveHref(value)
            ? value
            : remoteProject &&
                key === 'href' &&
                remotePathWithinProjectUri(
                  value,
                  remoteProject.hostAlias,
                  remoteProject.canonicalRoot
                )
              ? value
              : defaultUrlTransform(value)
        }
        remarkPlugins={plugins}
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
// every historical chat message while a later one streams in. The web opener
// is included because adding or removing it changes the anchor click behavior.
function markdownContentPropsEqual(
  prev: MarkdownContentProps,
  next: MarkdownContentProps
): boolean {
  return (
    prev.text === next.text &&
    prev.cwd === next.cwd &&
    prev.onOpenWebUrl === next.onOpenWebUrl &&
    prev.enableMath === next.enableMath &&
    prev.showColorPalettes === next.showColorPalettes
  )
}

const MarkdownContent = memo(MarkdownContentImpl, markdownContentPropsEqual)

export default MarkdownContent
