# Playloom

Playloom is a browser media player. Paste a direct media URL and it plays
immediately. The browser's native pipeline always plays first; custom decoding
exists only to extend what the browser cannot do — E-AC-3/AC-3/DTS audio, track
switching, and CORS-blocked byte access. Decoding happens in the client, never
on Cloudflare Workers. Workers serve the app and proxy bytes.

Keep the product simple, predictable, and useful as it grows.

## Priorities

Performance, stability, and reliability come first. Treat retries, reconnects,
partial streams, stale clients, and failed upstream calls as normal product
states. If a tradeoff is required, choose correctness and robustness over
short-term convenience. In the code itself, prioritize correctness and clarity;
speed and efficiency are secondary unless the task says otherwise.

Long-term maintainability is a core priority. If you add new functionality,
first check if shared logic can be extracted into a separate module. Duplicate
logic across multiple files is a code smell and should be avoided. Don't be
afraid to change existing code. Don't take shortcuts by just adding local logic
to solve a problem. Prefer implementing functionality in existing files unless
it is a new logical component, and avoid creating many small files.

## A note from Playloom

I like ambitious ideas, simple systems, and software that feels obvious. Do not
preserve complexity just because it already exists. Do not introduce machinery
because it looks architecturally impressive. Understand the real constraint,
then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to
honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make
changes effectively. Think of these instructions less as "hard rules", more as
"good defaults". The developer's preferences should be able to override
anything here. If a rule in this file fights the task in front of you, say so
loudly and get a human sign-off before breaking it.

## A small glossary

- **you** means the agent reading this file and changing Playloom.
- **user** means a person pasting a media URL into Playloom.
- **native path** means the browser's own `<video>` pipeline, including
  platform HLS.
- **advanced engine** means the Mediabunny/WebCodecs/WASM pipeline used only
  when the native path cannot do the job.
- **the proxy** means the same-origin Worker route `/api/media-proxy` that
  forwards range requests for the advanced engine.

## Product invariants

- The native path plays first. Never block startup on probing, Mediabunny, the
  proxy, or WASM.
- Native playback is never proxied. The proxy serves the advanced engine's
  byte reads only.
- Never set `crossOrigin` on native sources. A cross-origin video can be
  playable while its bytes are CORS-blocked; the attribute breaks that.
- `canPlayType()` is a hint, not a verdict. Runtime events — `loadedmetadata`,
  `canplay`, `playing`, `error` — are the real signal. No user-agent
  capability tables.
- Engine migration preserves currentTime, play/pause state, volume, mute,
  rate, and selected tracks. Switching audio tracks must not restart playback.
- In the advanced engine, the audio context clock is the single playback
  clock; video rendering follows it.
- Media URLs can carry credentials (`?token=`, `?expiry=`, `?mac=`). Never log
  them, put them in analytics, titles, or shareable app URLs. The entered URL
  lives in client state; `sessionStorage` only for `/` → `/watch` navigation.
- All media initialization happens on the client in `/watch`. Server loaders
  never fetch media.
- No global COOP/COEP — cross-origin media loading is the core use case.

## Hit every surface

The most common defect is a change that works on the path you tested and is
missing everywhere else. Before calling work done, walk this list and say which
entries applied. Fixing one path is not fixing the feature.

- **Engines.** Native, native HLS, hls.js, Mediabunny+WebCodecs, WASM
  AC-3/DTS. A change to one engine needs a decision per engine, even if the
  decision is "does not apply".
- **States.** Play, pause, seek, volume, mute, rate, fullscreen, PiP, track
  switching, engine migration mid-playback, source change while loading.
- **Failure paths.** CORS-blocked bytes, dead upstream, dropped range
  requests, codec without hardware support, decoder initialization failure.
  These are normal product states, not edge cases.
- **Browsers.** Chrome, Edge, Firefox, Safari. Codec and track APIs differ
  where it hurts; check before assuming.

## Ways to hurt yourself

1. **Believing `canPlayType()`.** It returns `""` for HEVC-in-Matroska while
   the file actually plays. Runtime events decide, always.
2. **Adding `crossOrigin` to "fix" canvas taint.** It kills native playback of
   cross-origin files. The advanced engine goes through the proxy instead.
3. **Assuming `audioTracks`.** Chrome exposes none on this class of file;
   native multi-track selection cannot be assumed anywhere.
4. **Buffering proxy bodies.** The proxy streams `upstream.body` through. A
   5 GB file must never sit in Worker memory.

## Dev servers

- `pnpm dev` runs the app on the local Worker environment.
- Regenerate Cloudflare binding types after changing `wrangler.jsonc` with
  `pnpm run cf-typegen`. The generated `worker-configuration.d.ts` is
  gitignored and regenerated inside `pnpm check`; never commit it.

## Linting and formatting

While iterating, run `pnpm run fmt` and fix lint with `pnpm run lint`. Warnings
fail every lint run through `denyWarnings` in `.oxlintrc.json`, so a warning is
a failure everywhere. When feeding lint output back into an agent loop, run
`oxlint --format=agent <paths>` for one compact line per finding.

Oxlint and `oxlint-tsgolint` are a matched pair — upgrade them together or the
type-aware server panics on unknown rule names.

Knip runs in both modes inside `pnpm check`: the default run and the production
run (`knip:production`). Production mode only analyzes patterns with the `!`
suffix in `knip.json`.

## Verifying

- Use the smallest proof that demonstrates the change.
- Test observable behavior through the public interface.
- Wait on real completion signals — a media event, a response, a decoded
  frame — never on sleeps or polling. A test that needs a timeout to pass is
  wrong.
- For large-file work: no whole-file download, ranges visible in the network
  panel, bounded memory, source switch cancels requests.
- Before handoff, run `pnpm check` and `pnpm build`.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Use a clear, correctly capitalized, imperative title with no trailing
  punctuation. Do not use conventional commit prefixes.
- Body: the problem in a sentence or two, then how you fixed it. Close with
  the model and harness that did the work.
- Every claim in the body must be checkable against the diff; never state an
  intention as a completed result.
- UI changes need before/after images.
- One concern per PR, where a concern is a change that can be reviewed and
  reverted on its own.

## Rules hygiene

AGENTS.md is read by every agent session. Keep it high-signal.

New rules must be non-obvious, repeatedly encountered, and specific enough to
act on. If lint can enforce it, it belongs in the oxlint configuration, not
here. Rules are traps to avoid, not maps to follow. Architectural descriptions
go stale fast; durable architecture belongs in `docs/internals/`.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files.
  `.plans/` is ignored as a safety net, not as an accepted project-artifact
  directory.
- Put durable architecture, constraints, and decisions in `docs/internals/`.
  Put deployment and operational procedures in `docs/operations/`.

## Documentation

Most code changes do not need a documentation change. Agents can read the
code.

- `docs/internals/` is for architectural decisions and their reasons,
  constraints that span components, and implementation traps hard to discover
  from the source. Before adding a paragraph, ask what a maintainer would get
  wrong without it.
- Do not enumerate fields or methods, narrate control flow, maintain file
  catalogs, or append PR summaries.
- When a documented decision changes, rewrite the affected text. Do not append
  another account of the new behavior.

## Where code lives

- `src/routes/` - `__root`, `/` (URL entry), `/watch` (player),
  `/api/media-proxy`.
- `src/components/ui/` - generated shadcn primitives. Treat them as read-only;
  the formatter and linter exclude this directory. Delete wholly-unused
  components; knip flags them and the shadcn CLI can restore them.
- `src/components/player/` - player shell, settings, track menus, errors.
- `src/media/` - playback controller, engines, probe, audio clock, models.
- `tools/oxlint/anti-slop/` - vendored Oxlint plugin installed by the
  `install-anti-slop` skill. Never edit or reformat it; update it by
  re-running the skill.
- `.repos/` - vendored read-only references (Effect). Never edit or import
  from them. Sync with `pnpm run sync:repos`. Read `.repos/effect/LLMS.md`
  before writing Effect code.

## Taste

- Measure before adding a cache, queue, or orchestrator.
- Probe beats speculate. When a rule and reality disagree, run the experiment
  and believe what you saw.
- Every external read has a deadline, a size bound, and a cancellation path.
- Never silently discard errors. Handle them, propagate them, or surface them
  to the UI. When discarding an error is genuinely intended, make it explicit
  with a comment saying why.
- Comments exist to explain why code is written a certain way when the reason
  is tricky or non-obvious.
- Use full words in names. A lying spinner, stale label, or dropped state
  change is a product bug.
