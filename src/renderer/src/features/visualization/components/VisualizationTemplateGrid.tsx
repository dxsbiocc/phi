import { visualizationCopy } from '../lib/visualizationCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { useEffect, useRef, useState } from 'react'
import { Box, Dialog, DialogContent, DialogTitle, IconButton, Typography } from '@mui/material'
import { FiChevronLeft, FiChevronRight } from 'react-icons/fi'

import { PhiIcons } from '../../../icons'
import type { VisualizationTemplate } from '../../../../../shared/visualizationTemplateTypes'

const previewCache = new Map<string, string>()
const decodedImages = new WeakMap<HTMLImageElement, string>()

function warmImage(url: string): void {
  const image = new Image()
  image.decoding = 'async'
  image.src = url
  if (typeof image.decode === 'function') void image.decode().catch(() => undefined)
}

function loadTemplatePreview(path: string): Promise<string | null> {
  const cached = previewCache.get(path)
  if (cached) return Promise.resolve(cached)
  if (typeof window === 'undefined' || !window.api?.previewFile) return Promise.resolve(null)
  return window.api
    .previewFile(path)
    .then((preview) => {
      if (preview.kind !== 'image') return null
      previewCache.set(path, preview.dataUrl)
      warmImage(preview.dataUrl)
      return preview.dataUrl
    })
    .catch(() => null)
}

/** Keep the previous frame on screen until the requested preview is ready. */
function useDisplayedPreview(path: string | null): string | null {
  const cached = path ? (previewCache.get(path) ?? null) : null
  const [fallback, setFallback] = useState<{ path: string; url: string } | null>(null)

  useEffect(() => {
    if (!path || previewCache.has(path)) return
    let cancelled = false
    void loadTemplatePreview(path).then((url) => {
      if (!cancelled && url) setFallback({ path, url })
    })
    return () => {
      cancelled = true
    }
  }, [path])

  if (!path) return null
  if (cached) return cached
  if (fallback?.path === path) return fallback.url
  return fallback?.url ?? null
}

export function VisualizationTemplateGrid({
  templates,
  emptyLabel,
  onOpen
}: {
  templates: readonly VisualizationTemplate[]
  emptyLabel: string
  onOpen: (template: VisualizationTemplate) => void
}): React.JSX.Element {
  useUiLanguage()

  if (templates.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 6, textAlign: 'center' }}>
        {emptyLabel}
      </Typography>
    )
  }

  return (
    <Box
      data-phi-visualization-grid="true"
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 1.5,
        alignContent: 'start',
        p: 2
      }}
    >
      {templates.map((template) => (
        <TemplateCard
          key={template.previewPath}
          template={template}
          onOpen={() => onOpen(template)}
        />
      ))}
    </Box>
  )
}

function TemplateCard({
  template,
  onOpen
}: {
  template: VisualizationTemplate
  onOpen: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
      },
      { rootMargin: '240px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    void loadTemplatePreview(template.previewPath).then((url) => {
      if (!cancelled) setDataUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [template.previewPath, visible])

  return (
    <Box
      component="button"
      type="button"
      ref={ref}
      data-phi-template-id={template.id}
      aria-label={visualizationCopy.openPreview(template.title)}
      onClick={onOpen}
      sx={templateCardSx}
    >
      <TemplatePreview dataUrl={dataUrl} />
    </Box>
  )
}

const templateCardSx = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  minWidth: 0,
  p: 0,
  border: 1,
  borderColor: 'divider',
  borderRadius: 1.5,
  overflow: 'hidden',
  bgcolor: 'background.paper',
  color: 'text.primary',
  cursor: 'pointer',
  textAlign: 'left',
  '&:hover': { borderColor: 'primary.main' },
  '&:focus-visible': {
    outline: '2px solid',
    outlineColor: 'primary.main',
    outlineOffset: 2
  }
} as const

const previewDialogPaperSx = {
  width: 'min(800px, calc(100% - 32px))',
  maxWidth: 800,
  maxHeight: 'calc(100% - 32px)'
} as const

const previewFrameSx = {
  width: 'min(640px, 100%)',
  maxWidth: 640,
  height: 'min(480px, 56vh)',
  maxHeight: 480,
  minWidth: 0,
  position: 'relative',
  overflow: 'hidden',
  flexShrink: 0
} as const

function TemplatePreview({ dataUrl }: { dataUrl: string | null }): React.JSX.Element {
  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        aspectRatio: '4 / 3',
        overflow: 'hidden',
        bgcolor: '#fff'
      }}
    >
      {dataUrl ? (
        <Box
          component="img"
          src={dataUrl}
          alt=""
          sx={{
            position: 'absolute',
            top: 10,
            left: 10,
            width: 'calc(100% - 20px)',
            height: 'calc(100% - 20px)',
            maxWidth: 'calc(100% - 20px)',
            maxHeight: 'calc(100% - 20px)',
            objectFit: 'contain'
          }}
        />
      ) : null}
    </Box>
  )
}

export function VisualizationTemplateDialog({
  template,
  previousPath,
  nextPath,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  onClose
}: {
  template: VisualizationTemplate | null
  previousPath?: string
  nextPath?: string
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}): React.JSX.Element {
  useUiLanguage()
  const dataUrl = useDisplayedPreview(template?.previewPath ?? null)

  useEffect(() => {
    const paths = [previousPath, nextPath].filter((path): path is string => Boolean(path))
    for (const path of paths) {
      void loadTemplatePreview(path).then((url) => {
        if (url) warmImage(url)
      })
    }
  }, [previousPath, nextPath])

  return (
    <Dialog
      open={template !== null}
      onClose={onClose}
      maxWidth={false}
      slotProps={{ paper: { sx: previewDialogPaperSx } }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' && hasPrevious) onPrevious()
        if (event.key === 'ArrowRight' && hasNext) onNext()
      }}
    >
      <DialogTitle
        sx={{
          position: 'relative',
          height: 56,
          px: 6,
          overflow: 'hidden',
          lineHeight: '24px',
          textAlign: 'center',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis'
        }}
      >
        {template?.title}
        <IconButton
          aria-label={visualizationCopy.closePreview}
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
        >
          <PhiIcons.action.close size={18} />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ overflow: 'hidden' }}>
        <VisualizationPreviewStage
          title={template?.title ?? ''}
          dataUrl={dataUrl}
          hasPrevious={hasPrevious}
          hasNext={hasNext}
          onPrevious={onPrevious}
          onNext={onNext}
        />
      </DialogContent>
    </Dialog>
  )
}

export function VisualizationPreviewStage({
  title,
  dataUrl,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext
}: {
  title: string
  dataUrl: string | null
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
}): React.JSX.Element {
  useUiLanguage()
  return (
    <Box
      data-phi-preview-stage="true"
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        bgcolor: '#fff',
        borderRadius: 1,
        minHeight: 240,
        '&:hover .phi-carousel-nav, &:focus-within .phi-carousel-nav': {
          opacity: 0.7,
          pointerEvents: 'auto'
        },
        '&:hover .phi-carousel-nav.Mui-disabled, &:focus-within .phi-carousel-nav.Mui-disabled': {
          opacity: 0.4
        }
      }}
    >
      <CarouselButton
        label={visualizationCopy.previousTemplate}
        disabled={!hasPrevious}
        onClick={onPrevious}
      >
        <FiChevronLeft size={22} />
      </CarouselButton>
      <Box sx={previewFrameSx}>
        <StablePreview src={dataUrl} alt={title} />
      </Box>
      <CarouselButton label={visualizationCopy.nextTemplate} disabled={!hasNext} onClick={onNext}>
        <FiChevronRight size={22} />
      </CarouselButton>
    </Box>
  )
}

type PreviewSlots = {
  a: string | null
  b: string | null
  aReady: boolean
  bReady: boolean
  top: 'a' | 'b'
}

function nextPreviewSlots(slots: PreviewSlots, src: string | null): PreviewSlots | null {
  const topSrc = slots.top === 'a' ? slots.a : slots.b
  if (src === topSrc) return null
  if (!src) return { a: null, b: null, aReady: false, bReady: false, top: 'a' }
  if (!topSrc) return slots.top === 'a' ? { ...slots, a: src } : { ...slots, b: src }
  const hidden = slots.top === 'a' ? 'b' : 'a'
  const hiddenSrc = hidden === 'a' ? slots.a : slots.b
  const hiddenReady = hidden === 'a' ? slots.aReady : slots.bReady
  if (hiddenSrc === src) return hiddenReady ? { ...slots, top: hidden } : null
  if (hidden === 'b') return { ...slots, b: src, bReady: false }
  return { ...slots, a: src, aReady: false }
}

function revealPreviewSlot(
  slots: PreviewSlots,
  slot: 'a' | 'b',
  url: string,
  src: string | null
): PreviewSlots {
  const ready = slot === 'a' ? { ...slots, aReady: true } : { ...slots, bReady: true }
  if (src !== url || slots.top === slot) {
    const unchanged = slot === 'a' ? slots.aReady : slots.bReady
    return unchanged ? slots : ready
  }
  return { ...ready, top: slot }
}

function StablePreview({ src, alt }: { src: string | null; alt: string }): React.JSX.Element {
  const [slots, setSlots] = useState<PreviewSlots>({
    a: src,
    b: null,
    aReady: false,
    bReady: false,
    top: 'a'
  })
  const next = nextPreviewSlots(slots, src)
  if (next) setSlots(next)

  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        bgcolor: '#fff'
      }}
    >
      <PreviewFrame
        src={slots.a}
        alt={slots.top === 'a' ? alt : ''}
        covered={slots.top !== 'a'}
        decoded={slots.aReady}
        onReady={(url) => setSlots((current) => revealPreviewSlot(current, 'a', url, src))}
      />
      <PreviewFrame
        src={slots.b}
        alt={slots.top === 'b' ? alt : ''}
        covered={slots.top !== 'b'}
        decoded={slots.bReady}
        onReady={(url) => setSlots((current) => revealPreviewSlot(current, 'b', url, src))}
      />
    </Box>
  )
}

function revealDecodedImage(image: HTMLImageElement, onReady: (url: string) => void): void {
  const url = image.getAttribute('src')
  if (!url || decodedImages.get(image) === url) return
  const finish = (): void => {
    if (image.getAttribute('src') !== url) return
    decodedImages.set(image, url)
    onReady(url)
  }
  if (typeof image.decode !== 'function') {
    finish()
    return
  }
  void image.decode().then(finish, finish)
}

function PreviewFrame({
  src,
  alt,
  covered,
  decoded,
  onReady
}: {
  src: string | null
  alt: string
  covered: boolean
  decoded: boolean
  onReady: (url: string) => void
}): React.JSX.Element | null {
  if (!src) return null
  return (
    <Box
      aria-hidden={covered || undefined}
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: covered ? 0 : 1,
        bgcolor: '#fff',
        visibility: covered && !decoded ? 'hidden' : 'visible'
      }}
    >
      <Box
        component="img"
        src={src}
        alt={alt}
        ref={(node: HTMLImageElement | null) => {
          if (node?.complete && node.naturalWidth > 0) revealDecodedImage(node, onReady)
        }}
        onLoad={(event) => revealDecodedImage(event.currentTarget, onReady)}
        sx={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
      />
    </Box>
  )
}

function CarouselButton({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <IconButton
      className="phi-carousel-nav"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      sx={{
        flexShrink: 0,
        width: 40,
        height: 40,
        opacity: 0,
        pointerEvents: 'none',
        color: 'common.black',
        bgcolor: '#fff',
        boxShadow: '0 8px 24px rgba(0,0,0,0.16)',
        transition: 'opacity 180ms ease, transform 180ms ease',
        '&:hover': {
          bgcolor: '#fff',
          opacity: 1,
          transform: 'scale(1.1)'
        },
        '&.Mui-disabled': {
          color: 'common.black',
          bgcolor: '#fff'
        }
      }}
    >
      {children}
    </IconButton>
  )
}
