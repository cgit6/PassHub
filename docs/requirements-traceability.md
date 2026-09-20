# PassHub 有效要求與實作追蹤矩陣

規劃狀態：**D160封口；D161完成舊碼清除；D166改定正式Jest runner；G02–G03c、窄 G04a、G04b 及 G05a 已發行限定 evidence，目前停止於G05a**。工程狀態：**A01、A11–A16、B13、B41、B42 共10條為V（G04b新增9條；G05a不新增完整requirement V），其餘126條仍U**。整理日期：2026-09-20。

這份文件回答：「討論過的要求，實作時如何避免漏掉？」它不是已完成成果，也不授權開始重寫程式。

快速閱讀：先看[實作方案](implementation-plan.md)與第 6 節 P01–P15 採用去向；第 10 節列新增細節及逐關對應。第 5、8、9 節保留早期同步歷史，不代表目前仍待選。第 2、3 節逐項工程驗收，不能只依摘要打勾。

## 1. 來源、用法與完成定義

- 來源：[業務範圍](business-scope.md)、[討論紀錄](discuss.md) D01–D157 及實作方案。衝突依明確採用的新版；D114預設接受是本輪授權，不捏造逐題答覆。候選／背景不當採用，官方來源不當工程證據。
- 本稿整理前的來源 SHA-256：`discuss.md = 96a222bde5938d5aa9a5d250ea61b79a7916fd4b494d3f63f4ec49e833d87da7`；`business-scope.md = 4c8969d698c1e5f315d6ada2a7312482b5b6b01e6098f38004314874a280ca09`。後續更新須記錄基線變動，不以舊摘要覆蓋新決策。
- 以下「責任」是行為邊界，實際接線／目錄規劃見D140–D141；G02–G03c只具限定程式／測試符號與局部 evidence，其餘不能由規劃欄推定已建立。
- 每列的 `T-要求ID` 是**預定驗收情境編號**，不是已存在的測試。欄內分號分開的情境都要覆蓋；必要時拆成多個實際測試。
- 每列 `U` 代表「尚未核對實作／測試／執行證據」。本輪只讀規格，不判定舊程式能否滿足要求；即使舊版已有相似功能，也不能直接標為完成。
- 實作時逐列補上程式符號／路徑、真實測試名稱、重跑命令、結果與 commit。未決細節先討論，不由實作者暗自選定為既成事實。
- 未來依D157固定25個STOP點，完成一子關即交差異／命令／exit／指紋／證據後停止，不能跨關。D114只授權這輪持續討論，不授權不停實作。

完成狀態依序為：`U 未核對 → I 已實作但未驗證 → V 已有可重跑證據 → R 已獨立覆核`。只有有證據的項目才能對外宣稱完成；文件採用狀態與工程完成狀態分開。

## 2. 有效要求矩陣

### 2.1 產品、資格、QR 與 Face

| ID | 有效要求 | 來源 | 責任 | 預定驗收情境 | 證據 |
|---|---|---|---|---|---|
| B01 | 單一邏輯地點；一張資格代表一次來訪，不建立永久訪客主檔。 | D01–D02、D34–D35 | 業務模型 | T-B01：可建立獨立資格；無 Site、租戶或永久 Visitor 管理能力。 | U |
| B02 | Presence 僅為資格使用狀態，不保證真人位置、身分或同一人跨媒介使用。 | D03–D04 | 業務語意／文件 | T-B02：文件明示限制；不宣稱考勤或真人身分驗證。 | U |
| B03 | 資格只經歷 `NOT_ENTERED → INSIDE → EXITED`，不能再次入場。 | D03、D13–D14、D164 | 核心規則 | T-B03：正常轉移；未入場離場、重複方向、離場再入場均拒絕。 | U：G03a純規則與單測已驗；保存／HTTP未驗。 |
| B04 | 只收顯示名稱、有效區間與可選 Face；QR由server產生；未知欄位直接拒絕。 | 業務 §4.1、D34、D104、D150–D151 | 輸入契約 | T-B04：不收Email、電話、公司、目的、受訪者、照片、證件、生物特徵或caller QR；根／巢狀額外與重複鍵拒絕。 | U |
| B05 | QR 是不可猜測的不透明 bearer token 字串，建立成功只回傳完整 token 一次；不產生 QR 圖像。 | D04–D05、業務 §4.2 | 建立資格／秘密處理 | T-B05：建立取得字串；不處理 QR 圖像／相機畫面；查詢、修改、事件、錯誤及日誌不能取回。 | U |
| B06 | 修改不更換或再顯示 QR；不找回、補發、救援或防轉交。 | D05、D15 | 資格管理 | T-B06：修改後原 QR 仍有效；不存在補發／查回功能。 | U |
| B07 | 入場前遺失 QR 可撤銷再建；INSIDE 且無 Face 時不提供 EXIT 救援。 | D05、D14、D34 | 資格管理／文件 | T-B07：撤銷再建可展示；在場遺失情境明示只能重建 Demo。 | U |
| B08 | Face 僅模擬外部辨識結果 `MATCHED`／`UNKNOWN`，不呼叫真實辨識 API。 | D06、D09、D34 | 辨識輸入 | T-B08：兩種結果均可提交；無圖片、confidence、活體或影像處理依賴。 | U |
| B09 | Face鍵是provider＋externalSubjectId，依D119精確原值／位元組上限；只Operator合規預綁。 | D06–D07、D15、D119、D144、D165 | 映射管理 | T-B09：provider grammar／subject UTF8及控制碼、不trim／normalize；成對比對，不新增provider管理；辨識不建槽或綁定。 | U：G03b原值validator／codec已驗；Operator預綁、映射與DB未驗。 |
| B10 | 同 Face 鍵只對應一張未終結資格，建立及修改都檢查唯一性。 | D07、D15、D67 | 映射管理／保存 | T-B10：建立重複、修改重複、並行初次綁定均最多一個成功。 | U |
| B11 | 移除／替換 Face 時釋放舊鍵，更新資格與新舊映射一致。 | D15、D67 | 修改資格 | T-B11：移除、替換、新鍵衝突與保存失敗；不留下半更新。 | U |
| B12 | 撤銷、未入場逾期終結、EXIT 後釋放 Face；INSIDE 逾期保留至 EXIT。 | D07、D16、D20、D69、D72、D76 | 映射終結／協調 | T-B12：各釋放時點及在場不釋放；後到整理不破壞較早準時 ENTRY。 | U |
| B13 | UNKNOWN 只產生 `FACE_UNKNOWN` 拒絕事件；MATCHED 無映射是 `FACE_SUBJECT_NOT_MAPPED`。 | D09、D32 | 決策 | T-B13：兩者理由不同；不建立陌生人資料、不事後認領。 | V：G04b 57-case 真Mongo integration驗證兩種 rejection shape、共同 Event 保存及不配置陌生 slot；完整 HTTP／auth 仍待 G08。 |
| B14 | 新 ID 的延遲 Face 事件不查歷史映射；按相關操作有效順序使用目前映射。 | D31、D76 | 映射讀取／文件 | T-B14：釋放重綁後的新 ID 使用新映射；原 ID 回放舊結果；明示限制。 | U |
| B15 | 建立／修改須 `validUntil > validFrom` 且結束晚於該請求首次接收時間。 | D13、D15、D164、業務 §4.1 | 時間規則 | T-B15：相等、反向、結束已到期拒絕；不因後續處理延誤刷新接收時間。 | U：G03a純時間規則已驗；入口首次時間接線未驗。 |
| B16 | 開始可在過去／現在／未來；允許跨日，不設同日或十二小時上限。 | D13、D164 | 時間規則 | T-B16：三種開始時間、跨日、超過十二小時皆依其他條件正常處理。 | U：G03a案例已驗；HTTP日期解析未驗。 |
| B17 | ENTRY 有效區間是 `[validFrom, validUntil)`；INSIDE 的 EXIT 不受區間限制。 | D13、D32、D72、D164 | 決策時間 | T-B17：等於開始允許、等於結束拒絕；逾期在場 EXIT 成功。 | U：G03a邊界已驗；保存與事件未驗。 |
| B18 | 未入場且未撤銷、未逾期才可修改；只改名稱、區間、Face。 | D15、D72、D76、D164 | 修改資格 | T-B18：允許欄位與禁止狀態；遵守較早已登記操作，QR 不變。 | U：G03a資格與QR保留effect已驗；DTO／FIFO／保存未驗。 |
| B19 | 合規入場前可永久撤銷，理由必填，保存原因與時間，不硬刪除或重新啟用。 | D16、D76、D164 | 撤銷資格 | T-B19：缺理由拒絕；完整保存；撤銷後不能修改或恢復。 | U：G03a資格、理由與Face釋放effect已驗；保存未驗。 |
| B20 | INSIDE／EXITED 完全凍結，不能修改或撤銷；未入場過期不可延長復活。 | D13–D16、D69、D72、D164 | 終態保護 | T-B20：各禁止情境；不得以整理先提交誤拒較早準時操作。 | U：G03a凍結規則已驗；FIFO／持久化保護未驗。 |
| B21 | QR／Face 是獨立替代方式，不加雙重核對；可 QR ENTRY、Face EXIT 或反向。 | D03–D04、D30 | 通行流程 | T-B21：跨媒介兩個方向；同媒介亦正常；不要求兩種憑證同時提交。 | U |

### 2.2 身分、來源與決策契約

| ID | 有效要求 | 來源 | 責任 | 預定驗收情境 | 證據 |
|---|---|---|---|---|---|
| B22 | 僅預置 Operator、Viewer 與 Recognition Source；人員帳號登入。 | D11 | 身分入口 | T-B22：預置登入可用；沒有公開帳號、角色或 Source 管理功能。 | U |
| B23 | Operator 可管理資格及讀取去敏查詢，但不可提交辨識。 | D11、D23–D24 | 權限 | T-B23：建立／修改／撤銷與查詢允許；辨識入口拒絕。 | U |
| B24 | Viewer 只讀同樣查詢，不可管理資格或提交辨識。 | D11、D24 | 權限 | T-B24：各寫入及辨識越權拒絕；查詢欄位與 Operator 相同。 | U |
| B25 | Source 只以個別機器憑證提交自身辨識，不做人員登入、管理或營運查詢。 | D11–D12 | 機器權限 | T-B25：逐個跨角色入口拒絕；錯誤憑證不洩漏業務進度。 | U |
| B26 | ENTRY／EXIT 各一個預置 Source，皆支援 QR／Face，方向由伺服器固定。 | D12 | Source 事實 | T-B26：兩媒介四組方向；payload 不能覆寫 direction／Source 身分。 | U |
| B27 | 已驗證但停用 Source 的新合法嘗試保存 `SOURCE_INACTIVE` 拒絕事件。 | D12、D21、D32 | Source 檢查 | T-B27：停用 fixture；與未通過 Source 認證的技術錯誤區分。 | U |
| B28 | 正式處理順序保留認證、業務格式、冪等、業務決策；登記／準入在非同步認證前。 | D18、D32、D76、D95、D99 | 入口／用例 | T-B28：慢認證前時間已固定；暫占登記不等於已認證或通行成功。 | U |
| B29 | ENTRY 首因順序：SOURCE_INACTIVE → B32 映射錯誤 → QUALIFICATION_REVOKED → ALREADY_INSIDE → QUALIFICATION_ALREADY_USED → QUALIFICATION_NOT_YET_VALID → QUALIFICATION_EXPIRED → ENTRY_GRANTED。 | D32、D164 | 純決策規則 | T-B29：各固定 code 與 API／Event 一致；多條件同時成立只回一個首因；INSIDE 逾期仍為 ALREADY_INSIDE。 | U：G03a首因與全部code已驗；API／Event一致性未驗。 |
| B30 | EXIT 首因順序：SOURCE_INACTIVE → B32 映射錯誤 → NOT_INSIDE → ALREADY_EXITED → EXIT_RECORDED。 | D32、D164 | 純決策規則 | T-B30：固定 code 與 API／Event 一致；不套 ENTRY 時間／撤銷檢查；撤銷但未入場的 QR EXIT 是 NOT_INSIDE。 | U：G03a首因、逾時EXIT及釋放effect已驗；API／Event未驗。 |
| B31 | 每個決策一個 reason；API／Event outcome 為 ACCEPTED／REJECTED。 | D32–D33、D164 | 回覆／事件 | T-B31：只有 ENTRY_GRANTED／EXIT_RECORDED 是 ACCEPTED；技術錯誤無通行 outcome。 | U：G03a輸出契約已驗；HTTP／Event保存未驗。 |
| B32 | 固定理由含 INVALID_QR_CREDENTIAL、FACE_UNKNOWN、FACE_SUBJECT_NOT_MAPPED。 | D32、D164、業務 §6 | 決策契約 | T-B32：各身分錯誤獨立驗證，不誤稱一般 EXPIRED 或授權通過。 | U：G03a三種映射錯誤已驗；真解析未驗。 |

### 2.3 事件、冪等與並行

| ID | 有效要求 | 來源 | 責任 | 預定驗收情境 | 證據 |
|---|---|---|---|---|---|
| B33 | 冪等鍵為 Source＋external event ID；同鍵同內容回放首次結果。 | D18、D165 | 冪等協調／保存 | T-B33：順序及並行重送只一個 Event、最多一次狀態轉移；首次拒絕及其重送皆零次轉移。 | U：G03b已驗內容HMAC固定表示；外部鍵、registry、保存與回放未驗。 |
| B34 | 同鍵不同內容為 IDEMPOTENCY_CONFLICT，沒有通行 outcome，不覆蓋、不產生第二個 Event。 | D18、D165、業務 §7.2 | 冪等比較 | T-B34：改變各影響內容的欄位觸發衝突；秘密比較資料不對外暴露。 | U：G03b共算artifact／timing-safe比對已驗；用例分流與Event未驗。 |
| B35 | 不同 Source 可使用相同 external event ID，互不誤合併。 | D18、D165 | 鍵唯一性 | T-B35：ENTRY／EXIT 同 ID 仍是兩個不同事件。 | U：G03b確認Source/eventID不進內容frame；複合唯一鍵未驗。 |
| B36 | 已保存的原鍵回放不重判時間、Source 狀態、Presence 或 Face 映射。 | D18、D31、D165 | 結果回放 | T-B36：停用、過期、釋放／重綁後仍回原結果，不新增 Event。 | U：G03b只驗比較artifact；canonical保存與不重判回放未驗。 |
| B37 | 同一資格的不同合法事件並行 ENTRY 最多一個成功，其他仍留拒絕 Event。 | D19、D76 | 完整操作 | T-B37：原 NOT_ENTERED、除 Presence 競爭外條件均通過且正常保存時，QR／Face、QR／QR、Face／Face 輸家 ALREADY_INSIDE；前提不成立依首因，不保證成功；不同資格各可成功。 | U |
| B38 | 同一資格的不同事件並行 EXIT 最多一個成功；Face 釋放影響後續 Face 的拒絕原因。 | D20、D32、D76 | 完整 EXIT | T-B38：QR 輸家 ALREADY_EXITED；無介入重綁時 Face 輸家為未映射；不同資格各可成功。 | U |
| B39 | 新合法可信辨識的允許／拒絕都保存 Event，不強制有 qualification ID。 | D21、D97–D99 | Event 保存 | T-B39：無效 QR、UNKNOWN、未映射、停用 Source 等保存；未準入不建 Event。 | U |
| B40 | 認證、格式、冪等衝突、限流／容量錯誤只寫適當去敏技術／安全紀錄。 | D21、D27、D97 | 錯誤分流 | T-B40：各錯誤沒有 Access Event、沒有假的通行 REJECTED。 | U |
| B41 | 必要 Presence、映射變更與 Event 共同原子保存後才回成功。 | D22、D44、D46、D65 | 用例／保存 | T-B41：逐項故障注入全成或全不成；無 Event 不得回 ENTRY_GRANTED。 | V：G04b 57-case 真Mongo integration覆蓋 accepted／rejected transaction、rollback、Presence／mapping／Event共同保存與 commit 後才回結果；G10 transport-loss仍U。 |
| B42 | 拒絕 Event 保存失敗是系統錯誤，不能聲稱拒絕已完整稽核。 | D22、D46 | 保存失敗回覆 | T-B42：拒絕寫入失敗；不回已保存業務結果。 | V：G04b 57-case fault／write-failure分類驗證拒絕 Event 保存失敗回 typed technical error，不回 audited business rejection；G10確認協議仍U。 |
| B43 | 時間為首次完整接收的伺服器時間，不接受 client 時間作決策、無離線補傳。 | D13、D31、D76 | 時間信任邊界 | T-B43：client 時間不能回溯；慢 body／慢認證／重送不混淆時間。 | U |

### 2.4 去敏查詢與展示

| ID | 有效要求 | 來源 | 責任 | 預定驗收情境 | 證據 |
|---|---|---|---|---|---|
| B44 | 資格 list／detail、INSIDE list、Event list／detail 為三類最小查詢。 | D23 | 唯讀用例 | T-B44：兩人員角色可讀；INSIDE 清單排除 NOT_ENTERED、撤銷、EXITED，仍包含逾期 INSIDE。 | U |
| B45 | 資格清單不篩選／搜尋／自訂排序；createdAt 降序加 ID 穩定排序。 | D29 | 資格查詢 | T-B45：相同時間跨頁無排序漂移；不新增額外篩選能力。 | U |
| B46 | Event只支援qualificationId、outcome、reasonCode三篩選AND；receivedAt及ID降序。 | D28、D152 | 事件查詢 | T-B46：八filter組合、enum／UUID／重複未知query拒絕及同時刻分頁；不加全文搜尋。 | U |
| B47 | 三類list keyset，limit預設20／1–100；INSIDE enteredAt及ID降序；cursor綁route／filters／epoch。 | D23、D27–D29、D152 | 查詢契約 | T-B47：canonical cursor≤512ASCII、格式／route／ANDfilters錯誤、舊epoch409；無跨頁snapshot承諾。 | U |
| B48 | 資格摘要含 ID、顯示名稱、有效區間、撤銷／逾期／Presence、有效 faceBound、建立／修改／撤銷時間及撤銷原因，不顯示完整 subject 或 QR。 | D24、D69、D72、D76 | 資格讀取投影 | T-B48：兩角色／list／detail 欄位齊全；INSIDE 逾期仍綁定；準時前序 ENTRY 未決不能只憑時鐘視為可釋放；普通已可終結的殘留引用不冒充有效綁定。 | U |
| B49 | Event投影含eventId、sourceId、direction、kind、outcome、reasonCode、receivedAt、recordedAt、可空qualificationId、presenceTransition。 | D21、D24、D145、D150 | 事件投影 | T-B49：list／detail／辨識同投影；DBreason映為reasonCode；recordedAt非commit時間；無秘密／比較資料。 | U |
| B50 | 成功／錯誤回覆、查詢、Event、安全／技術日誌都不洩漏 token、機器憑證或完整 subject。 | D05、D21、D24、D165 | 全介面秘密處理 | T-B50：逐個表面掃描已知秘密；建立成功的一次 QR 是唯一業務例外。 | U：G03b artifact enumerable表面只有digest/reference；HTTP、Event、query與log未驗。 |
| B51 | 固定 Demo：建立 → QR ENTRY → INSIDE → Face EXIT → 兩筆 Event 與 EXITED；裝置傳輸以獨立 ENTRY／EXIT client 模組展示。 | D30、D35、D162 | 可重跑展示 | T-B51：兩個 client 各自固定 Source 身分／方向且有結果斷言；可共用純傳輸工具但不複製後端裁決；反向跨媒介、拒絕、重送、競爭另有範例／測試。 | U |
| B52 | 辨識不能直接以內部 Qualification ID 作通行／映射捷徑，只接受 QR token 或模擬 Face 結果。 | 業務 §5.2、D34 | 輸入能力限制 | T-B52：知道 qualificationId 也不能跳過憑證／映射提交成功通行。 | U |

### 2.5 架構責任與 MongoDB 一致性

| ID | 有效要求 | 來源 | 責任 | 預定驗收情境 | 證據 |
|---|---|---|---|---|---|
| A01 | 乾淨重寫並保留Git、docs及根目錄文件；D161依使用者新決定不另備份，舊backend/frontend直接移出工作目錄。 | D36、D140、D157、D161 | 重寫準備 | T-A01：backend/frontend不存在；docs四文件、.git、.gitignore、readme.md保留；沒有PassHub legacy備份。 | V：D161盤點、精確垃圾桶移動及移後檢查 |
| A02 | strict TypeScript、NestJS 預設 Express adapter、模組化單體。 | D37、D59、D125、D163 | 技術基線 | T-A02：strict 建置及依賴核對；不宣稱 Node 原生無框架。 | U：G02已驗工具鏈與載入smoke；實際模組接線及G12覆核未完成。 |
| A03 | 核心 AccessModule 內分管理、辨識、查詢用例，不集中成萬用服務。 | D40–D41、D54–D59 | 核心模組 | T-A03：用例責任／資訊隱藏審查；不能只把所有檔案搬進 Access。 | G03c局部：ManageQualifications、RecognizeAttempt、ReadAccessData為三個窄能力且composition只回傳三者；完整AccessModule／HTTP／DB接線未驗 | U |
| A04 | 管理能力不能取得 ENTRY／EXIT 轉移能力；查詢不能寫；沒有任意 Presence setter。 | D55、D57–D59 | 能力限制 | T-A04：檢查可呼叫介面與依賴；管理用例協調自己的完整保存，不繞經辨識用例或取得通行 setter。 | G03c局部：management／recognition wrapper分離，query為redacted read-only projection，public surface無stage/setter；完整持久化權限未驗 | U |
| A05 | EXIT 是包含必要映射釋放的完整行為，不要求呼叫者拼湊兩個 setter。 | D41、D55–D59、D67 | 完整業務行為 | T-A05：所有 EXIT 入口同一規則；故障下無已離場仍有效映射。 | G03c局部：EXIT recognition plan保留`faceMappingEffect: RELEASE`且由opaque handle帶出；Mongo atomic release／reuse未驗 | U |
| A06 | AuthModule／SourcesModule 分開；Sources 不反向依賴 Auth。 | D42–D43、D60–D61 | 認證／來源邊界 | T-A06：依賴無循環；人員／機器認證職責明確。 | G03c局部：SourceCredentialVerificationPort移至sources/ports，Access只收SourceFacts；Auth／Sources runtime integration未驗 | U |
| A07 | Auth 只接來源驗證窄能力；Access 只接無憑證的 Source 事實能力。 | D60–D63 | ports／接線 | T-A07：不可用同一萬用 Service 加 type cast 假裝隔離。 | G03c局部：SourceFactsPort、ManagementDataPort、RecognitionDataPort分離且無萬用port；真實credential-auth接線未驗 | U |
| A08 | HTTP 轉交用例，領域純判斷；領域不依賴 Nest、Express、DB 或 session；Access 核心不直接依 Auth、HTTP 或具體 Mongo，infra 實作 ports 由組合入口接線。 | D41、D57、D62–D63 | 依賴方向 | T-A08：領域獨立測試；核心 imports 與實際 wiring 覆核，不用具體 infrastructure 繞過 port。 | G03c局部：boundary selected=18、edges=40、forbidden=0，production無raw comparison barrel import；HTTP／Nest／Mongo實際接線未驗 | U |
| A09 | 用例協調完整讀取、判斷、保存；管理與辨識共用唯一純資格政策，基礎設施不另創通行規則。 | D56–D59、D62–D63 | 用例／保存分工 | T-A09：跨用例不複製資格政策；repository 不藏另一套 reason 優先序。 | G03c局部：management／recognition均由domain decision及internal branded plan provenance產生，caller不能偽造；完整repository共同保存未驗 | U |
| A10 | 資料能力限當次完整操作；衝突重跑須新 scope、重新讀取及判斷。 | D56、D62–D65 | 操作上下文 | T-A10：結束後舊能力不可繼續用；衝突不能直接保存舊決策。 | G03c局部：每operation獨立owner／generation／epoch，closed或stale handle fail-closed並重核qualification／mapping freshness；真衝突重跑未驗 | U |
| A11 | MongoDB 官方 driver，多文件 transaction 作共同保存基礎，環境須真支援交易；參與同一交易的操作共用 client／session，交易內不以 Promise.all 並行操作。 | D64–D65 | MongoDB 保存 | T-A11：真 Mongo 整合測試、session 傳遞及操作順序核對；不支援交易時不能假裝一致性已驗證。 | V：G04b 57-case 真Mongo／rs0、手動 session、snapshot／primary／majority+j=true、順序 await、無 Promise.all／withTransaction；完整 production deployment仍U。 |
| A12 | 成功及依賴可變資料的拒絕都保護決策依據的新鮮度。 | D64–D65 | 並行保護 | T-A12：Source／映射／資格在判斷間變動；只有 snapshot／no-op 不算證明。 | V：G04b 57-case 驗 source version／direction／active、qualification／mapping／QR／Face guards 及 accepted／rejected freshness；上層 FIFO仍U。 |
| A13 | DB 唯一約束保護 Source＋external event ID。 | D65 | 事件索引 | T-A13：真實並行同鍵只一個 canonical Event，且正確分流重送／衝突。 | V：G04b 57-case 真Mongo unique index、同鍵並行 race、same-artifact replay、different-artifact conflict；loser immediate convergence不屬本 gate。 |
| A14 | 目前 Face Mapping 為獨立單一權威，不在多處保存可衝突的有效綁定。 | D66–D67 | 映射模型 | T-A14：所有有效映射走同一來源；資格摘要不能形成第二套真實綁定。 | V：G04b schema／adapter及G04a9驗 faceSlots sole mapping authority、reverse reference／incarnation、orphan／slotCount startup integrity；完整管理HTTP仍U。 |
| A15 | 同 Face 鍵的綁定／釋放／辨識須有真實共用寫入競爭；釋放清綁定引用但保留空協調位，首次缺鍵的綁定與未映射決策也受保護。 | D66–D67 | 空鍵競爭 | T-A15：首次綁定與 MATCHED 但未映射的辨識競爭；僅負查／no-op 不算保護；釋放後協調位仍可用。 | V：G04b 57-case 真Mongo驗首次 bind／unmapped recognition race、release保留空slot、mapping／qualification共同保存與分類；G05協調仍U。 |
| A16 | 區分各種 duplicate key／已中止交易；不能全部當可重跑或吞錯續用。 | D66–D67 | 保存錯誤分類 | T-A16：映射、事件、其他唯一鍵衝突；只有確認可安全重跑才重跑。 | V：G04b 57-case 分辨 duplicate、112 write conflict、251 abort、schema validation、unknown commit；不以 retry loop 偽造確定性。 |
| A17 | 逾期映射採相關操作惰性整理；唯讀不整理，無 TTL／背景終結業務。 | D68–D69、D72、D76、D164 | 映射整理 | T-A17：有效 faceBound、過期釋放、在場保留、準時排隊保護分開測。 | U：G03a生命週期effect已驗；相關操作、FIFO及DB整理未驗。 |
| A18 | v1 只一個 API 實例；相關完整業務寫入單執行，登入／唯讀不全排入 FIFO。 | D73–D74、D76 | 執行協調 | T-A18：部署及程式無第二 writer；不以唯讀可用宣稱故障下必定可查。 | U |

### 2.6 接收、等待、故障與續辦

| ID | 有效要求 | 來源 | 責任 | 預定驗收情境 | 證據 |
|---|---|---|---|---|---|
| L01 | body 完整抵達應用可觀察入口，同步大小／基本 JSON／準入檢查後，同步固定 receivedAt 及序號。 | D75–D76、D99 | 接收／準入 | T-L01：登記前不插 async Auth／DB；不是首 byte、按鈕、認證完成或 commit 時間。 | U |
| L02 | 建立、修改、撤銷、QR／Face、相關整理／重綁依登記順序取得完整操作權。 | D76 | FIFO | T-L02：慢 Auth 不被後到撤銷超車；同毫秒序號；失敗入口安全收尾。 | U |
| L03 | 較早 ENTRY 若成功，後到修改／撤銷失敗；較早 ENTRY 失敗不保證後者失敗。 | D17、D72、D76 | 管理與辨識競爭 | T-L03：ENTRY／修改／撤銷兩種先後逐一驗證，非以 DB 先提交者判定。 | U |
| L04 | 正常運作下，合法準時完整接收 ENTRY 不因排隊或後到逾期整理而被誤判逾期。 | D71–D72、D76 | 準時保障 | T-L04：QR／Face 期限內收齊、期限後執行；其餘不合法條件仍可拒絕。 | U |
| L05 | HTTP 逾時／斷線不取消仍存在的原操作，不刷新首次時間、FIFO 或預算。 | D77–D78、D95 | 請求與操作生命期 | T-L05：排隊及執行中斷線；原項仍受保護，不自動判 rollback。 | U |
| L06 | 可信同鍵同內容重送只關聯原進度／結果，不二次執行，不靠使用者重送才續辦。 | D78、D83、D95 | 重送／續辦 | T-L06：原 HTTP 已結束仍續辦；重送即查已知進度，不刻意再等五秒。 | U |
| L07 | DB 結果不明先有限確認；不能判安全時暫停相關寫入，不假回失敗／逾期。 | D79–D80、D85 | 未知結果處置 | T-L07：commit 回覆遺失；後項不能放行；唯讀可用性按 DB 實際能力。 | U |
| L08 | Event 暫不存在、逾時、Promise race、斷線或程序停止都不是充分未生效證據。 | D80、D83、D87、D91 | 安全判據 | T-L08：遲到寫入／未完成指令；未知保護不能被 timer 解開。 | U |
| L09 | 未重置且有充分未生效及不會晚寫證據、仍有執行額度、當下允許時，系統自動續辦原項。 | D81–D83、D89、D91 | 恢復協調 | T-L09：保留原接收時間／順序；不靠第二筆新業務替代原項。 | U |
| L10 | 已完整保存的結果是權威，晚到仍保留及回放；不是重新執行原項的許可。 | D83、D87、D89、D91 | canonical 結果 | T-L10：HTTP／確認／執行額度已過仍收到完整結果，回放且不重做。 | U |
| L11 | 原項舊 callback 只處理自身權利，不能放開下一項鎖或抹掉維護／人工管控。 | D82–D83、D89 | 控制權 | T-L11：延遲成功／失敗與新 owner、維護、人工接管並行。 | U |
| L12 | 自動確認先行；告警非接管；host-only socket／CLI實際hold、release、drain有獨立否決。 | D84–D85、D88–D89、D153 | 自動／人工界線 | T-L12：充分晚證據依D89續辦；hold先設屏障才ACK，release不越未知／維護，current/last控制重送有界。 | U |
| L13 | 無跨崩潰／重置延續保證，不新增持久 pending、分散式恢復平臺。 | D74、D78、D83 | 能力限制／文件 | T-L13：文件明示原程序消失／Demo 清除後不承諾續辦。 | U |

### 2.7 執行、確認與 HTTP 預算

| ID | 有效要求 | 來源 | 責任 | 預定驗收情境 | 證據 |
|---|---|---|---|---|---|
| L14 | 確認共用，首次DB未知／首次確需precommit清理取較早者；單送一格、原生終止組預扣兩格不退。 | D86–D87、D129–D131 | 確認預算 | T-L14：起點早於終止組準入，送失敗／到達未知不退款，跨輪／重送／恢復／人工不補滿。 | U |
| L15 | 新單送／新終止組準入前核窗口及格數；已準入原生兩送組有越窗／無組內間隔例外。 | D87、D93、D129、D137 | 確認節流 | T-L15：組預扣兩格、獨占、最多兩送、越窗只完成舊組不開新組；晚結果保留，無證仍停寫。 | U |
| L16 | 確認耗盡後，充分晚證據仍可在其餘條件成立時續辦；再次未知不重開確認額度。 | D88–D89 | 超限恢復 | T-L16：晚證據自動續辦；二次未知無額外確認；舊證據不能證明新寫入。 | U |
| L17 | 執行時間從首次取得完整處理權算，初次排隊不算；之後暫停、結果確認與恢復等候持續計時。 | D90–D91、D93 | 執行預算 | T-L17：初排隊與後續等候分開；確認時間同時消耗執行時間，不能串接成 15＋10 秒或恢復成新十五秒。 | U |
| L18 | 執行輪次含首次、正常衝突重跑及恢復；最後準入一輪可用剩餘時間完成。 | D91 | 輪次預算 | T-L18：用完輪次不開新輪，已準入一輪不因計數到上限立刻中斷。 | U |
| L19 | 執行時間耗盡不開始新業務步驟／重跑；必要安全確認仍受原確認額度控制。 | D91、D93 | 超時收尾 | T-L19：不把「十五秒到」誤當 rollback；不以安全收尾重開業務額度。 | U |
| L20 | 額度耗盡且充分確認未生效、不會晚寫、已完成安全收尾時，才形成技術未完成終局。 | D91 | 技術終局 | T-L20：收尾完成前不得終局；不標業務 REJECTED／EXPIRED、不撤銷資格；未知仍非安全終局。 | U |
| L21 | 同 ID 延續原終局／結果不刷新；新 ID 只在原項安全終結且服務允許時另算新時間。 | D91 | 再嘗試契約 | T-L21：新 ID 可能逾期，無原準時權；不能繞未知、維護、人工控制。 | U |
| L22 | 可調待測：HTTP五秒、執行十五秒／三輪、確認十秒／七格；七格取代三次。 | D92–D93、D129–D131 | 設定／文件 | T-L22：快路徑兩清理組＋第三輪未知、慢路徑到限；不保證用滿三輪或15＋10秒完成。 | U |
| L23 | unknown commit立即原commit→一秒canonical→兩秒原commit，此後兩秒交替；串行共用格，precommit組依L15例外。 | D93、D129、D136–D137 | 確認節奏 | T-L23：首次commit用exec剩餘，不借confirm；confirm commit至少剩兩秒、timeout2000；CRUD/canonical整毫秒不足1禁發，禁止0；真單送與組完整生命週期。 | U |
| L24 | 每個 HTTP 從本次登記算五秒應用等候，含認證／排隊，不含上傳；不保證網路準時送達。 | D94–D95 | 回覆計時 | T-L24：慢 body、Auth、排隊；重送只重算 HTTP 等候，不重算原項預算。 | U |
| L25 | HTTP 完成／期限競爭只回一次；晚結果不再回舊連線。 | D95 | 回覆 ownership | T-L25：deadline 同時完成、斷線、晚 callback；一次回覆無二次寫 response。 | U |
| L26 | 尚未通過驗證只表達技術等候／錯誤，不洩漏或宣稱可信業務進度。 | D95、D97 | 回覆權限／UX | T-L26：五秒時認證未完；晚認證失敗無業務 Event，成功仍依原項條件續辦。 | U |
| L27 | 驗收可觀察五秒後原項未完成、可信重送查進度、十五秒內完成後回放同一結果。 | D93、D95 | 預算整合驗收 | T-L27：受控延遲展示生命期不同，時間／順序／執行次數未刷新。 | U |

### 2.8 容量及工作生命期

| ID | 有效要求 | 來源 | 責任 | 預定驗收情境 | 證據 |
|---|---|---|---|---|---|
| L28 | 原操作32；validation8＝普通寫4/login1/query1＋retry2；HTTP32＝普通28＋retry4；專用不互借。 | D96–D99、D146、D148 | 容量設定 | T-L28：各自計數及分池滿、晚Auth持額；32非並行或吞吐；registry4096另計。 | U |
| L29 | 新辨識候選同步整組origin／validation／HTTP／registry預留才登記；可信join返自身預留。 | D99、D146、D149 | 同步準入 | T-L29：四資源各先滿與競爭、可信join／conflict／invalid返額；不先登記再丟棄、不漏還／重複還。 | U |
| L30 | 原操作槽涵蓋待驗證、FIFO、執行、未知；不因 HTTP 逾時／斷線／未知釋放。 | D97、D99 | 原項生命期 | T-L30：原項安全收尾或驗證失敗確定不進業務後才歸還。 | U |
| L31 | 驗證槽到驗證真正完成且安全轉交／收尾才還；HTTP 結束只還自身等候槽。 | D97、D99 | 驗證／HTTP 生命期 | T-L31：驗證超五秒仍占槽；轉交與斷線並行不超收、不重複釋放。 | U |
| L32 | 原項滿仍保留有限驗證／HTTP 通道識別重送；同鍵同內容不增第二原項。 | D97、D99 | 滿載重送 | T-L32：原項 32 時可信重送可關聯；不同內容 conflict；通道非無限豁免。 | U |
| L33 | 未驗證入口滿只能說本次無法驗證、不能確認原項狀態；不可說原項不存在或失敗。 | D97 | 滿載回覆 | T-L33：偽造 ID／合法重送同樣不洩漏原項；不誤取消既有簽到。 | U |
| L34 | 可信新項遇原項滿，明說未接收、不留本次準時權、不建 Event；後續新嘗試用新時間。 | D97、D99 | 新項拒收 | T-L34：不假稱排隊或業務拒絕；既有準時項不被淘汰騰槽。 | U |
| L35 | 原三上限不涵蓋全部資源；D148–D149另定connection/raw／scrypt／query／canonical及registry有界初值。 | D99、D148–D149 | 資源／記憶邊界 | T-L35：工作真收束前持額；registry4096含終局無日間evict、普通重啟不得重開寫；不作全面抗流量保證。 | U |
| L36 | 可信進度須區分故障暫停、等待處理、正在處理及完整結果；確認耗盡但未接管時，明示停止新確認、等待在途證據或人工介入，仍可能條件式自動續辦。 | D83、D89、D95 | 進度／交接語意 | T-L36：各階段不誤稱失敗／持續新確認／已接管；充分晚證據可自動續辦；實際接管另受控。 | U |

### 2.9 公開 sandbox 與獨立維護

| ID | 有效要求 | 來源 | 責任 | 預定驗收情境 | 證據 |
|---|---|---|---|---|---|
| M01 | 公開 API runtime 供體驗，GitHub 提供碼／文件；共用資料及帳號，不做個人隔離。 | D25、D30 | 展示部署／文件 | T-M01：外部可呼叫 API；明示共享互相影響，不宣稱 GitHub Pages 執行後端。 | U |
| M02 | 警告只填假資料、Demo 可清除、不保證正式營運／隱私／可用性；不自動辨識真實個資。 | D25–D27、D34 | Demo 警語 | T-M02：入口文件與操作說明可見，沒有正式 SLA／個資治理承諾。 | U |
| M03 | 預置公開體驗憑證不能混用部署、DB 或維護者秘密。 | D25 | 環境隔離 | T-M03：公開 seed credentials 是刻意值；其他秘密無 tracked／輸出洩漏。 | U |
| M04 | D148固定分鐘rate／IP表256、body16KiB及D152頁量；D155只信固定proxyIP/32；超限無Event。 | D27、D148、D152、D155 | 防濫用 | T-M04：各rate、IP表滿、slowbody／深度／重複headers、proxy偽造、專用重送也計rate但不取消原項；不加風控後臺。 | U |
| M05 | 維護命令獨立於 API、可重用必要模型設定；任何公開角色無 reset API。 | D47、D52 | 維護入口 | T-M05：停止 API 後外部命令仍可維護 DB；Operator／Viewer／Source 無重置權。 | U |
| M06 | 每日 Asia/Taipei 凌晨 03:00 由 API 外排程自動執行，不依賴人工或 API 自己計時。 | D26、D52 | 外部排程 | T-M06：排程時區／觸發驗證；API 不健康仍能啟動維護。 | U |
| M07 | 先拒新業務、有限等待既有操作，再停止 API；API 已停且確保舊 DB 工作不能干擾重置後資料才清除。 | D48–D52、D83 | 停機／隔離 | T-M07：清除前確認 API 已停；未知／未完成 DB 指令不能因停程序就假定消失；隔離須有證據。 | U |
| M08 | drain待測最多30秒，超時仍進安全重置、不取消；隔離未證明不能清庫。 | D50、D52、D155 | 重置超時 | T-M08：drain超限仍先確停API/Mongo、恢復PRIMARY再清；停止或隔離未知維持入口封閉。 | U |
| M09 | 只passhub_demo六collection sequential deleteMany保indexes後seed；公開Operator/Viewer/ENTRY/EXIT憑證不變，新epoch/nullclaim。 | D26、D47、D52、D155 | reset／seed | T-M09：qualifications/faceSlots/events/users/sources/metadata精確清理；不dropDB/volume/其他DB；seed非全庫原子、部署keys外管不換，受控重跑。 | U |
| M10 | 清除／seed 失敗不恢復 API，維護者修復重跑；成功後才重啟接受業務。 | D48、D52 | 維護失敗界線 | T-M10：各階段故障保持不可用；安全重跑恢復，無半初始化服務。 | U |

### 2.10 作品品質與可展示證據

| ID | 有效要求 | 來源 | 責任 | 預定驗收情境 | 證據 |
|---|---|---|---|---|---|
| E01 | 可操作且已核對的 REST／OpenAPI 契約，區分業務結果、認證、格式、衝突及儲存錯誤。 | D30、D34–D35、業務 §12 | API 契約 | T-E01：真 HTTP 與文件一致，不只生成 Swagger UI。 | U |
| E02 | 真 MongoDB 整合測試證明原子性、映射及冪等唯一性，不只 mock repository。 | D35、D65、業務 §12 | DB 整合驗證 | T-E02：實際交易故障／競爭、全部資料一致，保留環境及命令。 | U |
| E03 | 真實並行 HTTP 測試，驗證跨媒介及管理競爭、Event／Presence／Mapping 完整。 | D19–D20、D35、D76、業務 §12 | HTTP 整合驗證 | T-E03：不同事件均保存且最多一個轉移；同事件只一個 Event。 | U |
| E04 | D152固定10kqual/40kEvent與八filter各別索引前後實驗；正確性及完整證據為門檻、不要求改善百分比。 | 業務 §12、D152 | 查詢／測量 | T-E04：first/固定next每case10warmup100measure、raw/p50/p95/explain/fixture/環境；只改nonunique queryindexes，回歸如實報告。 | U |
| E05 | 結構化日誌與 request ID 可追蹤請求、原項及故障，不洩漏秘密。 | D21、業務 §12 | 可觀測性 | T-E05：跨層關聯可查；斷線、重送、未知、維護紀錄有安全上下文。 | U |
| E06 | 自動化測試涵蓋規則、權限、秘密、冪等、並行、故障、預算及維護。 | D35、D65–D99、業務 §12 | 測試套件 | T-E06：逐列對應，不把單元測試數量等同需求覆蓋。 | G03c局部：Jest 6 suites／37 tests、boundary selected=18 edges=40 forbidden=0、negative compile及public package resolution通過；完整136項、fault／budget／maintenance／HTTP／Mongo未驗 | U |
| E07 | 乾淨 Docker 環境啟動 API／真 Mongo，seed 與一鍵 Demo 可重跑且有斷言。 | D30、D35、業務 §12 | 交付／展示 | T-E07：無本機殘留安裝；交易環境、初始化及主流程成功。 | U |
| E08 | CI 靜態檢查、測試與建置有實際成功證據，保存 commit／環境／命令。 | 業務 §12 | CI | T-E08：乾淨 runner 通過；失敗阻止宣稱完成。 | U |
| E09 | README／設計文件交代信任邊界、狀態、資料流、原子性、模擬、共享及每日重置限制。 | D01、D25–D26、D30、D34、業務 §12 | 操作／設計文件 | T-E09：陌生讀者能重跑及解釋限制；不提公司現行系統或複製其資料／畫面。 | U |

## 3. 明確排除與負面驗收

排除也是要求。每項未完成負面核對前同為 U，不能因文件寫「不做」就算程式已符合。

| ID | 不納入 v1 的能力 | 來源 | 負面驗收 | 證據 |
|---|---|---|---|---|
| X01 | 多企業、多據點、組織、Access Group。 | D01、D08、D34 | T-X01：沒有相關實體／種子／管理／決策欄位；無 ACCESS_GROUP_NOT_ALLOWED。 | G03c局部：public package surface未暴露scope／raw plan／repository能力；完整排除項與seed／管理負面驗收未驗 | U |
| X02 | 永久 Person／Visitor、訪客歷史聚合、資格多次進出。 | D02–D03、D34 | T-X02：沒有主檔／聚合；EXITED 不能再使用。 | G03c局部：只公開三個窄Access能力，無Person／Visitor public contract；生命週期與EXITED負面驗收未驗 | U |
| X03 | 匿名申請、員工審批、訪客帳號／狀態頁、Admin、帳號／Source 管理與忘記密碼。 | D11、D34 | T-X03：只有預置入口及資格管理，無上述 API。 | G03c局部：root exports僅composition與三能力型別，無帳號／Admin API；HTTP surface與完整負面掃描未驗 | U |
| X04 | QR 找回／補發、硬刪除、重新啟用、救援碼、人工 Presence 修正、入場後撤銷。 | D05、D14–D16、D34 | T-X04：不存在繞過終態及救援流程。 | G03c局部：negative compile阻擋stage／setter／plan factory，public subpath對raw scope／handle／plan封鎖；業務流程負面驗收未驗 | U |
| X05 | 真實人臉 API、enrollment、陌生人認領、圖像／特徵／confidence／活體、QR＋Face 雙重核對。 | D04、D06、D09、D34 | T-X05：只接模擬辨識結果，不宣稱真實生物辨識。 | G03c局部：窄ComparisonPort僅支援已定義QR／Face結果，未引入真實Face API或影像表面；完整負面驗收未驗 | U |
| X06 | RTSP、攝影機、實體掃碼、門鎖、relay／Wiegand／I/O、Card／NFC、離線同步。 | D01、D12、D34 | T-X06：沒有硬體及影像基礎設施依賴。 | G03c局部：boundary forbidden=0且production import無硬體／HTTP表面；完整硬體／影像負面驗收未驗 | U |
| X07 | Webhook、外部 action、Delivery／outbox、動作規則引擎、下游投遞 worker／重試。 | D10、D34 | T-X07：只回傳決策；不誤禁止已採用的內部故障確認／續辦。 | G03c局部：RecognizeAttempt只產生窄recognition result，public surface無delivery／worker能力；完整負面驗收未驗 | U |
| X08 | 產品型前端、通知、PDF／檔案服務、Dashboard、考勤、報表／CSV、全文／進階搜尋、自訂排序、SSE／WebSocket。 | D23、D28–D30、D34、業務 §10.3 | T-X08：OpenAPI／腳本不是產品前端；查詢不擴張。 | G03c局部：ReadAccessData只提供qualifications／inside／events redacted projections，無前端／檔案／stream surface；完整查詢負面驗收未驗 | U |
| X09 | 正式個資生命週期、個人 sandbox、業務復原／備份承諾、正式 SLA、CAPTCHA／個人 API key／風控後臺。 | D25–D27、D34 | T-X09：明示一次性共享 Demo；部署秘密隔離及基本限流仍要做。 | G03c局部：query projection排除token／subject／HMAC／comparison reference，無個人sandbox／API key能力；部署與限流負面驗收未驗 | U |
| X10 | 多 API 實例、分散式佇列、跨崩潰／重置原項延續、必要的持久 pending 平臺。 | D74、D78、D83 | T-X10：單實例邊界明確；不把安全未知處置延伸為完整恢復系統。 | G03c局部：每operation獨立owner／generation且composition不提供跨process scope；崩潰／reset／pending負面驗收未驗 | U |
| X11 | 微服務、CQRS、EventEmitter 協調業務、通用 plugin SDK／DSL。 | D37、D41、D59 | T-X11：採模組化單體；無為拆而拆的通用平臺。 | G03c局部：composition維持窄三能力入口，boundary forbidden=0且無通用plugin／event coordinator import；完整架構負面驗收未驗 | U |

## 4. 舊提案、被取代要求與討論來源的去向

| 舊說法／候選 | 現行去向 | 依據 |
|---|---|---|
| 完全是參考系統的嚴格子集／原樣復刻。 | 整體較小；單次資格與 Presence 是承認的抽象／延伸，不保證流程逐字一致。 | D01–D03 |
| 永久 Visitor、QR 防轉交或 QR／Face 是同一真人證明。 | 不採；資格一次性、bearer 與替代媒介限制保留。 | D02–D04 |
| Access Group、UNKNOWN 人員主檔、Webhook／下游 action。 | 移除。 | D08–D10 |
| 開始必須在未來；只做本機 Demo。 | 可過去／現在／未來開始，結束仍須未來；公開 API 加本機重跑。 | D13、D25 |
| outcome 為 ALLOW／DENY。 | 改 ACCEPTED／REJECTED；技術錯誤不造通行 outcome。 | D33 |
| D37 的六個頂層模組全部定案。 | 只是候選；核心選 Access，Auth／Sources 分開，維護命令獨立；Health 等未採用。 | D37、D47、D59、D61 |
| 拆 Qualification／Recognition 客觀上更好，或只合併檔案就更模組化。 | 無客觀優勝結論；採 Access 必須保留內部能力隔離與完整操作。 | D38–D41、D54–D59 |
| 先清 DB 再重啟 server；等待超時取消當天 reset。 | 前者 D51 僅提案；採外部停新項／有限 drain／停機隔離／清除 seed／成功才重啟，超時仍安全重置。 | D47–D52 |
| 每個模組各提交，或 transaction 就自動解決所有競爭。 | 完整操作共同保存；新鮮度、唯一約束及 FIFO 分別驗證。 | D44、D46、D56–D57、D62–D67、D76 |
| 早期技術version欄位、兩階段持久pending是否選定。 | 早期D64–65 version僅例子；後續D142–145已採UUID incarnation與非負安全整數version真guard。持久pending仍不採，單API完整操作協調不变。 | D64–D65、D70、D73–D74、D142–D145 |
| D69：逾期終結先提交，就能拒絕較早準時 ENTRY。 | 此競爭承諾撤回；惰性整理保留，但不得破壞正常延遲的準時接收保障。 | D68–D72、D76 |
| D17：ENTRY／撤銷／修改只看誰先完成 DB。 | 改依同步登記順序取得相關完整處理權；不允許後到超車。 | D75–D76 |
| D77：排隊逾時取消原簽到，重送重新算時間。 | 不採；HTTP 生命期不等於原項生命期。 | D78 |
| 已知未生效一概技術失敗；先人工處理；確認超限後續辦必須人工點頭。 | 符合安全及剩餘額度可自動續辦；實際人工管控不可越過；安全耗盡才技術終局。 | D80、D83–D85、D87–D91 |
| 任一輪次到上限就立即中斷；五秒代表網路準時送達；32 人保證成功。 | 最後準入輪可在剩餘時間完成；五秒是應用等候；32／8／32 是不同資源待測上限。 | D90–D95、D97–D99 |
| D45 的公司裝置觀察、D53／D82 的角色分工。 | 前者是帶不確定性的背景證據，後者是討論程序；不新增產品功能，也不當作工程證明。 | D45、D53、D82 |

### D01–D99 反向核對索引

此索引只證明每段討論有處理去向，**不等於逐句語意覆蓋已完美或程式已完成**。範圍內的每個 D 編號都要能從原文覆核。

| 討論範圍 | 本稿去向 |
|---|---|
| D01–D10 | B01–B14、X01–X07；產品抽象、媒介與移除能力。 |
| D11–D20 | B15–B38；角色、來源、時間、終態、修改／撤銷、冪等及競爭。 |
| D21–D30 | B39–B51、M01–M04、E01–E09；事件、保存、查詢、sandbox 與展示。 |
| D31–D35 | B14、B29–B36、X01–X09、E01–E09；延遲、首因、outcome、排除及總體驗收。 |
| D36–D41 | A01–A05、A08；乾淨重寫、候選模組、完整性、品質理由；D39 撤除兩天時限，不形成效能／交期要求。 |
| D42–D46 | A06–A09、B41–B42；Auth／Sources、保存政策；D45 只作背景。 |
| D47–D52 | M05–M10；候選與已採用維護順序分開。 |
| D53–D59 | A03–A05、A09–A10；核心選擇與撤回客觀優勝；D53 是討論程序。 |
| D60–D67 | A06–A16；窄能力、操作上下文、交易、拒絕新鮮度及目前映射。 |
| D68–D72 | A17、B12、B17–B20、L03–L04；保留惰性整理，撤回破壞準時保障的先提交終結。 |
| D73–D78 | A18、L01–L06、L13；單實例、FIFO、接收點與 HTTP 不取消原項。 |
| D79–D85 | L07–L13；未知停寫、控制權、自動確認、續辦；D82 新角色是程序。 |
| D86–D91 | L14–L21；確認／執行額度、晚證據、人工管控及技術終局。 |
| D92–D95 | L22–L27；待測數值、確認節奏、HTTP 起點及一次回覆。 |
| D96–D99 | L28–L35；容量、生命期、入口／新項回覆及登記前完整準入。 |

## 5. 業務文件落差的同步紀錄

本節保留D99時點經使用者確認繼續後的同步歷史。第一欄是當時同步前舊說法；第二欄當時已納入business-scope。表內schema/工具/P未定只適用那個時點，**當前由第6節及第10節、D157採用去向取代**。工程證據仍全U，保留歷史而非再宣稱目前未定。

| 業務文件位置／說法 | 後續有效修正 | 追蹤 |
|---|---|---|
| §4.1／§4.5／§11.1：未入場逾期永久終結及映射釋放。 | 加 D72／D76 前序準時項保護，不能僅依處理當下過期而終結。 | B12、B20、L04 |
| §4.4：舊 QR 後續使用得到 QUALIFICATION_REVOKED。 | 限定新 QR ENTRY；未入場 QR EXIT 依首因為 NOT_INSIDE，原鍵回放不重判。 | B30、B36 |
| §4.4：修改／撤銷與 ENTRY 誰先完成誰生效。 | 改同步登記 FIFO；慢認證與同毫秒序號都要涵蓋。 | L01–L03 |
| §5.3：處理順序從 Source 認證開始。 | 補準入及同步登記在 async Auth 前；不把登記稱可信／合法業務受理。 | B28、L01、L26、L29 |
| §4.5：延遲 Face 新事件按接收當下映射。 | 不讀歷史映射，但也不在接收瞬間搶讀 DB，須尊重前序完整操作。 | B14、L02 |
| §7.1：所有合法新嘗試必有 Event。 | 說明技術準入拒收無 Event，保存失敗不能聲稱已有 Event。 | B39–B42、L34 |
| §7.3：transaction 還是待決方案。 | D65 已選官方 driver＋交易共同保存，schema／guard／driver API 仍待定。 | A11–A16 |
| §9.2：每日重置未展開外部排程及故障隔離。 | D52 已選每日臺北 03:00 的外部維護流程，失敗不恢復 API。 | M05–M10 |
| §9.2／§13：跨實例重置仍泛列待定。 | v1 單 API，無跨崩潰／重置續辦保證；§11／§12 的真 DB、HTTP 並行／故障證據仍要保留。 | A18、L13、E02–E03 |
| §13：NestJS／Express、driver 尚未選定。 | Nest 預設 Express adapter、strict TS、官方 Mongo driver 已採；其餘技術細節未定。 | A02、A11 |
| 去敏 Face 綁定摘要。 | faceBound 必須表示有效映射，不照搬待整理的物理引用。 | B48、A17 |
| 未包含 D78–D99 的詳細預算／恢復／容量。 | 同步有效行為承諾與待測初值，保留未決接線及不保證完成時間的限制。 | L05–L36 |

同步後查閱位置：時間／映射／管理競爭在業務 §4；接收點／FIFO 在 §5.4；共同保存及冪等在 §7.1–7.3；生命期／故障／三類預算／容量在 §7.4–7.6；每日維護在 §9.2；新增待驗收情境在 §11.6–11.7；已採架構與未決實作契約分列 §13.1–13.2。§11.3 另補可變依據拒絕保護及首次未映射競爭驗收。

## 6. P01–P15 規劃採用去向（非工程完成）

依D114逐題深議並預設接受；下列以最新有效決策為準。待實測風險有固定阻塞gate，不能當作實作者可自由選架構。全工程要求仍U。

| ID | 已採用契約及精確來源 | 受影響要求／主要gate |
|---|---|---|
| P01 | D161依使用者決定取代D140備份要求：不另備份，精確清除舊backend/frontend，保留docs／Git／根目錄文件；G01a/G01b已驗。 | A01–A03；G01a/G01b/G02 |
| P02 | D141窄管理／辨識／查詢ports、真wrapper、scope/epoch/owner/media/qual歸屬handle、負compile與runtime接線。 | A03–A10；G03c/G04b |
| P03 | D142–D145六collection、UUID/BSON日期/null/crossshape、真guard、4096保留槽與不allocate陌生Face；unique替換G04a必先真測。 | A11–A17、B09–B12；G04a/G04b/G08a |
| P04 | D150十業務API／DTO／status／202 stage／replayed、epoch/existing-only；D151有界前置深度＋原生JSON完整語法、duplicate拒絕。 | B28–B42、L05–L36；G07a/G07b/G08a/G08b |
| P05 | D117 JSON v2取代binary、D119精確識別、D120共算入口、D122/145獨立啟動向量及digest/reference共同保存。 | B09、B33–B36、B50；G03b/G04b |
| P06 | D122人員HS256 900秒/async scrypt、Source alias.secret/SHA256 timingSafeEqual、獨立注入keys不重啟換。 | B22–B27、A06–A07、M03；G06a/G06b |
| P07 | D125精確Node/Nest/driver/Mongo與編譯pins；D129–D137 Core生命週期／兩送例外／七格；D166取代D156的正式Jest runner決策，D167完成Jest unit重驗，固定Toxiproxy及正式clean指紋證據規則仍有效；G02/G03a/G03b局部gate已發行，後續接線與真環境仍待驗。 | A02、A11–A16、L14–L23、E02–E08；G02/G03a/G03b/G05b/G10b/G10c |
| P08 | D132–D139複合無效果＋無晚寫／canonical、真共同snapshot及受控回程loss；D153私密控制屏障。 | L07–L12、L16–L21；G10a/G10b/G10c |
| P09 | D146–D147 bodyParser:false先接raw hook／同步準入及Auth provisional FIFO，D148分池與D151嚴格入口。 | L01–L02、L28–L34；G05a/G07a/G07b |
| P10 | D149 registry4096無日間淘汰、epoch前置、writeRunClaim；ordinary restart同epoch關寫、只有限安全readonly回放，private fullreset重新開寫。 | L06、L13、L20–L21、L35；G05c/G11 |
| P11 | D152三list固定keyset／route-filter-epoch cursor、四query索引、八filter case分測／explain／固定10k/40k fixture。 | B44–B47、E04；G09a/G09b |
| P12 | D153 request/operation/epoch/run allowlist、有限best-effort logs及私密read/socket，hold ACK前許可屏障／bounded current-last control回放。 | B40、B50、E05；G10a |
| P13 | D148連線／reader/body/upload/validation/scrypt/query/canonical限額及fixed-minute rate、IP表256；D155信固定proxyIP/32。 | L01、L35、M04；G07a/G07b/G11 |
| P14 | D154–D155單API/單成員replset/NGINX；systemd03臺北Persistent=false、host lock/marker、API與Mongo確停及恢復、六collection精確清理／runTicket分bootstrap-ready／failclosed。 | A18、M01、M05–M10；G11 |
| P15 | D156未被D166取代的命令／期限／clean sourceCommit規則；D166正式Jest runner與其證據失效／重驗範圍；D157固定25STOP及maintenance600/1800。文件封口G00，完整release136證據G12；本輪只討論。 | E01–E09；G00/G01a–G12 |

實作方案記錄25個STOP、命令dictionary與證據位置。G01a/G01b已依D161完成，G02/G03a/G03b/G03c、窄 G04a、G04b 及 G05a 已依D166及本輪證據完成限定驗收並停止於G05a；後續完整 FIFO ingress、use-case wiring、HTTP、capacity、transport-loss、confirmation、maintenance、deployment 與完整 v1 仍未驗證。

## 7. 實作時的證據帳本與反向覆核

每個要求以此模板留下可核對紀錄；目前局部證據記於各要求列及 `docs/evidence/g02`、`g03a`、`g03b`，完整逐列反向覆核仍待G12。

| 要求 ID | 採用來源版本 | 程式路徑／符號 | 實際測試及情境對應 | 重跑命令／環境 | 結果／commit／報告 | 覆核者與剩餘問題 |
|---|---|---|---|---|---|---|
| 待填 | 待填 | 未核對 | 未建立映射 | 未執行 | 無工程證據 | 未覆核 |

關卡覆核流程：

1. 選一小組要求，先確認相關 P 項與來源衝突已收斂，再確定實際程式／測試改動範圍。
2. 實作、執行針對性驗收並檢視結果；依風險增加真 Mongo、真 HTTP、故障或競爭驗證。
3. 更新矩陣及證據帳本；說明成功、失敗、未測、已知限制，而不是只說「測試全綠」。
4. 獨立覆核者直接讀原始 D 段與測試，反查矩陣是否漏要求或誤採舊提案；不只閱讀實作者摘要。
5. 交付差異與證據後停止。未達條件不進下一關，不因時間壓力靜默縮減要求；必要變更先與使用者確認。

**當前停止點：G05a FIFO operation coordinator primitive evidence 已通過；exact Node image 中 G05a 21、unit 58，boundary selected=23／edges=57／forbidden=0／directRawComparison=0，negative compile、build及diff check通過。仍未驗完整FIFO ingress／use-case wiring、registry／capacity／HTTP／真transport-loss／confirmation／maintenance／完整v1。依25 STOP停止於G05a。A01、A11–A16、B13、B41、B42共10項為V（G04b新增9項；G05a不新增完整requirement V），其餘126項仍U，履歷未解鎖。**

## 8. 追蹤矩陣建立時的文件覆核紀錄（歷史）

- 三個獨立只讀覆核範圍：D01–D35 的業務／排除；D36–D76 的架構／維護；D77–D99 的生命期／額度／容量。覆核者直接比對原討論，不以實作者摘要取代來源。
- 已修正：並行成功限定同一資格、拒絕重送零次轉移、固定 reason code、禁止內部 ID 通行捷徑、在場與準時未決映射投影、唯一純政策、交易 session、空映射真實競爭、重置前停止 API、確認與執行重疊計時、完成安全收尾才技術終局，以及進度／交接語意。
- 三個覆核者再次確認原指出問題已回應；此為文件語意覆核，不代表無其他遺漏，更不是工程驗證。
- 結構核對目標：136 條可追蹤要求（含 11 條排除）、15 條待決事項；要求 ID 不重複且連續，矩陣欄位一致，每條工程證據仍為 U。D01–D99 均列處理去向，語意仍可隨使用者核對補正。
- 原始討論及業務文件的 SHA-256 未變；本輪只新增此文件。沒有修改程式、設定、README 或履歷，也沒有執行資料清除、服務重啟或工程測試。

## 9. 業務文件同步紀錄（2026-09-19）

- 授權：使用者在要求追蹤矩陣交付後回答「繼續」，依上一關卡的下一步同步 business-scope.md；不擴張至程式實作。
- 同步來源：D01–D99 中已採用結論。原始 discuss.md 不變；第 1 節 SHA-256 是矩陣建立前的歷史基線，不改寫成新版本。
- 同步後業務文件 SHA-256：`fafa9e13844c0945c5eb145ae0981da1e178f6f89efe1c21be6711e06b444d2b`。
- 分小段核對：資格／映射／接收／保存，接著故障／預算／容量／reset／驗收／架構界線。字串比對確認角色 §3、QR 一次性 §4.2、首因順序 §6.2–6.3、Demo 主流程 §9.4 未改。
- 獨立只讀覆核分業務、架構／維護、生命期／額度／容量三部分；補正同資格並行的合法前提、Face EXIT 中間無重綁限定、首次接收時間的驗收點，以及可變依據拒絕／首次映射競爭驗收。不把文件審核當工程證明。
- 僅更新業務文件及本矩陣的同步狀態／驗收前提；136 條要求的工程證據仍 U，15 項 P 清單不變。沒有開始重寫、執行測試、清除資料或重啟服務。


## 10. D100–D157 細化要求與固定關卡（當前）

下列不是另加產品功能；是既有要求的新契約／反例／驗收細化。原136 ID保留，T-ID可拆多個測試，**本節的子情境也必須映射到實際測試與結果**，不能只讓第2節同名test存在便宣稱覆蓋。

| 決策範圍 | 必須保留的細化／去向 | 對應要求 |
|---|---|---|
| D100–D104 | 比較摘要與業務結果共同保存；QR/Face精確原值而非resolved ID；UNKNOWN無subject；多餘欄拒絕。 | B04、B09、B33–B36、B41、B50、E01–E03 |
| D105–D113 | QR lookup與idem HMAC分工、欄位歧義／錯鍵啟動阻擋、unpaired surrogate拒絕、合法中文emoji無損UTF8/byte長度；官方查證與獨立實驗非工程。 | B05、B09、B33–B36、B50、A11、E06、M03 |
| D114–D117 | 持續討論授權與禁止實作；binary v1候選由JSON v2取代，literal frame及HMAC/reference共算，boundary/roundtrip反例。 | B33–B36、B50、A01、E06、E09 |
| D118–D120 | issued QR32-byte/43chars；input QR1–128opaque非decode；provider grammar/subject≤256UTF8含合法空白但禁控制碼；frame≤1024，reference掃描不能證計算正確。 | B04–B09、B33–B36、B40、B50、E06 |
| D121–D122 | HS256900秒精確claims/目前角色；async scrypt固定參數/成本持額；machine secret timingSafeEqual；金鑰分離／不重啟換；啟動獨立向量＋missing/mixed掃描failclosed。 | B22–B28、A06–A08、B50、M03、E06 |
| D123–D125 | 精確versions/pins/lockfile、Core無withTransaction、關閉一般retry但不聲稱消除隱藏重送；正常與fault隔離同版本。 | A02、A11、L14–L23、E02、E06–E08 |
| D126–D131 | abort公共生命週期最多兩送預扣不退/獨占/跨窗例外；確認起點首次未知或需清理較早；七格取代三次；D130永久終局候選不採，D89安全續辦保留。 | L07–L23、E02、E06 |
| D132–D137 | 複合無效果+no late／可信canonical與放後項分離；原非分片txn112/11000歸屬，NoSuch/label/localstate不足；snapshot primary/majority jtrue；unknown只原commit與canonical交替；首次commit用exec剩餘；固定timeout準入、先封scope、endSession無額外送。 | A10–A13、A16、B41–B42、L07–L23、E02、E06 |
| D138–D139 | 真HTTP/Mongo、單一snapshot共同before-after image；受控barrier+全地址proxy drop真回程loss、observer直連；SDAM繞路/observer受傷/barrier未解無效不能pass。 | B41–B42、L07–L11、E02–E03、E06 |
| D140–D141 | 一package骨架與窄能力仍有效；D140私密備份要求由D161明確取代，不執行。管理/辨識真wrapper與opaque handle契約不變。 | A01–A10、E06、E09 |
| D142–D145 | 六collection/UUID/incarnation/version/BSON/null/crossshape；QRlookup域分SHA256；source/mapping/qual真guard及QR負查共同guard；faceSlots sole權威/simple/partial scalar資格唯一，替換微型G04a先測；4096含empty/只管理allocate/陌生拒絕不建槽、count共同保存及boot核對。 | B09–B14、B39–B42、B48–B50、A11–A17、E02–E03、E06 |
| D146–D148 | Auth前同步FIFO準入，普通validation4寫/1login/1query＋retry2、HTTP28＋4不借；req.close非cancel；raw hook bodyParserfalse／fatalUTF8/BOM；64connections/16readers/16KiB/5supload、scrypt1/queryDB1/canonical2/confirm1持至真收束；fixedminute rate/IP256及postauth拒收。 | B28、B40、L01–L06、L24–L35、M04、E01、E06 |
| D149 | registry4096全類原ID無白天淘汰、四資源同步預留／join返；epoch前置／舊epoch拒絕、readonly查無不證不存在；persistent writeRunClaim正常停止不清，sameEpoch restart關寫、private fullreset新epoch重開。 | B33–B36、L06–L13、L20–L21、L28–L35、A18、M07–M10、E06、E09 |
| D150–D151 | 十business routes含Eventdetail/null資格；嚴格DTO/dates/headers/query，management無idem/QR lost不可重取；200保存replayed/202stage-confirm-control/503unconfirmed vs safe terminal；epoch/existingonly；16KiB fatalUTFBOM/深度先filter原生語法後scan cookedduplicate/all arrays拒。 | B04、B22–B52、L24–L36、M04、E01、E03、E06 |
| D152 | keyset fixed3sort/AND3filters、p1cursorroute-filter-epoch/512chars/limit1–100；不跨頁snapshot；四queryindexes／10k-40kfixture／八filter各別warmup10measure100raw p50p95explain／只改nonunique索引。 | B44–B49、E04、E06、E09 |
| D153 | allowlist request/operation/epoch/run/fixedcode、有限log/drop非必要Event；socket私密權限；hold同步屏障ACK/不撤issued；manual與maintenance獨立；current-last control replay有界/stale拒絕；late callback歸屬不凍permission。 | B40、B50、L07–L12、E05–E06、M05、M07 |
| D154–D155 | LinuxCompose單API/單member非HA、NGINXpins/HTTPS前提/固定proxy/禁止upstreamretry；systemd03TaipeiPersistentfalse/hostlockmarker/drain30/API+Mongo確認stop/恢復PRIMARY/僅passhub_demo六collection deleteMany保indexes；seed不整庫原子/任何fail off；受控ticketbootstrap與ready分開/普通boot不接claim；proxy/Mongo/容器全表面去敏及秘密scan。 | A18、L11–L13、M01–M10、B50、E05–E09 |
| D156–D157、D166 | Jest runner先編TS/真HTTPMongo/固定fault工具digestgate；期限fail非rollback/cleanup不蓋錯；正式clean sourceCommit/指紋及報告revision區分/變更失效/普通CI非完整證據；25STOP／每關報驗證再停。D166取代D156的Node unit runner選擇，其他證據規則保留。 | E01–E09、A01–A02、L07–L23、M05–M10 |

### 10.1 136 要求逐列gate索引

下列gate是規劃責任／驗收落點，不是測試已存在或通過。每ID保留第2/3節全情境與第10節細化；G12再獨審全部要求與排除。實作時必填第7節帳本（code/test/command/result/commit/artifact/reviewer）。

| 要求ID | 固定gate（規劃對應） |
|---|---|
| B01 | G03a、G08a、G12 |
| B02 | G03a、G08a、G12 |
| B03 | G03a、G08a、G12 |
| B04 | G03a、G08a、G12 |
| B05 | G03a、G08a、G12 |
| B06 | G03a、G08a、G12 |
| B07 | G03a、G08a、G12 |
| B08 | G04a、G04b、G08a、G08b、G10c |
| B09 | G04a、G04b、G08a、G08b、G10c |
| B10 | G04a、G04b、G08a、G08b、G10c |
| B11 | G04a、G04b、G08a、G08b、G10c |
| B12 | G04a、G04b、G08a、G08b、G10c |
| B13 | G04a、G04b、G08a、G08b、G10c |
| B14 | G04a、G04b、G08a、G08b、G10c |
| B15 | G03a、G05a、G08a、G08b |
| B16 | G03a、G05a、G08a、G08b |
| B17 | G03a、G05a、G08a、G08b |
| B18 | G03a、G05a、G08a、G08b |
| B19 | G03a、G05a、G08a、G08b |
| B20 | G03a、G05a、G08a、G08b |
| B21 | G03a、G05a、G08a、G08b |
| B22 | G06a、G06b、G07b、G08b |
| B23 | G06a、G06b、G07b、G08b |
| B24 | G06a、G06b、G07b、G08b |
| B25 | G06a、G06b、G07b、G08b |
| B26 | G06a、G06b、G07b、G08b |
| B27 | G06a、G06b、G07b、G08b |
| B28 | G06a、G06b、G07b、G08b |
| B29 | G03a、G08b |
| B30 | G03a、G08b |
| B31 | G03a、G08b |
| B32 | G03a、G08b |
| B33 | G03b、G05c、G08b、G10c |
| B34 | G03b、G05c、G08b、G10c |
| B35 | G03b、G05c、G08b、G10c |
| B36 | G03b、G05c、G08b、G10c |
| B37 | G04b、G05a、G05b、G07b、G08b、G10b、G10c |
| B38 | G04b、G05a、G05b、G07b、G08b、G10b、G10c |
| B39 | G04b、G05a、G05b、G07b、G08b、G10b、G10c |
| B40 | G04b、G05a、G05b、G07b、G08b、G10b、G10c |
| B41 | G04b、G05a、G05b、G07b、G08b、G10b、G10c |
| B42 | G04b、G05a、G05b、G07b、G08b、G10b、G10c |
| B43 | G04b、G05a、G05b、G07b、G08b、G10b、G10c |
| B44 | G09a |
| B45 | G09a |
| B46 | G09a |
| B47 | G09a |
| B48 | G09a |
| B49 | G09a |
| B50 | G07a、G09a、G10a、G11、G12 |
| B51 | G12 |
| B52 | G07a、G08b |
| A01 | G01a、G01b（D161完成，V） |
| A02 | G02、G12 |
| A03 | G03c、G04b、G08a、G08b |
| A04 | G03c、G04b、G08a、G08b |
| A05 | G03c、G04b、G08a、G08b |
| A06 | G03c、G04b、G08a、G08b |
| A07 | G03c、G04b、G08a、G08b |
| A08 | G03c、G04b、G08a、G08b |
| A09 | G03c、G04b、G08a、G08b |
| A10 | G03c、G04b、G08a、G08b |
| A11 | G04a、G04b、G10b、G10c |
| A12 | G04a、G04b、G10b、G10c |
| A13 | G04a、G04b、G10b、G10c |
| A14 | G04a、G04b、G10b、G10c |
| A15 | G04a、G04b、G10b、G10c |
| A16 | G04a、G04b、G10b、G10c |
| A17 | G03a、G04b、G08a、G08b、G09a |
| A18 | G05a、G11 |
| L01 | G05a、G07b、G08b |
| L02 | G05a、G07b、G08b |
| L03 | G05a、G07b、G08b |
| L04 | G05a、G07b、G08b |
| L05 | G05c、G07b、G08b |
| L06 | G05c、G07b、G08b |
| L07 | G05b、G05c、G10a、G10b、G10c |
| L08 | G05b、G05c、G10a、G10b、G10c |
| L09 | G05b、G05c、G10a、G10b、G10c |
| L10 | G05b、G05c、G10a、G10b、G10c |
| L11 | G05b、G05c、G10a、G10b、G10c |
| L12 | G05b、G05c、G10a、G10b、G10c |
| L13 | G05c、G11 |
| L14 | G05b、G10b、G10c |
| L15 | G05b、G10b、G10c |
| L16 | G05b、G10b、G10c |
| L17 | G05b、G10b、G10c |
| L18 | G05b、G10b、G10c |
| L19 | G05b、G10b、G10c |
| L20 | G05b、G10b、G10c |
| L21 | G05b、G10b、G10c |
| L22 | G05b、G10b、G10c |
| L23 | G05b、G10b、G10c |
| L24 | G07b、G08b |
| L25 | G07b、G08b |
| L26 | G07b、G08b |
| L27 | G07b、G08b |
| L28 | G05c、G07a、G07b、G11 |
| L29 | G05c、G07a、G07b、G11 |
| L30 | G05c、G07a、G07b、G11 |
| L31 | G05c、G07a、G07b、G11 |
| L32 | G05c、G07a、G07b、G11 |
| L33 | G05c、G07a、G07b、G11 |
| L34 | G05c、G07a、G07b、G11 |
| L35 | G05c、G07a、G07b、G11 |
| L36 | G07b、G08b、G10a、G10c |
| M01 | G11、G12 |
| M02 | G11、G12 |
| M03 | G11、G12 |
| M04 | G07a、G07b、G11 |
| M05 | G11 |
| M06 | G11 |
| M07 | G11 |
| M08 | G11 |
| M09 | G11 |
| M10 | G11 |
| E01 | G07a、G07b、G08a、G08b、G09a、G12 |
| E02 | G04a、G04b、G10b、G10c |
| E03 | G07b、G08a、G08b、G10b、G10c |
| E04 | G09a、G09b |
| E05 | G10a、G11 |
| E06 | G03a、G03b、G03c、G04a、G04b、G05a、G05b、G05c、G06a、G06b、G07a、G07b、G08a、G08b、G09a、G09b、G10a、G10b、G10c、G11、G12 |
| E07 | G02、G11、G12 |
| E08 | G12 |
| E09 | G12 |
| X01 | G03a、G03c、G07a、G08a、G08b、G09a、G11、G12 |
| X02 | G03a、G03c、G07a、G08a、G08b、G09a、G11、G12 |
| X03 | G03a、G03c、G07a、G08a、G08b、G09a、G11、G12 |
| X04 | G03a、G03c、G07a、G08a、G08b、G09a、G11、G12 |
| X05 | G03a、G03c、G07a、G08a、G08b、G09a、G11、G12 |
| X06 | G03a、G03c、G07a、G08a、G08b、G09a、G11、G12 |
| X07 | G03a、G03c、G07a、G08a、G08b、G09a、G11、G12 |
| X08 | G03a、G03c、G07a、G08a、G08b、G09a、G11、G12 |
| X09 | G03a、G03c、G07a、G08a、G08b、G09a、G11、G12 |
| X10 | G03a、G03c、G07a、G08a、G08b、G09a、G11、G12 |
| X11 | G03a、G03c、G07a、G08a、G08b、G09a、G11、G12 |

### 10.2 本輪必要同步驗證紀錄

- 僅Markdown：business-scope有效差異分段同步，矩陣改最新規劃／P採用與子情境／gate；D01–D157討論歷史保留，舊SHA及第8/9節是歷史基線。
- D161後readonly結構檢查：136 unique要求ID；A01為V、其餘135項U；P01–P15及25STOP保留。僅舊碼清除／保留項驗證完成，沒有新code、package、安裝、DB或部署驗證。
- D159後三名原覆核者直接重讀補正，確認當時指定問題均已回應。D161另由使用者明確改變舊碼處理策略；只A01更新為V，其餘U保留。
