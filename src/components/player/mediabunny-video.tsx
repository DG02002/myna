import { useMediaAttach } from "@videojs/react"
import { useEffect, useRef } from "react"

import { MediabunnyMediaAdapter } from "#/media/engines/mediabunny-adapter"
import {
  MediabunnyEngine,
  type EngineInit,
} from "#/media/engines/mediabunny-engine"

export interface MediabunnyVideoProps {
  init: EngineInit
  onEngine: (engine: MediabunnyEngine) => void
  onAdapter: (adapter: MediabunnyMediaAdapter | null) => void
  onSelectedAudioTrackId: (id: string | null) => void
}

// Advanced-engine media component: renders the decoded-video canvas and
// registers the engine's media adapter as the player's media, so the skin
// drives the engine exactly like a native video element.
export function MediabunnyVideo({
  init,
  onEngine,
  onAdapter,
  onSelectedAudioTrackId,
}: MediabunnyVideoProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const attachMedia = useMediaAttach()
  const onEngineRef = useRef(onEngine)
  const onAdapterRef = useRef(onAdapter)
  const onSelectedAudioTrackIdRef = useRef(onSelectedAudioTrackId)

  useEffect(() => {
    onEngineRef.current = onEngine
  })

  useEffect(() => {
    onAdapterRef.current = onAdapter
  })

  useEffect(() => {
    onSelectedAudioTrackIdRef.current = onSelectedAudioTrackId
  })

  // One engine per source; `init` is memoized by the parent stage.
  useEffect(() => {
    const engine = new MediabunnyEngine(init)
    const adapter = new MediabunnyMediaAdapter(engine, init.source.url)

    const unsubscribe = engine.listen((event) => {
      if (event.type === "loaded") {
        onSelectedAudioTrackIdRef.current(event.selectedAudioTrackId)
      }
    })

    engine.attachCanvas(canvasRef.current)
    attachMedia?.(adapter)
    onEngineRef.current(engine)
    onAdapterRef.current(adapter)
    void engine.load()

    return () => {
      unsubscribe()
      onAdapterRef.current(null)
      engine.dispose()
      attachMedia?.(null)
    }
  }, [init, attachMedia])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full bg-black object-contain"
    />
  )
}
