# G11b 持久寫入權與兩階段啟動證據

## 結論狀態

- b1–b3 工程切片：PASS。
- b4 nominal bridge／bootstrap／single-use ready：PASS（commit `20b8ab5`）。
- b5 production process/container：PASS（production code commit `b83559b`；final clean exact-toolchain run commit `ec9ca6e`）。
- G11b 整體 gate：**PASS，停止於 G11b**。
- 證據來源包含 b1–b3 commit `342f5efd3f23b25e563a02b4fbe332e7d973397e`、b4 commit `20b8ab5`、b5 production code commit `b83559b` 及 final clean run commit `ec9ca6e`。
- 本報告沒有納入主工作區既有的使用者修改 `src/access/domain/access-decision.ts`；該檔案未被本 gate 修改、staged 或提交。

## 本關範圍

G11b 建立維護流程可使用的 private one-use run ticket、read-only dataset verification、Mongo-backed persistent write claim，以及 response-loss 時的 fail-closed 語意；完整 G11b 另外必須接上 nominal WRITABLE bridge、opaque bootstrap receipt、single-use `authorizeReady` 與 production process/container。它不建立 marker／drain／API 或 Mongo 停機 controller、reset／seed、排程或公開 maintenance route；那些責任分別屬於 G11c–G11f。

## 契約驗收

- run ticket 是固定 private file 的一次性 bearer capability；ticket 內容只在本機 intake 與 process-local capability 中存在，不進 HTTP、一般 log、Mongo 或 evidence。
- verification 只接受 closed、完整且可驗證的既有 metadata；不修改業務資料，也不把 verification receipt 當成 service-ready。
- claim 只使用一個 Mongo `findOneAndUpdate` 類單文件 CAS：`_id=system`、`kind=system`、預期 `datasetEpoch`、`writeRunClaim=null`；不使用 upsert、transaction、read-before-write 或 adaptive retry。
- CAS 只寫入 `{runId, claimedAt: $$NOW}`，要求 primary、`w=majority`、`j=true` 及 bounded timeout；ticketId 不進 Mongo wire。
- 明確的合法 post-image 才能回報 `CLAIMED`；零 match 只能做一次 majority classification read。timeout、transport、ack 或 shape 不明均為 `CLAIM_UNKNOWN`，不能 retry、不能 takeover、不能清 claim。
- same-epoch ordinary restart 不能搶占既有 claim；同一 run ticket 重用在 Mongo I/O 前拒絕。

## 正式命令與結果

以下 b1–b3 命令在 source commit `342f5ef` 的工作樹執行；b4／b5 使用各自列出的 clean source commit。所有 command exit code 均為 `0`。

| Slice | 命令 | 結果 |
|---|---|---|
| b1 | `npm run test:g11b:b1` | 1 suite / 54 tests |
| b2a | `npm run test:g11b:b2a:unit` | 1 suite / 4 tests |
| b2b | `npm run test:g11b:b2b:unit` | 1 suite / 31 tests |
| b3a | `npm run test:g11b:b3a:unit` | 1 suite / 30 tests |
| b3b unit | `npm run test:g11b:b3b:unit` | 1 suite / 10 tests |
| b3b Mongo | `npm run test:g11b:b3b:integration` | MongoDB 8.0.32 rs0；1 suite / 6 tests |
| b3c-a | `npm run test:g11b:b3c-a:integration` | MongoDB 8.0.32 rs0；16 distinct competitors；1 suite / 1 test |
| b3c-b | `npm run test:g11b:b3c-b:fault` | MongoDB 8.0.32 rs0 + Toxiproxy 2.12；1 suite / 1 test |
| b4 | `npm run test:g11b:b4:unit`、`npm run test:g11b:b4:http` | nominal bridge／bootstrap／single-use ready；commit `20b8ab5` |
| b5 unit | `npm run test:g11b:b5:manifest` | clean exact Node v24.21.0 / npm 11.19.0；6 suites / 33 tests |
| b5 process | `node scripts/g11/test-g11b-runtime.mjs` | clean exact process slice；12 cases；source commit `ec9ca6e`；見 `b5-runtime-clean-final4.json` |
| full regression | `npm run test:unit` | 64 suites / 1138 tests |
| text | `git diff --check` | PASS |

## 真實 Mongo 與競爭證據

- b3b 使用 pinned MongoDB 8.0.32 replica set，驗證 exact collection、filter、pipeline、majority+j、primary read preference、bounded timeout、無 transaction／upsert／retry，以及 metadata 除 claim 外保持不變。
- b3c-a 使用 16 個獨立 MongoClient、Db、verifier、genuine ticket 及 claimer 同時競爭；結果固定為 1 個 `CLAIMED`、15 個 `CLAIM_HELD`，Mongo 只接受一次 CAS，winner claim 以 BSON Date 持久保存。
- b3c-b 的 application client 只能走 Toxiproxy replica-set route，direct observer 走獨立 primary route。downstream timeout 在 CAS 前安裝；observer 在 response 被 withholding 時以 majority read 證明 canonical claim 已落庫，application 仍回 `CLAIM_UNKNOWN`。
- fault window 從 CAS 到 UNKNOWN、ticket replay rejection 及第二次 observer read 都受 command monitor 保護：target DB 所有命令及 admin `bulkWrite`／`commitTransaction`／`abortTransaction` 均被檢查，唯一允許的 application operation 是一個 exact `findAndModify`。wire 的 filter、pipeline、`$$NOW`、`$literal`、majority+j、timeout、禁止欄位及 ticketId absence 均閉合驗證。
- UNKNOWN 與 replay rejection 後第二次 direct-majority read 與 landed snapshot `deepEqual`，確認沒有 late clear、mutation、classification read 或 retry。

## 清理與去敏

- b3b、b3c-a、b3c-b runner 使用隔離且唯一的 Compose project，bounded teardown，並在 primary failure 與 cleanup failure 同時發生時保留兩者。
- b3c-b 移除並確認 Toxiproxy toxic、reset proxy connection、關閉 failpoint、刪除測試 database、清理 private ticket temporary tree、關閉 clients，並確認 project-scoped containers／networks／volumes 與 generated npm-cache volume 均不存在。
- 測試輸出不包含 ticket path、ticketId、datasetEpoch 或 processRunId；生產錯誤只暴露封閉 status/code。

## 去敏指紋

```text
sourceCommit=342f5efd3f23b25e563a02b4fbe332e7d973397e
trackedSourceManifestSha256=1761616465c7367232ac090eb0c16bf53c2c05ca83c96c43651f11ba4bb51ca6
packageLockSha256=70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b
node=v24.12.0
npm=11.6.2
```

## 覆核與未解鎖範圍

首輪架構覆核指出 fault 測試只觀察 `findAndModify`／`find`，可能漏掉 UNKNOWN 後的 late CRUD 或清 claim；修正版已擴大整段 command window、加入 exact wire assertions，並在 replay 後增加第二次 majority snapshot 檢查。PM、架構師與測試員重新覆核 b1–b3 及回歸測試均 PASS。

正式 b5 clean process evidence 見 `b5-runtime-clean-final4.json`：12 個 exact process IDs、sourceDirty=false、固定 production image、canonical claim／ticket consumption、local ready、真實 login/create/QR ENTRY/query、ordinary restart closed、post-claim failure closed、SIGTERM 後 API 正常退出、private socket 消失、API 對 Mongo 的連線歸零且 claim 保留、全 phase 去敏掃描及 project cleanup 均通過；Mongo process 的確停屬 G11c，不在本證據宣稱內。去敏掃描涵蓋 argv／env／container logs／rotated logs／HTTP response bodies（只有 login accessToken 與 create qrToken 的宣告 body 欄位被移除後再掃描，HTTP headers 仍完整掃描）／Mongo snapshot／production canonical 與 host ticket path and wire／final process evidence，並在 API 停止後重跑。development run 另保存於 `b5-runtime-development.json`，明確標示不作 clean evidence。

G11b aggregate manifest 見 `b5-manifest.json`：33 個 unit tests、9 個真 Mongo 情境（前 8 個為既有 adapter／fault evidence，第 9 個為 production process claim observation）及 12 個真 process 情境。既有 adapter UNKNOWN 證據仍限定為 adapter scope，不冒稱 production process 的 UNKNOWN boot；production 對非 `CLAIMED` 結果採 fail-closed。

G11b 不代表 G11c–G11g 或 G12 完成。尚未建立 persistent marker／drain／API 與 Mongo 確停 controller、七 collection reset／stable seed、新 epoch、host flock／systemd 03:00 排程、完整 fault／rerun matrix、綜合 maintenance manifest 或公開 HTTPS release。
