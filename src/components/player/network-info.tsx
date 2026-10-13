import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import type { PlaybackEngineMode } from "#/components/player/playback-stage"
import { Button } from "#/components/ui/button"
import type { MediabunnyEngine } from "#/media/engines/mediabunny-engine"
import { createPlaybackDiagnosticSnapshot } from "#/media/models/playback-diagnostics"
import { isHlsUrl } from "#/media/models/source"
import type { ProbeFailure, ProbeResult } from "#/media/probe/metadata-probe"
import type { SubtitleTrack } from "#/media/subtitles"

interface MynaNetworkConnection extends EventTarget {
  readonly downlink: number
  readonly rtt: number
}

declare global {
  interface Navigator {
    readonly connection?: MynaNetworkConnection
  }
}

interface NetworkReadingsState {
  sourceUrl: string | null
  clientDownlinkMbps: number | null
  clientRttMs: number | null
  mediaRateMbps: number | null
  originResponseMs: number | null
  rateSamples: RateSample[]
}

interface RateSample {
  atMs: number
  mbps: number
}

interface ResourceSample {
  ageMs: number
  mediaRateMbps: number | null
  originResponseMs: number | null
}

type PlaybackState =
  | "unavailable"
  | "failed"
  | "seeking"
  | "loading"
  | "playing"
  | "buffering"
  | "paused"
  | "ended"

interface PlaybackSnapshot {
  state: PlaybackState
  bufferedAheadSeconds: number | null
}

const EMPTY_NETWORK_READINGS: NetworkReadingsState = {
  sourceUrl: null,
  clientDownlinkMbps: null,
  clientRttMs: null,
  mediaRateMbps: null,
  originResponseMs: null,
  rateSamples: [],
}

const EMPTY_PLAYBACK_SNAPSHOT: PlaybackSnapshot = {
  state: "unavailable",
  bufferedAheadSeconds: null,
}

const NETWORK_READING_STALE_MS = 30_000

// Tiny index reads mostly measure request latency, not stream throughput.
const MIN_RATE_SAMPLE_BYTES = 64 * 1024

const RATE_CHART_WINDOW_MS = 120_000

const RATE_CHART_MAX_SAMPLES = 600

export function NetworkInfo({
  sourceUrl,
  engineMode,
  mediaElement,
  engine,
  probeResult,
  probeFailure,
  requestedResumeSeconds,
  confirmedResumeSeconds,
  subtitleTracks,
}: {
  sourceUrl: string
  engineMode: PlaybackEngineMode
  mediaElement: HTMLVideoElement | null
  engine: MediabunnyEngine | null
  probeResult: ProbeResult | null
  probeFailure: ProbeFailure | null
  requestedResumeSeconds: number
  confirmedResumeSeconds: number
  subtitleTracks: SubtitleTrack[]
}) {
  const readings = useNetworkReadings(sourceUrl)
  const playback = usePlaybackSnapshot(mediaElement, engine)
  const sessionId = useMemo(() => globalThis.crypto.randomUUID(), [])
  const [copyMessage, setCopyMessage] = useState("")

  const peakMbps = readings.rateSamples.reduce(
    (peak, sample) => Math.max(peak, sample.mbps),
    0
  )

  const diagnosis = describeNetworkState(playback, readings, engineMode)

  const copyDiagnostics = async () => {
    const snapshot = createPlaybackDiagnosticSnapshot({
      sessionId,
      engineMode,
      readMode:
        engine?.readMode ??
        (engineMode === "native" ? "native-browser" : "unavailable"),
      playbackState: playback.state,
      currentTimeSeconds:
        engine?.currentTime ?? mediaElement?.currentTime ?? null,
      requestedResumeSeconds,
      confirmedResumeSeconds,
      playbackRate: engine?.playbackRate ?? mediaElement?.playbackRate ?? 1,
      bufferedAheadSeconds: playback.bufferedAheadSeconds,
      decodedVideoThroughSeconds: engine?.decodedVideoThroughSeconds ?? null,
      nativeErrorCode:
        engine === null ? (mediaElement?.error?.code ?? null) : null,
      probeResult,
      probeFailure,
      subtitleTracks,
      records: engine?.diagnosticSnapshot ?? [],
    })

    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2))
      setCopyMessage("Playback diagnostics copied.")
    } catch {
      setCopyMessage("Clipboard access is unavailable in this browser.")
    }
  }

  return (
    <section aria-label="Network status" className="space-y-5 text-base">
      <h2 className="sr-only">Network status</h2>
      <div aria-live="polite" className="space-y-1">
        <p className="font-semibold">{diagnosis.title}</p>
        <p className="text-muted-foreground">{diagnosis.detail}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 tabular-nums">
          <NetworkReading
            label="Playback"
            value={playbackStateLabel(playback)}
          />
          <NetworkReading
            label="Buffered ahead"
            value={formatBufferedAhead(playback.bufferedAheadSeconds)}
          />
          <NetworkReading
            label="Last measured read"
            value={formatRate(readings.mediaRateMbps)}
          />
          <NetworkReading
            label="Connection estimate"
            value={formatRate(readings.clientDownlinkMbps, true)}
          />
          <NetworkReading
            label="Connection latency"
            value={
              readings.clientRttMs === null
                ? "Not exposed"
                : `~${Math.round(readings.clientRttMs)} ms RTT`
            }
          />
          <NetworkReading
            label="Origin response"
            value={formatOriginResponse(readings.originResponseMs)}
          />
          <NetworkReading
            label="Metadata probe"
            value={metadataProbeLabel(probeResult, probeFailure)}
          />
        </dl>

        <RateChart
          samples={readings.rateSamples}
          emptyLabel={
            readings.rateSamples.length > 0
              ? "No reads in the last 2 minutes"
              : "No measurable media reads"
          }
        />
      </div>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {networkRateCaption(readings, engineMode, peakMbps)}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void copyDiagnostics()}
        >
          Copy playback diagnostics
        </Button>
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {copyMessage}
        </p>
      </div>
    </section>
  )
}

function metadataProbeLabel(
  result: ProbeResult | null,
  failure: ProbeFailure | null
): string {
  if (failure !== null) {
    const mode = failure.readMode === null ? "" : ` · ${failure.readMode}`

    const category =
      failure.status === null ? failure.kind : `HTTP ${failure.status}`

    return `${category}${mode} · ${failure.attempts} attempts`
  }

  return result === null ? "Not run" : `Ready · ${result.readMode}`
}

function networkRateCaption(
  readings: NetworkReadingsState,
  engineMode: PlaybackEngineMode,
  peakMbps: number
): string {
  if (readings.mediaRateMbps !== null) {
    return `Recent completed media read · peak ${formatRate(peakMbps)}`
  }

  if (engineMode === "native") {
    return "No recent measurable transfer. Playback may be using buffered or cached media; cross-origin links may hide byte timing."
  }

  return "Media read speed appears after a measurable range read completes."
}

function NetworkReading({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-b border-border/60 pb-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-medium">{value}</dd>
    </div>
  )
}

function usePlaybackSnapshot(
  mediaElement: HTMLVideoElement | null,
  engine: MediabunnyEngine | null
): PlaybackSnapshot {
  const store = useMemo(
    () => createPlaybackSnapshotStore(mediaElement, engine),
    [engine, mediaElement]
  )

  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  )
}

function createPlaybackSnapshotStore(
  mediaElement: HTMLVideoElement | null,
  engine: MediabunnyEngine | null
) {
  let waiting = false
  let snapshot = readPlaybackSnapshot(mediaElement, engine, waiting)
  const subscribers = new Set<() => void>()
  let detach: (() => void) | null = null

  const refresh = () => {
    const next = readPlaybackSnapshot(mediaElement, engine, waiting)

    if (
      next.state === snapshot.state &&
      next.bufferedAheadSeconds === snapshot.bufferedAheadSeconds
    ) {
      return
    }

    snapshot = next

    for (const subscriber of subscribers) {
      subscriber()
    }
  }

  const onMediaEvent = (event: Event) => {
    if (event.type === "waiting") {
      waiting = true
    } else if (
      event.type === "playing" ||
      event.type === "canplay" ||
      event.type === "seeked" ||
      event.type === "pause"
    ) {
      waiting = false
    }

    refresh()
  }

  const subscribe = (subscriber: () => void) => {
    subscribers.add(subscriber)

    if (subscribers.size === 1) {
      if (mediaElement !== null) {
        const events = [
          "error",
          "emptied",
          "canplay",
          "ended",
          "loadedmetadata",
          "pause",
          "play",
          "playing",
          "progress",
          "seeked",
          "seeking",
          "stalled",
          "timeupdate",
          "waiting",
        ]

        for (const event of events) {
          mediaElement.addEventListener(event, onMediaEvent)
        }

        detach = () => {
          for (const event of events) {
            mediaElement.removeEventListener(event, onMediaEvent)
          }
        }
      } else if (engine !== null) {
        detach = engine.listen((event) => {
          if (
            event.type === "loaded" ||
            event.type === "playing" ||
            event.type === "timeupdate" ||
            event.type === "seeking" ||
            event.type === "seeked" ||
            event.type === "play" ||
            event.type === "pause" ||
            event.type === "ended"
          ) {
            refresh()
          }
        })
      }

      refresh()
    }

    return () => {
      subscribers.delete(subscriber)

      if (subscribers.size === 0) {
        detach?.()
        detach = null
      }
    }
  }

  return {
    subscribe,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY_PLAYBACK_SNAPSHOT,
  }
}

function readPlaybackSnapshot(
  mediaElement: HTMLVideoElement | null,
  engine: MediabunnyEngine | null,
  waiting: boolean
): PlaybackSnapshot {
  if (engine !== null) {
    return readEnginePlaybackSnapshot(engine)
  }

  if (mediaElement === null) {
    return EMPTY_PLAYBACK_SNAPSHOT
  }

  const bufferedAheadSeconds = readBufferedAhead(mediaElement)
  let state: PlaybackState

  if (mediaElement.error !== null) {
    state = "failed"
  } else if (mediaElement.seeking) {
    state = "seeking"
  } else if (mediaElement.ended) {
    state = "ended"
  } else if (mediaElement.readyState < HTMLMediaElement.HAVE_METADATA) {
    state = "loading"
  } else if (mediaElement.paused) {
    state = "paused"
  } else if (
    waiting ||
    mediaElement.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
  ) {
    state = "buffering"
  } else {
    state = "playing"
  }

  return {
    state,
    bufferedAheadSeconds: roundBufferSeconds(bufferedAheadSeconds),
  }
}

function readEnginePlaybackSnapshot(
  engine: MediabunnyEngine
): PlaybackSnapshot {
  if (engine.seeking) {
    return { state: "seeking", bufferedAheadSeconds: null }
  }

  const bufferedAheadSeconds = roundBufferSeconds(engine.bufferedAheadSeconds)
  let state: PlaybackState = "playing"

  if (engine.ended) {
    state = "ended"
  } else if (engine.paused) {
    state = "paused"
  } else if (bufferedAheadSeconds !== null && bufferedAheadSeconds < 0.25) {
    state = "buffering"
  }

  return { state, bufferedAheadSeconds }
}

function readBufferedAhead(mediaElement: HTMLVideoElement): number | null {
  const { buffered, currentTime } = mediaElement

  for (let index = 0; index < buffered.length; index += 1) {
    const start = buffered.start(index)
    const end = buffered.end(index)

    if (currentTime >= start - 0.25 && currentTime <= end + 0.25) {
      return Math.max(0, end - currentTime)
    }
  }

  return buffered.length === 0 ? null : 0
}

function roundBufferSeconds(seconds: number | null): number | null {
  return seconds === null ? null : Math.round(seconds * 2) / 2
}

function playbackStateLabel(playback: PlaybackSnapshot): string {
  switch (playback.state) {
    case "unavailable":
      return "Not available"
    case "loading":
      return "Loading"
    case "failed":
      return "Failed"
    case "seeking":
      return "Seeking"
    case "playing":
      return "Playing"
    case "buffering":
      return "Buffering"
    case "paused":
      return "Paused"
    case "ended":
      return "Ended"
    default:
      return "Not available"
  }
}

function formatBufferedAhead(seconds: number | null): string {
  if (seconds === null) {
    return "Not exposed"
  }

  return `${seconds.toFixed(1)} s`
}

interface NetworkDiagnosis {
  title: string
  detail: string
}

function describeNetworkState(
  playback: PlaybackSnapshot,
  readings: NetworkReadingsState,
  engineMode: PlaybackEngineMode
): NetworkDiagnosis {
  if (playback.state !== "buffering") {
    const titles: Record<Exclude<PlaybackState, "buffering">, string> = {
      unavailable:
        engineMode === "mediabunny"
          ? "Playback buffer is not measurable"
          : "Playback state is not exposed",
      loading: "Loading media",
      failed: "Playback failed",
      seeking: "Seeking to a new position",
      playing: "Playback is keeping up",
      paused: "Playback is paused",
      ended: "Playback ended",
    }

    return {
      title: titles[playback.state],
      detail:
        playback.state === "playing" && playback.bufferedAheadSeconds !== null
          ? `${formatBufferedAhead(playback.bufferedAheadSeconds)} buffered ahead. ${engineMode === "mediabunny" ? "Measured from audio queued for playback." : "Measured from the player's media buffer."}`
          : "This status comes from the player's current playback state.",
    }
  }

  if (readings.originResponseMs !== null && readings.originResponseMs >= 1500) {
    return {
      title: "Buffering; the origin responded slowly",
      detail: `The last proxied media request waited ${formatDuration(readings.originResponseMs)} for the origin. The media server or route may be contributing.`,
    }
  }

  if (
    (readings.clientDownlinkMbps !== null && readings.clientDownlinkMbps < 3) ||
    (readings.clientRttMs !== null && readings.clientRttMs >= 300)
  ) {
    return {
      title: "Buffering; the connection estimate is weak",
      detail:
        "The browser reports low estimated bandwidth or high latency. Wi-Fi or your internet route may be contributing; this estimate is not a direct Wi-Fi test.",
    }
  }

  if (
    readings.mediaRateMbps !== null &&
    readings.mediaRateMbps <
      Math.min(3, readings.clientDownlinkMbps ?? 3) * 0.75
  ) {
    return {
      title: "Buffering; media delivery is slow",
      detail: `The last measurable media read was ${formatRate(readings.mediaRateMbps)}. The source or network route may be limiting delivery.`,
    }
  }

  if (readings.mediaRateMbps !== null) {
    return {
      title: "Playback is waiting for media",
      detail: `The last completed read measured ${formatRate(readings.mediaRateMbps)}. A completed request cannot show current delivery speed or establish whether it meets this video's bitrate.`,
    }
  }

  return {
    title: "Buffering; the cause is not measurable",
    detail:
      "This browser is not exposing direct-link byte timing, so Myna cannot tell whether Wi-Fi, the internet route, or the media server is responsible.",
  }
}

// Rolling throughput chart over the last two minutes of completed reads.
// Canvas, not SVG: it redraws every second as the window slides, and there
// is nothing to interact with.
function RateChart({
  samples,
  emptyLabel,
}: {
  samples: RateSample[]
  emptyLabel: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current

    if (canvas === null) {
      return undefined
    }

    const draw = () => {
      drawRateChart(canvas, samples, emptyLabel)
    }

    draw()

    // The window slides even when no new read completes.
    const slideTimer = window.setInterval(draw, 1000)

    const resizeObserver = new ResizeObserver(draw)
    resizeObserver.observe(canvas)

    return () => {
      window.clearInterval(slideTimer)
      resizeObserver.disconnect()
    }
  }, [emptyLabel, samples])

  return (
    <figure className="min-w-0 space-y-2">
      <figcaption className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>Media delivery</span>
        <span>Completed reads · Mbps</span>
      </figcaption>
      <div className="h-40">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={
            samples.length === 0
              ? emptyLabel
              : "Media read rate over time; the latest rate is shown above."
          }
          className="text-subtitle-ass h-full w-full"
        />
      </div>
      <div className="flex justify-between text-base text-muted-foreground tabular-nums">
        <span>2 minutes ago</span>
        <span>Now</span>
      </div>
    </figure>
  )
}

interface ChartSurface {
  context: CanvasRenderingContext2D
  width: number
  height: number
  windowStart: number
  strokeColor: string
}

// Sizes the canvas for the device pixel ratio, clears it, and captures the
// draw-time constants (window origin, text color); null when the context is
// unavailable or the element has no box yet.
function prepareChartSurface(canvas: HTMLCanvasElement): ChartSurface | null {
  const context = canvas.getContext("2d")

  if (context === null) {
    return null
  }

  const { width, height } = canvas.getBoundingClientRect()
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)

  canvas.width = Math.round(width * pixelRatio)
  canvas.height = Math.round(height * pixelRatio)

  if (width === 0 || height === 0) {
    return null
  }

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  context.clearRect(0, 0, width, height)

  return {
    context,
    width,
    height,
    windowStart: performance.now() - RATE_CHART_WINDOW_MS,
    strokeColor: getComputedStyle(canvas).color,
  }
}

function drawRateChart(
  canvas: HTMLCanvasElement,
  samples: RateSample[],
  emptyLabel: string
): void {
  const surface = prepareChartSurface(canvas)

  if (surface === null) {
    return
  }

  const visible = samples.filter((sample) => sample.atMs >= surface.windowStart)

  if (visible.length === 0) {
    drawEmptyChart(surface, emptyLabel)

    return
  }

  drawRateSeries(surface, visible)
}

function drawEmptyChart(
  { context, width, height, strokeColor }: ChartSurface,
  label: string
): void {
  context.fillStyle = strokeColor
  context.font = "14px system-ui, sans-serif"
  context.globalAlpha = 0.7
  context.textAlign = "center"
  context.fillText(label, width / 2, height / 2 + 5)
  context.globalAlpha = 1
}

interface ChartScales {
  x: (atMs: number) => number
  y: (mbps: number) => number
  bottomPadding: number
}

function chartScales(
  { width, height, windowStart }: ChartSurface,
  visible: RateSample[]
): ChartScales {
  const topPadding = 8
  const bottomPadding = 6

  const maxMbps = Math.max(
    1,
    visible.reduce((peak, sample) => Math.max(peak, sample.mbps), 0) * 1.15
  )

  return {
    x: (atMs) => ((atMs - windowStart) / RATE_CHART_WINDOW_MS) * width,
    y: (mbps) =>
      height -
      bottomPadding -
      (mbps / maxMbps) * (height - topPadding - bottomPadding),
    bottomPadding,
  }
}

function drawRateSeries(surface: ChartSurface, visible: RateSample[]): void {
  const scales = chartScales(surface, visible)

  strokeRateLine(surface, visible, scales)
  fillRateArea(surface, visible, scales)
}

function strokeRateLine(
  { context, strokeColor }: ChartSurface,
  visible: RateSample[],
  { x, y }: ChartScales
): void {
  context.beginPath()

  for (const [index, sample] of visible.entries()) {
    if (index === 0) {
      context.moveTo(x(sample.atMs), y(sample.mbps))
    } else {
      context.lineTo(x(sample.atMs), y(sample.mbps))
    }
  }

  context.strokeStyle = strokeColor
  context.lineWidth = 1.5
  context.lineJoin = "round"
  context.stroke()
}

function fillRateArea(
  { context, height, strokeColor }: ChartSurface,
  visible: RateSample[],
  { x, y, bottomPadding }: ChartScales
): void {
  const lastSample = visible.at(-1)

  if (lastSample === undefined) {
    return
  }

  const gradient = context.createLinearGradient(0, 0, 0, height)

  gradient.addColorStop(0, "rgba(127, 127, 127, 0.18)")
  gradient.addColorStop(1, "rgba(127, 127, 127, 0)")

  context.beginPath()
  context.moveTo(x(visible[0].atMs), height - bottomPadding)

  for (const sample of visible) {
    context.lineTo(x(sample.atMs), y(sample.mbps))
  }

  context.lineTo(x(lastSample.atMs), height - bottomPadding)
  context.closePath()
  context.fillStyle = gradient
  context.fill()

  context.beginPath()
  context.arc(x(lastSample.atMs), y(lastSample.mbps), 2.5, 0, Math.PI * 2)
  context.fillStyle = strokeColor
  context.fill()
}

function useNetworkReadings(sourceUrl: string): NetworkReadingsState {
  const [readings, setReadings] = useState(EMPTY_NETWORK_READINGS)

  useEffect(() => {
    const mediaUrl = new URL(sourceUrl)

    let mediaRateStaleTimer: ReturnType<typeof setTimeout> | undefined
    let originResponseStaleTimer: ReturnType<typeof setTimeout> | undefined
    const connection = navigator.connection ?? null

    const updateConnection = () => {
      setReadings((current) => {
        const previous = readingsForSource(current, sourceUrl)

        return {
          ...previous,
          sourceUrl,
          clientDownlinkMbps: readConnectionValue(connection, "downlink"),
          clientRttMs: readConnectionValue(connection, "rtt"),
        }
      })
    }

    const recordResource = (entry: PerformanceResourceTiming) => {
      const sample = readResourceSample(entry, mediaUrl)

      if (sample === null) {
        return
      }

      setReadings((current) => {
        const previous = readingsForSource(current, sourceUrl)

        return {
          ...previous,
          sourceUrl,
          mediaRateMbps: sample.mediaRateMbps ?? previous.mediaRateMbps,
          originResponseMs:
            sample.originResponseMs ?? previous.originResponseMs,
          rateSamples:
            sample.mediaRateMbps === null
              ? previous.rateSamples
              : appendRateSample(previous.rateSamples, {
                  atMs: performance.now() - sample.ageMs,
                  mbps: sample.mediaRateMbps,
                }),
        }
      })

      if (sample.mediaRateMbps !== null) {
        mediaRateStaleTimer = resetStaleTimer(
          mediaRateStaleTimer,
          sample.ageMs,
          () =>
            setReadings((current) =>
              current.sourceUrl === sourceUrl
                ? { ...current, mediaRateMbps: null }
                : current
            )
        )
      }

      if (sample.originResponseMs !== null) {
        originResponseStaleTimer = resetStaleTimer(
          originResponseStaleTimer,
          sample.ageMs,
          () =>
            setReadings((current) =>
              current.sourceUrl === sourceUrl
                ? { ...current, originResponseMs: null }
                : current
            )
        )
      }
    }

    updateConnection()
    connection?.addEventListener("change", updateConnection)

    let observer: PerformanceObserver | null = null

    if (typeof PerformanceObserver !== "undefined") {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry instanceof PerformanceResourceTiming) {
            recordResource(entry)
          }
        }
      })

      observer.observe({ type: "resource" })
    }

    for (const entry of performance.getEntriesByType("resource")) {
      if (entry instanceof PerformanceResourceTiming) {
        recordResource(entry)
      }
    }

    return () => {
      observer?.disconnect()
      connection?.removeEventListener("change", updateConnection)

      if (mediaRateStaleTimer !== undefined) {
        clearTimeout(mediaRateStaleTimer)
      }

      if (originResponseStaleTimer !== undefined) {
        clearTimeout(originResponseStaleTimer)
      }
    }
  }, [sourceUrl])

  return readings.sourceUrl === sourceUrl ? readings : EMPTY_NETWORK_READINGS
}

function readingsForSource(
  current: NetworkReadingsState,
  sourceUrl: string
): NetworkReadingsState {
  return current.sourceUrl === sourceUrl
    ? current
    : { ...EMPTY_NETWORK_READINGS, sourceUrl }
}

function appendRateSample(
  samples: RateSample[],
  sample: RateSample
): RateSample[] {
  const appended = [...samples, sample].toSorted(
    (left, right) => left.atMs - right.atMs
  )

  return appended.slice(-RATE_CHART_MAX_SAMPLES)
}

function readResourceSample(
  entry: PerformanceResourceTiming,
  mediaUrl: URL
): ResourceSample | null {
  const ageMs = performance.now() - entry.responseEnd
  let resourceUrl: URL

  try {
    resourceUrl = new URL(entry.name)
  } catch {
    return null
  }

  const isProxyRead =
    resourceUrl.origin === window.location.origin &&
    resourceUrl.pathname === "/api/media-proxy" &&
    resourceUrl.searchParams.get("url") === mediaUrl.href

  const isDirectMediaRead =
    !isHlsUrl(mediaUrl.href) &&
    resourceUrl.href === mediaUrl.href &&
    (entry.initiatorType === "video" ||
      entry.initiatorType === "fetch" ||
      entry.initiatorType === "xmlhttprequest")

  if (
    (!isProxyRead && !isDirectMediaRead) ||
    entry.transferSize === 0 ||
    ageMs > NETWORK_READING_STALE_MS
  ) {
    return null
  }

  const transferDurationMs = entry.responseEnd - entry.responseStart

  const mediaRateMbps =
    entry.encodedBodySize >= MIN_RATE_SAMPLE_BYTES && transferDurationMs > 0
      ? (entry.encodedBodySize * 8) / (transferDurationMs * 1000)
      : null

  const originResponseMs = isProxyRead
    ? (entry.serverTiming?.find((metric) => metric.name === "upstream")
        ?.duration ?? null)
    : null

  if (mediaRateMbps === null && originResponseMs === null) {
    return null
  }

  return { ageMs, mediaRateMbps, originResponseMs }
}

function resetStaleTimer(
  timer: ReturnType<typeof setTimeout> | undefined,
  ageMs: number,
  clearReading: () => void
): ReturnType<typeof setTimeout> {
  if (timer !== undefined) {
    clearTimeout(timer)
  }

  return setTimeout(clearReading, Math.max(0, NETWORK_READING_STALE_MS - ageMs))
}

function readConnectionValue(
  connection: MynaNetworkConnection | null,
  property: "downlink" | "rtt"
): number | null {
  if (connection === null) {
    return null
  }

  const value = connection[property]

  return Number.isFinite(value) ? value : null
}

function formatRate(rateMbps: number | null, estimate = false): string {
  if (rateMbps === null) {
    return "Not exposed"
  }

  const rate =
    rateMbps >= 1
      ? `${rateMbps.toFixed(1)} Mbps`
      : `${(rateMbps * 1000).toFixed(0)} Kbps`

  return estimate ? `~${rate}` : rate
}

function formatOriginResponse(waitMs: number | null): string {
  return waitMs === null ? "Not exposed" : formatDuration(waitMs)
}

function formatDuration(waitMs: number): string {
  return waitMs >= 1000
    ? `${(waitMs / 1000).toFixed(1)} s`
    : `${Math.round(waitMs)} ms`
}
