import { useId, useState, type FormEvent } from "react"

import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { formatFileSize } from "#/lib/utils"
import type { SubtitleTrack } from "#/media/subtitles"

export function SubtitleControls({
  tracks,
  onAddSubtitle,
  onRetrySubtitle,
  embeddedProbeFailed,
  disabled = false,
}: {
  tracks: SubtitleTrack[]
  onAddSubtitle: (url: string) => void
  onRetrySubtitle: (id: string) => void
  embeddedProbeFailed: boolean
  disabled?: boolean
}) {
  const inputId = useId()
  const [url, setUrl] = useState("")

  if (disabled) {
    return null
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = url.trim()

    if (value.length === 0) {
      return
    }

    onAddSubtitle(value)
    setUrl("")
  }

  return (
    <section aria-label="Add subtitle" className="space-y-3">
      <div className="space-y-3">
        <form className="flex gap-2" onSubmit={submit}>
          <div className="min-w-0 flex-1">
            <label className="sr-only" htmlFor={inputId}>
              Subtitle file URL
            </label>
            <Input
              id={inputId}
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
              placeholder="https://example.com/subtitles.vtt"
            />
          </div>
          <Button type="submit">Add</Button>
        </form>

        <div className="space-y-2" aria-live="polite">
          {embeddedProbeFailed ? (
            <p className="text-destructive text-xs">
              Could not inspect embedded subtitles.
            </p>
          ) : null}
          {tracks
            .filter((track) => track.source.kind === "external")
            .map((track) => (
              <div key={track.id} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <SubtitleLoadStatus track={track} />
                </div>
                {track.status === "failed" ? (
                  <Button
                    aria-label={`Retry ${track.label}`}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => onRetrySubtitle(track.id)}
                  >
                    Retry
                  </Button>
                ) : null}
              </div>
            ))}
        </div>
      </div>
    </section>
  )
}

export function SubtitlePlaybackStatus({
  track,
  onRetry,
}: {
  track: SubtitleTrack | undefined
  onRetry?: (id: string) => void
}) {
  if (
    track?.source.kind !== "matroska" ||
    track.status === "ready" ||
    track.status === "available"
  ) {
    return null
  }

  const announcement = {
    loading: `Loading ${track.label}`,
    failed: `Could not load ${track.label}`,
    incomplete: `Loaded part of ${track.label}`,
  }[track.status]

  return (
    <div className="myna-subtitle-player-status relative isolate rounded-media-control bg-media-popover px-3.5 py-2.5 text-media-popover-foreground surface-media after:surface-media-inset">
      <span className="sr-only" role="status">
        {announcement}
      </span>
      {track.status === "loading" ? (
        <div className="flex min-w-0 items-center gap-2.5">
          <CircularSubtitleProgress track={track} />
          <p className="min-w-0 truncate text-sm font-medium">
            Loading {track.label}
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <SubtitleLoadStatus track={track} />
          </div>
          {onRetry !== undefined ? (
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => onRetry(track.id)}
            >
              Retry
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}

function CircularSubtitleProgress({ track }: { track: SubtitleTrack }) {
  const progress = track.loadProgress

  const percent = subtitleLoadPercent(progress)

  const circumference = 2 * Math.PI * 9

  return (
    <svg
      aria-label={`Loading ${track.label}`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent === null ? undefined : Math.round(percent)}
      className="myna-subtitle-progress"
      focusable="false"
      role="progressbar"
      viewBox="0 0 24 24"
    >
      <circle className="myna-subtitle-progress-track" cx="12" cy="12" r="9" />
      <circle
        className="myna-subtitle-progress-indicator"
        cx="12"
        cy="12"
        r="9"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - (percent ?? 0) / 100)}
        transform="rotate(-90 12 12)"
      />
    </svg>
  )
}

function subtitleLoadPercent(
  progress: SubtitleTrack["loadProgress"]
): number | null {
  if (
    progress?.kind === "bytes" &&
    progress.totalBytes !== null &&
    progress.totalBytes > 0
  ) {
    return Math.max(
      0,
      Math.min(100, (progress.loadedBytes / progress.totalBytes) * 100)
    )
  }

  if (progress?.kind === "steps" && progress.total > 0) {
    return Math.max(
      0,
      Math.min(100, (progress.completed / progress.total) * 100)
    )
  }

  return null
}

interface SubtitleLoadingLabel {
  text: string
  percent: number | null
}

// What to say about a track that is still loading, and how far along it is
// when that is knowable: external files carry a length, embedded streams do
// not.
function subtitleLoadingLabel(track: SubtitleTrack): SubtitleLoadingLabel {
  const progress = track.loadProgress

  if (progress?.kind === "bytes") {
    const loaded = formatFileSize(progress.loadedBytes)

    if (progress.totalBytes !== null && progress.totalBytes > 0) {
      return {
        text: `Downloading ${track.label} — ${loaded} of ${formatFileSize(progress.totalBytes)}`,
        percent: Math.min(
          100,
          (progress.loadedBytes / progress.totalBytes) * 100
        ),
      }
    }

    return {
      text: `Downloading ${track.label} — ${loaded} so far`,
      percent: null,
    }
  }

  if (progress?.kind === "cues") {
    return {
      text: `Preparing ${track.label} · ${progress.cuesLoaded} captions read`,
      percent: null,
    }
  }

  const verb = track.source.kind === "matroska" ? "Reading" : "Downloading"

  return { text: `${verb} ${track.label}…`, percent: null }
}

function SubtitleLoadStatus({ track }: { track: SubtitleTrack }) {
  if (track.status === "loading") {
    const { text, percent } = subtitleLoadingLabel(track)

    return (
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-sm">{text}</p>
        {percent !== null ? (
          <div
            className="bg-muted h-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            aria-label={`Loading ${track.label}`}
          >
            {/* Dynamic width flows through the custom property; the
                myna-progress-fill class in styles.css owns the transition. */}
            <div
              className="myna-progress-fill bg-foreground/70 h-full rounded-full"
              style={{ "--subtitle-progress": `${percent}%` }}
            />
          </div>
        ) : null}
      </div>
    )
  }

  if (track.status === "failed") {
    return (
      <p className="text-destructive text-sm">
        {subtitleFailureMessage(track)}
      </p>
    )
  }

  if (track.status === "incomplete") {
    return (
      <p className="text-muted-foreground text-sm">
        {subtitleFailureMessage(track)}
      </p>
    )
  }

  return null
}

function subtitleFailureMessage(track: SubtitleTrack): string {
  const { kind, status, retryAfterMs } = track.failure ?? {}

  if (kind === "http") {
    const retryDelay =
      retryAfterMs === undefined || retryAfterMs === null
        ? ""
        : ` Try again in about ${Math.ceil(retryAfterMs / 1000)} seconds.`

    return `Subtitle server returned HTTP ${status ?? "an error"}.${retryDelay}`
  }

  if (kind === "range") {
    return `${track.label} could not be read because the server returned an invalid byte range.`
  }

  if (kind === "decode") {
    return `Myna could not decode ${track.label}. Choose Retry to restart the subtitle decoder.`
  }

  if (kind === "limit") {
    return `Loading ${track.label} reached its resource limit. Try a shorter subtitle source.`
  }

  if (kind === "timeout") {
    return `Loading ${track.label} timed out.`
  }

  if (kind === "unsupported") {
    return `${track.label} uses an unsupported subtitle format.`
  }

  if (kind === "invalid") {
    return `${track.label} is invalid or incomplete.`
  }

  if (track.status === "incomplete") {
    return `Part of ${track.label} loaded. Later subtitles may be missing.`
  }

  return `Could not load ${track.label}. The media source may be unavailable.`
}
