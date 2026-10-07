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

Native video, native HLS, and hls.js use the platform's `TextTrackList` for
both external and browser-exposed tracks. The captions menu reflects what that
active media actually exposes. Embedded subtitles absent from the browser's
list remain absent; in particular, Mediabunny does not read embedded MKV
subtitles.

The Mediabunny adapter exposes a detached video's real `TextTrackList` so the
Video.js captions feature can list and select external tracks. That host video
does not render over the decoded canvas, so `SubtitleOverlay` uses the selected
external track's parsed cues and the engine playback clock. The stage tracks
selection by its external subtitle id because Video.js track ids are local to
each media element; migration recreates the track and restores the selection.
