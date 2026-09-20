# G05b execution／confirmation budget ledger —限定 gate evidence

## 判定

G05b primitive-only gate **PASS**。本關交付每原操作的純 budget／admission ledger，不執行 Mongo driver、abort、canonical read、HTTP、Auth、registry 或 use-case；因此不宣稱 L14–L23 或完整 v1 已完成。

## Contract and implementation

`src/access/application/internal/budget-ledger.ts` 是 internal-only、per-operation、owner-fenced synchronous ledger：

- execution：首次 `beginRound()` 取得完整處理權時起算 15,000ms；最多 3 rounds，排隊不計，首次也計一輪。已准入第三輪可在剩餘時間完成；round／execution time 不因 retry、continuation 或重送刷新。
- confirmation：首次 DB unknown 或首次確需 precommit cleanup 取較早起點；10,000ms、7 shared slots。single confirmation 每次 admission 扣一格，失敗／unknown／timeout 不退款；同項 continuation／重送不補額度。
- cadence：single confirmation 由 ledger 輸出 immediate original commit、+1,000ms canonical、+2,000ms original，之後每 +2,000ms 交替；前一個 permit 未 settle 不准並行。首次 commit 受 execution 剩餘時間，不借 confirmation budget；canonical 及 subsequent sends 嚴格整數毫秒，`<1ms` 不發、不傳零。
- native precommit group：只在 precommit cleanup、confirmation window 尚可用且至少 2 slots 時 admission；原子預扣 2 slots、獨占、不可退款，最多兩 send，共用 2,000ms group deadline。已准入 group 的第二 send 可跨 confirmation window、無組內 1／2 秒間隔；不得建立新 group。
- continuation：只接受 synchronous opaque no-effect evidence verifier；成功後只授權一次下一 round，保留原 execution／confirmation deadline、slots、receivedAt／FIFO 語意。canonical result、重用 evidence、非同步／throw／reentrant verifier 均 fail-closed。
- safety：trusted clock rollback、clock／owner failure、overflow、foreign／forged／double-used permits、re-entry 及 construction mutation 都永久 freeze ledger。ledger 只輸出 permits／typed denials，不做任何 I/O。

這直接對應 D86–D93、D126–D137 與 business §7.4–7.5 的純 budget/admission 責任。G10b/c 才負責實際 driver wire、abort、transport unknown、canonical/no-late/safe-terminal 證據。

## Exact verification

Pinned image：

```text
node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
```

Executed inside that image:

```bash
npm ci --ignore-scripts
npm run test:g05b
npm run test:unit
npm run test:g05a
npm run test:boundary
npm run test:negative-compile
npm run build
```

Results: `npm ci` exit 0, 423 packages／0 vulnerabilities；G05b 1 suite／**80 tests passed**；unit 8 suites／**138 tests passed**；G05a 1 suite／**21 tests passed**；boundary `selected=24 edges=58 forbidden=0 directRawComparison=0`；negative compile exit 0；all builds exit 0. The slim image has no `git`, so its final `git diff --check` command was unavailable; host read-only `git diff --check` passed. No G04a/G04b source changed in this working tree; prior same-working-tree host true-Mongo evidence remains in `docs/evidence/g04a/report.md` and `docs/evidence/g04b/report.md` and is not relabeled as this gate's evidence.

The same image also ran `npm run test:coverage`: 8 suites／138 tests passed; aggregate coverage was 48.98% statements, 52.56% branches, 45.69% functions, 51.52% lines. The G05b ledger file alone was 92.82% statements, 91.02% branches, 100% functions, 98.58% lines. These are observational coverage figures, not a release threshold.

Architect review PASS and independent tester formal **80/80 PASS** were reviewed inputs. The 80 cases cover construction capture/validation, exact round/deadline behavior, confirmation origin/cadence/slots, native two-send group, continuation, forged/stale/reused capabilities, clock/owner failure, and static boundary/forbidden infrastructure checks. The earlier tester defect is represented by the permanent fail-closed and continuation evidence cases.

Working-tree fingerprints:

```text
package.json 1c2348201475c1382c6216c391c906ba633a826761c676bc99034618ebbb6316
package-lock.json 70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b
src/access/application/internal/budget-ledger.ts d8fa3a2960e747ca5c08fadbf7d79f5542d5c6ed9171b8f01e6cbbd18a670856
src/access/application/internal/index.ts 4c2ca6181b50b21570fba3907af0609a83e5b9144f7a6a29fc7091d424229f6d
test/unit/g05b-budget-ledger.test.ts 7f0f3fd220214fd2d83939cab04ccbceb38b3d308c700776930a630554063337
jest.g05b.unit.config.cjs 4c42c66da74142b179be3e6cacc901a2aa0191fd78ebbacaa877b6d45ea16c0c
```

## Requirement disposition and limits

L14–L23 remain **U**. The ledger is direct G05b evidence and a partial implementation input, but these requirements additionally need actual driver send/timeout behavior, unknown commit/canonical observation, native abort wire, no-late/safe-terminal evidence, and full lifecycle integration. No complete requirement is promoted to V; V remains 10 and U remains 126.

Still out of scope: G05c registry／epoch／capacity／join／late callback fence; G07 raw HTTP/admission/response lifecycle; G08 Auth/use-case/management/recognition/Event/Presence wiring; G10b abort wire and G10c transport-loss／confirmation protocol. Next legal gate is G05c.
