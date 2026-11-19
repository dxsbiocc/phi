export type ExecutionResource = {
  namespace: string
  segments: readonly string[]
  access: 'shared' | 'exclusive'
}

function samePrefix(left: readonly string[], right: readonly string[]): boolean {
  const length = Math.min(left.length, right.length)

  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false
  }

  return true
}

export function resourcesConflict(
  left: readonly ExecutionResource[],
  right: readonly ExecutionResource[]
): boolean {
  for (const leftResource of left) {
    for (const rightResource of right) {
      if (leftResource.namespace !== rightResource.namespace) continue
      if (!samePrefix(leftResource.segments, rightResource.segments)) continue
      if (leftResource.access === 'shared' && rightResource.access === 'shared') {
        continue
      }

      return true
    }
  }

  return false
}

function snapshot(resources: readonly ExecutionResource[]): ExecutionResource[] {
  return resources.map((resource) => ({
    namespace: resource.namespace,
    segments: resource.segments.slice(),
    access: resource.access
  }))
}

export function createResourceAdmission(): {
  reserve(owner: string, resources: readonly ExecutionResource[]): (() => void) | null
  conflicts(resources: readonly ExecutionResource[]): boolean
} {
  const reservations = new Map<string, { resources: readonly ExecutionResource[] }>()

  function conflicts(resources: readonly ExecutionResource[]): boolean {
    for (const reservation of reservations.values()) {
      if (resourcesConflict(resources, reservation.resources)) {
        return true
      }
    }

    return false
  }

  function reserve(owner: string, resources: readonly ExecutionResource[]): (() => void) | null {
    if (reservations.has(owner)) return null

    const retained = snapshot(resources)
    if (conflicts(retained)) return null

    const reservation = { resources: retained }
    reservations.set(owner, reservation)

    let released = false

    return () => {
      if (released) return
      released = true

      if (reservations.get(owner) === reservation) {
        reservations.delete(owner)
      }
    }
  }

  return { reserve, conflicts }
}
