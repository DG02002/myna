import { useId } from "react"

import { cn } from "#/lib/utils"

type WordmarkVariant = "cinema-delta" | "cyberpunk" | "orbitron"

export interface MynaWordmarkProps {
  className?: string
  variant?: WordmarkVariant
  gradient?: boolean
}

export function MynaWordmark({
  className,
  variant = "cinema-delta",
}: MynaWordmarkProps) {
  const id = useId()
  const maskId = `${id}-mask`
  const gradId = `${id}-grad`

  if (variant === "orbitron") {
    return (
      <svg
        role="img"
        aria-label="Myna"
        viewBox="-10 8 360 85"
        className={cn("myna-wordmark-svg", className)}
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="var(--color-chrome-stop-1)" />
            <stop offset="42%" stopColor="var(--color-chrome-stop-2)" />
            <stop offset="48%" stopColor="var(--color-chrome-stop-3)" />
            <stop offset="52%" stopColor="var(--color-chrome-stop-4)" />
            <stop offset="100%" stopColor="var(--color-chrome-stop-5)" />
          </linearGradient>
          <mask id={maskId}>
            <rect
              x="-100"
              y="-100"
              width="600"
              height="300"
              fill="var(--color-mask-reveal)"
            />
            <polygon
              points="-50,38 450,22 450,25.5 -50,41.5"
              fill="var(--color-mask-hide)"
            />
          </mask>
        </defs>
        <g transform="translate(5, 62)">
          <g
            transform="translate(-2.5, 2)"
            opacity={0.8}
            mask={`url(#${maskId})`}
          >
            <text
              x="0"
              y="0"
              fill="var(--color-cyber-cyan)"
              fontFamily="Orbitron Variable, Orbitron, sans-serif"
              fontSize="64"
              fontWeight="900"
              letterSpacing="-1.5px"
            >
              MYNA
            </text>
          </g>
          <g mask={`url(#${maskId})`}>
            <text
              x="0"
              y="0"
              fill={`url(#${gradId})`}
              fontFamily="Orbitron Variable, Orbitron, sans-serif"
              fontSize="64"
              fontWeight="900"
              letterSpacing="-1.5px"
            >
              MYNA
            </text>
          </g>
        </g>
      </svg>
    )
  }

  if (variant === "cinema-delta") {
    return (
      <svg
        role="img"
        aria-label="Myna"
        viewBox="-6 0 345 65"
        className={cn("myna-wordmark-svg", className)}
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="var(--color-chrome-stop-1)" />
            <stop offset="42%" stopColor="var(--color-chrome-stop-2)" />
            <stop offset="48%" stopColor="var(--color-chrome-stop-3)" />
            <stop offset="52%" stopColor="var(--color-chrome-stop-4)" />
            <stop offset="100%" stopColor="var(--color-chrome-stop-5)" />
          </linearGradient>
          <mask id={maskId}>
            <rect
              x="-100"
              y="-100"
              width="600"
              height="300"
              fill="var(--color-mask-reveal)"
            />
            <polygon
              points="-50,32 450,16 450,19.5 -50,35.5"
              fill="var(--color-mask-hide)"
            />
          </mask>
        </defs>
        <g transform="translate(0, 6)">
          <g
            transform="translate(-2.5, 2)"
            opacity={0.8}
            mask={`url(#${maskId})`}
            fill="var(--color-cyber-cyan)"
          >
            <path d="M 0 52 L 0 0 L 18 0 L 42 34 L 66 0 L 84 0 L 84 52 L 66 52 L 66 20 L 48 44 L 36 44 L 18 20 L 18 52 Z" />
            <path d="M 92 0 L 112 0 L 132 28 L 152 0 L 172 0 L 142 38 L 142 52 L 122 52 L 122 38 Z" />
            <path d="M 180 0 L 200 0 L 236 34 L 236 0 L 254 0 L 254 52 L 234 52 L 198 18 L 198 52 L 180 52 Z" />
            <path d="M 296 0 L 330 52 L 310 52 L 296 28 L 282 52 L 262 52 Z" />
          </g>
          <g mask={`url(#${maskId})`} fill={`url(#${gradId})`}>
            <path d="M 0 52 L 0 0 L 18 0 L 42 34 L 66 0 L 84 0 L 84 52 L 66 52 L 66 20 L 48 44 L 36 44 L 18 20 L 18 52 Z" />
            <path d="M 92 0 L 112 0 L 132 28 L 152 0 L 172 0 L 142 38 L 142 52 L 122 52 L 122 38 Z" />
            <path d="M 180 0 L 200 0 L 236 34 L 236 0 L 254 0 L 254 52 L 234 52 L 198 18 L 198 52 L 180 52 Z" />
            <path d="M 296 0 L 330 52 L 310 52 L 296 28 L 282 52 L 262 52 Z" />
          </g>
        </g>
      </svg>
    )
  }

  // Default: Cyberpunk in Liquid Anamorphic Chrome
  return (
    <svg
      role="img"
      aria-label="Myna"
      viewBox="-16 8 400 114"
      className={cn("myna-wordmark-svg", className)}
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="var(--color-chrome-stop-1)" />
          <stop offset="42%" stopColor="var(--color-chrome-stop-2)" />
          <stop offset="48%" stopColor="var(--color-chrome-stop-3)" />
          <stop offset="52%" stopColor="var(--color-chrome-stop-4)" />
          <stop offset="100%" stopColor="var(--color-chrome-stop-5)" />
        </linearGradient>
        <mask id={maskId}>
          <rect
            x="-100"
            y="-100"
            width="700"
            height="400"
            fill="var(--color-mask-reveal)"
          />
          <polygon
            points="-50,38 500,38 500,41.5 -50,41.5"
            fill="var(--color-mask-hide)"
          />
          <polygon
            points="200,67 340,43 340,46.5 200,70.5"
            fill="var(--color-mask-hide)"
          />
          <polygon
            points="46,55 58,55 56,58 44,58"
            fill="var(--color-mask-hide)"
          />
        </mask>
      </defs>

      <g transform="skewX(-14)">
        {/* Electric Cyan Glitch Underlay */}
        <g
          fill="var(--color-cyber-cyan)"
          opacity={0.8}
          transform="translate(-3.5, 2.5)"
          mask={`url(#${maskId})`}
        >
          <path d="M 0 32 L 14 16 L 36 16 L 52 46 L 68 16 L 90 16 L 90 80 L 68 80 L 68 44 L 56 66 L 46 66 L 34 44 L 34 80 L 12 80 L 12 40 L 0 40 Z" />
          <path d="M 98 16 L 124 16 L 140 44 L 154 12 L 180 12 L 152 56 L 152 74 L 122 115 L 122 74 L 122 56 Z" />
          <path d="M 188 30 L 202 16 L 226 16 L 256 58 L 256 12 L 282 12 L 282 66 L 268 80 L 244 80 L 214 38 L 214 80 L 188 80 Z" />
          <path d="M 314 10 L 334 10 L 366 80 L 342 80 L 335 64 L 305 64 L 297 80 L 273 80 Z M 320 28 L 311 48 L 329 48 Z" />
          <polygon points="305,53 378,53 368,61 305,61" />
        </g>

        {/* Foreground Liquid Chrome */}
        <g fill={`url(#${gradId})`} mask={`url(#${maskId})`}>
          <path d="M 0 32 L 14 16 L 36 16 L 52 46 L 68 16 L 90 16 L 90 80 L 68 80 L 68 44 L 56 66 L 46 66 L 34 44 L 34 80 L 12 80 L 12 40 L 0 40 Z" />
          <path d="M 98 16 L 124 16 L 140 44 L 154 12 L 180 12 L 152 56 L 152 74 L 122 115 L 122 74 L 122 56 Z" />
          <path d="M 188 30 L 202 16 L 226 16 L 256 58 L 256 12 L 282 12 L 282 66 L 268 80 L 244 80 L 214 38 L 214 80 L 188 80 Z" />
          <path d="M 314 10 L 334 10 L 366 80 L 342 80 L 335 64 L 305 64 L 297 80 L 273 80 Z M 320 28 L 311 48 L 329 48 Z" />
          <polygon points="305,53 378,53 368,61 305,61" />
        </g>
      </g>
    </svg>
  )
}
