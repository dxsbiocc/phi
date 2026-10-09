import { Box, Stack, TextField } from '@mui/material'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { RemoteDirectoryListing } from '../../../../../shared/remoteDirectoryBrowser'
import type { DirectoryListing } from '../../../types'
import { ProjectFileTree } from '../../file-preview/components/ProjectFileTree'
import {
  normalizeAbsoluteTreePath,
  resolveFuzzyTreePath
} from '../../file-preview/lib/fileTreeReveal'

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
  const listingRequestsRef = useRef(new Map<string, Promise<DirectoryListing>>())
  const resolutionRef = useRef(0)

  const listDirectory = useCallback(
    (path: string): Promise<DirectoryListing> => {
      const key = `${hostProfileId}\0${path}`
      const existing = listingRequestsRef.current.get(key)
      if (existing) return existing
      const request = window.api
        .listRemoteProjectDirectories({
          hostProfileId,
          path
        })
        .then(directoryListing)
        .catch((error) => {
          listingRequestsRef.current.delete(key)
          throw error
        })
      listingRequestsRef.current.set(key, request)
      return request
    },
    [hostProfileId]
  )

  useEffect(() => {
    const resolution = ++resolutionRef.current
    const timer = window.setTimeout(() => {
      const normalized = normalizeAbsoluteTreePath(selectedPath)
      if (!normalized) {
        setLocatedPath('')
        return
      }
      void resolveFuzzyTreePath(normalized, async (path) => {
        const listing = await listDirectory(path)
        return listing.entries.map((entry) => ({ name: entry.name, path: entry.path }))
      })
        .then((path) => {
          if (resolution === resolutionRef.current) setLocatedPath(path)
        })
        .catch(() => {
          // ProjectFileTree renders transport and permission failures at the exact directory row.
        })
    }, DIRECTORY_REVEAL_DELAY_MS)
    return () => {
      resolutionRef.current += 1
      window.clearTimeout(timer)
    }
  }, [listDirectory, selectedPath])

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
          genericDirectoryIcons
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
