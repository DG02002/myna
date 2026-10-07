import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

import { MediabunnyMediaAdapter } from "#/media/engines/mediabunny-adapter"
import {
  loadSubtitleCues,
  subtitleTrackName,
  type ExternalSubtitleTrack,
} from "#/media/subtitles"

export interface ExternalSubtitlesState {
  tracks: ExternalSubtitleTrack[]
  selectedId: string | null
  addSubtitle: (url: string) => void
  restoreSelection: (id: string | null) => void
}

export function useExternalSubtitles({
  useAdvancedEngine,
  nativeMediaRef,
  adapter,
}: {
  useAdvancedEngine: boolean
  nativeMediaRef: RefObject<HTMLVideoElement | null>
  adapter: MediabunnyMediaAdapter | null
}): ExternalSubtitlesState {
  const [tracks, setTracks] = useState<ExternalSubtitleTrack[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const loadControllers = useRef(new Map<string, AbortController>())

  const textTrackRegistry = useRef(
    new WeakMap<TextTrackList, Map<string, TextTrack>>()
  )

  useEffect(
    () => () => {
      for (const controller of loadControllers.current.values()) {
        controller.abort()
      }

      loadControllers.current.clear()
    },
    []
  )

  const addSubtitle = useCallback(
    (url: string) => {
      const id = crypto.randomUUID()
      const name = subtitleTrackName(url, tracks.length + 1)
      const controller = new AbortController()

      loadControllers.current.set(id, controller)
      setTracks((currentTracks) => [
        ...currentTracks,
        { id, ...name, status: "loading", cues: [] },
      ])

      void loadSubtitleCues(url, controller.signal)
        .then((result) => {
          if (controller.signal.aborted || "aborted" in result) {
            return
          }

          setTracks((currentTracks) =>
            currentTracks.map((track) => {
              if (track.id !== id) {
                return track
              }

              if ("cues" in result) {
                return { ...track, status: "ready", cues: result.cues }
              }

              return { ...track, status: "failed" }
            })
          )
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setTracks((currentTracks) =>
              currentTracks.map((track) =>
                track.id === id ? { ...track, status: "failed" } : track
              )
            )
          }
        })
        .finally(() => loadControllers.current.delete(id))
    },
    [tracks.length]
  )

  const restoreSelection = useCallback(
    (id: string | null) => setSelectedId(id),
    []
  )

  useEffect(() => {
    const media = useAdvancedEngine ? adapter : nativeMediaRef.current

    if (media === null) {
      return undefined
    }

    const { textTracks } = media

    const registeredTracks =
      textTrackRegistry.current.get(textTracks) ?? new Map<string, TextTrack>()

    textTrackRegistry.current.set(textTracks, registeredTracks)

    for (const subtitle of tracks) {
      if (subtitle.status !== "ready" || registeredTracks.has(subtitle.id)) {
        continue
      }

      try {
        const textTrack =
          media instanceof MediabunnyMediaAdapter
            ? media.addSubtitleTrack(subtitle.label, subtitle.language)
            : media.addTextTrack("subtitles", subtitle.label, subtitle.language)

        for (const cue of subtitle.cues) {
          textTrack.addCue(new VTTCue(cue.startTime, cue.endTime, cue.text))
        }

        registeredTracks.set(subtitle.id, textTrack)
      } catch {
        // Keep a browser cue failure inside subtitle status, away from playback state.
        // oxlint-disable-next-line react/set-state-in-effect
        setTracks((currentTracks) =>
          currentTracks.map((track) =>
            track.id === subtitle.id ? { ...track, status: "failed" } : track
          )
        )
      }
    }

    for (const [id, textTrack] of registeredTracks) {
      textTrack.mode = id === selectedId ? "showing" : "disabled"
    }

    const syncSelection = () => {
      let nextSelectedId: string | null = null

      for (const [id, textTrack] of registeredTracks) {
        if (textTrack.mode === "showing") {
          nextSelectedId = id
          break
        }
      }

      setSelectedId((currentId) =>
        currentId === nextSelectedId ? currentId : nextSelectedId
      )
    }

    textTracks.addEventListener("change", syncSelection)

    return () => textTracks.removeEventListener("change", syncSelection)
  }, [adapter, nativeMediaRef, selectedId, tracks, useAdvancedEngine])

  return { tracks, selectedId, addSubtitle, restoreSelection }
}
