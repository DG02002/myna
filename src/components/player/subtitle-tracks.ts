import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react"

import { MediabunnyMediaAdapter } from "#/media/engines/mediabunny-adapter"
import {
  createMatroskaSubtitleReader,
  type MatroskaAssTrackStream,
  type MatroskaSubtitleReader,
} from "#/media/matroska-subtitles"
import {
  loadSubtitleCues,
  subtitleTrackName,
  type SubtitleTrack,
} from "#/media/subtitles"

export interface SubtitleTracksState {
  tracks: SubtitleTrack[]
  selectedId: string | null
  selectedTrack: SubtitleTrack | undefined
  addSubtitle: (url: string) => void
  restoreSelection: (id: string | null) => void
  assTrackStream: MatroskaAssTrackStream | null
  failSubtitle: (id: string) => void
  embeddedProbeFailed: boolean
}

type SubtitleMedia = HTMLVideoElement | MediabunnyMediaAdapter

interface EmbeddedSubtitleLoad {
  id: string
  controller: AbortController
}

type SetSubtitleTracks = (
  update: (currentTracks: SubtitleTrack[]) => SubtitleTrack[]
) => void

type SetAssTrackStream = (stream: MatroskaAssTrackStream | null) => void

type SetAssTrackStreamId = (id: string | null) => void

function useEmbeddedSubtitleState() {
  const [assTrackStream, setAssTrackStream] =
    useState<MatroskaAssTrackStream | null>(null)

  const [assTrackStreamId, setAssTrackStreamId] = useState<string | null>(null)

  const [nativeBrowserTrackIds, setNativeBrowserTrackIds] = useState<
    Set<string>
  >(() => new Set())

  const [reader, setReader] = useState<MatroskaSubtitleReader | null>(null)
  const [embeddedProbeFailed, setEmbeddedProbeFailed] = useState(false)

  return {
    assTrackStream,
    setAssTrackStream,
    assTrackStreamId,
    setAssTrackStreamId,
    nativeBrowserTrackIds,
    setNativeBrowserTrackIds,
    reader,
    setReader,
    embeddedProbeFailed,
    setEmbeddedProbeFailed,
  }
}

function releaseSelectedSubtitle(
  tracks: SubtitleTrack[],
  selectedId: string | null,
  releasedAssTrackId: string | null
): SubtitleTrack[] {
  return tracks.map((track) => {
    const selectedLoadWasCancelled =
      track.id === selectedId &&
      track.source.kind === "matroska" &&
      track.status === "loading"

    const completedAssTrackWasReleased =
      track.id === releasedAssTrackId &&
      track.source.kind === "matroska" &&
      isAssSubtitleCodec(track.source.codecId) &&
      track.status === "ready"

    return selectedLoadWasCancelled || completedAssTrackWasReleased
      ? { ...track, status: "available" }
      : track
  })
}

function updateEmbeddedSubtitleTrack({
  setTracks,
  id,
  status,
  cues,
}: {
  setTracks: SetSubtitleTracks
  id: string
  status: SubtitleTrack["status"]
  cues?: SubtitleTrack["cues"]
}): void {
  setTracks((currentTracks) =>
    currentTracks.map((track) => {
      if (track.id !== id) {
        return track
      }

      const updatedTrack = { ...track, status }

      if (cues !== undefined) {
        updatedTrack.cues = cues
      }

      return updatedTrack
    })
  )
}

async function loadEmbeddedSubtitleContent({
  track,
  reader,
  signal,
  setTracks,
  setAssTrackStream,
  setAssTrackStreamId,
}: {
  track: SubtitleTrack
  reader: MatroskaSubtitleReader
  signal: AbortSignal
  setTracks: SetSubtitleTracks
  setAssTrackStream: SetAssTrackStream
  setAssTrackStreamId: SetAssTrackStreamId
}): Promise<void> {
  if (track.source.kind !== "matroska") {
    return
  }

  if (track.source.codecId === "S_TEXT/UTF8") {
    const cues = await reader.readCues(track.source.trackNumber, signal)

    if (!signal.aborted) {
      updateEmbeddedSubtitleTrack({
        setTracks,
        id: track.id,
        status: "ready",
        cues,
      })
    }

    return
  }

  const stream = reader.streamAssTrack(track.source.trackNumber, signal)

  setAssTrackStream(stream)
  setAssTrackStreamId(track.id)
  await stream.result

  if (!signal.aborted) {
    updateEmbeddedSubtitleTrack({
      setTracks,
      id: track.id,
      status: "ready",
      cues: [],
    })
  }
}

async function loadEmbeddedSubtitle({
  track,
  reader,
  embeddedLoad,
  setTracks,
  setAssTrackStream,
  setAssTrackStreamId,
}: {
  track: SubtitleTrack
  reader: MatroskaSubtitleReader
  embeddedLoad: RefObject<EmbeddedSubtitleLoad | null>
  setTracks: SetSubtitleTracks
  setAssTrackStream: SetAssTrackStream
  setAssTrackStreamId: SetAssTrackStreamId
}): Promise<void> {
  if (track.source.kind !== "matroska") {
    return
  }

  const load = embeddedLoad.current

  if (load === null || load.id !== track.id) {
    return
  }

  const { signal } = load.controller

  updateEmbeddedSubtitleTrack({
    setTracks,
    id: track.id,
    status: "loading",
  })

  try {
    await loadEmbeddedSubtitleContent({
      track,
      reader,
      signal,
      setTracks,
      setAssTrackStream,
      setAssTrackStreamId,
    })
  } catch {
    if (!signal.aborted) {
      setAssTrackStream(null)
      setAssTrackStreamId(null)
      updateEmbeddedSubtitleTrack({
        setTracks,
        id: track.id,
        status: "failed",
      })
    }
  } finally {
    if (embeddedLoad.current === load) {
      embeddedLoad.current = null
    }
  }
}

export function startEmbeddedSubtitleLoad({
  track,
  reader,
  embeddedLoad,
  setTracks,
  setAssTrackStream,
  setAssTrackStreamId,
}: {
  track: SubtitleTrack
  reader: MatroskaSubtitleReader
  embeddedLoad: RefObject<EmbeddedSubtitleLoad | null>
  setTracks: SetSubtitleTracks
  setAssTrackStream: SetAssTrackStream
  setAssTrackStreamId: SetAssTrackStreamId
}): Promise<void> | undefined {
  if (track.source.kind !== "matroska") {
    return undefined
  }

  const currentLoad = embeddedLoad.current

  if (currentLoad?.id === track.id) {
    return undefined
  }

  currentLoad?.controller.abort()

  const load = { id: track.id, controller: new AbortController() }
  embeddedLoad.current = load

  return loadEmbeddedSubtitle({
    track,
    reader,
    embeddedLoad,
    setTracks,
    setAssTrackStream,
    setAssTrackStreamId,
  })
}

export function useSubtitles({
  useAdvancedEngine,
  nativeMediaRef,
  adapter,
  matroskaUrl,
}: {
  useAdvancedEngine: boolean
  nativeMediaRef: RefObject<HTMLVideoElement | null>
  adapter: MediabunnyMediaAdapter | null
  matroskaUrl: string | null
}): SubtitleTracksState {
  const [tracks, setTracks] = useState<SubtitleTrack[]>([])
  const tracksRef = useRef(tracks)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const {
    assTrackStream,
    setAssTrackStream,
    assTrackStreamId,
    setAssTrackStreamId,
    nativeBrowserTrackIds,
    setNativeBrowserTrackIds,
    reader,
    setReader,
    embeddedProbeFailed,
    setEmbeddedProbeFailed,
  } = useEmbeddedSubtitleState()

  const externalLoads = useRef(new Map<string, AbortController>())

  const embeddedLoad = useRef<EmbeddedSubtitleLoad | null>(null)

  const registeredTracks = useRef(
    new WeakMap<TextTrackList, TextTrackRegistry>()
  )

  useEffect(() => {
    tracksRef.current = tracks
  }, [tracks])

  useEffect(() => {
    return () => cleanupSubtitleLoads(externalLoads, embeddedLoad)
  }, [])

  const addSubtitle = useCallback((url: string) => {
    const id = crypto.randomUUID()
    const name = subtitleTrackName(url, tracksRef.current.length + 1)
    const controller = new AbortController()

    externalLoads.current.set(id, controller)
    setTracks((currentTracks) => [
      ...currentTracks,
      {
        id,
        ...name,
        source: { kind: "external" },
        status: "loading",
        cues: [],
      },
    ])

    void loadSubtitleCues(url, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || "aborted" in result) {
          return
        }

        setTracks((currentTracks) =>
          currentTracks.map((track) => {
            if (track.id !== id) {
              return track
            }

            if ("cues" in result) {
              return { ...track, status: "ready", cues: result.cues }
            }

            return { ...track, status: "failed" }
          })
        )
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setTracks((currentTracks) =>
            currentTracks.map((track) =>
              track.id === id ? { ...track, status: "failed" } : track
            )
          )
        }
      })
      .finally(() => externalLoads.current.delete(id))
  }, [])

  const failSubtitle = useCallback(
    (id: string) => {
      if (embeddedLoad.current?.id === id) {
        embeddedLoad.current.controller.abort()
        embeddedLoad.current = null
      }

      setTracks((currentTracks) =>
        currentTracks.map((track) =>
          track.id === id ? { ...track, status: "failed" } : track
        )
      )
      setAssTrackStream(null)
      setAssTrackStreamId(null)
    },
    [setAssTrackStream, setAssTrackStreamId]
  )

  const selectSubtitle = useCallback(
    (id: string | null) => {
      if (id !== selectedId) {
        const releasedId = assTrackStreamId

        embeddedLoad.current?.controller.abort()
        embeddedLoad.current = null

        if (releasedId !== null) {
          setAssTrackStream(null)
          setAssTrackStreamId(null)
        }

        setTracks((currentTracks) =>
          releaseSelectedSubtitle(currentTracks, selectedId, releasedId)
        )
      }

      setSelectedId(id)
    },
    [assTrackStreamId, selectedId, setAssTrackStream, setAssTrackStreamId]
  )

  useEffect(() => {
    if (matroskaUrl === null) {
      return undefined
    }

    const controller = new AbortController()
    const media = nativeMediaRef.current
    let started = false

    const startProbe = () => {
      if (started) {
        return
      }

      started = true
      const nextReader = createMatroskaSubtitleReader(matroskaUrl)

      void nextReader
        .probe(controller.signal)
        .then((embeddedTracks) => {
          if (controller.signal.aborted) {
            return
          }

          setReader(nextReader)
          setEmbeddedProbeFailed(false)

          setTracks((currentTracks) => {
            const existingIds = new Set(currentTracks.map((track) => track.id))

            const additions = embeddedTracks
              .filter((track) => !existingIds.has(track.id))
              .map<SubtitleTrack>((track) => ({
                id: track.id,
                label: track.label,
                language: track.language,
                flags: track.flags,
                source: {
                  kind: "matroska",
                  trackNumber: track.trackNumber,
                  codecId: track.codecId,
                },
                status: "available",
                cues: [],
              }))

            return [...currentTracks, ...additions]
          })
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            // Embedded subtitle probing is optional and never changes playback state.
            setEmbeddedProbeFailed(true)
          }
        })
    }

    if (media === null || media.readyState >= 1 || media.error !== null) {
      startProbe()

      return () => controller.abort()
    }

    media.addEventListener("loadedmetadata", startProbe, { once: true })
    media.addEventListener("error", startProbe, { once: true })

    return () => {
      controller.abort()
      media.removeEventListener("loadedmetadata", startProbe)
      media.removeEventListener("error", startProbe)
    }
  }, [matroskaUrl, nativeMediaRef, setEmbeddedProbeFailed, setReader])

  useEffect(() => {
    const selectedTrack = tracksRef.current.find(
      (track) => track.id === selectedId
    )

    const isEmbeddedText =
      selectedTrack?.source.kind === "matroska" &&
      selectedTrack.source.codecId === "S_TEXT/UTF8"

    const isEmbeddedAss =
      selectedTrack?.source.kind === "matroska" &&
      isAssSubtitleCodec(selectedTrack.source.codecId)

    if (
      selectedId === null ||
      reader === null ||
      selectedTrack === undefined ||
      selectedTrack.source.kind !== "matroska" ||
      selectedTrack.status === "ready" ||
      selectedTrack.status === "failed" ||
      (!isEmbeddedText && !isEmbeddedAss)
    ) {
      return undefined
    }

    if (embeddedLoad.current?.id === selectedId) {
      return undefined
    }

    if (!useAdvancedEngine && isEmbeddedAss) {
      const nativeTracks = nativeMediaRef.current?.textTracks

      const matchedTrack =
        nativeTracks === undefined
          ? undefined
          : registeredTracks.current
              .get(nativeTracks)
              ?.browserMatches.get(selectedId)

      if (matchedTrack !== undefined) {
        return undefined
      }
    }

    void startEmbeddedSubtitleLoad({
      track: selectedTrack,
      reader,
      embeddedLoad,
      setTracks,
      setAssTrackStream,
      setAssTrackStreamId,
    })

    return undefined
  }, [
    nativeMediaRef,
    reader,
    selectedId,
    setAssTrackStream,
    setAssTrackStreamId,
    useAdvancedEngine,
  ])

  useEffect(() => {
    const media: SubtitleMedia | null = useAdvancedEngine
      ? adapter
      : nativeMediaRef.current

    if (media === null) {
      return undefined
    }

    const { textTracks } = media
    const registry = getTextTrackRegistry(registeredTracks.current, textTracks)

    registerSubtitleTracks({
      media,
      tracks,
      registry,
      useAdvancedEngine,
      setTracks,
    })
    setNativeBrowserTrackIds((currentIds) => {
      const nextIds = new Set(registry.browserMatches.keys())

      return areSetsEqual(currentIds, nextIds) ? currentIds : nextIds
    })
    applyTextTrackSelection(registry, selectedId)

    const syncSelection = () => syncSelectedTrack(registry, selectSubtitle)

    textTracks.addEventListener("change", syncSelection)
    syncSelection()

    return () => textTracks.removeEventListener("change", syncSelection)
  }, [
    adapter,
    nativeMediaRef,
    selectSubtitle,
    selectedId,
    setNativeBrowserTrackIds,
    tracks,
    useAdvancedEngine,
  ])

  const selectedTrack = tracks.find((track) => track.id === selectedId)

  const selectedTrackHasNativeRenderer =
    !useAdvancedEngine &&
    selectedId !== null &&
    nativeBrowserTrackIds.has(selectedId)

  const selectedAssTrackStream =
    selectedTrack?.source.kind === "matroska" &&
    isAssSubtitleCodec(selectedTrack.source.codecId) &&
    selectedTrack.status !== "failed" &&
    assTrackStreamId === selectedId &&
    !selectedTrackHasNativeRenderer
      ? assTrackStream
      : null

  return {
    tracks,
    selectedId,
    selectedTrack,
    addSubtitle,
    restoreSelection: selectSubtitle,
    assTrackStream: selectedAssTrackStream,
    failSubtitle,
    embeddedProbeFailed,
  }
}

function isAssSubtitleCodec(codecId: string): boolean {
  return codecId === "S_TEXT/ASS" || codecId === "S_TEXT/SSA"
}

function areSetsEqual<T>(left: Set<T>, right: Set<T>): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  )
}

interface TextTrackRegistry {
  registered: Map<string, TextTrack>
  browserMatches: Map<string, TextTrack>
  populated: Set<string>
}

function getTextTrackRegistry(
  registries: WeakMap<TextTrackList, TextTrackRegistry>,
  textTracks: TextTrackList
): TextTrackRegistry {
  const existing = registries.get(textTracks)

  if (existing !== undefined) {
    return existing
  }

  const registry: TextTrackRegistry = {
    registered: new Map(),
    browserMatches: new Map(),
    populated: new Set(),
  }

  registries.set(textTracks, registry)

  return registry
}

function registerSubtitleTracks({
  media,
  tracks,
  registry,
  useAdvancedEngine,
  setTracks,
}: {
  media: SubtitleMedia
  tracks: SubtitleTrack[]
  registry: TextTrackRegistry
  useAdvancedEngine: boolean
  setTracks: Dispatch<SetStateAction<SubtitleTrack[]>>
}): void {
  const usedBrowserTracks = new Set(registry.browserMatches.values())

  for (const subtitle of tracks) {
    const textTrack = getSubtitleTextTrack({
      media,
      subtitle,
      registry,
      useAdvancedEngine,
      usedBrowserTracks,
      setTracks,
    })

    if (textTrack !== undefined) {
      populateSubtitleTextTrack({ textTrack, subtitle, registry, setTracks })
    }
  }
}

function getSubtitleTextTrack({
  media,
  subtitle,
  registry,
  useAdvancedEngine,
  usedBrowserTracks,
  setTracks,
}: {
  media: SubtitleMedia
  subtitle: SubtitleTrack
  registry: TextTrackRegistry
  useAdvancedEngine: boolean
  usedBrowserTracks: Set<TextTrack>
  setTracks: Dispatch<SetStateAction<SubtitleTrack[]>>
}): TextTrack | undefined {
  let textTrack =
    registry.registered.get(subtitle.id) ??
    registry.browserMatches.get(subtitle.id)

  if (
    textTrack === undefined &&
    subtitle.source.kind === "matroska" &&
    !useAdvancedEngine
  ) {
    textTrack = findNativeTrack(media.textTracks, subtitle, usedBrowserTracks)

    if (textTrack !== undefined) {
      registry.browserMatches.set(subtitle.id, textTrack)
      usedBrowserTracks.add(textTrack)
    }
  }

  const shouldRegister =
    (subtitle.source.kind === "matroska" &&
      (subtitle.source.codecId === "S_TEXT/UTF8" ||
        isAssSubtitleCodec(subtitle.source.codecId)) &&
      subtitle.status !== "failed") ||
    subtitle.status === "ready"

  if (textTrack !== undefined || !shouldRegister) {
    return textTrack
  }

  try {
    const createdTrack =
      media instanceof MediabunnyMediaAdapter
        ? media.addSubtitleTrack(subtitle.label, subtitle.language)
        : media.addTextTrack("subtitles", subtitle.label, subtitle.language)

    registry.registered.set(subtitle.id, createdTrack)

    return createdTrack
  } catch {
    setSubtitleFailed(setTracks, subtitle.id)

    return undefined
  }
}

function populateSubtitleTextTrack({
  textTrack,
  subtitle,
  registry,
  setTracks,
}: {
  textTrack: TextTrack
  subtitle: SubtitleTrack
  registry: TextTrackRegistry
  setTracks: Dispatch<SetStateAction<SubtitleTrack[]>>
}): void {
  if (
    subtitle.status !== "ready" ||
    registry.browserMatches.has(subtitle.id) ||
    registry.populated.has(subtitle.id)
  ) {
    return
  }

  const addedCues: VTTCue[] = []

  try {
    for (const cue of subtitle.cues) {
      const vttCue = new VTTCue(cue.startTime, cue.endTime, cue.text)

      textTrack.addCue(vttCue)
      addedCues.push(vttCue)
    }

    registry.populated.add(subtitle.id)
  } catch {
    for (const cue of addedCues) {
      textTrack.removeCue(cue)
    }

    setSubtitleFailed(setTracks, subtitle.id)
  }
}

function setSubtitleFailed(
  setTracks: Dispatch<SetStateAction<SubtitleTrack[]>>,
  id: string
): void {
  // The effect reports failures from the external TextTrack API.
  setTracks((currentTracks) =>
    currentTracks.map((track) =>
      track.id === id ? { ...track, status: "failed" } : track
    )
  )
}

function cleanupSubtitleLoads(
  externalLoads: RefObject<Map<string, AbortController>>,
  embeddedLoad: RefObject<{
    id: string
    controller: AbortController
  } | null>
): void {
  for (const controller of externalLoads.current.values()) {
    controller.abort()
  }

  embeddedLoad.current?.controller.abort()
  externalLoads.current.clear()
  embeddedLoad.current = null
}

function applyTextTrackSelection(
  registry: TextTrackRegistry,
  selectedId: string | null
): void {
  for (const [id, textTrack] of registry.registered) {
    textTrack.mode = id === selectedId ? "showing" : "disabled"
  }

  for (const [id, textTrack] of registry.browserMatches) {
    textTrack.mode = id === selectedId ? "showing" : "disabled"
  }
}

function syncSelectedTrack(
  registry: TextTrackRegistry,
  selectSubtitle: (id: string | null) => void
): void {
  let nextSelectedId: string | null = null

  for (const [id, textTrack] of registry.registered) {
    if (textTrack.mode === "showing") {
      nextSelectedId = id
      break
    }
  }

  if (nextSelectedId === null) {
    for (const [id, textTrack] of registry.browserMatches) {
      if (textTrack.mode === "showing") {
        nextSelectedId = id
        break
      }
    }
  }

  selectSubtitle(nextSelectedId)
}

function findNativeTrack(
  textTracks: TextTrackList,
  subtitle: SubtitleTrack,
  usedTracks: Set<TextTrack>
): TextTrack | undefined {
  const label = normalizeTrackName(subtitle.label)
  const language = normalizeTrackName(subtitle.language)
  let languageMatch: TextTrack | undefined
  let languageMatchCount = 0

  for (let index = 0; index < textTracks.length; index += 1) {
    const textTrack = textTracks[index]

    if (
      textTrack !== undefined &&
      (textTrack.kind === "subtitles" || textTrack.kind === "captions") &&
      !usedTracks.has(textTrack) &&
      normalizeTrackName(textTrack.label) === label &&
      (language.length === 0 ||
        normalizeTrackName(textTrack.language) === language)
    ) {
      return textTrack
    }

    if (
      language.length > 0 &&
      textTrack !== undefined &&
      (textTrack.kind === "subtitles" || textTrack.kind === "captions") &&
      !usedTracks.has(textTrack) &&
      normalizeTrackName(textTrack.language) === language
    ) {
      languageMatch = textTrack
      languageMatchCount += 1
    }
  }

  return languageMatchCount === 1 ? languageMatch : undefined
}

function normalizeTrackName(value: string): string {
  return value.trim().toLowerCase()
}
