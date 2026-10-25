import { Children, memo, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

export interface AnimatedListProps {
  children: ReactNode
  className?: string
  animateInitial?: boolean
}

/** Animates keyed, live additions and removals without cycling through old items. */
export const AnimatedList = memo(function AnimatedList({
  children,
  className,
  animateInitial = false
}: AnimatedListProps): React.JSX.Element {
  return (
    <div className={className}>
      <AnimatePresence initial={animateInitial}>{Children.toArray(children)}</AnimatePresence>
    </div>
  )
})

export function AnimatedListItem({
  children,
  enterDelayMs = 0
}: {
  children: ReactNode
  enterDelayMs?: number
}): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      layout={!reduceMotion}
      initial={reduceMotion ? false : { scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1, originY: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { scale: 0, opacity: 0 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { type: 'spring', stiffness: 350, damping: 40, delay: enterDelayMs / 1000 }
      }
      style={{ width: '100%' }}
    >
      {children}
    </motion.div>
  )
}
