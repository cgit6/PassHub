# G12f Docker Demo

Result: **PASS**

## Scope

This gate proves a clean-source Docker reconstruction of the fixed local Demo flow. It does not prove public HTTPS, production availability, hardware integration, RTSP, or completion of every requirement in the ledger.

## Evidence

- Source checkout tested: `1800ed314c56822db8ef84f83319ed69506d9cd8` (`test: expand G12f Docker cleanup checks`), clean before execution.
- Command: `npm run check:g12f:docker-demo && npm run demo:g12f:docker`
- Exit status: `0`.
- Static checker: 17 checks passed.
- Docker API image: built from `infra/g11/api.Dockerfile`; the runner reported an immutable image digest and removed its temporary tag during cleanup.
- Compose source: `infra/g11/compose.yml`, SHA-256 `9637ed74abbd520321f3ce2bfcf4e631a7f7966aa11fe3694d4e3198442561f9`.
- Runtime: Docker 29.0.0, Compose v2.40.3, Node image pinned by the existing production Dockerfile.
- Fingerprints: runner `a4a0b8c69ff4daf6d23ccf504a236732993c2187ac7608b78994033a9a4e201a`; checker `5d785f018b266e70e4f93b6b68896985a67fee1b6fad30ccc473145757670b33`; `package.json` `3ee4036c4b4e3da43ab9d5ffd5a52ba4f36f48efed445c91ab53c6fc33a9f539`; `package-lock.json` `70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b`; README `132a1987248d884d351f8b29226dcca841e4af57f74b9ade7cf1e9c276423fe0`; API Dockerfile `6d022c40336cbc94c9ac1de707957c2790dd9b7d6637fc9a34a8f2b65f51afe3`.

## Cases

The runner asserted all cases below against the production entrypoint, MongoDB replica-set persistence, HTTPS proxy and public business routes:

`DOCKER_BUILD`, `MONGO_PRIMARY`, `API_READY`, `CREATE_QR`, `QR_ENTRY`, `INSIDE_QUERY`, `FACE_EXIT`, `EVENTS_EXITED`.

The runner created an ephemeral dataset and credentials, performed QR ENTRY and simulated `FACE_MATCHED` EXIT, then asserted `INSIDE`, `EXITED`, `ENTRY_GRANTED`, `EXIT_RECORDED` and both events. The runner removed Compose containers, networks, volumes, its image tag, TLS files, secrets and runtime files in `finally`, then independently probed project labels, image tag and temporary-directory absence. SIGINT/SIGTERM use the same cleanup path.

## Boundaries

The Face payload represents a result already produced by an external recognition service. The Demo does not process images, RTSP, confidence, cameras, locks or real biometric data. The runner does not expose internal readiness, runtime control, reset, claim or ticket APIs.

## Review status

PM, architecture and tester reviewed the G12f design and evidence requirements. Their pre-implementation blocking findings (missing runner, stale README, no clean seed path) were addressed by this gate. The next gate remains G12g public HTTPS/deployment.
