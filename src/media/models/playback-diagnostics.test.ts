import assert from "node:assert/strict"
import test from "node:test"

import type { ProbeResult } from "../probe/metadata-probe"
import { createPlaybackDiagnosticSnapshot } from "./playback-diagnostics"

const probeResult: ProbeResult = {
  containerName: "Matroska",
  durationSeconds: 600,
  readMode: "direct",
  tracks: [
    {
      number: 1,
      kind: "video",
      codecParameterString: "V_MPEG4/ISO/AVC",
      languageCode: "und",
      name: "Private title",
      decodable: true,
      default: true,
      displayWidth: 1920,
      displayHeight: 1080,
      channels: null,
      sampleRate: null,
    },
  ],
}

void test("playback diagnostic snapshots contain bounded safe read context", () => {
  const snapshot = createPlaybackDiagnosticSnapshot({
    sessionId: "session-opaque",
    engineMode: "mediabunny",
    readMode: "proxy",
    playbackState: "failed",
    currentTimeSeconds: 301,
    requestedResumeSeconds: 301,
    confirmedResumeSeconds: 300.5,
    playbackRate: 1,
    bufferedAheadSeconds: 0,
    decodedVideoThroughSeconds: 302,
    nativeErrorCode: null,
    probeResult,
    probeFailure: null,
    subtitleTracks: [],
    records: [
      {
        atMs: 1000,
        stage: "source",
        event: "retry",
        readErrorKind: "http",
        retryAttempt: 1,
        httpStatus: 429,
        retryAfterMs: 5000,
        rangeStart: 4096,
        byteCount: 2048,
      },
    ],
  })

  const serialized = JSON.stringify(snapshot)

  assert.equal(snapshot.reads.retryEvents, 1)
  assert.deepEqual(snapshot.reads.ranges[0], {
    event: "retry",
    category: "http",
    attempt: 1,
    startByte: 4096,
    bytesReceived: 2048,
    httpStatus: 429,
    retryAfterMs: 5000,
  })
  assert.equal(snapshot.playback.confirmedResumeSeconds, 300.5)
  assert.equal(snapshot.media.codecs[0], "V_MPEG4/ISO/AVC")
  assert.doesNotMatch(serialized, /Private title|sourceUrl|https?:\/\//i)
})

void test("playback diagnostic snapshots keep only the newest hundred events", () => {
  const records = Array.from({ length: 130 }, (_, index) => ({
    atMs: index,
    stage: "playback" as const,
    event: "priming" as const,
    mediaTime: index,
  }))

  const snapshot = createPlaybackDiagnosticSnapshot({
    sessionId: "session-opaque",
    engineMode: "native",
    readMode: "native-browser",
    playbackState: "paused",
    currentTimeSeconds: 30,
    requestedResumeSeconds: 30,
    confirmedResumeSeconds: 30,
    playbackRate: 1,
    bufferedAheadSeconds: null,
    decodedVideoThroughSeconds: null,
    nativeErrorCode: null,
    probeResult: null,
    probeFailure: null,
    subtitleTracks: [],
    records,
  })

  assert.equal(snapshot.events.length, 100)
  assert.equal(snapshot.events[0]?.mediaTimeSeconds, 30)
  assert.equal(snapshot.events[99]?.mediaTimeSeconds, 129)
})

void test("playback diagnostics retain safe native probe failure details", () => {
  const snapshot = createPlaybackDiagnosticSnapshot({
    sessionId: "session-opaque",
    engineMode: "native",
    readMode: "native-browser",
    playbackState: "paused",
    currentTimeSeconds: 0,
    requestedResumeSeconds: 0,
    confirmedResumeSeconds: 0,
    playbackRate: 1,
    bufferedAheadSeconds: null,
    decodedVideoThroughSeconds: null,
    nativeErrorCode: null,
    probeResult: null,
    probeFailure: {
      kind: "http",
      status: 503,
      retryAfterMs: 5000,
      readMode: "direct",
      attempts: 3,
      diagnostics: [
        {
          event: "retry",
          kind: "http",
          attempt: 2,
          rangeStart: 0,
          status: 503,
          retryAfterMs: 5000,
          byteCount: 0,
        },
        {
          event: "failed",
          kind: "http",
          attempt: 3,
          rangeStart: 0,
          status: 503,
          retryAfterMs: 5000,
          byteCount: 0,
        },
      ],
    },
    subtitleTracks: [],
    records: [],
  })

  assert.deepEqual(snapshot.probeFailure, {
    stage: "source",
    readMode: "direct",
    category: "http",
    httpStatus: 503,
    retryAfterMs: 5000,
    attempts: 3,
    events: [
      {
        stage: "source",
        event: "retry",
        category: "http",
        attempt: 2,
        rangeStart: 0,
        bytesReceived: 0,
        httpStatus: 503,
        retryAfterMs: 5000,
      },
      {
        stage: "source",
        event: "failed",
        category: "http",
        attempt: 3,
        rangeStart: 0,
        bytesReceived: 0,
        httpStatus: 503,
        retryAfterMs: 5000,
      },
    ],
  })
})
