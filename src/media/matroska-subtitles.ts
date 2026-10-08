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

export interface MatroskaSubtitleReader {
  probe(signal: AbortSignal): Promise<MatroskaTextTrack[]>
  readCues(trackNumber: number, signal: AbortSignal): Promise<SubtitleCue[]>
  streamAssTrack(
    trackNumber: number,
    signal: AbortSignal
  ): MatroskaAssTrackStream
  readAssTrack(
    trackNumber: number,
    signal: AbortSignal
  ): Promise<MatroskaAssTrackData>
}

type MatroskaSubtitleFailureKind =
  | "aborted"
  | "invalid"
  | "limit"
  | "unsupported"
  | "unreachable"
  | "timeout"

class MatroskaSubtitleError extends Error {
  constructor(readonly kind: MatroskaSubtitleFailureKind) {
    super(`Embedded subtitles are ${kind}.`)
    this.name = "MatroskaSubtitleError"
  }
}

const PAGE_SIZE = 8 * 1024

const MAX_RANGE_BYTES = 8 * 1024 * 1024

const MAX_RANGE_REQUESTS = 1024

const MAX_CACHED_BYTES = 1024 * 1024

const MAX_METADATA_SCAN_BYTES = 1024 * 1024

const MAX_CUES_ELEMENT_BYTES = 4 * 1024 * 1024

const CUE_INDEX_PAGE_SIZE = 64 * 1024

const MAX_CUE_INDEX_RANGE_BYTES =
  MAX_CUES_ELEMENT_BYTES + CUE_INDEX_PAGE_SIZE * 2

const MAX_SUBTITLE_CUES = 50_000

const MAX_SUBTITLE_TEXT_BYTES = 4 * 1024 * 1024

const MAX_BLOCK_BYTES = 64 * 1024

const MAX_CODEC_PRIVATE_BYTES = 256 * 1024

const MAX_ASS_PACKET_BYTES = 4 * 1024 * 1024

// Keep high-latency byte sources moving while bounding active cluster reads.
const INDEXED_CLUSTER_READ_CONCURRENCY = 12

const MAX_ASS_FONT_BYTES = 32 * 1024 * 1024

const MAX_ASS_FONT_FILE_BYTES = 24 * 1024 * 1024

const MAX_ASS_FONT_FILES = 128

const MAX_ASS_RANGE_BYTES = 48 * 1024 * 1024

const ASS_PAGE_SIZE = 64 * 1024

const MAX_ASS_RANGE_REQUESTS = 1024

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
  textBytes: Uint8Array
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
  codecPrivate: ElementHeader | null
  attachmentLinkUids: number[]
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
  codecPrivate: ElementHeader | null
  attachmentLinkUids: number[]
  flags: SubtitleTrackFlags
}

interface RangeReaderOptions {
  pageSize: number
  maxRangeBytes: number
  maxRangeRequests: number
  fileSize?: number | null
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
}

interface IndexedClusterBatchOptions {
  metadata: ParsedFile
  trackNumber: number
  clusters: Array<[number, TrackPosition[]]>
  signal: AbortSignal
}

interface CueClusterOptions {
  metadata: ParsedFile
  trackNumber: number
  clusterPosition: number
  positions: TrackPosition[]
  signal: AbortSignal
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
  private cachedBytes = 0
  private readonly pages = new Map<number, Uint8Array>()
  private readonly pendingPages = new Map<
    number,
    { promise: Promise<Uint8Array>; signal: AbortSignal }
  >()
  private readonly fetcher: typeof fetch
  private readonly pageSize: number
  private readonly maxRangeBytes: number
  private readonly maxRangeRequests: number

  constructor(
    private readonly url: string,
    fetcher: typeof fetch,
    {
      pageSize = PAGE_SIZE,
      maxRangeBytes = MAX_RANGE_BYTES,
      maxRangeRequests = MAX_RANGE_REQUESTS,
      fileSize = null,
    }: Partial<RangeReaderOptions> = {}
  ) {
    this.fetcher = fetcher.bind(globalThis)
    this.pageSize = pageSize
    this.maxRangeBytes = maxRangeBytes
    this.maxRangeRequests = maxRangeRequests
    this.fileSize = fileSize
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

    const output = new Uint8Array(length)

    return this.copyRange(start, output, signal)
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
    const cached = this.pages.get(start)

    if (cached !== undefined) {
      this.pages.delete(start)
      this.pages.set(start, cached)

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

      this.cachePage(start, page)

      return page
    } finally {
      if (this.pendingPages.get(start) === pendingRequest) {
        this.pendingPages.delete(start)
      }
    }
  }

  private cachePage(start: number, page: Uint8Array): void {
    const previous = this.pages.get(start)

    if (previous !== undefined) {
      this.cachedBytes -= previous.byteLength
    }

    this.pages.set(start, page)
    this.cachedBytes += page.byteLength

    while (this.cachedBytes > MAX_CACHED_BYTES) {
      const oldest = this.pages.entries().next()

      if (oldest.done) {
        break
      }

      const [oldestStart, oldestPage] = oldest.value

      this.pages.delete(oldestStart)
      this.cachedBytes -= oldestPage.byteLength
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

    return this.readFromRangeSource(start, end, signal)
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
    const url =
      this.readMode === "direct" ? this.url : proxiedMediaUrl(this.url)

    try {
      return await (this.readMode === "proxy"
        ? this.requestProxyPage({ url, start, end, signal })
        : this.requestPage({ url, start, end, signal }))
    } catch (error) {
      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted")
      }

      if (this.readMode === "proxy") {
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
  reader: RangeReader,
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
  reader: RangeReader,
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
  reader: RangeReader,
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
  reader: RangeReader,
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
  const deadline = setTimeout(() => controller.abort(), timeoutMs)

  if (parentSignal.aborted) {
    controller.abort()
  }

  parentSignal.addEventListener("abort", abortFromParent, { once: true })

  return {
    signal: controller.signal,
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
  const createCueRangeReader = (fileSize: number | null) =>
    new RangeReader(mediaUrl, fetcher, {
      pageSize: CUE_INDEX_PAGE_SIZE,
      maxRangeBytes: MAX_CUE_INDEX_RANGE_BYTES,
      maxRangeRequests: MAX_RANGE_REQUESTS,
      fileSize,
    })

  const createAssRangeReader = () =>
    new RangeReader(mediaUrl, fetcher, {
      pageSize: ASS_PAGE_SIZE,
      maxRangeBytes: MAX_ASS_RANGE_BYTES,
      maxRangeRequests: MAX_ASS_RANGE_REQUESTS,
    })

  return new MatroskaSubtitleReaderImpl(
    new RangeReader(mediaUrl, fetcher),
    createAssRangeReader,
    createCueRangeReader
  )
}

class MatroskaSubtitleReaderImpl implements MatroskaSubtitleReader {
  private metadata: ParsedFile | null = null

  constructor(
    private readonly reader: RangeReader,
    private readonly createAssRangeReader: () => RangeReader,
    private readonly createCueRangeReader: (
      fileSize: number | null
    ) => RangeReader
  ) {}

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
    signal: AbortSignal
  ): Promise<SubtitleCue[]> {
    const deadline = withDeadline(signal)

    try {
      const metadata = await this.readMetadata(deadline.signal)

      const track = metadata.tracks.find(
        (candidate) => candidate.trackNumber === trackNumber
      )

      if (track === undefined || track.codecId !== "S_TEXT/UTF8") {
        throw new MatroskaSubtitleError("invalid")
      }

      if (track.hasContentEncodings) {
        throw new MatroskaSubtitleError("unsupported")
      }

      const blocks = await this.readTrackBlocks(
        metadata,
        trackNumber,
        deadline.signal
      )

      if (blocks.length === 0) {
        throw new MatroskaSubtitleError("invalid")
      }

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
    } finally {
      deadline.dispose()
    }
  }

  async readAssTrack(
    trackNumber: number,
    signal: AbortSignal
  ): Promise<MatroskaAssTrackData> {
    return this.streamAssTrack(trackNumber, signal).result
  }

  streamAssTrack(
    trackNumber: number,
    signal: AbortSignal
  ): MatroskaAssTrackStream {
    // Font data and cue packets need a larger byte budget than Phase 8 text
    // cues. Use an isolated reader so selecting ASS never changes UTF8 limits.
    const reader = new MatroskaSubtitleReaderImpl(
      this.createAssRangeReader(),
      this.createAssRangeReader,
      this.createCueRangeReader
    )

    const trackStream = createMatroskaAssTrackStream()

    void reader
      .readAssTrackWithinBudget(trackNumber, signal, trackStream)
      .then(trackStream.complete, trackStream.fail)

    return trackStream.stream
  }

  private async readAssTrackWithinBudget(
    trackNumber: number,
    signal: AbortSignal,
    stream: MutableMatroskaAssTrackStream
  ): Promise<MatroskaAssTrackData> {
    const deadline = withDeadline(signal, ASS_TRACK_DEADLINE_MS)

    try {
      const input = await this.readAssTrackInput(
        trackNumber,
        deadline.signal,
        stream
      )

      const packets = await this.readAssTrackPackets({
        metadata: input.metadata,
        trackNumber,
        signal: deadline.signal,
        stream,
      })

      return {
        codecPrivate: input.codecPrivate,
        packets,
        fonts: input.fonts,
      }
    } catch (failure) {
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

    if (track.hasContentEncodings) {
      throw new MatroskaSubtitleError("unsupported")
    }

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
  }: AssTrackPacketReadOptions): Promise<MatroskaAssPacket[]> {
    const packets: MatroskaAssPacket[] = []
    let packetBytes = 0

    for await (const blocks of this.readTrackBlockBatches(
      metadata,
      trackNumber,
      signal
    )) {
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
    const target = await elementAt(
      this.reader,
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
        metadata.hasContentEncodings = true
        break
      default:
        await this.readTrackFlag(metadata.flags, field, signal)
    }
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

    const result: CuePoint[] = []
    const reader = this.createCueRangeReader(this.reader.size)

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

  private async readTrackBlocks(
    metadata: ParsedFile,
    trackNumber: number,
    signal: AbortSignal
  ): Promise<DecodedBlock[]> {
    const blocks: DecodedBlock[] = []

    for await (const batch of this.readTrackBlockBatches(
      metadata,
      trackNumber,
      signal
    )) {
      this.appendDecodedBlocks(blocks, batch)
    }

    return blocks
  }

  private async *readTrackBlockBatches(
    metadata: ParsedFile,
    trackNumber: number,
    signal: AbortSignal
  ): AsyncGenerator<DecodedBlock[]> {
    const cuePositions = await this.readCuePositions(
      metadata,
      trackNumber,
      signal
    )

    if (cuePositions.length === 0) {
      const blocks = await this.scanForTrack(metadata, trackNumber, signal)

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
    })
  }

  private async readCuePoint({
    reader,
    point,
    trackNumber,
    signal,
  }: {
    reader: RangeReader
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
    reader: RangeReader,
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

    for (
      let batchStart = 0;
      batchStart < clusters.length;
      batchStart += INDEXED_CLUSTER_READ_CONCURRENCY
    ) {
      if (signal.aborted) {
        throw new MatroskaSubtitleError("aborted")
      }

      const clusterBatch = clusters.slice(
        batchStart,
        batchStart + INDEXED_CLUSTER_READ_CONCURRENCY
      )

      const batchBlocks = await this.readIndexedClusterBatch({
        metadata,
        trackNumber,
        clusters: clusterBatch,
        signal,
      })

      const decodedBlocks = batchBlocks.flat()

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

  private async readIndexedClusterBatch({
    metadata,
    trackNumber,
    clusters,
    signal,
  }: IndexedClusterBatchOptions): Promise<DecodedBlock[][]> {
    const controller = new AbortController()
    const abortFromParent = () => controller.abort()

    signal.addEventListener("abort", abortFromParent, { once: true })

    if (signal.aborted) {
      controller.abort()
    }

    const pending = clusters.map(([clusterPosition, positions]) =>
      this.readCueCluster({
        metadata,
        trackNumber,
        clusterPosition,
        positions,
        signal: controller.signal,
      })
    )

    try {
      return await Promise.all(pending)
    } catch (error) {
      controller.abort()
      await Promise.allSettled(pending)
      throw error
    } finally {
      signal.removeEventListener("abort", abortFromParent)
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

  private async scanForTrack(
    metadata: ParsedFile,
    trackNumber: number,
    signal: AbortSignal
  ): Promise<DecodedBlock[]> {
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

      const scanned = await this.readScannedCluster({
        metadata,
        offset,
        trackNumber,
        signal,
      })

      if (scanned.blocks === null) {
        break
      }

      textBytes += this.appendDecodedBlocks(blocks, scanned.blocks)

      if (textBytes > MAX_SUBTITLE_TEXT_BYTES) {
        throw new MatroskaSubtitleError("limit")
      }

      offset = scanned.nextOffset
    }

    if (offset < metadata.segmentEnd && offset >= scanEnd) {
      throw new MatroskaSubtitleError("limit")
    }

    return blocks
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
    signal: AbortSignal
  ): Promise<ParsedBlock> {
    if (
      element.size === null ||
      element.size < 4 ||
      element.size > MAX_BLOCK_BYTES
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

    const textBytes = bytes.subarray(timestampOffset + 3)

    if (textBytes.byteLength === 0) {
      throw new MatroskaSubtitleError("invalid")
    }

    return {
      trackNumber: track.value,
      relativeTimestamp,
      textBytes,
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
        .decode(block.textBytes)
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
      textBytes: block.textBytes.byteLength,
      packetBytes: block.textBytes,
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
