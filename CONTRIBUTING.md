# Contributing

## Developer Setup

See the [development guide](docs/internals/development.md) for the initial
checkout, development commands, and quality gates.

## Read This First

Myna is a small focused product. We accept focused fixes and maintenance
work, but large feature requests and direction changes need discussion first.

You can report a bug or open a PR, but please keep it focused, tested, and
consistent with the product's direction.

Feature requests and proposals should start with a discussion or issue before
implementation.

## What We Are Most Likely To Accept

Small, focused bug fixes.

Small reliability fixes for retries, reconnects, partial streams, or failed
playback paths.

Small performance improvements.

Tightly scoped maintenance work that clearly improves Myna without
changing its direction.

## What We Are Least Likely To Accept

Large PRs.

Drive-by feature work.

Opinionated rewrites.

Anything that expands product scope — a second backend, a database, accounts,
transcoding on the server — without us asking for it first.

## If You Still Want To Open A PR

Keep it small.

Explain exactly what changed.

Explain exactly why the change should exist.

Do not mix unrelated fixes together.

If the PR makes anything resembling a UI change, include clear before/after
images.

If we have to guess what changed, we are much less likely to review it.

## Discuss Changes First

If you are thinking about a non-trivial change, start a discussion or issue
first.

That still does not mean we will want the PR, but it gives you a chance to
avoid wasting your time.

## Be Realistic

Opening a PR does not create an obligation on our side.

We may close it. We may ignore it. We may ask you to shrink it. We may
reimplement the idea ourselves later.

If you are fine with that, proceed.
