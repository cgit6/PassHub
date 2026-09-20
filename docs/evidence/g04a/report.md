# G04a Face reverse-unique transaction integration evidence

狀態：**通過（窄 G04a gate）**。本證據只覆蓋 `faceSlots` 微型實驗與真 MongoDB 交易，不宣稱完整 Mongo adapter、G04b 原子保存、HTTP、Nest controller、Event／qualification repository 或完整 v1 已完成。

## 固定環境

- Node image：`node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`
- Node／npm：`v24.21.0`／`11.19.0`
- Mongo image：`mongo:8.0.32-noble@sha256:01354084d2ae665d2e79b79b0cdc50c2c0c98873618912d9a2c8c9cb5c3d24e6`
- Mongo URI：`mongodb://127.0.0.1:27028/?replicaSet=rs0`
- Mongo topology：`rs0`、writable primary、advertised hosts exactly `['127.0.0.1:27028']`
- driver：`mongodb@7.6.0`（lockfile exact）

## Formal commands

先啟動並初始化真 single-member replica set：

```sh
docker compose -f infra/g04a-mongo-compose.yml up -d
node scripts/g04a-init-replica-set.mjs
```

精確 Node image 中執行 clean install、compile、unit 與 integration：

```sh
docker run --rm --network host \
  -v "$PWD":/workspace -w /workspace \
  node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 \
  bash -lc 'node --version && npm --version && npm ci && npm run build && npm run test:unit && G04A_MONGO_DATABASE=passhub_g04a_pinned npm run test:integration'
```

結果：`npm ci` added 423 packages／0 vulnerabilities；`npm run build` exit 0；unit **6 suites／37 tests passed**；integration **1 suite／9 tests passed**。

日常可重跑的 orchestration script 為 `npm run test:g04a`，會啟動 compose、執行 readiness initializer、執行正式 `test:integration`，最後移除其 compose container/network。

## Covered assertions

1. readiness 精確核對 MongoDB `8.0.32`、`setName=rs0`、`isWritablePrimary=true`、單一 advertised host。
2. `listIndexes()` 核對 `(provider, subject)` unique、`qualificationId` unique partial `$type: "string"`；case variants 可共存以驗證 simple exact-key semantics。
3. 兩個以上 null qualification 空槽共存；array、missing 欄位及兩種 null/scalar pairing 均由 validator 以 code `121` 拒絕。
4. release-first 同一 transaction／session：writer 讀到新狀態；另一 client 的 commit 前 majority read 仍為舊 mapping；commit 後 majority read 為新 mapping。
5. bind-first 真實 `E11000`（code `11000`）在 stage `reverse-bind-first`，交易完整 rollback。
6. provider+subject duplicate 與 qualification duplicate 均為 stage `bind` 的 `E11000`，兩者均保持 seed 狀態與 version。
7. injected abort 在 release 後觸發，舊 mapping 與版本完整 rollback。
8. 兩個真 driver session 經 bounded barrier（8 秒 timeout）並行 bind：最多一個 commit，最終恰有一個 parallel binding；失敗分類記錄 stage `bind`，實測 code `112`、label `TransientTransactionError`、kind `WRITE_CONFLICT`。
9. 以另一真 client `killSessions` 使 transaction 在 commit 取得實際 code `251`／label `TransientTransactionError`，分類為 stage `commit`／`TRANSACTION_ABORTED`；不把 251 或 112 誤標為 duplicate。

所有 transaction write/read probe 均由同一 session 串行執行；suite 未使用 mock、in-memory Mongo 或 fallback index。

## Evidence SHA256 (worktree at gate)

```text
infra/g04a-mongo-compose.yml                    c6e1ad17bd04991357f159674f2349b5c962cb4f5620d552caef83fc5862fc88
infra/toolchain-images.json                     30d56ed9263d9a4c1c8e626624c1b34746e5c3b26eee65c45e75c52f8ef05395
package.json                                    437fd195808b0db12b16bbdd5978ac8d0082caad45a37eaaf5b02c56546e6789
package-lock.json                               70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b
jest.config.cjs                                 91a214d158039a446df507e74a4afb7a18ebb813496fea29a5833f9baa086bec
jest.integration.config.cjs                     a19f4d657848c9ba1a5bc8cd2c01c13e5970347e30f3f731cf108794c7a458df
src/infrastructure/mongo/g04a-face-index-schema.ts 9744a459b6c5d9dea1a4c4041960db71b9621592655b444d180fbd653232c39d
src/infrastructure/mongo/g04a-face-index-experiment.ts dd75418634515d25f72bf89c10a707567208b2db08750f72eb69427e609584e3
test/integration/g04a-face-index.test.ts       eb471847c34457606aa990431e3abf9f10acd9fcf9c0317304d569be84acfda4
scripts/test-g04a-integration.mjs               034585f995bea22535055927fc689c98e0c341ddf46bfa12981ab5ccd35b79f4
scripts/g04a-init-replica-set.mjs               993017161e3201653d0f53e14762c560c3a1927a535a75a27cc52a78c21742dd
```

Production source was not changed for this gate; the validator pairing correction was present before the integration rerun. G04b、HTTP、Event 及完整 adapter 仍未宣稱完成。
