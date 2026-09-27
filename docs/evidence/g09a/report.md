# G09a 安全查詢與 keyset 限定驗收報告

- 驗收日期：2026-09-27
- 結論：PASS；依25 STOP停止於G09a
- 下一合法gate：G09b（尚未開始）
- 規劃基線：`d731e467c7d1385cb3195373baed80259abaecaf`
- production／test commits：core `1f55d3f`、Mongo adapter `ce6c74c`、HTTP composition `2186721`
- 受測source commit：`218672173735e93f3610e9a57debbbaccaae8a45`
- 證據性質：source commit上的production／tests，加本報告所在未提交docs working revision；不是G12要求的clean sourceCommit release evidence，也未建立新commit

## 1. Gate範圍與獨立裁定

專案經理逐讀D180、業務規格§8、實作方案G09a、矩陣B44–B50／A17–A18／M04／E項，以及目前production、tests與四個基線commit。未發現阻塞G09a的production defect。

本關直接驗收：

- Operator與Viewer可使用Qualification list／detail、INSIDE list、Event list／detail五條唯讀路由；Source及未授權角色不可使用。
- writer處於`PROVISIONAL`、`QUEUED`、`RUNNING`、`BLOCKED`或`UNKNOWN`時，query立即503 `TECHNICAL_BUSY`且DB 0 calls；writer quiescent時取得短read-observation lease，固定單一`observedAt`，後到writer可登記但必須等lease釋放才按FIFO開始。
- query不取得writer owner、不寫DB、不做cleanup；失敗路徑釋放lease。`expired`與`faceBound`由同一觀察形成，逾期`INSIDE`仍保持有效綁定投影。
- 三個list回`items`／`nextCursor`業務payload，空頁／末頁為`null`；兩個detail直接回單item。HTTP共用層另帶`currentDatasetEpoch`。
- Qualification投影exact keys、Event安全投影、UTC毫秒ISO日期、可空欄位及秘密遮蔽；Mongo projection不回QR digest、完整subject、externalEventId、HMAC、comparison reference、incarnation或version。
- 三種keyset排序、同時間ID tie-breaker、limit+1、limit不綁cursor、canonical unpadded base64url、route／filter／epoch binding及八種Event filter presence組合AND。
- 合法UUID查無Qualification／Event detail為404 `RESOURCE_NOT_FOUND`；格式／cursor／scope錯誤400；舊epoch 409；已認證Mongo read或投影異常503 `PERSISTENCE_UNAVAILABLE`且不回partial／null。
- request仍16KiB；成功response超過256KiB時fail closed，不洩漏被截斷資料。limit預設20、最大100。

## 2. 正式驗證

PM在source commit `2186721`上執行：

| 命令／驗證 | 結果 |
|---|---|
| `npm run test:g09a` | PASS：unit 3 suites／92；true HTTP e2e 1 suite／13；true Mongo integration 2 suites／16；合計121 tests；boundary及negative compile全通過 |
| `npm run test:unit` | PASS：19 suites／613 tests |
| `npm run test:g09a:coverage` | PASS：4 suites／105 tests |
| `npm run test:g04b` | PASS：真Mongo 8.0.32，1 suite／57 tests |
| `npm run test:g07a:e2e` | PASS：41 tests |
| `npm run test:g07b:e2e` | PASS：5 tests |
| `npm run test:g08a:e2e`／`test:g08a:integration` | PASS：12 true HTTP／10 true Mongo tests |
| `npm run test:g08b:e2e`／`test:g08b:integration` | PASS：6 true HTTP／3 true Mongo tests |
| G09a boundary | `files=10 edges=35 publicLeaks=0 forbidden=0` |
| G09a negative public-surface compile | PASS；expected errors全數被消耗 |
| production build | PASS；各正式命令的build及封存前獨立build均成功 |
| probable-secret pattern scan | PASS；`src`／`test`／`scripts`／package files無private-key、AWS access key或credentialed Mongo URI pattern命中 |
| `git diff --check`／文件一致性 | PASS；封存完成後重跑 |

正式Mongo runners使用：

- Node：`node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`，Node `v24.21.0`、npm `11.19.0`。
- MongoDB：`mongo:8.0.32-noble@sha256:01354084d2ae665d2e79b79b0cdc50c2c0c98873618912d9a2c8c9cb5c3d24e6`，單成員`rs0`且為writable primary。
- runner結束後G09a、G04b、G08a與G08b測試container／network均已移除；驗收結束沒有上述專案容器或volume殘留。

## 3. Coverage

G09a選定unit／HTTP suites的aggregate coverage：

- statements：88.21%
- branches：86.40%
- functions：98.38%
- lines：94.01%

這是四個G09a coverage suites、105 tests觸及的production範圍，**不是repository全面高覆蓋、不是136項要求完成率，也不包含真Mongo coverage instrumentation、G09b效能、G10故障／控制／日誌或G11部署**。coverage輸出目錄已移至系統垃圾桶，不留在workspace。

## 4. 需求矩陣裁定

矩陣結構審計維持136個unique requirement IDs且無重複。G09a只將具有完整、直接、可重跑證據的下列6項由U升為V：

- **B44**：五條最小查詢、兩人員角色相同讀取、INSIDE清單與list／detail／404契約。
- **B45**：Qualification固定`createdAt + ID`降序keyset，拒絕額外filter／搜尋／排序參數。
- **B46**：Event三篩選AND、八種presence組合、`receivedAt + ID`降序及strict query。
- **B47**：三list keyset、limit 1–100、canonical cursor、route／filter／epoch binding及同時間跨頁。
- **B48**：Qualification exact安全投影、單一`observedAt`的`expired`／`faceBound`、逾期INSIDE及秘密遮蔽。
- **B49**：query list／detail與G08b recognition共用exact安全Event投影，包含無Qualification Event且不洩漏比較資料。

矩陣由22V／114U變為28V／108U。

下列要求只增加局部證據，維持U：

- **B50**：G09a查詢表面已驗去敏，但G10安全／技術日誌與全部輸出表面尚未閉合。
- **A17**：G09a證明唯讀不cleanup及觀察投影；完整相關寫入惰性整理、準時競爭與全部DB生命期仍跨gate。
- **A18**：read lease與單writer協調已有直接程式證據，但單API部署及完整writer／故障生命期尚未驗收。
- **M04**：page／response限制已有證據；trusted proxy、公開部署與完整防濫用表面仍屬後續。
- **E01／E06**等作品／分層驗收要求只取得G09a切片，仍未完成完整API、release與全部gate證據。

## 5. 明確限制與STOP

G09a沒有開始或證明：

- G09b固定10k Qualification／40k Event、八種filter case、索引前後raw samples、p50／p95及`explain`效能實驗。
- G10 allowlist logs、私密hold／release／drain、native abort／cleanup、真正transport-loss及unknown確認／續辦。
- G11 maintenance、每日reset、NGINX／systemd、Docker部署與public HTTPS。
- OpenAPI完整契約、clean install、CI、公開Demo、G12逐136要求release audit或完整v1。
- 跨頁snapshot保證；D152明確只提供keyset，資料變動時使用者可能需要刷新第一頁。

因此只可宣稱「G09a限定安全查詢與keyset已通過」。正式STOP移至G09a；下一合法gate為G09b，尚未開始。
