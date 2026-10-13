# PassHub 本機移除前交接與未完成工作

更新日期：2026-10-13（Asia/Taipei）

## 1. 文件目的

這份文件用於在 `/home/sean/PassHub` 從目前電腦移除後，讓未來的開發者或 AI 能從 GitHub 重新取得專案，辨認真正完成的範圍，並從正確的 Gate 繼續。

本文件只記錄交接狀態，不代表尚未完成的 Atlas、公開部署或最終驗收已經通過。

## 2. 可恢復的 Git 快照

- Repository：`git@github.com:cgit6/PassHub.git`
- Branch：`main`
- 交接盤點時的 HEAD：`bcba73f62aedfea0c0d4e4aadafa3f8a8558a942`
- Commit：`bcba73f Add production and Mongo tests`
- Commit 時間：2026-10-10 14:15:05 +08:00
- 交接盤點前狀態：本機 `main` 與 `origin/main` 為 `+0 / -0`，沒有已知未推送 commit，工作樹乾淨。

本文件建立後會成為新的工作樹變更；**移除本機專案前，仍須把本文件 commit 並 push，重新確認 `main` 與 `origin/main` 同步**。上面的 commit 是建立本文件前的可恢復基準，不是本文件發布後的新 HEAD。

## 3. 一句話進度

PassHub 的核心業務、Local MongoDB 部署、測試、CI、OpenAPI 與本機 Docker Demo 已完成既有 Gate；Local＋Atlas 雙部署改造已完成 `G12g-0` 至 `G12g-3`，目前停止在：

> `G12g-3 PASS；下一個合法 Gate 是 G12g-4。`

尚未完成的是：

1. `G12g-4`：真實 MongoDB Atlas initializer 與整合驗證。
2. `G12g-5`：Atlas blue／green 維護與每日 reset。
3. `G12g-6`：Local／Atlas 業務等價及受保護 CI。
4. `G12g-7`：公開 Atlas HTTPS 部署。
5. `G12h`：最終 release audit。

## 4. 已完成且可以保留的成果

### 4.1 核心作品能力

- Node.js／TypeScript 的訪客單次通行資格與辨識決策 API。
- QR 與模擬 Face 結果可交叉用於 ENTRY／EXIT。
- Operator、Viewer、ENTRY Source、EXIT Source 的認證及權限邊界。
- `NOT_ENTERED → INSIDE → EXITED` 單次 Presence 狀態機。
- MongoDB 官方 driver、transaction、資格／映射／Presence／Event 的共同原子保存。
- 冪等、同鍵異內容衝突、並行 ENTRY、撤銷與 ENTRY 競爭、未知結果確認及故障處理。
- 嚴格 HTTP 輸入、資源限制、分頁、去敏查詢、結構化紀錄及 private runtime control。
- 本機每日維護、reset／seed、NGINX HTTPS、Docker Compose、OpenAPI、curl Demo、Jest 與 GitHub Actions CI。

### 4.2 已通過的 Gate 範圍

- `G01a`／`G01b`、`G02` 至 `G11g`：核心、HTTP、Mongo、故障、效能及 Local maintenance 的既有證據。
- `G12a` 至 `G12f`：歷史 release baseline、OpenAPI、需求稽核、clean install、CI 與 Local Docker Demo。
- `G12g-0`：Local＋Atlas 雙部署需求與架構重基線。
- `G12g-1`：exact deployment profile、Atlas dataset descriptor 與 database target 注入。
- `G12g-2`：Mongo capability verifier 分離；真 Local 通過，Atlas 分支只有 mock 證據。
- `G12g-3`：Local／Atlas 雙 Compose 靜態契約與 Local 回歸。

### 4.3 目前雙部署已經具備的基礎

- 只接受 `LOCAL_SELF_HOSTED` 與 `ATLAS_MANAGED` 兩個 exact profile。
- 兩種 profile 共用同一份 API image、application、domain、REST API、schema 與業務語意。
- Local 固定使用 `passhub_demo`、MongoDB 8.0.32、`rs0`、single-member writable PRIMARY。
- Atlas 固定使用 `passhub_demo_blue`／`passhub_demo_green`。
- Atlas active dataset descriptor 固定為無秘密的四欄資料：`profile`、`slot`、`databaseName`、`datasetEpoch`。
- Atlas Compose 已存在，只有 API＋NGINX，不內建 Mongo service、Mongo volume、root password 或 keyfile。
- Atlas API Compose 只接 application Mongo URI secret；maintenance credential 不得注入公開 API container。

### 4.4 現有直接證據

主要證據位置：

- `docs/evidence/g12f/`：Local Docker Demo。
- `docs/evidence/g12g-1/`：profile 與 descriptor。
- `docs/evidence/g12g-2/`：capability verifier 與真 Local Mongo。
- `docs/evidence/g12g-3/`：雙 Compose 靜態契約與 Local 回歸。
- 其他已完成 Gate：`docs/evidence/<gate>/`。

最後一次 `G12g-3` 限定驗證記錄為：

- 完整 unit：86 suites／1454 tests。
- `G12g-3`：1 suite／67 tests與20個 Compose checker cases。
- `G12g-1`、`G12g-2`、Local `G11a` 與 Local Docker Demo 回歸通過。

這些是對各自 Gate 的歷史證據，不可直接推論目前已有真 Atlas、公開 HTTPS 或最終 release 證據。

## 5. 尚未完成的外部前置

下列項目在交接時沒有完成證據；即使某項已在 Atlas UI 手動建立，沒有新的文件與測試證據前也必須視為「未確認」：

- 可用的 MongoDB Atlas cluster。
- 僅允許必要來源的 Atlas Network Access allowlist。
- `passhub_app` Database User 及其最小權限角色。
- `passhub_maintenance` Database User 及其最小權限角色。
- 兩組互不相同的 application／maintenance SRV URI secret。
- 公開 runtime host。
- domain 與 DNS。
- 正式 TLS 憑證與更新方式。
- 公開 host 上受保護的 secret、descriptor、runtime 目錄。
- Asia/Taipei 每日 03:00 scheduler。
- 受保護 CI environment／secrets。

`sean` 若已是 Atlas Database User，只能暫時作管理或人工驗證使用；不可直接當作最終 application 與 maintenance 共用帳號。

任何完整 Atlas URI、密碼、JWT key、comparison key 或其他秘密都不得寫入 Git、Markdown、issue、CI log 或聊天紀錄。

## 6. 下一步：G12g-4 真 Atlas initializer 與整合

### 6.1 目標

用真 Atlas 證明 SRV、TLS、認證、session、transaction、既有 schema／index 檢查、兩種 credential 的權限邊界及 API 啟動都能運作。Mock 不能替代此 Gate。

### 6.2 建議的小步驟

以下是 `G12g-4` 內的執行單元，不是新增正式 Gate；每個單元完成後都要先測試及覆核，再進下一個。

1. **權限稽核**
   - 從 production API 與 initializer 實際使用的 MongoDB commands 反推最低權限。
   - 建立 `passhub_app_role` 與 `passhub_maintenance_role`。
   - 角色只能作用於 `passhub_demo_blue`／`passhub_demo_green`，不得套用所有 database。
   - application role 不得 create／repair schema 或 index，也不得 drop collection／database。
   - maintenance role 只取得 initializer 所需能力；仍不得 drop collection／database 或改動其他 database。

2. **Atlas 外部資源準備**
   - 建立 `passhub_app` 與 `passhub_maintenance` 兩個 Database User，使用不同強密碼。
   - 建立精確 Network Access allowlist。
   - 產生兩條不同用途的 SRV URI；URI 應明確指定需要操作的 database 或由程式的 validated target 決定，不能讓任意 database name 穿透。
   - 把秘密存成 Git 之外、權限受限的 file-backed secret；不要放在 `.env` 後提交。

3. **Private initializer**
   - initializer 必須是獨立維護命令，不是 public API route，也不能常駐在 API Compose service。
   - 使用 maintenance credential 對指定 inactive slot 建立／核對 exact collections、validators、indexes、metadata 與 canonical seed。
   - 重跑必須冪等；若現況不符合 exact schema，應 fail closed，不可默默改成另一種結構。
   - 初始化只能作用於 allowlist 內的單一 database；禁止 drop database、drop collection、清除另一個 slot 或碰觸其他 database。
   - 建立新 `datasetEpoch`，metadata 與 descriptor 預期值必須一致。

4. **Application credential 的負面能力驗證**
   - application user 能完成正常 API 需要的 find／insert／update／transaction。
   - application user 無法執行 initializer、建立／修復 schema、建立 index、刪除 collection 或存取非 allowlist database。
   - maintenance secret 不得出現在 API container、Compose normalized config、process environment、log 或公開 evidence。

5. **真 Atlas integration**
   - 驗 SRV、TLS、authentication、writable topology 與 logical session。
   - 驗真 transaction commit／abort及保存失敗時不放行。
   - 驗 production read-only schema/index inspector。
   - 驗用 Atlas profile、正確 descriptor、application secret 啟動 API。
   - 驗 descriptor 的 container owner／mode、唯讀 mount、啟動只讀一次及 epoch mismatch pre-listen failure。

6. **測試與證據**
   - 新增專項 unit、真 Atlas integration、negative permission 及 secret scan。
   - 重跑所有因 shared startup／adapter／Compose 修改而失效的 targeted suites。
   - 產生 `docs/evidence/g12g-4/report.md` 及去敏 runtime evidence。
   - 經需求、架構、程式與測試覆核後 STOP，不直接跨入 `G12g-5`。

### 6.3 G12g-4 通過條件

- 真 Atlas transaction 成功，不是 mock。
- initializer 對兩個 slot 的其中一個可從空狀態冪等建立 exact schema／index／seed。
- application／maintenance credential 已分離並用真權限測試證明。
- public API 無 create／repair schema 能力，且拿不到 maintenance secret。
- URI、密碼及其他秘密沒有進入 Git diff、公開報告或 log。
- Local profile 沒有被 Atlas 改造破壞。

## 7. G12g-5 Atlas blue／green maintenance

### 7.1 目標

實作 Atlas profile 的每日重置，但不停 Atlas cluster。使用 blue／green database 切換，確保公開 API 在無法確認資料完整時保持關閉。

### 7.2 必須完成的流程

固定順序如下：

1. 取得唯一 maintenance controller lock。
2. 建立 maintenance marker，使 NGINX 封閉公開入口。
3. 要求既有 API 停止接新工作，有限 drain，最長 30 秒。
4. 停止唯一 API process，並直接證明原 process 已消失。
5. 選擇 inactive blue／green slot。
6. **先證明 inactive slot 可以安全重用**。
7. 用 maintenance credential 建立 exact schema／index、canonical seed、新 epoch 及 null claim。
8. 完整 verify inactive slot。
9. 使用原子替換發布新的 active dataset descriptor。
10. 建立新的 process identity 與一次性 run ticket。
11. 啟動 API，通過 private readiness 後才重新開放入口。

### 7.3 最大未解風險：safe-reuse

不能只因 inactive slot 已超過 24 小時就認定可以清理。必須有直接、可驗收的證據，證明舊 API／driver／重送／晚到工作不會再寫入該 slot。

若無法證明，`G12g-5` 必須 STOP 回到架構討論：

- 不得清理或重用 slot。
- 不得用 drop database／collection 當捷徑。
- 不得把 blue／green 稱為 backup 或 restore 機制。

### 7.4 故障語意

- descriptor publish **之前**失敗：舊 descriptor 保持不變，但公開入口繼續封閉。
- descriptor publish **之後**失敗：新 descriptor 已是唯一 authoritative 狀態，不得 rollback 到舊 slot；入口維持封閉，只能 controlled rerun。
- 任一步保存或驗證結果不確定：不得開放 API。

### 7.5 驗收

- 每個流程步驟、故障點、controller 競爭及 controlled rerun 都有測試。
- 直接驗 old-write isolation 與 safe-reuse predicate。
- 驗 descriptor atomic publish 不暴露 partial file。
- 驗 restart recovery、publish 前／後 failure 與不 rollback。
- 建立 `docs/evidence/g12g-5/` 後 STOP。

## 8. G12g-6 Local／Atlas 業務等價與 CI

### 8.1 業務等價

用同一批 fixture 與 request vectors 分別跑 Local 與真 Atlas，比較：

- HTTP status。
- reason code。
- Presence transition。
- Event 投影。
- QR／Face 等敏感資料的去敏結果。
- 冪等重放與同鍵異內容衝突。
- 最終資料語意。

允許的差異只能來自 topology、連線與 maintenance strategy；不允許 profile 改變 domain、application、HTTP contract 或業務結果。

### 8.2 CI 分層

- 一般 pull request：只使用 Local Docker 資源，不取得 Atlas secrets。
- 受保護 manual／release workflow：才能使用 Atlas credentials，執行真 Atlas integration 與 parity。
- Atlas workflow 必須有唯一測試資料範圍、cleanup、防並行污染與去敏 artifact。
- Local fault／performance 證據與 Atlas capability 證據分開保存，不互相冒充。

### 8.3 驗收

- 同一 vectors 在兩個 profile 的業務輸出一致。
- 普通 CI 無法讀取 Atlas secret。
- 受保護 workflow 有可追溯 run、commit、image digest 與去敏 evidence。
- 建立 `docs/evidence/g12g-6/` 後 STOP。

## 9. G12g-7 公開 Atlas HTTPS 部署

### 9.1 外部條件

GitHub 只承載 code 與 CI，不會替本專案常駐執行 API。開始前必須已有：

- 可執行 Docker Compose 的外部 host。
- domain／DNS。
- TLS 憑證。
- Atlas cluster、allowlist 與兩組 database credentials。
- 受保護的 runtime、descriptor 與 secret filesystem。
- Asia/Taipei 每日 03:00 scheduler。

### 9.2 部署與驗收

- 部署與 source commit、API image digest 一致的 `ATLAS_MANAGED` profile。
- 驗 HTTPS、NGINX、可信 proxy、rate limit 與安全 headers。
- 從公開入口重跑 OpenAPI 主流程：登入、建立資格、QR ENTRY、查詢 INSIDE、模擬 Face EXIT、查詢 EXITED／Events。
- 確認 private runtime control、initializer、maintenance credential、descriptor publisher 不可由公開網路存取。
- 驗真實 03:00 reset、API restart、失敗時入口封閉及 controlled recovery。
- 公開說明只能宣稱求職 Demo；不宣稱 HA、SLA、正式個資保障、真實人臉辨識、RTSP 或硬體整合。
- 建立 `docs/evidence/g12g-7/` 後，才可把頂層 `G12g` 標為完成並進入 `G12h`。

## 10. G12h 最終 release audit

必須以同一個 clean、已提交的新 HEAD 重新產生 release 證據，不能只沿用歷史 PASS。

至少需要：

- `npm ci`、build、完整 unit。
- Local 真 Mongo integration、HTTP e2e、fault、performance、maintenance、Docker Demo。
- 真 Atlas initializer、transaction、blue／green reset、parity 與 public smoke。
- OpenAPI、boundary、negative compile、secret scan。
- 現行 132 正式要求＋11 排除＝143 requirements 的逐項 evidence mapping。
- source commit、lockfile、non-secret config、image、fixture 與報告 fingerprints。
- 重新核對 README 所有能力聲明，只留下實際有證據的部分。

最終報告必須分開寫清楚：

- Local 證明了什麼。
- Atlas 證明了什麼。
- Public deployment 證明了什麼。
- 哪些限制仍然存在。

`G12h` 完成前，不應宣稱整個雲端版本或完整 release 已完成。

## 11. 重新 clone 後的恢復流程

```bash
git clone git@github.com:cgit6/PassHub.git
cd PassHub
git status --short --branch
git rev-parse HEAD
npm ci
npm run build
npm run test:unit
npm run test:g12g1
npm run test:g12g2
npm run test:g12g3
npm run check:g12f:docker-demo
npm run demo:g12f:docker
```

環境基準：

- Node.js：`>=24.21.0 <25`
- npm：`>=11.19.0 <12`
- 歷史正式測試使用 `node:24.21.0-bookworm-slim`。
- Docker 與 Compose 必須可用；歷史 `G12g-3` host orchestration 使用 Docker 29.0.0、Compose v2.40.3。

若 host Node 版本不符合 `package.json` engines，應使用 exact Node container 執行正式驗證，不能把較舊 host toolchain 的結果當 release 證據。

上述命令只是恢復與回歸入口。未重新連真 Atlas前，不得把它們當 `G12g-4` 證據。

## 12. 本機移除後不會由 GitHub 還原的內容

以下路徑受 `.gitignore` 排除，重新 clone 不會恢復：

- `node_modules/`：依賴，可由 `npm ci` 重建；盤點時約 145 MB。
- `dist/`：編譯產物，可由 `npm run build` 重建；盤點時約 9.3 MB。
- `coverage/`：測試覆蓋率產物，可重新執行測試產生；盤點時約 1.9 MB。
- `output/`：私密／原始 evidence；盤點時約 6.9 MB、247 個檔案，主要為 G09b raw samples 與完整 explains。
- `.env*`、secret files、TLS private key、Mongo URI、JWT key、comparison key。
- Docker containers、networks、volumes 及其中的本機 Demo Mongo 資料。
- 未加入 Git 的 IDE 設定與暫存檔。

其中 `output/` 的公開去敏摘要已另有 tracked `docs/evidence/`，但 raw samples／完整 explains 不在 Git。如果未來仍需要稽核原始 G09b run，應在刪除專案前另行安全保存 `output/`；否則接受它會永久消失，之後只能重新執行產生。

**不要為了備份方便把 `output/`、secret 或 `.env` 強制加入 Git。**

## 13. 本機移除前檢查表

- [ ] 閱讀本文件，確認下一 Gate 為 `G12g-4`。
- [ ] `git status --short --branch` 只包含預期的交接文件與對話紀錄變更。
- [ ] commit `docs/project-removal-handoff.md` 與 `docs/conversation-history.md`。
- [ ] push 至 `origin/main`。
- [ ] 再確認 `main...origin/main` 為 `+0 / -0` 且工作樹乾淨。
- [ ] 在 GitHub 網頁確認本文件可開啟。
- [ ] 決定是否需要離線保留 ignored `output/`；若不需要，接受 raw evidence 消失。
- [ ] 確認沒有只存在本機而仍需保留的 Atlas URI、密碼或 TLS key。
- [ ] 若已建立 Atlas credentials，確認它們保存在密碼管理工具；不要依賴專案資料夾內的 secret file 作唯一副本。
- [ ] 若有仍在運行的 PassHub Docker resources，先正常停止並確認是否需要保留 volume。
- [ ] 最後才移除 `/home/sean/PassHub`。

## 14. 繼續開發時的閱讀順序

1. 本文件：快速了解快照與未完成工作。
2. `docs/business-scope.md`：不可擴張的產品與業務邊界。
3. `docs/implementation-plan.md`：正式 Gate、STOP、命令與證據規則。
4. `docs/requirements-traceability.md`：143 項現行要求及目前 U／V 狀態。
5. `docs/discuss.md`：決策形成過程，尤其 D207–D210。
6. `docs/conversation-history.md`：從最初履歷討論至本次交接的可見對話存檔；只用來追溯脈絡，不取代最新規格。
7. `docs/evidence/g12g-1/` 至 `docs/evidence/g12g-3/`：最近三個 Gate 的直接證據與限制。
8. `infra/g11/compose.yml`、`infra/g11/compose.atlas.yml`：兩個部署 profile。
9. `src/deployment/internal/g12g1-*`、`g12g2-*`、`g12g3-*`：目前雙部署實作基礎。

若文件彼此出現衝突，以最新有效決策與直接工程證據為準；不要把早期 Gate 的 PASS 自動外推到後來新增的 Atlas 要求。

## 15. 維持不變的邊界

- 不新增多租戶、多據點或 Access Group。
- 不做真實人臉辨識、enrollment、影像、confidence、RTSP、攝影機或門鎖整合。
- Face 仍只是模擬「外部辨識服務已完成辨識」的輸入結果。
- 不新增 UI、報表、Webhook、背景投遞、微服務、CQRS 或通用 plugin 系統。
- public API 不取得 maintenance 能力。
- 不以 `NODE_ENV` 選擇資料庫或部署 profile。
- 不使用 drop database／collection／volume 完成 Atlas reset。
- 不把 blue／green slot 宣稱為備份或還原。
- 不在缺乏真實證據時宣稱 Atlas 相容、已公開部署、HA 或 SLA。

## 16. 下一個明確動作

恢復專案後不要直接開始公開部署。先執行 `G12g-4` 的第一個小單元：

> 讀取 production Mongo 使用面，整理 `passhub_app_role` 與 `passhub_maintenance_role` 的最小權限清單；經架構與測試覆核後，再到 Atlas 建立兩個角色、兩個 Database User 及對應 secret。

完成這個小單元並保存驗證結果後，才開始 private initializer。
