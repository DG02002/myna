# Media proxy

`/api/media-proxy` forwards range requests for the advanced engine when a
media origin blocks cross-origin byte access. Native playback is never
proxied; the route exists for Mediabunny's byte reads (and its background
probe) only.

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
