export type ResumeStatus =
  | "idle"
  | "pending"
  | "confirmed"
  | "failed"
  | "declined"

export const RESUME_CONFIRMATION_DEADLINE_MS = 10_000

export const RESUME_POSITION_TOLERANCE_SECONDS = 1

export interface ResumeConfirmation {
  clearDeadline: () => void
  confirm: (currentTime: number) => boolean
  fail: () => void
  startDeadline: () => void
}

export type ScheduleResumeDeadline = (
  callback: () => void,
  delayMs: number
) => () => void

export function canPersistPlaybackPosition(status: ResumeStatus): boolean {
  return status !== "pending" && status !== "failed"
}

export function createResumeConfirmation({
  targetTime,
  getStatus,
  updateStatus,
  onAccepted,
  onFailed,
  scheduleDeadline = scheduleTimer,
}: {
  targetTime: number
  getStatus: () => ResumeStatus
  updateStatus: (status: ResumeStatus) => void
  onAccepted: (currentTime: number, confirmed: boolean) => void
  onFailed?: () => void
  scheduleDeadline?: ScheduleResumeDeadline
}): ResumeConfirmation {
  let cancelDeadline: (() => void) | null = null

  const clearDeadline = () => {
    cancelDeadline?.()
    cancelDeadline = null
  }

  const fail = () => {
    if (getStatus() === "pending") {
      clearDeadline()
      updateStatus("failed")
      onFailed?.()
    }
  }

  return {
    clearDeadline,
    fail,
    startDeadline() {
      clearDeadline()
      cancelDeadline = scheduleDeadline(fail, RESUME_CONFIRMATION_DEADLINE_MS)
    },
    confirm(currentTime) {
      const pending = getStatus() === "pending"

      if (
        pending &&
        Math.abs(currentTime - targetTime) > RESUME_POSITION_TOLERANCE_SECONDS
      ) {
        fail()

        return false
      }

      if (pending) {
        clearDeadline()
        updateStatus("confirmed")
      }

      if (canPersistPlaybackPosition(getStatus())) {
        onAccepted(currentTime, pending)
      }

      return canPersistPlaybackPosition(getStatus())
    },
  }
}

function scheduleTimer(callback: () => void, delayMs: number): () => void {
  const timeout = setTimeout(callback, delayMs)

  return () => clearTimeout(timeout)
}
