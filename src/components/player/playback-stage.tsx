import type { HlsJsAdapter } from "@videojs/hlsjs-video"
import type { HlsJsVideo } from "@videojs/react/media/hlsjs-video"
import { VideoPlayer, Video } from "@videojs/react/video"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  AudioTracksContext,
  type AudioTracksValue,
} from "#/components/player/audio-tracks-context"
import { MediabunnyVideo } from "#/components/player/mediabunny-video"
import { VideoSkin } from "#/components/videojs/video/skin"
import type {
  EngineInit,
  MediabunnyEngine,
} from "#/media/engines/mediabunny-engine"
import { isHlsUrl, type PlaybackSource } from "#/media/models/source"
import { probeSource, type ProbeResult } from "#/media/probe/metadata-probe"
import { probeTrackLabel } from "#/media/probe/track-labels"

type HlsJsVideoComponent = typeof HlsJsVideo

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
}

// The native engine wins until it cannot do the job: a fatal native error,
// or an audio track request the browser cannot serve. Migration preserves
// position, play state, volume, mute, and rate. The stage is keyed by the
// source URL, so it mounts fresh per source.
export function PlaybackStage({
  source,
  onProbe,
  onModeChange,
}: {
  source: PlaybackSource
  onProbe: (state: ProbeState) => void
  onModeChange: (mode: PlaybackEngineMode) => void
}) {
  const [mode, setMode] = useState<PlaybackEngineMode>("native")
  const [snapshot, setSnapshot] = useState<MigrationSnapshot | null>(null)
  const [engine, setEngine] = useState<MediabunnyEngine | null>(null)

  const [selectedAudioTrackId, setSelectedAudioTrackId] = useState<
    string | null
  >(null)

  // The probe opens containers; a playlist is not one, and fetching it just
  // to fail would waste a round trip against a signed URL. The stage is
  // keyed by source URL, so the source kind never changes within a mount.
  const hlsSource = isHlsUrl(source.url)

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

  const nativeMediaRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    onProbe(probeState)
  }, [probeState, onProbe])

  useEffect(() => {
    onModeChange(mode)
  }, [mode, onModeChange])

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
  }, [mode, source.url, hlsSource])

  const audioTracks = useMemo(() => {
    if (probeState.status !== "ready") {
      return []
    }

    return probeState.result.tracks
      .filter((track) => track.kind === "audio")
      .map((track) => ({
        id: `${track.kind}-${track.number}`,
        label: probeTrackLabel(track),
        // canDecode reflects the browser's own decoders: an E-AC-3/AC-3
        // track reports false until the engine lazily registers its WASM
        // decoder, so a false default track still needs the engine.
        nativeDecodable: track.decodable,
      }))
  }, [probeState])

  const defaultAudioTrackId = audioTracks[0]?.id ?? null
  const effectiveSelectedId = selectedAudioTrackId ?? defaultAudioTrackId

  const migrateToEngine = useCallback(
    (nextAudioTrackId: string | null, element: HTMLVideoElement | null) => {
      setSnapshot({
        time: element?.currentTime ?? 0,
        wasPlaying: element !== null && !element.paused,
        volume: element?.volume ?? 1,
        muted: element?.muted ?? false,
        playbackRate: element?.playbackRate ?? 1,
        audioTrackId: nextAudioTrackId,
      })
      setMode("mediabunny")

      if (nextAudioTrackId !== null) {
        setSelectedAudioTrackId(nextAudioTrackId)
      }
    },
    []
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
    [audioTracks, effectiveSelectedId, engine, mode, migrateToEngine]
  )

  const onNativeError = useCallback(() => {
    // HLS failures stay in the video.js pipeline (the error dialog handles
    // them); the mediabunny engine cannot demux playlists, so migrating a
    // playlist source there would only produce a second failure.
    if (mode !== "native" || hlsSource) {
      return
    }

    migrateToEngine(effectiveSelectedId, nativeMediaRef.current)
  }, [effectiveSelectedId, hlsSource, mode, migrateToEngine])

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

  const tracksValue = useMemo<AudioTracksValue>(
    () => ({
      tracks: audioTracks,
      selectedId: effectiveSelectedId,
      selectTrack,
    }),
    [audioTracks, effectiveSelectedId, selectTrack]
  )

  return (
    <AudioTracksContext.Provider value={tracksValue}>
      {mode === "native" ? (
        <VideoPlayer key="native">
          <VideoSkin className="aspect-video w-full">
            {hlsSource ? (
              <LazyHlsVideo
                sourceUrl={source.url}
                videoRef={nativeMediaRef}
                onError={onNativeError}
              />
            ) : (
              <Video
                ref={nativeMediaRef}
                playsInline
                preload="metadata"
                onError={onNativeError}
              />
            )}
          </VideoSkin>
        </VideoPlayer>
      ) : (
        <VideoPlayer key="mediabunny">
          <VideoSkin className="aspect-video w-full">
            <MediabunnyVideo init={engineInit} onEngine={setEngine} />
          </VideoSkin>
        </VideoPlayer>
      )}
    </AudioTracksContext.Provider>
  )
}

// HLS media element, loaded on demand so hls.js never downloads for a
// progressive source. The component mounts first and the source is assigned
// afterwards: assigning via props during render starts loading before the
// adapter has attached its media element, and fatal manifest errors are
// dropped in that window — a dead link then spins forever instead of
// reaching the error dialog.
//
// No preferPlayback and no crossOrigin: hls.js over MSE wherever MSE exists
// (renditions and quality selection need it), platform HLS only where MSE is
// unavailable (iOS Safari), and crossOrigin breaks cross-origin native
// playback.
function LazyHlsVideo({
  sourceUrl,
  videoRef,
  onError,
}: {
  sourceUrl: string
  videoRef: React.RefObject<HTMLVideoElement | null>
  onError: () => void
}) {
  const [videoComponent, setVideoComponent] =
    useState<HlsJsVideoComponent | null>(null)

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
    if (videoComponent !== null && adapterRef.current !== null) {
      adapterRef.current.source = { src: sourceUrl }
    }
  }, [videoComponent, sourceUrl])

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
