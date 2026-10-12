import type { PlaybackFailure } from "./media-errors"

interface DirectSource {
  kind: "direct"
  url: string
}

export type PlaybackSource = DirectSource

// Playlists ride the HLS pipeline (platform HLS first, hls.js over MSE
// second); the mediabunny engine cannot demux them. Signed URLs may hide the
// extension — those take the progressive path and surface through its errors.
export function isHlsUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".m3u8")
  } catch {
    return false
  }
}

export function isMatroskaUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".mkv")
  } catch {
    return false
  }
}

export type SourceParseResult =
  | { source: PlaybackSource }
  | { failure: Extract<PlaybackFailure, { kind: "invalid-media-url" }> }

export function parseDirectSource(raw: string): SourceParseResult {
  const trimmed = raw.trim()

  if (trimmed.length === 0) {
    return { failure: { kind: "invalid-media-url", reason: "empty" } }
  }

  let url: URL

  try {
    url = new URL(trimmed)
  } catch {
    return { failure: { kind: "invalid-media-url", reason: "malformed" } }
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      failure: { kind: "invalid-media-url", reason: "unsupported-scheme" },
    }
  }

  return { source: { kind: "direct", url: url.toString() } }
}
