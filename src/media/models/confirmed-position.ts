const SEEK_COMPLETION_TOLERANCE_SECONDS = 1

function isValidPosition(position: number): boolean {
  return Number.isFinite(position) && position >= 0
}

// Keeps the last native media time the browser has actually reached. A seek
// target becomes durable only after the element finishes that seek.
export class ConfirmedPosition {
  private confirmedPositionSeconds: number
  private requestedPositionSeconds: number | null = null

  constructor(initialPositionSeconds = 0) {
    this.confirmedPositionSeconds = isValidPosition(initialPositionSeconds)
      ? initialPositionSeconds
      : 0
  }

  get confirmedTime(): number {
    return this.confirmedPositionSeconds
  }

  get hasPendingSeek(): boolean {
    return this.requestedPositionSeconds !== null
  }

  beginSeek(targetTime: number): void {
    if (isValidPosition(targetTime)) {
      this.requestedPositionSeconds = targetTime
    }
  }

  cancelSeek(): void {
    this.requestedPositionSeconds = null
  }

  observePosition(currentTime: number, seeking: boolean): number | null {
    if (seeking) {
      this.beginSeek(currentTime)

      return null
    }

    if (this.hasPendingSeek || !isValidPosition(currentTime)) {
      return null
    }

    this.confirmedPositionSeconds = currentTime

    return currentTime
  }

  capture(currentTime: number, seeking: boolean): number {
    if (seeking) {
      this.beginSeek(currentTime)

      return this.confirmedPositionSeconds
    }

    if (this.hasPendingSeek || !isValidPosition(currentTime)) {
      return this.confirmedPositionSeconds
    }

    this.confirmedPositionSeconds = currentTime

    return currentTime
  }

  completeSeek(currentTime: number, seeking: boolean): boolean {
    if (seeking || !isValidPosition(currentTime)) {
      return false
    }

    if (
      this.requestedPositionSeconds !== null &&
      Math.abs(currentTime - this.requestedPositionSeconds) >
        SEEK_COMPLETION_TOLERANCE_SECONDS
    ) {
      return false
    }

    this.requestedPositionSeconds = null
    this.confirmedPositionSeconds = currentTime

    return true
  }

  confirmEnded(currentTime: number): boolean {
    if (!isValidPosition(currentTime)) {
      return false
    }

    this.requestedPositionSeconds = null
    this.confirmedPositionSeconds = currentTime

    return true
  }
}
