import assert from "node:assert/strict"
import { test } from "node:test"
import { deflateSync } from "node:zlib"

import {
  createMatroskaSubtitleReader,
  MatroskaSubtitleError,
  type MatroskaPgsPacket,
} from "./matroska-subtitles"

const IDS = {
  ebml: "1A45DFA3",
  segment: "18538067",
  seekHead: "114D9B74",
  seek: "4DBB",
  seekId: "53AB",
  seekPosition: "53AC",
  info: "1549A966",
  timestampScale: "2AD7B1",
  tracks: "1654AE6B",
  trackEntry: "AE",
  trackNumber: "D7",
  trackType: "83",
  codecId: "86",
  trackName: "536E",
  language: "22B59C",
  languageIetf: "22B59D",
  flagDefault: "88",
  flagForced: "55AA",
  flagHearingImpaired: "55AB",
  contentEncodings: "6D80",
  contentEncoding: "6240",
  contentEncodingOrder: "5031",
  contentEncodingScope: "5032",
  contentEncodingType: "5033",
  contentCompression: "5034",
  contentEncryption: "5035",
  contentCompAlgo: "4254",
  contentCompSettings: "4255",
  codecPrivate: "63A2",
  attachmentLink: "7446",
  attachments: "1941A469",
  attachedFile: "61A7",
  fileName: "466E",
  fileMimeType: "4660",
  fileData: "465C",
  fileUid: "46AE",
  cluster: "1F43B675",
  clusterTimestamp: "E7",
  simpleBlock: "A3",
  blockGroup: "A0",
  block: "A1",
  blockDuration: "9B",
  cues: "1C53BB6B",
  cuePoint: "BB",
  cueTime: "B3",
  cueTrackPositions: "B7",
  cueTrack: "F7",
  cueClusterPosition: "F1",
  cueRelativePosition: "F0",
  cueDuration: "B2",
  void: "EC",
} as const

interface TrackFixture {
  trackNumber: number
  name: string
  language: string
  languageIetf?: string
  default?: boolean
  forced?: boolean
  hearingImpaired?: boolean
  contentEncodings?: ContentEncodingFixture[]
  codecId?: "S_TEXT/UTF8" | "S_TEXT/ASS" | "S_TEXT/SSA" | "S_HDMV/PGS"
  codecPrivate?: Uint8Array
  attachmentLinks?: number[]
  blockFlags?: number
  blockDurationTicks?: number
  cueDurationTicks?: number
  timestamp: number
  textBytes: Uint8Array
  preEncoded?: boolean
  blockGroup?: boolean
  blocks?: TrackBlockFixture[]
}

interface TrackBlockFixture {
  timestamp: number
  textBytes: Uint8Array
  blockFlags?: number
  blockDurationTicks?: number
  cueDurationTicks?: number
  blockGroup?: boolean
  preEncoded?: boolean
}

interface ContentEncodingFixture {
  order?: number
  scope?: number
  type?: number
  compression?: {
    algorithm?: number
    settings?: Uint8Array
  }
  encryption?: boolean
}

interface AttachmentFixture {
  uid: number
  name: string
  mimeType: string
  data: Uint8Array
}

interface FixtureOptions {
  tracks: TrackFixture[]
  attachments?: AttachmentFixture[]
  includeCues?: boolean
  cueBlockIndices?: number[]
  paddingBytes?: number
  cuesPaddingBytes?: number
  trailingSegmentVoidBytes?: number
  clusterPaddingBytes?: number
  clusterPaddingBytesByIndex?: Record<number, number>
  clusterPerBlock?: boolean
  unknownSegmentSize?: boolean
}

interface FixtureBlock {
  trackNumber: number
  timestamp: number
  clusterRelativePosition: number
  clusterIndex: number
  block: Uint8Array
  durationTicks?: number
}

interface RecordedRange {
  url: string
  header: string
  bytes: number
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0

  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }

  return result
}

function encodeSize(size: number): Uint8Array {
  for (let length = 1; length <= 8; length += 1) {
    if (BigInt(size) < (1n << BigInt(length * 7)) - 1n) {
      const bytes = new Uint8Array(length)
      let value = BigInt(size)

      for (let index = length - 1; index >= 0; index -= 1) {
        bytes[index] = Number(value & 0xffn)
        value >>= 8n
      }

      bytes[0] = (bytes[0] ?? 0) | (1 << (8 - length))

      return bytes
    }
  }

  throw new Error("Fixture element is too large.")
}

function element(id: string, data: Uint8Array): Uint8Array {
  return concat(Buffer.from(id, "hex"), encodeSize(data.byteLength), data)
}

function unsigned(value: number, width?: number): Uint8Array {
  let byteWidth = width ?? 1

  if (width === undefined) {
    while (value >= 2 ** (byteWidth * 8)) {
      byteWidth += 1
    }
  }

  const bytes = new Uint8Array(byteWidth)
  let remaining = BigInt(value)

  for (let index = byteWidth - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }

  return bytes
}

function uintElement(id: string, value: number, width?: number): Uint8Array {
  return element(id, unsigned(value, width))
}

function stringElement(id: string, value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value))
}

function trackEntry(track: TrackFixture): Uint8Array {
  const fields = [
    uintElement(IDS.trackNumber, track.trackNumber),
    uintElement(IDS.trackType, 17),
    stringElement(IDS.codecId, track.codecId ?? "S_TEXT/UTF8"),
    stringElement(IDS.trackName, track.name),
    stringElement(IDS.language, track.language),
  ]

  if (track.codecPrivate !== undefined) {
    fields.push(element(IDS.codecPrivate, track.codecPrivate))
  }

  for (const attachmentLink of track.attachmentLinks ?? []) {
    fields.push(uintElement(IDS.attachmentLink, attachmentLink))
  }

  if (track.languageIetf !== undefined) {
    fields.push(stringElement(IDS.languageIetf, track.languageIetf))
  }

  if (track.default !== undefined) {
    fields.push(uintElement(IDS.flagDefault, Number(track.default)))
  }

  if (track.forced !== undefined) {
    fields.push(uintElement(IDS.flagForced, Number(track.forced)))
  }

  if (track.hearingImpaired !== undefined) {
    fields.push(
      uintElement(IDS.flagHearingImpaired, Number(track.hearingImpaired))
    )
  }

  if (track.contentEncodings !== undefined) {
    const encodings = track.contentEncodings.map((encoding) => {
      const encodingFields: Uint8Array[] = []

      if (encoding.order !== undefined) {
        encodingFields.push(
          uintElement(IDS.contentEncodingOrder, encoding.order)
        )
      }

      if (encoding.scope !== undefined) {
        encodingFields.push(
          uintElement(IDS.contentEncodingScope, encoding.scope)
        )
      }

      if (encoding.type !== undefined) {
        encodingFields.push(uintElement(IDS.contentEncodingType, encoding.type))
      }

      if (encoding.compression !== undefined) {
        const compressionFields: Uint8Array[] = []

        if (encoding.compression.algorithm !== undefined) {
          compressionFields.push(
            uintElement(IDS.contentCompAlgo, encoding.compression.algorithm)
          )
        }

        if (encoding.compression.settings !== undefined) {
          compressionFields.push(
            element(IDS.contentCompSettings, encoding.compression.settings)
          )
        }

        encodingFields.push(
          element(IDS.contentCompression, concat(...compressionFields))
        )
      }

      if (encoding.encryption === true) {
        encodingFields.push(element(IDS.contentEncryption, new Uint8Array()))
      }

      return element(IDS.contentEncoding, concat(...encodingFields))
    })

    fields.push(element(IDS.contentEncodings, concat(...encodings)))
  }

  return element(IDS.trackEntry, concat(...fields))
}

function blockPayload(
  track: TrackFixture,
  block: TrackBlockFixture
): Uint8Array {
  const timestamp = new Uint8Array(2)

  new DataView(timestamp.buffer).setInt16(0, block.timestamp)

  let storedBytes = block.textBytes

  if (!block.preEncoded) {
    // Matroska decoding reverses this order, so fixtures apply encoders low to high.
    // oxlint-disable-next-line unicorn/no-array-sort -- Fixture applies encodings in their declared order.
    for (const encoding of [...(track.contentEncodings ?? [])].sort(
      (left, right) => (left.order ?? 0) - (right.order ?? 0)
    )) {
      if (encoding.compression?.algorithm === 0) {
        storedBytes = new Uint8Array(deflateSync(storedBytes))
      } else if (encoding.compression?.algorithm === 3) {
        const prefix = encoding.compression.settings ?? new Uint8Array()

        assert.deepEqual(storedBytes.subarray(0, prefix.byteLength), prefix)
        storedBytes = storedBytes.subarray(prefix.byteLength)
      }
    }
  }

  return concat(
    Uint8Array.of(0x80 | track.trackNumber),
    timestamp,
    Uint8Array.of(block.blockFlags ?? 0),
    storedBytes
  )
}

function makeBlock(track: TrackFixture, block: TrackBlockFixture): Uint8Array {
  const payload = blockPayload(track, block)

  if (!block.blockGroup) {
    return element(IDS.simpleBlock, payload)
  }

  const fields = [element(IDS.block, payload)]

  if (block.blockDurationTicks !== undefined) {
    fields.push(uintElement(IDS.blockDuration, block.blockDurationTicks))
  }

  return element(IDS.blockGroup, concat(...fields))
}

function trackPositions(
  block: FixtureBlock,
  clusterPosition: number,
  includeCues: boolean
): Uint8Array {
  const fields = [
    uintElement(IDS.cueTrack, block.trackNumber),
    uintElement(IDS.cueClusterPosition, clusterPosition),
  ]

  if (includeCues) {
    fields.push(
      uintElement(IDS.cueRelativePosition, block.clusterRelativePosition)
    )
  }

  if (block.durationTicks !== undefined) {
    fields.push(uintElement(IDS.cueDuration, block.durationTicks))
  }

  return element(IDS.cueTrackPositions, concat(...fields))
}

function cuePoint(
  block: FixtureBlock,
  clusterPosition: number,
  includeRelativePosition: boolean
): Uint8Array {
  return element(
    IDS.cuePoint,
    concat(
      uintElement(IDS.cueTime, block.timestamp),
      trackPositions(block, clusterPosition, includeRelativePosition)
    )
  )
}

function seekHead(cuesPosition: number): Uint8Array {
  const seek = element(
    IDS.seek,
    concat(
      element(IDS.seekId, Buffer.from(IDS.cues, "hex")),
      uintElement(IDS.seekPosition, cuesPosition, 4)
    )
  )

  return element(IDS.seekHead, seek)
}

function makeFixture({
  tracks,
  attachments = [],
  includeCues = true,
  cueBlockIndices,
  paddingBytes = 0,
  cuesPaddingBytes = 0,
  trailingSegmentVoidBytes = 0,
  clusterPaddingBytes = 0,
  clusterPaddingBytesByIndex = {},
  clusterPerBlock = false,
  unknownSegmentSize = false,
}: FixtureOptions): Uint8Array {
  const ebml = element(IDS.ebml, new Uint8Array())
  const info = element(IDS.info, uintElement(IDS.timestampScale, 1_000_000))
  const tracksElement = element(IDS.tracks, concat(...tracks.map(trackEntry)))

  const attachmentsElement =
    attachments.length === 0
      ? new Uint8Array()
      : element(
          IDS.attachments,
          concat(...attachments.map(attachedFileElement))
        )

  const timestampElement = uintElement(IDS.clusterTimestamp, 0)
  const blocks: FixtureBlock[] = []
  const clusters: Uint8Array[] = []
  let clusterData = timestampElement

  for (const track of tracks) {
    for (const packet of track.blocks ?? [track]) {
      const block = makeBlock(track, packet)

      if (clusterPerBlock) {
        const clusterIndex = clusters.length

        const clusterPadding =
          (clusterPaddingBytesByIndex[clusterIndex] ?? clusterPaddingBytes) > 0
            ? element(
                IDS.void,
                new Uint8Array(
                  clusterPaddingBytesByIndex[clusterIndex] ??
                    clusterPaddingBytes
                )
              )
            : new Uint8Array()

        blocks.push({
          trackNumber: track.trackNumber,
          timestamp: packet.timestamp,
          clusterRelativePosition: timestampElement.byteLength,
          clusterIndex,
          block,
          durationTicks: packet.cueDurationTicks,
        })
        clusters.push(
          element(IDS.cluster, concat(timestampElement, block, clusterPadding))
        )
      } else {
        blocks.push({
          trackNumber: track.trackNumber,
          timestamp: packet.timestamp,
          clusterRelativePosition: clusterData.byteLength,
          clusterIndex: 0,
          block,
          durationTicks: packet.cueDurationTicks,
        })
        clusterData = concat(clusterData, block)
      }
    }
  }

  if (!clusterPerBlock) {
    if (paddingBytes > 0) {
      clusterData = concat(
        clusterData,
        element(IDS.void, new Uint8Array(paddingBytes))
      )
    }

    clusters.push(element(IDS.cluster, clusterData))
  }

  const seekHeadTemplate = includeCues ? seekHead(0) : new Uint8Array()

  let clusterPosition =
    seekHeadTemplate.byteLength +
    info.byteLength +
    tracksElement.byteLength +
    attachmentsElement.byteLength

  const clusterPositions: number[] = []

  for (const cluster of clusters) {
    clusterPositions.push(clusterPosition)
    clusterPosition += cluster.byteLength
  }

  const cuesPosition = clusterPosition

  const cues = includeCues
    ? element(
        IDS.cues,
        concat(
          ...blocks.flatMap((block, index) => {
            if (
              cueBlockIndices !== undefined &&
              !cueBlockIndices.includes(index)
            ) {
              return []
            }

            const blockClusterPosition = clusterPositions[block.clusterIndex]

            if (blockClusterPosition === undefined) {
              throw new Error("Fixture cluster position is missing.")
            }

            return [cuePoint(block, blockClusterPosition, true)]
          }),
          ...(cuesPaddingBytes > 0
            ? [element(IDS.void, new Uint8Array(cuesPaddingBytes))]
            : [])
        )
      )
    : new Uint8Array()

  const head = includeCues ? seekHead(cuesPosition) : seekHeadTemplate

  const trailingSegmentVoid =
    trailingSegmentVoidBytes > 0
      ? element(IDS.void, new Uint8Array(trailingSegmentVoidBytes))
      : new Uint8Array()

  const body = concat(
    head,
    info,
    tracksElement,
    attachmentsElement,
    ...clusters,
    cues,
    trailingSegmentVoid
  )

  const segment = unknownSegmentSize
    ? concat(
        Buffer.from(IDS.segment, "hex"),
        Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
        body
      )
    : element(IDS.segment, body)

  return concat(ebml, segment)
}

function attachedFileElement(attachment: AttachmentFixture): Uint8Array {
  return element(
    IDS.attachedFile,
    concat(
      uintElement(IDS.fileUid, attachment.uid),
      stringElement(IDS.fileName, attachment.name),
      stringElement(IDS.fileMimeType, attachment.mimeType),
      element(IDS.fileData, attachment.data)
    )
  )
}

function inputUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return input.url
  }

  if (input instanceof URL) {
    return input.href
  }

  return input
}

function findElementOffsets(bytes: Uint8Array, id: string): number[] {
  const identifier = Buffer.from(id, "hex")
  const offsets: number[] = []

  for (
    let offset = 0;
    offset <= bytes.byteLength - identifier.byteLength;
    offset += 1
  ) {
    if (identifier.every((byte, index) => bytes[offset + index] === byte)) {
      offsets.push(offset)
    }
  }

  return offsets
}

function rangedFetch(
  bytes: Uint8Array,
  requests: RecordedRange[]
): typeof fetch {
  return async (input, init) => {
    const url = inputUrl(input)
    const rangeHeader = new Headers(init?.headers).get("range")
    const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader ?? "")

    if (!match) {
      throw new Error("Fixture request did not include a byte range.")
    }

    const start = Number(match[1])
    const requestedEnd = Number(match[2])
    const end = Math.min(requestedEnd, bytes.byteLength - 1)
    const responseBytes = bytes.slice(start, end + 1)

    requests.push({
      url,
      header: rangeHeader ?? "",
      bytes: responseBytes.byteLength,
    })

    return new Response(responseBytes, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
      },
    })
  }
}

function makeTrack(
  overrides: Partial<TrackFixture> &
    Pick<TrackFixture, "trackNumber" | "name" | "language">
): TrackFixture {
  return {
    timestamp: overrides.timestamp ?? 500,
    textBytes:
      overrides.textBytes ?? new TextEncoder().encode("Hello subtitle"),
    ...overrides,
  }
}

function pgsSegment(
  type: number,
  payload: Uint8Array = new Uint8Array()
): Uint8Array {
  return concat(
    Uint8Array.of(
      type,
      (payload.byteLength >> 8) & 0xff,
      payload.byteLength & 0xff
    ),
    payload
  )
}

function pgsPalette(id: number): Uint8Array {
  return pgsSegment(0x14, Uint8Array.of(id, 0, 128, 128, 128, 255, 0))
}

function pgsObject(id: number, version: number): Uint8Array {
  return pgsSegment(
    0x15,
    Uint8Array.of(
      (id >> 8) & 0xff,
      id & 0xff,
      version,
      0xc0,
      0,
      0,
      8,
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1
    )
  )
}

function pgsWindow(id: number): Uint8Array {
  return pgsSegment(0x17, Uint8Array.of(1, id, 0, 0, 0, 0, 0, 1, 0, 1))
}

function pgsPresentation(
  state: number,
  paletteId: number,
  references: Array<{ objectId: number; windowId: number }>
): Uint8Array {
  const payload = new Uint8Array(11 + references.length * 8)
  const view = new DataView(payload.buffer)

  view.setUint16(0, 1)
  view.setUint16(2, 1)
  payload[7] = state
  payload[9] = paletteId
  payload[10] = references.length

  references.forEach(({ objectId, windowId }, index) => {
    const offset = 11 + index * 8

    view.setUint16(offset, objectId)
    payload[offset + 2] = windowId
    view.setUint16(offset + 4, 0)
    view.setUint16(offset + 6, 0)
  })

  return pgsSegment(0x16, payload)
}

function pgsDisplaySet(segments: Uint8Array[]): Uint8Array {
  return concat(...segments, pgsSegment(0x80))
}

function isLimitError(error: Error): boolean {
  return error instanceof MatroskaSubtitleError && error.kind === "limit"
}

void test("parses multiple S_TEXT/UTF8 tracks and prefers IETF language flags", async () => {
  const tracks = [
    makeTrack({
      trackNumber: 2,
      name: "English",
      language: "eng",
      languageIetf: "en-US",
      cueDurationTicks: 1_000,
    }),
    makeTrack({
      trackNumber: 3,
      name: "French Signs",
      language: "fre",
      languageIetf: "fr-FR",
      default: false,
      forced: true,
      hearingImpaired: true,
      timestamp: 2_000,
      cueDurationTicks: 1_500,
      textBytes: new TextEncoder().encode("Bonjour"),
    }),
  ]

  const bytes = makeFixture({ tracks, unknownSegmentSize: true })
  const requests: RecordedRange[] = []

  const reader = createMatroskaSubtitleReader(
    "https://media.example/movie.mkv",
    rangedFetch(bytes, requests)
  )

  const { signal } = new AbortController()

  const metadata = await reader.probe(signal)

  assert.deepEqual(
    metadata.map(({ id, label, language, flags }) => ({
      id,
      label,
      language,
      flags,
    })),
    [
      {
        id: "matroska-2",
        label: "English",
        language: "en-US",
        flags: {
          default: true,
          forced: false,
          hearingImpaired: false,
          visualImpaired: false,
          textDescriptions: false,
          original: false,
          commentary: false,
        },
      },
      {
        id: "matroska-3",
        label: "French Signs",
        language: "fr-FR",
        flags: {
          default: false,
          forced: true,
          hearingImpaired: true,
          visualImpaired: false,
          textDescriptions: false,
          original: false,
          commentary: false,
        },
      },
    ]
  )
  assert.deepEqual(await reader.readCues(2, signal), [
    { startTime: 0.5, endTime: 1.5, text: "Hello subtitle" },
  ])
  assert.deepEqual(await reader.readCues(3, signal), [
    { startTime: 2, endTime: 3.5, text: "Bonjour" },
  ])
  assert.ok(requests.every((request) => request.header.startsWith("bytes=")))
})

void test("reads S_TEXT/UTF8 cues from a bounded Cues element over 2 MiB", async () => {
  const bytes = makeFixture({
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "Japanese",
        language: "jpn",
        timestamp: 500,
        cueDurationTicks: 1_000,
        textBytes: new TextEncoder().encode("日本語 subtitles work"),
      }),
    ],
    cuesPaddingBytes: 2_600_000,
  })

  const reader = createMatroskaSubtitleReader(
    "https://media.example/japanese-subtitles.mkv",
    rangedFetch(bytes, [])
  )

  const cues = await reader.readCues(2, new AbortController().signal)

  assert.deepEqual(cues, [
    { startTime: 0.5, endTime: 1.5, text: "日本語 subtitles work" },
  ])
})

void test("stops the Cue index at Cues when another Segment element follows", async () => {
  const bytes = makeFixture({
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "English",
        language: "eng",
        cueDurationTicks: 1_000,
      }),
    ],
    cuesPaddingBytes: 1,
    trailingSegmentVoidBytes: 8,
  })

  const reader = createMatroskaSubtitleReader(
    "https://media.example/trailing-segment-element.mkv",
    rangedFetch(bytes, [])
  )

  assert.deepEqual(await reader.readCues(2, new AbortController().signal), [
    { startTime: 0.5, endTime: 1.5, text: "Hello subtitle" },
  ])
})

void test("reads sparse SRT clusters within its bounded track budget", async () => {
  const blocks = Array.from({ length: 1_100 }, (_, index) => ({
    timestamp: index + 1,
    cueDurationTicks: 1,
    textBytes: new TextEncoder().encode(`cue ${index + 1}`),
  }))

  const bytes = makeFixture({
    clusterPerBlock: true,
    clusterPaddingBytes: 8 * 1024,
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "English",
        language: "eng",
        blocks,
      }),
    ],
  })

  const requests: RecordedRange[] = []

  const reader = createMatroskaSubtitleReader(
    "https://media.example/sparse-srt.mkv",
    rangedFetch(bytes, requests)
  )

  const cues = await reader.readCues(2, new AbortController().signal)

  assert.equal(cues.length, blocks.length)
  assert.equal(cues[0]?.text, "cue 1")
  assert.equal(cues.at(-1)?.text, "cue 1100")
  assert.ok(requests.length > 1024)
  assert.ok(
    requests.reduce((total, request) => total + request.bytes, 0) <
      16 * 1024 * 1024
  )
})

void test("calls the range fetcher with its global receiver", async () => {
  const bytes = makeFixture({
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "English",
        language: "eng",
        cueDurationTicks: 1_000,
      }),
    ],
  })

  const requests: RecordedRange[] = []
  const rangeFetch = rangedFetch(bytes, requests)

  const fetcher: typeof fetch = function (
    this: typeof globalThis,
    input: RequestInfo | URL,
    init?: RequestInit
  ) {
    assert.equal(this, globalThis)

    return rangeFetch(input, init)
  }

  const reader = createMatroskaSubtitleReader(
    "https://media.example/movie.mkv",
    fetcher
  )

  assert.equal((await reader.probe(new AbortController().signal)).length, 1)
  assert.ok(requests.length > 0)
})

void test("uses BlockDuration when a file has no subtitle Cues", async () => {
  const bytes = makeFixture({
    includeCues: false,
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "English",
        language: "eng",
        blockGroup: true,
        blockDurationTicks: 1_000,
      }),
    ],
  })

  const reader = createMatroskaSubtitleReader(
    "https://media.example/no-cues.mkv",
    rangedFetch(bytes, [])
  )

  assert.deepEqual(await reader.readCues(2, new AbortController().signal), [
    { startTime: 0.5, endTime: 1.5, text: "Hello subtitle" },
  ])
})

void test("rejects a no-Cues cluster beyond the bounded scan window", async () => {
  const bytes = makeFixture({
    includeCues: false,
    paddingBytes: 5 * 1024 * 1024,
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "English",
        language: "eng",
        blockGroup: true,
        blockDurationTicks: 1_000,
      }),
    ],
  })

  const requests: RecordedRange[] = []

  const reader = createMatroskaSubtitleReader(
    "https://media.example/large-no-cues.mkv",
    rangedFetch(bytes, requests)
  )

  const { signal } = new AbortController()

  await reader.probe(signal)
  await assert.rejects(reader.readCues(2, signal), /limit/)

  const bytesRead = requests.reduce(
    (total, request) => total + request.bytes,
    0
  )

  assert.ok(bytes.byteLength > 5 * 1024 * 1024)
  assert.ok(bytesRead < 16 * 1024, `requested ${bytesRead} bytes`)
})

void test("rejects missing durations, laced blocks, encoded tracks, and invalid UTF-8", async () => {
  const tracks = [
    makeTrack({
      trackNumber: 2,
      name: "No duration",
      language: "eng",
    }),
    makeTrack({
      trackNumber: 3,
      name: "Laced",
      language: "fra",
      blockFlags: 0x02,
      cueDurationTicks: 1_000,
    }),
    makeTrack({
      trackNumber: 4,
      name: "Encoded",
      language: "deu",
      contentEncodings: [{ type: 1, encryption: true }],
      cueDurationTicks: 1_000,
    }),
    makeTrack({
      trackNumber: 5,
      name: "Invalid UTF-8",
      language: "spa",
      cueDurationTicks: 1_000,
      textBytes: Uint8Array.of(0xc3, 0x28),
    }),
  ]

  const reader = createMatroskaSubtitleReader(
    "https://media.example/unsupported-blocks.mkv",
    rangedFetch(makeFixture({ tracks }), [])
  )

  const { signal } = new AbortController()

  await reader.probe(signal)
  await assert.rejects(reader.readCues(2, signal), /invalid/)
  await assert.rejects(reader.readCues(3, signal), /unsupported/)
  await assert.rejects(reader.readCues(4, signal), /unsupported/)
  await assert.rejects(reader.readCues(5, signal), /invalid/)
})

void test("restores zlib and ordered header-stripping subtitle encodings", async () => {
  const prefix = Uint8Array.of(0x20)

  const tracks = [
    makeTrack({
      trackNumber: 2,
      name: "Zlib",
      language: "eng",
      contentEncodings: [{ compression: { algorithm: 0 } }],
      cueDurationTicks: 1_000,
      textBytes: new TextEncoder().encode("Compressed subtitle"),
    }),
    makeTrack({
      trackNumber: 3,
      name: "Header stripping after zlib",
      language: "fra",
      contentEncodings: [
        { order: 0, compression: { algorithm: 3, settings: prefix } },
        { order: 1, compression: { algorithm: 0 } },
      ],
      cueDurationTicks: 1_000,
      textBytes: new TextEncoder().encode(" Header stripped subtitle"),
    }),
  ]

  const reader = createMatroskaSubtitleReader(
    "https://media.example/encoded-text.mkv",
    rangedFetch(makeFixture({ tracks }), [])
  )

  const { signal } = new AbortController()

  await reader.probe(signal)

  assert.deepEqual(await reader.readCues(2, signal), [
    { startTime: 0.5, endTime: 1.5, text: "Compressed subtitle" },
  ])
  assert.deepEqual(await reader.readCues(3, signal), [
    { startTime: 0.5, endTime: 1.5, text: "Header stripped subtitle" },
  ])
})

void test("rejects malformed, oversized, encrypted, and unsupported encodings", async () => {
  const tracks = [
    makeTrack({
      trackNumber: 2,
      name: "Malformed zlib",
      language: "eng",
      contentEncodings: [{ compression: { algorithm: 0 } }],
      cueDurationTicks: 1_000,
      textBytes: Uint8Array.of(0x78, 0x9c, 0xff, 0xff),
      preEncoded: true,
    }),
    makeTrack({
      trackNumber: 3,
      name: "Oversized expansion",
      language: "fra",
      contentEncodings: [{ compression: { algorithm: 0 } }],
      cueDurationTicks: 1_000,
      textBytes: new Uint8Array(64 * 1024 + 1).fill(0x41),
    }),
    makeTrack({
      trackNumber: 4,
      name: "Encrypted",
      language: "deu",
      contentEncodings: [{ type: 1, encryption: true }],
      cueDurationTicks: 1_000,
    }),
    makeTrack({
      trackNumber: 5,
      name: "Codec-private scope",
      language: "spa",
      contentEncodings: [{ scope: 2, compression: { algorithm: 0 } }],
      cueDurationTicks: 1_000,
    }),
    makeTrack({
      trackNumber: 6,
      name: "Unknown compression",
      language: "ita",
      contentEncodings: [{ compression: { algorithm: 7 } }],
      cueDurationTicks: 1_000,
    }),
  ]

  const reader = createMatroskaSubtitleReader(
    "https://media.example/invalid-encodings.mkv",
    rangedFetch(makeFixture({ tracks }), [])
  )

  const { signal } = new AbortController()

  await reader.probe(signal)

  await assert.rejects(reader.readCues(2, signal), { kind: "invalid" })
  await assert.rejects(reader.readCues(3, signal), { kind: "limit" })
  await assert.rejects(reader.readCues(4, signal), { kind: "unsupported" })
  await assert.rejects(reader.readCues(5, signal), { kind: "unsupported" })
  await assert.rejects(reader.readCues(6, signal), { kind: "unsupported" })
})

void test("stops on truncated input and servers that ignore Range", async () => {
  const fixture = makeFixture({
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "English",
        language: "eng",
        cueDurationTicks: 1_000,
      }),
    ],
  })

  const truncated = fixture.slice(0, 4)

  await assert.rejects(
    createMatroskaSubtitleReader(
      "https://media.example/truncated.mkv",
      rangedFetch(truncated, [])
    ).probe(new AbortController().signal),
    /invalid/
  )

  const requests: RecordedRange[] = []

  const ignoresRange: typeof fetch = async (input, init) => {
    requests.push({
      url: inputUrl(input),
      header: new Headers(init?.headers).get("range") ?? "",
      bytes: fixture.byteLength,
    })

    const body = new ArrayBuffer(fixture.byteLength)
    new Uint8Array(body).set(fixture)

    return new Response(body, { status: 200 })
  }

  await assert.rejects(
    createMatroskaSubtitleReader(
      "https://media.example/ignores-range.mkv",
      ignoresRange
    ).probe(new AbortController().signal),
    /unsupported/
  )
  assert.equal(requests.length, 2)
  assert.ok(requests.every((request) => request.header.startsWith("bytes=")))
})

void test("falls back to proxy byte ranges when direct CORS reads fail", async () => {
  const bytes = makeFixture({
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "English",
        language: "eng",
        cueDurationTicks: 1_000,
      }),
    ],
  })

  const requests: RecordedRange[] = []
  const rangeFetch = rangedFetch(bytes, requests)

  const fetcher: typeof fetch = async (input, init) => {
    if (inputUrl(input).startsWith("https://")) {
      requests.push({
        url: inputUrl(input),
        header: new Headers(init?.headers).get("range") ?? "",
        bytes: 0,
      })

      throw new TypeError("CORS blocked")
    }

    return rangeFetch(input, init)
  }

  const reader = createMatroskaSubtitleReader(
    "https://media.example/movie.mkv?token=sample",
    fetcher
  )

  await reader.probe(new AbortController().signal)

  assert.equal(requests.length, 4)
  assert.ok(requests[0]?.header.startsWith("bytes="))
  assert.ok(requests[1]?.url.startsWith("/api/media-proxy?url="))
  assert.ok(requests[2]?.header.startsWith("bytes="))
  assert.ok(requests[3]?.url.startsWith("/api/media-proxy?url="))
  assert.deepEqual(await reader.readCues(2, new AbortController().signal), [
    { startTime: 0.5, endTime: 1.5, text: "Hello subtitle" },
  ])
})

void test("retries every in-flight Cue index page after a concurrent CORS fallback", async () => {
  const blocks = Array.from({ length: 4_096 }, () => ({
    // Keep the signed Block relative timestamp in range while making the
    // generated Cue index large enough to span multiple 64 KiB reads.
    timestamp: 1_000,
    textBytes: new TextEncoder().encode("Cue"),
    cueDurationTicks: 1_000,
  }))

  const bytes = makeFixture({
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "English",
        language: "eng",
        blocks,
      }),
    ],
  })

  const requests: RecordedRange[] = []
  const proxyFetch = rangedFetch(bytes, requests)
  let directReads = 0
  let proxyReads = 0

  const fetcher: typeof fetch = async (input, init) => {
    if (inputUrl(input).startsWith("https://")) {
      directReads += 1
      await Promise.resolve()
      throw new TypeError("CORS blocked")
    }

    proxyReads += 1

    return proxyFetch(input, init)
  }

  const reader = createMatroskaSubtitleReader(
    "https://media.example/large-cue-index.mkv",
    fetcher
  )

  const cues = await reader.readCues(2, new AbortController().signal)

  assert.equal(cues.length, blocks.length)
  assert.ok(directReads >= 3)
  assert.ok(proxyReads >= 4)
  assert.ok(requests.some((request) => request.bytes === 64 * 1024))
})

void test("recovers one dropped proxy range without retrying malformed responses", async () => {
  const bytes = makeFixture({
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "English",
        language: "eng",
        cueDurationTicks: 1000,
      }),
    ],
  })

  const requests: RecordedRange[] = []
  const fixtureFetch = rangedFetch(bytes, requests)
  let proxyAttempts = 0

  const fetcher: typeof fetch = async (input, init) => {
    if (inputUrl(input).startsWith("https://")) {
      throw new TypeError("CORS blocked")
    }

    proxyAttempts += 1

    if (proxyAttempts === 1) {
      throw new TypeError("Dropped connection")
    }

    return fixtureFetch(input, init)
  }

  const reader = createMatroskaSubtitleReader(
    "https://media.example/movie.mkv",
    fetcher
  )

  assert.deepEqual(await reader.readCues(2, new AbortController().signal), [
    { startTime: 0.5, endTime: 1.5, text: "Hello subtitle" },
  ])
  assert.equal(proxyAttempts, 4)

  let invalidAttempts = 0

  const malformed: typeof fetch = async (input) => {
    if (inputUrl(input).startsWith("https://")) {
      throw new TypeError("CORS blocked")
    }

    invalidAttempts += 1

    return new Response(new Uint8Array(bytes), { status: 200 })
  }

  await assert.rejects(
    createMatroskaSubtitleReader(
      "https://media.example/movie.mkv",
      malformed
    ).probe(new AbortController().signal),
    /unsupported/
  )
  assert.equal(invalidAttempts, 1)
})

void test("retries a request deadline without treating it as source cancellation", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })

  const bytes = makeFixture({
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "English",
        language: "eng",
        cueDurationTicks: 1000,
      }),
    ],
  })

  const fixtureFetch = rangedFetch(bytes, [])
  let notifyStarted: (() => void) | undefined

  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })

  let proxyAttempts = 0

  const fetcher: typeof fetch = async (input, init) => {
    if (inputUrl(input).startsWith("https://")) {
      throw new TypeError("CORS blocked")
    }

    proxyAttempts += 1

    if (proxyAttempts !== 1) {
      return fixtureFetch(input, init)
    }

    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Timed out", "AbortError")),
        { once: true }
      )
      notifyStarted?.()
    })
  }

  const reader = createMatroskaSubtitleReader(
    "https://media.example/movie.mkv",
    fetcher
  )

  const cues = reader.readCues(2, new AbortController().signal)

  await started
  context.mock.timers.tick(10_000)
  assert.deepEqual(await cues, [
    { startTime: 0.5, endTime: 1.5, text: "Hello subtitle" },
  ])
  assert.equal(proxyAttempts, 4)
})

void test("cancellation prevents proxy retry after the source changes", async () => {
  const controller = new AbortController()
  const requests: string[] = []

  const fetcher: typeof fetch = async (input, init) => {
    requests.push(inputUrl(input))

    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true }
      )
      controller.abort()
    })
  }

  await assert.rejects(
    createMatroskaSubtitleReader(
      "https://media.example/movie.mkv",
      fetcher
    ).probe(controller.signal),
    /aborted/
  )
  assert.equal(requests.length, 1)
  assert.ok(requests[0]?.startsWith("https://"))
})

void test("reads selected cues from a large range source without reading the payload", async () => {
  const bytes = makeFixture({
    paddingBytes: 12 * 1024 * 1024,
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "English",
        language: "eng",
        cueDurationTicks: 1_000,
      }),
    ],
  })

  const requests: RecordedRange[] = []

  const reader = createMatroskaSubtitleReader(
    "https://media.example/large.mkv",
    rangedFetch(bytes, requests)
  )

  await reader.probe(new AbortController().signal)
  assert.deepEqual(await reader.readCues(2, new AbortController().signal), [
    { startTime: 0.5, endTime: 1.5, text: "Hello subtitle" },
  ])

  const bytesRead = requests.reduce(
    (total, request) => total + request.bytes,
    0
  )

  assert.ok(bytes.byteLength > 12 * 1024 * 1024)
  assert.ok(bytesRead < 128 * 1024, `requested ${bytesRead} bytes`)
  assert.ok(requests.every((request) => request.bytes <= 64 * 1024))
  assert.ok(requests.every((request) => request.header.startsWith("bytes=")))
})

void test("reads large cue indexes with bounded coarse pages", async () => {
  const packets = Array.from({ length: 4_096 }, (_, index) => ({
    timestamp: 1_000,
    textBytes: new TextEncoder().encode(`Cue ${index}`),
    cueDurationTicks: 1_000,
  }))

  const bytes = makeFixture({
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "Indexed English",
        language: "eng",
        blocks: packets,
      }),
    ],
  })

  const requests: RecordedRange[] = []

  const reader = createMatroskaSubtitleReader(
    "https://media.example/large-cues.mkv",
    rangedFetch(bytes, requests)
  )

  const cues = await reader.readCues(2, new AbortController().signal)

  assert.equal(cues.length, packets.length)
  assert.ok(requests.some((request) => request.bytes === 64 * 1024))
  assert.ok(requests.every((request) => request.bytes <= 64 * 1024))
})

void test("preserves timed ASS and SSA packets, styles, overrides, and metadata", async () => {
  const encoder = new TextEncoder()

  const assHeader = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 320",
    "PlayResY: 180",
    "WrapStyle: 2",
    "Collisions: Normal",
    "ScaledBorderAndShadow: yes",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Main,Arial,28,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,1,2,0,2,20,20,15,1",
    "Style: Accent,Arial,24,&H0000FF00,&H000000FF,&H00000000,&H80000000,0,0,1,2,0,8,20,20,15,1",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\r\n")

  const ssaHeader = [
    "[Script Info]",
    "ScriptType: v4.00",
    "PlayResX: 320",
    "PlayResY: 180",
    "Collisions: Normal",
    "[V4 Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding",
    "Style: Default,Arial,22,16777215,65535,0,0,-1,0,1,2,0,2,20,20,15,0,1",
    "[Events]",
    "Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\r\n")

  const assPackets = [
    String.raw`0,0:00:00.50,0:00:02.50,Main,,0,0,0,,{\pos(160,70)\c&H0000FF00&}{\rAccent}{\k20}Ka{\k30}raoke`,
    "0,0:00:00.50,0:00:02.50,Main,,0,0,22,,First collision line",
    "0,0:00:00.50,0:00:02.50,Main,,0,0,22,,Second collision line",
    String.raw`1,0:00:00.50,0:00:02.50,Main,,0,0,0,,{\move(10,130,310,130,0,2000)\an8}Moving line`,
  ]

  const ssaPacket =
    "0,0:00:00.75,0:00:02.25,Default,,0000,0000,0000,Marked=0,,Legacy subtitle"

  const tracks = [
    makeTrack({
      trackNumber: 2,
      name: "Styled English",
      language: "eng",
      languageIetf: "en-US",
      codecId: "S_TEXT/ASS",
      codecPrivate: encoder.encode(assHeader),
      blocks: assPackets.map((text, index) => ({
        timestamp: 500,
        textBytes: encoder.encode(text),
        cueDurationTicks: 2_000,
        blockFlags: index === 1 ? 0 : undefined,
      })),
    }),
    makeTrack({
      trackNumber: 3,
      name: "Legacy French",
      language: "fre",
      codecId: "S_TEXT/SSA",
      codecPrivate: encoder.encode(ssaHeader),
      blocks: [
        {
          timestamp: 750,
          textBytes: encoder.encode(ssaPacket),
          blockGroup: true,
          blockDurationTicks: 1_500,
        },
      ],
    }),
  ]

  const reader = createMatroskaSubtitleReader(
    "https://media.example/styled-subtitles.mkv",
    rangedFetch(makeFixture({ tracks }), [])
  )

  const { signal } = new AbortController()

  assert.deepEqual(
    (await reader.probe(signal)).map(({ id, codecId, label, language }) => ({
      id,
      codecId,
      label,
      language,
    })),
    [
      {
        id: "matroska-2",
        codecId: "S_TEXT/ASS",
        label: "Styled English",
        language: "en-US",
      },
      {
        id: "matroska-3",
        codecId: "S_TEXT/SSA",
        label: "Legacy French",
        language: "fre",
      },
    ]
  )

  const ass = await reader.readAssTrack(2, signal)
  assert.equal(new TextDecoder().decode(ass.codecPrivate), assHeader)
  assert.deepEqual(
    ass.packets.map(({ data }) => new TextDecoder().decode(data)),
    assPackets
  )
  assert.deepEqual(
    ass.packets.map(({ startTime, duration }) => ({ startTime, duration })),
    assPackets.map(() => ({ startTime: 0.5, duration: 2 }))
  )
  assert.match(
    new TextDecoder().decode(ass.packets[0]?.data),
    /\\pos\(160,70\)/
  )
  assert.match(new TextDecoder().decode(ass.packets[0]?.data), /\\k20/)

  const ssa = await reader.readAssTrack(3, signal)
  assert.equal(new TextDecoder().decode(ssa.codecPrivate), ssaHeader)
  assert.deepEqual(
    ssa.packets.map(({ data, startTime, duration }) => ({
      text: new TextDecoder().decode(data),
      startTime,
      duration,
    })),
    [{ text: ssaPacket, startTime: 0.75, duration: 1.5 }]
  )
})

void test("streams indexed ASS packets before later cluster reads finish", async () => {
  const encoder = new TextEncoder()

  const packets = Array.from({ length: 13 }, (_, index) => ({
    timestamp: (index + 1) * 1_000,
    textBytes: encoder.encode(
      `0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Cue ${index}`
    ),
    cueDurationTicks: 1_000,
  }))

  const bytes = makeFixture({
    clusterPerBlock: true,
    clusterPaddingBytes: 64 * 1024,
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "Streaming ASS",
        language: "eng",
        codecId: "S_TEXT/ASS",
        codecPrivate: encoder.encode("[Script Info]\r\n[Events]\r\n"),
        blocks: packets,
      }),
    ],
  })

  const clusterOffsets = findElementOffsets(bytes, IDS.cluster)
  const lastClusterOffset = clusterOffsets.at(-1) ?? 0
  const cuesOffset = findElementOffsets(bytes, IDS.cues).at(-1) ?? 0

  assert.equal(clusterOffsets.length, packets.length)
  assert.notEqual(
    Math.floor(lastClusterOffset / (64 * 1024)),
    Math.floor(cuesOffset / (64 * 1024))
  )

  const delayedPage = Math.floor(lastClusterOffset / (64 * 1024)) * (64 * 1024)
  let startDelayedPage!: () => void
  let releaseDelayedPage!: () => void

  const delayedPageStarted = new Promise<void>((resolve) => {
    startDelayedPage = resolve
  })

  const delayedPageRelease = new Promise<void>((resolve) => {
    releaseDelayedPage = resolve
  })

  const fixtureFetch = rangedFetch(bytes, [])

  const fetcher: typeof fetch = async (input, init) => {
    const range = new Headers(init?.headers).get("Range") ?? ""
    const start = Number(/^bytes=(\d+)-\d+$/.exec(range)?.[1])

    if (start === delayedPage) {
      startDelayedPage()
      await delayedPageRelease
    }

    return fixtureFetch(input, init)
  }

  const reader = createMatroskaSubtitleReader(
    "https://media.example/streaming-ass.mkv",
    fetcher
  )

  const stream = reader.streamAssTrack(2, new AbortController().signal)
  const received: string[] = []
  const replayed: string[] = []
  let resolveFirstBatch!: () => void

  const firstBatch = new Promise<void>((resolve) => {
    resolveFirstBatch = resolve
  })

  let completed = false
  let unsubscribeReplay: (() => void) | null = null

  void stream.result.then(
    () => {
      completed = true
    },
    () => {
      completed = true
    }
  )
  stream.subscribePackets((batch) => {
    received.push(...batch.map(({ data }) => new TextDecoder().decode(data)))

    if (received.length >= 12) {
      resolveFirstBatch()
    }
  })

  try {
    await firstBatch
    await delayedPageStarted
    assert.equal(completed, false)
    assert.equal(received.length, 12)

    unsubscribeReplay = stream.subscribePackets((batch) => {
      replayed.push(...batch.map(({ data }) => new TextDecoder().decode(data)))
    })

    assert.deepEqual(replayed, received)
  } finally {
    releaseDelayedPage()
  }

  const result = await stream.result
  unsubscribeReplay?.()

  assert.equal(result.packets.length, packets.length)
  assert.deepEqual(
    received,
    packets.map(({ textBytes }) => new TextDecoder().decode(textBytes))
  )
  assert.deepEqual(replayed, received)
})

void test("ASS deadline reports timeout after retaining partial packets", async (context) => {
  let expireDeadline: (() => void) | undefined
  const originalSetTimeout = globalThis.setTimeout

  context.mock.method(
    globalThis,
    "setTimeout",
    (callback: (...args: never[]) => void, delay?: number) => {
      if (delay === 240_000) {
        expireDeadline = () => callback()

        return originalSetTimeout(() => undefined, delay)
      }

      return originalSetTimeout(callback, delay)
    }
  )

  const encoder = new TextEncoder()

  const packets = Array.from({ length: 13 }, (_, index) => ({
    timestamp: (index + 1) * 1_000,
    textBytes: encoder.encode(
      `0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Cue ${index}`
    ),
    cueDurationTicks: 1_000,
  }))

  const bytes = makeFixture({
    clusterPerBlock: true,
    clusterPaddingBytes: 64 * 1024,
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "ASS deadline",
        language: "eng",
        codecId: "S_TEXT/ASS",
        codecPrivate: encoder.encode("[Script Info]\r\n[Events]\r\n"),
        blocks: packets,
      }),
    ],
  })

  const lastClusterOffset = findElementOffsets(bytes, IDS.cluster).at(-1) ?? 0

  const delayedPage = Math.floor(lastClusterOffset / (64 * 1024)) * (64 * 1024)

  const fixtureFetch = rangedFetch(bytes, [])

  let startDelayedPage!: () => void

  const delayedPageStarted = new Promise<void>((resolve) => {
    startDelayedPage = resolve
  })

  const fetcher: typeof fetch = async (input, init) => {
    const range = new Headers(init?.headers).get("Range") ?? ""
    const start = Number(/^bytes=(\d+)-\d+$/.exec(range)?.[1])

    if (start === delayedPage) {
      startDelayedPage()

      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Deadline", "AbortError")),
          { once: true }
        )
      })
    }

    return fixtureFetch(input, init)
  }

  const source = new AbortController()

  const stream = createMatroskaSubtitleReader(
    "https://media.example/partial-ass-deadline.mkv",
    fetcher
  ).streamAssTrack(2, source.signal)

  const received: string[] = []
  const replayed: string[] = []

  let resolveFirstBatch!: () => void

  const firstBatch = new Promise<void>((resolve) => {
    resolveFirstBatch = resolve
  })

  void stream.result.catch(() => {})

  stream.subscribePackets((batch) => {
    received.push(...batch.map(({ data }) => new TextDecoder().decode(data)))

    if (received.length >= 12) {
      resolveFirstBatch()
    }
  })

  await firstBatch
  await delayedPageStarted
  assert.equal(received.length, 12)
  assert.ok(expireDeadline)

  expireDeadline()

  await assert.rejects(stream.result, {
    kind: "deadline",
    message: "Embedded subtitle extraction timed out.",
  })

  assert.equal(source.signal.aborted, false)

  const unsubscribe = stream.subscribePackets((batch) => {
    replayed.push(...batch.map(({ data }) => new TextDecoder().decode(data)))
  })

  unsubscribe()

  assert.equal(received.length, 12)
  assert.deepEqual(replayed, received)
  assert.equal(replayed.includes("Cue 12"), false)
})

void test("keeps a progressing ASS load alive by re-arming the track deadline", async (context) => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout

  type DeadlineTimerHandle = ReturnType<typeof setTimeout>

  const deadlineTimerHandles = new Set<DeadlineTimerHandle>()
  let clearedDeadlineTimers = 0

  context.mock.method(
    globalThis,
    "setTimeout",
    (callback: (...args: never[]) => void, delay?: number) => {
      if (delay === 240_000) {
        // The real timer never fires within the test; only its handle is
        // tracked so re-arms are observable through clearTimeout.
        const handle = originalSetTimeout(() => undefined, delay)

        deadlineTimerHandles.add(handle)

        return handle
      }

      return originalSetTimeout(callback, delay)
    }
  )

  context.mock.method(
    globalThis,
    "clearTimeout",
    (handle: DeadlineTimerHandle) => {
      if (deadlineTimerHandles.delete(handle)) {
        clearedDeadlineTimers += 1
      }

      originalClearTimeout(handle)
    }
  )

  const encoder = new TextEncoder()

  const packets = Array.from({ length: 6 }, (_, index) => ({
    timestamp: (index + 1) * 1_000,
    textBytes: encoder.encode(
      `0,0:00:00.0${index},0:00:01.00,Default,,0,0,0,,Cue ${index}`
    ),
    cueDurationTicks: 1_000,
  }))

  const bytes = makeFixture({
    clusterPerBlock: true,
    clusterPaddingBytes: 64 * 1024,
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "ASS extended deadline",
        language: "eng",
        codecId: "S_TEXT/ASS",
        codecPrivate: encoder.encode("[Script Info]\r\n[Events]\r\n"),
        blocks: packets,
      }),
    ],
  })

  const lastClusterOffset = findElementOffsets(bytes, IDS.cluster).at(-1) ?? 0

  const delayedPage = Math.floor(lastClusterOffset / (64 * 1024)) * (64 * 1024)

  const fixtureFetch = rangedFetch(bytes, [])

  let releaseFinalCluster!: () => void

  const finalClusterReleased = new Promise<void>((resolve) => {
    releaseFinalCluster = resolve
  })

  const fetcher: typeof fetch = async (input, init) => {
    const range = new Headers(init?.headers).get("Range") ?? ""
    const start = Number(/^bytes=(\d+)-\d+$/.exec(range)?.[1])

    if (start === delayedPage) {
      await finalClusterReleased
    }

    return fixtureFetch(input, init)
  }

  const stream = createMatroskaSubtitleReader(
    "https://media.example/ass-extended-deadline.mkv",
    fetcher
  ).streamAssTrack(2, new AbortController().signal)

  let resolveFirstBatches!: () => void

  const firstBatches = new Promise<void>((resolve) => {
    resolveFirstBatches = resolve
  })

  const received: string[] = []

  void stream.result.catch(() => {})

  stream.subscribePackets((batch) => {
    received.push(...batch.map(({ data }) => new TextDecoder().decode(data)))

    if (received.length >= 5) {
      resolveFirstBatches()
    }
  })

  await firstBatches

  releaseFinalCluster()

  const result = await stream.result

  assert.equal(result.packets.length, 6)
  assert.equal(received.length, 6)

  // The gated final cluster cannot share a batch with the five before it, so
  // at least two progress re-arms plus the dispose must have cleared timers;
  // a fixed deadline clears exactly one, in dispose.
  assert.ok(
    clearedDeadlineTimers >= 3,
    `Expected batch progress to re-arm the track deadline, saw ${clearedDeadlineTimers} clears.`
  )
})

void test("accepts ASS tracks above 10,000 packets within the shared cue limit", async () => {
  const encoder = new TextEncoder()

  const packet = encoder.encode(
    "0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Fixture"
  )

  const blocks = Array.from({ length: 10_001 }, (_, timestamp) => ({
    timestamp,
    textBytes: packet,
    cueDurationTicks: 1_000,
  }))

  const reader = createMatroskaSubtitleReader(
    "https://media.example/many-ass-cues.mkv",
    rangedFetch(
      makeFixture({
        tracks: [
          makeTrack({
            trackNumber: 2,
            name: "Many ASS cues",
            language: "eng",
            codecId: "S_TEXT/ASS",
            codecPrivate: encoder.encode("[Script Info]\r\n[Events]\r\n"),
            blocks,
          }),
        ],
      }),
      []
    )
  )

  const result = await reader.readAssTrack(2, new AbortController().signal)

  assert.equal(result.packets.length, 10_001)
  assert.equal(result.packets[10_000]?.startTime, 10)
})

void test("loads only linked font attachments and tolerates a missing font", async () => {
  const linkedFont = Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7)
  const legacyTtf = Uint8Array.of(8, 9, 10, 11)
  const legacySfnt = Uint8Array.of(12, 13, 14, 15)
  const legacyWoff = Uint8Array.of(16, 17, 18, 19)
  const unrelatedFont = new Uint8Array(128 * 1024).fill(0xe7)

  const track = makeTrack({
    trackNumber: 2,
    name: "English with font",
    language: "eng",
    codecId: "S_TEXT/ASS",
    codecPrivate: new TextEncoder().encode("[Script Info]\r\n[Events]\r\n"),
    attachmentLinks: [100, 101, 102, 103],
    cueDurationTicks: 1_000,
  })

  const bytes = makeFixture({
    tracks: [track],
    attachments: [
      {
        uid: 100,
        name: "Fixture.ttf",
        mimeType: "application/x-truetype-font",
        data: linkedFont,
      },
      {
        uid: 101,
        name: "Legacy.ttf",
        mimeType: "application/x-font-ttf",
        data: legacyTtf,
      },
      {
        uid: 102,
        name: "Sfnt.ttf",
        mimeType: "application/font-sfnt",
        data: legacySfnt,
      },
      {
        uid: 103,
        name: "Woff.woff",
        mimeType: "application/font-woff",
        data: legacyWoff,
      },
      {
        uid: 200,
        name: "Unlinked.ttf",
        mimeType: "font/ttf",
        data: unrelatedFont,
      },
    ],
  })

  const requests: RecordedRange[] = []

  const reader = createMatroskaSubtitleReader(
    "https://media.example/linked-font.mkv",
    rangedFetch(bytes, requests)
  )

  assert.deepEqual(
    (await reader.readAssTrack(2, new AbortController().signal)).fonts,
    [linkedFont, legacyTtf, legacySfnt, legacyWoff]
  )
  assert.ok(requests.every(({ header }) => header.startsWith("bytes=")))

  const missingFontReader = createMatroskaSubtitleReader(
    "https://media.example/missing-font.mkv",
    rangedFetch(
      makeFixture({
        tracks: [
          makeTrack({
            ...track,
            attachmentLinks: [999],
          }),
        ],
        attachments: [
          {
            uid: 200,
            name: "Unlinked.ttf",
            mimeType: "font/ttf",
            data: unrelatedFont,
          },
        ],
      }),
      []
    )
  )

  assert.deepEqual(
    (await missingFontReader.readAssTrack(2, new AbortController().signal))
      .fonts,
    []
  )
})

void test("reads indexed ASS clusters with bounded concurrency and preserves cue order", async () => {
  const encoder = new TextEncoder()

  const packets = Array.from({ length: 24 }, (_, index) => ({
    timestamp: (index + 1) * 1_000,
    textBytes: encoder.encode(
      `0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Cue ${index}`
    ),
    cueDurationTicks: 1_000,
  }))

  const bytes = makeFixture({
    clusterPerBlock: true,
    clusterPaddingBytes: 64 * 1024,
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "ASS across clusters",
        language: "eng",
        codecId: "S_TEXT/ASS",
        codecPrivate: encoder.encode("[Script Info]\r\n[Events]\r\n"),
        blocks: packets,
      }),
    ],
  })

  const requests: RecordedRange[] = []
  let activeRequests = 0
  let maximumActiveRequests = 0

  const fixtureFetch = rangedFetch(bytes, requests)

  const clusterPages = findElementOffsets(bytes, IDS.cluster).map(
    (offset) => Math.floor(offset / (64 * 1024)) * (64 * 1024)
  )

  const heldPages = new Set(clusterPages)
  let resolveBatch: (() => void) | undefined
  let releaseBatch: (() => void) | undefined

  const batchReady = new Promise<void>((resolve) => {
    resolveBatch = resolve
  })

  const batchRelease = new Promise<void>((resolve) => {
    releaseBatch = resolve
  })

  const delayedFetch: typeof fetch = async (input, init) => {
    assert.equal(
      init?.cache,
      "no-store",
      "Concurrent ranges must bypass the browser HTTP cache lock"
    )
    const range = new Headers(init?.headers).get("Range") ?? ""
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)

    if (match === null || !heldPages.has(Number(match[1]))) {
      return fixtureFetch(input, init)
    }

    activeRequests += 1
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests)

    if (activeRequests === 1) {
      resolveBatch?.()
    }

    await batchRelease
    activeRequests -= 1

    return fixtureFetch(input, init)
  }

  const reader = createMatroskaSubtitleReader(
    "https://media.example/indexed-ass.mkv",
    delayedFetch
  )

  const read = reader.readAssTrack(2, new AbortController().signal)

  await batchReady
  releaseBatch?.()

  const result = await read

  assert.deepEqual(
    result.packets.map(({ data, startTime }) => ({
      text: new TextDecoder().decode(data),
      startTime,
    })),
    packets.map(({ textBytes, timestamp }) => ({
      text: new TextDecoder().decode(textBytes),
      startTime: timestamp / 1_000,
    }))
  )
  assert.ok(maximumActiveRequests > 1)
  assert.ok(maximumActiveRequests <= 12)
  assert.ok(heldPages.size >= 16)
  assert.ok(requests.every(({ header }) => header.startsWith("bytes=")))
})

void test("fills the bounded indexed cluster read window behind a slow cluster", async () => {
  const encoder = new TextEncoder()

  const packets = Array.from({ length: 36 }, (_, index) => ({
    timestamp: (index + 1) * 500,
    textBytes: encoder.encode(
      `0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Cue ${index}`
    ),
    cueDurationTicks: 1_000,
  }))

  const bytes = makeFixture({
    clusterPerBlock: true,
    clusterPaddingBytes: 64 * 1024,
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "ASS scheduling window",
        language: "eng",
        codecId: "S_TEXT/ASS",
        codecPrivate: encoder.encode("[Script Info]\r\n[Events]\r\n"),
        blocks: packets,
      }),
    ],
  })

  const clusterPages = findElementOffsets(bytes, IDS.cluster).map(
    (offset) => Math.floor(offset / (64 * 1024)) * (64 * 1024)
  )

  const heldPage = clusterPages.at(2)
  const lastPageInReadWindow = clusterPages.at(25)

  if (heldPage === undefined || lastPageInReadWindow === undefined) {
    throw new Error("The indexed ASS fixture is missing a cluster page.")
  }

  assert.equal(new Set(clusterPages).size, packets.length)

  const requests: RecordedRange[] = []

  const fixtureFetch = rangedFetch(bytes, requests)

  let resolveHeldPageStarted!: () => void
  let releaseHeldPage!: () => void

  const heldPageStarted = new Promise<void>((resolve) => {
    resolveHeldPageStarted = resolve
  })

  let resolveLastWindowPageStarted!: () => void

  const lastWindowPageStarted = new Promise<void>((resolve) => {
    resolveLastWindowPageStarted = resolve
  })

  const heldPageRelease = new Promise<void>((resolve) => {
    releaseHeldPage = resolve
  })

  let activeClusterRangeReads = 0
  let maximumActiveClusterRangeReads = 0
  let lastWindowPageStartedBeforeRelease = false
  let clusterBeyondWindowStartedBeforeRelease = false
  let maximumClusterIndexStartedBeforeRelease = -1
  let heldPageWasReleased = false

  const received: string[] = []

  const delayedFetch: typeof fetch = async (input, init) => {
    const range = new Headers(init?.headers).get("Range") ?? ""
    const match = /^bytes=(\d+)-\d+$/.exec(range)

    if (match === null) {
      return fixtureFetch(input, init)
    }

    const pageStart = Number(match[1])
    const clusterIndex = clusterPages.indexOf(pageStart)

    if (clusterIndex >= 0) {
      // The fixture puts each cluster on a distinct range page.
      activeClusterRangeReads += 1
      maximumActiveClusterRangeReads = Math.max(
        maximumActiveClusterRangeReads,
        activeClusterRangeReads
      )
    }

    if (!heldPageWasReleased && clusterIndex >= 0) {
      maximumClusterIndexStartedBeforeRelease = Math.max(
        maximumClusterIndexStartedBeforeRelease,
        clusterIndex
      )

      if (clusterIndex > 25) {
        clusterBeyondWindowStartedBeforeRelease = true
      }
    }

    if (pageStart === lastPageInReadWindow) {
      lastWindowPageStartedBeforeRelease = !heldPageWasReleased
      resolveLastWindowPageStarted()
    }

    try {
      if (pageStart === heldPage) {
        resolveHeldPageStarted()
        await heldPageRelease
      }

      return await fixtureFetch(input, init)
    } finally {
      if (clusterIndex >= 0) {
        activeClusterRangeReads -= 1
      }
    }
  }

  const reader = createMatroskaSubtitleReader(
    "https://media.example/indexed-ass-window.mkv",
    delayedFetch
  )

  const stream = reader.streamAssTrack(2, new AbortController().signal)

  stream.subscribePackets((batch) => {
    received.push(...batch.map(({ data }) => new TextDecoder().decode(data)))
  })

  await heldPageStarted

  try {
    await lastWindowPageStarted

    assert.equal(heldPageWasReleased, false)
    assert.equal(lastWindowPageStartedBeforeRelease, true)
    assert.equal(clusterBeyondWindowStartedBeforeRelease, false)
    assert.equal(maximumClusterIndexStartedBeforeRelease, 25)
  } finally {
    heldPageWasReleased = true
    releaseHeldPage()
  }

  assert.ok(maximumActiveClusterRangeReads <= 12)
  const result = await stream.result
  assert.equal(result.packets.length, packets.length)
  assert.deepEqual(
    received,
    packets.map(({ textBytes }) => new TextDecoder().decode(textBytes))
  )
})

void test("cancels every pending range in an indexed ASS batch", async () => {
  const encoder = new TextEncoder()

  const packets = Array.from({ length: 8 }, (_, index) => ({
    timestamp: (index + 1) * 1_000,
    textBytes: encoder.encode(
      `0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Cue ${index}`
    ),
    cueDurationTicks: 1_000,
  }))

  const bytes = makeFixture({
    clusterPerBlock: true,
    clusterPaddingBytes: 64 * 1024,
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "ASS cancellation",
        language: "eng",
        codecId: "S_TEXT/ASS",
        codecPrivate: encoder.encode("[Script Info]\r\n[Events]\r\n"),
        blocks: packets,
      }),
    ],
  })

  const requests: RecordedRange[] = []
  const fixtureFetch = rangedFetch(bytes, requests)
  let pendingRequests = 0
  let abortedRequests = 0

  const clusterPages = findElementOffsets(bytes, IDS.cluster).map(
    (offset) => Math.floor(offset / (64 * 1024)) * (64 * 1024)
  )

  const heldPages = new Set(clusterPages.slice(4, 8))
  let resolveBatch: (() => void) | undefined

  const batchReady = new Promise<void>((resolve) => {
    resolveBatch = resolve
  })

  const fetcher: typeof fetch = async (input, init) => {
    const range = new Headers(init?.headers).get("Range") ?? ""
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)

    if (match !== null && heldPages.has(Number(match[1]))) {
      pendingRequests += 1

      if (pendingRequests === 4) {
        resolveBatch?.()
      }

      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal

        if (signal === undefined || signal === null) {
          throw new Error("Expected an abort signal for fixture fetch.")
        }

        signal.addEventListener(
          "abort",
          () => {
            abortedRequests += 1
            reject(new DOMException("Aborted", "AbortError"))
          },
          { once: true }
        )
      })
    }

    return fixtureFetch(input, init)
  }

  const reader = createMatroskaSubtitleReader(
    "https://media.example/cancel-indexed-ass.mkv",
    fetcher
  )

  const controller = new AbortController()

  await reader.probe(controller.signal)

  const read = reader.readAssTrack(2, controller.signal)

  await batchReady
  controller.abort()

  await assert.rejects(read, { kind: "aborted" })
  assert.equal(pendingRequests, 4)
  assert.equal(abortedRequests, 4)
})

void test("reads ASS packets without Cues using BlockDuration", async () => {
  const packet = "0,0:00:00.50,0:00:01.50,Default,,0,0,0,,No Cues"

  const reader = createMatroskaSubtitleReader(
    "https://media.example/no-cues-ass.mkv",
    rangedFetch(
      makeFixture({
        includeCues: false,
        tracks: [
          makeTrack({
            trackNumber: 2,
            name: "ASS without Cues",
            language: "eng",
            codecId: "S_TEXT/ASS",
            codecPrivate: new TextEncoder().encode(
              "[Script Info]\r\n[Events]\r\n"
            ),
            blocks: [
              {
                timestamp: 500,
                textBytes: new TextEncoder().encode(packet),
                blockGroup: true,
                blockDurationTicks: 1_000,
              },
            ],
          }),
        ],
      }),
      []
    )
  )

  assert.deepEqual(
    (await reader.readAssTrack(2, new AbortController().signal)).packets.map(
      ({ data, startTime, duration }) => ({
        text: new TextDecoder().decode(data),
        startTime,
        duration,
      })
    ),
    [{ text: packet, startTime: 0.5, duration: 1 }]
  )
})

void test("cancels pending ASS byte reads when its track is deselected", async () => {
  const controller = new AbortController()
  const requestedUrls: string[] = []

  const fetcher: typeof fetch = async (input, init) => {
    requestedUrls.push(inputUrl(input))

    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true }
      )
      controller.abort()
    })
  }

  await assert.rejects(
    createMatroskaSubtitleReader(
      "https://media.example/pending-ass.mkv",
      fetcher
    ).readAssTrack(2, controller.signal),
    /aborted/
  )
  assert.equal(requestedUrls.length, 1)
  assert.ok(requestedUrls[0]?.startsWith("https://"))
})

void test("fails ASS tracks for missing headers, malformed packets, lacing, encodings, and duration", async () => {
  const validHeader = new TextEncoder().encode("[Script Info]\r\n[Events]\r\n")

  const tracks = [
    makeTrack({
      trackNumber: 2,
      name: "Missing header",
      language: "eng",
      codecId: "S_TEXT/ASS",
      cueDurationTicks: 1_000,
    }),
    makeTrack({
      trackNumber: 3,
      name: "Malformed packet",
      language: "fra",
      codecId: "S_TEXT/ASS",
      codecPrivate: validHeader,
      cueDurationTicks: 1_000,
      textBytes: Uint8Array.of(0xc3, 0x28),
    }),
    makeTrack({
      trackNumber: 4,
      name: "Laced packet",
      language: "deu",
      codecId: "S_TEXT/ASS",
      codecPrivate: validHeader,
      cueDurationTicks: 1_000,
      blockFlags: 0x02,
    }),
    makeTrack({
      trackNumber: 5,
      name: "Encoded track",
      language: "spa",
      codecId: "S_TEXT/SSA",
      codecPrivate: validHeader,
      contentEncodings: [{ type: 1, encryption: true }],
      cueDurationTicks: 1_000,
    }),
    makeTrack({
      trackNumber: 6,
      name: "Missing duration",
      language: "ita",
      codecId: "S_TEXT/ASS",
      codecPrivate: validHeader,
    }),
  ]

  const reader = createMatroskaSubtitleReader(
    "https://media.example/invalid-ass.mkv",
    rangedFetch(makeFixture({ tracks }), [])
  )

  const { signal } = new AbortController()

  await reader.probe(signal)
  await assert.rejects(reader.readAssTrack(2, signal), /invalid/)
  await assert.rejects(reader.readAssTrack(3, signal), /invalid/)
  await assert.rejects(reader.readAssTrack(4, signal), /unsupported/)
  await assert.rejects(reader.readAssTrack(5, signal), /unsupported/)
  await assert.rejects(reader.readAssTrack(6, signal), /invalid/)
})

void test("rejects oversized ASS codec private data and linked fonts", async () => {
  const validPacket = new TextEncoder().encode(
    "0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Text"
  )

  const largeCodecPrivate = createMatroskaSubtitleReader(
    "https://media.example/large-codec-private.mkv",
    rangedFetch(
      makeFixture({
        tracks: [
          makeTrack({
            trackNumber: 2,
            name: "Large header",
            language: "eng",
            codecId: "S_TEXT/ASS",
            codecPrivate: new Uint8Array(256 * 1024 + 1),
            cueDurationTicks: 1_000,
            textBytes: validPacket,
          }),
        ],
      }),
      []
    )
  )

  await assert.rejects(
    largeCodecPrivate.readAssTrack(2, new AbortController().signal),
    /limit/
  )

  const oversizedFontReader = createMatroskaSubtitleReader(
    "https://media.example/large-font.mkv",
    rangedFetch(
      makeFixture({
        tracks: [
          makeTrack({
            trackNumber: 2,
            name: "Large font",
            language: "eng",
            codecId: "S_TEXT/ASS",
            codecPrivate: new TextEncoder().encode(
              "[Script Info]\r\n[Events]\r\n"
            ),
            attachmentLinks: [100],
            cueDurationTicks: 1_000,
            textBytes: validPacket,
          }),
        ],
        attachments: [
          {
            uid: 100,
            name: "Oversized.ttf",
            mimeType: "font/ttf",
            data: new Uint8Array(24 * 1024 * 1024 + 1),
          },
        ],
      }),
      []
    )
  )

  await assert.rejects(
    oversizedFontReader.readAssTrack(2, new AbortController().signal),
    /limit/
  )
})

void test("streams binary PGS blocks without CodecPrivate or BlockDuration", async () => {
  const firstSegment = Uint8Array.of(0x14, 0, 2, 0, 0)
  const endSegment = Uint8Array.of(0x80, 0, 0)
  const secondSegment = Uint8Array.of(0x16, 0, 2, 0, 0)
  const requests: RecordedRange[] = []

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-track.mkv",
    rangedFetch(
      makeFixture({
        clusterPerBlock: true,
        tracks: [
          makeTrack({
            trackNumber: 7,
            name: "PGS 日本語",
            language: "jpn",
            codecId: "S_HDMV/PGS",
            forced: true,
            blocks: [
              {
                timestamp: 100,
                textBytes: concat(firstSegment, endSegment),
              },
              {
                timestamp: 250,
                textBytes: secondSegment,
                blockGroup: true,
                blockDurationTicks: 2_500,
              },
            ],
          }),
        ],
      }),
      requests
    )
  )

  const { signal } = new AbortController()
  const tracks = await reader.probe(signal)

  assert.deepEqual(
    tracks.map(({ id, codecId, label, language, flags }) => ({
      id,
      codecId,
      label,
      language,
      flags,
    })),
    [
      {
        id: "matroska-7",
        codecId: "S_HDMV/PGS",
        label: "PGS 日本語",
        language: "jpn",
        flags: {
          default: true,
          forced: true,
          hearingImpaired: false,
          visualImpaired: false,
          textDescriptions: false,
          commentary: false,
          original: false,
        },
      },
    ]
  )

  const packets = []

  for await (const packet of reader.streamPgsTrack(7, signal)) {
    packets.push(packet)
  }

  assert.deepEqual(
    packets.map(({ data, startTime, duration }) => ({
      data: [...data],
      startTime,
      duration,
    })),
    [
      { data: [...firstSegment], startTime: 0.1, duration: null },
      { data: [...endSegment], startTime: 0.1, duration: null },
      { data: [...secondSegment], startTime: 0.25, duration: 2.5 },
    ]
  )
  assert.deepEqual(
    packets.map((packet) => packet.location.segmentOffset),
    [0, firstSegment.byteLength, 0]
  )
  assert.ok(packets.every((packet) => packet.location.clusterPosition > 0))
  assert.ok(requests.length > 0)
})

void test("inflates zlib-compressed PGS blocks before segment parsing", async () => {
  const segment = Uint8Array.of(0x14, 0, 2, 0, 0)

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-zlib.mkv",
    rangedFetch(
      makeFixture({
        clusterPerBlock: true,
        tracks: [
          makeTrack({
            trackNumber: 7,
            name: "PGS English",
            language: "eng",
            codecId: "S_HDMV/PGS",
            contentEncodings: [{ compression: { algorithm: 0 } }],
            blocks: [{ timestamp: 100, textBytes: segment }],
          }),
        ],
      }),
      []
    )
  )

  const { signal } = new AbortController()

  await reader.probe(signal)

  const packets = []

  for await (const packet of reader.streamPgsTrack(7, signal)) {
    packets.push(packet)
  }

  assert.equal(packets.length, 1)
  assert.deepEqual(packets[0]?.data, segment)
})

void test("loads a zlib PGS window from a verified boundary without earlier A/V", async () => {
  const epoch = pgsDisplaySet([
    pgsPalette(0),
    pgsObject(1, 0),
    pgsWindow(0),
    pgsPresentation(0x80, 0, [{ objectId: 1, windowId: 0 }]),
  ])

  const omittedStateUpdate = pgsDisplaySet([pgsPalette(0)])

  const target = pgsDisplaySet([
    pgsPresentation(0, 0, [{ objectId: 1, windowId: 0 }]),
  ])

  const clear = pgsDisplaySet([pgsPresentation(0, 0, [])])

  const bytes = makeFixture({
    clusterPerBlock: true,
    clusterPaddingBytesByIndex: { 0: 8 * 1024 * 1024 },
    cueBlockIndices: [1, 3, 4],
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "Video placeholder",
        language: "und",
        codecId: "S_TEXT/UTF8",
        blocks: [{ timestamp: 0, textBytes: Uint8Array.of(0) }],
      }),
      makeTrack({
        trackNumber: 7,
        name: "PGS window",
        language: "eng",
        codecId: "S_HDMV/PGS",
        contentEncodings: [{ compression: { algorithm: 0 } }],
        blocks: [
          { timestamp: 8_000, textBytes: epoch },
          { timestamp: 9_000, textBytes: omittedStateUpdate },
          { timestamp: 10_000, textBytes: target },
          { timestamp: 11_000, textBytes: clear },
        ],
      }),
    ],
  })

  const requests: RecordedRange[] = []

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-target-window.mkv",
    rangedFetch(bytes, requests)
  )

  const events = []

  for await (const event of reader.streamPgsWindow(
    7,
    10,
    new AbortController().signal
  )) {
    events.push(event)
  }

  assert.deepEqual(events[0], { kind: "boundary", boundaryTime: 8 })
  assert.deepEqual(events.at(-1), {
    kind: "coverage",
    coverageTime: 11,
    complete: false,
  })
  assert.ok(
    requests.length < 32,
    `Expected the PGS window to reuse bounded range pages; got ${requests.length} requests.`
  )
  assert.deepEqual(
    events
      .flatMap((event) => (event.kind === "packet" ? [event.packet] : []))
      .map(({ startTime, data }) => [startTime, data[0]]),
    [
      ...[0x14, 0x15, 0x17, 0x16, 0x80].map((type) => [8, type]),
      ...[0x14, 0x80].map((type) => [9, type]),
      ...[0x16, 0x80].map((type) => [10, type]),
      ...[0x16, 0x80].map((type) => [11, type]),
    ]
  )

  const [leadingCluster, epochCluster] = findElementOffsets(bytes, IDS.cluster)

  assert.notEqual(leadingCluster, undefined)
  assert.notEqual(epochCluster, undefined)

  const firstEpochPage =
    Math.floor((epochCluster ?? 0) / (64 * 1024)) * (64 * 1024)

  const gapPageReads = requests.filter(({ header }) => {
    const match = /^bytes=(\d+)-\d+$/.exec(header)
    const start = match === null ? -1 : Number(match[1])

    return start > (leadingCluster ?? 0) && start < (epochCluster ?? 0)
  })

  assert.ok(
    gapPageReads.length <= 1 &&
      gapPageReads.every(({ header, bytes: byteLength }) => {
        const match = /^bytes=(\d+)-\d+$/.exec(header)

        return (
          (match === null ? -1 : Number(match[1])) === firstEpochPage &&
          byteLength <= 64 * 1024
        )
      }),
    `Expected only the page containing the verified epoch, got ${gapPageReads.map(({ header }) => header).join(", ")}.`
  )
})

void test("covers multiple PGS compositions in one bounded window", async () => {
  const epoch = pgsDisplaySet([
    pgsPalette(0),
    pgsObject(1, 0),
    pgsWindow(0),
    pgsPresentation(0x80, 0, [{ objectId: 1, windowId: 0 }]),
  ])

  const composition = pgsDisplaySet([
    pgsPresentation(0, 0, [{ objectId: 1, windowId: 0 }]),
  ])

  const cueBlockIndices = Array.from({ length: 41 }, (_, index) => index)

  const bytes = makeFixture({
    clusterPerBlock: true,
    cueBlockIndices,
    tracks: [
      makeTrack({
        trackNumber: 7,
        name: "PGS window coverage",
        language: "eng",
        codecId: "S_HDMV/PGS",
        blocks: [
          { timestamp: 0, textBytes: epoch },
          ...Array.from({ length: 40 }, (_, index) => ({
            timestamp: (index + 1) * 1_000,
            textBytes: composition,
          })),
        ],
      }),
    ],
  })

  const requests: RecordedRange[] = []

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-window-coverage.mkv",
    rangedFetch(bytes, requests)
  )

  const events = []

  for await (const event of reader.streamPgsWindow(
    7,
    0,
    new AbortController().signal
  )) {
    events.push(event)
  }

  assert.deepEqual(events[0], { kind: "boundary", boundaryTime: 0 })
  assert.deepEqual(events.at(-1), {
    kind: "coverage",
    coverageTime: 10,
    complete: false,
  })
  assert.ok(
    events.filter((event) => event.kind === "packet").length >= 20,
    "Expected the window to include the state transitions before its coverage edge."
  )
  assert.ok(
    requests.length < 32,
    `Expected the bounded PGS window to reuse range pages; got ${requests.length} requests.`
  )

  const firstReadRequestCount = requests.length
  const repeatedEvents = []

  for await (const event of reader.streamPgsWindow(
    7,
    0,
    new AbortController().signal
  )) {
    repeatedEvents.push(event)
  }

  assert.deepEqual(repeatedEvents, events)
  assert.equal(
    requests.length,
    firstReadRequestCount,
    "Expected a repeated window to reuse the reader's bounded PGS page cache."
  )
})

void test("restarts the shared PGS Cue index read after a seek cancels it", async () => {
  const epoch = pgsDisplaySet([
    pgsPalette(0),
    pgsObject(1, 0),
    pgsWindow(0),
    pgsPresentation(0x80, 0, [{ objectId: 1, windowId: 0 }]),
  ])

  const target = pgsDisplaySet([
    pgsPresentation(0, 0, [{ objectId: 1, windowId: 0 }]),
  ])

  const clear = pgsDisplaySet([pgsPresentation(0, 0, [])])

  const bytes = makeFixture({
    clusterPerBlock: true,
    cueBlockIndices: [0, 1, 2],
    tracks: [
      makeTrack({
        trackNumber: 7,
        name: "PGS seek cancellation",
        language: "eng",
        codecId: "S_HDMV/PGS",
        blocks: [
          { timestamp: 8_000, textBytes: epoch },
          { timestamp: 10_000, textBytes: target },
          { timestamp: 11_000, textBytes: clear },
        ],
      }),
    ],
  })

  const requests: RecordedRange[] = []
  const fixtureFetch = rangedFetch(bytes, requests)
  let stallNextRead = false
  let cueReadStarted!: () => void

  const cueReadStartedPromise = new Promise<void>((resolve) => {
    cueReadStarted = resolve
  })

  let rangeAttempts = 0

  const fetcher: typeof fetch = async (input, init) => {
    rangeAttempts += 1

    if (stallNextRead) {
      stallNextRead = false
      cueReadStarted()

      await new Promise<void>((_resolve, reject) => {
        const signal = init?.signal

        const abort = () =>
          reject(new DOMException("The request was aborted.", "AbortError"))

        if (signal?.aborted) {
          abort()
        } else {
          signal?.addEventListener("abort", abort, { once: true })
        }
      })
    }

    return fixtureFetch(input, init)
  }

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-cue-cancel.mkv",
    fetcher
  )

  await reader.probe(new AbortController().signal)
  stallNextRead = true

  const firstController = new AbortController()
  const firstStream = reader.streamPgsWindow(7, 10, firstController.signal)
  const firstIterator = firstStream[Symbol.asyncIterator]()

  const firstAttempt = firstIterator.next().then(
    (value) => ({ value, error: null }),
    (error: MatroskaSubtitleError) => ({ value: null, error })
  )

  await cueReadStartedPromise
  firstController.abort()

  const firstResult = await firstAttempt

  assert.ok(firstResult.error instanceof MatroskaSubtitleError)
  assert.equal(firstResult.error.kind, "aborted")

  const secondEvents = []

  for await (const event of reader.streamPgsWindow(
    7,
    10,
    new AbortController().signal
  )) {
    secondEvents.push(event)
  }

  assert.deepEqual(secondEvents[0], { kind: "boundary", boundaryTime: 8 })
  assert.ok(rangeAttempts >= 2)
  assert.ok(requests.length > 0)
})

void test("reads PGS state packets from an unindexed cluster between CuePoints", async () => {
  const epoch = pgsDisplaySet([
    pgsPalette(0),
    pgsObject(1, 0),
    pgsWindow(0),
    pgsPresentation(0x80, 0, [{ objectId: 1, windowId: 0 }]),
  ])

  const acquisition = pgsDisplaySet([
    pgsPalette(1),
    pgsObject(1, 1),
    pgsWindow(1),
    pgsPresentation(0x40, 1, []),
  ])

  const dependentComposition = pgsDisplaySet([
    pgsPresentation(0, 1, [{ objectId: 1, windowId: 1 }]),
  ])

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-sparse-state.mkv",
    rangedFetch(
      makeFixture({
        clusterPerBlock: true,
        cueBlockIndices: [0, 2],
        tracks: [
          makeTrack({
            trackNumber: 7,
            name: "PGS sparse state",
            language: "eng",
            codecId: "S_HDMV/PGS",
            blocks: [
              { timestamp: 100, textBytes: epoch },
              { timestamp: 200, textBytes: acquisition },
              {
                timestamp: 300,
                textBytes: dependentComposition,
                cueDurationTicks: 4_000,
              },
            ],
          }),
        ],
      }),
      []
    )
  )

  const packets = []

  for await (const packet of reader.streamPgsTrack(
    7,
    new AbortController().signal
  )) {
    packets.push(packet)
  }

  assert.deepEqual(
    packets.map(({ startTime, data, duration }) => ({
      startTime,
      type: data[0],
      duration,
    })),
    [
      ...[0.1, 0.1, 0.1, 0.1, 0.1].map((startTime, index) => ({
        startTime,
        type: [0x14, 0x15, 0x17, 0x16, 0x80][index],
        duration: null,
      })),
      ...[0.2, 0.2, 0.2, 0.2, 0.2].map((startTime, index) => ({
        startTime,
        type: [0x14, 0x15, 0x17, 0x16, 0x80][index],
        duration: null,
      })),
      ...[0.3, 0.3].map((startTime, index) => ({
        startTime,
        type: [0x16, 0x80][index],
        duration: 4,
      })),
    ]
  )
})

void test("reads PGS clusters omitted at the leading and trailing Cue boundaries", async () => {
  const leading = pgsDisplaySet([pgsPalette(0)])
  const indexed = pgsDisplaySet([pgsPalette(1)])
  const trailing = pgsDisplaySet([pgsSegment(0x16)])

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-leading-trailing.mkv",
    rangedFetch(
      makeFixture({
        clusterPerBlock: true,
        cueBlockIndices: [1],
        tracks: [
          makeTrack({
            trackNumber: 7,
            name: "PGS boundaries",
            language: "eng",
            codecId: "S_HDMV/PGS",
            blocks: [
              { timestamp: 100, textBytes: leading },
              {
                timestamp: 200,
                textBytes: indexed,
                cueDurationTicks: 5_000,
              },
              { timestamp: 300, textBytes: trailing },
            ],
          }),
        ],
      }),
      []
    )
  )

  const packets = []

  for await (const packet of reader.streamPgsTrack(
    7,
    new AbortController().signal
  )) {
    packets.push(packet)
  }

  assert.deepEqual(
    packets.map(({ startTime, data, duration }) => [
      startTime,
      data[0],
      duration,
    ]),
    [
      [0.1, 0x14, null],
      [0.1, 0x80, null],
      [0.2, 0x14, 5],
      [0.2, 0x80, 5],
      [0.3, 0x16, null],
      [0.3, 0x80, null],
    ]
  )
})

void test("starts at a distant first PGS Cue without scanning the A/V gap", async () => {
  const leadingBlockCount = 520

  const bytes = makeFixture({
    clusterPerBlock: true,
    clusterPaddingBytes: 8 * 1024,
    cueBlockIndices: [leadingBlockCount],
    tracks: [
      makeTrack({
        trackNumber: 2,
        name: "Video placeholder",
        language: "und",
        codecId: "S_TEXT/UTF8",
        blocks: Array.from({ length: leadingBlockCount }, (_, index) => ({
          timestamp: index,
          textBytes: Uint8Array.of(0),
        })),
      }),
      makeTrack({
        trackNumber: 7,
        name: "PGS distant first Cue",
        language: "eng",
        codecId: "S_HDMV/PGS",
        blocks: [
          {
            timestamp: leadingBlockCount,
            textBytes: pgsDisplaySet([pgsPalette(0)]),
          },
        ],
      }),
    ],
  })

  const requests: RecordedRange[] = []

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-distant-first-cue.mkv",
    rangedFetch(bytes, requests)
  )

  const packets = []

  for await (const packet of reader.streamPgsTrack(
    7,
    new AbortController().signal
  )) {
    packets.push(packet)
  }

  assert.equal(packets[0]?.data[0], 0x14)

  const clusterOffsets = findElementOffsets(bytes, IDS.cluster)
  const [firstCluster] = clusterOffsets
  const firstCueCluster = clusterOffsets.at(-1)

  assert.notEqual(firstCluster, undefined)

  assert.notEqual(firstCueCluster, undefined)

  const leadingRequests = requests.filter((request) => {
    const match = /^bytes=(\d+)-/.exec(request.header)

    const start = match === null ? -1 : Number(match[1])

    const firstCuePageStart =
      Math.floor((firstCueCluster ?? 0) / (2 * 1024 * 1024)) * (2 * 1024 * 1024)

    return start > (firstCluster ?? 0) && start < firstCuePageStart
  })

  assert.deepEqual(leadingRequests, [])
})

void test("reads indexed PGS clusters through large aligned range pages", async () => {
  const pageSize = 2 * 1024 * 1024

  const bytes = makeFixture({
    clusterPerBlock: true,
    clusterPaddingBytes: pageSize * 2 + 1024,
    tracks: [
      makeTrack({
        trackNumber: 7,
        name: "PGS large pages",
        language: "eng",
        codecId: "S_HDMV/PGS",
        blocks: [0, 1, 2].map((index) => ({
          timestamp: (index + 1) * 1_000,
          textBytes: pgsDisplaySet([pgsPalette(index)]),
        })),
      }),
    ],
  })

  const requests: RecordedRange[] = []

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-large-pages.mkv",
    rangedFetch(bytes, requests)
  )

  const packets: MatroskaPgsPacket[] = []

  for await (const packet of reader.streamPgsTrack(
    7,
    new AbortController().signal
  )) {
    packets.push(packet)
  }

  // Each display set contributes one packet per PGS segment (palette + end).
  assert.equal(packets.length, 6)

  const clusterPageStarts = new Set(
    findElementOffsets(bytes, IDS.cluster).map(
      (offset) => Math.floor(offset / pageSize) * pageSize
    )
  )

  const clusterPages = requests.filter(({ header }) => {
    const match = /^bytes=(\d+)-/.exec(header)

    return match !== null && clusterPageStarts.has(Number(match[1]))
  })

  // Three padded clusters spanning about two pages each must arrive in a
  // handful of aligned requests, not hundreds of small ones.
  assert.ok(
    clusterPages.length > 0 && clusterPages.length <= 9,
    `Expected aligned cluster page reads, got ${JSON.stringify(clusterPages)}.`
  )
  assert.ok(
    clusterPages.every(({ header, bytes: byteLength }) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(header)

      return (
        match !== null &&
        Number(match[1]) % pageSize === 0 &&
        byteLength <= pageSize
      )
    }),
    `Expected 2 MiB-aligned page requests, got ${JSON.stringify(clusterPages)}.`
  )
})

void test("pipelines cluster page fetches ahead of sequential PGS parsing", async () => {
  const pageSize = 2 * 1024 * 1024

  const bytes = makeFixture({
    clusterPerBlock: true,
    clusterPaddingBytes: pageSize * 2 + 1024,
    tracks: [
      makeTrack({
        trackNumber: 7,
        name: "PGS pipelined pages",
        language: "eng",
        codecId: "S_HDMV/PGS",
        blocks: [
          { timestamp: 1_000, textBytes: pgsDisplaySet([pgsPalette(0)]) },
        ],
      }),
    ],
  })

  const [clusterOffset] = findElementOffsets(bytes, IDS.cluster)

  if (clusterOffset === undefined) {
    throw new Error("The pipelined PGS fixture needs a cluster.")
  }

  const clusterPage = Math.floor(clusterOffset / pageSize) * pageSize

  // The padded cluster spans three pages, but its parse only reads headers
  // near the cluster start: the middle and last pages arrive exclusively
  // through the cluster-span prefetch. Hold the middle page and require the
  // last page to be fetched anyway — that is the pipelining under test.
  const heldPage = clusterPage + pageSize
  const prefetchedPage = heldPage + pageSize

  const fixtureFetch = rangedFetch(bytes, [])

  let releaseHeldPage!: () => void
  let resolvePrefetchStarted!: () => void

  const heldPageReleased = new Promise<void>((resolve) => {
    releaseHeldPage = resolve
  })

  const clusterPrefetchStarted = new Promise<void>((resolve) => {
    resolvePrefetchStarted = resolve
  })

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-pipelined-pages.mkv",
    async (input, init) => {
      const range = new Headers(init?.headers).get("range") ?? ""
      const match = /^bytes=(\d+)-\d+$/.exec(range)
      const start = match === null ? -1 : Number(match[1])

      if (start === prefetchedPage) {
        resolvePrefetchStarted()
      }

      if (start === heldPage || start === prefetchedPage) {
        await heldPageReleased
      }

      return fixtureFetch(input, init)
    }
  )

  const packets: MatroskaPgsPacket[] = []

  const reading = (async () => {
    for await (const packet of reader.streamPgsTrack(
      7,
      new AbortController().signal
    )) {
      packets.push(packet)
    }
  })()

  await clusterPrefetchStarted

  releaseHeldPage()

  await reading

  // One packet per PGS segment: palette and end of display set.
  assert.equal(packets.length, 2)
})

void test("stops before a dependent Cue after an unscanned physical gap", async () => {
  const first = pgsDisplaySet([pgsPalette(0)])

  const second = pgsDisplaySet([pgsPalette(1)])

  const bytes = makeFixture({
    clusterPerBlock: true,
    clusterPaddingBytesByIndex: { 1: 64 * 1024 * 1024 + 1 },
    cueBlockIndices: [0, 2],
    tracks: [
      makeTrack({
        trackNumber: 7,
        name: "PGS first Cue",
        language: "eng",
        codecId: "S_HDMV/PGS",
        blocks: [{ timestamp: 100, textBytes: first }],
      }),
      makeTrack({
        trackNumber: 2,
        name: "Video placeholder",
        language: "und",
        codecId: "S_TEXT/UTF8",
        blocks: [{ timestamp: 200, textBytes: Uint8Array.of(0) }],
      }),
      makeTrack({
        trackNumber: 7,
        name: "PGS second Cue",
        language: "eng",
        codecId: "S_HDMV/PGS",
        blocks: [{ timestamp: 300, textBytes: second }],
      }),
    ],
  })

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-unscanned-gap.mkv",
    rangedFetch(bytes, [])
  )

  const packets: MatroskaPgsPacket[] = []

  await assert.rejects(async () => {
    for await (const packet of reader.streamPgsTrack(
      7,
      new AbortController().signal
    )) {
      packets.push(packet)
    }
  }, isLimitError)

  assert.ok(packets.some((packet) => packet.startTime === 0.1))
  assert.equal(
    packets.some((packet) => packet.startTime === 0.3),
    false
  )
})

void test("reads a selected PGS block from an oversized A/V cluster", async () => {
  const bytes = makeFixture({
    paddingBytes: 5 * 1024 * 1024,
    tracks: [
      makeTrack({
        trackNumber: 7,
        name: "PGS oversized cluster",
        language: "eng",
        codecId: "S_HDMV/PGS",
        textBytes: pgsDisplaySet([pgsPalette(0)]),
      }),
    ],
  })

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-oversized-cluster.mkv",
    rangedFetch(bytes, [])
  )

  const packets = []

  for await (const packet of reader.streamPgsTrack(
    7,
    new AbortController().signal
  )) {
    packets.push(packet)
  }

  assert.equal(packets[0]?.data[0], 0x14)
})

void test("accepts a concatenated PGS block above the single-segment size", async () => {
  const oversizedObject = new Uint8Array(65_538)
  oversizedObject[0] = 0x15
  oversizedObject[1] = 0xff
  oversizedObject[2] = 0xff

  const palette = pgsPalette(0)
  const end = pgsSegment(0x80)
  const blockBytes = concat(oversizedObject, palette, end)

  assert.ok(blockBytes.byteLength + 4 > 65_550)

  const reader = createMatroskaSubtitleReader(
    "https://media.example/pgs-large-block.mkv",
    rangedFetch(
      makeFixture({
        tracks: [
          makeTrack({
            trackNumber: 7,
            name: "PGS large block",
            language: "eng",
            codecId: "S_HDMV/PGS",
            textBytes: blockBytes,
          }),
        ],
      }),
      []
    )
  )

  const packets = []

  for await (const packet of reader.streamPgsTrack(
    7,
    new AbortController().signal
  )) {
    packets.push(packet)
  }

  assert.equal(packets[0]?.data.byteLength, oversizedObject.byteLength)
  assert.equal(packets[1]?.data.byteLength, palette.byteLength)
  assert.equal(packets[2]?.data.byteLength, end.byteLength)
})
