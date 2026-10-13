import type { AdvancedReadFailureKind } from "../read-policy"

type MediaDiagnosticStage =
  | "source"
  | "audio"
  | "video"
  | "seek"
  | "subtitle"
  | "resume"
  | "playback"

type MediaDiagnosticEvent =
  | "loading"
  | "ready"
  | "failed"
  | "canceled"
  | "rate-change"
  | "buffer-trimmed"
  | "gap"
  | "end-of-stream"
  | "retry"
  | "seeking"
  | "seeked"
  | "priming"
  | "primed"
  | "prime-failed"
  | "prime-buffer-limit"
  | "underrun"
  | "underrun-recovered"

export interface MediaDiagnosticRecord {
  atMs: number
  stage: MediaDiagnosticStage
  event: MediaDiagnosticEvent
  mediaTime?: number
  playbackRate?: number
  errorCode?: number
  httpStatus?: number
  retryAfterMs?: number
  readErrorKind?: AdvancedReadFailureKind
  retryAttempt?: number
  operationId?: number
  byteCount?: number
  rangeStart?: number
}

export type MediaDiagnosticInput = Omit<MediaDiagnosticRecord, "atMs">

const MAX_MEDIA_DIAGNOSTIC_RECORDS = 100

export class MediaDiagnostics {
  private records: MediaDiagnosticRecord[] = []

  constructor(private readonly now: () => number = () => Date.now()) {}

  record(input: MediaDiagnosticInput): void {
    this.records.push({ ...input, atMs: this.now() })

    if (this.records.length > MAX_MEDIA_DIAGNOSTIC_RECORDS) {
      this.records.splice(0, this.records.length - MAX_MEDIA_DIAGNOSTIC_RECORDS)
    }
  }

  snapshot(): MediaDiagnosticRecord[] {
    return this.records.map((record) => ({ ...record }))
  }
}
