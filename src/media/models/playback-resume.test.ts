import assert from "node:assert/strict"
import { test } from "node:test"

import {
  canPersistPlaybackPosition,
  createResumeConfirmation,
  RESUME_CONFIRMATION_DEADLINE_MS,
  type ResumeStatus,
} from "./playback-resume"

interface CapturedDeadline {
  fire?: () => void
}

void test("only confirms and persists resume after the requested time is reached", () => {
  let status: ResumeStatus = "pending"
  const accepted: { currentTime: number; confirmed: boolean }[] = []

  const confirmation = createResumeConfirmation({
    targetTime: 301,
    getStatus: () => status,
    updateStatus: (nextStatus) => {
      status = nextStatus
    },
    onAccepted: (currentTime, confirmed) => {
      accepted.push({ currentTime, confirmed })
    },
  })

  assert.equal(canPersistPlaybackPosition(status), false)
  assert.equal(confirmation.confirm(301), true)
  assert.equal(status, "confirmed")
  assert.deepEqual(accepted, [{ currentTime: 301, confirmed: true }])
  assert.equal(canPersistPlaybackPosition(status), true)
})

void test("out-of-range restoration fails without accepting the wrong position", () => {
  let status: ResumeStatus = "pending"
  const accepted: number[] = []

  const confirmation = createResumeConfirmation({
    targetTime: 301,
    getStatus: () => status,
    updateStatus: (nextStatus) => {
      status = nextStatus
    },
    onAccepted: (currentTime) => accepted.push(currentTime),
  })

  assert.equal(confirmation.confirm(120), false)
  assert.equal(status, "failed")
  assert.deepEqual(accepted, [])
  assert.equal(canPersistPlaybackPosition(status), false)
})

void test("resume confirmation deadline exposes failure and can be canceled", () => {
  let status: ResumeStatus = "pending"
  const deadline: CapturedDeadline = {}
  let deadlineCanceled = false

  const confirmation = createResumeConfirmation({
    targetTime: 301,
    getStatus: () => status,
    updateStatus: (nextStatus) => {
      status = nextStatus
    },
    onAccepted: () => {},
    scheduleDeadline(callback, delayMs) {
      assert.equal(delayMs, RESUME_CONFIRMATION_DEADLINE_MS)
      deadline.fire = callback

      return () => {
        deadlineCanceled = true
      }
    },
  })

  confirmation.startDeadline()
  assert.ok(deadline.fire)
  deadline.fire()

  assert.equal(status, "failed")
  assert.equal(deadlineCanceled, true)
})

void test("choosing start from the beginning unlocks position persistence", () => {
  let status: ResumeStatus = "failed"
  const accepted: { currentTime: number; confirmed: boolean }[] = []

  const confirmation = createResumeConfirmation({
    targetTime: 301,
    getStatus: () => status,
    updateStatus: (nextStatus) => {
      status = nextStatus
    },
    onAccepted: (currentTime, confirmed) => {
      accepted.push({ currentTime, confirmed })
    },
  })

  status = "declined"

  assert.equal(canPersistPlaybackPosition(status), true)
  assert.equal(confirmation.confirm(0), true)
  assert.deepEqual(accepted, [{ currentTime: 0, confirmed: false }])
})
