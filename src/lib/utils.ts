export { cn } from "cn"

// Binary units (1 KB = 1024 B), matching how file sizes are labelled in
// file managers and download dialogs.
export function formatFileSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return ""
  }

  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes
  let unitIndex = -1

  do {
    value /= 1024
    unitIndex += 1
  } while (value >= 1024 && unitIndex < units.length - 1)

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

export function formatRelativeTime(
  timestamp: number,
  now: number = Date.now()
): string {
  const elapsedMs = Math.max(0, now - timestamp)
  const elapsedMinutes = Math.floor(elapsedMs / 60_000)

  if (elapsedMinutes < 1) {
    return "Just now"
  }

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} min ago`
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60)

  if (elapsedHours < 24) {
    return `${elapsedHours} hr ago`
  }

  const elapsedDays = Math.floor(elapsedHours / 24)

  if (elapsedDays === 1) {
    return "Yesterday"
  }

  if (elapsedDays < 7) {
    return `${elapsedDays} days ago`
  }

  const date = new Date(timestamp)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()

  const dateFormat: Intl.DateTimeFormatOptions = sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" }

  return date.toLocaleDateString(undefined, dateFormat)
}

// Display name for a media URL before any header probe has run: the last
// path segment when there is one, otherwise the host.
export function filenameFromUrl(url: string): string {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  const raw = parsed.pathname.split("/").pop() ?? ""

  if (raw.length === 0) {
    return parsed.host
  }

  try {
    return decodeURIComponent(raw)
  } catch {
    // Malformed percent-encoding; the raw segment is still a usable name.
    return raw
  }
}

export function hostFromUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
