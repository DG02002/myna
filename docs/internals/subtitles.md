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

The text reader supports `S_TEXT/UTF8`. Tracks with content encodings, laced
blocks, malformed UTF-8, or no usable cue duration fail as subtitles instead
of producing corrupted cues. ASS/SSA use a separate selected-track path for
`S_TEXT/ASS` and `S_TEXT/SSA`; Phase 8 UTF8 limits and cue rendering stay
unchanged. The ASS reader passes Matroska `CodecPrivate` and timed packet bytes
directly to AkariSub/libass in ordered batches as indexed cluster reads finish.
Its bounded session retains packets so a renderer recreated during engine
migration can replay them. It does not rebuild ASS `Dialogue` lines.

ASS reads use 64 KiB range pages, a 48 MiB per-track byte budget, at most 1,024
range requests, and a 240-second track deadline. UTF8 uses the same deadline
with its separate 8 MiB byte budget. Cue packets are capped at 4
MiB each and 50,000 per track; codec private data is capped at 256 KiB. The
reader honors Cues and otherwise scans only the existing bounded cluster
window. It reads fonts only when the selected `TrackEntry` links them with
`AttachmentLink`; unlinked attachments are ignored. Linked font files are
capped at 24 MiB each and 32 MiB total. Missing CodecPrivate, unsupported
content encodings, laced blocks, malformed packet UTF8, missing cue duration,
oversized resources, and malformed EBML fail the selected subtitle track.
Invalid ASS syntax is delegated to libass; a renderer/worker error marks the
track failed. Neither path changes playback state. The legacy `S_ASS` and
`S_SSA` identifiers, unlinked fonts, bitmap subtitles, and OCR are unsupported.

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
