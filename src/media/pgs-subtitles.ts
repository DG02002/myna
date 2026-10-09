import type { MatroskaPgsPacket } from "./matroska-subtitles"

export const PGS_LIMITS = {
  maxPacketBytes: 65_550,
  maxDisplaySetBytes: 4 * 1024 * 1024,
  maxObjectBytes: 2 * 1024 * 1024,
  maxObjectPixelArea: 4 * 1024 * 1024,
  maxPresentationWidth: 4096,
  maxPresentationHeight: 2160,
  maxPresentationPixels: 4096 * 2160,
  maxRgbaBytes: 4096 * 2160 * 4,
  maxCompositions: 32,
  maxObjects: 64,
  maxPalettes: 8,
  maxWindows: 32,
  maxReplayBytes: 32 * 1024 * 1024,
  maxReplayDisplaySets: 10_000,
  maxPackets: 50_000,
  maxDisplaySets: 10_000,
  maxTimelineReferences: 20_000,
  maxTimestampSpan: 0xffff_ffff / 90_000,
  maxWasmBytes: 2 * 1024 * 1024,
  wasmInitTimeoutMs: 10_000,
  workerResponseTimeoutMs: 10_000,
} as const

const PALETTE_SEGMENT = 0x14

const OBJECT_SEGMENT = 0x15

const PRESENTATION_SEGMENT = 0x16

const WINDOW_SEGMENT = 0x17

const END_SEGMENT = 0x80

interface PgsWindow {
  x: number
  y: number
  width: number
  height: number
}

interface PgsObjectState {
  version: number
  width: number
  height: number
  expectedBytes: number
  receivedBytes: number
  complete: boolean
}

interface PgsCompositionObject {
  objectId: number
  x: number
  y: number
  window: PgsWindow
  crop: { x: number; y: number; width: number; height: number } | null
}

export interface PgsComposition {
  timestamp: number
  duration: number | null
  width: number
  height: number
  paletteId: number
  objects: PgsCompositionObject[]
  clear: boolean
}

export interface PgsDisplaySet {
  timestamp: number
  valid: boolean
  boundary: boolean
  hasComposition: boolean
  composition: PgsComposition | null
  segments: MatroskaPgsPacket[]
  decoderBytes: number
}

interface PgsPresentationReference {
  objectId: number
  windowId: number
  flags: number
  x: number
  y: number
  crop: { x: number; y: number; width: number; height: number } | null
}

interface PgsPresentationSegment {
  width: number
  height: number
  state: number
  paletteId: number
  references: PgsPresentationReference[]
  timestamp: number
  duration: number | null
}

interface PgsPaletteEntry {
  index: number
  luma: number
  cr: number
  cb: number
  alpha: number
}

interface PgsPaletteState {
  version: number
  entries: Map<number, PgsPaletteEntry>
}

interface PgsPaletteUpdate extends PgsPaletteState {
  id: number
  packetIndex: number
}

interface ParsedPgsPresentationReference {
  reference: PgsPresentationReference
  nextOffset: number
}

interface ResolvedPgsCompositionReference {
  reference: PgsCompositionObject
  pixels: number
}

interface PgsCompositionResult {
  composition: PgsComposition | null
  valid: boolean
}

interface PgsCompositeFrame {
  output: Uint8ClampedArray
  width: number
  height: number
}

interface PgsCompositeObjectState extends PgsCompositeFrame {
  composition: PgsRgbaComposition
  crop: NonNullable<PgsRgbaComposition["crop"]>
}

interface PgsCompositeRow {
  screenY: number
  clipLeft: number
  clipRight: number
}

interface PgsCompositePixel {
  sourceY: number
  screenX: number
  screenY: number
}

function clonePaletteState(palette: PgsPaletteState): PgsPaletteState {
  return {
    version: palette.version,
    entries: new Map(palette.entries),
  }
}

function clonePaletteMap(
  palettes: Map<number, PgsPaletteState>
): Map<number, PgsPaletteState> {
  const clone = new Map<number, PgsPaletteState>()

  for (const [id, palette] of palettes) {
    clone.set(id, clonePaletteState(palette))
  }

  return clone
}

function clampPaletteByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function normalizePaletteEntry(entry: PgsPaletteEntry): PgsPaletteEntry {
  // PGS palette values use limited-range BT.601 Y'CbCr. The pinned
  // libbitsub renderer treats them as full-range values, so convert through
  // RGB before encoding the expanded decoder palette. These luma/chroma
  // coefficients match FFmpeg's BT.601 limited-range conversion; the inverse
  // uses the full-range BT.601 matrix consumed by libbitsub.
  const luma = (entry.luma - 16) * (255 / 219)
  const cb = entry.cb - 128
  const cr = entry.cr - 128
  const red = clampPaletteByte(luma + (104597 / 65536) * cr)

  const green = clampPaletteByte(
    luma - (25675 / 65536) * cb - (53279 / 65536) * cr
  )

  const blue = clampPaletteByte(luma + (132201 / 65536) * cb)

  return {
    ...entry,
    luma: clampPaletteByte(0.299 * red + 0.587 * green + 0.114 * blue),
    cr: clampPaletteByte(0.5 * red - 0.418688 * green - 0.081312 * blue + 128),
    cb: clampPaletteByte(-0.168736 * red - 0.331264 * green + 0.5 * blue + 128),
  }
}

function encodePaletteSegment(
  id: number,
  palette: PgsPaletteState
): Uint8Array {
  const entries = [...palette.entries.values()].map(normalizePaletteEntry)

  const payload = [id, palette.version]

  for (const entry of entries) {
    payload.push(entry.index, entry.luma, entry.cr, entry.cb, entry.alpha)
  }

  return Uint8Array.from([
    PALETTE_SEGMENT,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff,
    ...payload,
  ])
}

function readUint16(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0)
}

function readUint24(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) << 16) |
    ((data[offset + 1] ?? 0) << 8) |
    (data[offset + 2] ?? 0)
  )
}

function isPgsSegmentType(type: number): boolean {
  return (
    type === PALETTE_SEGMENT ||
    type === OBJECT_SEGMENT ||
    type === PRESENTATION_SEGMENT ||
    type === WINDOW_SEGMENT ||
    type === END_SEGMENT
  )
}

function readPresentationReference(
  payload: Uint8Array,
  offset: number
): ParsedPgsPresentationReference {
  if (offset + 8 > payload.byteLength) {
    throw new Error("Invalid PGS composition object.")
  }

  const objectId = readUint16(payload, offset)
  const windowId = payload[offset + 2] ?? 0
  const flags = payload[offset + 3] ?? 0
  const x = readUint16(payload, offset + 4)
  const y = readUint16(payload, offset + 6)
  let nextOffset = offset + 8
  let crop: PgsPresentationReference["crop"] = null

  if ((flags & 0x3f) !== 0) {
    throw new Error("PGS composition object uses reserved flags.")
  }

  if ((flags & 0x80) !== 0) {
    if (nextOffset + 8 > payload.byteLength) {
      throw new Error("Invalid PGS object crop rectangle.")
    }

    crop = {
      x: readUint16(payload, nextOffset),
      y: readUint16(payload, nextOffset + 2),
      width: readUint16(payload, nextOffset + 4),
      height: readUint16(payload, nextOffset + 6),
    }
    nextOffset += 8

    if (crop.width === 0 || crop.height === 0) {
      throw new Error("PGS object crop rectangle is empty.")
    }
  }

  return {
    reference: { objectId, windowId, flags, x, y, crop },
    nextOffset,
  }
}

export function createPgsSupSegment(
  packet: MatroskaPgsPacket,
  baseTime: number
): Uint8Array {
  const { data, startTime } = packet
  const pts = Math.round((startTime - baseTime) * 90_000)

  if (
    data.byteLength < 3 ||
    data.byteLength > PGS_LIMITS.maxPacketBytes ||
    !Number.isSafeInteger(pts) ||
    pts < 0 ||
    pts > 0xffff_ffff ||
    !isPgsSegmentType(data[0] ?? -1) ||
    readUint16(data, 1) !== data.byteLength - 3
  ) {
    throw new Error("Invalid embedded PGS segment.")
  }

  const wrapped = new Uint8Array(data.byteLength + 10)
  const view = new DataView(wrapped.buffer)

  wrapped[0] = 0x50
  wrapped[1] = 0x47
  view.setUint32(2, pts, false)
  // Matroska stores only the presentation timestamp. libbitsub retains DTS
  // but does not use it for parsing or playback, so there is no DTS to copy.
  view.setUint32(6, 0, false)
  wrapped.set(data, 10)

  return wrapped
}

export class PgsDisplaySetInspector {
  private objects = new Map<number, PgsObjectState>()
  private palettes = new Map<number, PgsPaletteState>()
  private windows = new Map<number, PgsWindow>()
  private validState = false
  private pending: MatroskaPgsPacket[] = []
  private pendingBytes = 0
  private pendingTime: number | null = null
  private currentObjects = new Map<number, PgsObjectState>()
  private currentPalettes = new Map<number, PgsPaletteState>()
  private currentWindows = new Map<number, PgsWindow>()
  private pendingPaletteUpdates: PgsPaletteUpdate[] = []
  private presentation: PgsPresentationSegment | null = null
  private pendingInvalid = false
  private displaySetCount = 0

  push(packet: MatroskaPgsPacket): PgsDisplaySet | null {
    if (this.pending.length === 0) {
      this.beginDisplaySet(packet)
    }

    this.appendPendingPacket(packet)
    const parsed = this.parsePendingPacket(packet)

    if (parsed === null) {
      return null
    }

    return this.processSegment(parsed.type, parsed.payload, packet)
  }

  get count(): number {
    return this.displaySetCount
  }

  invalidateState(): void {
    this.markStateInvalid()
  }

  discardPending(): void {
    this.markStateInvalid()
    this.clearPending()
  }

  finish(): number | null {
    if (this.pending.length === 0) {
      return null
    }

    const timestamp = this.pendingTime
    this.markStateInvalid()
    this.clearPending()

    return timestamp
  }

  private beginDisplaySet(packet: MatroskaPgsPacket): void {
    this.pendingTime = packet.startTime
    this.currentObjects = new Map()
    this.currentPalettes = new Map()
    this.currentWindows = new Map()
    this.pendingPaletteUpdates = []
    this.presentation = null
    this.pendingInvalid = false
  }

  private appendPendingPacket(packet: MatroskaPgsPacket): void {
    if (
      packet.data.byteLength > PGS_LIMITS.maxPacketBytes ||
      this.pendingBytes > PGS_LIMITS.maxDisplaySetBytes - packet.data.byteLength
    ) {
      throw new Error("Embedded PGS display set exceeds its byte limit.")
    }

    this.pendingBytes += packet.data.byteLength
    this.pending.push(packet)
  }

  private parsePendingPacket(
    packet: MatroskaPgsPacket
  ): { type: number; payload: Uint8Array } | null {
    const { data } = packet
    const type = data[0] ?? -1
    const length = readUint16(data, 1)

    if (
      data.byteLength < 3 ||
      data.byteLength > PGS_LIMITS.maxPacketBytes ||
      !isPgsSegmentType(type) ||
      length !== data.byteLength - 3
    ) {
      this.pendingInvalid = true

      return null
    }

    return { type, payload: data.subarray(3) }
  }

  private processSegment(
    type: number,
    payload: Uint8Array,
    packet: MatroskaPgsPacket
  ): PgsDisplaySet | null {
    try {
      switch (type) {
        case PALETTE_SEGMENT:
          this.readPalette(payload)
          break
        case OBJECT_SEGMENT:
          this.readObject(payload)
          break
        case PRESENTATION_SEGMENT:
          this.readPresentationSegment(payload, packet)
          break
        case WINDOW_SEGMENT:
          this.readWindows(payload)
          break
        case END_SEGMENT:
          if (payload.byteLength !== 0) {
            this.pendingInvalid = true
          }

          return this.finishDisplaySet(packet.startTime)
      }
    } catch {
      this.pendingInvalid = true
    }

    return null
  }

  private readPresentationSegment(
    payload: Uint8Array,
    packet: MatroskaPgsPacket
  ): void {
    if (this.presentation !== null) {
      this.pendingInvalid = true

      return
    }

    this.presentation = this.readPresentation(payload, packet)
  }

  private readPalette(payload: Uint8Array): void {
    if (payload.byteLength < 2 || (payload.byteLength - 2) % 5 !== 0) {
      throw new Error("Invalid PGS palette segment.")
    }

    const id = payload[0] ?? 0
    const entries = new Map<number, PgsPaletteEntry>()

    for (let offset = 2; offset < payload.byteLength; offset += 5) {
      const entry = {
        index: payload[offset] ?? 0,
        luma: payload[offset + 1] ?? 0,
        cr: payload[offset + 2] ?? 0,
        cb: payload[offset + 3] ?? 0,
        alpha: payload[offset + 4] ?? 0,
      }

      entries.set(entry.index, entry)
    }

    this.pendingPaletteUpdates.push({
      id,
      packetIndex: this.pending.length - 1,
      version: payload[1] ?? 0,
      entries,
    })
  }

  private readObject(payload: Uint8Array): void {
    if (payload.byteLength < 4) {
      throw new Error("Invalid PGS object segment.")
    }

    const id = readUint16(payload, 0)
    const version = payload[2] ?? 0
    const flags = payload[3] ?? 0
    const startsObject = (flags & 0x80) !== 0
    const endsObject = (flags & 0x40) !== 0

    if ((flags & 0x3f) !== 0) {
      throw new Error("PGS object segment uses reserved flags.")
    }

    const object = startsObject
      ? this.readFirstObjectFragment(payload, id, version)
      : this.readContinuationObjectFragment(id, version)

    const dataOffset = startsObject ? 11 : 4

    if (object.version !== version || object.complete) {
      throw new Error("PGS object fragment has no matching first fragment.")
    }

    this.appendObjectFragment(
      object,
      payload.byteLength - dataOffset,
      endsObject
    )
  }

  private readFirstObjectFragment(
    payload: Uint8Array,
    id: number,
    version: number
  ): PgsObjectState {
    if (payload.byteLength < 11) {
      throw new Error("Invalid first PGS object fragment.")
    }

    const declaredLength = readUint24(payload, 4)
    const width = readUint16(payload, 7)
    const height = readUint16(payload, 9)
    const expectedBytes = declaredLength - 4

    if (
      declaredLength < 5 ||
      expectedBytes > PGS_LIMITS.maxObjectBytes ||
      width === 0 ||
      height === 0 ||
      width * height > PGS_LIMITS.maxObjectPixelArea
    ) {
      throw new Error("Embedded PGS object exceeds its size limit.")
    }

    const object: PgsObjectState = {
      version,
      width,
      height,
      expectedBytes,
      receivedBytes: 0,
      complete: false,
    }

    this.objects.set(id, object)
    this.currentObjects.set(id, object)

    if (
      this.currentObjects.size > PGS_LIMITS.maxObjects ||
      this.objects.size > PGS_LIMITS.maxObjects * 2
    ) {
      throw new Error("Embedded PGS object state exceeds its limit.")
    }

    return object
  }

  private readContinuationObjectFragment(
    id: number,
    version: number
  ): PgsObjectState {
    const object = this.objects.get(id)

    if (object === undefined || object.version !== version || object.complete) {
      throw new Error("PGS object fragment has no matching first fragment.")
    }

    return object
  }

  private appendObjectFragment(
    object: PgsObjectState,
    fragmentBytes: number,
    endsObject: boolean
  ): void {
    object.receivedBytes += fragmentBytes

    if (
      fragmentBytes <= 0 ||
      object.receivedBytes > object.expectedBytes ||
      object.receivedBytes > PGS_LIMITS.maxObjectBytes
    ) {
      throw new Error("PGS object fragment exceeds its declared size.")
    }

    if (endsObject && object.receivedBytes !== object.expectedBytes) {
      throw new Error("PGS object fragments are incomplete.")
    }

    if (!endsObject && object.receivedBytes === object.expectedBytes) {
      throw new Error("PGS object is missing its final-fragment flag.")
    }

    object.complete = endsObject
  }

  private readPresentation(
    payload: Uint8Array,
    packet: MatroskaPgsPacket
  ): PgsPresentationSegment {
    if (payload.byteLength < 11) {
      throw new Error("Invalid PGS presentation segment.")
    }

    const width = readUint16(payload, 0)
    const height = readUint16(payload, 2)
    const state = (payload[7] ?? 0) & 0xc0
    const paletteId = payload[9] ?? 0
    const objectCount = payload[10] ?? 0
    const pixels = width * height
    let offset = 11
    const references: PgsPresentationReference[] = []

    if (
      width === 0 ||
      height === 0 ||
      width > PGS_LIMITS.maxPresentationWidth ||
      height > PGS_LIMITS.maxPresentationHeight ||
      pixels > PGS_LIMITS.maxPresentationPixels ||
      objectCount > PGS_LIMITS.maxCompositions ||
      (state !== 0 && state !== 0x40 && state !== 0x80)
    ) {
      throw new Error("Embedded PGS presentation exceeds its size limit.")
    }

    for (let index = 0; index < objectCount; index += 1) {
      const { reference, nextOffset } = readPresentationReference(
        payload,
        offset
      )

      references.push(reference)
      offset = nextOffset
    }

    if (offset !== payload.byteLength) {
      throw new Error("PGS presentation segment has trailing bytes.")
    }

    return {
      width,
      height,
      state,
      paletteId,
      references,
      timestamp: packet.startTime,
      duration: packet.duration,
    }
  }

  private readWindows(payload: Uint8Array): void {
    if (payload.byteLength < 1) {
      throw new Error("Invalid PGS window segment.")
    }

    const count = payload[0] ?? 0

    if (payload.byteLength !== 1 + count * 9) {
      throw new Error("Invalid PGS window segment length.")
    }

    for (let index = 0, offset = 1; index < count; index += 1, offset += 9) {
      const id = payload[offset] ?? 0

      const window = {
        x: readUint16(payload, offset + 1),
        y: readUint16(payload, offset + 3),
        width: readUint16(payload, offset + 5),
        height: readUint16(payload, offset + 7),
      }

      if (window.width === 0 || window.height === 0) {
        throw new Error("PGS window is empty.")
      }

      this.windows.set(id, window)
      this.currentWindows.set(id, window)
    }

    if (
      this.currentWindows.size > PGS_LIMITS.maxWindows ||
      this.windows.size > PGS_LIMITS.maxWindows * 2
    ) {
      throw new Error("Embedded PGS window state exceeds its limit.")
    }
  }

  private finishDisplaySet(timestamp: number): PgsDisplaySet {
    this.displaySetCount += 1

    if (this.displaySetCount > PGS_LIMITS.maxDisplaySets) {
      throw new Error("Embedded PGS display-set count exceeds its limit.")
    }

    const { presentation } = this

    const boundary =
      presentation !== null &&
      (presentation.state === 0x40 || presentation.state === 0x80)

    const palettes = this.expandPendingPalettes(boundary)

    const { composition, valid } = this.validateDisplaySet(
      presentation,
      palettes,
      boundary
    )

    const segments = this.pending

    const result: PgsDisplaySet = {
      timestamp: presentation?.timestamp ?? this.pendingTime ?? timestamp,
      valid,
      boundary,
      hasComposition: presentation !== null,
      composition,
      segments,
      decoderBytes: segments.reduce(
        (total, segment) => total + segment.data.byteLength + 10,
        0
      ),
    }

    this.clearPending()

    return result
  }

  private validateDisplaySet(
    presentation: PgsPresentationSegment | null,
    palettes: Map<number, PgsPaletteState>,
    boundary: boolean
  ) {
    if (boundary) {
      this.commitBoundaryState()
    }

    let valid = !this.pendingInvalid

    valid &&= this.hasCompleteCurrentObjects()
    valid &&= this.hasBoundedCommittedState(boundary)

    const compositionResult =
      presentation === null
        ? { composition: null, valid: !this.pendingInvalid }
        : this.createComposition(presentation, palettes)

    valid &&= compositionResult.valid

    if (!valid) {
      this.validState = false
      this.markStateInvalid()
    } else if (!boundary) {
      this.palettes = palettes
    }

    valid &&= this.validState

    return {
      composition: valid ? compositionResult.composition : null,
      valid,
    }
  }

  private expandPendingPalettes(
    boundary: boolean
  ): Map<number, PgsPaletteState> {
    // PGS palette segments may update only the changed entries, while the
    // pinned decoder treats each PDS as a complete replacement palette.
    const palettes = clonePaletteMap(boundary ? new Map() : this.palettes)

    for (const update of this.pendingPaletteUpdates) {
      const previousPalette = palettes.get(update.id)
      const entries = new Map(previousPalette?.entries)

      for (const entry of update.entries.values()) {
        entries.set(entry.index, entry)
      }

      const palette = {
        version: update.version,
        entries,
      }

      palettes.set(update.id, palette)

      const packet = this.pending[update.packetIndex]

      if (packet !== undefined) {
        this.pending[update.packetIndex] = {
          ...packet,
          data: encodePaletteSegment(update.id, palette),
        }
      }
    }

    if (
      palettes.size > PGS_LIMITS.maxPalettes * 2 ||
      (boundary && palettes.size > PGS_LIMITS.maxPalettes)
    ) {
      throw new Error("Embedded PGS palette state exceeds its limit.")
    }

    this.pendingBytes = this.pending.reduce(
      (total, packet) => total + packet.data.byteLength,
      0
    )

    if (this.pendingBytes > PGS_LIMITS.maxDisplaySetBytes) {
      throw new Error("Embedded PGS display set exceeds its byte limit.")
    }

    this.currentPalettes = palettes

    return palettes
  }

  private commitBoundaryState(): void {
    this.objects = new Map(this.currentObjects)
    this.palettes = clonePaletteMap(this.currentPalettes)
    this.windows = new Map(this.currentWindows)
    this.validState = true
  }

  private hasCompleteCurrentObjects(): boolean {
    return ![...this.currentObjects.values()].some((object) => !object.complete)
  }

  private hasBoundedCommittedState(boundary: boolean): boolean {
    return (
      boundary ||
      (this.objects.size <= PGS_LIMITS.maxObjects &&
        this.palettes.size <= PGS_LIMITS.maxPalettes &&
        this.windows.size <= PGS_LIMITS.maxWindows)
    )
  }

  private createComposition(
    presentation: PgsPresentationSegment,
    palettes = this.palettes
  ): PgsCompositionResult {
    const references: PgsCompositionObject[] = []
    let decodedPixelCount = 0

    if (
      presentation.references.length > 0 &&
      !palettes.has(presentation.paletteId)
    ) {
      return { composition: null, valid: false }
    }

    for (const reference of presentation.references) {
      const resolved = this.resolveCompositionReference(reference)

      if (resolved === null) {
        return { composition: null, valid: false }
      }

      decodedPixelCount += resolved.pixels

      if (
        decodedPixelCount > PGS_LIMITS.maxPresentationPixels ||
        decodedPixelCount * 4 > PGS_LIMITS.maxRgbaBytes
      ) {
        return { composition: null, valid: false }
      }

      references.push(resolved.reference)
    }

    if (!this.validState) {
      return { composition: null, valid: false }
    }

    return {
      composition: {
        timestamp: presentation.timestamp,
        duration: presentation.duration,
        width: presentation.width,
        height: presentation.height,
        paletteId: presentation.paletteId,
        objects: references,
        clear: presentation.references.length === 0,
      },
      valid: true,
    }
  }

  private resolveCompositionReference(
    reference: PgsPresentationReference
  ): ResolvedPgsCompositionReference | null {
    const object = this.objects.get(reference.objectId)
    const window = this.windows.get(reference.windowId)

    if (object === undefined || !object.complete || window === undefined) {
      return null
    }

    const pixels = object.width * object.height

    if (
      reference.crop !== null &&
      (reference.crop.x + reference.crop.width > object.width ||
        reference.crop.y + reference.crop.height > object.height)
    ) {
      return null
    }

    return {
      reference: {
        objectId: reference.objectId,
        x: reference.x,
        y: reference.y,
        window,
        crop: reference.crop,
      },
      pixels,
    }
  }

  private markStateInvalid(): void {
    this.validState = false
  }

  private clearPending(): void {
    this.pending = []
    this.pendingBytes = 0
    this.pendingTime = null
    this.currentObjects = new Map()
    this.currentPalettes = new Map()
    this.currentWindows = new Map()
    this.pendingPaletteUpdates = []
    this.presentation = null
    this.pendingInvalid = false
  }
}

export interface PgsRgbaComposition {
  x: number
  y: number
  width: number
  height: number
  rgba: Uint8Array
  crop: { x: number; y: number; width: number; height: number } | null
  window: { x: number; y: number; width: number; height: number }
}

export function compositePgsFrame(
  width: number,
  height: number,
  compositions: PgsRgbaComposition[]
): Uint8ClampedArray {
  validateFrameSize(width, height, compositions.length)
  const output = new Uint8ClampedArray(width * height * 4)
  const frame = { output, width, height }
  let compositionPixelCount = 0

  for (const composition of compositions) {
    const crop = getValidatedCrop(composition)
    compositionPixelCount += crop.width * crop.height

    if (compositionPixelCount > PGS_LIMITS.maxPresentationPixels) {
      throw new Error("Embedded PGS RGBA output exceeds its byte limit.")
    }

    compositeObject(frame, composition, crop)
  }

  return output
}

function validateFrameSize(
  width: number,
  height: number,
  compositionCount: number
): void {
  const pixelCount = width * height

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > PGS_LIMITS.maxPresentationWidth ||
    height > PGS_LIMITS.maxPresentationHeight ||
    pixelCount > PGS_LIMITS.maxPresentationPixels ||
    compositionCount > PGS_LIMITS.maxCompositions
  ) {
    throw new Error("Embedded PGS frame exceeds its render limit.")
  }
}

function getValidatedCrop(
  composition: PgsRgbaComposition
): NonNullable<PgsRgbaComposition["crop"]> {
  if (
    composition.width <= 0 ||
    composition.height <= 0 ||
    composition.width * composition.height > PGS_LIMITS.maxObjectPixelArea ||
    composition.rgba.byteLength !== composition.width * composition.height * 4
  ) {
    throw new Error("Embedded PGS object exceeds its render limit.")
  }

  const crop = composition.crop ?? {
    x: 0,
    y: 0,
    width: composition.width,
    height: composition.height,
  }

  if (
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.x + crop.width > composition.width ||
    crop.y + crop.height > composition.height
  ) {
    throw new Error("Embedded PGS crop rectangle is invalid.")
  }

  return crop
}

function compositeObject(
  frame: PgsCompositeFrame,
  composition: PgsRgbaComposition,
  crop: NonNullable<PgsRgbaComposition["crop"]>
): void {
  const state: PgsCompositeObjectState = { ...frame, composition, crop }
  const { x: drawX, y: drawY } = composition
  const clipLeft = Math.max(0, composition.window.x, drawX)
  const clipTop = Math.max(0, composition.window.y, drawY)

  const clipRight = Math.min(
    frame.width,
    composition.window.x + composition.window.width,
    drawX + crop.width
  )

  const clipBottom = Math.min(
    frame.height,
    composition.window.y + composition.window.height,
    drawY + crop.height
  )

  for (let screenY = clipTop; screenY < clipBottom; screenY += 1) {
    compositeRow(state, { screenY, clipLeft, clipRight })
  }
}

function compositeRow(
  state: PgsCompositeObjectState,
  row: PgsCompositeRow
): void {
  const { composition, crop } = state
  const sourceY = crop.y + row.screenY - composition.y

  for (let screenX = row.clipLeft; screenX < row.clipRight; screenX += 1) {
    compositePixel(state, { sourceY, screenX, screenY: row.screenY })
  }
}

function compositePixel(
  state: PgsCompositeObjectState,
  pixel: PgsCompositePixel
): void {
  const { composition, crop, output, width } = state
  const { sourceY, screenX, screenY } = pixel
  const sourceX = crop.x + screenX - composition.x
  const sourceOffset = (sourceY * composition.width + sourceX) * 4
  const targetOffset = (screenY * width + screenX) * 4
  const sourceAlpha = (composition.rgba[sourceOffset + 3] ?? 0) / 255

  if (sourceAlpha === 0) {
    return
  }

  const targetAlpha = (output[targetOffset + 3] ?? 0) / 255
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha)
  const targetWeight = targetAlpha * (1 - sourceAlpha)

  for (let channel = 0; channel < 3; channel += 1) {
    const sourceChannel = composition.rgba[sourceOffset + channel] ?? 0
    const targetChannel = output[targetOffset + channel] ?? 0
    output[targetOffset + channel] = Math.round(
      (sourceChannel * sourceAlpha + targetChannel * targetWeight) / outputAlpha
    )
  }

  output[targetOffset + 3] = Math.round(outputAlpha * 255)
}
