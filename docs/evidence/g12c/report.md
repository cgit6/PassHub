# G12c Boundary／Requirements Audit

## Result

`PASS` — G12c 只核對業務邊界與要求帳本，沒有修改業務程式或公開 API。這個 PASS 代表稽核器與帳本結構通過，不代表 136 項工程要求全部完成。

## Source and commands

- Source commit: `faad6dcb7e38e316cffe481568a973a24984248c`
- `npm run check:g12c:requirements` → PASS
- `npm run build` → PASS
- `npm run check:g12b:openapi` → PASS（回歸確認 G12b 公開契約仍為 8 path templates／10 methods、0 internal routes）
- `git diff --check` → PASS

## Requirements ledger

- 正式矩陣：125 IDs。
- 明確排除：X01–X11，共 11 IDs。
- 總帳本：136 IDs；逐項映射 §10.1：136/136；重複與遺漏：0。
- 正式矩陣每一列都有 U／I／V／R 工程狀態欄；本 gate 不把 U 改成 V。
- 逐列 audit 分類：`DIRECT_EVIDENCE` 4、`PARTIAL_EVIDENCE` 75、`STRUCTURAL_ONLY` 46、`EXCLUDED` 11。每列均有 T-要求ID 驗收情境與 §10.1 gate 映射；`DIRECT_EVIDENCE` 的四個引用檔案均由工具確認存在。未具備直接 artifact 的項目保留為未完成，不被本關升格。

## Current boundary checks

以下現行邊界檢查均 PASS：G03c、G06a、G06b、G08a、G08b、G09a、G10 fault topology、G11a topology、G11e maintenance contract。每個結果保存 script SHA-256、exit code 與輸出摘要於 `runtime.json`；G11b、G11c、G11d、G11f、G11g 沿用各自既有 evidence，本關不把它們重新驗證冒充為新 runtime。

G07a／G07b 舊邊界腳本未被冒充為目前證據：它們會把 G11 新增的 private control socket 與 production lifecycle 誤算為 G07 的單一 HTTP owner，故明確標記為 `STALE_LEGACY_TOPOLOGY`。這是檢查器範圍過時，不是以失敗結果隱藏；目前邊界由 G08–G11 的現行檢查與既有 evidence 接手。

## Scope conclusion

本關沒有發現新增業務能力、公開 internal route、需求 ID 漂移或排除項目被重新加入。下一合法 gate 是 G12d（clean install／完整測試重跑）。
