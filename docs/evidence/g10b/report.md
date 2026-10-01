# G10b private evidence runner contract

## Scope

`npm run test:g10b:evidence` is the private, clean-worktree evidence entry point for the implemented G10b attached Mongo fault slice. It refuses to run unless `git status --porcelain=v1 --untracked-files=all` is empty and records the exact clean source commit.

Its private artifacts are written below ignored `output/evidence/g10b/<runId>/`. The run directory is mode `0700`; the closed artifact set (`manifest.json`, `results.json`, `cleanup.json`) is mode `0600`.

## Recorded facts

The manifest records SHA-256 provenance for every G10b-owned implementation file, every test selected by the G10b unit suite, selected G10b integration tests, package/lock/TypeScript/Jest configuration, evidence and fault runners, topology configuration, Toxiproxy configuration, toolchain pin, and G04b fixture. The hash inventory is explicit and closed.

Results retain only unit/topology/fault exit summaries and Jest totals, plus the two fixed case facts. A successful fault phase is accepted only when it reports exactly two suites and three tests:

- `WRITE_CONFLICT`: code `112`, `NO_APP_PARTIAL_EFFECT`.
- `DUPLICATE_FACE`: code `11000`, `NO_APP_PARTIAL_EFFECT`.

The cleanup artifact records only whether containers, networks, and volumes with the exact `passhub-g10b-fault-` prefix are absent, and that a primary execution failure takes precedence over cleanup or artifact-write failure. The runner re-checks the clean worktree after all phases and immediately before artifact writing; any detected mutation is recorded as `FAIL`.

## Deliberate exclusions

Artifacts use exact closed keysets and never retain command text or output, Mongo replies, request IDs, `lsid`, transaction numbers, URIs, HTTP bodies, Face subjects, credentials, or response payloads. This tracked document describes the contract only; it does not claim that a formal evidence run has been performed from this uncommitted working revision.
