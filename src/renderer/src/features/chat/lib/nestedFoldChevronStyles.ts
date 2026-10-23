export const nestedFoldChevronRevealSx = {
  '& .phi-nested-fold-chevron': {
    opacity: 0,
    transition: 'opacity 150ms, transform 150ms'
  },
  '&:hover .phi-nested-fold-chevron, &:focus-within .phi-nested-fold-chevron': {
    opacity: 1
  },
  '@media (hover: none)': {
    '& .phi-nested-fold-chevron': { opacity: 1 }
  }
} as const
