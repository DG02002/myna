# Media proxy

`/api/media-proxy` forwards range requests for the advanced engine when a
media origin blocks cross-origin byte access. Native playback is never
proxied; the route exists for Mediabunny's byte reads (and its background
probe) only.

Mediabunny's URL reads, metadata probe, and filename/size request share
`AdvancedMediaReadPolicy`. It times out after 15 seconds without response
headers or body progress; these are inactivity limits, not a movie duration
limit. A failed read gets at most two transient retries for network errors,
408, 425, 429, 500, 502, 503, or 504. The delay is 500 ms, then 1 second,
capped at 2 seconds, unless `Retry-After` asks for longer; the client honors
at most 30 seconds. The retry budget follows a resumed byte offset, and
cancellation interrupts the delay before another upstream request. A 200
response that ignores Range remains Mediabunny's sequential streaming path.

Only a cross-origin fetch `TypeError` is treated as byte access unavailable
and eligible for proxy fallback. The browser error is ambiguous, so this does
not claim the origin's CORS policy was proven. Readable HTTP failures and
invalid ranges keep their status and do not trigger a duplicate proxy read.
These rules apply to the advanced byte pipeline; native playback stays direct.

Some cross-origin servers return a valid `206` while the browser hides
`Content-Range`. The read policy accepts that case only when the readable body
fits the requested range and any visible `Content-Length` agrees. A resumed
range also has to match the response's visible ETag or Last-Modified validator
and any known total size; otherwise the read stops before appending new bytes.

## Abuse posture (decided at the proxy-hardening phase)

Per-client rate limiting is a Workers Rate Limit binding (`RATE_LIMITER` in
`wrangler.jsonc`), not a WAF rule and not an in-isolate bucket. The binding
is the only mechanism that is both correct across isolates and colos and
owned by this repository: WAF rate limiting rules require a Cloudflare zone
(a workers.dev deployment has none) and live outside version control, and an
in-isolate bucket under-limits by design while costing more code.

Sizing: 600 requests per 60 seconds per client IP. Legitimate range
streaming sits far below it (a seek burst is ~12 requests; sustained reads
are 1–2 per second), so the limit only bites relay abuse of the open proxy.
The limit call fails open — the binding is a permissive, eventually
consistent backstop, and an unavailable limiter must not take playback down.
`namespace_id` is self-chosen and unique to the Cloudflare account;
bindings sharing an id share counters.

Destination policy stays as enforced in `src/media/proxy/destinations.ts`:
HTTPS only on port 443, private/loopback/link-local/CGNAT/metadata blocks,
and revalidation of every redirect hop (`redirect: "manual"` — a plain
`redirect: "follow"` silently defeats all of it). Deliberately not added:
a destination allow-list (the product is "paste any direct media URL"),
content-type filtering (media origins answer as `application/octet-stream`
and the check is trivially bypassed), and response size caps (range reads
are client-bounded; caps break legitimate slices without bounding anything
the rate limit does not already bound). Bodies stream with no time cap —
I/O wait is free in Workers, and client disconnect is the cancellation path.

## Observability

One structured JSON decision line per request (method, destination host and
path, outcome, status, redirect hops, upstream wait). Host and path are
copied from the parsed destination URL only, never from the raw `url`
parameter, so signed query strings (`?token=`, `?mac=`, `?expiry=`) cannot
reach Workers Logs. Logs are queryable under Workers Logs
(`observability.enabled`).
