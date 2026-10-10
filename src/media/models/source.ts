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

const SOURCE_SESSION_KEY = "myna.source"

export function storeSourceForSession(source: PlaybackSource): void {
  window.sessionStorage.setItem(SOURCE_SESSION_KEY, source.url)
}

export type SessionSource = PlaybackSource | null | undefined

// undefined means "not read yet" (server render); null means "read, none".
// Parsed sources are cached by the raw stored string so repeated snapshot
// reads return a stable reference for useSyncExternalStore.
let cachedRaw: string | undefined

let cachedSource: PlaybackSource | null = null

export function loadSourceFromSession(): SessionSource {
  let raw: string | null = null

  try {
    raw = window.sessionStorage.getItem(SOURCE_SESSION_KEY)
  } catch {
    // Storage can be unavailable (privacy mode); treat it as no source
    // rather than failing the watch page.
    return null
  }

  if (raw === null) {
    return null
  }

  if (raw !== cachedRaw) {
    const result = parseDirectSource(raw)
    cachedRaw = raw
    cachedSource = "source" in result ? result.source : null
  }

  return cachedSource
}
