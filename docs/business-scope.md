# PassHub v1 業務邊界規格

- 文件狀態：業務與實作規劃已收斂；G02–G03c、窄 G04a、G04b 完整原子保存 adapter、G05a FIFO coordinator primitive 及 G05b budget ledger 已有各自限定工程證據，依25 STOP停止於G05b；完整v1工程驗證仍未完成
- 更新日期：2026-09-20
- 適用版本：PassHub v1
- 文件目的：以 D01–D35 為業務底稿，同步至 D157 的有效修正；實作細節及逐關驗收集中在 implementation-plan.md，不把官方查證、歷史候選或待做測試當成工程成果

原始依據見[討論紀錄](./discuss.md)，逐項實作及驗收對應見[要求追蹤矩陣](./requirements-traceability.md)。本文件的「已確認」是規格採用狀態，不代表程式／測試已完成。

## 1. 產品定位

PassHub v1 是一個**公開共享、每日重置的單地點訪客單次通行資格與辨識決策 API sandbox**。

Operator 為一次來訪建立限時 Qualification，取得只顯示一次的 QR credential，並可選擇預先綁定模擬外部人臉系統的 subject。受信任的 Recognition Source 將 QR token，或模擬的外部人臉辨識結果送入 PassHub。系統負責：

- 將 QR 或 Face 輸入映射至同一張 Qualification。
- 依 Source、Qualification 生命週期、有效時間與 Presence 形成固定結果。
- 以 `ACCEPTED`／`REJECTED` 與單一 reason code 回覆通行嘗試。
- 保存不可變 Access Event，並在必要時一致地轉移 Presence。
- 提供 Qualification、`INSIDE` Qualification 與 Access Event 的最小分頁查詢。

PassHub 只回傳通行結果，不控制門鎖，也不呼叫任何下游系統。公開使用者透過 OpenAPI 或 curl 操作共用 sandbox；系統不承諾資料隔離、持久性、正式個資治理、可用性或 SLA。

PassHub 是獨立設計的求職作品，不是任何公司或產品的相容實作，也不宣稱可直接用於正式營運。單次 Qualification 與 Presence 是 PassHub 為作品閉環採用的自訂業務模型，不得描述成參考系統的原樣重現。

### 1.1 v1 成功條件

v1 必須公開展示並可重跑下列核心閉環：

> Operator 登入並建立立即有效、含虛構 Face subject 的 Qualification → 保存建立回應中只顯示一次的 QR token → ENTRY Source 以 QR 完成 ENTRY → Viewer 查證 Qualification 為 INSIDE 並查到 Access Event → EXIT Source 以 Face 完成 EXIT → Viewer 查證 Qualification 為 EXITED 並查到第二筆 Access Event

完成標準是一條小而完整的後端流程，而不是完整門禁產品。正常通行、拒絕、事件重送、並行競爭、保存失敗、權限隔離、秘密遮蔽、每日重置與公開限流都必須有固定且可驗證的結果。

## 2. 核心名詞

| 名詞 | 定義 |
| --- | --- |
| Qualification | 一次來訪的限時通行資格；不是永久 Visitor／Person 主檔，也不能承載多次來訪。 |
| QR Credential | PassHub 產生的隨機、不透明 bearer token。QR 圖像與相機掃描不屬於 PassHub；系統只簽發及接收已解碼字串。 |
| Face Mapping | `provider + externalSubjectId` 與一張未終結 Qualification 之間的對應；不是照片、特徵向量或辨識模型。 |
| Recognition Source | 受信任的邏輯 API client，固定為 ENTRY 或 EXIT，並以自己的機器憑證提交辨識結果。 |
| Recognition Attempt | Source 送入的一次 QR、Face MATCHED 或 Face UNKNOWN 請求。 |
| Access Event | 對一筆已通過準入、Source 認證、業務格式及冪等檢查的新 Recognition Attempt 完成保存的不可變業務紀錄；容量拒收及持久化失敗不能聲稱已有 Event。 |
| Presence | 單張 Qualification 的使用狀態；只能是 NOT_ENTERED、INSIDE 或 EXITED，不代表系統已證明某位真人實際在場。 |
| Public Sandbox | 所有體驗者共用帳號、Source credential 與資料，資料每日重置且不具持久性或隔離保證的公開求職 Demo。 |

v1 只有一個邏輯地點，不建立 Site／Branch 實體，也沒有 Access Group、跨地點資料隔離或跨地點拒絕規則。

## 3. 角色、信任邊界與權限

### 3.1 固定角色

| 角色 | 能力 |
| --- | --- |
| Operator | 登入；建立及查詢 Qualification；在規則允許時修改或撤銷 Qualification；查詢 `INSIDE` Qualification 與 Access Event。 |
| Viewer | 登入；唯讀查詢 Qualification、`INSIDE` Qualification 與 Access Event。 |
| Recognition Source | 以自身機器憑證提交 QR／Face Recognition Attempt；不得管理 Qualification 或查詢營運資料。 |

### 3.2 預置身分

下列身分由 seed／部署設定預置，不提供管理 API：

- 一個 Operator Demo 帳號。
- 一個 Viewer Demo 帳號。
- 一個啟用的 ENTRY Source。
- 一個啟用的 EXIT Source。

公開 README 會提供專用 Demo credential，讓任何人操作 sandbox。這些值是刻意公開的測試資料，不是正式秘密，且必須與部署、資料庫及維護者 credential 完全分離。測試可另外建立停用 Source fixture，但這不構成公開 Source 管理能力。

### 3.3 認證與權限原則

- Operator 與 Viewer 以預置帳號登入，取得十五分鐘 HS256 JWT，以 Authorization: Bearer 提交；無 refresh／註冊／密碼復原。每次驗證目前帳號及角色。（D122）
- 每個 Recognition Source 使用自己的機器憑證，以 Authorization: Source alias.secret 提交；alias 不是可信身分，驗證 secret 後才取得 Source。（D122、D150）
- Source 的身分、固定方向與啟用狀態只能由 PassHub 依已驗證憑證取得，不能由 Recognition Attempt 覆寫。
- Source 認證失敗只形成安全／技術紀錄，不建立 Access Event。
- v1 不提供註冊、個人帳號、密碼重設、角色指派、Admin、Source 管理或使用者資料隔離。

### 3.4 權限矩陣

| 行為 | Operator | Viewer | Recognition Source |
| --- | --- | --- | --- |
| 登入 | 可 | 可 | 不適用 |
| 建立 Qualification | 可 | 不可 | 不可 |
| 修改尚可變更的 Qualification | 可 | 不可 | 不可 |
| 撤銷尚可撤銷的 Qualification | 可 | 不可 | 不可 |
| 硬刪除、重新啟用或修正 Presence | 不可 | 不可 | 不可 |
| 查詢 Qualification | 可 | 可 | 不可 |
| 查詢 `INSIDE` Qualification | 可 | 可 | 不可 |
| 查詢 Access Event | 可 | 可 | 不可 |
| 提交 Recognition Attempt | 不可 | 不可 | 僅限自身 |
| 修改或刪除 Access Event | 不可 | 不可 | 不可 |
| 執行公開資料重置 | 不可 | 不可 | 不可 |

## 4. Qualification 生命週期

### 4.1 最小資料與時間

每張 Qualification 只包含完成一次通行流程所需的資料：

- 訪客顯示名稱。
- `validFrom` 與 `validUntil`。
- 系統產生的 QR credential。
- 可選的 Face Mapping。
- 撤銷狀態、撤銷時間及撤銷原因。
- Presence。
- 建立及修改時間。

不保存 Email、電話、公司、拜訪目的、受訪員工、照片、身分證件、生物特徵或永久訪客身分。

Qualification 時間規則固定為：

- `validUntil` 必須晚於 `validFrom`。
- 建立或修改成功時，`validUntil` 必須仍晚於該次請求的伺服器接收時間。
- `validFrom` 可以位於過去、現在或未來；建立已經開始但尚未結束的 Qualification 是合法的。
- ENTRY 使用伺服器首次接收時間判斷半開區間 `[validFrom, validUntil)`。
- `NOT_ENTERED` Qualification 在不破壞較早已登記準時 ENTRY 的前提下逾期終結，之後不能再 ENTRY、修改、撤銷或延長；不能先讓後到整理終結，再把較早準時項當成需要復活的資格。
- `INSIDE` Qualification 即使超過 `validUntil`，仍可完成 EXIT。
- Qualification 可以跨日；v1 不設定同日或十二小時上限。

Client 不得提供可改變通行決策時間的事件 occurredAt；所有業務時間判斷都使用 PassHub 的伺服器首次接收時間。

首次接收點及排序依第 5.4 節。在系統正常運作下，期限內完整接收的合法 ENTRY，不得只因排隊、處理延遲或後到逾期整理而被判 `QUALIFICATION_EXPIRED`。來源、映射、撤銷及進出狀態仍須檢查，準時不等於必定通行。這項保障不承諾跨程序崩潰或每日重置延續。（D72、D76、D78）

### 4.2 QR credential

- Operator 建立 Qualification 時，PassHub 自動產生 QR token。
- 完整 token 只在建立成功的 response 中出現一次。
- 後續 response、查詢、Access Event、應用程式日誌與錯誤訊息均不得回傳完整 token。
- QR 是 bearer credential；持有有效 token 即可提交辨識，v1 不防止截圖、分享或轉交。
- QR 與 Face 可各自獨立完成 ENTRY 或 EXIT，不做雙重核對或第二因素驗證。
- 跨媒介進出只表示兩次事件映射到同一張 Qualification，不表示驗證為同一真人。
- 不提供 token 找回、重新顯示、輪替、補發或救援碼。
- 入場前遺失時，只能撤銷舊 Qualification 並建立新 Qualification。
- 已 `INSIDE`、遺失 QR 且沒有 Face Mapping 時，v1 無法完成 EXIT；此情境是公開已知限制。
- PassHub 不產生 QR 圖像，也不接收相機畫面；Source 送入的只是已解碼 token。

### 4.3 入場前修改

Qualification 只有同時符合下列條件時可以修改：

- Presence 為 `NOT_ENTERED`。
- 尚未撤銷。
- 尚未逾期。

Operator 只可修改：

- 訪客顯示名稱。
- `validFrom` 與 `validUntil`，且修改後重新符合 4.1。
- 新增、替換或移除 Face Mapping，且修改後重新符合 4.5 的唯一性規則。

QR token 不更換，也不因修改而再次顯示。v1 不保留 Qualification 版本歷史。

### 4.4 撤銷、凍結與終結

- 只有 `NOT_ENTERED`、未撤銷且尚未逾期的 Qualification 可以撤銷。
- Operator 撤銷時必須提供簡短原因；系統保存撤銷時間與原因。
- 撤銷不硬刪除資料，且撤銷後不得修改、重新啟用或 ENTRY。
- 舊 QR 不再允許 ENTRY，但仍映射原資格：新 QR ENTRY 在第 6.2 節對應順位形成 `QUALIFICATION_REVOKED`；未入場的新 QR EXIT 依第 6.3 節形成 `NOT_INSIDE`。已保存原事件的重送仍回放首次結果。
- 撤銷時立即釋放 Face Mapping；尚未重綁時的新 Face Attempt 形成 `FACE_SUBJECT_NOT_MAPPED`。
- ENTRY 成功後，顯示名稱、有效區間及 Face Mapping 全部凍結，Operator 不得修改或撤銷。
- `INSIDE` Qualification 即使逾期仍維持原內容與 Face Mapping，唯一正常後續狀態轉移是完成 EXIT。
- `EXITED` Qualification 永久完成，不得再次 ENTRY、修改、撤銷或重用為另一趟來訪。
- 所有 Qualification 都不得由業務 API 硬刪除或人工修正 Presence。

修改／撤銷與 ENTRY 競爭時，依第 5.4 節的同步登記順序 FIFO 取得完整處理權，不以認證速度或誰先取得 DB 鎖決定先後：（D76 修正 D17）

- ENTRY 先成功：Qualification 成為 `INSIDE`，修改或撤銷失敗。
- 撤銷先成功：後續 QR ENTRY 形成 `QUALIFICATION_REVOKED`；已釋放的 Face subject 形成 `FACE_SUBJECT_NOT_MAPPED`。
- 修改先成功：ENTRY 必須完整依修改後資料判斷，不得混用新舊欄位。

較早合法 ENTRY 的認證即使較慢，後到撤銷也不能插隊；較早 ENTRY 若失敗且未入場，後續修改／撤銷仍依自身條件判斷，不保證任何一方必定成功。

### 4.5 Face Mapping

- Face 輸入只模擬「外部服務已完成辨識後的結果」；PassHub 不呼叫真實第三方辨識 API。
- Face Mapping 的完整識別是 `provider + externalSubjectId`；兩者必須一起比對，v1 不提供 provider CRUD、adapter 註冊或切換後臺。
- Operator 只在建立或 4.3 允許的修改期間提交 provider 與 external subject；後續查詢與日誌只顯示是否已綁定，不查回完整值。
- PassHub 不因 Recognition Attempt 自動建立 Mapping。
- 同一組 `provider + externalSubjectId` 同時只能對應一張未終結 Qualification；重複綁定時拒絕建立或修改。
- Operator 在可修改期間移除或替換 Face Mapping 時，舊的 `provider + externalSubjectId` 立即釋放；替換後的新 Mapping 必須通過相同唯一性檢查。
- Face subject 在 Qualification 撤銷、符合第 4.1 節前序保護的 `NOT_ENTERED` 逾期終結或完成 EXIT 時釋放；`INSIDE` 即使逾期仍保留到 EXIT。相關寫入採惰性整理，不新增背景掃描或以唯讀查詢執行清理。（D69 的整理方向保留，終結競爭依 D72／D76 修正）
- 釋放後，subject 可綁到未來的新 Qualification；未重綁時的新 Attempt 形成 `FACE_SUBJECT_NOT_MAPPED`。
- PassHub 不保存照片、影像、feature／embedding、confidence、liveness 或其他生物辨識資料。
- Source 必須即時提交 Face 結果。網路重送必須沿用原 external event ID；若延遲舊結果使用新 ID，PassHub 不查歷史 Mapping，而是按相關操作 FIFO 順序確立的目前 Mapping 判斷，無法辨識其歷史來源。這不是在接收瞬間搶讀尚未完成的前序寫入。v1 不保存 Mapping 歷史，也不支援離線或延遲補送。

目前映射唯一權威為 faceSlots。綁定、釋放及依映射裁決使用真實寫入 guard；首次缺槽的 MATCHED 拒絕寫共同鍵空間 guard 並保存 Event，**辨識不新增槽或綁定**。只有管理綁定新 subject 時分配槽；釋放清引用但保留空槽，總量初值 4096（含空槽），日間不回收，完整 reset 才清除。滿額時新 subject 管理回技術容量錯誤，解綁不增加容量；既有空槽可重用，缺槽辨識仍可保存拒絕。單資格單 Face 唯一索引的同交易替換必先經真 MongoDB 微型阻塞實測，未通過不得靜默改策略。（D142–D145、D157）

## 5. Recognition Source 與輸入

### 5.1 Source 邊界

- Demo 固定一個 ENTRY Source 與一個 EXIT Source。
- 兩個 Source 都能提交 QR 或 Face 輸入。
- 每個 Source 使用自己的機器憑證；Source 身分、固定方向及啟用狀態由 server-side 預置資料決定。
- Request payload 不得指定或覆寫 Source 方向。
- 已通過憑證驗證但處於停用狀態的 Source，其格式合法新嘗試形成 `REJECTED + SOURCE_INACTIVE` Access Event。
- Source 只能提交線上即時取得的辨識結果，不得離線累積或以新的 external event ID 延遲補送。
- 因網路逾時而沿用原 external event ID 重送，不屬於延遲補送，依第 7.2 節回放。

Recognition Source 是邏輯 API client，不代表 PassHub 擁有實體終端、門鎖、相機、掃碼器或串流控制能力。

### 5.2 輸入種類

v1 只接受三種 Recognition Attempt：

| 輸入 | 業務內容 |
| --- | --- |
| QR_SCANNED | 帶入 QR token，由 PassHub 映射 Qualification。 |
| FACE_MATCHED | 帶入模擬外部服務回傳的 `provider + externalSubjectId`，由 PassHub 映射 Qualification。 |
| FACE_UNKNOWN | 上游表示未辨識出任何 subject；不帶 Qualification、照片或其他人臉資料。 |

每個格式合法的 attempt 都必須包含 Source 自行產生的 external event ID。Payload 不接受：

- 可改變決策時間的 client occurredAt。
- PassHub 內部 Qualification ID 作為 QR／Face 映射捷徑。
- 可覆寫的 ENTRY／EXIT 方向。
- 圖片、串流、特徵、confidence 或硬體控制內容。

三種 DTO、十個業務 API 與回覆契約已在 D150–D151 定案，見[實作方案](implementation-plan.md)；辨識只有 externalEventId 加上述媒介內容，不接受其他欄位。

### 5.3 固定處理順序

每筆 Source request 先依第 5.4 節完成同步基本檢查、準入及登記，再依下列正式順序處理；同步登記不代表認證或業務格式已通過：

1. 驗證 Source 機器憑證。
2. 驗證 event envelope 與媒介資料格式。
3. 依 Source 身分與 external event ID 判斷首次請求、回放或 conflict。
4. 首次合法嘗試檢查 Source 是否啟用。
5. 依 QR／Face 映射 Qualification，或形成 invalid／unknown／unmapped 結果。
6. 依 Source 固定方向執行 ENTRY 或 EXIT 規則。
7. 共同原子保存 Access Event、必要 Presence 轉移及 Mapping 變更。
8. 只有必要資料完整保存後，才回覆通行業務結果。

PassHub 不在此流程中控制門鎖、呼叫 Webhook 或建立任何下游投遞工作。

### 5.4 首次接收點與相關完整寫入順序

此節同步 D72、D74、D76；一般新項還須符合第 7.6 節的完整容量準入。

- 完整 body 進入應用可觀察入口，完成同步大小、基本 JSON 與準入檢查後，同步固定首次 server receivedAt、單調序號及登記。中間不插入非同步 Auth 或 DB 等待。
- 接收時間不是 client 掃描／按鈕時間、網路首 byte、認證完成、取得 DB 鎖或保存成功時間；同毫秒由序號區分先後。
- 資格建立、修改、撤銷、QR／Face 辨識及附帶的逾期整理、映射釋放／重綁等相關完整寫入依登記序 FIFO 取得處理權。
- v1 僅一個 API 實例、相關寫入單執行。普通唯讀與登入不全排進此 FIFO；但它們仍須有適當資源限制，也不保證故障下必定可用。
- 身分／業務格式不合法不得進業務保存；同步暫占及登記不是可信受理或通行授權。既有事件回放不是新通行決策。
- 未知結果不能因等待逾時就放開後項；故障確認、續辦及維護依第 7.4–7.6 節與第 9.2 節。

G05a 已證內部同步登記／單調序號／單一FIFO權限、settlement與unknown fail-closed primitive；G05b 已證每原操作 15秒／3輪 execution、10秒／7格 confirmation、single-send cadence、native precommit兩送預扣及continuation admission ledger；G05c 已證 process-local registry／opaque artifact join／conflict、4096 retention、generation／late-callback與epoch／read-only claim primitive。框架 hook、完整同步準入、G05a／G05b／G05c composition、同鍵暫占與HTTP／use-case接線、driver wire與生命期合併仍須後續 G07a/G07b/G08/G10/G11 真驗，不能把本 primitive、時間戳、單實例或一般 mutex 當成完整FIFO／冪等／故障協議已通過驗收。

## 6. Presence 與通行決策

### 6.1 Presence 狀態機

唯一正常狀態順序為：

> NOT_ENTERED → INSIDE → EXITED

| 目前狀態 | ENTRY | EXIT |
| --- | --- | --- |
| NOT_ENTERED | 通過完整 ENTRY 規則後轉為 INSIDE | `REJECTED + NOT_INSIDE` |
| INSIDE | `REJECTED + ALREADY_INSIDE` | `ACCEPTED + EXIT_RECORDED`，轉為 EXITED |
| EXITED | `REJECTED + QUALIFICATION_ALREADY_USED` | QR 可映射時為 `REJECTED + ALREADY_EXITED` |

上表以輸入仍能映射 Qualification 為前提。QR 會繼續映射原 Qualification，因此可得到終態 reason code；Face Mapping 在撤銷、符合第 4.1 節前序保護的未入場逾期終結或 EXIT 後釋放，未重綁時的新 Face Attempt 會先得到 `FACE_SUBJECT_NOT_MAPPED`。較早準時項不能被後到釋放搶先破壞。

Presence 只描述 Qualification 使用狀態。任何文件、API 說明或履歷都不得把 `INSIDE` 清單宣稱為已驗證真人的在場紀錄、考勤或定位結果。

### 6.2 ENTRY 固定優先序

通過認證、格式及冪等前置處理後，新 ENTRY 依下列順序取得第一個成立的結果；每筆 Access Event 只保存一個 reason code：

1. Source 停用：`REJECTED + SOURCE_INACTIVE`。
2. 媒介無法映射：依輸入形成 `INVALID_QR_CREDENTIAL`、`FACE_UNKNOWN` 或 `FACE_SUBJECT_NOT_MAPPED`。
3. Qualification 已撤銷：`REJECTED + QUALIFICATION_REVOKED`。
4. Presence 為 `INSIDE`：`REJECTED + ALREADY_INSIDE`。
5. Presence 為 `EXITED`：`REJECTED + QUALIFICATION_ALREADY_USED`。
6. Server receivedAt 早於 `validFrom`：`REJECTED + QUALIFICATION_NOT_YET_VALID`。
7. Server receivedAt 等於或晚於 `validUntil`：`REJECTED + QUALIFICATION_EXPIRED`。
8. 全部通過：`ACCEPTED + ENTRY_GRANTED`，Presence 轉為 `INSIDE`。

任何拒絕都不得改變 Presence。

### 6.3 EXIT 固定優先序

通過認證、格式及冪等前置處理後，新 EXIT 依下列順序取得第一個成立的結果：

1. Source 停用：`REJECTED + SOURCE_INACTIVE`。
2. 媒介無法映射：依輸入形成 `INVALID_QR_CREDENTIAL`、`FACE_UNKNOWN` 或 `FACE_SUBJECT_NOT_MAPPED`。
3. Presence 為 `NOT_ENTERED`：`REJECTED + NOT_INSIDE`。
4. Presence 為 `EXITED`：`REJECTED + ALREADY_EXITED`。
5. Presence 為 `INSIDE`：`ACCEPTED + EXIT_RECORDED`，Presence 轉為 `EXITED` 並釋放 Face Mapping。

EXIT 不重新檢查 Qualification 的有效時間。已在有效區間內成功 ENTRY 的 Qualification，即使收到 EXIT 時已逾期，仍可正常離場。

### 6.4 Outcome、reason code 與前置錯誤

Access Event 與對應 API response 統一使用：

- `outcome: ACCEPTED | REJECTED`
- 單一 `reasonCode`

只有 `ENTRY_GRANTED` 與 `EXIT_RECORDED` 搭配 `ACCEPTED`；其餘通行 reason code 都搭配 `REJECTED`。v1 不另設 `ALLOW`／`DENY` 業務欄位。

下列前置錯誤在通行業務判斷前處理，不建立 Access Event，也不產生通行 outcome：

- Source 認證失敗。
- Event envelope 或媒介資料格式錯誤。
- 相同冪等鍵但業務內容不同的 `IDEMPOTENCY_CONFLICT`。
- 傳輸大小、頻率、容量等技術準入限制；滿載回覆須符合第 7.6 節，不能冒稱原項失敗。

必要持久化失敗則發生在業務判斷後、response 前；此時不得把尚未完整保存的判斷回傳為通行 outcome，也不得留下可觀察的部分成功。前置錯誤與持久化失敗使用獨立 error response；D150 的 status／技術碼與可信進度見實作方案。

## 7. Access Event、冪等與一致性

### 7.1 Access Event 建立邊界

通過技術準入、Source 認證、業務格式及冪等檢查，且使用新 external event ID 的每一筆 Recognition Attempt，均須成功保存一筆不可修改的 Access Event 後才回覆通行結果，不論 `ACCEPTED` 或 `REJECTED`。這包含：

- 成功 ENTRY／EXIT。
- 無效 QR。
- FACE_UNKNOWN。
- FACE_MATCHED 但沒有現行 Mapping。
- Source 停用。
- Qualification 撤銷、過早、過期或狀態不符。

Source 認證失敗、格式錯誤、限流／大小／容量限制及 `IDEMPOTENCY_CONFLICT` 只寫適當去敏的安全／技術紀錄，不建立 Access Event。必要保存失敗不得聲稱已有 Event；結果未知也不是已保存的業務拒絕。

Access Event 至少能回答：

- PassHub decision event ID。
- Source ID 與固定方向。
- Source external event ID，供內部冪等判斷。
- QR 或 Face 媒介。
- `ACCEPTED`／`REJECTED` outcome 與單一 reason code。
- Server receivedAt。
- 能安全映射時的 Qualification ID。
- Presence 是否以及如何改變。

Event 不保存或輸出原始 QR token、Source 機器憑證或完整 external subject。Event 不提供修改或刪除能力。

### 7.2 冪等契約

冪等鍵固定為：

> Source 身分 + external event ID

- 相同鍵且業務內容相同時，原樣回放第一次已保存的完整結果。
- 回放不重新檢查目前的 Source、Mapping、Qualification、效期或 Presence，不建立第二筆 Event，也不再次轉移狀態。
- 相同鍵但業務內容不同時，回傳 `IDEMPOTENCY_CONFLICT`；不覆寫舊 Event，也不建立新 Event。
- 不同 Source 可以使用相同 external event ID，彼此不衝突。
- Face subject 即使已釋放或重綁，使用原 external event ID 的真正重送仍回放舊結果。
- 原項仍在途時，必要驗證及同鍵同內容確認後，只關聯原進度，不新增原操作或刷新首次 receivedAt、FIFO、執行／確認預算。技術終局的同 ID 也不重新執行；無跨崩潰／重置延續保證。（D78、D83、D91、D95）

Source＋external event ID 使用資料庫唯一約束。相同內容採 D117 固定 JSON v2／UTF-8 位元組長度與 HMAC-SHA-256，不 trim、大小寫轉換或 Unicode 正規化；QR 原 token、Face provider／subject 精確原值比較，UNKNOWN 無 subject。比較 digest 與 reference ID 共同原子保存，啟動核對獨立向量及相容資料。（D117、D119–D122、D142、D145）

相關寫入及辨識重送須帶 PassHub-Dataset-Epoch。舊世代被拒絕，不能自動換新 epoch 冒稱原項續辦。辨識的 existing-only 通道只關聯既有項，永不升級成新項。同程序／資料世代 registry 初值 4096，含終局結果，日間不淘汰；普通同資料世代重啟只允許有限唯讀／canonical 回放，**不能重新開寫**，重新開寫須私密完整隔離／reset 新世代。（D149–D150）

### 7.3 並行與保存不變條件

- 在資格原為 `NOT_ENTERED`、兩筆除 Presence 競爭外的 ENTRY 條件均通過，且必要保存可完成的驗收前提下，兩個不同事件同時對同一 Qualification ENTRY，最多一筆完成 `NOT_ENTERED → INSIDE` 並形成 `ENTRY_GRANTED`，另一筆形成 `ALREADY_INSIDE`；兩筆 Event 都保存。前提不成立時仍按第 6.2 節首因裁決，不保證有任何一筆成功。
- 上述規則同樣適用 QR／Face、QR／QR 或 Face／Face 並行 ENTRY。
- 兩個不同事件同時對同一 Qualification EXIT 時，最多一筆完成 `INSIDE → EXITED` 並形成 `EXIT_RECORDED`；兩筆 Event 都保存，Presence 只改變一次。不同 Qualification 可以各自正常成功。
- 同一資格的正常 EXIT 競爭中，Face 先完成 EXIT 時，後處理 QR 仍映射舊 Qualification，形成 `ALREADY_EXITED`。
- 同一資格 QR 先完成 EXIT 且兩次辨識之間沒有介入 Face 重綁時，Face Mapping 已釋放，後處理 Face 形成 `FACE_SUBJECT_NOT_MAPPED`。若中間已重綁，Face 按目前映射與正常規則處理，不固定宣稱未映射。
- 修改／撤銷與 ENTRY 的競爭結果依第 4.4 節，不得形成同時已撤銷且 `INSIDE`，也不得讓 ENTRY 讀到部分更新。

成功 ENTRY／EXIT 只有在 Access Event、必要 Presence 轉移及 Mapping 變更共同原子保存後才能回覆。拒絕通行也必須先成功保存拒絕 Event，才回覆業務拒絕。已確認必要保存失敗時回傳系統錯誤；提交結果未知則依第 7.4 節確認與停寫，不假設已回滾：

- 不回傳 `ACCEPTED`。
- 不假裝已完成可稽核的 `REJECTED`。
- 不得留下或向呼叫端暴露 Event、Presence 與必要 Mapping 的部分成功。

共同保存已選 MongoDB 官方 driver 多文件 transaction，部署必須真支援交易；同一交易操作共用 MongoClient／session，交易內不以 Promise.all 並行。成功及依賴可變資料的拒絕，都保護 Source、Mapping、Qualification 決策依據的新鮮度；snapshot、read-compare 或 no-op 不能單獨當作證明。（D63–D65）

完整操作的資料能力受該次範圍限制，結束後不可續用。已證明可安全重跑的衝突須重新建立範圍、讀取及裁決，不能保存舊計畫；duplicate key 須區分索引歸屬，不能吞錯續用已中止交易。提交不明與整輪可重跑衝突分開處理。schema／guard／Core API 已按 D125–D145 收斂，仍須真整合及故障測試。交易 snapshot／primary、majority＋journal，共同保存；canonical majority／primary，不假稱 latest 或高可用。

### 7.4 原操作生命期、未知結果與安全續辦

此節同步 D78、D80、D83、D85、D87、D89、D91、D95。

- HTTP 等待結束、斷線或重送不取消仍在途的原操作，不改首次時間、順位及額度。伺服器負責推進符合條件的原項，不靠測試者重送叫醒。
- DB 結果未知時先有限自動確認；仍無充分證據則停相關通行寫入，不能盲目重做、放後項或假回通行失敗／逾期。Event 暫時不存在、連線恢復、timer、Promise race、斷線或停止程序都不是已回滾／不會晚寫的充分證據。
- 若已確認必要資料完整保存，原結果為權威，即使晚於 HTTP、執行或確認上限，仍更新原項並供合法回放，不重做。
- 原項仍在同一程序、原資料未重置，且充分確認上一輪無保存效果及舊工作不會晚寫、原項仍有執行資格、服務當下允許、未受實際人工管控或維護阻擋，則自動續辦同一項。確認額度用完或證據晚到本身不是額外等人批準的理由。
- 續辦不補滿任何額度；新一輪寫入再次未知仍沿用原確認額度，上一輪安全證據不能證明新寫入安全。
- 確認不足交維護者關注，人工也不能強解鎖或補額度。關注／告警不等於已接管；確認停止時須明示「停止新確認，等待在途證據或人工介入」，以及符合條件仍可能自動續辦。實際接管或維護生效時不能自行越權續辦／解除管控，但確定保存結果仍可更新與查詢。
- API 語意區分故障暫停、等待處理、正在處理及完整結果：可信在途 202 明示 stage、confirmationState、control；未能驗證／確認回去敏 503，不宣稱原項失敗。保存結果 200 明示 replayed，回放 ACCEPTED 不代表再次放行。（D150）
- 舊 callback／finally 只作用於自身處理權，不能解開下一項關卡、誤停恢復後服務或越過維護。已解決原項的舊通知只作適當技術紀錄；真正新故障或未解安全疑慮仍重新判斷。
- 不承諾任意故障有限時間內恢復／完成，也不提供跨程序崩潰、重啟或每日重置的原項／技術終局延續保證。

安全證據及 driver 生命週期依 D129–D139 的複合判據；Event 查無、abort Promise／本地狀態、程序停止均不能單獨放權。私密 Unix socket／host CLI 的 hold、release、status、drain 有效範圍見 D153；hold 不撤回已交 driver 工作，release 不解維護或未知。不新增公開恢復 API、持久 pending 或分散式佇列。

### 7.5 三類等待／處理上限

以下是 D95、D129–D137 已採用的**可調待測初值**，不是效能成果、取消證明或完成時間保證；七格已明確取代早期三次初值。

| 預算 | 初值 | 起算與消耗 |
| --- | --- | --- |
| 每次 HTTP 回覆等候 | 5 秒 | 本次完整 body 通過第 5.4 節同步檢查及準入、登記時起算，含認證與排隊，不含上傳。重送只重算自己的 HTTP 等候。 |
| 每原操作執行 | 15 秒、最多 3 輪，含首次 | 首次取得完整處理權起算，初次排隊不計；開始後暫停、結果確認、恢復等候都計入。首次、衝突整輪重跑及恢復共用輪次。 |
| 每原操作確認／必要清理 | 10 秒、7 格 | 首次 DB 未知或首次確需 precommit 清理，取較早者同步起算；跨輪／重送共用、不刷新／不退款。單送扣一格，原生終止組保守預扣兩格。 |

- HTTP 結果先完成就先回；到五秒結束本次等待並嘗試回覆，不取消原項，不保證按送出後五秒內送達。每個 HTTP 等候方只有一次回覆權，deadline 與完成競爭不能回兩次，晚 callback 不再響應舊連線。
- 到點仍未通過認證或正式格式驗證，只回不洩漏原項資訊的技術等候逾時，不能稱已受理／處理中。晚認證失敗不得進業務；成功才依正常條件接續。可信同鍵同內容重送直接提供可確認進度或保存結果，不刻意再等五秒，也不保證故障下每次均可立即查得。
- 每完整執行輪開始前取得共同額度；輪次用完僅禁止新輪，最後準入一輪仍可在剩餘總時間完成。時間耗盡停止新增業務步驟及重跑，但容許必要安全收尾；不補確認額度，不把已送命令當已取消。
- unknown commit 首次立即確認原交易 commit，失敗後一秒查 canonical，再失敗兩秒原 commit，此後兩秒交替，單呼叫串行。單送準入須窗口／格數許可；確認 commit 固定兩秒、窗口至少剩兩秒。precommit 原生中止組限窗口內且至少兩格時準入、預扣不退、兩送共用兩秒；**已準入組第二送可跨窗口且無組內一／二秒間隔**，不準新組。此為 D129 局部例外，不保證取消或準時完成。
- 執行開始後確認等待同時消耗執行時間，非 15＋10 秒保證。所有額度不能補滿；不使用 withTransaction 自動重跑，原生 abort 兩送組須真測計量，endSession 不得額外送出繞預算。（D125、D129、D137）
- 執行額度耗盡且充分證明無保存效果、舊工作不會晚寫，並已完成安全收尾，才形成「技術未完成、執行額度耗盡」終局，非通行 `REJECTED`／`EXPIRED`，不自動撤銷資格。結果未知仍停寫；完整保存結果即使晚到仍為權威。
- 同 ID 不重啟終局；原項安全終結、服務允許且正常準入通過後，新 ID 才是新嘗試，採新 receivedAt，可能已逾期、不繼承原準時權。新 ID 不能繞未知停寫、維護或人工管控。

具體 timeout／生命週期依 D136–D137，HTTP／記憶依 D149–D151；仍待工程驗證，不因 timeout 當成取消或遺忘同 ID 後重新執行。D130 新增永久終局候選未採用，符合 D89 的安全續辦仍保留。

### 7.6 有限容量、準入與釋放

此節同步至 D146–D149。初值可調待測，不宣稱容量內所有請求必受理；registry 4096 是額外記憶資源，不等於原操作 32。

| 資源 | 初值 | 釋放邊界 |
| --- | --- | --- |
| 未完成原操作 | 32 | 涵蓋暫占待驗證、FIFO、執行、未知；驗證失敗且確定不進業務，或原項完整結束且安全收尾後才還。 |
| 並行入口驗證工作 | 8：普通 6（寫入 4／login 1／query 1）＋重送專用 2 | 真工作完成且安全轉交／收尾才還；query 工作持至 DB 收束，專用不互借。 |
| HTTP 等候回覆 | 32：普通 28＋重送專用 4 | 本身等待結束／斷線才返，只返自己的 HTTP 槽，不取消原項或其他工作。 |

- 一般新辨識候選登記前同步取得 origin、validation、HTTP、registry 預留，全部成功才固定 receivedAt／序號；任一不足整組不成立，不能登記後丟棄。可信同鍵 join 返回自己的預留；專用 existing-only 缺項仍不能升新。暫占不是可信受理。
- 原項滿仍可透過有限驗證與 HTTP 通道辨認可信同鍵同內容重送，不新增第二原項、不刷新時間／順位／額度；不同內容仍為 conflict。重送不無條件免除入口限制，也不保證每次均可接受。
- 未通過驗證就遇入口滿，只能說「本次無法完成驗證、不能判定原操作狀態」，不能說原項不存在、未受理或失敗，不能洩漏進度。
- 可信確認是新項而原項容量滿，才說「新操作未接收、未保留本次準時紀錄」；不建 Event，只作適當技術紀錄。這不是排隊或通行拒絕，後續重試用新時間且可能已逾期。
- 不淘汰已登記準時項騰槽；HTTP 逾時、斷線、結果未知不釋放原項／仍在工作驗證。競爭下取得、轉交、歸還各只能按實際生命期正確執行。
- 原項 32 不是並行寫入數，仍單 writer FIFO。其他資源初值依 D148–D149：connection 64、raw reader 16、body 16KiB／上傳絕對五秒、scrypt 1無queue、queryDB 1、canonical回放 2、原確認 1；所有工作真收束才返自己的額度。

同步準入／同鍵合併／滿載重送的具體接線與資源驗證尚未完成；不得把政策已採用寫成容量實測成果。

## 8. 最小營運查詢

Operator 與 Viewer 使用相同的讀取範圍與去敏欄位；Recognition Source 不得使用任何營運查詢。

### 8.1 Qualification 清單與詳情

Qualification 清單：

- 必須分頁。
- 固定依建立時間由新到舊排序；時間相同時以 Qualification ID 作 tie-breaker。
- 不提供名稱、有效時間、撤銷、逾期或 Presence 篩選。
- 不提供全文搜尋或自訂排序。

已知 Qualification ID 時可查單筆詳情。清單及詳情可顯示：

- Qualification ID 與訪客顯示名稱。
- `validFrom`、`validUntil`。
- 撤銷、逾期與 Presence 狀態。
- `faceBound`，只表示是否有有效綁定，不照搬待惰性整理的物理引用；`INSIDE` 逾期仍保留綁定，受前序準時 ENTRY 保護時不能僅憑時鐘判可釋放。
- 建立、修改、撤銷時間及撤銷原因。

不得顯示 QR token 或完整 external subject。

### 8.2 INSIDE Qualification 清單

- 只列出 Presence 為 `INSIDE` 的 Qualification。
- 不列 `NOT_ENTERED`、撤銷或 `EXITED`；即使已過有效期限，`INSIDE` 仍列出。
- 必須分頁，固定 enteredAt 降序加 Qualification ID 降序。（D152）
- 使用與第 8.1 節相同的安全欄位。
- 名稱及說明必須使用「INSIDE Qualification／資格使用狀態」，不得宣稱為已驗證真人的在場名單。

### 8.3 Access Event 清單與詳情

Access Event 清單只支援三種固定篩選：

- `qualificationId`
- `outcome`
- `reasonCode`

Source、方向及媒介只顯示、不篩選。三篩選 AND，receivedAt／Event ID 降序；三類 list 共同 limit 預設20／最大100、固定 keyset cursor（D152），無跨頁 snapshot 保證。不提供全文或自訂排序。

清單及詳情可顯示：

- Decision event ID。
- Source ID 與固定方向。
- QR／Face 媒介。
- Outcome 與 reason code。
- Server receivedAt。
- 能安全映射時的 Qualification ID。
- Presence 是否以及如何改變。

不得顯示原始 QR token、Source 機器憑證、完整 external subject 或內部冪等比較資料。

### 8.4 明確不提供的查詢能力

v1 不提供統計圖表、Dashboard、CSV／報表匯出、全文搜尋、任意組合進階查詢、使用者自訂排序、WebSocket、SSE 或即時推送。

## 9. 公開共享 sandbox

### 9.1 公開展示與共享資料

- GitHub repository 保存原始碼、README、OpenAPI contract 與操作範例。
- Node.js API 使用 GitHub 以外的自管 Linux／Docker Compose runtime，單 API／單成員 Mongo replica set／NGINX HTTPS；主機、網域、憑證是未提供的部署前提，不宣稱高可用。（D154–D155）
- 本機仍須能以 Docker 及 seed 重建相同核心流程，但本機不是唯一展示方式。
- 所有體驗者共用預置 Operator、Viewer、ENTRY Source、EXIT Source credential 及同一份可丟棄資料。
- 不提供註冊、個人帳號、資料隔離或私人 workspace；其他體驗者可能讀取或修改共享 Qualification。
- README 必須明示這是公開求職 sandbox，要求只使用虛構資料，禁止輸入真實姓名、個資、秘密、正式 QR／token 或真實第三方 subject。
- 系統不承諾資料持久性、隱私隔離、可用性或 SLA。
- 公開 Demo credential 是刻意公開的測試值；不得與 deployment、database 或 maintainer secret 共用，也不能作為正式設備認證能力的證據。

D24 的最小揭露仍適用於公開環境：API 查詢、Access Event、錯誤及日誌不得輸出原始 QR token、Source credential 或完整 `provider + externalSubjectId`。

### 9.2 每日重置

- 公開環境每天 **Asia/Taipei 凌晨 03:00** 由 API 外的排程自動執行，不能只由將被停止的 API 計時或正常情況等人工操作。（D52）
- 重置為獨立 host 維護命令，API 停止後仍可執行；為隔離舊 DB 工作，**本方案也停止並確認舊 Mongo 程序消失，重啟恢復完成 PRIMARY 後才清理**，維護程序本身不停止。（D155 具體化 D52）
- 順序為：停止接受新業務 → 有限等待既有操作 → 停止 API，等待超時也進安全重置 → 確認舊 DB 工作不會干擾新資料 → 清除限定 Demo 資料及重建 seed → 成功才自動啟動 API。
- 停止 API 不證明已送 DB 工作取消。隔離／確認必須在清除前成立；不能為準時維護直接跳過安全前提，也不等於授權刪除整個 DB。
- 精確清理僅 passhub_demo 的 qualifications、faceSlots、events、users、sources、metadata，逐 collection deleteMany({})保留索引，不 drop DB／volume／其他DB；seed 不是整庫原子，任何未知或失敗都保持關閉。（D155）
- 重置後恢復 canonical Operator、Viewer、ENTRY Source 與 EXIT Source；公開 Demo credential 保持不變。
- 維護者另有非公開手動重置命令；任何公開角色或 API 都不能觸發重置。
- README 必須說明資料會每日消失，且重置期間的請求可能失敗；使用者可在重置完成後重新操作。
- 清除或 seed 失敗維持不可用，由維護者修復重跑，不啟動半完成環境；維護開始否決過時的原項續辦許可。
- 不提供備份、單筆復原、使用者匯出、刪除申請或正式 retention policy。

v1 單 API、不自動重啟。systemd 臺北03:00／Persistent=false，漏跑不白天補清庫。host local exclusive lock／marker封入口→drain≤30秒→確認API停止→確認Mongo停止→恢復PRIMARY→精確清理seed新epoch／nullclaim→私密一次runTicket bootstrap→授權local ready→handoff才開入口。bootstrap不是ready，marker也不是普通程序接管許可。主流程各階段失敗均failclosed，未知停止／額外writer不跳步。（D149、D154–D155）

### 9.3 最低公平使用限制

公開環境必須具有可由部署設定調整的最低護欄：

- 限制單一來源在短時間內的請求數。
- 限制 JSON request body 大小。
- 限制所有分頁查詢的單頁筆數。
- 超過上述限制時直接拒絕，不建立 Access Event。

待測固定分鐘初值：login每IP5／全局20、query每帳號60／全局120、辨識每Source30／全局60、管理每帳號10／全局20；IP表256只去過期項，滿表拒新IP。重送亦計但不取消原項。proxy只信固定IP/32及覆寫XFF，禁止自動重放上游請求。（D148、D155）v1 不加 CAPTCHA、個人key、付費或風控後臺，不宣稱production-grade抗濫用。

### 9.4 固定公開 Demo 主流程

README 與互動式 OpenAPI 必須讓使用者依序完成：

1. 取得公開 Operator、Viewer、ENTRY Source 與 EXIT Source Demo credential。
2. 以 Operator 登入。
3. 建立立即有效、綁定一組自行輸入且不與他人重複之虛構 `provider + externalSubjectId` 的 Qualification。
4. 保存建立 response 中只顯示一次的 QR token。
5. 以 ENTRY Source 提交 QR，取得 `ACCEPTED + ENTRY_GRANTED`。
6. 以 Viewer 查詢該 Qualification、`INSIDE` Qualification 清單及 ENTRY Access Event。
7. 以 EXIT Source 提交同一組 Face Mapping，取得 `ACCEPTED + EXIT_RECORDED`。
8. 再查詢 Qualification 與 Event，確認最終為 `EXITED` 且兩筆 Access Event 存在。

公開產品體驗只使用互動式 OpenAPI 與可複製 curl 範例，不製作產品型前端。Face ENTRY→QR EXIT、拒絕、重送及並行情境由自動化測試與補充 API 範例證明。

求職 Demo 另提供兩個彼此獨立的裝置 client 模組：ENTRY client 只能以預置 ENTRY Source 身分送出 attempt，EXIT client 只能以預置 EXIT Source 身分送出 attempt。兩者模擬外部裝置傳輸已解碼 QR 或人臉辨識結果，不模擬影像、門鎖或硬體；可共用純 HTTP／序列化工具，但通行方向與業務裁決仍完全由 PassHub 的可信 Source 資料及單一後端規則決定。（D162）

### 9.5 已知限制

- Presence 只是 Qualification 使用狀態，不證明真人身分、位置或考勤。
- QR 可被截圖或轉交，且不與 Face 雙重核對。
- Qualification 已 `INSIDE`、QR 遺失且沒有 Face Mapping 時，v1 沒有業務救援流程。
- Face subject 終態後可重綁；延遲舊結果若錯用新 external event ID，可能依當下 Mapping 作用於新 Qualification。
- 公開 credential 與資料由所有體驗者共用；操作可能互相影響，內容每日重置。
- 最低限流只能降低資源濫用風險，不能保證抵抗惡意流量。
- 準時保障限已符合準入的完整接收及正常運作；不保證真實抵達／按鈕時間、滿載必受理、故障必完成或跨崩潰／重置續辦。
- HTTP 逾時不代表通行失敗／rollback；未知結果可能使相關寫入維持暫停，維護及人工不能以無證強解鎖救場。

## 10. v1 明確排除

### 10.1 產品、身分與管理

- 多企業租戶、多地點、組織樹與地點級 RBAC。
- 永久 Visitor／Person 主檔、多次拜訪關聯及同一 Qualification 多次進出。
- 訪客自行申請、受訪員工審核、訪客帳號及訪客狀態頁。
- Admin、帳號／角色管理、密碼重設、Source 管理及 Access Group。
- 硬刪除、重新啟用、QR 補發、救援碼、人工 Presence 修正及入場後撤銷。
- Card、NFC 或 QR／Face 以外的第三種通行媒介。

### 10.2 辨識、影像與硬體

- 真實第三方人臉辨識 API。
- Face enrollment、照片、影像、feature／embedding、confidence、liveness 或模型。
- RTSP、串流擷取、解碼、轉碼、相機管理及相機 QR 掃描。
- 實體門鎖、relay、Wiegand、I/O、韌體及離線設備同步。

### 10.3 下游整合、呈現與正式營運

- Webhook、下游 HTTP action、Event Delivery、outbox、背景投遞及其重試、規則引擎；不排除第 7.4–7.5 節已採用的內部安全確認／續辦。
- Email、SMS、LINE、PDF、檔案服務或其他通知。
- 產品型前端、Dashboard、統計、考勤、報表及 CSV。
- WebSocket、SSE、全文搜尋、任意進階查詢及自訂排序。
- 正式個資生命週期、使用者資料隔離、備份／復原、可用性承諾及 SLA。
- 可插拔 provider、通用 adapter SDK、規則 DSL、動態 policy builder 或其他 action 類型。
- 多 API 實例擴容、分散式佇列、必要的持久 pending 平臺、跨崩潰／重置原項延續；不以微服務、CQRS 或 EventEmitter 協調核心通行業務。

## 11. 業務驗收情境

### 11.1 核心流程與 Qualification

| 情境 | 預期結果 |
| --- | --- |
| 建立已開始但尚未結束的 Qualification | `validFrom` 可早於或等於該請求首次 server receivedAt；`validUntil` 必須晚於 `validFrom` 及該首次 receivedAt，不能以稍後執行時鐘改判；QR 只在成功 response 顯示一次。 |
| 建立未來 Qualification | 建立成功；有效時間前 ENTRY 為 `REJECTED + QUALIFICATION_NOT_YET_VALID`。 |
| QR ENTRY→Face EXIT | 依序形成 `ENTRY_GRANTED`、`EXIT_RECORDED`；Presence 最終為 `EXITED`。 |
| Face ENTRY→QR EXIT | 使用相同 policy 及狀態規則，Presence 最終為 `EXITED`。 |
| 入場前修改 | 只允許有效的 `NOT_ENTERED` Qualification 修改名稱、時間及 Face Mapping；重驗時間與 Mapping 唯一性，QR 不變且不重顯。 |
| 入場前撤銷 | 必填原因；保留 Qualification 與撤銷資料，QR 永久失效並釋放 Face Mapping。 |
| ENTRY 後修改／撤銷 | 一律失敗；Qualification 完全凍結，只能 EXIT。 |
| 未入場逾期且無較早受保護 ENTRY | Qualification 逾期終結且不能延長；新 QR ENTRY 為 `QUALIFICATION_EXPIRED`，相關操作可惰性釋放 Face；不能拿此規則誤拒較早準時項。 |
| 入場後逾期再 EXIT | `ACCEPTED + EXIT_RECORDED`，不重新檢查有效時間。 |
| Face subject 重複綁定 | 同一 `provider + externalSubjectId` 已被未終結 Qualification 占用時，拒絕建立或修改。 |
| Face subject 終態後重用 | 前一 Qualification 撤銷、符合前序保護的未入場逾期終結或 `EXITED` 後可綁至新 Qualification；INSIDE 逾期不可釋放。 |
| QR token 可見性 | 只在建立成功 response 出現；後續查詢、Event、錯誤及日誌均不得出現。 |

### 11.2 通行結果與固定優先序

| 情境 | 預期結果 | 建立 Access Event |
| --- | --- | --- |
| 已認證但 Source 停用 | `REJECTED + SOURCE_INACTIVE` | 是 |
| 無效 QR | `REJECTED + INVALID_QR_CREDENTIAL` | 是 |
| Face 輸入為 UNKNOWN | `REJECTED + FACE_UNKNOWN` | 是 |
| MATCHED Face 沒有現行 Mapping | `REJECTED + FACE_SUBJECT_NOT_MAPPED` | 是 |
| QR 映射到已撤銷 Qualification 後 ENTRY | `REJECTED + QUALIFICATION_REVOKED` | 是 |
| 已 `INSIDE` 再 ENTRY | `REJECTED + ALREADY_INSIDE` | 是 |
| 已 `EXITED` 再 ENTRY | `REJECTED + QUALIFICATION_ALREADY_USED` | 是 |
| ENTRY 過早 | `REJECTED + QUALIFICATION_NOT_YET_VALID` | 是 |
| `NOT_ENTERED` 且 ENTRY 首次 server receivedAt >= validUntil | 其他較高順位條件未成立時，`REJECTED + QUALIFICATION_EXPIRED`；不是只看執行當下時鐘。 | 是 |
| `NOT_ENTERED` 就 EXIT | `REJECTED + NOT_INSIDE` | 是 |
| 已 `EXITED` 再以 QR EXIT | `REJECTED + ALREADY_EXITED` | 是 |
| Source 認證失敗 | 獨立認證錯誤，沒有通行 outcome | 否 |
| Event envelope／媒介格式錯誤 | 獨立 validation error，沒有通行 outcome | 否 |
| 同冪等鍵但內容不同 | `IDEMPOTENCY_CONFLICT`，沒有通行 outcome | 否 |
| 超過 request、body 或 page limit | 獨立限制錯誤，沒有通行 outcome | 否 |

ENTRY 必須按第 6.2 節、EXIT 必須按第 6.3 節取得第一個成立 reason code。同時符合多個條件時不得回傳多個原因，也不得因程式路徑不同改變優先序。

Qualification 時間錯誤、Face重複、越權與公開限制均拒絕，使用 D150 的技術 status，不冒充 Recognition 的通行 reason；未知保存仍按第7節。

### 11.3 冪等、並行與完整保存

| 情境 | 預期結果 |
| --- | --- |
| 同 Source、同 external event ID、相同內容順序／並行重送 | 只一個 Event，原樣回放首次結果；首次允許最多一次 Presence 轉移，首次拒絕及重送都是零次轉移。 |
| 同 Source、同 ID、不同內容 | `IDEMPOTENCY_CONFLICT`；不覆寫、不新增 Access Event。 |
| 不同 Source 使用相同 ID | 視為互不衝突的不同事件。 |
| Face 舊結果沿用原 ID 重送 | 依冪等契約回放首次結果。 |
| Face 舊結果以新 ID 延遲送達 | 視為新事件，按相關 FIFO 有效順序的目前 Mapping 處理，不查歷史，也不搶讀未完成前序操作。 |
| 同資格兩筆不同事件並行 ENTRY | 原為 NOT_ENTERED，除 Presence 競爭外其餘 ENTRY 條件均通過且正常保存時，最多一筆 ENTRY_GRANTED、另一筆 ALREADY_INSIDE；兩筆 Event 均保存。前提不成立仍依首因判斷；不同資格可各自成功。 |
| 同資格 Face 先完成 EXIT、QR 後處理 | 正常 EXIT 前提下，Face 為 `EXIT_RECORDED`；QR 仍映射舊資格而為 `ALREADY_EXITED`；兩筆 Event 均保存。 |
| 同資格 QR 先完成 EXIT、Face 後處理且中間無重綁 | QR 為 `EXIT_RECORDED`；Face Mapping 釋放後，Face 為 `FACE_SUBJECT_NOT_MAPPED`；兩筆 Event 均保存。有介入重綁時按目前映射及正常首因裁決。 |
| ENTRY 與修改競爭 | 依入口登記 FIFO，先 ENTRY 成功則修改失敗；先修改成功則 ENTRY 完整依新資料判斷。 |
| ENTRY 與撤銷競爭 | 依入口登記 FIFO，不允許後到撤銷越過慢認證的較早 ENTRY；ENTRY 成功後撤銷失敗，ENTRY 未入場時後項仍依規則判斷。 |
| 成功 Event／Presence／必要 Mapping 保存失敗 | 已確認失敗回系統錯誤，不回 `ACCEPTED`；三者共同原子保存，不留可觀察部分成功。提交不明依第 7.4 節確認／停寫。 |
| 拒絕 Event 保存失敗 | 回系統錯誤，不假裝已完成可稽核的 `REJECTED`。 |
| 依賴可變資料的拒絕與資料變更競爭 | 成功及拒絕都保護 Source／Mapping／Qualification 決策依據；不能只讀 snapshot 後提交舊拒絕，衝突須安全重取範圍並重新裁決。 |
| 首次尚無 Face 協調位：綁定與 MATCHED 未映射拒絕競爭 | 同鍵首次建立也有真實共用寫入競爭；綁定先確立則按綁定資格裁決，未映射拒絕先確立才可保存未映射 Event；不只負查／no-op，也不吞 duplicate key 續用中止交易。 |

### 11.4 權限、查詢與秘密

| 情境 | 預期結果 |
| --- | --- |
| Viewer 權限 | 可使用三類查詢，不可建立、修改、撤銷或提交 Recognition Attempt。 |
| Operator 權限 | 可管理規則允許的 Qualification 並使用三類查詢，不可提交 Recognition Attempt。 |
| Source 權限 | 只能提交自身 Recognition Attempt，不可登入或查詢營運資料。 |
| Qualification 清單 | 無篩選，createdAt 由新到舊並以 Qualification ID 穩定排序；可分頁。 |
| INSIDE Qualification 清單 | 只列 `INSIDE`，含已逾期在場資格，不含未入場／撤銷／已離場；不可宣稱為真人在場，可穩定分頁。 |
| Event 清單 | 只支援 `qualificationId`、`outcome`、`reasonCode`，receivedAt 由新到舊並以 Event ID 穩定排序。 |
| 查詢欄位 | Operator／Viewer 相同；faceBound 表示有效綁定，過期 INSIDE 仍綁定；前序準時項保護與可終結殘留引用分開，不顯示完整 subject。 |
| Event／查詢／日誌敏感資料 | 不得包含原始 QR、Source credential 或完整 `provider + externalSubjectId`。 |

### 11.5 公開 sandbox

| 情境 | 預期結果 |
| --- | --- |
| 固定公開主流程 | OpenAPI／curl 可完成第 9.4 節全部步驟並得到兩筆 Event。 |
| 共用 credential | README 範例可操作，但 credential 與 deployment／database／maintainer secret 完全分離。 |
| 每日自動重置 | 臺北 03:00 外部排程；停新項、有限 drain、停 API 並隔離舊 DB 工作後清除 Demo、恢復 seed，成功才重啟；公開 credential 不變。 |
| 維護者手動重置 | 非公開命令可執行同等重建；任何公開角色及 API 都不可觸發。 |
| 重置期間請求 | 可以失敗；文件揭露固定時間且使用者可於完成後重試。 |
| 最低公平使用限制 | Request rate、body 及 page size 超限時拒絕且不建立 Access Event。 |
| 公開資料警語 | README 明示共用、可互相影響、每日清除、只供虛構資料且無 SLA。 |

### 11.6 接收、故障與預算驗收

以下均為待實作驗收，不是已執行測試。細項對應追蹤矩陣 L01–L27、L36。

| 情境 | 預期結果 |
| --- | --- |
| 完整接收與慢上傳／認證／DB | 同步基本檢查與準入後固定時間及序號；慢上傳不以首 byte 提早算，慢認證不後移準時點；登記不是授權。 |
| 同毫秒及相關寫入先後 | 序號固定順序；建立／修改／撤銷／QR／Face／整理與重綁不超車，登入／普通唯讀不全排入 FIFO。 |
| 準時 QR／Face 延後處理 | 期限內完整接收、期限後執行不能僅因延遲而 EXPIRED；後到整理／重綁不搶先破壞，其他拒絕規則仍有效。 |
| 原 HTTP 逾時／斷線 | 原項未取消、首次時間與預算未刷新；五秒後驗證仍未完只回去敏技術等候，無可信進度洩漏。 |
| deadline 與完成競爭 | 每 HTTP 只回一次，晚結果不再回舊連線，但原結果保存供可信重送。 |
| 原項在途及同 ID 重送 | 可信同內容只查原進度，不新增原項／輪次；區分等待、處理、故障暫停及完整結果，無刻意再等五秒。 |
| 提交成功但回覆遺失／延遲 | 真 DB／受控傳輸故障驗證可能晚成功；無充分證據停寫，不靠 mock timeout 或查不到 Event 推論 rollback，不盲重做。 |
| 確認失敗與額度競爭 | 單送按D136立即／一秒／後續兩秒及格數串行；原生中止組按§7.5預扣兩格不退、獨占，已準入組有跨窗／無組內間隔例外；不得另開免費清理。 |
| 確認超限與晚證據 | 十秒／七格，禁止新單送／新中止組；已準入兩送組有 D129 越窗例外。晚結果可回放，充分安全且剩餘執行有效時依D89續辦，不補額度。 |
| 續辦再次未知 | 原確認額度沿用，上一輪無效果證據不能解新寫入；無證維持停相關寫入。 |
| 執行及確認時間重疊 | 初次排隊不計執行，開始後暫停／確認／恢復等候都計；非 15＋10 秒保證，重送不補滿。 |
| 最後輪及時間耗盡 | 三輪含首次，最後已準入輪可在剩餘時間完成；十五秒到不新增業務工作，已送工作不假當 rollback，安全收尾不補確認額度。 |
| 技術終局與新 ID | 充分無效果且不晚寫、已安全收尾才技術未完成終局；不撤銷資格、不假 REJECTED／EXPIRED，同 ID 不再執行，新 ID 正常準入及新時間。 |
| 告警與實際接管 | 告警非接管；超限須表明停新確認／等在途證據或人工，仍可能條件式續辦；實際管控／維護不得被晚 callback 越過。 |
| 舊通知與下一項處理權 | 舊 finally／failure 不誤解新鎖或誤停新服務；保存結果可更新不等於全局解鎖。 |
| 受控延遲展示 | HTTP 超五秒原項確知未完，合法重送可見進度；原項在十五秒執行預算內完成後回同結果，時間／FIFO／輪次未刷新。 |

### 11.7 容量與維護故障驗收

細項對應追蹤矩陣 L28–L35、M05–M10；容量數字未量測。

| 情境 | 預期結果 |
| --- | --- |
| 32／8／32 任一資源滿 | 一般新項完整所需名額在登記前同步取得，失敗不登記且還未登記暫占；沒有超收或重複還槽。 |
| HTTP 超五秒驗證仍在工作 | 只還 HTTP 資源，驗證真正完成及安全轉交才還驗證槽；未知原項不還原項槽。 |
| 原項滿時同 ID 重送 | 保留有限驗證路徑辨認既有原項，不增原項、不刷新時間；入口滿未驗證不能宣稱原項不存在或失敗。 |
| 可信新項滿載拒收 | 無準時保留、無 Event，不冒稱排隊或通行拒絕；不淘汰舊項，重試用新時間且可逾期。 |
| 外部每日排程 | API 已停止／不健康時獨立命令仍可連 DB；臺北 03:00 可自動觸發，不依靠公開角色。 |
| drain 超時與舊 DB 工作 | 超時仍進安全重置，但清除前須停止 API 並證明舊工作不干擾新資料，不把程序停止當取消證明。 |
| 清除／seed 階段失敗 | API 維持不可用，維護者修復後重跑；成功才自動啟動，連續重建冪等且公開憑證不變。 |
| reset 與故障續辦競爭 | 維護否決舊恢復許可，原項／晚 callback 不得寫入新 Demo；不宣稱跨重置原項延續。 |

## 12. 求職作品完成證據

本節是後續 release gate，不是額外業務功能。公開 repository 必須提供可重跑證據，完成前不得將能力寫成履歷成果。

- 使用 Node.js／TypeScript 實作 REST API，並以 HTTP e2e test 經公開介面完成第 9.4 節閉環。
- OpenAPI contract 必須有可重跑驗證，證明文件與成功結果、通行拒絕、認證／授權錯誤、validation error、冪等 conflict 及系統錯誤一致；不能只有互動文件頁面。
- 權限測試涵蓋 Operator／Viewer 寫入差異、Source 機器認證、Source 不可查詢，以及方向只能由 server-side Source 取得。
- 使用真實 MongoDB 驗證 Face Mapping 唯一性、冪等、修改／撤銷競爭、並行 ENTRY／EXIT 及 fail-closed；不得只用 in-memory mock 證明資料一致性。
- 以真實並行 HTTP requests 證明同一資格每次狀態最多轉移一次，所有已準入的新合法 attempt 完成保存後有一致的 Event；同鍵重送只一個 Event，首次拒絕不轉移。技術準入拒收及保存未知不能假稱已留下 Event。
- 三類清單按 D152 的 keyset／索引，八種Event filter case各別量測及explain；不預寫 latency或百分比，不以空資料或合併filter數字假證效能。
- D153結構化allowlist與request／operationUUID、有限日志輪替及私密查詢，配合D155代理／Mongo／容器輸出已知秘密掃描；不能把best-effort技術日志冒充必要Event。
- 自動化測試涵蓋第 11 節全部業務情境、固定 reason-code 優先序、一次顯示 QR、查詢去敏、準時 FIFO、未知停寫與續辦、共用預算、容量準入／釋放、每日重置及最低公平使用限制；逐項連至追蹤矩陣及真實執行證據。
- CI使用D125精確基線與D156未被取代的命令／期限規則及D166正式Jest runner；fault／perf專項雖opt-in，仍是完整交付必需證據，普通CI綠燈不能解鎖全部成果。
- Docker依D125／D155 pins及D157逐關流程，乾淨隔離環境重建；真實測試與Docker尚未執行。正式證據綁clean sourceCommit與code／lock／config／image／fixture／環境，報告發布revision可不同。
- 公開 API runtime、互動式 OpenAPI 與 README curl 流程必須實際可用；本機 Demo command 也必須自動執行並 assert 第 9.4 節結果。
- 每日自動重置、非公開維護者重置及可設定 request／body／page limits 必須具有可重跑驗證，不只出現在文件。
- README／ADR 說明產品資料流、角色與信任邊界、Qualification 狀態、冪等與一致性選擇、Mock Face 邊界、公開共享資料、重置及已知限制。

公開證據完成後，履歷只能描述實際通過驗證的 Node.js／TypeScript、MongoDB、REST API、認證授權、冪等、並行一致性、OpenAPI、Docker、CI 與公開部署成果。v1 沒有下游 message broker、Webhook、outbox 或通用事件匯流排，因此不得將整體系統概括為事件驅動架構，也不得宣稱真實門禁、人臉辨識或硬體整合。

## 13. 已採用架構前提與剩餘實作契約

### 13.1 已採用前提，不重新當成候選

| 項目 | 已確認方向 | 來源 |
| --- | --- | --- |
| 技術／運行 | NestJS 預設 Express HTTP adapter、strict TypeScript、模組化單體；僅一個 API process，不重用舊 Express routes 或宣稱 Node 原生無框架。 | D37、D74 |
| 核心 | AccessModule，內分資格管理、辨識、去敏唯讀用例，共用唯一純資格／通行政策，不形成萬用 AccessService。 | D57、D59 |
| 能力限制 | 管理協調自己的完整操作，不繞經辨識或取得 ENTRY／EXIT／任意 Presence setter；查詢唯讀，保存能力不是萬用共用入口；EXIT 包含必要映射釋放。 | D55、D57、D59 |
| 身分／來源 | AuthModule 與 SourcesModule 分開；Sources 不反向依 Auth；Auth 只取窄來源驗證能力，Access 只取無憑證來源事實。新嘗試裁決啟用狀態，既有結果回放優先。 | D61 |
| 依賴／接線 | HTTP 認證／角色確認後進核心；Access 不直接依 Auth、HTTP 或具體 Mongo；純 domain 不依框架／DB／session，infra 實作窄 ports，由組合入口接線。完整操作讀取及提交相容，衝突重新取範圍全段判斷。 | D63 |
| 保存／映射 | 官方 Mongo driver 多文件交易、成功／拒絕決策新鮮度保護、事件鍵唯一約束；獨立目前 Face 映射、空協調位及首次競爭保護，不增加歷史或主檔。 | D65、D67 |
| 順序／故障 | 相關完整寫入同步登記 FIFO，準時保障、HTTP 不取消原項、有限確認、安全條件式續辦及未知停寫。 | D72–D95 |
| 準入／維護 | 登記前完整容量準入及生命期釋放；每日臺北 03:00 外部停止／隔離／重建／成功才重啟。 | D52、D97、D99 |
| 重寫 | 同一repo／root package／docs；D161依使用者新決定不另備份，舊backend／frontend已移出工作目錄，保留docs、Git及根目錄文件。 | D140、D157、D161 |

最初六頂層模組只是歷史候選。完整目錄、窄ports、schema／API／版本／部署／驗收在D117–D157及實作方案，均屬已採規劃而非完成工程。

### 13.2 已收斂規劃、阻塞實測與停止點

P01–P15採用決策與逐關驗收見[實作方案](implementation-plan.md)及追蹤矩陣。剩餘不是讓實作者自由選架構：Face唯一索引替換微型真測、固定工具相容性及fault映像digest是明確前置gate；未過便停止回討論，不靜默換策。外部主機／domain／TLS需環境提供。D161已取代舊碼私密備份要求，不再建立legacy備份。

目前矩陣為 A01 與 G04b 直接證據涵蓋的 A11–A16、B13、B41、B42 共 10 項 V（G04b 新增 9 項；G05a／G05b／G05c不新增完整requirement V），其餘126項仍U；這不代表完整 v1、HTTP、FIFO、registry 或 fault protocol 完成。G04b 證據只涵蓋六 collection schema／guards、共同保存、freshness、QR／Face解析、comparison artifact、Event/source idempotency unique、canonical snapshot 與 error classification。G05a另證內部FIFO primitive；G05b另證純execution／confirmation budget ledger、七格、native group與continuation admission；G05c另證process-local registry／opaque artifact comparer、4096 bounded retention、join／conflict、canonical／safe technical terminal、generation／late-callback fence、epoch／read-only claim primitive。G05c仍未接上G05a／G05b／G05c composition、Mongo writeRunClaim state machine、完整 capacity／HTTP／use-case／driver／G10／G11；完整 ingress、use-case接線、budget wire及後續gate仍未驗。B33–B36、L05–L13、L20–L21、L28–L36逐項仍U，不能因 primitive 測試升級完整要求。不同 externalEventId 的並行 ENTRY 不在 adapter 內自動新 scope 重判；同 ID 並行首次請求只保證最多一筆 committed，未知競爭與後續 confirmation／retry 由後續 gate 處理。下一合法 gate 為 G06a。

## 決策來源

本文件以[討論紀錄](./discuss.md) D01–D35為業務底稿，同步至D157；D114明確授權持續逐題討論、預設接受及必要文件同步，非逐題個別回答。D69依D72、D17依D76修正；D89安全續辦保留，D130永久終局候選未採；D117取代binaryv1、D131七格取代三次、D129原生兩送局部例外、D149同epoch普通重啟寫入關閉皆有效。其餘歷史候選及背景不新增產品要求。

本次同步不是新業務決策，也不改寫原始討論。未來若變更已確認結論，須先新增討論決策 block，再同步本文件、驗收及追蹤矩陣。實作／測試／公開證據未完成前，不把文件採用視為履歷成果。
