import { useId, useState, type FormEvent } from "react"

import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { formatFileSize } from "#/lib/utils"
import type { SubtitleTrack } from "#/media/subtitles"

export function SubtitleControls({
  tracks,
  onAddSubtitle,
  embeddedProbeFailed,
  disabled = false,
}: {
  tracks: SubtitleTrack[]
  onAddSubtitle: (url: string) => void
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
              <SubtitleLoadStatus key={track.id} track={track} />
            ))}
        </div>
      </div>
    </section>
  )
}

export function SubtitlePlaybackStatus({
  track,
}: {
  track: SubtitleTrack | undefined
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
        <SubtitleLoadStatus track={track} />
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
      <p className="text-destructive text-sm">Could not load {track.label}.</p>
    )
  }

  if (track.status === "incomplete") {
    return (
      <p className="text-muted-foreground text-sm">
        Loaded part of {track.label}; later subtitles may be missing.
      </p>
    )
  }

  return null
}
