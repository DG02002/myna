import {
  ArrowLeft01Icon,
  Bug01Icon,
  CaptionsIcon,
  FullSignalIcon,
  InfoIcon,
  Share08Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  createFileRoute,
  Link,
  type SearchSchemaInput,
} from "@tanstack/react-router"
import { AlertDialog } from "radix-ui"
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { MediaInfo } from "#/components/player/media-info"
import { NetworkInfo } from "#/components/player/network-info"
import {
  PlaybackStage,
  type PlaybackEngineMode,
  type PlaybackPositionChange,
  type ProbeState,
} from "#/components/player/playback-stage"
import { SubtitleControls } from "#/components/player/subtitle-controls"
import { Button } from "#/components/ui/button"
import { Skeleton } from "#/components/ui/skeleton"
import { filenameFromUrl } from "#/lib/utils"
import {
  loadHistory,
  recordPlayedUrl,
  subscribeToHistory,
  updateHistoryEntry,
  updateHistoryPosition,
  type HistoryEntry,
} from "#/media/models/history"
import { parseDirectSource, type PlaybackSource } from "#/media/models/source"
import {
  probeFileDetails,
  type FileDetails,
} from "#/media/probe/metadata-probe"

type PlayerTool = "media" | "subtitle" | "network"

const TELEGRAM_BUG_REPORT_URL = "https://telegram.me/myna_support?direct"

const FILE_DETAILS_CACHE_LIMIT = 50

const fileDetailsCache = new Map<string, FileDetails>()

function cacheFileDetails(url: string, details: FileDetails): void {
  fileDetailsCache.delete(url)
  fileDetailsCache.set(url, details)

  if (fileDetailsCache.size > FILE_DETAILS_CACHE_LIMIT) {
    const oldestUrl = fileDetailsCache.keys().next().value

    if (oldestUrl !== undefined) {
      fileDetailsCache.delete(oldestUrl)
    }
  }
}

export const Route = createFileRoute("/watch")({
  head: () => ({
    meta: [
      { title: "Watch | Myna" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  validateSearch: validateWatchSearch,
  component: WatchPage,
})

type WatchSearchInput = SearchSchemaInput & {
  itemId?: string | number | boolean | null
}

function isTextSearchValue(value: WatchSearchInput["itemId"]): value is string {
  return typeof value === "string"
}

function validateWatchSearch(search: WatchSearchInput) {
  return {
    itemId: isTextSearchValue(search.itemId) ? search.itemId : undefined,
  }
}

function subscribeToSharedUrl(listener: () => void): () => void {
  window.addEventListener("hashchange", listener)

  return () => window.removeEventListener("hashchange", listener)
}

function readSharedUrl(): string | undefined {
  return (
    new URLSearchParams(window.location.hash.slice(1)).get("url") ?? undefined
  )
}

interface ResolvedWatchSource {
  url: string | null | undefined
  invalidShareLink: boolean
}

// A shared fragment wins over local history; otherwise the history entry's
// URL is the source. undefined means "not resolved yet" (server snapshot),
// null means "no source for this link".
function resolveWatchSourceUrl(
  sharedUrl: string | undefined,
  historyEntry: HistoryEntry | null | undefined
): ResolvedWatchSource {
  if (sharedUrl !== undefined) {
    const result = parseDirectSource(sharedUrl)

    if ("source" in result) {
      return { url: result.source.url, invalidShareLink: false }
    }

    return { url: null, invalidShareLink: true }
  }

  if (historyEntry === undefined) {
    return { url: undefined, invalidShareLink: false }
  }

  return { url: historyEntry?.url ?? null, invalidShareLink: false }
}

function useResolvedWatchSource(itemId: string | undefined) {
  const sharedUrl = useSyncExternalStore(
    subscribeToSharedUrl,
    readSharedUrl,
    () => undefined
  )

  const historyEntries = useSyncExternalStore(
    subscribeToHistory,
    loadHistory,
    () => undefined
  )

  const historyEntryById =
    historyEntries === undefined
      ? undefined
      : (historyEntries.find((entry) => entry.id === itemId) ?? null)

  const resolved = resolveWatchSourceUrl(sharedUrl, historyEntryById)

  const historyEntry = findResolvedHistoryEntry(
    historyEntries,
    historyEntryById,
    resolved.url
  )

  const source = useMemo<PlaybackSource | null | undefined>(() => {
    if (resolved.url === undefined) {
      return undefined
    }

    if (resolved.url === null) {
      return null
    }

    return { kind: "direct", url: resolved.url }
  }, [resolved.url])

  return { source, historyEntry, invalidShareLink: resolved.invalidShareLink }
}

function findResolvedHistoryEntry(
  entries: HistoryEntry[] | undefined,
  entryById: HistoryEntry | null | undefined,
  sourceUrl: string | null | undefined
): HistoryEntry | null | undefined {
  if (entries === undefined) {
    return undefined
  }

  if (sourceUrl === null || sourceUrl === undefined) {
    return entryById
  }

  return entries.find((entry) => entry.url === sourceUrl) ?? null
}

function useSourceScopedPlayerTool(sourceUrl: string | null) {
  const [state, setState] = useState<{
    sourceUrl: string | null
    tool: PlayerTool | null
  }>({ sourceUrl, tool: null })

  const activeTool = state.sourceUrl === sourceUrl ? state.tool : null

  const setActiveTool = useCallback(
    (tool: PlayerTool | null) => setState({ sourceUrl, tool }),
    [sourceUrl]
  )

  return { activeTool, setActiveTool }
}

function usePlaybackPositionWriter(sourceUrl: string | null) {
  const lastPositionWrite = useRef({ url: "", at: 0 })

  return useCallback(
    (change: PlaybackPositionChange) => {
      if (
        sourceUrl === null ||
        !Number.isFinite(change.currentTime) ||
        change.currentTime < 0
      ) {
        return
      }

      const now = performance.now()

      const shouldWrite =
        change.reason !== "progress" ||
        lastPositionWrite.current.url !== sourceUrl ||
        now - lastPositionWrite.current.at >= 5_000

      if (!shouldWrite) {
        return
      }

      updateHistoryPosition(
        sourceUrl,
        change.reason === "ended" ? 0 : change.currentTime
      )
      lastPositionWrite.current = { url: sourceUrl, at: now }
    },
    [sourceUrl]
  )
}

function useSourceFileDetails(
  sourceUrl: string | null,
  historyEntry: HistoryEntry | null | undefined
) {
  const [fileDetailsFor, setFileDetailsFor] = useState<{
    url: string
    details: FileDetails
  } | null>(null)

  const [fileDetailsSettledFor, setFileDetailsSettledFor] = useState<
    string | null
  >(null)

  useEffect(() => {
    if (sourceUrl === null) {
      return undefined
    }

    // Record the visit before probing so a quick departure still keeps history.
    recordPlayedUrl(sourceUrl)

    if (fileDetailsCache.has(sourceUrl)) {
      return undefined
    }

    const controller = new AbortController()

    void (async () => {
      try {
        const details = await probeFileDetails(
          { kind: "direct", url: sourceUrl },
          controller.signal
        )

        if (controller.signal.aborted) {
          return
        }

        if (details !== null) {
          cacheFileDetails(sourceUrl, details)
          startTransition(() => {
            setFileDetailsFor({ url: sourceUrl, details })
          })
          updateHistoryEntry(sourceUrl, details)
        }
      } catch {
        // The URL-derived name is the safe fallback when headers cannot be read.
      } finally {
        if (!controller.signal.aborted) {
          setFileDetailsSettledFor(sourceUrl)
        }
      }
    })()

    return () => controller.abort()
  }, [sourceUrl])

  let fileDetails: FileDetails | null = null

  if (fileDetailsFor !== null && fileDetailsFor.url === sourceUrl) {
    fileDetails = fileDetailsFor.details
  } else if (sourceUrl !== null) {
    fileDetails = fileDetailsCache.get(sourceUrl) ?? null
  }

  const cachedFilename =
    fileDetails?.filename ??
    (historyEntry?.filenameConfirmed ? historyEntry.filename : null)

  const filenamePending =
    sourceUrl !== null &&
    cachedFilename === null &&
    fileDetailsSettledFor !== sourceUrl

  const settledFilename =
    fileDetailsSettledFor === sourceUrl ? historyEntry?.filename : null

  const filename =
    cachedFilename ??
    settledFilename ??
    (sourceUrl === null ? "" : filenameFromUrl(sourceUrl))

  return { filename, filenamePending, fileDetails }
}

function WatchPage() {
  const { itemId } = Route.useSearch()

  const { source, historyEntry, invalidShareLink } =
    useResolvedWatchSource(itemId)

  const sourceUrl = source === null || source === undefined ? null : source.url

  const { filename, filenamePending, fileDetails } = useSourceFileDetails(
    sourceUrl,
    historyEntry
  )

  const [probeState, setProbeState] = useState<ProbeState>({
    status: "loading",
  })

  const [engineMode, setEngineMode] = useState<PlaybackEngineMode>("native")
  const [bugReportOpen, setBugReportOpen] = useState(false)
  const [playbackAttempt, setPlaybackAttempt] = useState(0)

  const retryPlayback = useCallback(() => {
    setProbeState({ status: "loading" })
    setEngineMode("native")
    setPlaybackAttempt((attempt) => attempt + 1)
  }, [])

  const onProbe = useCallback((state: ProbeState) => {
    startTransition(() => {
      setProbeState(state)
    })
  }, [])

  const onModeChange = useCallback((mode: PlaybackEngineMode) => {
    startTransition(() => {
      setEngineMode(mode)
    })
  }, [])

  const { activeTool, setActiveTool } = useSourceScopedPlayerTool(sourceUrl)
  const onPositionChange = usePlaybackPositionWriter(sourceUrl)

  if (source === undefined || (source !== null && historyEntry === undefined)) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-6 md:px-8 lg:px-8">
        <div aria-hidden className="aspect-video w-full" />
      </main>
    )
  }

  if (source === null) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 md:px-8 lg:px-8 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          {invalidShareLink
            ? "This shared media link is invalid"
            : "No saved media for this link"}
        </h1>
        <p className="text-muted-foreground max-w-lg text-balance">
          {invalidShareLink
            ? "This link does not contain a valid HTTP or HTTPS media URL. Open the app to enter a different link."
            : "Watch links point to history in this browser. The item may have been removed, or this link may have opened on another device. Open the app and paste the media URL to play it here."}
        </p>
        <Button asChild>
          <Link to="/add">Open the app</Link>
        </Button>
      </main>
    )
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col px-6 py-6 md:px-8 lg:px-8">
      <header className="myna-watch-header mb-5 grid items-center gap-3 sm:gap-4">
        <Link
          to="/app"
          aria-label="Back to app"
          title="Back to app"
          className="flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <HugeiconsIcon
            icon={ArrowLeft01Icon}
            strokeWidth={1.8}
            className="size-6"
          />
        </Link>
        <div className="min-w-0 space-y-1">
          {filenamePending ? (
            <div
              className="flex min-h-16 items-center"
              aria-busy="true"
              aria-label="Loading filename"
            >
              <span className="sr-only">Loading filename</span>
              <div className="myna-filename-skeleton h-7 w-3/4 sm:h-8">
                <Skeleton aria-hidden="true" />
              </div>
            </div>
          ) : (
            <h1
              className="line-clamp-2 min-h-16 content-center break-all text-xl leading-normal font-medium tracking-tight sm:text-2xl"
              title={filename}
            >
              <bdi>{filename}</bdi>
            </h1>
          )}
        </div>
      </header>

      <PlaybackStage
        key={`${source.url}:${playbackAttempt}`}
        source={source}
        startTimeSeconds={historyEntry?.positionSeconds ?? 0}
        onRetryPlayback={retryPlayback}
        onProbe={onProbe}
        onModeChange={onModeChange}
        onPositionChange={onPositionChange}
        renderDetails={({
          mediaElement,
          engine,
          probeResult,
          probeFailure,
          requestedResumeSeconds,
          confirmedResumeSeconds,
          subtitleTracks,
          addSubtitle,
          retrySubtitle,
          canAddSubtitles,
          embeddedProbeFailed,
        }) => (
          <div className="mt-4">
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label="Player tools"
            >
              <PlayerToolButton
                id="watch-tool-media"
                label="Media info"
                icon={InfoIcon}
                active={activeTool === "media"}
                onClick={() =>
                  setActiveTool(activeTool === "media" ? null : "media")
                }
              />
              <PlayerToolButton
                id="watch-tool-subtitle"
                label="Add subtitle"
                icon={CaptionsIcon}
                active={activeTool === "subtitle"}
                disabled={!canAddSubtitles}
                onClick={() =>
                  setActiveTool(activeTool === "subtitle" ? null : "subtitle")
                }
              />
              <PlayerToolButton
                id="watch-tool-network"
                label="Network status"
                icon={FullSignalIcon}
                active={activeTool === "network"}
                onClick={() =>
                  setActiveTool(activeTool === "network" ? null : "network")
                }
              />
              <PlayerToolButton
                id="watch-tool-bug"
                label="Bug report"
                icon={Bug01Icon}
                active={bugReportOpen}
                dialog
                onClick={() => {
                  setActiveTool(null)
                  setBugReportOpen(true)
                }}
              />
              <ShareLinkButton
                key={source.url}
                mediaUrl={source.url}
                title={filename}
              />
            </div>

            <div
              id="watch-tools-panel"
              hidden={activeTool === null}
              role="region"
              aria-labelledby={
                activeTool === null ? undefined : `watch-tool-${activeTool}`
              }
              className="pt-4"
            >
              {activeTool === "media" ? (
                <MediaInfo
                  sourceUrl={source.url}
                  probeState={probeState}
                  engineMode={engineMode}
                  sizeBytes={
                    fileDetails?.sizeBytes ?? historyEntry?.sizeBytes ?? null
                  }
                />
              ) : null}
              {activeTool === "subtitle" ? (
                <SubtitleControls
                  tracks={subtitleTracks}
                  onAddSubtitle={addSubtitle}
                  onRetrySubtitle={retrySubtitle}
                  embeddedProbeFailed={embeddedProbeFailed}
                  disabled={!canAddSubtitles}
                />
              ) : null}
              <div hidden={activeTool !== "network"}>
                <NetworkInfo
                  sourceUrl={source.url}
                  engineMode={engineMode}
                  mediaElement={mediaElement}
                  engine={engine}
                  probeResult={probeResult}
                  probeFailure={probeFailure}
                  requestedResumeSeconds={requestedResumeSeconds}
                  confirmedResumeSeconds={confirmedResumeSeconds}
                  subtitleTracks={subtitleTracks}
                />
              </div>
            </div>

            <BugReportDialog
              open={bugReportOpen}
              onOpenChange={setBugReportOpen}
            />
          </div>
        )}
      />
    </main>
  )
}

function ShareLinkButton({
  mediaUrl,
  title,
}: {
  mediaUrl: string
  title: string
}) {
  const [message, setMessage] = useState("")
  const messageTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (messageTimer.current !== null) {
        window.clearTimeout(messageTimer.current)
      }
    }
  }, [])

  // The status line is fleeting feedback; leaving it up forever would read
  // as a stale state.
  const announce = (text: string) => {
    startTransition(() => {
      setMessage(text)
    })

    if (messageTimer.current !== null) {
      window.clearTimeout(messageTimer.current)
    }

    messageTimer.current = window.setTimeout(() => {
      startTransition(() => {
        setMessage("")
      })
    }, 4000)
  }

  const share = async () => {
    const link = new URL("/watch", window.location.origin)
    link.hash = new URLSearchParams({ url: mediaUrl }).toString()

    try {
      if (navigator.share) {
        await navigator.share({ title, url: link.toString() })

        return
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return
      }
    }

    try {
      await navigator.clipboard.writeText(link.toString())
      announce("Share link copied.")
    } catch {
      announce("Could not copy the share link.")
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-start gap-1">
      <Button
        type="button"
        size="lg"
        variant="outline"
        onClick={() => void share()}
      >
        <HugeiconsIcon
          icon={Share08Icon}
          strokeWidth={1.8}
          className="size-4"
        />
        Share
      </Button>
      {message ? (
        <span className="text-muted-foreground text-xs" aria-live="polite">
          {message}
        </span>
      ) : null}
    </div>
  )
}

function PlayerToolButton({
  id,
  label,
  icon,
  active,
  dialog = false,
  disabled = false,
  onClick,
}: {
  id: string
  label: string
  icon: typeof InfoIcon
  active: boolean
  dialog?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Button
      id={id}
      type="button"
      size="lg"
      variant={active ? "secondary" : "outline"}
      aria-expanded={dialog ? undefined : active}
      aria-controls={dialog ? undefined : "watch-tools-panel"}
      aria-haspopup={dialog ? "dialog" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-4" />
      <span>{label}</span>
    </Button>
  )
}

function BugReportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      {/* Keep this app-level dialog above player controls. */}
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <AlertDialog.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            document.getElementById("watch-tool-bug")?.focus()
          }}
          className="dark myna-alert-dialog-content fixed top-1/2 left-1/2 z-50 max-w-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-4xl border bg-background text-foreground shadow-lg"
        >
          <div className="relative flex justify-center overflow-hidden rounded-t-4xl px-6 py-8 text-primary">
            <HugeiconsIcon
              icon={Bug01Icon}
              strokeWidth={1.5}
              className="size-12"
              aria-hidden="true"
            />
          </div>

          <div className="flex flex-col items-center px-10 pt-0 pb-10 text-center">
            <AlertDialog.Title className="w-full text-2xl leading-tight font-bold sm:text-3xl">
              Report a bug
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-4 w-full text-pretty text-base text-muted-foreground">
              Choose how you’d like to report an issue with Myna.
            </AlertDialog.Description>

            <div className="myna-clipboard-dialog-actions mt-8 flex w-full flex-col gap-3">
              <AlertDialog.Action asChild>
                <Button asChild size="lg">
                  <a
                    href="https://github.com/DG02002/myna/issues/new"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <GitHubIcon />
                    <span>Open a GitHub issue</span>
                  </a>
                </Button>
              </AlertDialog.Action>
              <AlertDialog.Action asChild>
                <Button asChild variant="outline" size="lg">
                  <a
                    href={TELEGRAM_BUG_REPORT_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <TelegramIcon />
                    <span>Message us on Telegram</span>
                  </a>
                </Button>
              </AlertDialog.Action>
              <AlertDialog.Cancel asChild>
                <Button variant="ghost" size="lg">
                  Not now
                </Button>
              </AlertDialog.Cancel>
            </div>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

function GitHubIcon() {
  return (
    <svg
      viewBox="0 0 1024 1024"
      fill="none"
      aria-hidden="true"
      className="size-5"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M512 0C229.12 0 0 229.12 0 512c0 226.56 146.56 417.92 350.08 485.76 25.6 4.48 35.2-10.88 35.2-24.32 0-12.16-.64-52.48-.64-95.36-128.64 23.68-161.92-31.36-172.16-60.16-5.76-14.72-30.72-60.16-52.48-72.32-17.92-9.6-43.52-33.28-.64-33.92 40.32-.64 69.12 37.12 78.72 52.48 46.08 77.44 119.68 55.68 149.12 42.24 4.48-33.28 17.92-55.68 32.64-68.48-113.92-12.8-232.96-56.96-232.96-252.8 0-55.68 19.84-101.76 52.48-137.6-5.12-12.8-23.04-65.28 5.12-135.68 0 0 42.88-13.44 140.8 52.48 40.96-11.52 84.48-17.28 128-17.28s87.04 5.76 128 17.28c97.92-66.56 140.8-52.48 140.8-52.48 28.16 70.4 10.24 122.88 5.12 135.68 32.64 35.84 52.48 81.28 52.48 137.6 0 196.48-119.68 240-233.6 252.8 18.56 16 34.56 46.72 34.56 94.72 0 68.48-.64 123.52-.64 140.8 0 13.44 9.6 29.44 35.2 24.32C877.44 929.92 1024 737.92 1024 512 1024 229.12 794.88 0 512 0"
        clipRule="evenodd"
      />
    </svg>
  )
}

function TelegramIcon() {
  return (
    <svg
      viewBox="0 0 256 256"
      preserveAspectRatio="xMidYMid"
      aria-hidden="true"
      className="size-5"
    >
      <defs>
        <linearGradient
          id="myna-telegram-gradient"
          x1="50%"
          x2="50%"
          y1="0%"
          y2="100%"
        >
          <stop offset="0%" stopColor="var(--color-sky-400)" />
          <stop offset="100%" stopColor="var(--color-sky-500)" />
        </linearGradient>
      </defs>
      <path
        fill="url(#myna-telegram-gradient)"
        d="M128 0C94.06 0 61.48 13.494 37.5 37.49A128.038 128.038 0 0 0 0 128c0 33.934 13.5 66.514 37.5 90.51C61.48 242.506 94.06 256 128 256s66.52-13.494 90.5-37.49c24-23.996 37.5-56.576 37.5-90.51 0-33.934-13.5-66.514-37.5-90.51C194.52 13.494 161.94 0 128 0Z"
      />
      <path
        fill="var(--color-white)"
        d="M57.94 126.648c37.32-16.256 62.2-26.974 74.64-32.152 35.56-14.786 42.94-17.354 47.76-17.441 1.06-.017 3.42.245 4.96 1.49 1.28 1.05 1.64 2.47 1.82 3.467.16.996.38 3.266.2 5.038-1.92 20.24-10.26 69.356-14.5 92.026-1.78 9.592-5.32 12.808-8.74 13.122-7.44.684-13.08-4.912-20.28-9.63-11.26-7.386-17.62-11.982-28.56-19.188-12.64-8.328-4.44-12.906 2.76-20.386 1.88-1.958 34.64-31.748 35.26-34.45.08-.338.16-1.598-.6-2.262-.74-.666-1.84-.438-2.64-.258-1.14.256-19.12 12.152-54 35.686-5.1 3.508-9.72 5.218-13.88 5.128-4.56-.098-13.36-2.584-19.9-4.708-8-2.606-14.38-3.984-13.82-8.41.28-2.304 3.46-4.662 9.52-7.072Z"
      />
    </svg>
  )
}
