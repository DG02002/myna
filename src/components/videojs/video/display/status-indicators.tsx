import type { ComponentProps } from "react"

import { SeekIndicator } from "#/components/videojs/ui/seek-indicator.tsx"
import { StatusAnnouncer } from "#/components/videojs/ui/status-announcer.tsx"
import {
  PlaybackStatusIndicator,
  StatusIndicator,
} from "#/components/videojs/ui/status-indicator.tsx"
import { VolumeIndicator } from "#/components/videojs/ui/volume-indicator.tsx"
import { cn } from "#/lib/utils.ts"

export type VideoStatusIndicatorsProps = Omit<ComponentProps<"div">, "children">

export function VideoStatusIndicators({
  className,
  ...props
}: VideoStatusIndicatorsProps = {}) {
  return (
    <>
      <StatusAnnouncer />
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-20 grid grid-cols-3 items-center justify-items-center",
          "text-media-controls-foreground",
          className
        )}
        {...props}
      >
        <VolumeIndicator />
        <StatusIndicator />
        <SeekIndicator />
        <PlaybackStatusIndicator />
      </div>
    </>
  )
}
