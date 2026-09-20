import { Alert, Box, Chip, Stack, Typography } from '@mui/material'
import { useMemo } from 'react'
import {
  MolstarStructureViewer,
  type MolstarStructureSource
} from '../../../components/MolstarStructureViewer'
import type { FilePreview } from '../../../types'
import type { MolecularStructureFileFormat } from '../lib/molecularStructureFiles'

export function MolecularStructureFilePreview({
  file,
  format
}: {
  file: Extract<FilePreview, { kind: 'text' }>
  format: MolecularStructureFileFormat
}): React.JSX.Element {
  const source = useMemo<MolstarStructureSource>(
    () => ({
      kind: 'data',
      value: file.content,
      format,
      label: file.name
    }),
    [file.content, file.name, format]
  )
  const formatLabel = format === 'pdb' ? 'PDB' : 'mmCIF'

  return (
    <Box
      data-phi-molecular-structure-file-preview="true"
      data-phi-molecular-structure-format={format}
      sx={{
        flexShrink: 0,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        p: 1.5
      }}
    >
      <Stack spacing={1}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            结构预览
          </Typography>
          <Chip size="small" label="Mol*" />
          <Chip size="small" variant="outlined" label={formatLabel} />
          <Chip size="small" variant="outlined" label={file.name} />
        </Stack>

        {file.truncated ? (
          <Alert severity="warning" variant="outlined">
            文件内容已截断，Mol* 可能无法解析完整结构；下方仍保留文本预览。
          </Alert>
        ) : null}

        <MolstarStructureViewer source={source} height={360} />
      </Stack>
    </Box>
  )
}
