import { ArrowRight02Icon, Delete02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useNavigate } from "@tanstack/react-router"
import { AlertDialog } from "radix-ui"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react"

import {
  ClipboardAccessIcon,
  ClipboardPermissionDialog,
} from "#/components/clipboard-permission-dialog"
import { Button } from "#/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "#/components/ui/input-group"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "#/components/ui/pagination"
import { formatFileSize, formatRelativeTime, hostFromUrl } from "#/lib/utils"
import {
  clearHistory,
  loadHistory,
  recordPlayedUrl,
  removeHistoryEntry,
  subscribeToHistory,
  type HistoryEntry,
} from "#/media/models/history"
import {
  playbackFailureMessage,
  type PlaybackFailure,
} from "#/media/models/media-errors"
import { parseDirectSource } from "#/media/models/source"

const EMPTY_HISTORY: HistoryEntry[] = []

const HISTORY_PAGE_SIZE = 7

export function AppPage() {
  const navigate = useNavigate()
  const [value, setValue] = useState("")
  const [failure, setFailure] = useState<PlaybackFailure | null>(null)

  const valueRef = useRef("")

  const [clipboardSuggestion, setClipboardSuggestion] = useState<string | null>(
    null
  )

  const [clipboardMessage, setClipboardMessage] = useState<string | null>(null)
  const [readingClipboard, setReadingClipboard] = useState(false)
  const [clipboardDialogOpen, setClipboardDialogOpen] = useState(false)

  const [clipboardPermission, setClipboardPermission] = useState<
    PermissionState | "unsupported"
  >("unsupported")

  const history = useSyncExternalStore(
    subscribeToHistory,
    loadHistory,
    () => EMPTY_HISTORY
  )

  const play = (rawUrl: string) => {
    const result = parseDirectSource(rawUrl)

    if ("failure" in result) {
      setFailure(result.failure)

      return
    }

    const itemId = recordPlayedUrl(result.source.url)
    void navigate({ to: "/watch", search: { itemId } })
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setClipboardSuggestion(null)
    play(value)
  }

  const readClipboard = useCallback(async (showError: boolean) => {
    setClipboardMessage(null)

    if (!navigator.clipboard?.readText) {
      if (showError) {
        setClipboardMessage(
          "Clipboard access isn't available here. Paste a media URL into the field instead."
        )
      }

      return false
    }

    if (showError) {
      setReadingClipboard(true)
    }

    try {
      const url = parseClipboardUrl(await navigator.clipboard.readText())
      const currentValue = valueRef.current.trim()

      setClipboardPermission("granted")
      setClipboardSuggestion(url === currentValue ? null : url)

      return true
    } catch {
      setClipboardSuggestion(null)

      if (showError) {
        setClipboardMessage(
          "Clipboard access was blocked. Paste a media URL into the field instead."
        )
      }

      return false
    } finally {
      if (showError) {
        setReadingClipboard(false)
      }
    }
  }, [])

  const checkClipboard = () => {
    setFailure(null)

    if (clipboardPermission === "granted") {
      void readClipboard(true)
    } else {
      setClipboardDialogOpen(true)
    }
  }

  useEffect(() => {
    if (!navigator.clipboard?.readText || !navigator.permissions) {
      return undefined
    }

    let isActive = true
    let permissionStatus: PermissionStatus | undefined

    const onPermissionChange = () => {
      if (permissionStatus) {
        setClipboardPermission(permissionStatus.state)
      }
    }

    void Promise.resolve()
      .then(() => {
        // SAFETY: Chromium supports clipboard-read, though PermissionName omits it.
        return navigator.permissions.query({
          name: "clipboard-read" as PermissionName,
        })
      })
      .then((status) => {
        if (!isActive) {
          return
        }

        permissionStatus = status
        onPermissionChange()
        status.addEventListener("change", onPermissionChange)
      })
      .catch(() => {
        if (isActive) {
          setClipboardPermission("unsupported")
        }
      })

    return () => {
      isActive = false

      if (permissionStatus) {
        permissionStatus.removeEventListener("change", onPermissionChange)
      }
    }
  }, [])

  useEffect(() => {
    if (clipboardPermission !== "granted") {
      return undefined
    }

    const refreshClipboard = () => void readClipboard(false)

    refreshClipboard()
    window.addEventListener("focus", refreshClipboard)

    return () => window.removeEventListener("focus", refreshClipboard)
  }, [clipboardPermission, readClipboard])

  const { invalid, message, describedBy } = getFormFeedback(
    failure,
    clipboardMessage
  )

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 pt-10 pb-12 sm:pt-14 sm:pb-16 md:px-8 lg:px-8">
      <form className="flex w-full flex-col gap-3" onSubmit={submit} noValidate>
        <label htmlFor="media-url" className="sr-only">
          Media URL
        </label>
        <div
          inert={!clipboardSuggestion}
          data-visible={Boolean(clipboardSuggestion)}
          className="myna-clipboard-suggestion"
        >
          <div className="min-h-0 overflow-hidden">
            <button
              type="button"
              aria-label="Play copied media link"
              tabIndex={clipboardSuggestion ? 0 : -1}
              onClick={() => {
                if (!clipboardSuggestion) {
                  return
                }

                setValue(clipboardSuggestion)
                valueRef.current = clipboardSuggestion
                setClipboardSuggestion(null)
                play(clipboardSuggestion)
              }}
              className="w-full rounded-md px-1 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="shimmer shimmer-color-blue-500/60 shimmer-duration-3000 block max-w-full truncate text-base font-normal text-primary">
                {clipboardSuggestion}
              </span>
            </button>
          </div>
        </div>
        <div className="myna-link-input">
          <InputGroup size="xl">
            <InputGroupInput
              id="media-url"
              type="url"
              name="media-url"
              value={value}
              size="xl"
              onChange={(event) => {
                setValue(event.target.value)
                valueRef.current = event.target.value
                setClipboardSuggestion(null)
                setClipboardMessage(null)

                if (failure !== null) {
                  setFailure(null)
                }
              }}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              placeholder="https://example.com/video.mkv"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              onFocus={() => {
                if (clipboardPermission === "granted") {
                  void readClipboard(false)
                }
              }}
            />
            <InputGroupAddon align="inline-end">
              <div className="myna-link-input-actions">
                {clipboardPermission !== "granted" ? (
                  <InputGroupButton
                    type="button"
                    size="icon-lg"
                    variant="ghost"
                    disabled={readingClipboard}
                    aria-label="Enable clipboard suggestions"
                    title="Enable clipboard suggestions"
                    onClick={checkClipboard}
                  >
                    <ClipboardAccessIcon
                      key={clipboardSuggestion ?? "idle"}
                      className="size-7"
                      shimmerVisible
                    />
                  </InputGroupButton>
                ) : null}
                <InputGroupButton
                  type="submit"
                  size="icon-lg"
                  variant="default"
                  aria-label="Play media URL"
                  disabled={value.trim().length === 0}
                >
                  <HugeiconsIcon
                    icon={ArrowRight02Icon}
                    strokeWidth={2}
                    className="size-7"
                  />
                </InputGroupButton>
              </div>
            </InputGroupAddon>
          </InputGroup>
        </div>
        {message ? (
          <p
            id="media-url-error"
            role="alert"
            className="text-destructive mt-2 px-5 text-base"
          >
            {message.description}
          </p>
        ) : null}
        {clipboardMessage ? (
          <p
            id="clipboard-error"
            role="alert"
            className="text-destructive px-5 text-base"
          >
            {clipboardMessage}
          </p>
        ) : null}
      </form>

      <ClipboardPermissionDialog
        open={clipboardDialogOpen}
        onOpenChange={setClipboardDialogOpen}
        onAllow={() => readClipboard(true)}
      />

      <PlayedList
        entries={history}
        onPlay={play}
        onRemove={removeHistoryEntry}
        onClear={clearHistory}
      />
    </main>
  )
}

function PlayedList({
  entries,
  onPlay,
  onRemove,
  onClear,
}: {
  entries: HistoryEntry[]
  onPlay: (url: string) => void
  onRemove: (url: string) => void
  onClear: () => void
}) {
  const [requestedPage, setRequestedPage] = useState(1)

  if (entries.length === 0) {
    return null
  }

  const pageCount = Math.max(1, Math.ceil(entries.length / HISTORY_PAGE_SIZE))
  const page = Math.min(requestedPage, pageCount)

  const visibleEntries = entries.slice(
    (page - 1) * HISTORY_PAGE_SIZE,
    page * HISTORY_PAGE_SIZE
  )

  return (
    <section className="mt-14" aria-labelledby="recent-title">
      <header className="mb-6 flex items-center justify-between gap-4">
        <h2 id="recent-title" className="text-2xl font-medium tracking-tight">
          Recent
        </h2>
        <ClearAllButton onClear={onClear} />
      </header>
      <ul className="border-t border-border/70">
        {visibleEntries.map((entry) => (
          <PlayedRow
            key={entry.id}
            entry={entry}
            onPlay={() => onPlay(entry.url)}
            onRemove={() => onRemove(entry.url)}
          />
        ))}
      </ul>
      {pageCount > 1 ? (
        <HistoryPagination
          page={page}
          pageCount={pageCount}
          onPageChange={setRequestedPage}
        />
      ) : null}
    </section>
  )
}

function PlayedRow({
  entry,
  onPlay,
  onRemove,
}: {
  entry: HistoryEntry
  onPlay: () => void
  onRemove: () => void
}) {
  const meta = [
    formatFileSize(entry.sizeBytes),
    hostFromUrl(entry.url),
    formatRelativeTime(entry.lastPlayedAt),
  ]
    .filter((part) => part.length > 0)
    .join(" · ")

  return (
    <li className="myna-history-row grid min-h-28 gap-3 border-b border-border/70 transition-colors duration-150 hover:bg-muted/30 sm:gap-4">
      <button
        type="button"
        onClick={onPlay}
        aria-label={`Play ${entry.filename}`}
        className="flex min-w-0 flex-col justify-center py-6 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-col gap-2">
          <span className="myna-history-filename text-foreground block truncate font-medium">
            <bdi>{entry.filename}</bdi>
          </span>
          <span className="text-muted-foreground block truncate text-lg tabular-nums sm:text-xl">
            {meta}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${entry.filename} from history`}
        className="text-muted-foreground hover:text-destructive flex w-full items-center justify-center outline-none transition-colors duration-150 hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <HugeiconsIcon icon={Delete02Icon} className="size-4.5 sm:size-5" />
      </button>
    </li>
  )
}

function parseClipboardUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())

    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function getFormFeedback(
  failure: PlaybackFailure | null,
  clipboardMessage: string | null
) {
  const invalid = failure?.kind === "invalid-media-url"
  const message = failure === null ? null : playbackFailureMessage(failure)

  const describedBy =
    [
      message ? "media-url-error" : null,
      clipboardMessage ? "clipboard-error" : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined

  return { invalid, message, describedBy }
}

function ClearAllButton({ onClear }: { onClear: () => void }) {
  const [open, setOpen] = useState(false)

  return (
    <span className="myna-history-clear">
      <AlertDialog.Root open={open} onOpenChange={setOpen}>
        <AlertDialog.Trigger asChild>
          <Button type="button" variant="destructive">
            Clear history
          </Button>
        </AlertDialog.Trigger>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
          <AlertDialog.Content className="dark myna-alert-dialog-content fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-4xl border bg-background text-foreground shadow-lg">
            <div className="flex flex-col px-8 py-8 text-center sm:px-10">
              <AlertDialog.Title className="w-full text-2xl leading-tight font-medium">
                Clear all playback history?
              </AlertDialog.Title>
              <div className="myna-history-dialog-actions mt-6 flex w-full flex-col gap-3">
                <AlertDialog.Action asChild>
                  <Button variant="destructive" size="lg" onClick={onClear}>
                    Clear history
                  </Button>
                </AlertDialog.Action>
                <AlertDialog.Cancel asChild>
                  <Button variant="outline" size="lg">
                    Cancel
                  </Button>
                </AlertDialog.Cancel>
              </div>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </span>
  )
}

function HistoryPagination({
  page,
  pageCount,
  onPageChange,
}: {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
}) {
  const firstPage = Math.max(1, Math.min(page - 1, pageCount - 2))

  const pages = Array.from(
    { length: Math.min(3, pageCount) },
    (_, index) => firstPage + index
  )

  return (
    <div className="myna-history-pagination mt-6">
      <Pagination aria-label="Recent pages">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#recently-played-title"
              aria-disabled={page === 1}
              tabIndex={page === 1 ? -1 : undefined}
              onClick={(event) => {
                event.preventDefault()

                if (page > 1) {
                  onPageChange(page - 1)
                }
              }}
            />
          </PaginationItem>
          {firstPage > 1 ? (
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
          ) : null}
          {pages.map((number) => (
            <PaginationItem key={number}>
              <PaginationLink
                href="#recently-played-title"
                aria-label={`Page ${number}`}
                isActive={page === number}
                onClick={(event) => {
                  event.preventDefault()
                  onPageChange(number)
                }}
              >
                {number}
              </PaginationLink>
            </PaginationItem>
          ))}
          {firstPage + pages.length - 1 < pageCount ? (
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
          ) : null}
          <PaginationItem>
            <PaginationNext
              href="#recently-played-title"
              aria-disabled={page === pageCount}
              tabIndex={page === pageCount ? -1 : undefined}
              onClick={(event) => {
                event.preventDefault()

                if (page < pageCount) {
                  onPageChange(page + 1)
                }
              }}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
