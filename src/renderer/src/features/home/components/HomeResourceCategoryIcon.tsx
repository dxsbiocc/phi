type HomeResourceKind = 'skill' | 'wrapper' | 'mcp' | 'plugin'

/** Category marks for the home summary; individual resources still use their owned images. */
export function HomeResourceCategoryIcon({ kind }: { kind: HomeResourceKind }): React.JSX.Element {
  const filled = kind === 'wrapper' || kind === 'plugin'
  return (
    <svg
      width={filled ? 32 : 23}
      height={filled ? 32 : 23}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kind === 'skill' ? (
        <>
          <path d="M4.5 8.5c3.5-1.8 7-1.8 11.5 0v16c-4.5-1.8-8-1.8-11.5 0z" />
          <path d="M27.5 8.5c-3.5-1.8-7-1.8-11.5 0v16c4.5-1.8 8-1.8 11.5 0z" />
          <path d="M16 8.5v16" />
          <path
            d="m22.5 2.5.7 2.2 2.2.7-2.2.7-.7 2.2-.7-2.2-2.2-.7 2.2-.7z"
            fill="currentColor"
            stroke="none"
          />
        </>
      ) : kind === 'wrapper' ? (
        <>
          <rect x="1" y="1" width="30" height="30" rx="7" fill="currentColor" stroke="none" />
          <path d="M10 11h12M16 11v10M9 21h14" stroke="#fff" strokeWidth="2.4" />
          <rect x="5" y="7" width="9" height="8" rx="2" fill="#fff" stroke="none" />
          <rect x="18" y="7" width="9" height="8" rx="2" fill="#fff" stroke="none" />
          <rect x="11.5" y="18" width="9" height="8" rx="2" fill="#fff" stroke="none" />
        </>
      ) : kind === 'mcp' ? (
        <>
          <rect x="3.5" y="11" width="9" height="10" rx="3" />
          <rect x="19.5" y="11" width="9" height="10" rx="3" />
          <path d="M12.5 16h7M8 11V6M24 21v5" />
          <circle cx="8" cy="4.5" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="24" cy="27.5" r="1.5" fill="currentColor" stroke="none" />
        </>
      ) : (
        <>
          <rect x="1" y="1" width="30" height="30" rx="7" fill="currentColor" stroke="none" />
          <rect x="6" y="6" width="8" height="8" rx="2" fill="#fff" stroke="none" />
          <rect
            x="18"
            y="6"
            width="8"
            height="8"
            rx="2"
            fill="#fff"
            fillOpacity="0.72"
            stroke="none"
          />
          <rect
            x="6"
            y="18"
            width="8"
            height="8"
            rx="2"
            fill="#fff"
            fillOpacity="0.72"
            stroke="none"
          />
          <rect x="18" y="18" width="8" height="8" rx="2" fill="#fff" stroke="none" />
        </>
      )}
    </svg>
  )
}
