import type {
  PlaybackEngineMode,
  ProbeState,
} from "#/components/player/playback-stage"
import { durationLabel, probeTrackLabel } from "#/media/probe/track-labels"

export function MediaInfo({
  probeState,
  engineMode,
}: {
  probeState: ProbeState
  engineMode: PlaybackEngineMode
}) {
  return (
    <section className="text-muted-foreground space-y-1.5 text-sm">
      {import.meta.env.DEV ? (
        <EngineBadge probeState={probeState} engineMode={engineMode} />
      ) : null}
      {probeState.status === "loading" ? (
        <p className="text-xs">Reading media information…</p>
      ) : null}
      {probeState.status === "failed" ? (
        <p className="text-xs">
          Media information is unavailable for this link.
        </p>
      ) : null}
      {probeState.status === "ready" ? (
        <div className="space-y-1">
          <p className="text-xs tabular-nums">
            {probeState.result.containerName}
            {probeState.result.durationSeconds !== null
              ? ` · ${durationLabel(probeState.result.durationSeconds)}`
              : ""}
            {` · ${probeState.result.tracks.length} track${probeState.result.tracks.length === 1 ? "" : "s"}`}
          </p>
          <ul className="space-y-0.5">
            {probeState.result.tracks.map((track) => (
              <li key={`${track.kind}-${track.number}`} className="text-xs">
                <span className="text-foreground">
                  {track.kind === "video" ? "Video" : `Audio ${track.number}`}
                </span>{" "}
                · {probeTrackLabel(track)}
                {track.decodable ? "" : " · native decoder unavailable"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function EngineBadge({
  probeState,
  engineMode,
}: {
  probeState: ProbeState
  engineMode: PlaybackEngineMode
}) {
  const engineLabel =
    engineMode === "mediabunny" ? "Mediabunny+WebCodecs" : "Native"

  const readMode =
    probeState.status === "ready"
      ? ` · probe via ${probeState.result.readMode}`
      : ""

  return (
    <p className="text-foreground/60 text-xs tracking-wide uppercase">
      {`Engine: ${engineLabel}${readMode}`}
    </p>
  )
}
