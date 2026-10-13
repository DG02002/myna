import { useEffect, useRef } from "react"

import type { MediabunnyMediaAdapter } from "#/media/engines/mediabunny-adapter"
import type {
  PgsSubtitleFrame,
  PgsSubtitleSession,
} from "#/media/pgs-subtitle-session"

type SubtitleMediaClock = HTMLVideoElement | MediabunnyMediaAdapter

interface PgsFrameDrawContext {
  context: CanvasRenderingContext2D | null
  canvas: HTMLCanvasElement
  trackId: string
  onFailure: (id: string) => void
  onUnavailable: (id: string) => void
  resizeCanvas: () => void
}

interface PgsMediaListenerCallbacks {
  clock: ReturnType<typeof createPlaybackClock>
  onSeeking: () => void
  onSeeked: () => void
}

function setCanvasVisibility(
  canvas: HTMLCanvasElement,
  visible: boolean
): void {
  canvas.classList.toggle("invisible", !visible)
}

function createCanvasResizer(
  host: HTMLDivElement,
  canvas: HTMLCanvasElement
): () => void {
  return () => {
    // PGS compositions can retain uncropped dimensions when the video is cropped.
    const { width, height } = canvas
    const hostWidth = host.clientWidth
    const hostHeight = host.clientHeight

    if (width <= 0 || height <= 0 || hostWidth <= 0 || hostHeight <= 0) {
      setCanvasVisibility(canvas, false)

      return
    }

    const scale = Math.min(hostWidth / width, hostHeight / height)
    const contentWidth = width * scale
    const contentHeight = height * scale
    canvas.style.left = `${(hostWidth - contentWidth) / 2}px`
    canvas.style.top = `${(hostHeight - contentHeight) / 2}px`
    canvas.style.width = `${contentWidth}px`
    canvas.style.height = `${contentHeight}px`
    setCanvasVisibility(canvas, true)
  }
}

function handlePgsStatusFrame(
  frame: PgsSubtitleFrame,
  drawContext: PgsFrameDrawContext
): boolean {
  const { context, canvas, trackId, onFailure, onUnavailable } = drawContext

  if (context === null) {
    return true
  }

  switch (frame.kind) {
    case "failed":
      context.clearRect(0, 0, canvas.width, canvas.height)
      onFailure(trackId)

      return true
    case "unavailable":
      context.clearRect(0, 0, canvas.width, canvas.height)
      onUnavailable(trackId)

      return true
    case "clear":
      context.clearRect(0, 0, canvas.width, canvas.height)

      return true
    case "hold":
      return true
    case "frame":
      return false
  }

  return false
}

function drawPgsFrame(
  frame: PgsSubtitleFrame,
  drawContext: PgsFrameDrawContext
): void {
  if (handlePgsStatusFrame(frame, drawContext)) {
    return
  }

  const { context, canvas, resizeCanvas } = drawContext

  if (context === null || frame.kind !== "frame") {
    return
  }

  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width
    canvas.height = frame.height
  }

  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(frame.bitmap, 0, 0)
  resizeCanvas()
}

function attachResizeListeners(
  host: HTMLDivElement,
  resizeCanvas: () => void
): () => void {
  const observer = new ResizeObserver(resizeCanvas)
  observer.observe(host)
  window.addEventListener("resize", resizeCanvas)
  document.addEventListener("fullscreenchange", resizeCanvas)

  return () => {
    observer.disconnect()
    window.removeEventListener("resize", resizeCanvas)
    document.removeEventListener("fullscreenchange", resizeCanvas)
  }
}

function createPlaybackClock(
  media: SubtitleMediaClock,
  session: PgsSubtitleSession,
  resizeCanvas: () => void
) {
  let animationFrame: number | null = null

  const updateClock = () => {
    resizeCanvas()
    session.requestTime(media.currentTime)
  }

  const renderWhilePlaying = () => {
    updateClock()
    animationFrame = requestAnimationFrame(renderWhilePlaying)
  }

  const startClock = () => {
    if (animationFrame === null) {
      updateClock()
      animationFrame = requestAnimationFrame(renderWhilePlaying)
    }
  }

  const stopClock = () => {
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame)
      animationFrame = null
    }

    updateClock()
  }

  const dispose = () => {
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame)
    }
  }

  return { dispose, startClock, stopClock, updateClock }
}

function attachMediaListeners(
  media: SubtitleMediaClock,
  resizeCanvas: () => void,
  callbacks: PgsMediaListenerCallbacks
): () => void {
  const { clock, onSeeking, onSeeked } = callbacks

  media.addEventListener("loadedmetadata", resizeCanvas)
  media.addEventListener("play", clock.startClock)
  media.addEventListener("playing", clock.startClock)
  media.addEventListener("pause", clock.stopClock)
  media.addEventListener("seeking", onSeeking)
  media.addEventListener("seeked", onSeeked)
  media.addEventListener("timeupdate", clock.updateClock)
  media.addEventListener("ratechange", clock.updateClock)

  return () => {
    media.removeEventListener("loadedmetadata", resizeCanvas)
    media.removeEventListener("play", clock.startClock)
    media.removeEventListener("playing", clock.startClock)
    media.removeEventListener("pause", clock.stopClock)
    media.removeEventListener("seeking", onSeeking)
    media.removeEventListener("seeked", onSeeked)
    media.removeEventListener("timeupdate", clock.updateClock)
    media.removeEventListener("ratechange", clock.updateClock)
  }
}

export function PgsSubtitleOverlay({
  session,
  trackId,
  useAdvancedEngine,
  nativeVideo,
  adapter,
  onFailure,
  onUnavailable,
}: {
  session: PgsSubtitleSession
  trackId: string
  useAdvancedEngine: boolean
  nativeVideo: HTMLVideoElement | null
  adapter: MediabunnyMediaAdapter | null
  onFailure: (id: string) => void
  onUnavailable: (id: string) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const failureRef = useRef(onFailure)
  const unavailableRef = useRef(onUnavailable)

  useEffect(() => {
    failureRef.current = onFailure
  }, [onFailure])

  useEffect(() => {
    unavailableRef.current = onUnavailable
  }, [onUnavailable])

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    const media = useAdvancedEngine ? adapter : nativeVideo

    if (host === null || canvas === null || media === null) {
      return undefined
    }

    const context = canvas.getContext("2d", { alpha: true })

    const resizeCanvas = createCanvasResizer(host, canvas)

    const clock = createPlaybackClock(media, session, resizeCanvas)
    let seeking = false

    const clearCanvas = () => {
      context?.clearRect(0, 0, canvas.width, canvas.height)
    }

    const handleSeeking = () => {
      seeking = true
      session.invalidatePendingRender()
      clearCanvas()
    }

    const handleSeeked = () => {
      seeking = false
      // The worker may have remembered a frame that the overlay dropped during seeking.
      session.invalidatePendingRender()
      clock.updateClock()
    }

    const unsubscribe = session.subscribe((frame) => {
      if (seeking && frame.kind === "frame") {
        return
      }

      drawPgsFrame(frame, {
        context,
        canvas,
        trackId,
        onFailure: failureRef.current,
        onUnavailable: unavailableRef.current,
        resizeCanvas,
      })
    })

    const detachResize = attachResizeListeners(host, resizeCanvas)

    const detachMedia = attachMediaListeners(media, resizeCanvas, {
      clock,
      onSeeking: handleSeeking,
      onSeeked: handleSeeked,
    })

    resizeCanvas()
    clock.updateClock()

    if (!media.paused) {
      clock.startClock()
    }

    return () => {
      unsubscribe()
      detachResize()
      detachMedia()
      clock.dispose()

      if (context !== null) {
        context.clearRect(0, 0, canvas.width, canvas.height)
      }
    }
  }, [adapter, nativeVideo, session, trackId, useAdvancedEngine])

  return (
    // Captions overlay the video and remain below the player controls.
    <div
      ref={hostRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      <canvas ref={canvasRef} className="absolute invisible" />
    </div>
  )
}
