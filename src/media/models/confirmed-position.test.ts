import assert from "node:assert/strict"
import { test } from "node:test"

import { ConfirmedPosition } from "./confirmed-position"

void test("progress, pause, and cleanup retain the last confirmed native position during a seek", () => {
  const position = new ConfirmedPosition(301)
  position.beginSeek(1_100)

  assert.equal(position.observePosition(1_100, false), null)
  assert.equal(position.capture(1_100, false), 301)
  assert.equal(position.capture(1_100, true), 301)
  assert.equal(position.completeSeek(1_100, true), false)
  assert.equal(position.confirmedTime, 301)

  assert.equal(position.completeSeek(1_100, false), true)
  assert.equal(position.observePosition(1_100, false), 1_100)
  assert.equal(position.confirmedTime, 1_100)
})

void test("failed and superseded native seeks cannot confirm an older target", () => {
  const position = new ConfirmedPosition(301)
  position.beginSeek(1_100)

  assert.equal(position.completeSeek(301, false), false)
  assert.equal(position.capture(301, false), 301)

  position.beginSeek(1_200)
  assert.equal(position.completeSeek(1_100, false), false)
  assert.equal(position.capture(1_100, false), 301)

  assert.equal(position.completeSeek(1_200, false), true)
  assert.equal(position.confirmedTime, 1_200)
})

void test("canceling a native seek retains the last confirmed position", () => {
  const position = new ConfirmedPosition(301)
  position.beginSeek(0)

  assert.equal(position.capture(0, false), 301)
  position.cancelSeek()

  assert.equal(position.hasPendingSeek, false)
  assert.equal(position.capture(301, false), 301)
  assert.equal(position.confirmedTime, 301)
})

void test("a genuine ended event remains an intentional completion update", () => {
  const position = new ConfirmedPosition(301)
  position.beginSeek(1_100)

  assert.equal(position.confirmEnded(1_474), true)
  assert.equal(position.hasPendingSeek, false)
  assert.equal(position.confirmedTime, 1_474)
})
