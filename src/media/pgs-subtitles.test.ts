import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import wasmInit, { PgsParser } from "libbitsub/pkg"

import {
  createMatroskaSubtitleReader,
  type MatroskaPgsPacket,
} from "./matroska-subtitles"
import {
  compositePgsFrame,
  createPgsSupSegment,
  PGS_LIMITS,
  PgsDisplaySetInspector,
  type PgsDisplaySet,
} from "./pgs-subtitles"

function be16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff]
}

function be24(value: number): number[] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function segment(type: number, payload: number[]): Uint8Array {
  return Uint8Array.from([type, ...be16(payload.length), ...payload])
}

function pcs({
  state = 0,
  width = 64,
  height = 48,
  paletteId = 0,
  objects = [{ id: 1, x: 10, y: 12, window: 0 }],
  crop,
}: {
  state?: number
  width?: number
  height?: number
  paletteId?: number
  objects?: Array<{ id: number; x: number; y: number; window?: number }>
  crop?: { x: number; y: number; width: number; height: number }
} = {}): Uint8Array {
  const payload = [
    ...be16(width),
    ...be16(height),
    0x10,
    0,
    1,
    state,
    0,
    paletteId,
    objects.length,
  ]

  for (const object of objects) {
    payload.push(
      ...be16(object.id),
      object.window ?? 0,
      crop === undefined ? 0 : 0x80,
      ...be16(object.x),
      ...be16(object.y)
    )

    if (crop !== undefined) {
      payload.push(
        ...be16(crop.x),
        ...be16(crop.y),
        ...be16(crop.width),
        ...be16(crop.height)
      )
    }
  }

  return segment(0x16, payload)
}

function windowSegment({
  id = 0,
  x = 0,
  y = 0,
  width = 64,
  height = 48,
}: {
  id?: number
  x?: number
  y?: number
  width?: number
  height?: number
} = {}): Uint8Array {
  return segment(0x17, [
    1,
    id,
    ...be16(x),
    ...be16(y),
    ...be16(width),
    ...be16(height),
  ])
}

function paletteSegment(luma = 235): Uint8Array {
  return segment(0x14, [0, 0, 1, luma, 128, 128, 255])
}

function paletteEntriesSegment(
  entries: Array<[number, number, number, number, number]>,
  version = 0
): Uint8Array {
  return segment(0x14, [
    0,
    version,
    ...entries.flatMap(([index, luma, cr, cb, alpha]) => [
      index,
      luma,
      cr,
      cb,
      alpha,
    ]),
  ])
}

function objectFragment({
  bytes,
  flags,
  width = 4,
  height = 3,
  totalBytes = bytes.length,
  objectId = 1,
}: {
  bytes: number[]
  flags: number
  width?: number
  height?: number
  totalBytes?: number
  objectId?: number
}): Uint8Array {
  const header = [
    ...be16(objectId),
    0,
    flags,
    ...(flags & 0x80
      ? [...be24(totalBytes + 4), ...be16(width), ...be16(height)]
      : []),
  ]

  return segment(0x15, [...header, ...bytes])
}

function packet(data: Uint8Array, startTime: number): MatroskaPgsPacket {
  return {
    data,
    startTime,
    duration: null,
    location: { clusterPosition: 100, blockOffset: 50, segmentOffset: 0 },
  }
}

function pushSet(
  inspector: PgsDisplaySetInspector,
  segments: Uint8Array[],
  timestamp: number
): PgsDisplaySet | null {
  let result: PgsDisplaySet | null = null

  for (const data of segments) {
    result = inspector.push(packet(data, timestamp)) ?? result
  }

  return result
}

function createSupDisplaySetBytes(
  displaySet: PgsDisplaySet,
  baseTime: number
): Uint8Array {
  const wrappedSegments = displaySet.segments.map((packetSegment) =>
    createPgsSupSegment(packetSegment, baseTime)
  )

  const bytes = new Uint8Array(
    wrappedSegments.reduce(
      (total, wrappedSegment) => total + wrappedSegment.byteLength,
      0
    )
  )

  let offset = 0

  for (const wrappedSegment of wrappedSegments) {
    bytes.set(wrappedSegment, offset)
    offset += wrappedSegment.byteLength
  }

  return bytes
}

let pgsWasmReady: Promise<void> | null = null

async function createPgsParser(): Promise<PgsParser> {
  pgsWasmReady ??= readFile(
    new URL(
      "../../node_modules/libbitsub/pkg/libbitsub_bg.wasm",
      import.meta.url
    )
  ).then(async (bytes) => {
    await wasmInit({ module_or_path: new Uint8Array(bytes) })
  })

  await pgsWasmReady

  return new PgsParser()
}

function compositionRgba(parser: PgsParser, index: number): number[] {
  const frame = parser.renderAtIndex(index)

  assert.ok(frame)
  assert.equal(frame.compositionCount, 1)

  const composition = frame.getComposition(0)

  assert.ok(composition)

  try {
    return Array.from(composition.getRgba())
  } finally {
    composition.free()
    frame.free()
  }
}

function assertRgbClose(
  actual: number[],
  expected: number[],
  tolerance = 2
): void {
  assert.equal(actual.length, expected.length)

  for (let index = 0; index < actual.length; index += 1) {
    const channel = index % 4

    if (channel === 3) {
      assert.equal(actual[index], expected[index])
    } else {
      assert.ok(
        Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)) <= tolerance,
        `RGB channel ${index} differed: ${actual[index]} vs ${expected[index]}`
      )
    }
  }
}

void test("wraps one raw Matroska PGS segment as SUP with rebased PTS and zero DTS", () => {
  const raw = paletteSegment()
  const wrapped = createPgsSupSegment(packet(raw, 12.5), 10)
  const view = new DataView(wrapped.buffer)

  assert.deepEqual(Array.from(wrapped.subarray(0, 2)), [0x50, 0x47])
  assert.equal(view.getUint32(2), 225_000)
  assert.equal(view.getUint32(6), 0)
  assert.deepEqual(Array.from(wrapped.subarray(10)), Array.from(raw))

  assert.throws(
    () =>
      createPgsSupSegment(
        packet(raw, 10 + PGS_LIMITS.maxTimestampSpan + 1),
        10
      ),
    /Invalid embedded PGS segment/
  )
})

void test("requires a verified complete boundary and follows reused PGS state", () => {
  const inspector = new PgsDisplaySetInspector()
  const rle = [0, 0x84, 1, 0, 0, 0x84, 1, 0, 0, 0x84, 1, 0, 0]

  const firstFragment = objectFragment({
    bytes: rle.slice(0, 7),
    flags: 0x80,
    totalBytes: rle.length,
  })

  const finalFragment = objectFragment({ bytes: rle.slice(7), flags: 0x40 })

  const unverifiedAcquisition = pushSet(
    inspector,
    [pcs({ state: 0x40 }), segment(0x80, [])],
    1
  )

  assert.equal(unverifiedAcquisition?.valid, false)

  const epoch = pushSet(
    inspector,
    [
      pcs({ state: 0x80 }),
      windowSegment({ x: 8, y: 8, width: 32, height: 24 }),
      paletteSegment(235),
      firstFragment,
      finalFragment,
      segment(0x80, []),
    ],
    2
  )

  assert.equal(epoch?.valid, true)
  assert.equal(epoch?.boundary, true)
  assert.equal(epoch?.composition?.objects[0]?.window.x, 8)

  const reuse = pushSet(
    inspector,
    [pcs({ objects: [{ id: 1, x: 20, y: 5 }] }), segment(0x80, [])],
    3
  )

  assert.equal(reuse?.valid, true)
  assert.equal(reuse?.composition?.objects[0]?.x, 20)
})

void test("rejects incomplete acquisition state until a later full epoch", () => {
  const inspector = new PgsDisplaySetInspector()

  const incomplete = pushSet(
    inspector,
    [pcs({ state: 0x40 }), segment(0x80, [])],
    1
  )

  const normal = pushSet(inspector, [pcs(), segment(0x80, [])], 2)

  const recovered = pushSet(
    inspector,
    [
      pcs({ state: 0x80 }),
      windowSegment(),
      paletteSegment(),
      objectFragment({
        bytes: [0, 0x84, 1, 0, 0],
        flags: 0xc0,
        width: 4,
        height: 1,
      }),
      segment(0x80, []),
    ],
    3
  )

  assert.equal(incomplete?.valid, false)
  assert.equal(normal?.valid, false)
  assert.equal(recovered?.valid, true)
})

void test("invalidates reused palette state after a malformed update", () => {
  const inspector = new PgsDisplaySetInspector()

  const epoch = pushSet(
    inspector,
    [
      pcs({ state: 0x80 }),
      windowSegment(),
      paletteSegment(),
      objectFragment({ bytes: [0, 0x84, 1, 0, 0], flags: 0xc0 }),
      segment(0x80, []),
    ],
    1
  )

  const malformed = pushSet(
    inspector,
    [pcs(), segment(0x14, [0, 1, 99]), segment(0x80, [])],
    2
  )

  const reuse = pushSet(inspector, [pcs(), segment(0x80, [])], 3)

  assert.equal(epoch?.valid, true)
  assert.equal(malformed?.valid, false)
  assert.equal(reuse?.valid, false)
})

void test("validates object lengths and presentation dimensions before decode", () => {
  const malformedInspector = new PgsDisplaySetInspector()

  const malformed = pushSet(
    malformedInspector,
    [
      pcs({ state: 0x80 }),
      windowSegment(),
      paletteSegment(),
      objectFragment({ bytes: [1, 2, 3], flags: 0xc0, totalBytes: 100 }),
      segment(0x80, []),
    ],
    1
  )

  const oversizedInspector = new PgsDisplaySetInspector()

  const oversized = pushSet(
    oversizedInspector,
    [pcs({ state: 0x80, width: 4097 }), segment(0x80, [])],
    1
  )

  assert.equal(malformed?.valid, false)
  assert.equal(oversized?.valid, false)
})

void test("clips object pixels to crop, window, and presentation bounds", () => {
  const width = 4
  const height = 3
  const rgba = new Uint8Array(width * height * 4)

  for (let index = 0; index < width * height; index += 1) {
    rgba.set([255, 0, 0, 255], index * 4)
  }

  const result = compositePgsFrame(5, 4, [
    {
      x: 1,
      y: 1,
      width,
      height,
      rgba,
      crop: { x: 1, y: 1, width: 3, height: 2 },
      window: { x: 2, y: 2, width: 2, height: 1 },
    },
  ])

  const pixel = (x: number, y: number) =>
    result.slice((y * 5 + x) * 4, (y * 5 + x) * 4 + 4)

  assert.deepEqual(Array.from(pixel(2, 2)), [255, 0, 0, 255])
  assert.deepEqual(Array.from(pixel(3, 2)), [255, 0, 0, 255])
  assert.deepEqual(Array.from(pixel(1, 2)), [0, 0, 0, 0])
  assert.deepEqual(Array.from(pixel(3, 1)), [0, 0, 0, 0])
})

void test("composites multiple objects in order and preserves transparent pixels", () => {
  const result = compositePgsFrame(3, 1, [
    {
      x: 0,
      y: 0,
      width: 2,
      height: 1,
      rgba: Uint8Array.of(0, 0, 255, 255, 0, 255, 0, 0),
      crop: null,
      window: { x: 0, y: 0, width: 3, height: 1 },
    },
    {
      x: 1,
      y: 0,
      width: 1,
      height: 1,
      rgba: Uint8Array.of(255, 0, 0, 128),
      crop: null,
      window: { x: 1, y: 0, width: 1, height: 1 },
    },
  ])

  const pixel = (x: number) => result.slice(x * 4, x * 4 + 4)

  assert.deepEqual(Array.from(pixel(0)), [0, 0, 255, 255])
  assert.deepEqual(Array.from(pixel(1)), [255, 0, 0, 128])
  assert.deepEqual(Array.from(pixel(2)), [0, 0, 0, 0])
})

void test("resets verified object and palette state at a complete new epoch", () => {
  const inspector = new PgsDisplaySetInspector()

  const firstEpoch = pushSet(
    inspector,
    [
      pcs({ state: 0x80 }),
      windowSegment(),
      paletteSegment(),
      objectFragment({ bytes: [0, 0x84, 1, 0, 0], flags: 0xc0 }),
      segment(0x80, []),
    ],
    1
  )

  const nextEpoch = pushSet(
    inspector,
    [
      pcs({
        state: 0x80,
        paletteId: 4,
        objects: [{ id: 2, x: 20, y: 10, window: 3 }],
      }),
      windowSegment({ id: 3, x: 16, y: 8, width: 32, height: 24 }),
      segment(0x14, [4, 0, 1, 76, 255, 85, 255]),
      objectFragment({
        objectId: 2,
        width: 2,
        height: 1,
        bytes: [0, 0x82, 1],
        flags: 0xc0,
      }),
      segment(0x80, []),
    ],
    2
  )

  assert.equal(firstEpoch?.valid, true)
  assert.equal(nextEpoch?.valid, true)
  assert.equal(nextEpoch?.composition?.objects[0]?.objectId, 2)
})

void test("merges partial palette updates for the pinned decoder", async () => {
  const inspector = new PgsDisplaySetInspector()

  const epoch = pushSet(
    inspector,
    [
      pcs({ state: 0x80, width: 2, height: 1 }),
      windowSegment({ width: 2, height: 1 }),
      paletteEntriesSegment([
        [1, 100, 100, 200, 255],
        [2, 16, 128, 128, 255],
      ]),
      objectFragment({
        bytes: [1, 2, 0, 0],
        flags: 0xc0,
        width: 2,
        height: 1,
      }),
      segment(0x80, []),
    ],
    0
  )

  const update = pushSet(
    inspector,
    [
      pcs({ width: 2, height: 1 }),
      paletteEntriesSegment([[2, 76, 255, 85, 255]], 1),
      segment(0x80, []),
    ],
    1
  )

  assert.equal(epoch?.valid, true)
  assert.equal(update?.valid, true)

  const updatePalette = update?.segments.find(
    (candidate) => candidate.data[0] === 0x14
  )

  assert.ok(updatePalette)
  assert.equal(updatePalette.data.byteLength, 15)
  assert.deepEqual(
    Array.from(updatePalette.data.subarray(3)),
    [0, 1, 1, 98, 96, 210, 255, 2, 76, 255, 85, 255]
  )
  assert.equal(update?.decoderBytes, 70)

  const parser = await createPgsParser()

  try {
    assert.equal(parser.feed(createSupDisplaySetBytes(epoch, 0)), 1)
    assert.equal(parser.feed(createSupDisplaySetBytes(update, 0)), 1)

    assertRgbClose(compositionRgba(parser, 0), [53, 92, 243, 255, 0, 0, 0, 255])
    assertRgbClose(
      compositionRgba(parser, 1),
      [53, 92, 243, 255, 254, 0, 0, 255]
    )
    assertRgbClose(compositionRgba(parser, 0), [53, 92, 243, 255, 0, 0, 0, 255])
  } finally {
    parser.free()
  }
})

void test("adapts limited-range BT.601 palette colors for the pinned decoder", async () => {
  const inspector = new PgsDisplaySetInspector()

  const displaySet = pushSet(
    inspector,
    [
      pcs({ state: 0x80, width: 5, height: 1 }),
      windowSegment({ width: 5, height: 1 }),
      paletteEntriesSegment([
        [1, 235, 128, 128, 255],
        [2, 16, 128, 128, 255],
        [3, 76, 255, 85, 255],
        [4, 100, 100, 200, 128],
        [5, 200, 150, 100, 64],
      ]),
      objectFragment({
        bytes: [1, 2, 3, 4, 5, 0, 0],
        flags: 0xc0,
        width: 5,
        height: 1,
      }),
      segment(0x80, []),
    ],
    0
  )

  assert.equal(displaySet?.valid, true)

  const palette = displaySet?.segments.find(
    (candidate) => candidate.data[0] === 0x14
  )

  assert.ok(palette)
  assert.equal(palette.data[palette.data.byteLength - 5], 5)
  assert.equal(palette.data[palette.data.byteLength - 1], 64)

  const parser = await createPgsParser()

  try {
    assert.equal(parser.feed(createSupDisplaySetBytes(displaySet, 0)), 1)

    // FFmpeg's limited-range BT.601 yuv444p conversion is the independent
    // reference for these authored PGS colors. A two-channel-code tolerance
    // covers the 8-bit RGB -> full-range Y'CbCr -> libbitsub rounding.
    assertRgbClose(
      compositionRgba(parser, 0),
      [
        255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 53, 92, 243, 128, 249,
        207, 158, 64,
      ]
    )
  } finally {
    parser.free()
  }
})

void test("extracts a generated Matroska PGS track as ordered binary segments", async () => {
  const fixture = new Uint8Array(
    await readFile(
      new URL("../../tests/fixtures/pgs-acceptance.mkv", import.meta.url)
    )
  )

  const originalFetch = globalThis.fetch

  const rangeRequests: Array<{ start: number; end: number; returned: number }> =
    []

  const { signal } = new AbortController()

  globalThis.fetch = async (_input, init) => {
    const range = new Headers(init?.headers).get("range")
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "")

    if (match === null) {
      throw new Error("PGS fixture request did not use a byte range.")
    }

    const start = Number(match[1])
    const requestedEnd = Number(match[2])
    const end = Math.min(requestedEnd, fixture.byteLength - 1)
    const body = fixture.slice(start, end + 1)
    rangeRequests.push({ start, end, returned: body.byteLength })

    return new Response(body, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${fixture.byteLength}`,
        "Content-Length": String(body.byteLength),
      },
    })
  }

  try {
    const reader = createMatroskaSubtitleReader(
      "https://fixture.invalid/pgs-acceptance.mkv"
    )

    const tracks = await reader.probe(signal)
    const track = tracks.find((candidate) => candidate.codecId === "S_HDMV/PGS")

    assert.ok(track)
    assert.equal(track.trackNumber, 2)
    assert.equal(track.label, "Synthetic PGS")
    assert.equal(track.language, "eng")
    assert.equal(track.flags.default, true)
    const packets: MatroskaPgsPacket[] = []

    for await (const candidate of reader.streamPgsTrack(
      track.trackNumber,
      signal
    )) {
      packets.push(candidate)
    }

    assert.deepEqual(
      packets.map((candidate) => candidate.data[0]),
      [0x16, 0x17, 0x14, 0x15, 0x80, 0x16, 0x14, 0x80, 0x16, 0x80]
    )
    assert.deepEqual(
      packets.map((candidate) => candidate.startTime),
      [0, 0, 0, 0, 0, 2, 2, 2, 4, 4]
    )
    assert.equal(packets[0]?.duration, 1.5)
    assert.ok(
      packets.every(
        (candidate, index) =>
          index === 0 ||
          candidate.location.blockOffset >
            (packets[index - 1]?.location.blockOffset ?? -1)
      )
    )
    assert.ok(rangeRequests.length > 0)
    assert.ok(
      rangeRequests.every(
        (request) => request.returned <= request.end - request.start + 1
      )
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
