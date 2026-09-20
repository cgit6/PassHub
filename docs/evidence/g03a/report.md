# G03a｜唯一純 Domain 規則

驗證日期：2026-09-19（Asia/Taipei）  
執行基線：G02 鎖定的 linux/amd64 Node 24.21.0 image  
Git 狀態：repository 尚無首次 commit；保存 working-tree 指紋，不冒稱 clean sourceCommit。

## 審查狀態（2026-09-19）

runtime `presence`、`revocationReason` 及 access input 型別的防線已由 source 提供；本次以正式 Jest 重跑既有業務案例並新增 runtime-corruption 情境。G03a gate 通過本關 unit 範圍；不解鎖 G03c，也不把純函式證據延伸成 HTTP／FIFO／DB／Event 完成。

## 本關範圍

建立唯一的純 TypeScript 業務政策來源：

- Qualification 狀態不變量及 `NOT_ENTERED → INSIDE → EXITED`。
- 建立／修改時間窗及半開 ENTRY 區間 `[validFrom, validUntil)`。
- 修改、撤銷、自然逾期與 Face Mapping 保留／釋放規則。
- ENTRY／EXIT 固定首因順序、單一 outcome／reason 及完整狀態效果。
- 損壞的資格狀態形成技術 invariant error，不轉成一般通行拒絕。

本關不處理 NestJS、HTTP、DTO、Auth、冪等、MongoDB、共同保存、QR 產生／摘要、Face 唯一索引或並行協調。這些不能用純函式測試冒充完成。

## 實作邊界

- `src/access/domain/qualification.ts`：資格狀態、時間窗、管理資格、逾期及 Face 生命週期。
- `src/access/domain/access-decision.ts`：Source 狀態、映射結果、ENTRY／EXIT 固定優先序與完整 effects。
- `src/access/domain/index.ts`：唯一公開 domain 匯出入口。

辨識輸入必須先由外層取得可信 Source 與互斥的映射結果；domain 不查資料庫。純裁決回傳 `presenceTransition`、`qualificationEffect`、`faceMappingEffect`，避免呼叫端成功 EXIT 後忘記釋放 Face Mapping，或逾期後只拒絕但未要求終結。

## 實際驗證

| 驗證 | 結果 |
|---|---|
| `npm run build`（精確 Node image） | exit 0 |
| `npm run test:unit`（精確 Node image） | 26 pass、0 fail；其中 domain 14（access 5、qualification 9） |
| Jest coverage（全 unit suite） | 26 pass；domain statements/lines 92.08%、branches 93.07%、functions 100% |
| 禁止依賴掃描 | 3 個 domain 檔案；Nest／Express／MongoDB／Node I/O imports 0 |
| lockfile 指紋 | 與 G02 相同，表示本關沒有新增依賴 |

Coverage 只用來找未走分支，不作需求完成率；測試通過也不表示 Event 或狀態已能原子保存。

測試包含：

- 11 種拒絕 reason 與 2 種成功 reason。
- Source inactive、映射錯誤、撤銷、Presence、早到、逾期的固定首因。
- ENTRY 在 `validFrom` 相等時通過、在 `validUntil` 相等時過期。
- INSIDE 超過 `validUntil` 仍可 EXIT 並要求釋放 Face。
- QR 保留、入場後／離場後／撤銷後／逾期後不可修改。
- 撤銷理由必填，撤銷與惰性自然逾期都回傳 Face 釋放效果。
- `NOT_ENTERED` 自然逾期不再視為有效 Face 綁定；逾期 INSIDE 仍保留到 EXIT。
- 非法 timestamp／Presence／撤銷／終結欄位組合由 invariant 阻擋。
- runtime 未知 `presence`、非 string `revocationReason`、未知 direction／resolution、非 boolean `sourceActive` 由 `DomainInvariantError` 阻擋。

## 檔案指紋

| 檔案 | SHA-256 |
|---|---|
| `src/access/domain/access-decision.ts` | `2ea8eefb462c389ad90ed087ca71c883ad83df623c937bf7e353102e8ee8cac6` |
| `src/access/domain/qualification.ts` | `012d650eaf5870ce66f261213868e0468094bce9165b390eaf199adf66fe9371` |
| `src/access/domain/index.ts` | `5d9472d7dc683aa84a00dc62fbb9b021858341ca8824e96afa761ca622bb40aa` |
| `test/unit/domain-access-decision.test.ts` | `3d58a6f000be5eacae66e661874fb4498901caadba9d5614be2081e19ab3b7d1` |
| `test/unit/domain-qualification.test.ts` | `09c33a9ccc69fd0bba9fd082eef89026f98e35d3644a773fc949a91ba0956d82` |
| `package-lock.json` | `70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b` |

## Gate 判定

**G03a PASS（純 domain unit 範圍）**：精確 Node 24.21.0 image 內 Jest 14 個 domain tests 全綠，包含所有既有業務案例與 runtime corruption cases。相關 136 要求仍標 U，因 HTTP、資料模型、共同保存、並行及獨立覆核尚未完成；履歷成果不解鎖。
