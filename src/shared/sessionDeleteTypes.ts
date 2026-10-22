export type SessionDeleteResult =
  { status: 'deleted' } | { status: 'connection-required' } | { status: 'confirmation-required' }
