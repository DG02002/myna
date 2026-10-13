type InvalidUrlReason = "empty" | "malformed" | "unsupported-scheme"

export type PlaybackFailure =
  | { kind: "invalid-media-url"; reason: InvalidUrlReason }
  | { kind: "playback-aborted" }
  | { kind: "network" }
  | { kind: "upstream-http"; status?: number }
  | { kind: "invalid-range" }
  | { kind: "byte-access-unavailable" }
  | { kind: "read-timeout" }
  | { kind: "read-truncated" }
  | { kind: "decoder" }
  | { kind: "decode" }
  | { kind: "unsupported-container" }
  | { kind: "native-playback"; code: number }

export interface PlaybackFailureMessage {
  title: string
  description: string
}

const INVALID_URL_MESSAGES: Record<InvalidUrlReason, PlaybackFailureMessage> = {
  empty: {
    title: "Enter a media link",
    description: "Paste the direct link to a video or audio file.",
  },
  malformed: {
    title: "That doesn't look like a link",
    description: "Paste a full media URL, starting with https:// or http://.",
  },
  "unsupported-scheme": {
    title: "Only web links can play",
    description: "Myna plays http:// and https:// links to media files.",
  },
}

function invalidUrlMessage(reason: InvalidUrlReason): PlaybackFailureMessage {
  return INVALID_URL_MESSAGES[reason]
}

const FAILURE_MESSAGES: Record<
  Exclude<PlaybackFailure["kind"], "invalid-media-url">,
  PlaybackFailureMessage
> = {
  "playback-aborted": {
    title: "Playback stopped",
    description:
      "The file stopped loading before it finished. The link may have expired, or the server dropped the connection.",
  },
  network: {
    title: "Couldn't reach the server",
    description:
      "Myna couldn't fetch the file. Open the link in a new tab to check it still works, then try again.",
  },
  "upstream-http": {
    title: "The media server is unavailable",
    description: "The server returned HTTP {status}. Try the link again later.",
  },
  "invalid-range": {
    title: "The media server returned an invalid response",
    description:
      "Advanced playback could not read the requested byte range. Try opening the link directly or use another source.",
  },
  "byte-access-unavailable": {
    title: "Advanced playback can't read this link",
    description:
      "The browser blocked access to the media bytes. The link may still play in the browser's built-in player.",
  },
  "read-timeout": {
    title: "The media server stopped responding",
    description:
      "The server stopped sending media data. Check the link and try again.",
  },
  "read-truncated": {
    title: "The media response ended early",
    description:
      "The server stopped before the requested media data arrived. Try again or use another source.",
  },
  decoder: {
    title: "The selected decoder failed",
    description:
      "Myna could not decode this track. Try another audio track or playback engine.",
  },
  decode: {
    title: "This track couldn't be decoded",
    description:
      "The selected codec may be unsupported, or the media data may be corrupt or truncated.",
  },
  "unsupported-container": {
    title: "This format isn't supported",
    description:
      "The browser's built-in player can't open this container or codec combination. Try a different file.",
  },
  "native-playback": {
    title: "Playback failed",
    description:
      "The player reported an unexpected error. Try reloading the page or a different link.",
  },
}

export function playbackFailureMessage(
  failure: PlaybackFailure
): PlaybackFailureMessage {
  if (failure.kind === "invalid-media-url") {
    return invalidUrlMessage(failure.reason)
  }

  const message = FAILURE_MESSAGES[failure.kind]

  return failure.kind === "upstream-http"
    ? {
        ...message,
        description: message.description.replace(
          "{status}",
          String(failure.status ?? "an error")
        ),
      }
    : message
}

export function isRetryablePlaybackFailure(failure: PlaybackFailure): boolean {
  return [
    "network",
    "upstream-http",
    "invalid-range",
    "byte-access-unavailable",
    "read-timeout",
    "read-truncated",
  ].includes(failure.kind)
}

export function isPlaybackFailure(value: unknown): value is PlaybackFailure {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false
  }

  if (value.kind === "invalid-media-url") {
    return (
      "reason" in value &&
      (value.reason === "empty" ||
        value.reason === "malformed" ||
        value.reason === "unsupported-scheme")
    )
  }

  if (value.kind === "upstream-http") {
    return !("status" in value) || typeof value.status === "number"
  }

  return [
    "playback-aborted",
    "network",
    "invalid-range",
    "byte-access-unavailable",
    "read-timeout",
    "read-truncated",
    "decoder",
    "decode",
    "unsupported-container",
    "native-playback",
  ].includes(String(value.kind))
}

const MEDIA_ERR_ABORTED = 1

const MEDIA_ERR_NETWORK = 2

const MEDIA_ERR_DECODE = 3

export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

export function nativeMediaErrorCodeToFailure(code: number): PlaybackFailure {
  switch (code) {
    case MEDIA_ERR_ABORTED:
      return { kind: "playback-aborted" }
    case MEDIA_ERR_NETWORK:
      return { kind: "network" }
    case MEDIA_ERR_DECODE:
      return { kind: "decode" }
    case MEDIA_ERR_SRC_NOT_SUPPORTED:
      return { kind: "unsupported-container" }
    default:
      return { kind: "native-playback", code }
  }
}
