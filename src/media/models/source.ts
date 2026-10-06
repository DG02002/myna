import type { PlaybackFailure } from "./media-errors"

interface DirectSource {
  kind: "direct"
  url: string
}

export type PlaybackSource = DirectSource

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

const SOURCE_SESSION_KEY = "playloom.source"

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
