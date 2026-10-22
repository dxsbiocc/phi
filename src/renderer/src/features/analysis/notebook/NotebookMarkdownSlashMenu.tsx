import { analysisCopy } from '../lib/analysisUiCopy'
import { useUiLanguage } from '../../../lib/i18n'
import { useEffect, useRef } from 'react'
import {
  ListItemIcon,
  ListItemText,
  MenuItem,
  MenuList,
  Paper,
  Popper,
  Typography
} from '@mui/material'
import {
  FiBold,
  FiCode,
  FiGrid,
  FiHash,
  FiImage,
  FiItalic,
  FiLink,
  FiList,
  FiMessageSquare
} from 'react-icons/fi'
import { markdownInsertLabel, type MarkdownInsertKind } from './markdownInsert'

const icons = {
  bold: FiBold,
  italic: FiItalic,
  link: FiLink,
  formula: FiHash,
  codeBlock: FiCode,
  image: FiImage,
  list: FiList,
  quote: FiMessageSquare,
  table: FiGrid
} as const satisfies Record<MarkdownInsertKind, typeof FiBold>

export function NotebookMarkdownSlashMenu({
  anchor,
  menuId,
  kinds,
  activeIndex,
  onActiveIndexChange,
  onInsert
}: {
  anchor: DOMRect | null
  menuId: string
  kinds: readonly MarkdownInsertKind[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onInsert: (kind: MarkdownInsertKind) => void
}): React.JSX.Element {
  useUiLanguage()
  const paperRef = useRef<HTMLDivElement | null>(null)
  const activeKind = kinds[activeIndex]

  useEffect(() => {
    const paper = paperRef.current
    const option = activeKind && document.getElementById(`${menuId}-${activeKind}`)
    if (!paper || !option) return
    const paperRect = paper.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    if (optionRect.top < paperRect.top) paper.scrollTop -= paperRect.top - optionRect.top
    else if (optionRect.bottom > paperRect.bottom)
      paper.scrollTop += optionRect.bottom - paperRect.bottom
  }, [activeKind, menuId])

  return (
    <Popper
      open={Boolean(anchor)}
      anchorEl={anchor ? { getBoundingClientRect: () => anchor } : null}
      placement="bottom-start"
      modifiers={[{ name: 'offset', options: { offset: [0, 6] } }]}
      sx={{ zIndex: (theme) => theme.zIndex.modal + 1 }}
    >
      <Paper
        ref={paperRef}
        id={menuId}
        data-phi-notebook-markdown-slash-menu="true"
        elevation={5}
        sx={{ width: 236, maxHeight: 248, overflowY: 'auto', borderRadius: 2 }}
      >
        {kinds.length ? (
          <MenuList role="listbox" aria-label={analysisCopy.insertIntoMarkdown} dense>
            {kinds.map((kind, index) => {
              const Icon = icons[kind]
              return (
                <MenuItem
                  key={kind}
                  id={`${menuId}-${kind}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  selected={index === activeIndex}
                  tabIndex={-1}
                  onMouseEnter={() => onActiveIndexChange(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => onInsert(kind)}
                >
                  <ListItemIcon sx={{ minWidth: 28 }}>
                    <Icon size={16} />
                  </ListItemIcon>
                  <ListItemText primary={markdownInsertLabel(kind)} />
                </MenuItem>
              )
            })}
          </MenuList>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, py: 1.25 }}>
            {analysisCopy.noMatchingMarkdownInserts}
          </Typography>
        )}
      </Paper>
    </Popper>
  )
}
