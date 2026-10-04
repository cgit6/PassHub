# G12b — OpenAPI 與可重跑 curl Demo

狀態：**PASS（限定 API 文件與既有 HTTP route 對齊）**。

## 驗證命令

```text
npm run check:g12b:openapi
npm run build
npm run test:g08a:e2e
npm run test:g08b:e2e
npm run test:g09a:e2e
```

## 驗證結果

- release manifest source commit 為 `5e60e40b9d36ac94c9e50e6f02d1fdb0f99f39e1`，`sourceDirty=false`；HTTP e2e 實際執行於 `383d758a3cae14bd6c688ce3bf6a660479a55c8c`。兩者之間只有 G12b 文件／evidence 修正，沒有 production code 變更。
- [`docs/openapi.json`](../../openapi.json) 描述 D150 的 10 條業務 method、8 個 path template。
- OpenAPI 與 curl 文件一致性檢查通過；spec 沒有 `/internal/*`、reset、claim 或 runTicket route。
- G08a HTTP e2e：1 suite／12 tests PASS。
- G08b HTTP e2e：1 suite／6 tests PASS。
- G09a HTTP e2e：1 suite／13 tests PASS。
- `npm run build` PASS。
- [`docs/demo/g12b-curl.md`](../../demo/g12b-curl.md) 覆蓋建立資格、QR ENTRY、INSIDE 查詢、Face EXIT、資格與 Event 查詢，以及 UNKNOWN／冪等／跨媒介限制。

## 邊界與限制

本關沒有新增業務端點，也沒有新增 `/openapi.json` runtime route。curl 文件需要已啟動的本機 Demo 與外部注入的預置憑證；它不把維護 socket、reset、claim、runTicket 或真實影像／RTSP 能力公開。公開 HTTPS、CI、Docker 一鍵 Demo 與完整 release audit 留在後續 G12e–G12h。
