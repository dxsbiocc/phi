import { Box, Stack, TextField } from '@mui/material'
import { useCallback, useEffect, useState } from 'react'

import type { RemoteDirectoryListing } from '../../../../../shared/remoteDirectoryBrowser'
import type { DirectoryListing } from '../../../types'
import { ProjectFileTree } from '../../file-preview/components/ProjectFileTree'
import { normalizeAbsoluteTreePath } from '../../file-preview/lib/fileTreeReveal'

const DIRECTORY_REVEAL_DELAY_MS = 400

function directoryListing(result: RemoteDirectoryListing): DirectoryListing {
  return {
    path: result.path,
    name: result.path === '/' ? '/' : (result.path.split('/').filter(Boolean).pop() ?? result.path),
    displayPath: result.path,
    rootPath: '/',
    rootLabel: '/',
    entries: result.directories.map((entry) => ({
      path: entry.path,
      name: entry.name,
      displayPath: entry.path,
      kind: 'directory'
    })),
    truncated: result.truncated
  }
}

export function RemoteDirectoryTree({
  hostProfileId,
  selectedPath,
  onSelectPath
}: {
  hostProfileId: string
  selectedPath: string
  onSelectPath: (path: string) => void
}): React.JSX.Element {
  const [locatedPath, setLocatedPath] = useState(
    () => normalizeAbsoluteTreePath(selectedPath) ?? ''
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLocatedPath(normalizeAbsoluteTreePath(selectedPath) ?? '')
    }, DIRECTORY_REVEAL_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [hostProfileId, selectedPath])

  const listDirectory = useCallback(
    async (path: string): Promise<DirectoryListing> =>
      directoryListing(
        await window.api.listRemoteProjectDirectories({
          hostProfileId,
          path
        })
      ),
    [hostProfileId]
  )

  const inputPathIsInvalid = Boolean(selectedPath) && !normalizeAbsoluteTreePath(selectedPath)

  return (
    <Stack spacing={1}>
      <TextField
        fullWidth
        label="服务器上的项目目录"
        value={selectedPath}
        onChange={(event) => onSelectPath(event.target.value)}
        placeholder="/cluster/lab/project"
        error={inputPathIsInvalid}
        helperText={
          inputPathIsInvalid
            ? '请输入以 / 开头的服务器绝对路径。'
            : '可直接输入绝对路径，或在下方目录树中选择。'
        }
      />
      <Box
        sx={{
          height: 260,
          minHeight: 220,
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1.5,
          bgcolor: 'background.paper'
        }}
      >
        <ProjectFileTree
          key={hostProfileId}
          rootPath="/"
          activePath={locatedPath}
          onOpenFile={() => undefined}
          onSelectDirectory={(path) => {
            setLocatedPath(path)
            onSelectPath(path)
          }}
          onListDirectory={listDirectory}
          revealPath={locatedPath}
          searchPlaceholder="筛选文件夹..."
          stateKey={`remote-project:${hostProfileId}`}
          variant="standalone"
        />
      </Box>
    </Stack>
  )
}
