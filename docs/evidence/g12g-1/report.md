# G12g-1 typed profile 與 dataset descriptor 邊界

狀態：**PASS（deployment intake／dataset selection 限定證據；非 Atlas 相容或部署證據）**

## 完成範圍

- 部署 profile 只接受 exact `LOCAL_SELF_HOSTED`／`ATLAS_MANAGED`；缺值、空白、大小寫變體、未知值與 NUL 均在 Mongo 連線及 HTTP listen 前拒絕，且不以 `NODE_ENV` 選擇資料庫。
- Local 固定選擇 `passhub_demo`，完全不讀 Atlas descriptor；既有 G11a probe 只允許 Local。
- Atlas 啟動時只讀一次固定 `/run/passhub/dataset/active-dataset.json`。wire 固定為單行 canonical JSON＋單一 LF，exact fields 為 `profile`、`slot`、`databaseName`、`datasetEpoch`；只允許 BLUE／GREEN 與對應資料庫名稱及 canonical lowercase UUID v4。
- descriptor reader 驗證獨立目錄／檔案權限、owner、regular file、symlink、realpath、`O_NOFOLLOW`、bounded read、fatal UTF-8、BigInt stat identity、雙次完整讀取、same-inode mutation、path replacement、close fault及去敏錯誤。
- validated dataset target 注入既有 Mongo adapter；Atlas descriptor epoch 在消耗 ticket、durable claim及 listen 前與已驗 metadata epoch比較。
- D207 requirements checker 已重基線為132個正式＋11個排除＝143 IDs，並理解G12g-0～g-7非終態與完成後轉G12h的canonical終態；PASS只代表帳本結構，不代表143項均完成。

## 驗證結果

- Exact toolchain：Node `v24.21.0`、npm `11.19.0` pinned container。
- `npm run test:g12g1`：3 suites／65 tests；boundary PASS；9個錯誤checker mutation全部拒絕、1個canonical terminal正例接受；143-ID baseline PASS。
- Exact toolchain完整unit：83 suites／1350 tests PASS。
- Local回歸：G11a Docker runtime 8／8、G11b production runtime 12／12、G12f static 17／17、G12f Docker Demo 8／8，且當次containers／networks／volumes／image tags完成清理。
- `git diff --check`：PASS。
- 專案經理、架構師與獨立測試員最終覆核：PASS。

詳細摘要、工具版本、來源狀態與檔案指紋見 `runtime.json`。

## 證據限制

- 本次受測工作樹以 HEAD `8322ce3d7f859212b0c35b6fac2ec057fcf0b669` 為基底且包含尚未提交的G12g-0／g-1差異；G11b runtime明示為dirty-development回歸，不冒充clean release evidence。
- 沒有連線 MongoDB Atlas；既有production topology verifier仍為Local限定。Atlas capability verifier屬G12g-2。
- `/run/passhub/dataset`的Atlas read-only mount、Atlas Compose、credential分離與實際部署拓撲尚未建立，屬G12g-3。
- 沒有實作Atlas initializer、descriptor publisher、blue／green reset、safe-reuse、公開HTTPS或GitHub runtime；分別留在G12g-4至g-7。
- A18、M11、M12及E10仍未被本gate完整閉合，不得宣稱Atlas可運行、已部署或與Local等價。
