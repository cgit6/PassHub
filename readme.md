# PassHub

PassHub 是一個以 Node.js／TypeScript 實作的單一邏輯地點訪客通行資格與辨識決策 API，使用 MongoDB 官方 driver。它接收 QR token 或外部辨識服務傳來的模擬 Face 結果，由後端統一完成資格映射、ENTRY／EXIT 決策、Presence 狀態與事件稽核。

## 技術重點

- Node.js 24、TypeScript、原生 HTTP composition、MongoDB 8 replica set
- Operator／Viewer 人員登入與個別 ENTRY／EXIT Source 認證
- QR／Face 替代輸入、冪等事件、原子 Presence 與 Event 保存
- OpenAPI、Jest、Docker Compose、NGINX HTTPS 與 GitHub Actions CI

## 本機 Docker Demo

```bash
npm ci
npm run demo:g12f:docker
```

完整說明見 [`docs/demo/g12f-docker.md`](docs/demo/g12f-docker.md)。Demo 會自行建立暫存 secret、TLS、Mongo seed 與一次性 runtime ticket，執行「建立 → QR ENTRY → INSIDE → 模擬 Face EXIT → EXITED／事件查詢」，最後清除所有 project-scoped Docker 資源。

這是求職展示，不是正式門禁產品：不處理 RTSP、影像、人臉辨識演算法、相機或門鎖，也不提供正式個資、可用性或資料隔離保證。請只使用虛構資料。

## API 文件

- [OpenAPI](docs/openapi.json)
- [curl API 操作範例](docs/demo/g12b-curl.md)
- [Docker Demo 操作與限制](docs/demo/g12f-docker.md)

## 其他驗證

```bash
npm run build
npm run test:unit
npm run check:g12b:openapi
npm run check:g12c:requirements
npm run check:g12e:workflow
```
