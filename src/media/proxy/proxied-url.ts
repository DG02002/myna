// Client-side helper for routing advanced-engine reads through the
// same-origin media proxy.
export function proxiedMediaUrl(mediaUrl: string): string {
  return `/api/media-proxy?url=${encodeURIComponent(mediaUrl)}`
}
