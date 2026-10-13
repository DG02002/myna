// Background metadata probe. Opens a second mediabunny Input over the
// source URL (direct first, proxy on CORS failure) to surface container,
// duration, tracks, and decodability. Runs alongside native playback and
// must never disturb it; failures propagate to the caller to display.
import type { InputAudioTrack, InputTrack, InputVideoTrack } from "mediabunny"

import type { PlaybackSource } from "../models/source"
import { proxiedMediaUrl } from "../proxy/proxied-url"
import {
  type AdvancedReadDiagnostic,
  type AdvancedReadFailureKind,
  AdvancedMediaReadError,
  AdvancedMediaReadPolicy,
  isProxyFallbackFailure,
} from "../read-policy"

export type ProbeReadMode = "direct" | "proxy"

export interface ProbeFailure {
  kind: AdvancedReadFailureKind | "unknown"
  status: number | null
  retryAfterMs: number | null
  readMode: ProbeReadMode | null
  attempts: number
  diagnostics: AdvancedReadDiagnostic[]
}

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

async function readViaUrl(
  readUrl: string,
  signal: AbortSignal,
  readPolicy: AdvancedMediaReadPolicy
) {
  if (signal.aborted) {
    throw new AdvancedMediaReadError("aborted")
  }

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
    source: new UrlSource(readUrl, readPolicy.urlSourceOptions),
  })

  const disposeFromAbort = () => input.dispose()
  signal.addEventListener("abort", disposeFromAbort, { once: true })

  if (signal.aborted) {
    input.dispose()
  }

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

interface ProbeSourceOptions {
  readPolicy?: AdvancedMediaReadPolicy
  onReadMode?: (mode: ProbeReadMode) => void
}

export async function probeSource(
  source: PlaybackSource,
  signal: AbortSignal,
  options: ProbeSourceOptions = {}
): Promise<ProbeResult> {
  const { readPolicy = new AdvancedMediaReadPolicy(), onReadMode } = options

  onReadMode?.("direct")

  try {
    return {
      ...(await readViaUrl(source.url, signal, readPolicy)),
      readMode: "direct",
    }
  } catch (directError) {
    if (signal.aborted) {
      throw new AdvancedMediaReadError("aborted")
    }

    if (
      !(directError instanceof Error) ||
      !isProxyFallbackFailure(directError)
    ) {
      throw directError
    }

    onReadMode?.("proxy")

    return {
      ...(await readViaUrl(proxiedMediaUrl(source.url), signal, readPolicy)),
      readMode: "proxy",
    }
  }
}

export interface FileDetails {
  filename: string
  sizeBytes: number | null
}

const FILE_DETAILS_TIMEOUT_MS = 8_000

interface FileDetailsRequest {
  displayUrl: string
  signal: AbortSignal
  readPolicy: AdvancedMediaReadPolicy
}

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
  request: FileDetailsRequest
): Promise<FileDetails | null> {
  const { displayUrl, signal, readPolicy } = request

  if (signal.aborted) {
    return null
  }

  const controller = new AbortController()

  const abortFromCaller = () => controller.abort()

  signal.addEventListener("abort", abortFromCaller, { once: true })

  const deadline = setTimeout(() => controller.abort(), FILE_DETAILS_TIMEOUT_MS)

  try {
    const response = await readPolicy.fetchWithRetries(fetchUrl, {
      headers: { Range: "bytes=0-0" },
      signal: controller.signal,
    })

    // The one-byte body is worthless; start cancellation without making the
    // metadata result depend on an upstream stream's cancel acknowledgement.
    void response.body?.cancel().catch(() => {})

    return {
      filename: filenameFromResponse(new URL(displayUrl), response),
      sizeBytes: sizeFromResponse(response),
    }
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
  signal: AbortSignal,
  readPolicy = new AdvancedMediaReadPolicy()
): Promise<FileDetails | null> {
  try {
    return await readFileDetails(source.url, {
      displayUrl: source.url,
      signal,
      readPolicy,
    })
  } catch (directError) {
    if (
      signal.aborted ||
      !(directError instanceof Error) ||
      !isProxyFallbackFailure(directError)
    ) {
      return null
    }

    try {
      return await readFileDetails(proxiedMediaUrl(source.url), {
        displayUrl: source.url,
        signal,
        readPolicy,
      })
    } catch {
      return null
    }
  }
}
