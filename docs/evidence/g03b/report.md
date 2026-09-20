# G03b｜固定編碼、摘要與啟動向量

驗證日期：2026-09-19（Asia/Taipei）  
執行基線：linux/amd64 Node 24.21.0／npm 11.19.0 精確 digest image  
Git 狀態：repository 尚無首次 commit；保存 working-tree 指紋，不冒稱 clean sourceCommit。

## 審查狀態（2026-09-19）

recognition validator 對非 string 值及未知／null `kind`、frame codec 的 runtime 防線已由 source 提供；本次以正式 Jest 重跑既有 comparison 案例並新增 runtime-input 與 startup config corruption 情境。G03b gate 通過本關 unit 範圍；不接續 G03c，也不把比較契約證據延伸成 registry／保存／回放／HTTP 完成。

## 本關範圍

建立辨識比較資料的單一固定表示與比較能力：

- D117 JSON v2 frame，長度使用原字串 UTF-8 bytes。
- D119 QR、provider、external event ID 與 subject 邊界；不 trim、case-fold 或 normalize。
- HMAC-SHA256 比較摘要及 `comparisonReferenceId` 共同產物。
- 三個獨立 literal startup vectors；frame 或 key 不相容即 fail closed。
- QR lookup 使用獨立 domain-separated SHA-256；QR 發行使用 32 random bytes／unpadded base64url。

本關不建立 Source＋external event ID 的持久冪等索引，不掃描 MongoDB 現存資料、不保存 Event，也不接 HTTP／Nest 啟動。missing／mixed reference 的資料集掃描與 capability 產物保存仍屬後續 G03c／G04b；不能用本關單測宣稱完整回放成立。

## 實作邊界

- `recognition-input.ts`：精確識別值 validator 及 technical input error。
- `frame-codec.ts`：dense primitive array → `JSON.stringify` → UTF-8 bytes，固定 frame version 與 1024-byte guard。
- `comparison-capability.ts`：核對三組 literal frame/HMAC 後才產生 frozen capability；caller 不能在 `create` 時提供 digest 或 reference ID。
- `digests.ts`：QR 發行與 lookup digest，和冪等 HMAC 分離。
- `test/fixtures/comparison-vectors.ts`：以 shell byte tools／OpenSSL 獨立算出的硬編碼答案；module initialization 不呼叫 production codec 產生答案。

比較 artifact 的 enumerable 表面只有 64 位小寫 HMAC 與 reference ID，不含 QR、subject 或 HMAC key；比對先核 reference，再將 hex 解成 32-byte Buffer 以 `timingSafeEqual` 比較。

## 獨立固定向量

測試 key 僅為非秘密 fixture：`000102...1e1f`。

| 輸入 | 固定 frame | 固定 HMAC-SHA256 |
|---|---|---|
| QR `A` | `["PassHub/idem/v2","QR_SCANNED",[1,"A"]]` | `1035cbfb48da122da36a14350fdd5e43942923570c45dcfb50007a4d1dba93ae` |
| Face `DemoFace`／`中😀` | `["PassHub/idem/v2","FACE_MATCHED",[8,"DemoFace"],[7,"中😀"]]` | `b414e2e7b0a1ea756132cd1038e6648dd065b05beb771d14caf72a8b3d560873` |
| Unknown | `["PassHub/idem/v2","FACE_UNKNOWN"]` | `4c2c59f9a184f54901874d198ce64e0b225d3603cc53525437451048af08bb65` |

QR lookup 的獨立 `A` 答案為 `67a65222958bb899a7d7a341910c5af940b9356bfae0bf9f31c6c6d006632338`。

## 實際驗證

| 驗證 | 結果 |
|---|---|
| 精確 Node image `npm run test:unit` | exit 0；26 pass、0 fail（comparison 11＋domain 14＋toolchain 1） |
| Jest coverage（comparison source） | comparison statements/lines 95.48%／95.39%、branches 92.15%、functions 91.17% |
| 原值危險轉換掃描 | comparison source 中 `normalize`／`trim`／`toLowerCase` 0 筆 |
| lockfile 指紋 | 與 G02／G03a 相同，沒有新增依賴 |

測試涵蓋三個精確 frame、中文／emoji byte length、JSON escaping、組合與分解 Unicode 不合併、合法空白保留、QR/provider/event ID 上下限、subject 256-byte 與控制碼／surrogate 邊界、錯 key／frame／缺向量／重複向量 fail closed、reference mismatch、HMAC 比較、QR lookup 固定答案及 43-char 發行形狀；另覆蓋非 string 識別值、null／未知 recognition kind，以及 startup null/string config、string/empty key、null/nonarray vectors、null vector、錯型欄位的 `ComparisonCompatibilityError`。

Coverage 只用來觀察未走分支，不作要求完成率；frame 的 1024-byte 防線在目前更窄的欄位上限下不可達，但仍保留為版本演進防線。

## 檔案指紋

| 檔案 | SHA-256 |
|---|---|
| `src/access/application/comparison/comparison-capability.ts` | `3a9d4e9f68bd71b590aae844b4dbb77957c93bebbaf6e3d8ac55e424f79c079d` |
| `src/access/application/comparison/digests.ts` | `5c48e4ad131373866f3bd5ef93b35adc0a7077feb25bd6e1415dd6db4d1c32ad` |
| `src/access/application/comparison/frame-codec.ts` | `33fb15cdce96ddeaa51295ad00fddf357c4e11f5d890057a353afe0a1037cb86` |
| `src/access/application/comparison/index.ts` | `c40a2444dbaff6b71b031e28ffd1cf12354f1033bf37aeb804f8cbc37699a823` |
| `src/access/application/comparison/recognition-input.ts` | `bbeb6b6532fe01904e7d3300cb7e9c9f52e2786eb97baf95bbb09042d3493b38` |
| `test/fixtures/comparison-vectors.ts` | `87eb4c776336a7d46ef1a70ca23e37b545ea6b79f1cc55390d4ddad065d223b9` |
| `test/unit/comparison-codec.test.ts` | `c08c9f89362636afd3625b51b5ebbad65c82d493d6b67173abbd3cad5016ddc7` |
| `test/unit/comparison-digest.test.ts` | `68d5ca378365e9ebb04dc66028415e98dd6929f5297ed84fbd1ee6370b74aada` |
| `package-lock.json` | `70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b` |

## Gate 判定

**G03b PASS（固定 comparison unit 範圍）**：精確 Node 24.21.0 image 內 Jest 11 個 comparison tests 全綠，含 runtime-input 與 startup config corruption cases。B09、B33–B36、B50 只增加本關局部證據，仍標 U：尚未有 Source key、registry、MongoDB 保存／掃描、回放、HTTP 投影或日誌驗證。A01 維持 V，其餘 135 要求仍 U，履歷成果不解鎖。
