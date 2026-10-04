# G12f Docker Demo

這是 PassHub 的本機、一次性求職展示。它使用空的 Docker volume 建立單成員 MongoDB replica set、production API 與本機 HTTPS proxy，然後自動執行固定流程：

`建立資格 → QR ENTRY → 查詢 INSIDE → 模擬 Face EXIT → 查詢 EXITED 與兩筆事件`

## 執行

需求：Docker Engine、Docker Compose v2、OpenSSL，以及可執行 Node.js 腳本的環境。命令會自行 build API image、產生短生命週期的測試 secret／TLS／runtime ticket、建立 Mongo seed，完成後清除 Compose resources、image tag 與暫存目錄。

```bash
npm ci
npm run demo:g12f:docker
```

成功時只輸出去敏的 gate、case 清單、image tag／digest 與 Compose 設定指紋；QR token、JWT、Source credential、Mongo URI、bootstrap ticket 不會輸出。

## 驗收內容

runner 會以正式 production entrypoint 啟動服務，並斷言：

- Operator 登入及建立資格，QR token 只在建立回覆取得一次。
- ENTRY client 以預置 ENTRY Source 傳送 QR 結果，回覆 `ENTRY_GRANTED`。
- Viewer 查詢顯示 `INSIDE`。
- EXIT client 以預置 EXIT Source 傳送模擬 `FACE_MATCHED`，回覆 `EXIT_RECORDED`。
- 資格查詢到 `EXITED`，事件查詢包含入口與出口的兩個決策。

這裡的 Face 是「外部影像服務已完成辨識」的模擬結果；PassHub 不處理 RTSP、影像、confidence、人臉演算法、相機或門鎖。ENTRY／EXIT client 只負責固定方向的 HTTP 傳輸，通行裁決仍由 PassHub 完成。

## 限制

- 這是本機 synthetic data Demo，不是公開服務，不提供 SLA、資料隔離、正式個資治理或跨重啟資料保證。
- 不使用真實個資；不要把真實姓名、聯絡方式或生物辨識資料放入 Demo。
- 不含多據點、多租戶、通知、Webhook、RTSP、硬體、人臉 enrollment 或正式維運介面。
- G12f 只證 Docker 可重建及固定業務流程；不代表 G12g public HTTPS 或完整 v1 已完成。

## 與既有維護能力的界線

Demo runner 只在本機暫存目錄建立一次性 runtime identity、ticket 與 seed，並在 `finally` 清理。它不暴露 `/internal/*`、runtime control socket、reset、claim 或 run-ticket API，也不把維護 secret 當成公開 Demo credential。
