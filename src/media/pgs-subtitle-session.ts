import {
  MatroskaSubtitleError,
  type MatroskaPgsPacket,
  type MatroskaPgsWindowEvent,
} from "./matroska-subtitles"
import { PGS_LIMITS } from "./pgs-subtitles"

export type PgsSubtitleFrame =
  | { kind: "frame"; bitmap: ImageBitmap; width: number; height: number }
  | { kind: "clear" }
  | { kind: "failed" }
  | { kind: "hold" }
  | { kind: "unavailable" }

type WorkerRequest =
  | { type: "init"; generation: number }
  | { type: "reset-window"; generation: number; sequence: number }
  | {
      type: "packet"
      generation: number
      sequence: number
      packet: MatroskaPgsPacket
    }
  | {
      type: "finish"
      generation: number
      sequence: number
      coverageTime: number | null
      complete: boolean
    }
  | {
      type: "time"
      generation: number
      sequence: number
      time: number
      redraw: boolean
    }
  | { type: "release-frame"; generation: number; sequence: number }

type WorkerResponse =
  | { type: "ready"; generation: number }
  | { type: "window-ready"; generation: number; sequence: number }
  | { type: "ack"; generation: number; sequence: number }
  | {
      type: "frame"
      generation: number
      sequence: number
      requestSequence: number
      bitmap: ImageBitmap
      width: number
      height: number
    }
  | {
      type: "clear" | "hold" | "unavailable" | "failed"
      generation: number
      sequence: number
      requestSequence: number
    }
  | { type: "limit"; generation: number; sequence: number }

interface PendingPacket {
  sequence: number
  resolve: () => void
  reject: (error: Error) => void
}

interface PendingWindowReset {
  sequence: number
  resolve: () => void
  reject: (error: Error) => void
}

interface PgsSubtitleWindow {
  requestTime: number
  boundaryTime: number
  coverageTime: number
  packets: MatroskaPgsPacket[]
}

interface PgsWindowReadState {
  boundaryTime: number | null
  coverageTime: number | null
  packetBytes: number
  packets: MatroskaPgsPacket[]
}

type PgsWindowLoader = (
  targetTime: number,
  signal: AbortSignal
) => AsyncIterable<MatroskaPgsWindowEvent>

export type PgsSubtitleWindowStatus =
  | "loading"
  | "ready"
  | "incomplete"
  | "failed"

const MAX_PGS_WINDOW_PACKETS = 50_000

const MAX_PGS_WINDOW_BYTES = 32 * 1024 * 1024

// A window load on a latency-bound origin can take most of the window
// deadline, so the next window must start loading as soon as playback is
// inside the current one instead of near its coverage edge.
const PGS_WINDOW_PREFETCH_LEAD_SECONDS = 30

const MAX_PGS_WINDOW_FORWARD_SECONDS = 120

const MAX_PGS_WINDOW_ATTEMPTS_PER_FAILURE = 3

const PGS_WINDOW_RETRY_BASE_MS = 1_000

function postToWorker(
  worker: Worker,
  message: WorkerRequest,
  transfer: Transferable[] = []
): void {
  worker.postMessage(message, transfer)
}

export class PgsSubtitleSession {
  private readonly generation =
    crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
  private readonly worker: Worker
  private readonly listeners = new Set<(frame: PgsSubtitleFrame) => void>()
  private readonly windowStatusListeners = new Set<
    (status: PgsSubtitleWindowStatus) => void
  >()
  private sequence = 0
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private readonly ready: Promise<void>
  private pendingPacket: PendingPacket | null = null
  private pendingWindowReset: PendingWindowReset | null = null
  private windowResetPromise: Promise<void> | null = null
  private disposed = false
  private renderOutstanding = false
  private latestTime: number | null = null
  private latestTimeRequest: { time: number; sequence: number } | null = null
  private pendingTime: { time: number; sequence: number } | null = null
  private redrawNextTime = false
  private failedValue = false
  private renderWatchdog: ReturnType<typeof setTimeout> | null = null
  private staleBeforeRequestSequence = 0
  private windowLoader: PgsWindowLoader | null = null
  private latestWindowFailureValue: MatroskaSubtitleError | null = null
  private currentWindow: { start: number; end: number } | null = null
  private activeWindowController: AbortController | null = null
  private activeWindowTarget: number | null = null
  private prefetchController: AbortController | null = null
  private prefetchedWindow: PgsSubtitleWindow | null = null
  private attemptedPrefetchTarget: number | null = null
  private failedWindowAttempts = 0
  private nextWindowRetryAt = 0
  private windowRetryExhausted = false
  private windowSequence = 0
  private applyingWindow = false
  private windowStatus: PgsSubtitleWindowStatus = "loading"

  constructor(private readonly now: () => number = () => performance.now()) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // Keep disposal before the first push from creating an unhandled rejection.
    void this.ready.catch(() => undefined)
    this.worker = new Worker(
      new URL("./pgs-subtitle-worker.ts", import.meta.url),
      {
        type: "module",
      }
    )
    this.worker.addEventListener("message", this.onMessage)
    this.worker.addEventListener("error", this.onWorkerError)
    postToWorker(this.worker, { type: "init", generation: this.generation })
  }

  subscribe(listener: (frame: PgsSubtitleFrame) => void): () => void {
    const needsInitialFrame = this.listeners.size === 0
    this.listeners.add(listener)

    if (needsInitialFrame && !this.disposed) {
      // A remounted canvas has no pixels even when the worker's visual key is unchanged.
      this.redrawNextTime = true

      if (this.latestTime !== null) {
        this.requestTime(this.latestTime)
      }
    }

    return () => this.listeners.delete(listener)
  }

  subscribeWindowStatus(
    listener: (status: PgsSubtitleWindowStatus) => void
  ): () => void {
    this.windowStatusListeners.add(listener)
    listener(this.windowStatus)

    return () => this.windowStatusListeners.delete(listener)
  }

  get failed(): boolean {
    return this.failedValue
  }

  get latestWindowFailure(): MatroskaSubtitleError | null {
    return this.latestWindowFailureValue
  }

  setWindowLoader(loader: PgsWindowLoader): void {
    this.windowLoader = loader
  }

  retryWindow(): boolean {
    if (
      this.latestTime === null ||
      this.windowLoader === null ||
      this.disposed ||
      this.failedValue
    ) {
      return false
    }

    if (
      !this.upstreamAllowsWindowRequest() ||
      this.activeWindowController !== null
    ) {
      return false
    }

    if (
      this.currentWindow !== null &&
      this.latestTime >= this.currentWindow.start &&
      this.latestTime <= this.currentWindow.end
    ) {
      if (this.prefetchController !== null || this.prefetchedWindow !== null) {
        return false
      }

      this.resetWindowRetryState()
      this.attemptedPrefetchTarget = null
      const accepted = this.startWindowPrefetch(this.currentWindow.end)

      if (accepted) {
        this.setWindowStatus("loading")
      }

      return accepted
    }

    this.resetWindowRetryState()
    const accepted = this.startWindowLoad(this.latestTime)

    if (accepted) {
      this.setWindowStatus("loading")
    }

    return accepted
  }

  private resetWindowRetryState(): void {
    this.failedWindowAttempts = 0
    this.nextWindowRetryAt = 0
    this.windowRetryExhausted = false
  }

  invalidatePendingRender(): void {
    this.staleBeforeRequestSequence = this.sequence + 1
    this.redrawNextTime = true
  }

  async push(packet: MatroskaPgsPacket): Promise<void> {
    await this.waitForWorkerResponse(this.ready)

    if (this.disposed) {
      throw new Error("Embedded PGS session was canceled.")
    }

    if (this.pendingPacket !== null) {
      throw new Error("Embedded PGS input exceeded its backpressure limit.")
    }

    const sequence = ++this.sequence
    const data = packet.data.slice()

    await this.waitForWorkerResponse(
      new Promise<void>((resolve, reject) => {
        this.pendingPacket = { sequence, resolve, reject }
        postToWorker(
          this.worker,
          {
            type: "packet",
            generation: this.generation,
            sequence,
            packet: { ...packet, data },
          },
          [data.buffer]
        )
      })
    )

    if (this.latestTime !== null && !this.applyingWindow) {
      this.requestTime(this.latestTime)
    }
  }

  async finish(coverageTime: number | null, complete: boolean): Promise<void> {
    await this.waitForWorkerResponse(this.ready)

    if (this.disposed) {
      return
    }

    postToWorker(this.worker, {
      type: "finish",
      generation: this.generation,
      sequence: ++this.sequence,
      coverageTime,
      complete,
    })

    if (this.latestTime !== null && !this.applyingWindow) {
      this.requestTime(this.latestTime)
    }
  }

  requestTime(time: number): void {
    if (!Number.isFinite(time) || this.disposed || this.failedValue) {
      return
    }

    const request = { time, sequence: ++this.sequence }
    this.latestTime = time
    this.latestTimeRequest = request

    if (this.windowLoader !== null) {
      if (
        this.currentWindow !== null &&
        time >= this.currentWindow.start &&
        time <= this.currentWindow.end
      ) {
        if (
          this.currentWindow.end - time <= PGS_WINDOW_PREFETCH_LEAD_SECONDS &&
          this.currentWindow.end > time + 0.5
        ) {
          this.startWindowPrefetch(this.currentWindow.end)
        }
      } else {
        this.ensureWindowForTime(time)

        return
      }
    }

    if (this.readyResolve !== null) {
      return
    }

    if (this.renderOutstanding) {
      this.pendingTime = request

      return
    }

    this.sendTime(request)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.cancelWindowReads()
    this.rejectPendingWorkerWork()
    this.clearSessionState()
    this.worker.removeEventListener("message", this.onMessage)
    this.worker.removeEventListener("error", this.onWorkerError)
    this.worker.terminate()
  }

  private cancelWindowReads(): void {
    this.activeWindowController?.abort()
    this.activeWindowController = null
    this.prefetchController?.abort()
    this.prefetchController = null
    this.prefetchedWindow = null
  }

  private rejectPendingWorkerWork(): void {
    const error = new Error("Embedded PGS session was canceled.")
    this.readyReject?.(error)
    this.readyResolve = null
    this.readyReject = null
    this.pendingPacket?.reject(error)
    this.pendingPacket = null
    this.pendingWindowReset?.reject(error)
    this.pendingWindowReset = null
  }

  private clearSessionState(): void {
    this.pendingTime = null
    this.latestTimeRequest = null
    this.clearRenderWatchdog()
    this.listeners.clear()
  }

  private onMessage = (event: MessageEvent<WorkerResponse>): void => {
    const message = event.data

    if (message.generation !== this.generation || this.disposed) {
      this.releaseStaleFrame(message)

      return
    }

    switch (message.type) {
      case "ready":
        this.handleReady()

        return
      case "ack":
        this.handleAck(message.sequence)

        return
      case "window-ready":
        this.handleWindowReady(message.sequence)

        return
      case "limit":
        this.handleLimit(message.sequence)

        return
      case "failed":
        this.handleFailure()
        this.handleRenderedMessage(message)

        return
      case "frame":
      case "clear":
      case "hold":
      case "unavailable":
        this.handleRenderedMessage(message)

        return
    }
  }

  private releaseStaleFrame(message: WorkerResponse): void {
    if (message.type === "frame") {
      message.bitmap.close()
    }
  }

  private handleReady(): void {
    this.readyResolve?.()
    this.readyResolve = null
    this.readyReject = null

    if (this.latestTimeRequest !== null && !this.renderOutstanding) {
      this.sendTime(this.latestTimeRequest)
    }
  }

  private handleAck(sequence: number): void {
    if (this.pendingPacket?.sequence === sequence) {
      this.pendingPacket.resolve()
      this.pendingPacket = null
    }
  }

  private handleWindowReady(sequence: number): void {
    if (this.pendingWindowReset?.sequence === sequence) {
      this.pendingWindowReset.resolve()
      this.pendingWindowReset = null
    }
  }

  private handleLimit(sequence: number): void {
    if (this.pendingPacket?.sequence === sequence) {
      this.pendingPacket.reject(
        new Error("Embedded PGS track reached a resource limit.")
      )
      this.pendingPacket = null
    }
  }

  private handleFailure(): void {
    this.failedValue = true
    this.latestWindowFailureValue = null
    this.setWindowStatus("failed")
    const error = new Error("Embedded PGS decoder failed.")
    this.readyReject?.(error)
    this.readyReject = null
    this.readyResolve = null
    this.pendingPacket?.reject(error)
    this.pendingPacket = null
    this.pendingWindowReset?.reject(error)
    this.pendingWindowReset = null
  }

  private handleRenderedMessage(
    message: Extract<
      WorkerResponse,
      { type: "frame" | "clear" | "hold" | "unavailable" | "failed" }
    >
  ): void {
    const stale =
      message.type !== "failed" &&
      message.requestSequence < this.staleBeforeRequestSequence

    this.clearRenderWatchdog()

    const frame: PgsSubtitleFrame =
      message.type === "frame"
        ? {
            kind: "frame",
            bitmap: message.bitmap,
            width: message.width,
            height: message.height,
          }
        : { kind: message.type }

    // In window mode the worker reports "unavailable" whenever the render
    // time is past the active window's coverage — including the moments
    // before the first window lands and while the next one is loading on a
    // slow origin. That state is transient by construction: requestTime
    // keeps starting window loads for such times, and a load that genuinely
    // fails reports its own unavailable. Report a clear so the canvas
    // empties without marking the track incomplete.
    const transientCoverageGap =
      message.type === "unavailable" && this.isBeyondWindowCoverage()

    if (!stale && message.type !== "hold") {
      this.notifyListeners(transientCoverageGap ? { kind: "clear" } : frame)
    }

    if (message.type === "frame") {
      message.bitmap.close()
    }

    postToWorker(this.worker, {
      type: "release-frame",
      generation: this.generation,
      sequence: message.sequence,
    })
    this.renderOutstanding = false

    const latestTime = this.pendingTime
    this.pendingTime = null

    if (latestTime !== null) {
      this.sendTime(latestTime)
    }
  }

  private notifyListeners(frame: PgsSubtitleFrame): void {
    for (const listener of this.listeners) {
      try {
        listener(frame)
      } catch {
        // The listener owns only the synchronous draw; every transferred bitmap
        // is closed below even if its canvas has been removed during a render.
      }
    }
  }

  private onWorkerError = (): void => {
    this.failWorker(new Error("Embedded PGS decoder worker failed."))
  }

  private sendTime(request: { time: number; sequence: number }): void {
    this.renderOutstanding = true
    this.armRenderWatchdog()
    const redraw = this.redrawNextTime
    this.redrawNextTime = false
    postToWorker(this.worker, {
      type: "time",
      generation: this.generation,
      sequence: request.sequence,
      time: request.time,
      redraw,
    })
  }

  private ensureWindowForTime(time: number): void {
    if (this.windowLoader === null || this.disposed || this.failedValue) {
      return
    }

    if (this.activatePrefetchedWindow(time)) {
      return
    }

    if (this.hasWindowRequestFor(time) || !this.canRetryWindow()) {
      return
    }

    this.startWindowLoad(time)
  }

  private activatePrefetchedWindow(time: number): boolean {
    const window = this.prefetchedWindow

    if (
      window === null ||
      time < Math.min(window.boundaryTime, window.requestTime) ||
      time > window.coverageTime
    ) {
      return false
    }

    this.activeWindowController?.abort()
    this.activeWindowController = null
    this.prefetchController?.abort()
    this.prefetchController = null
    this.prefetchedWindow = null
    this.attemptedPrefetchTarget = null
    this.beginWindowActivation(window, time)

    return true
  }

  private hasWindowRequestFor(time: number): boolean {
    return (
      this.activeWindowController !== null &&
      this.activeWindowTarget !== null &&
      time >= this.activeWindowTarget &&
      time <= this.activeWindowTarget + MAX_PGS_WINDOW_FORWARD_SECONDS
    )
  }

  private isBeyondWindowCoverage(): boolean {
    if (this.windowLoader === null || this.failedValue) {
      return false
    }

    const time = this.latestTime

    // Before the first window activates there is no coverage yet; the first
    // load is in flight and reports its own failure if it cannot land.
    return (
      time !== null &&
      (this.currentWindow === null || time > this.currentWindow.end)
    )
  }

  private canRetryWindow(): boolean {
    return !this.windowRetryExhausted && this.upstreamAllowsWindowRequest()
  }

  private upstreamAllowsWindowRequest(): boolean {
    return this.now() >= this.nextWindowRetryAt
  }

  private recordWindowFailure(error: MatroskaSubtitleError | null): void {
    this.latestWindowFailureValue = error
    this.failedWindowAttempts += 1

    const retryable =
      error !== null &&
      (error.kind === "unreachable" ||
        error.kind === "timeout" ||
        error.kind === "deadline" ||
        (error.kind === "http" &&
          (error.status === 408 ||
            error.status === 425 ||
            error.status === 429 ||
            (error.status !== null && error.status >= 500))))

    if (!retryable) {
      this.windowRetryExhausted = true
      this.setWindowStatus(
        this.currentWindow === null ? "failed" : "incomplete"
      )

      return
    }

    const backoffMs =
      PGS_WINDOW_RETRY_BASE_MS * 2 ** (this.failedWindowAttempts - 1)

    const { retryAfterMs } = error

    this.nextWindowRetryAt = this.now() + Math.max(backoffMs, retryAfterMs ?? 0)

    if (this.failedWindowAttempts >= MAX_PGS_WINDOW_ATTEMPTS_PER_FAILURE) {
      this.windowRetryExhausted = true
      this.setWindowStatus(
        this.currentWindow === null ? "failed" : "incomplete"
      )
    } else {
      this.setWindowStatus(
        this.currentWindow === null ? "loading" : "incomplete"
      )
    }
  }

  private beginWindowActivation(window: PgsSubtitleWindow, time: number): void {
    const controller = new AbortController()
    const sequence = ++this.windowSequence
    this.activeWindowController = controller
    this.activeWindowTarget = time

    void this.activateWindow(window, controller.signal, sequence).finally(
      () => {
        this.clearActiveWindow(controller)
      }
    )
  }

  private startWindowLoad(time: number): boolean {
    const loader = this.windowLoader

    if (
      loader === null ||
      this.disposed ||
      this.failedValue ||
      !this.canRetryWindow() ||
      this.hasWindowRequestFor(time)
    ) {
      return false
    }

    this.cancelCurrentWindowLoad()

    const controller = new AbortController()
    const sequence = ++this.windowSequence
    this.activeWindowController = controller
    this.activeWindowTarget = time

    if (this.currentWindow === null) {
      this.setWindowStatus("loading")
    }

    this.notifyListeners({ kind: "clear" })

    void this.readWindow(loader, time, controller.signal)
      .then(async (window) => {
        if (
          controller.signal.aborted ||
          this.disposed ||
          sequence !== this.windowSequence
        ) {
          return
        }

        await this.activateWindow(window, controller.signal, sequence)
      })
      .catch((error) => {
        if (controller.signal.aborted || this.disposed) {
          return
        }

        this.activeWindowController = null
        this.activeWindowTarget = null
        this.recordWindowFailure(
          error instanceof MatroskaSubtitleError ? error : null
        )
        this.notifyListeners({ kind: "unavailable" })
      })
      .finally(() => this.clearActiveWindow(controller))

    return true
  }

  private cancelCurrentWindowLoad(): void {
    this.activeWindowController?.abort()
    this.activeWindowController = null
    this.activeWindowTarget = null
    this.prefetchController?.abort()
    this.prefetchController = null
    this.prefetchedWindow = null
  }

  private clearActiveWindow(controller: AbortController): void {
    if (this.activeWindowController === controller) {
      this.activeWindowController = null
      this.activeWindowTarget = null
    }
  }

  private startWindowPrefetch(targetTime: number): boolean {
    if (
      this.windowLoader === null ||
      this.disposed ||
      this.failedValue ||
      !this.canRetryWindow() ||
      this.prefetchController !== null ||
      this.prefetchedWindow !== null ||
      this.attemptedPrefetchTarget === targetTime
    ) {
      return false
    }

    const controller = new AbortController()
    const loader = this.windowLoader
    this.prefetchController = controller
    this.attemptedPrefetchTarget = targetTime

    void this.readWindow(loader, targetTime, controller.signal)
      .then((window) => {
        if (
          controller.signal.aborted ||
          this.disposed ||
          this.currentWindow?.end !== targetTime
        ) {
          return
        }

        this.prefetchedWindow = window
        this.prefetchController = null
      })
      .catch((error) => {
        if (!controller.signal.aborted && !this.disposed) {
          this.recordWindowFailure(
            error instanceof MatroskaSubtitleError ? error : null
          )

          // Keep current coverage active; the next boundary read shares this backoff.
          this.prefetchController = null
        }
      })

    return true
  }

  private async readWindow(
    loader: PgsWindowLoader,
    targetTime: number,
    signal: AbortSignal
  ): Promise<PgsSubtitleWindow> {
    const state: PgsWindowReadState = {
      boundaryTime: null,
      coverageTime: null,
      packetBytes: 0,
      packets: [],
    }

    for await (const event of loader(targetTime, signal)) {
      if (signal.aborted || this.disposed) {
        throw new Error("Embedded PGS window was canceled.")
      }

      this.recordWindowEvent(state, event)
    }

    if (state.boundaryTime === null || state.coverageTime === null) {
      throw new MatroskaSubtitleError("invalid")
    }

    return {
      requestTime: targetTime,
      boundaryTime: state.boundaryTime,
      coverageTime: state.coverageTime,
      packets: state.packets,
    }
  }

  private recordWindowEvent(
    state: PgsWindowReadState,
    event: MatroskaPgsWindowEvent
  ): void {
    switch (event.kind) {
      case "boundary": {
        const { boundaryTime } = event
        state.boundaryTime = boundaryTime

        return
      }

      case "packet": {
        const { packet } = event
        state.packetBytes += packet.data.byteLength

        if (
          state.packets.length >= MAX_PGS_WINDOW_PACKETS ||
          state.packetBytes > MAX_PGS_WINDOW_BYTES
        ) {
          throw new Error("Embedded PGS window exceeded its retention limit.")
        }

        state.packets.push(packet)

        return
      }

      case "coverage": {
        const { coverageTime } = event
        state.coverageTime = coverageTime

        return
      }
    }
  }

  private async activateWindow(
    window: PgsSubtitleWindow,
    signal: AbortSignal,
    sequence: number
  ): Promise<void> {
    if (signal.aborted || this.disposed || sequence !== this.windowSequence) {
      return
    }

    this.applyingWindow = true

    try {
      await this.resetWorkerWindow()

      if (signal.aborted || this.disposed || sequence !== this.windowSequence) {
        return
      }

      if (!(await this.pushWindowPackets(window, signal, sequence))) {
        return
      }

      await this.finish(window.coverageTime, false)

      if (signal.aborted || this.disposed || sequence !== this.windowSequence) {
        return
      }

      this.markWindowActive(window)
    } catch (error: unknown) {
      if (!signal.aborted && !this.disposed) {
        this.recordWindowFailure(
          error instanceof MatroskaSubtitleError ? error : null
        )
        this.notifyListeners({ kind: "unavailable" })
      }
    } finally {
      if (sequence === this.windowSequence) {
        this.applyingWindow = false
      }
    }
  }

  private markWindowActive(window: PgsSubtitleWindow): void {
    this.currentWindow = {
      start: Math.min(window.boundaryTime, window.requestTime),
      end: window.coverageTime,
    }
    this.failedWindowAttempts = 0
    this.latestWindowFailureValue = null
    this.nextWindowRetryAt = 0
    this.windowRetryExhausted = false
    this.attemptedPrefetchTarget = null
    this.setWindowStatus("ready")

    if (this.latestTime !== null) {
      this.requestTime(this.latestTime)
    }
  }

  private setWindowStatus(status: PgsSubtitleWindowStatus): void {
    if (this.windowStatus === status) {
      return
    }

    this.windowStatus = status

    for (const listener of this.windowStatusListeners) {
      listener(status)
    }
  }

  private async pushWindowPackets(
    window: PgsSubtitleWindow,
    signal: AbortSignal,
    sequence: number
  ): Promise<boolean> {
    for (const packet of window.packets) {
      if (signal.aborted || sequence !== this.windowSequence) {
        return false
      }

      // Worker acknowledgements preserve decode order and cap retained packets.
      // oxlint-disable-next-line no-await-in-loop
      await this.push(packet)
    }

    return true
  }

  private async resetWorkerWindow(): Promise<void> {
    await this.waitForWorkerResponse(this.ready)

    if (this.disposed) {
      return
    }

    if (this.windowResetPromise !== null) {
      await this.windowResetPromise
    }

    const sequence = ++this.sequence

    const resetPromise = new Promise<void>((resolve, reject) => {
      this.pendingWindowReset = { sequence, resolve, reject }
      postToWorker(this.worker, {
        type: "reset-window",
        generation: this.generation,
        sequence,
      })
    })

    this.windowResetPromise = resetPromise

    try {
      await this.waitForWorkerResponse(resetPromise)
    } finally {
      if (this.windowResetPromise === resetPromise) {
        this.windowResetPromise = null
      }
    }
  }

  private async waitForWorkerResponse<T>(promise: Promise<T>): Promise<T> {
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true
        reject(new Error("Embedded PGS decoder worker timed out."))
      }, PGS_LIMITS.workerResponseTimeoutMs)
    })

    try {
      return await Promise.race([promise, timeoutPromise])
    } catch (error) {
      if (timedOut) {
        this.failWorker(
          error instanceof Error
            ? error
            : new Error("Embedded PGS decoder worker timed out.")
        )
      }

      throw error
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout)
      }
    }
  }

  private armRenderWatchdog(): void {
    this.clearRenderWatchdog()
    this.renderWatchdog = setTimeout(() => {
      this.failWorker(new Error("Embedded PGS decoder worker timed out."))
    }, PGS_LIMITS.workerResponseTimeoutMs)
  }

  private clearRenderWatchdog(): void {
    if (this.renderWatchdog !== null) {
      clearTimeout(this.renderWatchdog)
      this.renderWatchdog = null
    }
  }

  private failWorker(error: Error): void {
    if (this.disposed) {
      return
    }

    const wasFailed = this.failedValue
    this.failedValue = true
    this.latestWindowFailureValue = null
    this.setWindowStatus("failed")
    this.rejectPendingOperations(error)
    this.pendingTime = null
    this.latestTimeRequest = null
    this.renderOutstanding = false
    this.clearRenderWatchdog()
    this.worker.removeEventListener("message", this.onMessage)
    this.worker.removeEventListener("error", this.onWorkerError)
    this.worker.terminate()

    if (!wasFailed) {
      this.notifyListeners({ kind: "failed" })
    }
  }

  private rejectPendingOperations(error: Error): void {
    this.readyReject?.(error)
    this.readyReject = null
    this.readyResolve = null
    this.pendingPacket?.reject(error)
    this.pendingPacket = null
    this.pendingWindowReset?.reject(error)
    this.pendingWindowReset = null
  }
}
