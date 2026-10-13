import type { UrlSourceOptions } from "mediabunny"

import { parseRetryAfterMs } from "./retry-after"

const ADVANCED_READ_LIMITS = {
  headerInactivityMs: 15_000,
  bodyInactivityMs: 15_000,
  maxTransientRetries: 2,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 2_000,
  maxRetryAfterMs: 30_000,
} as const

export type AdvancedReadFailureKind =
  | "aborted"
  | "byte-access-unavailable"
  | "http"
  | "invalid-range"
  | "invalid-response"
  | "network"
  | "timeout"
  | "truncated"

export interface AdvancedReadDiagnostic {
  event: "failed" | "retry"
  kind: AdvancedReadFailureKind
  attempt: number
  rangeStart: number
  status: number | null
  retryAfterMs: number | null
  byteCount: number
}

export interface AdvancedReadPolicyClock {
  now: () => number
  setTimeout: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

export interface AdvancedReadPolicyOptions {
  fetch?: typeof fetch
  clock?: AdvancedReadPolicyClock
  onDiagnostic?: (diagnostic: AdvancedReadDiagnostic) => void
  pageOrigin?: string
  headerInactivityMs?: number
  bodyInactivityMs?: number
  maxTransientRetries?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  maxRetryAfterMs?: number
}

interface ReadAttempt {
  rangeStart: number
  requestedLength: number | null
  resourceKey: string
  crossOrigin: boolean
  expectedResourceIdentity: ResourceIdentity | null
  resourceIdentity: ResourceIdentity | null
  retryNumber: number
  inputSignal: AbortSignal | null
}

interface ResourceIdentity {
  etag: string | null
  lastModified: string | null
  totalSize: number | null
}

interface ResponseRange {
  length: number | null
  maximumLength: number | null
  totalSize: number | null
}

interface ContentRangeBounds {
  start: number
  end: number
  total: number | null
}

interface RequestedRange {
  start: number
  length: number | null
}

interface ReadRequestContext {
  inputSignal: AbortSignal | null
  attempt: ReadAttempt
  controller: AbortController
  cleanup: () => void
}

interface ReadFailureContext {
  kind: AdvancedReadFailureKind
  attempt: ReadAttempt
  nextRangeStart: number
  byteCount: number
  status?: number | null
  retryAfterMs?: number | null
}

interface BodyReadContext {
  request: ReadRequestContext
  reader: ReadableStreamDefaultReader<Uint8Array>
  responseStatus: number
  expectedLength: number | null
  maximumLength: number | null
  byteCount: number
  finished: boolean
}

interface BodyResponseOptions {
  responseStatus: number
  expectedLength: number | null
  maximumLength: number | null
}

interface RetryContext {
  retryNumber: number
  nextRangeStart: number
  resourceKey: string
  resourceIdentity: ResourceIdentity | null
  inputSignal: AbortSignal | null
  byteCount: number
}

interface PendingRetry {
  retryNumber: number
  delayMs: number
  resourceIdentity: ResourceIdentity | null
  removeAbortListener: () => void
}

const systemClock: AdvancedReadPolicyClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
}

function errorMessage(kind: AdvancedReadFailureKind, status: number | null) {
  switch (kind) {
    case "aborted":
      return "Media read canceled."
    case "byte-access-unavailable":
      return "Direct media byte access is unavailable."
    case "http":
      return `Media server returned HTTP ${status ?? "an error"}.`
    case "invalid-range":
      return "Media server returned an invalid byte range."
    case "invalid-response":
      return "Media server returned an invalid response."
    case "network":
      return "Media network request failed."
    case "timeout":
      return "Media read stopped delivering data."
    case "truncated":
      return "Media response ended before its byte range was complete."
    default:
      return "Media read failed."
  }
}

export class AdvancedMediaReadError extends Error {
  constructor(
    readonly kind: AdvancedReadFailureKind,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null
  ) {
    super(errorMessage(kind, status))
    this.name = "AdvancedMediaReadError"
  }
}

function isRetryableRead(error: AdvancedMediaReadError): boolean {
  return (
    error.kind === "network" ||
    error.kind === "timeout" ||
    error.kind === "truncated" ||
    (error.kind === "http" &&
      error.status !== null &&
      isRetryableStatus(error.status))
  )
}

function requestedRange(
  input: RequestInfo | URL,
  init: RequestInit
): RequestedRange {
  const headers = new Headers(
    init.headers ?? (input instanceof Request ? input.headers : undefined)
  )

  const range = /^bytes=(\d+)-(\d*)$/i.exec(headers.get("Range") ?? "")
  const start = range === null ? 0 : Number(range[1])
  const end = range?.[2] ? Number(range[2]) : null

  return {
    start: Number.isSafeInteger(start) && start >= 0 ? start : 0,
    length:
      end !== null && Number.isSafeInteger(end) && end >= start
        ? end - start + 1
        : null,
  }
}

function requestResourceKey(input: RequestInfo | URL): string {
  const value = input instanceof Request ? input.url : String(input)

  try {
    const url = new URL(value)
    url.hash = ""

    return url.href
  } catch {
    return value
  }
}

function responseRange(
  response: Response,
  attempt: ReadAttempt
): ResponseRange | null {
  if (response.status !== 206) {
    return null
  }

  const contentRange = response.headers.get("Content-Range")

  if (
    contentRange === null &&
    (attempt.crossOrigin || response.type === "cors")
  ) {
    return hiddenCrossOriginResponseRange(response, attempt)
  }

  return visibleResponseRange(response, contentRange, attempt)
}

function hiddenCrossOriginResponseRange(
  response: Response,
  attempt: ReadAttempt
): ResponseRange {
  const declaredLength = declaredBodyLength(response)
  const expectedTotal = attempt.expectedResourceIdentity?.totalSize ?? null
  let length = declaredLength

  if (attempt.requestedLength !== null) {
    if (declaredLength !== null && declaredLength > attempt.requestedLength) {
      throw new AdvancedMediaReadError("invalid-range")
    }
  }

  if (expectedTotal !== null) {
    const expectedLength = Math.min(
      attempt.requestedLength ?? expectedTotal - attempt.rangeStart,
      expectedTotal - attempt.rangeStart
    )

    if (
      expectedLength <= 0 ||
      (declaredLength !== null && declaredLength !== expectedLength)
    ) {
      throw new AdvancedMediaReadError("invalid-range")
    }

    length = expectedLength
  }

  return {
    length,
    maximumLength: attempt.requestedLength,
    totalSize: expectedTotal,
  }
}

function visibleResponseRange(
  response: Response,
  contentRange: string | null,
  attempt: ReadAttempt
): ResponseRange {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange ?? "")

  if (match === null) {
    throw new AdvancedMediaReadError("invalid-range")
  }

  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === "*" ? null : Number(match[3])

  if (!isValidVisibleRange({ start, end, total }, attempt)) {
    throw new AdvancedMediaReadError("invalid-range")
  }

  const length = end - start + 1

  if (!contentLengthMatches(response, length)) {
    throw new AdvancedMediaReadError("invalid-range")
  }

  return { length, maximumLength: length, totalSize: total }
}

function isValidVisibleRange(
  bounds: ContentRangeBounds,
  attempt: ReadAttempt
): boolean {
  const { start, end, total } = bounds

  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    (total === null || Number.isSafeInteger(total)) &&
    start === attempt.rangeStart &&
    end >= start &&
    (total === null || total > end) &&
    (attempt.requestedLength === null ||
      end - start + 1 <= attempt.requestedLength)
  )
}

function contentLengthMatches(
  response: Response,
  rangeLength: number
): boolean {
  const header = response.headers.get("Content-Length")

  if (header === null || response.headers.has("Content-Encoding")) {
    return true
  }

  const length = Number(header)

  return !Number.isFinite(length) || length < 0 || length === rangeLength
}

function responseIdentity(
  response: Response,
  totalSize: number | null
): ResourceIdentity {
  const etag = response.headers.get("ETag")

  return {
    etag: etag !== null && !/^W\//i.test(etag) ? etag : null,
    lastModified: response.headers.get("Last-Modified"),
    totalSize:
      totalSize ??
      (response.status === 200 ? declaredBodyLength(response) : null),
  }
}

function hasResourceValidator(identity: ResourceIdentity | null): boolean {
  return (
    identity !== null &&
    (identity.etag !== null || identity.lastModified !== null)
  )
}

function matchesResourceIdentity(
  expected: ResourceIdentity,
  actual: ResourceIdentity
): boolean {
  return (
    (expected.etag === null || expected.etag === actual.etag) &&
    (expected.lastModified === null ||
      expected.lastModified === actual.lastModified) &&
    (expected.totalSize === null || expected.totalSize === actual.totalSize)
  )
}

function declaredBodyLength(response: Response): number | null {
  if (response.headers.has("Content-Encoding")) {
    return null
  }

  const contentLengthHeader = response.headers.get("Content-Length")
  const contentLength = Number(contentLengthHeader)

  return contentLengthHeader !== null &&
    Number.isFinite(contentLength) &&
    contentLength >= 0
    ? contentLength
    : null
}

function resolveOrigin(input: RequestInfo | URL, pageOrigin: string | null) {
  try {
    const value = input instanceof Request ? input.url : String(input)

    return new URL(value, pageOrigin ?? undefined).origin
  } catch {
    return null
  }
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  )
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Keep the readable status or range error if stream cancellation fails.
  }
}

function discardResponseBody(response: Response): void {
  void cancelResponseBody(response)
}

function abortReason(signal: AbortSignal): AdvancedMediaReadError {
  return signal.reason instanceof AdvancedMediaReadError
    ? signal.reason
    : new AdvancedMediaReadError("aborted")
}

function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal))
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))

    signal.addEventListener("abort", onAbort, { once: true })

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

export function isProxyFallbackFailure(error: Error): boolean {
  let current: Error | undefined = error
  const seen = new Set<Error>()

  while (current !== undefined && !seen.has(current)) {
    seen.add(current)

    if (current instanceof AdvancedMediaReadError) {
      return current.kind === "byte-access-unavailable"
    }

    const causeValue: unknown = current.cause

    if (!(causeValue instanceof Error)) {
      return false
    }

    current = causeValue
  }

  return false
}

export class AdvancedMediaReadPolicy {
  private readonly fetchImplementation: typeof fetch
  private readonly clock: AdvancedReadPolicyClock
  private readonly onDiagnostic:
    | ((diagnostic: AdvancedReadDiagnostic) => void)
    | null
  private readonly pageOrigin: string | null
  private readonly headerInactivityMs: number
  private readonly bodyInactivityMs: number
  private readonly maxTransientRetries: number
  private readonly retryBaseDelayMs: number
  private readonly retryMaxDelayMs: number
  private readonly maxRetryAfterMs: number
  private readonly retryContexts = new WeakMap<
    AdvancedMediaReadError,
    RetryContext
  >()
  private readonly pendingRetries = new Map<string, PendingRetry>()

  readonly fetchFn: NonNullable<UrlSourceOptions["fetchFn"]>
  readonly getRetryDelay: NonNullable<UrlSourceOptions["getRetryDelay"]>
  readonly handleUnhandledError: NonNullable<
    UrlSourceOptions["handleUnhandledError"]
  >

  constructor(options: AdvancedReadPolicyOptions = {}) {
    this.fetchImplementation =
      options.fetch ?? ((input, init) => fetch(input, init))
    this.clock = options.clock ?? systemClock
    this.onDiagnostic = options.onDiagnostic ?? null
    this.pageOrigin =
      options.pageOrigin ??
      (typeof window === "undefined" ? null : window.location.origin)
    this.headerInactivityMs =
      options.headerInactivityMs ?? ADVANCED_READ_LIMITS.headerInactivityMs
    this.bodyInactivityMs =
      options.bodyInactivityMs ?? ADVANCED_READ_LIMITS.bodyInactivityMs
    this.maxTransientRetries =
      options.maxTransientRetries ?? ADVANCED_READ_LIMITS.maxTransientRetries
    this.retryBaseDelayMs =
      options.retryBaseDelayMs ?? ADVANCED_READ_LIMITS.retryBaseDelayMs
    this.retryMaxDelayMs =
      options.retryMaxDelayMs ?? ADVANCED_READ_LIMITS.retryMaxDelayMs
    this.maxRetryAfterMs =
      options.maxRetryAfterMs ?? ADVANCED_READ_LIMITS.maxRetryAfterMs
    this.fetchFn = (input, init) => this.fetch(input, init ?? {})
    this.getRetryDelay = (previousAttempts, error) =>
      error instanceof AdvancedMediaReadError
        ? this.retryDelay(previousAttempts, error)
        : null
    this.handleUnhandledError = (error) => {
      if (error instanceof AdvancedMediaReadError) {
        this.handleUnhandled(error)
      }
    }
  }

  get urlSourceOptions(): Pick<
    UrlSourceOptions,
    "fetchFn" | "getRetryDelay" | "handleUnhandledError"
  > {
    return {
      fetchFn: this.fetchFn,
      getRetryDelay: this.getRetryDelay,
      handleUnhandledError: this.handleUnhandledError,
    }
  }

  async fetchWithRetries(
    input: RequestInfo | URL,
    init: RequestInit
  ): Promise<Response> {
    return this.fetchWithRetryAttempt(input, init, 0)
  }

  private async fetchWithRetryAttempt(
    input: RequestInfo | URL,
    init: RequestInit,
    previousAttempts: number
  ): Promise<Response> {
    try {
      return await this.fetchFn(input, init)
    } catch (error: unknown) {
      if (this.getRetryDelay(previousAttempts + 1, error, input) === null) {
        throw error
      }

      return this.fetchWithRetryAttempt(input, init, previousAttempts + 1)
    }
  }

  private async fetch(
    input: RequestInfo | URL,
    init: RequestInit
  ): Promise<Response> {
    const request = await this.createRequest(input, init)
    const response = await this.fetchResponse(input, init, request)

    return this.wrapResponse(response, request)
  }

  private async createRequest(
    input: RequestInfo | URL,
    init: RequestInit
  ): Promise<ReadRequestContext> {
    const inputSignal =
      init.signal ?? (input instanceof Request ? input.signal : null)

    if (inputSignal?.aborted) {
      throw new AdvancedMediaReadError("aborted")
    }

    const range = requestedRange(input, init)
    const key = requestResourceKey(input)
    const pendingRetry = this.takeRetry(key, range.start)
    const retryNumber = pendingRetry?.retryNumber ?? 0

    if (pendingRetry !== undefined && pendingRetry.delayMs > 0) {
      try {
        await this.waitForRetryDelay(pendingRetry.delayMs, inputSignal)
      } catch {
        throw new AdvancedMediaReadError("aborted")
      }
    }

    const attempt: ReadAttempt = {
      rangeStart: range.start,
      requestedLength: range.length,
      resourceKey: key,
      crossOrigin: this.isCrossOrigin(input),
      expectedResourceIdentity: pendingRetry?.resourceIdentity ?? null,
      resourceIdentity: null,
      retryNumber,
      inputSignal,
    }

    const requestController = new AbortController()

    const abortFromInput = () => {
      requestController.abort(new AdvancedMediaReadError("aborted"))
    }

    inputSignal?.addEventListener("abort", abortFromInput, { once: true })

    const cleanup = () => {
      inputSignal?.removeEventListener("abort", abortFromInput)
    }

    return {
      inputSignal,
      attempt,
      controller: requestController,
      cleanup,
    }
  }

  private async fetchResponse(
    input: RequestInfo | URL,
    init: RequestInit,
    request: ReadRequestContext
  ): Promise<Response> {
    const { attempt, controller } = request

    const fetchPromise = Promise.resolve().then(() =>
      this.fetchImplementation(input, { ...init, signal: controller.signal })
    )

    let responseClaimed = false

    void fetchPromise.then(
      (lateResponse) => {
        if (controller.signal.aborted && !responseClaimed) {
          void cancelResponseBody(lateResponse)
        }
      },
      () => undefined
    )

    const headerDeadline = this.clock.setTimeout(
      () =>
        controller.abort(
          this.createError({
            kind: "timeout",
            attempt,
            nextRangeStart: attempt.rangeStart,
            byteCount: 0,
          })
        ),
      this.headerInactivityMs
    )

    try {
      const response = await awaitWithSignal(fetchPromise, controller.signal)

      responseClaimed = true

      return response
    } catch (error: unknown) {
      request.cleanup()

      if (request.inputSignal?.aborted) {
        throw new AdvancedMediaReadError("aborted")
      }

      if (controller.signal.reason instanceof AdvancedMediaReadError) {
        throw controller.signal.reason
      }

      if (error instanceof TypeError && this.isCrossOrigin(input)) {
        throw this.createError({
          kind: "byte-access-unavailable",
          attempt,
          nextRangeStart: attempt.rangeStart,
          byteCount: 0,
        })
      }

      throw this.createError({
        kind: "network",
        attempt,
        nextRangeStart: attempt.rangeStart,
        byteCount: 0,
      })
    } finally {
      this.clock.clearTimeout(headerDeadline)
    }
  }

  private wrapResponse(
    response: Response,
    request: ReadRequestContext
  ): Response {
    const body = this.readableResponseBody(response, request)

    const responseRangeInfo = this.responseRangeInfo(response, request)

    const identity = responseIdentity(
      response,
      responseRangeInfo?.totalSize ?? null
    )

    const invalidContinuation =
      request.attempt.rangeStart > 0 && response.status !== 206

    const changedResource =
      request.attempt.expectedResourceIdentity !== null &&
      !matchesResourceIdentity(
        request.attempt.expectedResourceIdentity,
        identity
      )

    if (invalidContinuation || changedResource) {
      request.cleanup()
      discardResponseBody(response)

      throw this.createError({
        kind: "invalid-range",
        attempt: request.attempt,
        nextRangeStart: request.attempt.rangeStart,
        byteCount: 0,
      })
    }

    request.attempt.resourceIdentity = identity

    const expectedLength = response.headers.has("Content-Encoding")
      ? null
      : (responseRangeInfo?.length ?? declaredBodyLength(response))

    const maximumLength = response.headers.has("Content-Encoding")
      ? null
      : (responseRangeInfo?.maximumLength ?? expectedLength)

    const wrappedBody = this.wrapBody(body, request, {
      responseStatus: response.status,
      expectedLength,
      maximumLength,
    })

    Object.defineProperty(response, "body", { value: wrappedBody })

    return response
  }

  private readableResponseBody(
    response: Response,
    request: ReadRequestContext
  ): ReadableStream<Uint8Array> {
    if (request.inputSignal?.aborted) {
      request.cleanup()
      discardResponseBody(response)

      throw new AdvancedMediaReadError("aborted")
    }

    if (!response.ok) {
      request.cleanup()
      discardResponseBody(response)

      throw this.createError({
        kind: "http",
        attempt: request.attempt,
        nextRangeStart: request.attempt.rangeStart,
        byteCount: 0,
        status: response.status,
        retryAfterMs: parseRetryAfterMs(
          response.headers.get("Retry-After"),
          this.clock.now()
        ),
      })
    }

    if (response.body === null) {
      request.cleanup()

      throw this.createError({
        kind: "invalid-response",
        attempt: request.attempt,
        nextRangeStart: request.attempt.rangeStart,
        byteCount: 0,
      })
    }

    return response.body
  }

  private responseRangeInfo(
    response: Response,
    request: ReadRequestContext
  ): ResponseRange | null {
    let rangedBody: ResponseRange | null

    try {
      rangedBody = responseRange(response, request.attempt)
    } catch {
      request.cleanup()
      discardResponseBody(response)

      throw this.createError({
        kind: "invalid-range",
        attempt: request.attempt,
        nextRangeStart: request.attempt.rangeStart,
        byteCount: 0,
      })
    }

    return rangedBody
  }

  private wrapBody(
    body: ReadableStream<Uint8Array>,
    request: ReadRequestContext,
    options: BodyResponseOptions
  ): ReadableStream<Uint8Array> {
    const context: BodyReadContext = {
      request,
      reader: body.getReader(),
      responseStatus: options.responseStatus,
      expectedLength: options.expectedLength,
      maximumLength: options.maximumLength,
      byteCount: 0,
      finished: false,
    }

    return new ReadableStream<Uint8Array>({
      pull: (controller) => this.pullBody(context, controller),
      cancel: () => this.cancelBody(context),
    })
  }

  private async pullBody(
    context: BodyReadContext,
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<void> {
    if (context.finished) {
      return
    }

    try {
      const result = await this.readBodyChunk(context)

      this.forwardBodyChunk(context, controller, result)
    } catch (error: unknown) {
      const readError =
        error instanceof AdvancedMediaReadError
          ? error
          : this.createError({
              kind: "network",
              attempt: context.request.attempt,
              nextRangeStart: this.nextBodyOffset(context),
              byteCount: context.byteCount,
            })

      this.failBodyRead(context, controller, readError)
    }
  }

  private async readBodyChunk(
    context: BodyReadContext
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    const { request } = context
    const { controller } = request
    const readPromise = context.reader.read()
    let deadline: ReturnType<typeof setTimeout> | null = null
    let onAbort: (() => void) | null = null

    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(abortReason(controller.signal))

        return
      }

      onAbort = () => reject(abortReason(controller.signal))
      controller.signal.addEventListener("abort", onAbort, { once: true })
    })

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      deadline = this.clock.setTimeout(() => {
        const timeout = this.createError({
          kind: "timeout",
          attempt: request.attempt,
          nextRangeStart: this.nextBodyOffset(context),
          byteCount: context.byteCount,
        })

        controller.abort(timeout)
        reject(timeout)
      }, this.bodyInactivityMs)
    })

    try {
      return await Promise.race([readPromise, abortPromise, timeoutPromise])
    } finally {
      if (deadline !== null) {
        this.clock.clearTimeout(deadline)
      }

      if (onAbort !== null) {
        controller.signal.removeEventListener("abort", onAbort)
      }
    }
  }

  private forwardBodyChunk(
    context: BodyReadContext,
    controller: ReadableStreamDefaultController<Uint8Array>,
    result: ReadableStreamReadResult<Uint8Array>
  ): void {
    if (context.finished) {
      return
    }

    if (result.done) {
      if (
        context.expectedLength !== null &&
        context.byteCount < context.expectedLength
      ) {
        throw this.createError({
          kind: "truncated",
          attempt: context.request.attempt,
          nextRangeStart: this.nextBodyOffset(context),
          byteCount: context.byteCount,
        })
      }

      context.finished = true
      context.request.cleanup()
      controller.close()

      return
    }

    const nextByteCount = context.byteCount + result.value.byteLength

    if (
      (context.expectedLength !== null &&
        nextByteCount > context.expectedLength) ||
      (context.maximumLength !== null && nextByteCount > context.maximumLength)
    ) {
      throw this.createError({
        kind: "invalid-range",
        attempt: context.request.attempt,
        nextRangeStart: this.nextBodyOffset(context),
        byteCount: nextByteCount,
      })
    }

    context.byteCount = nextByteCount
    controller.enqueue(result.value)
  }

  private failBodyRead(
    context: BodyReadContext,
    controller: ReadableStreamDefaultController<Uint8Array>,
    error: AdvancedMediaReadError
  ): void {
    if (context.finished) {
      return
    }

    context.finished = true
    context.request.cleanup()
    void context.reader.cancel().catch(() => {
      // The caller has stopped consuming this response, so cancellation is best-effort.
    })

    if (context.request.inputSignal?.aborted) {
      controller.close()

      return
    }

    controller.error(error)
  }

  private async cancelBody(context: BodyReadContext): Promise<void> {
    if (!context.finished) {
      context.finished = true
      context.request.cleanup()
      context.request.controller.abort(new AdvancedMediaReadError("aborted"))
    }

    await context.reader.cancel()
  }

  private nextBodyOffset(context: BodyReadContext): number {
    return context.responseStatus === 206
      ? context.request.attempt.rangeStart + context.byteCount
      : context.byteCount
  }

  private retryDelay(
    previousAttempts: number,
    error: AdvancedMediaReadError
  ): number | null {
    const context = this.retryContexts.get(error)

    if (context === undefined || context.inputSignal?.aborted) {
      return null
    }

    return this.scheduleRetry(previousAttempts, error, context)
  }

  private scheduleRetry(
    previousAttempts: number,
    error: AdvancedMediaReadError,
    context: RetryContext
  ): number | null {
    if (!this.canRetryAfterFailure(error, context)) {
      return null
    }

    const retryNumber = Math.max(
      context.retryNumber,
      Math.max(0, previousAttempts - 1)
    )

    if (retryNumber >= this.maxTransientRetries) {
      this.emitFailure(error, context)

      return null
    }

    const { retryAfterMs } = error

    if (retryAfterMs !== null && retryAfterMs > this.maxRetryAfterMs) {
      this.emitFailure(error, context)

      return null
    }

    const exponentialDelay = Math.min(
      this.retryBaseDelayMs * 2 ** retryNumber,
      this.retryMaxDelayMs
    )

    const delayMs = Math.max(exponentialDelay, retryAfterMs ?? 0)

    const retryContext: RetryContext = {
      retryNumber: retryNumber + 1,
      nextRangeStart: context.nextRangeStart,
      resourceKey: context.resourceKey,
      resourceIdentity: context.resourceIdentity,
      inputSignal: context.inputSignal,
      byteCount: context.byteCount,
    }

    if (!this.reserveRetry(retryContext, delayMs)) {
      return null
    }

    this.reportDiagnostic({
      event: "retry",
      kind: error.kind,
      attempt: retryContext.retryNumber,
      rangeStart: Math.max(
        0,
        retryContext.nextRangeStart - retryContext.byteCount
      ),
      status: error.status,
      retryAfterMs,
      byteCount: context.byteCount,
    })

    // Mediabunny's wait is not cancelable. The next fetchFn call applies the
    // reserved delay with the original request signal instead.
    return 0
  }

  private canRetryAfterFailure(
    error: AdvancedMediaReadError,
    context: RetryContext
  ): boolean {
    if (
      isRetryableRead(error) &&
      (context.byteCount === 0 ||
        hasResourceValidator(context.resourceIdentity))
    ) {
      return true
    }

    this.emitFailure(error, context)

    return false
  }

  private createError(context: ReadFailureContext): AdvancedMediaReadError {
    const error = new AdvancedMediaReadError(
      context.kind,
      context.status ?? null,
      context.retryAfterMs ?? null
    )

    this.retryContexts.set(error, {
      retryNumber: context.attempt.retryNumber,
      nextRangeStart: context.nextRangeStart,
      resourceKey: context.attempt.resourceKey,
      resourceIdentity:
        context.attempt.resourceIdentity ??
        context.attempt.expectedResourceIdentity,
      inputSignal: context.attempt.inputSignal,
      byteCount: context.byteCount,
    })

    return error
  }

  private takeRetry(
    resourceKey: string,
    offset: number
  ): PendingRetry | undefined {
    const key = this.retryKey(resourceKey, offset)
    const retry = this.pendingRetries.get(key)

    if (retry === undefined) {
      return undefined
    }

    this.pendingRetries.delete(key)
    retry.removeAbortListener()

    return retry
  }

  private reserveRetry(context: RetryContext, delayMs: number): boolean {
    if (context.inputSignal?.aborted) {
      return false
    }

    const key = this.retryKey(context.resourceKey, context.nextRangeStart)
    const existing = this.pendingRetries.get(key)
    existing?.removeAbortListener()

    const pending: PendingRetry = {
      retryNumber: context.retryNumber,
      delayMs,
      resourceIdentity: context.resourceIdentity,
      removeAbortListener: () => undefined,
    }

    const abort = () => {
      if (this.pendingRetries.get(key) === pending) {
        this.pendingRetries.delete(key)
      }
    }

    if (context.inputSignal !== null) {
      context.inputSignal.addEventListener("abort", abort, { once: true })
      pending.removeAbortListener = () =>
        context.inputSignal?.removeEventListener("abort", abort)
    }

    this.pendingRetries.set(key, pending)

    while (this.pendingRetries.size > 16) {
      const next = this.pendingRetries.entries().next()

      if (next.done) {
        break
      }

      const [offset, oldest] = next.value

      oldest.removeAbortListener()
      this.pendingRetries.delete(offset)
    }

    return true
  }

  private waitForRetryDelay(
    delayMs: number,
    signal: AbortSignal | null
  ): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal))
    }

    return new Promise((resolve, reject) => {
      let onAbort: (() => void) | null = null

      const timer = this.clock.setTimeout(() => {
        if (onAbort !== null) {
          signal?.removeEventListener("abort", onAbort)
        }

        resolve()
      }, delayMs)

      onAbort = () => {
        this.clock.clearTimeout(timer)
        reject(
          signal === null
            ? new AdvancedMediaReadError("aborted")
            : abortReason(signal)
        )
      }

      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private retryKey(resourceKey: string, offset: number): string {
    return `${resourceKey}\u0000${offset}`
  }

  private emitFailure(
    error: AdvancedMediaReadError,
    context: RetryContext
  ): void {
    this.reportDiagnostic({
      event: "failed",
      kind: error.kind,
      attempt: context.retryNumber + 1,
      rangeStart: Math.max(0, context.nextRangeStart - context.byteCount),
      status: error.status,
      retryAfterMs: error.retryAfterMs,
      byteCount: context.byteCount,
    })
  }

  private handleUnhandled(error: AdvancedMediaReadError): void {
    this.reportDiagnostic({
      event: "failed",
      kind: error.kind,
      attempt: 0,
      rangeStart: 0,
      status: error.status,
      retryAfterMs: error.retryAfterMs,
      byteCount: 0,
    })
  }

  private reportDiagnostic(diagnostic: AdvancedReadDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic)
    } catch {
      // Diagnostic observers must not change the outcome of a media read.
    }
  }

  private isCrossOrigin(input: RequestInfo | URL): boolean {
    if (this.pageOrigin === null) {
      return false
    }

    const origin = resolveOrigin(input, this.pageOrigin)

    return origin !== null && origin !== this.pageOrigin
  }
}
