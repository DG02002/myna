// External subtitle text: one parser for SRT and WebVTT (they differ in
// header requirements and timestamp separators, not in cue shape), plus the
// client-side loader that fetches a subtitle URL. Cues are added to media
// elements programmatically, never through `<track src>` — a cross-origin
// track URL needs CORS headers plus a `crossOrigin` attribute, and that
// attribute is banned here because it breaks native cross-origin playback.
import { proxiedMediaUrl } from "./proxy/proxied-url"

export interface SubtitleCue {
  startTime: number
  endTime: number
  // Raw cue text with VTT markup (`<i>`, `<v Name>`) intact: VTTCue renders
  // it natively; the advanced-engine overlay strips it for display.
  text: string
}

export interface SubtitleTrack {
  id: string
  label: string
  language: string
  flags?: SubtitleTrackFlags
  source:
    | { kind: "external" }
    | {
        kind: "matroska"
        trackNumber: number
        codecId: string
      }
  status: "loading" | "available" | "ready" | "incomplete" | "failed"
  cues: SubtitleCue[]
}

export interface SubtitleTrackFlags {
  default: boolean
  forced: boolean
  hearingImpaired: boolean
  visualImpaired: boolean
  textDescriptions: boolean
  original: boolean
  commentary: boolean
}

export interface SubtitleTrackName {
  label: string
  language: string
}

type SubtitleLoadFailure = { kind: "unreachable" } | { kind: "invalid" }

export type SubtitleLoadResult =
  | { cues: SubtitleCue[] }
  | { failure: SubtitleLoadFailure }
  | { aborted: true }

const MAX_SUBTITLE_BYTES = 4_000_000

const SUBTITLE_FETCH_DEADLINE_MS = 15_000

// Hours are optional in WebVTT timestamps; both separators are accepted in
// both formats because real files mix them.
const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/

const TIMING_LINE = /^(\S+)\s+-->\s+(\S+)/

function parseTimestamp(value: string): number | null {
  const match = TIMESTAMP.exec(value)

  if (match === null) {
    return null
  }

  const hours = match[1] === undefined ? 0 : Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const milliseconds = Number(match[4].padEnd(3, "0"))

  if (minutes > 59 || seconds > 59) {
    return null
  }

  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000
}

// `start --> end` plus anything the formats allow after the end timestamp
// (WebVTT cue settings, legacy SRT coordinates) — the trailing settings are
// ignored in V1 rendering.
function parseTimingLine(
  line: string
): { startTime: number; endTime: number } | null {
  const match = TIMING_LINE.exec(line)

  if (match === null) {
    return null
  }

  const startTime = parseTimestamp(match[1])
  const endTime = parseTimestamp(match[2])

  if (startTime === null || endTime === null || endTime < startTime) {
    return null
  }

  return { startTime, endTime }
}

// Malformed cues are skipped, never fatal: one broken block in a
// hand-edited file must not take down the other thousand cues. Blocks
// without a timing line (WEBVTT headers, NOTE/STYLE blocks, junk before the
// first cue) fall through the same way.
function parseCueBlock(block: string): SubtitleCue | null {
  const lines = block.split("\n")
  const timingIndex = lines.findIndex((line) => parseTimingLine(line) !== null)

  if (timingIndex === -1) {
    return null
  }

  const timing = parseTimingLine(lines[timingIndex])

  if (timing === null) {
    return null
  }

  const text = lines
    .slice(timingIndex + 1)
    .join("\n")
    .trim()

  return text.length === 0 ? null : { ...timing, text }
}

export function parseSubtitleCues(content: string): SubtitleCue[] {
  const normalized = content.replace(/^\uFEFF/, "").replaceAll(/\r\n?/g, "\n")
  const cues: SubtitleCue[] = []

  for (const block of normalized.split(/\n[ \t]*\n/)) {
    const cue = parseCueBlock(block)

    if (cue !== null) {
      cues.push(cue)
    }
  }

  return cues
}

// Cue text for the advanced-engine overlay: VTTCue markup and entities do
// not survive textContent rendering, so strip and decode the common ones.
export function subtitleCueDisplayText(text: string): string {
  return text
    .replaceAll(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", "\u00a0")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
}

const SUBTITLE_EXTENSIONS = /\.(vtt|srt|sub|webvtt|txt)$/i

const LANGUAGE_SEGMENT = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/

// A real label for the captions menu, derived from the URL: the filename
// without extension, with a trailing language tag (`movie.en.srt`) split
// into label + language.
export function subtitleTrackName(
  url: string,
  fallbackIndex: number
): SubtitleTrackName {
  let filename: string

  try {
    filename = new URL(url).pathname.split("/").pop() ?? ""
  } catch {
    filename = ""
  }

  let decoded = filename

  try {
    decoded = decodeURIComponent(filename)
  } catch {
    // Malformed percent-encoding; the raw name is still a usable label.
  }

  const stem = decoded.replace(SUBTITLE_EXTENSIONS, "")

  if (stem.length > 0) {
    const segments = stem.split(".")
    const last = segments.at(-1) ?? ""

    if (segments.length > 1 && LANGUAGE_SEGMENT.test(last)) {
      return { label: segments.slice(0, -1).join("."), language: last }
    }

    return { label: stem, language: "" }
  }

  return { label: `Subtitles ${fallbackIndex}`, language: "" }
}

// One fetch attempt with a deadline, a size bound, and a cancellation path
// chained to the caller's signal. Returns null for anything that is not an
// OK response body under the size bound.
async function fetchSubtitleTextOnce(
  url: string,
  signal: AbortSignal
): Promise<string | null> {
  if (signal.aborted) {
    return null
  }

  const controller = new AbortController()

  const abortFromCaller = () => controller.abort()

  signal.addEventListener("abort", abortFromCaller, { once: true })

  const deadline = setTimeout(
    () => controller.abort(),
    SUBTITLE_FETCH_DEADLINE_MS
  )

  try {
    const response = await fetch(url, { signal: controller.signal })
    const length = Number(response.headers.get("content-length"))

    if (
      !response.ok ||
      (Number.isFinite(length) && length > MAX_SUBTITLE_BYTES)
    ) {
      controller.abort()

      return null
    }

    if (response.body === null) {
      return null
    }

    return await readBodyText(response.body, controller)
  } catch {
    return null
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener("abort", abortFromCaller)
  }
}

function readBodyText(
  body: ReadableStream<Uint8Array>,
  controller: AbortController
): Promise<string | null> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ""

  // Continuation-passing read so the size bound can abort mid-body without
  // awaiting inside a loop.
  const pull = async (): Promise<string | null> => {
    const { done, value } = await reader.read()

    if (done) {
      return text + decoder.decode()
    }

    received += value.byteLength
    text += decoder.decode(value, { stream: true })

    if (received > MAX_SUBTITLE_BYTES) {
      controller.abort()

      return null
    }

    return pull()
  }

  return pull()
}

export async function loadSubtitleCues(
  url: string,
  signal: AbortSignal
): Promise<SubtitleLoadResult> {
  // Direct first; the same-origin proxy only when the origin blocks
  // cross-origin reads (the same fallback order the advanced engine uses).
  const directText = await fetchSubtitleTextOnce(url, signal)

  if (signal.aborted) {
    return { aborted: true }
  }

  const text =
    directText ?? (await fetchSubtitleTextOnce(proxiedMediaUrl(url), signal))

  if (signal.aborted) {
    return { aborted: true }
  }

  if (text === null) {
    return { failure: { kind: "unreachable" } }
  }

  const cues = parseSubtitleCues(text)

  return cues.length > 0 ? { cues } : { failure: { kind: "invalid" } }
}
