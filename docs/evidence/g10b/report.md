# G10b private evidence runner and formal run

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

Artifacts use exact closed keysets and never retain command text or output, Mongo replies, request IDs, `lsid`, transaction numbers, URIs, HTTP bodies, Face subjects, credentials, or response payloads.

## Formal run

The formal clean-worktree run completed successfully from source commit `77e8c21b741780e7b26ba0d0944111697991dc04`.

- Run ID: `g10b-41a126f2424d49c6a89df8f9b7d200e6`
- Result: `PASS`; unit suite `8 / 65`, topology check passed, fault suite exactly `2 / 3`.
- Verified cases: `WRITE_CONFLICT` (`112`) and `DUPLICATE_FACE` (`11000`), both `NO_APP_PARTIAL_EFFECT`.
- Cleanup: `PASS`; no container, network, or volume with the exact `passhub-g10b-fault-` prefix remained.
- Private artifact hashes: results `4f5a0a32d1bcc71c723f48707e511ba8c35c119ca557b5e939682fca80fec37b`; cleanup `f4cf6fe9fc222433a6037c166f7ef2f3b266dfc7acd9b37ccc41ed8a994f3043`.

This proves the implemented **pre-commit** termination slice only. It does not prove G10c transport-unknown confirmation, production deployment, or complete-release acceptance.
