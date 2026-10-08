import type { AkariSubOptions, default as AkariSubType } from "akarisub"
import { useEffect, useRef } from "react"

import type { MediabunnyMediaAdapter } from "#/media/engines/mediabunny-adapter"
import type { MediabunnyEngine } from "#/media/engines/mediabunny-engine"
import type { MatroskaAssTrackData } from "#/media/matroska-subtitles"

const ENGINE_CLOCK_INTERVAL_MS = 1000 / 30

type AssRendererTarget =
  | {
      kind: "advanced"
      canvas: HTMLCanvasElement
      adapter: MediabunnyMediaAdapter
      engine: MediabunnyEngine
    }
  | { kind: "native"; video: HTMLVideoElement; canvas: HTMLCanvasElement }

export function AssSubtitleOverlay({
  trackId,
  data,
  useAdvancedEngine,
  nativeVideo,
  adapter,
  engine,
  onFailure,
}: {
  trackId: string
  data: MatroskaAssTrackData
  useAdvancedEngine: boolean
  nativeVideo: HTMLVideoElement | null
  adapter: MediabunnyMediaAdapter | null
  engine: MediabunnyEngine | null
  onFailure: (id: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const onFailureRef = useRef(onFailure)

  useEffect(() => {
    onFailureRef.current = onFailure
  }, [onFailure])

  // oxlint-disable-next-line max-statements -- Renderer, media clock, and cleanup share one lifecycle.
  useEffect(() => {
    const canvas = canvasRef.current
    let target: AssRendererTarget

    if (useAdvancedEngine) {
      if (canvas === null || adapter === null || engine === null) {
        return undefined
      }

      target = { kind: "advanced", canvas, adapter, engine }
    } else {
      if (nativeVideo === null || canvas === null) {
        return undefined
      }

      target = { kind: "native", video: nativeVideo, canvas }
    }

    const media = target.kind === "advanced" ? target.adapter : target.video

    let active = true
    let failed = false
    let renderer: AkariSubType | null = null
    let animationFrame: number | null = null
    let lastClockUpdate = 0

    const fail = () => {
      if (failed) {
        return
      }

      failed = true
      const failedRenderer = renderer
      renderer = null
      failedRenderer?.removeEventListener("error", fail)
      failedRenderer?.destroy()
      onFailureRef.current(trackId)
    }

    const syncClock = () => {
      if (renderer === null) {
        return
      }

      try {
        renderer.setCurrentTime(
          media.paused,
          target.kind === "advanced"
            ? target.engine.currentTime
            : target.video.currentTime,
          media.playbackRate
        )
      } catch {
        fail()
      }
    }

    const updatePlayingClock = (timestamp: number) => {
      if (!active || renderer === null) {
        animationFrame = null

        return
      }

      if (timestamp - lastClockUpdate >= ENGINE_CLOCK_INTERVAL_MS) {
        syncClock()
        lastClockUpdate = timestamp
      }

      if (media.paused) {
        animationFrame = null

        return
      }

      animationFrame = requestAnimationFrame(updatePlayingClock)
    }

    const startClock = () => {
      syncClock()

      if (animationFrame === null && !media.paused) {
        animationFrame = requestAnimationFrame(updatePlayingClock)
      }
    }

    const stopClock = () => {
      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame)
        animationFrame = null
      }

      syncClock()
    }

    const resizeCanvas = () => {
      if (renderer === null) {
        return
      }

      const width =
        target.kind === "advanced"
          ? target.engine.width
          : target.video.videoWidth

      const height =
        target.kind === "advanced"
          ? target.engine.height
          : target.video.videoHeight

      if (width === null || height === null || width <= 0 || height <= 0) {
        return
      }

      try {
        renderer.resize(width, height, 0, 0, true)
      } catch {
        fail()
      }
    }

    const attachClock = () => {
      media.addEventListener("play", startClock)
      media.addEventListener("playing", startClock)
      media.addEventListener("pause", stopClock)
      media.addEventListener("seeked", syncClock)
      media.addEventListener("timeupdate", syncClock)
      media.addEventListener("ratechange", syncClock)
      media.addEventListener("ended", stopClock)
      media.addEventListener("loadedmetadata", resizeCanvas)

      if (!media.paused) {
        startClock()
      } else {
        syncClock()
      }

      resizeCanvas()
    }

    const detachClock = () => {
      media.removeEventListener("play", startClock)
      media.removeEventListener("playing", startClock)
      media.removeEventListener("pause", stopClock)
      media.removeEventListener("seeked", syncClock)
      media.removeEventListener("timeupdate", syncClock)
      media.removeEventListener("ratechange", syncClock)
      media.removeEventListener("ended", stopClock)
      media.removeEventListener("loadedmetadata", resizeCanvas)
    }

    const initialize = async () => {
      try {
        const { default: AkariSub } = await import("akarisub")

        if (!active) {
          return
        }

        if (
          target.kind === "advanced" &&
          target.engine.width &&
          target.engine.height
        ) {
          target.canvas.width = target.engine.width
          target.canvas.height = target.engine.height
        }

        // A manual canvas clock also works for CORS-tainted native video.
        // AkariSub's video-managed clock tries to construct a VideoFrame.
        const options: AkariSubOptions = {
          canvas: target.canvas,
          onDemandRender: false,
          offscreenRender: false,
          targetFps: 30,
          libassMemoryLimit: 64,
          useLocalFonts: false,
          fonts: data.fonts.map((font) => font.slice()),
        }

        const nextRenderer = new AkariSub(options)

        if (!active) {
          nextRenderer.destroy()

          return
        }

        renderer = nextRenderer
        renderer.addEventListener("error", fail)
        renderer.addEventListener(
          "ready",
          () => {
            if (!active || renderer === null) {
              return
            }

            try {
              renderer.initStreamingTrack({
                // AkariSub transfers buffers to its worker. Keep the retained
                // source data intact for renderer recreation and migration.
                header: data.codecPrivate.slice(),
                format: "matroska",
                pruneDelay: null,
              })

              for (const packet of data.packets) {
                renderer.appendSubtitleChunk(
                  packet.data.slice(),
                  packet.startTime,
                  packet.duration
                )
              }

              attachClock()
            } catch {
              fail()
            }
          },
          { once: true }
        )
      } catch {
        fail()
      }
    }

    void initialize()

    return () => {
      active = false
      detachClock()

      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame)
      }

      renderer?.removeEventListener("error", fail)
      renderer?.destroy()
      renderer = null
    }
  }, [adapter, data, engine, nativeVideo, trackId, useAdvancedEngine])

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 [[data-controls-visible]_&]:bottom-20"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="h-full w-full object-contain" />
    </div>
  )
}
