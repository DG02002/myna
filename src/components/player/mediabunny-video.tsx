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
}

// Advanced-engine media component: renders the decoded-video canvas and
// registers the engine's media adapter as the player's media, so the skin
// drives the engine exactly like a native video element.
export function MediabunnyVideo({
  init,
  onEngine,
  onAdapter,
}: MediabunnyVideoProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const attachMedia = useMediaAttach()
  const onEngineRef = useRef(onEngine)
  const onAdapterRef = useRef(onAdapter)

  useEffect(() => {
    onEngineRef.current = onEngine
  })

  useEffect(() => {
    onAdapterRef.current = onAdapter
  })

  // One engine per source; `init` is memoized by the parent stage.
  useEffect(() => {
    const engine = new MediabunnyEngine(init)
    const adapter = new MediabunnyMediaAdapter(engine, init.source.url)

    engine.attachCanvas(canvasRef.current)
    attachMedia?.(adapter)
    onEngineRef.current(engine)
    onAdapterRef.current(adapter)
    void engine.load()

    return () => {
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
