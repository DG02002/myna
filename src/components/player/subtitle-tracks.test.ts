import assert from "node:assert/strict"
import { test } from "node:test"

import {
  MatroskaSubtitleError,
  type MatroskaSubtitleReader,
} from "#/media/matroska-subtitles"
import type { SubtitleTrack } from "#/media/subtitles"

import {
  startExternalSubtitleLoad,
  startEmbeddedSubtitleLoad,
  SubtitleLoadManager,
} from "./subtitle-tracks"

function createTrack(id = "matroska-2"): SubtitleTrack {
  return {
    id,
    label: "English",
    language: "en",
    source: {
      kind: "matroska",
      trackNumber: 2,
      codecId: "S_TEXT/UTF8",
    },
    status: "available",
    cues: [],
  }
}

function createHarness(streamCues: MatroskaSubtitleReader["streamCues"]) {
  let tracks = [createTrack()]
  const manager = new SubtitleLoadManager()

  // SAFETY: This focused reader fake is only consumed through streamCues.
  const reader = { streamCues } as MatroskaSubtitleReader

  const setTracks = (
    update: (currentTracks: SubtitleTrack[]) => SubtitleTrack[]
  ) => {
    tracks = update(tracks)
  }

  const start = (targetTime: number) =>
    startEmbeddedSubtitleLoad({
      track: tracks[0],
      reader,
      loadManager: manager,
      targetTime,
      setTracks,
      setAssTrackStream: () => {},
      setAssTrackStreamId: () => {},
      setPgsSession: () => {},
      setPgsTrackSessionId: () => {},
    })

  return {
    get tracks() {
      return tracks
    },
    manager,
    start,
  }
}

void test("publishes current UTF8 cues before finishing and retains partial coverage", async () => {
  let deliverFirstCue!: () => void
  let releaseLaterRead!: () => void

  const firstCueDelivered = new Promise<void>((resolve) => {
    deliverFirstCue = resolve
  })

  const laterRead = new Promise<void>((resolve) => {
    releaseLaterRead = resolve
  })

  const harness = createHarness(async function* ({ targetTime, signal }) {
    assert.equal(targetTime, 301)
    yield [{ startTime: 300, endTime: 304, text: "Current caption" }]
    deliverFirstCue()
    await laterRead

    if (!signal.aborted) {
      throw new MatroskaSubtitleError("deadline")
    }
  })

  const loading = harness.start(301)

  assert.ok(loading)

  try {
    await firstCueDelivered
    assert.equal(harness.tracks[0]?.status, "loading")
    assert.deepEqual(harness.tracks[0]?.cues, [
      { startTime: 300, endTime: 304, text: "Current caption" },
    ])
  } finally {
    releaseLaterRead()
  }

  await loading
  assert.equal(harness.tracks[0]?.status, "incomplete")
  assert.equal(harness.tracks[0]?.failure?.kind, "timeout")
  assert.deepEqual(harness.tracks[0]?.coverage, undefined)
  assert.equal(harness.tracks[0]?.cues[0]?.startTime, 300)
  harness.manager.dispose()
})

void test("cancels a selected UTF8 stream when another track takes ownership", async () => {
  let deliverCurrentCue!: () => void

  const currentCueDelivered = new Promise<void>((resolve) => {
    deliverCurrentCue = resolve
  })

  let releaseAfterAbort!: () => void

  const afterAbort = new Promise<void>((resolve) => {
    releaseAfterAbort = resolve
  })

  const firstSignals: AbortSignal[] = []

  const harness = createHarness(async function* ({ signal }) {
    firstSignals.push(signal)
    yield [{ startTime: 90, endTime: 92, text: "Selected caption" }]
    deliverCurrentCue()
    await afterAbort

    if (!signal.aborted) {
      yield [{ startTime: 91, endTime: 93, text: "Stale caption" }]
    }
  })

  const loading = harness.start(90)

  assert.ok(loading)
  await currentCueDelivered
  harness.manager.startEmbeddedLoad("replacement-track")
  assert.equal(firstSignals[0]?.aborted, true)
  releaseAfterAbort()
  await loading

  assert.deepEqual(harness.tracks[0]?.cues, [
    { startTime: 90, endTime: 92, text: "Selected caption" },
  ])
  harness.manager.dispose()
})

void test("retries a failed external subtitle with its original URL", async () => {
  const originalFetch = globalThis.fetch
  const id = "external-subtitle"
  const url = "https://subtitles.example/movie.en.vtt"
  const manager = new SubtitleLoadManager()

  let track: SubtitleTrack = {
    id,
    label: "movie",
    language: "en",
    source: { kind: "external" },
    status: "loading",
    cues: [],
  }

  let fetchCount = 0

  const waiters = new Map<
    SubtitleTrack["status"],
    (nextTrack: SubtitleTrack) => void
  >()

  const setTracks = (
    update: (currentTracks: SubtitleTrack[]) => SubtitleTrack[]
  ) => {
    const [nextTrack] = update([track])

    if (nextTrack === undefined) {
      return
    }

    track = nextTrack
    waiters.get(track.status)?.(track)
    waiters.delete(track.status)
  }

  const waitForStatus = (status: SubtitleTrack["status"]) =>
    new Promise<SubtitleTrack>((resolve) => {
      waiters.set(status, resolve)

      if (track.status === status) {
        resolve(track)
      }
    })

  globalThis.fetch = async () => {
    fetchCount += 1

    return fetchCount === 1
      ? new Response(null, {
          status: 503,
          headers: { "Retry-After": "7" },
        })
      : new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nRetry caption", {
          status: 200,
          headers: { "Content-Type": "text/vtt" },
        })
  }

  try {
    const failed = waitForStatus("failed")

    startExternalSubtitleLoad({
      id,
      url,
      controller: new AbortController(),
      loadManager: manager,
      setTracks,
    })

    const failedTrack = await failed

    assert.equal(failedTrack.failure?.kind, "http")
    assert.equal(failedTrack.failure?.status, 503)
    assert.equal(failedTrack.failure?.retryAfterMs, 7_000)

    track = {
      ...track,
      status: "loading",
      failure: undefined,
      loadProgress: undefined,
    }

    const ready = waitForStatus("ready")

    startExternalSubtitleLoad({
      id,
      url,
      controller: new AbortController(),
      loadManager: manager,
      setTracks,
    })

    const readyTrack = await ready

    assert.equal(fetchCount, 2)
    assert.deepEqual(readyTrack.cues, [
      { startTime: 1, endTime: 2, text: "Retry caption" },
    ])
  } finally {
    manager.dispose()
    globalThis.fetch = originalFetch
  }
})
