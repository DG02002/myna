import { useEffect, useState } from "react"

import type { PlaybackEngineMode } from "#/components/player/playback-stage"

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
  clientDownlinkMbps: number | null
  clientRttMs: number | null
  mediaRateMbps: number | null
  proxyUpstreamWaitMs: number | null
}

interface ResourceSample {
  ageMs: number
  mediaRateMbps: number | null
  proxyUpstreamWaitMs: number | null
}

const EMPTY_NETWORK_READINGS: NetworkReadingsState = {
  clientDownlinkMbps: null,
  clientRttMs: null,
  mediaRateMbps: null,
  proxyUpstreamWaitMs: null,
}

const NETWORK_READING_STALE_MS = 30_000

// Tiny index reads mostly measure request latency, not stream throughput.
const MIN_RATE_SAMPLE_BYTES = 64 * 1024

export function NetworkInfo({
  sourceUrl,
  engineMode,
}: {
  sourceUrl: string
  engineMode: PlaybackEngineMode
}) {
  const readings = useNetworkReadings(sourceUrl)

  return (
    <section aria-label="Network diagnostics" className="space-y-1">
      <p className="text-foreground/60 text-xs tracking-wide uppercase">
        Network
      </p>
      <dl className="space-y-0.5 text-xs tabular-nums">
        <div className="flex justify-between gap-3">
          <dt>Recent media rate</dt>
          <dd>{formatRate(readings.mediaRateMbps)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Client link estimate</dt>
          <dd>
            {formatRate(readings.clientDownlinkMbps, true)}
            {readings.clientRttMs === null
              ? ""
              : ` · ${Math.round(readings.clientRttMs)} ms RTT`}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Proxy upstream wait</dt>
          <dd>{formatProxyWait(readings.proxyUpstreamWaitMs, engineMode)}</dd>
        </div>
      </dl>
      <p className="text-xs">
        Media rate uses completed reads; client link speed is an estimate.
      </p>
    </section>
  )
}

function useNetworkReadings(sourceUrl: string): NetworkReadingsState {
  const [readings, setReadings] = useState(EMPTY_NETWORK_READINGS)

  useEffect(() => {
    const sourceOrigin = new URL(sourceUrl).origin

    let mediaRateStaleTimer: ReturnType<typeof setTimeout> | undefined
    let proxyWaitStaleTimer: ReturnType<typeof setTimeout> | undefined
    const connection = navigator.connection ?? null

    const updateConnection = () => {
      setReadings((current) => ({
        ...current,
        clientDownlinkMbps: readConnectionValue(connection, "downlink"),
        clientRttMs: readConnectionValue(connection, "rtt"),
      }))
    }

    const recordResource = (entry: PerformanceResourceTiming) => {
      const sample = readResourceSample(entry, sourceOrigin)

      if (sample === null) {
        return
      }

      setReadings((current) => ({
        ...current,
        mediaRateMbps: sample.mediaRateMbps ?? current.mediaRateMbps,
        proxyUpstreamWaitMs:
          sample.proxyUpstreamWaitMs ?? current.proxyUpstreamWaitMs,
      }))

      if (sample.mediaRateMbps !== null) {
        mediaRateStaleTimer = resetStaleTimer(
          mediaRateStaleTimer,
          sample.ageMs,
          () => setReadings((current) => ({ ...current, mediaRateMbps: null }))
        )
      }

      if (sample.proxyUpstreamWaitMs !== null) {
        proxyWaitStaleTimer = resetStaleTimer(
          proxyWaitStaleTimer,
          sample.ageMs,
          () =>
            setReadings((current) => ({
              ...current,
              proxyUpstreamWaitMs: null,
            }))
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

      if (proxyWaitStaleTimer !== undefined) {
        clearTimeout(proxyWaitStaleTimer)
      }
    }
  }, [sourceUrl])

  return readings
}

function readResourceSample(
  entry: PerformanceResourceTiming,
  sourceOrigin: string
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
    resourceUrl.pathname === "/api/media-proxy"

  const isDirectMediaRead =
    resourceUrl.origin === sourceOrigin &&
    (entry.initiatorType === "video" ||
      entry.initiatorType === "fetch" ||
      entry.initiatorType === "xmlhttprequest")

  if (
    (!isProxyRead && !isDirectMediaRead) ||
    ageMs > NETWORK_READING_STALE_MS
  ) {
    return null
  }

  const transferDurationMs = entry.responseEnd - entry.responseStart

  const mediaRateMbps =
    entry.encodedBodySize >= MIN_RATE_SAMPLE_BYTES && transferDurationMs > 0
      ? (entry.encodedBodySize * 8) / (transferDurationMs * 1000)
      : null

  const proxyUpstreamWaitMs = isProxyRead
    ? (entry.serverTiming?.find((metric) => metric.name === "upstream")
        ?.duration ?? null)
    : null

  if (mediaRateMbps === null && proxyUpstreamWaitMs === null) {
    return null
  }

  return { ageMs, mediaRateMbps, proxyUpstreamWaitMs }
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

function formatProxyWait(
  waitMs: number | null,
  engineMode: PlaybackEngineMode
): string {
  if (waitMs !== null) {
    return waitMs >= 1000
      ? `${(waitMs / 1000).toFixed(1)} s`
      : `${Math.round(waitMs)} ms`
  }

  return engineMode === "mediabunny"
    ? "Waiting for a proxy read"
    : "Not using proxy"
}
