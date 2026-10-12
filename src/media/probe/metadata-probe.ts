// Background metadata probe. Opens a second mediabunny Input over the
// source URL (direct first, proxy on CORS failure) to surface container,
// duration, tracks, and decodability. Runs alongside native playback and
// must never disturb it; failures propagate to the caller to display.
import type { InputAudioTrack, InputTrack, InputVideoTrack } from "mediabunny"

import type { PlaybackSource } from "../models/source"
import { proxiedMediaUrl } from "../proxy/proxied-url"

type ProbeReadMode = "direct" | "proxy"

export interface ProbeTrackInfo {
  number: number
  kind: "video" | "audio"
  codecParameterString: string | null
  languageCode: string
  name: string | null
  decodable: boolean
  default: boolean
  displayWidth: number | null
  displayHeight: number | null
  channels: number | null
  sampleRate: number | null
}

export interface ProbeResult {
  containerName: string
  durationSeconds: number | null
  tracks: ProbeTrackInfo[]
  readMode: ProbeReadMode
}

const PROBE_TIMEOUT_SECONDS = 20

async function describeTrack(
  track: InputTrack
): Promise<ProbeTrackInfo | null> {
  const videoTrack: InputVideoTrack | null = track.isVideoTrack() ? track : null
  const audioTrack: InputAudioTrack | null = track.isAudioTrack() ? track : null

  if (videoTrack === null && audioTrack === null) {
    return null
  }

  const [codecParameterString, languageCode, name, decodable, disposition] =
    await Promise.all([
      track.getCodecParameterString(),
      track.getLanguageCode(),
      track.getName(),
      track.canDecode(),
      track.getDisposition(),
    ])

  const displayWidth =
    videoTrack === null ? null : await videoTrack.getDisplayWidth()

  const displayHeight =
    videoTrack === null ? null : await videoTrack.getDisplayHeight()

  const channels =
    audioTrack === null ? null : await audioTrack.getNumberOfChannels()

  const sampleRate =
    audioTrack === null ? null : await audioTrack.getSampleRate()

  return {
    number: track.number,
    kind: videoTrack === null ? "audio" : "video",
    codecParameterString,
    languageCode,
    name,
    decodable,
    default: disposition.default,
    displayWidth,
    displayHeight,
    channels,
    sampleRate,
  }
}

async function readViaUrl(readUrl: string, signal: AbortSignal) {
  const {
    Input,
    UrlSource,
    MP4,
    MATROSKA,
    WEBM,
    MP3,
    WAVE,
    OGG,
    ADTS,
    FLAC,
    MPEG_TS,
  } = await import("mediabunny")

  const input = new Input({
    formats: [MP4, MATROSKA, WEBM, MP3, WAVE, OGG, ADTS, FLAC, MPEG_TS],
    source: new UrlSource(readUrl),
  })

  const disposeFromAbort = () => input.dispose()
  signal.addEventListener("abort", disposeFromAbort, { once: true })

  const deadline = setTimeout(
    () => input.dispose(),
    PROBE_TIMEOUT_SECONDS * 1000
  )

  try {
    const format = await input.getFormat()
    const tracks = await input.getTracks()
    const described = await Promise.all(tracks.map(describeTrack))

    return {
      containerName: format.name,
      durationSeconds: await input.getDurationFromMetadata(),
      tracks: described.filter(
        (track): track is ProbeTrackInfo => track !== null
      ),
    }
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener("abort", disposeFromAbort)
    input.dispose()
  }
}

export async function probeSource(
  source: PlaybackSource,
  signal: AbortSignal
): Promise<ProbeResult> {
  try {
    return { ...(await readViaUrl(source.url, signal)), readMode: "direct" }
  } catch (directError) {
    if (signal.aborted) {
      throw directError
    }

    return {
      ...(await readViaUrl(proxiedMediaUrl(source.url), signal)),
      readMode: "proxy",
    }
  }
}

export interface FileDetails {
  filename: string
  sizeBytes: number | null
}

const FILE_DETAILS_TIMEOUT_MS = 8_000

const CONTENT_RANGE_TOTAL = /\/(\d+)$/

// `filename*=UTF-8''%E2%80%A6` (RFC 5987) wins over the plain `filename=`
// parameter; both may be quoted.
function filenameFromDispositionHeader(value: string): string | null {
  const extended = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value)

  if (extended !== null) {
    try {
      return decodeURIComponent(
        extended[1].trim().replaceAll(/^["']|["']$/g, "")
      )
    } catch {
      // Malformed percent-encoding; fall through to the plain parameter.
    }
  }

  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value)

  if (plain !== null) {
    return (plain[1] ?? plain[2]).trim()
  }

  return null
}

// Signed download URLs often name the file in a query parameter instead of
// the path; S3-style presigned links use `response-content-disposition`.
function filenameFromQueryParameters(url: URL): string | null {
  for (const name of [
    "response-content-disposition",
    "content-disposition",
    "filename",
    "file",
  ]) {
    const value = url.searchParams.get(name)

    if (value === null) {
      continue
    }

    const fromDisposition = filenameFromDispositionHeader(value)

    if (fromDisposition !== null && fromDisposition.length > 0) {
      return fromDisposition
    }

    if (value.length > 0) {
      return value
    }
  }

  return null
}

function filenameFromResponse(url: URL, response: Response): string {
  const disposition = response.headers.get("content-disposition")

  if (disposition !== null) {
    const filename = filenameFromDispositionHeader(disposition)

    if (filename !== null && filename.length > 0) {
      return filename
    }
  }

  const fromQuery = filenameFromQueryParameters(url)

  if (fromQuery !== null) {
    return fromQuery
  }

  const fromPath = url.pathname.split("/").pop() ?? ""

  if (fromPath.length === 0) {
    return url.host
  }

  try {
    return decodeURIComponent(fromPath)
  } catch {
    return fromPath
  }
}

function sizeFromResponse(response: Response): number | null {
  const contentRange = response.headers.get("content-range")

  if (contentRange !== null) {
    const total = CONTENT_RANGE_TOTAL.exec(contentRange)

    if (total !== null) {
      const parsed = Number(total[1])

      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed
      }
    }
  }

  // On a 206 the content-length is the range chunk size (1 byte here), not
  // the file size; only a full 200 response carries the real length.
  if (response.status === 200) {
    const length = Number(response.headers.get("content-length"))

    if (Number.isFinite(length) && length > 0) {
      return length
    }
  }

  return null
}

// One zero-length range request — headers only, the body is cancelled
// immediately — to learn the display filename and size before playback.
// fetchUrl may be relative (the proxy path); displayUrl is always the
// absolute media URL the filename is derived from.
async function readFileDetails(
  fetchUrl: string,
  displayUrl: string,
  signal: AbortSignal
): Promise<FileDetails | null> {
  const controller = new AbortController()

  const abortFromCaller = () => controller.abort()

  signal.addEventListener("abort", abortFromCaller, { once: true })

  const deadline = setTimeout(() => controller.abort(), FILE_DETAILS_TIMEOUT_MS)

  try {
    const response = await fetch(fetchUrl, {
      headers: { Range: "bytes=0-0" },
      signal: controller.signal,
    })

    // The one-byte body is worthless; releasing it lets the connection close
    // instead of lingering until garbage collection.
    await response.body?.cancel().catch(() => {})

    if (!response.ok) {
      return null
    }

    return {
      filename: filenameFromResponse(new URL(displayUrl), response),
      sizeBytes: sizeFromResponse(response),
    }
  } catch {
    return null
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener("abort", abortFromCaller)
  }
}

// Filename and size for the watch header and the local history list, with
// the same direct-then-proxy fallback order the engines use. A null result
// means "no details"; callers fall back to the URL-derived name.
export async function probeFileDetails(
  source: PlaybackSource,
  signal: AbortSignal
): Promise<FileDetails | null> {
  const direct = await readFileDetails(source.url, source.url, signal)

  if (direct !== null && direct.sizeBytes !== null) {
    return direct
  }

  if (signal.aborted) {
    return direct
  }

  const proxied = await readFileDetails(
    proxiedMediaUrl(source.url),
    source.url,
    signal
  )

  if (direct === null) {
    return proxied
  }

  if (proxied === null) {
    return direct
  }

  return {
    filename: direct.filename,
    sizeBytes: proxied.sizeBytes ?? direct.sizeBytes,
  }
}
