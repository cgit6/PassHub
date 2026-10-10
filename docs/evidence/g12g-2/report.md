# G12g-2 Mongo capability verifier 分離

狀態：**PASS（真 Local capability／Atlas 分支邏輯限定證據；非 Atlas 相容或部署證據）**

## 完成範圍

- production Mongo 連線成功後進入固定 `MONGO_CAPABILITY` stage，並在 dataset composition、process identity／ticket、durable claim及 HTTP listen 前恰好呼叫一次 profile-specific verifier。
- `LOCAL_SELF_HOSTED` 固定依序執行 `buildInfo`、`hello`，要求 MongoDB exact `8.0.32`、`rs0`、writable PRIMARY及exact一個非空host。
- `ATLAS_MANAGED` 只執行 `hello`，要求 writable PRIMARY及正safe-integer `logicalSessionTimeoutMinutes`；不讀取或鎖定 build patch、`setName`、`hosts`、`msg`。
- verifier不執行insert／update／delete／repair／create schema／index。既有 `inspectExistingG04bSchemaReadOnly` 繼續負責schema／index inventory與snapshot transaction唯讀驗證，public application沒有取得建立或修復schema的能力。
- driver及topology錯誤收斂為固定 `MONGO_CAPABILITY_VERIFICATION_FAILED`，不保留或輸出cause、URI、host、version、raw reply。engine importer只允許production-private facade與test support，亦未由public barrel／package export。
- 真Local integration在任何schema、seed或drop操作前先以fail-closed target guard限定exact `127.0.0.1:27029`、`replicaSet=rs0`及`passhub_g12g2_<positive digits>`隔離資料庫；正負矩陣共12 cases。
- Local runtime runner為每次程序配置可預測且唯一的test container及Compose project名稱；正常、`SIGTERM`、`SIGINT`三條直接可執行測試均驗證只清理該container／project的container、network及volume，不碰無關資源。
- G12g-1建立的requirements checker mutation harness已改為從當前active status動態推導相鄰子關，不再硬鎖g-1→g-2；其輸出明示為G12g-1建立的回歸工具。

## 驗證結果

- Exact toolchain：Node `v24.21.0`、npm `11.19.0`。
- `npm run test:g12g2`：2 unit suites／37 tests、boundary PASS、runner safety正常／`SIGTERM`／`SIGINT` 3 cases PASS，以及真 MongoDB `8.0.32` integration 1 test PASS。
- 真Local integration驗證exact版本／拓撲、snapshot read concern與commit transaction；verifier＋既有唯讀schema inspector執行前後dataset snapshot相同，受監測區間無mutation command，測試後完成isolated database與Docker資源cleanup。
- Exact toolchain完整unit：85 suites／1387 tests PASS。
- Local回歸：G11a Docker runtime 8／8、G11b dirty-development production runtime 12／12、G12f static 17／17、G12f Docker Demo 8／8 PASS。
- `npm run test:g12g1`：G12g-1既有65 tests、boundary、動態checker regression及143-ID requirements baseline PASS；輸出完成子關為G12g-2、下一子關為G12g-3。
- `git diff --check`：PASS。

詳細摘要、來源狀態、工具版本、結果與檔案指紋見 `runtime.json`。

## 證據限制

- 本次受測工作樹以HEAD `8322ce3d7f859212b0c35b6fac2ec057fcf0b669`為基底，包含尚未提交的G12g-0至g-2差異；這是development-gate evidence，不是clean release evidence。G11b runtime明示為dirty-development回歸。
- Atlas verifier的正負矩陣使用mock command runner，只證分支、命令白名單、拒絕條件與去敏；沒有連線真MongoDB Atlas，不能算Atlas managed相容證據。
- 沒有建立或驗證Atlas Compose、credential分離、SRV／TLS／auth、真Atlas transaction、read-only descriptor mount、initializer、publisher、blue／green reset或公開HTTPS。
- M13只有Local與Atlas branch局部證據，仍維持`U`；真Atlas部分留G12g-4，跨profile等價留G12g-6，最終release留G12h。
- 下一合法子關為G12g-3；本gate不修改雙Compose或開始其實作。
