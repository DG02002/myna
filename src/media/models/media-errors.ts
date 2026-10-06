type InvalidUrlReason = "empty" | "malformed" | "unsupported-scheme"

export type PlaybackFailure =
  | { kind: "invalid-media-url"; reason: InvalidUrlReason }
  | { kind: "playback-aborted" }
  | { kind: "network" }
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
    description: "Playloom plays http:// and https:// links to media files.",
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
      "Playloom couldn't fetch the file. Open the link in a new tab to check it still works, then try again.",
  },
  decode: {
    title: "This file can't be decoded",
    description:
      "The file arrived, but its contents couldn't be decoded. It may be corrupt or truncated.",
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

  return FAILURE_MESSAGES[failure.kind]
}

const MEDIA_ERR_ABORTED = 1

const MEDIA_ERR_NETWORK = 2

const MEDIA_ERR_DECODE = 3

const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

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
