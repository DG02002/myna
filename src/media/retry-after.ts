export function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now()
): number | null {
  if (value === null) {
    return null
  }

  const seconds = Number(value)

  if (value.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000
  }

  const retryAtMs = Date.parse(value)

  return Number.isFinite(retryAtMs) ? Math.max(0, retryAtMs - nowMs) : null
}
