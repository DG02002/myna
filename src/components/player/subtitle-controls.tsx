import { useId, useState, type FormEvent } from "react"

import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
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
    <section className="min-w-56 space-y-1.5">
      <form className="space-y-1.5" onSubmit={submit}>
        <label className="text-sm font-medium" htmlFor={inputId}>
          Add subtitles
        </label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            type="url"
            required
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
            placeholder="https://example.com/subtitles.vtt"
            aria-label="Subtitle file URL"
          />
          <Button type="submit">Add</Button>
        </div>
      </form>
      <div className="space-y-1" aria-live="polite">
        {embeddedProbeFailed ? (
          <p className="text-destructive text-xs">
            Could not inspect embedded subtitles.
          </p>
        ) : null}
        {tracks.map((track) => {
          if (track.status === "loading") {
            return (
              <p className="text-muted-foreground text-xs" key={track.id}>
                Loading {track.label}…
              </p>
            )
          }

          if (track.status === "failed") {
            return (
              <p className="text-destructive text-xs" key={track.id}>
                Could not load {track.label}.
              </p>
            )
          }

          if (track.status === "incomplete") {
            return (
              <p className="text-muted-foreground text-xs" key={track.id}>
                Loaded part of {track.label}; later subtitles may be missing.
              </p>
            )
          }

          return null
        })}
      </div>
    </section>
  )
}
