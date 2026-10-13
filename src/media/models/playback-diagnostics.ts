import type { ProbeFailure, ProbeResult } from "../probe/metadata-probe"
import type { SubtitleTrack } from "../subtitles"
import type { MediaDiagnosticRecord } from "./diagnostics"

const MAX_DIAGNOSTIC_RECORDS = 100

const MAX_CODEC_LABEL_LENGTH = 128

export interface PlaybackDiagnosticSnapshotInput {
  sessionId: string
  engineMode: string
  readMode: string
  playbackState: string
  currentTimeSeconds: number | null
  requestedResumeSeconds: number
  confirmedResumeSeconds: number
  playbackRate: number
  bufferedAheadSeconds: number | null
  decodedVideoThroughSeconds: number | null
  nativeErrorCode: number | null
  probeResult: ProbeResult | null
  probeFailure: ProbeFailure | null
  subtitleTracks: readonly SubtitleTrack[]
  records: readonly MediaDiagnosticRecord[]
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null
}

function safeLabel(value: string): string {
  let safe = ""

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0

    if (codePoint <= 31 || codePoint === 127) {
      continue
    }

    if (safe.length + character.length > MAX_CODEC_LABEL_LENGTH) {
      break
    }

    safe += character
  }

  return safe
}

export function createPlaybackDiagnosticSnapshot(
  input: PlaybackDiagnosticSnapshotInput
) {
  const records = input.records.slice(-MAX_DIAGNOSTIC_RECORDS)

  const firstRecordTime = records[0]?.atMs ?? 0

  const readEvents = records.filter(
    (record) => record.readErrorKind !== undefined
  )

  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    engineMode: safeLabel(input.engineMode),
    readMode: safeLabel(input.readMode),
    playback: {
      state: safeLabel(input.playbackState),
      currentTimeSeconds: finiteOrNull(input.currentTimeSeconds),
      requestedResumeSeconds: finiteOrNull(input.requestedResumeSeconds),
      confirmedResumeSeconds: finiteOrNull(input.confirmedResumeSeconds),
      playbackRate: finiteOrNull(input.playbackRate),
      bufferedAheadSeconds: finiteOrNull(input.bufferedAheadSeconds),
      decodedVideoThroughSeconds: finiteOrNull(
        input.decodedVideoThroughSeconds
      ),
      nativeErrorCode: input.nativeErrorCode,
    },
    media: {
      container: input.probeResult?.containerName
        ? safeLabel(input.probeResult.containerName)
        : null,
      metadataReadMode: input.probeResult?.readMode ?? null,
      durationSeconds: finiteOrNull(input.probeResult?.durationSeconds ?? null),
      codecs: [
        ...new Set(
          (input.probeResult?.tracks ?? [])
            .map((track) => track.codecParameterString)
            .filter((codec): codec is string => codec !== null)
            .map(safeLabel)
        ),
      ],
    },
    probeFailure:
      input.probeFailure === null
        ? null
        : {
            stage: "source",
            readMode: input.probeFailure.readMode,
            category: input.probeFailure.kind,
            httpStatus: input.probeFailure.status,
            retryAfterMs: input.probeFailure.retryAfterMs,
            attempts: input.probeFailure.attempts,
            events: input.probeFailure.diagnostics.map((record) => ({
              stage: "source",
              event: record.event,
              category: record.kind,
              attempt: record.attempt,
              rangeStart: record.rangeStart,
              bytesReceived: record.byteCount,
              httpStatus: record.status,
              retryAfterMs: record.retryAfterMs,
            })),
          },
    subtitles: input.subtitleTracks.map((track) => ({
      kind: track.source.kind,
      codec:
        track.source.kind === "matroska"
          ? safeLabel(track.source.codecId)
          : null,
      status: track.status,
      coverage: track.coverage
        ? {
            startTimeSeconds: finiteOrNull(track.coverage.startTime),
            endTimeSeconds: finiteOrNull(track.coverage.endTime),
          }
        : null,
      failure: track.failure?.kind ?? null,
      httpStatus: track.failure?.status ?? null,
      retryAfterMs: track.failure?.retryAfterMs ?? null,
    })),
    reads: {
      retryEvents: readEvents.filter((record) => record.event === "retry")
        .length,
      failedEvents: readEvents.filter((record) => record.event === "failed")
        .length,
      bytesSeenInReadEvents: readEvents.reduce(
        (total, record) => total + (record.byteCount ?? 0),
        0
      ),
      ranges: readEvents.map((record) => ({
        event: record.event,
        category: record.readErrorKind,
        attempt: record.retryAttempt ?? null,
        startByte: record.rangeStart ?? null,
        bytesReceived: record.byteCount ?? 0,
        httpStatus: record.httpStatus ?? null,
        retryAfterMs: record.retryAfterMs ?? null,
      })),
    },
    events: records.map((record) => ({
      afterStartMs: Math.max(0, record.atMs - firstRecordTime),
      stage: record.stage,
      event: record.event,
      mediaTimeSeconds: finiteOrNull(record.mediaTime ?? null),
      playbackRate: finiteOrNull(record.playbackRate ?? null),
      errorCode: record.errorCode ?? null,
      httpStatus: record.httpStatus ?? null,
      retryAfterMs: record.retryAfterMs ?? null,
      readErrorKind: record.readErrorKind ?? null,
      retryAttempt: record.retryAttempt ?? null,
      operationId: record.operationId ?? null,
      rangeStart: record.rangeStart ?? null,
      byteCount: record.byteCount ?? null,
    })),
  }
}
