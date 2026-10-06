import { Video, VideoPlayer } from "@videojs/react/video"
import { useEffect, useRef } from "react"

import { VideoSkin } from "#/components/videojs/video/skin"
import type { PlaybackSource } from "#/media/models/source"

export function WatchPlayer({ source }: { source: PlaybackSource }) {
  const mediaRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const element = mediaRef.current

    // src is assigned after mount so the media element is attached to the
    // player before it starts loading; startup errors then reach player
    // state and the error dialog.
    if (element !== null) {
      element.src = source.url
      element.load()
    }
  }, [source.url])

  return (
    <VideoPlayer>
      <VideoSkin className="aspect-video w-full">
        <Video ref={mediaRef} playsInline preload="metadata" />
      </VideoSkin>
    </VideoPlayer>
  )
}
