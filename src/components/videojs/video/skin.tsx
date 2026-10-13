"use client"

import "../styles/video/base.css"
import type { ControlsVisibility } from "@videojs/core"
import type { ComponentProps, ReactNode } from "react"

import { BufferingIndicator } from "#/components/videojs/ui/buffering-indicator.tsx"
import { Container } from "#/components/videojs/ui/container.tsx"
import { ErrorDialog } from "#/components/videojs/ui/error-dialog.tsx"
import { Poster } from "#/components/videojs/ui/poster.tsx"
import { Title } from "#/components/videojs/ui/title.tsx"
import { cn } from "#/lib/utils.ts"

import { VideoGestures } from "./behaviors/gestures"
import { VideoHotkeys } from "./behaviors/hotkeys"
import { VideoStatusIndicators } from "./display/status-indicators"
import { DefaultVideoControls } from "./layout/controls"

export interface VideoSkinProps extends Omit<
  NonNullable<ComponentProps<typeof Container>>,
  "children"
> {
  children?: ReactNode
  onRetryPlayback?: () => void
  renderPoster?: NonNullable<ComponentProps<typeof Poster>>["renderImage"]
  renderThumbnail?: NonNullable<
    ComponentProps<typeof DefaultVideoControls>
  >["renderThumbnail"]
  /** Passed through to the control bar; "always" pins it visible. */
  controlsVisibility?: ControlsVisibility
}

export function VideoSkin({
  children,
  className,
  onRetryPlayback,
  renderPoster,
  renderThumbnail,
  controlsVisibility,
  ...props
}: VideoSkinProps = {}) {
  return (
    <Container
      className={cn(
        "pointer-fine:not-data-controls-visible:cursor-none",
        className
      )}
      data-theme="default"
      data-preset="video"
      {...props}
    >
      {children}
      <Poster renderImage={renderPoster} />
      <BufferingIndicator />
      <ErrorDialog onRetryPlayback={onRetryPlayback} />
      <Title />

      <DefaultVideoControls
        renderThumbnail={renderThumbnail}
        visibility={controlsVisibility}
      />

      <VideoHotkeys />
      <VideoGestures />
      <VideoStatusIndicators />
    </Container>
  )
}
