import { PgsDisplaySetInspector, type PgsDisplaySet } from "./pgs-subtitles"
import { proxiedMediaUrl } from "./proxy/proxied-url"
import type { SubtitleCue, SubtitleTrackFlags } from "./subtitles"

// Parsing ranges is deliberately sequential: each next EBML offset depends on
// the previous element header, and reads share one strict request budget.
// oxlint-disable no-await-in-loop -- Do not parallelize cursor traversal.

interface MatroskaTextTrack {
  id: string
  trackNumber: number
  codecId: string
  label: string
  language: string
  flags: SubtitleTrackFlags
  hasContentEncodings: boolean
}

interface MatroskaAssPacket {
  data: Uint8Array
  startTime: number
  duration: number
}

interface MatroskaAssTrackMetadata {
  codecPrivate: Uint8Array
  fonts: Uint8Array[]
}

interface MatroskaAssTrackData {
  codecPrivate: Uint8Array
  packets: MatroskaAssPacket[]
  fonts: Uint8Array[]
}

export interface MatroskaAssTrackStream {
  metadata: Promise<MatroskaAssTrackMetadata>
  result: Promise<MatroskaAssTrackData>
  subscribePackets(listener: (packets: MatroskaAssPacket[]) => void): () => void
}

export interface MatroskaSubtitleReadProgress {
  completed: number
  total: number
}

export interface MatroskaSubtitleReader {
  probe(signal: AbortSignal): Promise<MatroskaTextTrack[]>
  readCues(
    trackNumber: number,
    signal: AbortSignal,
    onProgress?: (progress: MatroskaSubtitleReadProgress) => void
  ): Promise<SubtitleCue[]>
  streamPgsTrack(
    trackNumber: number,
    signal: AbortSignal
  ): AsyncIterable<MatroskaPgsPacket>
  streamPgsWindow(
    trackNumber: number,
    targetTime: number,
    signal: AbortSignal
  ): AsyncIterable<MatroskaPgsWindowEvent>
  streamAssTrack(
    trackNumber: number,
    signal: AbortSignal,
    onProgress?: (progress: MatroskaSubtitleReadProgress) => void
  ): MatroskaAssTrackStream
  readAssTrack(
    trackNumber: number,
    signal: AbortSignal
  ): Promise<MatroskaAssTrackData>
}

export interface MatroskaPgsPacket {
  data: Uint8Array
  startTime: number
  duration: number | null
  location: {
    clusterPosition: number
    blockOffset: number
    segmentOffset: number
  }
}

export type MatroskaPgsWindowEvent =
  | { kind: "boundary"; boundaryTime: number }
  | { kind: "packet"; packet: MatroskaPgsPacket }
  | { kind: "coverage"; coverageTime: number; complete: false }

interface PgsTrackProgress {
  packetCount: number
  packetBytes: number
  lastPacketTime: number | undefined
}

interface PgsWindowInspection {
  boundaryPacketIndex: number | null
  boundaryTime: number | null
  nextEventTime: number | null
  lastTrustedTime: number | null
  stopPacketIndex: number | null
}

interface PgsWindowCueEntry {
  time: number
  position: TrackPosition
}

interface PgsWindowCueReadResult {
  packets: MatroskaPgsPacket[]
  cluster: ElementHeader
  position: TrackPosition
  blockEnd: number
}

interface PgsWindowGapRequest {
  metadata: ParsedFile
  trackNumber: number
  previous: PgsWindowCueReadResult
  current: PgsWindowCueReadResult
  cueClusterPositions: Map<number, TrackPosition[]>
  signal: AbortSignal
}

interface PgsWindowCueIndex {
  cueEntries: PgsWindowCueEntry[]
  cueClusterPositions: Map<number, TrackPosition[]>
  targetCueIndex: number
}

interface PgsWindowSeed extends PgsWindowCueIndex {
  boundaryCueIndex: number
  packets: MatroskaPgsPacket[]
  inspection: PgsWindowInspection
}

interface PgsWindowForwardPlan extends PgsWindowSeed {
  forwardCueIndex: number
}

interface PgsWindowInspectionState {
  earlierBoundary: { index: number; time: number } | null
  futureBoundary: { index: number; time: number } | null
  nextEventTime: number | null
  stopPacketIndex: number | null
  lastTrustedTime: number | null
}

interface PgsTrackFailureContext {
  failure: MatroskaSubtitleError | null
  signalAborted: boolean
  deadlineExpired: boolean
  lastPacketTime: number | undefined
}

interface PgsPacketStreamRequest {
  metadata: ParsedFile
  trackNumber: number
  signal: AbortSignal
  progress: PgsTrackProgress
}

export type MatroskaSubtitleFailureKind =
  | "aborted"
  | "deadline"
  | "invalid"
  | "limit"
  | "unsupported"
  | "unreachable"
  | "timeout"

function subtitleErrorMessage(kind: MatroskaSubtitleFailureKind): string {
  switch (kind) {
    case "deadline":
      return "Embedded subtitle extraction timed out."
    case "timeout":
      return "Embedded subtitle range request timed out."
    default:
      return `Embedded subtitles are ${kind}.`
  }
}

export class MatroskaSubtitleError extends Error {
  constructor(
    readonly kind: MatroskaSubtitleFailureKind,
    readonly coverageTime?: number
  ) {
    super(subtitleErrorMessage(kind))

    this.name = "MatroskaSubtitleError"
  }
}

function orderedContentEncodings(
  track: ParsedTrack
): MatroskaContentEncoding[] {
  if (!track.hasContentEncodings) {
    return []
  }

  if (
    track.contentEncodingsUnsupported ||
    track.contentEncodings.length === 0 ||
    track.contentEncodings.length > MAX_CONTENT_ENCODINGS
  ) {
    throw new MatroskaSubtitleError(
      track.contentEncodings.length > MAX_CONTENT_ENCODINGS
        ? "limit"
        : "unsupported"
    )
  }

  const seenOrders = new Set<number>()
  const encodings = [...track.contentEncodings]

  for (const encoding of encodings) {
    if (
      seenOrders.has(encoding.order) ||
      encoding.unsupported ||
      encoding.type !== 0 ||
      encoding.scope !== 1 ||
      encoding.hasEncryption ||
      !encoding.hasCompression ||
      encoding.compressionAlgorithm === null ||
      (encoding.compressionAlgorithm !== 0 &&
        encoding.compressionAlgorithm !== 3) ||
      (encoding.compressionAlgorithm === 0 &&
        encoding.compressionSettings.byteLength > 0)
    ) {
      throw new MatroskaSubtitleError("unsupported")
    }

    seenOrders.add(encoding.order)
  }

  // Matroska applies decoding in descending ContentEncodingOrder.
  // TS lib is ES2022, so toSorted is not available here. This array is local.
  // oxlint-disable-next-line unicorn/no-array-sort
  return encodings.sort((left, right) => right.order - left.order)
}

async function restoreContentEncodings({
  bytes,
  track,
  maximumCompressedBytes,
  maximumDecompressedBytes,
  signal,
}: {
  bytes: Uint8Array
  track: ParsedTrack
  maximumCompressedBytes: number
  maximumDecompressedBytes: number
  signal: AbortSignal
}): Promise<Uint8Array> {
  if (bytes.byteLength > maximumCompressedBytes) {
    throw new MatroskaSubtitleError("limit")
  }

  let restored = bytes

  for (const encoding of orderedContentEncodings(track)) {
    if (signal.aborted) {
      throw new MatroskaSubtitleError("aborted")
    }

    if (encoding.compressionAlgorithm === 0) {
      if (restored.byteLength > maximumCompressedBytes) {
        throw new MatroskaSubtitleError("limit")
      }

      restored = await decompressZlib(
        restored,
        maximumDecompressedBytes,
        signal
      )
      continue
    }

    const size = encoding.compressionSettings.byteLength + restored.byteLength

    if (size > maximumDecompressedBytes) {
      throw new MatroskaSubtitleError("limit")
    }

    const withPrefix = new Uint8Array(size)
    withPrefix.set(encoding.compressionSettings)
    withPrefix.set(restored, encoding.compressionSettings.byteLength)
    restored = withPrefix
  }

  return restored
}

async function decompressZlib(
  bytes: Uint8Array,
  maximumBytes: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  if (signal.aborted) {
    throw new MatroskaSubtitleError("aborted")
  }

  if (typeof DecompressionStream === "undefined") {
    throw new MatroskaSubtitleError("unsupported")
  }

  const stream = new DecompressionStream("deflate")
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const writing = writeZlibInput(writer, bytes)
  const cancelStreams = () => cancelDecompressionStreams(writer, reader)

  signal.addEventListener("abort", cancelStreams, { once: true })

  try {
    const output = await readZlibOutput(reader, maximumBytes, signal)

    if (!(await writing)) {
      throw new MatroskaSubtitleError("invalid")
    }

    return output
  } catch (error) {
    cancelStreams()
    await writing

    throw normalizeZlibFailure(
      error instanceof MatroskaSubtitleError ? error : null,
      signal
    )
  } finally {
    releaseDecompressionStreams({ signal, cancelStreams, writer, reader })
  }
}

function normalizeZlibFailure(
  failure: MatroskaSubtitleError | null,
  signal: AbortSignal
): MatroskaSubtitleError {
  if (signal.aborted) {
    return new MatroskaSubtitleError("aborted")
  }

  return failure ?? new MatroskaSubtitleError("invalid")
}

function releaseDecompressionStreams({
  signal,
  cancelStreams,
  writer,
  reader,
}: {
  signal: AbortSignal
  cancelStreams: () => void
  writer: WritableStreamDefaultWriter<BufferSource>
  reader: ReadableStreamDefaultReader<Uint8Array>
}): void {
  signal.removeEventListener("abort", cancelStreams)
  writer.releaseLock()
  reader.releaseLock()
}

async function writeZlibInput(
  writer: WritableStreamDefaultWriter<BufferSource>,
  bytes: Uint8Array
): Promise<boolean> {
  try {
    const input = new Uint8Array(bytes)
    await writer.write(input)
    await writer.close()

    return true
  } catch {
    return false
  }
}

async function readZlibOutput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let receivedBytes = 0

  while (true) {
    if (signal.aborted) {
      throw new MatroskaSubtitleError("aborted")
    }

    const result = await reader.read()

    if (result.done) {
      break
    }

    receivedBytes += result.value.byteLength

    if (receivedBytes > maximumBytes) {
      throw new MatroskaSubtitleError("limit")
    }

    chunks.push(result.value.slice())
  }

  return concatenateChunks(chunks, receivedBytes)
}

function cancelDecompressionStreams(
  writer: WritableStreamDefaultWriter<BufferSource>,
  reader: ReadableStreamDefaultReader<Uint8Array>
): void {
  // The caller keeps the decode or abort failure as the reported error.
  void writer.abort().catch(() => {})
  void reader.cancel().catch(() => {})
}

function normalizePgsTrackFailure({
  failure,
  signalAborted,
  deadlineExpired,
  lastPacketTime,
}: PgsTrackFailureContext): MatroskaSubtitleError {
  if (signalAborted) {
    return new MatroskaSubtitleError("aborted", lastPacketTime)
  }

  if (
    deadlineExpired &&
    failure instanceof MatroskaSubtitleError &&
    failure.kind === "aborted"
  ) {
    return new MatroskaSubtitleError("deadline", lastPacketTime)
  }

  if (failure instanceof MatroskaSubtitleError) {
    return new MatroskaSubtitleError(
      failure.kind,
      failure.coverageTime ?? lastPacketTime
    )
  }

  return new MatroskaSubtitleError("unreachable", lastPacketTime)
}

function normalizeTextTrackFailure(
  failure: MatroskaSubtitleError,
  deadlineExpired: boolean
): MatroskaSubtitleError {
  if (deadlineExpired && failure.kind === "aborted") {
    return new MatroskaSubtitleError("deadline")
  }

  return failure
}

function reportSubtitleReadProgress(
  onProgress: ((progress: MatroskaSubtitleReadProgress) => void) | undefined,
  completed: number,
  total: number
): void {
  if (total > 0) {
    onProgress?.({ completed: Math.min(total, completed), total })
  }
}

const PAGE_SIZE = 8 * 1024

const MAX_RANGE_BYTES = 8 * 1024 * 1024

const MAX_RANGE_REQUESTS = 1024

// A selected text track can point to many sparse 8 KiB cluster pages. Keep a
// separate bounded budget for that selected track instead of raising every
// reader.
const MAX_TEXT_TRACK_RANGE_BYTES = 32 * 1024 * 1024

const MAX_TEXT_TRACK_RANGE_REQUESTS = 4096

const MAX_CACHED_BYTES = 1024 * 1024

const MAX_METADATA_SCAN_BYTES = 1024 * 1024

const MAX_CUES_ELEMENT_BYTES = 4 * 1024 * 1024

const CUE_INDEX_PAGE_SIZE = 64 * 1024

const MAX_CUE_INDEX_RANGE_BYTES =
  MAX_CUES_ELEMENT_BYTES + CUE_INDEX_PAGE_SIZE * 2

const MAX_SUBTITLE_CUES = 50_000

const MAX_SUBTITLE_TEXT_BYTES = 4 * 1024 * 1024

const MAX_BLOCK_BYTES = 64 * 1024

const MAX_CONTENT_ENCODINGS = 4

const MAX_CONTENT_ENCODING_SETTINGS_BYTES = MAX_BLOCK_BYTES

const MAX_CODEC_PRIVATE_BYTES = 256 * 1024

const MAX_ASS_PACKET_BYTES = 4 * 1024 * 1024

// Latency-bound origins pay a full round-trip per range request almost
// independently of its size. Two MiB pages keep a ~10 MiB Cluster to a handful
// of requests while sparse cue reads avoid intervening clusters.
const PGS_PAGE_SIZE = 2 * 1024 * 1024

const LARGE_FILE_PGS_PAGE_THRESHOLD = 8 * 1024 * 1024 * 1024

// The 2 MiB trace exhausted 128 MiB before reaching a state boundary across
// ~9 MiB clusters. Give REMUX files a larger fixed ceiling for boundary scans.
const MAX_PGS_RANGE_BYTES = 128 * 1024 * 1024

const LARGE_FILE_MAX_PGS_RANGE_BYTES = 1024 * 1024 * 1024

const MAX_PGS_RANGE_REQUESTS = 2048

const MAX_PGS_TRACK_BYTES = 32 * 1024 * 1024

const MAX_PGS_TRACK_PACKETS = 50_000

// A Matroska Block can contain a complete display set made of several PGS
// segments. Bound the selected Block itself; an A/V-heavy Cluster is still
// traversed child-by-child so its unrelated payload is never buffered.
const MAX_PGS_BLOCK_BYTES = 4 * 1024 * 1024

const MAX_PGS_NO_CUES_SCAN_BYTES = 4 * 1024 * 1024

// Cue positions are byte locations, not decoder restart points. Scan nearby
// physical gaps to recover omitted state, but do not walk hundreds of MB of
// unrelated A/V before the first selected Cue or between sparse subtitle Cues.
const MAX_PGS_LEADING_GAP_BYTES = 4 * 1024 * 1024

const MAX_PGS_PHYSICAL_GAP_BYTES = 64 * 1024 * 1024

const MAX_PGS_BOUNDARY_SEARCH_CUES = 256

const MAX_PGS_BOUNDARY_SEARCH_SECONDS = 120

const MIN_PGS_WINDOW_COVERAGE_SECONDS = 10

const MAX_PGS_WINDOW_FORWARD_SECONDS = 120

// No-progress bound for one target window: the timer extends while window
// pages keep arriving, so slow-but-delivering origins finish and only a
// stalled source aborts. Total work stays capped by the byte and request
// budgets.
const MAX_PGS_WINDOW_DEADLINE_MS = 30_000

const MAX_PGS_WINDOW_GAP_BYTES = 64 * 1024 * 1024

// Windows share these pages so sparse-Cue recovery does not refetch the same
// physical gap on every playback window.
const MAX_PGS_CACHED_BYTES = 32 * 1024 * 1024

const PGS_CLUSTER_READ_WINDOW = 6

const PGS_TRACK_DEADLINE_MS = 240_000

// Bound active reads and ordered results while keeping slow sources moving.
const INDEXED_CLUSTER_READ_CONCURRENCY = 12

const INDEXED_CLUSTER_READ_WINDOW = INDEXED_CLUSTER_READ_CONCURRENCY * 2

// Contiguous parse walks (cluster children, window gaps) know their full byte
// span before parsing. Fetch that span's pages a few at a time ahead of the
// sequential cursor so latency-bound origins overlap round-trips instead of
// paying one per page. Every prefetched page is inside the span the parser is
// about to walk, so this is pipelining, not speculation.
const PAGE_PREFETCH_CONCURRENCY = 4

const MAX_ASS_FONT_BYTES = 32 * 1024 * 1024

const MAX_ASS_FONT_FILE_BYTES = 24 * 1024 * 1024

const MAX_ASS_FONT_FILES = 128

const MAX_ASS_RANGE_BYTES = 48 * 1024 * 1024

const ASS_PAGE_SIZE = 64 * 1024

const MAX_ASS_RANGE_REQUESTS = 1024

// No-progress bound for a selected ASS track: the timer resets as indexed
// cluster reads complete, so slow-but-healthy proxy paths finish while total
// work stays capped by the byte and request budgets.
const ASS_TRACK_DEADLINE_MS = 240_000

const MAX_CLUSTER_SCAN_BYTES = 4 * 1024 * 1024

const RANGE_DEADLINE_MS = 10_000

// Hundreds of sparse subtitle ranges can exceed two minutes through the
// browser's six HTTP/1 connections, even when every upstream read is healthy.
const TRACK_DEADLINE_MS = 240_000

const MAX_EBML_CHILDREN = 100_000

const EBML = 0x1a45dfa3

const SEGMENT = 0x18538067

const SEEK_HEAD = 0x114d9b74

const SEEK = 0x4dbb

const SEEK_ID = 0x53ab

const SEEK_POSITION = 0x53ac

const INFO = 0x1549a966

const TIMESTAMP_SCALE = 0x2ad7b1

const TRACKS = 0x1654ae6b

const ATTACHMENTS = 0x1941a469

const ATTACHED_FILE = 0x61a7

const FILE_NAME = 0x466e

const FILE_MIME_TYPE = 0x4660

const FILE_DATA = 0x465c

const FILE_UID = 0x46ae

const TRACK_ENTRY = 0xae

const TRACK_NUMBER = 0xd7

const TRACK_TYPE = 0x83

const CODEC_ID = 0x86

const TRACK_NAME = 0x536e

const TRACK_LANGUAGE = 0x22b59c

const TRACK_LANGUAGE_IETF = 0x22b59d

const CODEC_PRIVATE = 0x63a2

const ATTACHMENT_LINK = 0x7446

const FLAG_DEFAULT = 0x88

const FLAG_FORCED = 0x55aa

const FLAG_HEARING_IMPAIRED = 0x55ab

const FLAG_VISUAL_IMPAIRED = 0x55ac

const FLAG_TEXT_DESCRIPTIONS = 0x55ad

const FLAG_ORIGINAL = 0x55ae

const FLAG_COMMENTARY = 0x55af

const TRACK_FLAG_NAMES = new Map<number, keyof SubtitleTrackFlags>([
  [FLAG_DEFAULT, "default"],
  [FLAG_FORCED, "forced"],
  [FLAG_HEARING_IMPAIRED, "hearingImpaired"],
  [FLAG_VISUAL_IMPAIRED, "visualImpaired"],
  [FLAG_TEXT_DESCRIPTIONS, "textDescriptions"],
  [FLAG_ORIGINAL, "original"],
  [FLAG_COMMENTARY, "commentary"],
])

const FONT_MIME_TYPES = new Set([
  "font/collection",
  "font/otf",
  "font/sfnt",
  "font/ttf",
  "font/woff",
  "font/woff2",
  "application/x-truetype-font",
  "application/x-font-ttf",
  "application/font-sfnt",
  "application/font-woff",
  "application/x-font-opentype",
  "application/x-font-truetype",
  "application/vnd.ms-opentype",
])

const FONT_FILE_EXTENSIONS = new Set([
  ".otf",
  ".ttc",
  ".ttf",
  ".woff",
  ".woff2",
])

const CONTENT_ENCODINGS = 0x6d80

const CONTENT_ENCODING = 0x6240

const CONTENT_ENCODING_ORDER = 0x5031

const CONTENT_ENCODING_SCOPE = 0x5032

const CONTENT_ENCODING_TYPE = 0x5033

const CONTENT_COMPRESSION = 0x5034

const CONTENT_ENCRYPTION = 0x5035

const CONTENT_COMP_ALGO = 0x4254

const CONTENT_COMP_SETTINGS = 0x4255

const CLUSTER = 0x1f43b675

const CLUSTER_TIMESTAMP = 0xe7

const SIMPLE_BLOCK = 0xa3

const BLOCK_GROUP = 0xa0

const BLOCK = 0xa1

const BLOCK_DURATION = 0x9b

const CUES = 0x1c53bb6b

const CUE_POINT = 0xbb

const CUE_TIME = 0xb3

const CUE_TRACK_POSITIONS = 0xb7

const CUE_TRACK = 0xf7

const CUE_CLUSTER_POSITION = 0xf1

const CUE_RELATIVE_POSITION = 0xf0

const CUE_DURATION = 0xb2

interface ElementHeader {
  id: number
  start: number
  dataStart: number
  size: number | null
  end: number | null
}

interface TrackPosition {
  trackNumber: number
  clusterPosition: number
  relativePosition: number | null
  durationTicks: number | null
}

interface CuePoint {
  timeTicks: number
  positions: TrackPosition[]
}

interface PgsScanResult {
  nextOffset: number | null
  packets: MatroskaPgsPacket[]
  lastPacketTime: number | undefined
}

interface PgsScanRequest {
  metadata: ParsedFile
  offset: number
  trackNumber: number
  lastPacketTime: number | undefined
  signal: AbortSignal
}

interface PgsClusterReadRequest {
  metadata: ParsedFile
  clusterPosition: number
  trackNumber: number
  positions: TrackPosition[]
  signal: AbortSignal
}

interface PgsPhysicalClusterReadResult {
  nextOffset: number
  cluster: IndexedCueCluster | null
}

interface PgsClusterContext {
  metadata: ParsedFile
  cluster: ElementHeader
  clusterTicks: number
  trackNumber: number
  cueDurations: Map<number, number | null>
  signal: AbortSignal
}

function createPgsCueDurationMap(
  positions: TrackPosition[]
): Map<number, number | null> {
  const durations = new Map<number, number | null>()

  for (const position of positions) {
    if (position.relativePosition !== null) {
      durations.set(position.relativePosition, position.durationTicks)
    }
  }

  return durations
}

function getPgsCueDuration(
  context: PgsClusterContext,
  child: ElementHeader
): number | null {
  return (
    context.cueDurations.get(child.start - context.cluster.dataStart) ?? null
  )
}

interface ParsedFile {
  segmentDataStart: number
  segmentEnd: number
  timestampScale: number
  tracks: ParsedTrack[]
  firstCluster: ElementHeader | null
  cues: ElementHeader | null
  attachments: ElementHeader | null
}

interface MetadataElements {
  seekPositions: Map<number, number>
  info: ElementHeader | null
  tracks: ElementHeader | null
  cues: ElementHeader | null
  attachments: ElementHeader | null
  firstCluster: ElementHeader | null
}

interface ParsedBlock {
  trackNumber: number
  relativeTimestamp: number
  dataBytes: Uint8Array
}

interface DecodedBlock {
  trackNumber: number
  startTime: number
  durationTicks: number | null
  text: string
  textBytes: number
  packetBytes: Uint8Array
}

interface ParsedTrack extends MatroskaTextTrack {
  contentEncodings: MatroskaContentEncoding[]
  contentEncodingsUnsupported: boolean
  codecPrivate: ElementHeader | null
  attachmentLinkUids: number[]
}

interface MatroskaContentEncoding {
  order: number
  scope: number
  type: number
  compressionAlgorithm: number | null
  compressionSettings: Uint8Array
  hasCompression: boolean
  hasEncryption: boolean
  unsupported: boolean
}

interface AttachedFile {
  uid: number | null
  name: string | null
  mimeType: string | null
  data: ElementHeader | null
}

interface LinkedFontReadOptions {
  file: AttachedFile
  linkedUids: Set<number>
  totalFontBytes: number
  signal: AbortSignal
}

interface TrackMetadata {
  trackNumber: number | null
  trackType: number | null
  codecId: string | null
  trackName: string | null
  language: string | null
  languageIetf: string | null
  hasContentEncodings: boolean
  contentEncodings: MatroskaContentEncoding[]
  contentEncodingsUnsupported: boolean
  codecPrivate: ElementHeader | null
  attachmentLinkUids: number[]
  flags: SubtitleTrackFlags
}

interface RangeReaderOptions {
  pageSize: number
  maxRangeBytes: number
  maxRangeRequests: number
  fileSize?: number | null
  directReads?: boolean
  pageCache?: RangePageCache
}

interface SubtitleRangeReader {
  readonly size: number | null
  read(start: number, length: number, signal: AbortSignal): Promise<Uint8Array>
}

class MemoryRangeReader implements SubtitleRangeReader {
  constructor(
    private readonly bytes: Uint8Array,
    private readonly baseOffset: number,
    readonly size: number
  ) {}

  async read(
    start: number,
    length: number,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    const relativeStart = start - this.baseOffset
    const relativeEnd = relativeStart + length

    if (
      signal.aborted ||
      !Number.isSafeInteger(relativeStart) ||
      length <= 0 ||
      relativeStart < 0 ||
      relativeEnd > this.bytes.byteLength
    ) {
      throw new MatroskaSubtitleError(signal.aborted ? "aborted" : "invalid")
    }

    return this.bytes.subarray(relativeStart, relativeEnd)
  }
}

interface VintResult {
  value: number
  length: number
  unknown: boolean
}

interface VintOptions {
  offset: number
  maximumLength: number
  keepMarker: boolean
}

interface ElementRange {
  start: number
  end: number
  signal: AbortSignal
}

interface RangeRequest {
  url: string
  start: number
  end: number
  signal: AbortSignal
}

class RangePageCache {
  private cachedBytes = 0
  private readonly pages = new Map<number, Uint8Array>()

  constructor(private readonly maximumBytes: number) {}

  get(start: number): Uint8Array | undefined {
    const page = this.pages.get(start)

    if (page !== undefined) {
      this.pages.delete(start)
      this.pages.set(start, page)
    }

    return page
  }

  set(start: number, page: Uint8Array): void {
    const previous = this.pages.get(start)

    if (previous !== undefined) {
      this.cachedBytes -= previous.byteLength
    }

    this.pages.set(start, page)
    this.cachedBytes += page.byteLength

    while (this.cachedBytes > this.maximumBytes) {
      const oldest = this.pages.entries().next()

      if (oldest.done) {
        break
      }

      const [oldestStart, oldestPage] = oldest.value

      this.pages.delete(oldestStart)
      this.cachedBytes -= oldestPage.byteLength
    }
  }
}

interface SeekTargetOptions {
  segmentDataStart: number
  relativePosition: number
  expectedId: number
  signal: AbortSignal
}

interface IndexedCueOptions {
  metadata: ParsedFile
  trackNumber: number
  cuePoints: CuePoint[]
  signal: AbortSignal
  onProgress?: (progress: MatroskaSubtitleReadProgress) => void
}

interface TrackBlockReadOptions {
  metadata: ParsedFile
  trackNumber: number
  signal: AbortSignal
  onProgress?: (progress: MatroskaSubtitleReadProgress) => void
}

interface CueClusterOptions {
  metadata: ParsedFile
  trackNumber: number
  clusterPosition: number
  positions: TrackPosition[]
  signal: AbortSignal
}

type IndexedCueCluster = [clusterPosition: number, positions: TrackPosition[]]

interface IndexedClusterReadWindowOptions<T> {
  clusters: IndexedCueCluster[]
  signal: AbortSignal
  onProgress?: (progress: MatroskaSubtitleReadProgress) => void
  concurrency?: number
  window?: number
  readCluster: (cluster: IndexedCueCluster, signal: AbortSignal) => Promise<T[]>
}

interface IndexedClusterWindowResult<T> {
  blocks: T[]
  advanced: boolean
}

class IndexedClusterReadWindow<T> {
  private readonly controller = new AbortController()

  private readonly completed = new Map<number, T[]>()

  private readonly active = new Map<number, Promise<void>>()

  private nextToStart = 0

  private nextToYield = 0

  private failure: Error | null = null

  private wakeReader: (() => void) | null = null

  private readonly abortFromParent = () => {
    this.controller.abort()
    this.notifyReader()
  }

  constructor(private readonly options: IndexedClusterReadWindowOptions<T>) {
    const { signal } = options

    signal.addEventListener("abort", this.abortFromParent, { once: true })

    if (signal.aborted) {
      this.controller.abort()
    }
  }

  async *batches(): AsyncGenerator<T[]> {
    this.startAvailableReads()

    try {
      while (this.nextToYield < this.options.clusters.length) {
        if (this.options.signal.aborted) {
          throw new MatroskaSubtitleError("aborted")
        }

        const ready = this.takeContiguousResults()

        if (ready.advanced) {
          this.options.onProgress?.({
            completed: this.nextToYield,
            total: this.options.clusters.length,
          })
          this.startAvailableReads()

          if (ready.blocks.length > 0) {
            yield ready.blocks
          }

          continue
        }

        if (this.failure !== null) {
          throw this.failure
        }

        await this.waitForChange()
      }

      if (this.failure !== null) {
        throw this.failure
      }
    } finally {
      await this.dispose()
    }
  }

  private startAvailableReads(): void {
    while (
      !this.controller.signal.aborted &&
      this.failure === null &&
      this.active.size <
        (this.options.concurrency ?? INDEXED_CLUSTER_READ_CONCURRENCY) &&
      this.nextToStart < this.options.clusters.length &&
      this.nextToStart <
        this.nextToYield + (this.options.window ?? INDEXED_CLUSTER_READ_WINDOW)
    ) {
      const index = this.nextToStart
      const cluster = this.options.clusters[index]

      if (cluster === undefined) {
        break
      }

      this.nextToStart += 1

      this.startRead(index, cluster)
    }
  }

  private startRead(index: number, cluster: IndexedCueCluster): void {
    const task = this.options
      .readCluster(cluster, this.controller.signal)
      .then(
        (blocks) => {
          this.completed.set(index, blocks)
        },
        (error: Error) => {
          this.failure ??= error
          this.controller.abort()
        }
      )
      .finally(() => {
        this.active.delete(index)
        this.startAvailableReads()
        this.notifyReader()
      })

    this.active.set(index, task)
  }

  private takeContiguousResults(): IndexedClusterWindowResult<T> {
    const blocks: T[] = []
    let advanced = false

    while (this.completed.has(this.nextToYield)) {
      const result = this.completed.get(this.nextToYield)

      if (result === undefined) {
        break
      }

      this.completed.delete(this.nextToYield)
      blocks.push(...result)
      this.nextToYield += 1
      advanced = true
    }

    return { blocks, advanced }
  }

  private notifyReader(): void {
    const wake = this.wakeReader
    this.wakeReader = null
    wake?.()
  }

  private waitForChange(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeReader = resolve
    })
  }

  private async dispose(): Promise<void> {
    this.controller.abort()
    await Promise.all(this.active.values())
    this.options.signal.removeEventListener("abort", this.abortFromParent)
  }
}

interface ClusterReadOptions {
  cluster: ElementHeader
  clusterTicks: number
  trackNumber: number
  timestampScale: number
  signal: AbortSignal
}

interface BlockReadOptions {
  element: ElementHeader
  clusterTicks: number
  timestampScale: number
  cueDurationTicks: number | null
  signal: AbortSignal
}

interface BlockGroupReadOptions {
  group: ElementHeader
  clusterTicks: number
  timestampScale: number
  cueDurationTicks: number | null
  targetTrackNumber: number | null
  signal: AbortSignal
}

interface BlockTiming {
  clusterTicks: number
  blockDurationTicks: number | null
  cueDurationTicks: number | null
  timestampScale: number
}

interface ScannedCluster {
  nextOffset: number
  blocks: DecodedBlock[] | null
}

interface DeadlineScope {
  signal: AbortSignal
  expired: () => boolean
  extend: () => void
  dispose: () => void
}

interface MutableMatroskaAssTrackStream {
  stream: MatroskaAssTrackStream
  setMetadata: (metadata: MatroskaAssTrackMetadata) => void
  appendPackets: (packets: MatroskaAssPacket[]) => void
  complete: (data: MatroskaAssTrackData) => void
  fail: (failure: MatroskaSubtitleError) => void
}

interface AssTrackPacketReadOptions {
  metadata: ParsedFile
  trackNumber: number
  signal: AbortSignal
  stream: MutableMatroskaAssTrackStream
  extendDeadline: () => void
  onProgress?: (progress: MatroskaSubtitleReadProgress) => void
}

function createMatroskaAssTrackStream(): MutableMatroskaAssTrackStream {
  let resolveMetadata!: (metadata: MatroskaAssTrackMetadata) => void
  let rejectMetadata!: (failure: MatroskaSubtitleError) => void
  let resolveResult!: (data: MatroskaAssTrackData) => void
  let rejectResult!: (failure: MatroskaSubtitleError) => void
  let metadataSettled = false

  const packets: MatroskaAssPacket[] = []
  const listeners = new Set<(batch: MatroskaAssPacket[]) => void>()

  const metadata = new Promise<MatroskaAssTrackMetadata>((resolve, reject) => {
    resolveMetadata = resolve
    rejectMetadata = reject
  })

  const result = new Promise<MatroskaAssTrackData>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  // A renderer may unmount before metadata arrives; the load owner still
  // observes `result`, while preventing an unused metadata rejection.
  void metadata.catch(() => {})

  return {
    stream: {
      metadata,
      result,
      subscribePackets: (listener) => {
        listeners.add(listener)

        if (packets.length > 0) {
          listener(packets)
        }

        return () => listeners.delete(listener)
      },
    },
    setMetadata: (value) => {
      if (!metadataSettled) {
        metadataSettled = true
        resolveMetadata(value)
      }
    },
    appendPackets: (batch) => {
      if (batch.length === 0) {
        return
      }

      packets.push(...batch)

      for (const listener of listeners) {
        listener(batch)
      }
    },
    complete: (data) => {
      if (!metadataSettled) {
        const value = { codecPrivate: data.codecPrivate, fonts: data.fonts }
        metadataSettled = true
        resolveMetadata(value)
      }

      resolveResult({ ...data, packets })
    },
    fail: (failure) => {
      if (!metadataSettled) {
        metadataSettled = true
        rejectMetadata(failure)
      }

      rejectResult(failure)
    },
  }
}

function createTrackMetadata(): TrackMetadata {
  return {
    trackNumber: null,
    trackType: null,
    codecId: null,
    trackName: null,
    language: null,
    languageIetf: null,
    hasContentEncodings: false,
    contentEncodings: [],
    contentEncodingsUnsupported: false,
    codecPrivate: null,
    attachmentLinkUids: [],
    flags: {
      default: true,
      forced: false,
      hearingImpaired: false,
      visualImpaired: false,
      textDescriptions: false,
      original: false,
      commentary: false,
    },
  }
}

function groupCuePositions(
  cuePoints: CuePoint[]
): Map<number, TrackPosition[]> {
  const grouped = new Map<number, TrackPosition[]>()

  for (const point of cuePoints) {
    for (const position of point.positions) {
      const clusterPositions = grouped.get(position.clusterPosition) ?? []

      clusterPositions.push(position)
      grouped.set(position.clusterPosition, clusterPositions)
    }
  }

  return grouped
}

function comparePgsPacketOrder(
  left: MatroskaPgsPacket,
  right: MatroskaPgsPacket
): number {
  return (
    left.startTime - right.startTime ||
    left.location.clusterPosition - right.location.clusterPosition ||
    left.location.blockOffset - right.location.blockOffset ||
    left.location.segmentOffset - right.location.segmentOffset
  )
}

function pgsPacketLocationKey(packet: MatroskaPgsPacket): string {
  const { clusterPosition, blockOffset, segmentOffset } = packet.location

  return `${clusterPosition}:${blockOffset}:${segmentOffset}`
}

function mergePgsWindowPackets(
  ...batches: MatroskaPgsPacket[][]
): MatroskaPgsPacket[] {
  const packets = new Map<string, MatroskaPgsPacket>()

  for (const batch of batches) {
    for (const packet of batch) {
      packets.set(pgsPacketLocationKey(packet), packet)
    }
  }

  // TS lib is ES2022, so toSorted is not available here. This is a new array.
  // oxlint-disable-next-line unicorn/no-array-sort
  return [...packets.values()].sort(comparePgsPacketOrder)
}

function inspectPgsWindowPackets(
  packets: MatroskaPgsPacket[],
  targetTime: number
): PgsWindowInspection {
  const inspector = new PgsDisplaySetInspector()

  const state: PgsWindowInspectionState = {
    earlierBoundary: null,
    futureBoundary: null,
    nextEventTime: null,
    stopPacketIndex: null,
    lastTrustedTime: null,
  }

  for (let packetIndex = 0; packetIndex < packets.length; packetIndex += 1) {
    const packet = packets[packetIndex]

    if (packet === undefined) {
      continue
    }

    const displaySet = inspector.push(packet)

    if (displaySet === null || !displaySet.valid) {
      continue
    }

    recordPgsWindowDisplaySet({
      packets,
      packetIndex,
      displaySet,
      targetTime,
      state,
    })
  }

  const boundary = state.earlierBoundary ?? state.futureBoundary

  return {
    boundaryPacketIndex: boundary?.index ?? null,
    boundaryTime: boundary?.time ?? null,
    nextEventTime: state.nextEventTime,
    lastTrustedTime: state.lastTrustedTime,
    stopPacketIndex: state.stopPacketIndex,
  }
}

function recordPgsWindowDisplaySet({
  packets,
  packetIndex,
  displaySet,
  targetTime,
  state,
}: {
  packets: MatroskaPgsPacket[]
  packetIndex: number
  displaySet: PgsDisplaySet
  targetTime: number
  state: PgsWindowInspectionState
}): void {
  if (displaySet.boundary) {
    const [firstSegment] = displaySet.segments

    const segmentIndex =
      firstSegment === undefined
        ? packetIndex
        : findPgsWindowSegmentIndex(packets, firstSegment)

    const boundary = {
      index: segmentIndex < 0 ? packetIndex : segmentIndex,
      time: displaySet.timestamp,
    }

    if (displaySet.timestamp <= targetTime) {
      state.earlierBoundary = boundary
    } else if (state.futureBoundary === null) {
      state.futureBoundary = boundary
    }
  }

  if (displaySet.timestamp <= targetTime && displaySet.hasComposition) {
    state.lastTrustedTime = displaySet.timestamp
  }

  recordPgsWindowNextEvent({
    packets,
    packetIndex,
    displaySet,
    targetTime,
    state,
  })
}

function recordPgsWindowNextEvent({
  packets,
  packetIndex,
  displaySet,
  targetTime,
  state,
}: {
  packets: MatroskaPgsPacket[]
  packetIndex: number
  displaySet: PgsDisplaySet
  targetTime: number
  state: PgsWindowInspectionState
}): void {
  if (!displaySet.hasComposition || displaySet.timestamp <= targetTime) {
    return
  }

  // Keep several future display sets in one window instead of rereading for each.
  state.nextEventTime = displaySet.timestamp
  const lastSegment = displaySet.segments.at(-1)

  const segmentIndex =
    lastSegment === undefined
      ? packetIndex
      : findPgsWindowSegmentIndex(packets, lastSegment)

  state.stopPacketIndex = segmentIndex < 0 ? packetIndex : segmentIndex
}

function findPgsWindowSegmentIndex(
  packets: MatroskaPgsPacket[],
  segment: MatroskaPgsPacket
): number {
  const segmentKey = pgsPacketLocationKey(segment)

  return packets.findIndex(
    (candidate) => pgsPacketLocationKey(candidate) === segmentKey
  )
}

function createPgsWindowCueEntries(
  cuePoints: CuePoint[],
  timestampScale: number
): PgsWindowCueEntry[] {
  const entries = cuePoints.flatMap((point) =>
    point.positions.map((position) => ({
      time: (point.timeTicks * timestampScale) / 1_000_000_000,
      position,
    }))
  )

  // TS lib is ES2022, so toSorted is not available here. This array is local.
  // oxlint-disable-next-line unicorn/no-array-sort
  return entries.sort(
    (left, right) =>
      left.time - right.time ||
      left.position.clusterPosition - right.position.clusterPosition ||
      (left.position.relativePosition ?? 0) -
        (right.position.relativePosition ?? 0)
  )
}

function findPgsCueIndexAtTime(
  cueEntries: PgsWindowCueEntry[],
  targetTime: number
): number {
  let targetCueIndex = 0

  for (let index = 0; index < cueEntries.length; index += 1) {
    const entry = cueEntries[index]

    if (entry !== undefined && entry.time <= targetTime) {
      targetCueIndex = index
    }
  }

  return targetCueIndex
}

function findPgsBoundaryCueIndex({
  cueEntries,
  startIndex,
  targetCueIndex,
  boundaryTime,
}: {
  cueEntries: PgsWindowCueEntry[]
  startIndex: number
  targetCueIndex: number
  boundaryTime: number | null
}): number {
  let boundaryCueIndex = startIndex

  if (boundaryTime === null) {
    return boundaryCueIndex
  }

  for (let index = startIndex; index <= targetCueIndex; index += 1) {
    const entry = cueEntries[index]

    if (entry !== undefined && entry.time <= boundaryTime) {
      boundaryCueIndex = index
    }
  }

  return boundaryCueIndex
}

function parallelPageStarts({
  start,
  length,
  pageSize,
  directReads,
}: {
  start: number
  length: number
  pageSize: number
  directReads: boolean
}): number[] {
  const end = start + length
  const pageStarts: number[] = []

  if (directReads) {
    for (let pageStart = start; pageStart < end; pageStart += pageSize) {
      pageStarts.push(pageStart)
    }

    return pageStarts
  }

  const firstPage = Math.floor(start / pageSize) * pageSize
  const lastPage = Math.floor((end - 1) / pageSize) * pageSize

  for (
    let pageStart = firstPage;
    pageStart <= lastPage;
    pageStart += pageSize
  ) {
    pageStarts.push(pageStart)
  }

  return pageStarts
}

function cueClustersBetween({
  cueClusterPositions,
  segmentDataStart,
  startOffset,
  endOffset,
}: {
  cueClusterPositions: Map<number, TrackPosition[]>
  segmentDataStart: number
  startOffset: number
  endOffset: number
}): Map<number, TrackPosition[]> {
  return new Map(
    [...cueClusterPositions].filter(([clusterPosition]) => {
      const absolute = segmentDataStart + clusterPosition

      return absolute >= startOffset && absolute < endOffset
    })
  )
}

function isAssCodecId(codecId: string): boolean {
  return codecId === "S_TEXT/ASS" || codecId === "S_TEXT/SSA"
}

function isFontAttachment(file: AttachedFile): boolean {
  const mimeType = file.mimeType?.trim().toLowerCase() ?? ""

  if (FONT_MIME_TYPES.has(mimeType)) {
    return true
  }

  const fileExtension = file.name
    ?.slice(file.name.lastIndexOf("."))
    .toLowerCase()

  return (
    mimeType === "application/octet-stream" &&
    fileExtension !== undefined &&
    FONT_FILE_EXTENSIONS.has(fileExtension)
  )
}

class RangeReader {
  private fileSize: number | null
  private readMode: "direct" | "proxy" = "direct"
  private bytesRead = 0
  private requests = 0
  private readonly pageCache: RangePageCache
  private readonly pendingPages = new Map<
    number,
    { promise: Promise<Uint8Array>; signal: AbortSignal }
  >()
  private readonly fetcher: typeof fetch
  readonly pageSize: number
  private readonly maxRangeBytes: number
  private readonly maxRangeRequests: number

  private readonly directReads: boolean

  // Notified after every completed page fetch. Deadline owners use it to
  // extend a no-progress deadline while a slow source keeps delivering.
  onProgress: (() => void) | null = null

  constructor(
    private readonly url: string,
    fetcher: typeof fetch,
    {
      pageSize = PAGE_SIZE,
      maxRangeBytes = MAX_RANGE_BYTES,
      maxRangeRequests = MAX_RANGE_REQUESTS,
      fileSize = null,
      directReads = false,
      pageCache,
    }: Partial<RangeReaderOptions> = {}
  ) {
    this.fetcher = fetcher.bind(globalThis)
    this.pageSize = pageSize
    this.maxRangeBytes = maxRangeBytes
    this.maxRangeRequests = maxRangeRequests
    this.fileSize = fileSize
    this.directReads = directReads
    this.pageCache = pageCache ?? new RangePageCache(MAX_CACHED_BYTES)
  }

  get size(): number | null {
    return this.fileSize
  }

  async read(
    start: number,
    length: number,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    this.validateReadRange(start, length)

    if (this.directReads) {
      const end = start + length - 1
      this.reservePage(start, end)

      return this.readFromRangeSource(start, end, signal)
    }

    const output = new Uint8Array(length)

    return this.copyRange(start, output, signal)
  }

  async readParallel(
    start: number,
    length: number,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    this.validateReadRange(start, length)

    const end = start + length

    const pageStarts = parallelPageStarts({
      start,
      length,
      pageSize: this.pageSize,
      directReads: this.directReads,
    })

    const controller = new AbortController()
    const abortFromParent = () => controller.abort()
    signal.addEventListener("abort", abortFromParent, { once: true })

    if (signal.aborted) {
      controller.abort()
    }

    const output = new Uint8Array(length)
    let nextPage = 0

    const readPages = async () => {
      while (nextPage < pageStarts.length) {
        if (controller.signal.aborted) {
          throw new MatroskaSubtitleError("aborted")
        }

        const pageStart = pageStarts[nextPage]

        if (pageStart === undefined) {
          return
        }

        nextPage += 1
        const pageEnd = Math.min(end, pageStart + this.pageSize)
        let page: Uint8Array

        if (this.directReads) {
          this.reservePage(pageStart, pageEnd - 1)
          page = await this.readFromRangeSource(
            pageStart,
            pageEnd - 1,
            controller.signal
          )
        } else {
          page = await this.readPage(pageStart, controller.signal)
        }

        const copyStart = Math.max(start, pageStart)
        const copyEnd = Math.min(end, pageStart + page.byteLength)

        output.set(
          page.subarray(copyStart - pageStart, copyEnd - pageStart),
          copyStart - start
        )
      }
    }

    const workers = Array.from(
      { length: Math.min(INDEXED_CLUSTER_READ_CONCURRENCY, pageStarts.length) },
      readPages
    )

    try {
      await Promise.all(workers)

      return output
    } catch (error) {
      controller.abort()
      await Promise.allSettled(workers)
      throw error
    } finally {
      signal.removeEventListener("abort", abortFromParent)
    }
  }

  // Fetch the aligned pages covering [start, end) ahead of a sequential parse
  // of the same span, with bounded concurrency. Cached and in-flight pages are
  // skipped, budgets apply per fetched page, and the parent signal cancels
  // outstanding fetches. A prefetch failure is not surfaced here: the parser
  // reaches that page through the normal read path, which re-fetches it and
  // reports the failure through the caller's error handling.
  prefetch(start: number, end: number, signal: AbortSignal): void {
    this.prefetchRanges([{ start, end }], signal)
  }

  prefetchRanges(
    ranges: ReadonlyArray<{ start: number; end: number }>,
    signal: AbortSignal
  ): void {
    if (this.directReads || ranges.length === 0 || signal.aborted) {
      return
    }

    const maximumPages = Math.min(
      this.maxRangeRequests - this.requests,
      Math.ceil((this.maxRangeBytes - this.bytesRead) / this.pageSize)
    )

    if (maximumPages <= 0) {
      return
    }

    const pageStarts = this.collectMissingPrefetchPages(ranges, maximumPages)

    if (pageStarts.length === 0) {
      return
    }

    let nextPage = 0

    const fetchPages = async (): Promise<void> => {
      while (nextPage < pageStarts.length) {
        if (signal.aborted) {
          return
        }

        const pageStart = pageStarts[nextPage]
        nextPage += 1

        try {
          await this.readPage(pageStart, signal)
        } catch {
          return
        }
      }
    }

    void Promise.all(
      Array.from(
        { length: Math.min(PAGE_PREFETCH_CONCURRENCY, pageStarts.length) },
        fetchPages
      )
    )
  }

  private collectMissingPrefetchPages(
    ranges: ReadonlyArray<{ start: number; end: number }>,
    maximumPages: number
  ): number[] {
    const missing = new Set<number>()

    for (const range of ranges) {
      if (range.end <= range.start) {
        continue
      }

      const firstPage = Math.floor(range.start / this.pageSize) * this.pageSize

      for (
        let pageStart = firstPage;
        pageStart < range.end;
        pageStart += this.pageSize
      ) {
        if (this.fileSize !== null && pageStart >= this.fileSize) {
          break
        }

        if (
          this.pageCache.get(pageStart) !== undefined ||
          this.pendingPages.has(pageStart)
        ) {
          continue
        }

        missing.add(pageStart)

        if (missing.size >= maximumPages) {
          break
        }
      }

      if (missing.size >= maximumPages) {
        break
      }
    }

    return [...missing]
  }

  private validateReadRange(start: number, length: number): void {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(length) ||
      start < 0 ||
      length <= 0
    ) {
      throw new MatroskaSubtitleError("invalid")
    }

    if (this.fileSize !== null && start + length > this.fileSize) {
      throw new MatroskaSubtitleError("invalid")
    }
  }

  private async copyRange(
    start: number,
    output: Uint8Array,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    const length = output.byteLength
    let copied = 0

    while (copied < length) {
      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted")
      }

      const offset = start + copied
      const pageStart = Math.floor(offset / this.pageSize) * this.pageSize
      const page = await this.readPage(pageStart, signal)

      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted")
      }

      const pageOffset = offset - pageStart
      const count = Math.min(length - copied, page.byteLength - pageOffset)

      if (count <= 0) {
        throw new MatroskaSubtitleError("invalid")
      }

      output.set(page.subarray(pageOffset, pageOffset + count), copied)
      copied += count
    }

    return output
  }

  private async readPage(
    start: number,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    const cached = this.pageCache.get(start)

    if (cached !== undefined) {
      return cached
    }

    const pending = this.pendingPages.get(start)

    if (pending !== undefined && !pending.signal.aborted) {
      return pending.promise
    }

    const request = this.fetchPage(start, signal)
    const pendingRequest = { promise: request, signal }

    this.pendingPages.set(start, pendingRequest)

    try {
      const page = await request

      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted")
      }

      this.pageCache.set(start, page)

      return page
    } finally {
      if (this.pendingPages.get(start) === pendingRequest) {
        this.pendingPages.delete(start)
      }
    }
  }

  private async fetchPage(
    start: number,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    if (this.fileSize !== null && start >= this.fileSize) {
      throw new MatroskaSubtitleError("invalid")
    }

    const end = this.pageEnd(start)

    this.reservePage(start, end)

    const page = await this.readFromRangeSource(start, end, signal)

    this.onProgress?.()

    return page
  }

  private pageEnd(start: number): number {
    return this.fileSize === null
      ? start + this.pageSize - 1
      : Math.min(start + this.pageSize, this.fileSize) - 1
  }

  private reservePage(start: number, end: number): void {
    if (
      this.requests >= this.maxRangeRequests ||
      this.bytesRead + end - start + 1 > this.maxRangeBytes
    ) {
      throw new MatroskaSubtitleError("limit")
    }

    this.bytesRead += end - start + 1
  }

  private async readFromRangeSource(
    start: number,
    end: number,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    // Parallel reads can start in direct mode together. Keep each read's
    // fallback decision tied to the mode it started with so one CORS failure
    // does not prevent its in-flight siblings from retrying through the proxy.
    const { readMode } = this
    const url = readMode === "direct" ? this.url : proxiedMediaUrl(this.url)

    try {
      return await (readMode === "proxy"
        ? this.requestProxyPage({ url, start, end, signal })
        : this.requestPage({ url, start, end, signal }))
    } catch (error) {
      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted")
      }

      if (readMode === "proxy") {
        throw error instanceof MatroskaSubtitleError
          ? error
          : new MatroskaSubtitleError("unreachable")
      }

      this.readMode = "proxy"
      this.reservePage(start, end)

      try {
        return await this.requestProxyPage({
          url: proxiedMediaUrl(this.url),
          start,
          end,
          signal,
        })
      } catch (proxyError) {
        if (signal.aborted) {
          throw new MatroskaSubtitleError("aborted")
        }

        throw proxyError instanceof MatroskaSubtitleError
          ? proxyError
          : new MatroskaSubtitleError("unreachable")
      }
    }
  }

  private async requestProxyPage(request: RangeRequest): Promise<Uint8Array> {
    try {
      return await this.requestPage(request)
    } catch (error) {
      if (
        request.signal.aborted ||
        !(error instanceof MatroskaSubtitleError) ||
        (error.kind !== "timeout" && error.kind !== "unreachable")
      ) {
        throw error
      }

      // A dropped range is recoverable, but still consumes the read budget.
      this.reservePage(request.start, request.end)

      return this.requestPage(request)
    }
  }

  private async requestPage({
    url,
    start,
    end,
    signal: parentSignal,
  }: RangeRequest): Promise<Uint8Array> {
    if (this.requests >= this.maxRangeRequests) {
      throw new MatroskaSubtitleError("limit")
    }

    const controller = new AbortController()
    const abortFromParent = () => controller.abort()

    const deadline = setTimeout(() => controller.abort(), RANGE_DEADLINE_MS)

    parentSignal.addEventListener("abort", abortFromParent, { once: true })
    this.requests += 1

    try {
      const response = await this.fetcher(url, {
        headers: { Range: `bytes=${start}-${end}` },
        // Chromium serializes concurrent ranges behind its HTTP cache lock.
        // Pages are already cached with an explicit memory bound in this reader.
        cache: "no-store",
        signal: controller.signal,
      })

      const range = await readRangeHeaders(response, start, end)

      if (this.fileSize !== null && range.totalSize !== this.fileSize) {
        await cancelBody(response)
        throw new MatroskaSubtitleError("invalid")
      }

      this.fileSize = range.totalSize

      return await readBoundedBody(response, range.length, {
        controller,
        maximumBytes: this.pageSize,
      })
    } catch (error) {
      if (parentSignal.aborted || controller.signal.aborted) {
        throw new MatroskaSubtitleError(
          parentSignal.aborted ? "aborted" : "timeout"
        )
      }

      throw error instanceof MatroskaSubtitleError
        ? error
        : new MatroskaSubtitleError("unreachable")
    } finally {
      clearTimeout(deadline)
      parentSignal.removeEventListener("abort", abortFromParent)
    }
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // A rejected response body is already unusable; cancellation is best effort.
  }
}

async function readRangeHeaders(
  response: Response,
  start: number,
  requestedEnd: number
): Promise<{ totalSize: number; length: number }> {
  if (response.status !== 206) {
    await cancelBody(response)
    throw new MatroskaSubtitleError("unsupported")
  }

  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(
    response.headers.get("content-range") ?? ""
  )

  if (match === null) {
    await cancelBody(response)
    throw new MatroskaSubtitleError("invalid")
  }

  const rangeStart = Number(match[1])
  const rangeEnd = Number(match[2])
  const totalSize = Number(match[3])
  const expectedEnd = Math.min(requestedEnd, totalSize - 1)

  if (
    !Number.isSafeInteger(totalSize) ||
    totalSize <= 0 ||
    rangeStart !== start ||
    rangeEnd !== expectedEnd ||
    rangeEnd < rangeStart
  ) {
    await cancelBody(response)
    throw new MatroskaSubtitleError("invalid")
  }

  return { totalSize, length: rangeEnd - rangeStart + 1 }
}

async function readBoundedBody(
  response: Response,
  expectedBytes: number,
  {
    controller,
    maximumBytes,
  }: { controller: AbortController; maximumBytes: number }
): Promise<Uint8Array> {
  if (response.body === null || expectedBytes > maximumBytes) {
    await cancelBody(response)
    throw new MatroskaSubtitleError("invalid")
  }

  const chunks = await readResponseChunks(
    response.body.getReader(),
    expectedBytes,
    controller
  )

  return concatenateChunks(chunks, expectedBytes)
}

async function readResponseChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expectedBytes: number,
  controller: AbortController
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  let received = 0

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      received += value.byteLength

      if (received > expectedBytes) {
        controller.abort()
        throw new MatroskaSubtitleError("invalid")
      }

      chunks.push(value)
    }
  } catch (error) {
    controller.abort()
    throw error instanceof MatroskaSubtitleError
      ? error
      : new MatroskaSubtitleError("unreachable")
  } finally {
    reader.releaseLock()
  }

  if (received !== expectedBytes) {
    throw new MatroskaSubtitleError("invalid")
  }

  return chunks
}

function concatenateChunks(
  chunks: Uint8Array[],
  expectedBytes: number
): Uint8Array {
  const result = new Uint8Array(expectedBytes)
  let offset = 0

  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }

  return result
}

function vintLength(firstByte: number, maximumLength: number): number {
  if (firstByte === 0) {
    throw new MatroskaSubtitleError("invalid")
  }

  let mask = 0x80
  let length = 1

  while ((firstByte & mask) === 0) {
    mask >>= 1
    length += 1
  }

  if (length > maximumLength) {
    throw new MatroskaSubtitleError("invalid")
  }

  return length
}

function readVint(
  bytes: Uint8Array,
  { offset, maximumLength, keepMarker }: VintOptions
): VintResult {
  if (offset >= bytes.byteLength) {
    throw new MatroskaSubtitleError("invalid")
  }

  const length = vintLength(bytes[offset] ?? 0, maximumLength)

  if (offset + length > bytes.byteLength) {
    throw new MatroskaSubtitleError("invalid")
  }

  let value = BigInt(bytes[offset] ?? 0)

  if (!keepMarker) {
    value &= BigInt(0xff >> length)
  }

  for (let index = 1; index < length; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index] ?? 0)
  }

  const unknown = !keepMarker && value === (1n << BigInt(length * 7)) - 1n

  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MatroskaSubtitleError("unsupported")
  }

  return { value: unknown ? 0 : Number(value), length, unknown }
}

function decodeUnsigned(bytes: Uint8Array): number {
  if (bytes.byteLength === 0 || bytes.byteLength > 8) {
    throw new MatroskaSubtitleError("invalid")
  }

  let value = 0n

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MatroskaSubtitleError("unsupported")
  }

  return Number(value)
}

async function elementAt(
  reader: SubtitleRangeReader,
  start: number,
  signal: AbortSignal
): Promise<ElementHeader> {
  const { size } = reader

  if (size === null || start < 0 || start >= size) {
    throw new MatroskaSubtitleError("invalid")
  }

  const bytes = await reader.read(start, Math.min(12, size - start), signal)

  const id = readVint(bytes, {
    offset: 0,
    maximumLength: 4,
    keepMarker: true,
  })

  const elementSize = readVint(bytes, {
    offset: id.length,
    maximumLength: 8,
    keepMarker: false,
  })

  const dataStart = start + id.length + elementSize.length

  const sizeValue = elementSize.unknown ? null : elementSize.value
  const end = sizeValue === null ? null : dataStart + sizeValue

  if (
    end !== null &&
    (!Number.isSafeInteger(end) || end > size || end < dataStart)
  ) {
    throw new MatroskaSubtitleError("invalid")
  }

  return { id: id.value, start, dataStart, size: sizeValue, end }
}

async function* childElements(
  reader: SubtitleRangeReader,
  { start, end, signal }: ElementRange
): AsyncGenerator<ElementHeader> {
  let offset = start
  let count = 0

  while (offset < end) {
    count += 1

    if (count > MAX_EBML_CHILDREN) {
      throw new MatroskaSubtitleError("limit")
    }

    const child = await elementAt(reader, offset, signal)

    if (child.size === null || child.end === null || child.end > end) {
      throw new MatroskaSubtitleError("invalid")
    }

    yield child
    offset = child.end
  }

  if (offset !== end) {
    throw new MatroskaSubtitleError("invalid")
  }
}

async function readUnsignedElement(
  reader: SubtitleRangeReader,
  element: ElementHeader,
  signal: AbortSignal
): Promise<number> {
  if (element.size === null || element.size > 8) {
    throw new MatroskaSubtitleError("invalid")
  }

  return decodeUnsigned(
    await reader.read(element.dataStart, element.size, signal)
  )
}

async function readStringElement(
  reader: SubtitleRangeReader,
  element: ElementHeader,
  signal: AbortSignal
): Promise<string> {
  if (element.size === null || element.size > 4096) {
    throw new MatroskaSubtitleError("limit")
  }

  return new TextDecoder().decode(
    await reader.read(element.dataStart, element.size, signal)
  )
}

function withDeadline(
  parentSignal: AbortSignal,
  timeoutMs = TRACK_DEADLINE_MS
): DeadlineScope {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort()

  let expired = false
  let deadline: ReturnType<typeof setTimeout> | undefined

  const fire = () => {
    expired = true
    controller.abort()
  }

  const arm = () => {
    clearTimeout(deadline)
    deadline = setTimeout(fire, timeoutMs)
  }

  arm()

  if (parentSignal.aborted) {
    controller.abort()
  }

  parentSignal.addEventListener("abort", abortFromParent, { once: true })

  return {
    signal: controller.signal,
    expired: () => expired,
    // Extend is for track deadlines measured in progress, not wall time: a
    // load whose reads keep completing stays inside its byte and request
    // budgets and must not die to this clock.
    extend: () => {
      if (!expired) {
        arm()
      }
    },
    dispose: () => {
      clearTimeout(deadline)
      parentSignal.removeEventListener("abort", abortFromParent)
    },
  }
}

export function createMatroskaSubtitleReader(
  mediaUrl: string,
  fetcher: typeof fetch = fetch
): MatroskaSubtitleReader {
  const pgsPageCache = new RangePageCache(MAX_PGS_CACHED_BYTES)

  const createCueRangeReader = (fileSize: number | null) =>
    new RangeReader(mediaUrl, fetcher, {
      pageSize: CUE_INDEX_PAGE_SIZE,
      maxRangeBytes: MAX_CUE_INDEX_RANGE_BYTES,
      maxRangeRequests: MAX_RANGE_REQUESTS,
      fileSize,
      directReads: true,
    })

  const createAssRangeReader = () =>
    new RangeReader(mediaUrl, fetcher, {
      pageSize: ASS_PAGE_SIZE,
      maxRangeBytes: MAX_ASS_RANGE_BYTES,
      maxRangeRequests: MAX_ASS_RANGE_REQUESTS,
    })

  const createPgsRangeReader = (
    fileSize: number | null = null,
    directReads = false
  ) => {
    const largeFile =
      fileSize !== null && fileSize > LARGE_FILE_PGS_PAGE_THRESHOLD

    return new RangeReader(mediaUrl, fetcher, {
      pageSize: PGS_PAGE_SIZE,
      maxRangeBytes: largeFile
        ? LARGE_FILE_MAX_PGS_RANGE_BYTES
        : MAX_PGS_RANGE_BYTES,
      maxRangeRequests: MAX_PGS_RANGE_REQUESTS,
      fileSize,
      directReads,
      pageCache: pgsPageCache,
    })
  }

  return new MatroskaSubtitleReaderImpl(
    new RangeReader(mediaUrl, fetcher, {
      maxRangeBytes: MAX_TEXT_TRACK_RANGE_BYTES,
      maxRangeRequests: MAX_TEXT_TRACK_RANGE_REQUESTS,
    }),
    { createAssRangeReader, createCueRangeReader, createPgsRangeReader }
  )
}

interface MatroskaRangeReaderFactories {
  createAssRangeReader: () => RangeReader
  createCueRangeReader: (fileSize: number | null) => RangeReader
  createPgsRangeReader: (
    fileSize?: number | null,
    directReads?: boolean
  ) => RangeReader
}

interface MatroskaSubtitleReaderState {
  metadata?: ParsedFile | null
  pgsCueIndexes?: Map<number, PgsCueIndexCacheEntry>
}

interface PgsCueIndexCacheEntry {
  promise: Promise<CuePoint[]>
  signal: AbortSignal | null
}

class MatroskaSubtitleReaderImpl implements MatroskaSubtitleReader {
  private metadata: ParsedFile | null = null
  private readonly pgsCueIndexes: Map<number, PgsCueIndexCacheEntry>

  constructor(
    private readonly reader: RangeReader,
    private readonly rangeReaders: MatroskaRangeReaderFactories,
    {
      metadata = null,
      pgsCueIndexes = new Map<number, PgsCueIndexCacheEntry>(),
    }: MatroskaSubtitleReaderState = {}
  ) {
    this.metadata = metadata
    this.pgsCueIndexes = pgsCueIndexes
  }

  async probe(signal: AbortSignal): Promise<MatroskaTextTrack[]> {
    const deadline = withDeadline(signal)

    try {
      return (await this.readMetadata(deadline.signal)).tracks.map(
        ({
          id,
          trackNumber,
          codecId,
          label,
          language,
          flags,
          hasContentEncodings,
        }) => ({
          id,
          trackNumber,
          codecId,
          label,
          language,
          flags,
          hasContentEncodings,
        })
      )
    } finally {
      deadline.dispose()
    }
  }

  async readCues(
    trackNumber: number,
    signal: AbortSignal,
    onProgress?: (progress: MatroskaSubtitleReadProgress) => void
  ): Promise<SubtitleCue[]> {
    const deadline = withDeadline(signal)
    const extendDeadline = deadline.extend
    this.reader.onProgress = extendDeadline

    try {
      const metadata = await this.readMetadata(deadline.signal)

      const track = metadata.tracks.find(
        (candidate) => candidate.trackNumber === trackNumber
      )

      if (track === undefined || track.codecId !== "S_TEXT/UTF8") {
        throw new MatroskaSubtitleError("invalid")
      }

      orderedContentEncodings(track)

      const blocks = await this.readTrackBlocks({
        metadata,
        trackNumber,
        signal: deadline.signal,
        onProgress,
      })

      if (blocks.length === 0) {
        throw new MatroskaSubtitleError("invalid")
      }

      return this.createTextCues(blocks, metadata)
    } catch (failure) {
      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted")
      }

      if (failure instanceof MatroskaSubtitleError) {
        throw normalizeTextTrackFailure(failure, deadline.expired())
      }

      throw failure
    } finally {
      this.clearProgressCallback(extendDeadline)
      deadline.dispose()
    }
  }

  private clearProgressCallback(callback: () => void): void {
    // An older read must not clear a newer track's deadline callback.
    if (this.reader.onProgress === callback) {
      this.reader.onProgress = null
    }
  }

  private createTextCues(
    blocks: DecodedBlock[],
    metadata: ParsedFile
  ): SubtitleCue[] {
    blocks.sort((left, right) => left.startTime - right.startTime)

    return blocks.map((block) => ({
      startTime: block.startTime,
      endTime: this.endTime(
        block.startTime,
        block.durationTicks,
        metadata.timestampScale
      ),
      text: block.text,
    }))
  }

  streamPgsTrack(
    trackNumber: number,
    signal: AbortSignal
  ): AsyncIterable<MatroskaPgsPacket> {
    const reader = new MatroskaSubtitleReaderImpl(
      this.rangeReaders.createPgsRangeReader(this.reader.size),
      this.rangeReaders,
      { metadata: this.metadata, pgsCueIndexes: this.pgsCueIndexes }
    )

    return reader.readPgsTrackWithinBudget(trackNumber, signal)
  }

  streamPgsWindow(
    trackNumber: number,
    targetTime: number,
    signal: AbortSignal
  ): AsyncIterable<MatroskaPgsWindowEvent> {
    return this.readPgsWindowFromSource(trackNumber, targetTime, signal)
  }

  private async *readPgsWindowFromSource(
    trackNumber: number,
    targetTime: number,
    signal: AbortSignal
  ): AsyncGenerator<MatroskaPgsWindowEvent> {
    const deadline = withDeadline(signal, MAX_PGS_WINDOW_DEADLINE_MS)

    const progress: PgsTrackProgress = {
      packetCount: 0,
      packetBytes: 0,
      lastPacketTime: undefined,
    }

    try {
      if (!Number.isFinite(targetTime) || targetTime < 0) {
        throw new MatroskaSubtitleError("invalid")
      }

      const metadata = await this.readMetadata(deadline.signal)

      const windowRangeReader = this.rangeReaders.createPgsRangeReader(
        this.reader.size
      )

      // The window deadline bounds a lack of progress, not wall time: a
      // latency-bound origin can legitimately need more than one deadline
      // window of round-trips while pages keep arriving.
      windowRangeReader.onProgress = deadline.extend

      const windowReader = new MatroskaSubtitleReaderImpl(
        windowRangeReader,
        this.rangeReaders,
        { metadata, pgsCueIndexes: this.pgsCueIndexes }
      )

      yield* windowReader.readPgsWindowWithinBudget({
        metadata,
        trackNumber,
        targetTime,
        signal: deadline.signal,
        progress,
      })
    } catch (failure) {
      throw normalizePgsTrackFailure({
        failure: failure instanceof MatroskaSubtitleError ? failure : null,
        signalAborted: signal.aborted,
        deadlineExpired: deadline.expired(),
        lastPacketTime: progress.lastPacketTime,
      })
    } finally {
      deadline.dispose()
    }
  }

  private async *readPgsWindowWithinBudget({
    metadata,
    trackNumber,
    targetTime,
    signal,
    progress,
  }: {
    metadata: ParsedFile
    trackNumber: number
    targetTime: number
    signal: AbortSignal
    progress: PgsTrackProgress
  }): AsyncGenerator<MatroskaPgsWindowEvent> {
    this.assertPgsTrack(metadata, trackNumber)

    const cueIndex = await this.readPgsWindowCueIndex({
      metadata,
      trackNumber,
      targetTime,
      signal,
    })

    const seed = await this.findPgsWindowSeed({
      metadata,
      trackNumber,
      targetTime,
      cueIndex,
      signal,
    })

    const plan = await this.extendPgsWindowThroughNextEvent({
      metadata,
      trackNumber,
      targetTime,
      seed,
      signal,
    })

    yield* this.emitPgsWindow(plan, targetTime, progress)
  }

  private async readPgsWindowCueIndex({
    metadata,
    trackNumber,
    targetTime,
    signal,
  }: {
    metadata: ParsedFile
    trackNumber: number
    targetTime: number
    signal: AbortSignal
  }): Promise<PgsWindowCueIndex> {
    const cuePoints = await this.readPgsCuePositions(
      metadata,
      trackNumber,
      signal
    )

    if (cuePoints.length === 0) {
      throw new MatroskaSubtitleError("unsupported")
    }

    const cueEntries = createPgsWindowCueEntries(
      cuePoints,
      metadata.timestampScale
    )

    return {
      cueEntries,
      cueClusterPositions: groupCuePositions(cuePoints),
      targetCueIndex: findPgsCueIndexAtTime(cueEntries, targetTime),
    }
  }

  private async findPgsWindowSeed({
    metadata,
    trackNumber,
    targetTime,
    cueIndex,
    signal,
  }: {
    metadata: ParsedFile
    trackNumber: number
    targetTime: number
    cueIndex: PgsWindowCueIndex
    signal: AbortSignal
  }): Promise<PgsWindowSeed> {
    const search = await this.searchPgsWindowBoundary({
      metadata,
      trackNumber,
      targetTime,
      cueIndex,
      signal,
    })

    const boundaryCueIndex = findPgsBoundaryCueIndex({
      cueEntries: cueIndex.cueEntries,
      startIndex: search.firstCueIndex,
      targetCueIndex: cueIndex.targetCueIndex,
      boundaryTime: search.inspection.boundaryTime,
    })

    const packets = await this.readPgsWindowCueEntries({
      metadata,
      trackNumber,
      cueEntries: cueIndex.cueEntries,
      cueClusterPositions: cueIndex.cueClusterPositions,
      startIndex: boundaryCueIndex,
      endIndex: cueIndex.targetCueIndex,
      includeGaps: true,
      signal,
    })

    const inspection = inspectPgsWindowPackets(packets, targetTime)

    if (inspection.boundaryPacketIndex === null) {
      throw new MatroskaSubtitleError("limit")
    }

    return { ...cueIndex, boundaryCueIndex, packets, inspection }
  }

  private async searchPgsWindowBoundary({
    metadata,
    trackNumber,
    targetTime,
    cueIndex,
    signal,
  }: {
    metadata: ParsedFile
    trackNumber: number
    targetTime: number
    cueIndex: PgsWindowCueIndex
    signal: AbortSignal
  }): Promise<{
    firstCueIndex: number
    inspection: PgsWindowInspection
  }> {
    let firstCueIndex = cueIndex.targetCueIndex
    let backwardStep = 1

    let inspection = await this.inspectPgsCueRange({
      metadata,
      trackNumber,
      cueIndex,
      targetTime,
      firstCueIndex,
      includeGaps: false,
      signal,
    })

    while (inspection.boundaryPacketIndex === null && firstCueIndex > 0) {
      const nextFirstCueIndex = Math.max(
        0,
        cueIndex.targetCueIndex - backwardStep,
        cueIndex.targetCueIndex - MAX_PGS_BOUNDARY_SEARCH_CUES + 1
      )

      const firstEntry = cueIndex.cueEntries[nextFirstCueIndex]

      if (
        firstEntry === undefined ||
        targetTime - firstEntry.time > MAX_PGS_BOUNDARY_SEARCH_SECONDS
      ) {
        break
      }

      firstCueIndex = nextFirstCueIndex
      inspection = await this.inspectPgsCueRange({
        metadata,
        trackNumber,
        cueIndex,
        targetTime,
        firstCueIndex,
        includeGaps: false,
        signal,
      })

      if (inspection.boundaryPacketIndex === null) {
        inspection = await this.inspectPgsCueRange({
          metadata,
          trackNumber,
          cueIndex,
          targetTime,
          firstCueIndex,
          includeGaps: true,
          signal,
        })
      }

      backwardStep *= 2
    }

    if (inspection.boundaryPacketIndex === null) {
      throw new MatroskaSubtitleError("limit")
    }

    return { firstCueIndex, inspection }
  }

  private async inspectPgsCueRange({
    metadata,
    trackNumber,
    cueIndex,
    targetTime,
    firstCueIndex,
    includeGaps,
    signal,
  }: {
    metadata: ParsedFile
    trackNumber: number
    cueIndex: PgsWindowCueIndex
    targetTime: number
    firstCueIndex: number
    includeGaps: boolean
    signal: AbortSignal
  }): Promise<PgsWindowInspection> {
    const packets = await this.readPgsWindowCueEntries({
      metadata,
      trackNumber,
      cueEntries: cueIndex.cueEntries,
      cueClusterPositions: cueIndex.cueClusterPositions,
      startIndex: firstCueIndex,
      endIndex: cueIndex.targetCueIndex,
      includeGaps,
      signal,
    })

    return inspectPgsWindowPackets(packets, targetTime)
  }

  private async extendPgsWindowThroughNextEvent({
    metadata,
    trackNumber,
    targetTime,
    seed,
    signal,
  }: {
    metadata: ParsedFile
    trackNumber: number
    targetTime: number
    seed: PgsWindowSeed
    signal: AbortSignal
  }): Promise<PgsWindowForwardPlan> {
    let { packets, inspection } = seed
    let forwardCueIndex = seed.targetCueIndex
    const coverageGoal = targetTime + MIN_PGS_WINDOW_COVERAGE_SECONDS

    this.prefetchPgsWindowForwardSpan({
      metadata,
      seed,
      targetTime,
      coverageGoal,
      signal,
    })

    while (
      (inspection.nextEventTime === null ||
        inspection.nextEventTime < coverageGoal) &&
      forwardCueIndex + 1 < seed.cueEntries.length
    ) {
      const nextEntry = seed.cueEntries[forwardCueIndex + 1]

      if (
        nextEntry === undefined ||
        nextEntry.time - targetTime > MAX_PGS_WINDOW_FORWARD_SECONDS
      ) {
        break
      }

      forwardCueIndex += 1
      packets = await this.includeNextPgsCue({
        metadata,
        trackNumber,
        seed,
        forwardCueIndex,
        packets,
        signal,
      })
      inspection = inspectPgsWindowPackets(packets, targetTime)
    }

    return { ...seed, packets, inspection, forwardCueIndex }
  }

  // Cue entries identify the cluster header and selected Block pages. Prefetch
  // those sparse pages while earlier stages run instead of downloading every
  // intervening video and audio payload page.
  private prefetchPgsWindowForwardSpan({
    metadata,
    seed,
    targetTime,
    coverageGoal,
    signal,
  }: {
    metadata: ParsedFile
    seed: PgsWindowSeed
    targetTime: number
    coverageGoal: number
    signal: AbortSignal
  }): void {
    const startEntry = seed.cueEntries[seed.targetCueIndex + 1]

    const goalIndex = findPgsCueIndexAtTime(seed.cueEntries, coverageGoal) + 1
    const goalEntry = seed.cueEntries[goalIndex]

    if (
      startEntry === undefined ||
      goalEntry === undefined ||
      // The extension stops at the forward bound; do not fetch past it.
      goalEntry.time - targetTime > MAX_PGS_WINDOW_FORWARD_SECONDS
    ) {
      return
    }

    const ranges: Array<{ start: number; end: number }> = []

    for (let index = seed.targetCueIndex + 1; index <= goalIndex; index += 1) {
      const entry = seed.cueEntries[index]

      if (entry === undefined) {
        continue
      }

      const clusterStart =
        metadata.segmentDataStart + entry.position.clusterPosition

      ranges.push({ start: clusterStart, end: clusterStart + 1 })

      if (entry.position.relativePosition !== null) {
        const blockStart = clusterStart + entry.position.relativePosition

        // RelativePosition starts at Cluster data, after its small header.
        // This page-sized range also covers a Block that straddles a page edge.
        ranges.push({
          start: blockStart,
          end: blockStart + this.reader.pageSize,
        })
      }
    }

    this.reader.prefetchRanges(ranges, signal)
  }

  private async includeNextPgsCue({
    metadata,
    trackNumber,
    seed,
    forwardCueIndex,
    packets,
    signal,
  }: {
    metadata: ParsedFile
    trackNumber: number
    seed: PgsWindowSeed
    forwardCueIndex: number
    packets: MatroskaPgsPacket[]
    signal: AbortSignal
  }): Promise<MatroskaPgsPacket[]> {
    const nextPackets = await this.readPgsWindowCueEntries({
      metadata,
      trackNumber,
      cueEntries: seed.cueEntries,
      cueClusterPositions: seed.cueClusterPositions,
      startIndex: forwardCueIndex - 1,
      endIndex: forwardCueIndex,
      includeGaps: true,
      signal,
    })

    return mergePgsWindowPackets(packets, nextPackets)
  }

  private *emitPgsWindow(
    plan: PgsWindowForwardPlan,
    targetTime: number,
    progress: PgsTrackProgress
  ): Generator<MatroskaPgsWindowEvent> {
    const { packets, inspection } = plan
    const { boundaryPacketIndex, boundaryTime } = inspection

    if (boundaryPacketIndex === null || boundaryTime === null) {
      throw new MatroskaSubtitleError("limit", progress.lastPacketTime)
    }

    yield { kind: "boundary", boundaryTime }

    const finalPacketIndex = inspection.stopPacketIndex ?? packets.length - 1

    for (
      let index = boundaryPacketIndex;
      index <= finalPacketIndex && index < packets.length;
      index += 1
    ) {
      const packet = packets[index]

      if (packet !== undefined) {
        yield this.recordPgsWindowPacket(packet, progress)
      }
    }

    yield {
      kind: "coverage",
      coverageTime:
        inspection.nextEventTime ??
        Math.max(
          targetTime,
          plan.cueEntries[plan.forwardCueIndex]?.time ?? targetTime
        ),
      complete: false,
    }
  }

  private recordPgsWindowPacket(
    packet: MatroskaPgsPacket,
    progress: PgsTrackProgress
  ): MatroskaPgsWindowEvent {
    progress.packetCount += 1
    progress.packetBytes += packet.data.byteLength

    if (
      progress.packetCount > MAX_PGS_TRACK_PACKETS ||
      progress.packetBytes > MAX_PGS_TRACK_BYTES
    ) {
      throw new MatroskaSubtitleError("limit", packet.startTime)
    }

    progress.lastPacketTime = packet.startTime

    return { kind: "packet", packet }
  }

  async readAssTrack(
    trackNumber: number,
    signal: AbortSignal
  ): Promise<MatroskaAssTrackData> {
    return this.streamAssTrack(trackNumber, signal).result
  }

  streamAssTrack(
    trackNumber: number,
    signal: AbortSignal,
    onProgress?: (progress: MatroskaSubtitleReadProgress) => void
  ): MatroskaAssTrackStream {
    // Font data and cue packets need a larger byte budget than Phase 8 text
    // cues. Use an isolated reader so selecting ASS never changes UTF8 limits.
    const reader = new MatroskaSubtitleReaderImpl(
      this.rangeReaders.createAssRangeReader(),
      this.rangeReaders
    )

    const trackStream = createMatroskaAssTrackStream()

    void reader
      .readAssTrackWithinBudget({
        trackNumber,
        signal,
        stream: trackStream,
        onProgress,
      })
      .then(trackStream.complete, trackStream.fail)

    return trackStream.stream
  }

  private async readAssTrackWithinBudget({
    trackNumber,
    signal,
    stream,
    onProgress,
  }: Pick<
    AssTrackPacketReadOptions,
    "trackNumber" | "signal" | "stream" | "onProgress"
  >): Promise<MatroskaAssTrackData> {
    const deadline = withDeadline(signal, ASS_TRACK_DEADLINE_MS)

    try {
      const input = await this.readAssTrackInput(
        trackNumber,
        deadline.signal,
        stream
      )

      deadline.extend()

      const packets = await this.readAssTrackPackets({
        metadata: input.metadata,
        trackNumber,
        signal: deadline.signal,
        stream,
        onProgress,
        // The deadline is a no-progress bound: through a slow proxy the whole
        // track can outrun the wall clock while every read keeps succeeding.
        extendDeadline: deadline.extend,
      })

      return {
        codecPrivate: input.codecPrivate,
        packets,
        fonts: input.fonts,
      }
    } catch (failure) {
      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted")
      }

      if (
        deadline.expired() &&
        failure instanceof MatroskaSubtitleError &&
        failure.kind === "aborted"
      ) {
        throw new MatroskaSubtitleError("deadline")
      }

      if (failure instanceof MatroskaSubtitleError) {
        throw failure
      }

      throw new MatroskaSubtitleError("unreachable")
    } finally {
      deadline.dispose()
    }
  }

  private async readAssTrackInput(
    trackNumber: number,
    signal: AbortSignal,
    stream: MutableMatroskaAssTrackStream
  ): Promise<{
    metadata: ParsedFile
    codecPrivate: Uint8Array
    fonts: Uint8Array[]
  }> {
    const metadata = await this.readMetadata(signal)

    const track = metadata.tracks.find(
      (candidate) => candidate.trackNumber === trackNumber
    )

    if (
      track === undefined ||
      !isAssCodecId(track.codecId) ||
      track.codecPrivate === null ||
      track.codecPrivate.size === null ||
      track.codecPrivate.size === 0
    ) {
      throw new MatroskaSubtitleError("invalid")
    }

    orderedContentEncodings(track)

    if (track.codecPrivate.size > MAX_CODEC_PRIVATE_BYTES) {
      throw new MatroskaSubtitleError("limit")
    }

    const codecPrivate = await this.reader.read(
      track.codecPrivate.dataStart,
      track.codecPrivate.size,
      signal
    )

    const fonts = await this.readLinkedFonts(
      metadata.attachments,
      track.attachmentLinkUids,
      signal
    )

    stream.setMetadata({ codecPrivate, fonts })

    return { metadata, codecPrivate, fonts }
  }

  private async readAssTrackPackets({
    metadata,
    trackNumber,
    signal,
    stream,
    extendDeadline,
    onProgress,
  }: AssTrackPacketReadOptions): Promise<MatroskaAssPacket[]> {
    const packets: MatroskaAssPacket[] = []
    let packetBytes = 0

    for await (const blocks of this.readTrackBlockBatches({
      metadata,
      trackNumber,
      signal,
      onProgress,
    })) {
      const batch = this.createAssPackets(blocks, metadata.timestampScale)

      packets.push(...batch)
      packetBytes += batch.reduce(
        (total, packet) => total + packet.data.byteLength,
        0
      )

      if (
        packets.length > MAX_SUBTITLE_CUES ||
        packetBytes > MAX_ASS_PACKET_BYTES
      ) {
        throw new MatroskaSubtitleError("limit")
      }

      extendDeadline()
      stream.appendPackets(batch)
    }

    if (packets.length === 0) {
      throw new MatroskaSubtitleError("invalid")
    }

    return packets
  }

  private createAssPackets(
    blocks: DecodedBlock[],
    timestampScale: number
  ): MatroskaAssPacket[] {
    return blocks.map((block) => {
      const endTime = this.endTime(
        block.startTime,
        block.durationTicks,
        timestampScale
      )

      return {
        data: block.packetBytes,
        startTime: block.startTime,
        duration: endTime - block.startTime,
      }
    })
  }

  private async readMetadata(signal: AbortSignal): Promise<ParsedFile> {
    if (this.metadata !== null) {
      return this.metadata
    }

    try {
      const parsed = await this.parseMetadata(signal)
      this.metadata = parsed

      return parsed
    } catch (error) {
      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted")
      }

      throw error
    }
  }

  private async parseMetadata(signal: AbortSignal): Promise<ParsedFile> {
    const segment = await this.readSegmentHeader(signal)
    const fileSize = this.reader.size

    if (fileSize === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    const segmentEnd = segment.end ?? fileSize

    const elements = await this.scanMetadataPrefix(segment, segmentEnd, signal)

    const resolved = await this.resolveSeekTargets(
      segment.dataStart,
      elements,
      signal
    )

    if (resolved.tracks === null || resolved.tracks.size === null) {
      throw new MatroskaSubtitleError("unsupported")
    }

    if (resolved.tracks.size > MAX_METADATA_SCAN_BYTES) {
      throw new MatroskaSubtitleError("limit")
    }

    const timestampScale =
      resolved.info === null
        ? 1_000_000
        : await this.readTimestampScale(resolved.info, signal)

    return {
      segmentDataStart: segment.dataStart,
      segmentEnd,
      timestampScale,
      tracks: await this.readTracks(resolved.tracks, signal),
      firstCluster: resolved.firstCluster,
      cues: resolved.cues,
      attachments: resolved.attachments,
    }
  }

  private async readSegmentHeader(signal: AbortSignal): Promise<ElementHeader> {
    await this.reader.read(0, 1, signal)

    const ebml = await elementAt(this.reader, 0, signal)

    if (ebml.id !== EBML || ebml.end === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    const segment = await elementAt(this.reader, ebml.end, signal)

    if (segment.id !== SEGMENT) {
      throw new MatroskaSubtitleError("invalid")
    }

    return segment
  }

  private async scanMetadataPrefix(
    segment: ElementHeader,
    segmentEnd: number,
    signal: AbortSignal
  ): Promise<MetadataElements> {
    const elements: MetadataElements = {
      seekPositions: new Map(),
      info: null,
      tracks: null,
      cues: null,
      attachments: null,
      firstCluster: null,
    }

    let offset = segment.dataStart
    const scanEnd = Math.min(segmentEnd, offset + MAX_METADATA_SCAN_BYTES)

    while (offset < scanEnd) {
      const element = await elementAt(this.reader, offset, signal)

      if (element.id === SEEK_HEAD) {
        await this.parseSeekHead(element, elements.seekPositions, signal)
      } else if (element.id === INFO) {
        elements.info = element
      } else if (element.id === TRACKS) {
        elements.tracks = element
      } else if (element.id === CUES) {
        elements.cues = element
      } else if (element.id === ATTACHMENTS) {
        elements.attachments = element
      } else if (element.id === CLUSTER) {
        elements.firstCluster = element
        break
      }

      if (element.end === null) {
        break
      }

      offset = element.end
    }

    return elements
  }

  private async resolveSeekTargets(
    segmentDataStart: number,
    elements: MetadataElements,
    signal: AbortSignal
  ): Promise<MetadataElements> {
    const infoPosition = elements.seekPositions.get(INFO)
    const tracksPosition = elements.seekPositions.get(TRACKS)
    const cuesPosition = elements.seekPositions.get(CUES)
    const attachmentsPosition = elements.seekPositions.get(ATTACHMENTS)

    if (elements.info === null && infoPosition !== undefined) {
      elements.info = await this.readSeekTarget({
        segmentDataStart,
        relativePosition: infoPosition,
        expectedId: INFO,
        signal,
      })
    }

    if (elements.tracks === null && tracksPosition !== undefined) {
      elements.tracks = await this.readSeekTarget({
        segmentDataStart,
        relativePosition: tracksPosition,
        expectedId: TRACKS,
        signal,
      })
    }

    if (elements.cues === null && cuesPosition !== undefined) {
      elements.cues = await this.readSeekTarget({
        segmentDataStart,
        relativePosition: cuesPosition,
        expectedId: CUES,
        signal,
      })
    }

    if (elements.attachments === null && attachmentsPosition !== undefined) {
      elements.attachments = await this.readSeekTarget({
        segmentDataStart,
        relativePosition: attachmentsPosition,
        expectedId: ATTACHMENTS,
        signal,
      })
    }

    return elements
  }

  private async parseSeekHead(
    element: ElementHeader,
    positions: Map<number, number>,
    signal: AbortSignal
  ): Promise<void> {
    if (element.size === null || element.size > MAX_METADATA_SCAN_BYTES) {
      throw new MatroskaSubtitleError("limit")
    }

    for await (const seek of childElements(this.reader, {
      start: element.dataStart,
      end: element.end ?? element.dataStart,
      signal,
    })) {
      if (seek.id !== SEEK || seek.end === null) {
        continue
      }

      let targetId: number | null = null
      let targetPosition: number | null = null

      for await (const field of childElements(this.reader, {
        start: seek.dataStart,
        end: seek.end,
        signal,
      })) {
        if (field.id === SEEK_ID && field.size !== null && field.size <= 4) {
          const bytes = await this.reader.read(
            field.dataStart,
            field.size,
            signal
          )

          targetId = bytes.reduce((value, byte) => (value << 8) | byte, 0)
        } else if (field.id === SEEK_POSITION) {
          targetPosition = await readUnsignedElement(this.reader, field, signal)
        }
      }

      if (targetId !== null && targetPosition !== null) {
        positions.set(targetId, targetPosition)
      }
    }
  }

  private async readSeekTarget({
    segmentDataStart,
    relativePosition,
    expectedId,
    signal,
  }: SeekTargetOptions): Promise<ElementHeader> {
    const reader =
      expectedId === CUES
        ? this.rangeReaders.createCueRangeReader(this.reader.size)
        : this.reader

    const target = await elementAt(
      reader,
      segmentDataStart + relativePosition,
      signal
    )

    if (target.id !== expectedId || target.size === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    return target
  }

  private async readTimestampScale(
    info: ElementHeader,
    signal: AbortSignal
  ): Promise<number> {
    if (info.size === null || info.end === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    for await (const child of childElements(this.reader, {
      start: info.dataStart,
      end: info.end,
      signal,
    })) {
      if (child.id === TIMESTAMP_SCALE) {
        const value = await readUnsignedElement(this.reader, child, signal)

        if (value <= 0) {
          throw new MatroskaSubtitleError("invalid")
        }

        return value
      }
    }

    return 1_000_000
  }

  private async readTracks(
    tracksElement: ElementHeader,
    signal: AbortSignal
  ): Promise<ParsedTrack[]> {
    if (tracksElement.size === null || tracksElement.end === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    const result: ParsedTrack[] = []

    for await (const entry of childElements(this.reader, {
      start: tracksElement.dataStart,
      end: tracksElement.end,
      signal,
    })) {
      if (entry.id !== TRACK_ENTRY || entry.end === null) {
        continue
      }

      const track = await this.readTrackEntry(entry, signal)

      if (track !== null) {
        result.push({
          ...track,
          label: track.label || `Subtitle ${result.length + 1}`,
        })
      }
    }

    return result
  }

  private async readTrackEntry(
    entry: ElementHeader,
    signal: AbortSignal
  ): Promise<ParsedTrack | null> {
    const metadata = createTrackMetadata()

    for await (const field of childElements(this.reader, {
      start: entry.dataStart,
      end: entry.end ?? entry.dataStart,
      signal,
    })) {
      await this.readTrackField(metadata, field, signal)
    }

    if (
      metadata.trackType !== 17 ||
      (metadata.codecId !== "S_TEXT/UTF8" &&
        metadata.codecId !== "S_HDMV/PGS" &&
        (metadata.codecId === null || !isAssCodecId(metadata.codecId))) ||
      metadata.trackNumber === null
    ) {
      return null
    }

    return {
      id: `matroska-${metadata.trackNumber}`,
      trackNumber: metadata.trackNumber,
      codecId: metadata.codecId,
      label: metadata.trackName?.trim() ?? "",
      language:
        metadata.languageIetf?.trim() || metadata.language?.trim() || "eng",
      flags: metadata.flags,
      hasContentEncodings: metadata.hasContentEncodings,
      contentEncodings: metadata.contentEncodings,
      contentEncodingsUnsupported: metadata.contentEncodingsUnsupported,
      codecPrivate: metadata.codecPrivate,
      attachmentLinkUids: metadata.attachmentLinkUids,
    }
  }

  private async readTrackField(
    metadata: TrackMetadata,
    field: ElementHeader,
    signal: AbortSignal
  ): Promise<void> {
    switch (field.id) {
      case TRACK_NUMBER:
        metadata.trackNumber = await readUnsignedElement(
          this.reader,
          field,
          signal
        )
        break
      case TRACK_TYPE:
        metadata.trackType = await readUnsignedElement(
          this.reader,
          field,
          signal
        )
        break
      case CODEC_ID:
        metadata.codecId = await readStringElement(this.reader, field, signal)
        break
      case TRACK_NAME:
        metadata.trackName = await readStringElement(this.reader, field, signal)
        break
      case TRACK_LANGUAGE:
        metadata.language = await readStringElement(this.reader, field, signal)
        break
      case TRACK_LANGUAGE_IETF:
        metadata.languageIetf = await readStringElement(
          this.reader,
          field,
          signal
        )
        break
      case CODEC_PRIVATE:
        metadata.codecPrivate = field
        break
      case ATTACHMENT_LINK:
        if (metadata.attachmentLinkUids.length <= MAX_ASS_FONT_FILES) {
          metadata.attachmentLinkUids.push(
            await readUnsignedElement(this.reader, field, signal)
          )
        }

        break
      case CONTENT_ENCODINGS:
        if (metadata.hasContentEncodings) {
          metadata.contentEncodingsUnsupported = true
        }

        metadata.hasContentEncodings = true
        {
          const parsed = await this.readContentEncodings(field, signal)
          metadata.contentEncodings.push(...parsed.encodings)
          metadata.contentEncodingsUnsupported ||= parsed.unsupported
        }

        break
      default:
        await this.readTrackFlag(metadata.flags, field, signal)
    }
  }

  private async readContentEncodings(
    element: ElementHeader,
    signal: AbortSignal
  ): Promise<{
    encodings: MatroskaContentEncoding[]
    unsupported: boolean
  }> {
    if (element.end === null || element.size === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    const encodings: MatroskaContentEncoding[] = []
    let unsupported = false

    for await (const child of childElements(this.reader, {
      start: element.dataStart,
      end: element.end,
      signal,
    })) {
      if (child.id !== CONTENT_ENCODING) {
        unsupported = true
        continue
      }

      if (encodings.length >= MAX_CONTENT_ENCODINGS) {
        throw new MatroskaSubtitleError("limit")
      }

      encodings.push(await this.readContentEncoding(child, signal))
    }

    return { encodings, unsupported }
  }

  private async readContentEncoding(
    element: ElementHeader,
    signal: AbortSignal
  ): Promise<MatroskaContentEncoding> {
    if (element.end === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    const encoding: MatroskaContentEncoding = {
      order: 0,
      scope: 1,
      type: 0,
      compressionAlgorithm: null,
      compressionSettings: new Uint8Array(),
      hasCompression: false,
      hasEncryption: false,
      unsupported: false,
    }

    const seen = new Set<number>()

    for await (const child of childElements(this.reader, {
      start: element.dataStart,
      end: element.end,
      signal,
    })) {
      if (seen.has(child.id)) {
        encoding.unsupported = true
        continue
      }

      seen.add(child.id)

      switch (child.id) {
        case CONTENT_ENCODING_ORDER:
          encoding.order = await readUnsignedElement(this.reader, child, signal)
          break
        case CONTENT_ENCODING_SCOPE:
          encoding.scope = await readUnsignedElement(this.reader, child, signal)
          break
        case CONTENT_ENCODING_TYPE:
          encoding.type = await readUnsignedElement(this.reader, child, signal)
          break
        case CONTENT_COMPRESSION: {
          encoding.hasCompression = true
          const compression = await this.readContentCompression(child, signal)
          encoding.compressionAlgorithm = compression.algorithm
          encoding.compressionSettings = compression.settings
          encoding.unsupported ||= compression.unsupported
          break
        }

        case CONTENT_ENCRYPTION:
          encoding.hasEncryption = true
          break
        default:
          encoding.unsupported = true
      }
    }

    return encoding
  }

  private async readContentCompression(
    element: ElementHeader,
    signal: AbortSignal
  ): Promise<{
    algorithm: number
    settings: Uint8Array
    unsupported: boolean
  }> {
    if (element.end === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    let algorithm = 0
    let settings: Uint8Array = new Uint8Array()
    let unsupported = false
    const seen = new Set<number>()

    for await (const child of childElements(this.reader, {
      start: element.dataStart,
      end: element.end,
      signal,
    })) {
      if (seen.has(child.id)) {
        unsupported = true
        continue
      }

      seen.add(child.id)

      if (child.id === CONTENT_COMP_ALGO) {
        algorithm = await readUnsignedElement(this.reader, child, signal)
      } else if (child.id === CONTENT_COMP_SETTINGS) {
        if (
          child.size === null ||
          child.size > MAX_CONTENT_ENCODING_SETTINGS_BYTES
        ) {
          throw new MatroskaSubtitleError("limit")
        }

        settings = await this.reader.read(child.dataStart, child.size, signal)
      } else {
        unsupported = true
      }
    }

    return { algorithm, settings, unsupported }
  }

  private async readLinkedFonts(
    attachments: ElementHeader | null,
    attachmentLinkUids: number[],
    signal: AbortSignal
  ): Promise<Uint8Array[]> {
    if (attachmentLinkUids.length === 0 || attachments === null) {
      return []
    }

    if (
      attachmentLinkUids.length > MAX_ASS_FONT_FILES ||
      attachments.end === null
    ) {
      throw new MatroskaSubtitleError("limit")
    }

    const linkedUids = new Set(attachmentLinkUids)

    return this.readLinkedFontAttachments(attachments, linkedUids, signal)
  }

  private async readLinkedFontAttachments(
    attachments: ElementHeader,
    linkedUids: Set<number>,
    signal: AbortSignal
  ): Promise<Uint8Array[]> {
    if (attachments.end === null) {
      throw new MatroskaSubtitleError("limit")
    }

    const fonts: Uint8Array[] = []
    let seenFiles = 0
    let totalFontBytes = 0

    for await (const entry of childElements(this.reader, {
      start: attachments.dataStart,
      end: attachments.end,
      signal,
    })) {
      if (entry.id !== ATTACHED_FILE) {
        continue
      }

      seenFiles += 1

      if (seenFiles > MAX_ASS_FONT_FILES) {
        throw new MatroskaSubtitleError("limit")
      }

      const file = await this.readAttachedFile(entry, signal)

      const font = await this.readLinkedFont({
        file,
        linkedUids,
        totalFontBytes,
        signal,
      })

      if (font === null) {
        continue
      }

      totalFontBytes += font.byteLength
      fonts.push(font)
    }

    return fonts
  }

  private async readLinkedFont({
    file,
    linkedUids,
    totalFontBytes,
    signal,
  }: LinkedFontReadOptions): Promise<Uint8Array | null> {
    if (
      file.uid === null ||
      !linkedUids.has(file.uid) ||
      !isFontAttachment(file)
    ) {
      return null
    }

    if (
      file.data === null ||
      file.data.size === null ||
      file.data.size === 0 ||
      file.data.size > MAX_ASS_FONT_FILE_BYTES ||
      totalFontBytes + file.data.size > MAX_ASS_FONT_BYTES
    ) {
      throw new MatroskaSubtitleError("limit")
    }

    return this.reader.read(file.data.dataStart, file.data.size, signal)
  }

  private async readAttachedFile(
    entry: ElementHeader,
    signal: AbortSignal
  ): Promise<AttachedFile> {
    if (entry.end === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    const file: AttachedFile = {
      uid: null,
      name: null,
      mimeType: null,
      data: null,
    }

    for await (const field of childElements(this.reader, {
      start: entry.dataStart,
      end: entry.end,
      signal,
    })) {
      if (field.id === FILE_UID) {
        file.uid = await readUnsignedElement(this.reader, field, signal)
      } else if (field.id === FILE_NAME) {
        file.name = await readStringElement(this.reader, field, signal)
      } else if (field.id === FILE_MIME_TYPE) {
        file.mimeType = await readStringElement(this.reader, field, signal)
      } else if (field.id === FILE_DATA) {
        file.data = field
      }
    }

    return file
  }

  private async readTrackFlag(
    flags: SubtitleTrackFlags,
    field: ElementHeader,
    signal: AbortSignal
  ): Promise<void> {
    const flagName = TRACK_FLAG_NAMES.get(field.id)

    if (flagName !== undefined) {
      flags[flagName] =
        (await readUnsignedElement(this.reader, field, signal)) !== 0
    }
  }

  private async readCuePositions(
    metadata: ParsedFile,
    trackNumber: number,
    signal: AbortSignal
  ): Promise<CuePoint[]> {
    const cuesElement = metadata.cues

    if (
      cuesElement === null ||
      cuesElement.size === null ||
      cuesElement.end === null
    ) {
      return []
    }

    if (cuesElement.size > MAX_CUES_ELEMENT_BYTES) {
      throw new MatroskaSubtitleError("limit")
    }

    const rangeReader = this.rangeReaders.createCueRangeReader(this.reader.size)

    const cueBytes = await rangeReader.readParallel(
      cuesElement.dataStart,
      cuesElement.size,
      signal
    )

    const reader = new MemoryRangeReader(
      cueBytes,
      cuesElement.dataStart,
      cuesElement.end
    )

    const result: CuePoint[] = []

    for await (const point of childElements(reader, {
      start: cuesElement.dataStart,
      end: cuesElement.end,
      signal,
    })) {
      const cuePoint = await this.readCuePoint({
        reader,
        point,
        trackNumber,
        signal,
      })

      if (cuePoint !== null) {
        result.push(cuePoint)

        if (result.length > MAX_SUBTITLE_CUES) {
          throw new MatroskaSubtitleError("limit")
        }
      }
    }

    return result
  }

  private async readPgsCuePositions(
    metadata: ParsedFile,
    trackNumber: number,
    signal: AbortSignal
  ): Promise<CuePoint[]> {
    const cached = this.pgsCueIndexes.get(trackNumber)

    if (cached !== undefined && !cached.signal?.aborted) {
      return cached.promise
    }

    const entry: PgsCueIndexCacheEntry = {
      promise: Promise.resolve([]),
      signal,
    }

    const reading = this.readCuePositions(metadata, trackNumber, signal).then(
      (cuePoints) => {
        entry.signal = null

        return cuePoints
      }
    )

    entry.promise = reading
    this.pgsCueIndexes.set(trackNumber, entry)

    try {
      return await reading
    } catch (error) {
      if (this.pgsCueIndexes.get(trackNumber) === entry) {
        this.pgsCueIndexes.delete(trackNumber)
      }

      throw error
    }
  }

  private async readTrackBlocks({
    metadata,
    trackNumber,
    signal,
    onProgress,
  }: TrackBlockReadOptions): Promise<DecodedBlock[]> {
    const blocks: DecodedBlock[] = []

    for await (const batch of this.readTrackBlockBatches({
      metadata,
      trackNumber,
      signal,
      onProgress,
    })) {
      this.appendDecodedBlocks(blocks, batch)
    }

    return blocks
  }

  private async *readPgsTrackWithinBudget(
    trackNumber: number,
    signal: AbortSignal
  ): AsyncGenerator<MatroskaPgsPacket> {
    const deadline = withDeadline(signal, PGS_TRACK_DEADLINE_MS)

    const progress: PgsTrackProgress = {
      packetCount: 0,
      packetBytes: 0,
      lastPacketTime: undefined,
    }

    try {
      const metadata = await this.readMetadata(deadline.signal)
      this.assertPgsTrack(metadata, trackNumber)

      yield* this.readPgsPacketsWithinBudget({
        metadata,
        trackNumber,
        signal: deadline.signal,
        progress,
      })
    } catch (failure) {
      throw normalizePgsTrackFailure({
        failure: failure instanceof MatroskaSubtitleError ? failure : null,
        signalAborted: signal.aborted,
        deadlineExpired: deadline.expired(),
        lastPacketTime: progress.lastPacketTime,
      })
    } finally {
      deadline.dispose()
    }
  }

  private assertPgsTrack(metadata: ParsedFile, trackNumber: number): void {
    const track = metadata.tracks.find(
      (candidate) => candidate.trackNumber === trackNumber
    )

    if (track === undefined || track.codecId !== "S_HDMV/PGS") {
      throw new MatroskaSubtitleError("invalid")
    }

    orderedContentEncodings(track)
  }

  private async readPgsWindowCueEntries({
    metadata,
    trackNumber,
    cueEntries,
    cueClusterPositions,
    startIndex,
    endIndex,
    includeGaps,
    signal,
  }: {
    metadata: ParsedFile
    trackNumber: number
    cueEntries: PgsWindowCueEntry[]
    cueClusterPositions: Map<number, TrackPosition[]>
    startIndex: number
    endIndex: number
    includeGaps: boolean
    signal: AbortSignal
  }): Promise<MatroskaPgsPacket[]> {
    const packets: MatroskaPgsPacket[] = []
    let previous: PgsWindowCueReadResult | null = null

    for (let index = startIndex; index <= endIndex; index += 1) {
      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted")
      }

      const entry = cueEntries[index]

      if (entry === undefined) {
        throw new MatroskaSubtitleError("invalid")
      }

      const current = await this.readPgsWindowCueEntry({
        metadata,
        trackNumber,
        entry,
        cueClusterPositions,
        signal,
      })

      packets.push(...current.packets)

      if (includeGaps && previous !== null) {
        packets.push(
          ...(await this.readPgsWindowGap({
            metadata,
            trackNumber,
            previous,
            current,
            cueClusterPositions,
            signal,
          }))
        )
      }

      previous = current
    }

    const orderedPackets = mergePgsWindowPackets(packets)

    if (orderedPackets.length > MAX_PGS_TRACK_PACKETS) {
      throw new MatroskaSubtitleError("limit", orderedPackets.at(-1)?.startTime)
    }

    return orderedPackets
  }

  private async readPgsWindowCueEntry({
    metadata,
    trackNumber,
    entry,
    cueClusterPositions,
    signal,
  }: {
    metadata: ParsedFile
    trackNumber: number
    entry: PgsWindowCueEntry
    cueClusterPositions: Map<number, TrackPosition[]>
    signal: AbortSignal
  }): Promise<PgsWindowCueReadResult> {
    const { position } = entry
    const clusterStart = metadata.segmentDataStart + position.clusterPosition

    const cluster = await this.readPgsClusterHeader({
      clusterPosition: clusterStart,
      signal,
    })

    const clusterPositions = cueClusterPositions.get(
      position.clusterPosition
    ) ?? [position]

    if (position.relativePosition === null) {
      const clusterLength = (cluster.end ?? cluster.dataStart) - cluster.start

      if (clusterLength > MAX_PGS_WINDOW_GAP_BYTES) {
        throw new MatroskaSubtitleError("limit", entry.time)
      }

      const packets = await this.readPgsCluster({
        metadata,
        clusterPosition: clusterStart,
        trackNumber,
        positions: clusterPositions,
        signal,
      })

      return {
        packets,
        cluster,
        position,
        blockEnd: cluster.end ?? cluster.dataStart,
      }
    }

    const blockStart = cluster.dataStart + position.relativePosition
    const child = await elementAt(this.reader, blockStart, signal)

    if (
      child.end === null ||
      child.end > (cluster.end ?? child.end) ||
      (child.id !== SIMPLE_BLOCK && child.id !== BLOCK_GROUP)
    ) {
      throw new MatroskaSubtitleError("invalid", entry.time)
    }

    const clusterTicks = await this.readClusterTimestamp(cluster, signal)

    const context: PgsClusterContext = {
      metadata,
      cluster,
      clusterTicks,
      trackNumber,
      cueDurations: createPgsCueDurationMap(clusterPositions),
      signal,
    }

    this.reader.prefetch(child.dataStart, child.end, signal)

    return {
      packets: await this.readPgsClusterChild(child, context),
      cluster,
      position,
      blockEnd: child.end,
    }
  }

  private async readPgsWindowGap(
    request: PgsWindowGapRequest
  ): Promise<MatroskaPgsPacket[]> {
    const { previous, current } = request
    const previousEnd = previous.cluster.end

    if (previousEnd === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    if (previous.cluster.start === current.cluster.start) {
      return this.readSameClusterPgsWindowGap(request)
    }

    return this.readPgsWindowBetweenClusters(request, previousEnd)
  }

  private async readSameClusterPgsWindowGap({
    metadata,
    trackNumber,
    previous,
    current,
    cueClusterPositions,
    signal,
  }: PgsWindowGapRequest): Promise<MatroskaPgsPacket[]> {
    const nextRelativePosition = current.position.relativePosition

    if (nextRelativePosition === null) {
      return []
    }

    return this.readPgsWindowClusterChildren({
      metadata,
      trackNumber,
      cluster: previous.cluster,
      positions:
        cueClusterPositions.get(previous.position.clusterPosition) ?? [],
      startOffset: previous.blockEnd,
      endOffset: current.cluster.dataStart + nextRelativePosition,
      signal,
    })
  }

  private async readPgsWindowBetweenClusters(
    request: PgsWindowGapRequest,
    previousEnd: number
  ): Promise<MatroskaPgsPacket[]> {
    const {
      metadata,
      trackNumber,
      previous,
      current,
      cueClusterPositions,
      signal,
    } = request

    const currentClusterPosition = current.cluster.start

    if (previousEnd > currentClusterPosition) {
      throw new MatroskaSubtitleError("invalid")
    }

    const packets = await this.readPgsWindowClusterChildren({
      metadata,
      trackNumber,
      cluster: previous.cluster,
      positions:
        cueClusterPositions.get(previous.position.clusterPosition) ?? [],
      startOffset: previous.blockEnd,
      endOffset: previousEnd,
      signal,
    })

    const gapBytes = currentClusterPosition - previousEnd

    if (gapBytes > MAX_PGS_WINDOW_GAP_BYTES) {
      throw new MatroskaSubtitleError("limit")
    }

    const cueClusters = cueClustersBetween({
      cueClusterPositions,
      segmentDataStart: metadata.segmentDataStart,
      startOffset: previousEnd,
      endOffset: currentClusterPosition,
    })

    await this.appendPgsWindowPhysicalGap({
      packets,
      metadata,
      trackNumber,
      cueClusters,
      startOffset: previousEnd,
      endOffset: currentClusterPosition,
      signal,
    })

    return packets
  }

  private async appendPgsWindowPhysicalGap({
    packets,
    metadata,
    trackNumber,
    cueClusters,
    startOffset,
    endOffset,
    signal,
  }: {
    packets: MatroskaPgsPacket[]
    metadata: ParsedFile
    trackNumber: number
    cueClusters: Map<number, TrackPosition[]>
    startOffset: number
    endOffset: number
    signal: AbortSignal
  }): Promise<void> {
    for await (const [
      clusterPosition,
      positions,
    ] of this.readPgsPhysicalClusters({
      metadata,
      cueClusters,
      startOffset,
      endOffset,
      signal,
    })) {
      const clusterStart = metadata.segmentDataStart + clusterPosition

      const cluster = await this.readPgsClusterHeader({
        clusterPosition: clusterStart,
        signal,
      })

      const clusterBytes = (cluster.end ?? cluster.dataStart) - cluster.start

      if (clusterBytes > MAX_PGS_WINDOW_GAP_BYTES) {
        throw new MatroskaSubtitleError("limit")
      }

      packets.push(
        ...(await this.readPgsCluster({
          metadata,
          clusterPosition: clusterStart,
          trackNumber,
          positions,
          signal,
        }))
      )
    }
  }

  private async readPgsWindowClusterChildren({
    metadata,
    trackNumber,
    cluster,
    positions,
    startOffset,
    endOffset,
    signal,
  }: {
    metadata: ParsedFile
    trackNumber: number
    cluster: ElementHeader
    positions: TrackPosition[]
    startOffset: number
    endOffset: number
    signal: AbortSignal
  }): Promise<MatroskaPgsPacket[]> {
    if (
      endOffset < startOffset ||
      endOffset > (cluster.end ?? endOffset) ||
      endOffset - startOffset > MAX_PGS_WINDOW_GAP_BYTES
    ) {
      throw new MatroskaSubtitleError("limit")
    }

    if (endOffset === startOffset) {
      return []
    }

    const clusterTicks = await this.readClusterTimestamp(cluster, signal)

    const context: PgsClusterContext = {
      metadata,
      cluster,
      clusterTicks,
      trackNumber,
      cueDurations: createPgsCueDurationMap(positions),
      signal,
    }

    const packets: MatroskaPgsPacket[] = []
    let offset = startOffset

    while (offset < endOffset) {
      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted")
      }

      const child = await elementAt(this.reader, offset, signal)

      if (
        child.end === null ||
        child.end > (cluster.end ?? child.end) ||
        child.end > endOffset
      ) {
        throw new MatroskaSubtitleError("limit")
      }

      packets.push(...(await this.readPgsClusterChild(child, context)))
      offset = child.end
    }

    if (offset !== endOffset) {
      throw new MatroskaSubtitleError("invalid")
    }

    return packets
  }

  private async *readPgsPacketsWithinBudget({
    metadata,
    trackNumber,
    signal,
    progress,
  }: PgsPacketStreamRequest): AsyncGenerator<MatroskaPgsPacket> {
    for await (const batch of this.readPgsTrackPacketBatches(
      metadata,
      trackNumber,
      signal
    )) {
      yield* this.validatePgsPacketBatch(batch, progress)
    }

    if (progress.packetCount === 0) {
      throw new MatroskaSubtitleError("invalid")
    }
  }

  private *validatePgsPacketBatch(
    batch: MatroskaPgsPacket[],
    progress: PgsTrackProgress
  ): Generator<MatroskaPgsPacket> {
    for (const packet of batch) {
      progress.packetCount += 1
      progress.packetBytes += packet.data.byteLength

      if (
        progress.packetCount > MAX_PGS_TRACK_PACKETS ||
        progress.packetBytes > MAX_PGS_TRACK_BYTES
      ) {
        throw new MatroskaSubtitleError("limit", packet.startTime)
      }

      if (
        progress.lastPacketTime !== undefined &&
        packet.startTime < progress.lastPacketTime
      ) {
        throw new MatroskaSubtitleError("unsupported", progress.lastPacketTime)
      }

      progress.lastPacketTime = packet.startTime
      yield packet
    }
  }

  private async *readTrackBlockBatches({
    metadata,
    trackNumber,
    signal,
    onProgress,
  }: TrackBlockReadOptions): AsyncGenerator<DecodedBlock[]> {
    const cuePositions = await this.readCuePositions(
      metadata,
      trackNumber,
      signal
    )

    if (cuePositions.length === 0) {
      const blocks = await this.scanForTrack({
        metadata,
        trackNumber,
        signal,
        onProgress,
      })

      if (blocks.length > 0) {
        yield blocks
      }

      return
    }

    yield* this.readIndexedBlockBatches({
      metadata,
      trackNumber,
      cuePoints: cuePositions,
      signal,
      onProgress,
    })
  }

  private async *readPgsTrackPacketBatches(
    metadata: ParsedFile,
    trackNumber: number,
    signal: AbortSignal
  ): AsyncGenerator<MatroskaPgsPacket[]> {
    const cuePoints = await this.readPgsCuePositions(
      metadata,
      trackNumber,
      signal
    )

    if (cuePoints.length === 0) {
      yield* this.scanPgsTrack(metadata, trackNumber, signal)

      return
    }

    yield* this.readPgsPhysicalPacketBatches({
      metadata,
      trackNumber,
      cuePoints,
      signal,
    })
  }

  private async *readPgsPhysicalPacketBatches({
    metadata,
    trackNumber,
    cuePoints,
    signal,
  }: {
    metadata: ParsedFile
    trackNumber: number
    cuePoints: CuePoint[]
    signal: AbortSignal
  }): AsyncGenerator<MatroskaPgsPacket[]> {
    const clusters: IndexedCueCluster[] = []

    const orderedClusters = this.readPgsOrderedClusters({
      metadata,
      cuePoints,
      signal,
    })

    while (true) {
      let result: IteratorResult<IndexedCueCluster>

      try {
        result = await orderedClusters.next()
      } catch (error) {
        // Deliver already-discovered clusters before exposing an oversized
        // physical gap. Later dependent packets must not use stale state.
        if (clusters.length > 0) {
          yield* this.readPgsClusterBatches({
            metadata,
            trackNumber,
            clusters,
            signal,
          })
          clusters.length = 0
        }

        throw error
      }

      if (result.done) {
        break
      }

      clusters.push(result.value)

      if (clusters.length < PGS_CLUSTER_READ_WINDOW) {
        continue
      }

      yield* this.readPgsClusterBatches({
        metadata,
        trackNumber,
        clusters,
        signal,
      })
      clusters.length = 0
    }

    if (clusters.length > 0) {
      yield* this.readPgsClusterBatches({
        metadata,
        trackNumber,
        clusters,
        signal,
      })
    }
  }

  private async *readPgsOrderedClusters({
    metadata,
    cuePoints,
    signal,
  }: {
    metadata: ParsedFile
    cuePoints: CuePoint[]
    signal: AbortSignal
  }): AsyncGenerator<IndexedCueCluster> {
    if (metadata.firstCluster === null) {
      throw new MatroskaSubtitleError("unsupported")
    }

    const cueClusters = [...groupCuePositions(cuePoints).entries()]

    cueClusters.sort(([left], [right]) => left - right)

    const cueClusterMap = new Map(cueClusters)

    const [firstCue, ...remainingCues] = cueClusters

    if (firstCue === undefined) {
      throw new MatroskaSubtitleError("invalid")
    }

    yield* this.readPgsGapClusters({
      metadata,
      cueClusters: cueClusterMap,
      startOffset: metadata.firstCluster.start,
      endOffset: metadata.segmentDataStart + firstCue[0],
      maximumBytes: MAX_PGS_LEADING_GAP_BYTES,
      signal,
    })

    let previousCluster = await this.readPgsClusterHeader({
      clusterPosition: metadata.segmentDataStart + firstCue[0],
      signal,
    })

    yield firstCue

    for (const cue of remainingCues) {
      const cueOffset = metadata.segmentDataStart + cue[0]
      yield* this.readPgsGapClusters({
        metadata,
        cueClusters: cueClusterMap,
        startOffset: previousCluster.end ?? cueOffset,
        endOffset: cueOffset,
        maximumBytes: MAX_PGS_PHYSICAL_GAP_BYTES,
        signal,
      })

      previousCluster = await this.readPgsClusterHeader({
        clusterPosition: cueOffset,
        signal,
      })

      yield cue
    }

    yield* this.readPgsGapClusters({
      metadata,
      cueClusters: cueClusterMap,
      startOffset: previousCluster.end ?? metadata.segmentEnd,
      endOffset: metadata.segmentEnd,
      maximumBytes: MAX_PGS_PHYSICAL_GAP_BYTES,
      signal,
    })
  }

  private async *readPgsGapClusters({
    metadata,
    cueClusters,
    startOffset,
    endOffset,
    maximumBytes,
    signal,
  }: {
    metadata: ParsedFile
    cueClusters: Map<number, TrackPosition[]>
    startOffset: number
    endOffset: number
    maximumBytes: number
    signal: AbortSignal
  }): AsyncGenerator<IndexedCueCluster> {
    const gapBytes = endOffset - startOffset

    if (gapBytes < 0) {
      throw new MatroskaSubtitleError("invalid")
    }

    if (gapBytes > maximumBytes) {
      if (maximumBytes === MAX_PGS_LEADING_GAP_BYTES) {
        return
      }

      throw new MatroskaSubtitleError("limit")
    }

    yield* this.readPgsPhysicalClusters({
      metadata,
      cueClusters,
      startOffset,
      endOffset,
      signal,
    })
  }

  private async *readPgsPhysicalClusters({
    metadata,
    cueClusters,
    startOffset,
    endOffset,
    signal,
  }: {
    metadata: ParsedFile
    cueClusters: Map<number, TrackPosition[]>
    startOffset: number
    endOffset: number
    signal: AbortSignal
  }): AsyncGenerator<IndexedCueCluster> {
    if (
      startOffset < 0 ||
      endOffset <= startOffset ||
      endOffset > metadata.segmentEnd
    ) {
      return
    }

    let offset = startOffset
    let scannedBytes = 0

    while (offset < endOffset) {
      const result = await this.readPgsPhysicalCluster({
        metadata,
        cueClusters,
        offset,
        signal,
      })

      scannedBytes += result.nextOffset - offset
      offset = result.nextOffset

      if (scannedBytes > MAX_PGS_PHYSICAL_GAP_BYTES) {
        throw new MatroskaSubtitleError("limit")
      }

      if (result.cluster === null) {
        continue
      }

      yield result.cluster
    }

    if (offset !== endOffset) {
      throw new MatroskaSubtitleError("invalid")
    }
  }

  private async readPgsPhysicalCluster({
    metadata,
    cueClusters,
    offset,
    signal,
  }: {
    metadata: ParsedFile
    cueClusters: Map<number, TrackPosition[]>
    offset: number
    signal: AbortSignal
  }): Promise<PgsPhysicalClusterReadResult> {
    if (signal.aborted) {
      throw new MatroskaSubtitleError("aborted")
    }

    const topLevel = await elementAt(this.reader, offset, signal)

    if (
      topLevel.end === null ||
      topLevel.end <= offset ||
      topLevel.end > metadata.segmentEnd
    ) {
      throw new MatroskaSubtitleError("invalid")
    }

    if (topLevel.id === CLUSTER) {
      const clusterPosition = topLevel.start - metadata.segmentDataStart
      const positions = cueClusters.get(clusterPosition) ?? []

      return {
        nextOffset: topLevel.end,
        cluster: [clusterPosition, positions],
      }
    }

    return { nextOffset: topLevel.end, cluster: null }
  }

  private async *readPgsClusterBatches({
    metadata,
    trackNumber,
    clusters,
    signal,
  }: {
    metadata: ParsedFile
    trackNumber: number
    clusters: IndexedCueCluster[]
    signal: AbortSignal
  }): AsyncGenerator<MatroskaPgsPacket[]> {
    const readWindow = new IndexedClusterReadWindow({
      clusters,
      signal,
      concurrency: 3,
      window: 6,
      readCluster: ([clusterPosition, positions], readSignal) =>
        this.readPgsCluster({
          metadata,
          clusterPosition: metadata.segmentDataStart + clusterPosition,
          trackNumber,
          positions,
          signal: readSignal,
        }),
    })

    for await (const packets of readWindow.batches()) {
      const orderedPackets = [...packets]

      // Sorting a copy keeps the read-window batch untouched.
      orderedPackets.sort(comparePgsPacketOrder)

      if (orderedPackets.length > 0) {
        yield orderedPackets
      }
    }
  }

  private async *scanPgsTrack(
    metadata: ParsedFile,
    trackNumber: number,
    signal: AbortSignal
  ): AsyncGenerator<MatroskaPgsPacket[]> {
    if (metadata.firstCluster === null) {
      throw new MatroskaSubtitleError("unsupported")
    }

    const scanEnd = Math.min(
      metadata.segmentEnd,
      metadata.firstCluster.start + MAX_PGS_NO_CUES_SCAN_BYTES
    )

    let offset = metadata.firstCluster.start
    let lastPacketTime: number | undefined

    while (offset < scanEnd) {
      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted", lastPacketTime)
      }

      const scan = await this.readNextPgsScanItem({
        metadata,
        offset,
        trackNumber,
        lastPacketTime,
        signal,
      })

      const {
        nextOffset,
        packets: scannedPackets,
        lastPacketTime: nextLastPacketTime,
      } = scan

      if (nextOffset === null) {
        return
      }

      if (scannedPackets.length > 0) {
        yield scannedPackets
      }

      offset = nextOffset
      lastPacketTime = nextLastPacketTime
    }

    if (offset < metadata.segmentEnd && offset >= scanEnd) {
      throw new MatroskaSubtitleError("limit", lastPacketTime)
    }
  }

  private async readNextPgsScanItem({
    metadata,
    offset,
    trackNumber,
    lastPacketTime,
    signal,
  }: PgsScanRequest): Promise<PgsScanResult> {
    const topLevel = await elementAt(this.reader, offset, signal)

    if (topLevel.id === CUES) {
      return { nextOffset: null, packets: [], lastPacketTime }
    }

    if (topLevel.end === null) {
      throw new MatroskaSubtitleError("unsupported", lastPacketTime)
    }

    if (topLevel.id !== CLUSTER) {
      return { nextOffset: topLevel.end, packets: [], lastPacketTime }
    }

    if (
      topLevel.end - (metadata.firstCluster?.start ?? offset) >
      MAX_PGS_NO_CUES_SCAN_BYTES
    ) {
      throw new MatroskaSubtitleError("limit", lastPacketTime)
    }

    const packets = await this.readPgsCluster({
      metadata,
      clusterPosition: offset,
      trackNumber,
      positions: [],
      signal,
    })

    const orderedPackets = [...packets]

    // Sorting a copy keeps the original packet collection untouched.
    orderedPackets.sort(comparePgsPacketOrder)

    return {
      nextOffset: topLevel.end,
      packets: orderedPackets,
      lastPacketTime: orderedPackets.at(-1)?.startTime ?? lastPacketTime,
    }
  }

  private async readPgsCluster({
    metadata,
    clusterPosition,
    trackNumber,
    positions,
    signal,
  }: PgsClusterReadRequest): Promise<MatroskaPgsPacket[]> {
    const cluster = await this.readPgsClusterHeader({
      clusterPosition,
      signal,
    })

    const clusterTicks = await this.readClusterTimestamp(cluster, signal)

    const context: PgsClusterContext = {
      metadata,
      cluster,
      clusterTicks,
      trackNumber,
      cueDurations: createPgsCueDurationMap(positions),
      signal,
    }

    return this.readPgsClusterPackets(context)
  }

  private async readPgsClusterHeader({
    clusterPosition,
    signal,
  }: {
    clusterPosition: number
    signal: AbortSignal
  }): Promise<ElementHeader> {
    const cluster = await elementAt(this.reader, clusterPosition, signal)

    if (cluster.id !== CLUSTER || cluster.end === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    return cluster
  }

  private async readPgsClusterPackets(
    context: PgsClusterContext
  ): Promise<MatroskaPgsPacket[]> {
    const packets: MatroskaPgsPacket[] = []

    const clusterEnd = context.cluster.end ?? context.cluster.dataStart

    for await (const child of childElements(this.reader, {
      start: context.cluster.dataStart,
      end: clusterEnd,
      signal: context.signal,
    })) {
      const childPackets = await this.readPgsClusterChild(child, context)

      if (childPackets.length > 0) {
        packets.push(...childPackets)
      }

      if (packets.length > MAX_PGS_TRACK_PACKETS) {
        throw new MatroskaSubtitleError("limit", packets.at(-1)?.startTime)
      }
    }

    return packets
  }

  private async readPgsClusterChild(
    child: ElementHeader,
    context: PgsClusterContext
  ): Promise<MatroskaPgsPacket[]> {
    if (child.id === SIMPLE_BLOCK) {
      return this.readPgsSimpleBlock(child, context)
    }

    if (child.id === BLOCK_GROUP) {
      return this.readPgsBlockGroup({
        group: child,
        clusterTicks: context.clusterTicks,
        timestampScale: context.metadata.timestampScale,
        cueDurationTicks: getPgsCueDuration(context, child),
        clusterPosition: context.cluster.start,
        targetTrackNumber: context.trackNumber,
        signal: context.signal,
      })
    }

    return []
  }

  private async readPgsSimpleBlock(
    child: ElementHeader,
    context: PgsClusterContext
  ): Promise<MatroskaPgsPacket[]> {
    if (
      (await this.readBlockTrackNumber(child, context.signal)) !==
      context.trackNumber
    ) {
      return []
    }

    if (child.end !== null) {
      this.reader.prefetch(child.dataStart, child.end, context.signal)
    }

    const parsed = await this.readBlockPayload(
      child,
      context.signal,
      MAX_PGS_BLOCK_BYTES
    )

    return this.createPgsPackets({
      parsed,
      clusterTicks: context.clusterTicks,
      blockDurationTicks: null,
      cueDurationTicks: getPgsCueDuration(context, child),
      timestampScale: context.metadata.timestampScale,
      clusterPosition: context.cluster.start,
      blockOffset: child.start,
    })
  }

  private async readPgsBlockGroup({
    group,
    clusterTicks,
    timestampScale,
    cueDurationTicks,
    clusterPosition,
    targetTrackNumber,
    signal,
  }: {
    group: ElementHeader
    clusterTicks: number
    timestampScale: number
    cueDurationTicks: number | null
    clusterPosition: number
    targetTrackNumber: number
    signal: AbortSignal
  }): Promise<MatroskaPgsPacket[]> {
    if (group.end === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    let parsed: ParsedBlock | null = null
    let blockElement: ElementHeader | null = null
    let durationTicks: number | null = null

    for await (const child of childElements(this.reader, {
      start: group.dataStart,
      end: group.end,
      signal,
    })) {
      if (child.id === BLOCK) {
        const blockTrackNumber = await this.readBlockTrackNumber(child, signal)

        if (blockTrackNumber !== targetTrackNumber) {
          continue
        }

        if (parsed !== null) {
          throw new MatroskaSubtitleError("unsupported")
        }

        if (child.end !== null) {
          this.reader.prefetch(child.dataStart, child.end, signal)
        }

        parsed = await this.readBlockPayload(child, signal, MAX_PGS_BLOCK_BYTES)
        blockElement = child
      } else if (child.id === BLOCK_DURATION) {
        durationTicks = await readUnsignedElement(this.reader, child, signal)
      }
    }

    if (parsed === null || blockElement === null) {
      return []
    }

    return this.createPgsPackets({
      parsed,
      clusterTicks,
      blockDurationTicks: durationTicks,
      cueDurationTicks,
      timestampScale,
      clusterPosition,
      blockOffset: blockElement.start,
    })
  }

  private createPgsPackets({
    parsed,
    clusterTicks,
    blockDurationTicks,
    cueDurationTicks,
    timestampScale,
    clusterPosition,
    blockOffset,
  }: {
    parsed: ParsedBlock
    clusterTicks: number
    blockDurationTicks: number | null
    cueDurationTicks: number | null
    timestampScale: number
    clusterPosition: number
    blockOffset: number
  }): MatroskaPgsPacket[] {
    const { dataBytes } = parsed
    const startTicks = clusterTicks + parsed.relativeTimestamp
    const startTime = (startTicks * timestampScale) / 1_000_000_000

    if (!Number.isFinite(startTime) || startTime < 0) {
      throw new MatroskaSubtitleError("invalid")
    }

    const durationTicks = blockDurationTicks ?? cueDurationTicks

    const duration =
      durationTicks === null || durationTicks <= 0
        ? null
        : (durationTicks * timestampScale) / 1_000_000_000

    if (
      !Number.isFinite(startTime) ||
      startTime < 0 ||
      (duration !== null && (!Number.isFinite(duration) || duration <= 0))
    ) {
      throw new MatroskaSubtitleError("invalid", startTime)
    }

    const packets = this.splitPgsSegments({
      dataBytes,
      startTime,
      duration,
      clusterPosition,
      blockOffset,
    })

    if (packets.length === 0) {
      throw new MatroskaSubtitleError("invalid", startTime)
    }

    return packets
  }

  private splitPgsSegments({
    dataBytes,
    startTime,
    duration,
    clusterPosition,
    blockOffset,
  }: {
    dataBytes: Uint8Array
    startTime: number
    duration: number | null
    clusterPosition: number
    blockOffset: number
  }): MatroskaPgsPacket[] {
    const packets: MatroskaPgsPacket[] = []
    let segmentOffset = 0

    while (segmentOffset < dataBytes.byteLength) {
      if (dataBytes.byteLength - segmentOffset < 3) {
        throw new MatroskaSubtitleError("invalid", startTime)
      }

      const type = dataBytes[segmentOffset] ?? 0

      const segmentLength =
        ((dataBytes[segmentOffset + 1] ?? 0) << 8) |
        (dataBytes[segmentOffset + 2] ?? 0)

      const nextSegmentOffset = segmentOffset + 3 + segmentLength

      if (![0x14, 0x15, 0x16, 0x17, 0x80].includes(type)) {
        throw new MatroskaSubtitleError("unsupported", startTime)
      }

      if (
        nextSegmentOffset > dataBytes.byteLength ||
        (type === 0x80 && segmentLength !== 0)
      ) {
        throw new MatroskaSubtitleError("invalid", startTime)
      }

      packets.push({
        data: dataBytes.slice(segmentOffset, nextSegmentOffset),
        startTime,
        duration,
        location: { clusterPosition, blockOffset, segmentOffset },
      })

      segmentOffset = nextSegmentOffset
    }

    return packets
  }

  private async readCuePoint({
    reader,
    point,
    trackNumber,
    signal,
  }: {
    reader: SubtitleRangeReader
    point: ElementHeader
    trackNumber: number
    signal: AbortSignal
  }): Promise<CuePoint | null> {
    if (point.id !== CUE_POINT || point.end === null) {
      return null
    }

    let timeTicks: number | null = null
    const positions: TrackPosition[] = []

    for await (const field of childElements(reader, {
      start: point.dataStart,
      end: point.end,
      signal,
    })) {
      if (field.id === CUE_TIME) {
        timeTicks = await readUnsignedElement(reader, field, signal)
      } else if (field.id === CUE_TRACK_POSITIONS && field.end !== null) {
        const position = await this.readCueTrackPosition(reader, field, signal)

        if (position.trackNumber === trackNumber) {
          positions.push(position)
        }
      }
    }

    if (timeTicks === null || positions.length === 0) {
      return null
    }

    if (positions.length > MAX_SUBTITLE_CUES) {
      throw new MatroskaSubtitleError("limit")
    }

    return { timeTicks, positions }
  }

  private async readCueTrackPosition(
    reader: SubtitleRangeReader,
    element: ElementHeader,
    signal: AbortSignal
  ): Promise<TrackPosition> {
    if (element.end === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    let trackNumber: number | null = null
    let clusterPosition: number | null = null
    let relativePosition: number | null = null
    let durationTicks: number | null = null

    for await (const field of childElements(reader, {
      start: element.dataStart,
      end: element.end,
      signal,
    })) {
      if (field.id === CUE_TRACK) {
        trackNumber = await readUnsignedElement(reader, field, signal)
      } else if (field.id === CUE_CLUSTER_POSITION) {
        clusterPosition = await readUnsignedElement(reader, field, signal)
      } else if (field.id === CUE_RELATIVE_POSITION) {
        relativePosition = await readUnsignedElement(reader, field, signal)
      } else if (field.id === CUE_DURATION) {
        durationTicks = await readUnsignedElement(reader, field, signal)
      }
    }

    if (trackNumber === null || clusterPosition === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    return { trackNumber, clusterPosition, relativePosition, durationTicks }
  }

  private async *readIndexedBlockBatches({
    metadata,
    trackNumber,
    cuePoints,
    signal,
    onProgress,
  }: IndexedCueOptions): AsyncGenerator<DecodedBlock[]> {
    const clusters = [...groupCuePositions(cuePoints)]
    let blockCount = 0
    let textBytes = 0

    const cueCount = clusters.reduce(
      (count, [, positions]) => count + positions.length,
      0
    )

    if (cueCount > MAX_SUBTITLE_CUES) {
      throw new MatroskaSubtitleError("limit")
    }

    const readWindow = new IndexedClusterReadWindow({
      clusters,
      signal,
      onProgress,
      readCluster: ([clusterPosition, positions], readSignal) =>
        this.readCueCluster({
          metadata,
          trackNumber,
          clusterPosition,
          positions,
          signal: readSignal,
        }),
    })

    for await (const decodedBlocks of readWindow.batches()) {
      for (const block of decodedBlocks) {
        blockCount += 1
        textBytes += block.textBytes

        if (
          blockCount > MAX_SUBTITLE_CUES ||
          textBytes > MAX_SUBTITLE_TEXT_BYTES
        ) {
          throw new MatroskaSubtitleError("limit")
        }
      }

      yield decodedBlocks
    }
  }

  private async readCueCluster({
    metadata,
    trackNumber,
    clusterPosition,
    positions,
    signal,
  }: CueClusterOptions): Promise<DecodedBlock[]> {
    const cluster = await elementAt(
      this.reader,
      metadata.segmentDataStart + clusterPosition,
      signal
    )

    if (cluster.id !== CLUSTER) {
      throw new MatroskaSubtitleError("invalid")
    }

    const clusterTicksPromise = this.readClusterTimestamp(cluster, signal)

    if (positions.some((position) => position.relativePosition === null)) {
      const clusterTicks = await clusterTicksPromise

      return this.scanCluster({
        cluster,
        clusterTicks,
        trackNumber,
        timestampScale: metadata.timestampScale,
        signal,
      })
    }

    const [clusterTicks, targets] = await Promise.all([
      clusterTicksPromise,
      (async () => {
        const elements: Array<{
          position: TrackPosition
          element: ElementHeader
        }> = []

        for (const position of positions) {
          const { relativePosition } = position

          if (relativePosition === null) {
            throw new MatroskaSubtitleError("invalid")
          }

          elements.push({
            position,
            element: await elementAt(
              this.reader,
              cluster.dataStart + relativePosition,
              signal
            ),
          })
        }

        return elements
      })(),
    ])

    const blocks: DecodedBlock[] = []

    for (const { position, element: target } of targets) {
      const { durationTicks } = position

      if (position.relativePosition === null) {
        throw new MatroskaSubtitleError("invalid")
      }

      const block = await this.readBlockElement({
        element: target,
        clusterTicks,
        timestampScale: metadata.timestampScale,
        cueDurationTicks: durationTicks,
        signal,
      })

      if (block.trackNumber !== trackNumber) {
        throw new MatroskaSubtitleError("invalid")
      }

      blocks.push(block)
    }

    return blocks
  }

  private appendDecodedBlocks(
    output: DecodedBlock[],
    blocks: DecodedBlock[]
  ): number {
    let textBytes = 0

    for (const block of blocks) {
      textBytes += block.textBytes
      output.push(block)

      if (
        output.length > MAX_SUBTITLE_CUES ||
        textBytes > MAX_SUBTITLE_TEXT_BYTES
      ) {
        throw new MatroskaSubtitleError("limit")
      }
    }

    return textBytes
  }

  private async scanForTrack({
    metadata,
    trackNumber,
    signal,
    onProgress,
  }: TrackBlockReadOptions): Promise<DecodedBlock[]> {
    if (metadata.firstCluster === null) {
      throw new MatroskaSubtitleError("unsupported")
    }

    const scanEnd = Math.min(
      metadata.segmentEnd,
      metadata.firstCluster.start + MAX_CLUSTER_SCAN_BYTES
    )

    let offset = metadata.firstCluster.start
    let textBytes = 0
    const blocks: DecodedBlock[] = []

    while (offset < scanEnd) {
      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted")
      }

      const scanned = await this.readAndAppendScannedTrackCluster({
        metadata,
        trackNumber,
        signal,
        offset,
        blocks,
        textBytes,
      })

      if (scanned === null) {
        reportSubtitleReadProgress(onProgress, 1, 1)
        break
      }

      ;({ nextOffset: offset, textBytes } = scanned)

      reportSubtitleReadProgress(
        onProgress,
        offset - metadata.firstCluster.start,
        scanEnd - metadata.firstCluster.start
      )
    }

    if (offset < metadata.segmentEnd && offset >= scanEnd) {
      throw new MatroskaSubtitleError("limit")
    }

    return blocks
  }

  private async readAndAppendScannedTrackCluster({
    metadata,
    trackNumber,
    signal,
    offset,
    blocks,
    textBytes,
  }: {
    metadata: ParsedFile
    trackNumber: number
    signal: AbortSignal
    offset: number
    blocks: DecodedBlock[]
    textBytes: number
  }): Promise<{ nextOffset: number; textBytes: number } | null> {
    const scanned = await this.readScannedCluster({
      metadata,
      offset,
      trackNumber,
      signal,
    })

    if (scanned.blocks === null) {
      return null
    }

    const nextTextBytes =
      textBytes + this.appendDecodedBlocks(blocks, scanned.blocks)

    if (nextTextBytes > MAX_SUBTITLE_TEXT_BYTES) {
      throw new MatroskaSubtitleError("limit")
    }

    return { nextOffset: scanned.nextOffset, textBytes: nextTextBytes }
  }

  private async readScannedCluster({
    metadata,
    offset,
    trackNumber,
    signal,
  }: {
    metadata: ParsedFile
    offset: number
    trackNumber: number
    signal: AbortSignal
  }): Promise<ScannedCluster> {
    const topLevel = await elementAt(this.reader, offset, signal)

    if (topLevel.id === CUES) {
      return { nextOffset: offset, blocks: null }
    }

    if (topLevel.id !== CLUSTER) {
      if (topLevel.end === null) {
        throw new MatroskaSubtitleError("invalid")
      }

      return { nextOffset: topLevel.end, blocks: [] }
    }

    if (topLevel.end === null) {
      throw new MatroskaSubtitleError("unsupported")
    }

    if (
      metadata.firstCluster === null ||
      topLevel.end - metadata.firstCluster.start > MAX_CLUSTER_SCAN_BYTES
    ) {
      throw new MatroskaSubtitleError("limit")
    }

    const clusterTicks = await this.readClusterTimestamp(topLevel, signal)

    const blocks = await this.scanCluster({
      cluster: topLevel,
      clusterTicks,
      trackNumber,
      timestampScale: metadata.timestampScale,
      signal,
    })

    return { nextOffset: topLevel.end, blocks }
  }

  private async readClusterTimestamp(
    cluster: ElementHeader,
    signal: AbortSignal
  ): Promise<number> {
    if (cluster.end === null) {
      throw new MatroskaSubtitleError("unsupported")
    }

    for await (const child of childElements(this.reader, {
      start: cluster.dataStart,
      end: cluster.end,
      signal,
    })) {
      if (child.id === CLUSTER_TIMESTAMP) {
        return readUnsignedElement(this.reader, child, signal)
      }

      if (child.id === SIMPLE_BLOCK || child.id === BLOCK_GROUP) {
        break
      }
    }

    return 0
  }

  private async scanCluster({
    cluster,
    clusterTicks,
    trackNumber,
    timestampScale,
    signal,
  }: ClusterReadOptions): Promise<DecodedBlock[]> {
    if (
      cluster.end === null ||
      cluster.end - cluster.start > MAX_CLUSTER_SCAN_BYTES
    ) {
      throw new MatroskaSubtitleError("limit")
    }

    const result: DecodedBlock[] = []

    for await (const child of childElements(this.reader, {
      start: cluster.dataStart,
      end: cluster.end,
      signal,
    })) {
      if (child.id === SIMPLE_BLOCK) {
        if ((await this.readBlockTrackNumber(child, signal)) === trackNumber) {
          result.push(
            await this.readBlockElement({
              element: child,
              clusterTicks,
              timestampScale,
              cueDurationTicks: null,
              signal,
            })
          )
        }
      } else if (child.id === BLOCK_GROUP) {
        const block = await this.readBlockGroup({
          group: child,
          clusterTicks,
          timestampScale,
          cueDurationTicks: null,
          targetTrackNumber: trackNumber,
          signal,
        })

        if (block !== null && block.trackNumber === trackNumber) {
          result.push(block)
        }
      }

      if (result.length > MAX_SUBTITLE_CUES) {
        throw new MatroskaSubtitleError("limit")
      }
    }

    return result
  }

  private async readBlockElement({
    element,
    clusterTicks,
    timestampScale,
    cueDurationTicks,
    signal,
  }: BlockReadOptions): Promise<DecodedBlock> {
    if (element.id === BLOCK_GROUP) {
      const block = await this.readBlockGroup({
        group: element,
        clusterTicks,
        timestampScale,
        cueDurationTicks,
        targetTrackNumber: null,
        signal,
      })

      if (block === null) {
        throw new MatroskaSubtitleError("invalid")
      }

      return block
    }

    if (element.id !== SIMPLE_BLOCK && element.id !== BLOCK) {
      throw new MatroskaSubtitleError("invalid")
    }

    const parsed = await this.readBlockPayload(element, signal)

    return this.decodeBlock(parsed, {
      clusterTicks,
      blockDurationTicks: null,
      cueDurationTicks,
      timestampScale,
    })
  }

  private async readBlockGroup({
    group,
    clusterTicks,
    timestampScale,
    cueDurationTicks,
    targetTrackNumber,
    signal,
  }: BlockGroupReadOptions): Promise<DecodedBlock | null> {
    if (group.end === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    let parsedBlock: ParsedBlock | null = null
    let durationTicks: number | null = null

    for await (const child of childElements(this.reader, {
      start: group.dataStart,
      end: group.end,
      signal,
    })) {
      if (child.id === BLOCK) {
        const blockTrackNumber = await this.readBlockTrackNumber(child, signal)

        if (
          targetTrackNumber === null ||
          blockTrackNumber === targetTrackNumber
        ) {
          parsedBlock = await this.readBlockPayload(child, signal)
        }
      } else if (child.id === BLOCK_DURATION) {
        durationTicks = await readUnsignedElement(this.reader, child, signal)
      }
    }

    if (parsedBlock === null) {
      return null
    }

    return this.decodeBlock(parsedBlock, {
      clusterTicks,
      blockDurationTicks: durationTicks,
      cueDurationTicks,
      timestampScale,
    })
  }

  private async readBlockTrackNumber(
    element: ElementHeader,
    signal: AbortSignal
  ): Promise<number> {
    if (element.size === null || element.size < 1) {
      throw new MatroskaSubtitleError("invalid")
    }

    const prefix = await this.reader.read(
      element.dataStart,
      Math.min(element.size, 8),
      signal
    )

    return readVint(prefix, {
      offset: 0,
      maximumLength: 8,
      keepMarker: false,
    }).value
  }

  private async readBlockPayload(
    element: ElementHeader,
    signal: AbortSignal,
    maximumBlockBytes = MAX_BLOCK_BYTES
  ): Promise<ParsedBlock> {
    if (
      element.size === null ||
      element.size < 4 ||
      element.size > maximumBlockBytes
    ) {
      throw new MatroskaSubtitleError("limit")
    }

    const bytes = await this.reader.read(
      element.dataStart,
      element.size,
      signal
    )

    const track = readVint(bytes, {
      offset: 0,
      maximumLength: 8,
      keepMarker: false,
    })

    const timestampOffset = track.length

    if (timestampOffset + 3 > bytes.byteLength) {
      throw new MatroskaSubtitleError("invalid")
    }

    const relativeTimestamp = new DataView(
      bytes.buffer,
      bytes.byteOffset + timestampOffset,
      2
    ).getInt16(0)

    const flags = bytes[timestampOffset + 2] ?? 0
    const lacing = (flags & 0x06) >> 1

    if (lacing !== 0) {
      throw new MatroskaSubtitleError("unsupported")
    }

    const encodedBytes = bytes.subarray(timestampOffset + 3)

    const trackMetadata = this.metadata?.tracks.find(
      (candidate) => candidate.trackNumber === track.value
    )

    const dataBytes =
      trackMetadata === undefined
        ? encodedBytes
        : await restoreContentEncodings({
            bytes: encodedBytes,
            track: trackMetadata,
            maximumCompressedBytes: maximumBlockBytes,
            maximumDecompressedBytes: maximumBlockBytes,
            signal,
          })

    return {
      trackNumber: track.value,
      relativeTimestamp,
      dataBytes,
    }
  }

  private decodeBlock(block: ParsedBlock, timing: BlockTiming): DecodedBlock {
    const {
      clusterTicks,
      blockDurationTicks,
      cueDurationTicks,
      timestampScale,
    } = timing

    let text: string

    try {
      text = new TextDecoder("utf-8", { fatal: true })
        .decode(block.dataBytes)
        .replaceAll("\u0000", "")
        .trim()
    } catch {
      throw new MatroskaSubtitleError("invalid")
    }

    if (text.length === 0) {
      throw new MatroskaSubtitleError("invalid")
    }

    const startTicks = clusterTicks + block.relativeTimestamp
    const startTime = (startTicks * timestampScale) / 1_000_000_000

    if (!Number.isFinite(startTime) || startTime < 0) {
      throw new MatroskaSubtitleError("invalid")
    }

    return {
      trackNumber: block.trackNumber,
      startTime,
      durationTicks: blockDurationTicks ?? cueDurationTicks,
      text,
      textBytes: block.dataBytes.byteLength,
      packetBytes: block.dataBytes,
    }
  }

  private endTime(
    startTime: number,
    durationTicks: number | null,
    timestampScale: number
  ): number {
    if (durationTicks === null || durationTicks <= 0) {
      throw new MatroskaSubtitleError("invalid")
    }

    const endTime = startTime + (durationTicks * timestampScale) / 1_000_000_000

    if (!Number.isFinite(endTime) || endTime <= startTime) {
      throw new MatroskaSubtitleError("invalid")
    }

    return endTime
  }
}
