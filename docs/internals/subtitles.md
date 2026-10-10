# External subtitles

External subtitles are fetched as text, parsed once, and added to the active
media with `addTextTrack()` and `VTTCue`. Do not use `<track src>`: a
cross-origin track requires CORS and `crossOrigin`, which can make an otherwise
playable native media URL fail. The fetch has a deadline, a byte limit, and an
abort signal; it tries the URL directly, then the media proxy if browser CORS
blocks the read. Subtitle errors stay in the subtitle status UI and never
change playback state.

SRT and WebVTT share the same cue shape, so one small parser handles both.
Malformed cue blocks are skipped while valid cues remain usable. The parser
keeps VTT markup for browser rendering; the canvas overlay strips markup and
decodes common entities before displaying cue text.

Embedded Matroska `S_TEXT/UTF8` subtitles are a side channel. The original URL
stays on the native `<video>` while a client reader requests only EBML metadata
and the selected subtitle blocks. It prefers Matroska Cues; files without
usable subtitle Cues get only a bounded cluster scan. Every read requires a
valid `206` response with a matching `Content-Range`. The direct URL is tried
first, and the media proxy is used only for these byte-range reads when direct
fetching fails. Reads, deadlines, cue count, subtitle text, and retained range
pages are capped. Source changes and track changes abort pending reads. A
subtitle failure stays in subtitle status and never interrupts playback; URLs
are not written to logs.

Subtitle range fetches bypass the browser HTTP cache with `cache: "no-store"`.
Chromium otherwise serializes concurrent ranges to the same URL behind a cache
lock, consuming the request deadline before queued reads reach the network.
The reader retains its own bounded page cache.
Proxy network failures and request timeouts get one retry within the same
byte/request budget; cancellation and malformed range responses never retry.

The text reader supports `S_TEXT/UTF8`. UTF8, ASS/SSA, and PGS restore supported
Block-scoped Matroska encodings in descending `ContentEncodingOrder`: zlib
compression and header stripping. Each compressed and restored Block stays
within the selected reader's existing Block limit, and zlib output is streamed
with cancellation. Encryption, other scopes or algorithms, malformed encoding
chains, laced Blocks, malformed UTF8, and missing cue duration fail as
subtitles instead of producing corrupted cues. ASS/SSA use a separate
selected-track path for `S_TEXT/ASS` and `S_TEXT/SSA`; cue decoding and
rendering stay unchanged. The ASS reader passes Matroska `CodecPrivate` and
timed packet bytes directly to AkariSub/libass in ordered batches as indexed
cluster reads finish.
Its bounded session retains packets so a renderer recreated during engine
migration can replay them. It does not rebuild ASS `Dialogue` lines.

ASS reads use 64 KiB range pages, a 48 MiB per-track byte budget, and at
most 1,024 range requests. ASS subtitle blocks are scattered one-to-a-few per
cluster across the file, so larger pages would multiply fetched bytes far past
the budget; the 64 KiB page stays. The track deadline is a no-progress bound
of 240 seconds that resets as indexed cluster batches complete, so a slow
proxy path finishes while byte, request, and per-range deadlines bound the
work absolutely. UTF8 uses 8 KiB range pages, a separate 32 MiB byte budget,
and at most 4,096 requests. Its 240-second no-progress deadline extends as
each page arrives, so a large sparse track can finish while byte, request, and
per-range deadlines bound the work. Cue packets are
capped at 4 MiB each and 50,000 per track; codec private data is capped at
256 KiB. The reader honors Cues and otherwise scans only the existing bounded
cluster window. It reads fonts only when the selected `TrackEntry` links them with
`AttachmentLink`; unlinked attachments are ignored. Linked font files are
capped at 24 MiB each and 32 MiB total. Missing CodecPrivate, unsupported
content-encoding types, scopes or algorithms, laced Blocks, malformed packet
UTF8, missing cue duration, oversized resources, and malformed EBML fail the
selected subtitle track.
Invalid ASS syntax is delegated to libass; a renderer/worker error marks the
track failed. Neither path changes playback state. The legacy `S_ASS` and
`S_SSA` identifiers, unlinked fonts, bitmap subtitles, and OCR are unsupported.

Embedded `S_HDMV/PGS` is a binary path. Matroska has no CodecPrivate for PGS;
a Block can contain one or more concatenated PGS segments, and its Block
timestamp and optional BlockDuration apply to each extracted segment. PGS
segments are assembled through the End segment before they reach the parser.
Palette, object, window, and composition state survives between display sets.
A state-bearing packet that is missing or malformed invalidates dependent
compositions until a complete EpochStart or AcquisitionPoint supplies every
referenced palette, object, and window. Cue positions are byte hints rather
than decoder restart points. Each seek loads from the nearest Cue, searches
back at most 256 Cue entries or 120 seconds for a verified state boundary, and
scans nearby physical gaps of at most 64 MiB to recover unindexed state. If no
safe boundary is found, the canvas clears and the window is unavailable. The
reader aims for at least 10 seconds of future composition coverage when Cue
entries permit it, bounded to 120 seconds ahead; the session starts loading
the next window as soon as playback is 30 seconds from the coverage edge,
because a window load on a latency-bound origin can take most of the window
deadline. While playback sits between the active window's coverage and the
next window landing, the renderer reports a transient clear rather than an
unavailable: only a window load that genuinely fails marks the track partial.
A 32 MiB LRU page cache is shared across windows
to avoid fetching the same sparse-Cue gap repeatedly. A new seek cancels the
current range reads and resets the worker before replaying the new window, so
palette and object state cannot leak across a seek. One upcoming window may be
prefetched and is discarded when a seek changes its target.

PGS uses the low-level parser from libbitsub 1.12.1 in a dedicated worker. The
adapter wraps each Matroska segment in the SUP segment header, converts its
media timestamp to 90 kHz ticks relative to the first packet, and uses DTS 0:
Matroska supplies a presentation timestamp only, and this parser stores but
does not consume DTS. The parser uses a 32-bit PTS field and does not unwrap it,
so tracks spanning more than 4,294,967,295 ticks (about 13 hours, 15 minutes)
are stopped at the limit. Rendering uses the player clock directly, so native
video and Mediabunny use the same parser path. `renderAtIndex` reconstructs
earlier state from its nearest verified boundary; replay more than 10,000
display sets from that boundary is reported unavailable and clears the canvas.
Authored PGS palette entries remain in their limited-range BT.601 Y'CbCr form
for state and partial updates. Expanded palettes sent to libbitsub pass through
BT.601 RGB and are re-encoded as full-range Y'CbCr because the pinned decoder
interprets palette values as full range; alpha is preserved. This conversion is
only for decoder input and does not replace the raw palette state.

The PGS reader caps each extracted segment at 65,550 bytes and each Matroska
Block at 4 MiB, so one Block may carry a concatenated display set. One
assembled display set is capped at 4 MiB, window bytes at 32 MiB, and a window
at 50,000 segments. The Cue index is capped at 4 MiB and fetched in parallel
64 KiB ranges, with at most 12 active reads. Target windows use aligned 2 MiB
pages to keep latency-bound Cluster reads to a handful of requests. They allow
at most 2,048 requests and 128 MiB of range traffic through 8 GiB; larger files
have a 1 GiB range-traffic ceiling because the measured UHD clusters require a
longer backward state search. Cue positions prefetch the Cluster header and
selected PGS Block pages through the coverage-goal Cue. The sequential parser
walks EBML child headers and fetches selected PGS Block payloads while skipping
unrelated A/V payload pages; pages beyond the event that satisfies coverage
stay cached for the next window. The window deadline is a 30-second no-progress
bound that
extends while pages keep arriving, so slow-but-delivering origins finish and
only a stalled source aborts. The legacy full-track reader still scans only the first 4 MiB after
the first Cluster when Cues are absent and has a 240-second operation deadline.
Range requests have a 10-second deadline and proxy transient failures receive
one retry inside the same budgets. The worker accepts at most one input Block
at a time. Its replay data is capped at 32 MiB, display sets at 10,000,
retained composition references at 20,000, objects at 64 per epoch, palettes
at 8, windows at 32, and composition references at 32.
Pending object bytes are capped at 2 MiB and each object at 4,194,304 pixels.
A presentation is at most 4096 by 2160 pixels; referenced decoded objects
together are capped at that pixel area and 35,389,440 RGBA bytes. The renderer
keeps at most one transferred frame awaiting synchronous draw and clears
libbitsub's decoded cache after each render. The session retains at most one
prefetched window in addition to worker replay state. Browser/WASM allocator
fragmentation and GPU-side canvas memory are not directly measurable by these
byte limits. Track/source changes abort range reads and terminate the worker; a
decoder failure stays nonfatal to media playback. The worker and WASM are
loaded only when a PGS track is selected. The libbitsub license is served from
`/licenses/libbitsub/`.

AkariSub runs libass in a Web Worker on a player-owned canvas that reserves
space for visible controls. Both engines drive its clock explicitly: native
video supplies its media time and Mediabunny supplies its audio-context time.
Do not use AkariSub's video-managed frame clock with signed cross-origin media;
it constructs a `VideoFrame`, which fails on tainted native video. Pass copies
of headers, packets, and fonts because AkariSub transfers their buffers to the
worker; retained data must survive renderer recreation and engine migration.
VOD event pruning and local font discovery are disabled. The package and bundled
component notices are served from `/licenses/akarisub/`.

Native video, native HLS, and hls.js use the active media's `TextTrackList`.
For an embedded track already exposed by the browser, the player reuses that
track instead of registering a duplicate. Otherwise it adds a programmatic
`TextTrack`; UTF8 cues populate it, while ASS/SSA use it only as a captions-menu
selection entry for AkariSub. The Matroska track number is its stable key, so
selection can be recreated on the Mediabunny adapter during engine migration.

The Mediabunny adapter exposes a detached video's real `TextTrackList` so the
Video.js captions feature can list and select external and extracted tracks.
That host video does not render over the decoded canvas, so `SubtitleOverlay`
uses parsed text cues and the engine playback clock; the ASS canvas receives
the same clock from the engine. Video.js track objects are local to each media
element; the stage stores the stable application track id, recreates the
programmatic track after migration, and restores selection.
