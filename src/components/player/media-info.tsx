import { useEffect, useState } from "react"

import type { PlaybackSource } from "#/media/models/source"
import { probeSource, type ProbeResult } from "#/media/probe/metadata-probe"

type ProbeState =
  | { status: "loading" }
  | { status: "ready"; result: ProbeResult }
  | { status: "failed" }

const CODEC_LABELS: [prefix: string, label: string][] = [
  ["avc1", "H.264"],
  ["avc3", "H.264"],
  ["hev1", "HEVC"],
  ["hvc1", "HEVC"],
  ["vp09", "VP9"],
  ["vp08", "VP8"],
  ["av01", "AV1"],
  ["mp4a", "AAC"],
  ["opus", "Opus"],
  ["ec-3", "E-AC-3"],
  ["ac-3", "AC-3"],
  ["dts", "DTS"],
  ["flac", "FLAC"],
  ["vorbis", "Vorbis"],
]

function codecLabel(codecParameterString: string | null): string {
  if (codecParameterString === null) {
    return "unknown codec"
  }

  for (const [prefix, label] of CODEC_LABELS) {
    if (codecParameterString.startsWith(prefix)) {
      return label
    }
  }

  return codecParameterString
}

function languageLabel(languageCode: string): string {
  if (languageCode === "und") {
    return "Unknown language"
  }

  try {
    return (
      new Intl.DisplayNames(["en"], { type: "language" }).of(languageCode) ??
      languageCode
    )
  } catch {
    return languageCode
  }
}

function channelLabel(channels: number): string {
  if (channels === 1) {
    return "mono"
  }

  if (channels === 2) {
    return "stereo"
  }

  if (channels === 6) {
    return "5.1"
  }

  if (channels === 8) {
    return "7.1"
  }

  return `${channels} ch`
}

function durationLabel(seconds: number): string {
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60

  const minutePart = hours > 0 ? String(minutes).padStart(2, "0") : `${minutes}`

  return `${hours > 0 ? `${hours}:` : ""}${minutePart}:${String(rest).padStart(2, "0")}`
}

function trackLabel(track: ProbeResult["tracks"][number]): string {
  const parts = [
    languageLabel(track.languageCode),
    codecLabel(track.codecParameterString),
  ]

  if (track.kind === "video") {
    if (track.displayWidth !== null && track.displayHeight !== null) {
      parts.push(`${track.displayWidth}×${track.displayHeight}`)
    }
  } else {
    if (track.channels !== null) {
      parts.push(channelLabel(track.channels))
    }

    if (track.sampleRate !== null) {
      parts.push(`${Math.round(track.sampleRate / 100) / 10} kHz`)
    }
  }

  return parts.join(" · ")
}

export function MediaInfo({ source }: { source: PlaybackSource }) {
  const [state, setState] = useState<ProbeState>({ status: "loading" })

  useEffect(() => {
    const controller = new AbortController()

    probeSource(source, controller.signal)
      .then((result) => setState({ status: "ready", result }))
      .catch(() => {
        // Probe failures are informational only; native playback is
        // unaffected and the panel simply reports what it could not read.
        if (!controller.signal.aborted) {
          setState({ status: "failed" })
        }
      })

    return () => controller.abort()
  }, [source])

  return (
    <section className="text-muted-foreground space-y-1.5 text-sm">
      {import.meta.env.DEV ? <EngineBadge state={state} /> : null}
      {state.status === "loading" ? (
        <p className="text-xs">Reading media information…</p>
      ) : null}
      {state.status === "failed" ? (
        <p className="text-xs">
          Media information is unavailable for this link.
        </p>
      ) : null}
      {state.status === "ready" ? (
        <div className="space-y-1">
          <p className="text-xs tabular-nums">
            {state.result.containerName}
            {state.result.durationSeconds !== null
              ? ` · ${durationLabel(state.result.durationSeconds)}`
              : ""}
            {` · ${state.result.tracks.length} track${state.result.tracks.length === 1 ? "" : "s"}`}
          </p>
          <ul className="space-y-0.5">
            {state.result.tracks.map((track) => (
              <li key={`${track.kind}-${track.number}`} className="text-xs">
                <span className="text-foreground">
                  {track.kind === "video" ? "Video" : `Audio ${track.number}`}
                </span>{" "}
                · {trackLabel(track)}
                {track.decodable ? "" : " · not decodable in this browser"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function EngineBadge({ state }: { state: ProbeState }) {
  const readMode =
    state.status === "ready" ? ` · probe via ${state.result.readMode}` : ""

  return (
    <p className="text-foreground/60 text-xs tracking-wide uppercase">
      {`Engine: Native${readMode}`}
    </p>
  )
}
