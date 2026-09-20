# G05c registry／epoch／late-callback fence —限定 gate evidence

## 判定

G05c primitive-only gate **PASS**。本關交付 process-local operation registry、opaque capability provenance、artifact equality join/conflict、4096 bounded retention、canonical／safe technical terminal、generation／late-callback fence、dataset epoch 與 writable/read-only claim primitive。它沒有接上 G05a／G05b／G05c composition、Mongo metadata claim state machine、HTTP、capacity pools、use-case、driver、transport fault 或 maintenance，因此不宣稱任何完整 v1 requirement 已新增為 V。

架構 review **PASS**；independent tester formal **51/51 PASS** 已核對，PM 另以 exact image 重新執行同一 production/test surface。G05c source 仍是 internal-only，沒有 infrastructure、Mongo、transaction、retry loop、parallel orchestration 或 raw comparison exposure。

## Contract and implementation

`src/access/application/internal/operation-registry.ts` 的 composition-only issuer 只發出 branded、frozen、空 opaque tokens；實際 payload/provenance 留在 module-private `WeakMap`。registry key 是 `sourceId + externalEventId`；不同 Source 不 alias，同 key 同 artifact join/replay，different artifact 回 typed `IDEMPOTENCY_CONFLICT`，不覆寫原 entry、不新增 operation。

- `IN_FLIGHT`、`UNKNOWN`、`CANONICAL`、`SAFE_TECHNICAL_TERMINAL` 四狀態保留原 entry；canonical 與 safe terminal 只回放原 opaque result reference，不重新執行。
- 同 artifact 判斷由建構時 capture 的同步 trusted verifier 完成；G05c 不讀 raw HMAC／secret、不自行重算 crypto、不暴露 comparison reference。throw、非 boolean、thenable、re-entry 或 provenance 遺失均永久 fail-closed。
- 初始 capacity 為 4096；滿格拒絕新 key，但既有 join／canonical replay 仍可用；沒有 TTL／日間 eviction，terminal entry 不釋放。
- execution／confirmation lease 帶 generation、datasetEpoch、processRunId、ownerId；UNKNOWN 只能由相同 generation 的 trusted continuation evidence 一次 mint permit，resume 後 generation 遞增，舊 lease／permit／late callback 不能改變 entry 或其他 key。
- result reference、key、artifact、claim、lease、permit 皆有 issuer／registry provenance；foreign、forged、stale、double-use 均 typed reject 或永久 freeze。
- `writeRunClaim` 只接受 issuer 已發出的 opaque `WRITABLE`／`READ_ONLY`／`STALE` claim。READ_ONLY／STALE lookup 為 `NOT_PROVEN` 且禁止新寫入；G05c 不模擬 metadata atomic claim、process takeover、reset 或 Mongo state machine。
- trusted owner、artifact comparer、continuation verifier 必須同步且回傳精確契約值；throw／primitive throw／async resolve/reject／then getter／re-entry 均 freeze registry，diagnostic snapshot 不洩漏 artifact、result 或 secret identity。

這些 primitive 對應 D78–D91、D95–D99、D146–D149、D149–D150 的窄 registry／epoch／late-callback責任；完整 registry admission 與四資源 all-or-nothing、FIFO／budget wiring、HTTP/use-case integration 仍須後續 gate。

## Exact verification

Pinned image：

```text
node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
```

Repo 以 read-only bind mount 複製到 container writable temporary workspace；`dist`／`coverage`／host `node_modules` 未清除或 chown。exact image 內執行：

```bash
npm ci --ignore-scripts
npm run test:g05c
npm run test:unit
npm run test:g05a
npm run test:g05b
npm run test:boundary
npm run test:negative-compile
npm run test:coverage
npm run build
```

結果：

- `npm ci --ignore-scripts` exit 0；423 packages／0 vulnerabilities。
- G05c：1 suite／**51 tests passed**。
- full unit：9 suites／**189 tests passed**。
- G05a：1 suite／**21 tests passed**。
- G05b：1 suite／**80 tests passed**。
- boundary：`selected=25 edges=59 forbidden=0 directRawComparison=0`。
- negative public-surface compile：exit 0，所有 `@ts-expect-error` 反例均被消耗。
- build/typecheck：exit 0；各 test script 內建置及獨立 `npm run build` 均 exit 0。
- coverage：9 suites／189 tests passed；aggregate **54.45% statements／56.55% branches／51.71% functions／57.04% lines**；operation-registry file 為 **95.08% statements／91.97% branches／100% functions／96.50% lines**。coverage 是觀察值，不是 release threshold。
- host read-only `git diff --check`：exit 0。

Source／test fingerprints（working tree，非 clean source commit）：

```text
package.json                                      e8bf39fb689fd3acc478cde451fb8b607d9ee2b15965fcc04241299ca8bb6fdb
package-lock.json                                 70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b
src/access/application/internal/operation-registry.ts a4e2097775f7881564288e9ff2fc15eeaaf350c9f6f05f91ce44350897c9bd91
src/access/application/internal/index.ts          c6163eb42b990a493baebf0fa4e746d40a63a83130cb7d0881d1e04f68116940
test/unit/g05c-operation-registry.test.ts         3193f5b49ab2cce652178da18dd2a6de90c891aa12ca3c646976cdcf5966d20b
jest.g05c.unit.config.cjs                         8ef0ab14c5c3b15cb7183e83451a2e9932e0b0f0dd71f75f07a5b600f703b739
tsconfig.json                                     b3b50b1fbb675b7c5960b103c6937faaaba0cf46c024866b885e8791f69d608f
scripts/check-g03c-boundary.mjs                   eec7fc28685b768d6ac316ac54b60899f41baa5855555d9e1dceb897121ef3de
scripts/check-g03c-negative-compile.mjs           b7e1101571ae925b94d9763ded648bd47d09337762bc56dbbb7142c2b42238f4
```

既有 G04a／G04b 真 Mongo evidence 仍引用 `docs/evidence/g04a/report.md`／`docs/evidence/g04b/report.md`；本 gate 沒有把 host Mongo 9／57 證據重新標成 G05c，也沒有把 G05c unit primitive 冒稱 adapter 或 integration。

## Requirement disposition and limits

完整 requirement V 維持 **10**：A01（既有）＋A11–A16、B13、B41、B42（G04b 新增9）；完整 requirement U 維持 **126**。G05c 不新增完整 requirement V。

以下逐項仍為 U，不能由本 primitive 解鎖：

- **B33–B36**：registry key／join／conflict／replay primitive 已測，但尚未完成 G05a／G05b／G05c composition、完整保存／use-case、canonical Event 回放及並行 ingress。
- **L05–L13**：epoch／claim／unknown／late-callback fence 只在 opaque registry primitive；尚未完成 full admission、HTTP lifecycle、writeRunClaim Mongo atomic state、safe continuation 與完整用例接線。
- **L20–L21**：technical terminal／late callback state machine 只是假資料 result reference 與 generation fence；沒有 G10 真 driver／transport-loss／no-late／safe-terminal 證據。
- **L28–L36**：4096 registry bounded retention 不等於 D148／D149 四資源同步準入、HTTP／connection／query／rate capacity、ordinary restart maintenance 或 G11 reset。

仍明確 out of scope：G05a／G05b／G05c composition wiring、Mongo `writeRunClaim` atomic lifecycle、FIFO ingress、budget／seven-slot driver wiring、G06 auth、G07 HTTP/raw/admission/capacity、G08 use-case／Event／Presence wiring、G10 driver send／unknown commit／abort／transport loss／confirmation protocol、G11 maintenance/reset。不得宣稱 HTTP／v1 完成。

## Stop and handoff

依 25 STOP，停止於 **G05c**；下一合法 gate 為 **G06a**，本次不開始 G06a。下一 gate 必須重新驗證前述需求原文、接線及環境，不得把本報告的 51 cases、coverage 或 bounded registry 當完整 release evidence。
