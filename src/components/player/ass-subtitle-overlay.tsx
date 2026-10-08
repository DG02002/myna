import type { AkariSubOptions, default as AkariSubType } from "akarisub"
import { useEffect, useRef } from "react"

import type { MediabunnyMediaAdapter } from "#/media/engines/mediabunny-adapter"
import type { MediabunnyEngine } from "#/media/engines/mediabunny-engine"
import type { MatroskaAssTrackStream } from "#/media/matroska-subtitles"

const ENGINE_CLOCK_INTERVAL_MS = 1000 / 30

const BOOTSTRAP_ASS_SUBTITLE = `[Script Info]
ScriptType: v4.00+
PlayResX: 384
PlayResY: 288

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,1,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,99:00:00.00,99:00:01.00,Default,,0,0,0,,
`

type AssRendererTarget =
  | {
      kind: "advanced"
      canvas: HTMLCanvasElement
      adapter: MediabunnyMediaAdapter
      engine: MediabunnyEngine
    }
  | { kind: "native"; video: HTMLVideoElement; canvas: HTMLCanvasElement }

export function createStreamingAkariSubOptions(
  canvas: HTMLCanvasElement,
  fonts: Uint8Array[]
): AkariSubOptions & { fonts: Uint8Array[]; subContent: string } {
  return {
    canvas,
    onDemandRender: false,
    offscreenRender: false,
    targetFps: 30,
    libassMemoryLimit: 64,
    useLocalFonts: false,
    // AkariSub parses subContent during worker startup even when the caller
    // will use initStreamingTrack. libass rejects an events-free bootstrap
    // track, so keep one cue far beyond normal media durations until the real
    // Matroska header replaces it.
    subContent: BOOTSTRAP_ASS_SUBTITLE,
    fonts: fonts.map((font) => font.slice()),
  }
}

export function subscribeAssSubtitlePackets({
  stream,
  renderer,
  onFailure,
}: {
  stream: MatroskaAssTrackStream
  renderer: Pick<AkariSubType, "appendSubtitleChunk">
  onFailure: () => void
}): () => void {
  let active = true
  let unsubscribePackets: (() => void) | null = null

  const unsubscribe = () => {
    if (!active) {
      return
    }

    active = false
    unsubscribePackets?.()
    unsubscribePackets = null
  }

  const appendPackets = (
    packets: Parameters<
      Parameters<MatroskaAssTrackStream["subscribePackets"]>[0]
    >[0]
  ) => {
    if (!active) {
      return
    }

    try {
      for (const packet of packets) {
        renderer.appendSubtitleChunk(
          packet.data.slice(),
          packet.startTime,
          packet.duration
        )
      }
    } catch {
      unsubscribe()
      onFailure()
    }
  }

  const stopListening = stream.subscribePackets(appendPackets)

  if (active) {
    unsubscribePackets = stopListening
  } else {
    stopListening()
  }

  return unsubscribe
}

export function AssSubtitleOverlay({
  trackId,
  stream,
  useAdvancedEngine,
  nativeVideo,
  adapter,
  engine,
  onFailure,
}: {
  trackId: string
  stream: MatroskaAssTrackStream
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
    let unsubscribePackets: (() => void) | null = null
    let animationFrame: number | null = null
    let lastClockUpdate = 0

    const fail = () => {
      if (!active || failed) {
        return
      }

      failed = true
      unsubscribePackets?.()
      unsubscribePackets = null
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
        const [{ default: AkariSub }, metadata] = await Promise.all([
          import("akarisub"),
          stream.metadata,
        ])

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
        const options = createStreamingAkariSubOptions(
          target.canvas,
          metadata.fonts
        )

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
              // Queue replacement before packet replay and before attachClock
              // can send the first render time to AkariSub's worker.
              renderer.initStreamingTrack({
                // AkariSub transfers buffers to its worker. Keep the retained
                // source data intact for renderer recreation and migration.
                header: metadata.codecPrivate.slice(),
                format: "matroska",
                pruneDelay: null,
              })

              unsubscribePackets = subscribeAssSubtitlePackets({
                stream,
                renderer,
                onFailure: fail,
              })

              if (!active || failed || renderer === null) {
                return
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
      unsubscribePackets?.()
      unsubscribePackets = null
      detachClock()

      if (animationFrame !== null) {
        cancelAnimationFrame(animationFrame)
      }

      renderer?.removeEventListener("error", fail)
      renderer?.destroy()
      renderer = null
    }
  }, [adapter, engine, nativeVideo, stream, trackId, useAdvancedEngine])

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 [[data-controls-visible]_&]:-translate-y-1/8"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="h-full w-full object-contain" />
    </div>
  )
}
