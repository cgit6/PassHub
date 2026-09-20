---
artifact_type: socratic-knowledge
schema_version: 2
id: "20260915-passhub-business-scope-discussion"
title: "PassHub v1 業務邊界與架構討論紀錄"
status: settled
verification: partially-sourced
mode:
  - B
  - D
  - E
topics:
  - "access control business scope"
  - "single-visit qualification"
  - "QR and face recognition inputs"
  - "presence state"
  - "portfolio scope reduction"
  - "modular architecture"
  - "atomic persistence"
  - "information hiding"
aliases:
  - "PassHub 業務邊界討論"
  - "PassHub 求職作品範圍決策"
  - "PassHub 架構辯論"
created: "2026-09-15"
updated: "2026-09-20"
---

# PassHub v1 業務邊界與架構討論紀錄

## 快速檢索卡

- 核心問題：在小型訪客資格／模擬辨識決策業務上，形成合理、模組化、可驗證的Node.js/TypeScript架構與逐關方案；不以兩天時限取代品質論證。
- 當前結論：D160完成規劃封口；D161完成舊碼清除；D163–D167完成G02–G03b限定證據；D168完成G03c窄scope／opaque handle／composition限定證據；D169完成G04a Face reverse-unique 真Mongo限定gate；D170完成G04b完整原子保存 adapter 限定gate（57 tests）；D171完成G05a FIFO coordinator primitive 限定gate（21 tests）；D172完成G05b execution／confirmation budget ledger 限定gate（80 tests）；D173完成G05c registry／epoch／晚callback fence primitive 限定gate（51 tests）；D174完成G06a human-auth primitive 限定gate（unit 88、true Mongo 5）並停止於G06a。A01、A11–A16、B13、B41、B42共10項為V（G04b新增9項；G05a／G05b／G05c／G06a不新增完整requirement V）、其餘126項仍U，完整v1未完成。
- 關鍵爭點：D129原生中止兩送有界組預扣不退、跨窗口局部例外；D130較早確認起點／D131七格；D143 Face反向unique同txn替換必须G04a先真測。D149同epoch普通restart關寫是明示可用性代價，不能依memory空接管。
- 適用於：D01–D165有效採用／修正、獨立角色公開論點、官方查證及剩餘gate風險。採Nest預設Express/strictTS/官方driver/單API/單Mongo member replica set，非無框架或HA；25STOP見D157及實作方案。
- 不適用於：把歷史候選／官方語法／manifest／獨立唯讀實驗當PassHub已完成成果。D117 JSON v2已取代binary v1，D130永久終局候選未採，D89安全條件續辦仍有效；D161只有A01為V。
- 待驗證：G05b之後所有gate；G04b已證六 collection schema／integrity、共同保存、freshness、QR／Face解析、comparison artifact、Event/source unique、canonical snapshot及typed error分類；G05a另證內部FIFO primitive；G05b另證純execution／confirmation budget ledger、七格、native precommit兩送及continuation admission，但不含bounded HTTP ingress/use-case wiring、registry、driver wire、native清理／真回程loss、perf/logs/hold、Docker/CI/03維護/TLS及完整release。G04a仍只證Face reverse-unique微型阻塞；G02–G03c保留各自限定證據。
- 實作者入口：[實作方案](implementation-plan.md)，再讀[136要求矩陣](requirements-traceability.md)及[業務規格](business-scope.md)，並回查對應D原文。未來每子關報實際證據後STOP，D114不授權未來不停實作。

## 閱讀狀態與階段界線

- 最新狀態：D174記錄G06a human-auth primitive限定gate已通過並停止；仍沒有Source auth、完整G05a／G05b／G05c composition、完整HTTP／Nest controller／route權限／use-case FIFO wiring、Mongo writeRunClaim、capacity、driver wire／真transport-loss／safe terminal／confirmation、timing-side-channel、完整v1接線或部署。A01、A11–A16、B13、B41、B42共10項為V（G04b新增9項；G05a／G05b／G05c／G06a不新增完整requirement V），其餘126項仍U。
- D01–D35 及所有較早摘要／交接保留歷史；其中「K1尚未同步」「尚未開始第二階段」「API/schema未定」不代表當前狀態。最新有效版本由D117/119/122/125/129–139/140–157及後續明確覆核修正判定，歷史block不回寫。下方回溯狀態描述只對當時有效，不能用來覆蓋新版。
- 文件整體settled代表有效規劃已採用；D161留下舊碼處理證據，D163–D167留下G02–G03b證據，D168留下G03c限定架構證據，D169留下G04a限定真Mongo證據，D170留下G04b限定真Mongo證據，D171留下G05a primitive證據，D172留下G05b budget ledger證據，D173留下G05c registry primitive證據，D174留下G06a human-auth primitive證據。partially-sourced仍含專案取捨、官方查證與未實測組合；G04b／G05a／G05b／G05c／G06a不代表完整API、FIFO ingress、composition、HTTP、Source auth、driver wire、真transport-loss或其餘126要求通過。
- 「使用者已接受」與「辯論暫定」逐 block 區分。授權保存辯論不等於確認候選架構，也不等於授權重寫程式。
- D36–D41 為 2026-09-16 回溯追加；統一使用建檔時間，不捏造各輪原始時間。
- D42–D46 為 2026-09-17 回溯追加；統一記錄保存時間，不捏造各輪原始時間。公開程式查核另保留查詢日期及固定 commit。
- D47–D51 為 2026-09-17 17:20 回溯追加；保存使用者逐項選擇、未接受的提案及仍待確認的重啟順序，不虛構新一輪角色攻防。
- D52–D57 為 2026-09-17 17:47 回溯追加；保存後續維護確認及三個獨立 agent 的正式攻防，不保存內部思考，不捏造逐輪原始時間。使用者確認的是共同責任契約，尚未選擇核心模組分合。
- D58–D59 為 2026-09-17 18:05 回溯追加；保存最後選擇的角色論點與使用者對 AccessModule 的接受，不把偏好當成客觀優勢或已完成工程成果。
- D60–D61 為 2026-09-18 回溯追加；記錄的是前段已發生的 Auth／Sources 攻防與使用者同意，時間為保存時間，不捏造原始回合日期及秒數。
- D62–D65 為 2026-09-18 11:43 回溯追加；保存已發生的接線及 MongoDB 攻防與兩次明確接受，時間為保存時間，不捏造逐輪秒數。資料模型與未映射競爭尚未定案。
- D66–D67 為 2026-09-18 12:28 回溯追加；保存目前映射與首次建立競爭的攻防及使用者接受，時間為保存時間，不捏造逐輪秒數；逾期釋放機制尚未選定。
- D68–D69 為 2026-09-18 12:50 回溯追加；保存逾期整理與截止前收到、截止後完成的 ENTRY 攻防及使用者接受，時間為保存時間；終結 reason 優先序仍待下一輪確認。
- D70–D72 為 2026-09-18 13:49 回溯追加；保存拒絕 reason 候選、使用者要求重評體驗、三 agent 攻防及使用者採用準時接收保障。時間為保存時間，不捏造逐輪時點；尚未採用接收占位、排序、緩衝或其他具體技術方案。
- D73–D74 為 2026-09-18 14:30 回溯追加；保存單實例接收保護候選、兩階段持久保護必要論的退守，以及使用者採用相關完整寫入協調。時間為保存時間；FIFO、接收點及故障恢復尚未定案。
- D75–D76 為 2026-09-18 14:54 回溯追加；保存接收點／全 FIFO 的攻防、撤銷不能超車的取捨及使用者接受。時間為保存時間；排隊及執行上限尚未定案。
- D77–D78 為 2026-09-18 16:05 回溯追加；保存等待／執行期限的三 agent 公開攻防，以及使用者指出準時簽到不應因忙碌重送而逾期後的修正與接受。時間為保存時間，不捏造新一輪 agent 仲裁；上限數值與實作仍未定。
- D79–D80 為 2026-09-18 18:18 回溯追加；保存新一輪執行／確認預算攻防及白話澄清後對資料庫結果不明暫停通行的接受。當前狀態以末尾 D80 及其交接為準；不把跨恢復總預算、重試次數或恢復細節一併標為已採用。
- D81–D83 為 2026-09-19 01:31 回溯追加；保存恢復與維護的前段攻防、新增 UX 異端的兩輪自動辯論及白話說明後的接受。時間為保存時間，不捏造原回合時點；接受的是原資料未重置下的安全續辦與進度原則，不等於選定自動恢復工具或逐項人工批准。
- D84–D85 為 2026-09-19 01:37 回溯追加；保存工程與 UX 的兩輪發起責任攻防、撤回人工優先及使用者接受混合分工。時間為保存時間，非逐輪原始時間；沒有實際恢復服務或設定自動排程。
- D86–D87 為 2026-09-19 01:43 回溯追加；保存兩輪確認額度攻防與使用者接受。時間為保存時間，非逐輪原始時間；只採用確認上限的規則，尚未選秒數／次數值，也未確認超限後無效果原項須人工批准或可以自動續辦。
- D88–D89 為 2026-09-19 01:49 回溯追加；保存超限後晚證據的兩輪攻防與使用者接受。時間為保存時間，非逐輪原始時間；採用條件式自動續辦及人工關注／管控的區別，尚未定義執行資格計量或實作接管機制。
- D90–D91 為 2026-09-19 01:55 回溯追加；保存執行上限的兩輪攻防及使用者接受。時間為保存時間，非逐輪原始時間；採用計時／計次規則、最後一輪及技術終局界線，具體數值與工程機制仍未選定。
- D92–D93 為 2026-09-19 02:03 回溯追加；保存三種上限的對照、Demo 初始值的兩輪攻防及使用者接受。時間為保存時間，非逐輪原始時間；初值可調且未量測，未寫入程式設定。
- D94–D95 為 2026-09-19 02:09 回溯追加；保存 HTTP 起點的兩輪攻防及使用者接受。時間為保存時間，非逐輪原始時間；採用起點及一次回覆政策，入口／框架機制與測試仍未完成。
- D96–D97 為 2026-09-19 02:15 回溯追加；保存容量准入的兩輪攻防及使用者接受。時間為保存時間，非逐輪原始時間；採用名額生命期與拒絕／重送語意，容量數字與實作接線仍未定。
- D98–D99 為 2026-09-19 02:24 回溯追加；保存容量初值的工程／UX 公開攻防及使用者接受。時間為保存時間，非逐輪原始時間；初值可調且未量測，完整准入為採用政策，未寫入程式或設定。
- D100–D101 為 2026-09-19 03:05 回溯追加；保存 QR 比對的質詢與工程異端攻防，以及使用者對比較摘要與業務結果共同原子保存的接受。時間為保存時間，非逐輪原始時間；其餘候選仍待確認，未執行實作或測試。
- D102–D103 為 2026-09-19 03:11 回溯追加；保存 provider 大小寫的質詢攻防與使用者對三種媒介內容比對規則的接受。時間為保存時間，非逐輪原始時間；完整格式政策及摘要設計仍待確認，未執行實作或測試。
- D104 為 2026-09-19 03:13 回溯追加；保存使用者直接選擇多餘欄位拒絕與後續保存授權，不捏造自動辯論。時間為保存時間；實際欄位名稱及格式細節未定，未執行實作或測試。
- D105–D107 為 2026-09-19 03:21 回溯追加；保存經核准的 Q1 官方查證、三個獨立 agent 的正式論點及使用者接受。時間為保存時間，不捏造原始逐輪時點；不保存隱藏思考，不把官方 API 文件或採用方向當成專案安全／實作驗證。
- D108–D109 為 2026-09-19 03:28 回溯追加；保存工程異端、捍衛、仲裁三個獨立 agent 的正式攻防與使用者接受。時間為保存時間，不捏造逐輪時點；只新增啟動檢查契約，不宣稱安全證明或已完成工程驗證。
- D110–D113 為 2026-09-19 03:57 回溯追加；保存未成對代理碼質詢、經核准的 Q2 查證、證據後重述、合法多位元組攻防及使用者接受。時間為保存時間，非逐輪原始時點；只保存正式公開論點，獨立唯讀實驗與待執行的 PassHub 驗收分開。
- D39 明確撤除本輪架構辯論的兩天判準；舊 block 保留當時的時限理由，但後續不能再以時程或節省實作成本取代架構論證。

## 記錄規則

- 每個已形成結論的議題立即新增一個 block，不等待整場討論結束。
- block 保留當時的問題、攻防、決策過程與結論；後續即使出現衝突，也不回寫舊 block。
- 新結論若修正或推翻舊結論，另開新 block，並標明它與舊 block 的關係。
- 每個 block 使用 Asia/Taipei（UTC+08:00）時間。D01–D13 是本次回溯建檔，因沒有可靠的逐題原始秒數，統一記錄回溯建檔時間，不捏造各回合時間。
- 「當時結論已確認」只代表該回合已形成決策，不代表後續不能推翻，也不代表程式或業務文件已完成修改。

## 核心問題

PassHub 是求職作品，不是準備投入真實營運的門禁產品。它需要保留參考 middleware 系統中「辨識輸入進入後端、映射業務對象、形成決策並留下可查事件」的核心脈絡，但必須刪除影像基礎設施、硬體控制、大型管理後台與通用事件動作等能力。工程品質可以高於參考程式，業務能力則應維持顯著較小；任何刻意偏移都必須明確揭露，不能宣稱為原系統的完整重現。

## 形成的知識

### D01｜與參考 middleware 系統的關係

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認；逐項業務邊界仍在討論
- 討論問題：PassHub 是否必須是參考系統的嚴格子集，以及作品可以在哪些地方做不同設計。
- 初始主張：作品的業務能力只能比參考系統小，核心流程不能偏移太多；缺少硬體、影像辨識服務及真實業務資料時可以用模擬取代。
- 關鍵挑戰：PassHub 採用的單次通行資格與 Presence 狀態機，在參考程式中沒有找到完全相同的業務模型，因此不能同時宣稱「嚴格子集」與「完整重現」。
- 決策過程：保留整體範圍較小的原則，但允許少量、經逐題確認且公開承認的作品化延伸；工程設計可以改善，不能把改善後的獨立作品描述成目標公司的原系統。
- 結論：
  1. PassHub 整體業務能力必須顯著小於參考系統。
  2. 核心脈絡保留為「辨識輸入 → 身分／資格映射 → 規則判斷 → 結果與稽核事件」。
  3. 單次資格與 Presence 是 PassHub 的刻意延伸，必須如實標示，不宣稱完全重現或嚴格子集。
  4. TypeScript、模組化、自動化測試、一致性與安全處理屬於工程品質提升，不會因此擴張業務範圍。
  5. 真實人臉辨識、影像串流與硬體資料以邊界模擬取代，不假裝已完成實體整合。
- 主張變化：`只能是嚴格子集` → `整體範圍更小，但允許明示的作品化延伸`。
- 適用邊界：本結論只約束產品能力與對外敘事；不要求複製參考 repository 的 API、欄位、畫面或程式結構。
- 待處理問題：後續每一項能力仍需判斷是參考流程的縮限、作品化延伸，或應直接刪除。
- 依據來源：使用者提供的作品目標與時限；K1；K2 的公開程式查核。

## 討論的演化

- D01：從「不得超出參考系統」收斂為「整體顯著較小；任何獨立延伸必須逐項確認並揭露」。
- D02–D03：選擇單次通行資格及三段式狀態，同時承認兩者不是參考系統的原樣重現。
- D04–D07：降低 QR 與 Face 的身分保證，只維護資格映射，不建立影像或真人身分驗證能力。
- D08–D10：移除在單點 Demo 中價值不足的 Access Group、陌生人主檔與下游動作觸發。
- D11–D13：保留最小角色授權、固定方向 Source 與可立即展示的有效時間規則。
- D14：Qualification 進入 INSIDE 後完全凍結，只允許完成 EXIT。
- D15：未入場、未撤銷且未逾期的 Qualification 可修改有限欄位，QR credential 保持不變。
- D16：未入場的有效 Qualification 可由 Operator 附理由永久撤銷；保留紀錄、停用 QR 並釋放 Face Mapping。
- D17：修改／撤銷與 ENTRY 競爭時只允許一方先成功，另一方依已提交的新狀態決定結果。
- D18：同一 Source 的相同 external event ID 重送時回放首次結果；相同鍵不同內容則拒絕為協定衝突。
- D19：不同事件同時 ENTRY 時最多一筆成功，其他嘗試保存為可解釋的 ALREADY_INSIDE 拒絕 Event。
- D20：不同事件並行 EXIT 時最多一筆成功；QR 輸家為 ALREADY_EXITED，Face 輸家在 Mapping 釋放後為 FACE_SUBJECT_NOT_MAPPED。
- D21：通過 Source 認證且格式合法的新通行嘗試皆保存 Access Event；認證、格式及冪等衝突只進技術／安全紀錄。
- D22：Access Event 與必要 Presence 轉移必須完整保存後才能回覆業務結果；保存失敗一律 fail closed。
- D23：Operator／Viewer 只共用 Qualification、INSIDE Qualification 與 Access Event 三類分頁查詢。
- D24：Operator／Viewer 使用相同的去敏查詢欄位；QR、機器憑證及完整 Face subject 永不由查詢或日誌揭露。
- D25：Demo 改為公開共享且可隨時重置的 sandbox；GitHub 保存程式與文件，API runtime 使用其他公開執行環境。
- D26：公開 sandbox 每日自動清除體驗資料並恢復固定 seed；維護者另有非公開手動重置命令。
- D27：公開 sandbox 限制請求頻率、body 大小及分頁上限；超限請求不形成 Access Event。
- D28：Access Event 清單只支援 qualificationId、outcome 與 reasonCode 三種固定篩選，並採穩定時間排序。
- D29：Qualification 清單不提供篩選或搜尋，只保留穩定分頁排序、單筆詳情與獨立 INSIDE 清單。
- D30：公開 Demo 以 OpenAPI／curl 完成 QR ENTRY→Face EXIT 主流程，不製作產品型前端。
- D31：Face subject 重綁後不追溯歷史 Mapping；新 event ID 一律依接收當下 Mapping 處理，延遲補送列為 Source 責任與已知限制。
- D32：每筆新通行嘗試只產生一個 reason code，ENTRY／EXIT 依固定優先序判斷。
- D33：API response 與 Access Event 統一使用 ACCEPTED／REJECTED outcome；協定、認證與系統錯誤使用獨立 error code。
- D34：鎖定 v1 最終排除清單，不加入帳號後台、真實辨識／硬體、下游動作、產品型前端或正式營運能力。
- D35：使用者完成整體驗收，PassHub v1 業務邊界正式收斂，可同步改寫 K1；仍不得提前進入架構或實作。

## 邊界與未解問題

- Operator 在 Qualification 進入 INSIDE 後的凍結規則、入場前修改、撤銷及其與 ENTRY 的競爭結果均已確認。
- D18–D20 已確認辨識事件重送、並行 ENTRY 與並行 EXIT 的狀態及事件結果。
- D21 已確認 Access Event 與 protocol／security log 的分界。
- D22 已確認 Event／Presence 的完整保存及 fail-closed 回應條件；具體一致性技術留待第二階段。
- D23 已確認最小查詢種類。
- D24 已確認兩種人員角色共用的可見欄位與秘密遮蔽。
- D25 已推翻 K1 的「只限本機」前提並確立公開共享 sandbox。
- D26 已確認每日自動重置與非公開手動重置。
- D27 已確認公開 API 的最低公平使用限制；精確數值與套件留待第二階段。
- D28 已確認 Access Event 的最小篩選與排序語意。
- D29 已確認 Qualification 清單不提供額外篩選。
- D30 已確認公開 Demo 的固定主流程與無產品型前端邊界。
- D31 已確認延遲 Face 事件不納入 v1，避免歷史 Mapping 與 occurredAt 決策能力。
- D32 已確認拒絕與成功 reason code 的固定優先序。
- D33 已統一 API 與 Event 的通行結果術語，取代 D10 中暫用的 `ALLOW`／`DENY`。
- D34 已確認最終排除清單；目前只剩整體業務邊界驗收。
- D35：完整產品敘述獲使用者確認，第一階段業務邊界正式收斂。
- K1 尚未同步 D08 與 D10：文件仍含 Access Group、Fixed Event Receiver、Event Delivery、outbox、背景重試及相關驗收文字。
- K1 對 `validFrom` 的既有文字仍禁止回填過去時間，與 D13 已接受規則衝突。
- K1 部分段落仍將 Presence 寫成真人「目前在場」，後續應改為資格使用狀態，避免過度宣稱身分保證。
- K1 仍將 Demo 限定在本機 Docker；後續須依 D25 改為公開共享 sandbox，同時保留本機可重跑能力。
- 本文件只記錄業務決策；尚未開始第二階段架構規劃，也沒有授權重寫程式。
- D35 已確認業務範圍整體收斂；目前只授權同步業務規格文件，不包含架構設計或程式重寫。

## 知識範圍與前提

- K1｜`/home/sean/PassHub/docs/business-scope.md`｜目前業務規格草稿｜已參考；尚未同步本輪新決議。
- K2｜[`e234xp/middlewareServer` 固定查核版本](https://github.com/e234xp/middlewareServer/tree/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0)｜公開參考系統｜已查核；只用於理解業務脈絡，不作為可複製規格。
- K3｜使用者提供的目標職缺、內部訪談資訊、兩天時限與求職作品定位｜需求來源｜已參考・鎖定。
- 參考系統的已查核脈絡包含 Visitor／Person、Camera／Tablet Source、辨識結果、事件條件及外部動作；未找到與 PassHub 完全相同的單次資格及 Presence 模型。
- 使用者已明確排除真實影像基礎設施、人臉辨識及硬體測試；Face 輸入只模擬外部服務已完成辨識後的結果。
- 本紀錄區分公開程式事實、使用者提供資訊、討論推論與已確認決策；「需求已確認」不代表實作或驗證已完成。

## 交接資訊

- 下一步依 D01–D35 改寫 K1，逐章移除舊 Access Group、Delivery／outbox、本機限定與其他衝突內容，並保留第二階段技術決策空間。
- D18–D35 已閉合事件處理、查詢揭露、公開展示、重置、最低保護、清單範圍、固定 Demo 主流程、延遲事件限制、reason code 優先序、結果術語、排除範圍及整體驗收。
- 整場業務邊界確認完成後，才依所有 Dxx 結論逐段改寫 K1，並刪除已被否決的 Access Group 與下游投遞內容。
- 修改 K1 時必須執行文字搜尋，確認舊名詞、reason code、驗收案例及作品證據均已同步，不只改摘要。

## 追加討論紀錄

### D02｜以單次通行資格取代永久 Visitor 主檔

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認
- 與既有結論的關係：具體化 D01 允許的作品化延伸；不回寫 D01。
- 討論問題：PassHub 應維護可跨多次拜訪重用的 Visitor 主檔，還是每次來訪各自建立一張資格。
- 初始主張：參考系統以 Visitor／Person 資料為中心；改成單次資格可能偏離其資料生命週期。
- 使用者選擇：維持單次通行資格。
- 決策過程：以兩天內能閉合的單次進出流程為優先，捨棄永久人員主檔、多次拜訪與跨資格關聯；同時將此差異列為獨立作品設計，不偽裝成參考系統原有模型。
- 結論：
  1. 每張 Qualification 只代表一次來訪及一個進出週期。
  2. 不建立永久 Visitor 主檔，也不將多次 Qualification 聚合為同一訪客歷史。
  3. Qualification 可包含展示名稱、有效區間、QR credential 與可選 Face Mapping。
- 主張變化：`考慮對齊 Visitor 主檔` → `採用單次來訪 Qualification`。
- 適用邊界：Qualification 是 PassHub v1 的業務聚合，不代表已驗證真人身分。
- 待處理問題：Qualification 的欄位、索引與資料模型留待架構階段。
- 依據來源：使用者明確選擇；K1；K2 的 Visitor／Person 公開程式。

### D03｜保留 Presence，但限定為資格使用狀態

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認
- 與既有結論的關係：延伸 D02，並進一步揭露 D01 所稱的流程偏移；不回寫舊 block。
- 討論問題：`NOT_ENTERED → INSIDE → EXITED` 是否符合參考系統，以及是否值得保留。
- 關鍵挑戰：K2 沒有顯示相同的單次資格 Presence 狀態機；若稱為真人在場狀態，又會超出 QR 與模擬 Face 能提供的證據。
- 使用者選擇：保留三段式狀態，並承認它是 PassHub 的獨立延伸。
- 決策過程：狀態機能讓作品展示一致性、重複方向拒絕及並行轉移，因此保留；語意則收縮為「資格被系統視為尚未使用、已進場或已離場」。
- 結論：
  1. 唯一正常順序為 `NOT_ENTERED → INSIDE → EXITED`，每張資格只有一個週期。
  2. Presence 只代表 Qualification 的使用狀態，不證明某位真人實際在場。
  3. 對外說明不得把 Presence 宣稱為具身分保證的人員在場紀錄。
- 主張變化：`Presence 可能是參考流程的一部分` → `確認是 PassHub 延伸` → `保留，但收縮成資格狀態`。
- 適用邊界：本狀態可供通行決策與事件追查；不等同考勤、人流統計或真人定位。
- 待處理問題：並行轉移與終態 reason code 仍需另題複核。
- 依據來源：使用者明確接受；K1；K2 公開程式查核未發現同型 Presence 模型。

### D04｜QR 是 bearer credential，不提供真人身分保證

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認
- 與既有結論的關係：收縮 D03 的 Presence 解讀；不回寫 D03。
- 討論問題：QR 可被截圖或轉交時，PassHub 是否仍能宣稱辨識到資格原持有人，以及是否需要 QR 與人臉雙重核對。
- 關鍵挑戰：只持有 QR 只能證明請求方擁有該 token，不能證明真人身分；`QR ENTRY → Face EXIT` 也不能證明進出者是同一個人。
- 使用者選擇：接受 QR 可轉交的風險，不加入 QR 與 Face 雙重核對，以符合兩天時限。
- 決策過程：把安全宣稱限制在資格層級，保留兩種媒介可獨立驅動同一資格，不加入第二因素、防轉交或活體驗證。
- 結論：
  1. QR 採 bearer credential 語意，持有有效 token 即可提交辨識。
  2. QR 與 Face 可各自獨立完成 ENTRY 或 EXIT，不要求雙重核對。
  3. 跨媒介進出只表示兩次事件映射到同一張 Qualification，不表示驗證為同一真人。
  4. v1 不處理 QR 分享、截圖轉交、第二因素或防冒用。
- 主張變化：`兩種媒介驗證訪客` → `兩種媒介映射同一資格` → `不宣稱真人同一性`。
- 適用邊界：適合本機流程展示，不是高安全性門禁設計。
- 待處理問題：履歷與 README 應如何精確描述此安全邊界，留待作品完成後處理。
- 依據來源：使用者明確接受；一般 bearer token 安全語意。

### D05｜QR 只顯示一次且不提供補發

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認；已接受無復原限制
- 與既有結論的關係：補充 D04 的 credential 生命週期；不回寫 D04。
- 討論問題：QR token 遺失時，是否提供查回、補發、救援碼或人工修正。
- 關鍵挑戰：加入補發需要定義舊 token 失效、重發競爭、事件稽核及已在場者如何離場，會擴張兩天作品範圍。
- 使用者選擇：不加入 QR 補發或復原。
- 決策過程：保留一次顯示及最小撤銷能力；把已進場但沒有其他辨識媒介的遺失情境明列為 Demo 限制，而不是以不完整救援流程掩蓋。
- 結論：
  1. QR token 只在 Qualification 建立成功時回傳一次，後續查詢不得取回。
  2. 不提供補發、救援碼或人工 Presence 修正。
  3. 入場前遺失時，可撤銷舊 Qualification 並建立新 Qualification。
  4. 已 `INSIDE`、遺失 QR 且沒有 Face Mapping 時，v1 無法完成 EXIT；此情境必須列為已知限制。
- 主張變化：`考慮遺失後復原` → `不補發` → `明示進場後可能卡在 INSIDE`。
- 適用邊界：限制只可由重建本機 Demo 情境處理，不包裝成正式營運方案。
- 待處理問題：QR 的雜湊保存與比較方式屬實作設計，留待第二階段。
- 依據來源：使用者明確接受；K1 的既有已知限制。

### D06｜Face Mapping 由 Operator 預先建立

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認
- 與既有結論的關係：定義 D04 中 Face 媒介的輸入邊界；不回寫 D04。
- 討論問題：PassHub 如何知道外部辨識結果對應哪張 Qualification，以及是否自行建立人臉資料。
- 初始主張：外部服務已完成影像辨識，PassHub 只接收模擬的辨識結果並處理後續流程。
- 關鍵挑戰：若沒有預先映射，單憑外部 subject ID 無法找到來訪資格；若收到事件後自動建立，又會變成人臉 enrollment 或人員主檔能力。
- 使用者選擇：由 Operator 預先綁定外部辨識系統既有的身分 ID，PassHub 不自動建立映射。
- 決策過程：把影像及模型責任完整留在系統外；Qualification 只保存外部命名空間中的參考，辨識來源提交 `MATCHED` 或 `UNKNOWN` 模擬結果。
- 結論：
  1. Operator 建立或仍可修改 Qualification 時，可提供 `provider + externalSubjectId`。
  2. PassHub 不做人臉 enrollment、影像辨識或 subject 推論，也不因辨識事件自動建立 Face Mapping。
  3. PassHub 不保存照片、影像、feature／embedding、confidence 或 liveness 資訊。
  4. v1 不串接真實第三方人臉 API；輸入只模擬外部服務已完成辨識後的結果。
- 主張變化：`PassHub 接收辨識結果` → `先釐清映射責任` → `Operator 預綁，PassHub 只解析結果`。
- 適用邊界：`provider + externalSubjectId` 是外部參考，不代表 PassHub 驗證該外部資料真實性。
- 待處理問題：provider 的固定值、格式與機器輸入 DTO 留待架構階段。
- 依據來源：使用者明確接受；K1；使用者對無硬體／影像環境的限制。

### D07｜同一 Face subject 同時只能對應一張未終結資格

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認
- 與既有結論的關係：補充 D06，排除 Face Mapping 的選擇歧義；不回寫 D06。
- 討論問題：相同外部人臉 ID 同時綁定多張 Qualification 時，`MATCHED` 應作用於哪一張。
- 關鍵挑戰：外部事件只提供 subject ID，若有兩張尚未結束的資格，PassHub 無法確定要更新哪一次來訪。
- 使用者選擇：接受同一 subject 同時只對應一張未終結 Qualification。
- 決策過程：以唯一性限制取代時間排序、人工選擇或多候選比對，保持模擬輸入與資格映射為確定流程。
- 結論：
  1. 相同 `provider + externalSubjectId` 同時只能綁定一張未終結 Qualification。
  2. 重複綁定時拒絕建立或修改，不猜測應使用哪張。
  3. 舊 Qualification 已撤銷、已 `EXITED`，或已過期且從未入場後，subject 才能供新 Qualification 使用。
  4. Qualification 即使逾期，只要仍為 `INSIDE`，Mapping 必須保留以完成 EXIT。
- 主張變化：`允許填入外部 subject` → `發現多資格映射歧義` → `以未終結唯一性消除歧義`。
- 適用邊界：這是 v1 的簡化規則，不建立跨多次拜訪的永久人員關聯。
- 待處理問題：唯一性在 MongoDB 中的落實方式留待架構階段。
- 依據來源：使用者明確接受；D02、D03、D06。

### D08｜移除 Access Group

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認；K1 尚未同步
- 與既有結論的關係：收縮 D01 的參考能力範圍，刪除單點 Demo 中缺乏實質用途的授權維度；不回寫 D01。
- 討論問題：單一地點、固定一組 ENTRY／EXIT Source 的 PassHub 是否需要 Qualification 與 Source 的 Access Group 比對。
- 關鍵挑戰：所有有效訪客本來就使用同一組設備，Access Group 無法表達有意義的替代路徑，卻會增加欄位、驗證、reason code 與測試。
- 使用者選擇：移除 Access Group。
- 決策過程：將通行判斷縮限為 Source、方向、Qualification 效期／撤銷狀態與 Presence；參考系統較廣的群組條件不納入本作品。
- 結論：
  1. Qualification、Source、查詢及事件不包含 Access Group。
  2. 刪除群組比對、`ACCESS_GROUP_NOT_ALLOWED` reason code 及對應驗收案例。
  3. 不提供 Access Group seed、CRUD 或權限管理。
- 主張變化：`用 Access Group 展示條件式授權` → `單點固定來源下價值不足` → `整體移除`。
- 適用邊界：若未來增加多區域或多門禁權限，必須另開 v2 議題，不能在 v1 實作中偷偷恢復。
- 待處理問題：改寫 K1 時需搜尋並移除所有殘留群組語意。
- 依據來源：使用者明確接受；K1；K2 的較廣群組能力。

### D09｜UNKNOWN Face 只形成拒絕事件

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認
- 與既有結論的關係：補充 D06，縮小 K2 的陌生人處理範圍；不回寫 D06。
- 討論問題：外部模擬服務回傳 `UNKNOWN` 時，PassHub 是否需要建立陌生人資料或提供事後認領。
- 初始主張：至少應保存此次拒絕，讓事件可供查證。
- 關鍵挑戰：陌生人主檔、影像保存、比對紀錄與事後認領會重新引入影像及人員管理領域。
- 使用者選擇：只保存拒絕事件。
- 決策過程：保留事件稽核價值，刪除與 Qualification 決策無直接關係的 stranger lifecycle。
- 結論：
  1. `UNKNOWN` 形成拒絕事件，記錄 Source、固定方向、伺服器時間與 reason code。
  2. 不建立陌生人主檔，不保存照片、特徵或 confidence。
  3. 不提供 Operator 事後認領或轉換為 Qualification 的流程。
- 主張變化：`參考系統可查 stranger` → `作品只需可追查拒絕` → `保留 Event，刪除 stranger domain`。
- 適用邊界：事件不得含能還原影像或完整外部身分的資料。
- 待處理問題：Event 的最小安全欄位與保存期限仍待討論。
- 依據來源：使用者明確接受；K2 的 stranger 查詢脈絡；D06。

### D10｜只回傳決策，不觸發下游動作

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認；K1 尚未同步
- 與既有結論的關係：大幅收縮 D01 中參考 middleware 的外部動作能力；不回寫 D01。
- 討論問題：PassHub 判定通行成功後，是否主動控制門鎖、呼叫 Webhook 或建立背景投遞流程。
- 關鍵挑戰：下游 HTTP、持久化 Delivery、重試、去重及規則引擎能展示整合能力，但會增加另一條需要閉合的失敗與營運生命週期，不利兩天內完成。
- 使用者選擇：PassHub 只回傳決策，不主動觸發下游系統。
- 決策過程：將 Recognition Source 視為同步呼叫者；PassHub 完成必要保存後回傳 `ALLOW`／`DENY`，由 Demo 呼叫端顯示「模擬開門」，不把顯示行為當成門鎖整合。
- 結論：
  1. 新辨識嘗試形成決策；成功時保存事件並更新 Qualification 狀態後，PassHub 同步回傳結果。
  2. 不控制實體門鎖，不呼叫 Webhook、HTTP receiver 或其他下游 API。
  3. 不建立 Event Delivery、outbox、背景 worker、自動重試、動作規則引擎或公開重送能力。
  4. Demo 呼叫端可以呈現模擬開門，但該呈現不屬於 PassHub 後端業務能力。
- 主張變化：`考慮用外送展示非同步整合` → `評估兩天成本` → `只保留同步決策與內部稽核`。
- 適用邊界：這會省略 K2 的重要外部動作能力，必須承認 PassHub 只是較小的辨識決策服務。
- 待處理問題：事件與 Presence 的必要保存順序仍需在一致性議題確認。
- 依據來源：使用者明確接受；K1 的既有 Delivery 草稿；K2 的外部動作觸發程式。

### D11｜只保留三種預置身分

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認
- 與既有結論的關係：收縮 D01 的帳號與營運範圍；不回寫 D01。
- 討論問題：在沒有完整管理後台的作品中，哪些人員與機器身分仍有必要保留。
- 初始主張：保留最小 RBAC 以展示登入、人員權限差異及機器來源隔離，但不建立帳號管理產品。
- 使用者選擇：接受 Operator、Viewer 與 Recognition Source 三種預置身分。
- 決策過程：將業務寫入集中於 Operator、查詢集中於 Viewer、辨識輸入集中於機器 Source；刪除自助註冊、Admin 與身分生命週期。
- 結論：
  1. `Operator` 可建立、修改、撤銷及查詢 Qualification。
  2. `Viewer` 只能查詢 Qualification 摘要、Presence 與 Event。
  3. `Recognition Source` 只能提交 QR／Face 辨識事件，不能讀取營運資料或管理 Qualification。
  4. 人員帳號與機器憑證皆由 Demo 預置；不提供註冊、帳號／角色管理、忘記密碼或 Admin API。
- 主張變化：`可能需要後台角色` → `只保留能證明授權邊界的最小三種身分`。
- 適用邊界：認證 token 與 machine credential 的格式屬第二階段設計，不在本結論指定。
- 待處理問題：Viewer 可見的 Qualification 與 Event 欄位仍待確認。
- 依據來源：使用者明確接受；K1 的角色草稿；求職作品需要展示的 API 授權能力。

### D12｜固定 ENTRY／EXIT Source，方向不可由請求指定

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認
- 與既有結論的關係：具體化 D03 的狀態輸入及 D11 的機器身分；不回寫舊 block。
- 討論問題：如何在不建立設備管理功能的情況下，可信地區分 ENTRY 與 EXIT。
- 關鍵挑戰：若請求 payload 可自行填方向，持有 ENTRY 憑證的呼叫者也能聲稱自己是 EXIT，設備身分與方向沒有約束力。
- 使用者選擇：接受固定方向、獨立機器憑證的預置 Source。
- 決策過程：以 server-side 預置資料綁定 Source 身分及方向；QR／Face 都走同一 Recognition Source 契約，避免為媒介建立兩套設備管理流程。
- 結論：
  1. Demo 預置一個啟用的 `ENTRY` Source 與一個啟用的 `EXIT` Source。
  2. 兩者各自使用機器憑證，方向由 server-side Source 決定，payload 不得覆寫。
  3. 兩個 Source 都可提交 QR 或 Face 輸入。
  4. 停用 Source 的拒絕情境以 fixture／測試驗證，不提供 Source 管理 API。
- 主張變化：`請求帶入進出方向` → `方向必須可信` → `由預置 Source 與憑證固定`。
- 適用邊界：v1 不處理多地點、設備 CRUD、動態指派或離線事件。
- 待處理問題：Source 憑證輪替與正式設備生命週期不在 v1；認證方式留待架構階段。
- 依據來源：使用者明確接受；K1；K2 的 Camera／Tablet Source 概念。

### D13｜Qualification 有效時間與逾時 EXIT

- 討論時間：2026-09-15 14:19:14 +08:00（回溯建檔）
- 狀態：當時結論已確認；K1 尚未同步
- 與既有結論的關係：精確化 D02、D03 的 Qualification 生命週期；不回寫舊 block。
- 討論問題：有效區間應如何限制 ENTRY，同時讓本機 Demo 可建立後立即使用。
- 初始主張：只有有效時間內可以 ENTRY；若強制 `validFrom` 必須在未來，Demo 建立後可能需要等待或使用不自然的時間技巧。
- 關鍵挑戰：允許已開始的有效區間不能變成建立已完全過期的 Qualification；逾時後若已在場，也不能因效期失效而無法 EXIT。
- 使用者選擇：允許 `validFrom` 位於現在、未來或已開始的過去時間，並保留逾時 EXIT。
- 決策過程：以 `validUntil` 仍在未來作為建立時的最低有效性要求；ENTRY 使用伺服器首次接收時間判斷半開區間，EXIT 則依 `INSIDE` 狀態完成離場。
- 結論：
  1. `validUntil` 必須晚於 `validFrom`，且建立時 `validUntil` 必須仍在未來。
  2. `validFrom` 可位於現在、未來或已開始的過去時間，不強制一定在未來。
  3. ENTRY 只有在伺服器時間位於 `[validFrom, validUntil)` 時才可成功。
  4. Qualification 在 `NOT_ENTERED` 狀態逾期後視為終結，不能再 ENTRY。
  5. 已進入 `INSIDE` 的 Qualification 即使超過 `validUntil`，仍可完成 EXIT。
- 主張變化：`開始時間必須在未來` → `Demo 需要立即生效` → `允許已開始，但禁止建立已完全過期資格`。
- 適用邊界：本結論不決定 client／server 時間格式、時區序列化或資料庫索引。
- 待處理問題：修改有效區間時是否沿用相同驗證，需與 Operator 修改規則一併確認。
- 依據來源：使用者明確接受；D02、D03；K1 的有效時間草稿。

### D14｜Qualification 進入 INSIDE 後完全凍結

- 討論時間：2026-09-15 15:33:35 +08:00
- 狀態：當時結論已確認；入場前修改規則尚待討論
- 與既有結論的關係：補充 D03、D05、D07 與 D13，確定 ENTRY 成功後的資料生命週期；不回寫舊 block。
- 討論問題：Qualification 已進入 `INSIDE` 後，Operator 是否仍可修改顯示名稱、有效時間、Face Mapping 或撤銷資格。
- 初始主張：ENTRY 後完全凍結，唯一允許的後續業務狀態改變是由 EXIT Source 完成離場。
- 關鍵挑戰：入場後修改會使事後查到的資格與通行當時使用的資料不一致；入場後撤銷則可能讓訪客無法以原有媒介完成 EXIT。
- 使用者選擇：接受 Qualification 進入 `INSIDE` 後完全凍結。
- 決策過程：以通行事件的可解釋性及離場可達性為優先，不加入版本化資格、入場後撤銷或人工修正等額外生命週期。
- 結論：
  1. Qualification 進入 `INSIDE` 後，Operator 不得修改顯示名稱、有效時間或 Face Mapping。
  2. `INSIDE` 狀態不得由 Operator 撤銷。
  3. 即使 `validUntil` 已過，Qualification 與原 Face Mapping 仍保持不變，供 EXIT 使用。
  4. 唯一正常後續狀態轉移是由 EXIT Source 完成 `INSIDE → EXITED`。
- 主張變化：`Operator 可能持續管理資格` → `ENTRY 後修改會破壞事件語意` → `INSIDE 後完全凍結`。
- 適用邊界：v1 不提供入場後緊急撤銷、人工離場、資料更正或 Presence 修正；正式產品需要另行設計營運救援流程。
- 待處理問題：`NOT_ENTERED` 時允許修改的欄位、撤銷條件，以及修改／撤銷與 ENTRY 的競爭結果。
- 依據來源：使用者於本輪明確接受；D03、D05、D07、D13。

### D15｜Qualification 入場前的有限修改

- 討論時間：2026-09-15 15:39:56 +08:00
- 狀態：當時結論已確認；撤銷與競爭規則尚待討論
- 與既有結論的關係：補充 D06、D07、D13 與 D14，確定 `NOT_ENTERED` 階段的可修改範圍；不回寫舊 block。
- 討論問題：Qualification 尚未入場時，Operator 可修改哪些內容，以及修改後是否需要重新符合既有規則。
- 初始主張：只允許仍為 `NOT_ENTERED`、未撤銷且尚未逾期的 Qualification 修改顯示名稱、有效區間與 Face Mapping；QR credential 不變。
- 關鍵挑戰：若修改可以繞過時間或 Face subject 唯一性規則，會建立出無法由正常建立流程產生的 Qualification；若順便更換 QR，又等同引入 D05 已排除的補發能力。
- 使用者選擇：接受有限欄位修改及既有規則重驗，不更換或重新顯示 QR。
- 決策過程：將修改視為對同一張尚未使用 Qualification 的資料校正，而不是建立新 credential 或改寫已發生的通行歷史。
- 結論：
  1. 只有 `NOT_ENTERED`、未撤銷且尚未逾期的 Qualification 可以修改。
  2. Operator 可修改訪客顯示名稱、`validFrom`、`validUntil` 及 Face Mapping。
  3. 修改後的時間必須重新符合 D13；Face Mapping 必須重新符合 D07。
  4. QR token 不更換，也不因修改而再次顯示。
  5. `INSIDE` 後的完全凍結仍依 D14，不受本結論影響。
- 主張變化：`Operator 可修改資格` → `限制在未使用階段及有限欄位` → `重新套用時間與 Face 唯一性規則`。
- 適用邊界：不提供 QR 輪替、補發、版本歷史或已發生事件的回溯修改。
- 待處理問題：撤銷 Qualification 的條件、Face Mapping 釋放時機，以及修改／撤銷與 ENTRY 同時發生時的結果。
- 依據來源：使用者於本輪明確接受；D05、D06、D07、D13、D14。

### D16｜Qualification 入場前的永久撤銷

- 討論時間：2026-09-15 15:42:44 +08:00
- 狀態：當時結論已確認；與 ENTRY 的競爭規則尚待討論
- 與既有結論的關係：補充 D05、D07、D14 與 D15，確定未入場 Qualification 的取消語意；不回寫舊 block。
- 討論問題：Operator 應在什麼條件下撤銷 Qualification，以及撤銷後如何處理舊資格、QR 與 Face Mapping。
- 初始主張：尚未入場的有效 Qualification 可以附理由撤銷；保留舊資料供查核，但所有通行能力永久失效。
- 關鍵挑戰：硬刪除會失去「曾建立後取消」的紀錄；允許重新啟用會使舊 QR 再度有效；持續占用 Face subject 則會阻止同一訪客建立未來的新資格。
- 使用者選擇：接受「尚未入場可以取消；取消後保留紀錄，但舊資格永久失效」。
- 決策過程：以不可逆撤銷取代刪除與重新啟用，保留最小稽核資料；QR 維持指向已撤銷的舊資格，Face Mapping 則釋放供未來 Qualification 使用。
- 結論：
  1. 只有 `NOT_ENTERED`、未撤銷且尚未逾期的 Qualification 可以撤銷。
  2. Operator 撤銷時必須提供簡短原因，並保存撤銷時間與原因。
  3. 撤銷不硬刪除 Qualification，且撤銷後不得重新啟用。
  4. 舊 QR 永久失效；後續提交時得到 `QUALIFICATION_REVOKED`，但任何輸出不得揭露 token。
  5. Face Mapping 在撤銷時釋放，subject 可供未來的新 Qualification 使用；尚未重綁時的輸入得到 `FACE_SUBJECT_NOT_MAPPED`。
  6. `INSIDE` Qualification 不可撤銷，仍依 D14 完成 EXIT。
- 主張變化：`取消可能刪除或停用資格` → `保留取消紀錄` → `永久撤銷 QR 並釋放可重用 Face subject`。
- 適用邊界：撤銷不是刪除、暫停或入場後的緊急封鎖；v1 不提供恢復、人工 Presence 修正或補發 credential。
- 待處理問題：撤銷與 ENTRY 同時發生時，哪個操作生效及另一方應得到什麼結果。
- 依據來源：使用者於本輪明確接受；D05、D07、D14、D15。

### D17｜修改／撤銷與 ENTRY 的競爭結果

- 討論時間：2026-09-15 16:09:05 +08:00
- 狀態：當時結論已確認；一致性實作留待第二階段
- 與既有結論的關係：完成 D14–D16 的 Operator 生命週期規則，並補充 D03 的 Presence 不變條件；不回寫舊 block。
- 討論問題：Operator 修改或撤銷 Qualification 與 Recognition Source 的 ENTRY 同時發生時，是否可能兩者都成功，以及後完成者應依哪一版資料處理。
- 初始主張：只允許一個操作先成功；另一個操作必須重新讀取已提交的最新狀態，再得到確定結果。
- 關鍵挑戰：若 ENTRY 與撤銷都成功，會形成同時 `INSIDE` 且已撤銷的矛盾；若 ENTRY 混用修改前後欄位，則單次決策無法說明實際採用的資格內容。
- 使用者選擇：接受先成功者生效，另一方依最新狀態處理。
- 決策過程：把競爭結果定義成業務不變條件，不在本階段預先指定 MongoDB transaction、條件更新、版本欄位或鎖定方式。
- 結論：
  1. ENTRY 先成功時，Qualification 進入 `INSIDE`；同時進行的修改或撤銷必須失敗。
  2. 撤銷先成功時，ENTRY 形成 `QUALIFICATION_REVOKED` 拒絕結果，不改變 Presence。
  3. 修改先成功時，ENTRY 必須完整依修改後的 Qualification 判斷，不得混用新舊欄位。
  4. 不允許 Qualification 同時為已撤銷與 `INSIDE`，也不允許單一 ENTRY 觀察到部分更新。
- 主張變化：`同時請求可能依排程各自處理` → `兩者都成功會破壞狀態` → `先成功者提交，另一方依最新狀態決定`。
- 適用邊界：本結論定義可觀察業務結果，不指定資料庫的一致性技術；技術選擇必須能證明這些結果。
- 待處理問題：並行的兩筆 ENTRY／EXIT 如何保存事件，以及相同事件重送如何避免重複轉移。
- 依據來源：使用者於本輪明確接受；D03、D14、D15、D16。

### D18｜Recognition Event 的冪等重送契約

- 討論時間：2026-09-15 16:36:10 +08:00
- 狀態：當時結論已確認；不同事件的並行結果尚待討論
- 與既有結論的關係：補充 D09、D10、D12 與 D17，區分網路重送與新的辨識嘗試；不回寫舊 block。
- 討論問題：Recognition Source 因網路逾時重送同一事件時，PassHub 是否應重新執行通行判斷並建立第二筆 Event。
- 初始主張：以 Source 身分與 Source 產生的 external event ID 共同識別同一事件；內容相同時回放首次結果。
- 關鍵挑戰：若重送重新判斷，第一次 ENTRY 可能成功、第二次卻因已 `INSIDE` 被拒絕，讓同一實體事件得到兩個矛盾結果；若只看 external event ID，不同 Source 又可能意外互相衝突。
- 使用者選擇：接受 `Source 身分 + externalEventId` 作為冪等鍵及首次結果回放規則。
- 決策過程：把已使用冪等鍵的內容視為不可改寫；相同內容只回放，內容不同則視為呼叫端違反協定，不建立第二筆業務事件。
- 結論：
  1. 每個 Recognition Source 必須為辨識事件提供 `externalEventId`，且該 ID 只需在該 Source 範圍內唯一。
  2. 冪等鍵固定為 `Source 身分 + externalEventId`。
  3. 相同鍵、相同業務內容重送時，回傳第一次保存的結果；不建立第二筆 Event，也不再次轉移 Presence。
  4. 相同鍵但業務內容不同時，回傳 protocol conflict；不得覆寫首次資料或建立第二筆 Access Event。
  5. 不同 Source 可以使用相同 external event ID，彼此不衝突。
- 主張變化：`每次 HTTP 請求各自判斷` → `網路重送會產生矛盾結果` → `以 Source 範圍冪等鍵回放首次結果`。
- 適用邊界：本結論不指定內容正規化、hash、HTTP status 或資料庫唯一索引；只定義外部可觀察契約。
- 待處理問題：兩個 external event ID 不同但同時操作同一 Qualification 時，狀態與 Event 應如何保存。
- 依據來源：使用者於本輪明確接受；D03、D09、D10、D12、D17；K1 的冪等草稿。

### D19｜不同辨識事件的並行 ENTRY

- 討論時間：2026-09-15 16:38:22 +08:00
- 狀態：當時結論已確認；並行 EXIT 尚待討論
- 與既有結論的關係：補充 D03、D17 與 D18，確定不同事件同時嘗試 `NOT_ENTERED → INSIDE` 的業務結果；不回寫舊 block。
- 討論問題：同一 Qualification 同時收到兩個 external event ID 不同的 ENTRY 嘗試時，是否可以兩筆都成功，以及失敗的嘗試是否仍須保存。
- 初始主張：這是兩次真實辨識嘗試，不是 D18 的網路重送；最多一筆改變 Presence，但兩筆都應留下 Event。
- 關鍵挑戰：若兩筆都成功會重複完成同一狀態轉移；若只保存成功事件，則無法解釋第二次掃描及系統如何處理競爭。
- 使用者選擇：接受一筆成功、另一筆拒絕且兩筆都保存。
- 決策過程：以 Presence 的單次轉移為一致性不變條件，同時以不可變拒絕 Event 保留每個已驗證、格式合法的新嘗試。
- 結論：
  1. 不同 external event ID 的兩筆 ENTRY 都是新的業務嘗試，不適用 D18 的回放。
  2. 同一 Qualification 最多一筆完成 `NOT_ENTERED → INSIDE` 並得到 `ENTRY_GRANTED`。
  3. 另一筆依最新 Presence 得到 `ALREADY_INSIDE`，不得再次改變狀態。
  4. 成功與拒絕兩筆 Access Event 都必須保存。
  5. QR 與 Face 同時 ENTRY、兩筆 QR 同時 ENTRY 或兩筆 Face 同時 ENTRY 均適用相同規則。
- 主張變化：`兩個請求各自判斷` → `只允許單次狀態轉移` → `輸家仍作為 ALREADY_INSIDE Event 保存`。
- 適用邊界：本結論不指定 transaction、conditional update、鎖或重試實作；只要求對外結果與持久化紀錄一致。
- 待處理問題：並行 EXIT 時，Face Mapping 在成功離場後釋放，輸家的 reason code 及可追查性需另題確認。
- 依據來源：使用者於本輪明確接受；D03、D09、D17、D18。

### D20｜不同辨識事件的並行 EXIT

- 討論時間：2026-09-15 16:40:53 +08:00
- 狀態：當時結論已確認；一致性實作留待第二階段
- 與既有結論的關係：補充 D07、D18 與 D19，確定 Face Mapping 釋放對並行 EXIT 的可觀察結果；不回寫舊 block。
- 討論問題：同一 `INSIDE` Qualification 幾乎同時收到 QR 與 Face EXIT 時，哪一筆改變 Presence，以及 Face Mapping 釋放後另一筆應得到什麼結果。
- 初始主張：最多一筆完成 `INSIDE → EXITED`；後處理的事件重新查看最新狀態與映射，再形成拒絕事件。
- 關鍵挑戰：QR token 持續能對應舊 Qualification，但 Face Mapping 在成功 EXIT 後會釋放，兩種媒介的輸家 reason code 因而不完全對稱。
- 使用者選擇：接受媒介結果不對稱，以換取較簡單的 Face Mapping 生命週期。
- 決策過程：不為了統一 reason code 而保留終態 Face Mapping 歷史；維持 D07 的 subject 可重用性，並將每個不同事件按最新映射及 Presence 保存成可解釋結果。
- 結論：
  1. 同一 Qualification 的不同 EXIT 事件最多一筆完成 `INSIDE → EXITED` 並得到 `EXIT_RECORDED`。
  2. 成功 EXIT 後立即釋放 Face Mapping，讓 subject 可綁到未來的新 Qualification。
  3. Face 先成功時，後處理的 QR 仍能映射舊 Qualification，得到 `ALREADY_EXITED`。
  4. QR 先成功時，後處理的 Face 因 Mapping 已釋放，得到 `FACE_SUBJECT_NOT_MAPPED`。
  5. 成功與拒絕兩筆不同 Access Event 都保存，Presence 只改變一次。
- 主張變化：`並行 EXIT 輸家統一為已離場` → `Face Mapping 已在終態釋放` → `接受依媒介產生不同拒絕原因`。
- 適用邊界：本結論不保留終態 Face Mapping 歷史，也不處理 subject 已快速重綁至新 Qualification 後的延遲舊事件；後者若成為需求須另開議題。
- 待處理問題：實作必須證明並行請求最多一次狀態轉移，並確認每筆業務嘗試的 Event 建立邊界。
- 依據來源：使用者於本輪明確接受；D03、D07、D18、D19。

### D21｜Access Event 與技術錯誤的分界

- 討論時間：2026-09-15 16:45:32 +08:00
- 狀態：當時結論已確認；保存失敗契約尚待討論
- 與既有結論的關係：補充 D09、D10、D18–D20，確定哪些輸入屬於可稽核的業務通行嘗試；不回寫舊 block。
- 討論問題：所有進入辨識 API 的請求是否都建立 Access Event，或應先區分可信的通行嘗試與 protocol／security error。
- 初始主張：通過 Source 認證且 event envelope 格式合法的新嘗試，不論允許或拒絕都保存；尚未形成可信業務輸入的錯誤只寫技術或安全紀錄。
- 關鍵挑戰：若認證失敗與格式垃圾也進入 Access Event，業務事件會混入無法識別來源或無法判讀內容的流量；若拒絕通行完全不保存，又失去稽核價值。
- 使用者選擇：接受以 Source 認證及格式合法性劃分業務 Event。
- 決策過程：先建立可信的 Source 與輸入 envelope 邊界，再執行 Qualification 映射及通行規則；因此業務拒絕可稽核，protocol／security error 則保持在不同紀錄管道。
- 結論：
  1. 通過 Source 認證、格式合法且非冪等衝突的每個新通行嘗試，都建立 Access Event。
  2. Access Event 涵蓋允許與拒絕，包括無效 QR、`UNKNOWN` Face、未映射 Face、Source 停用、資格過早／過期／撤銷及狀態不符。
  3. Source 認證失敗、event envelope 格式錯誤及相同冪等鍵不同內容的 conflict，不建立 Access Event，只寫安全或技術紀錄。
  4. Access Event 不保存原始 QR token、Source 機器憑證或完整 external subject ID。
- 主張變化：`所有 API 請求都可能形成事件` → `先辨識可信業務輸入` → `業務允許／拒絕進 Event，協定與認證錯誤分流`。
- 適用邊界：本結論不指定 log library、欄位遮罩、保存期限或 HTTP status；這些項目需後續分別確認。
- 待處理問題：Access Event 或必要 Presence 轉移保存失敗時，API 是否可以回覆通行成功。
- 依據來源：使用者於本輪明確接受；D09、D10、D18、D19、D20；K1 的事件邊界草稿。

### D22｜Event 與 Presence 完整保存後才回覆

- 討論時間：2026-09-15 16:47:23 +08:00
- 狀態：當時結論已確認；一致性機制留待第二階段
- 與既有結論的關係：補充 D10、D17、D19–D21，確定通行回應與持久化結果的業務契約；不回寫舊 block。
- 討論問題：規則已算出允許或拒絕，但 Access Event 或必要 Presence 轉移保存失敗時，PassHub 是否仍可回傳業務結果。
- 初始主張：資料沒有完整保存就不能宣稱已完成通行決策；特別是不能讓呼叫端依未持久化的 `ALLOW` 模擬開門。
- 關鍵挑戰：若 Event 已保存但 Presence 沒有更新，或 Presence 已更新卻沒有 Event，查詢、重送與稽核會互相矛盾；拒絕事件未保存時也不符合 D21 的可追查契約。
- 使用者選擇：接受保存失敗一律 fail closed。
- 決策過程：把 Access Event 與必要 Presence 轉移視為一次業務決策的完整保存結果；具體原子性方法延後，但任何實作都不得暴露部分成功。
- 結論：
  1. ENTRY／EXIT 成功時，Access Event 與必要 Presence 轉移都成功保存後，才能回傳 `ALLOW`／成功結果。
  2. Event 與 Presence 不得只保存其中一方，也不得向呼叫端暴露部分成功。
  3. 拒絕通行雖不改變 Presence，仍須先成功保存拒絕 Event，才回覆對應的業務拒絕。
  4. 任何必要保存失敗都回傳系統錯誤，不回傳 `ALLOW`，也不假裝已完成可稽核的拒絕。
- 主張變化：`先計算結果即可回覆` → `回覆可能與資料庫狀態矛盾` → `完整持久化後回覆，否則 fail closed`。
- 適用邊界：本結論不預先指定 MongoDB transaction、條件更新、session 或 retry；第二階段必須以整合測試證明契約。
- 待處理問題：資料庫暫時錯誤時是否由 Source 使用新事件 ID 重試，或以原冪等鍵重送，需在 API 契約階段細化。
- 依據來源：使用者於本輪明確接受；D10、D17、D19、D20、D21。

### D23｜三類最小營運查詢

- 討論時間：2026-09-15 16:50:10 +08:00
- 狀態：當時結論已確認；回傳欄位尚待討論
- 與既有結論的關係：具體化 D03、D10 與 D11 的唯讀能力，並移除 D10 已否決的 Delivery 查詢；不回寫舊 block。
- 討論問題：求職 Demo 需要哪些營運查詢，才能驗證 Qualification、Presence 與 Event 閉環，又不擴張成 Dashboard 或報表系統。
- 初始主張：Operator 與 Viewer 共用三類分頁查詢，角色差異只在 Operator 另有 Qualification 寫入能力。
- 關鍵挑戰：把 Presence 清單稱為真實「在場人員」會違反 D03；增加統計、搜尋、匯出與即時推送則會超出核心流程。
- 使用者選擇：接受三類最小查詢能力。
- 決策過程：查詢只服務 Demo 驗證與單筆問題追查；用 `INSIDE Qualification` 明確表達它是資格狀態，不宣稱真人位置。
- 結論：
  1. Operator 與 Viewer 都可查詢 Qualification 清單及單筆詳情。
  2. 兩者都可查詢狀態為 `INSIDE` 的 Qualification 清單；不得描述為已驗證真人的在場名單。
  3. 兩者都可查詢 Access Event 清單及單筆詳情。
  4. 三類清單都必須分頁並採穩定排序。
  5. v1 不提供統計圖表、Dashboard、CSV／報表匯出、全文搜尋、任意組合進階查詢、WebSocket 或即時推送。
  6. Operator 與 Viewer 的讀取範圍相同；角色差異只在 Operator 可執行 D15、D16 定義的 Qualification 寫入操作。
- 主張變化：`可能需要多類營運查詢` → `只保留驗證核心閉環所需資料` → `三類分頁查詢且不宣稱真人在場`。
- 適用邊界：篩選條件、cursor／offset、排序鍵及 HTTP path 留待第二階段；本結論只鎖定能力種類。
- 待處理問題：三類查詢的可見欄位，以及 QR、Face subject 與機器憑證的遮蔽規則。
- 依據來源：使用者於本輪明確接受；D03、D10、D11、D21、D22。

### D24｜Operator／Viewer 共用去敏查詢欄位

- 討論時間：2026-09-15 16:52:46 +08:00
- 狀態：當時結論已確認；資料保存期限尚待討論
- 與既有結論的關係：補充 D04–D06、D11、D21 與 D23，確定三類查詢及日誌的資料揭露上限；不回寫舊 block。
- 討論問題：Operator 是否需要比 Viewer 看到更多 Face Mapping 資料，以及 Qualification、Event 與日誌可否回傳 credential 或完整外部身分。
- 初始主張：兩種人員角色使用相同的安全讀取欄位；Operator 需要更換 Face Mapping 時直接提交新值，不查回舊值。
- 關鍵挑戰：QR token 與 Source credential 可直接用於提交請求；完整 external subject ID 雖不是 PassHub credential，仍沒有必要出現在一般營運查詢或日誌。
- 使用者選擇：接受相同讀取欄位及秘密／外部身分遮蔽。
- 決策過程：以最小揭露滿足 Demo 查核；保留可解釋的 Qualification、狀態及 Event metadata，移除執行通行或還原外部身分所不需要的值。
- 結論：
  1. Qualification 查詢可回傳 ID、顯示名稱、有效區間、撤銷／逾期／Presence 狀態、Face 是否綁定，以及建立、修改、撤銷時間與撤銷原因。
  2. Access Event 查詢可回傳 decision event ID、Source ID、固定方向、QR／Face 媒介、outcome、reason code、伺服器接收時間、可安全映射時的 Qualification ID，以及是否發生狀態轉移。
  3. Operator 與 Viewer 使用相同讀取欄位；Operator 不因具寫入權限而取得更多 credential 或完整 Face subject。
  4. 所有後續查詢及日誌不得出現原始 QR token、Source 機器憑證或完整 `externalSubjectId`。
  5. Operator 更換 Face Mapping 時直接提交新值，不提供舊值查回。
- 主張變化：`Operator 可能需要完整 Face ID` → `修改不等於必須查回` → `兩角色共用最小去敏讀取模型`。
- 適用邊界：本結論不決定資料庫是否保存 externalSubjectId 原文或其索引表示；儲存安全策略留待架構階段。
- 待處理問題：資料保存多久、Demo 如何清除，以及是否需要自動去識別化。
- 依據來源：使用者於本輪明確接受；D04、D05、D06、D11、D21、D23。

### D25｜公開共享且可重置的 API sandbox

- 討論時間：2026-09-15 17:01:06 +08:00
- 狀態：當時結論已確認；runtime 與重置策略尚待討論
- 與既有結論的關係：推翻 K1 及先前討論中的「只限本機 Demo」前提，擴充 D11、D23、D24 的展示環境；不回寫舊 block。
- 討論問題：PassHub 是否只供評審在本機啟動，或公開部署 API 讓任何人直接體驗；GitHub 是否能直接承載 Node.js API runtime。
- 使用者修正：希望將作品公開部署，讓其他人能直接使用 API；因為只是求職 Demo，不要求正式個資治理。
- 外部查證：GitHub Pages 是靜態網站託管，可承載 repository、README 或靜態 API 文件，但不提供常駐 Node.js 後端 runtime；實際 API 必須使用另一個可執行服務的公開環境。
- 決策過程：將作品定位改為公開、共享、可丟棄且可隨時重置的 sandbox；不因公開展示加入租戶、個人帳號或正式 SLA，並保留 D24 的最小資料揭露。
- 結論：
  1. GitHub 保存公開 repository、README 與 API 操作文件；PassHub API 部署到另一個公開 runtime，實際平台留待第二階段。
  2. 所有體驗者共用預置 Operator、Viewer 與 Recognition Source Demo 憑證；不提供註冊、個人帳號或使用者資料隔離。
  3. 公開資料是共享且可丟棄的 Demo 資料，可能被其他體驗者讀取、修改或隨時清除；不承諾持久性、隔離性、可用性或 SLA。
  4. README 必須要求只輸入虛構資料，並明示不要提交真實姓名、個資、秘密或正式第三方識別碼；系統不宣稱能判斷輸入是否真實。
  5. 不建立正式個資生命週期、隱私後台或使用者刪除 API。
  6. D24 持續適用：一般查詢與日誌不得揭露原始 QR、完整 Face subject 或 Source credential。
  7. 為了實際操作而公開在文件中的 Demo credential 是刻意公開的測試值，必須與部署、資料庫及維護者秘密完全分離，也不得宣稱具有正式設備身分保證。
- 主張變化：`只提供本機 Docker Demo` → `希望任何人直接體驗 API` → `公開 GitHub 作品＋外部 API runtime＋共享可丟棄 sandbox`。
- 適用邊界：公開展示不等於正式營運；本結論不選 hosting vendor、網域、TLS、secret manager、限流套件或監控服務。
- 待處理問題：共享資料採何種重置週期、是否需要自動清理，以及公開寫入的最低頻率與資料量限制。
- 依據來源：使用者於本輪明確接受；D11、D23、D24；[GitHub Pages 官方說明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)。

### D26｜公開 sandbox 每日自動重置

- 討論時間：2026-09-15 17:05:04 +08:00
- 狀態：當時結論已確認；重置實作與公平使用限制尚待討論
- 與既有結論的關係：補充 D25 的共享可丟棄資料生命週期，取代先前只靠本機 volume 重建的方向；不回寫舊 block。
- 討論問題：公開共享 sandbox 的 Qualification、Presence 與 Access Event 是否永久累積，以及如何避免任何人透過公開介面任意重置他人的操作。
- 初始主張：每日固定自動清除體驗資料並恢復 canonical seed；另外提供維護者專用的非公開手動重置方式。
- 關鍵挑戰：永不清理會使清單與資料庫持續膨脹；公開 reset API 則會讓任何人中斷其他體驗者；自動重置本身也可能使當下請求失敗。
- 使用者選擇：接受每日自動重置。
- 決策過程：將重置明確定位為求職 sandbox 維護，而非正式產品的個資保存政策；固定 Demo credential 不跟著更換，讓公開操作範例保持可用。
- 結論：
  1. 公開環境每天固定一次刪除體驗者建立的 Qualification、Presence 與 Access Event。
  2. 重置後恢復預置 Operator、Viewer、ENTRY Source 與 EXIT Source；公開 Demo credential 保持不變。
  3. 維護者另有非公開手動重置命令；v1 不提供公開 reset API。
  4. README 必須揭露固定重置時間，並說明重置期間請求可能失敗、資料不具持久性且可重新操作。
  5. 本機環境仍可透過刪除 volume 與重跑 seed 完整重建，但那是開發操作，不是公開 API 能力。
- 主張變化：`資料留到使用者自行清除` → `公開共享環境會持續累積` → `每日自動重置＋維護者手動重置`。
- 適用邊界：不提供備份、還原單筆資料、使用者匯出、刪除申請或 SLA；重置排程與互斥方式留待架構階段。
- 待處理問題：公開請求的頻率、payload 與總資料量限制，以及重置與進行中請求的一致性處理。
- 依據來源：使用者於本輪明確接受；D23、D24、D25。

### D27｜公開 sandbox 的最低公平使用限制

- 討論時間：2026-09-15 17:06:23 +08:00
- 狀態：當時結論已確認；精確數值與實作留待第二階段
- 與既有結論的關係：補充 D21、D23、D25 與 D26，限制公開共享寫入對服務與部署額度的影響；不回寫舊 block。
- 討論問題：公開 sandbox 是否需要最小限度的請求及資料量限制，以及超限請求是否算成業務通行事件。
- 初始主張：限制短時間請求數、JSON body 大小及單頁回傳筆數；不引入個人帳號、CAPTCHA 或完整風控產品。
- 關鍵挑戰：公開固定憑證可被自動化濫用，只靠每日重置仍可能在重置前耗盡資源；但建立使用者級配額與管理後台又超出兩天作品範圍。
- 使用者選擇：接受最小公平使用限制，精確數值延後決定。
- 決策過程：把限流與大小上限視為公開 Demo 的營運護欄，不將其建模成 Access Event 或新的產品角色；實際 enforcement 可由應用程式或部署環境完成。
- 結論：
  1. 公開 sandbox 必須限制單一來源在短時間內的請求數量。
  2. JSON request body 必須有固定大小上限，所有清單也必須有單頁筆數上限。
  3. 超過頻率、body 或分頁限制的請求直接拒絕，不建立 Access Event。
  4. v1 不加入 CAPTCHA、每人 API key、付費方案、封鎖名單或完整風控後台。
  5. 精確門檻及使用套件由第二階段決定，並允許以部署設定調整。
- 主張變化：`每日重置可能足夠` → `公開寫入仍可在重置前耗盡資源` → `加入最小可設定護欄，不建立風控產品`。
- 適用邊界：限流不能證明正式抗濫用或阻擋分散式攻擊；README 不得將其宣稱為 production-grade 防護。
- 待處理問題：精確門檻、可信 client IP 來源、反向代理設定及多 instance 一致限流留待架構階段。
- 依據來源：使用者於本輪明確接受；D21、D23、D25、D26。

### D28｜Access Event 的最小篩選與穩定排序

- 討論時間：2026-09-15 17:08:42 +08:00
- 狀態：當時結論已確認；分頁機制與索引留待第二階段
- 與既有結論的關係：補充 D23、D24，限制 Access Event 查詢面並保留單次來訪追查能力；不回寫舊 block。
- 討論問題：Access Event 清單應提供哪些篩選與排序，才能支援 Demo 除錯而不擴張為通用搜尋系統。
- 初始主張：只保留 Qualification、結果及原因三種高價值篩選；方向、媒介與 Source 可見但不提供篩選。
- 關鍵挑戰：v1 只有固定 ENTRY／EXIT Source，加入所有欄位及任意組合查詢會增加 contract、索引與測試成本，卻不明顯改善核心展示。
- 使用者選擇：接受三種固定篩選及穩定時間排序。
- 決策過程：優先支援「追查某張 Qualification」、「檢視允許／拒絕」及「檢視特定 reason code」；其餘欄位只作為結果資訊。
- 結論：
  1. Access Event 清單只支援 `qualificationId`、`outcome` 與 `reasonCode` 三種固定篩選。
  2. Source、方向與 QR／Face 媒介仍在結果中顯示，但 v1 不提供對應篩選。
  3. 清單固定依伺服器接收時間由新到舊排序；時間相同時以 Event ID 作穩定 tie-breaker。
  4. v1 不提供全文搜尋、任意欄位查詢或使用者自訂排序。
- 主張變化：`可依多種事件欄位篩選` → `固定 Source 使部分篩選價值有限` → `只保留追查、結果與原因三種篩選`。
- 適用邊界：篩選是否可組合、cursor 編碼、最大頁數、索引與 explain 證據留待架構階段。
- 待處理問題：Qualification 清單是否需要狀態／效期篩選，以及公開 Demo 的固定操作流程。
- 依據來源：使用者於本輪明確接受；D23、D24、D27。

### D29｜Qualification 清單不提供篩選

- 討論時間：2026-09-15 17:11:36 +08:00
- 狀態：當時結論已確認；分頁機制留待第二階段
- 與既有結論的關係：補充 D23、D26 與 D28，進一步縮小營運查詢面；不回寫舊 block。
- 討論問題：Qualification 清單是否需要名稱、時間、撤銷、逾期或 Presence 篩選。
- 初始主張：每日重置使資料量有限；單筆詳情、獨立 `INSIDE` 清單及 Event 篩選已足以完成展示與追查。
- 關鍵挑戰：增加多種 Qualification 篩選會擴大 query contract、索引與驗證矩陣，但不會補足新的核心流程能力。
- 使用者選擇：接受 Qualification 清單不提供篩選。
- 決策過程：將清單用途限定為瀏覽近期建立的 Qualification；精確追查依 ID detail，狀態展示則由獨立 `INSIDE Qualification` 清單負責。
- 結論：
  1. Qualification 清單不提供名稱搜尋、有效時間、撤銷、逾期或 Presence 篩選。
  2. 清單固定依建立時間由新到舊排序；時間相同時以 Qualification ID 作穩定 tie-breaker。
  3. 清單必須分頁，並保留以已知 ID 查單筆詳情的能力。
  4. `INSIDE` Qualification 仍使用 D23 的獨立清單，不由一般 Qualification filter 取代。
- 主張變化：`可能加入狀態與時間篩選` → `每日重置且已有專用查詢` → `只保留瀏覽、detail 與 INSIDE 清單`。
- 適用邊界：page size、cursor／offset、索引與 OpenAPI 參數留待第二階段。
- 待處理問題：公開 Demo 的固定操作流程及其對 seed、公開 credential 與每日重置的依賴。
- 依據來源：使用者於本輪明確接受；D23、D26、D28。

### D30｜公開 API Demo 的固定主流程

- 討論時間：2026-09-15 17:12:56 +08:00
- 狀態：當時結論已確認；OpenAPI 與部署方式留待第二階段
- 與既有結論的關係：補充 D04、D11、D23、D25、D26，將已確認能力串成公開可操作的主要展示流程；不回寫舊 block。
- 討論問題：公開使用者如何在沒有產品型前端的情況下，完整體驗跨媒介通行與查詢閉環。
- 初始主張：以互動式 OpenAPI 及可複製 curl 範例完成 Operator 建立、QR ENTRY、Viewer 查詢、Face EXIT 與終態查證。
- 關鍵挑戰：若只提供零散 endpoint，評審難以確認整體流程；若為此製作完整 UI，又會消耗兩天時限並擴張非必要前端範圍。
- 使用者選擇：接受固定公開 API 主流程，不製作產品型前端。
- 決策過程：讓 README 公開的 Demo credential、一次顯示 QR、使用者自行輸入的虛構 Face ID 及三類查詢形成單一路徑；反向媒介與異常案例由測試及補充範例證明。
- 結論：
  1. README 提供公開 Operator、Viewer、ENTRY Source 與 EXIT Source 的 Demo credential 及操作入口。
  2. 主流程固定為 Operator 登入並建立立即有效且含虛構 Face ID 的 Qualification，保存建立回應中只顯示一次的 QR token。
  3. ENTRY Source 以 QR 完成 `ENTRY_GRANTED`；Viewer 查 Qualification、`INSIDE` 清單及 Access Event。
  4. EXIT Source 再以同一 Face ID 完成 `EXIT_RECORDED`；最後查證 Qualification 為 `EXITED` 且兩筆 Event 存在。
  5. 公開展示只提供互動式 OpenAPI 文件與可複製 curl 範例，不製作產品型前端。
  6. Face ENTRY→QR EXIT、拒絕、重送及並行情境由自動化測試與補充 API 範例證明，不增加第二套 UI 流程。
- 主張變化：`公開 API 但操作路徑未定` → `需要可理解的完整閉環` → `OpenAPI／curl 的單一跨媒介主流程`。
- 適用邊界：Swagger UI 是否由 API 或靜態頁承載、登入 token 形式、curl 腳本位置與線上 URL 留待第二階段。
- 待處理問題：共享環境中的 Face ID 應提示使用唯一虛構值，避免與其他使用者同時綁定衝突。
- 依據來源：使用者於本輪明確接受；D04、D11、D23、D25、D26、D29。

### D31｜Face subject 重綁後不處理延遲舊事件

- 討論時間：2026-09-15 17:17:17 +08:00
- 狀態：當時結論已確認；列為公開 Demo 已知限制
- 與既有結論的關係：補充 D07、D18、D20 與 D30，限制 Face Mapping 重用後的事件時間語意；不回寫舊 block。
- 討論問題：Face subject 已從終態 Qualification 釋放並綁到新 Qualification 後，外部來源才以新的 external event ID 傳入舊辨識結果時，PassHub 是否需要找回歷史 Mapping。
- 初始主張：v1 不接受 client 提供可改變決策的 occurredAt，也不保留歷史 Mapping；新事件只依伺服器接收當下的現行 Mapping 處理。
- 關鍵挑戰：舊結果若誤用新 external event ID，PassHub 無法與真正的新辨識區分，可能把它套用到新 Qualification；解決需要可信事件時間、歷史 Mapping 或其他關聯資訊。
- 使用者選擇：接受不處理此情境，將即時提交及 event ID 正確重用視為 Source 責任。
- 決策過程：保留 D18 的原 event ID 重送保護，但不為違反 Source contract 的延遲新事件建立另一套歷史解析流程。
- 結論：
  1. Recognition Source 必須即時提交辨識結果，不支援離線累積或延遲補送。
  2. 因網路問題重送時必須沿用原 `externalEventId`，依 D18 回放首次結果。
  3. 使用新 external event ID 的請求一律視為新事件，依伺服器接收當下的現行 Face Mapping 處理。
  4. PassHub 不接受可改變業務判斷時間的 client `occurredAt`，也不保留 Face Mapping 歷史供回溯解析。
  5. 延遲舊結果誤用新 ID 可能作用於新 Qualification，列為已知限制並在 README 說明。
- 主張變化：`Face subject 終態後可立即重用` → `延遲事件可能誤映射` → `不增加歷史模型，以 Source 即時／重送契約限制`。
- 適用邊界：這不是正式離線門禁或可靠訊息整合契約；若未來要求離線設備，必須重新設計事件時間、簽章、Mapping 版本與衝突處理。
- 待處理問題：Source contract 在 OpenAPI 與 Demo 文件中的警語及測試案例，留待第二階段。
- 依據來源：使用者於本輪明確接受；D07、D18、D20、D30。

### D32｜ENTRY／EXIT 的固定 reason-code 優先序

- 討論時間：2026-09-15 17:18:51 +08:00
- 狀態：當時結論已確認；結果欄位命名尚待討論
- 與既有結論的關係：補充 D03、D09、D13、D16、D18–D22，確定多個條件同時成立時的單一業務結果；不回寫舊 block。
- 討論問題：同一通行嘗試同時符合狀態、撤銷或時間等多個拒絕條件時，PassHub 應回傳哪一個 reason code。
- 初始主張：每筆新通行嘗試只回傳一個 reason code，並以固定檢查順序取得第一個不通過的業務條件。
- 關鍵挑戰：若沒有優先序，相同資料可能因程式重構或不同 handler 順序而得到不同 reason code，導致 API、Event 與測試不一致。
- 使用者選擇：接受 ENTRY／EXIT 的固定優先順序。
- 決策過程：protocol／security 與冪等處理先於業務判斷；新業務事件先確認 Source 可用及輸入映射，再檢查 Qualification 狀態與 ENTRY 時間。EXIT 對已 `INSIDE` 的 Qualification 不重新檢查效期。
- 結論：
  1. Source 認證、event envelope、冪等回放／衝突在業務 reason code 之前處理，不適用下列通行優先序。
  2. 新 ENTRY 的優先序為：`SOURCE_INACTIVE` → 媒介映射錯誤 → `QUALIFICATION_REVOKED` → `ALREADY_INSIDE` → `QUALIFICATION_ALREADY_USED` → `QUALIFICATION_NOT_YET_VALID` → `QUALIFICATION_EXPIRED` → `ENTRY_GRANTED`。
  3. 媒介映射錯誤依輸入互斥地形成 `INVALID_QR_CREDENTIAL`、`FACE_UNKNOWN` 或 `FACE_SUBJECT_NOT_MAPPED`。
  4. 新 EXIT 的優先序為：`SOURCE_INACTIVE` → 媒介映射錯誤 → `NOT_INSIDE` → `ALREADY_EXITED` → `EXIT_RECORDED`。
  5. `INSIDE` Qualification 執行 EXIT 時不檢查有效時間，延續 D13 的逾時離場規則。
  6. 每筆新 Access Event 只保存一個最終 reason code。
- 主張變化：`可能回報所有不符合條件` → `多原因使 contract 不穩定` → `固定順序且只回第一個業務結果`。
- 適用邊界：實作可以拆成 policy steps，但不得改變對外優先序；HTTP status 與 error response schema 留待第二階段。
- 待處理問題：API decision 與 Access Event outcome 應使用 `ALLOW/DENY` 還是 `ACCEPTED/REJECTED`。
- 依據來源：使用者於本輪明確接受；D03、D09、D13、D16、D18–D22。

### D33｜統一 API 與 Event 的 outcome 術語

- 討論時間：2026-09-15 17:24:15 +08:00
- 狀態：當時結論已確認；response schema 留待第二階段
- 與既有結論的關係：修正 D10 暫用的 `ALLOW`／`DENY`，並完成 D21、D22、D32 的結果分類；不回寫舊 block。
- 討論問題：API response 使用 `ALLOW`／`DENY`、Access Event 使用 `ACCEPTED`／`REJECTED` 是否有必要，或應統一成一套業務詞彙。
- 初始主張：API 與 Event 都使用 `ACCEPTED`／`REJECTED` outcome，並以 reason code 表示 ENTRY、EXIT 或拒絕原因。
- 關鍵挑戰：兩套詞彙沒有增加資訊，反而可能在 mapping、測試與文件中出現 `ALLOW + REJECTED` 等矛盾組合。
- 使用者選擇：接受單一 outcome 詞彙，移除 `ALLOW`／`DENY`。
- 決策過程：將通行業務結果統一為 outcome＋reason code；尚未形成 Access Event 的認證、格式、冪等衝突與系統失敗維持獨立 error response。
- 結論：
  1. 新 Access Event 與其 API response 都使用 `outcome: ACCEPTED | REJECTED`。
  2. `ACCEPTED + ENTRY_GRANTED` 表示成功 ENTRY；`ACCEPTED + EXIT_RECORDED` 表示成功 EXIT。
  3. 其他 D32 reason code 與 `REJECTED` 搭配。
  4. Source 認證失敗、格式錯誤、`IDEMPOTENCY_CONFLICT` 及持久化失敗不建立通行 outcome，使用獨立 error code／response。
  5. 後續業務文件、OpenAPI、測試與 README 不再以 `ALLOW`／`DENY` 表示 PassHub 通行結果。
- 主張變化：`response 用 ALLOW/DENY、Event 用 ACCEPTED/REJECTED` → `兩套詞彙可能漂移` → `統一 outcome，錯誤另行分類`。
- 適用邊界：HTTP status、error envelope、enum 命名位置及 TypeScript type 留待第二階段。
- 待處理問題：最終業務文件必須搜尋並移除殘留 `ALLOW`／`DENY`，同時保留自然語言中的「允許／拒絕」描述。
- 依據來源：使用者於本輪明確接受；D10、D21、D22、D32。

### D34｜PassHub v1 最終明確排除清單

- 討論時間：2026-09-15 17:52:35 +08:00
- 狀態：當時結論已確認；整體業務邊界尚待最後驗收
- 與既有結論的關係：彙整並鎖定 D01–D33 的範圍縮限，防止第二階段以工程需求名義重新加入已刪除的產品能力；不回寫舊 block。
- 討論問題：PassHub v1 還有哪些能力必須明確排除，才能維持兩天求職作品的邊界並避免超過參考系統範圍。
- 初始主張：只保留已確認的 Qualification、QR／Mock Face、固定 Source、Presence、Access Event、最小查詢及公開 sandbox；其餘管理、影像、硬體、整合與呈現能力一律排除。
- 關鍵挑戰：若排除項目沒有集中鎖定，架構規劃很容易為了展示技術而重新加入 Admin、outbox、真實辨識、前端或報表，導致兩天範圍失控。
- 使用者選擇：接受完整排除清單。
- 決策過程：依角色、身分資料、辨識／硬體、下游整合、呈現及正式營運六類檢查；只保留 D25–D27 所需的公開 sandbox 重置與最低護欄。
- 結論：
  1. 排除多租戶、多地點、組織架構、永久 Visitor／Person 主檔及多次拜訪關聯。
  2. 排除訪客自行申請、員工審核、訪客狀態頁、Admin，以及帳號／角色、Source、Access Group 管理。
  3. 排除 QR 補發、救援碼、資格重新啟用、人工 Presence 修正及 Card／NFC 等第三種通行媒介。
  4. 排除真實人臉 API、enrollment、照片、特徵、confidence、活體辨識、RTSP、影像處理、相機管理與實體掃碼。
  5. 排除實體門鎖、relay、Wiegand、I/O、離線設備同步、Webhook、下游 HTTP 動作、outbox、背景投遞、重試及規則引擎。
  6. 排除 Email、SMS、其他通知、產品型前端、Dashboard、統計、報表、CSV、WebSocket／SSE、全文搜尋及進階查詢。
  7. 排除正式個資治理、使用者資料隔離、可用性承諾與 SLA；公開 Demo 只保留每日重置、假資料警語及最低限流。
- 主張變化：`逐項刪除低價值能力` → `需要防止架構階段重新擴張` → `集中鎖定最終排除清單`。
- 適用邊界：OpenAPI、Docker、CI、自動化測試、結構化日誌、索引與一致性驗證是完成既有能力的工程證據，不因本排除清單而禁止；但不得藉此新增業務模組。
- 待處理問題：以完整產品敘述進行最後驗收；通過後同步改寫 K1 的所有章節、驗收情境與作品證據。
- 依據來源：使用者於本輪明確接受；D01–D33。

### D35｜PassHub v1 業務邊界整體驗收

- 討論時間：2026-09-15 17:56:46 +08:00
- 狀態：整體結論已確認；K1 尚待同步
- 與既有結論的關係：彙整並確認 D01–D34，正式結束第一階段逐題討論；不回寫舊 block。
- 討論問題：D01–D34 是否已形成一個完整、可理解、可在兩天作品時限內實現的 PassHub v1，並可作為 K1 的唯一業務依據。
- 最終產品敘述：PassHub v1 是公開共享、每日重置的單地點訪客通行 API。Operator 為一次來訪建立限時 Qualification，取得只顯示一次的 QR，並可選擇預綁模擬外部 Face subject；固定 ENTRY／EXIT Source 以 QR 或 Face 驅動 `NOT_ENTERED → INSIDE → EXITED`，系統形成 `ACCEPTED／REJECTED`、保存 Access Event，並提供最小查詢。
- 已揭露限制：Presence 只是資格使用狀態；QR 與 Face 不做雙重核對；不處理真實辨識、硬體、離線事件或下游動作；公開 Demo 共用 credential 與資料，且不具正式資料治理或 SLA。
- 使用者確認：上述產品敘述就是預期專案，業務邊界可正式收斂並開始同步 K1。
- 決策過程：以最終產品敘述重新檢查核心輸入、狀態、輸出、角色、查詢、公開展示及排除項目，確認沒有要求新增未討論的業務模組。
- 結論：
  1. D01–D34 共同構成 PassHub v1 已確認的業務邊界。
  2. K1 應全面依本紀錄改寫，不能只修改摘要或保留與新決議衝突的驗收／作品證據。
  3. 本次授權只包含業務規格文件同步與文字驗證，不包含 API、資料模型、框架、部署平台或程式實作。
  4. K1 同步完成並驗證後必須停止，再開始第二階段架構與執行方案討論。
- 主張變化：`逐題收斂個別能力` → `以完整產品敘述檢查閉環` → `使用者確認第一階段正式完成`。
- 適用邊界：後續若改變任何 Dxx 結論，必須另開新 block，重新評估 K1 與驗收情境，不得靜默修改既有知識。
- 待處理問題：完成 K1 同步、差異檢查及規則一致性驗證；通過後停止在第一階段 gate。
- 依據來源：使用者於本輪明確確認；D01–D34。

## 第二階段：架構前提與自動辯論紀錄

本節記錄業務文件同步後的架構討論。D36、D37 保留使用者已接受的方向；D38、D40、D41 保存角色攻防及仲裁暫定判斷，不表示使用者已採用整套架構。D39 是使用者對評估前提的明確修正。本次只保存紀錄，沒有執行舊版移出、程式重寫或新增架構文件。

### D36｜保留專案與規格，舊版另存後乾淨重寫

- 討論時間：2026-09-16 17:14:48 +08:00（回溯追加建檔，非原始回合時間）
- 狀態：乾淨重寫方向已獲使用者接受；執行細節尚未定稿，尚未實作
- 與既有結論的關係：D35 的業務規格同步完成後，開始第二階段；不推翻 D01–D35 的產品能力及排除項目。
- 討論問題：新業務是否應在舊 PassHub 程式上漸進改造，或保留專案身分後乾淨重寫。
- 初始主張：沿用同一個 PassHub repository，但新版本只保留 TypeScript 後端，不保留產品型前端。
- 關鍵比較：舊版以 Visitor／Appointment／Pass、申請審批及相機掃碼為中心；新規格則是 Qualification、固定 Source、Mock Face、冪等及不可變 Access Event。新舊業務模型差異大，不能把舊 controller 換成 TypeScript 就當成新架構。
- 使用者選擇：接受舊程式先保存為公開 repository 外的不公開備份，再乾淨重寫；保留 docs、專案名稱與 Git repository。
- 決策過程：把舊程式視為參考及反例，不作為新業務實作基底；新實作須由已確認規格驅動，而非由舊目錄或依賴決定新功能。
- 結論：
  1. 保留 PassHub 專案身分、Git 與已確認文件。
  2. 舊版另存於公開 repository 外；備份與移出尚未執行。
  3. 新版為 TypeScript 後端專案，不帶入舊 React 前端、申請審批、通知、PDF、照片或相機掃碼能力。
- 主張變化：`考慮沿舊程式改造` → `保留規格與專案身分，實作乾淨重寫`。
- 適用邊界：本項只確認遷移方向，不指定目錄、package 結構或執行命令；不能據此直接開始移動或刪除資料。
- 待處理問題：備份的精確範圍、目標位置及乾淨重寫的逐關驗證順序。
- 依據來源：[使用者陳述] 已接受方向；[既有討論] 舊版唯讀盤點；[專案參考：A1] 第 10、13 節。

### D37｜接受 NestJS 技術方向，六個頂層模組仍為候選

- 討論時間：2026-09-16 17:14:48 +08:00（回溯追加建檔，非原始回合時間）
- 狀態：技術方向已獲使用者接受；模組切分與完整架構尚未定稿
- 與既有結論的關係：具體化 D36 的後端重寫方向；不改變既有業務契約。
- 討論問題：使用何種框架及應用程式結構，才能形成合理、乾淨且模組化的後端。
- 使用者已接受的方向：NestJS、預設 Express HTTP adapter、strict TypeScript、單一 API process 的 modular monolith。
- 初始候選切分：
  1. `AuthModule`：Operator／Viewer 的人員認證與角色授權；認證格式未定。
  2. `SourcesModule`：機器身分、固定方向與啟用狀態。
  3. `QualificationsModule`：資格生命週期、QR／Face 對應、Presence 與資格查詢。
  4. `RecognitionModule`：Attempt 協定、冪等、通行流程協調、Event 保存與查詢。
  5. `SandboxModule`：預置資料及非公開重置操作；不提供公開管理 API。
  6. `HealthModule`：服務健康與就緒狀態。
- 設計前提：Config、資料庫與觀測屬基礎設施；不為 Presence、Event、QR、Face 或 User／Admin 各建一個獨立業務模組。純業務規則不依賴 NestJS／Express，controller 不直接承擔資料庫與通行判斷。
- 當時候選依賴：Recognition 使用 Qualifications 與 Sources 的能力；Qualifications 不反向呼叫 Recognition。這是待檢驗的切分，不是已確認實作。
- 結論：
  1. NestJS／Express adapter／strict TypeScript 與單體應用方向已接受。
  2. 六模組表只是一個可反駁候選，不代表六個模組同等必要，也不證明是最乾淨的方案。
  3. 不引入微服務、CQRS、EventEmitter 或 message queue；不可藉架構重新加入下游投遞業務。
  4. 先前候選描述中提到 JWT，不構成認證選型確認；JWT、其他 token 與 machine credential 格式均未定。
- 主張變化：`框架與結構待選` → `接受 NestJS 單體方向，但模組邊界交由辯論檢驗`。
- 適用邊界：Express 在此是 NestJS HTTP adapter，不代表使用舊 Express routes／controllers，也不改成 Node.js 原生 HTTP server。
- 待處理問題：六模組是否合理、內部依賴及用例責任；driver、資料模型、API 路徑、測試與部署尚未決定。
- 依據來源：[使用者陳述] 已接受方向；[專案參考：A1] 既有能力與工程證據；[既有框架參考：A4]；[LLM 背景知識] 模組化單體與責任分離。

### D38｜模組可以分開，但完整保存不能被切成各自提交

- 討論時間：2026-09-16 17:14:48 +08:00（回溯追加建檔，非原始回合時間）
- 狀態：自動辯論已完成；仲裁結論暫定，尚未獲使用者採用為完整架構
- 與既有結論的關係：壓測 D37 的 Qualifications／Recognition 切分；D22 的完整保存及 fail-closed 仍是已確認硬性契約。
- 討論問題：資格模組先提交 Presence，辨識模組稍後保存 Event 失敗，是否會使模組切分違反業務一致性。
- 初始主張：六個邏輯模組可以維持單向依賴，分工也能保持清楚。
- 質詢修士的反例：ENTRY 已把 Qualification 改成 `INSIDE`，但 Access Event 保存失敗；API 即使回系統錯誤，查詢仍看見沒有對應事件的成功狀態。
- 捍衛騎士的回應：此反例命中初始架構未說清楚的保存責任；邏輯模組不同不代表可以分別提交。辨識的 application use case 必須協調 Event、必要 Presence 與映射變更的完整保存，資格能力不能先獨立提交部分成功。
- 回應的收縮：不再只以模組表宣稱一致性已解決；六模組可行的前提是明確界定同一次決策的持久化協調責任。暫時錯誤若需要重試，也不能只補寫 Event 而保留失配狀態。
- 仲裁判斷：六模組未被證明不可行，但原始說明不足，必須補上完整操作的所有權及失敗邊界。
- 暫定結論：
  1. 一次決策的 Event、必要 Presence 與映射變更不能形成可觀察的部分成功。
  2. 拒絕結果也須保存拒絕 Event 才回覆；保存失敗仍回系統錯誤，不回通行 outcome。
  3. 跨模組完整保存可以成立，不代表一定要合併模組；反過來，合併模組也不會自動得到原子性。
  4. 具體 MongoDB transaction／條件更新、介面或 session 傳遞仍未鎖定，需以真實整合測試證明契約。
- 主張變化：`六模組看似可直接實作` → `六模組僅在完整保存責任清楚時成立`。
- 適用邊界：反例與防禦是架構推論，不是已執行的故障注入測試；不改寫 D22 的業務要求。
- 待處理問題：Qualifications 與 Recognition 的切分是否有實質資訊隱藏價值，或應歸入同一核心模組。
- 依據來源：[專案參考：A1] 第 7.3、12 節；D17–D22；[LLM 背景知識] 協調保存與失敗邊界；[本輪推論] 跨模組不等於分次提交。

### D39｜架構辯論撤除兩天時限，不以省時替代設計理由

- 討論時間：2026-09-16 17:14:48 +08:00（回溯追加建檔，非原始回合時間）
- 狀態：使用者已明確修正評估前提；業務範圍不因此擴張
- 與既有結論的關係：取代前段以兩天或實作成本支持架構合併的理由；保留 D01–D35 已確認業務與排除項目。
- 討論問題：是否能因兩天內要完成，就判定少模組或合併資格／辨識是更好的架構。
- 原有前提：部分建議曾以有限準備時間支持簡化架構或合併模組。
- 使用者修正：不用管兩天完成；只辯論架構是否合理、模組化、功能乾淨，並要求開始自動辯論。
- 捍衛騎士的回應：接受修正，撤回以速度或時程支持合併的理由；改以責任內聚、資訊隱藏、規則歸屬、依賴方向與可驗證性評估候選。
- 結論：
  1. 本輪架構辯論不得以兩天時限、節省實作時間或趕快投遞作為模組切分的理由。
  2. 不把模組多寡、檔案數量或框架形式等同工程品質。
  3. 時間限制撤除不代表擴張產品；已排除的多據點、影像、硬體、Webhook、產品型 UI 等能力仍不得加入。
- 主張變化：`可能以時程支持合併` → `合併或拆分必須由架構品質本身論證`。
- 適用邊界：只修正架構評估前提，不回寫第一階段歷史，也不推翻已選擇的小作品定位。
- 待處理問題：用相同品質判準比較 Qualifications／Recognition 分開與合併 AccessModule 兩個候選。
- 依據來源：[使用者陳述] 明確撤除兩天判準；[既有討論] 捍衛騎士撤回省時理由。

### D40｜資格與辨識分開，是否真的形成資訊隱藏邊界

- 討論時間：2026-09-16 17:14:48 +08:00（回溯追加建檔，非原始回合時間）
- 狀態：自動辯論已完成；兩個候選均保留，尚未獲使用者定稿
- 與既有結論的關係：承接 D38 的保存責任缺口，並依 D39 排除時程理由；不因共同保存就直接判定必須合併。
- 討論問題：QualificationsModule 與 RecognitionModule 是不同責任，還是把同一個資格的生命週期拆成彼此牽動的兩半。
- 初始主張：六個頂層模組可以形成乾淨的責任切分。
- 異端辯士的立場：資格取得、修改、撤銷及被使用是同一核心流程；Recognition 並不做影像辨識，而時間、Presence、凍結與 Face 釋放又橫跨兩邊，因此它們更適合歸入同一 AccessModule。要求說清楚分開到底隱藏了什麼，而不只是把 service 拆開。
- 捍衛騎士的回應：部分命中。原始表格確實沒有精確區分規則與協議，但兩者可以有不同責任：資格部分唯一擁有生命週期及通行資格規則；辨識部分負責 Attempt 協定、冪等回放／衝突、來源前置順序、完整保存協調及 Event。辨識不得取得快照後自行重算效期／狀態，也不得靠通用 setter 任意改 Presence。
- 回應的收縮：撤回「六個頂層模組是最乾淨方案」的隱含主張；保留其條件式可行性，並正式提出合併候選。
- 合併候選：
  - `AccessModule` 內有資格生命週期及唯一規則來源。
  - 辨識用例處理 Attempt、冪等及完整保存協調。
  - Access Event 作為不可變紀錄與安全查詢能力。
  - 資格管理與辨識各有自己的 HTTP 入口；不收成一個什麼都做的 AccessService。
- 仲裁判斷：拆分若能真正隔離生命週期規則與協議協調，可以乾淨；若兩邊都擁有狀態與映射政策，合併候選較有說服力。共同提交本身不足以裁定哪個架構較好。
- 暫定結論：
  1. Qualifications／Recognition 分開與 AccessModule 合併都仍是候選。
  2. 規則有唯一歸屬，比頂層 Nest module 數量重要。
  3. 合併不得消除內部分工；拆分不得複製規則或透過任意資料操作繞過邊界。
- 主張變化：`預設六模組切分` → `六模組條件式可行；AccessModule 成為另一候選，待壓測內部邊界`。
- 適用邊界：這是候選比較，不是已決定的目錄或 NestJS exports／providers 設定。
- 待處理問題：AccessModule 是否只是把同樣的耦合藏進更大的模組；其內部責任如何實際受到約束。
- 依據來源：[專案參考：A1] 資格、映射、Attempt 與一致性契約；[LLM 背景知識] 內聚與資訊隱藏；[本輪推論] 兩個候選的條件式比較。

### D41｜AccessModule 不能只合併名稱，必須保證完整行為與乾淨依賴

- 討論時間：2026-09-16 17:14:48 +08:00（回溯追加建檔，非原始回合時間）
- 狀態：自動辯論已完成；設計缺口已補上約束，實作證據未取得，尚未獲使用者採用為定稿
- 與既有結論的關係：壓測 D40 的 AccessModule 候選；延續 D22 完整保存與 D07、D20 的 Face 釋放硬性契約。
- 討論問題：同一 Nest module 內仍可能有互相穿透的 service；合併要如何避免成為換名字的大雜燴。
- 質詢修士的反例：Recognition 完成 EXIT，只把 Presence 改為 `EXITED`；QualificationService 才知道離場必須釋放 Face Mapping。若兩者各自操作資料，新 Face Attempt 仍錯誤找到舊資格，subject 也不能綁到下一次來訪。這證明合併資料夾不等於規則內聚。
- 捍衛騎士的回應：部分命中；合併 NestJS module 不足以證明乾淨。保留 AccessModule 候選，但撤回「合併本身就能解決耦合」的說法；必須明列內部行為與依賴約束。
- 防禦提出的內部分工：
  1. 資格規則：唯一負責可修改性、ENTRY／EXIT、狀態轉移與 Face 釋放條件；不操作 HTTP 或 MongoDB。
  2. 資格管理用例：協調建立、修改、撤銷，套用資格規則，不重寫同一份政策。
  3. 辨識用例：處理冪等、身分映射、取得決策及完整保存協調；不私自設定 Presence 或複製資格規則。
  4. 資料存取實作：依完整操作保存狀態、必要映射變更與 Event，落實資料一致性；不自行決定業務上是否可通行。
- 關鍵行為約束：`完成 EXIT` 是包含 Presence 轉移與必要 Face 釋放的完整操作；不能先提供 `setPresence(EXITED)`，再要求呼叫者記得補做映射解除。兩組用例共用規則，但不互相呼叫對方的 Service；事件查詢不必穿過辨識決策流程。
- 依賴方向的澄清：`HTTP 入口 → 用例 → 純業務規則`；資料存取透過用例所需介面接入，由基礎設施實作。純業務規則不反向依賴 NestJS、HTTP、MongoDB 或 repository；不能把執行流程示意誤當成 Domain 必須依賴 Repository 的編譯依賴圖。
- 可檢查但尚未完成的證據：
  1. 生命週期及 Face 釋放條件有唯一政策來源，不需逐 handler 修改同一規則。
  2. 用例不能繞過規則任意改狀態；完整行為不靠呼叫者記得補做。
  3. 依賴檢查禁止純業務規則引入框架或資料庫；工具與精確規則尚未選定。
  4. 真實 MongoDB 整合測試證明 EXIT、Face 釋放與 Event 完整保存，失敗時沒有可觀察的部分成功。
- 仲裁判斷：AccessModule 可以是合理的核心模組，但理由是規則唯一歸屬、清楚用例分工及不可任意拆開的完整操作，不是把程式放在一起。若最終仍是一個通用 AccessService，這個防禦就不成立；原本兩個頂層模組的方案也未被排除。
- 暫定結論：
  1. 合併不等於封裝；必須同時定義可依賴的行為與禁止穿透的內部。
  2. 不為每個小函式或類別強行建立介面；介面放在真正需要隔離的外部操作，避免只增加層數。
  3. 本輪只有架構約束，尚無現有程式達標、整合測試通過或使用者定稿的證據。
- 主張變化：`AccessModule 可避免規則分散` → `只有具備可檢查的內部邊界與完整行為，AccessModule 才成立`。
- 適用邊界：不在本輪決定細部檔名、DTO、資料模型、具體 repository 介面、transaction 或測試工具；反例是推論，不是現有程式缺陷報告。
- 待處理問題：下一個建議攻防是 AuthModule／SourcesModule 是否有不同且必要的資訊隱藏邊界；尚未開始該輪。
- 依據來源：[專案參考：A1] 第 4.5、6.3、7.3、12 節；D07、D20、D22；[LLM 背景知識] 依賴方向及可測試邊界；[本輪推論] EXIT／映射釋放反例與條件式防禦。

## 第二階段知識範圍與前提

以下 A1–A4 是架構場次的保存識別，避免與第一階段 K1–K3 的不同編號用途混淆；不回寫舊來源標記。

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已確認業務規格｜已參考・鎖定；本次完整重讀。採用資格生命週期、Face 釋放、固定 Source、冪等、完整保存、最小查詢及工程驗收契約。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜既有業務討論紀錄｜已參考・鎖定；本次完整重讀原 D01–D35。採用已確認決策、追加格式與歷史不回寫原則。
- A3｜`/home/sean/work/problab_v0510`｜既有工程品質參考｜已參考・鎖定；架構前段已參考，本次保存未重讀。只保留可轉移的責任分離、清楚資料流與驗證原則，不複製模組、業務模型或程式。
- A4｜[NestJS 官方 First steps](https://docs.nestjs.com/first-steps)｜框架基礎參考｜已參考・鎖定；架構前段已查閱，本次未新增外部查證。框架參考不能證明六模組或 AccessModule 是最優方案。
- LLM 背景知識｜開啟｜實際用於內聚、資訊隱藏、單向依賴、用例協調與測試邊界；均不是外部查證或現有實作證據。
- 使用者陳述｜作品定位、已接受的重寫／技術方向，以及撤除兩天架構判準｜屬需求與取捨前提，不假裝是程式查核。
- 本輪推論｜保存失敗反例、模組切分比較與 EXIT／Face 釋放反例｜只支持條件式架構判斷。
- 本次沒有新增、移除或停止來源，也沒有新增 Q 編號的外部查證分支。尚缺的是候選採用決策及後續實作驗證，不應寫成已有測試成果。

## 第二階段交接資訊

- 可安全採用：D01–D35 的小型業務邊界；D36、D37 已接受的乾淨重寫與 NestJS／Express adapter／strict TypeScript 單體方向；D39 撤除兩天架構判準。
- 不可假設：已確認六模組、已確認 AccessModule 合併、已選 JWT／MongoDB driver／transaction／API 路徑／測試框架／部署平台，或程式已開始重寫。
- 下一個明示建議：由異端辯士挑戰 AuthModule 與 SourcesModule 是否應分開，檢驗人員認證與機器來源是否真的隱藏不同責任。這題只被提出，尚未辯論，也沒有結論。
- 仍待收斂：Qualifications／Recognition 的頂層分合、AccessModule 的內部行為邊界、完整保存的技術與介面責任，以及其他候選模組是否必要。
- 後續驗證必須涵蓋：固定 reason-code 優先序、Face 唯一性與釋放、冪等、並行 ENTRY／EXIT、修改／撤銷競爭及 fail-closed；不能只靠各 service 的 mock 測試宣稱一致性。
- 保存完成後停止，不續開下一輪攻防，不修改 business-scope.md、README、履歷、程式或其他文件；也不執行 Git add／commit／push。完整架構及執行方案仍需後續討論確認。

## 第二階段討論續錄：認證邊界與必要保存

本節只保存已發生的討論。D42、D43 是自動辯論暫定判斷，D44 是概念澄清，D45 是公開程式查核及其限制，D46 是使用者對既有業務政策的再確認。授權保存不代表採用候選模組，也不代表開始實作。

### D42｜Auth 與 Sources 的切分不能只靠人員和機器的名稱

- 討論時間：2026-09-17 16:54:16 +08:00（回溯保存時間，非原始回合時間）
- 狀態：自動辯論已完成；責任邊界暫定，頂層模組切分未定稿
- 與既有結論的關係：承接 D37、D41 的 AuthModule／SourcesModule 候選；修正 Auth 只處理人員認證的原始分工，但不回寫舊 block。
- 討論問題：人員認證與機器認證是否足以構成兩個頂層模組，還是只是重複拆出憑證驗證流程。
- 異端辯士的攻擊：不同呼叫者不等於不同資訊隱藏邊界；若兩邊都驗證憑證、產生身分與處理認證錯誤，可能只是重複實作。
- 捍衛騎士的回應：部分命中。撤回「人員和機器不同，所以必須分成兩個模組」；但來源固定方向及啟用狀態不是單純認證。例如憑證正確但停用的 Source，新嘗試仍須留下 `SOURCE_INACTIVE` 拒絕事件，不能直接視為認證失敗；已保存事件重送則應先回放原結果。
- 修正後候選：Auth 可驗證人員或機器憑證並產生可信身分；Sources 擁有來源資料、固定方向及啟用狀態；辨識用例協調冪等與來源狀態的業務檢查。
- 仲裁判斷：有必要區分「你是誰」與「這個來源現在能做什麼」，但責任不同仍不足以證明必須是兩個 NestJS 頂層模組。
- 暫定結論：可以共用合適的認證底層工具，不強迫人員與機器採用同一憑證格式或機制。Sources 不應把停用政策混成憑證驗證失敗；來源狀態不能搶在已保存結果回放之前重新判斷。
- 主張變化：`Auth 管人員、Sources 管機器，所以分開` → `認證與來源業務狀態需分清，但模組位置仍需證明`。
- 適用邊界：未選 JWT、API key、秘密保存格式或 guard 實作；沒有確認合併或分拆方案。
- 待處理問題：Auth 若需要讀取 Source 憑證資料，是否會與 Sources 形成循環依賴。
- 依據來源：[專案參考：A1] 來源停用、認證及冪等契約；D37、D41；[LLM 背景知識] 認證與授權責任區分；[本輪推論] 停用來源及重送反例。

### D43｜單向依賴可避免認證與來源互相穿透，但尚未驗證

- 討論時間：2026-09-17 16:54:16 +08:00（回溯保存時間，非原始回合時間）
- 狀態：自動辯論已完成；反例已有條件式回應，尚無實作依賴證據
- 與既有結論的關係：追打 D42 的修正版；保留責任區分，但不把候選依賴當成定稿。
- 討論問題：Auth 讀 Sources，Sources 又依賴 Auth 做保護，是否造成循環與相互穿透。
- 質詢修士的反例：若機器認證需要 Source 資料，而 Sources 的內部服務又呼叫 Auth 驗證權限，就出現 `Auth → Sources → Auth`。
- 捍衛騎士的回應：這個風險成立，但不是不可避免。候選方向是 `HTTP 入口 → Auth → Sources`，以及 `辨識用例 → Sources`；箭頭表示程式依賴，不是通行流程的檢查先後順序。
- 防禦約束：Auth 只取得必要的 Source 憑證驗證資料並產生可信 Source 身分；Sources 不另存第二套資料，也不反向呼叫 HTTP 認證。v1 沒有公開 Source 管理 API，不需為不存在的功能加上反向依賴。用例不能把 request 任意提供的 Source ID 當成已認證身分。
- 仲裁判斷：概念上的循環可透過入口保護與單向能力依賴避開，但必須由實際 imports、providers 與測試證明，不能只靠箭頭宣稱架構乾淨。
- 暫定結論：來源停用仍是辨識用例在冪等回放之後處理的業務狀態；認證、來源能力與協議協調的責任不得互相重寫。此安排不裁定頂層模組數量。
- 主張變化：`Auth 與 Sources 責任不同即可分開` → `還必須能維持單向資料取得與可信身分傳遞，且不互相重新認證`。
- 適用邊界：尚未建立程式或依賴檢查，具體窄介面與檔案位置未決定。
- 待處理問題：下一輪建議由異端辯士挑戰 Sandbox 的 seed／reset 是常駐應用模組，還是獨立私有維護入口；尚未開始該輪。
- 依據來源：[專案參考：A1] 預置來源、無來源管理 API、認證及重送契約；D42；[LLM 背景知識] 單向依賴與可信身分；[本輪推論] 循環依賴反例及防禦。

### D44｜架構界定完整操作，原子保存保證資料不出現部分成功

- 討論時間：2026-09-17 16:54:16 +08:00（回溯保存時間，非原始回合時間）
- 狀態：概念澄清；未選定資料庫機制或模組方案
- 與既有結論的關係：白話澄清 D22、D38、D41 的完整保存政策；不新增業務能力。
- 使用者疑問：資格更新成功但事件紀錄失敗，有很多技術處理方式；這真的是改架構能處理的問題嗎？若採全部成功或全部失敗，是否會讓遠端辨識也變成失敗？
- 澄清一：架構不能使資料庫永不失敗；它要界定誰負責協調完整操作，避免各 service 各自提交後才補救。原子性機制才負責讓狀態、必要映射變更及事件共同成功或共同不生效；合併模組不會自動產生原子性。
- 澄清二：外部辨識結果與本地通行決策不同。外部已辨識出身分，不表示本地資格檢查及必要保存已完成；本地保存失敗應回系統錯誤，不把結果改成 `FACE_UNKNOWN`，也不假裝是資格不符。
- 澄清三：業務拒絕同樣需要先保存拒絕事件；資料庫完全不可用時，不能保證該次嘗試已留下業務事件。安全／技術紀錄也不能冒充已完成的 Access Event。
- 回應遺失的邊界：完整保存成功但回應遺失，與提交確定失敗不同；不能把所有系統錯誤都解讀為「絕對沒有提交」。呼叫者以相同事件鍵重送，應回放已保存結果或依首次未完成情況處理，不建立第二次通行。
- 實體邊界：資料庫回滾不能撤銷已打開的門。PassHub 不控制真實門鎖；若未來串接硬體，動作時序及硬體確認另需設計，本輪不加入。
- 整理結論：完整操作的責任邊界與資料原子性是互補關係，不是二選一。這些澄清不裁定使用 transaction、單文件原子更新或其他具體方式。
- 待處理問題：使用者要求查核 middlewareServer 實際可見的辨識結果與放行動作方向，結果另存 D45。
- 依據來源：[專案參考：A1] 必要保存、冪等與硬體排除契約；D22、D38、D41；[使用者陳述] 本 block 的問題；[LLM 背景知識] 原子性、提交與回應遺失的區分。

### D45｜公開程式顯示伺服器可依辨識結果觸發動作，但不證明全部裝置流程

- 討論時間：2026-09-17 16:54:16 +08:00（回溯保存時間，非原始查詢秒數）
- 狀態：外部查核已完成；限定公開程式版本，硬體及實際部署邊界仍未知
- 與既有結論的關係：回應 D44 的資料流查詢，不把參考系統做法自動當成 PassHub 政策。
- 查詢範圍：使用者直接授權查核 `e234xp/middlewareServer`，確認可見流程是裝置自行放行後回報，還是伺服器處理辨識結果後觸發動作。
- 版本基準：查詢日期為 2026-09-17；GitHub 當時 main 指向 `c41eee9e22636364d0d4a5dbac6d0d47d7a185f0`，commit 時間為 2024-08-22。既有本機稽核副本 HEAD 與此 SHA 相同且工作樹乾淨；不是把公開分支直接視為目前 production 部署版本。[middlewareServer commit，e234xp，2024](https://github.com/e234xp/middlewareServer/commit/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0)
- 神諭使者的可見發現：
  1. 初始化路徑會啟動結果、I/O box 與 Wiegand workers，結果處理不是僅憑檔名推測的未接入功能。[main 初始化，e234xp，2024](https://github.com/e234xp/middlewareServer/blob/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0/src/main.js#L196-L199)、[介面初始化，e234xp，2024](https://github.com/e234xp/middlewareServer/blob/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0/src/interface/init/index.js)、[worker 初始化，e234xp，2024](https://github.com/e234xp/middlewareServer/blob/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0/src/app/init/index.js)
  2. `worker-result.js` 接收辨識結果，依規則篩選後呼叫 action，包含 I/O box 與 Wiegand。這支持「伺服器收到辨識結果後觸發動作」的可見路徑，不是只有已放行後的被動紀錄。[結果接收與動作規則，e234xp，2024](https://github.com/e234xp/middlewareServer/blob/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0/src/domain/worker-result.js#L4-L181)
  3. I/O box worker 產生 relay 指令並寫入連線；Wiegand worker 送出人員卡號或設定卡號。送出指令／卡號不是證明實體門已打開，下游控制器的最終決策在本次來源之外。[I/O 指令，e234xp，2024](https://github.com/e234xp/middlewareServer/blob/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0/src/domain/worker-iobox.js#L120-L163)、[Wiegand 觸發與寫入，e234xp，2024](https://github.com/e234xp/middlewareServer/blob/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0/src/domain/worker-wiegand.js#L126-L210)
  4. Tablet 驗證會轉送 `/system/verifyface` 或 `/system/verifycard`，回傳驗證識別，再由結果查詢取得辨識資料；`tabletverify` 的結果容器在記憶體中。這不等於實體通行後回報，也不證明外部引擎完全不做持久保存。[Tablet 驗證，e234xp，2024](https://github.com/e234xp/middlewareServer/blob/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0/src/domain/tabletverify.js#L7-L130)、[結果取得，e234xp，2024](https://github.com/e234xp/middlewareServer/blob/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0/src/domain/tabletverify.js#L271-L279)
  5. Tablet check-in 回應含可通行卡號等同步資料，設備建立資料也包含 relay 設定；這只支持「伺服器提供設備資料」的觀察。「設備可能自行執行動作」仍是推論，缺少韌體不能判定。[Tablet 同步回應，e234xp，2024](https://github.com/e234xp/middlewareServer/blob/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0/src/app/api/tablet/checkin.js#L84-L143)、[Tablet relay 設定，e234xp，2024](https://github.com/e234xp/middlewareServer/blob/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0/src/app/api/airafacelite/tablet/create.js#L68-L90)
  6. 技術 system log 走延後寫入及 UDP 傳送，這段本身沒有等待持久保存完成的證據；它不是完整辨識歷史保存流程的替代證據。[system log 寫入，e234xp，2024](https://github.com/e234xp/middlewareServer/blob/c41eee9e22636364d0d4a5dbac6d0d47d7a185f0/src/spiderman/systemlog.js#L56-L130)
- 查核結論：至少存在伺服器根據辨識結果與規則觸發控制動作的路徑；但不能宣稱所有裝置皆由伺服器最終放行，也不能宣稱裝置一律自行放行後才回報。
- 仍無法判定：缺少 Tablet 韌體、外部辨識引擎實作、下游門禁控制器及實際部署設定。可見鏈路沒有證明「必要稽核事件持久保存成功才允許動作」，也不能據此斷言未見部分完全沒有保存或一致性機制。
- 證據缺口狀態：查詢已由使用者直接核准並完成；伺服器動作路徑可確認，所有設備的最終決策與持久保存先後仍未知。本次沒有為此新建 Q 編號。
- 對 PassHub 的影響：可以承認參考系統包含辨識結果到控制動作的流程；PassHub 仍只展示辨識輸入到本地決策及可查詢事件，不加入真實門鎖，也不宣稱復刻全部 production 流程。

### D46｜必要紀錄存不下來就不放行，是 PassHub 的已確認完整性政策

- 討論時間：2026-09-17 16:54:16 +08:00（回溯保存時間，非原始回合時間）
- 狀態：使用者已確認；技術機制與候選架構未定稿
- 與既有結論的關係：在 D45 查核後再確認 D22、D38 的 fail-closed；business-scope.md 已有此契約，不新增業務範圍，也不回寫舊 block。
- 使用者確認：「即使身分與資格都正確，只要必要紀錄存不下來，這次就不放行，確保系統的完整性。」
- 決策過程：區分外部身分辨識、本地資格決策與必要保存；即使前兩者符合條件，也不能略過最後的完整保存而回覆通行成功。
- 已確認結論：
  1. 新的成功通行必須把狀態、必要映射變更及事件共同原子保存；不能留下可觀察的部分成功。
  2. 必要保存未能完成時回系統錯誤，不回傳成功通行結果；拒絕事件保存失敗同樣不假裝完成業務拒絕。
  3. 外部身分辨識仍可正確，本地失敗代表通行處理未完成，不將其偽裝為未知身分。
  4. 已成功提交但回應遺失時，依冪等契約處理重送；不以「呼叫者收到錯誤」推定一定未提交。
- 主張變化：將原有 fail-closed 政策在參考程式查核後明確重申，沒有因參考系統不明的保存流程撤回完整性要求。
- 適用邊界：這是 PassHub 的明確取捨，不宣稱 middlewareServer 已採相同政策；未決定 MongoDB transaction、資料模型、模組合併或真實硬體協議。
- 待處理問題：後續需選定並驗證完整保存方案；本次只保存討論，不開始實作。
- 依據來源：[使用者陳述] 本 block 的政策確認；[專案參考：A1] 第 6.3 節與保存失敗驗收；D22、D38、D44、D45。

## 2026-09-17 知識範圍與前提

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已參考・鎖定｜前段已讀，本次保存只搜尋確認必要保存條文，未重讀全份；業務政策已存在，不修改該檔。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜已參考・鎖定｜本次完整讀取並保留原 D01–D41；只更新檢索資訊及追加續錄。
- A3｜`/home/sean/work/problab_v0510`｜已參考・鎖定｜前段工程品質參考，本次未重讀，也不把舊系統能力說成 PassHub 已完成。
- A4｜NestJS 官方 First steps｜已參考・鎖定｜前段框架參考，本次未重新查詢；不能用來證明模組切分最優。
- A5｜`e234xp/middlewareServer`｜已參考・鎖定｜使用者直接授權的外部查核；查詢日期 2026-09-17、固定 SHA 及逐項連結見 D45。本次保存未新增網路查詢；不是把保存日重新當成第二次版本查核。
- A5 實際查核範圍：`src/main.js`、`src/interface/init/index.js`、`src/app/init/index.js`、`src/domain/index.js`、`src/domain/worker-result.js`、`src/domain/worker-iobox.js`、`src/domain/worker-wiegand.js`、`src/domain/tabletverify.js`、`src/domain/verifyresult.js`、`src/app/api/tablet/verifyfaceservice.js`、`src/app/api/tablet/getverifyresult.js`、`src/app/api/tablet/checkin.js`、`src/app/api/airafacelite/tablet/create.js`、`src/spiderman/systemlog.js`，以及相關引用／註冊搜尋。D45 只保存足以支持本題判斷的發現，不稱已稽核全部部署及硬體。
- LLM 背景知識｜開啟｜用於責任分離、單向依賴、原子性與回應遺失的概念澄清；不作為設備行為、外部引擎或 production 保存順序的證據。
- 使用者陳述｜fail-closed 再確認及求職展示取捨｜屬需求與政策，不是外部程式事實。
- 本輪推論｜Auth／Sources 候選、循環依賴反例及 Tablet 可能自行動作｜分別保留暫定或未知標記，不寫成已實作或已證實。
- 本次保存沒有移除或停止來源，沒有把未讀的新來源列為已參考，也沒有新增查證分支或工程成果。

## 2026-09-17 交接資訊

- 可安全採用：既有業務邊界及已接受的重寫／技術方向；D46 已確認的必要保存失敗不放行政策。該政策已存在於 business-scope.md，本次只補討論脈絡。
- 不可假設：Auth／Sources 已決定分開或合併、AccessModule 已採用、完整六模組已定稿、認證格式或 MongoDB 保存機制已選定，以及參考 production 系統和 PassHub 具備相同放行政策。
- 當前主張：候選架構必須保持規則唯一歸屬、可信身分、單向依賴及完整操作；具體頂層切分仍待討論與實作驗證。
- 下一個明示建議：由異端辯士挑戰 Sandbox 的 seed／reset 是否應作為常駐應用模組，或應放在獨立私有維護入口。只討論責任與依賴，不因改組程式結構撤回每日重置等已確認業務要求；這輪尚未開始。
- 後續驗證：在既有並行、冪等、映射釋放及權限驗收之外，須驗證必要保存失敗無部分成功，以及成功保存後回應遺失的同鍵回放；測試仍未執行。
- 停止點：本次保存並驗證後停止，不續開 Sandbox 攻防，不修改 business-scope.md、README、履歷或程式，也不執行 Git add／commit／push。

## 第二階段討論續錄：Demo 維護命令與重置行為

本節記錄 D46 保存後的白話比較及使用者逐項決策，不是新一輪自動辯論。已接受的行為與未確認的操作順序分開保存；沒有執行命令、清除資料庫、停止或重啟任何服務。

### D47｜Demo 初始化與重置採獨立維護命令

- 討論時間：2026-09-17 17:20:49 +08:00（回溯保存時間，非原始回合時間）
- 狀態：使用者已確認責任切分；命令名稱、排程與執行環境未定
- 與既有結論的關係：收斂 D37 的 SandboxModule 候選及 D43 的下一題；初始化與重置不再預設為 API 常駐模組，其他模組切分不因此定稿。
- 討論問題：API 常駐模組與獨立維護命令有什麼區別。
- 比較過程：常駐模組由 API 應用承擔重置責任；獨立命令由維護者或外部排程啟動。兩者均可共用必要程式，不需要兩套資料模型或重複規則；都仍須處理重置與進行中操作的競爭。
- 使用者選擇：「獨立維護命令」。
- 已確認結論：Demo 初始化與重置放在同一 repository 的獨立維護入口，可共用必要設定與資料存取；不提供公開重置 API。每日重置需求保留，但排程方式未定。
- 主張變化：`Sandbox 可能是常駐頂層模組` → `Demo 初始化／重置由獨立維護命令承擔`。
- 適用邊界：不因獨立命令而建立另一套業務規則，也不宣稱常駐 Sandbox 模組已移除或新命令已完成。
- 待處理問題：維護期間的 API 行為、重置失敗及進行中操作另見 D48–D51。
- 依據來源：[使用者陳述] 責任切分選擇；D37、D43；[LLM 背景知識] 應用入口與維護工具的分離。

### D48｜維護期間暫停業務操作，重置失敗不恢復服務

- 討論時間：2026-09-17 17:20:49 +08:00（回溯保存時間，非原始回合時間）
- 狀態：使用者已確認行為；維護狀態與回應機制未定
- 與既有結論的關係：補足 D47 的操作隔離，不擴增訪客通行業務能力。
- 討論問題：重置時是否接受暫停 API 業務操作，以及重置中途失敗時是否可直接恢復。
- 建議與使用者回應：對「暫時拒絕操作，明確回覆 Demo 維護中、請稍後重試」，使用者接受；對「重置失敗維持維護中，由維護者重跑成功才恢復」，使用者也接受。
- 已確認結論：重置期間不對外提供業務操作；成功後才恢復。重置中途失敗，不讓測試者操作半完成的資料，維持不可用，待維護者重跑成功。
- 適用邊界：尚未決定 HTTP status、維護訊息由 API 或部署入口提供、健康檢查行為及維護狀態保存位置。若 API 程序停止，維護回覆不能憑空由已停止的程序提供，機制需另行規劃。
- 待處理問題：何時清資料、如何隔離舊操作，以及如何安全恢復服務仍需確認與驗證。
- 依據來源：[使用者陳述] 兩次接受；D47；[本輪推論] 半完成資料不應對外開放。

### D49｜先停止新操作，讓既有操作結束後再清資料

- 討論時間：2026-09-17 17:20:49 +08:00（回溯保存時間，非原始回合時間）
- 狀態：使用者已確認一般流程；逾時例外由 D50 補充
- 與既有結論的關係：細化 D48 的維護進入行為，不表示必須無限等待。
- 討論問題：維護開始時，已經在處理的通行請求要如何對待。
- 建議：停止接受新業務操作，讓已開始的操作結束，再開始清理，避免通行保存與重置互相干擾。
- 使用者選擇：接受。
- 已確認結論：一般流程先關閉新操作入口、等待進行中操作結束，再清理 Demo 資料；等待時間有上限，超時依 D50，不把本 block 解讀為無限等待。
- 適用邊界：「操作結束」涵蓋不再干擾重置的資料庫工作，不只是 HTTP 連線結束。具體追蹤、停止與確認方式尚未設計或測試。
- 待處理問題：卡住的操作超過上限時是否取消重置，另見 D50 的使用者修正。
- 依據來源：[使用者陳述] 對等待既有操作的接受；D48；[LLM 背景知識] 維護排空與資料競爭。

### D50｜等待超時直接重置，不採取消本次重置的提案

- 討論時間：2026-09-17 17:20:49 +08:00（回溯保存時間，非原始回合時間）
- 狀態：使用者已確認逾時處理方向；隔離舊操作的技術方案未定
- 與既有結論的關係：補充 D49 的等待上限；明確記錄使用者沒有採納「逾時取消重置」的建議。
- 初始建議：若進行中操作一直卡住，等待超過上限就中止本次重置，維持維護中並交由維護者處理。
- 白話澄清：以 ENTRY 正在寫資料庫、資料庫未回應的情境解釋，原建議是等不到就先不清資料。
- 使用者修正：「超過一定時間直接重置」。
- 已確認結論：停止新操作後可等待既有操作，但超過上限便進入重置，不繼續無限等待，也不採「只因請求等待逾時而取消本次重置」。若重置本身失敗，仍依 D48 維持不可用。
- 助手指出的必要一致性約束：舊操作不能在重置後把舊資料重新寫回；未完成的呼叫可以失敗，由測試者重試。此約束是實作必須處理的風險，不是已驗證的保障，也不表示已選用取消、停止程序或版本隔離機制。
- 主張變化：`等待超時就先不重置`（未被使用者採納）→ `等待有上限，超時直接重置；舊操作的隔離方式另訂`。
- 適用邊界：逾時不等於請求或資料庫操作自動停止；具體上限未決定，也不授權現在執行任何清除。
- 待處理問題：是否以 server 重啟處理暫存，以及重啟與清資料的順序，另見 D51。
- 依據來源：[使用者陳述] 逾時直接重置；D48、D49；[LLM 背景知識] 超時與實際操作停止不同；[本輪推論] 舊操作寫回風險。

### D51｜先清資料庫再重啟是使用者提案，停止與重置順序仍未定案

- 討論時間：2026-09-17 17:20:49 +08:00（回溯保存時間，非原始回合時間）
- 狀態：使用者已提出清資料及重啟的方案；助手提出替代順序，尚未取得使用者對順序的確認
- 與既有結論的關係：承接 D50 的逾時直接重置；不因授權保存就把某一重啟流程當成已採用方案。
- 使用者問題：重置是否包含重啟 server。
- 當時澄清：重置原先指清除 Demo 業務資料及重建預置資料，不必然包含重啟；重啟是否納入及執行順序需要另外決定。
- 使用者提案：「先清空資料庫再重啟 server」，理由是重啟可以一併清除未完成的記憶體狀態及暫存。
- 助手回應：重啟能清掉程序內記憶體，但先清資料、後停止程序存在時間空隙；舊操作可能在清除後、程序停止前寫回資料。重啟不會再次清除這些已持久保存的內容，也不保證資料庫已收到的工作立即取消。
- 替代候選順序：`進入維護 → 停止 server → 確認舊資料庫操作已結束 → 清除 Demo 資料並重建預置資料 → 啟動 server`。它是助手建議，不是使用者已接受的定稿；與 D50 的等待上限如何配合，仍需選定可驗證機制。
- 暫定整理：使用者要達成的是清理 Demo 資料與未完成的程序狀態；實際清除範圍、重啟是否為固定步驟，以及先清或先停的順序未定。不能據此推定已設計業務狀態 cache，也不能推定要刪除整個資料庫及所有控制資料。
- 適用邊界：沒有停止 server、清空資料庫、重建預置資料或執行任何維護命令；本次沒有查核現有 cache 或 MongoDB 中止操作機制。
- 待處理問題：下一步先確認重啟與清理順序，再規劃舊操作隔離、維護訊息及恢復判準；不直接進入實作。
- 依據來源：[使用者陳述] 清資料後重啟的提案及其理由；D48–D50；[LLM 背景知識] 程序記憶體與持久資料的區分；[本輪推論] 清除和寫回的時間競爭。

## 2026-09-17 17:20 維護討論知識範圍與前提

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已參考・鎖定｜沿用前段已確認的業務前提；本次保存未重讀內容，只比對檔案雜湊以確認未修改。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜已參考・鎖定｜本次完整讀取 D01–D46，保留原 block 與交接快照，只更新當前檢索資訊及追加 D47–D51。
- A3｜`/home/sean/work/problab_v0510`｜已參考・鎖定｜本次未重讀，沒有用它宣稱 PassHub 已具備維護隔離能力。
- A4｜NestJS 官方 First steps｜已參考・鎖定｜本次未重新查詢，沒有用框架文件支持具體重置順序。
- A5｜`e234xp/middlewareServer`｜已參考・鎖定｜沿用 D45 的限定查核，這段沒有重新研究或推定其 production 維護流程。
- 使用者陳述｜獨立維護命令、維護及失敗行為、等待上限與重啟提案｜確認狀態分列於各 block，不將保存授權當成對候選順序的接受。
- LLM 背景知識｜開啟｜只用於維護責任、程序記憶體、持久資料及並行寫回風險的概念說明，不是外部查證或現有程式檢查結果。
- 本次沒有新增外部來源、移除或停止來源、建立新的 Q 查證分支，亦沒有執行維護或取得工程驗收證據。

## 2026-09-17 17:20 維護討論交接資訊

- 可安全採用：D47 的獨立維護命令；D48 的維護期間暫停業務操作、重置失敗不恢復；D49 的先停新操作再等待既有操作；D50 的等待有上限、逾時直接重置。
- 已放棄的提案：不能再把「等待請求逾時就取消本次重置」寫成目前政策，使用者已選擇直接重置；重置本身失敗則仍依 D48。
- 不可假設：使用者已接受先停止 server 才清資料、每次重置必須重啟、已選定排程／HTTP status／維護狀態位置／取消機制，或清空範圍已包含整個資料庫。
- 下一步：先確認 D51 的重啟與重置順序及清理範圍；實作方案需同時滿足等待上限與重置後無舊資料寫回的要求，不以 HTTP 超時或程序停止冒充所有資料庫工作已停止。
- 後續待驗證：維護期間沒有新業務操作、既有操作正常結束或逾時處理、重置中及重置後無舊寫入干擾、重置失敗不開放半完成資料、成功後預置資料可用；目前沒有完成任何這類測試。
- 停止點：只保存本次討論並檢查文件，之後停止。不修改 business-scope.md、README、履歷或程式，不執行實際重置／重啟，也不執行 Git add／commit／push。

## 第二階段討論續錄：三 agent 核心邊界比較與共同保存契約

本節保存已發生的正式論點及主張變化，不是重新啟動辯論。D52 更新維護流程，D53 記錄使用者指定的討論方式，D54–D56 保存三組攻防，D57 記錄使用者對共同責任契約的明確接受。A 是 QualificationsModule／RecognitionModule 分拆，B 是 AccessModule 內部分工；兩者仍未定案。

### D52｜每日凌晨 03:00 由 API 之外的排程自動停止、重置及重啟

- 討論時間：2026-09-17 17:47:38 +08:00（回溯保存時間，非原始回合時間）
- 狀態：使用者已接受自動維護流程；具體排程、停止及資料清理機制未定
- 與既有結論的關係：更新 D51 尚未確認的重啟順序，延續 D47–D50 的獨立命令、維護隔離、等待上限及失敗不恢復。
- 使用者澄清：每日凌晨 03:00 自動執行，不是正常情況下由人工操作；並質問停止服務後如何清理資料。
- 助手澄清：停止的是 PassHub API 程序，不是 MongoDB 或獨立維護命令。重置入口可在 API 停止後連線資料庫；排程及重新啟動能力不能只放在將被停止的 API 程序內。
- 使用者選擇：接受所述自動流程，並要求接續核心模組討論。
- 已確認流程：
  1. 每日凌晨 03:00 進入維護，停止接受新業務操作；依目前專案時區前提為 Asia/Taipei。
  2. 等待既有操作結束，等待有上限；必要時逾時停止 API，進入重置流程，不無限等待請求。
  3. API 停止，且舊資料庫工作不會干擾重置後，由獨立維護命令清除 Demo 資料並重建預置資料。停止 API 不等於資料庫已接收的工作自動取消，隔離與確認機制待實作規劃。
  4. 重置成功才自動啟動 API；重置失敗維持不可用，才由維護者介入。
- 主張變化：`先清資料庫再重啟`（D51 提案）→ `由外部排程自動停止 API、隔離舊操作後清理與重建、成功才重啟`（本 block 已接受）。
- 適用邊界：未決定 cron／容器／雲端排程工具、HTTP 維護回覆來源、等待上限或整個資料庫刪除；沒有實際停止、清除或重啟服務。
- 待處理問題：實作規劃需同時落實等待有上限、舊操作不干擾新資料及失敗不可用，並確認清理範圍。
- 依據來源：[使用者陳述] 自動執行時間及接受；D47–D51；[LLM 背景知識] API 程序、資料庫及維護程序的獨立生命週期。

### D53｜三個角色使用獨立 agent，第一輪盲評後只交換正式論點

- 討論時間：2026-09-17 17:47:38 +08:00（回溯保存時間，非原始回合時間）
- 狀態：使用者指定的討論方式已執行；不等於三個互不影響的證據來源
- 與既有結論的關係：延續自動辯論及使用者要求的嚴格比較，不改變候選或業務範圍。
- 使用者要求：異端辯士、捍衛騎士、仲裁賢者分別由三個獨立 agent 擔任，由主 agent 陳述內容，彼此思考不要互相汙染。
- 實際方式：以不繼承完整對話歷史的獨立 agent 啟動，各自取得相同事實底稿及自己的角色指引；第一階段不分享其他角色的立場或輸出。agent 分別為 `/root/core_boundary_heretic`、`/root/core_boundary_defender`、`/root/core_boundary_moderator`。
- 後續交換規則：攻防所需的正式主張、攻擊及回應經主 agent 傳遞，仲裁者取得正式發言後判斷；不要求或交換隱藏思考，不讀取其他 agent 的私有推理，也不以共享檔案傳遞尚未公開的立場。
- 已觀察結果：第一輪異端與捍衛皆獨立偏向 B；沒有虛構兩者對模組偏好的直接衝突，而是檢驗 B 的比較理由及可檢查限制。
- 適用邊界：獨立上下文不保證不同模型、不同訓練背景或統計獨立；正式交鋒必然使角色知道對手論點，不能聲稱後續完全沒有相互影響。agent 意見屬設計推論，不是三份實作證據。
- 依據來源：[使用者陳述] 指定三 agent；[本輪執行紀錄] 獨立啟動、正式論點傳遞及盲評結果。

### D54｜無資格事件揭示辨識的獨立責任，撤回 AccessModule 較優的主張

- 討論時間：2026-09-17 17:47:38 +08:00（回溯保存時間，非原始回合時間）
- 狀態：三 agent 攻防已完成；B 比較優勢已撤回，A／B 均保留為候選
- 與既有結論的關係：承接 D40–D41；保留唯一規則及完整行為限制，不因初始偏好直接採用合併。
- 捍衛騎士開場：B 的 AccessModule 較適合作為核心邊界；管理、辨識及事件查詢各有內部用例，共用純資格規則。理由是修改／撤銷與 ENTRY 競爭、EXIT 釋放 Mapping，跨越操作分類；同時承認共同保存不要求同一模組。
- 異端辯士攻擊：同意優先考慮 B，但共同生命週期不足以證明比較優勢。合法 UNKNOWN、無效 QR 或停用 Source 都須保存事件，卻未必涉及資格；辨識不能被化約成資格生命週期。要求提出 B 的可檢查限制，並說明比 A 多排除什麼錯誤依賴。
- 捍衛騎士回應：部分命中，明確撤回 B 優於 A，退守為 B 是可提出清楚限制的候選。管理不得任意設定 Presence；辨識負責協議、映射及完整保存；無資格拒絕也能記事件；查詢只有去敏讀取。這些限制 A 同樣能做到。
- 仲裁賢者判斷：無資格 Event 已補進責任說明，但能力限制未落實驗證，也缺 A 的對稱契約比較；不能恢復 B 較優的主張。
- 主張收縮路徑：`B 較適合` → `共同生命週期不足證明比較優勢` → `B 是受限制的可行候選，A 仍保留`。
- 適用邊界：沒有 imports、providers 或整合測試證據；本輪反例是依業務規格的設計挑戰，不是現有程式缺陷查核。
- 下一分支：使用者接受讓異端提出 A 的最小公開契約，結果見 D55。
- 依據來源：[專案參考：A1] 第 4.3–4.5、5.3、6、7.1–7.3、8.3 節；[正式 agent 發言] 三角色攻防；[本輪推論] 模組比較與能力限制。

### D55｜拆分以最小資格行為契約合作，也可共用一次完整保存

- 討論時間：2026-09-17 17:47:38 +08:00（回溯保存時間，非原始回合時間）
- 狀態：三 agent 攻防已完成；A 的概念契約已具體化，A／B 尚未選擇
- 與既有結論的關係：補足 D54 的對稱比較，不取回已撤回的 B 優勢。
- 異端辯士提出 A：Qualifications 擁有唯一純資格規則、QR／Face 映射、生命週期及管理用例；對 Recognition 只提供「映射並依方向裁決、參與必要變更」的受限制行為，不公開通用 setter、repository 或任意 Presence 修改。Recognition 擁有固定處理順序、冪等、Event 建立與查詢，也處理無資格 Event。
- 保存合作提案：辨識應用用例協調共同保存，資格能力參與同一保存單位、不自行提交；管理用例也協調自己的保存，不繞經辨識。技術上下文停留在應用／基礎設施層，純規則不接 MongoDB session。發生衝突不能沿用舊計畫，須以固定首次接收時間重讀與重新裁決。
- 異端辯士問題：同樣限制成立時，B 比 A 多排除哪種錯誤依賴。
- 捍衛騎士回應：問題指向已撤回的 B 較優，未推翻目前的 B 可行；同時承認 A 的合作契約概念可行。真正尚待明確的是保存組合責任及「暫存」時序，不能把回傳轉移計畫當作並行保證，也不能據此直接判定 A 有缺陷。
- 仲裁賢者判斷：A 已在概念上回應窄資格契約、無資格事件、避免自行提交及純規則混入 MongoDB 的疑慮；沒有證明 A 較優，也沒有完成實作驗證。不再循環爭論模組數量，先收斂共同保存責任。
- 形成的比較：A 把資格能力限制放在跨頂層模組的公開契約；B 把相同限制放在 AccessModule 的內部元件契約。兩者都不得重複規則或任意穿透寫入。
- 適用邊界：提案是概念上的能力與合作方式，不是 API 路徑、DTO、具體介面或資料模型定稿；單純重新讀取資料不等於解決競爭。
- 下一分支：使用者接受討論完整保存的流程負責人與衝突後的舊計畫處理，結果見 D56。
- 依據來源：[專案參考：A1] 第 4.4–4.5、5.3、6、7、8.3 節；[正式 agent 發言] A 契約及回應；[本輪推論] 跨模組與內部元件邊界的比較。

### D56｜用例協調完整流程，保存層區分可重跑衝突與提交不明

- 討論時間：2026-09-17 17:47:38 +08:00（回溯保存時間，非原始回合時間）
- 狀態：三 agent 設計論證已收斂；使用者接受另見 D57，工程驗證未取得
- 與既有結論的關係：補足 D55 的完整保存責任，延續 D22、D46 的 fail-closed；不因保存方案要求 A／B 必須合併。
- 捍衛騎士正式方案：應用用例擁有整次業務流程及有界重跑／結果確認；純業務規則擁有唯一政策；基礎設施保存單位提供完整提交、撤回及可信結果分類，不制定資格政策。
- 操作邊界：Recognition 用例協調一次 Attempt，資格管理用例協調自身的建立／修改／撤銷。共同保存能力須涵蓋完整操作：先處理已保存事件的回放或內容衝突，再讀必要來源、映射與資格、套用規則並完整保存。無資格拒絕同樣保存冪等結果與 Event。
- 衝突重跑：由應用用例重跑完整操作，而非只重試保存舊 plan 或補寫 Event；固定首次 receivedAt，不因內部重試刷新。讀取、裁決與提交必須具有相容的一致性邊界，重讀本身不能保證並行正確；技術機制待選。
- 提交不明：先確認原事件結果，不能盲當未提交，也不能僅因暫時查不到就重做。重試及確認有上限；無法確認完整保存時回系統錯誤，不回通行 outcome。
- 異端辯士回應：承認舊 plan 與提交不明已有處理方向，沒有足以否定架構的殘餘反例；要求精確化保存結果分類。只有能證明本輪未留下保存效果，才能報可觸發業務重跑的衝突；其餘不確定結果必須進入提交不明確認流程。
- 捍衛騎士回應：接受精確化，不視為核心架構被駁倒；分類是概念責任契約，不是已選定的 error enum 或 DTO。接受以故障注入驗收，但測試尚未執行。
- 仲裁賢者判斷：責任在設計層已收斂，沒有新增外部事實必須查證；真正缺的是保存及分類的落實、並行與故障測試。A／B 都能承載此契約，應交使用者確認後回到核心模組的選擇。
- 適用邊界：業務重跑不得另開無限迴圈；技術性提交確認不能偷換成重新裁決。純規則不依 NestJS、HTTP 或 MongoDB。尚未選 driver、transaction、版本欄位、鎖或實際重試工具。
- 依據來源：[專案參考：A1] 第 4.4、5.3、6.4、7.1–7.3 節；[正式 agent 發言] 保存方案、結果分類挑戰及仲裁；[LLM 背景知識] 原子保存與提交確認不同；[本輪推論] 三層責任契約。

### D57｜使用者接受共同責任分工，核心模組分合留待最後選擇

- 討論時間：2026-09-17 17:47:38 +08:00（回溯保存時間，非原始回合時間）
- 狀態：使用者已確認共同責任契約並授權本次保存；A／B 尚未選定
- 與既有結論的關係：將 D56 的角色共識提升為使用者接受的設計前提；不把 D54、D55 的候選可行性誤寫成模組採用決策。
- 使用者確認：「接受，先把目前討論結果更新至文件後，我們再回到核心模組的最後選擇。」
- 已確認責任：
  1. 純業務規則唯一負責資格的可修改性、撤銷與 ENTRY／EXIT 政策，不依賴框架或資料庫。
  2. 應用用例是完整操作的流程負責人，協調讀取、裁決及保存；衝突時有界重跑完整流程，不沿用舊判斷提交，並保留固定首次 receivedAt。
  3. 資料庫保存層負責狀態、必要映射變更及事件的共同原子保存，以及可信的保存結果分類，不自行發明業務規則。
  4. 分類須區分完整成功、確定本輪未生效的可重跑衝突，以及提交不明。提交不明先確認同鍵原結果；查不到不等於已回滾，無法確認時回系統錯誤，不回通行成功或假裝已完成業務拒絕。
  5. 無資格拒絕事件、冪等及並行契約仍完整保留；這套分工同時適用 A 與 B。
- 尚未確認：A／B 的頂層模組選擇、Auth／Sources 分合、具體資料庫與重試機制、API／DTO／資料模型／工具選型。
- 驗收證據：後續需驗證跨媒介並行、修改／撤銷競爭、原子保存失敗、可重跑衝突確無本輪保存效果、提交確認遺失及同鍵回放。全部列為待完成，不聲稱測試已通過。
- 主張變化：`角色提出且接受的共同責任方案` → `使用者已接受的架構設計前提`；沒有恢復 B 較優主張。
- 停止點：本次保存並檢查後停止，再由使用者與角色回到核心模組的最後選擇；不在寫檔過程直接定案或實作。
- 依據來源：[使用者陳述] 明確接受及保存要求；D54–D56；[專案參考：A1] 既有資格、冪等、並行及完整保存驗收。

## 2026-09-17 17:47 架構討論知識範圍與前提

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已參考・鎖定｜三 agent 各自讀取相關規格；主 agent 本段實際重讀第 1–3、4.2–4.5、5.3、6–7、8 節及章節索引。本次保存未重讀全文，只比對雜湊確認未修改；採用固定流程、資格凍結、映射釋放、無資格事件、冪等及並行／保存契約。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜已參考・鎖定｜主 agent 在討論階段讀取 D38–D41 作為歷史前提；三 agent 起始只取得事實底稿，不讀既有角色辯論。主 agent 本次完整讀取原 D01–D51，保留所有原 block，追加 D52–D57 並更新檢索資訊。
- A3｜`/home/sean/work/problab_v0510`｜已參考・鎖定｜本段未重讀，只保留前段工程品質前提，不推定維護或保存機制已移植。
- A4｜NestJS 官方 First steps｜已參考・鎖定｜本段未重新查詢，不用作 A／B 優劣證據。
- A5｜`e234xp/middlewareServer`｜已參考・鎖定｜沿用 D45 的限定查核，本段沒有再次研究，也不推定其 production 保存或重置政策。
- 使用者陳述｜凌晨 03:00 自動維護、三獨立 agent、逐輪繼續及共同責任契約接受｜分別列為需求、討論方式及設計決策，不充作工程測試證據。
- 正式 agent 發言｜三角色獨立準備後的開場、攻擊、回應及仲裁｜屬可追溯設計論證；保存正式內容及收縮路徑，不保存或宣稱取得內部思考。
- LLM 背景知識｜開啟｜用於窄行為契約、內聚、依賴方向、原子保存、衝突與提交不明的概念說明；不是外部查證或特定 driver 的行為保證。
- 本段沒有新增外部來源或 Q 查證分支，沒有移除或停止既有來源；本次保存沒有新增架構攻防、工程測試或維護執行。

## 2026-09-17 17:47 架構討論交接資訊

- 可安全採用：D52 的自動維護順序，以及 D57 的共同責任分工；既有 fail-closed、冪等、無資格 Event、固定 receivedAt 及並行契約不變。
- 已撤回且不可暗中恢復：D54 的「B 比 A 更適合」比較主張。第一輪兩 agent 偏好 B，不等於使用者採用，更不等於兩份獨立實作證據。
- 核心最後選擇：A 使用 QualificationsModule／RecognitionModule 的跨模組行為契約；B 使用單一 AccessModule 的內部元件契約。兩者均須分開管理、辨識與去敏查詢，維持唯一規則及受限制的寫入能力，不建立萬用 AccessService。
- 不可假設：A／B 已定案、Auth／Sources 已定案、具體 repository／資料模型／transaction／driver／認證／重試／排程已選定，或自動重置、保存原子性及錯誤分類已測試通過。
- 下一步：回到核心模組的最後選擇，依頂層業務邊界取向及能力限制做決策；不能再用兩天時限、模組數量或已撤回比較主張代替理由，也不需再循環質疑已接受的共同責任分工。
- 後續驗收：實際依賴及能力限制、無資格事件、修改／撤銷與 ENTRY 競爭、同鍵重送、保存失敗、提交確認遺失及重跑上限；自動維護需驗證舊工作不寫回重置後資料、失敗不恢復。所有驗收仍待執行。
- 停止點：本次只修改 discuss.md，保留舊紀錄並驗證後停止。不同步 business-scope.md、README 或履歷，不開始重寫程式、不執行清資料／重啟，也不執行 Git add／commit／push。

## 第二階段討論續錄：核心模組最後選擇

### D58｜以完整通行業務作頂層邊界，採用前提是內部能力隔離

- 討論時間：2026-09-17 18:05:30 +08:00（回溯保存時間，非原始回合時間）
- 狀態：三 agent 最後評估及一組攻防已完成；使用者確認另見 D59
- 與既有結論的關係：承接 D54–D57；共同保存責任不重開，也不恢復「B 客觀較優」的已撤回主張。
- 捍衛騎士最後建議：選 B，以完整資格通行業務作 AccessModule 頂層邊界；內部仍有資格管理、辨識與安全查詢用例及純業務規則。這是邊界表達偏好，不是比較優勢的證明。
- 代價與另一方案：B 不能靠兩個頂層模組的界線表達管理／辨識能力隔離，須檢查內部元件契約；若更重視將資格能力限制提升為跨頂層模組的公開合作契約，A 仍是合理選擇。
- 異端辯士獨立取向及挑戰：也偏向 B，不虛構對模組偏好的衝突；唯一採用條件是查詢不得取得寫入能力、管理不得取得 ENTRY／EXIT 轉移或任意 Presence setter、repository 不作通用共享能力。限制須由介面、依賴檢查及測試驗證，不能只靠資料夾名稱。
- 捍衛騎士回應：接受能力隔離為 B 的必守契約；核心用例保有必要寫入權限，也可共用受限制的保存適配器。不是禁止所有基礎設施重用；Nest exports 本身也不能保證所有 TypeScript imports 遵守邊界，檢查工具待選。
- 仲裁賢者判斷：採 B 是頂層業務邊界取向，沒有恢復客觀較優主張。能力隔離在設計層已回應，交使用者決定，不再循環辯論模組數量；沒有新增外部事實需要查證，實作證據仍欠。
- 適用邊界：未知 Face、無效 QR 等無資格 Event 仍是辨識的獨立責任，不因合併就要求每筆事件都關聯資格。Auth／Sources 等其他模組不因這輪偏好直接定案。
- 依據來源：[專案參考：A1] 第 1.1、4、5.3、6–8 節；D54–D57；[正式 agent 發言] 最後取向、能力隔離挑戰與回應；[本輪推論／設計偏好] 頂層邊界表達。

### D59｜核心正式採用 AccessModule，保留內部分工與能力限制

- 討論時間：2026-09-17 18:05:30 +08:00（回溯保存時間，非原始回合時間）
- 狀態：使用者已確認核心採用決策，並授權先更新討論文件再討論 Auth／Sources
- 與既有結論的關係：更新 D57 的 A／B 尚未選定；採用 B，不代表 A 被證明不合理，也不撤回 D57 的共同責任契約。
- 使用者確認：對「AccessModule＋上述內部分工與能力限制」回答「接受」；之後要求先確認文件已更新至最新結論，再進行討論。
- 已確認核心分工：
  1. 資格管理用例：建立、依規則允許的修改與撤銷。
  2. 辨識用例：QR／Face 輸入、冪等、映射、決策及完整保存協調；包含無資格的拒絕事件。
  3. 查詢用例：資格、INSIDE Qualification 及事件的安全分頁讀取。
  4. 純業務規則：唯一擁有資格生命週期及通行政策，不依框架或資料庫。
- 已確認能力限制：查詢只有讀取能力；管理不具 ENTRY／EXIT 轉移或任意 Presence 設定能力；資料存取不成為所有元件的萬用入口。各完整用例仍取得完成自身操作所需的受限制保存能力。
- 完整保存：應用用例、純規則及保存層依 D57 分工，衝突與提交不明的契約不變；不能把管理、辨識及查詢收成萬用 AccessService。
- 主張變化：`A／B 皆為候選` → `使用者選 B 作為核心頂層邊界`；是採用決策而非恢復比較優勢。
- 尚未定案：Auth／Sources 的頂層切分、其他模組完整清單、檔案與介面細節、資料模型、認證、MongoDB 保存機制及驗證工具。
- 驗收證據：能力限制需介面、import／依賴檢查與測試共同落實，並延續 D57 的真實並行與故障驗收；目前沒有實作或測試通過證據。
- 保存關卡：先檢查本次追加、歷史保留及當前檢索資訊；向使用者回報後，依本次明確授權進入 Auth／Sources 討論。不修改其他文件、不開始程式實作。
- 依據來源：[使用者陳述] 核心接受及最新保存／討論順序；D57、D58；[專案參考：A1] 核心用例與驗收契約。

## 2026-09-17 18:05 核心定案知識範圍與前提

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已參考・鎖定｜沿用前段已讀的核心與驗收規則；本次保存未新增內容讀取，只比對雜湊確認未修改。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜已參考・鎖定｜最後評估前重讀 D57 及交接；本次完整讀取原 D01–D57，保留原 block，只更新檢索資訊並追加 D58–D59。
- A3｜`/home/sean/work/problab_v0510`｜已參考・鎖定｜本段未重讀，不把工程品質參考當成 PassHub 的實作證據。
- A4｜NestJS 官方 First steps｜已參考・鎖定｜本段未重新查詢，不以框架模組機制冒充完整能力隔離。
- A5｜`e234xp/middlewareServer`｜已參考・鎖定｜本段未重新查核，不將參考系統的架構或內部資料作為核心採用依據。
- 正式 agent 發言與使用者陳述｜最後取向、採用前提及明確接受｜分別是設計論證與使用者決策，不是多數投票證明或實作成果。
- LLM 背景知識｜開啟｜僅用於模組邊界、窄能力及依賴限制的概念說明；沒有新增來源或外部查證分支。

## 2026-09-17 18:05 核心定案交接資訊

- 可安全採用：D59 的 AccessModule 核心定案，以及 D57 共同責任分工、D52 自動維護流程與既有業務契約。
- 不可假設：已完成程式、已驗證能力隔離、已採用完整模組清單，或已選定資料庫、認證、API、部署及測試方案。
- 下一題：Auth／Sources 的責任及頂層模組切分；先沿用 D42–D43 的認證與來源業務狀態區分、可信 Source 身分及單向依賴候選，不因它們曾被討論就誤寫成已定稿。
- 不重開：AccessModule 最後選擇、共同保存責任及已撤回的 B 客觀比較優勢。不以兩天判準或假想新功能推動架構擴張。
- 本次邊界：只保存 D58–D59 並驗證，接著按使用者授權討論下一題；後續 Auth／Sources 攻防不自動視為使用者接受，也不在本次保存中預先編造結論。不修改 business-scope.md、README、履歷或程式，不執行 Git add／commit／push。

## 第二階段討論續錄：認證與來源模組定案

### D60｜Auth／Sources 分開仍須窄能力接線，不能匯出同一萬用服務

- 討論時間：2026-09-18 11:31:59 +08:00（回溯保存時間，非原始回合日期或秒數）
- 狀態：三個獨立 agent 的評估及一組攻防已完成；使用者接受另見 D61
- 與既有結論的關係：收斂 D42–D43 尚未決定的頂層切分；不重開 D59 的 AccessModule 或 D57 的共同保存責任。
- 比較候選：A 是 AuthModule／SourcesModule 分開；B 是一個身份／來源頂層模組，內部分開人員認證、機器認證及來源資訊。兩者都不能把停用來源混成認證失敗，也不能擴增帳號或來源管理功能。
- 捍衛騎士獨立開場：偏向 A。Auth 負責可信身分、身分類型及人員權限；Sources 擁有來源憑證與預置資料、固定方向及啟用狀態。Auth 經窄能力取得驗證必要材料，Access 取得不含憑證的來源資訊，Sources 不反向依賴 Auth。這是邊界取向，不宣稱 A 客觀較優；代價是機器認證需要跨模組合作契約。
- 異端辯士獨立取向及正式挑戰：也偏向 A，不虛構對模組偏好的對立。有效缺口是兩個模組不會自行按消費者隔離能力；若 Sources 匯出同一個寬服務，Auth 與 Access 仍可能取得相同的憑證查驗能力。要求透過窄介面及匯入／注入路徑，限制 Access 只取得來源事實。
- 捍衛騎士回應：接受精確化，分別提供受限制的驗證材料能力，以及不含憑證的 SourceContext 讀取能力，由組合接線分別提供給 Auth 與 Access。不能只把同一寬服務以 TypeScript 型別轉換偽裝成隔離；必須檢查 Access 不匯入或注入驗證能力。具體 provider、介面及檢查工具尚未定稿。
- 既有業務順序：Source 身分來自已驗證憑證，不由 request body 覆寫；Auth 不以 active 作認證條件。Access 先處理冪等回放／內容衝突，僅對新合法嘗試判斷 active；Sources 提供可信資料，不自行決定通行結果。
- 仲裁賢者判斷：能力隔離挑戰在設計層已回應，實際 import／注入及測試尚未落實；角色同意不等於使用者採用。沒有新外部事實需要查證，交使用者確認分開方案及限制，不再循環討論模組數量。
- 適用邊界：公開 Demo credential 是刻意公開的測試值，不把它描述成正式私密憑證；仍保留內部去憑證與最小能力契約，且與部署／資料庫／維護者憑證分離。不強迫人員與機器使用同一認證格式。
- 依據來源：[專案參考：A1] 第 3.2–3.4、5.1、5.3、7.2 節；D42–D43、D57、D59；[正式 agent 發言] `/root/core_boundary_defender`、`/root/core_boundary_heretic`、`/root/core_boundary_moderator` 的開場、攻擊、回應及仲裁；[本輪推論] 窄能力隔離與邊界取向。

### D61｜使用者同意 AuthModule／SourcesModule 分開，Access 保留業務判斷

- 討論時間：2026-09-18 11:31:59 +08:00（回溯保存時間，非原始回合日期或秒數）
- 狀態：使用者已確認採用決策並授權本次保存；完整架構接線及技術方案未定
- 與既有結論的關係：更新 D42–D43、D59 的認證／來源分合未定狀態；核心 AccessModule 與共同保存契約維持不變。
- 使用者確認：對「Auth／Sources 分開＋窄能力介面＋Access 保留通行判斷」回答「同意」，之後要求「好先保存」。
- 已確認分工：
  1. AuthModule 負責人員及 Source 的認證、可信身分與類型，以及 Operator／Viewer 人員角色權限；人員與機器身分不能混用權限。
  2. SourcesModule 擁有來源預置資料、憑證查驗所需材料、固定方向與啟用狀態，向不同消費者提供受限制的能力。
  3. Auth 僅取得認證所需來源能力；Access 僅取得不含憑證的來源資訊。不得以一個通用 SourcesService 讓所有元件取得全部能力。
  4. AccessModule 保留通行判斷、冪等及完整流程協調。憑證錯誤屬認證失敗，不建立 Access Event；新合法嘗試遇停用來源由 Access 保存 `SOURCE_INACTIVE` 拒絕事件；同鍵同內容先回放原結果，不重新判斷現在的 active。
  5. Sources 不反向依賴 Auth，也不制定通行決策；來源固定方向及身分不得由辨識 payload 覆寫。
- 當前已採用邊界摘要：Auth 處理身分與角色；Sources 處理來源資料與窄能力；Access 處理資格管理、辨識、安全查詢及共同保存協調；獨立維護命令處理 Demo 初始化與重置。此摘要不是完整 providers、imports 或檔案結構定稿，也不表示其他基礎設施或健康檢查安排已決定。
- 主張變化：`Auth／Sources 責任已區分、頂層切分仍待選` → `使用者採用兩個頂層模組及窄能力合作契約`。不把這項選擇當成合併方案不合理的證明。
- 尚未定案：整體依賴／接線圖、介面與 DTO、JWT 或其他登入格式、機器憑證格式、資料模型、MongoDB driver／保存機制、測試工具與部署細節。不新增帳號或 Source CRUD、註冊、密碼重設或角色指派。
- 待驗證：Access 不取得驗證材料的 import／注入限制、人員與 Source 越權拒絕、來源方向不可覆寫、認證失敗不記事件、新停用來源記事件及舊事件回放順序；並延續 D57、D59 的並行／故障與能力隔離驗收。目前尚未執行。
- 保存關卡：本次只追加討論紀錄並更新檢索／交接資訊，檢查後停止；不自動開啟整體依賴討論、不修改其他文件或程式。
- 依據來源：[使用者陳述] 明確同意及保存要求；D60；[專案參考：A1] 預置身分、權限、來源與冪等契約。

## 2026-09-18 認證與來源定案知識範圍與前提

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已參考・鎖定｜討論階段主 agent 實際重讀第 3.2–3.4、5.1–5.3 節，並沿用前段已讀的第 7.2 節；三 agent 各自讀取相關規格。本次保存未重讀內容，只比對檔案雜湊確認未修改。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜已參考・鎖定｜討論前重讀 D42–D43 及 D59 的暫定責任／採用狀態；本次完整讀取原 D01–D59，保留所有原 block，更新當前檢索資訊並追加 D60–D61。
- A3｜`/home/sean/work/problab_v0510`｜已參考・鎖定｜本段未重讀，不以品質參考推定 PassHub 已完成來源能力隔離。
- A4｜NestJS 官方 First steps｜已參考・鎖定｜本段未重新查詢，沒有以模組名稱或框架匯出機制充當 consumer 能力隔離證據。
- A5｜`e234xp/middlewareServer`｜已參考・鎖定｜本段未重新查核，不推定參考系統採同樣的認證或模組方案。
- 正式 agent 發言｜三角色獨立準備後只交換正式開場、挑戰、回應及仲裁｜屬設計論證，不是工程測試或多數意見證明；沒有保存內部思考。
- 使用者陳述｜對兩模組及窄能力契約的同意、本次保存要求｜屬採用決策與寫檔授權，不擴大程式實作權限。
- LLM 背景知識｜開啟｜用於認證與業務狀態區分、可信身分、能力介面及單向依賴；實際接線與工具能力仍需驗證。
- 本段沒有新增外部來源、移除或停止來源、建立新的 Q 查證分支；本次保存沒有新 agent 攻防、工程測試或維護操作。

## 2026-09-18 認證與來源定案交接資訊

- 可安全採用：D61 的 AuthModule／SourcesModule 分開及窄能力契約，D59 的 AccessModule 核心及內部分工，D57 共同保存責任，D52 每日凌晨 03:00 自動維護流程。
- 當前責任邊界：Auth 是可信身分與角色入口；Sources 分別提供認證所需能力及去憑證來源資訊；Access 是通行流程與業務判斷的協調者；維護命令在 API 程序之外執行重置。
- 下一步：整理整體依賴方向與組合接線，檢查是否存在循環、驗證材料暴露或元件繞過能力限制；不重新辯論已接受的模組分合。
- 不可假設：已確認完整檔案／介面／provider 圖、認證格式、資料模型、MongoDB 機制、健康檢查方案、排程平台或測試工具；所有工程驗收仍待完成。
- 不重開：AccessModule 採用、Auth／Sources 分開、共同保存分工及已撤回的客觀優勢主張。不以兩天或假想的新管理功能擴張架構。
- 停止點：只修改 discuss.md、驗證並回報後停止。不同步 business-scope.md、README 或履歷，不開始程式實作、不執行重置／重啟，也不執行 Git add／commit／push。

## 第二階段討論續錄：整體接線與 MongoDB 保存方向

### D62｜無循環接線不等於操作一致性，資料能力須受完整操作約束

- 討論時間：2026-09-18 11:43:36 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：三 agent 獨立準備及一組正式攻防已完成；採用決策見 D63
- 與既有結論的關係：承接 D57、D59、D61，不重開模組分合或共同責任；分別檢查程式依賴與執行資料流，不以一張資料流圖判定依賴循環。
- 捍衛騎士主張：HTTP 入口使用 Auth 取得可信人員／Source 身分並檢查角色，再呼叫 Access 用例。Access 核心接收可信身分資料並宣告窄 ports，不直接依賴 Auth、HTTP 或具體 MongoDB 實作；infra 實作 ports，由啟動組合入口接線。純業務規則不依框架、資料庫或 provider。
- 來源合作：Sources 向 Auth 提供驗證所需能力，向 Access 提供去憑證來源事實；新辨識操作的 Source、Mapping、Qualification 讀取與提交必須具有相容一致性範圍。不能把認證階段讀到的舊 active 直接當作裁決依據；回放仍優先。
- 異端辯士攻擊：承認主張已有一致性要求，不虛構允許範圍外讀取的稻草人；但 adapter 符合窄型別及由入口注入，都不能證明實際查詢受目前保存單位約束。要求可操作的合格接線及重跑契約。
- 捍衛騎士回應：接受精確化。每輪完整操作提供該輪所需的受限制讀取／保存能力，不綁入自行範圍外查詢的普通 reader；操作結束後不能繼續使用該輪能力。衝突重跑建立新範圍、重新取得資料及裁決，不沿用舊 reader、快照或計畫。關聯由 infra 維護，不把 DB session 傳入 domain。
- 仲裁賢者判斷：設計契約已補上，依賴方向維持；能力生命期是合法使用與驗收契約，不提前要求動態 token、可熱插拔 adapter 或通用管理框架。實際接線、隔離與並行測試仍欠，角色共識不是測試證據。
- 待驗收：範圍外 reader 不能導致通行 outcome；Mapping 修改／ENTRY 競爭重跑時不能沿用舊映射或舊裁決。具體檢查方式與工具未選，未執行驗收。
- 依據來源：[專案參考：A1] 第 4.4–4.5、5.3、7.2–7.3 節；D57、D59、D61；[正式 agent 發言] 三個 core_boundary agent 的獨立準備、單一攻擊、回應及仲裁；[本輪推論] 接線及能力範圍契約，非已落實的框架功能。

### D63｜使用者接受入口認證、核心窄能力及一致性接線方向

- 討論時間：2026-09-18 11:43:36 +08:00（回溯保存時間）
- 狀態：使用者已確認採用；具體組合及驗證未完成
- 使用者確認：對 D62 摘要中的「入口認證、核心不依賴外部實作、資料能力受限制，而且完整操作讀取與保存必須一致」回答「接受」。
- 已採用方向：入口負責可信身分及角色；Access 協調完整用例；純 domain 保有唯一規則；infra 實作受限制資料能力並由組合入口接線。這是責任與依賴方向，不是完整 imports／providers／檔案圖。
- 已採用限制：完整操作需要相容讀取與提交，衝突全段重跑並使用新範圍，不提交舊裁決；維持 D57 的固定首次 receivedAt、提交不明確認及有界處理。
- 尚未決定：具體 ports、身分型別、操作範圍表達、資料模型、依賴檢查工具及保存機制。不得把範圍契約寫成必須新增通用框架或已測試。
- 與舊結論的關係：D61 的「整體接線待討論」已形成採用方向，但細節仍待規劃；Auth／Sources 窄能力、Source active 與回放順序不變。
- 依據來源：[使用者陳述] 接受及後續討論選擇；D62；[專案參考：A1] 核心與一致性契約。

### D64｜MongoDB 交易作共同保存基礎，但拒絕也須保護決策依據

- 討論時間：2026-09-18 11:43:36 +08:00（回溯保存時間）
- 狀態：官方事實查核及三 agent 一組攻防完成；採用見 D65，實作未驗證
- 候選方向：MongoDB 官方 Node.js driver 多文件交易，搭配必要條件寫與資料庫唯一約束；不以記憶體鎖或事後補 Event 取代共同保存。
- 已查核事實：交易可共同提交／撤回多份資料；參與操作要使用同一 MongoClient 的 session，單一交易內不使用 Promise.all 並行。[MongoDB, Transactions — Node.js Driver，2026-09-18 查詢](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)
- 已查核邊界：交易內讀取可能是舊快照，不能由交易推斷所有讀取自動序列化；同一文件的實際寫入可形成鎖／寫入衝突。[MongoDB, Production Considerations — stale reads／write conflicts，2026-09-18 查詢](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/)
- 捍衛騎士主張：Event、必要 Presence 與 Mapping 變更在同一交易共同保存；以唯一組合鍵約束 Source＋external event ID，相關競爭需要可檢查衝突。主要風險是拒絕或未映射路徑只讀不寫，可能提交過時裁決。
- 異端辯士攻擊：ENTRY 讀到尚未 validFrom 後暫停，Operator 修改區間並先提交，ENTRY 再只保存舊拒絕 Event。若條件寫只保護成功 Presence 轉移，這筆拒絕未必觸發衝突。要求將依賴可變資格／映射的拒絕也納入採用前提。
- 捍衛騎士精確化：接受成功與拒絕均保護決策依據。已映射資格可透過讀得的內部版本條件及實際版本變更，與 Event 共同保存；版本不符或 write conflict 重讀重判，不能只做 read-compare 或 no-op。此為待選的具體例，不是使用者已指定的 version 欄位或資料模型；內部併發版本也不是業務版本歷史。
- 尚未解決：未映射查詢與並行建立綁定，需要資料模型提供共享衝突點；唯一索引不會自動證明這種查無資料的判斷仍有效。Source 讀取也須維持 D63 的相容性範圍。
- 冪等唯一約束：唯一複合索引可保證一組鍵最多一份文件；但結果回放、內容比較與 duplicate-key 競爭的分類仍是用例／保存協調責任。[MongoDB, Unique Indexes，2026-09-18 查詢](https://www.mongodb.com/docs/manual/core/index-unique/)
- 錯誤分工：整個交易的可重跑衝突，與提交結果不明不同；官方 Core API 分別說明 TransientTransactionError 的整交易重試，以及 UnknownTransactionCommitResult 的 commit 重試。[MongoDB, Transactions — Transaction Errors，2026-09-18 查詢](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/#transaction-errors) 專案仍依 D57 有界處理、固定 receivedAt，不能因 commit 回覆遺失就盲目重做業務，或將查不到結果當作已回滾。
- 部署代價：standalone 不支援交易，需使用支援交易的 replica set 或其他相容部署；本輪不決定節點數、不宣稱高可用。[MongoDB, Production Considerations — Availability，2026-09-18 查詢](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/#availability)
- 仲裁賢者判斷：已映射資格的拒絕反例在設計層得到回應；交易是原子保存基礎，不是完整並行方案已證明。先確認此方向，再進資料模型及映射衝突點，所有並行／故障驗收仍待執行。
- 依據來源：[專案參考：A1] 第 4.4、7.1–7.3 節；D57、D63；[神諭查證：A6] MongoDB 官方文件；[正式 agent 發言] 三角色正式攻防；[本輪推論] 交易、衝突保護與索引的組合。

### D65｜使用者接受交易基礎、成功／拒絕並行保護及事件鍵唯一約束

- 討論時間：2026-09-18 11:43:36 +08:00（回溯保存時間）
- 狀態：使用者已採用保存方向，完整資料模型及並行方案仍待確認
- 使用者確認：對「交易作共同保存基礎＋成功與拒絕都保護判斷依據＋資料庫唯一約束」回答「接受」；之後要求先寫文件，再討論下一題。
- 已接受方向：使用 MongoDB 官方 driver 多文件交易共同保存事件、必要資格狀態與映射變更；成功與依賴可變資料的拒絕均防止提交過時判斷；Source＋external event ID 由資料庫唯一性保證。不因拒絕而繞過必要事件保存。
- 已保留代價及限制：需要支援交易的部署與重試協調；回放、內容衝突、整操作重跑及提交不明仍按既有契約處理。未映射與並行綁定未解決，不可描述成全方案已完成。
- 未採用為細節定稿：內部版本欄位、所有狀態／Mapping 寫入方法、collection／索引完整定義、Core／Convenient API、重試上限及 timeout、driver／server 版本、replica set 節點數、部署平台及測試框架。
- 下一題：Qualification、Face Mapping 與 Access Event 的資料模型，及未映射查詢／並行綁定的共享衝突點；不重新辯論 transaction 本身是否能保證共同提交。
- 保存關卡：本次只更新 discuss.md，檢查歷史保留、編號、來源、未知及最新交接；回報證據後，依使用者本次明確授權討論下一題。不修改其他文件／程式、不執行 Git 操作或實際資料清除。
- 依據來源：[使用者陳述] 保存方向接受及「先寫文件再下一題討論」；D64；[專案參考：A1] 保存與競爭契約。

## 2026-09-18 接線與 MongoDB 保存方向知識範圍與前提

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已參考・鎖定｜接線階段重讀第 4–8 節相關片段；MongoDB 階段重讀第 4.5、5.1 等片段並沿用已讀的第 4.4、7 節。保存時只比對 hash，不宣稱本輪重新讀完整規格。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜已參考・鎖定｜接線階段重讀 D57、D59–D61 與交接；本次完整讀取原 D01–D61，所有原 block 及交接保留，只更新頂部檢索資訊並追加 D62–D65。
- A3｜`/home/sean/work/problab_v0510`｜已參考・鎖定｜本段未重讀，僅維持品質參考，不作 transaction 或 capability 已落實的證據。
- A4｜NestJS 官方 First steps｜已參考・鎖定｜本段未重新查詢，不用 Nest exports 證明消費者權限或交易範圍。
- A5｜`e234xp/middlewareServer`｜已參考・鎖定｜本段未重新查核，不將 PassHub 的交易政策描述成參考 production 的既有保證。
- A6｜MongoDB 官方文件｜已參考・鎖定｜2026-09-18 新增並實際查詢 Transactions — Node.js Driver、Production Considerations、Unique Indexes，以及 Transactions — Database Manual。採用原子保存、session／client 範圍、交易內並行限制、stale read／write conflict、交易與 commit 重試區分、唯一複合鍵與部署限制；不推定未選的實際版本／環境具備已測試相同結果。以上事實引用就近列於 D64。
- 正式 agent 發言｜三角色各自準備後交換正式主張／挑戰／回應／仲裁｜只保存可追溯的論證與變化，不保存內部思考，也不把角色一致視為多份獨立工程證據。
- 使用者陳述｜兩輪「接受」與先保存再討論的要求｜屬採用決策及限定寫檔／討論順序授權，不是程式實作授權。
- LLM 背景知識｜開啟｜用於依賴反轉、窄能力、操作範圍及決策讀取保護的一般背景；MongoDB 精確機制以 A6 查核事實為限。
- 本段沒有停止或移除來源；未決的是模型及機制，不是待查資料被默認成保證。本次保存不新增角色攻防或工程測試。

## 2026-09-18 接線與 MongoDB 保存方向交接資訊

- 可安全採用：D63 整體責任及依賴接線方向、D65 MongoDB 官方 driver 交易基礎與成功／拒絕決策保護、事件鍵唯一約束；維持 D52、D57、D59、D61。
- 下一題：討論資格、Face Mapping、事件與冪等結果的資料責任，尤其未映射與並行綁定的共享衝突點。方向未確認前不要預寫完整 schema／collection 或實作。
- 不可假設：只因使用 transaction 就序列化所有決策；unique 自動保護未映射判斷；內部 version 範例已被使用者指定；已完成 ports／provider 圖、資料模型、登入格式、retry API、節點數或部署／測試工具。
- 必須驗收：成功／拒絕讀取與保存相容、未映射與並行綁定、修改／撤銷與 ENTRY、同鍵回放／內容衝突、原子保存失敗、提交結果不明、固定 receivedAt、有界重跑；依賴及維護驗收均仍待執行。
- 本次關卡：先保存並檢查，回報證據後才開始下一題討論。後續攻防不自動代表使用者採用，不自動保存新結論；不修改 business-scope.md、README、履歷或程式，不做資料清除／重啟及 Git add／commit／push。

## 第二階段討論續錄：目前 Face 映射與首次建立競爭

### D66｜獨立目前映射，空協調紀錄也須涵蓋首次建立

- 討論時間：2026-09-18 12:28:36 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：三 agent 獨立準備及一組正式攻防完成；採用見 D67，實作與效能未驗證
- 與既有結論的關係：承接 D65 的未映射／並行綁定缺口；不重開交易、模組或操作範圍方向，不一次決定所有 collection／欄位。
- 捍衛騎士候選：按 `provider + externalSubjectId` 獨立保存目前對應及協調位，內容是目前 Qualification 引用或空狀態；Qualification 不另保存第二套權威映射。資格生命週期與釋放政策仍由唯一純 domain 決定。
- 協調契約：綁定、釋放及依映射裁決在完整交易範圍使用同鍵真實寫入競爭點，未綁定拒絕也不能只做負查或 no-op。釋放清空引用而保留協調位，不保留舊資格關聯、映射歷史、人臉或永久訪客資料。
- 技術／業務區分：Attempt 可以確保空技術位存在，但不得自行填入 Qualification 引用；只有受既有業務規則允許的管理操作建立業務綁定。空位只是「目前未綁定」的協調資料，不表示註冊訪客或完成 Face enrollment。
- 異端辯士正式挑戰：承認未映射真實寫入及保留協調位已提出；首次無紀錄時是否也把「先取得同鍵協調位並完成真實寫入，才提交 unmapped Event」列為採用前提？唯一鍵不會自行證明首次負查與綁定的排序。
- 捍衛騎士回應：接受為採用條件。首次 duplicate-key 必須辨明 subject 協調位、事件冪等鍵或其他約束，不能一律當業務重複，也不能忽略錯誤而繼續已中止交易。只有證明本輪無保存效果才整段重跑、重取資料與裁決，receivedAt 固定；unknown commit 另依 D57 確認。
- 排序驗收：未映射 Event 先提交，後續綁定可成功；綁定先提交，Attempt 應依已綁定資格裁決，不能提交舊的未映射結果。這是本輪候選精確化，不把角色回應冒充已通過驗收。
- 仲裁賢者判斷：首次建立缺口在設計層已回應；映射單一權威及空位非業務 Mapping 成立於所述契約，不代表完整 schema 已定稿。多文件寫入、空位增長、限制與每日重置代價須保留，真實並行與錯誤分類待測。
- 依據來源：[專案參考：A1] 第 4.3–4.5、7.1–7.3 節；D57、D63–D65；[神諭查證：A6] 前段已讀的交易、stale read／真實寫入衝突及唯一鍵事實；[正式 agent 發言] 三角色準備、單一攻擊、回應及仲裁；[本輪推論] 可空的目前協調位模型，官方文件不是該模型已驗證的證據。

### D67｜使用者接受獨立目前映射、可空協調紀錄與首次競爭保護

- 討論時間：2026-09-18 12:28:36 +08:00（回溯保存時間）
- 狀態：使用者已採用方向；逾期釋放及完整資料模型仍待討論
- 使用者確認：對「獨立保存目前映射、允許空的協調紀錄，而且首次建立也必須受到並行保護」回答「接受」；之後要求先寫文件再討論。
- 已採用：映射只有一份權威；對應同 subject 的綁定、釋放與辨識使用共同寫入競爭點，涵蓋首次建立及未映射拒絕。空位不自動成為業務映射、不建立 Visitor 主檔或歷史，不由 Attempt 自行關聯資格。
- 已保留邊界：撤銷、移除、替換、未入場逾期及 EXIT 應使 subject 可重用；過期 INSIDE 保留至 EXIT。這些業務規則不變，逾期後何時及如何整理實體引用尚未決定。
- 未定細節：協調位 collection／完整欄位、識別碼儲存形式、資格反查／安全查詢、精確條件寫與首次建立機制、錯誤分類、配額及完整資料模型。不把空位生命期說成永久人物資料，不新增映射管理 API、清理服務或背景排程。
- 待驗收：首次建立雙方競爭、同 subject 雙綁定、替換／釋放／辨識競爭、未映射拒絕排序、交易保存失敗及提交不明；空位資料量限制與 Demo reset 清除範圍亦待落實。
- 保存關卡：先更新 discuss.md 並驗證歷史、編號、格式、來源與未知；回報後按使用者授權討論逾期釋放。不修改其他文件／程式、不執行 Git 或實際重置。
- 依據來源：[使用者陳述] 本輪接受及先保存再討論；D66；[專案參考：A1] 映射生命週期與並行契約。

## 2026-09-18 目前映射定案知識範圍與前提

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已參考・鎖定｜上一輪實際重讀第 4.4–4.5、10–11 節片段，沿用已讀的第 7 節；本次保存只比對 hash。採用映射唯一性、釋放、禁止自動綁定及無歷史契約。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜已參考・鎖定｜本次完整讀取原 D01–D65，保留所有原 block／交接，僅更新頂部檢索資訊並追加 D66–D67。
- A3｜`/home/sean/work/problab_v0510`｜已參考・鎖定｜本段未重讀，不作新模型已驗證的證據。
- A4｜NestJS 官方 First steps｜已參考・鎖定｜本段未重新查詢，不證明協調位的交易正確性。
- A5｜`e234xp/middlewareServer`｜已參考・鎖定｜本段未重新查核，不把協調位描述成參考系統的既有模型。
- A6｜MongoDB 官方文件｜已參考・鎖定｜沿用 D64 實際查核；上一輪另查 Transactions — Database Manual 的 upsert／版本相關片段，未由此新增特定 upsert 自動重試保證。模型是本輪推論，並行及失敗分類仍待實驗。
- 正式 agent 發言／使用者陳述｜分別是模型論證、精確化及採用／保存授權｜不包含內部思考，不是工程測試。
- LLM 背景知識｜開啟｜用於單一權威、空技術位與業務綁定區分、共同衝突點；沒有新增外部來源或停止／移除來源。本次保存不新增攻防或測試。

## 2026-09-18 目前映射定案交接資訊

- 可安全採用：D67 獨立目前映射與可空協調位、首次競爭保護；D65 交易及成功／拒絕依據保護；既有模組、接線、共同保存及維護契約保持。
- 下一題：未入場資格逾期後的映射有效性及引用整理，怎麼讓識別碼可重新綁定，同時不釋放過期 INSIDE 者的 EXIT 映射。先形成精確候選，不預設背景清理、TTL 或新增管理 API。
- 不可假設：映射模型已測試、所有資格／事件 schema 已定、空位是永久人物資料、每筆 duplicate-key 都可直接重試、未知提交可盲重跑，或逾期實體引用已由排程整理。
- 關卡：本次保存、檢查、回報後才討論下一題；新攻防不自動採用或保存。不修改 business-scope.md、README、履歷或程式，不清資料、重啟或執行 Git add／commit／push。

## 第二階段討論續錄：逾期整理與永久終結

### D68｜惰性整理逾期引用，不能只靠清引用與技術版本阻止復活

- 討論時間：2026-09-18 12:50:00 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：三 agent 獨立準備及一組攻防完成；採用見 D69，reason 優先序及測試未完成
- 捍衛騎士候選：未入場逾期的映射在業務上無效、不占位，綁定／重綁或新 Face 辨識碰到舊引用時，在完整交易內惰性整理。無操作可保留尚未整理的實體引用，但不能因此判定有效或阻止合法重用；不建立背景清理排程或 TTL。
- 既有規則：INSIDE 即使逾期仍保留映射直到 EXIT；安全查詢以有效映射投影 faceBound，不因舊引用存在就回 true。普通查詢只有讀取能力，不執行清理；同鍵同內容回放仍先回舊結果，不重新映射或清理。
- 競爭反例：ENTRY 在 validUntil 前收到後暫停，期限後的操作先釋放並重綁 subject；即使 ENTRY 遇版本衝突而重跑，固定 receivedAt 仍在原有效區間，若只清引用、資格仍可依舊時間入場，就可能復活已終結資格並失去原 Face 映射。
- 捍衛騎士補足：逾期釋放／重綁先完整保存時，同時保存舊資格不可逆的終結事實；清理與 ENTRY 必須觸及相容的 subject／資格衝突點，不能只改映射引用。
- 異端辯士正式攻擊：承認終結事實可以覆蓋復活反例，但它不是技術版本號，是影響結果的業務前提；原首次 receivedAt 規則尚未明定先保存終結可以壓過較早收到的 ENTRY，也未確定 reason 優先序。要求作為需使用者確認的精確化，不能稱為版本衝突自然保證。
- 捍衛騎士回應：接受是新精確化。固定 receivedAt 用於時間條件，不推翻先完整保存的 INSIDE 或逾期終結。ENTRY 先提交就保留 INSIDE 與映射；逾期整理／重綁先提交就永久終結舊資格，舊 ENTRY 不得復活。舊 QR 保留原資格映射，在前置及較高優先條件不成立時，候選以 QUALIFICATION_EXPIRED 拒絕；完整 reason 優先序待確認。
- Face／回放結果：釋放後尚未重綁的新 Face 請求為 FACE_SUBJECT_NOT_MAPPED；已重綁的新請求依目前映射處理；原 event ID 回放不重新判斷。終結事實不新增 Presence 值、歷史映射或人工修改能力。
- 仲裁賢者判斷：競爭語義在設計層得到回應，但 reason 缺口部分未解；先確認有限方向，再只核對終結事實如何放入既有優先序，不將原規格已明定或實作已通過作為推論。
- 待驗收：截止邊界前接收／後提交的 QR／Face ENTRY 與逾期整理／重綁雙向競爭；INSIDE 逾期 EXIT、查詢 faceBound、未重綁及重綁後 Face、舊 ID 回放、原子保存失敗與提交不明。尚未執行。
- 依據來源：[專案參考：A1] 第 4.1、4.4–4.5、6.2、7.2–7.3 節；D57、D65、D67；[正式 agent 發言] 三角色正式攻防；[本輪推論] 惰性整理、持久終結及競爭語義，非新增外部查核結果。

### D69｜使用者接受惰性整理、INSIDE 保留與先提交終結不復活

- 討論時間：2026-09-18 12:50:00 +08:00（回溯保存時間）
- 狀態：使用者已採用有限方向；終結 reason 位置尚未採用，實作未驗證
- 使用者確認：對「操作時整理逾期引用、保留 INSIDE 的離場能力、先保存的終結不能復活」回答「接受」，之後要求寫文件再討論。
- 已採用：業務到期不等待排程；對未入場逾期資格，在相關寫入／新辨識完整操作中整理映射引用，普通查詢維持唯讀；過期 INSIDE 的映射保留到 EXIT。
- 已採用競爭精確化：ENTRY 與逾期整理／重綁依完整保存的先後裁決。ENTRY 先保存為 INSIDE，不得被整理掉；逾期整理／重綁先保存不可逆終結事實，較早收到但後完成的 ENTRY 不得復活舊資格。receivedAt 不刷新，仍用於其時間條件。
- 未決：終結事實的具體欄位／表示、完整拒絕優先序、觸發整理的精確操作與資料存取、query 投影機制、交易條件與測試工具。不能把持久終結等同任意 Presence setter、業務版本歷史或訪客主檔。
- 下一題：只核對已保存的逾期終結事實與既有 ENTRY reason 優先序；保留 Source／映射／撤銷／Presence 等既有高優先條件及 EXIT 特例，不擴張功能。
- 保存關卡：只更新 discuss.md、檢查並回報，再按使用者本次授權討論下一題；新候選不自動接受或保存。不修改業務規格、README、履歷或程式，不做 Git、清資料或重啟。
- 依據來源：[使用者陳述] 本輪接受及寫文件再討論；D68；[專案參考：A1] 時間與映射契約。

## 2026-09-18 逾期釋放定案知識範圍與前提

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已參考・鎖定｜上一輪主 agent 實際重讀第 4.1–4.5 節，沿用前段已讀的第 6、7 節；本次保存比對 hash，未修改。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜已參考・鎖定｜本次完整讀取原 D01–D67，保留所有原 block 及交接，更新頂部當前狀態並追加 D68–D69。
- A3｜`/home/sean/work/problab_v0510`｜已參考・鎖定｜本段未重讀，不能證明惰性整理正確。
- A4｜NestJS 官方 First steps｜已參考・鎖定｜本段未重新查詢，不作競爭語義證據。
- A5｜`e234xp/middlewareServer`｜已參考・鎖定｜本段未重新查核，不將永久終結政策描述成參考系統既有流程。
- A6｜MongoDB 官方文件｜已參考・鎖定｜沿用 D64 的限定機制事實，本段未新增外查；交易與版本衝突本身不能替使用者決定終結優先關係。
- 使用者陳述／正式 agent 發言｜限定採用、保存授權及公開論證｜不保存內部思考，不把角色共識當工程驗收。
- LLM 背景知識｜開啟｜用於邏輯有效性／實體清理、終結事實／版本區分與競爭反例；本段沒有新增、停止或移除來源。reason 未解缺口保留於 D68–D69，不虛構新 Q 查核或測試。

## 2026-09-18 逾期釋放定案交接資訊

- 可安全採用：D69 惰性整理、唯讀投影、INSIDE 保留及先完整保存終結不得復活；延續目前映射、交易、模組與共同操作契約。
- 下一題：確定逾期終結如何參與 ENTRY 拒絕優先序，明確區分自然到期與已保存的終結事實。現在只是假定較高優先條件不成立時舊 QR 應拒絕，不假定完整 reason 表已更新。
- 不可假設：business-scope.md 已同步新精確化、所有欄位已定、普通查詢會清理、存在 TTL／背景掃描、固定 receivedAt 可以復活已終結資格，或真實並行驗收已通過。
- 關卡：本次保存驗證回報後才開下一題；新結論仍須使用者確認及另行授權保存。不修改其他文件／程式，不做 Git、重置或重啟。

## 第二階段討論續錄：準時接收與使用者體驗修正

### D70｜逾期 reason 定義候選不能取代使用者體驗取捨

- 討論時間：2026-09-18 13:49:15 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：攻防完成但候選未經使用者採用；後續改由 D71–D72 重評實際承諾
- 候選主張：保留 ENTRY 的 Source、映射、撤銷、INSIDE、EXITED 高優先條件，在時間條件前檢查已保存的逾期終結；QUALIFICATION_EXPIRED 同時表示接收已超時，或裁決前已因逾期永久終結。EXIT 規則不變。
- 異端辯士攻擊：若事件 receivedAt 在有效期之前或之內，卻顯示 EXPIRED，單看時間可能被誤認為判斷錯誤；必須說清 reason 並非只代表 receivedAt 已超過期限。
- 捍衛騎士回應：接受說明缺口，以期限不符或已保存終結的兩種成因精確化定義；不新增欄位／code，不宣稱單筆事件可還原具體終結時點。
- 仲裁賢者判斷：reason 語義得到回應，完整追溯仍有限制；候選是產品選擇，不是技術唯一正解。
- 使用者追問：先詢問早到／遲到的差別，再指出可能是系統延遲導致準時請求被判逾期。主 agent 承認這不只是文字問題，而是實際體驗取捨，不能把改寫 reason 當成已解決。
- 限制：本段 reason 擴充及優先序未定案，不將其視為 D72 的處理方案。
- 依據來源：[專案參考：A1] 第 4.1、6.2–6.3、7 節；D68–D69；[正式 agent 發言] reason 攻防；[使用者陳述] 澄清與重評要求。

### D71｜重新比較準時保障與允許終結先提交的兩種承諾

- 討論時間：2026-09-18 13:49:15 +08:00（回溯保存時間）
- 狀態：兩種取捨及單組攻防已討論；具體保護機制未完成
- 使用者要求：確定準時抵達卻顯示逾期是否可接受，並說明不能接受及可以接受各自的處理方向。未做使用者訪談，不能代替真實使用者斷言接受；本輪由使用者決定作品承諾。
- 捍衛騎士重整：實體抵達或 Client 掃描不等於 server 完整收到合法請求。若不能接受，候選是在接收流程保護未決準時請求及其解析的資格／Face 對應，使清理、釋放與重綁不能越過；若接受，可保留完整提交優先，但明示準時提交不保證授權，區分接收超時與準時接收後被先終結。
- 異端辯士單一攻擊：server 已在 RAM 收到請求，卻在可恢復接收保護保存前停頓／崩潰時，清理仍看不到它。不能把保護保存成功冒充 server 已收到，或事後改稱請求未收到。
- 捍衛騎士回應：承認間隙有效。持久接收紀錄與必要占位共同保存只描述保存後保障；要涵蓋此前的準時完整接收，還需接收排序／協調及失敗歸屬。保護失敗使用技術錯誤，不偽稱接收已逾期；提交不明不能因逾時就直接解除保護。這些均為候選，不是實作保證。
- 仲裁賢者判斷：攻擊部分解決，保障起點及崩潰恢復仍待設計；先讓使用者選擇正常運作下是否保護準時接收，再設計機制，不能只改 reason。
- 已保留：單次資格、INSIDE 逾期 EXIT、狀態／必要映射／事件共同原子保存、同鍵原結果回放；不引入 Client 決策時間或允許逾期新請求的寬限。
- 尚未選擇：接收占位、持久未決紀錄、接收排序、有限保留緩衝等具體方案；其資料模型、逾時值、清理條件與恢復均未定。
- 依據來源：[使用者陳述] 重評要求；[正式 agent 發言] 三角色獨立準備及公開攻防；[專案參考：A1] 第 4.1、4.5、7 節；[本輪推論] 接收承諾與保存間隙，非新的外部查證。

### D72｜採用準時接收保障，修正 D69 的逾期終結競爭規則

- 討論時間：2026-09-18 13:49:15 +08:00（回溯保存時間）
- 狀態：使用者已接受業務方向；接收保護、故障處理與測試未完成
- 使用者確認：對正常運作下準時完整接收不因系統處理延遲被判逾期，回答「恩，我覺得這樣比較合理一點，系統還是要以用戶體驗出發」，並要求先寫文件再討論。
- 新承諾：系統正常運作下，期限內完整收到的合法 ENTRY，不得只因系統處理延遲或後續逾期清理而被判逾期。首次 server receivedAt 固定，不刷新，也不以 Client 掃描時間證明準時。
- 修正關係：D69 的「逾期整理／重綁先保存不可逆終結，即可拒絕較早收到的準時 ENTRY」不再是現行規則。D68–D69 及舊交接保留為歷史，不以不可逆終結或 version conflict 恢復該已撤回規則。終結的前提須重新設計，不能先清理再讓準時請求復活。
- 保障範圍：這只排除由系統延遲／後續逾期清理造成的業務逾期誤拒，不承諾所有準時請求都放行；來源、身分映射、撤銷、重複入場等其他規則仍要檢查，原先修改／撤銷競爭不自動改成接收優先。
- 保存與故障：必要狀態、映射及事件仍共同原子保存；保存失敗不放行，回報系統錯誤，不偽稱使用者遲到或已完成業務拒絕。提交不明須確認，不得盲目重新授權或逾時解除未決保護。
- 保留／待協調：INSIDE 逾期保留 Face 映射直到 EXIT、查詢唯讀與冪等回放不變。惰性整理不另設背景掃描的方向保留，但何時可整理、釋放、重綁及如何保護準時未決請求待重設；未採用 Face 歷史或真人雙重核對。
- 未決：保障起點及完整合法接收的觀察位置、接收至保護保存間隙、QR／Face 對應、有限處理與失敗恢復、提交不明、重置與未決保護的協調、reason 次序及真實並行驗收。不能把 RAM 記錄或持久時間戳單獨當成解決方案。
- 下一題：只比較準時接收保護如何成立、如何與逾期釋放／重綁協調；每次完成一組三 agent 攻防後停等，不自動選定或實作。
- 保存關卡：只更新 discuss.md 並檢查；不修改 business-scope.md、README、履歷或程式，不執行 Git、清資料或重啟。驗證及回報後按本次授權進入下一題，新候選另待確認。
- 依據來源：[使用者陳述] 使用者體驗優先及保存授權；D71；[專案參考：A1] 原接收時間與原子保存契約；[本輪推論] 保護要求及尚未完成的機制。

## 2026-09-18 準時接收保障知識範圍與前提

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已參考・鎖定｜沿用上一輪主 agent 重讀的第 4.1–4.5、6、7 節；本次保存比對 hash，未修改。舊文字的到期終結與準時接收衝突須依 D72 精確化，不能稱規格已同步。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜已參考・鎖定｜本次重讀頂部及 D68–D69；保存前取得全文快照，用於驗證舊正文未改，並追加 D70–D72。
- A3｜`/home/sean/work/problab_v0510`｜已參考・鎖定｜本段未重讀，不作接收保障的可行性證據。
- A4｜NestJS 官方 First steps｜已參考・鎖定｜本段未重新查詢，不作協調或恢復的正確性證據。
- A5｜`e234xp/middlewareServer`｜已參考・鎖定｜本段未重新查核，不把 PassHub 準時接收承諾描述成對方現行流程。
- A6｜MongoDB 官方文件｜已參考・鎖定｜本段無新增外查；既有交易原子性不能獨自保護尚未形成可見紀錄的接收。
- 使用者陳述／正式 agent 發言｜作品承諾、保存授權及公開論點｜不保存內部思考；沒有真實使用者接受程度調查，不以 agent 共識替代驗收。
- LLM 背景知識｜開啟｜用於接收／保存區分、競爭反例與承諾界線；本段沒有來源加入、停止或移除，也未新增外查 Q 分支。

## 2026-09-18 準時接收保障交接資訊

- 可安全採用：D72 正常運作下保障準時完整接收、不因系統延遲或後續清理誤判逾期；保持 fail-closed 原子保存、其他拒絕條件、唯讀查詢、原事件回放與 INSIDE 逾期 EXIT。
- 已取代：D69 無條件讓逾期清理／重綁先提交壓過較早準時請求；D70 的 EXPIRED 擴充不是現行處理方案。不得恢復舊結論或以改寫訊息掩蓋誤拒。
- 下一題：接收保護成立點及其與逾期整理／映射重綁的協調；先討論可驗證的候選，再處理有界失敗與恢復，不直接增加巨大 queue 或背景清理。
- 不可假設：接收占位或固定緩衝已採用、持久接收已實作、完整模型已定、接收保護可逾時任意解除、普通查詢會清理、Face 映射歷史存在，或 business-scope.md／程式已同步。
- 關卡：本次保存驗證回報後才開下一題；新結論仍須使用者確認及另行授權保存，不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：單實例接收與完整寫入協調

### D73｜從兩階段持久保護收縮為相關完整操作的接收協調

- 討論時間：2026-09-18 14:30:43 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：三 agent 獨立準備及一組攻防完成；採用範圍見 D74，排序與故障處理未定
- 捍衛騎士候選：單一 API 實例在完整 body 可觀察時，先同步固定 receivedAt 並登記未解析保護，再做非同步驗證；解析 QR／Face 後轉成持久的資格／subject 保護，解除全域未解析關卡。所有可能逾期終結或釋放／重綁的操作都參與協調，不能只保護已解析資格。
- 異端辯士單一攻擊：承認未解析保護覆蓋早期 QR 解析延遲反例；改挑戰兩階段必要性。在本輪正常運作保障下，為何不能持有接收協調直到相關完整操作得到確定結果？全域轉個別、持久保護解除增加狀態責任，持久化也不代表完整崩潰恢復。
- 捍衛騎士退守：沒有必要案例證明本輪必須兩階段持久 pending，撤回其必要論，收縮為「單實例接收登記＋相關完整操作序列」。建立、修改、撤銷及辨識中影響逾期整理／映射的相關寫入不得繞過協調；映射解析到完整保存間，後項不能改掉對應；普通查詢不串行。
- 故障限定：提交結果不明時暫阻相關後項；有界確認仍未解就停止相關寫入並回報技術錯誤，不能逾時後假設已回滾而繼續。原 event ID 的已保存結果仍先回放。
- 仲裁賢者判斷：部分解決，主張已收縮；單實例部署限制需使用者確認。精確接收點、排序／FIFO、故障恢復與吞吐代價仍未定／未量測，不能把角色共識當成完成驗證。
- 未改變：D72 的準時接收保障、其他資格條件、原子保存、INSIDE 逾期 EXIT 及回放。未把撤銷競爭改成準時 ENTRY 必勝，也未採用多實例或完整崩潰恢復保證。
- 依據來源：D72；[專案參考：A1] 第 4.1、4.4–4.5、7 節；[正式 agent 發言] 三角色獨立準備及公開攻防；[本輪推論] 接收協調方向，非新增外部查證或測試。

### D74｜接受 v1 單一 API 實例與相關完整寫入接收協調

- 討論時間：2026-09-18 14:30:43 +08:00（回溯保存時間）
- 狀態：使用者已採用限定方向；接收／排序細節與實作未驗證
- 使用者確認：對「單一 API 實例＋相關完整寫入協調」回答「接受，寫文件再討論」。
- 已採用部署前提：v1 只運行一個 API 實例，不支援多 API 實例擴容；不得將 process 內協調宣稱為跨實例保障。具體平台、啟動方式及強制單實例機制未定。
- 已採用協調方向：在接收入口先登記時間及待處理操作，再協調相關完整寫入；後來的逾期終結／釋放／重綁不能插隊，使先準時接收的合法 ENTRY 因系統延遲而失效。普通唯讀查詢不需要排進此寫入序列。
- 已採用保存界線：相關完整操作結果確定前不解除協調。提交不明時先確認；無法確認就暫停相關寫入、回報系統錯誤，不把未知當成回滾、不假裝完成可稽核的業務拒絕。
- 與舊決策的關係：承接 D72，不恢復 D69 的逾期終結先提交可壓過準時接收。D73 的兩階段持久保護不是本輪必要方案，未因此新增永久人員、Face 歷史或外部 queue；目前映射、共同原子保存、其他資格條件與 INSIDE 逾期 EXIT 保留。
- 仍未採用：精確的完整接收觀察點、FIFO 或其他排序規則、所有相關寫入的確切清單、容量／等待上限、預驗證與認證順序、斷線／重送、重啟與崩潰恢復、資料模型及協調器實作。不能把單實例本身、時間戳或一般 mutex 當成驗收證據。
- 代價與保障：寫請求可能等待；尚未做效能實驗，也未承諾跨實例、重啟後保留未決接收或完整崩潰恢復。故障仍 fail-closed，不以用戶體驗承諾掩蓋不確定保存。
- 下一題：只討論接收時間在哪個入口固定，以及相關寫入按什麼順序取得處理權；不一併定等待值、重試 API、資料模型或恢復方案。
- 保存關卡：只更新 discuss.md 並驗證回報，再依本次授權完成下一題的一組攻防。新候選另待確認，不修改 business-scope.md、README、履歷或程式，不執行 Git、清資料或重啟。
- 依據來源：[使用者陳述] 採用及保存授權；D73；[專案參考：A1] 原子保存及時間契約。

## 2026-09-18 單實例完整寫入協調知識範圍與前提

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已參考・鎖定｜沿用前段讀過的時間、映射及事件契約；本次保存比對 hash，未修改，不能宣稱業務規格已同步 D72、D74。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜已參考・鎖定｜本次重讀頂部與 D70–D72，取得全文快照以驗證舊正文保留，追加 D73–D74。
- A3｜`/home/sean/work/problab_v0510`｜已參考・鎖定｜本段未重讀，不作協調正確性證據。
- A4｜NestJS 官方 First steps｜已參考・鎖定｜本段未重新查詢，不宣稱特定入口 hook／middleware 已選定。
- A5｜`e234xp/middlewareServer`｜已參考・鎖定｜本段未重新查核，不把單實例序列方案描述成對方現行實作。
- A6｜MongoDB 官方文件｜已參考・鎖定｜本段無新增外查；共同交易保留，但單實例協調不替代原子保存，也不證明提交不明已處理。
- 使用者陳述／正式 agent 發言｜採用、保存授權及公開論點｜不保存內部思考，不把三角色共識當測試結果。
- LLM 背景知識｜開啟｜用於序列協調、未解析保護與恢復界線；本段沒有來源加入、停止或移除，也未新增外查 Q 分支。

## 2026-09-18 單實例完整寫入協調交接資訊

- 可安全採用：D74 單一 API 實例與相關完整寫入接收協調；D72 準時接收保障；普通查詢不串行，其他資格條件、共同原子保存、原結果回放及 INSIDE 逾期 EXIT 保留。
- 已撤回：兩階段持久保護在本輪是必要方案的主張；未因此承諾完整恢復或採用額外資料模型。
- 下一題：完整接收觀察點與處理排序；在任何非同步認證／資料庫操作前如何保留順位，避免驗證速度或 DB 取得鎖的先後變成接收排序。
- 不可假設：FIFO 已採用、所有 HTTP 或唯讀查詢要串行、mutex 支援多實例、提交不明可逾時釋放、存在持久接收／背景 queue，或 business-scope.md／程式已同步。
- 關卡：保存驗證回報後再開下一題；新候選仍待使用者確認及另行保存，不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：完整接收點與相關寫入 FIFO

### D75｜全 FIFO 比只保護逾期競爭更廣，撤銷超車需明確取捨

- 討論時間：2026-09-18 14:54:48 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：三 agent 獨立準備及一組攻防完成；採用見 D76，入口機制與時間上限未驗證
- 捍衛騎士候選：完整 body 可由應用入口觀察、完成同步大小／基本 JSON／准入檢查後，同步固定首次 receivedAt 與單調序號，在非同步認證或 DB 操作前登記；相關寫入依登記序 FIFO 取得完整操作權，同毫秒依序號，普通查詢不排隊。登記不是授權，也不是 Client 掃描、TCP 首 byte 或 DB 保存時間。
- 異端辯士單一攻擊：合法 ENTRY 先登記但認證較慢時，較晚撤銷即使能先完成，也會被迫等待。全 FIFO 排除原先可能的撤銷超車，比 D72 只禁止後續逾期整理／重綁越過更廣；它不是準時保障的唯一必要條件。
- 捍衛騎士回應：承認有效，維持 FIFO 作候選而非必然。理由是統一、可解釋的操作順序，不另訂哪些後項可越過；代價是撤銷等待及單實例寫入吞吐限制。若要保留撤銷超車，可採只限制逾期操作的部分排序，但須另定競爭協調。
- 前置順序限定：入口預檢僅限同步傳輸／基本格式／准入；正式認證、業務 envelope 驗證、冪等順序保留。認證／格式／限制失敗不建 Access Event；已保存原 ID 回放不是新授權，不重新映射或判斷 inactive。
- 仲裁賢者判斷：攻擊部分解決，產品選擇仍需確認；FIFO 與部分排序均為候選，不能把 D74 當作已接受全 FIFO。下一步直接交使用者選定，再討論容量／等待／故障。
- 限制：未選特定 NestJS hook、計時 API、協調器型別、容量或等待秒數，未做效能及入口實作驗證。
- 依據來源：D72–D74；[專案參考：A1] 第 4.1、4.4–4.5、5、7 節；[正式 agent 發言] 公開攻防；[本輪推論] 全 FIFO 的產品取捨，非新增外部查證。

### D76｜接受入口同步記錄接收時間／序號及相關完整寫入 FIFO

- 討論時間：2026-09-18 14:54:48 +08:00（回溯保存時間）
- 狀態：使用者已接受接收及排序方向；時間上限與實作未驗證
- 使用者確認：對「相關寫入統一先完整收到、先取得處理權，包含撤銷也不插隊」回答「接受」，並要求先保存，再討論排隊等待與開始執行後的時間上限。
- 已採用接收點：完整請求 body 進入應用可觀察的入口、完成同步大小／基本 JSON／准入檢查時，同步固定首次 server receivedAt 與序號並登記。中間不插入非同步認證或 DB 等待；不等認證完成、取得 DB 鎖或保存成功才取號，不以 Client 掃描或網路首 byte 作決策時間。
- 已採用排序：資格建立、修改、撤銷、QR／Face 辨識及其附帶的逾期整理／映射釋放／重綁等相關完整寫入，以登記序 FIFO 取得處理權；同毫秒使用序號區分先後。普通唯讀查詢不排進此寫入序列，不串行所有 HTTP 或登入操作。
- 與原競爭規則的關係：明確接受後到撤銷不能越過較早入場請求；先修改成功，後 ENTRY 依完整新資料判斷；先 ENTRY 成功，後修改／撤銷失敗。較早 ENTRY 若未入場，後續撤銷仍依規則判斷，不保證一定成功或準時 ENTRY 必勝。
- 保留前置／保存契約：登記不代表身分可信或取得資格；正式 Auth → 業務格式 → 冪等前置順序保留。認證／格式／限制失敗僅技術紀錄，新合法嘗試仍保存 Access Event；既存結果原樣回放，必要狀態／映射／事件共同原子保存後才回通行結果。
- 保留保障：D72 準時接收不因自身延遲／後續逾期清理誤拒、D74 單一 API 實例、提交不明先確認而非逾時解除協調，以及 INSIDE 逾期 EXIT。FIFO 不代替 MongoDB 交易、唯一性或整合驗收。
- 未決：排隊等待與開始執行的精確分界、兩種上限及其計時起點／數值、取消與開始的競爭、慢認證、排隊容量、斷線／重送、已發出 DB 操作的停止證據、提交不明確認與恢復、維護／重啟協調、入口 hook 與實作工具。
- 下一題：只區分排隊等待與開始執行後的時間上限，說明何時可確定沒有業務副作用而取消，何時必須保留協調並確認結果；不先選任意秒數，不把逾時等同已回滾。
- 保存關卡：只更新 discuss.md 並驗證回報，再完成下一題一組三 agent 攻防；新候選另待確認。不修改 business-scope.md、README、履歷或程式，不執行 Git、清資料或重啟。
- 依據來源：[使用者陳述] 採用及保存／下一題授權；D75；[專案參考：A1] 原前置、時間與保存契約。

## 2026-09-18 接收排序定案知識範圍與前提

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已參考・鎖定｜沿用前段已讀的時間／修改／映射／事件契約，本次比對 hash 未修改；原 first-completed 競爭已由 D76 的 FIFO 精確化，不能稱規格已同步。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜已參考・鎖定｜本次重讀頂部及 D73–D74，取得全文快照作舊正文保留檢查，追加 D75–D76。
- A3｜`/home/sean/work/problab_v0510`｜已參考・鎖定｜本段未重讀，不作 FIFO 或時間上限的正確性證據。
- A4｜NestJS 官方 First steps｜已參考・鎖定｜本段未重新查詢，不宣稱具體入口機制已完成。
- A5｜`e234xp/middlewareServer`｜已參考・鎖定｜本段未重新查核，不把接收 FIFO 描述成對方現行流程。
- A6｜MongoDB 官方文件｜已參考・鎖定｜本段無新增外查，逾時／提交不明的具體 driver 行為未在此重新驗證。
- 使用者陳述／正式 agent 發言｜接收排序決策、保存授權及公開攻防｜不保存內部思考，不以角色共識替代工程證據。
- LLM 背景知識｜開啟｜用於接收順位／完成競爭的區分；本段無來源加入、停止或移除，也未新增外查 Q 分支。

## 2026-09-18 接收排序定案交接資訊

- 可安全採用：D76 應用入口同步接收時間／序號及相關完整寫入 FIFO，撤銷不插隊；D72、D74 的準時保障與單實例前提，以及其他資格條件、共同原子保存、唯讀查詢與原事件回放保留。
- 已精確化：D74 的未定接收點／FIFO 由 D76 定案。原 first-completed 的可能超車結果收窄，不以用戶體驗承諾恢復任意超車或讓 ENTRY 全面優先。
- 下一題：排隊等待與執行上限；必須分清取消尚未開始、已發出操作、已知回滾及提交不明，不把 timer 到點當作停止或回滾證據。
- 不可假設：秒數、容量、計時 API、取消工具、driver timeout／abort 行為或崩潰恢復已定；不串行普通查詢，不新增多實例，不假設 business-scope.md／程式已同步。
- 關卡：保存驗證回報後才開下一題，新候選仍待使用者確認及另行保存；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：等待回覆上限不取消準時簽到

### D77｜排隊逾時取消與重送重新計時的候選被使用者體驗反例推翻

- 討論時間：2026-09-18 16:05:10 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：三 agent 公開攻防已完成；排隊取消候選未採用，由 D78 取代
- 捍衛騎士原候選：WAITING 從登記起算，到期若取消勝過取得完整操作權，永久禁止晚到執行，回技術忙碌而非 EXPIRED／業務 REJECTED，不建 Event；RUNNING 從取得操作權起算，到期停止新增步驟／重跑並請求終止，不證明回滾。結果確認另留有限預算，完整保存則回放，確認無保存效果且無晚寫才釋放後項；結果不明未解就停相關寫入。
- 異端辯士單一攻擊：接受候選已排除取消後晚寫與逾時等於回滾；仍未定確定取消後同 external event ID 重送是否延續原 receivedAt。未建 Event 時沒有結果可回放，重新計時可能讓準時到達者變成逾期。
- 捍衛騎士當時調整：建議確定未執行且取消後，原準時保障終止；同鍵重送查無保存結果則作新接收項，使用新時間與目前映射。RUNNING 提交不明不能套用此政策盲目重做。這是 D72 的待確認縮限，不是既有決策。
- 仲裁賢者當時判斷：攻擊命中；候選需要使用者明確接受，不能當成實作細節。取消互斥、晚寫隔離及資料庫結果確認均未驗證，本輪沒有新增具體 driver API 能力主張或外查。
- 使用者反例：指出人已在有效時間內簽到，若因系統忙碌被迫重送才逾時，不符合原準時接收保障。
- 主張變化：撤回「排隊逾時確定取消後，重送以新時間判斷」的候選，不以第一次回應是 busy 而非 EXPIRED 掩蓋最後仍因系統延遲誤拒的體驗。
- 紀錄邊界：上述為既有三 agent 正式攻防及隨後使用者修正；沒有在修正後重新啟動三 agent，不能冒稱新版已經角色仲裁或工程驗證。
- 依據來源：D72、D74、D76；[正式 agent 發言] 三角色公開攻防；[使用者陳述] 準時簽到體驗反例；[本輪推論] 期限政策取捨。

### D78｜接受回覆等待有上限，但不因排隊超時取消原簽到或刷新接收時間

- 討論時間：2026-09-18 16:05:10 +08:00（回溯保存時間）
- 狀態：使用者已接受修正原則；期限數值、機制與故障驗收未定
- 使用者確認：對「回覆等待可以有上限，但準時收到的簽到不應只因系統處理慢而變成遲到」及同一事件重送延續原處理的修正回答「好」。沿用逐項保存至 discuss.md 的工作節奏，只保存本輪已接受原則。
- 已採用準時保障：在 D76 的接收點正式登記、正常運作中仍有效的同一簽到項，保留原 receivedAt 與處理順位；僅因排隊等待／等待回覆超時，不取消其簽到，不失去準時資格，也不將超時當成業務 EXPIRED。登記仍不等於授權，其他條件照既定規則判斷。
- 已採用回覆界線：等待回覆到上限，只能表達目前尚未取得處理結果；不能聲稱已失敗、已取消或已回滾。具體 HTTP status、DTO 與等待／處理中回應方式尚未選定，不因此新增完成結果或無 Event 的業務拒絕。
- 已採用重送語義：同一 source＋external event ID、相同內容的重送，若原項仍在排隊或執行中，關聯原處理並等待／查其結果，不新增一份業務操作，不刷新原時間。已保存時依原冪等契約回放；相同鍵不同內容不得被當成新的相同事件，既定衝突契約保留。正式認證與格式驗證順序仍保留。
- 執行後超時：繼續遵守 D57、D74 的確定結果界線。計時器或 client 斷線不證明已發出命令停止或交易回滾；完整保存結果仍為權威，確認無保存效果且不可能晚寫才可放後項。提交不明先有界確認，仍不明則停相關寫入，不靠重送盲目重做。
- 未承諾：無限排隊、無限執行、任何準時請求必定通行，或資料庫故障／重置／程序崩潰後仍能恢復未完成接收項。容量滿時的接收前拒絕、伺服器已登記但尚未完成項的有限處理保障，以及 maintenance 邊界需另外確認；不把這些未知當成可以任意撤銷正常運作中的原準時保障。
- 與既有決策的關係：維持 D72、D74、D76，不採用 D77 取消後以新 receivedAt 重送的縮限。維持單一實例、FIFO、必要狀態／映射／Event 原子保存及 INSIDE 逾期 EXIT；不新增持久 pending、歷史 Face mapping、外部 queue 或跨程序恢復方案。
- 待討論與驗證：HTTP 回覆等待、實際排隊、開始執行及結果確認的上限各限制什麼、起算點與數值；長時間佔用／故障後的停寫與恢復；同鍵在途重送的追蹤及內容衝突；容量准入；認證失敗與斷線；重置協調。需要驗收等待超時後仍按原時間執行、同鍵不重複執行，以及結果不明時不釋放關卡。
- 下一題：先區分「呼叫端等待回覆」與「伺服器實際執行／確認結果」兩種期限的責任，不先選秒數，不恢復自動取消已接收排隊項的候選。
- 保存關卡：本次只保存並驗證 discuss.md；新一輪攻防須依後續選擇推進。未修改 business-scope.md、README、履歷或程式，未執行 Git、清資料或重啟。
- 依據來源：[使用者陳述] 準時體驗要求及修正接受；D72、D74、D76；D77 演化紀錄。此為採用政策，非已完成成果。

## 2026-09-18 等待回覆與準時保障知識範圍與前提

- A1｜`/home/sean/PassHub/docs/business-scope.md`｜已參考・鎖定｜沿用先前時間與原子保存契約，本次比對 hash 未修改，不宣稱已同步 D78。
- A2｜`/home/sean/PassHub/docs/discuss.md`｜已參考・鎖定｜本次重讀檢索卡及末尾 D73–D76，取得完整快照以驗證舊正文保留，追加 D77–D78。
- A3｜`/home/sean/work/problab_v0510`｜已參考・鎖定｜本段未重讀，不作期限處理正確性證據。
- A4｜NestJS 官方 First steps｜已參考・鎖定｜本段無重新查詢，具體回覆或取消 API 未選定。
- A5｜`e234xp/middlewareServer`｜已參考・鎖定｜本段無重新查核，不描述成對方現行期限政策。
- A6｜MongoDB 官方文件｜已參考・鎖定｜沿用交易與提交不明界線，本段未新增查詢或宣稱 driver 取消能力已驗證。
- 使用者陳述／正式 agent 發言｜本輪反例、修正接受及先前公開攻防｜分開標記；不保存內部思考，不冒稱新版完成第二輪三 agent 仲裁。
- LLM 背景知識｜開啟｜用於回覆等待與實際操作生命期的區分，無來源加入、停止或移除，無新增外查 Q 分支。

## 2026-09-18 等待回覆與準時保障交接資訊

- 可安全採用：D78 的回覆等待超時不取消仍存活的原簽到、不刷新 receivedAt；同鍵相同內容重送關聯原項；已保存原樣回放。D72、D74、D76 及其他授權條件與原子保存保留。
- 已撤回：D77 的排隊超時取消、原準時保障終止及取消後重送重新計時候選；不能在後續選秒數時悄悄恢復。
- 下一題：回覆等待與實際執行／結果確認的期限責任；仍需三個獨立 agent 公開攻防，使用者確認後才能保存新的採用方向。
- 不可假設：秒數、容量、處理中 API、在途追蹤、持久接收、崩潰恢復或 driver abort 已實作；client 超時不代表資料庫回滾，不承諾無限等待或全部請求必定成功。
- 關卡：保存驗證回報後停等下一輪；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：資料庫故障與結果不明的停寫界線

### D79｜有限自動處理不等於保證有限時間內完成業務結果

- 討論時間：2026-09-18 18:18:02 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：三 agent 獨立準備與一組公開攻防已完成；細節仍為候選，接受範圍見 D80
- 捍衛騎士候選：開始執行後的新工作期限與結果確認期限分開。到期停止新增業務步驟／重跑並申請停止已發出的命令，不能推定回滾；確認完整保存則回原結果，無保存效果且不可能晚寫才具備安全釋放的證據。原簽到未完成時不因此刷新 receivedAt 或取消準時保障。
- 異端辯士單一攻擊：停寫只是安全姿態，沒有有限完成的終局；永久等待恢復可能無限佔用關卡，每次恢復重新給完整預算也可能無限重跑。要求釐清跨停止／恢復的有限處理界線。
- 捍衛騎士調整：承認部分命中，撤回停寫能保證有限完成／恢復可用的暗示。提出原項跨恢復共用總處理／確認預算及有限重跑次數、恢復不補滿預算的候選；耗盡不再自動執行，報技術故障而非 EXPIRED。提交未知仍停相關寫入，沿既有 D52 隔離後維護流程處理，但不保證重置成功或未完成項跨重置延續。
- 仲裁賢者判斷：部分解決，只限制自動處理，不保證業務完成或恢復可用。確定無效果的技術失敗與提交未知不能混同；停相關寫入不代表必須停全部唯讀。故障取捨須使用者確認，具體機制未驗證，本輪無新增外部查證。
- 使用者理解停等：使用者表示看不懂；主 agent 改以「準時接收但晚處理」對比「資料庫沒有回覆、可能已保存」澄清，不把先前複雜候選直接視為已接受。
- 依據來源：D52、D57、D72、D74、D76、D78；三角色正式公開發言；本輪一般推論，非實作或故障測試證據。

### D80｜接受資料庫結果無法確認時暫停相關通行操作

- 討論時間：2026-09-18 18:18:02 +08:00（回溯保存時間）
- 狀態：使用者已接受安全／可用性取捨；預算與恢復細節未定
- 使用者確認：對白話問題「真的遇到資料庫故障、結果查不清楚時，能接受 Demo 暫時不能進行通行操作，而不是冒險繼續嗎？」回答「可以」。
- 已採用：資料庫結果先花有限時間確認；完整保存則以已保存結果為準，確認沒有保存且不會再晚寫則報技術故障；結果始終不明時暫停相關通行寫入，不回假成功、不盲目重跑、不解除未決操作的協調讓後項繼續修改相關資料。
- 未改變：正常運作中的系統忙碌／排隊延遲仍保留首次 receivedAt，同鍵在途重送不刷新時間，不把系統故障誤報成訪客遲到或資格 EXPIRED。timer 到點、client 斷線或查不到 Event 都不是已回滾證據。
- 接受範圍：只確認「故障結果不明時寧可暫停相關通行，也不冒險繼續」。不自動批准 D79 的跨恢復共用總預算、精確起算點、重跑次數、無效果原項的終局、重送失敗回應、故障自動重置或跨重置延續政策。
- 已知代價：故障期間不能保證通行可用；不保證有限時間內必定取得結果或恢復。普通唯讀是否可用仍依資料庫狀態，不要求無條件提供可用性。D52 的維護隔離前提保留，沒有實際停止、清除或重啟。
- 待驗證：保存成功但回覆遺失、確定未生效且禁止晚寫、提交未知、結果確認耗盡後停寫、同鍵重送，以及恢復前的安全確認。driver、時間數值與恢復工具尚未選定。
- 依據來源：使用者白話澄清後的接受；D79 攻防演化；D57、D74、D78。此為採用政策，不是完成工程成果。

## 2026-09-18 資料庫故障停寫交接資訊

- 當前採用：D80 結果不明時暫停相關通行寫入；D78 正常忙碌不取消準時資格、原同鍵關聯及時間保留；共同原子保存與原結果回放保留。
- 來源：A1–A6 範圍及鎖定狀態沿用既有紀錄。主 agent 本輪保存重讀檢索卡／末尾並取得完整快照比對，A1 只比對 hash 未修改；沒有新增外查或來源變更。三 agent 的公開論點與使用者接受分開標記；LLM 背景知識開啟，不作 driver 能力或故障驗證證據。
- 下一題建議：結果不明而停寫後，如何確認可以恢復；與已採用 D52 維護流程銜接，先確認責任與安全條件，不急著挑秒數或新增完整恢復系統。需另經使用者選擇及三 agent 攻防，不自行採用。
- 不可假設：所有 D79 候選已接受、故障必定可恢復、超時就是回滾、重啟能自動取消已發出資料庫命令，或 business-scope.md／程式已同步。
- 關卡：本次只更新 discuss.md 並驗證後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：恢復安全與原簽到的使用者體驗

### D81｜恢復須同時具備資料安全與服務當下允許，維護否決舊許可

- 討論時間：2026-09-19 01:31:22 +08:00（回溯保存時間，非原回合時點）
- 狀態：前段三 agent 攻防候選；續辦採用範圍由 D83 明確限定
- 初始候選：原資料恢復須確認原項完整保存或確定沒有保存效果，且舊操作不會晚寫。完整保存回原結果；無效果不代表取消原簽到，續辦尚待確認；未知維持停相關寫入。連線、health check 或查不到 Event 不足以解除未知關卡。
- 工程異端挑戰：原資料安全證據取得後，凌晨維護可能已開始；若仍憑舊恢復許可開寫，會越過 D52 的隔離階段。資料安全不等於當下獲准恢復。
- 捍衛調整：增加服務當下允許條件，維護開始否決舊恢復許可；恢復與維護必須共同協調，不得先檢查再拿過時許可開寫。維護期間依 D52 隔離、重建成功才啟動，失敗維持不可用。
- 仲裁：政策缺口已解，協調機制未驗證。原資料恢復與清資料重建是不同路徑，不把清資料當成所有安全恢復的必要條件。
- 使用者停等：沒有立即接受三條件整份方案，而是要求更多自動辯論及新增 UX 異端；不得把後續白話接受推廣成所有恢復細節已定案。
- 依據：D52、D74、D78、D80；三角色正式公開發言，非新增外部查證或測試。

### D82｜新增獨立 UX 異端，兩輪攻防補上續辦責任與晚到通知的控制權

- 討論時間：2026-09-19 01:31:22 +08:00（回溯保存時間）
- 狀態：使用者指定新角色分工已執行；兩輪形成候選，採用範圍見 D83
- 角色調整：新增 `/root/core_boundary_ux_heretic`，以不繼承其他角色對話的獨立上下文準備，聚焦使用者等待、重送、準時保障及展示可理解性；原 `/root/core_boundary_heretic` 聚焦系統一致性與工程風險。捍衛與仲裁仍各由原獨立 agent 擔任。此為不同評審角度，不宣稱模型或統計獨立。
- 交換與節奏：第一階段不交換他方準備；之後只傳正式候選、攻擊、回應及仲裁，不交換隱藏思考。使用者授權更多自動辯論，本次完成兩輪，每輪固定一名異端 → 捍衛 → 仲裁，不把兩名攻擊者塞進一組攻防。今後沿用兩位異端的分工及分輪節奏。
- UX 異端第一輪：承認保留原時間已解重新計時；指出全局服務可用不等於原項正在續辦，測試者不知道誰推進、該等待或重送，API-only 展示不能靠解說者補完。
- 捍衛回應：確認安全且獲准續辦後，由伺服器推進原項；同鍵重送只關聯狀態／結果，不建立新工作、不負責啟動續辦。API 分開表達整體服務與原項進度，不能把暫停項說成正在處理。批准責任與機制仍未定，沒有要求逐項人工批准或新增 Operator 管理 API。
- 第一輪仲裁：政策部分解決，新增 UX 約束仍待採用；建議第二輪檢查舊完成通知的處理權。
- 工程異端第二輪：舊項已處理、下一項取得處理權後，舊 finally 再解除關卡可能誤放後項；舊 failure callback 也可能誤停恢復後服務。這些風險不需要再次寫 DB。
- 捍衛回應：晚到通知只能作用於自己原有的處理權，不能解除新項的關卡；原項只完成一次，已解決項的舊通知只作去敏技術紀錄。若揭示未解安全疑慮或真正新故障，仍須重新判斷，不一律忽略。
- 第二輪仲裁：控制權挑戰在政策層已解，處理權識別與兩種競爭測試未完成；兩輪授權結束後交使用者選擇，不繼續自動攻防、不宣稱工程已成立。
- 依據：D81；使用者新增角色及自動辯論要求；四 agent 的正式公開論點與本輪推論。無新增外查來源，不作真實使用者研究證據。

### D83｜接受未重置且確認安全後，由系統續辦原簽到並清楚回報進度

- 討論時間：2026-09-19 01:31:22 +08:00（回溯保存時間）
- 狀態：使用者白話澄清後接受方向；具體恢復及回應契約未定、未實作
- 使用者確認：先表示看不懂；主 agent 改以「9:59 簽到後資料庫故障，故障排除後系統續辦，不要求重新簽到」說明。對「原資料尚未重置，確認安全後由系統接著處理原簽到、保留準時紀錄並清楚回報進度」回答「ok」。
- 已接受續辦方向：原項仍存在、原資料未重置且確認可安全續辦時，由系統負責接續原操作，保留首次 receivedAt 與 FIFO 順位，不要求測試者重新簽到或用重送叫醒工作；已完整保存則回原結果，不重做。
- 已接受重送與進度方向：同一 source＋external event ID、相同內容重送，只關聯原項的進度／結果，不產生另一筆簽到、不重新計時。API 要明確區分故障暫停、等待／正在處理及完整結果，而非含糊地一直要求等待；具體狀態名稱、HTTP status、DTO 與路徑未定。
- 工程驗收要求：舊操作與晚到通知不得干擾下一筆處理權，屬實作須驗證的正確性要求；白話接受不等於使用者選定鎖、callback、owner 識別或其他具體機制。維護不得被恢復流程越過，沿用 D52 的安全隔離前提。
- 保留故障界線：D80 結果不明仍停相關寫入，不冒險放行；續辦不等於任意重做未知提交，也不保證準時項一定獲准通行。登記、授權、必要狀態／映射／Event 原子保存與其他拒絕條件保留。
- 未一併採用：自動或人工恢復的選擇、獨立恢復管理 API、逐項人工批准、秒數與重試次數、跨恢復共用總預算、故障必定有限完成、未完成項跨程序崩潰／重置延續、持久 pending 或新背景平台。不得把「故障排除後續辦」解讀成已批准完整自動復原系統。
- 待驗證：原資料恢復後同項原時間續辦、同鍵不重複啟動、API 不誤報進度、舊 finally 不解除新處理權、舊錯誤不誤停服務，以及維護否決已過時恢復許可。未執行任何測試、重啟或重置。
- 依據：使用者白話接受；D82 演化；D72、D74、D76、D78、D80 的既有契約。

## 2026-09-19 原簽到續辦交接資訊

- 可採用：D83 的未重置／原項仍存在下安全續辦、原時間及順位保留、伺服器推進與同鍵進度關聯。D80 未知停寫、D78 正常延遲準時保障保留。
- 討論方式：D82 的 UX 與工程兩位獨立異端，各自準備再分輪攻防；捍衛與仲裁各自獨立。新一輪仍須使用者選擇，不以角色共識替代採用或驗證。
- 來源：A1–A6 範圍與鎖定狀態沿用；本次主 agent 重讀 discuss.md 檢索卡及末尾、取得完整快照做歷史保留檢查，business-scope.md 僅比對 hash 未修改，其餘來源未重讀或重新查詢。使用者要求／接受、正式 agent 論點與一般推論分開標記；LLM 背景知識開啟，無新增外查 Q 分支。
- 下一題建議：恢復由誰發起，以及如何接上現有獨立維護命令；先比較維護者確認後恢復與有限自動確認後恢復的責任，不急著建立新管理 API 或無限制重跑。尚未選定，待使用者決定是否繼續辯論。
- 不可假設：三項安全條件已有可驗收證據、恢復工具已選、自動恢復已完成、故障一定能恢復、原項一定跨重置延續，或 business-scope.md／程式已同步。
- 保存關卡：只更新 discuss.md、驗證後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：有限自動確認與人工介入

### D84｜工程與 UX 攻防將人工優先修正為有限自動確認、維護者兜底

- 討論時間：2026-09-19 01:37:31 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：兩輪自動攻防完成；採用範圍見 D85
- 捍衛初始候選：維護者發起、仍存活的原 API 程序執行安全確認；人工只請求不能強解鎖。私有通知方式未定，不假定外部命令能直接操作 process 內原項，也不增加公開 Admin 能力。自動發起同樣可比較，但觸發與重試邊界未定，因此暫偏人工優先。
- 第一輪工程異端：人的請求不能替已耗盡的執行預算創造新機會；確認無效果只證明不會撞到舊工作，不代表原項仍可以再執行。要求分開「發起安全確認」與「批准新的執行機會」。
- 捍衛調整：承認，人工請求只啟動確認，不補滿執行預算；完整保存後回放原結果不是重新執行。無效果原項仍須具備可續辦條件；耗盡或尚未決定時不宣稱恢復成功，也不直接放後項。
- 第一輪仲裁：部分解決，責任已分開；不必現在挑數值才比較人工／自動發起。建議第二輪由 UX 檢查等待維護者的代價。
- 第二輪 UX 異端：正常有限確認耗盡後，若恢復只等維護者，即使安全、服務許可與既有執行條件後來可確認，都仍增加等人時間，可能中斷求職 Demo。接受安全與有界要求，但挑戰人工依賴的必要價值。
- 捍衛調整：撤回人工優先，改為有限自動發起確認；符合安全條件、當下服務許可及既有可續辦條件才自行續辦。確認不了就維持停寫，交給維護者；不只憑連線恢復就續辦，不引入大型恢復後台。
- 最終仲裁：UX 挑戰部分解決，方向改混合候選，與 D80、D83 相容；界線與機制未驗證。自動／人工均不能默默補滿耗盡預算，另批執行機會與跨重置保障仍未定。
- 來源與證據：D52、D57、D80–D83；四個獨立 agent 的公開論點，兩輪各一次異端 → 捍衛 → 仲裁；無新增外查或故障測試，不保存隱藏思考。

### D85｜接受有限自動確認，無法確認時人工介入

- 討論時間：2026-09-19 01:37:31 +08:00（回溯保存時間）
- 狀態：使用者已接受混合分工；數值、觸發與實作未定
- 使用者確認：對「有限自動恢復，無法確認時人工介入」回答「接受」。前段白話方案明確以有限確認、安全條件齊備及不無限重試為前提。
- 已採用分工：原程序先在有限範圍內自動發起確認；可證明原結果完整保存，則回放原結果。若確定無保存效果且舊工作不會晚寫、目前服務允許、原項仍符合續辦條件，則由伺服器接續原操作，不必只因人工尚未到場而等待。
- 已採用失敗界線：自動確認仍無法證明安全時，保持相關通行寫入暫停並明確交維護者處理，不盲目重做、不假成功、不將未知當回滾。人工介入不是一鍵強解鎖，也不能跳過相同安全條件。
- 保留前提：D83 的原項仍存在、原資料未重置、原接收時間與 FIFO 順位保留及同鍵進度關聯；D80 未知停寫；D52 維護否決恢復、隔離舊操作、重建成功才啟動。重送不啟動新的恢復輪次、不刷新原接收時間。
- 未一併採用：自動確認的觸發方式、次數／窗口／秒數、總處理與確認預算的具體規則、耗盡後另批執行機會、私有通知或恢復命令介面、任何新公開管理 API、自動清資料／重啟工具、跨崩潰／重置延續、故障必定可恢復或有限時間必定完成。
- 待驗證：安全證據成立時自動續辦、無證維持停寫、有限確認用完不無限重啟、重送不增加執行／恢復輪次、維護與恢復競爭、人工不能繞過安全條件，及舊通知不改新處理權。未實際執行恢復或測試。
- 依據：使用者接受；D84 攻防；D80、D83。這是採用方向，不是已完成工程成果。

## 2026-09-19 有限自動確認與人工介入交接資訊

- 可採用：D85 混合分工，有限自動確認、安全齊備才續辦、證據不足停寫交維護者。D83 原項／時間／順位與同鍵進度關聯、D80 未知停寫保留。
- 已撤回：D84 初始的人工優先建議；人工並非資料安全的必然要求，不因維護者不在而阻止已符合條件的有限自動續辦。
- 來源：沿用鎖定 A1–A6；本次保存重讀 discuss.md 檢索卡與末尾、取得全文快照作歷史保留檢查，business-scope.md 僅比對 hash，其餘來源未重讀或重新查詢。正式角色論點與使用者採用分列；LLM 背景知識開啟，沒有新增外查 Q 分支。
- 下一題建議：先定自動確認與原操作執行各自的有界規則，避免每次重送或恢復都重開一份無限制機會；起算點、次數與時間值尚未決定，需依後續選擇辯論。
- 不可假設：恢復工具、排程、driver abort 能力或所有預算已定，或 business-scope.md／程式已同步。不得把混合分工變成無限自動重跑或提交未知時解鎖。
- 保存關卡：本次只更新 discuss.md、驗證後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：自動確認額度與晚到結果

### D86｜兩輪攻防補清失敗計次，以及確認停止不等於原項取消

- 討論時間：2026-09-19 01:43:29 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：四角色分輪攻防完成；採用範圍見 D87
- 捍衛初始候選：每個原操作共用一份確認次數與時間額度；首次 DB 結果不明起算，不因轉入恢復或 HTTP 重送重設。最初按「實際發出的確認請求」計次，達任一上限停止新確認並交維護者；已發命令不因此被取消，晚到充分證據仍更新原項。
- 第一輪工程異端：挑戰「實際發出」的定義；送出途中失敗或無法確定是否到達 DB，若不計次便能反覆免費重試。並行觸發也可能各自認為還有額度。
- 捍衛修正：每次送出嘗試均計次，失敗或到達不明不退還；送出前取得原項共同額度並檢查時間仍未超限，拿不到不得新發確認。只定應用層契約，不宣稱 driver 內部重試已被約束。
- 第一輪仲裁：政策層已解主要計次漏洞，共同額度取得及 driver 邊界仍須驗證；推薦 UX 檢查停止確認與原項權利。
- 第二輪 UX 異端：確認額度耗盡後才證明原項沒有保存效果，不能把停止確認偷偷等同取消尚存的執行資格；否則準時項可能永久暫停。要求分開恢復原項與補發執行機會。
- 捍衛回應：確認額度耗盡不取消原項或尚存執行資格；提出「晚到無效果證據成立且原項仍有資格、服務允許，由維護者批准續辦同項」候選。原接收時間與順位不改，不補滿真正耗盡的執行資格；資格如何計量、是否耗盡與人工介面未定。
- 最終仲裁：保留原項與晚到確定結果的窄規則可收斂；但騎士增加的人工批准是新候選，不得當作已採用。晚到無效果後可以自動續辦或需要批准，留待另題確認；兩輪到此停等。
- 角色與來源：沿用 D82 的工程／UX 兩位獨立異端、捍衛及仲裁；先獨立準備，再只交換正式公開論點，每輪異端 → 捍衛 → 仲裁。依據 D80、D83、D85 與本輪推論，無新增外查或測試，不保存隱藏思考。

### D87｜接受每原項共用有限確認額度，超限不誤報失敗或丟棄晚結果

- 討論時間：2026-09-19 01:43:29 +08:00（回溯保存時間）
- 狀態：使用者已接受確認額度規則；具體數值、續辦授權與實作未定
- 使用者確認：主 agent 白話摘要「同一次通行嘗試，共用有限的自動確認額度；用完不代表通行失敗」，列明失敗計次、首次結果不明起算、重送不補滿、超限不代表 rollback、晚到保存成功仍提供原結果；使用者回答「接受」。
- 已採用額度：每個原操作共用有限的確認次數及總時間；從首次 DB 結果不確定起算，正常排隊不消耗這份確認時間。正常確認轉入恢復、同鍵重送及 HTTP 等候逾時，均不重新計時或補滿次數。首次 receivedAt 與 FIFO 順位另依 D76、D78 保留，不與確認時間混用。
- 已採用計次：每次確認的送出嘗試均計一次，途中失敗或送達不明也計次；發出前須檢查原項共同剩餘額度及時間，避免並行超用。這是應用層要求，driver 內部自動重試、命令數與時間限制尚須另行查證與驗證。
- 已採用超限界線：達次數或時間任一上限，停止發起新的自動確認，未決時保持相關寫入暫停並交維護者處理。上限不是 rollback、取消已發 DB 命令或取消原通行嘗試的證據，也不能把未知誤報成業務失敗、遲到或 EXPIRED。
- 已採用晚結果：超限後才取得的確定結果不得丟棄；若證據確認原結果已完整保存，仍更新原項並提供原保存結果，不重新執行。確認額度耗盡本身不剝奪尚存的原項執行資格；但沒有保存效果也不自行證明仍有執行資格或獲准續辦。
- 不變安全條件：結果證據、舊工作不得晚寫、當下服務許可及維護否決仍須分開判斷；晚到通知不能越過 D82 的原項處理權限制或解開其他項的關卡。收到確定原結果不等於全局服務立即可恢復。
- 未一併採用：具體秒數／次數、業務執行及重新執行的總預算／資格計量、超限後確認無效果能否自動續辦或須人工批准、耗盡後補發新機會、私有人工介面、持久 pending、跨重啟／重置延續或保證必定完成。D86 的人工批准僅是候選，不以本次接受擴張。
- 待驗證：正常排隊不吃確認額度、失敗送出仍計次、並行取額度不超用、正常確認轉恢復與同鍵重送不補滿、上限不虛構 rollback、晚到完整保存結果可回放，以及晚通知不誤解鎖。未執行任何實作或故障測試。
- 依據：使用者接受；D86 公開攻防及白話摘要；D76、D78、D80、D83、D85。此為已採用規則，不是已完成工程成果。

## 2026-09-19 自動確認額度交接資訊

- 可採用：D87 每原項共用有限時間與次數、首次未知起算、失敗計次、不因重送或恢復補滿、超限停止新確認而不取消原項，晚確定結果保留。D85 有限自動確認／人工兜底及既有安全條件保留。
- 最新未決：超限後才證明無效果，原項若仍可執行且安全／服務條件齊備，能否自行續辦或須維護者批准；只比較責任界線，不擅自補滿預算或新增公開管理 API。具體數值亦未選定。
- 來源：A1–A6 範圍及鎖定狀態沿用；保存時主 agent 重讀 discuss.md 檢索卡及末尾，取得全文快照比對歷史，business-scope.md 僅比對 hash，其餘來源未重新查詢。正式角色公開論點與使用者採用分列；LLM 背景知識開啟，無新增外查 Q 分支。
- 不可假設：driver 已提供已驗證的全程取消、所有 timeout 都代表未提交、已選定實際上限數值、人工批准已採用、原項必定完成，或業務文件／程式已同步。
- 保存關卡：本次只更新 discuss.md，文字與歷史保留檢查後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：超限後續辦與人工管控

### D88｜兩輪攻防限制續辦再次未知，並區分人工關注與實際接管

- 討論時間：2026-09-19 01:49:33 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：四角色分輪攻防完成；採用範圍見 D89
- 捍衛候選：超限後，在途結果才充分證明上一輪完全沒有保存效果且不會再晚寫，只要原項仍可執行、服務當下允許，協調器就接續原項，不必只因證據晚到而等待人工批准。不補滿確認或執行額度，不改 receivedAt／FIFO；晚 callback 不能直接開寫，仍檢查自身處理權與維護許可。
- 第一輪工程異端：支持條件式自動續辦，但挑戰續辦的新寫入再次結果不明時，是否會被當作另一個「首次未知」而重開額度；上一輪無效果證據也不能拿來解鎖新寫入。
- 捍衛精確化：續辦仍是同一原操作，再次未知沿用原項已耗盡的確認額度，停止新自動確認及相關寫入、交維護者處理。舊證據只證明上一輪工作安全結束，新寫入須自身充分證據才可收尾。
- 第一輪仲裁：工程質詢在政策層已解，機制未驗證；人工接管後的自動動作權限仍未明定，推薦 UX 檢查交接敘事與控制權。
- 第二輪 UX 異端：同樣支持安全後自動續辦，但指出「交維護者」可能讓人誤認操作已由人工接管、背景不會再動。要求只有人工管控實際生效時才稱「已接管」，否則須揭露晚證據仍可能觸發自動續辦。
- 捍衛修正：「需要人工關注」不等於「已接管」；尚未生效管控時，明示停止新確認、等待在途證據或人工介入，仍可能條件式續辦。人工管控或維護生效後，晚證據可更新原項結果，但不得自行續辦或解除管控。不新增逐項批准平台，具體機制留待規劃。
- 最終仲裁：兩輪形成責任候選，無具體 driver 事實需要新增查證；建議先由使用者確認，再討論執行資格／整體有界的最小規則。兩輪結束停等，不自行保存或繼續擴張。
- 來源與角色：D83、D85、D87；沿用工程與 UX 兩位獨立異端、捍衛及仲裁，獨立準備後只交換正式公開論點，每輪異端 → 捍衛 → 仲裁。沒有為角色扮演虛構對立，未新增外查或測試，不保存隱藏思考。

### D89｜接受充分晚證據下自動續辦，但不得補滿額度或越過人工管控

- 討論時間：2026-09-19 01:49:33 +08:00（回溯保存時間）
- 狀態：使用者已接受責任規則；執行資格計量與控制機制未定、未實作
- 使用者確認：主 agent 摘要「安全已確認、原操作仍可續辦，而且沒有進入人工管控或維護，就自動續辦，不必額外等人批准」，呈現兩輪修正及準時提交例子；使用者回答「接受」。
- 已採用續辦：原項仍在同一程序且未重置，超限後才取得充分證據確認上一輪完全無保存效果、舊工作不會再晚寫，原項仍有執行資格、當下服務允許且未受人工管控或維護阻擋時，由協調器自動續辦同一原操作。不僅因確認額度已用完或證據晚到而額外等待人工批准，也不要求測試者重新提交。
- 已採用預算與證據界線：續辦不補滿確認／執行額度，不刷新首次 receivedAt 或 FIFO 順位。續辦後新寫入若再未知，仍沿用原項已耗盡的確認額度，停止新自動確認、停相關寫入並交人工關注；上一輪無效果證據不能證明新寫入安全。晚到完整保存結果依 D87 更新／回放，不重做。
- 已採用交接語意：通知或需要維護者關注，不代表人工管控已生效；此時仍須明示「停止新確認，等待在途證據或人工介入」，以及安全條件齊備後仍可能自動續辦。具體 API 狀態名稱與 DTO 尚未選定。
- 已採用控制權：只有人工管控實際生效才稱「已接管」；接管或維護生效期間，不得因晚證據自行越權續辦或解除管控。確定原保存結果仍可更新並提供查詢，這與啟動新寫入、恢復全局服務是不同動作。D82 的原項處理權限制及 D52 的維護否決保留。
- 未一併採用：執行資格如何計量或何時耗盡、整體執行上限、具體確認秒數／次數、耗盡後新增執行機會、人工管控／接管及解除的工具或介面、逐項批准平台、新公開管理 API、持久 pending、跨崩潰／重置恢復或保證完成。條件式續辦不等於無限重做。
- 待驗證：晚充分無效果證據下同項自動續辦、資格或許可未知時不續辦、再次未知不重開額度或重用舊證據、通知人工不誤稱接管、管控生效與晚 callback 競爭不越權，以及已保存結果仍可回放。未執行實作、接管或故障測試。
- 依據：使用者接受；D88 公開攻防；D83、D85、D87。這是已採用規則，不是已完成工程成果。

## 2026-09-19 超限後續辦與人工管控交接資訊

- 可採用：D89 晚充分無效果證據下條件式自動續辦，同項再未知不補確認額度、證據不跨技術輪次重用；人工關注與實際管控分開，管控／維護生效後不得自動越權。D87 額度及晚結果、D85 分工保留。
- 下一題建議：以最小規則定義「原項仍可執行」及整體執行上限，避免條件式續辦變成無限重做；先決定政策，不急著挑秒數或新增恢復系統。需另經使用者選擇與角色攻防。
- 來源：沿用鎖定 A1–A6；保存時重讀 discuss.md 檢索卡及末尾，取得全文快照作歷史保留檢查，business-scope.md 僅比對 hash，其餘來源未重新查詢。公開角色論點、使用者採用與本輪推論分列；LLM 背景知識開啟，無新增外查 Q 分支。
- 不可假設：原項永遠有執行資格、通知人工即管控生效、人工管控機制已選、確認超限等於 rollback、晚證據必定到達、程式／業務文件已同步或故障必定恢復。
- 保存關卡：本次只更新 discuss.md、驗證後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：執行額度與技術終局

### D90｜兩輪攻防區分最後一次執行與時間耗盡，補清新嘗試不繼承準時保障

- 討論時間：2026-09-19 01:55:01 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：四角色分輪攻防完成；採用範圍見 D91
- 捍衛初始候選：每原項共用完整執行次數與總時間，首次取得完整操作權起算，排隊不算、開始後暫停／確認仍算；初次執行、正常衝突重跑及恢復續辦均消耗原項額度，不刷新。初始說法「任一上限耗盡即不再開始新步驟或重跑」過於籠統。
- 第一輪工程異端：最後一次開始時已用掉最後名額，若立即禁止下一步，最後名額反而不能完成正常工作。要求區分次數限制與時間限制，不阻止必要安全收尾。
- 捍衛修正：次數用完只禁止新完整執行輪，已取得最後名額的一輪仍可在剩餘總時間內完成；總時間耗盡才停止新增業務步驟與重跑，允許必要安全收尾。這不證明命令已取消或 rollback，收尾確認仍不能繞過 D87 額度。
- 第一輪仲裁：計次漏洞在政策層已解，起算／跨暫停計時、實際停止及無晚寫證據仍待驗證；建議 UX 檢查技術終局後的重送含義。
- 第二輪 UX 異端：同 ID 不重啟已明確，但換新 ID 是否能重新嘗試、是否仍享有原準時保障未明；本次技術未完成不應被描述為資格從此不可使用。
- 捍衛精確化：原項確無效果、不會晚寫且已安全收尾後，技術終局不撤銷通行資格。新 ID 是新嘗試，須重新准入並採新 receivedAt，重新檢查來源、資格及狀態，可能已逾期；不繼承原項準時保障、不補原額度。原結果仍未知或停寫未解除時，新 ID 不得繞過關卡；單項額度不是全部請求的總配額。
- 最終仲裁：兩輪形成窄規則，數值、容量、driver 機制及跨重置終局保留仍未定／未驗證，無重要新外部事實需查證；停等使用者確認，不再開輪或自行保存。
- 來源與角色：D76、D78、D80、D87、D89；工程與 UX 異端各自獨立準備，再只交換正式公開論點，每輪異端 → 捍衛 → 仲裁。無新增外查或實作測試，不保存隱藏思考。

### D91｜接受每原項共用有限執行額度，安全收尾後區分技術終局與新嘗試

- 討論時間：2026-09-19 01:55:01 +08:00（回溯保存時間）
- 狀態：使用者已接受執行上限及終局規則；數值與實作未定
- 使用者確認：對白話摘要「同一操作共用有限的執行次數與總時間，重試、恢復都不能補滿」，以及兩輪修正與技術終局／新 ID 區別，回答「接受」。
- 已採用計時：每原操作的總執行時間從首次取得完整操作權起算，開始執行前排隊不計；開始後的暫停、結果確認與恢復等待仍計入，不重新起算。首次 receivedAt／FIFO 是準時判斷與順序，與這份技術時間上限分開。
- 已採用計次：每次開始完整業務執行前取得原項的一次額度，第一次也計次；正常衝突的整輪重跑與恢復續辦均共用剩餘輪次，不以重送或恢復補滿。具體用例及 driver 內部重試的計數邊界仍須實作驗證。
- 已採用上限區別：輪次用完只禁止開始新的完整執行輪，最後一輪仍可在剩餘總時間內完成正常步驟。總時間用完則停止新增業務步驟與重跑，但允許必要安全收尾；已發命令不因 timer 到點就被視為取消或回滾。安全收尾不額外補滿 D87 確認額度，也不保證固定時間內必定收尾。
- 已採用結果政策：原結果已完整保存則提供／回放它；額度耗盡且充分證明無保存效果、舊工作不會再晚寫並已安全收尾，則收束為「本次因技術問題未完成、執行額度耗盡」，不是業務拒絕、遲到或 EXPIRED。結果仍未知則依既有規則停相關寫入，不能假稱失敗、任意放後項或利用舊證據解鎖。
- 已採用重送及新嘗試：同 ID 重送不重新執行，關聯原項進度／技術終局或原保存結果。技術終局不自動撤銷通行資格；只有完成安全收尾、服務允許並符合正常准入規則時，新 ID 才能作為新嘗試接受，新 receivedAt 不繼承原準時保障，資格可能已逾期。新 ID 不得繞過未知停寫、人工管控或維護。
- 保留架構界線：D89 的「原項仍可執行」須具備本輪定義的剩餘執行許可，並符合當下服務與安全條件；單項預算不代表整體准入／容量已定或新請求必定能被接受。D72、D78 的正常排隊準時保障不撤回，但不承諾故障下必定完成。
- 未一併採用：具體輪次／秒數、driver 與停止／終止 API、技術終局回應格式與保存機制、容量／限流數值、耗盡後補發原項機會、人工管控工具、跨程序崩潰／重置的原項或終局延續、持久 pending 或故障必定有限恢復。
- 待驗證：初次／重跑／恢復共用計次、最後輪能正常完成、暫停不刷新時間、時間耗盡後不新增業務工作而安全收尾、確認不補滿、未知不虛構回滾、技術終局同 ID 不再執行，以及新 ID 採新時間且不越過安全關卡。未執行任何程式或故障測試。
- 依據：使用者接受；D90 公開攻防及白話摘要；D76、D78、D80、D87、D89。這是採用規則，不是已完成工程成果。

## 2026-09-19 執行額度與技術終局交接資訊

- 可採用：D91 共用輪次／總時間、取得完整操作權起算、排隊不算而開始後暫停仍算、不補滿、最後輪及安全收尾界線；結果確無效果的技術終局與新 ID 新時間分開。D87 確認額度與 D89 控制權保留。
- 下一步建議：先整理排隊、執行、結果確認三種上限的對照與待定參數，確認沒有互相矛盾，再決定哪些數值可作 Demo 起始設定、哪些須靠測試校準。不得以未測數值宣稱效能／可用性保證；新討論須另經使用者選擇，不自行推進實作。
- 來源：沿用鎖定 A1–A6；保存時重讀 discuss.md 檢索卡及末尾，取得全文快照檢查歷史保留，business-scope.md 僅比對 hash，其餘來源未重新查詢。正式公開角色論點、使用者接受及推論分列；LLM 背景知識開啟，沒有新增外查 Q 分支。
- 不可假設：具體上限已選、停止新增步驟等於已 rollback、技術終局會跨重啟／重置保留、新 ID 仍享有舊準時保障、所有限流／容量已完成，或業務文件與程式已同步。
- 保存關卡：本次只更新 discuss.md，驗證後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：Demo 初始上限與驗收

### D92｜對照三種上限，兩輪攻防補上確認節奏與可觀察的重送進度

- 討論時間：2026-09-19 02:03:10 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：對照摘要與兩輪攻防完成；採用範圍見 D93
- 前段白話對照：HTTP 等待上限不是排隊取消期限；執行從首次取得完整操作權起算，確認從首次 DB 結果未知起算。排隊不扣執行／確認時間，開始後確認等待也計入執行時間；兩者可同時起作用，不是相加的完成保證。此為 D78、D87、D91 的整理，沒有新增取消規則。
- 捍衛候選：HTTP 回覆等待 5 秒；執行總時間 15 秒、最多 3 輪含首次；確認總時間 10 秒、最多 3 次送出嘗試含失敗。全部為待測、可調 Demo 初值，不是業界標準或實測效能；HTTP 精確起點仍未定。
- 第一輪工程異端：不反對初值，但指出 3 次快速失敗若立即連發，可能遠早於 10 秒耗盡；要求發起節奏與故障測試，否則初值不足以說明暫時故障的恢復機會。
- 捍衛精確化：首次立即確認，失敗後分別等 1 秒、2 秒再考慮下次，每次送出前檢查原項剩餘次數與窗口。前次尚未完成不並行補發；10 秒／3 次任一到限就停止新發，不保證等滿 10 秒，也不保證已發命令在窗口內完成。
- 第一輪仲裁：策略層已回應快速耗盡風險，數值與節奏未量測；推薦 UX 檢查 5 秒後的同 ID 進度與結果回放。
- 第二輪 UX 異端：接受作 Demo 起點，但要求注入可控延遲，驗證首次 HTTP 等待超過 5 秒後，在原項確知尚未完成時，同 ID 能取得仍在處理，再於完成後取得原結果；只看到逾時後直接成功不足以展示進度語意。
- 捍衛回應：接受作驗收，分別量測 HTTP 等待及取得操作權後的執行時間，安排原項在 15 秒執行預算內完成；重送不增加輪次、不改 receivedAt／FIFO。不是保證每次重送都看到處理中，HTTP 起點及 API 形式仍未定。
- 最終仲裁：形成待測可調初值與驗收候選，沒有新業界或 driver 事實需要查證；停等使用者採用，不自行寫檔或延長攻防。
- 角色與來源：工程與 UX 兩位獨立異端、捍衛及仲裁，各自準備後只交換正式公開論點，每輪異端 → 捍衛 → 仲裁。依據 D78、D87、D89、D91 及本輪推論，無新增外查／量測，不保存隱藏思考。

### D93｜接受可調待測的 Demo 初始值與確認節奏，不作完成時間保證

- 討論時間：2026-09-19 02:03:10 +08:00（回溯保存時間）
- 狀態：使用者已接受作為待測初值；未實作、未量測、未寫入設定
- 使用者確認：主 agent 展示 5／15／10 秒及 3 輪／次的表格，列明首次立即確認、失敗後等 1／2 秒、不並行補發，以及可控延遲下同 ID 進度／原結果驗收；對「待測、可調的 Demo 初始值」回答「接受」。
- 已採用初值：HTTP 回覆等待 5 秒，到期不取消原操作；同 ID 仍依原進度／結果關聯。原操作執行總時間 15 秒、最多 3 輪含首次，起算與最後輪規則沿用 D91。結果確認總時間 10 秒、最多 3 次送出嘗試含失敗，起算及額度共享沿用 D87。
- 已採用確認節奏：首次立即嘗試；失敗後分別等 1 秒、2 秒，再檢查是否能發起下一次。前次未完成不並行補發，每次送出前須有剩餘時間／次數；失敗不退還次數，同項恢復及重送不重新取得額度。這不是固定時刻排程，慢回覆會影響後續能否發起。
- 保留上限意義：時間／次數任一到限停止新發確認，不保證用滿窗口、不保證已發命令在 10 秒內完成，也不代表命令已取消或已回滾。確認等待同時消耗已開始的執行總時間，15 秒與 10 秒不是相加的完成保證。未知仍依 D80、D87 停相關寫入，晚結果及管控依 D89，執行耗盡的技術終局依 D91。
- 已採用 Demo 驗收：分別量測 HTTP 等待與操作權取得後的執行時間，注入使 HTTP 等待超過 5 秒但原項仍能在 15 秒執行預算內完成的可控延遲；在確知原項未完成時，同 ID 重送須能取得進度，完成後再取得原樣結果。驗證不新增執行輪次、不刷新首次 receivedAt 或 FIFO；不宣稱每次重送都必定看到處理中。
- 待測校準：正常無故障延遲、快速連續失敗、慢回應、已發確認晚結果、同 ID 重送及預算耗盡。數值只能作初始設定，若量測不合適須調整並記錄依據，不寫成效能／可用性成果。
- 未一併採用：HTTP 計時精確起點、每個 DB 命令／driver 的實際 timeout 或取消能力、重試 API、HTTP status／DTO／路徑、隊列容量或排隊取消期限、限流數值、部署平台、人工管控工具、跨重啟／重置延續，以及有限時間必定完成的承諾。
- 依據：使用者接受；D92 正式公開攻防及本輪白話摘要；D78、D87、D89、D91。此為待測設定的採用，不是已完成或已驗證工程成果。

## 2026-09-19 Demo 初始上限交接資訊

- 可採用：D93 待測可調初值與確認節奏、同 ID 可觀察進度／原結果驗收；D87、D89、D91 的預算共享、安全停寫、管控及技術終局不變。
- 下一題建議：先收斂 HTTP 回覆等待的精確起點，再確認必要准入／容量界線；不把「回覆不再等待」變成取消排隊，不新增大型恢復系統。具體工程參數須靠後續測試校準，未授權實作。
- 來源：沿用鎖定 A1–A6；保存時重讀 discuss.md 檢索卡及末尾、取得全文快照比對歷史，business-scope.md 僅比對 hash，其餘來源未重新查詢。使用者採用、公開角色論點與推論分列；LLM 背景知識開啟，無新增外查 Q 分支。
- 不可假設：5／15／10 秒是業界最佳值、Demo 已完成量測、確認窗口保證命令結束、固定秒數能保證吞吐或恢復可用、HTTP 起點已定，或程式／設定／業務文件已同步。
- 保存關卡：本次只更新 discuss.md，文字與歷史保留驗證後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：HTTP 等待起點與一次回覆

### D94｜兩輪攻防限制回覆競爭，澄清五秒不是端到端送達保證

- 討論時間：2026-09-19 02:09:45 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：四角色分輪攻防完成；採用範圍見 D95
- 捍衛候選：HTTP 等待從 D76 同步登記點起算，與該次接收時間同點，先於非同步認證／DB 工作；每個重送各算自己的 5 秒，不改原操作時間、順位或額度。認證／正式格式驗證尚未完成就不能回「已受理、處理中」；驗證後同 ID 有在途原項則直接回可確認進度，已保存則回放，不硬等滿 5 秒。
- 第一輪工程異端：接受未驗證者只收到不洩露資訊的技術逾時；指出 5 秒到點與驗證／結果完成同時發生，兩條路徑可能重複回覆。
- 捍衛精確化：每個 HTTP 等候方只回覆一次，到期與完成競爭同一回覆權，晚 callback 不得再次響應。HTTP 已結束不取消原操作；晚認證失敗仍不得進業務，成功才依格式、冪等與執行條件接續，後續合法重送可關聯原狀態。
- 第一輪仲裁：政策層已回應競爭問題，一次回覆及入口實作仍須驗證；推薦 UX 檢查是否被誤解為固定等待或含上傳時間。
- 第二輪 UX 異端：承認驗證後同 ID 直接提供進度已解重送又多等問題；要求明列 5 秒不含上傳，結果先完成就先回，也不是使用者按送出後 5 秒必定收到的保證。
- 捍衛回應：接受，5 秒是完整 body 通過同步入口檢查並登記後的應用回覆等待策略；到點結束本次等待並嘗試回覆，實際送達仍受排程與傳輸影響，不新增上傳策略或網路端到端保證。
- 最終仲裁：窄候選已收斂，無新增外部事實需查證；使用者接受後才保存，再討論必要准入／容量，不重開故障議題。
- 角色與來源：工程與 UX 異端、捍衛及仲裁獨立準備，之後只交換正式公開論點，每輪異端 → 捍衛 → 仲裁。依據 D76、D78、D93 及本輪推論，無新增外查或實作測試，不保存隱藏思考。

### D95｜接受登記後五秒的應用等待策略，回覆一次而不取消原操作

- 討論時間：2026-09-19 02:09:45 +08:00（回溯保存時間）
- 狀態：使用者已接受 HTTP 起點與回覆政策；未實作、未測試
- 使用者確認：對「伺服器完整收到請求、通過基本檢查並登記時間後開始算，包含認證與排隊等待」及兩輪修正、3 秒排隊加 1 秒處理例子，回答「接受」。
- 已採用起點：沿用 D76 的完整 body 在應用可觀察、同步大小／基本 JSON／准入檢查通過後的登記點，先於非同步認證與資料庫工作，開始本次 HTTP 的 5 秒等待。同鍵重送有自己的 HTTP 等待，不覆寫原操作首次 receivedAt、FIFO 或執行／確認額度。
- 已採用等待意義：結果先完成就先回，5 秒是等待上限策略，不是固定等待長度；到點結束本次等待、嘗試回覆，但不取消原操作。它不含上傳時間，不保證使用者按下送出後 5 秒內收到，也不是 event loop／網路送達的硬即時保證。
- 已採用驗證界線：到點時認證或正式格式驗證仍未完成，只能提供不洩露原項資訊的技術等待逾時，不能稱已受理或處理中。晚認證失敗仍不得進入業務；成功才依正式格式、冪等、權限與執行條件接續。登記不等於授權或業務受理。
- 已採用重送回覆：完成必要驗證及同鍵內容確認後，同 ID 若已有在途原項，直接提供當下可確認進度；已有保存結果則直接回放，不刻意再等待 5 秒。保持不同內容的冪等衝突規則，不向未驗證者洩露狀態，也不保證任意故障下都可立即取得進度。
- 已採用一次回覆：每個 HTTP 等候方只有一次回覆權；等待到期與處理完成競爭時僅一方可回覆，晚 callback 不能再次響應。原項的處理／保存結果與個別 HTTP 回覆生命期分開，晚結果仍依既有規則更新以供後續合法查詢／重送。
- 不變：D93 的 15 秒／3 輪執行從首次操作權起算、10 秒／3 次確認從首次 DB 未知起算；HTTP 等待不補任何額度，排隊不吃執行／確認時間。未知停寫、共同原子保存、準時保障與維護／人工管控保留。
- 未一併採用：框架 hook、HTTP status／DTO／路徑、上傳與慢 body 超時政策、隊列容量／限流數值、在途記憶與技術終局保存機制、driver 取消能力、跨崩潰／重置延續或故障一定可恢復。
- 待驗證：認證／排隊均計入 HTTP 等待、認證未完成不誤報受理或洩露原項、到期與完成只能回覆一次、HTTP 已結束原項可依條件繼續、同鍵驗證後進度／原結果直接提供且時間／額度不刷新。未執行任何程式或故障測試。
- 依據：使用者接受；D94 正式公開攻防與白話摘要；D76、D78、D93。這是採用規則，不是已完成工程成果。

## 2026-09-19 HTTP 等待起點交接資訊

- 可採用：D95 同步登記後起算 5 秒、每 HTTP 一次回覆、未驗證不冒稱受理、合法重送直接取得可確認進度／結果，以及非上傳／端到端保證。D87、D89、D91、D93 的執行／確認及安全界線保留。
- 下一題建議：必要准入與排隊容量；避免公開 Demo 無限接收新操作，同時不能用容量政策偷偷取消已接收的準時原項。先定最小規則，再選待測數值，不新增大型佇列或恢復平台。
- 來源：沿用鎖定 A1–A6；保存時重讀 discuss.md 檢索卡及末尾、分段取得全文快照比對歷史，business-scope.md 僅比對 hash，其餘來源未重新查詢。使用者採用、公開角色論點與推論分列；LLM 背景知識開啟，無新增外查 Q 分支。
- 不可假設：五秒包括上傳或保證網路送達、登記即授權、框架入口已驗證、HTTP 到期即取消、重送能保證任意故障下立即回覆，或設定／程式／業務文件已同步。
- 保存關卡：本次只更新 discuss.md，文字與歷史保留驗證後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：容量准入與未受理語意

### D96｜兩輪攻防修正提前釋放驗證名額，區分入口受限與新操作未受理

- 討論時間：2026-09-19 02:15:18 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：四角色分輪攻防完成；採用範圍見 D97
- 捍衛候選：有限原項名額包含未驗證暫占、排隊、執行及結果不明的工作，入口同步取得暫占才登記；不能因 HTTP 逾時、斷線或 DB 未知歸還。另限制 HTTP 驗證／等候資源；原項滿時仍可透過有限驗證辨認可信重送，合法同鍵同內容只關聯既有進度／結果，不新增原項；不是重送就回容量技術錯誤、不建業務 Event。終局記憶護欄與數值尚未選定。
- 第一輪工程異端：接受容量分開，但指出 HTTP 已回覆逾時時，非同步認證可能仍在跑；若認證名額一起歸還，持續新請求就能累積無界未完成認證。
- 捍衛修正：HTTP 回覆／等候資源與驗證工作名額各按自身生命期計算。HTTP 結束只能歸還等候方資源，驗證須確認真正結束並安全轉交才釋放；無法確認時仍占名額，不假定逾時取消了工作。原項名額另依安全終結釋放，不連帶解鎖。
- 第一輪仲裁：政策層已回應提前釋放風險，名額取得／轉交／釋放未驗證；推薦 UX 區分新項未受理與重送本次驗證受限。
- 第二輪 UX 異端：入口驗證滿時尚不知道是否合法重送，不能回「簽到未受理」讓人誤以為原項及準時時間不存在；可信判定為新項且業務容量滿後才可說新項未受理。
- 捍衛精確化：認證前入口滿，只能說本次請求未完成驗證、不能確認原項狀態，不洩漏進度；可信新項遇原項滿才明說未受理、未保留本次準時資格，重試採新時間且可能已逾期。可信同鍵已有原項仍關聯原時間／順位；暫占及登記不是認證成功或通行授權。
- 最終仲裁：兩輪形成窄規則，D76 同步登記、重送保護與容量接線，以及數值仍未驗證；停等使用者採用，不自行寫檔或新增平台。
- 來源與角色：D76、D78、D80、D95 及本輪推論；工程／UX 兩位異端、捍衛與仲裁先獨立準備，再只交換正式公開論點，每輪異端 → 捍衛 → 仲裁。無新增外查或實作測試，不保存隱藏思考。

### D97｜接受有限容量按工作生命期釋放，滿載不取消已接收原操作

- 討論時間：2026-09-19 02:15:18 +08:00（回溯保存時間）
- 狀態：使用者已接受最小容量及回覆規則；數字與接線未定、未實作
- 使用者確認：對「名額滿了，拒絕尚未接收的新操作；不丟掉已接收的操作」，以及工作名額／同 ID 重送及三種回覆語意的白話摘要，回答「接受」。
- 已採用容量分工：原操作容量與入口驗證工作／HTTP 等候資源分開限制，不把同 ID 重送當成第二筆業務工作，也不讓任何重送無條件免除入口資源限制。原項名額覆蓋暫占待驗證、排隊、執行及故障未決項；實際同步准入與可信同鍵關聯的接線仍待規劃。
- 已採用生命期：HTTP 等待逾時或斷線不等於背景認證結束，驗證名額須到真正完成並安全轉交／收尾才歸還。原項不能因 HTTP 逾時、斷線或結果未知釋放；驗證失敗且確定不進業務，或原項完整結束並安全收尾後，才依自身生命期歸還名額。不得丟棄已接收的準時項以騰容量。
- 已採用重送保護：完成必要驗證、可信 source＋external event ID 與相同內容確認後，只關聯既有進度／結果，不新增業務原項、不改原 receivedAt／FIFO／預算；不同內容仍是冪等衝突。原項容量滿不能一概拒絕所有可能的重送，但驗證通道也須有界；入口受限不代表原操作取消，不保證所有重送必定接受。
- 已採用入口滿語意：認證入口滿而尚未完成驗證，只能表達「本次請求無法完成驗證，不能判定原操作狀態」。不能宣稱原項未受理、不存在或失敗，也不能向未驗證者洩漏原項進度。
- 已採用新項滿語意：可信判定是新操作且原項名額滿，才回「新操作未接收，未保留本次準時紀錄」；不建立業務 Event，只作適當技術紀錄。這不是排隊或通行拒絕；稍後重試採新的接收時間，可能已逾期，不能繼承被容量拒絕時的時間。暫占／登記不等於可信受理或通行授權。
- 不變安全前提：未知停相關寫入、共同原子保存、維護／人工管控與已接收原項準時保障保留；新 ID 不得繞安全關卡。唯讀及認證不因此全部排進相關業務寫入 FIFO，但不代表資源無限或故障下保證可用。
- 未一併採用：原項／驗證／HTTP 名額數字、每來源或 IP 限流值、原項暫占轉移與重送辨識的具體接線、技術終局記憶容量／期限／保存方式、HTTP status／DTO、分散式佇列或新平台、driver 取消能力，以及跨崩潰／重置延續。
- 待驗證：滿容量不超收新項、未完成驗證不提早還名額、同鍵重送不增原項、入口滿不誤稱原簽到失敗、可信新項滿不冒稱排隊、已接收項不被容量淘汰、未知保持名額及安全關卡，以及釋放／轉交競爭不重複歸還。未執行任何容量或故障測試。
- 依據：使用者接受；D96 公開攻防與白話摘要；D76、D78、D80、D95。這是已採用規則，不是已完成工程成果。

## 2026-09-19 容量准入交接資訊

- 可採用：D97 原項與入口工作分開限制、按實際生命期歸還、重送不增加業務原項但不全免入口限制、未驗證入口滿與可信新項未受理分開，以及不取消已接收準時項。
- 下一步建議：先確認名額計數／接線的最小方式與待測容量初值，再將已採用架構整理成可執行方案；不需要新增大型佇列或恢復平台。容量數值與未決細節須另經選擇，不自行開始重寫。
- 來源：沿用鎖定 A1–A6；保存時重讀 discuss.md 檢索卡及末尾、分段取得全文快照比對歷史，business-scope.md 僅比對 hash，其餘來源未重新查詢。公開角色論點、使用者採用及推論分列；LLM 背景知識開啟，無新增外查 Q 分支。
- 不可假設：所有重送永遠可以接受、認證前自報 event ID 可豁免資源限制、HTTP 結束即工作結束、同步接線已驗證、容量數值已定、終局記憶無限保存，或程式／設定／業務文件已同步。
- 保存關卡：本次只更新 discuss.md，文字與歷史保留驗證後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：容量初值與登記前完整准入

### D98｜容量候選的公開攻防，補足先取名額再登記及非體驗保證

- 討論時間：2026-09-19 02:24:10 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：工程／UX 公開攻防完成；採用範圍見 D99
- 捍衛候選：未完成原操作 32、並行入口驗證 8、HTTP 等候 32，分別限制待處理工作、驗證負載與回覆等候資源；僅作可調待測起點，不宣稱最優、吞吐能力或可支撐人數。
- 工程異端：不反對數字，但指出若先占原項並登記，才發現驗證槽已滿，就可能丟掉已登記的準時項；要求明確區分整組准入未成立與已登記原項，避免漏項或漏還名額。
- 捍衛回應：一般新項須在登記前同步確認並取得原操作、驗證及 HTTP 等候所需名額，整組成功才登記；任一不足則整組不成立、歸還未登記暫占，不能先登記再因容量不足丟棄。原操作滿時仍可經有限驗證／HTTP 通道辨認重送，但不登記第二筆原項；可信判定是新項則依 D97 未受理政策處理。
- UX 異端：反對把容量 32 包裝成 32 人都能順利簽到；原項尚有空位，不代表入口可完成驗證，既有原項的同 ID 重送也未必當下能取得進度。
- 捍衛回應：接受，維持數字作為三類資源的待測上限，不承諾即時通行、每次請求均成功受理或故障下查詢可用率；須以實測調整。
- 仲裁：工程准入與 UX 語意在政策層已回應，32／8／32 不是效能成果，不改原接收時間及執行／確認預算。名額取得、轉交、釋放與測試仍未證明；建議使用者接受後保存，再收斂實作方案，不擴張新子系統。
- 角色與來源：工程與 UX 異端及捍衛先獨立準備，再交換正式公開論點；仲裁在取得完整公開回應後補足最終判斷。依據 D76、D95、D97 與本輪推論；無新增外查或實作測試，不保存隱藏思考，不把角色同意當成工程驗證。

### D99｜接受 32／8／32 待測初值，登記前取得完整所需名額

- 討論時間：2026-09-19 02:24:10 +08:00（回溯保存時間）
- 狀態：使用者已接受可調容量初值及完整准入政策；未實作、未量測
- 使用者確認：對「32／8／32 作為待測初值，以及登記前取得完整所需名額的規則」回答「可以」；沿既有逐題保存流程，先保存再整理實作方案。
- 已採用初值：原操作容量 32，覆蓋暫占待驗證、FIFO 等候、執行中及結果尚不確定的工作；並行入口驗證容量 8；HTTP 等候回覆容量 32。三者為不同計數器，各按 D97 的實際生命期釋放，不以 HTTP 逾時或斷線連帶釋放仍工作的驗證或原項。
- 已採用一般新項准入：在 D76 登記前同步取得完整所需名額，整組成功才登記。任一不足則整組准入未成立，歸還尚未登記的暫占；不能登記後再因驗證／HTTP 容量不足丟掉原操作。不等同任何 MongoDB 交易或認證已成功，具體同步機制仍待實作驗證。
- 已保留滿容量重送辨識：原項滿時，有限驗證及 HTTP 通道仍可辨認可信同鍵同內容重送，不新增第二筆業務原項、不刷新原時間／FIFO／預算；入口滿且未驗證時不能宣稱原操作不存在或失敗。可信新項遇原項滿依 D97 明說未受理、不保留本次準時時間；不同內容依冪等衝突處理。
- 已採用說明界線：原操作 32 不是 32 筆並行業務寫入，相關寫入仍依既有單執行 FIFO。32／8／32 不是 32 人成功簽到、吞吐能力、即時回覆或容量內全部請求必定受理的保證；不同資源可能先滿，既有重送也受有限入口限制。
- 不變：D93、D95 的 HTTP 5 秒、執行 15 秒／3 輪、確認 10 秒／3 次及各起點保留；共同原子保存、未知停寫、已接收準時項不淘汰、一次回覆、維護與人工管控界線保留。不新增優先排程、分散式佇列或跨重置續辦能力。
- 未一併採用：暫占登記與重送關聯的完整接線、其他登入／唯讀路徑的資源上限、每來源或 IP 限流值、技術終局記憶容量／期限／保存方式、HTTP status／DTO、driver 取消機制，或程式設定已同步。三個上限不代表所有應用記憶體及網路資源均已受控。
- 待驗證：各容量邊界及超額拒絕、一般新項取得任一名額失敗時沒有登記／漏還、同鍵重送不增原項、驗證跨過 HTTP 5 秒仍占驗證槽、未知原項不釋放、完整安全收尾後才能再准入，以及競爭下不重複釋放。不假稱已完成容量、整合或故障測試。
- 依據：使用者接受；D98 公開攻防及本輪白話摘要；D76、D93、D95、D97。初值屬未量測的設計選擇，可依驗證證據調整，不是履歷已完成成果。

## 2026-09-19 容量初值交接資訊

- 可採用：D99 原操作 32／並行入口驗證 8／HTTP 等候 32 的可調待測初值、一般新項登記前取得完整所需名額、未登記暫占失敗歸還，以及非吞吐／體驗保證的界線；D97 名額生命期及滿容量重送規則保留。
- 下一步建議：把已採用架構收斂成分關卡的可執行方案，先明列仍待選定的技術細節及准入接線驗證，不自行開始重寫；不為容量初值另建大型佇列或恢復平台。
- 來源：沿用鎖定 A1–A6；保存時重讀 discuss.md 檢索卡及末尾、分段取得全文快照比對歷史，business-scope.md 僅比對 hash，其餘來源未重新查詢。使用者採用、公開角色論點與推論分列；LLM 背景知識開啟，無新增外查 Q 分支。
- 不可假設：32 等於 32 人保證成功簽到或 32 筆並行寫入、一般新項可以先登記再等容量、所有重送免入口限制、HTTP 結束即驗證完成、名額接線已驗證，或所有應用資源／終局記憶已具完整上限。
- 保存關卡：本次只更新 discuss.md，完成文字與歷史保留驗證後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：QR 輸入比對與結果共同保存

### D100｜四輪攻防區分輸入內容、格式與比較資料完整性

- 討論時間：2026-09-19 03:05:24 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：三輪質詢及一輪工程異端攻防完成；已採用範圍見 D101，其餘精確化仍為候選
- 初始候選：建立資格時只回傳一次原始 QR，資料庫以不保存原始 token 的摘要支援查找及重送比對。摘要演算法、長度、編碼及資料模型未指定；「僅存摘要」的完整方案不是本輪已驗證成果或全部已採用的設計。
- 第一輪質詢：首次無效 QR A 留下拒絕結果，同 Source／event ID 改送無效 QR B；兩次都映射不到資格，單靠相同拒絕結果或空資格 ID 無法識別不同內容。
- 第一輪捍衛修正：承認結果／映射不能代替輸入比對；候選改為從實際輸入產生秘密安全的比較表示，無效 QR 也須能比對。仲裁認為設計層缺口已回應，但摘要強度、碰撞及秘密保護仍待選擇與驗證，不能宣稱絕不碰撞。
- 第二輪質詢：合法輸入只有 JSON 欄位順序或字串外的空白不同，直接比較原始 JSON 會把同一業務內容當成衝突。
- 第二輪捍衛修正：提出依正式驗證後的業務欄位值比對、而非原始 JSON bytes 的候選；QR 字串本身不擅自 trim 或變更大小寫。仲裁將此列為精確化候選，尚未取得使用者逐項採用，完整正規化仍未決定。
- 第三輪質詢：QR 輸入使用既有鍵，卻額外夾帶 Face 專屬 provider／subject 欄位，應先格式拒絕還是進入回放／衝突？
- 第三輪捍衛修正：提出媒介專屬欄位互斥的候選；QR 夾帶 Face 專屬欄位時，正式格式驗證先拒絕，不進冪等、不建立業務 Event。保留既有認證／正式格式驗證先於冪等的順序；仲裁未將全部未知欄位政策或 DTO 定案。
- 第四輪工程異端：指出「不存原始 token」仍不足；若結果存下來但首次輸入比較資料漏存，後續無法分辨原內容重送與換 token。要求已保存、可回放的業務結果與必要比較資料共同原子保存。
- 第四輪捍衛修正：接受完整性缺口，補足共同原子保存的窄契約；包含無效 QR 拒絕結果，缺少必要比較資料不得當作完整可回放結果，也不得因此盲目重跑業務。共同存在只保證完整性，不證明摘要足夠、安全或絕無碰撞。
- 最終仲裁：完整性問題在契約層已回應；建議使用者先確認窄契約，其他摘要／格式候選、實作與測試仍保留未決。本輪無新增需核准的外查 Q 分支，沒有外部查證或工程測試。
- 角色與過程：首輪依一次性捍衛開場 → 質詢 → 捍衛 → 仲裁，後續各輪一名攻擊者 → 捍衛 → 仲裁。質詢修士、工程異端、捍衛及仲裁由獨立 agent 執行，只交換正式公開論點；未將 UX 異端插入本輪，不保存隱藏思考，也不把角色同意當成工程證據。
- 依據：本輪 K1 §4.2、§5.2–5.3、§7.1–7.3；本輪 K2 D05、D18 及既有共同保存方向；本輪 K3 B05、B33–B36、B41、P03–P05。來源路徑及狀態見末尾交接，不沿用歷史來源同名 ID 推定內容。

### D101｜接受可回放業務結果與首次輸入比較摘要共同原子保存

- 討論時間：2026-09-19 03:05:24 +08:00（回溯保存時間）
- 狀態：使用者已接受窄完整性契約；未實作、未測試
- 使用者確認：對「比較摘要與通行結果共同原子保存」回答「接受」；隨後確認每筆可回放結果、包含無效 QR 拒絕、不保存原始 token 及摘要演算法／格式未決的摘要，並對保存至 docs/discuss.md 回答「好」。
- 已採用契約：每筆已保存、可供同鍵重送回放的通行業務結果，必須與足以供首次輸入內容比對的秘密安全表示共同原子保存。本文以「比較摘要」簡稱其責任，不表示已選定某一 hash 演算法或固定欄位。
- 已採用涵蓋範圍：包含允許與拒絕結果，尤其是無效 QR 等沒有資格映射的拒絕。結果與必要比較資料一起成功或一起失敗；如本次另有必要 Presence／Mapping 變更，納入既有共同原子保存範圍，不拆成事後補寫比較摘要。
- 已採用不完整結果處理界線：缺少必要比較資料時，不得宣稱取得完整、可正常回放的業務結果，也不能因無法比對就盲目重新執行通行業務。具體技術錯誤與診斷方式仍待規劃。
- 保留秘密限制：不保存原始 QR token 作為重送比較資料；比較摘要也不得由公開查詢、事件回應、錯誤或日誌洩漏。QR 只在建立成功時回傳一次的既有規則不變；摘要如何滿足秘密安全仍需選擇及驗證。
- 未一併採用：摘要演算法、token 長度／編碼、是否使用金鑰、碰撞風險處理、查找摘要與重送表示是否共用、完整比較欄位／正規化、媒介專屬及未知欄位政策、DTO／HTTP status、MongoDB schema／索引，以及「資料庫只存摘要」的全部實作設計。D100 的 JSON 業務值及媒介互斥精確化保留為候選，不因本次窄契約接受而全部定案。
- 不擴大範圍：本條針對已持久保存的通行業務結果，不要求所有記憶體中進度或技術終局持久化；技術終局記憶／原 ID 保護機制仍屬本輪 K3 P10 的未決事項。不增加跨崩潰或每日重置續辦能力。
- 待驗證：原子保存故障時不出現結果／比較資料半套；無效 QR A 同鍵同內容重送能回放、改送 B 能識別衝突；必要 Presence／Mapping 變更不與事件及比較資料分離；比較資料缺失不誤回放或盲目重做；公開輸出及日誌不洩漏原始 token 或比較秘密。摘要選定後另驗證其比對與秘密保護性質；這些只是待執行情境，不是已完成測試。
- 依據：使用者明確接受與保存授權；D100 公開攻防及白話摘要；本輪 K1–K3 的既有契約與未決項目。採用完整性原則不等於工程成果已完成。

## 2026-09-19 QR 比較摘要交接資訊

- 可採用：D101 已保存、可回放的通行業務結果與首次輸入比較摘要共同原子保存，涵蓋無效 QR 拒絕及必要 Presence／Mapping 變更；缺少必要比較資料不得當完整回放結果或盲目重做，不保存原始 token。D99 與此前已採用安全／時間／容量規則保留。
- 下一題建議：先確認「相同業務內容」的欄位與格式邊界，明確區分格式錯誤、同內容回放及不同內容衝突，再選秘密安全表示；不直接跳到程式或宣稱摘要絕不碰撞。
- 本輪知識範圍：K1 `/home/sean/PassHub/docs/business-scope.md`（業務與採用架構契約，已參考・鎖定）；K2 `/home/sean/PassHub/docs/discuss.md`（D01–D99 歷史與本輪保存前基線，已參考・鎖定）；K3 `/home/sean/PassHub/docs/requirements-traceability.md`（要求及未決項目，已參考・鎖定）。這些為本輪 ID，不覆寫較早 A／K ID 的來源定義。本輪沒有停止或新增未使用來源。
- 實際使用與限制：攻防使用上述既有來源；保存時重讀本檔檢索卡及末尾，分段取得全文快照供歷史保留檢查，K1／K3 僅比對 hash，沒有重新查詢歷史外部 repositories。LLM 背景知識開啟，僅用於輸入／結果區分及完整性推論；使用者採用、角色推論與未驗證細節分列，無新增外查 Q 或實作測試。
- 不可假設：D100 全部候選已被接受、摘要演算法已定、格式與正規化已完整收斂、共同存在等於沒有碰撞或秘密洩漏、P05／P10 已全部解決，或業務文件／追蹤矩陣／程式已同步。
- 保存關卡：本次只更新 discuss.md，文字與歷史保留驗證後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：重送內容欄位與識別字串語意

### D102｜provider 大小寫反例補足合法與相同的區別

- 討論時間：2026-09-19 03:11:23 +08:00（回溯保存時間，非逐輪原始時間）
- 狀態：一輪質詢 → 捍衛 → 仲裁完成；採用範圍見 D103
- 初始候選：同 Source＋external event ID 下，正式格式驗證後比較媒介種類及對應業務輸入值，不比較原始 JSON 排版或映射後的資格。Source／event ID 定義鍵，伺服器時間與目前業務狀態不參與內容比較；QR token／subject 不擅自 trim 或改大小寫。
- 質詢修士：同鍵 FACE_MATCHED 重送，subject 相同，provider 從 `DemoFace` 改為 `demoface`，且假設兩者均通過格式驗證；原候選未明確說明 provider 是否保留原值，無法直接判定回放或衝突。
- 捍衛騎士：承認部分命中。合法只表示通過格式，不表示兩值相同；補足 provider 也保留正式驗證後的原字串值，不 trim、改大小寫或合併別名。因此兩種拼法依候選為不同內容，不能靠映射同資格宣稱相同。若日後改為大小寫不敏感，須另經確認且讓映射與比對使用一致規則。
- 仲裁賢者：定義層問題已回應，候選收斂為各媒介的明確欄位值契約；建議先由使用者確認，不繼續無限追問。完整未知欄位政策可另定，本輪沒有會改變判斷的關鍵外部事實缺口。
- 公開摘要：同鍵從 QR 改用 Face，即使映射同資格仍是衝突；真正改用另一種方式嘗試須使用新事件 ID。JSON 欄位順序與字串外排版空白不改業務值；伺服器時間與目前資格狀態不加入輸入比較。
- 角色與來源：質詢修士、捍衛騎士、仲裁賢者先獨立準備，再只交換正式公開論點；延續既有模式 D，不重做一次性開場。依據本輪 K1 §5.1–5.3、§7.2；本輪 K2 D100–D101；本輪 K3 P05。無新增外查 Q、檔案修改或實作測試，不保存隱藏思考，不把角色論證當成工程證據。

### D103｜接受三種輸入的精確值比對，不以資格映射代替輸入相同

- 討論時間：2026-09-19 03:11:23 +08:00（回溯保存時間）
- 狀態：使用者已接受欄位值契約；未實作、未測試
- 使用者確認：對「同鍵重送必須保持輸入方式及對應識別值完全相同，不以最後找到同一資格代替內容比較」及三種輸入欄位表回答「接受」；後續對保存至 docs/discuss.md 回答「好」。
- 已採用鍵界線：可信 Source 身分＋external event ID 用於定位原操作；不同 Source 的相同 event ID 不是同鍵。鍵相同後，依下表確認輸入內容是否相同，不使用原始機器憑證字串代替 Source 身分。

| 格式合法的輸入 | 納入相同內容比較的值 |
| --- | --- |
| QR_SCANNED | 輸入種類＋QR token。 |
| FACE_MATCHED | 輸入種類＋provider＋externalSubjectId。 |
| FACE_UNKNOWN | 輸入種類。 |

- 已採用字串語意：比較正式解析與格式驗證後的字串值，不擅自 trim、變更大小寫、合併別名或替識別值做隱含正規化；QR token、provider、externalSubjectId 均遵守這條規則。`DemoFace` 與 `demoface` 如均合法，仍是不同值。event ID 的完整格式／允許字元仍待定，不以本條假定所有字串都合法。
- 已採用排版界線：JSON 欄位順序及字串外的排版空白不構成內容變更；字串值內的空白不能當作排版擅自去除。伺服器 receivedAt、目前 Source 啟用狀態、Mapping、Qualification 與 Presence 不作為原輸入內容比較值；回放仍遵守原保存結果，不重新依當前狀態裁決。
- 已採用媒介界線：同鍵由 QR 改為 FACE_MATCHED／FACE_UNKNOWN，或更換 QR token、provider、subject，即使最後對應同一 Qualification，也為不同業務內容，依既有規則回 `IDEMPOTENCY_CONFLICT`，不覆寫原結果或新增業務 Event。真正更換方式或識別值的新嘗試須使用新 event ID；新 ID 不代表保留原接收時間，也不能繞過未知結果停寫或其他安全界線。
- 保留既有驗證順序：先完成 Source 認證與正式格式驗證，才進入冪等與內容比較。表格只定義合法輸入的業務比較欄位，不決定額外／未知欄位是否接受；格式錯誤不得被當成合法同內容重送或用舊 ID 繞過驗證。
- 與舊紀錄關係：補足 D100 的業務欄位值候選，更新 D101 交接中「比較欄位未定」的部分；D100 的媒介專屬欄位互斥及所有未知欄位處理仍待確認，不回寫歷史 block。D101 的秘密安全比較表示與結果共同原子保存規則保留，欄位相同的語意不等於摘要已設計完成。
- 未一併採用：完整 DTO／欄位命名、字串長度／允許字元、未知或錯媒介欄位處理、JSON 重複欄位政策、摘要演算法／序列化／金鑰／碰撞風險處理、MongoDB schema／索引、HTTP status，以及在途／技術終局記憶機制。K3 P05 只部分收斂，不標示全部完成。
- 待驗證：三種媒介各自同值可回放；同鍵更換媒介或任一識別值形成衝突；同資格的不同媒介不誤回放；JSON 排版改變不誤衝突；合法大小寫／字串內空白差異不被偷偷合併；同內容回放不重判效期、映射或 Presence。另驗證 D101 共同保存與秘密不洩漏。這些為待執行情境，沒有跑過測試或新增完成成果。
- 依據：使用者接受與保存授權；D102 正式攻防及公開摘要；本輪 K1–K3 既有契約。格式合法性與內容相同性分開判定。

## 2026-09-19 重送內容欄位交接資訊

- 可採用：D103 三種輸入的比較欄位、識別字串原值語意、JSON 排版不影響業務值、不同媒介即使映射同資格仍是不同內容；D101 比較表示與結果共同原子保存保留。新 ID 是新嘗試，不補原項的時間或安全資格。
- 下一題建議：處理正式格式驗證遇到額外／未知或其他媒介欄位時的邊界，再選秘密安全的比較表示；不要讓新欄位被默默忽略卻改變業務決策，也不重新開啟已採用的基本比對欄位。
- 本輪知識範圍：K1 `/home/sean/PassHub/docs/business-scope.md`（業務契約，已參考・鎖定）；K2 `/home/sean/PassHub/docs/discuss.md`（既有決策及 D100–D101，已參考・鎖定）；K3 `/home/sean/PassHub/docs/requirements-traceability.md`（未決項目 P05，已參考・鎖定）。沿用本輪 ID，不改寫歷史來源定義；沒有來源停止或新增未使用來源。
- 實際使用與限制：攻防重讀 K1 §5.1–5.3／§7.2 並使用 K2、K3 的既有上下文；保存時重讀本檔檢索卡與末尾、分段取得全文快照檢查歷史，K1／K3 僅比對 hash，未重新查詢外部 repositories。LLM 背景知識開啟，僅用於內容與排版區分的一般推論；使用者採用、角色推論及未驗證細節分列，無新增外查 Q 或實作測試。
- 不可假設：所有未知欄位／媒介互斥政策已採用、摘要設計已完成、原值比對等於所有字串都合法、P05 全部解決、換新 ID 可復用舊時間或繞過安全關卡，或業務文件／追蹤矩陣／程式已同步。
- 保存關卡：本次只更新 discuss.md，文字與歷史保留驗證後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：辨識請求嚴格欄位政策

### D104｜接受多餘欄位直接格式拒絕，不由舊事件 ID 繞過

- 討論時間：2026-09-19 03:13:50 +08:00（回溯保存時間，非原始選擇時點）
- 狀態：使用者已接受嚴格欄位政策；未實作、未測試
- 討論問題：辨識請求夾帶額外／未知或其他媒介的欄位時，直接拒絕，還是忽略後繼續處理？
- 決策過程：使用者直接回答「直接拒絕」；助理確認適用於辨識請求，列出 QR 夾帶人臉欄位及 FACE_UNKNOWN 夾帶 subject 的例子，並確認格式拒絕先於冪等、不建 Access Event；使用者對保存至 docs/discuss.md 回答「好」。本題為使用者直接選擇，不虛構角色攻防或獨立 agent 驗證。
- 已採用政策：每種 Recognition Attempt 只接受其正式契約允許的欄位；額外／未知及只屬於其他媒介的欄位直接拒絕為格式錯誤，不默默移除、忽略或轉換成合法輸入再處理。
- 已採用例子：QR_SCANNED 夾帶 Face 的 provider／externalSubjectId，或 FACE_UNKNOWN 夾帶 subject，都屬格式錯誤。三種輸入的合法業務值比對仍依 D103；共用 external event ID 等必要 envelope 欄位不是多餘欄位，實際命名與完整 DTO 尚待定義。
- 保留既有順序：通過基本／技術准入後，先完成 Source 認證，再做正式媒介格式驗證；格式不合法就停止，不進入冪等回放／內容衝突判斷，也不建立 Access Event。只依既有規則作去敏安全／技術紀錄，不回傳原始 token、秘密憑證或完整 Face subject。
- 已採用重送界線：即使 Source＋external event ID 已有原結果，夾帶多餘欄位仍須格式拒絕，不能以舊 ID 或「主要欄位沒變」繞過正式格式驗證。此格式拒絕不覆寫原保存結果；稍後真正格式合法且同內容的重送仍依原冪等規則處理。
- 與舊紀錄關係：補足 D100 第三輪的媒介專屬欄位互斥候選，以及 D103 保留的額外／未知欄位處理，更新其未決狀態；舊 block 保留為歷史。D101 的秘密安全比較資料共同保存與 D103 的原值比對不變。
- 適用邊界：本次只確認辨識請求的欄位政策，不自動擴張成所有管理／查詢 API、HTTP headers 或部署設定的共同政策；也不決定 parser、schema library、NestJS pipe 或框架接線。
- 未一併採用：API 路徑、DTO 精確欄位名稱／巢狀結構、完整必填與型別／長度／允許字元、JSON 重複欄位處理、HTTP status／錯誤碼、摘要演算法／序列化／金鑰與資料模型。不能把 P04／P05 整體標成完成，也不宣稱已具備正式實作。
- 待驗證：新 ID 與既有 ID 的額外／未知或錯媒介欄位均直接格式拒絕、不產生業務 Event／Presence 變更；合法共用欄位不誤拒絕；格式錯誤不覆寫原結果；後續合法同內容重送仍可回放；錯誤與技術紀錄不洩漏秘密。這些是待執行情境，未執行程式或測試。
- 依據：使用者直接選擇與保存授權；本輪 K1 §5.2–5.3、§7.1–7.2 的既有驗證／事件邊界；本輪 K2 D100–D103；本輪 K3 P04–P05 的未決項目。採用嚴格政策不表示完整格式契約或工程成果已完成。

## 2026-09-19 辨識請求嚴格欄位交接資訊

- 可採用：D104 按 Recognition Attempt 種類限制欄位，額外／未知或錯媒介欄位直接格式拒絕，不默默忽略，既有 event ID 不豁免；格式拒絕不進冪等、不建 Access Event、不覆寫原結果。D101 共同保存及 D103 業務值比對保留。
- 下一題建議：在已確認比對欄位與嚴格輸入政策上，討論 QR 查找及首次輸入比較資料的秘密安全表示；若選具體加密／摘要方案，須另取適用的官方來源與驗證依據，不以討論同意代替安全證明。
- 本輪知識範圍：K1 `/home/sean/PassHub/docs/business-scope.md`（既有驗證／事件契約，已參考・鎖定）；K2 `/home/sean/PassHub/docs/discuss.md`（採用與未決紀錄，已參考・鎖定）；K3 `/home/sean/PassHub/docs/requirements-traceability.md`（P04–P05 追蹤草案，已參考・鎖定）。沿用本輪來源 ID；無停止來源或新增未使用來源。
- 實際使用與限制：使用上述來源的既有上下文與使用者直接陳述；保存時重讀本檔檢索卡與末尾，以全文歷史 hash 檢查未改寫既有紀錄，K1／K3 僅比對 hash，未重新查詢外部 repositories。LLM 背景知識開啟，只作格式與業務流程區分的一般背景，無新增外查 Q、角色攻防或實作測試。
- 不可假設：完整 DTO／格式已定、所有 API 均採用同政策、未知欄位可以先默默剝除、摘要／儲存方案已完成、P04／P05 全部解決，或業務文件／追蹤矩陣／程式已同步。
- 保存關卡：本次只更新 discuss.md，文字與歷史保留驗證後停等；不修改其他文件／程式，不執行 Git、清資料或重啟。

## 第二階段討論續錄：QR 摘要、重送比較與欄位邊界

### D105｜Q1 官方查證：安全隨機值、SHA／HMAC 與秘密管理的適用界線

- 討論時間：2026-09-19 03:21:39 +08:00（回溯保存時間，非原始查詢或逐輪時點）
- 狀態：Q1 經使用者核准後已查證；專案具體安全性仍待判定與驗證
- 待判定問題：QR 查找與首次輸入比較應如何避免保存原始秘密，又能忠實比較合法業務值？採用摘要時，隨機性、可猜輸入、表示及金鑰管理有哪些前提？
- 授權與流程：仲裁提出 Q1 證據缺口與官方來源範圍，使用者回答「同意」後才開始查證；新增來源內容與完整知識範圍先回報，再返回模式 D。使用者對捍衛騎士整理優先候選回答「好」。沒有以資料查證直接代替使用者採用方案。
- 官方事實一：Node.js 提供 `randomBytes` 產生密碼學強度的偽隨機資料；`createHash` 與 `createHmac` 是不同 API，後者接受秘密金鑰，文件均展示 SHA-256 用法。這只支持 API 能力，不證明 PassHub 的表示、長度或部署安全。[Node.js 專案，Crypto：randomBytes](https://nodejs.org/api/crypto.html#cryptorandombytessize-callback)、[createHash](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options)、[createHmac](https://nodejs.org/api/crypto.html#cryptocreatehmacalgorithm-key-options)（動態文件，未標示單一發布年；查閱 2026-09-19）。
- 官方事實二：OWASP Session 指南區分熵與字串長度，要求安全隨機且不承載可理解的敏感內容；Forgot Password 指南要求 token 隨機、足夠長且安全保存。兩者分別是 session／密碼復原情境，不能直接把其位元數建議或一次性生命週期移植成 PassHub 已定規格。[OWASP，Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html#general-security-practices)（動態指南，未標示單一發布年；查閱 2026-09-19）。
- 官方事實三：OWASP Password Storage 說明攻擊者可以猜候選輸入、計算 hash 再比對；pepper 討論要求秘密與資料庫分開保存，並提供 HMAC 相關作法。這是密碼儲存情境的參考，不是 OWASP 直接指定 PassHub 使用 HMAC-SHA-256，也不表示登入密碼可改用一般 SHA／HMAC 儲存。[OWASP，Password Storage Cheat Sheet：When Password Hashes Can Be Cracked](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#when-password-hashes-can-be-cracked)、[Peppering](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#peppering)（動態指南，未標示單一發布年；查閱 2026-09-19）。
- 官方事實四：OWASP Secrets Management 反對把秘密硬編碼到 Docker ENV／ARG，提醒環境變數也可能經 dump／日誌暴露，並要求避免記錄秘密；部分金鑰材料需要跨部署保留。注入環境變數本身不等於完整安全方案。[OWASP，Secrets Management Cheat Sheet，§5.1／§6.2／§8.3](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)（動態指南，未標示單一發布年；查閱 2026-09-19）。
- 本輪推論，非來源直接要求：伺服器產生的高熵 QR 與使用者提交的無效 QR／Face subject 有不同可猜性；針對「只取得資料庫」的威脅，重送比較優先評估秘密與資料分開的 HMAC。保留比較資料時須維持相容的計算規則與金鑰，重啟不能默默換鍵。HMAC 不補救秘密一起外洩、表示歧義或錯誤輸入契約，也不提供零碰撞保證。
- 仲裁界線：來源支持 API、隨機性及秘密管理的一般前提；HMAC 分工與跨重啟相容是 PassHub 的設計推論。D101 共同保存與不洩漏原始 QR 的契約保留，尚未選 token 長度、完整表示或部署方式。Q1 不因完成閱讀而成為安全驗證全數通過。

### D106｜質詢命中摘要前的欄位歧義，候選收斂為明確邊界

- 討論時間：2026-09-19 03:21:39 +08:00（回溯保存時間）
- 狀態：一輪捍衛開場 → 質詢 → 捍衛 → 仲裁完成；採用範圍見 D107
- 獨立準備：捍衛騎士、質詢修士、仲裁賢者由三個獨立 agent 準備，再只傳遞正式公開論點。這是加入外部證據後的候選重述，不是假造另一輪一般開場；工程／UX 異端未參與本輪，不保存隱藏思考。
- 捍衛騎士開場：優先候選為安全隨機 QR；Qualification 用 SHA-256 token 摘要查找；整份合法業務輸入用 HMAC-SHA-256 比較重送。查找與內容比較不能混用，後者也涵蓋 Face、UNKNOWN 及無效 QR。保留 D103 原值、D104 格式先拒及 D101 原子保存；金鑰須與保留資料相容，缺失或無法確認相容時停止受影響能力，不默默換鍵。長度、表示與部署尚待定。
- 質詢修士：假設 provider／subject 的 `ab`＋`c` 與 `a`＋`bc` 都合法，D103 應視為不同內容。若摘要前的表示不保留欄位邊界，兩組可能都變成 `abc`；這是序列化歧義，不是 HMAC 碰撞。不指稱候選一定會裸串接，而是要求「無歧義」形成可檢查的約束。
- 捍衛騎士：承認部分命中；HMAC 不能修復摘要前混值。收斂為包含輸入種類、各種類固定欄位順序、每個欄位的明確長度與完整值，不用裸串接或含糊分隔符。`ab`／`c` 與 `a`／`bc` 的邊界結構不同；這只是結構示意，不是已定序列化。長度單位與編碼仍待定，不得藉轉碼、trim 或大小寫轉換改掉 D103 原值；應直接測表示層，不只觀察摘要輸出。
- 仲裁賢者：定義層挑戰已回應，候選從抽象「無歧義」縮至可審閱的種類／順序／長度／完整值方向；具體編碼仍未完成。SHA 與 HMAC 分工可供使用者採用，不構成完整安全證明；無須新增外查 Q 才能判定本次欄位邊界問題。建議確認後再由工程異端獨立挑戰，不自動續開下一輪。
- 依據與限制：K2 D101／D103／D104、K3 P05、D105 官方查證與分列推論；`ab`／`c` 例子是假設均合法的邊界反例，不決定 provider 的實際允許格式。沒有演算法實作、資料庫操作或測試結果。

### D107｜接受 QR 查找與重送比較分工、欄位邊界及金鑰相容性

- 討論時間：2026-09-19 03:21:39 +08:00（回溯保存時間）
- 狀態：使用者已接受設計方向；未實作、未測試
- 使用者確認：助理呈現正式攻防與摘要後，使用者回答「接受」；助理重述安全隨機 QR、SHA-256 查找、HMAC-SHA-256 比較、欄位邊界與金鑰一致性，明列未定細節，再詢問保存至 docs/discuss.md，使用者回答「好」。保存授權不延伸至其他文件或程式。
- 已採用分工：QR token 以密碼學安全隨機方式產生，仍依既有業務僅於建立成功時回傳一次。Qualification 保存 SHA-256 token 摘要供查找，不保存可再次取得的原始 QR；Event 的完整相關業務輸入比較表示使用 HMAC-SHA-256，不能以 Qualification 查找摘要、映射後資格或結果 reason 代替。
- 已採用表示方向：包含輸入種類、各種類固定欄位順序，每個欄位使用明確長度與完整值保留邊界。依 D103 比較合法解析後原字串值，JSON 排版不影響值，不擅自正規化；不得因不同欄位切分而形成同一摘要前輸入。具體編碼、長度單位及格式仍未選定。
- 已採用金鑰方向：HMAC 秘密與資料庫分開管理，不放入公開程式、Docker 定義或日誌；與保留比較資料維持相容，不能每次普通重啟重新產生。缺失或無法確認相容時，停止受影響能力，不靜默生成替代鍵。這是要求，不宣稱已有相容性檢查、部署注入或輪替工具；Qualification 的 SHA 查找與 Event 的 HMAC 比較各有用途，不能把缺鍵風險混稱為所有 SHA 查找都要秘密金鑰。
- 與舊紀錄關係：補足 D101 及 D104 的摘要演算法方向，更新 D105–D106 候選的採用狀態；D101 比較表示與可回放業務結果共同原子保存、D103 業務值契約、D104 嚴格格式先於冪等均不變。舊 block 保留歷史，不標示 K3 P05 或其他待辦整體完成。
- 未一併採用：token 位元／位元組長度與文字編碼、字串長度單位、完整 canonical representation、摘要儲存格式、用途標記／版本、金鑰取得／相容驗證／輪替方式、碰撞風險政策、完整 DTO、MongoDB schema／索引／driver 接線及測試工具。官方頁面所示 Node.js 版本不是本專案選定 runtime；Session 指南位元數不是已定 QR 長度。
- 待驗證，尚未執行：查找摘要與重送比較正確分工；同值異排版可回放，不同種類／識別值衝突；`ab`／`c` 與 `a`／`bc` 的摘要前表示不同；完整原值在編碼及長度計算下不丟失；重啟同資料同鍵仍可比對，缺失／不相容鍵不靜默替換；查詢、事件、錯誤、日誌與公開部署定義不洩漏原始 QR 或 HMAC 秘密；D101 原子保存及故障情境仍需真實整合驗收。不將測試規劃寫成成果。
- 判定界線：接受的是設計方向，不是「無碰撞」「可猜輸入已全面安全」「只要 HMAC 就安全」或跨崩潰恢復保證；整體文件保留 provisional／partially-sourced，工程要求仍未完成。

## 2026-09-19 QR 摘要與欄位邊界交接資訊

- 可採用：D107 安全隨機 QR、SHA-256 資格查找、HMAC-SHA-256 業務內容比較、種類／固定順序／明確長度／完整值方向，以及跨普通重啟的金鑰相容與缺失時停止受影響能力。D101／D103／D104 繼續適用。
- 下一題建議：由工程異端獨立挑戰這個已採用方向的工程適用性與剩餘風險，再由捍衛與仲裁回應；一次只處理一個問題，不與 UX 異端同輪混辯，不把長度、編碼或金鑰部署細節默認成已決定。保存驗證後先停等，不自動開始。
- 本輪允許來源與最終狀態：K1 `/home/sean/PassHub/docs/business-scope.md`（既有業務契約，已參考・鎖定）；K2 `/home/sean/PassHub/docs/discuss.md`（D101／D103／D104 及演化紀錄，已參考・鎖定）；K3 `/home/sean/PassHub/docs/requirements-traceability.md`（P05 未決項，已參考・鎖定）；K4 [Node.js Crypto](https://nodejs.org/api/crypto.html)（官方 API，已參考・鎖定）；K5 [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)（核准的官方指南範圍，已參考・鎖定）。本輪來源 ID 不重寫歷史 K／A 編號。
- 實際閱讀與使用：延續 K1–K3 既有上下文；查證實際讀取 K4 的 randomBytes／createHash／createHmac 相關內容，以及 K5 的 Session Management、Forgot Password、Password Storage、Secrets Management 四篇指南，對應段落見 D105。保存時重讀本檔檢索卡及末尾、取得歷史正文 hash；K1／K3 僅比對 hash，未重新研究外部公司 repositories。
- 來源狀態與推論：沒有停止使用的來源，也沒有加入但未使用的來源。LLM 背景知識開啟，僅用於欄位邊界、摘要與部署相容性的一般推論，不作專案實驗證據；使用者接受、官方事實、設計推論與待驗證項目分列。Q1 已核准且已查證一般前提，具體安全性仍無法以文件閱讀單獨判定；本輪未新增其他 Q。
- 不可假設：token 長度／編碼／長度單位／完整表示已定、金鑰部署或輪替已完成、HMAC 能修復序列化歧義或保證無碰撞、查證等於測試全綠、P05 整體解決，或業務文件／追蹤矩陣／程式已同步。
- 保存關卡：本次只更新 discuss.md；檢查歷史正文保留、編號連續、來源與未知標記及其他文件未變後停止。不修改程式／README／履歷，不執行 Git、清資料或重啟。

## 第二階段討論續錄：金鑰相容啟動檢查

### D108｜工程異端挑戰合法錯鍵，候選補足啟動檢查觸發條件

- 討論時間：2026-09-19 03:28:58 +08:00（回溯保存時間，非原始逐輪時點）
- 狀態：工程異端 → 捍衛 → 仲裁完成；採用範圍見 D109
- 討論問題：已有缺鍵／不相容時停止能力的政策，但系統如何發現格式合法、能正常計算 HMAC 的錯鍵，而不是等正確重送失敗才猜測？
- 工程異端：反對把「有載入、設定名稱相同」當相容證據；合法錯鍵可能讓正確重送誤報內容衝突，或讓新 Event 混入另一套比較資料。挑戰的是 D107 尚未決定的相容檢查觸發方法，不指稱已採用只看名稱，也不假稱已發現程式缺陷。要求最小、可驗證的金鑰及表示規則檢查。
- 捍衛騎士：部分命中；沒有採用只看名稱，但觸發條件確實未定。維持 D107，補候選：明確初始化時保存少量不含真實秘密的固定測試輸入、預期欄位表示及 HMAC 結果，保留比較資料關聯同一相容性標識。普通啟動核對表示、再以載入金鑰重算；不符、缺證據或標識混雜時停止受影響內容比較與新事件保存，回技術不相容，不誤報業務衝突。
- 捍衛收斂：測試組可包含不同 kind 及 `ab／c`、`a／bc` 邊界，僅能檢查涵蓋的差異，不證明所有資料或編碼正確。普通啟動不能因看似空資料或缺證據覆寫驗證紀錄；明確完整重置且確認舊比較資料清除後，才可重新初始化，不默默換鍵。具體表示、標識及初始化程序待定，不新增輪替／救援平台。
- 仲裁賢者：攻擊在設計層已有回應，D107 分工不變，新增相容檢查仍為候選，須經使用者確認。相容標識不是密碼學證明，少量測試不是全資料／全編碼驗證；本輪是自定啟動契約推論，沒有必要新增外查，推薦先確認最小契約再談具體格式。
- 獨立角色與依據：工程異端、捍衛、仲裁由三個獨立 agent 準備，僅交換正式公開論點；UX 異端未同輪參與，不保存隱藏思考。依據 K2 D107 相容要求及未決細節、K3 P05；錯鍵後果與驗證方法為本輪工程推論，不是外部案例或實驗成果。未改檔、未測試，無新增 Q。

### D109｜接受啟動先核對測試表示與摘要，不以錯鍵誤報業務衝突

- 討論時間：2026-09-19 03:28:58 +08:00（回溯保存時間）
- 狀態：使用者已接受最小啟動檢查契約；未實作、未測試
- 使用者確認：助理呈現一輪攻防與「初始化保存測試輸入／摘要、每次啟動核對、不符或缺失停止辨識決策、普通重啟不得覆寫」的白話方案，詢問是否接受，使用者回答「好」。助理確認採用，明示尚未實作／驗證並詢問保存至 docs/discuss.md，使用者再回答「好」。
- 已採用契約：明確初始化時保存一組非真實秘密的固定測試輸入、預期表示與使用當時金鑰計算的 HMAC 摘要；啟動接受辨識請求前，使用目前金鑰重算並核對，同時檢查欄位表示的一致性。只通過名稱、格式或金鑰非空檢查不夠。
- 已採用不相容界線：不符或檢查資料缺失時停止辨識決策；不能繼續形成允許／拒絕的業務 Event 或 Presence 變更，也不能把金鑰／表示問題誤報為訪客資格拒絕或 IDEMPOTENCY_CONFLICT。依技術不相容處理，不以新鍵重算替換舊檢查資料而假裝通過。具體錯誤格式與受影響能力的啟動接線未定。
- 已採用生命週期界線：普通重啟不得覆寫檢查資料；只有明確完整重置、確認舊比較資料已清除後，才可重新初始化。這不授權目前執行重置，也不決定重置時必須換鍵；D107 普通重啟保持金鑰相容及既有維護隔離方向不變。
- 與舊紀錄關係：補足 D107 的相容檢查方向，D101 共同原子保存、D103 原字串值、D104 格式先拒及 D107 SHA／HMAC 分工均保留；D108 的具體標識設計與測試案例是後續候選，不將完整資料模型或混雜判定接線默認為已定。舊 block 保留歷史，K3 P05 仍只部分收斂，要求工程證據不變。
- 未一併採用：固定測試組完整內容、表示／編碼／長度單位、相容性標識與資料關聯方法、混雜檢出方式、初始化程序及交易接線、金鑰部署／備份／輪替、HTTP status／錯誤碼、runtime 動態換鍵處理、資料完整性或防篡改證明。少量固定測試不能證明全部既有資料相容，不能把通過檢查當成整體安全保證。
- 待驗證，尚未執行：正確保留資料與金鑰普通重啟通過；格式合法錯鍵、缺鍵、缺檢查資料或測試表示改變時停止辨識決策；正確重送不因部署錯誤被誤報內容衝突；普通重啟不覆寫檢查證據；完整重置的隔離／清除／初始化與恢復順序安全；測試資料與錯誤日誌不洩漏真實 token、Face subject 或金鑰。這些只列為待驗收，不宣稱測試完成。
- 依據與判定：使用者接受／保存授權、D108 正式攻防、K2 D107；本輪是採用工程契約，不是新增官方安全標準或已驗證實作。整體 provisional／partially-sourced 狀態不變。

## 2026-09-19 金鑰相容啟動檢查交接資訊

- 可採用：D109 啟動前核對非秘密固定測試表示與摘要，不符／缺失停止辨識決策、不得誤報業務衝突；普通重啟不覆寫，完整重置確認舊比較資料清除後才重新初始化。D107 分工、金鑰相容及 D101／D103／D104 保留。
- 下一題建議：回到 D107 尚未定的字串編碼與長度單位，讓質詢修士檢查如何保留 D103 原字串值及 D106 欄位邊界；一次只形成一個可驗收契約，不先設計整套資料模型／輪替平台。保存後停等使用者，不自動辯論。
- 允許來源與最終狀態：K1 `/home/sean/PassHub/docs/business-scope.md`（既有業務契約，已參考・鎖定）；K2 `/home/sean/PassHub/docs/discuss.md`（D105–D107 及本輪演化，已參考・鎖定）；K3 `/home/sean/PassHub/docs/requirements-traceability.md`（P05 未決項，已參考・鎖定）；K4 [Node.js Crypto](https://nodejs.org/api/crypto.html)（D105 已查證 API 背景，已參考・鎖定）；K5 [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)（D105 已查證秘密管理背景，已參考・鎖定）。沿用來源 ID，不改寫歷史定義；沒有停止使用或新增未使用來源。
- 實際使用與限制：角色重讀 K2 D105–D107；主 agent 亦讀 K3 P05 相關紀錄，延續 K1／K4／K5 已有上下文，沒有本輪新增外查或重新研究公司 repositories。保存重讀本檔檢索卡／末尾，檢查歷史正文及 K1／K3 hash。LLM 背景知識開啟，僅作錯鍵後果、固定測試及生命週期區別的一般推論；使用者採用與未驗證工程細節分列。Q1 既有一般前提已查證，具體安全性仍待驗證，本輪未新增 Q。
- 不可假設：固定測試可證明全資料／全編碼／防篡改安全、相容標識方案已定、普通重啟可自動初始化缺失證據、完整重置一定換鍵、金鑰輪替／備份已完成，或業務文件／矩陣／程式已同步。
- 保存關卡：本次只更新 discuss.md；確認歷史完整、編號連續及其他文件未變後停止。不修改程式、README、履歷或其他文件，不執行 Git、資料清除或服務重啟。

## 第二階段討論續錄：字串編碼與完整組合驗收

### D110｜質詢未成對代理碼是否在轉碼時丟失原值，建立 Q2

- 討論時間：2026-09-19 03:57:56 +08:00（回溯保存時間，非原始逐輪時點）
- 狀態：質詢 → 捍衛 → 仲裁完成；當時外部事實待查，Q2 後續結果見 D111
- 初始缺口：D103 要求保留合法解析後的原字串；D107 已接受欄位邊界，但尚未定義字串範圍、編碼與長度單位。長度標示不能補救在編碼前已經丟失的原值。
- 質詢修士：以 JSON 轉義的 `\uD800`、`\uD801` 作假設反例；如果解析後不同的值在轉碼時都被替換成同樣的內容，明示欄位長度也無法區分。當時不把具體 Node 行為寫成已證實，也不假定正式契約接受這些字串。
- 捍衛騎士：承認部分命中；維持保留原值與欄位邊界，但補候選為先界定合法字串，再編碼。若不接受未成對代理碼就先拒絕；若要接受則必須另選能保留它們的表示，不能默默替換。具體 API 行為須查證，不以一般 Unicode 背景代替證據。
- 仲裁賢者：建立 Q2，需確認 JavaScript／JSON 字串範圍、UTF-8 轉碼及長度單位；資料可能影響選擇拒絕或保留這類值的方向。推薦核對 Node.js、ECMAScript、Unicode 官方來源；使用者回答「同意」，授權此窄範圍查證。
- Q2 當時問題：不同未成對代理碼是否可能形成相同 UTF-8 bytes？JavaScript 字串長度與 UTF-8 位元組長度是否不同？何種合法字串範圍能在不正規化或替換下保留原值？狀態由待核准改為已核准，後續查證與限制另錄 D111。
- 角色與來源：質詢、捍衛、仲裁為獨立 agent，僅交換正式公開論點，不記錄隱藏思考；基礎為 K2 D103／D107／D109、K3 P05 與本輪假設推論。反例不是已發現的 PassHub 缺陷，也不是已採用的完整輸入格式。

### D111｜Q2 官方查證與獨立唯讀實驗：字串長度不等於 UTF-8 長度

- 討論時間：2026-09-19 03:57:56 +08:00（回溯保存時間）
- 查詢日期：2026-09-19；Q2 已核准且已查證一般前提。完整表示與專案實作正確性仍無法由本次資料單獨判定。
- 官方事實一：ECMAScript String 是 16-bit code units 的序列，長度按這些單位計算，字串也可能含未成對代理碼；JSON 解析並不自動替專案建立「只接受合法 Unicode」的業務契約。來源：[Ecma International／TC39，ECMAScript String Type](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-ecmascript-language-types-string-type)、[JSON.parse](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse)（動態規範，查閱 2026-09-19；本次頁面顯示 2027，不代表專案採用該規範或 runtime 版本）。
- 官方事實二：`IsStringWellFormedUnicode` 對未成對代理碼判定不完整，`String.prototype.isWellFormed` 使用這項檢查。這提供合法字串檢查的官方語意背景，不是本專案已選定 API 或相容 runtime。來源：[Ecma International／TC39，IsStringWellFormedUnicode](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-isstringwellformedunicode)、[String.prototype.isWellFormed](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.iswellformed)（動態規範，查閱 2026-09-19）。
- 官方事實三：`Buffer.byteLength(string, encoding)` 計算指定編碼的位元組長度，不是 JavaScript 字串的 code-unit 長度；不能用 `string.length` 代替 UTF-8 bytes。來源：[Node.js，Buffer.byteLength](https://nodejs.org/api/buffer.html#static-method-bufferbytelengthstring-encoding)（動態官方 API 文件，未標示單一發布年；查閱 2026-09-19）。
- 官方事實四：Unicode scalar value 不包含 surrogate code points；UTF-8 對每個 scalar value 有唯一的 1–4 bytes 編碼，surrogate 的 UTF-8 編碼屬不合法序列。這支持先限定完整 Unicode 字串再無損編碼，但不直接要求所有產品採用拒絕政策。來源：[Unicode Consortium，Unicode 18.0.0 Core Specification，Chapter 3 §3.9，D76／D92](https://www.unicode.org/versions/Unicode18.0.0/core-spec/chapter-3/)（查閱 2026-09-19；由核准的 latest 範圍取得，不是本專案選定的版本）。
- 官方邊界：Node.js Crypto 提醒字串／bytes 的轉換可能丟失資訊，且不自動合併不同 Unicode 組合形式；其中密碼情境的正規化建議不覆寫 D103 的識別值原樣比對政策。來源：[Node.js，Using strings as inputs to cryptographic APIs](https://nodejs.org/api/crypto.html#using-strings-as-inputs-to-cryptographic-apis)（動態官方文件，查閱 2026-09-19）。不將其他 API 的轉碼說明直接冒充 `Buffer.from` 對此反例的實測結果。
- 獨立實驗觀察：在 Node.js `v24.12.0`，`JSON.parse` 得到的 `\uD800` 與 `\uD801` 原值不同，code unit 分別為 55296、55297；`Buffer.from(value, "utf8")` 的結果卻都為 `efbfbd`。這確認本環境存在轉碼前不同、轉碼後相同的反例，不是摘要碰撞。
- 合法樣本觀察：`A` 的 JavaScript 長度／UTF-8 bytes 為 1／1；`中` 為 1／3；`😀` 為 2／4。三者分別編碼再解碼都取回原值。這只是逐欄樣本結果，不證明完整 frame 邊界，也不證明所有版本或所有輸入都正確。
- 重跑方式：在 shell 執行以下唯讀單行實驗；不讀寫專案、資料庫或真實秘密。保存時於同日重跑得到相同觀察。

```sh
node -e 'const a=JSON.parse("\"\\uD800\""),b=JSON.parse("\"\\uD801\""); console.log(JSON.stringify({nodeVersion:process.version,differentParsedValues:a!==b,aCodeUnit:a.charCodeAt(0),bCodeUnit:b.charCodeAt(0),aUtf8Hex:Buffer.from(a,"utf8").toString("hex"),bUtf8Hex:Buffer.from(b,"utf8").toString("hex"),equalUtf8:Buffer.from(a,"utf8").equals(Buffer.from(b,"utf8")),samples:["A","中","😀"].map(s=>({text:s,jsLength:s.length,utf8Bytes:Buffer.byteLength(s,"utf8"),roundTrip:Buffer.from(s,"utf8").toString("utf8")===s})),wellFormedApi:typeof "".isWellFormed}));'
```

- 證據與採用分離：官方資料與實驗支持「若不先限制字串，轉碼可能丟值」；拒絕未成對代理碼、UTF-8 與位元組長度是後續 PassHub 的設計選擇，不是來源直接指定。未執行 PassHub 測試、資料庫整合或 CI；不選定 runtime，也不提供完整序列化或密碼學安全證明。

### D112｜證據後重述與合法中文／emoji 質詢：補完整組合驗收

- 討論時間：2026-09-19 03:57:56 +08:00（回溯保存時間）
- 狀態：證據回歸、捍衛重述與合法多位元組的一輪質詢 → 捍衛 → 仲裁完成；採用範圍見 D113
- 回到脈絡：Q2 查證後先回仲裁，說明未成對代理碼轉碼失真的風險已有本環境觀察，但方案尚未被使用者採用；使用者選擇重述及後續合法多位元組檢驗，這些分支選擇不被記成提前採納。
- 捍衛騎士重述：相關識別、映射及冪等字串解析後先拒絕未成對代理碼；合法原值以 UTF-8 編碼，每欄使用實際 bytes 長度，不用 JavaScript 字串長度；不替換、trim、改大小寫或正規化。合法配對 emoji 不因 surrogate 檢查被誤拒，但仍須符合後續正式欄位限制。Face 預綁與查找使用同一無損範圍，external event ID 也不能在轉碼中丟值。保留 kind／固定順序／明確長度／完整值，允許字元、上限與完整 frame 仍未定。
- 質詢修士：假設 provider 是 `中`、subject 是 `😀A`，UTF-8 長度分別 3、5 bytes；不指稱候選切錯，但逐欄長度及 roundtrip 還不能證明完整表示中的欄位邊界。要求可檢查證據，確認取值不截斷、不吃進下一欄。
- 捍衛騎士：承認部分命中，維持實際 UTF-8 bytes 長度；已有逐欄樣本證據，但尚無完整 frame 證據。補候選驗收：待格式選定，把 `中`、`😀A` 編入整筆表示並依格式獨立解讀，確認長度 3／5、每欄 bytes 等於原始編碼、解碼回原值、下一欄起點及整筆結束位置正確；另加入相鄰多位元組欄位及截短資料反例，拒絕不完整表示。這是測試方法，不新增產品的公開解碼 API。
- 仲裁賢者：設計層已補回應，但完整格式未選、驗收未執行。主張維持 UTF-8 位元組長度，新增完整組合與截短反例的驗收條件；本輪無需新增外查。推薦先由使用者確認編碼／長度與驗收方向，再討論具體格式，不自動採納或改檔。
- 獨立角色與來源：質詢、捍衛、仲裁由三個獨立 agent 先準備，再僅交換正式公開論點；工程／UX 異端未混入同輪，不保存隱藏思考。實際依據為 K2 D103／D107、Q2 K6–K8 與分列的本輪測試推論；中文／emoji 欄位是假設合法的測試案例，不決定 production 欄位格式。

### D113｜接受 UTF-8 無損原值、位元組長度與完整組合驗收

- 討論時間：2026-09-19 03:57:56 +08:00（回溯保存時間）
- 狀態：使用者已接受設計與驗收方向；未實作、未通過 PassHub 測試
- 使用者確認：助理呈現一輪正式攻防，以「不修改原字串、拒絕無法完整編碼的內容、按實際 bytes 計長度、驗證完整組合」詢問是否接受，使用者回答「接受」。助理重述並詢問將這輪結論與前面查證結果保存至 docs/discuss.md，使用者回答「好」。授權只更新本紀錄，不修改程式或其他文件。
- 已採用字串契約：本輪所指「無法完整編碼」具體為解析後含未成對代理碼的相關字串，須在 UTF-8 編碼前按格式拒絕，不能替換成其他字元後繼續；完整、符合正式欄位限制的原值以 UTF-8 編碼，各欄長度採該欄實際位元組數，不採 JavaScript `string.length`。合法配對 emoji 不因 well-formed 檢查被誤拒，不代表各欄已開放所有 Unicode 字元。
- 已採用原值界線：不 trim、不轉大小寫、不 Unicode 正規化、不修復非法值；Face 預綁與辨識查找使用同樣無損字串範圍，external event ID 也要保留完整原值。只約束參與識別、映射及冪等的相關字串，不自動擴張成所有自由文字的驗證政策。
- 保留既有比較語意：比較解析後的合法值，不比較 JSON 排版；直接 `中` 與 JSON 轉義 `\u4E2D` 解析為同一值時不因此衝突。不同合法原值不因視覺相似或 Unicode 組合形式被默默合併。無效 Unicode 字串依 D104 格式先拒、不進冪等判斷、不建業務 Event，只沿用去敏技術紀錄；既有 event ID 也不豁免。
- 已採用驗收方向：正式組合格式選定後，直接驗證 kind、固定欄序、各欄明確 bytes 長度及完整值；用 `中`／`😀A` 等假設合法案例作獨立取值檢查，確認 3／5 bytes、逐欄原始 bytes 與解碼原值、下一欄起點及整筆結束。包含相鄰多位元組、截短／不完整表示及 D106 的 `ab／c` 對 `a／bc` 邊界反例；不只以 HMAC 輸出是否不同判斷表示正確。
- 與舊紀錄關係：補足 D107 的編碼與長度單位，以及 D106 的原值／邊界驗收；D109 啟動相容檢查、D101 原子保存、D103 原值與 D104 嚴格格式順序保留。只更新相關未決項，不回寫舊 block，不把 P05 或工程要求整體標為完成。
- 未一併採用：每欄完整允許字元／空值政策／長度上限、長度前綴寬度與位元序、kind 的具體表示、版本／用途標記、完整 frame、token 位元數及發行文字格式、DTO／JSON 重複欄位政策、具體 API／validator／runtime、MongoDB 字串比較接線與資料模型、初始化測試組及金鑰管理方案。UTF-8 的選擇不是 QR 發行格式的選擇。
- 待執行驗收：含未成對代理碼的輸入直接格式拒絕，不得先替換或丟值再受理；正式允許的中文／emoji 完整 roundtrip；Face 綁定與查找範圍一致；external event ID 不轉碼合併；完整表示、邊界反例與截短資料符合上述規則；同值異排版可回放而不同合法原值衝突；錯誤／日誌不洩漏原始 QR、完整 Face subject 或金鑰。D111 是孤立實驗，這些 PassHub 情境尚未實作或驗證。
- 判定界線：接受設計決定不等於程式正確、測試全綠、無碰撞或全 Unicode／跨版本證明。整體 `provisional`／`partially-sourced` 與工程要求待完成狀態不變。

## 2026-09-19 字串編碼與完整組合驗收交接資訊

- 可採用：D113 相關字串先拒絕未成對代理碼，再 UTF-8 編碼、按每欄實際 bytes 標長度，保留原值不隱式轉換；完整組合須驗證欄位邊界、原值、下一欄起點、整筆結束及截短反例。D101／D103／D104／D107／D109 保留。
- 下一題建議：討論多欄位的具體組合格式，讓固定順序與長度規則形成可直接測試的表示；一次只收斂一個問題，不提前決定整套 DTO／資料模型／金鑰管理。保存驗證後停等，不自動開啟新攻防。
- 本輪允許來源與最終狀態：K1 `/home/sean/PassHub/docs/business-scope.md`（既有業務契約）；K2 `/home/sean/PassHub/docs/discuss.md`（D103／D107／D109 及本輪演化）；K3 `/home/sean/PassHub/docs/requirements-traceability.md`（P05 未決項）；K4 [Node.js Crypto](https://nodejs.org/api/crypto.html)（API 與字串輸入邊界）；K5 [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)（D105 既有秘密管理背景）；K6 [Node.js Buffer](https://nodejs.org/api/buffer.html)（位元組長度／轉碼背景）；K7 [ECMAScript](https://tc39.es/ecma262/)（String、JSON.parse、well-formed 檢查）；K8 [Unicode Core Specification](https://www.unicode.org/versions/latest/)（Q2 取得 Chapter 3）。八項均為已參考・鎖定，沿用本輪來源 ID，不改寫歷史定義；沒有停止來源或加入未使用來源。
- 實際讀取與使用：Q2 讀取 K6 編碼／byteLength 相關段落、K7 String／JSON.parse／IsStringWellFormedUnicode／isWellFormed、K8 Chapter 3 §3.9、K4 Crypto 字串輸入注意事項，精確連結及採用知識見 D111。延續 K1–K3 既有上下文、K5 的 D105 背景；本次保存重讀 K2 檢索卡與末尾、核對 K1／K3 hash，重跑 D111 孤立唯讀實驗，未重新研究公司 repositories 或新增外查。
- 證據層級：官方事實、獨立實驗、使用者接受及本輪驗收推論分列。LLM 背景知識開啟，僅用於「逐欄樣本不等於完整 frame」及無損／邊界驗收的一般背景，不冒充實作證據。Q1 一般前提既有已查證；Q2 已核准、已查證本輪一般前提，完整格式與 PassHub 正確性仍待決定及驗證；沒有新 Q。
- 不可假設：完整表示、前綴／上限／允許字元、QR 發行格式或 runtime 已定；所有自由文字都採用同政策；合法所有 Unicode 字元均可當識別值；逐欄 roundtrip 或固定啟動樣本可證明完整表示與全資料安全；業務文件／矩陣／程式已同步。
- 保存關卡：只更新 discuss.md，保留舊 block；檢查歷史正文、frontmatter、編號連續及其他文件未變後停止。不修改程式、README、履歷或矩陣，不執行 Git 寫入、資料清除或服務重啟。

## 第二階段討論續錄：持續授權與完整實作方案收斂

### D114｜持續逐題深議、預設接受、保存驗證後續進，停在實作前

- 記錄日期：2026-09-19（Asia/Taipei，回溯保存；不捏造原始秒數）
- 狀態：使用者明確授權流程變更；不授權程式實作
- 使用者指示：現在開始按當前流程逐步討論到執行實作之前一步停下；每討論完一題就寫文件，寫完再接續，不停下，預設接受深度討論過後的決策。
- 流程調整：保留獨立角色準備、單一攻擊者 → 捍衛 → 仲裁，以及工程／UX 異端分輪。仲裁後依本次持續授權採用有充分理由的決策，先保存及檢查，再進推薦的下一題；不再要求每題單獨回答「接受」或「保存」。這是使用者本次的流程覆寫，不把它偽裝成使用者逐題說過相同話，也不改写舊輪的候選／接受狀態。
- 授權範圍：完成剩餘 P01–P15 實作契約、必要的官方來源查核及可交付實作者的規劃文件；必要文件同步須先列差異、逐小段驗證，保持歷史可追溯。必要查證只限影響本方案的官方 API／安全／交易／部署前提，仍列 Q 與來源，不以自主流程免除證據義務。
- 終點與禁止：所有阻擋實作的契約須有決策、可執行小關卡、驗收對應與剩餘風險；到實作準備完成就停止。禁止開始程式重寫、修改 package／設定、安裝依賴、移動舊碼、執行資料清除／重啟、建立遠端資源或投履歷。規劃命令可以寫入文件，不能直接執行那些變更。
- 完成判準：不能只補摘要便宣告結束；要逐項核對 P01–P15 與既有 136 條要求，確認沒有未決阻擋、舊要求丟失、候選偷變採用或實作成果誤報。待執行的工程驗收維持 U，不要求在規劃階段假造綠燈。
- 中斷檢查：續進時實際確認本檔末尾仍為 D113，相關 agent 均已完成，未發現本次中斷留下的新實作或新紀錄；不重啟未知背景工作。前段保存後停等規則保留為歷史，從本 block 起由本次持續授權取代。

### D115｜長度前綴格式與內嵌零值質詢的保存及採用

- 記錄日期：2026-09-19（回溯保存前一輪已發生攻防）
- 狀態：依 D114 持續授權採用前輪深議後的格式；未實作、未通過測試，後续工程比較可以另開 block 修正
- 捍衛開場：內部重送比較格式為 ASCII `PassHub/idem/v1`＋一個零位元組，再接一位元組 kind；`0x01`＝QR_SCANNED 接 token，`0x02`＝FACE_MATCHED 依序接 provider／externalSubjectId，`0x03`＝FACE_UNKNOWN 不接資料欄。每欄採四位元組無號大端序長度＋完整原值 UTF-8 bytes，全部供 HMAC 計算。
- 格式界線：按 kind 決定固定欄數，必須恰好讀完整筆；不足、多餘或未定 kind 不接受。Source＋external event ID 仍為冪等鍵，不把目前時間、映射、Presence 或裁決結果混入內容。用途／版本也納入 HMAC，規則變更不能沿用 v1 靜默改義，須明確處理保留資料相容。
- 質詢修士：沒有指出已存在結構歧義，提出假設合法 subject 為 `A\u0000B` 的驗收邊界；要求確認內容零值不是終止符，且表示與 `AB` 不同，不因標頭也有零值而截斷。
- 捍衛回應：未命中結構歧義；標頭零值只在固定標頭位置，各欄照明示長度讀取，不掃零找結尾。假設兩者都允許，`A\u0000B` 為三 bytes，`AB` 為兩 bytes，長度及完整內容不同。補待執行的逐 bytes 表示、原值、下一欄起點／整筆結束驗收，而不是只比較 HMAC。
- 仲裁：反例在設計層已回應，候選維持；字元規則是否允許 NUL 與大小上限仍未定，測試未執行不等於已找到程式缺陷；本輪無新外查需求。此前停等於具體格式確認，本次按 D114 持續授權記錄採用，而非捏造一次個別接受。
- 不擴張與安全：只在記憶體中形成必要的內部 HMAC 輸入，不保存或公開含原始 QR 的 frame，不建立產品解碼 API。各欄／整筆需有限大小檢查，四位元組能表示的容量不是允許輸入上限，禁止截斷。實際字元／上限及啟動向量仍需後續收斂。
- 獨立角色與依據：前輪質詢、捍衛、仲裁為三個獨立 agent，僅傳遞正式公開論點；來源 K2 D103／D107／D113 與 Q2 的 K6–K8，frame 及驗收屬工程決策／推論，不是官方指定格式或已完成成果。
- 下一題：工程異端比較此自定 bytes 格式與固定 JSON array 的審閱／維護責任，確認工程必要性，不能只因時限或假設性能便選型；格式若改，以新 block 明確取代，不改寫本段。

### D116｜工程異端命中二進位選型必要性，Q3 查證 JSON 固定表示

- 記錄日期：2026-09-19（Asia/Taipei，回溯保存正式公開攻防及當日查證）
- 狀態：工程異端 → 捍衛 → 仲裁；Q3 查證返回 → 捍衛正式重述 → 仲裁完成。採用見 D117，未實作。
- 工程異端：優先固定 JSON array，保留 kind、固定欄數與每欄 UTF-8 長度，另定唯一序列化；測試向量容易閱讀，自定 binary 另有位移、大端序及長度读寫責任。不公開 decoder 不消除審閱成本，JSON 也須固定跳脫；問現有三種內部輸入有何需求足以支持額外責任。這是清晰度取捨，不拿兩天時限或虛構性能作理由。
- 捍衛騎士：命中選型理由，不是證明 binary 錯誤；撤回 binary 優先，保留 D107／D113 的欄序、長度與原值，改提固定 JSON v2；精確序列化前提須另查官方規範。
- 仲裁／Q3：建立窄查證，核對 K7 `JSON.stringify`、`QuoteJSONString`、`SerializeJSONArray`；依 D114 持續授權由 root 核准，不捏造個別使用者查證答覆。Q3 已查證一般前提，完整實作／跨版本正確性仍待驗證。
- 官方查證：陣列按索引序列化，未指定 `space` 不加入縮排；字串引號、反斜線及控制字元有指定跳脫。`toJSON`、`undefined`、非有限數字有特殊處理，因此不能把任意客端物件視為安全固定表示。來源：[Ecma International／TC39，JSON.stringify](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.stringify)、[QuoteJSONString](https://tc39.es/ecma262/multipage/structured-data.html#sec-quotejsonstring)、[SerializeJSONArray](https://tc39.es/ecma262/multipage/structured-data.html#sec-serializejsonarray)（動態規範，查閱 2026-09-19；頁面顯示 ECMAScript 2027，非專案 runtime 選型）。
- 獨立實驗：Node.js v24.12.0 的唯讀樣本中，v2 `中`／`😀A` 取回原值；`ab／c` 與 `a／bc` 不同；內嵌零、引號、反斜線完整保留；直接中文及 JSON 轉義解析為同值時表示相同。這些是孤立 API 樣本，不是 PassHub 測試、HMAC 零碰撞證明或全面版本保證。
- 證據後重述：伺服器重新建立普通密集陣列，只放已驗證 primitive strings 與計算出的有限非負安全整數；不接受任意物件／缺項／自訂 `toJSON`，不用 replacer 或縮排。官方資料支持一般序列化前提；限制輸入與選用 JSON 是本輪工程推論，不冒稱官方指定 PassHub。
- 獨立角色與来源：工程異端、捍衛、仲裁先獨立準備，僅交換上述正式公開論點，不保存隱藏思考；來源 K2 D103／D107／D113／D115、Q3 K7 及 K6 的既有 byteLength 背景。K1–K8 均維持已參考・鎖定，沒有停止來源；本輪新讀 K7 的三項 JSON 定義，未新增來源 ID 或查詢公司 repositories。

### D117｜採用受限固定 JSON v2，明確取代二進位格式優先

- 記錄日期：2026-09-19
- 狀態：依 D114 持續授權預設接受深議決策；未實作、工程驗收待執行
- 採用理由：目前沒有已確認的性能／跨語言需求足以支持二進位的額外位移與長度讀寫責任；固定 JSON array 保留既有比較契約，表示向量較易審閱。不是宣稱 JSON 普遍較優，也不說 binary 有已證缺陷。
- 唯一 v2 結構：

```text
["PassHub/idem/v2","QR_SCANNED",[n,token]]
["PassHub/idem/v2","FACE_MATCHED",[n,provider],[m,externalSubjectId]]
["PassHub/idem/v2","FACE_UNKNOWN"]
```

- `n`／`m` 是原字串實際 UTF-8 bytes 長度，不是跳脫後 JSON 文字長度，也不是 `string.length`。伺服器自行建立固定、無缺項的普通陣列，長度只能是計算所得的有限非負安全整數；只接受通過正式契約／well-formed 檢查的原字串，不 trim／改大小寫／正規化。不序列化任意客端物件，不使用 replacer、縮排、自訂 `toJSON`、raw JSON 或猴子補丁。
- 唯一序列化：對此受限陣列呼叫 `JSON.stringify(array)`，將回傳字串以 UTF-8 編碼，整份 bytes 作 HMAC-SHA-256 輸入；不是任意 JSON 的 canonicalization。用途／版本、kind、各欄長度與完整值均入比較，Source／external event ID 作鍵，時間／映射／結果不加入表示。
- 取代路徑：D115 binary 格式為歷史；實作者使用本 block 的 JSON v2，不實作 v1 binary 或通用版本框架。版本字串沿用 v2 以明示本次改規則，日後不得保留同版本靜默改義；D109 啟動向量亦按本採用表示建立。現階段沒有舊版已發布資料，不因這次討論就新增資料遷移平台。
- 秘密界線：完整表示僅在必要記憶體中用於計算，不保存／公開／記錄它或原始 QR；只依 D101 共同保存必要比較摘要與 canonical 結果。QR Qualification 的 SHA-256 查找與 Event HMAC 比較仍分工，不混用。
- 表示層驗收：三種精確結構、固定欄數／順序、長度、完整值及終結；`ab／c` 對 `a／bc`、正式允許的中文／emoji、引號／反斜線、假設允許時內嵌零、同解析值異 JSON 排版；拒絕缺值、未成對代理碼、額外欄及格式截短。驗收用的解讀工具不是產品解碼 API，不只比較 HMAC 是否不同。樣本中正式契約不允許的內容，分成低層表示測試及 API 格式拒絕測試，不假稱它已開放。
- 仍待下一題：正式識別字元、欄位與整筆大小上限、QR 熵及發行文字格式；不從四 bytes 舊容量或 JSON 結構推導無限允許大小。這些有待採用，不授權實作者任選。
- 來源與授權：D116 正式攻防／Q3 及 D114 持續授權；不虛構使用者在本題另說過「接受」。保存後檢查歷史及編號，再進識別輸入契約，程式不變。

### D118｜UX 異端挑戰空白分類，Q4 核對 QR 發行表示

- 記錄日期：2026-09-19
- 狀態：UX 異端 → 捍衛 → 仲裁，Q4 返回完成；採用見 D119，未實作。
- 初始候選：32 安全隨機 bytes／無 padding base64url QR；辨識 QR 可接受非發行長度的合法未知值；provider／event ID 有界 ASCII，subject 非空且 256 UTF-8 bytes，禁控制碼、首尾 U+0020，保留其他合法空白；frame 有界 1024 bytes。
- UX 異端：原值識別卻只禁首尾普通空格、接受外觀近似其他空白，會讓手機測試者難理解同樣看似空白的值，一種格式錯誤、一種未映射；主張保留首尾 U+0020，不 trim 或合併，控制字元禁令照舊。問單禁普通空格的業務價值是否足以承擔負擔。
- 捍衛：命中選擇理由，沒有業務依據支持單禁 U+0020；改為保留 subject 首尾普通空格，明定非空是至少一個碼點，因此純空白也可合法，不代表空字串。照原值綁定／查找，查無映射形成業務拒絕，不設 fallback。承認肉眼辨識負擔仍存在，不能假稱原值政策消除了所有 UX 風險。
- 仲裁：退守有效，可形成一致契約；所有數值是 Demo 待測初值而非外部最佳值。建立 Q4 核對 base64url 編碼，依 D114 root 核准必要窄查證。
- Q4 官方事實：`Buffer` 編碼為 `base64url` 字串時省略 padding；解碼器能接受普通 base64，不能代替專案的嚴格字元驗證。來源：[Node.js，Buffer：Buffers and character encodings](https://nodejs.org/api/buffer.html#buffers-and-character-encodings)（動態官方文件，查閱 2026-09-19；頁面顯示 v26.9.0，不代表 project runtime）。專案不解碼再重編 token，沿用 D103 原值識別。
- Q4 樣本：Node.js v24.12.0 唯讀 `Buffer.alloc(32, 0).toString("base64url")` 長度 43、無 `=`、符合 base64url 字母集合；固定零值只是格式樣本，不是真實 QR、隨機品質或專案測試證據。
- frame 有界樣本：同環境的固定 JSON v2，128 個 ASCII QR 字元的表示為 169 bytes；64 ASCII provider＋256 個反斜線 subject 的表示為 627 bytes，小於 1024。這是跳脫擴張邊界樣本，驗收仍需實際 validator／property cases，不能只靠兩筆樣本稱全集證明。
- 獨立角色與來源：UX 異端、捍衛、仲裁先獨立準備，再只交換正式論點；工程異端未同輪混入。K2 D103／D113／D117，Q4 K6 編碼段及已有 Q1 K4 隨機 API；沒有新來源 ID、停止來源或隱藏思考保存。Q4 已核准、已查證一般前提；剩餘 validator 及安全接線仍待工程驗證。

### D119｜採用有限識別契約與 32-byte QR 發行，區分格式與未映射

- 記錄日期：2026-09-19
- 狀態：依 D114 預設接受深議決策；採用初值，未實作、未量測
- 各識別字串先拒絕未成對代理碼，不做 trim、大小寫轉換、別名合併或 Unicode 正規化。下列模式表示完整值的允許集合，不准接受部分匹配或尾端多餘字元。

| 欄位／用途 | 採用契約 |
|---|---|
| QR 發行 | `randomBytes(32)` 的無 padding base64url 編碼，43 ASCII 字元；秘密隨機 bytes 為 256 bits，此為長度而非實測安全保證。建立成功僅回傳一次。 |
| Recognition QR token | `[A-Za-z0-9_-]{1,128}`，大小寫及原值精確識別，不要求 43 字元，不做 base64 解碼／重編；合法未知值形成 `INVALID_QR_CREDENTIAL` 業務 Event。 |
| provider | `[A-Za-z][A-Za-z0-9._-]{0,63}`，1–64 ASCII bytes；合法非預置 provider 不當格式錯誤，依目前 mapping 形成未映射拒絕。 |
| externalEventId | `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`，1–128 ASCII bytes；不轉大小寫，同可信 Source 共同定義鍵。 |
| externalSubjectId | 非空（至少一個完整碼點），至多 256 UTF-8 bytes；禁止 U+0000–001F、U+007F–009F、U+2028、U+2029，其餘合法原值保留，包括中文、emoji、首尾及純空白。 |
| 內部 JSON v2 表示 | 最多 1024 UTF-8 bytes；各 length 由驗證後原值計算，不受客端指定；超界不截斷。 |

- Face 預綁／修改與辨識查找使用完全相同 provider／subject 範圍與精確字串語意，不能管理時修剪、查找時保留，或以相同資格掩蓋內容改變。`FACE_UNKNOWN` 不帶 provider／subject，比較仍只有 kind；完整 DTO 另題。
- 格式與業務拒絕：非字串、空字串、非法字元、未成對代理碼或超界在正式格式驗證停止，不入冪等／不建 Access Event；合法但未知 QR／Face 才進既有業務拒絕及共同保存。舊 event ID 不豁免格式；合法相同內容仍可回放原结果。
- UX 限制：subject 原值是上游模擬身分，不是姓名，也不保證視覺唯一；Demo 主例用易辨 ASCII 假 ID，另測合法 Unicode／空白差異。不提供前端修剪、別名修復或身分 fallback；查詢／日誌仍不公開完整 subject。控制碼政策與長度只是有限 Demo 契約，不宣稱適用所有辨識供應商。
- 必要驗收（待執行）：發行 QR 長度／alphabet／一次回傳；合法未知短 QR 保存拒絕；非法字元／尾換行／超界 QR 格式拒絕；provider 1／64／65、ID 1／128／129、subject 256／257 UTF-8 邊界，ASCII 與多位元組分開；空字串、非字串、控制码拒絕；空白原值及 Unicode 組合形式不合併；預綁／查找一致；frame 精確 bytes 及 1024 邊界；錯誤無秘密輸出。舊 NUL 反例仍可測低層表示，但 API 層因本契約拒絕，不稱 NUL 已開放。
- 不一併決定：displayName、撤銷 reason、時間 DTO、整體 body／headers／slow upload、登入 token／source credential、資料庫 collation／schema、啟動向量／相容 ID、runtime。這些按 P04／P06／P03／P13 後續逐題收斂。
- 採用與取代：D118 原先首尾 U+0020 禁令已由本條取代，D113 原值／UTF-8、D117 JSON v2、D109 啟動檢查與既有共同保存不變。依 D114 授權，不冒稱使用者另作個別選擇；未將工程要求改成 V／R。
- 下一題：P06 人員／機器認證與秘密、啟動相容檢查的具體契約；P01–P15 其餘項仍列待辦，不因本題完成就宣告可實作。

### D120｜工程異端限定相容標籤掃描的證據，補強唯一計算入口

- 記錄日期：2026-09-19；狀態：独立工程異端 → 捍衛 → 仲裁，採用見 D122。
- 捍衛開場：人員短效 JWT、每請求查目前帳號；機器秘密驗證後建立可信 Source，active 留在 Access 的新嘗試回放檢查之後；三種部署秘密分離。啟動使用資料集 referenceID、非秘密 v2 表示／HMAC 向量，並掃保留比較記錄的 ID。
- 工程異端：固定向量驗證目前設定，全掃只能驗標籤。若某保存路徑使用另一規則算摘要，卻貼上相同 ID，兩檢查仍可能通過；這是待排除反例，不是已發現缺陷。要求每次保存有受約束的計算來源，而非把標籤同一當充分證明。
- 捍衛：承認部分命中，收縮掃描保障到缺失／混合 ID 的完整性檢查。啟動驗證後凍結編碼器與 HMAC 鍵，形成唯一比較能力，共同產出摘要與 ID；呼叫端不能另算摘要自行貼 ID。保存用例只接受共同產物，與 canonical 結果原子保存。介面不是實作證明，仍須檢查全部入口並測錯鍵／錯編碼器反例。
- 仲裁：設計層補強，計算正確性仍待工程證據；保留掃描但不再宣稱證明摘要來源。P06 的 JWT、scrypt、安全比對 API 未充分查明，推薦唯一下一分支 Q5，不串另一名攻擊者。
- 獨立性及依據：三個既有獨立 agent，只交換上述正式公開論點；K2 D107／D109／D117、D119 與人員／Source 既有責任，反例與唯一能力屬本輪工程推論。沒有讀其他角色準備或保存隱藏思考。

### D121｜Q5 官方查證認證 API 與成本前提，返回後重述

- 記錄日期：2026-09-19；狀態：依 D114 持續授權 root 核准必要窄查證，已查證一般 API 前提；不是使用者另逐項答覆或專案驗收。
- 查證範圍：K4 Node.js Crypto 的 scrypt／timingSafeEqual；K5 OWASP 密碼指南的 scrypt；新增 K9 Nest JWT、K10 jsonwebtoken 官方 README。主題具體，不研究公司系統、不拓展認證管理平台。
- 完整知識範圍：K1 business-scope.md、K2 discuss.md、K3 requirements-traceability.md、K4 https://nodejs.org/api/crypto.html、K5 https://cheatsheetseries.owasp.org/、K6 https://nodejs.org/api/buffer.html、K7 https://tc39.es/ecma262/、K8 https://www.unicode.org/versions/latest/、K9 https://github.com/nestjs/jwt/blob/master/README.md、K10 https://github.com/auth0/node-jsonwebtoken/blob/master/README.md，均已參考・鎖定；沒有停止來源。LLM 背景知識開啟，只補一般工程取捨。
- 實讀與採用知識：K9 的 JwtService.verify／verifyAsync／module options 說明包裝 jsonwebtoken，呼叫 options 可覆寫秘密，故本案要封裝禁止外部覆寫；K10 的 jwt.verify 選項可限定 algorithms、issuer、audience、maxAge，回傳 payload 仍須視為輸入驗證。預設 secret 可接受不只 HS256，不能拿預設值代替限定。來源：[NestJS JWT README](https://github.com/nestjs/jwt/blob/master/README.md)、[Auth0 jsonwebtoken README](https://github.com/auth0/node-jsonwebtoken/blob/master/README.md)（master 動態資料，查閱 2026-09-19，尚未鎖依賴版本）。
- K4 的實際定義：非同步 scrypt 接受 N／r／p 與 maxmem，預設 maxmem 為 32 MiB；記憶體要求約 128×N×r，超界會錯。salt 建議隨機且至少 16 bytes。timingSafeEqual 要求等長 bytes，長度不同會 throw，周邊程式仍可能有時間洩漏。來源：[Node.js scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)、[timingSafeEqual](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b)（查閱頁顯示 Node.js 26.9.0，不是本案 runtime）。
- K5 的實際指南：Argon2id 優先，scrypt 為替代；列 N=131072／r=8／p=1 等 CPU／RAM 折衷組合。選原生 scrypt 是本案工程取捨，不冒称 OWASP 首選。來源：[OWASP Password Storage：scrypt](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)（查閱 2026-09-19）。
- 返回仲裁 → 捍衛重述：證據要求明列 JWT 算法、驗 payload、秘密封裝、scrypt 參數與 maxmem、等長摘要比對。捍衛据此正式提出 D122 的完整初值，仲裁認為可保存設計，版本鎖定／登入資源界線及真實測試仍待下一關。
- 邊界：沒有安裝 JWT 套件、跑密碼成本實驗或 PassHub 測試；API 文件不能證明接線安全、全部寫入口受約束或抗過載。Q5 一般前提查明，實作證據維持未知。

### D122｜採用人員／機器認證契約及凍結的比較能力

- 記錄日期：2026-09-19；狀態：依 D114 持續授權預設接受深議決策，未實作、未量測；不冒稱使用者另作本題選擇。
- 人員 JWT：獨立 32 安全隨機 bytes 的 HS256 簽章鍵，期限 900 秒，issuer=`PassHub`、audience=`human-api`。只發 sub／iat／exp／iss／aud；驗證指定 algorithms=[HS256]、issuer、audience、數字 maxAge=900，禁止關閉期限檢查。驗後另要求字串 sub、整數 iat／exp、精確 iss／aud、exp=iat+900、iat 不在未來、exp 尚未到期。封裝不允許呼叫者覆寫秘密或選項，不以 decode 代 verify、不 refresh、不增登出／帳號管理能力。
- 人員權限：每次依 sub 查目前帳號啟用狀態及 Operator／Viewer 角色，不採舊 role claim；原 Auth／Access 責任不變。時間精度為 JWT 秒，相關測試使用可控制時鐘，不能用容忍值悄悄延長期限。
- seed 密碼：非同步 scrypt，N=131072、r=8、p=1、每帳號獨立隨機 salt 至少 16 bytes、keylen=64 bytes、maxmem=268435456 bytes；保存算法／參數／salt／摘要，驗證用固定已採用參數。不得用 SHA-256 代替人員密碼雜湊。這些為待测初值，P13 必須決定登入並行與入口成本上限，參數本身不保證抗過載。
- 機器憑證：預置 entry／exit Source 的 `entry.<secret>`／`exit.<secret>`；secret 發行為 32 隨機 bytes 的無 padding base64url，43 ASCII。解析只接受這兩個前段、單一分隔點與完整 43 字元 base64url 字母集合，不 trim／解碼重編／大小寫合併；前段只是未可信 lookup hint。對 secret 原值算 SHA-256，DB 摘要必為 32-byte Buffer，等長 timingSafeEqual 成功才取得可信 Source。畸形 DB 摘要屬技術失敗，不洩漏秘密、帳號／Source 存在資訊或繞過驗證；單一 API 不是整體時間安全證明。
- 啟用與回放：Source active 不搬到 Auth；可信且格式合法的舊鍵同內容先回放，新的合法嘗試才由 Access 判 active，避免停用改寫首次結果。帳密錯誤只留已去敏的安全／技術紀錄，不建立 Access Event。
- 秘密：JWT 鍵、內容 HMAC 鍵、DB 登入秘密分離，部署注入、不進 Git／映像／log／OpenAPI 範例；普通啟動不重新產生，程序中不更換。刻意公開的假 Demo 人員密碼／機器憑證與上述秘密不同，不宣稱它們私密或可直接沿用正式營運。
- 啟動相容證據：資料集 referenceID，加上非秘密 QR=`A`、MATCHED provider=`DemoFace`／subject=`中😀`、UNKNOWN 三向量的 D117 v2 預期表示與 HMAC。核對目前表示／鍵結果，再檢查保留比较記錄是否缺失／混合 ID；不相容停受影響能力，普通空 DB 不自動補證據。僅明確完整 reset，隔離舊工作并清除舊比較資料後初始化新證據。
- 唯一比較能力：啟動核對後凍結 v2 編碼器／鍵，共同產生摘要與 referenceID；呼叫端不得另算摘要或自行指定 ID，保存入口只接共同產物，與 canonical 結果原子保存。全掃只能查標籤完整性，不能證明摘要來源／正確性；D109 啟動契約保留但保障按本輪明示限定。不能以此保存 raw QR／frame 作額外證明。
- 驗收待辦：錯簽章／算法／iss／aud／缺或畸形 claims／未來 iat／過期／角色改變；salt／參數／成本、畸形摘要與通用認證失敗；秘密掃描及啟動錯鍵／錯表示／缺混 ID；全保存入口和錯能力注入；原子保存、普通重啟及 reset。未執行、136 條既有工程要求保持 U。
- 下一題：仲裁推薦 P07，先鎖 runtime／依賴與真實 MongoDB 交易測試環境，讓後續契約能在同一環境重現；P01 目錄／備份与其餘 P 題保留待辦，不能略過或開始實作。

### D123｜P07 正常 Demo 與故障驗證分開啟動，不能拆成兩套版本

- 記錄日期：2026-09-19；狀態：獨立捍衛开場 → UX 異端 → 捍衛 → 仲裁，依 D114 採用展示入口分離，工具未驗證。
- 捍衛初始候選：受支持 Node LTS、Nest 預設 Express adapter、strict TypeScript、官方 MongoDB driver，查相容後鎖精確 patch。Jest／Supertest 驗 HTTP，Docker 真 replica set 驗交易，再以傳輸故障驗未知／晚結果；不把 mock timeout 當證據。顯式交易 API 仍要查原生重試是否繞既定額度。
- UX 異端：陌生面試者不應先理解故障攔截才可体验核心流程；要求正常 Demo 保留真交易，故障驗證只明確另行啟動，同一鎖版基線。
- 捍衛：承認重現流程缺口，正式補上兩入口。正常僅單 API＋真 replica set，seed／相容檢查後先登入、建立、辨識與回放；故障專項在隔離 test DB 明確加入工具，逐案列操作、API 進度、DB 保存證據、未知時不可解鎖／重做判準。前置條件分列，不能只交成功輸出。
- 仲裁：UX 缺口在設計層已回應，工具与精確版本仍未驗；推薦 Q6a「可重現交易基線」窄查證，不一次連測試工具也猜定。按 D114 持續授權 root 核准來源查證，非使用者另作個別答覆。
- 獨立性及依據：捍衛、UX 異端、仲裁獨立準備，只交換正式論點；工程異端未混入同輪。K1–K3、D114／D122，展示取捨屬本輪推論，沒有實作／安裝。

### D124｜Q6a 發行與固定 driver 來源查核，顯式 API 不等於沒有隱藏重送

- 記錄日期：2026-09-19；狀態：一般前提與版本 metadata 已查，工程驗收未执行。
- 完整知識範圍：K1 `/home/sean/PassHub/docs/business-scope.md`；K2 `/home/sean/PassHub/docs/discuss.md`；K3 `/home/sean/PassHub/docs/requirements-traceability.md`；K4 [Node Crypto](https://nodejs.org/api/crypto.html)；K5 [OWASP](https://cheatsheetseries.owasp.org/)；K6 [Node Buffer](https://nodejs.org/api/buffer.html)；K7 [ECMAScript](https://tc39.es/ecma262/)；K8 [Unicode](https://www.unicode.org/versions/latest/)；K9 [Nest JWT README](https://github.com/nestjs/jwt/blob/master/README.md)；K10 [jsonwebtoken README](https://github.com/auth0/node-jsonwebtoken/blob/master/README.md)；K11 [Node 發行資訊](https://nodejs.org/en/about/previous-releases)；K12 [Nest 遷移指南](https://docs.nestjs.com/migration-guide)；K13 [Mongo 交易文件](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)；K14 [Mongo 相容表](https://www.mongodb.com/docs/drivers/compatibility/)；K15 [官方 driver repository](https://github.com/mongodb/node-mongodb-native)；K16 [npm 官方 registry](https://registry.npmjs.org/)；K17 [Docker 官方映像清單](https://github.com/docker-library/official-images)及唯讀 registry manifest；K18 [MongoDB 8.0 發行紀錄](https://www.mongodb.com/docs/manual/release-notes/8.0/)；K19 [TypeScript 5.9 發行說明](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html)。均已參考・鎖定，無停止來源；LLM 背景開啟，僅用於取捨。
- K11／K12 實讀：Node 24 為 LTS、頁列 24.21.0。Nest 現行指南是 12，core packages 為 ESM；允許使用支援 require-ESM 的 Node 保留應用 CJS，應用及 CLI 的最低 Node 不同，24.21 滿足所列要求。不是用 Node 26 動態 API 文件替專案選型，也不沿用模型對 Nest 11 的印象。
- K13 實讀：Core API 明確建立／提交／結束交易及 session，Convenient API 另有自動重試。官方範例的重試策略不等於本案的有限額度；僅選 Core 不足以保證每次呼叫只送一次。
- K15 固定來源：先讀 v7.0.0 sessions 作線索，不當最終版本；以 v7.6.0 [sessions.ts](https://github.com/mongodb/node-mongodb-native/blob/v7.6.0/src/sessions.ts)、[execute_operation.ts](https://github.com/mongodb/node-mongodb-native/blob/v7.6.0/src/operations/execute_operation.ts)、[mongo_client.ts](https://github.com/mongodb/node-mongodb-native/blob/v7.6.0/src/mongo_client.ts)、[connection_string.ts](https://github.com/mongodb/node-mongodb-native/blob/v7.6.0/src/connection_string.ts)及 [README](https://github.com/mongodb/node-mongodb-native/blob/v7.6.0/README.md)核對。commit 的 maxAttempts 由 maxAdaptiveRetries+1 產生，剩餘零可提前拋錯；不能只依 unknown label 有無斷定成敗。abort 仍有內部再送一次分支，且吞部分錯誤／轉本地 ABORTED；resolve 或本地狀態不證明伺服器已回滾。公共 maxAdaptiveRetries 允許 0，但不能因此宣稱所有方法零重送。
- K16 實際唯讀 GET：core／common／platform-express／testing=12.0.3，platform 使用 Express 5.2.1；JWT=12.0.2 的 peer 包含 Nest 12、依賴 jsonwebtoken 9.0.3；Swagger=12.0.1 的 peer 是 Nest 12；mongodb=7.6.0 engines >=20.19.0。另取 TS 5.9.3 精確 metadata，沒有因 latest=7.0.2 自動採最新 compiler。Jest 30.5.2／Supertest 7.2.2 只取得 engines 線索，仍為待補查工具候選。瀏覽器 registry 讀取失敗後，以 Node fetch 唯讀 metadata，未安裝、未輸出認證 token。
- K17 實讀 library/node 與 library/mongo 有 D125 exact tags。唯讀 Docker registry manifest 取得 OCI index digest 和 linux amd64／arm64 子 manifest，沒有 pull／啟動映像；pin index 固定兩平台，不能把 mutable tag 當完整鎖定。K19 §Support for --module node20 說明穩定選項及 CJS require-ESM，支持編譯候選，不是 clean compile 證據。
- 無法採用的部分：K14 表格未完整取得，不宣稱完整矩陣已核對；K15 README 只取得 server 4.4+ 的一般支持敘述。K18 讀發行頁但不採其中性能百分比／全面安全或完整相容結論。metadata、tag、source inspection 均不能證明依賴無漏洞或 PassHub 可執行。
- 返回仲裁 → 捍衛正式重述 → 仲裁：採 D125 的明確驗證基線；撤除 Core＝零隱藏重試的假設。P08 必須處理 abort 實際送出與無效果／無遲寫證據，未解不能放處理權；P07 的測試工具及相容／建置驗收仍待後段。

### D125｜採用精確驗證基線，保留真交易與預算的阻擋關卡

- 記錄日期：2026-09-19；狀態：依 D114 持續授權採用版本／編譯及展示基線，未實作。P07 不標全完成，工程要求全部維持 U。

| 項目 | 採用基線 |
|---|---|
| Node.js | 24.21.0 LTS |
| TypeScript | 5.9.3，不追 TS 7 最新值 |
| Nest core／common／platform-express／testing | 同為 12.0.3 |
| Express adapter 所用 Express | 5.2.1，不另換框架 |
| Nest JWT／jsonwebtoken | 12.0.2／9.0.3 |
| OpenAPI 的 Nest Swagger | 12.0.1 |
| MongoDB 官方 driver／server | 7.6.0／8.0.32 |
| 應用模組／編譯 | CommonJS，module=node20、target=ES2023、strict、legacy decorators／metadata；須乾淨編譯驗接線，不依 Nest 12 內部 ESM 強迫整個應用改 ESM。 |

- npm 直接依賴使用精確版本，後續實作產生並提交 lockfile，以 npm ci 重現傳遞依賴；目前不建立 package 或 lockfile。版本若因實際不相容要改，先報證據與調整決策，不能默改或聲稱 metadata 已證編譯。
- Docker 固定基線（2026-09-19 唯讀取得 OCI index）：`node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`；`mongo:8.0.32-noble@sha256:01354084d2ae665d2e79b79b0cdc50c2c0c98873618912d9a2c8c9cb5c3d24e6`。沒有拉取或驗運行；主验收平台 linux amd64，arm64 只證 manifest 存在，不冒稱已測。
- 正常 Demo 單 API＋真 replica set，不啟動故障攔截工具；故障專項明確 opt-in、隔離 test DB、與正常使用同一鎖版，不把 Docker、transaction integration 或故障效果以 mocks 替代。節點數／具體命令仍由部署與交付關卡收斂，不宣稱高可用。
- 交易 API 候選收斂：採 Core 明確控制，不用 withTransaction 自動重跑；client 設 retryReads=false、retryWrites=false、maxAdaptiveRetries=0，仍需真 command monitoring／故障測試驗實際發送。全部重跑必須遵守 D91／D93 額度且重新建操作範圍／重讀判斷，時間及原項不能刷新。這不是「所有隱藏重送已消除」的證明。
- 未解阻擋：abort 內建重送的計量與取消／結果證據；commit 不確定錯誤分類；真 replica 保存／並行／fault 驗收；Jest／Supertest／fault 工具細節；完整相容核對及乾淨安裝／編譯。不能因 Promise 完成、本地 transaction state、缺 label 或 HTTP timeout 放權。原有 fail-closed、共同保存及準時保護不退回。
- 仲裁推荐下一單題 P08：abort 何種證據足以解除處理權、實際內建送出如何納額度；這直接影響完整性。P01 備份／目錄及其餘 P 題仍未完成，版本基線不是實作授權。

### D126｜P08 放權證據須涵蓋完整交易／清理生命週期，單次 abort 控制不足

- 記錄日期：2026-09-19；狀態：獨立捍衛開場 → 工程異端 → 捍衛 → 仲裁完成，依 D114 採用約束收縮；具體 API 可行性待 Q7，不標 P08 定案。
- 捍衛開場：只有能歸屬原交易的伺服器終止證據，加上舊工作不可能再寫，才可解除相關寫入權；須排除尚未解決 commit，所有已發命令已完成或可靠隔離。abort Promise、本地 ABORTED、查無 Event 或 timeout 都不夠。確認中的 abort 每次發送也計共同額度，不借 cleanup 免費重送；已確認完整保存則回放，不再追無效果。優先評估可證單次送出的公開操作，但未證明存在安全接線。
- 工程異端：單次 abort 的限制未涵蓋整个收尾。finally／endSession 若另觸發終止命令，可能在額度耗盡後發送或在原確認尚未完成時另開一路；這是生命週期邊界反例，不是已驗證程式缺陷。
- 捍衛：部分命中，收縮到全部終止／確認／session 清理入口。可能發命令的自動清理同樣不得繞 D87／D93 的共同額度、非並行及停止；純本地釋放不是 server 終止證據。不修改 driver private state，不假稱 raw 單次命令已可用；無證保留停寫。
- 仲裁：約束部分解決，公開 API 能否做到仍未知；建立 Q7 窄查固定 driver 7.6 的 abort／endSession／finally 何時送出、內重試／公開控制及結果與在途工作證據。依 D114 root 核准必要查證後接續，不串第二個攻擊者或開始實作。
- 不退回：D87 確認每發送嘗試含失敗計次，D93 10 秒／3 次與間隔，D91 15 秒／3 輪及不補確認的安全收尾，D89 原項續辦安全條件均保留；未知不能報業務拒絕或為新 ID 放行。
- 獨立性及依據：工程異端、捍衛、仲裁先獨立準備，只交換上述公開論點；K15 固定來源線索、D87／D89／D91／D93／D125。尚無新的官方事實採用、測試或程式修改；Q7 為下一窄分支，不將候選偷改成可執行成果。

### D127｜Q7 固定公開 API 的生命週期查證，不能以單次 raw 中止解全部階段

- 記錄日期：2026-09-19；狀態：依 D114 root 核准 Q7 窄查證，一般來源前提已查；仍未實作。
- 知識範圍：K1–K19 的完整路徑、用途與已參考・鎖定狀態沿 D124，不變更定義或停止使用。新增 K20 [MongoDB 8.0 中止命令](https://www.mongodb.com/docs/v8.0/reference/command/aborttransaction/)（server 命令語義）；K21 [Node driver 監測文件](https://www.mongodb.com/docs/drivers/node/current/monitoring-and-logging/monitoring/)（命令事件）；K22 [官方命令監測規範](https://github.com/mongodb/specifications/blob/master/source/command-logging-and-monitoring/command-logging-and-monitoring.md)（事件關聯及邊界），均實讀並鎖定。LLM 背景仍開啟，只作一般推論。
- 完整引用回執：K15 固定 v7.6.0 sessions.ts 的 endSession／asyncDispose／commit finally／applySession，以及 [db.ts 的 command](https://github.com/mongodb/node-mongodb-native/blob/v7.6.0/src/db.ts)、[run_command.ts](https://github.com/mongodb/node-mongodb-native/blob/v7.6.0/src/operations/run_command.ts)、[operation.ts](https://github.com/mongodb/node-mongodb-native/blob/v7.6.0/src/operations/operation.ts)，配既讀 execute_operation.ts，核對公開呼叫与 session 裝飾。endSession 交易仍 active 時會呼叫 public abort，且可能吞部分錯；dispose 亦走 endSession。不能無條件 finally 自動收尾後就放權。
- 單次 raw API 邊界：Db.command 公開接 session／timeout，RunCommandOperation 未設一般 retry aspects；零 adaptive retry 基線提供單送候選線索，但尚無真 wire 驗證。applySession 自附原 session 的 lsid／txnNumber／autocommit；raw abort 不自動把 active 的本地狀態改 ABORTED，所以其後 endSession 仍可能多送。不能由單次呼叫來源推導整个生命週期受控，不用 driver private state 補丁。
- 阶段限定（固定來源事实）：commitTransaction 的 finally 不論成功／錯誤都轉本地 COMMITTED；這不是 server 提交證明，但通常使 endSession 不再認為 inTransaction。public abort 對此本地狀態會拒絕，所以它不能一概當 unknown commit 的處理 API。上述 raw＋cleanup 反例主要針對 precommit active 階段，不能混寫所有階段。
- K20 實讀 Definition／Syntax／Atomicity：abortTransaction 對 admin DB、原 session／交易執行，正常中止丟棄交易內變更。來源一般語義不能替特定回覆歸屬、在途工作或 error 的判定；NoSuchTransaction 不單獨證明之前沒有提交。曾先讀 current 8.3 頁，再核對 8.0 固定 major 頁，不用 8.3 新功能冒稱 8.0 已具備。
- K21／K22 實讀 Command Events、Guarantees、Succeeded or Failed：監測預設關閉，monitorCommands=true 才開。started 與 succeeded／failed 用相同 requestId 關聯；ok=1 的命令即使有 write errors 仍可稱 succeeded，送出例外也可稱 failed。故只看事件名稱不足，須檢查原命令／交易、實際回覆及所有在途工作；started 不證 server 收到，failed 不證 server 沒執行。事件完整 command／reply 不可直接印 log，以免洩漏秘密與 subject。
- 取得限制：舊 command-monitoring 子路徑失敗後，採 current monitoring 的實際章節與官方規範；搜尋命中的第三方鏡像及無關舊文件沒有採用。查閱 2026-09-19，K22 master 動態、driver 原始碼固定 tag；沒有安裝、跑 Mongo 或 PassHub 測試。
- 返回仲裁：Q7 否定「單次 raw＝全生命週期無隱藏送出」的充分性，推薦捍衛重述完整窄生命週期候選；若需改政策必須明示另辯，不把公開 API 尚未知的部分藏在永久停寫裡。

### D128｜提出原生 public abort 成組額度取捨，尚未採用變更

- 記錄日期：2026-09-19；狀態：神諭返回 → 捍衛重述 → 仲裁，僅形成待深議候選；不因 D114 預設接受便跳過未解政策。
- 捍衛新版候選：不直接 raw abort 留 active 再讓 endSession 補送，而評估 public abort「有界成組終止」。原項停止新業務，釐清既有命令，發前保守扣兩個共同確認名額、整組獨占；實際只送一次亦不補回。完成後再檢查本地非 active 才 endSession，不另開 finally 終止路徑。
- 顯式政策差異：原生第二送可能不遵 D93 的 1／2 秒間隔及窗口；需另決定能否允許窗口內獲准的最多兩送組完成。本輪沒有採用這個例外或改寫 D87／D93，不假稱舊規則已容許。
- 放權證據候選：能歸原交易、無錯誤的 abort 成功回覆，加上無未決 commit、全部舊命令已收束且不能晚寫；NoSuchTransaction、succeeded 名稱、本地 ABORTED、endSession 完成各自都不夠。實際生命周期、普通未遇未知的收尾額度起點仍須收斂。
- 仲裁：成組預扣是待裁定取捨，非已證 API 能力；public abort 須限尚可中止的交易，unknown commit 不能交同路徑。推薦下一單輪工程異端檢查「階段限定与成組額度能否共同滿足既有規則」；UX 留後輪、不混攻擊。
- 來源與授權：K15／K20–K22 查證、D87／D89／D91／D93、D126–D127 與本輪推論；只交換正式公開資料。按 D114 保存／驗證後接推薦分支，不標工程證據完成、不修改程式或既有政策。

### D129｜採用 precommit 有界終止組例外，明示取代 D93 的局部逐送節奏

- 記錄日期：2026-09-19；狀態：工程異端 → 捍衛 → 仲裁完成，依 D114 持續授權採用政策方向，實作及普通清理起點待後題。
- 工程異端：precommit 限定避免 API 誤用、預扣兩格限制次數，兩者都不保證原生第二送在十秒內或遵守間隔；如期限前准入、第一送失敗後第二送跨期限，次數雖沒超用，時間規則已改。承認候選已揭露取捨，要求明確選逐送停止還是整組繼續，不同時宣稱兼有。
- 捍衛：選「期限內准入的有界終止組可繼續」，放棄組內期限後絕無新送出的保證。理由是保留公開 driver 的完整中止生命週期，不改 private state，也不將 raw 中止後額外清理藏起來。限 precommit；准入時須仍在確認窗口、有至少兩格，保守扣兩格、不因實際一送退回；原生組最多兩送，不並行其他確認。組內第二送可跨窗口、無原來 1／2 秒間隔。
- 仲裁：攻擊命中並引出正面取捨，可作政策方向，但公開 driver 整段生命週期仍待真 Mongo 驗收。正常 precommit 清理如何建立窗口尚未定，推薦下一單題先定該起點，不先串 UX。
- 明確取代／保留：本條局部取代 D93 對本組逐送的窗口／間隔要求，並限定 D87 的到限停止為不准入新終止組／其他新確認；不抹除歷史規則。其他單送確認仍遵剩餘窗口及間隔，原項額度不補滿。窗口結束不准新組，執行 15 秒到期不開新業務步驟；HTTP 結束不取消原項，安全收尾不保證能取消或固定時間完成。
- 階段與放權不變：unknown commit 不用 native abort 猜回滾，走結果確認；本地 COMMITTED／ABORTED 僅助判 cleanup 接線，非 server 結果。解除相關寫入仍需完整 canonical 結果，或充分無效果與無晚寫證據，以及處理權／服務許可／維護否決等原條件。
- 必須驗收：至多兩送、完整預扣／不退款、組內不並行、跨窗口仍只完成已准入組而不開新組、endSession 無額外中止、原項重送不補額度、階段錯用拒絕與證據不足停寫。監測違反界線須阻擋交付，不能用文檔選擇冒充已測。
- 授權與依據：K15 固定版本來源、D87／D91／D93／D128 及本輪工程取捨；三獨立 agent 僅交換正式公開論點，UX 未混輪。採用來自 D114 預設接受，不捏造個別答覆；136 條既有工程證據仍 U。

### D130｜採用首次未知／首次需清理的較早確認起點，終局收縮尚不採用

- 記錄日期：2026-09-19；狀態：捍衛正式開場 → UX 異端 → 捍衛 → 仲裁，依 D114 採用起點，額度適配及新終局限制另題。
- 捍衛候選：首次 DB 結果不明或首次確定需要 precommit 終止清理，取較早者固定確認時鐘。應用決定停止該輪、需要 public abort 時同步固定起點，再檢查 group 准入，不等送出／失敗才起算。既有更早未知不刷新，後續衝突、恢復及清理共用同窗口／次數，排隊仍不消耗執行或確認時間。
- UX 異端：首次 group 扣兩格後只剩一格，第二次正常衝突也可能無法清理；時間／輪次尚有並不保證用滿三輪。要求明示第二清理不足如何停住、何時才能技術終局，不能只稱「最多三輪」而隱藏快速人工等待的代價。
- 捍衛：承認說明不足，候選維持三格並接受代價；不足時停止新業務／確認，保留原項與相關關卡，明示清理額度不足、結果待釐清，不說已回滾。另提晚取得充分安全證據後直接技術未完成、不續輪，明示這需另採、不能用未剩執行時間作假理由。
- 仲裁：攻擊命中代價揭露，未推翻起點。起點可採；新「即便執行資格仍有效也不續辦」會縮限 D89／D91，尚未採用，不能叫執行額度耗盡。推薦下一單題工程比較三次待測初值與原生兩送組是否適配，先考慮初值校準，再判新增终局限制是否值得。
- 採用／取代：D87 起點由本條局部修正為首次未知／首次確需清理的較早時點；不從正常排隊起算，未知／清理／恢復皆不能重設。D129 的原生組及共同預扣不退保留；其他執行、準時時間／FIFO、處理權／維護、未知不得放行與放權證據不變。確認三次仍為目前初值，下一題可明示修正，不悄改。
- 不採用／待驗收：本輪没有新增清理不足的永久終局規則；無安全證據仍停寫，不得提供業務 REJECTED／EXPIRED。測較早起點、已未知不刷新、跨輪共用、兩連續需清理衝突、額度不足不送／不放權及晚證據的既有安全判斷。工程證據未執行、仍 U。
- 獨立性及依據：UX 異端、捍衛、仲裁獨立準備只交換正式論點，工程異端未混輪；K15、D87／D89／D91／D93／D129 及本輪取捨，無新外查。保存與檢查後依 D114 接推薦工程比較，不開始程式。

### D131｜校準確認待測初值為七格，不以額度調整代替安全證據

- 記錄日期：2026-09-19；狀態：捍衛開場 → 工程異端 → 捍衛 → 仲裁，依 D114 持續授權採用可調初值，未量測或實作。
- 捍衛開場：三格與原生清理每組預扣兩格不匹配；提出七格，使兩組扣四格後尚有三格處理第三輪未知，三輪皆清理時可容納六格。這是配套容量理由，不保證時間內完成。
- 工程異端：只按輪數加總不足，慢清理可能用完窗口；要求同時符合時間／節奏的具體時序，展示三格會阻擋、七格能安全完成。
- 捍衛部分承認：提供假設驗收時序，並放棄普遍適配宣稱。執行 t=0；t=0.5 首次確需清理，確認窗固定至 t=10.5；第一組 t=0.5 准入，t=0.8 取得充分無效果與無晚寫證據，扣兩格。第二轮 t=1.2 再需清理，第二組至 t=1.5 安全收束，再扣兩格。第三輪 t=2 提交未知，t=2.1 單送確認、t=2.3 取得完整原保存結果且舊工作收束，扣一格。總五格、不並行、沒有失敗後等待；三格在第二組准入時因剩一格而停住，七格可容納此路徑。這是控制延遲的待測例，不是 PassHub 實測。
- 仲裁：時序在設計層回應適配反例，足以採為初值，不能證七格最佳或保證所有輪次。推薦下一單題 P08 放權證據矩陣，避免額度充足被誤當安全。
- 明確修正／保留：D93／D130 的確認三次初值由本條改七格；十秒窗口、D130 起點、十五秒／三執行輪、跨輪及重送共用不刷新保留。D129 原生組預扣兩格不退、獨占、最多兩送及組內跨窗／間隔例外保留；單送失敗後先一秒、後續兩秒，仍須剩餘窗口與額度。本輪不新增 D130 尚未採用的永久終局，D89 安全條件續辦仍有效。
- 必須驗收：上述快路徑、兩清理組後第三輪未知、三組連續清理、其他確認先耗額度、慢路徑到限停止新准入、額度不足不送／不假回滾、同項不補額度及晚證據不誤放權。實際送出、原生 lifecycle 與安全證據仍需真 Mongo；136 條工程要求全部 U。
- 來源／獨立性：K2 D87／D89／D91／D93／D125–D130、K15 固定來源與本輪推論；工程異端、捍衛、仲裁獨立準備，只交换正式公開論點，UX 不混輪，沒有新外查／程式改動。保存檢查後續進，不要求逐題接受。

### D132｜放權以結果及無晚寫的複合證據為準，成功 abort 不是唯一出口

- 記錄日期：2026-09-19；狀態：捍衛開場 → 工程異端 → 捍衛 → 仲裁，依 D114 採用判準修正；精確錯誤分類待 Q8，P08 未完成。
- 捍衛候選矩陣：未發任何 DB 命令且無可晚啟動工作，可按原項執行資格續辦／收尾；precommit 未發 commit，原交易 abort 無錯成功回覆、全部舊命令明確收束無晚寫，可作無效果出口；DB 錯誤不能只靠 label／Promise。commit 有效成功回覆或同鍵同內容完整 canonical 原子結果可證保存，但放後項還須排除舊工作影響；查無 Event／命令在途均不充分。本地 COMMITTED／ABORTED、endSession 完成與 NoSuchTransaction 不單獨作結果證據。
- 工程異端：正常衝突可能已由 server 終止原交易，之後 abort 才回 NoSuchTransaction；強求再次成功 abort 將安全可重跑路徑誤升停寫。挑戰的是複合證據，不要求把任何 label 或 NoSuchTransaction 自動視為回滾。
- 捍衛承認出口過窄：成功 abort 是一條充分路徑，不是唯一出口。接受「已充分證明 server 終止原交易＋從未發 commit＋全部舊工作收束且無晚寫」的判準；滿足時後續 NoSuchTransaction 不否定此證據，但它本身也不提供缺少的證明。哪些精確衝突回覆能作 server 終止證據仍未知，不偷填錯誤碼。
- 仲裁：攻擊命中，採用複合判準而非唯一成功回覆；分類仍未解，推薦唯一下一分支 Q8。依 D114 root 核准窄查官方原交易終止的精確錯誤語義、命令／交易歸屬、傳輸失敗後排除舊工作晚生效的条件，查後回仲裁及捍衛重述。
- 控制與預算保留：D129 原生終止組限 precommit，commit 已發不盲轉 abort；D130／D131 共用窗口與七格。續辦須同程序／資料未 reset、owner 有效、服務許可且沒有維護／实际接管否決；充分無效果按 D89／D91，不新增永久終局。canonical 已保存可回放不等於全局服務立即解鎖。
- 未實作驗收：逐 phase 驗 commit 是否曾准入、所有命令與晚 callback 歸屬、原子 canonical、正常已終止衝突、NoSuchTransaction 單獨拒絕、未決命令不放後項、錯 owner／維護／資料期否決。136 條工程證據 U；K15、K20–K22 查證背景與 K2 D80／D83／D89／D91／D125–D131，本輪三獨立角色只交换正式公開論點，不外查、改程式或操作 DB。

### D133｜Q8 查證後精確化 precommit 複合出口，commit 確認仍另題

- 記錄日期：2026-09-19；狀態：D132 窄查證 → 仲裁說明影響 → 捍衛正式重述 → 仲裁；依 D114 採用已查範圍的矩陣精確化，P08 未整體完成、工程證據 U。
- 完整知識範圍：K1 `/home/sean/PassHub/docs/business-scope.md`（業務）；K2 `/home/sean/PassHub/docs/discuss.md`（決策）；K3 `/home/sean/PassHub/docs/requirements-traceability.md`（136 要求／P01–P15）；K4 [Node Crypto](https://nodejs.org/api/crypto.html)；K5 [OWASP](https://cheatsheetseries.owasp.org/)；K6 [Node Buffer](https://nodejs.org/api/buffer.html)；K7 [ECMAScript](https://tc39.es/ecma262/)；K8 [Unicode](https://www.unicode.org/versions/latest/)；K9 [Nest JWT](https://github.com/nestjs/jwt/blob/master/README.md)；K10 [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken/blob/master/README.md)；K11 [Node 發行](https://nodejs.org/en/about/previous-releases)；K12 [Nest 遷移](https://docs.nestjs.com/migration-guide)；K13 [driver 交易](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)；K14 [Mongo 相容表](https://www.mongodb.com/docs/drivers/compatibility/)（未取得完整表）；K15 [官方 driver repository](https://github.com/mongodb/node-mongodb-native)（固定 v7.6.0）；K16 [npm registry](https://registry.npmjs.org/)（metadata）；K17 [Docker 官方映像](https://github.com/docker-library/official-images)及唯讀 registry manifest；K18 [Mongo 8.0 發行](https://www.mongodb.com/docs/manual/release-notes/8.0/)；K19 [TS 5.9](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html)；K20 [Mongo 8.0 abort](https://www.mongodb.com/docs/v8.0/reference/command/aborttransaction/)；K21 [driver 監測](https://www.mongodb.com/docs/drivers/node/current/monitoring-and-logging/monitoring/)；K22 [官方 command monitoring 規範](https://github.com/mongodb/specifications/blob/master/source/command-logging-and-monitoring/command-logging-and-monitoring.md)；新增 K23 [Mongo 8.0 交易限制](https://www.mongodb.com/docs/v8.0/core/transactions-production-consideration/)；K24 [官方交易規範](https://github.com/mongodb/specifications/blob/master/source/transactions/transactions.md)；K25 [官方 server repository](https://github.com/mongodb/mongo)（固定 r8.0.32）。全部已參考・鎖定，沒有停止或移除；LLM 背景開啟，只作一般取捨，不冒充 server 語義。
- 實讀引用回執（MongoDB 官方，查閱 2026-09-19）：K23 的 In-progress Transactions and Write Conflicts／Stale Reads 說明交易內寫入衝突中止，交易操作失敗時不顯示部分變更。K24 的 Error Reporting and Retrying／Handling command errors 說明 DuplicateKeyError 中止、network／pool 可由 driver 加 TransientTransactionError；同標籤不全是 server 已終止證據。commit 可重試原交易；其 majority 重試理由包含 failover 後 NoSuchTransaction，不能把該碼通用當從未提交。這是一般語義，不證本案回覆歸屬或已消除在途指令。
- K25 固定原始碼回執：[error_codes.yml](https://github.com/mongodb/mongo/blob/r8.0.32/src/mongo/base/error_codes.yml) 列 112=WriteConflict、11000=DuplicateKey；[transaction_participant.cpp](https://github.com/mongodb/mongo/blob/r8.0.32/src/mongo/db/transaction/transaction_participant.cpp) 的 _checkIsCommandValidWithTxnState 拒絕 aborted／committed 的一般後續操作，_shouldRestartTransactionOnReuseActiveTxnNumber 的非分片分支不准同號重新啟動；[txn_cmds.cpp](https://github.com/mongodb/mongo/blob/r8.0.32/src/mongo/db/commands/txn_cmds.cpp) 的 CmdAbortTxn 正常終止原交易再回覆。讀 source 不是線上命令證明，也不把其他分片／內部交易分支納入 v1 能力。
- K15 重讀 v7.6.0 sessions.ts 的 abort／commit：原生中止最多再嘗試一次、可能吞錯並本地轉 ABORTED；commit 的零 adaptive retry 早退可能先於 unknown label 補上。這些既有線索強化不能只看 public Promise／本地狀態／label，而非新增性能成果。
- 仲裁判資料影響：正常已終止 precommit 出口可比 D132 最初候選更寬，但傳輸不明不能借錯誤標籤放權；請捍衛重述，不隨查證偷定 read／write concern。
- 捍衛正式新版矩陣：未發 DB 且 scope 封閉／無晚啟動可按額度處理；precommit 原交易無錯 abort 回覆＋未發 commit＋舊工作收束無晚寫，可作出口；精確歸屬原非分片交易的 server 112／11000 回覆＋未發 commit＋舊工作全部收束＋scope 不可再用，也可作複合終止出口，後續 NoSuchTransaction 不要求變成成功 abort。任意同碼錯誤／driver label 不算。傳輸未知仍需真正終止與無晚寫證據；commit 有效成功回覆或可信完整 canonical 可證保存，但需另核舊工作；commit 未知且查無不證回滾、不轉 precommit abort。
- 生命週期 checkpoint：封閉新業務工作 → 判 phase／所有在途命令 → 收集原交易證據 → 核 owner／同程序資料期／服務許可及維護否決 → 放權或按原剩餘額度續辦。D129 終止組、D130 起點、D131 七格、D89 安全續辦及未知停寫保留，不新增恢復平台。
- 待驗收／後題：確定 server 錯誤與 transport 失敗分流、錯 txn／同碼非交易錯誤拒作出口、NoSuchTransaction 單獨不足、晚工作／旧 scope 不可生效、正常安全衝突可續辦及不補預算。接下來先定 read／write concern，再收斂 unknown commit／canonical 確認；不能宣稱所有故障可自動恢復或 P08 全完成。未安裝、啟動 Mongo、改程式／設定或執行測試。

### D134｜原結果回放不是再次授權，讀寫一致性組合先查證再採

- 記錄日期：2026-09-19；狀態：捍衛開場 → UX 異端 → 捍衛 → 仲裁，依 D114 採用展示／驗收補充；關注設定仍候選，推薦 Q9。
- 捍衛候選：交易 snapshot／primary，共同提交 w=majority、j=true；交易外 canonical 查詢 majority／primary。snapshot 不替代可變事實的真實寫入 guard，majority 不直接等於最新；查到核可信 Source＋event ID＋原比較表示與完整原結果，不要求目前 Presence／映射仍等於當時。查無／timeout／write concern 失敗不單獨證回滾。設定不預定節點數／高可用、不作性能宣稱，精確保證與 API 尚需查證。
- UX 異端：接受不重判，但原 ACCEPTED 不等於本次 HTTP 又授權通行；要求狀態改變後重送仍回原結果且不重執行的可理解展示。
- 捍衛：行為已由既有回放契約覆蓋，承認說明不足；補首次 ACCEPTED、後續狀態／映射變動、同 ID 同內容回原結果的驗收，不新增 Event 或 Presence／Mapping 業務寫入。呈現明示「原結果回放」，不是此刻重新裁決；API 識別欄位及範例留 P04，不改原 outcome。
- 仲裁：展示缺口部分命中且設計已補，讀寫設定未因此證實。推薦唯一 Q9：MongoDB 8 snapshot／majority／journal 前提、固定 driver 7.6 設定位置與 timeout 覆寫；依 D114 root 核准必要窄查，返回仲裁／正式重述後才採設定。
- 保留／證據：D65 真交易與拒絕新鮮度、D101 比較與 canonical 共同保存、D129–D133 額度／安全判據均不變。K2 既有冪等決策、K15／K24 已查一般前提與本輪推論；三獨立角色仅交換正式論點，工程異端不混輪，未外查／實作，136 條工程證據 U。保存檢查後續 Q9，不等待逐題確認。

### D135｜Q9 後採交易與 canonical 的一致性設定，應用仍負責整項期限

- 記錄日期：2026-09-19；狀態：D134 窄查 → 仲裁 → 捍衛正式重述 → 仲裁，依 D114 持續授權採設定與責任契約；具體操作 timeout／unknown commit 策略下題，工程 U。
- 全部知識範圍：K1 `/home/sean/PassHub/docs/business-scope.md`；K2 `/home/sean/PassHub/docs/discuss.md`；K3 `/home/sean/PassHub/docs/requirements-traceability.md`；K4 [Node Crypto](https://nodejs.org/api/crypto.html)；K5 [OWASP](https://cheatsheetseries.owasp.org/)；K6 [Buffer](https://nodejs.org/api/buffer.html)；K7 [ECMAScript](https://tc39.es/ecma262/)；K8 [Unicode](https://www.unicode.org/versions/latest/)；K9 [Nest JWT](https://github.com/nestjs/jwt/blob/master/README.md)；K10 [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken/blob/master/README.md)；K11 [Node 發行](https://nodejs.org/en/about/previous-releases)；K12 [Nest 遷移](https://docs.nestjs.com/migration-guide)；K13 [driver 交易](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)；K14 [Mongo 相容](https://www.mongodb.com/docs/drivers/compatibility/)；K15 [官方 driver repo](https://github.com/mongodb/node-mongodb-native)（v7.6.0）；K16 [npm metadata](https://registry.npmjs.org/)；K17 [Docker 官方映像](https://github.com/docker-library/official-images)及 registry manifests；K18 [Mongo8 發行](https://www.mongodb.com/docs/manual/release-notes/8.0/)；K19 [TS5.9](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html)；K20 [abort](https://www.mongodb.com/docs/v8.0/reference/command/aborttransaction/)；K21 [監測](https://www.mongodb.com/docs/drivers/node/current/monitoring-and-logging/monitoring/)；K22 [監測規範](https://github.com/mongodb/specifications/blob/master/source/command-logging-and-monitoring/command-logging-and-monitoring.md)；K23 [交易限制](https://www.mongodb.com/docs/v8.0/core/transactions-production-consideration/)；K24 [交易規範](https://github.com/mongodb/specifications/blob/master/source/transactions/transactions.md)；K25 [server repo](https://github.com/mongodb/mongo)（r8.0.32）。新增 K26 [snapshot](https://www.mongodb.com/docs/v8.0/reference/read-concern-snapshot/)；K27 [majority 讀](https://www.mongodb.com/docs/v8.0/reference/read-concern-majority/)；K28 [write concern](https://www.mongodb.com/docs/v8.0/reference/write-concern/)；K29 [driver CSOT](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/csot/)。均已參考・鎖定，無停止／移除；用途分別為既有業務、決策、追蹤、安全／runtime／交易 API／資料保證的精確前提；LLM 背景開啟，不支持版本／保證數據。
- 實讀回執（MongoDB 官方，查閱 2026-09-19）：K26 的 Read Concern and Transactions，snapshot 在交易層設定，相關保證依 majority 提交。K27 的非交易 majority／Storage Engine Support，讀得持久資料但非最新值保證，需支援 committed reads。K28 的 Transaction Note／j／wtimeout／Reads after majority 說明 WC 在交易層；j=true 需 journal，按 w 要求成員確認 journal、單獨 j 非 failover 保證；wtimeout 不撤已有修改，8.0 secondary 可能尚未 apply。未採性能敘述／全面安全或高可用宣稱。
- API 回執：K29 的 inheritance／Overrides／Transactions 說明 operation 可覆寫，session defaultTimeoutMS 涉及 commit／abort／endSession；該 current 一般表不可代替固定 Core 行為。K15 固定 [transactions.ts](https://github.com/mongodb/node-mongodb-native/blob/v7.6.0/src/transactions.ts)、sessions.ts 的 startTransaction／commit／abort、[utils.ts](https://github.com/mongodb/node-mongodb-native/blob/v7.6.0/src/utils.ts) resolveOptions、execute_operation.ts 顯示 TransactionOptions 不包含 timeoutMS，交易關注 options 優先於 session／client；Core CRUD 有單操作期限，並不自動共享應用十五秒。withTransaction 的特定 override 限制不拿來套本案不用的路徑。
- 仲裁解釋影響後，捍衛正式採用：交易層 readConcern=snapshot、readPreference=primary、writeConcern={w:"majority",j:true}；交易外 canonical 讀 majority／primary。需檢查儲存引擎 supportsCommittedReads、journal 開啟及實際 majority 提交。canonical 原結果不要求目前資格仍與當時狀態相同，查無仍未知，snapshot 不取代 guard。
- 責任：窄 infra adapter 獨掌 Mongo options，不讓用例傳任意覆寫。每個新步驟前核原項剩餘執行時間／phase／共同額度，再配置適當單操作期限；不把 session 或 client 每次重設 timeout 當原項十五秒共享。已准入原生終止組依 D129 收尾例外。timeout、writeConcernError 仍不證取消／回滾，不以 timer 放權。
- 待驗收：actual wire 關注設定與優先序、journal／committed-read 啟動檢查、正常完整保存與 primary majority 查到 canonical、關注失敗／查無保持未知、操作期限制不能重開原項預算、late 結果與組內跨窗。公開文件／固定 source 不等於 PassHub 實測；未安裝、跑 DB、改設定或 code。
- 下一單題：unknown commit 具體確認策略及操作 timeout 初值，填有限安全路徑與停寫條件；節點數／部署及 fault 工具仍後題，不標 P08／P07 全完成。各題保存檢查後再續進，依 D114 預設接受、不捏造逐題答覆。

### D136｜unknown commit 只確認原交易，首次提交不能借確認期限

- 記錄日期：2026-09-19；狀態：捍衛開場 → 工程異端 → 捍衛 → 仲裁，依 D114 採用策略與待測初值；單送／timeout 真驗收仍阻擋交付。
- 捍衛初始策略：首次 commit 未知後，第一確認立即重試同 session、同交易的 public commit，不重跑業務。未確定則等一秒查 canonical majority／primary，再未確定等兩秒重試原 commit，此後每次未確定後兩秒、交替兩路。一次僅一個應用確認呼叫，前次未完成不另發；每次送出嘗試前扣共同一格，失敗不退，沿 D130 起點、D131 十秒／七格不刷新。可能已發而不確定者即使缺 unknown label 仍分類未知；NoSuchTransaction／查無原結果不單獨證無效果。
- 工程異端：首次提交准入漏定；必要寫入完成時執行只剩 0.1 秒、session 預設兩秒，不能把第一次 commit 放到尚未成立的確認窗口，借安全確認延長業務。
- 捍衛承認命中：首次 commit 屬當前執行輪及十五秒原執行預算，不新增輪、不借確認格。發前取 remaining 的向下整毫秒，public commitTransaction({timeoutMS:min(2000,remainingWholeMs)})；不足一毫秒禁止發，不傳零。Q9 已讀 public option 提供配置前提，實際覆寫／wire 仍需測。已可能發且未知才轉確認，未准入 commit 則按 precommit 安全收尾，不擅造永久終局。
- 其他待測期限：session defaultTimeoutMS=2000；一般 CRUD 每步 min(2000,剩餘執行整毫秒)，canonical 確認 min(2000,剩餘確認整毫秒)，不足一毫秒不發、不傳零。確認用 public commit 目前保持「窗口至少剩兩秒才准入、timeout 兩秒」的保守版本，沒有被首次提交修正暗中取代；期限設定不保證實際 server 工作準時停止。
- 完整結果與放權分開：成功 commit 且必要寫入完整，或可信 canonical 可提供原結果；不重判當前 Presence／Mapping。放下一項仍須舊工作不影響、owner／資料期／服務及維護許可；查無及兩種 timeout 不解鎖。十五秒到期不新增業務步驟，必要原結果確認仍限自己的既有額度。
- 仲裁：首次期限缺口設計已補，採用時保留首次與確認提交的不同准入，公開 method 單送仍待驗證。推薦下一唯一單題 precommit 終止組 timeout／endSession 接線，不標 P08 完成。
- 必須驗收：首次 commit 前 exec 邊界／零毫秒、固定 driver 每 public commit 至多單送、timeout 逐次覆寫及真正線路計量、交替單呼叫／間隔／共同扣格、重送不刷新、缺 label 保持未知、查無不重業務、成功結果與放後項分離、所有 cleanup 無額外終止。K15 固定版本／Q9、K24 與 D125／D129–D135；工程三獨立角色只交換正式論點，未外查、改 code、跑 Mongo 或測試，136 條 U。

### D137｜原生終止組共用兩秒初值，先封新增工作再清理 session

- 記錄日期：2026-09-19；狀態：捍衛開場 → 工程異端 → 捍衛 → 仲裁，依 D114 採用配置與修正時序，實測 U。
- 候選：precommit public abortTransaction({timeoutMS:2000})，原生最多兩次內部嘗試共用一個 TimeoutContext，不各給兩秒。確認窗口尚未到且有至少兩格才准入、先預扣兩格不退／獨占；即使窗口只剩 0.1 秒，已准入組可按自身两秒初值收尾，保留 D129 越窗例外、不採 min(兩秒,剩窗口)。不保證呼叫或 server 固定時間結束；組未完成不開別條確認／清理路徑。
- 工程異端：候選「組完成後封 scope」太晚；先前 await 的晚 callback 若持有能力，可在 abort 期間發新業務命令，違反 D133 先封要求。
- 捍衛承認順序失當：先封原 scope、禁止新業務 DB 命令及延後重跑，晚 callback 恢復仍拒用已封能力；再收束已發工作、核 owner／precommit phase，才准入終止組。組後只判原結果、收束既發工作與受控 endSession，不重開舊 scope；晚通知只能更新自身结果、不解除新 owner gate。
- endSession 契約：本地工作收束且 transaction 非 active 才呼叫，禁止無條件 finally 另 abort。吞錯後本地 ABORTED 只助本地清理、不證 server 終止；endSession 實际不得另送交易／清理 DB 命令繞共同額度，違反則阻擋交付、重新收斂方案，不以免費清理包裝。一般監測 heartbeat 與本項送出須可區分，不能打印 command／reply 秘密。
- 仲裁：修正後順序可採，scope 封閉與 timeout context 仍不證原交易無效果／server 舊工作已收束。傳輸未知須充分證據，否則相關停寫。D136 確認 commit 剩至少兩秒准入未更改；不偷偷以同公開 option 理由改另一策略。
- 驗收／下一題：兩送共同 ctx／預扣不退／組獨占及跨窗、封 scope 前後晚 callback 不新增 DB 命令、phase 錯用拒絕、endSession 無額外送、timeout 及本地狀態不放權、新 owner／維護競爭。推薦下一唯一單題 P08 最小故障整合案例，先把證據路徑具體化，不添控制平台。
- 獨立性／依據：三獨立工程角色只交換公開論點，UX 未混輪；K15 固定 driver 的兩次 abort 共 context 線索、D129–D136 及本輪時序推論。沒有外查、安裝、跑 DB 或改 code／設定；136 條工程證據仍 U。保存檢查後按 D114 續進。

### D138｜故障驗收使用真 HTTP／MongoDB，共同快照避免假部分保存

- 記錄日期：2026-09-19；狀態：捍衛開場 → 工程異端 → 捍衛修正 → 仲裁，依 D114 持續授權採驗收設計；工具能力待 Q10，測試未執行。
- 捍衛候選：正常 Demo 不依賴故障工具；另以 opt-in、隔離測試資料庫及同一鎖定版本，驗證提交後回覆遺失、原交易真正衝突、precommit 傳輸未知、晚 callback、原生中止重送、晚證據及維護競爭。測試 hook 只控制先後，不用應用 throw 冒充網路故障或 server 已終止。保存結果須包括 Event／digest、資格狀態、必要映射與協調位；同 ID 回放不增加事件、不更新狀態或補時間／額度。
- 工程異端：獨立 majority observer 若分次讀 Event、Presence、Mapping，可能跨 commit 拼出假部分保存；只在最後查到全齊，也不能證明中途一致。要求共同觀測視圖、受控時序及區分有限採樣與全瞬間證明。
- 捍衛承認：每份 observer 樣本以同一唯讀 snapshot 交易順序讀 Event、資格使用狀態、映射／協調位及必要版本，按 D135 primary 與 majority commit；觀察交易成功完成才判讀。先保存案例完整前像，再於 commit 前、已發未確定、回覆受阻、確認後的受控關卡採樣；每份只接受案例完整前像或後像，不假設初值全空，不拼不同時點。有限樣本不是所有瞬間的數學證明，須結合官方交易原子性、真故障位置、命令回覆及 rollback 案例。
- 仲裁：攻擊命中觀察方法，修正可採為驗收契約，不等於已證明工程成功。原生 abort 的真重送／共享兩秒／預扣不退、scope 封閉後無新增業務命令、endSession 無額外送，以及充分結果與無晚寫放權条件均需真線路證據；command monitoring 名稱、應用 Promise 或計時器不單獨當證明。
- 唯一下一分支 Q10：核对固定官方 server failpoint 的作用階段與效果，以及測試網路工具是否能真正阻斷 commit 回覆並保留可關聯證據。依 D114 root 核准此窄查；不得把提交後 server 回錯、應用自行丟錯與實際回程遺失混稱。不新增正式業務功能、故障平台或 production 故障入口。
- 邊界：隔離測試 writer 僅用於真競爭驗收，不新增公開第二 writer；不延伸 crash／reset 延續、多 API 或 HA。三獨立角色僅交換公開論點，依據 K2 D123／D125／D129–D137、K15／K25–K29及工程推論；沒有新外查、程式／設定改動或實測，136 條要求仍 U。保存及文字檢查後才進 Q10。

### D139｜Q10 分清真正回程遺失，採受控代理故障驗收設計

- 記錄日期：2026-09-19；狀態：D138 核准窄查 → 仲裁說明影響 → 捍衛正式重述 → 仲裁，依 D114 採為待實作驗收設計，工程 U。
- 知識範圍更新：D135 的 K1–K29 全部保留原用途、一般參考／專案文件類型及已參考・鎖定狀態，沒有移除或停止；新增 K30 [Shopify Toxiproxy 官方 repository](https://github.com/Shopify/toxiproxy#toxics)，一般參考、已參考・鎖定，用於測試代理功能邊界，不視為 MongoDB 交易保證。LLM 背景開啟，僅支持一般機制推論。
- 完整實讀回執（查閱 2026-09-19）：K25 固定 [txn_cmds.cpp](https://github.com/mongodb/mongo/blob/r8.0.32/src/mongo/db/commands/txn_cmds.cpp) 的 hangBeforeCommitingTxn 位於提交前；participantReturnNetworkErrorForCommitAfterExecutingCommitLogic 位於實際提交邏輯後，但產生 HostUnreachable 錯誤回覆，不是真 socket 回程遺失。[curop_failpoint_helpers.cpp](https://github.com/mongodb/mongo/blob/r8.0.32/src/mongo/db/curop_failpoint_helpers.cpp) waitWhileFailPointEnabled 只有相關 nss 過濾，不能假称不同 appName 豁免該 barrier。K25 [failCommand 官方 wiki](https://github.com/mongodb/mongo/wiki/The-failCommand-fail-point) 及 K24 [legacy transactions test format](https://github.com/mongodb/specifications/blob/master/source/transactions/tests/legacy-test-format.md) 說明 closeConnection／errorCode 使命令不執行，不能證 commit 後丟回覆。固定 commands.cpp 另核對 failCommand 邏輯，不將 master 額外行為套固定版本。
- K30 回執：官方 README 的 timeout toxic 可阻斷資料、timeout=0 持續丟資料至移除；downstream 僅 server→client。它不是 Mongo-aware，不自動定位 commit。官方 [v2.12.0 release](https://github.com/Shopify/toxiproxy/releases/tag/v2.12.0) 可讀；未檢核該版本實作／映像 digest，故本輪沒有擅把它鎖為已驗證選型。API release metadata 的 web 讀取失敗，不當證據。
- 仲裁解釋：上述證據排除兩種假證明；真回程故障須有受控時序，不能只挑工具便宣稱提交後遺失已證實。推薦捍衛據資料正式重述完整接線及失敗判準。
- 捍衛正式版本：opt-in 隔離測試中應用所有 Mongo 流量走代理，controller／observer 走不受 drop 影響的連線；先共同前像，再原 commit 停在 barrier，安裝 downstream timeout=0，關閉 barrier 並確認釋放後 observer 才開始同 snapshot 讀取及 majority 提交。observer 證完整後像、應用遇真正傳輸／期限未知，移除故障，再原項確認及回放原結果，不重跑已保存業務、不刷新時間／額度。不同 appName 不用來假豁免 barrier。
- 通過／無效：須保存受控時序、共同前後像、真回程受阻、unknown 分類與共同額度、後續安全放權證據。SDAM 繞過代理、heartbeat 阻止原 commit 送出、observer 誤傷或 barrier 未釋放均使預期案例失敗／無效，不能算成功。有限採樣仍不證所有瞬間，與 D138 原子性判準共同使用。
- 仲裁及停止條件：此為足以採用的可執行測試設計；確切 Toxiproxy 版本／映像 digest、全部 Mongo 位址經代理及可控 barrier 列 P07 實作 gate 前置，未滿足不得執行有效案例。真樣本、命令關聯、完整保存與無晚寫仍待實作驗收；不無限預先外查工具、不加入 production 故障能力。
- 下一單題：P01 repository／目錄與私密舊碼備份界線。獨立仲裁、捍衛僅交换正式來源回執與主張，未混入其他草稿；實際程式、安裝、DB、部署皆未改動，136 條工程證據仍 U。每題保存檢查後依 D114 續進。

### D140｜單一 package 正式骨架與私密備份，不跟隨專案外連結

- 記錄日期：2026-09-19；狀態：捍衛開場 → 工程異端 → 捍衛修正 → 仲裁，依 D114 採 P01 交付形狀；沒有實際搬檔或備份。
- 正式骨架：同一 Git repository、一個 root npm package，保留 docs；不建立 workspace 或產品前端。`src/composition/` 組合入口；`src/access/{domain,application,ports,infrastructure,http}/`；`src/auth/`、`src/sources/`、`src/shared/`；`test/{unit,integration,e2e,fault,fixtures}/`；`docs/`、`scripts/`、`infra/docker/`。shared 只放必要技術共用，不放萬用 repository／service；資料夾不取代窄能力及實際接線驗收。
- 現況與公開策略：唯讀盤點有 backend、frontend、root readme.md；它們仍原封保留。本輪選新入口為 README.md，未來先備份舊內容，不直接覆蓋。公開程式／設定樣例／證據不得帶入秘密、私密 inventory、備份或旧版包袱；Git 歷史不改寫。
- 未來備份位置及範圍：`/home/sean/PassHub-legacy-backups/<UTCstamp>-<random>/`，父目錄及每批 0700；完整保存目前 working tree 的範圍內資料，含 hidden、untracked、.git、.env 及 node_modules（若存在）。先停止相關修改，以私密 inventory 核對路徑、型態、權限、連結原 target 文字及普通檔案 hash，核對來源前後一致、備份可讀且無漏項，才准提出精確清理名單。不能把只備 tracked 檔當完整備份。
- 工程異端：外部 symlink 若只保留 target，復原可能仍依賴活資料；全面 dereference 又越界帶入無關秘密或巨大資料。要求明定備份責任，不將範圍內完整稱獨立可復原。
- 捍衛承認並修正：只保存 symlink 本身、不 follow 任何 target、不查讀外部內容；manifest 標內／外／未確認、鏈、懸空及絕對路徑依賴，不因文字看似在 root 內便稱安全。外部／未知依賴存在時只宣告範圍內完整，獨立復原承諾不成立，清理 gate 停住請使用者選精確擴大範圍、接受依賴或替換；D114 不授權自行擴大讀取／複製。沒有聲稱已驗證整棵樹無連結。
- 仲裁：修正可採，復原先在另一私密位置驗證，不覆蓋 workspace；具體清理 exact list 另過關卡，不刪 workspace 或改 Git history。當前只是計畫，不執行 copy／move／delete。下一单題 P02 實際能力介面與 composition 接線，不新增備份平台。
- 依據／驗證邊界：K1、K2 D36／D37／D59／D114／D125、K3 P01及唯讀檔案盤點，三獨立角色只交換正式公開論點；未读秘密內容、安裝或改 code。備份完整性、復原及新程式建置均待實作 gate，136 條 U 保留。

### D141｜實際窄介面與解析歸屬能力，不只接受一份合法 plan

- 記錄日期：2026-09-19；狀態：捍衛開場 → 工程異端 → 捍衛修正 → 仲裁，依 D114 採有限 P02 契約，沒有實作介面或接線。
- 應用能力：Access 對外只提供 `ManageQualifications.create/update/revoke`、`RecognizeAttempt.execute`、`ReadAccessData.qualifications/inside/events`；輸入已驗證命令／可信身分，輸出一次 QR 建立結果、辨識結果或去敏頁面，不 export repository／任意 Presence setter。Auth 的 `AuthenticateHuman.login/verify`、`AuthenticateSource.verify` 給 HTTP，Access 核心不依 Auth。Sources 分別提供 `SourceCredentialVerificationPort.verify` 給 Auth，`SourceFactsPort.read` 給 Access；後者只有 ID／方向／active 且綁當次一致性 scope，不能借認證時舊事實作裁決。
- scope 方法：管理只得 `readQualification/readMapping/stageManagementChange`；辨識得 `readSourceFacts/resolveQr/resolveFace/readQualification/stageRecognitionResult`，涵蓋無資格 Event 與必要通行／映射變更；查詢只得去敏讀取。stage 只接受唯一 pure domain 的相應計畫，不接受任意補丁；凍結比較能力共同產出 HMAC 與 referenceID，與完整辨識結果一起保存。
- 真接線：composition 掌 concrete adapter／provider，為 consumer 建立實際不同 wrapper，不將萬用 service cast 成窄介面。infra 執行共同保存、衝突及結果分類，政策、重讀裁決及共同預算仍由用例負責。domain 不依 Nest／HTTP／Mongo／session；scope 及 owner／資料期能力不是領域業務資料。
- 工程異端：合法 pure-domain ENTRY 計畫不證其屬於這次解析；QR 指向 A 卻誤配 B 的合法 plan，可能原子保存錯人。要求保存歸屬，不只計畫種類／版本。
- 捍衛承認並補強：scope 固定可信 Source 與合法媒介輸入，解析產生呼叫端不可自行組裝的不透明 resolution handle；私有登記 scope、資料世代、owner、媒介、資格及映射版本。stage 接 handle＋plan，核對目前 scope 有效、解析資格與 plan 一致；跨 scope／媒介、假 handle、A 配 B 均拒絕。無資格拒絕用實際處理步驟產生的明確 case，不強造資格、不容夾帶資格變更。這是歸屬核對，不由 adapter 另訂通行政策，也不取代 DB freshness guard。
- 仲裁：有限契約可採；scope 封閉／owner 或資料期失效不能 stage。必要驗收 A 配 B、跨 scope／媒介、假 handle、無資格夾變更與晚 callback，並以 tsc 負向 fixture、有限 import graph script及真 provider 接線測試核對隔離；工具及測試尚未建立，介面宣告不是工程證據。
- 下一單題：P03 資格、目前映射、Event／比較資料的實際 schema／ID／guard與空鍵生命周期。依據 K2 D59–D67／D101／D117／D122／D125／D135–D140、K3 P02及本輪推論，三獨立工程角色只交換公開論點，沒有新外查／code／DB／設定改動，136 條 U 保留。

### D142｜六類資料與真寫 guard，單資格單 Face 的索引補強待查

- 記錄日期：2026-09-19；狀態：捍衛開場 → 工程異端 → 捍衛修正 → 仲裁，依 D114 採 P03a schema 方向；partial unique／精確 collation 待 Q11，不宣工程保證。
- 表示：實體 ID 由 server randomUUID 產生，caller 不指定；預置帳號／credential alias 不是 caller 可指定的實體 ID。日期 BSON Date，辨識 receivedAt 僅首次 server 登記值。資格需 ID、incarnation、version、displayName、有效區間、撤銷／逾期終結事實、Presence、唯一 qrLookupDigest；不持久化原 QR。
- 六類 collection 責任：`qualifications` 保存資格；`faceSlots` 保存 provider／subject、可空 qualificationId、incarnation／version，是目前映射唯一權威，釋放清引用不立即刪槽；`events` 保存 ID、Source＋externalEventId、kind／方向／receivedAt、可空資格 ID、outcome／reason、inputHmac／referenceID；`users` 保存帳號／角色／enabled／salt／scrypt參數及hash；`sources` 保存 ID／方向／active／credentialDigest／incarnation／version；`metadata` 保存資料世代、比較 referenceID／啟動向量及 QR 鍵空間 guard。完整欄位細節按既有 B48／B49 去敏及轉移證據要求補全，不能把本最小清單當刪除那些要求的授權。
- 已定索引方向：帳號、Source 身分、QR lookup digest、Event(Source＋externalEventId)、Face(provider＋subject)唯一；識別採 simple 精確語義但 API 設定待 Q11。每次裁決以所讀版本對必要 Source／映射／資格作真條件增版，包括可變事實拒絕；無資格拒絕不造資格。QR 不存在判定與建立共用 QR 鍵空間真寫 guard，不能只依負查／唯一索引。
- 保存與衝突：必要資格／映射／Event／HMAC及referenceID／guard 同一 session 順序提交，不 Promise.all。首次空槽競爭 11000 辨索引歸屬、整輪中止後才按安全条件重讀，不吞錯續原交易。D141 handle 核 scope 對象／版本／incarnation／資料世代；不取代 guard。INSIDE 逾期映射、FIFO與unknown停寫保持。
- 工程異端：Face 鍵唯一只保護一 subject 不綁兩資格，未保護一資格最多一個目前 Face；替換漏清旧槽可留下兩 subject 通行。捍衛承認：同scope反查資格目前槽、核資格 incarnation，資格與舊／新槽真版本寫，清旧／綁新共同提交；資格 guard 保護反查不存在，不在資格加第二份權威。另提非空 qualificationId partial unique、只納字串排空槽，但未將尚未核對的語義稱已支持。
- 仲裁：其餘 schema 責任可採；單資格單 Face 補強合理、精確索引待查。唯一 Q11 核對 Mongo8 partial unique／$type／$exists／null與simple collation，依D114 root核准窄官方查後重述。空槽容量／滿額／清理後續 P03b，不假已採數值，不設 TTL／背景 worker／Face 歷史；不足時不能略 guard 保存未映射拒絕。
- 依據／邊界：K1、K2 D64–D76／D101／D117／D119／D122／D135／D141、K3 P03及本輪推論，三獨立工程角色只交換正式論點，沒有實際 schema/index/code/DB 改動。資料型態、反查、唯一性、全部拒絕的新鮮度與故障原子性均待真 Mongo，136 條 U 保留；每題保存驗證後續進。

### D143｜Q11 後定索引形狀，唯一值同交易重用須先過可行性關卡

- 記錄日期：2026-09-19；狀態：D142窄查 → 仲裁說明影響 → 捍衛正式重述 → 仲裁；依D114採具體風險方案，非已可運行schema。
- 全部知識範圍：K1 `/home/sean/PassHub/docs/business-scope.md`；K2 `/home/sean/PassHub/docs/discuss.md`；K3 `/home/sean/PassHub/docs/requirements-traceability.md`；K4 [Node Crypto](https://nodejs.org/api/crypto.html)；K5 [OWASP](https://cheatsheetseries.owasp.org/)；K6 [Buffer](https://nodejs.org/api/buffer.html)；K7 [ECMAScript](https://tc39.es/ecma262/)；K8 [Unicode](https://www.unicode.org/versions/latest/)；K9 [Nest JWT](https://github.com/nestjs/jwt/blob/master/README.md)；K10 [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken/blob/master/README.md)；K11 [Node 發行](https://nodejs.org/en/about/previous-releases)；K12 [Nest 遷移](https://docs.nestjs.com/migration-guide)；K13 [driver 交易](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)；K14 [Mongo 相容](https://www.mongodb.com/docs/drivers/compatibility/)；K15 [官方 driver repo](https://github.com/mongodb/node-mongodb-native)（v7.6.0）；K16 [npm metadata](https://registry.npmjs.org/)；K17 [Docker 官方映像](https://github.com/docker-library/official-images)及 registry manifests；K18 [Mongo8 發行](https://www.mongodb.com/docs/manual/release-notes/8.0/)；K19 [TS5.9](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html)；K20 [abort](https://www.mongodb.com/docs/v8.0/reference/command/aborttransaction/)；K21 [監測](https://www.mongodb.com/docs/drivers/node/current/monitoring-and-logging/monitoring/)；K22 [監測規範](https://github.com/mongodb/specifications/blob/master/source/command-logging-and-monitoring/command-logging-and-monitoring.md)；K23 [交易限制](https://www.mongodb.com/docs/v8.0/core/transactions-production-consideration/)；K24 [交易規範](https://github.com/mongodb/specifications/blob/master/source/transactions/transactions.md)；K25 [server repo](https://github.com/mongodb/mongo)（r8.0.32）。新增 K26 [snapshot](https://www.mongodb.com/docs/v8.0/reference/read-concern-snapshot/)；K27 [majority 讀](https://www.mongodb.com/docs/v8.0/reference/read-concern-majority/)；K28 [write concern](https://www.mongodb.com/docs/v8.0/reference/write-concern/)；K29 [driver CSOT](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/csot/)。均已參考・鎖定，無停止／移除；用途分別為既有業務、決策、追蹤、安全／runtime／交易 API／資料保證的精確前提；LLM 背景開啟，不支持版本／保證數據。 本次另有 K30 [Toxiproxy](https://github.com/Shopify/toxiproxy)；K31 [Node24 Test runner](https://nodejs.org/docs/latest-v24.x/api/test.html)；K32 [Jest Getting Started](https://jestjs.io/docs/getting-started)；K33 [Mongo8 Partial Index](https://www.mongodb.com/docs/v8.0/core/index-partial/)；K34 [Mongo8 Collation](https://www.mongodb.com/docs/v8.0/reference/collation/)；K35 [Mongo8 query $type](https://www.mongodb.com/docs/v8.0/reference/operator/query/type/)；K36 [Mongo8 query $exists](https://www.mongodb.com/docs/v8.0/reference/operator/query/exists/)。新增均一般參考、已參考・鎖定；K31／K32 只作測試工具候選資料，不支持已選定框架，當題沒有採用其功能保證。K30固定v2.12.0README已讀，不等於已鎖映像／真測。
- 完整引用回執（MongoDB官方8.0文件，查閱2026-09-19）：K33 CreatePartial允$type／$exists:true，PartialIndexwithUniqueConstraint只限制符合filter的文檔；K34 locale:simple為binarycomparison、索引與操作須相同collation；K35 Arrays明示query$type:string也匹配含string的array；K36 Definition明示$exists:true含null。故不用exists排空位，也不把partialindex當scalar型別驗證。以上文件版本8.0不是PassHub實跑8.0.32證據。
- 補充實讀：K25固定r8.0.32 [concurrent_unique_partial_index.js](https://github.com/mongodb/mongo/blob/r8.0.32/jstests/core/txns/concurrent_unique_partial_index.js)只測不符合partialfilter的資料並行無衝突；[transactions_write_conflicts_unique_indexes.js](https://github.com/mongodb/mongo/blob/r8.0.32/jstests/core/txns/transactions_write_conflicts_unique_indexes.js)測唯一索引並行衝突，不證同交易移走再重用相同唯一值。另兩個猜測unique_index(s).js路徑404，不採；舊版本社群搜尋線索不作8.0.32行為證據。未實測，沒有因此追加保證。
- 仲裁資料影響：查證支持語法與比較方向，但補出null及array邊界；推薦捍衛重述欄位形狀、索引及更新契約，必要真交易關卡不可省。
- 正式faceSlots：provider／subject原值、qualificationId、qualificationIncarnation、slotIncarnation、version；資格引用兩欄必須同null或同scalarUUID字串，禁止array／缺欄。受限寫入與啟動shape核對，不假稱索引會驗型別。索引unique(provider,subject)、simplecollation；另unique(qualificationId)、partialFilterExpression={qualificationId:{$type:"string"}}。辨識與資格反查同simple設定。
- 替換及歸屬：同scope反查資格舊槽核incarnation，真寫資格及舊新槽guard，清舊／綁新共同交易；D141handle對應實際解析槽、資格、版本、資料世代。無槽可為合法未綁，多槽／孤兒／incarnation不符則技術阻擋，不任選或自行修復；普通版本衝突仍按既定重讀，不誤叫腐敗。
- 明確風險閘門：固定Mongo8.0.32真交易驗證清舊槽資格引用後、把同資格唯一值綁新槽，是否能正常提交；同時驗多空槽、同資格雙綁、並行反查負查及失敗無部分保存。語法支持不證release／reuse可行。此小關卡在依賴它的核心功能前；未過立即停止返回討論，不靜默移除索引或任由實作者選資格guard替代方案。這不是留給實作者自行決定的分支。
- 仲裁：可採先做索引可行性小關卡的具體風險方案，非整體schema運作已驗證。下一單題P03b空subject槽容量、安全清理與首次競爭；政策可先收斂但不能越過索引gate。正常程式／配置／DB未改，136條U保留；按D114逐題保存验证後續進。

### D144｜4096 保留槽初值，陌生 Face 拒絕不建槽且解綁不回收

- 記錄日期：2026-09-19；狀態：捍衛開場 → UX異端 → 捍衛修正 → 仲裁，依D114採P03b有限政策，數值及代價待測。
- 槽生命期：faceSlots總量初值4096，包括bound與empty，不是有效綁定人數；白天不刪槽，僅既定完整dailyreset清除。只有管理綁定新subject時分配；既有空槽可重用，釋放清引用保留槽。INSIDE逾期不釋放，expiry按原FIFO整理；沒有TTL／背景清理／新映射回收API。
- 初次負查：FACE_UNKNOWN無subject不建槽；FACE_MATCHED查無槽亦不建槽，同交易真寫metadata.faceKeySpaceGuard再保存未映射Event。所有綁定／釋放亦真寫此共用guard與必要槽；已有槽辨識仍真寫該槽及資格guard。首次createunique競爭與負查共同受保護，FIFO不取代DB寫入競爭；避免陌生subject拒絕大量新增空槽。
- 配額：新槽及metadata.slotCount同交易檢查上限／更新；已滿可重用已存在空槽，不能建立新槽。啟動核對slotCount與實際槽總數，差異阻擋而非自动修正。全域guard增加競爭是明示代價，未量測；D143替換索引先驗gate保留。
- UX異端：累積換綁可能幾乎無有效映射仍滿槽，只說稍後重試會引導無效解綁／換ID。捍衛承認：技術code `FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED`，訊息明示「保留的subject槽位已滿；解除綁定不回收槽位」，同容量條件retryable=false。已知空槽重用與預定03:00reset是不同機會，reset非恢復保證，不新增subject查找或救援功能。
- 原項與错误語意：滿额只阻新管理綁槽，不取消已登記辨識時間權；缺槽辨識仍可保存未映射Event。管理容量失敗需安全確認無保存／無晚寫，不假回通行业務REJECTED、不省guard、不悄丟原項，也不套D91簽到預算耗盡終局。完整HTTP形狀留P04，該處不得重解為暫時忙碌。
- 仲裁／驗收：採有限政策，測大量換綁後滿額、新subject管理失败、解绑／换ID不加容量、existingempty可重用、陌生辨識不allocate且Event正常保存、首次綁定競爭與已登記準時保障、count共同回滾／啟動不一致阻擋、reset隔離舊工作。下一單題P03c完整欄位／編碼收尾，不留實作者默選。
- 依據與邊界：K2 D67／D72／D76／D99／D137／D141–D143、K3 A15／P03及本輪推論；UX、捍衛、仲裁獨立只交換正式論點，工程異端未混輪。沒有外查／code／設定／DB變更或實测，136条U保留，保存驗證後才續進。

### D145｜欄位／摘要表示封口，shape 與生命週期組合都要核對

- 記錄日期：2026-09-19；狀態：捍衛開場 → 工程異端 → 捍衛修正 → 仲裁，依D114採有限P03c資料契約；沒有schema／codec實作。
- 共用表示：業務實體_id為server UUID字串，guard incarnation亦UUID，version非負安全整數，溢出技術阻擋；nullable欄必須存在，以null表示未發生。metadata的_id="system"是明示單例例外，kind="system"唯一，不讓caller指定。日期為BSON Date。公開預置Source UUID與公開憑證跨reset穩定，Source incarnation／datasetEpoch用於新資料世代，ordinaryrestart不重生證據。seed固定帳號／ID由受控初始化提供，不授權公開自選主資料ID。
- qualifications補全：displayName字串；validFrom／validUntil／createdAt／updatedAt日期；createdBy人員ID；qrLookupDigest；presence；enteredAt／exitedAt／revokedAt／expiredTerminalAt可空日期，revocationReason可空字串。業務時間使用相應操作首次receivedAt，updatedAt為server構造變更時間，沒有以處理完成時間取代準時權。
- faceSlots補全：provider／subject精確原值；qualificationId／qualificationIncarnation同null或同scalarUUID字串；slotIncarnation／version。不允許array或缺引用欄；不在資格保存第二份有效Face權威。
- events補全：sourceId／externalEventId／kind／direction／outcome／reason enum、可空qualificationId、receivedAt／recordedAt、presenceTransition:{from,to}|null、inputHmac及comparisonReferenceId。receivedAt為原辨識首次登記；recordedAt只是server構造待保存紀錄時間，不冒稱commit完成或持久時間。Event不可變，公開投影不回HMAC／比較referenceID；API公開reasonCode如何投影在P04明定，不由infra另創理由。
- users／sources：users為exact username、Operator或Viewer role、enabled、passwordSalt／passwordHash hex及既定scryptParams；sources為唯一credentialAlias(entry／exit)、固定方向、active、credentialDigest與既定guard。alias只是未信任routing提示，須验证憑證後才取得可信Source ID。
- 摘要表示：hex64為64個小寫十六進位ASCII，HMAC及credentialDigest輸入比對解為32-byte Buffer。QR lookup採SHA-256(UTF8("PassHub/qr-lookup/v1")＋NUL＋原token)，不decode／normalize，原token不持久化。metadata保存datasetEpoch、comparisonReferenceId UUID、frameVersion v2、獨立審閱literal輸入／expectedframeUTF8hex及knownHMACvectors、qrGuardVersion／faceGuardVersion／slotCount。啟動不以同編碼器重造參考答案來假證實正確。
- 工程異端：欄位型別正確仍可能INSIDE但enteredAt空、同時未入場逾期終結。捍衛承認：write／decode／startup同核跨欄位不變量。NOT_ENTERED入離場時間皆null，撤銷／逾期明確終結至多一種；INSIDE entry非null／exitnull且兩終結皆無；EXITED兩時間非null且两終結無。revokedAt與非空revocationReason成對；expiredTerminalAt只未入場未撤銷明確終結，自然時間逾期只是衍生展示，不自動增終結事實。
- Event組合與錯誤：ACCEPTED必有資格及方向相符ENTRY／EXIT轉移；REJECTED transition=null。enteredAt保留原receivedAt，不另要求exitedAt>=enteredAt來偷加牆鐘／NTP假設，先後按原順位。多slot／孤兒／錯incarnation／非法組合技術阻擋受影響操作，不轉一般通行拒絕、不自行修復；普通版本衝突仍按原重讀。啟動shape／引用／metadata核對不能代替D120摘要來源限制。
- 仲裁／驗收：有限欄位契約可採，驗合法狀態codec往返、每種非法組合拒絕、摘要與version邊界、損壞資料不進裁決及無部分保存。D143索引可行性小關卡仍保留，不稱P03工程完成。下一單題P09 body入口／同步准入／認證handoff及HTTP等待；資源数值另P13。
- 依據：K4官方hash背景API、K2既定生命週期／D142–D144及本輪推論；三獨立工程角色只交换正式公開論點，沒有新外查／code／設定／DB變更，136条U保留。每題保存驗證後按D114續進。

### D146｜同步登記入口與專用重送分額，實際 raw hook 待 Q12

- 記錄日期：2026-09-19；狀態：捍衛開場 → 工程異端 → 捍衛修正 → 仲裁，依D114採准入分額政策；framework接線待Q12，沒有middleware實作。
- 候選入口：停用Nest內建body parser，自訂前置boundedrawreader收完整body，strictUTF8及basicJSON／結構檢查後，同一同步步驟取得完整資源、固定wallDate receivedAt／單調HTTP等待起點／順位，不插await。此時不是完整DTO或授權成功；较早暫存登記Auth慢，後到writer不能超車。初排隊不計執行，首次完整操作權才起15秒單調執行期限，每HTTP從自身登記起5秒且回一次。
- 普通／重送生命期：一般項先取得origin／validation／HTTP才登記；Auth→正式DTO→可信Source／eventID及凍結HMAC比較。同鍵同內容join原項、異內容conflict；驗證失敗或join安全移除自己的暫順位，validation真正結束才釋放。HTTP結束只釋own等待槽，不取消Auth或origin，不釋未完成工作。各權利用不透明admission／owner憑據。
- 重送支線：未認證聲明只是不可信retrycandidate，不因聲明直接可信查原項。專用支線只能驗證後關聯既有原項／保存結果，查無不得升級新origin或取得新準時權，即使後來有空位亦同；具體transport聲明格式P04明定。候選登記只算本HTTP等待，不是新業務原項接收權。已驗證newitem遇滿明示未受理、不建Event、不保留本次準時時間。
- 工程異端：8個validation若被慢Auth占滿，HTTP逾時亦不可釋，「有retry分支」不代表實際保留通道。捍衛承認並選待測分池：validation總8＝普通6＋retry專用2；HTTP總32＝普通28＋retry專用4，普通不能借專額。origin總32不縮28，HTTP關閉返普通等待名額時origin仍在，後續可再收。專額亦可飽和，有限backpressure、不保證每次重送即時驗證；不可信流量仍可能耗專額。
- 進度／canonical／確認：在途重送只看原項已知記憶進度，不新增DB確認或刷新額度；原協調器持續按既有共同額度確認。已保存結果可獨立readonly回放、不排在unknown寫入FIFO之後；查不到不證原項失敗。未通過驗證者不得可信進度，任何容量錯誤亦不得斷言原項不存在。具體canonical查讀與終局記憶下一P10完整閉合，不留繞確認預算的隱藏路徑。
- 仲裁／Q12：分池可採，完整同步准入／順位及實際生命期保留；hook尚未查不能宣framework已保證。依D114root核准唯一窄Q12，核fixedNest／Express停用預設parser、middleware順序、有界rawstream與嚴格解碼接線；查後仲裁影響、捍衛重述。body／slowupload及其他資源數值P13另定。
- 依據／驗收：K2D76／D95／D97／D99／D122／D136／D145、K3P09及本輪推論；測慢Auth不被後項超車、同步名額allornothing、join只還自己、普通滿仍專額可用／專額滿不漏資訊、候選查無不升級、HTTP與Auth／origin分離、回放不開業務。三獨立工程角色只交换正式論點，UX未混輪；沒有新外查／code／DB／設定變更，136條U保留。保存檢查後才進窄查。


### D147｜Q12 入口接線定案，HTTP 事件不得取消原項

- 記錄日期：2026-09-19；狀態：神諭窄查 → 仲裁影響 → 捍衛正式重述 → 仲裁；依D114持續授權預設接受P09入口契約，工程證據仍U。
- 全部知識範圍：K1 `/home/sean/PassHub/docs/business-scope.md`；K2 `/home/sean/PassHub/docs/discuss.md`；K3 `/home/sean/PassHub/docs/requirements-traceability.md`；K4 [Node Crypto](https://nodejs.org/api/crypto.html)；K5 [OWASP](https://cheatsheetseries.owasp.org/)；K6 [Buffer](https://nodejs.org/api/buffer.html)；K7 [ECMAScript](https://tc39.es/ecma262/)；K8 [Unicode](https://www.unicode.org/versions/latest/)；K9 [Nest JWT](https://github.com/nestjs/jwt/blob/master/README.md)；K10 [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken/blob/master/README.md)；K11 [Node 發行](https://nodejs.org/en/about/previous-releases)；K12 [Nest 遷移](https://docs.nestjs.com/migration-guide)；K13 [driver 交易](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)；K14 [Mongo 相容](https://www.mongodb.com/docs/drivers/compatibility/)；K15 [官方 driver repo](https://github.com/mongodb/node-mongodb-native)（v7.6.0）；K16 [npm metadata](https://registry.npmjs.org/)；K17 [Docker 官方映像](https://github.com/docker-library/official-images)及 registry manifests；K18 [Mongo8 發行](https://www.mongodb.com/docs/manual/release-notes/8.0/)；K19 [TS5.9](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html)；K20 [abort](https://www.mongodb.com/docs/v8.0/reference/command/aborttransaction/)；K21 [監測](https://www.mongodb.com/docs/drivers/node/current/monitoring-and-logging/monitoring/)；K22 [監測規範](https://github.com/mongodb/specifications/blob/master/source/command-logging-and-monitoring/command-logging-and-monitoring.md)；K23 [交易限制](https://www.mongodb.com/docs/v8.0/core/transactions-production-consideration/)；K24 [交易規範](https://github.com/mongodb/specifications/blob/master/source/transactions/transactions.md)；K25 [server repo](https://github.com/mongodb/mongo)（r8.0.32）。新增 K26 [snapshot](https://www.mongodb.com/docs/v8.0/reference/read-concern-snapshot/)；K27 [majority 讀](https://www.mongodb.com/docs/v8.0/reference/read-concern-majority/)；K28 [write concern](https://www.mongodb.com/docs/v8.0/reference/write-concern/)；K29 [driver CSOT](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/csot/)。均已參考・鎖定，無停止／移除；用途分別為既有業務、決策、追蹤、安全／runtime／交易 API／資料保證的精確前提；LLM 背景開啟，不支持版本／保證數據。
- K30 [Toxiproxy](https://github.com/Shopify/toxiproxy)；K31 [Node24 Test runner](https://nodejs.org/docs/latest-v24.x/api/test.html)；K32 [Jest](https://jestjs.io/docs/getting-started)；K33 [Mongo8 Partial Index](https://www.mongodb.com/docs/v8.0/core/index-partial/)；K34 [Collation](https://www.mongodb.com/docs/v8.0/reference/collation/)；K35 [$type](https://www.mongodb.com/docs/v8.0/reference/operator/query/type/)；K36 [$exists](https://www.mongodb.com/docs/v8.0/reference/operator/query/exists/)；K37 [Nest middleware](https://docs.nestjs.com/middleware)及[raw-body](https://docs.nestjs.com/faq/raw-body)；K38 [Nest v12.0.3 core](https://github.com/nestjs/nest/blob/v12.0.3/packages/core/nest-application.ts)及[Express adapter](https://github.com/nestjs/nest/blob/v12.0.3/packages/platform-express/adapters/express-adapter.ts)；K39 [Node v24.21.0 util](https://github.com/nodejs/node/blob/v24.21.0/doc/api/util.md)；K40 [Express5 API 索引](https://expressjs.com/en/5x/api/)；K41 [Node24 HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html)。K30–K41皆一般參考、已參考・鎖定；用途依序為故障工具、測試候選、索引比較、入口接線與嚴格解碼／HTTP生命期，不支持已實測保證。K40本次未採用任何知識；K31／K32仍未選定。所有來源無停止／移除。
- 完整引用回執（官方文件／固定源碼，查閱2026-09-19）：K37 middleware的全域middleware／parser章及raw-body警語支持bodyParser:false停預設parser，但rawBody:true helper依赖parser enabled，不可並用。K38 nest-application.ts init先決定parser再modules/router，use委派adapter；express-adapter.ts預設裝json／urlencoded parser。故composition在init／listen前裝functional receiver並明確傳能力，不假Nest DI／exception filter覆蓋底層app.use。
- K39 util.md TextDecoder章：fatal:true拒解碼錯誤；ignoreBOM:true反而保留BOM，ICU-disabled環境不支持fatal。K41 IncomingMessage.complete／close、ServerResponse.close／finish章：complete表示HTTP完整，req.close自v16不等於socket取消，res.finish僅交OS不證收件。K40僅API索引，本次未採任何功能知識。官方能力不是專案跑通證據。
- 捍衛正式主張／知識基礎：D146、K37–K39／K41及本輪推論。使用bodyParser:false、不搭rawBody helper；receiver收完整bounded body，用fatal:true／ignoreBOM:true嚴格UTF-8且明確拒BOM，再同步basicJSON／結構、完整准入／receivedAt／单調等待起點／順位，才asyncAuth及DTO。啟動核對runtime解碼能力；前置錯誤明確有限去敏出口，不靠未接入filter。
- HTTP唯一response owner協調結果、五秒與提前斷線，只完成一次；req.close不cancel原項，finish不釋仍執行能力。HTTP等待、Auth、origin分生命期。D146 origin32／validation6+2／HTTP28+4及retry不升新項保留。未知／在途重送不新增原確認預算。
- 仲裁：查證修正helper及close誤用，契約可採。必要驗收middleware實際順序、每類前置錯誤、跨chunk非法／截尾UTF-8、BOM、HTTP一次回覆及晚結果資源、慢Auth不超車；皆待實作。下一單題P13登記前raw body與高成本認證資源初值，不建立泛用入口平台。
- 邊界：獨立角色僅交換正式查證與主張；未改code／設定、未安裝或啟動服務。每題保存與檢查後續進，136條U不變。


### D148｜入口與查讀資源待測初值，限速不取代未收束工作上限

- 日期：2026-09-19；捍衛開場→工程異端→捍衛修正→仲裁，依D114預設接受P13有限配置，全部工程驗收U。
- 登記前初值：同時連線64、raw reader16、body16KiB；自應用觀察request起固定5秒收完整body、不按chunk刷新；header／keepalive候選5秒。超限關閉／拒本次傳輸，不登記準時權、不建Event。reader／連線按真生命期釋；完整body移交驗證後其buffer受對應工作容量限制，不留額外無界副本。精確server設定及涵蓋範圍在首個入口實作gate核對／測試，沒有宣称已由API保證。
- 普通validation6細分相關寫入4、login1、query1；retry專用2不借，合計8。login另scrypt並行1、無等待queue，實際計算結束才返額，HTTPclose／逾時不取消。這是約128MiB單次scrypt成本的背景起點，不保證程序總記憶體。
- 命中攻擊：每分鐘rate不能封住跨HTTP尚未結束的DB工作。修正query1驗證額一路持到DB工作真收束；一般queryDB1、已保存canonical回放2、原項確認獨立1且仍按10秒／7格串行。原項執行也按既有單writer；回放滿只能在已計容量工作內等，不生無界queue。timeout不自動證工作停止，須實測持額及最終收束；HTTP结束不歸還其他仍在使用的額度。
- fixed-minute rate待測初值：login每socket-peer IP5／全局20；query每可信帳號60／全局120；辨識每可信Source30／全局60；管理每可信帳號10／全局20，單位皆每分鐘，重送亦計。認證後新業務之前判准入；超限清自己的暫登記、不保留本次新原項時間權、不建Event。已受理原項不因後來rate取消／刷新。其餘入口滿不得断言原項不存在。
- IP計數表256，只移除過期項；滿表拒新IP項、不驅逐有效項以繞限，既有IP按原額。默认不信Forwarded／X-Forwarded-For，按socketpeer；可信代理範圍P14明定。tech出口去敏且有限，不回顯body／秘密。原origin32、HTTP28+4及實際生命期不變。
- 仲裁：攻擊已在設計回應，初值可採但不是最優值或體驗／吞吐承諾。驗收慢body、未收束query、Auth／scrypt及重送分池滿、rate窗口／滿IP表／偽造proxy／postauth拒收、名額只返一次及晚callback；皆未執行。下一單題P10原ID在途／完整結果／技術終局記憶，不增加持久pending。
- 基礎：K2D99／D122／D146／D147、K3P13、K41的HTTP生命期前提與本輪工程推論；三独立工程角色只交换公开论点，无新外查／code／install／DB／部署變更。


### D149｜原 ID 記憶4096格與資料世代前置條件，重啟不默默恢復寫入

- 日期：2026-09-19；捍衛開場→UX異端→捍衛修正→仲裁，依D114預設接受P10；沒有實作registry或維護標記。
- 同process／dataset registry待測初值4096格，白天無TTL、淘汰或按HTTP期限遺忘，完整reset後才清。可信鍵SourceID＋externalEventID；保留inputHmac／comparisonReferenceId、原receivedAt／順位及去敏狀態。在途／unknown持原owner和全部共同預算；canonical完成保存原結果或Event定位；安全技術終局保存充分無效果／無晚寫證據及技術結果，同ID不得新做。
- 普通新辨識候選整組同步准入新增registry預留，與origin／validation／HTTP同时取得；可信join既有項則返自己的預留。滿格停止新原項、不淘汰舊ID，專用retry仍可驗證關聯或有限canonical回放。在途重送不發新DB確認。技術終局記憶不是AccessEvent；沒有持久pending或新恢復服務。
- UX命中：文字說不跨reset不足，旧ID可能被悄当新項。採technical header `PassHub-Dataset-Epoch`，目前epoch由現有login／query及准入錯誤回覆提供，不增metadata管理API；相關寫入與重送必帶所處dataset原epoch。缺失／不符回技術前置條件錯誤、無Event／新項；epoch非認證。明確取新epoch提交是新dataset操作，不是旧项續辦，Demo腳本不得自動刷新epoch重送舊內容。
- 重啟取捨：metadata新增writeRunClaim:{datasetEpoch,processRunId}；完整reset成功後null，啟動須原子claim且確認成功才開寫。claim使用後正常停止亦不清，新process看到既有claim或claim結果未知則寫入關閉；不能依registry空／程序停／DB看空接管。read-only及DB canonical回放仍須原認證、相容檢查及有限資源；找不到不證舊項失敗。
- 同dataset普通restart不恢復寫入，明確犧牲保留資料重啟可用性；重新開寫只能private維護隔離旧DB工作→完整reset新epoch，不是自動清庫，不稱重啟已證no-late。比較／部署秘密普通重啟保持不變，D109相容核對仍必要；本決策增加啟動寫入門檻而不覆寫舊摘要。
- 仲裁：有限記憶及可辨認reset界線可採；驗收4096邊界、同步返額、同ID终局重送、完整結果／异內容回放、旧epoch拒絕、claim並行/未知/普通restart不得寫及受控reset後新epoch。全部U。下一P04具體API／DTO／進度／status，不拓展新业务。
- 基礎：K2D91／D99／D109／D122／D146–D148、K3P10、使用者跨reset能力邊界與本輪推論；獨立UX、捍衛、仲裁只交換公開主張，未外查／改code／DB／部署。


### D150｜十個業務端點與明確進度回覆，不把技術未知當通行拒絕

- 日期：2026-09-19；捍衛開場→工程異端→捍衛修正→仲裁，依D114預設接受P04a。原始JSON傳輸另P04b，實際API未建立。

| Method／path | 能力／輸入 |
|---|---|
| POST /auth/login | 匿名；username、password |
| POST /qualifications | Operator；displayName、validFrom、validUntil、face |
| PATCH /qualifications/:id | Operator；上述四欄非空子集 |
| POST /qualifications/:id/revoke | Operator；reason |
| GET /qualifications | Operator／Viewer；limit?、cursor? |
| GET /qualifications/inside | Operator／Viewer；limit?、cursor? |
| GET /qualifications/:id | Operator／Viewer；資格詳情 |
| GET /events | Operator／Viewer；limit?、cursor?、qualificationId?、outcome?、reasonCode? |
| GET /events/:id | Operator／Viewer；含qualificationId=null的事件詳情 |
| POST /recognition/attempts | Source；辨識三種互斥DTO |

- 命中遺漏：最初表漏B44Eventdetail；承認補回，沒有擴業務。events三篩選AND且enum／UUID驗值；所有DTO／巢狀未知欄及query未知／重複參數拒絕，不默採首／末值。不得提供Source、方向、clienttime、Presence、QR查回或資格ID辨識捷徑。
- DTO：create face必有，null或{provider,externalSubjectId}；update未提供欄維持原值，face:null清綁，face物件替換，其餘按domain狀態／時間核對。辨識{externalEventId,kind:QR_SCANNED,token}、{externalEventId,kind:FACE_MATCHED,provider,externalSubjectId}、{externalEventId,kind:FACE_UNKNOWN}。識別原值沿D119；displayName1–128UTF8bytes、reason1–512bytes，wellformed禁既定控制碼、不trim。login exactseedusername/password1–128UTF8bytes不轉換。date只有效YYYY-MM-DDTHH:mm:ss.SSSZ，精確roundtrip驗日曆，不接受offset／隱式數字／client決策時間。
- 人員Authorization:Bearer JWT；Source Authorization:Source alias.secret，角色不混用。相關寫入／辨識重送必帶PassHub-Dataset-Epoch；缺失／非法400，不符409。PassHub-Retry-Mode:existing-only只辨識既有項，不升new；其精確傳輸與重複header處理接P04b。
- Eventlist／detail／辨識共用安全投影：eventId、sourceId、direction、kind、outcome、reasonCode、receivedAt、recordedAt、qualificationId、presenceTransition。DBreason只投影為reasonCode，政策一致；無token、完整subject、媒介原輸入、HMAC／referenceID。辨識200，ACCEPTED及REJECTED皆須先完整保存；另replayed:boolean，true不是再次授權。資格查詢保持B48完整摘要／有效faceBound，不以最小DTO刪欄。
- 可信在途202含原externalEventId／receivedAt，stage=QUEUED|RUNNING|CONFIRMING|PAUSED_UNKNOWN，confirmationState=NOT_STARTED|ACTIVE|EXHAUSTED，control=NONE|MANUAL|MAINTENANCE。PAUSED_UNKNOWN+EXHAUSTED+NONE只等晚證據／人工介入，不稱持續新確認或已接管；所有stage無業務outcome。已驗證重送立即回已知進度，不故意再等五秒。
- 未驗證／未能確認本次原項503 REQUEST_STATUS_UNCONFIRMED，無可信進度；readonlyrestart查不到canonical503 CANONICAL_RESULT_UNCONFIRMED，不證不存在／失敗。已安全且執行額度耗盡終局503 OPERATION_EXECUTION_EXHAUSTED、terminal:true，同ID不重啟，不是Eventreason／REJECTED。格式400、認證401、權限403、idem衝突409、rate429、techbusy／未完成503；槽滿507 FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED沿D144。
- 管理create201且唯一成功回覆含qrToken；update／revoke200安全摘要。HTTP五秒或斷線不cancel，無管理冪等／progressAPI；create回覆遺失不能補取QR，盲重送可能另建資格，操作文件不得教自動重試create。limit暫定20／max100、cursorASCII≤512，完整編碼／排序P11；health／OpenAPI僅technical交付P14。
- 仲裁／驗收：補回既有能力後契約可採，逐端點真HTTP核角色、unknown／重複輸入、日期、Event無資格、投影、stage／終局、epoch、existingonly及丟回應限制；全未測。下一P04b rawJSON／格式／傳輸，不開始code。
- 基礎：K1§8.3、K3B44／B46／B49／P04、K2D119／D122／D145–D149及本輪推論；三獨立工程角色只交换公開論點，無新外查／install／DB／部署變更。


### D151｜有界深度先篩，原生完整語法後驗，禁止重複鍵與模糊傳輸

- 日期：2026-09-19；捍衛開場→工程異端→捍衛修正→仲裁，依D114預設接受P04b，scanner與HTTP接線均未實作。
- Content-Type只application/json，可帶唯一charset=utf-8；Content-Encoding只缺省或identity，其他415。大小16KiB／完整收body5秒沿D148，超大小413；嚴格UTF-8、BOM、JSON或結構400。不得自動解壓／修值／忽略BOM。
- 異端命中順序：16KiB已有總量上限，非無界；但先完整parse再depth只限制可接受內容、未保護解析順序。捍衛承認改為rawstrictdecode→有限容器depthfilter→原生JSON.parse全語法→按JSON解碼後鍵值掃原文duplicate，全部同步於准入／登記前；之後Auth／完整DTO沿D147。
- filter只追字串內／外、escape、容器；字串內括號不計、字串外任何array拒、root必object、object最多兩層。括號不匹配／無法安全辨認亦拒，通過仍須原生驗grammar，不能自造fullparser或稱filter證JSON合法。duplicate包括a與Unicodeescaped同鍵，不能靜默最後值；合法DTO不用array。
- Content-Type、Content-Encoding、Authorization、PassHub-Dataset-Epoch、PassHub-Retry-Mode原始header重複400，不接受框架合併。query解碼後名重複400，不trim／coerce或默採首末值。unknownDTO／query沿D150。UUID為小寫標準形狀、日期固定UTC毫秒及實際曆日，不任Date修正；識別D119原值不變。
- readonly不用epoch但回覆提供目前epoch；相關寫入及existing-only重送仍必带epoch。错误只有限技術碼／說明，不echo原body／secret／subject／parserstack。req.close不取消登記原項。
- 首入口gate必測rawheaders合併前拒絕、decodedqueryduplicate、escapedduplicate、字串括號／長escape／截尾／16KiB內極深object／array／depth邊界，與原生parse完整語法及合法DTOcorpus對照；此為scanner及固定Node／Nest／Express接線的阻擋驗收，不宣已具備。全部U。
- 仲裁：順序缺口在設計解決，有限契約可採。下一P11分頁／索引／可重跑效能，不擴業務。依據K2D119／D147–D150、K39／K41已查前提及本輪推論；三獨立工程角色只交换公開主張，无新外查／code／DB／部署。


### D152｜固定 keyset 分頁與八種篩選各別效能證據

- 日期：2026-09-19；捍衛開場→UX異端→捍衛補強→仲裁，依D114預設接受P11。沒有建立索引、fixture或效能成果。
- 資格list固定createdAt DESC／_id DESC；INSIDE list固定enteredAt DESC／_id DESC、含逾期INSIDE；Eventlist固定receivedAt DESC／_id DESC、qualificationId／outcome／reasonCode三篩選AND。readonly不整理映射、不增加搜尋／自訂排序。
- limit只無前導零十進位1–100、預設20；未知／重複參數400。續頁用時間更小、或同時間ID更小。cursor無paddingbase64url、ASCII≤512，標準編碼往返必一致，固定八元素JSONarray：[\"p1\",epoch,endpoint,qualificationId|null,outcome|null,reasonCode|null,lastTime,lastId]。endpoint literal僅qualifications|inside|events；前兩清單三filter位皆null。每位置既定primitive/null、禁nestedarray/object；日期／UUID／endpoint／filters與本次請求精確匹配，epoch不符409。limit可變，cursor非授權，不直接變Mongoquery；HTTPbody禁array不套此固定內部格式。
- 不跨頁snapshot，每頁看當次資料；較晚保存的Event可能落在已翻區段，INSIDE退出可消失，不承諾完整遍歷當初集合。刷新首頁看最新狀態；不可用cursor解碼技巧冒稱歷史完整快照。
- 非唯一查詢索引：qualifications(createdAt DESC,_id DESC)、qualifications(presence ASC,enteredAt DESC,_id DESC)、events(receivedAt DESC,_id DESC)、events(qualificationId ASC,receivedAt DESC,_id DESC)。既有唯一／partialunique／simple語義保留，不造八組索引。不宣稱自動planner一定最佳，真explain與分頁正確性待驗。
- UX命中：總體p50/p95不能支持八filters皆改善。候選讀取fixture為隔離performanceDB10000資格／40000Event，含各Presence及無資格拒絕，shape／引用／跨欄位不變量必核對；不宣稱公開API能寫此規模。八case=無filter、三單、三雙、三者AND，各固定參數並報符合筆數／選擇率。
- 各case limit20首頁及固定續頁各10warmup／100measure，分別保存rawsamples／p50／p95及獨立explain keysExamined／docsExamined／執行資訊；附版本、硬體、fixturehash、Gitcommit。beforeafter僅切本題非唯一查詢索引，unique不動、資料／負載相同；只在隔離perf環境，不能對公開DemoDB做benchmark清理。
- 門檻是結果／分頁正確及證據完整，不預設改善百分比。未改善／退步照報，只涵蓋量測情境；實測後才解鎖履歷效能敘述。第一查詢gate驗同time跨頁／limit邊界／各filter／cursor非法與跨endpoint/dataset／並行可見性限制。
- 仲裁：反例已補回逐case證據，契約可採但工程U。下一P12去敏日誌及P08最小私密管控，不新增恢復平台。依據K3B44–B47／E04、K2D150／D151及本輪推論；独立UX／捍衛／仲裁只交換公開論點，無新外查／code／DB／部署變更。


### D153｜私密暫停須先切斷新許可，凍結歸屬不凍結允許值

- 日期：2026-09-19；捍衛開場→工程異端→捍衛修正→仲裁縮限→捍衛正式接受→仲裁；依D114預設接受P12及P08最小管控，工具未建立。
- structured JSON固定allowlist：server requestUUID／operationUUID、datasetEpoch／processRunId／owner、round／group／phase、額度與固定技術碼。重送有自己requestUUID但關聯原operation；舊callback用建立時凍結的歸屬context，不能寫新owner紀錄。driver監測只安全命令名／requestId關聯，不dumpcommand/reply/error，也不把monitor次數當完整wire次數。
- 不記token／密碼／keys／salt或hash／完整subject／body／任意drivererror message。queue初值128筆，每筆≤2KiB、5份各10MiB輪替，目录0700／檔案0600；超額或寫失敗有限丟棄並標LOGGING_DEGRADED、不遞迴記錯。這是best-effort技術日志，非必要AccessEvent；drop不冒稱Event保存失敗或全紀錄已完整，必要Event仍原子持久後才回業務結果。未来host-onlylogs:read按operationUUID讀取，不公開日志查詢API。
- 真管控入口：host-only CLI／私有Unixsocket，目錄0700／socket0600；status去敏看revision／進度，hold建立manualveto／controlId，release匹配controlId／epoch／run／expectedRevision只撤自身veto，drain建立獨立maintenance禁止並有限等待。沒有publicAdmin/recovery API，不新增durablepending。外部reset能在API停止後独立運作，不靠socket續辦。
- 工程異端命中：舊callback把allowed判斷凍住，可能holdack後才newcall。捍衛承認：hold同步更新currentrevision／veto許可屏障後才ack，每個尚未交driver業務步驟／重跑重核現行owner／revision／veto，檢查→登記pending→交driver間不await。凍結的是歸屬、不是當前permission。
- hold成功不證已撤回：交driver含内部queue皆issued/inflight，ack後可能晚wire；必要確認／中止按原scope／owner／共同budget安全收尾，不新做業務。drain逾時明示notdrained，不證DB隔離。manual／maintenance独立，release不清maintenance、unknown或補预算，晚證據亦不能越有效veto。
- 仲裁另縮限控制重送：只current／last transition有限context，核epoch／run／expectedRevision／requestControlId及參數；匹配當前/last可回放，state再推進後舊revision拒絕不重做。不承諾全歷史控制回覆／無界map。捍衛已正式接受此取代最初未限定的controlid歷史回放提議。
- 驗收：真socket權限／command並行／staleepochrunrevision／hold屏障＋晚driverwire／release不越未知或maintenance／controlled重送限界，日志buffer／rotation／失敗無遞迴／已知秘密全表面掃描／原callback歸屬。全部U，沒有靠log告警假稱接管。
- 下一P14單API部署／外部03:00reset／舊工作隔離／成功才重啟、失敗不可用。依據K2D83–D89／D141／D149及本輪工程推論，独立工程／捍衛／仲裁只交換正式論點，无新外查／code／install／DB／部署。


### D154｜部署維護分 bootstrap 與 ready，排除許可循環後核准 Q13

- 日期：2026-09-19；捍衛開場→工程異端→捍衛修正→仲裁，依D114採P14接線方向；精確生命期前提待Q13，沒有部署或clear。
- 自管Linux／DockerCompose，單API及單成員Mongo replica set、D125pins，非HA。host／domain／TLS憑證為交付前置，不購買或假設已有。選Nginx官方映像作HTTPS反代，版本digest待唯一Q13；API／Mongo無hostports、不mountDockerSocket，proxy覆寫轉送標頭、API只信固定proxy私網IP/32，不全信bridge或任意Forwarded。
- 待測起點host2vCPU／4GiBRAM／20GiB空閒盤；API768MiB／Mongo1536MiB／proxy128MiB，proxy／Docker日志另有限輪替。這不是人數／吞吐承諾；resource及TLS真gate驗收。
- external03:00AsiaTaipei流程：exclusivehostlock＋persistentmaintenance marker／host公網屏障→drain最多30秒→停API確認舊API程序停止（不證DBworkgone）→停Mongo確認舊DB程序停止→啟Mongo待恢復完成PRIMARY→只passhub_demo六collection清理／seed稳定公開憑證、新epoch及nullclaim（JWT/HMACkey不換）→受控bootstrap／ready／handoff才開公網。任何停止未知／恢復／clear／seed／startup失敗都failclosed，不能skip隔離或broad dropDB。
- 工程命中許可循環：若localgate就是ready，而marker阻许可，互依卡死。承認拆bootstrap-verification（配置、PRIMARY、schema/index/向量/epoch及受控claim，不執行業務、不要求service-ready）及service-ready（許可成立後）。host在exclusive lock提供私密單次runTicket限定新epoch/processRunId，普通啟動不能自造或越marker；非lease／逐項pending平台。
- bootstrap成功後私密控制授權該run撤serviceveto，再本機ready；host公網屏障仍封、marker仍標未完成handoff，不把marker有無當唯一許可。ready失敗重維持veto／停API，不解marker／外層封閉；ready成功交接完成才移除marker開公網。ordinaryrestart沿D149不能接管claim；live只process，ready不是bootstrap等價物。
- 仲裁：方向可採，停止請求／drain／processgone與DB舊工作隔離須分清，不能未查就假證no-late。Q13依D114root核准唯一窄官方查：systemd時區排程／util-linux互斥鎖、Docker停止程序生命期、Mongo停止恢復及精確清理、所選Nginx官方映像版本digest；不展軟體比較，domain/cert仍外部前置。
- 查後按神諭→仲裁影響→捍衛重述→仲裁保存下一block。驗收全流程各階段故障、旧claim/marker普通重啟、单实例、舊DB工作隔離及清理精確目標；全U。依據K2D52／D125／D149／D153、K3P14及本輪推論，三獨立工程角色只交換公開論點，code／DB／部署未改。


### D155｜Q13 後鎖代理與外部夜間維護，漏排不白天補清庫

- 日期：2026-09-19；窄神諭→仲裁影響→捍衛正式重述→仲裁，依D114預設接受P14具體計畫；實際部署／隔離／清理全U。
- 全部知識範圍：K1 `/home/sean/PassHub/docs/business-scope.md`；K2 `/home/sean/PassHub/docs/discuss.md`；K3 `/home/sean/PassHub/docs/requirements-traceability.md`；K4 [Node Crypto](https://nodejs.org/api/crypto.html)；K5 [OWASP](https://cheatsheetseries.owasp.org/)；K6 [Buffer](https://nodejs.org/api/buffer.html)；K7 [ECMAScript](https://tc39.es/ecma262/)；K8 [Unicode](https://www.unicode.org/versions/latest/)；K9 [Nest JWT](https://github.com/nestjs/jwt/blob/master/README.md)；K10 [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken/blob/master/README.md)；K11 [Node 發行](https://nodejs.org/en/about/previous-releases)；K12 [Nest 遷移](https://docs.nestjs.com/migration-guide)；K13 [driver 交易](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)；K14 [Mongo 相容](https://www.mongodb.com/docs/drivers/compatibility/)；K15 [官方 driver repo](https://github.com/mongodb/node-mongodb-native)（v7.6.0）；K16 [npm metadata](https://registry.npmjs.org/)；K17 [Docker 官方映像](https://github.com/docker-library/official-images)及 registry manifests；K18 [Mongo8 發行](https://www.mongodb.com/docs/manual/release-notes/8.0/)；K19 [TS5.9](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html)；K20 [abort](https://www.mongodb.com/docs/v8.0/reference/command/aborttransaction/)；K21 [監測](https://www.mongodb.com/docs/drivers/node/current/monitoring-and-logging/monitoring/)；K22 [監測規範](https://github.com/mongodb/specifications/blob/master/source/command-logging-and-monitoring/command-logging-and-monitoring.md)；K23 [交易限制](https://www.mongodb.com/docs/v8.0/core/transactions-production-consideration/)；K24 [交易規範](https://github.com/mongodb/specifications/blob/master/source/transactions/transactions.md)；K25 [server repo](https://github.com/mongodb/mongo)（r8.0.32）。新增 K26 [snapshot](https://www.mongodb.com/docs/v8.0/reference/read-concern-snapshot/)；K27 [majority 讀](https://www.mongodb.com/docs/v8.0/reference/read-concern-majority/)；K28 [write concern](https://www.mongodb.com/docs/v8.0/reference/write-concern/)；K29 [driver CSOT](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/csot/)。均已參考・鎖定，無停止／移除；用途分別為既有業務、決策、追蹤、安全／runtime／交易 API／資料保證的精確前提；LLM 背景開啟，不支持版本／保證數據。
- K30 [Toxiproxy](https://github.com/Shopify/toxiproxy)；K31 [Node24 Test runner](https://nodejs.org/docs/latest-v24.x/api/test.html)；K32 [Jest](https://jestjs.io/docs/getting-started)；K33 [Mongo8 Partial Index](https://www.mongodb.com/docs/v8.0/core/index-partial/)；K34 [Collation](https://www.mongodb.com/docs/v8.0/reference/collation/)；K35 [$type](https://www.mongodb.com/docs/v8.0/reference/operator/query/type/)；K36 [$exists](https://www.mongodb.com/docs/v8.0/reference/operator/query/exists/)；K37 [Nest middleware](https://docs.nestjs.com/middleware)及[raw-body](https://docs.nestjs.com/faq/raw-body)；K38 [Nest v12.0.3 core](https://github.com/nestjs/nest/blob/v12.0.3/packages/core/nest-application.ts)及[Express adapter](https://github.com/nestjs/nest/blob/v12.0.3/packages/platform-express/adapters/express-adapter.ts)；K39 [Node v24.21.0 util](https://github.com/nodejs/node/blob/v24.21.0/doc/api/util.md)；K40 [Express5 API 索引](https://expressjs.com/en/5x/api/)；K41 [Node24 HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html)。K30–K41皆一般參考、已參考・鎖定；用途依序為故障工具、測試候選、索引比較、入口接線與嚴格解碼／HTTP生命期，不支持已實測保證。K40本次未採用任何知識；K31／K32仍未選定。所有來源無停止／移除。
- K42 [systemd v255 time](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd.time.xml)／[timer](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd.timer.xml)：一般參考，已參考・鎖定，排程語義；K43 [Docker stop](https://docs.docker.com/reference/cli/docker/container/stop/)／[inspect](https://docs.docker.com/reference/cli/docker/container/inspect/)／[Compose start](https://docs.docker.com/reference/cli/docker/compose/start/)：一般參考，已參考・鎖定，程序生命期；K44 [Mongo8 shutdown](https://www.mongodb.com/docs/v8.0/reference/command/shutdown/)／[journaling](https://www.mongodb.com/docs/v8.0/tutorial/manage-journaling/)／[deleteMany](https://www.mongodb.com/docs/v8.0/reference/method/db.collection.deletemany/)：一般參考，已參考・鎖定，停止恢復與精確清理；K45 [Nginx proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)／[SSL](https://nginx.org/en/docs/http/ngx_http_ssl_module.html)／[rewrite](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html)：一般參考，已參考・鎖定，入口屏障／轉送；K46 [util-linux v2.39.3 flock](https://raw.githubusercontent.com/util-linux/util-linux/v2.39.3/sys-utils/flock.1.adoc)：一般參考，已參考・鎖定，local互斥。全部K1–K46保留，無停止／移除；LLM背景仍開啟只支持一般推論。
- 完整實讀回執：K42固定v255time.xml CalendarEvents／IANA timezone及timer.xml OnCalendar／AccuracySec／Persistent，支持明列時區但非精確秒點，Persistenttrue啟用可補inactive漏排。K46固定v2.39.3flock.1.adoc exclusive/nonblock／filedescriptorclose及NFS/CIFS限制；因此選local固定lockinode，無unlink／網路FS鎖假保證。systemd網站403不當證據，使用官方固定源碼文檔。
- K43stop官方SIGTERM或StopSignal→grace→SIGKILL，timeout設定非process已消失證據；inspect／Compose start頁僅一般命令資料。K44Mongo8shutdown SIGTERM在primarystepdown失敗仍繼續，quiesce後結束remainingops；journaling重啟reapplyjournal，不能停後跳過恢復；deleteMany空filter刪該collection全部，drop需重建indexes，未採broaddrop或rollback保證。
- K17新增實讀官方library/nginx表：stable1.30.5-trixie、源碼commit a16f1329e13e7273c4103f75d863ca625b75109e。匿名registry唯讀manifest鎖`nginx:1.30.5-trixie@sha256:f91bdb7aee4cba26f89b1c5c3aa12742ec3c91c6d70fd7007c6dc797e9676c45`，列amd64/arm64，實作targetlinuxamd64；沒pull／運行。K45實讀proxyrequestbuffer預設on、chunked須明配HTTP1.1、nextupstream預設error/timeout、ignoreclientabort預設off、setheader與SSLcertificatekey及rewrite-file/return章。不採示例舊cipher、不自動代管TLS。
- 捍衛正式主張／基礎：K17、K42–K46、D149／D153／D154及本輪推論。timer `OnCalendar=*-*-* 03:00:00 Asia/Taipei`、AccuracySec=1s、RandomizedDelaySec=0、Persistent=false；漏排不白天補破壞性reset，host需時間同步/tzdata、實際calendar與觸發gate，不保精確點。host固定local exclusive nonblockingflock及persistentmarker，不unlink鎖檔；非APIcron。
- 反代：鎖上述NGINX映像，TLSdomain/key/certificate由使用者環境提供；API/DB不發布hostports，無DockerSocket。proxy_request_buffering off、顯式HTTP1.1、proxy_next_upstream off、body16KiB、upstreamread/send初15s（非wholedeadline）、覆寫XFF為remoteAddr，API只信固定proxyIP/32。marker檔存在則公網503；clientabort不取消原項，應用owner自負生命期。
- 主runbook：exclusivehostlock／marker封入口→privatedrain最多30s→stopAPI確認既定唯一舊程序停止→stopMongo確認舊DB程序停止→startMongo確認journal恢復完成PRIMARY→指定passhub_demo六collection逐一deleteMany({})保留indexes→seed新epoch/nullwriteRunClaim及metadata向量、假帳號/Source穩定、部署keys不換→privateoneuserunTicketbootstrap-verification→授權本機service-ready→成功handoff才撤marker開公網。API/Mongo明配stop_signalSIGTERM及30sgrace，API無自動restart；grace到／stopresponse本身不證隔離。若有額外writer/API/container或停止狀態不明，拒跳步、外層封閉，先解精確環境問題。
- 精確清理僅qualifications/faceSlots/events/users/sources/metadata，僅passhub_demo；不dropDB、不清admin/system/local或volume。若停止／恢復／clear/seed/claim/startup/ready不確定，APIoff/marker保留，不稱seed原子整庫完成，可維護者按同受控流程安全重跑。初部署同explicitinitializer，不因空庫自動heal。ordinaryrestart同dataset寫入沿D149關閉，安全相容canonicalreadonly回放仍有限；marker不是新process接管許可。
- 防許可循環保留：bootstrap只配置/PRIMARY/schema/index/shape/vector/epoch/受控claim，不業務、不等同ready；私密runTicket限定新epoch/run，由持lockcontroller提供，普通啟動不可自造。bootstrap成功才授權該run撤serviceveto作localready，host公網marker仍封；失敗重veto/stopAPI，成功才handoff。privatehandoff只此維護能力，不解原項unknown／補預算，不新增lease/pending。
- 全表面去敏：Nginx access_log off/error_log /dev/null；Mongo原始query/command/profiling日志不開/不採集，Demo候選logpath /dev/null；controller只固定去敏phase，不echo原工具錯誤或secret配置。應用D153allowlist日志、容器輸出皆進knownsecret掃描阻擋publicgate。取捨是不提供原始DB/代理診斷證據；掃描有限案例非永不洩漏證明，須結合輸出限制。
- 仲裁：已足採可驗收的規劃，不再擴平台；P14真proc終止／recover/precisetarget／oneAPI／ticket/permission／失敗各階段／排程與公網代理語義皆待工程。next唯一P07測試工具定稿＋P15有限gates。獨立角色只交换正式來源/主張，本機code/install/Docker/DB/部署未動。


### D156｜原生 Node 測試工具定稿，正式證據綁受測 source 而非漂亮綠燈

- 日期：2026-09-19；捍衛開場→工程異端→捍衛修正／正式補充→仲裁，依D114預設接受P07工具及證據規則，未安裝／測試。
- 完整實讀回執／基礎：K31固定Node24.21官方Test runner executionmodel／childinheritance與runoptions，默认processisolation、testfilechild、test-concurrency限制並行child、forceExit=false／timeout預設Infinity；本題不採Infinity。K32 GettingStarted的TypeScript轉換設定不等於typecheck，只候選對比，未核Jest當前version。K30固定v2.12.0官方README／release曾讀，映像pin及實際代理仍待toolgate。其餘K1–K46保留locked無停止／移除，LLM背景只一般測試隔離推論。
- 選strictTS先編CJS，再Node24.21node:test／node:assert，runnerprocessisolation／concurrency1／forceExit=false，不加Jest/Babel/Supertest。HTTP真fetch與ephemeralport，不直接controller代替入口；unit受限mock，integration/e2e/fault真Mongo且隔離／串行套件；被測並行HTTP在test內明確發起，不表示production多API。mockclock只本用例clock，不替driver／真transport。
- 固定Toxiproxyv2.12.0；第一toolgate從官方來源解析／保存exactimage digest後才能有效fault，不floating、不自行換版。D138/D139共同snapshot／proxy/barrier及無效判準保留，沒正確barrier／流量繞路／observer誤傷不算pass，production無failpoint。
- 未來命令：npm ci、npm run build、test:unit、test:integration、test:e2e、test:fault、test:perf、check:openapi、check:boundary、check:requirements、verify:clean-install（後者皆npm run）。命令尚不存在；CI同套D125pins，fault/perf明確optin，cleaninstall隔離乾淨副本不清workspace；requirements檢查測試名字存在不代表通過136條。
- 待測timeout每caseunit10s、integration/e2e60s、fault120s、perf300s；maintenance/reset另600s，不硬塞ordinarye2e60s。命令總unit60s、integration/e2e300s、fault900s、perf1800s，maintenance命令總P15明定。逾時令run失敗、不證rollback/取消／收束，cleanup不覆蓋原失敗；專屬程序/容器無法證收束不得重用環境，數字不宣稱最佳。
- 工程異端命中：真舊fault結果也不能套未測新commit。正式release需fault及全部必需證據，綁sourceCommit（受測程式cleancheckout）、code/lockfile/nonsecretconfig/image/fixture指紋、secret引用非secret值、環境、命令及exit。相關程式/依賴/設定變更令證據失效，缺證不得public完成或解鎖履歷；dirtyrun只本機暫時結果。
- 報告自指縮限已正式確認：reportpublicationrevision可不同，明示並核受測sourceCommit及指紋，不要求報告含其自身新commit才算已測。regularCIgreen≠完整交付，optin不免除交付必需驗收，不把測試數量或Source官方支持當工程成果。
- 仲裁：工具與證據規則可採，接線／兼容／真故障尚U；next唯一P15逐小gate範圍／證據／停止條件，然後136trace、文件同步及獨立audit，停在code前，不再展平台分支。独立工程／捍衛／仲裁只交换公開論點，code/install/DB/Docker/部署未動。


### D166｜正式 unit runner 改採 Jest，取代 D156 的 Node runner 選擇

- 日期：2026-09-19；使用者正式決策改採 Jest 作為 unit runner。D166 只取代 D156 的 runner 選擇，不改業務契約、25 STOP、真 HTTP／Mongo／fault／performance 的驗收邊界，也不把 Jest 選擇誤稱為已安裝或已驗證。
- 本階段不安裝 Jest、不改既有測試檔、不新增 Jest config 或 script。待本輪 source 開發完成且架構 code review 通過後，即可由獨立 tester 以正式 Jest runner 重寫／補足 unit tests，包含 G03a/G03b 的 runtime-corruption／runtime-input 情境；不需等待 G03c。Jest 尚未安裝，既有測試尚未改動。
- 證據失效範圍：凡以 D156 `node:test`／`node:assert` runner 執行結果作為工程證據的 G02 unit runner 部分、G03a 初始 domain 測試／coverage 報告及 G03b 初始 comparison 測試／coverage 報告，均暫不可用於 gate 通過或履歷解鎖。source／build 的獨立結果仍可作診斷背景，但不能替代 Jest 重驗；本次 runtime source 修正也使原 G03a/G03b source hash／報告需重新發行。
- 固定保留 D156 未被取代的規則：strict TypeScript、編譯後受測 source 綁定、clean source／code／lock／非秘密設定／image／fixture 指紋、timeout／isolation／concurrency 的工程要求，以及「測試全綠不等於136要求完成」。Jest 依賴、版本、轉換設定、命令及新證據在正式重驗前皆未定案，不提前修改 package 或宣稱 gate 完成。
- 仲裁：G03a/G03b 暫停，不解鎖 G03c；A01維持V，其餘135要求仍U。source 開發完成且架構 code review 通過後，獨立 tester 即可交 Jest 變更與可重跑 evidence，不以 G03c 完成作為前置；各 gate 仍逐關停止。


### D157｜固定25個逐責任STOP點，實作大包撤回後停在執行前

- 日期：2026-09-19；正式開場→單一工程異端→捍衛修正→仲裁；依D114持續授權預設接受P15，不捏造逐題個別答覆。此輪不實作。
- 公開開場：有限關卡，先契約封口／私密備份／工具，再原型／純規則／閉環／故障維護／完整交付；每關報證據停止。
- 工程異端命中：原G3b即使說「分別驗scope、FIFO、容量、期限、完整txn生命期」，仍可讓實作者一起加入後才fault，沒有逐責任基線。捍衛承認並撤回大原型，正式改下表固定25 STOP。子關也是停止點，不靠大關末尾驗收掩蓋中間未驗責任。

| Gate | 單一交付責任 | 代表驗證／artifact（皆未來） |
|---|---|---|
| G00 | 規劃文件同步及136 trace獨立audit | 文件diff／來源逐項覆核；此關只文件，不證工程 |
| G01a | 私密完整working tree備份及復原前置核對 | 私密inventory／hash／symlink依賴及另私密位置復原核對 |
| G01b | 經核准exact list的舊碼移出 | 清理前後exact清單、Git／docs保留；不擴scope |
| G02 | 鎖版package／編譯／測試工具基線 | npm ci／npm run build、D125pins、Toxiproxyv2.12.0 exact digest |
| G03a | 唯一純domain規則 | test:unit之domain情境／全部合法拒絕與首因 |
| G03b | 固定編碼／摘要與啟動向量 | test:unit之comparison／獨立literal向量／原值邊界 |
| G03c | 窄scope／handle／composition | check:boundary、unit scope；負compile／runtime wiring |
| G04a | Face反向unique替換微型阻塞 | 真Mongo8.0.32 integration face-index／同txn release-reuse、空槽、失敗回滾 |
| G04b | 完整原子保存adapter | 真Mongo integration atomic／共同snapshot、成功與拒絕新鮮度 |
| G05a | FIFO操作權協調器 | PASS：exact Node image、unit 21／慢前項不超車、settlement／owner／fail-closed boundary |
| G05b | 執行／確認共同預算 | PASS：exact Node image、unit 80／15秒3輪、10秒7格、native兩送、continuation、capability fail-closed |
| G05c | registry／epoch／晚callback fence primitive | PASS：exact Node image、unit 51；artifact join／conflict、4096 retention、canonical／safe terminal、generation／late callback、epoch／read-only claim |
| G06a | 人員認證能力 | PASS：exact Node／Mongo、unit 88／Mongo integration 5；strict JWT／scrypt／目前角色enabled／opaque principal／primary-majority read-only reader |
| G06b | Source認證／安全facts | integration source-auth／alias不可信及窄接線 |
| G07a | bounded raw／JSON前置入口 | 真HTTP e2e ingress／嚴格UTF8、BOM、深度／重複鍵與headers |
| G07b | 同步准入與HTTP等待生命期 | e2e admission／分池／existing-only／順位／一次回覆 |
| G08a | 管理用例及完整保存 | e2e management／建立修改撤銷、QR一次、Face容量 |
| G08b | 完整辨識處理鏈 | e2e recognition／QR Face UNKNOWN、拒絕Event、回放／conflict／並行 |
| G09a | 安全查詢／keyset | e2e query／detail、無資格Event、AND篩選及epoch cursor |
| G09b | 分case查詢效能 | test:perf／固定fixture／八filters、索引前後raw與explain |
| G10a | allowlist日志／私密控制屏障 | integration private-control／有限buffer／rotation、hold release drain許可 |
| G10b | precommit終止／abort完整清理 | 真fault termination／112 11000歸屬、最多兩送、endSession無額外送 |
| G10c | 真傳輸未知確認 | 真fault transport-unknown／precommit未知及commit後回程loss、coherent observer |
| G11 | 部署／reset生命期 | test:maintenance／唯一writer隔離、恢復、精確target、bootstrap ready、失敗off及普通restart |
| G12 | 完整交付證據audit | 全必需套件、OpenAPI／boundary／requirements／cleaninstall、CI／Demo／publicHTTPS及136證據 |

- 執行依表順序、依賴前关通過；G04a先於任何依賴Face替換的功能，未過必回討論，不靜默drop unique／換guard策略。G11只部署reset生命週期，不夾新業務。G12是既有責任的完整交付audit，不作新架構平台。
- 每子關交差異、來源D／要求ID、實際命令與exit、情境／資料像、環境／指紋及獨立覆核後STOP；任何失敗／無效fault／缺證即停，保留最後通過基線但不自動還原用户文件或fallback。D114持續授權僅本輪討論，不擴為未來不停實作。
- 命令dictionary依D156：npm ci、npm run build，以及npm run test:unit／test:integration／test:e2e／test:fault／test:perf／test:maintenance／check:openapi／check:boundary／check:requirements／verify:clean-install。表中情境標籤是未來runner selector，script必實際正確傳入，不假稱目前可跑。maintenance每case600s、總1800s；其他D156期限保留，逾時不證回滾／隔離，cleanup不能蓋原失敗。
- 證據位置：逐關採去敏artifact，正式sourceCommit／code／lock／nonsecretconfig／image／fixture及環境綁定依D156，報告publicationrevision可異以避免自指；完整必需fault／perf／維護缺證不能被CI green代替。具體帳本整理於實作方案，原token／keys／私密inventory不可公開。
- 知識基礎：K2 D114–D156有效採用、K3之136要求及本輪小步驗證推論；角色獨立準備只交換上述公開論點，沒有交換私有思考。官方讀證支持前提，不支持工程完成。
- 仲裁：原大包攻擊已於規劃層回應，可採25STOP；selector、tools、真工程皆U。唯一收尾：必要business／matrix／implementation-plan文件同步→136 trace獨立audit→修正具體遺漏並驗證→報告停在實作前。不開更多研究／架構分支。
- 文件輸出預覽／範圍：依D114已授權可交實作者的規劃文件，在既有docs新增implementation-plan.md，彙整有效契約／固定gates／命令／證據／風險／handoff；不覆寫同名檔或建缺目錄。business-scope與requirements-traceability同步當前採用；討論歷史不回寫、136工程證據全U，README／code／resume／設定不動。


### D158｜有效規劃同步與136逐列gate落點，獨立覆核前不冒稱封口

- 日期：2026-09-19；依D114必要文件同步授權，按D157有限收尾。這是有效決策的文件編譯／驗證紀錄，不捏造新自動攻防或個別使用者接受。
- 先列範圍後按小段更新business-scope：認證／比較／Face只管理allocate；故障／七格與原生跨窗例外／四資源分池；查詢／部署／API與Mongo確停再恢復清理；作品證據／當前規劃去向。先前D01–D99的業務模型／排除／首因與QR一次性保留，修正已過時「尚待第二階段」而非擴業務。
- requirements-traceability保留136 unique ID及所有U，P01–P15改成採用來源與固定阻塞gate；新增D100–D157逐段細化及136逐列gate索引，子情境同須map實際測試＋結果，不只名字存在。第8/9節與舊SHA保留歷史，未改成新假基線。
- 新增既有docs內implementation-plan.md（建前確認同名不存在、docs存在），含skill知識frontmatter／七必要章節、有效契約／來源／25STOP／命令／期限／artifact與風險／handoff。settled只指已採規劃；尚未獨立audit，工程全部U。僅對新文作機械繁體字校整，未改契約。
- 分段readonly驗證：business七格／native例外／普通28+retry4／origin-validation-HTTP-registry／sameEpoch關寫／Mongo停止恢復及精確DB／漏排不白天補／bootstrap-ready區分；matrix136要求136U136unique、136gate落點無漏／無extra、P01–15完整／columns一致；plan25uniqueSTOP／frontmatter及必需章節／fence成對。
- 同步前歷史基線：business SHA256=fafa9e13844c0945c5eb145ae0981da1e178f6f89efe1c21be6711e06b444d2b；matrix SHA256=5b354e2af5973cea1d8aa764f89d1c5613aec721ab5e011c9f8a084b39a078fb。本輪sync後diff以檔案現值與本紀錄核對，不聲稱歷史SHA仍相等。
- 下一唯一工作：三個獨立只讀覆核分業務／排除、原項／交易／故障維護、136追蹤／gate／交付，直接讀來源D与三份同步文件，不以root摘要代證；指出具體遺漏就逐項修正保存驗證。不開新研究／架構分支，通過文件覆核後停止在實作前。
- code／README／履歷／package／設定未改；沒有install、備份搬刪、DB測試清除、Docker啟動／重啟或部署。文字／結構檢查不等工程實測，所有要求仍U。


### D159｜獨立audit最小補正，完整結果與放後項共用安全前提

- 日期：2026-09-19；三個獨立agent直接讀指定原D與business／matrix／plan，分業務排除、原項交易維護、136trace工具關卡，各只交公開結果、不互讀私有準備。依D114預設接受具體同步補正，不開新架構／研究。
- audit未發現業務擴張／原B或X要求丟失／候選偷採／工程綠燈假報；已核136unique/U／gate落點／P15與25STOP、G04a與tooldigest前置、clean sourceCommit及失效、完整release必需faultperfmaintenance、私密與環境前提。這是限定文件覆核，不是無其他缺陷保證或工程驗證。
- 交易覆核命中plan放權句：canonical或無效果出口措辭可能讓no-late只套後者。已補**两種结果都另須舊工作不影響／scope封閉／無晚寫、currentowner／同程序資料期／服務及manual-maintenance許可**才放後項；canonical先回放不等放權。原D132／D136要求保留，非新增政策。
- seed句拆明：只seed穩定假體驗credential、新epoch/nullclaim／向量；部署keys外部管理、不換，不入seed/DB。原D155前提不丟。
- matrix有效B46補D152三filtersAND、M08補D155 drain≤30s、M09補僅passhub_demo六collection deleteMany保indexes／seed不全庫原子、E04補固定10k/40k八case／證據正確完整門檻不預設改善。所有原ID仍U。
- 舊version去向改「當時僅例子、後D142–145已採incarnation/version真guard」，持久pending仍不採；§5明示D99/P未定是歷史，§6/10當前取代。§7當前停止點改規劃已採／文件audit／U136／未來G01a，不再說API/schema未定。
- business故障驗收單送節奏明確排除native兩送組，引用§7.5預扣兩格／跨窗／組內間隔例外。business hook旧待定改D146–149已規劃待真驗；planG00及handoff改audit尚在補正，不提前完成。
- 討論front quickcard／lateststate改D158覆核中，不改D1–158正文；historyhash核對不變。同步分小段的查驗確認sharedReleasePreconditions、外管keys、abort例外、25gates、136U/unique／欄位與fence；下一只請原覆核者直接核最小補正，再最终封口。
- 工程仍全U；没有程式／README／履歷／設定／install／備份／DB／Docker／部署變更。


### D160｜P01–P15規劃封口，限定文件覆核完成並止於實作前

- 日期：2026-09-19；依D114授權終點与D157固定收尾，完成討論→逐題保存驗證→必要同步→獨立audit→具體補正重核。不是授權進工程階段。
- 三個獨立公開回執：業務／排除覆核者直接重讀D159六項同步補正，確認AND／維護targets／perf門檻／version歷史／G00交接已回應；交易／原項覆核者確認兩種结果放權共用no-late/owner/service/veto、seed外管keys及native例外等六項已回應；136追蹤覆核者直接核B46/M08/M09/E04四處及136unique/136U/136gate落點、25STOP。各本次限定範圍未見具體殘留，不宣告無其他缺陷，不交換私有思考。
- 當前採用摘要：單次Qualification／Presence非真人；QR與模擬Face獨立替代；Nest預設Express strictTS／官方driver單API；窄能力与唯一純政策、完整原子保存＋真guard；入口同步時間／FIFO／有限資源，HTTP不cancel原項；確認10秒7格/native兩送預扣跨窗例外／15秒3輪；複合安全判據及未知停寫、D89安全续辦。D130永久終局候選不採。
- 同epoch ordinary restart關寫、registry4096不白天忘ID；私密host控制與daily03Taipei外部lock/marker、確停API及Mongo／journal恢復／精確六collection清理seed／bootstrap-ready分開／failclosed；sourceCommit與報告revision分開、完整交付必需fault/perf/維護。這些是已採規劃，不是工程成果。
- 確定實作者入口：implementation-plan.md有效契約／25STOP／命令dictionary／期限／證據與風險／handoff；requirements-traceability保136ID及新增細化與逐列gate、P01–15；business-scope有效業務。討論front最新state與settled已同步，歷史block正文不改。
- 最終readonly驗證目標與回執：136要求ID／136U／136unique／136gate索引無漏extra、P01–15／25STOP完整、來源D1–160連續／fence成對、必要knowledge frontmatter/章節、相對Markdown links實際存在。最初D1–113正文按preD114的length147853/hash e373885073806a1e3d84d92c0ef398acae6c13271e9bafdeae562ef3f92a90e1核相等；D1–159歷史prefix同样保存。這是文檔檢查，不能算DB／HTTP／Docker工程測試。
- 封口三份同步文件SHA256（不含本紀錄自身，避免自指）：business=ae724e8d75e2e4880e1617342d6e817bb7b46f76fba85e35f7e5899ed6e6ea81；matrix=c57a09c5e9daca9c2d044f363e981cc49da0e40194662f5b63561d0e5b5256d6；implementation-plan=c71365a88a111067e50cc691fe9d7d0dd9e79103b465c4008e501b7c58fa520f。後續若修改，依新差異及採用來源重核，不把本历史hash偷換現值。
- 剩餘指定風險：G02乾淨pins兼容／Toxiproxyv2.12.0exactdigest；G04a真Mongounique同txn release-reuse，先於依賴功能、未過回討論不撤索引；G01a外部未知symlink依賴停exact清理；host/domain/TLS外部前提。這些是固定阻塞gate／環境提供，不留自由架構選擇，也不冒稱已驗。
- **本輪終點已達：規劃及限定文檔覆核完成，所有136工程證據仍U，停止在實作之前。**未來另獲實作授權只先G01a私密備份／復原前置檢查，報驗證後STOP；不得從D114推演不停實作或擴大外部讀取／備份範圍。G01bexact清理獨立stop。
- 本輪僅Markdown四份：discuss、business-scope、requirements-traceability更新／新增implementation-plan。沒有改code／README／履歷／package／設定，沒有install／備份copy／移動刪除／DB清除或測試／Docker啟動重啟／外部部署／Gitmutation。履歷成果未解鎖，不使用作品完成的假設投遞。


### D161｜取消額外舊碼備份，直接移出backend／frontend並保留規格與Git

- 日期：2026-09-19；使用者明確表示直接清空舊code、保留討論文件、不額外備份。此新決定取代D36／D140／D157中「先私密完整備份再移出」的未執行方案；不回寫舊歷史。
- 執行前唯讀精確盤點：PassHub root有backend約78MB、frontend約152MB、docs、.git、.gitignore、readme.md；兩舊碼目錄合計13405個一般檔案，所列symlink皆node_modules內部相對連結，未發現指向專案外的連結。
- 精確清除目標只有/home/sean/PassHub/backend及frontend；docs、.git、.gitignore、readme.md排除。為避免不可逆誤刪，使用系統gio trash移出，沒有建立PassHub-legacy-backups或其他專案備份，沒有follow連結或改Git歷史。
- 移後證據：backend=false、frontend=false；docs=true且保留business-scope.md、discuss.md、implementation-plan.md、requirements-traceability.md；.git/.gitignore/readme.md均存在。垃圾桶info記原路徑及DeletionDate=2026-09-19T15:01:55；對應files/backend與files/frontend存在。
- 可復原邊界：目前系統垃圾桶路徑/home/sean/.local/share/Trash/files/backend與frontend，metadata在Trash/info同名.trashinfo；這是桌面垃圾桶的安全刪除機制，不是額外專案備份。未永久清空垃圾桶，也未觸碰其他垃圾桶項目。
- 規劃同步：G01a改為精確盤點／接受無額外備份，G01b改為移出及保留項核對，兩者完成；A01更新V，其餘135要求U。D140的one-root-package骨架仍有效，只有備份策略失效。下一關為G02鎖版package／編譯／測試工具基線，尚未執行。
- 未執行：沒有建立新code／README.md／package或設定，沒有install、DB/Docker/服務、遠端部署、Git add/commit/push或履歷修改。


### D162｜ENTRY 與 EXIT 的模擬裝置傳輸拆成兩個獨立 client 模組

- 日期：2026-09-19；狀態：使用者明確接受目前架構說明，並新增實作約束；本輪只保存決策，不開始G02。
- 使用者要求：實作模擬裝置傳輸訊息時，入口與出口各自成為獨立模組，而不是由同一個可任意切換方向的裝置模擬器承擔。
- 採用解釋：ENTRY client 固定使用預置ENTRY Source身分；EXIT client固定使用預置EXIT Source身分。兩者都可送QR或模擬Face結果，但不能由payload／執行參數交換方向或機器身分。
- 邊界：這兩個是位於PassHub信任邊界外側的Demo client模組，不是把後端Recognition規則複製成兩套。兩者可以共用不含業務判斷的HTTP、序列化及顯示工具；資格映射、Presence、首因與reason code仍只有後端Access唯一規則來源。
- 驗收：以兩個真實client入口分別跑QR ENTRY與Face EXIT；接線／import檢查證明client沒有引入後端domain裁決，後端仍從已驗證Source資料取得固定方向。反向媒介情境由測試覆蓋，不新增影像、門鎖或硬體功能。
- 追蹤：B51補入D162及兩個client驗收；implementation-plan未來骨架新增`src/demo-devices/entry/`、`src/demo-devices/exit/`。要求總數仍為136，B51仍U，待G08b及G12真實證據。
- 停止點：沒有建立上述目錄或任何code，沒有install、DB、Docker、服務或Git mutation；下一關仍是G02。


### D163｜G02鎖版package、strict編譯與原生測試工具基線通過

- 日期：2026-09-19；狀態：使用者授權執行下一步，依D157只完成G02後停止，未進G03a。
- 建立單一root npm package及lockfile，沒有workspace；Node 24.21.0、TypeScript 5.9.3、Nest 12.0.3、Express 5.2.1、JWT、Swagger、Mongo driver 7.6.0等15個直接套件皆精確鎖版。`reflect-metadata`、`rxjs`及Node／Express型別使用相容精確版本，不以range漂移。
- 編譯採CommonJS、module Node20、target ES2023、strict、legacy decorators／metadata；測試採編譯後Node 24.21原生node:test／node:assert、process預設隔離、concurrency1、case timeout10秒，沒有Jest／Babel／Supertest。
- 主機Node為24.12.0，不拿它冒充基線。實際在精確Node linux/amd64映像`sha256:2fe369...d553`內驗證runtime v24.21.0／npm11.19.0，執行package-lock-only、npm ci、build、test:unit及npm ls均exit0；smoke為1 pass／0 fail，僅證依賴可由編譯CommonJS載入。
- Shopify官方GHCR解析Toxiproxy 2.12.0 index digest `sha256:9378ed...a214e`及linux/amd64子映像`sha256:a3e244...fef8`；精確子映像實跑回報`toxiproxy-server version 2.12.0`。這不證fault接線有效，後者仍留G10。
- `infra/toolchain-images.json`保存Node、Mongo、NGINX與Toxiproxy精確映像；`.npmrc`強制engine及save-exact；`.nvmrc`固定24.21.0。`src/composition/toolchain-smoke.ts`與一個unit test只屬工具鏈證據，不含API、domain或業務規則。
- 公開證據為`docs/evidence/g02/report.md`，含真命令結果、限制及檔案SHA。repository尚無首次commit，故本關誠實記錄working-tree指紋，不假稱clean sourceCommit；正式commit綁定仍由G12阻擋。
- 追蹤判定：G02通過；A02仍U，因模組化單體及實際接線尚未完成。A01維持V，其餘135要求仍U；無履歷解鎖。
- 下一停止點：只有G03a唯一純domain規則，尚未開始。沒有MongoDB連線／交易、HTTP API、Docker Compose、裝置client、部署或Git add／commit／push。


### D164｜G03a唯一純domain規則與固定首因通過

- 日期：2026-09-19；狀態：使用者表示前關沒問題即可執行下一步，依D157只完成G03a後停止，未進G03b。
- 新增`src/access/domain/qualification.ts`、`access-decision.ts`及唯一index出口。全部為同步純函式／型別，禁止Nest、Express、MongoDB、Node I/O及repository依賴；掃描3檔0違規。
- 資格政策：核對合法狀態組合、時間窗、修改／撤銷凍結、原因必填、QR保留effect、惰性逾期、Face有效投影與釋放。NOT_ENTERED自然逾期不再視為有效Face，INSIDE即使逾期仍保留到EXIT。
- 通行政策：依D32精確實作ENTRY／EXIT首因，輸出單一ACCEPTED／REJECTED＋reason、Presence transition、資格終結及Face effect。EXIT成功與自然逾期不要求呼叫者另記得釋放；拒絕不帶Presence transition。
- 損壞狀態不降級為一般業務拒絕：非法時間、撤銷／終結並存、Presence與時間戳矛盾拋`DomainInvariantError`，後續用例必須當技術阻擋。沒有加入`exitedAt>=enteredAt`的未採牆鐘假設。
- 驗證：精確Node24.21映像中build exit0、test:unit 13pass/0fail（12 domain＋1 toolchain）；domain限定coverage line95.24%、branch93.48%、functions100%。coverage只作分支觀察，不當需求完成率。
- 需求部分證據：B03、B15–B20、B29–B32、A17補D164與G03a已驗範圍，但仍為U，因HTTP／FIFO／mapping解析／共同保存／DB與Event一致性尚未驗。A01維持V，其餘135U，履歷不解鎖。
- 證據：`docs/evidence/g03a/report.md`保存實際命令、限制及檔案SHA；lockfile SHA與G02相同，沒有新增依賴。repository仍無首次commit，不冒稱clean sourceCommit。
- 下一停止點：只有G03b固定編碼／摘要與啟動向量，尚未開始。沒有Nest module/controller、MongoDB、Docker Compose、裝置client、部署或Git mutation。


### D165｜G03b固定比較表示、摘要能力與獨立向量通過

- 日期：2026-09-19；狀態：使用者表示前關沒問題即可進下一步，依D157只完成G03b後停止，未進G03c。
- 新增`src/access/application/comparison/`五個檔案。D117 JSON v2以dense primitive array、`JSON.stringify`與UTF-8實作；QR／provider／subject長度取原值UTF-8 bytes，不trim、case-fold或normalize。Source ID／external event ID仍是外部冪等鍵，不進frame。
- D119邊界固定：辨識QR 1–128 base64url alphabet、provider固定grammar、event ID固定grammar、subject 1 code point／最多256 UTF-8 bytes；拒絕unpaired surrogate、C0/C1、U+2028/U+2029，其他空白保留。QR發行為32 random bytes的43-char unpadded base64url。
- QR lookup依D145使用`SHA256("PassHub/qr-lookup/v1" + NUL + originalToken)`，和冪等HMAC分開。比較artifact只公開64位小寫HMAC及reference ID；比對先核reference，再將hex解成32-byte Buffer作`timingSafeEqual`。
- startup verifier只接受QR=`A`、MATCHED=`DemoFace`／`中😀`、UNKNOWN三組且各一次；逐一對照獨立literal frame hex與known HMAC。錯key、錯frame、缺失、重複或意外向量fail closed；通過後複製key並建立frozen唯一能力，caller不能在`create`提供digest/reference。
- 測試fixture的frame及HMAC以shell byte tools／OpenSSL獨立算出後硬編碼，module initialization不呼叫production codec自證。精確Node24.21.0／npm11.19.0映像中全套22 pass／0 fail；comparison專屬9 pass，line96.18%、branch91.57%、functions90.91%。lockfile未變。
- 首輪測試曾把Tab誤列為允許空白，實作依契約正確拒絕而令測試失敗；修正案例為允許U+00A0並把Tab列入拒絕後重跑全綠。這是測試修正，不是放寬validator。
- 限制：本關沒有MongoDB metadata／現有資料missing-mixed掃描、Source＋eventID registry、Event保存、回放或HTTP／log表面；frame1024 guard在目前更窄欄位上限下不可達，只作版本演進防線。故B09、B33–B36、B50仍U，不以局部codec證據冒稱冪等完成。
- 證據：`docs/evidence/g03b/report.md`保存命令、精確向量、已測邊界、限制及檔案SHA。repository仍無首次commit，不冒稱clean sourceCommit。
- 下一停止點：只有G03c窄scope／handle／composition，尚未開始。沒有Nest controller、MongoDB、Docker Compose、ENTRY／EXIT client、部署或Git mutation。


### D167｜Jest unit runner重驗G02/G03a/G03b並停止於G03b

- 日期：2026-09-19；狀態：依D166授權由獨立測試工程師執行 Jest 重驗；完成 G02、G03a、G03b 後停止，不開始 G03c、HTTP 或 Mongo。
- runner決策：採編譯後 JavaScript 執行 Jest 30.5.2，`@types/jest` 30.0.0 精確鎖版；`jest.config.cjs` 固定 `maxWorkers=1`、`detectOpenHandles=true`、`forceExit=false`、case timeout 10 秒。因 Nest 12 ESM 與 CommonJS 編譯輸出共存，script 明示 `NODE_OPTIONS=--experimental-vm-modules`；沒有包裝舊 `node:test` runner。
- 測試改寫：toolchain 1、domain access 5、domain qualification 9、comparison codec 6、comparison digest 5，共 5 suites／26 tests；移除正式測試對 `node:test`／`node:assert` 的依賴。既有業務案例、獨立 literal vectors、QR 邊界與 UTF-8／Unicode 邊界均保留。
- runtime反例：新增未知 `presence`、非 string `revocationReason`、未知 direction／resolution、非 boolean `sourceActive`；非 string QR/provider/subject、null／未知 recognition kind；startup null/string config、string/empty key、null/nonarray vectors、null vector 與錯型欄位，均驗證正確自訂 error。
- 精確環境證據：`node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553` 內 `npm ci --ignore-scripts`、`npm run build`、`npm run test:unit`、`npm run test:coverage` 均 exit 0；coverage statements 94.13%、branches 92.67%、functions 94.23%、lines 94.03%。本機 Node v24.12.0／npm 11.6.2 僅作輔助重跑，不冒稱 pin 環境。
- 依賴與指紋：17 個直接 dependency／devDependency 均精確鎖版；`package.json` SHA-256 `a97de05fbb8d8cb378eea68abb65a3905fc1bf392c456ecfa5b2499f4dbafa89`、`package-lock.json` SHA-256 `70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b`、`jest.config.cjs` SHA-256 `91a214d158039a446df507e74a4afb7a18ebb813496fea29a5833f9baa086bec`。repository尚無首次 commit，因此只保存 working-tree SHA，不冒稱 clean sourceCommit。
- Gate判定：G02 PASS（工具鏈／clean install／build／Jest）；G03a PASS（純 domain unit）；G03b PASS（固定 comparison unit）。A01維持 V，其餘135要求仍 U；G03c不得開始。純 unit 證據不延伸為模組接線、HTTP、MongoDB、Event保存、冪等回放、故障、部署或公開sandbox完成。


### D168｜G03c窄scope／opaque handle／composition限定證據通過並停止

- 日期：2026-09-20；狀態：依25 STOP完成G03c限定驗收並停止；下一合法關G04a尚未開始。A01維持V，其餘135項維持U，完整v1未完成。
- 架構多輪review已收斂本關邊界：management／recognition／query窄能力與不同wrapper；opaque handle以scope／epoch／owner／generation／media及qualification／mapping version＋incarnation封存；stage前重新核新鮮度並對stale／closed fail-closed；FACE_MATCHED缺mapping或qualification／incarnation不一致不作RESOLVED；QR可無mapping；inactive source先回SOURCE_INACTIVE且後續stage仍可記拒絕；plan provenance由可信internal domain decision產生；SourceCredentialVerificationPort移出Access，query為redacted projection，production不直引raw comparison barrel；每個operation獨立owner／generation並可retire。
- 實際局部證據：Jest 6 suites／37 tests；boundary selected=18、edges=40、forbidden=0；negative compile真正消耗public-surface反例；runtime wiring、dist declaration與package resolution確認consumer只能取得composeAccess／createAccessComposition及ManageQualifications、RecognizeAttempt、ReadAccessData三個窄能力，raw scope／handle／plan／comparison subpath回ERR_PACKAGE_PATH_NOT_EXPORTED。
- 證據限制：測試使用 fake narrow ports；本關不聲稱Mongo transaction、HTTP contract、Nest controller、Auth／Sources runtime integration、完整DB／Event／冪等／fault／maintenance或G04 correctness。Boundary數字與37 tests不是136要求完成率。
- 契約留項：`ManageQualifications.create` 的 `Promise<void>` 是G08a前需收斂的輸出契約；G03c不猜QR DTO。D156 formal clean `sourceCommit`屬G12 release規則，本關只保存working-tree SHA／檔案指紋，不冒稱clean commit；後續任何G12正式證據須綁clean checkout。
- 停止與交接：G03c report保存命令、37 tests、boundary／negative compile／public surface及working-tree指紋；不開始G04a，不進HTTP／Mongo或G04外擴，待下一合法gate另行授權與驗證。


### D169｜G04a Face reverse-unique 真Mongo8.0.32限定gate通過並停止

- 日期：2026-09-20；狀態：依25 STOP完成G04a窄實驗，通過後停止於G04a；G04b尚未開始。A01維持V，其餘135項維持U，完整v1未完成。本段只保存限定真Mongo證據，不把實驗骨架冒稱完整adapter。
- 實際局部證據：既有 Jest unit 37 tests 綠燈；G04a 真 MongoDB `8.0.32` integration 9 cases 通過。compose 使用 exact `mongo:8.0.32-noble` digest，單節點 `rs0` readiness 驗 `setName=rs0`、`isWritablePrimary=true`、advertised hosts 恰一且與 URI host 一致；測後 compose container／network 已清理。
- index／shape：`faceSlots` 保留 simple `(provider, subject)` unique 與 `qualificationId` `$type:string` partial unique。validator 仍保留既有 required／scalar 欄位，另以明確 pairing 條件限制 `qualificationId`／`qualificationIncarnation` 只能雙 null 或雙 string；兩種半綁定真 Mongo 均回 `code=121`，合法雙 null／雙 string 可保存。這只是 G04a shape gate，不是六 collection 完整 schema。
- 真交易情境：同交易 release-first 清舊 qualification reference 後重用新槽成功；writer session 內讀可見未提交變更，另一 client/session 的 majority observer 在 commit 前只見舊狀態，commit 後 majority read 見新狀態；reverse bind-first 由 qualification reverse unique 形成 `E11000` 並保持無部分寫入；`provider+subject` duplicate 另行分類；注入失敗 rollback 無部分保存。
- 並行／錯誤分類：兩 session 先過 barrier 再競爭同 subject，成功者一個，另一項依真 server 結果分類為 `code=112 + TransientTransactionError`；`code=251`／abort 與 `UnknownTransactionCommitResult` 保留不同分類及 stage，不把 112／251 當 duplicate，也不把 unknown commit 當 rollback。所有 writer operation 同 session 且順序 `await`，observer API 明確 majority read concern。
- 證據限制：只驗 faceSlots index／shape／release-reuse visibility／duplicate／rollback／parallel transaction error classification；不驗 G04b 完整 atomic adapter、qualifications／events／users／sources／metadata 接線、完整冪等／新鮮度、HTTP／Nest、FIFO、fault、maintenance、deployment 或 public sandbox。G04a 不解鎖任何完整 v1 claim。
- 停止與交接：G04a report 保存窄命令、unit37／integration9、Mongo version／readiness、shape code121、visibility、E11000、rollback、parallel112／251 classification 與清理限制；架構／tester 後續若開始 G04b，須另開 gate、另建 evidence。不得因本關通過而撤索引、換 guard 或跨入完整保存實作。


### D170｜G04b 完整原子保存 adapter 真Mongo限定gate通過並停止

- 日期：2026-09-20；狀態：架構 review PASS、independent tester formal 57/57 PASS；PM獨立重跑並核對 code／tests／docs 後，G04b限定 gate PASS，依25 STOP停止於G04b。A01、A11–A16、B13、B41、B42共10項為V（G04b直接新增9項），其餘126項維持U；完整v1未完成。
- 證據：`npm run test:g04b` 真MongoDB `8.0.32` `rs0`為1 suite／57 tests；`npm run test:g04a`為1 suite／9 tests；`npm run test:unit`為6 suites／37 tests；合計8 suites／103。`npm run test:boundary`為`selected=21 edges=55 forbidden=0 directRawComparison=0`；negative compile、build、`git diff --check`均exit0。G04a fixtures已改合法UUID。Mongo exact image為`mongo:8.0.32-noble@sha256:01354084d2ae665d2e79b79b0cdc50c2c0c98873618912d9a2c8c9cb5c3d24e6`，compose測後teardown。
- 交付契約：六 collection schema／validator／unique index／bootstrap與既有資料fail-closed integrity（legacy Event、face-slot orphan／incarnation、slotCount、Event source-direction）；accepted及rejected共用session／transaction保存Presence、mapping、Event；source／qualification／mapping／QR／Face freshness guard；QR／Face精確解析與D117 comparison artifact；`FACE_UNKNOWN`與`FACE_SUBJECT_NOT_MAPPED`分流；source+externalEventId unique、same-artifact replay、different-artifact conflict；一次canonical snapshot redacted projection；duplicate／112／251／schema validation／unknown commit typed分類。
- 修正歷程：canonical replay改為先查既有Event再檢查目前source freshness，故current source／mapping／qualification變動不會重判已保存結果；補強UUID validators；startup補既有integrity scan且不修復；新增13 formal regressions；G04a fixture改合法UUID。
- 同ID精確裁定：同一`source + externalEventId + comparison artifact`首次真正並行請求，G04b僅保證最多一筆`COMMITTED`；另一筆可因112／未知提交結果回typed `WRITE_CONFLICT`、`UNKNOWN_COMMIT_RESULT`或`UNKNOWN/UNCONFIRMED`。winner尚未可見時，一次canonical lookup為null是合法未知，不要求兩Promise立即resolve或立即收斂；winner commit可見後再次同ID／同artifact必須`REPLAYED`。retry loop、budget、immediate convergence、跨scope重判屬G05/G08b/G10。不同externalEventId並行ENTRY也不由G04b自動新scope重判／產生`ALREADY_INSIDE`，由後續G05 coordination／完整用例處理。
- 限制與交接：不宣稱G05 FIFO／registry／budget／immediate convergence；G08 HTTP／Nest／auth／e2e／capacity；G10真transport-loss／confirmation／abort protocol；亦不宣稱clean source commit或v1 release。下一合法 gate為G05a FIFO operation coordinator。


### D171｜G05a FIFO operation coordinator primitive gate通過並停止

- 日期：2026-09-20；狀態：架構 review PASS、independent tester formal 21/21 PASS；PM先核對契約／production coordinator，再在 exact Node image 獨立重跑，G05a primitive限定 gate PASS，依25 STOP停止於G05a。G05a不新增完整requirement V；A01、A11–A16、B13、B41、B42共10項為V（G04b新增9項），其餘126項維持U；完整v1未完成。
- 精確環境與命令：主機 Node v24.12.0／npm 11.6.2低於D125 pins，故使用 `node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`；`npm ci --ignore-scripts && npm run test:g05a && npm run test:unit && npm run test:boundary && npm run test:negative-compile` exit 0。結果為 G05a 1 suite／21 tests、unit 7 suites／58 tests、boundary `selected=23 edges=57 forbidden=0 directRawComparison=0`、negative compile exit 0，build隨各 script exit 0，`git diff --check` exit 0；423 packages、0 vulnerabilities。
- 交付契約：`src/access/application/internal/write-operation-coordinator.ts` 僅提供 management create/update/revoke及recognition四個channel；同步trusted clock／UUID operationId／單調bigint sequence登記，四channel共用FIFO，microtask才執行。context／owner frozen且可判斷stale；settlement僅 `PRESTART_REJECTED`、`BUSINESS_RESULT_PERSISTED`、`KNOWN_NO_EFFECT`、`UNKNOWN_EFFECT`。未知效果、executor throw/reject、無／重複／非法settlement均fail-closed並永久阻擋後項；已知無效果可前進。測試含同毫秒順序、慢前項、獨立bundle、clock failure、owner／context不可變、construction capture及窄boundary；沒有timeout／retry／resume／cancel／Promise.all。
- 來源與責任：D72–D78、D141、D146–D149只要求此種內部同步登記／FIFO權限／未知停止 primitive；G05a不接 use-case／Nest HTTP／Auth／Mongo，不實作 raw admission、同鍵registry／join、budget／七格／confirmation、epoch/capacity、或完整結果保存。production usecase目前仍直接管理scope；因此 L01–L04、A18、B15–B21、B37–B43及E06保持U，primitive只能作局部實作輸入，不能宣稱完整requirement V。
- 限制與交接：G05a不提供未知後續resume；上層後續 gate須維持未知停止，另證安全續辦／confirmation／registry。仍不宣稱G05b budget／七格／confirmation、G05c registry／epoch／capacity／join、G07 HTTP／Auth／e2e、G08 management／recognition／capacity，或G10真transport-loss／confirmation／abort protocol。下一合法 gate為G05b；本 evidence見 `docs/evidence/g05a/report.md`。


### D172｜G05b execution／confirmation budget ledger限定gate通過並停止

- 日期：2026-09-20；狀態：架構 review PASS、independent tester formal 80/80 PASS；PM先核對 pure ledger／production surface，再於指定 exact Node image 獨立重跑，G05b primitive限定 gate PASS，依25 STOP停止於G05b。G05a／G05b不新增完整requirement V；A01、A11–A16、B13、B41、B42共10項為V（G04b新增9項），其餘126項維持U；L14–L23仍U，完整v1未完成。
- 精確環境與命令：使用 `node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553` 執行 `npm ci --ignore-scripts`、`npm run test:g05b`、`npm run test:unit`、`npm run test:g05a`、`npm run test:boundary`、`npm run test:negative-compile`、`npm run build`；結果分別為 npm 423 packages／0 vulnerabilities、G05b 1 suite／80 tests、unit 8 suites／138 tests、G05a 1 suite／21 tests、boundary `selected=24 edges=58 forbidden=0 directRawComparison=0`、negative compile exit 0、build exit 0。另執行 `npm run test:coverage`：8 suites／138 tests，aggregate 48.98% statements／52.56% branches／45.69% functions／51.52% lines，G05b ledger 92.82%／91.02%／100%／98.58%。slim image無git，故image內diff check不可用；host唯讀 `git diff --check` PASS。
- 純 ledger契約：每原操作首次完整owner起算 execution 15秒／最多3輪，排隊不計，已准入最後輪可完成；confirmation由首次unknown或首次precommit cleanup較早者起算10秒／7 shared slots，single send每次扣一格、不退款、串行；cadence為立即original commit、1秒canonical、2秒original、其後每2秒交替。首次commit使用execution剩餘整數毫秒，canonical及確認commit遵守剩餘整毫秒／固定2000ms規則，禁止0ms。native precommit group只在window內且至少2格准入，預扣2格、不退款、獨占、最多兩送、共用2000ms，第二送可越確認window且無組內間隔。continuation僅接受synchronous opaque no-effect evidence，保留全部既有budget，不刷新。
- 安全與測試：trusted clock rollback／failure／overflow、owner failure、foreign／forged／double-used permit、reentry、construction mutation、重用evidence均永久freeze；ledger只輸出typed admission／denial／permit，不執行I/O。80 cases涵蓋四輪review與tester defect：construction capture、round/deadline、confirmation origin/cadence/slots、native two-send group、continuation、capability provenance及static forbidden boundary。
- 責任界線：G05b不做 Mongo driver send、commit／abort、canonical observer、transport-loss、no-late／safe-terminal判定；不做G05c registry／epoch／capacity／join／late callback，不做G07 HTTP/raw/admission，不做G08 Auth/use-case/Event/Presence wiring。L14–L23因此仍U；pure ledger只作局部證據，不升完整requirement V。G04a/G04b仍引用既有同working-tree host真Mongo evidence，未因本關重標。
- 限制與交接：native group的真 driver wire、unknown commit、abort結果、確認與安全放權須由G10b/G10c實測；G05c為下一合法 gate。不得宣稱G05b已完成driver send、transport fault、safe terminal、HTTP、use-case或完整confirmation protocol；本 evidence見 `docs/evidence/g05b/report.md`。


### D173｜G05c registry／epoch／晚callback fence primitive限定gate通過並停止

- 日期：2026-09-20；狀態：架構 review PASS、independent tester formal 51/51 PASS；PM先獨立核對D78–D91、D95–D99、D146–D149、business／plan／trace與production surface，再以 exact Node image 重跑 G05c 51、全 unit 189、G05a 21、G05b 80、build、boundary、negative compile、coverage及host diff check，均通過；依25 STOP停止於G05c，下一合法 gate 為G06a。
- 精確環境與指紋：`node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`；repo以read-only bind加container writable temporary workspace執行，未清除／chown host `dist`、`coverage`或`node_modules`。`npm ci --ignore-scripts`為423 packages／0 vulnerabilities；boundary `selected=25 edges=59 forbidden=0 directRawComparison=0`；negative public-surface compile exit0；coverage 9 suites／189 tests，aggregate 54.45% statements／56.55% branches／51.71% functions／57.04% lines，operation-registry為95.08%／91.97%／100%／96.50%；host `git diff --check` exit0。source／test SHA及完整命令見`docs/evidence/g05c/report.md`。
- 交付契約：G05c是process-local、internal-only registry primitive；opaque issuer發出frozen branded key／artifact／result／claim／lease／permit，WeakMap保存provenance。key為Source＋externalEventId；same trusted artifact join／canonical replay，different artifact typed `IDEMPOTENCY_CONFLICT`；`IN_FLIGHT`／`UNKNOWN`／`CANONICAL`／`SAFE_TECHNICAL_TERMINAL`保留原entry；初值4096，無TTL／日間eviction，滿格停止新原項但仍可join／回放。
- 晚callback與epoch：lease／permit封存datasetEpoch、processRunId、ownerId、generation；UNKNOWN只可由同步opaque evidence一次mint continuation permit，resume後升generation，foreign／forged／stale／double-used callback不能改狀態。canonical／safe terminal只回放opaque result reference，不重跑。artifact comparer、owner fence、continuation verifier只接受同步精確結果；throw、非boolean、thenable、re-entry或provenance損壞永久fail-closed。
- writeRunClaim界線：只接受issuer已發出的opaque `WRITABLE`／`READ_ONLY`／`STALE` claim；READ_ONLY／STALE禁止新寫入且lookup為`NOT_PROVEN`。不模擬Mongo metadata atomic claim、process takeover、full reset、新epoch或ordinary restart state machine；這些由G11／composition另證。
- 需求裁定：G05c不新增完整requirement V。A01、A11–A16、B13、B41、B42共10項V（G04b新增9項），其餘126項U；B33–B36、L05–L13、L20–L21、L28–L36逐項維持U。primitive不等於G05a／G05b／G05c composition、FIFO ingress、Mongo writeRunClaim、HTTP／capacity／use-case、G10 driver／transport-loss／confirmation或G11 maintenance/reset完成。
- 限制與交接：G05c不做G06 Auth、G07 HTTP/raw/admission/capacity、G08 use-case／Event／Presence wiring、G10真driver／unknown commit／abort／safe-terminal protocol或G11 reset；不宣稱HTTP／v1。正式 evidence見`docs/evidence/g05c/report.md`，下一合法 gate為G06a。


### D174｜G06a 人員認證 primitive 限定 gate 通過並停止

- 日期：2026-09-20；狀態：架構 review PASS、independent tester formal unit 88/88 PASS；PM 依 D61／D122／D150、business／plan／trace 與 `src/auth` contract 獨立核對，於 exact Node／Mongo image 重跑後，G06a primitive gate PASS，依25 STOP停止於G06a。G06a不新增完整 requirement V；A01、A11–A16、B13、B41、B42共10項為V（G04b新增9項），其餘126項維持U，完整v1未完成。
- 精確環境與命令：使用 `node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`，Mongo compose 使用 `mongo:8.0.32-noble@sha256:01354084d2ae665d2e79b79b0cdc50c2c0c98873618912d9a2c8c9cb5c3d24e6`；隔離 writable temporary workspace 內執行 `npm ci --ignore-scripts`、`npm run build`、`npm run test:g06a:unit`、`npm run test:g06a:integration`、`npm run test:unit`、`npm run test:g04a`、`npm run test:g04b`、`npm run test:boundary`、`npm run test:g06a:boundary`、兩個 negative compile、`npm run test:coverage`，均以最後一次單一、清理後 runner 結果為正式證據。結果為 G06a unit 1 suite／88、true Mongo 1 suite／5、full unit 10 suites／277、G04a 1 suite／9、G04b 1 suite／57；G03c boundary `selected=25 edges=59 forbidden=0 directRawComparison=0`、G06a boundary `files=12 edges=21 forbidden=0`、兩 negative compile／build／coverage／secret scan／host diff check 通過。coverage aggregate 56.86% statements／59.70% branches／53.62% functions／59.41% lines。一次重疊 compose runner 的無效 timeout 已 teardown，後續單一 runner 完整重跑通過，未列入正式計數；詳見 evidence。
- 交付契約：`createHumanAuth` 僅接受窄 account reader／password deriver／32-byte injected JWT key／clock，發出同 capability provenance 的 frozen opaque `HumanPrincipal`；login exact username/password 1–128 UTF-8 bytes、保留原值、generic invalid credentials 與 dummy scrypt；JWT 僅 HS256、exact `sub/iat/exp/iss/aud`、issuer `PassHub`、audience `human-api`、900秒 TTL、strict algorithm／issuer／audience／maxAge／UUID／時間關係；async scrypt 固定 N=131072、r=8、p=1、keyLength=64、maxmem=268435456，固定長度 `timingSafeEqual`；每次 verify reread current enabled／role，無 refresh／logout／register／password reset。Mongo reader 只做 users narrow `findOne`，`primary`＋`majority` read concern，無 write／transaction／retry。
- 安全與邊界：typed secret-free input／credentials／token／role／clock／configuration／dependency／reentrant／frozen errors；static boundary files=12／edges=21／forbidden=0，negative public-surface compile 消耗所有反例。JWT／scrypt／current role evidence 不等於 HTTP／route permission、Source auth、rate／capacity、deployment、timing-side-channel、use-case、Mongo write lifecycle 或完整 E06 test coverage。
- 需求裁定：B22–B28、A06–A07、M03、E06及其餘要求仍U；本關不把人員 auth primitive 升為完整 requirement V，不宣稱 Source alias.secret／active／direction、Operator／Viewer HTTP route、G05 composition、G07 HTTP、G08 use-case、G10 transport／confirmation／abort 或 G11 maintenance／deployment完成。
- 限制與交接：G06a不接 Source credential verification、Nest controller／Bearer route、raw/admission、FIFO／budget／registry composition、Access Event／Presence、rate／capacity、部署或公開 API。正式 evidence 見 `docs/evidence/g06a/report.md`；下一合法 gate 為 G06b Source authentication／security facts，本輪不開始 G06b。
