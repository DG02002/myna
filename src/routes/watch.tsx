import { createFileRoute, Link } from "@tanstack/react-router"
import { useCallback, useState, useSyncExternalStore } from "react"

import { MediaInfo } from "#/components/player/media-info"
import {
  PlaybackStage,
  type PlaybackEngineMode,
  type ProbeState,
} from "#/components/player/playback-stage"
import { SubtitleControls } from "#/components/player/subtitle-controls"
import { Button } from "#/components/ui/button"
import { loadSourceFromSession } from "#/media/models/source"

export const Route = createFileRoute("/watch")({ component: WatchPage })

const subscribeToNothing = () => () => {}

function WatchPage() {
  // sessionStorage is a client-only store; the server snapshot stays
  // undefined so the first client render replaces the skeleton without a
  // hydration mismatch.
  const source = useSyncExternalStore(
    subscribeToNothing,
    loadSourceFromSession,
    () => undefined
  )

  const [probeState, setProbeState] = useState<ProbeState>({
    status: "loading",
  })

  const [engineMode, setEngineMode] = useState<PlaybackEngineMode>("native")

  const onProbe = useCallback((state: ProbeState) => setProbeState(state), [])

  const onModeChange = useCallback(
    (mode: PlaybackEngineMode) => setEngineMode(mode),
    []
  )

  if (source === undefined) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-6">
        <div className="bg-muted aspect-video w-full rounded-2xl" />
      </main>
    )
  }

  if (source === null) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-3 px-4 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          No media chosen
        </h1>
        <p className="text-muted-foreground text-balance">
          Paste a direct media link on the home page to start playing it here.
        </p>
        <Button asChild>
          <Link to="/">Choose a link</Link>
        </Button>
      </main>
    )
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-6">
      <PlaybackStage
        key={source.url}
        source={source}
        onProbe={onProbe}
        onModeChange={onModeChange}
        renderDetails={({
          subtitleTracks,
          addSubtitle,
          canAddSubtitles,
          embeddedProbeFailed,
        }) => (
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <p className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
              <bdi>{safeHost(source.url)}</bdi>
              <Link
                to="/"
                className="text-foreground underline underline-offset-4 hover:opacity-80"
              >
                {" "}
                Choose another link
              </Link>
            </p>
            <SubtitleControls
              tracks={subtitleTracks}
              onAddSubtitle={addSubtitle}
              embeddedProbeFailed={embeddedProbeFailed}
              disabled={!canAddSubtitles}
            />
            <MediaInfo
              key={source.url}
              sourceUrl={source.url}
              probeState={probeState}
              engineMode={engineMode}
            />
          </div>
        )}
      />
    </main>
  )
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
