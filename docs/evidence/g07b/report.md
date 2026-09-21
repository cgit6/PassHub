# G07b 同步準入與 HTTP 等待生命期 — 限定 gate evidence

## 判定

G07b **PASS**。架構師完成三輪獨立 review 後判定 PASS；independent tester final gate PASS；PM另對照業務規格、實作方案、136要求矩陣、production與正式測試，未發現業務邊界偏移或 production blocker。

本關只交付內部技術 admission composition seam：十條業務路由分類、dataset epoch／`existing-only`入口、同步資源分池、provisional FIFO、registry reservation／join／replay／conflict、fixed-minute rate、五秒一次回覆 owner、opaque work handoff與 unknown recognition handoff。validator與實際工作均為注入 port；本關沒有交付正式 G06 Auth route、G08 management／recognition use case、Access Event／Presence／Mongo接線、G05b execution／confirmation ledger接線、G10 driver／故障確認、G11維護或部署。

依25 STOP停止於 **G07b**；下一合法gate為 **G08a**，尚未開始。

## Contract and implementation

- `business-route-classifier.ts`只辨識D150的十條exact method/path；`existing-only`只允許辨識路由。寫入先驗dataset epoch，missing／malformed與mismatch分開，readonly／stale claim不開新寫入。
- `admission-resource-ledger.ts`固定HTTP普通28／retry4、validation普通寫4／login1／query1／retry2、origin32，以及scrypt1／queryDB1／canonical replay2／original confirmation1。lease逐一釋放，無全域`releaseAll`或借池。
- normal writer先同步取得資源；recognition另取得registry reservation，再建立provisional FIFO receipt。async validator較慢時，後到writer不可超車；login／query不被排入writer FIFO。
- `operation-registry` reservation與既有entry共同計入4096容量；new／join／canonical replay／safe terminal replay／conflict都消耗或釋放candidate reservation，foreign與double release fail-closed。`existing-only`只lookup既有項，永不建立新項。
- registry key facts只由issuer的`assertKey`取得；202進度中的`sourceId`／`externalEventId`不信任validator自述。normal recognition在FIFO head才完成registry決定；same artifact不二次執行，different artifact回conflict。
- `http-response-owner.ts`從receipt monotonic time計五秒，completion／deadline／close只能有一個回覆owner；HTTP結束只釋放本次HTTP lease，不取消已admit work。
- 回覆使用opaque、issuer／epoch綁定的response plan；payload先複製、freeze、canonical render並限制64KiB，拒絕proxy、accessor、thenable、cycle、raw Error與非canonical值。
- fixed-minute rate固定login 5/IP、20 global、IP map 256；query 60/account、120 global；recognition 30/source、60 global；management 10/account、20 global。clock rollback／reentry令所有類別fail-closed。
- recognition發生unknown effect時保留origin、registry轉UNKNOWN，並把opaque confirmation lease／operation context／observation reference交給factory-owned coordinator；G07b不自行執行G10確認。
- G07b只接受native exact Promise依賴並防reentry／hostile thenable；internal symbols不由root public surface或package export公開。

## Review findings and fixes

架構 review 共三輪。前兩輪要求修正的核心問題包括：

1. 辨識進度曾可能使用與registry key不同的欄位來源。修正後所有可信key facts只由captured issuer的`assertKey`產生，202與registry操作使用同一份facts。
2. 舊版mismatch schema可能先claim work token或留下provisional／registry殘留。修正為先做canonical validation，foreign key或key mismatch在token claim與provisional activation前拒絕，且不留下資源／registry殘留。
3. canonical replay／trusted 202與unknown handoff的provenance、一次性及釋放路徑逐一收緊；有效join仍使用真實registry key facts，unknown只交給未來G10 owner。

第三輪architecture確認上述修正、G05a／G05c回歸、valid join、foreign／mismatch負例及resource歸零後判定PASS，才啟動formal tester。

## Exact verification

正式驗收使用固定Node映像：

```text
node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
```

正式命令集合：

```bash
npm run build
npm run test:g07b:unit
npm run test:g07b:e2e
npm run test:g07b:coverage
npm run test:g07b:boundary
npm run test:g07b:negative-compile
npm run test:unit
npm run test:g05a
npm run test:g05b
npm run test:g05c
npm run test:g07a:unit
npm run test:g07a:e2e
git diff --check
```

結果：

- G07b unit：2 suites／**40 tests passed**。
- G07b true Node／Nest／Express HTTP e2e：1 suite／**5 tests passed**。
- G07b combined：3 suites／**45 tests passed**。
- Full unit：14 suites／**427 tests passed**。
- 回歸：G05a **21**、G05b **80**、G05c **51**；G07a unit **32**、true HTTP e2e **41**，全部PASS。
- G07b boundary：`files=8 edges=17 servers=1 publicLeaks=0 forbidden=0`。
- G07b negative public-surface compile、build及diff check均PASS。
- G07b coverage aggregate：**71.34% statements／71.56% branches／86.70% functions／74.09% lines**。
- `g07b-admission-handler.ts`：**60.22% statements／60.77% branches／77.92% functions／62.52% lines**。

上述coverage是分支觀察，**不是全面高覆蓋，也不是requirement完成率**。特別是正式Auth／Access／Mongo、G05b ledger與G10/G11未接，因此不能由45個G07b tests或coverage百分比推論完整v1已完成。

## Tested scenarios

- 十路由exact method/path、固定路由優先、query忽略、trailing slash／方法變體拒絕，以及retry mode只限recognition。
- admission各pool、不借池、bundle acquire失敗回滾、foreign／double release；ancillary N/N+1。
- registry 4096 reservation／4097拒絕、entry與reservation共用容量、reserved new／join／replay／conflict及readonly write拒絕。
- slow-head provisional FIFO、同毫秒sequence、較後prestart rejection、unknown阻擋及hostile lifecycle thenable。
- fixed-minute per-key／global／IP map 256、minute rollover、clock rollback與reentry全域freeze。
- opaque route-scoped one-shot work token、opaque response plan provenance／snapshot／body limit、unknown receipt offer／accept／take一次性。
- response owner receipt age、deadline、late callback、close、preclosed與reentrant write的single response／exact-once HTTP lease release。
- 真HTTP epoch拒絕、slow writer FIFO且query獨立、normal recognition canonical replay／conflict、unknown後existing-only回`PAUSED_UNKNOWN`，以及client disconnect不取消admitted work。

## Source fingerprints

基準Git commit為`3d8bf1b0c98a983007b1936f20d071a4b85ac443`；以下為受測working-tree fingerprints，不冒稱clean source commit：

```text
src/access/application/internal/operation-registry.ts             30a3c5cc90abaf40a599e2e6d36198c3f13c6dda71849d8dba4750f9ac247cc8
src/access/application/internal/write-operation-coordinator.ts    db365d90559d476f8e244b74dac4cbc4d3bb40ab1d34f746a36edc079f7116d1
src/composition/internal/admission-resource-ledger.ts              f52bdf1afe82cf4b1e781dd2ff8445bf2cfd5b7c673d283a9fd6420a7f9aeb10
src/composition/internal/admission-work-handoff.ts                 5eefde4db70a45b5e85efa7edddf1f33d54b412f1bae8b64f23ca12456959eb1
src/composition/internal/fixed-minute-rate-ledger.ts               462cef50840a86c908f2a7a8d0265413c46b38a8350707f8d98c42621d8a222c
src/composition/internal/g07b-admission-handler.ts                 f961d2251428e5ff5c53dd9e767a06700708f7e2838b7ff824a0e2dfc97cecab
src/composition/internal/http-response-owner.ts                    1703c2b71117c5e33550fd1d08496c4dbfc73608ca44cd3c4ec7fbb5d718edff
src/composition/internal/http-response-plan.ts                     7020d3ac678ad2bc99620860ce4a4f396d20a8d4ea2424f7f7a90d1232c5107e
src/composition/internal/unknown-recognition-coordinator.ts        133668792c2c1f1697fec90b605c0373e98b82d721d8788f6dc8727834ad9671
src/shared/internal/http/business-route-classifier.ts              2bb8f7f32f529cfb3c60ce9d4d07d366128c55056af85f9f6a3eea5a66bc8a69
test/unit/g07b-admission-primitives.test.ts                        df8406bffcb2282872c5e4f477d2c9c64e430b3729045ac9b6a441f673256b5b
test/unit/g07b-g05-regression.test.ts                              ee1694284a4ff17e57851df2e3a7e7572f7dd4e44650c7e0c2e535297683dd0c
test/e2e/g07b-admission-http.test.ts                               7bd4502fdbe01db795a8a177dbb4450cb32c132b498adc13f5a7e68492a32207
test/negative/g07b-public-surface.ts                               7bb98e8826bc075175dca46defa60b46712678505ea0f1e6805b75135e29ad6c
scripts/check-g07b-boundary.mjs                                    9b7cfe9223081dce15cdfd20de91bc27ab37fae5f6ed5c4fc398fbeb32cc9ad5
scripts/check-g07b-negative-compile.mjs                            a5990e7bb8edcbb9d813e765c7881b1789bbbca517be3f958f4586dc5f2e15a2
jest.g07b.unit.config.cjs                                          b69186a683c2cb73625b46cdc66602db6464b841fc740d28747293e76ec2cf39
jest.g07b.e2e.config.cjs                                           21e53eed243789875b5b8ab4feaf6360757c3d59d9155621791740f9129ffd63
jest.g07b.coverage.config.cjs                                      dea64f4f70c8df328774a8fb261c55d86b4096c9019183be49db95d735523097
package.json                                                       4559354cfef9760df517911bb70a48e0732ef9d60b6dbd7dbdde4f3e30517b8c
package-lock.json                                                  70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b
```

## Requirement disposition and limits

完整requirement維持 **10 V／126 U**；G07b不新增完整requirement V。

- L01–L02、L05–L06、L24–L32、L35–L36及M04取得可重跑的局部技術證據，但正式Auth／Access／Mongo與後續故障、維護、部署責任尚未閉合，因此維持U。
- B22–B28與B37–B43仍U：本關沒有把G06a／G06b primitives接成正式路由權限，也沒有形成或保存真正Access decision／Event／Presence。
- E01、E03、E06仍U：本關有unit、true HTTP、boundary與negative compile，但不等於全136要求、真Mongo業務鏈、fault、maintenance、deployment或release evidence。
- G05b尚未接入G07b handler；execution 15秒／3輪、confirmation 10秒／7格及真driver cadence不能宣稱完成。
- unknown coordinator只是交接給未來G10 owner；本關沒有執行canonical確認、abort或transport-loss恢復。
- 沒有公開部署、OpenAPI、Demo client、每日reset或完整作品流程；履歷成果仍未解鎖。

## Stop and handoff

依25 STOP，停止於 **G07b**。下一合法gate為 **G08a 管理用例及完整保存**；G08a尚未開始，PM本輪只修改`docs/**`，未修改production、tests、package或lockfile。
