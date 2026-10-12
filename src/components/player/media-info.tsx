import type { ReactNode } from "react"

import type {
  PlaybackEngineMode,
  ProbeState,
} from "#/components/player/playback-stage"
import { formatFileSize, hostFromUrl } from "#/lib/utils"
import { isHlsUrl } from "#/media/models/source"
import type { ProbeResult, ProbeTrackInfo } from "#/media/probe/metadata-probe"
import { durationLabel } from "#/media/probe/track-labels"

export function MediaInfo({
  sourceUrl,
  probeState,
  engineMode,
  sizeBytes,
}: {
  sourceUrl: string
  probeState: ProbeState
  engineMode: PlaybackEngineMode
  sizeBytes: number | null
}) {
  return (
    <section aria-label="Media information" className="space-y-5">
      {probeState.status === "loading" ? (
        <p className="text-muted-foreground text-sm">
          Reading media information…
        </p>
      ) : null}
      {probeState.status === "failed" ? (
        <p className="text-muted-foreground text-sm">
          {isHlsUrl(sourceUrl)
            ? "Track details are unavailable for this HLS stream."
            : "Media information is unavailable for this link."}
        </p>
      ) : null}
      {probeState.status === "ready" ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">File details</caption>
              <tbody>
                <InfoRow label="Source">{hostFromUrl(sourceUrl)}</InfoRow>
                <InfoRow label="Container">
                  {probeState.result.containerName}
                </InfoRow>
                <InfoRow label="Duration">
                  {probeState.result.durationSeconds === null
                    ? "Unknown"
                    : durationLabel(probeState.result.durationSeconds)}
                </InfoRow>
                <InfoRow label="File size">
                  {sizeBytes === null ? "Unknown" : formatFileSize(sizeBytes)}
                </InfoRow>
                <InfoRow label="Tracks">
                  {probeState.result.tracks.length}
                </InfoRow>
                {import.meta.env.DEV ? (
                  <InfoRow label="Engine">
                    <EngineBadge
                      sourceUrl={sourceUrl}
                      probeReadMode={probeState.result.readMode}
                      engineMode={engineMode}
                    />
                  </InfoRow>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Audio and video tracks</caption>
              <thead>
                <tr className="border-y border-border/70">
                  <th scope="col" className="px-3 py-2 font-medium">
                    Track
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Format
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody>
                {probeState.result.tracks.map((track) => (
                  <TrackRow
                    key={`${track.kind}-${track.number}`}
                    track={track}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  )
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr className="border-b border-border/60 last:border-b-0">
      <th
        scope="row"
        className="w-36 px-3 py-2 text-left font-medium text-muted-foreground"
      >
        {label}
      </th>
      <td className="break-words px-3 py-2 tabular-nums">{children}</td>
    </tr>
  )
}

function TrackRow({ track }: { track: ProbeTrackInfo }) {
  const details = [
    track.name,
    track.languageCode && track.languageCode !== "und"
      ? track.languageCode
      : null,
    track.kind === "video" &&
    track.displayWidth !== null &&
    track.displayHeight !== null
      ? `${track.displayWidth} × ${track.displayHeight}`
      : null,
    track.kind === "audio" && track.channels !== null
      ? `${track.channels} ${track.channels === 1 ? "channel" : "channels"}`
      : null,
    track.kind === "audio" && track.sampleRate !== null
      ? `${(track.sampleRate / 1000).toFixed(1).replace(/\.0$/, "")} kHz`
      : null,
    track.default ? "Default" : null,
    !track.decodable ? "Native decoder unavailable" : null,
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ")

  return (
    <tr className="border-b border-border/60 last:border-b-0">
      <th scope="row" className="px-3 py-2 text-left font-medium">
        {track.kind === "video" ? "Video" : `Audio ${track.number}`}
      </th>
      <td className="max-w-56 break-words px-3 py-2 text-muted-foreground">
        {track.codecParameterString ?? "Unknown codec"}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {details.length > 0 ? details : "—"}
      </td>
    </tr>
  )
}

function EngineBadge({
  sourceUrl,
  probeReadMode,
  engineMode,
}: {
  sourceUrl: string
  probeReadMode: ProbeResult["readMode"]
  engineMode: PlaybackEngineMode
}) {
  let engineLabel: string

  if (engineMode === "mediabunny") {
    engineLabel = "Mediabunny + WebCodecs"
  } else if (isHlsUrl(sourceUrl)) {
    engineLabel = "hls.js / native HLS"
  } else {
    engineLabel = "Native"
  }

  return (
    <span>
      {engineLabel} · probe via {probeReadMode}
    </span>
  )
}
