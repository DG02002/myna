import { useEffect, useMemo, useState } from "react"

import type { MediabunnyMediaAdapter } from "#/media/engines/mediabunny-adapter"
import type { MediabunnyEngine } from "#/media/engines/mediabunny-engine"
import {
  subtitleCueDisplayText,
  type SubtitleTrack,
  type SubtitleCue,
} from "#/media/subtitles"

export function SubtitleOverlay({
  adapter,
  engine,
  track,
}: {
  adapter: MediabunnyMediaAdapter
  engine: MediabunnyEngine
  track: SubtitleTrack | undefined
}) {
  const cues = useMemo(() => {
    if (track?.status !== "ready") {
      return []
    }

    // Sorting a copy keeps the track's parsed cue order intact.
    // oxlint-disable-next-line unicorn/no-array-sort
    return [...track.cues].sort(
      (left, right) => left.startTime - right.startTime
    )
  }, [track])

  const [activeCueIndex, setActiveCueIndex] = useState(-1)

  useEffect(() => {
    const updateCue = () => {
      const nextIndex = findActiveCueIndex(cues, engine.currentTime)

      setActiveCueIndex((currentIndex) =>
        currentIndex === nextIndex ? currentIndex : nextIndex
      )
    }

    let frame: number | null = null

    const renderFrames = () => {
      updateCue()

      if (!adapter.paused) {
        frame = requestAnimationFrame(renderFrames)
      } else {
        frame = null
      }
    }

    const startFrames = () => {
      if (frame === null) {
        frame = requestAnimationFrame(renderFrames)
      }
    }

    const stopFrames = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }

      updateCue()
    }

    updateCue()

    adapter.addEventListener("play", startFrames)
    adapter.addEventListener("playing", startFrames)
    adapter.addEventListener("pause", stopFrames)
    adapter.addEventListener("seeked", updateCue)
    adapter.addEventListener("timeupdate", updateCue)

    if (!adapter.paused) {
      startFrames()
    }

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }

      adapter.removeEventListener("play", startFrames)
      adapter.removeEventListener("playing", startFrames)
      adapter.removeEventListener("pause", stopFrames)
      adapter.removeEventListener("seeked", updateCue)
      adapter.removeEventListener("timeupdate", updateCue)
    }
  }, [adapter, cues, engine])

  if (track?.status !== "ready") {
    return null
  }

  const activeCue = cues[activeCueIndex]

  if (activeCue === undefined) {
    return null
  }

  return (
    // Keep rendered subtitles over the video and below the player controls.
    <div className="pointer-events-none absolute inset-x-4 bottom-20 z-20 text-center">
      <span className="inline-block max-w-full rounded-sm bg-black/75 px-2 py-1 text-base leading-snug whitespace-pre-line text-white shadow-sm">
        {subtitleCueDisplayText(activeCue.text)}
      </span>
    </div>
  )
}

function findActiveCueIndex(cues: SubtitleCue[], time: number): number {
  let low = 0
  let high = cues.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const cue = cues[middle]

    if (cue === undefined || cue.startTime > time) {
      high = middle - 1
    } else {
      low = middle + 1
    }
  }

  const index = high
  const cue = cues[index]

  return cue !== undefined && time < cue.endTime ? index : -1
}
