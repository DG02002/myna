import { useMediaAttach } from "@videojs/react"
import { useEffect, useRef } from "react"

import { MediabunnyMediaAdapter } from "#/media/engines/mediabunny-adapter"
import {
  MediabunnyEngine,
  type EngineInit,
} from "#/media/engines/mediabunny-engine"

export interface MediabunnyVideoProps {
  init: EngineInit
  createEngine?: (init: EngineInit) => MediabunnyEngine
  onEngine: (engine: MediabunnyEngine) => void
  onAdapter: (adapter: MediabunnyMediaAdapter | null) => void
  onSelectedAudioTrackId: (id: string | null) => void
}

// Advanced-engine media component: renders the decoded-video canvas and
// registers the engine's media adapter as the player's media, so the skin
// drives the engine exactly like a native video element.
export function MediabunnyVideo({
  init,
  createEngine,
  onEngine,
  onAdapter,
  onSelectedAudioTrackId,
}: MediabunnyVideoProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const attachMedia = useMediaAttach()
  const initRef = useRef(init)
  const createEngineRef = useRef(createEngine)
  const onEngineRef = useRef(onEngine)
  const onAdapterRef = useRef(onAdapter)
  const onSelectedAudioTrackIdRef = useRef(onSelectedAudioTrackId)

  useEffect(() => {
    initRef.current = init
  }, [init])

  useEffect(() => {
    createEngineRef.current = createEngine
  }, [createEngine])

  useEffect(() => {
    onEngineRef.current = onEngine
  })

  useEffect(() => {
    onAdapterRef.current = onAdapter
  })

  useEffect(() => {
    onSelectedAudioTrackIdRef.current = onSelectedAudioTrackId
  })

  const sourceUrl = init.source.url

  // Resume confirmation and other parent state updates can change the init
  // object without changing the source. Keep the loaded engine for that source.
  useEffect(() => {
    const currentInit = initRef.current

    const engine =
      createEngineRef.current?.(currentInit) ??
      new MediabunnyEngine(currentInit)

    const adapter = new MediabunnyMediaAdapter(engine, sourceUrl)

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
  }, [attachMedia, sourceUrl])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full bg-black object-contain"
    />
  )
}
