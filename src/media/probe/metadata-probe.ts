// Background metadata probe. Opens a second mediabunny Input over the
// source URL (direct first, proxy on CORS failure) to surface container,
// duration, tracks, and decodability. Runs alongside native playback and
// must never disturb it; failures propagate to the caller to display.
import type { InputAudioTrack, InputTrack, InputVideoTrack } from "mediabunny"

import type { PlaybackSource } from "../models/source"
import { proxiedMediaUrl } from "../proxy/proxied-url"

type ProbeReadMode = "direct" | "proxy"

interface ProbeTrackInfo {
  number: number
  kind: "video" | "audio"
  codecParameterString: string | null
  languageCode: string
  name: string | null
  decodable: boolean
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

  const [codecParameterString, languageCode, name, decodable] =
    await Promise.all([
      track.getCodecParameterString(),
      track.getLanguageCode(),
      track.getName(),
      track.canDecode(),
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
