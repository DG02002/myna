// Local, client-only history of played links. Entries never leave the
// browser: media URLs can carry credentials (`?token=`, `?mac=`), so they are
// persisted only in this device's localStorage and never logged, sent to a
// server, or copied into shareable app URLs.
import { filenameFromUrl } from "#/lib/utils"

export interface HistoryEntry {
  id: string
  url: string
  filename: string
  filenameConfirmed: boolean
  sizeBytes: number | null
  positionSeconds: number
  addedAt: number
  lastPlayedAt: number
}

const HISTORY_STORAGE_KEY = "myna.history.v1"

const HISTORY_LIMIT = 50

const HISTORY_CHANGED_EVENT = "myna:history-changed"

// Cached snapshot so useSyncExternalStore receives a stable reference
// between mutations.
let cachedEntries: HistoryEntry[] | null = null

type StoredHistoryEntry = Omit<
  HistoryEntry,
  "id" | "positionSeconds" | "filenameConfirmed"
> & {
  id?: string
  positionSeconds?: number
  filenameConfirmed?: boolean
}

function isStoredHistoryEntry(value: unknown): value is StoredHistoryEntry {
  if (typeof value !== "object" || value === null) {
    return false
  }

  // SAFETY: value is a non-null object, decoded field-by-field below before
  // the predicate returns true.
  const entry = value as Partial<HistoryEntry>

  return (
    (entry.id === undefined || typeof entry.id === "string") &&
    typeof entry.url === "string" &&
    entry.url.length > 0 &&
    typeof entry.filename === "string" &&
    (entry.filenameConfirmed === undefined ||
      typeof entry.filenameConfirmed === "boolean") &&
    (entry.sizeBytes === null || typeof entry.sizeBytes === "number") &&
    (entry.positionSeconds === undefined ||
      (typeof entry.positionSeconds === "number" &&
        Number.isFinite(entry.positionSeconds) &&
        entry.positionSeconds >= 0)) &&
    typeof entry.addedAt === "number" &&
    typeof entry.lastPlayedAt === "number"
  )
}

function normalizeHistoryEntry(
  entry: StoredHistoryEntry,
  id: string
): HistoryEntry {
  const {
    url,
    filename,
    filenameConfirmed,
    sizeBytes,
    positionSeconds,
    addedAt,
    lastPlayedAt,
  } = entry

  return {
    id,
    url,
    filename,
    filenameConfirmed: filenameConfirmed ?? false,
    sizeBytes,
    positionSeconds: positionSeconds ?? 0,
    addedAt,
    lastPlayedAt,
  }
}

export function loadHistory(): HistoryEntry[] {
  if (cachedEntries !== null) {
    return cachedEntries
  }

  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY)
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)

    if (Array.isArray(parsed) && parsed.every(isStoredHistoryEntry)) {
      const seenIds = new Set<string>()
      let didMigrate = false

      cachedEntries = parsed.map((entry) => {
        const storedId = entry.id
        let id = storedId

        if (id === undefined || id.length === 0 || seenIds.has(id)) {
          id = crypto.randomUUID()
          didMigrate = true
        }

        seenIds.add(id)

        return normalizeHistoryEntry(entry, id)
      })

      if (didMigrate) {
        try {
          window.localStorage.setItem(
            HISTORY_STORAGE_KEY,
            JSON.stringify(cachedEntries)
          )
        } catch {
          // The in-memory IDs still support links for this session.
        }
      }
    } else {
      cachedEntries = []
    }
  } catch {
    // Corrupted JSON or unavailable storage (privacy mode): an empty
    // history is a fine degraded state, not an error worth surfacing.
    cachedEntries = []
  }

  return cachedEntries ?? []
}

function writeEntries(entries: HistoryEntry[]): void {
  cachedEntries = entries

  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Quota or privacy mode: the in-memory list keeps working for this
    // session even though nothing persists.
  }

  window.dispatchEvent(new Event(HISTORY_CHANGED_EVENT))
}

// Upserts by URL: replaying a link refreshes its details and moves it to the
// top rather than duplicating the row.
export function recordPlayedUrl(url: string): string {
  const now = Date.now()
  const entries = loadHistory()
  const index = entries.findIndex((entry) => entry.url === url)
  const existing = index === -1 ? undefined : entries[index]

  const id = existing?.id ?? crypto.randomUUID()

  writeEntries(
    [
      {
        id,
        url,
        filename: existing?.filename ?? filenameFromUrl(url),
        filenameConfirmed: existing?.filenameConfirmed ?? false,
        sizeBytes: existing?.sizeBytes ?? null,
        positionSeconds: existing?.positionSeconds ?? 0,
        addedAt: existing?.addedAt ?? now,
        lastPlayedAt: now,
      },
      ...(index === -1 ? entries : entries.toSpliced(index, 1)),
    ].slice(0, HISTORY_LIMIT)
  )

  return id
}

// Fills in the real filename and size once the header probe completes.
export function updateHistoryEntry(
  url: string,
  details: { filename?: string; sizeBytes?: number | null }
): void {
  const entries = loadHistory()
  const index = entries.findIndex((entry) => entry.url === url)

  if (index === -1) {
    return
  }

  const entry = entries[index]

  writeEntries([
    ...entries.slice(0, index),
    {
      ...entry,
      filename: details.filename ?? entry.filename,
      filenameConfirmed:
        details.filename === undefined ? entry.filenameConfirmed : true,
      sizeBytes: details.sizeBytes ?? entry.sizeBytes,
    },
    ...entries.slice(index + 1),
  ])
}

export function updateHistoryPosition(
  url: string,
  positionSeconds: number
): void {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
    return
  }

  const entries = loadHistory()
  const index = entries.findIndex((entry) => entry.url === url)

  if (index === -1) {
    return
  }

  const entry = entries[index]

  if (Math.abs(entry.positionSeconds - positionSeconds) < 0.25) {
    return
  }

  writeEntries([
    ...entries.slice(0, index),
    { ...entry, positionSeconds },
    ...entries.slice(index + 1),
  ])
}

export function removeHistoryEntry(url: string): void {
  writeEntries(loadHistory().filter((entry) => entry.url !== url))
}

export function clearHistory(): void {
  writeEntries([])
}

export function subscribeToHistory(listener: () => void): () => void {
  const onStorage = () => {
    cachedEntries = null
    listener()
  }

  window.addEventListener(HISTORY_CHANGED_EVENT, listener)
  window.addEventListener("storage", onStorage)

  return () => {
    window.removeEventListener(HISTORY_CHANGED_EVENT, listener)
    window.removeEventListener("storage", onStorage)
  }
}
