// Label formatting shared by the media info panel and the audio track menu:
// real information like "English · E-AC-3 · 5.1 · 48 kHz", never bare names.
import type { ProbeTrackInfo } from "./metadata-probe"

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

export function durationLabel(seconds: number): string {
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60

  const minutePart = hours > 0 ? String(minutes).padStart(2, "0") : `${minutes}`

  return `${hours > 0 ? `${hours}:` : ""}${minutePart}:${String(rest).padStart(2, "0")}`
}

export function probeTrackLabel(track: ProbeTrackInfo): string {
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
