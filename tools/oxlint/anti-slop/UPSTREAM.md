# Upstream provenance

- Source: `install-anti-slop` skill bundle in this repository
  (`.agents/skills/install-anti-slop`), installed with its
  `scripts/install.mjs` on 2026-10-06 at playloom commit `5b3582f`.
  The skill bundle is the recoverable pristine snapshot; no separate
  upstream repository or commit is recorded with it.
- Installed paths: `tools/oxlint/anti-slop/index.ts` (generic plugin),
  `tools/oxlint/anti-slop/effect/index.ts` (Effect plugin).
- Intentional deviations: none. The vendored tree is unmodified.
- Companion dependency: `@oxlint/plugins` pinned to the exact installed
  `oxlint` version (1.82.0) so the pair moves together.
