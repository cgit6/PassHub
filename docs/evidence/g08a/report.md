# G08a 管理用例及完整保存驗收報告

- 驗收日期：2026-09-26
- 結論：PASS；依 25 STOP 停止於 G08a
- 下一合法 gate：G08b（尚未開始）
- 受測工作樹基準：HEAD `8725af3b876a5c6b093b010b97e524f447744d9c` 加本關未提交差異；不是 G12 所要求的 clean source commit
- 主機：Linux、Node v24.12.0、npm 11.6.2
- 真 Mongo 驗收容器：`node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`，Node v24.21.0、npm 11.19.0；MongoDB 8.0.32 replica set `rs0`

## 1. Gate 範圍與裁定

G08a 只驗證管理用例及其完整保存，不驗證完整辨識、查詢、故障確認、維護或部署。專案經理獨立對照 `business-scope.md`、`implementation-plan.md`、`requirements-traceability.md`、`discuss.md`、production diff 與正式測試，未發現阻塞本關的 production defect。

通過的管理契約：

- 人員認證後只允許目前角色為 Operator 執行建立、修改及撤銷；Viewer 為 403、無效 token 為 401、認證依賴故障為 503。
- CREATE 僅接受 displayName、canonical validFrom／validUntil 及明示的 `face: null | {provider, externalSubjectId}`；PATCH 只更新實際提供的非空子集；撤銷理由必填。
- Face provider／subject 採精確原值及既定 grammar／UTF-8／控制字元界線；不 trim、normalize 或擴張 provider 管理能力。
- QR 由 server 建立，只有 CREATE 201 回傳 43 字元 token；PATCH／revoke 及安全摘要不回 token、incarnation 或 version。
- public result 以 CREATE／UPDATE／REVOKE discriminator 回傳；摘要只含既定 Qualification 狀態欄位及有效 `faceBound`。
- 未入場逾期在管理操作中惰性持久化終結並釋放 Face，再回可辨識的已知業務衝突；這不是 unknown effect。
- Face create／PATCH 使用目前 qualification incarnation／version 做新鮮度保護；duplicate、capacity 4096、釋放後重用及衝突皆維持交易原子性。
- 管理操作沿用 G07b 同步準入的 `receivedAt`／sequence 與 G05a FIFO；慢認證情境不讓後到管理寫入超車。
- 已知無副作用錯誤可安全結束；不能證明是否生效的持久化錯誤映成 `UNKNOWN_EFFECT`，交由既有 G07b fail-closed owner 停止後續 writer，不假稱管理失敗或成功。

## 2. 正式驗證

| 驗證 | 命令 | 結果 |
|---|---|---|
| G08a 完整 gate | `npm run test:g08a` | PASS：unit 52／52、true HTTP e2e 12／12、true Mongo integration 10／10、boundary、negative compile及各階段build全通過 |
| 覆蓋率 | `npm run test:g08a:coverage` | PASS：3 suites／74 tests |
| 全部 unit 回歸 | `npm run test:unit` | PASS：15 suites／479 tests |
| 文件／差異 | `git diff --check` | PASS（文件封存後重跑） |

G08a boundary 結果：`files=5 edges=22 publicLeaks=0 forbidden=0`。負向編譯驗證管理內部能力、raw scope／plan及秘密欄位未成為 public API。

覆蓋率（statements／branches／functions／lines）：

- G08a aggregate：79.00%／73.91%／84.61%／82.28%
- `src/access/application`：69.64%／65.75%／86.66%／71.02%
- G08a management composition：87.97%／79.72%／90.00%／94.77%

這些數字只描述 G08a 選定 suites，不是整個 repository 的全面高覆蓋，也不是 136 項需求完成率。

## 3. 真 Mongo 情境

10 個 integration cases 直接使用 MongoDB 8.0.32 replica set，涵蓋：

- create／PATCH KEEP-null-set／revoke 的完整資料生命期與 trusted receivedAt。
- not-found、無效時間窗及 INSIDE／EXITED／已撤銷不可變，失敗不留下部分寫入。
- 未入場逾期終結與 Face 釋放共同保存。
- duplicate Face 建立整筆回滾，釋放後相同 subject 可重用。
- stale Face incarnation fail-closed。
- 第 4095／4096／4097 容量邊界、counter／schema／index 一致及釋放槽重用。
- 並行相同 Face create 最多一個成功，輸家不留孤兒 Qualification。
- commit／persistence error 的 known-no-effect 與 unknown-effect 分類。

上述是有限、可重跑的測試證據，不等同真 transport-loss／commit ambiguity 已完成；後者仍屬 G10。

## 4. 需求矩陣裁定

本關將以下三項由 U 升為 V：

- B04：管理輸入 exact DTO、未知／重複欄位拒絕與 server QR。
- B09：Face 精確鍵規則、Operator 合規預綁及不由辨識建立映射。
- B19：入場前永久撤銷、必填理由、原因／時間／Face 釋放完整保存，以及無 delete／reactivate 表面。

矩陣目前為 13V／123U。B05、B06、B10–B12、B15–B18、B20、B22–B24、L01–L02 等雖新增局部證據，仍因未來查詢／辨識／競爭／日誌或其他表面尚未完整驗證而保持 U；不得由測試數量升格。

## 5. 明確未完成

- G08b：QR／Face／UNKNOWN 的正式辨識處理鏈、Event、回放／conflict及並行通行。
- G09：資格／在場／Event安全查詢、cursor與效能實驗。
- G10：allowlist logs、私密控制、native abort與真 transport unknown確認。
- G11：Docker／HTTPS／公開部署、每日維護與reset生命期。
- 正式 OpenAPI、CI、clean-install、Demo及G12逐136要求完整release audit。

因此本關停止於 G08a，不開始 G08b，也不解鎖「完整 PassHub 已完成」或部署成果敘述。
