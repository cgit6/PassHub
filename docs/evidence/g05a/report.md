# G05a FIFO operation coordinator —限定 gate evidence

## 判定

G05a primitive gate **PASS**。本關交付的是 Access application 內部、窄 capability 的寫入權協調器；它尚未接入 use-case、Nest/HTTP、Auth、Mongo adapter 或 registry，因此不宣稱完整 FIFO ingress 或 v1 完成。

## 契約與實作

- `src/access/application/internal/write-operation-coordinator.ts` 提供四個且只有四個寫入 channel：management create/update/revoke、recognition；login、普通唯讀、HTTP 與 raw parser 不進此 primitive。
- enqueue 會同步擷取 trusted `receivedAtMs`、產生 UUID `operationId`、配置單調 `bigint sequence` 並登記；executor 只在 microtask 中開始。四個 channel 共用一條 FIFO；慢前項未結算時，後項不會執行。
- context／owner 是 frozen、單次 operation 的 opaque authority。舊 owner、重複／非法 settlement、executor throw/reject、沒有 settlement 或 thenable 未收束，都 fail-closed 為 `UNKNOWN_EFFECT` 並永久阻擋後項。
- 合法 settlement 僅有 `PRESTART_REJECTED`、`BUSINESS_RESULT_PERSISTED`、`KNOWN_NO_EFFECT`、`UNKNOWN_EFFECT`；`PRESTART_REJECTED`／`KNOWN_NO_EFFECT` 是已知無業務效果並可安全前進，成功可解析並前進，未知不可前進。沒有 timeout、retry、resume、cancel 或 Promise.all。

這符合 D72–D78、D141、D146–D149 對同步登記、trusted clock／sequence、單一相關寫入權、未知停止及窄內部 capability 的要求。G05a 不負責 G05b budget／七格／confirmation，G05c registry／epoch／capacity/join，或 G07/G08 的 HTTP、Auth、use-case 接線。

## 驗收重跑

主機僅供診斷：Node `v24.12.0`、npm `11.6.2`，低於 lock contract 的 Node `24.21.0`、npm `11.19.0`，所以依 D125／G02 先以 exact image 重跑。

```text
node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
```

```bash
docker run --rm \
  -v /home/sean/PassHub:/workspace -w /workspace \
  node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 \
  bash -lc 'npm ci --ignore-scripts && npm run test:g05a && npm run test:unit && npm run test:boundary && npm run test:negative-compile'
```

結果：`npm ci --ignore-scripts` exit 0（423 packages、0 vulnerabilities）；`test:g05a` 1 suite／**21 tests passed**；`test:unit` 7 suites／**58 tests passed**；build 隨各 script 均 exit 0；boundary `selected=23 edges=57 forbidden=0 directRawComparison=0`；negative public-surface compile exit 0。`git diff --check` exit 0。架構 review PASS、independent tester formal 21/21 PASS 為本 gate 的 review inputs；PM 已在上述 exact image 獨立重跑。

本次 working-tree fingerprints：

```text
package.json cfafa66d6d9eef925ab1519620a0d07592352decb269efa5b5a07e28ebe073a1
package-lock.json 70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b
src/access/application/internal/write-operation-coordinator.ts 032017879f7f77e1cb239c8869dacd750a3e500bbb8e95b632e3f8f2c7c63a23
src/access/application/internal/index.ts 22f1f1b902a33589ab3ccdfb3bc3dc15ada8765fd49a07926463819de3a1372f
test/unit/g05a-write-operation-coordinator.test.ts 466d968461655608abff6f523426e1b20eda33d1469ac19193dd1bce9e521843
jest.g05a.unit.config.cjs 634360e84edeabe525c8979e5a7e0eb5d3d1ff4010094a834bcb636177d31416
```

## Requirement disposition and limits

No full 136-ID requirement is promoted to V by this primitive-only gate. L01–L04 (trusted ingress, complete FIFO wiring, ordering/business outcome), A18 (single deployed API), B15–B21 (full management/recognition), B37–B43 (cross-layer event/presence/mapping concurrency), and E06 remain U. The primitive is direct evidence for the G05a responsibility and a partial implementation input to L01/L02/A18, not completion of those requirements.

Still unverified: production use-case wiring, synchronous raw/HTTP admission, source authentication, idempotency registry/join, resource capacity, budget/confirmation, late callback/epoch fencing, Mongo/Event outcome, true transport loss, maintenance, deployment, and public HTTP/e2e. Next legal gate is G05b only after the parent gate sequence accepts this STOP; G05c/G07/G08/G10 remain locked by their own evidence.
