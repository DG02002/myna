import type { HlsJsAdapter } from "@videojs/hlsjs-video"
import type { HlsJsVideo } from "@videojs/react/media/hlsjs-video"
import { VideoPlayer, Video } from "@videojs/react/video"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { AssSubtitleOverlay } from "#/components/player/ass-subtitle-overlay"
import {
  AudioTracksContext,
  type AudioTracksValue,
} from "#/components/player/audio-tracks-context"
import { MediabunnyVideo } from "#/components/player/mediabunny-video"
import { PgsSubtitleOverlay } from "#/components/player/pgs-subtitle-overlay"
import { SubtitleOverlay } from "#/components/player/subtitle-overlay"
import { useSubtitles } from "#/components/player/subtitle-tracks"
import { SubtitleTracksContext } from "#/components/player/subtitle-tracks-context"
import { VideoSkin } from "#/components/videojs/video/skin"
import type { MediabunnyMediaAdapter } from "#/media/engines/mediabunny-adapter"
import type {
  EngineInit,
  MediabunnyEngine,
} from "#/media/engines/mediabunny-engine"
import { MEDIA_ERR_SRC_NOT_SUPPORTED } from "#/media/models/media-errors"
import {
  isHlsUrl,
  isMatroskaUrl,
  type PlaybackSource,
} from "#/media/models/source"
import { probeSource, type ProbeResult } from "#/media/probe/metadata-probe"
import { probeTrackLabel } from "#/media/probe/track-labels"
import type { SubtitleTrack } from "#/media/subtitles"

type HlsJsVideoComponent = typeof HlsJsVideo

// Apple's browsers are the one family where the plan's "native HLS" path is
// the first-class pipeline; they are identified by a capability no other
// browser exposes — the webkit presentation-mode (PiP) API on video
// elements — rather than a user-agent string. Everywhere else hls.js over
// MSE plays, which the quality menu needs (renditions exist only on the MSE
// engine) and which sidesteps Chromium's own new HLS support that still
// rejects some streams outright (measured, October 2026).
let platformHlsHint: boolean | undefined

function prefersPlatformHls(): boolean {
  platformHlsHint ??=
    typeof HTMLVideoElement !== "undefined" &&
    "webkitPresentationMode" in HTMLVideoElement.prototype

  return platformHlsHint
}

export type PlaybackEngineMode = "native" | "mediabunny"

export type ProbeState =
  | { status: "loading" }
  | { status: "ready"; result: ProbeResult }
  | { status: "failed" }

interface MigrationSnapshot {
  time: number
  wasPlaying: boolean
  volume: number
  muted: boolean
  playbackRate: number
  audioTrackId: string | null
  subtitleTrackId: string | null
}

export interface PlaybackStageDetails {
  subtitleTracks: SubtitleTrack[]
  addSubtitle: (url: string) => void
  canAddSubtitles: boolean
  embeddedProbeFailed: boolean
}

// The native engine wins until it cannot do the job: a fatal native error,
// or an audio track request the browser cannot serve. Migration preserves
// position, play state, volume, mute, and rate. The stage is keyed by the
// source URL, so it mounts fresh per source.
export function PlaybackStage({
  source,
  onProbe,
  onModeChange,
  renderDetails,
}: {
  source: PlaybackSource
  onProbe: (state: ProbeState) => void
  onModeChange: (mode: PlaybackEngineMode) => void
  renderDetails?: (details: PlaybackStageDetails) => ReactNode
}) {
  const [mode, setMode] = useState<PlaybackEngineMode>("native")
  const [snapshot, setSnapshot] = useState<MigrationSnapshot | null>(null)
  const [engine, setEngine] = useState<MediabunnyEngine | null>(null)
  const [adapter, setAdapter] = useState<MediabunnyMediaAdapter | null>(null)

  const [selectedAudioTrackId, setSelectedAudioTrackId] = useState<
    string | null
  >(null)

  // The probe opens containers; a playlist is not one, and fetching it just
  // to fail would waste a round trip against a signed URL. The stage is
  // keyed by source URL, so the source kind never changes within a mount.
  const { hlsSource, probeState, matroskaUrl } = usePlaybackSource(source)

  const nativeMediaRef = useRef<HTMLVideoElement | null>(null)

  const [nativeVideoElement, setNativeVideoElement] =
    useState<HTMLVideoElement | null>(null)

  const attachNativeVideo = useCallback((element: HTMLVideoElement | null) => {
    nativeMediaRef.current = element
    setNativeVideoElement(element)
  }, [])

  const {
    tracks: subtitleTracks,
    selectedId: selectedSubtitleId,
    selectedTrack: selectedSubtitleTrack,
    addSubtitle,
    restoreSelection: restoreSubtitleSelection,
    assTrackStream,
    pgsSession,
    failSubtitle,
    markSubtitleIncomplete,
    embeddedProbeFailed,
  } = useSubtitles({
    useAdvancedEngine: mode === "mediabunny",
    nativeMediaRef,
    adapter,
    matroskaUrl,
  })

  useEffect(() => {
    onProbe(probeState)
  }, [onProbe, probeState])

  // Native sources load after mount so startup errors reach player state.
  // HLS sources are owned by the HlsJsVideo adapter, which manages the
  // element's source itself.
  useEffect(() => {
    if (mode !== "native" || hlsSource) {
      return
    }

    const element = nativeMediaRef.current

    if (element !== null) {
      element.src = source.url
      element.load()
    }
  }, [mode, nativeMediaRef, source.url, hlsSource])

  const audioTracks = useMemo(() => {
    if (probeState.status !== "ready") {
      return []
    }

    return probeState.result.tracks
      .filter((track) => track.kind === "audio")
      .map((track) => ({
        id: `${track.kind}-${track.number}`,
        label: `${probeTrackLabel(track)}${track.default ? " · Default" : ""}`,
        // canDecode reflects the browser's own decoders: an E-AC-3/AC-3
        // track reports false until the engine lazily registers its WASM
        // decoder, so a false default track still needs the engine.
        nativeDecodable: track.decodable,
      }))
  }, [probeState])

  // Native playback does not expose its selected Matroska audio track in
  // Chrome. Keep the selection unknown until the user chooses one or the
  // advanced engine reports its actual selection.
  const effectiveSelectedId = selectedAudioTrackId

  const migrateToEngine = useCallback(
    (nextAudioTrackId: string | null, element: HTMLVideoElement | null) => {
      setSnapshot({
        time: element?.currentTime ?? 0,
        wasPlaying: element !== null && !element.paused,
        volume: element?.volume ?? 1,
        muted: element?.muted ?? false,
        playbackRate: element?.playbackRate ?? 1,
        audioTrackId: nextAudioTrackId,
        subtitleTrackId: selectedSubtitleId,
      })
      setMode("mediabunny")
      onModeChange("mediabunny")

      if (nextAudioTrackId !== null) {
        setSelectedAudioTrackId(nextAudioTrackId)
      }
    },
    [onModeChange, selectedSubtitleId]
  )

  const selectTrack = useCallback(
    (id: string) => {
      const track = audioTracks.find((candidate) => candidate.id === id)

      if (track === undefined) {
        return
      }

      if (mode === "mediabunny") {
        if (id !== effectiveSelectedId) {
          setSelectedAudioTrackId(id)
          void engine?.selectAudioTrack(id)
        }

        return
      }

      // The native engine exposes no audio track switching (validated on
      // Chrome), and it plays a track the browser cannot decode as silence.
      // Selecting the already-selected track is only a no-op when the
      // native engine is actually playing it; otherwise migrate at the
      // current position.
      const alreadyNativelyServed =
        id === effectiveSelectedId && track.nativeDecodable

      if (!alreadyNativelyServed) {
        migrateToEngine(id, nativeMediaRef.current)
      }
    },
    [
      audioTracks,
      effectiveSelectedId,
      engine,
      mode,
      migrateToEngine,
      nativeMediaRef,
    ]
  )

  const onNativeError = useCallback(() => {
    // HLS failures stay in the video.js pipeline (the error dialog handles
    // them); the mediabunny engine cannot demux playlists, so migrating a
    // playlist source there would only produce a second failure.
    if (mode !== "native" || hlsSource) {
      return
    }

    migrateToEngine(effectiveSelectedId, nativeMediaRef.current)
  }, [effectiveSelectedId, hlsSource, mode, migrateToEngine, nativeMediaRef])

  const engineInit = useMemo<EngineInit>(
    () => ({
      source,
      startTime: snapshot?.time ?? 0,
      autoPlay: snapshot?.wasPlaying ?? true,
      volume: snapshot?.volume ?? 1,
      muted: snapshot?.muted ?? false,
      playbackRate: snapshot?.playbackRate ?? 1,
      audioTrackId: snapshot?.audioTrackId ?? null,
    }),
    [source, snapshot]
  )

  const contextValues = useMemo(() => {
    let selectionLabel = ""

    if (mode === "native") {
      selectionLabel = "Browser default"
    } else if (effectiveSelectedId === null) {
      selectionLabel = "Loading…"
    }

    return {
      audio: {
        tracks: audioTracks,
        selectedId: effectiveSelectedId,
        selectionLabel,
        selectTrack,
      } satisfies AudioTracksValue,
      subtitles: {
        tracks: subtitleTracks,
        selectedId: selectedSubtitleId,
        selectSubtitle: restoreSubtitleSelection,
      },
    }
  }, [
    audioTracks,
    effectiveSelectedId,
    mode,
    restoreSubtitleSelection,
    selectTrack,
    selectedSubtitleId,
    subtitleTracks,
  ])

  return (
    <AudioTracksContext.Provider value={contextValues.audio}>
      <SubtitleTracksContext.Provider value={contextValues.subtitles}>
        <>
          {mode === "native" ? (
            <VideoPlayer key="native">
              <VideoSkin className="aspect-video w-full">
                {hlsSource ? (
                  <LazyHlsVideo
                    sourceUrl={source.url}
                    videoRef={attachNativeVideo}
                    onError={onNativeError}
                  />
                ) : (
                  <Video
                    ref={attachNativeVideo}
                    playsInline
                    preload="metadata"
                    onError={onNativeError}
                  />
                )}
                {assTrackStream !== null &&
                selectedSubtitleTrack?.source.kind === "matroska" &&
                (selectedSubtitleTrack.source.codecId === "S_TEXT/ASS" ||
                  selectedSubtitleTrack.source.codecId === "S_TEXT/SSA") ? (
                  <AssSubtitleOverlay
                    key={selectedSubtitleTrack.id}
                    trackId={selectedSubtitleTrack.id}
                    stream={assTrackStream}
                    useAdvancedEngine={false}
                    nativeVideo={nativeVideoElement}
                    adapter={null}
                    engine={null}
                    onFailure={failSubtitle}
                  />
                ) : null}
                {pgsSession !== null &&
                selectedSubtitleTrack?.source.kind === "matroska" &&
                selectedSubtitleTrack.source.codecId === "S_HDMV/PGS" ? (
                  <PgsSubtitleOverlay
                    key={selectedSubtitleTrack.id}
                    session={pgsSession}
                    trackId={selectedSubtitleTrack.id}
                    useAdvancedEngine={false}
                    nativeVideo={nativeVideoElement}
                    adapter={null}
                    onFailure={failSubtitle}
                    onUnavailable={markSubtitleIncomplete}
                  />
                ) : null}
              </VideoSkin>
            </VideoPlayer>
          ) : (
            <VideoPlayer key="mediabunny">
              <VideoSkin className="aspect-video w-full">
                <MediabunnyVideo
                  init={engineInit}
                  onEngine={setEngine}
                  onSelectedAudioTrackId={setSelectedAudioTrackId}
                  onAdapter={(nextAdapter) => {
                    if (nextAdapter !== null && snapshot !== null) {
                      restoreSubtitleSelection(snapshot.subtitleTrackId)
                    }

                    setAdapter(nextAdapter)
                  }}
                />
                {adapter !== null && engine !== null ? (
                  <SubtitleOverlay
                    adapter={adapter}
                    engine={engine}
                    track={subtitleTracks.find(
                      (track) => track.id === selectedSubtitleId
                    )}
                  />
                ) : null}
                {pgsSession !== null &&
                adapter !== null &&
                selectedSubtitleTrack?.source.kind === "matroska" &&
                selectedSubtitleTrack.source.codecId === "S_HDMV/PGS" ? (
                  <PgsSubtitleOverlay
                    key={selectedSubtitleTrack.id}
                    session={pgsSession}
                    trackId={selectedSubtitleTrack.id}
                    useAdvancedEngine
                    nativeVideo={null}
                    adapter={adapter}
                    onFailure={failSubtitle}
                    onUnavailable={markSubtitleIncomplete}
                  />
                ) : null}
                {assTrackStream !== null &&
                selectedSubtitleTrack?.source.kind === "matroska" &&
                (selectedSubtitleTrack.source.codecId === "S_TEXT/ASS" ||
                  selectedSubtitleTrack.source.codecId === "S_TEXT/SSA") ? (
                  <AssSubtitleOverlay
                    key={selectedSubtitleTrack.id}
                    trackId={selectedSubtitleTrack.id}
                    stream={assTrackStream}
                    useAdvancedEngine
                    nativeVideo={null}
                    adapter={adapter}
                    engine={engine}
                    onFailure={failSubtitle}
                  />
                ) : null}
              </VideoSkin>
            </VideoPlayer>
          )}
          {renderDetails?.({
            subtitleTracks,
            addSubtitle,
            canAddSubtitles: !hlsSource,
            embeddedProbeFailed,
          })}
        </>
      </SubtitleTracksContext.Provider>
    </AudioTracksContext.Provider>
  )
}

function usePlaybackSource(source: PlaybackSource) {
  const hlsSource = isHlsUrl(source.url)
  const probeState = useSourceProbe(source, hlsSource)
  const matroskaUrl = findMatroskaUrl(source.url, hlsSource, probeState)

  return { hlsSource, probeState, matroskaUrl }
}

function useSourceProbe(
  source: PlaybackSource,
  hlsSource: boolean
): ProbeState {
  const [probeState, setProbeState] = useState<ProbeState>(() =>
    hlsSource ? { status: "failed" } : { status: "loading" }
  )

  useEffect(() => {
    if (hlsSource) {
      return undefined
    }

    const controller = new AbortController()

    probeSource(source, controller.signal)
      .then((result) => {
        setProbeState({ status: "ready", result })
      })
      .catch(() => {
        // Probe failures are informational only; playback is unaffected.
        if (!controller.signal.aborted) {
          setProbeState({ status: "failed" })
        }
      })

    return () => controller.abort()
  }, [source, hlsSource])

  return probeState
}

function findMatroskaUrl(
  url: string,
  hlsSource: boolean,
  probeState: ProbeState
): string | null {
  if (hlsSource || isMatroskaUrl(url)) {
    return hlsSource ? null : url
  }

  if (
    probeState.status === "ready" &&
    probeState.result.containerName.toLowerCase().includes("matroska")
  ) {
    return url
  }

  return null
}

// HLS media element, loaded on demand so hls.js never downloads for a
// progressive source. The component mounts first and the source is assigned
// afterwards: assigning via props during render starts loading before the
// adapter has attached its media element, and fatal manifest errors are
// dropped in that window — a dead link then spins forever instead of
// reaching the error dialog.
//
// Engine routing: Apple platforms play through their own HLS pipeline
// (prefersPlatformHls); everyone else through hls.js over MSE, which the
// quality menu needs. A manifest the platform pipeline rejects outright gets
// one rebuild through hls.js; from then on failures belong to the error
// dialog. No crossOrigin — it breaks cross-origin native playback.
function LazyHlsVideo({
  sourceUrl,
  videoRef,
  onError,
}: {
  sourceUrl: string
  videoRef: (element: HTMLVideoElement | null) => void
  onError: () => void
}) {
  const [videoComponent, setVideoComponent] =
    useState<HlsJsVideoComponent | null>(null)

  const [platformHlsRejected, setPlatformHlsRejected] = useState(false)

  const adapterRef = useRef<HlsJsAdapter | null>(null)

  useEffect(() => {
    let cancelled = false

    void import("@videojs/react/media/hlsjs-video").then((module) => {
      if (!cancelled) {
        setVideoComponent(() => module.HlsJsVideo)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  // Runs after the video component below has mounted and its adapter has
  // attached, so loading starts against an attached element.
  useEffect(() => {
    const adapter = adapterRef.current

    if (videoComponent === null || adapter === null) {
      return undefined
    }

    const usePlatformHls = prefersPlatformHls() && !platformHlsRejected

    // The adapter re-dispatches the element's error events on itself (the
    // element's own are stopped at the element), which is the only reliable
    // signal a native-HLS failure happened. The listener parameter matches
    // the adapter's EventLike shape structurally — @videojs/media is not a
    // direct dependency to import the type from.
    const onAdapterError = (event: {
      readonly type: string
      readonly timeStamp: number
    }) => {
      if (
        usePlatformHls &&
        event instanceof ErrorEvent &&
        event.error?.code === MEDIA_ERR_SRC_NOT_SUPPORTED
      ) {
        setPlatformHlsRejected(true)
      }
    }

    adapter.addEventListener("error", onAdapterError)

    adapter.source = usePlatformHls
      ? { src: sourceUrl, preferPlayback: "native" }
      : { src: sourceUrl }

    return () => {
      adapter.removeEventListener("error", onAdapterError)
    }
  }, [videoComponent, sourceUrl, platformHlsRejected])

  if (videoComponent === null) {
    return null
  }

  const VideoElement = videoComponent

  return (
    <VideoElement
      ref={videoRef}
      mediaRef={adapterRef}
      playsInline
      preload="metadata"
      onError={onError}
    />
  )
}
