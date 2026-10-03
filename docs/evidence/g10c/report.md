# G10c 真實傳輸未知確認證據

## 結果

G10c 通過本輪驗收。證據同時涵蓋 Mongo/Toxiproxy wire probe 與實際 G07 → G08a → G04b HTTP 管理流程；沒有使用 `failCommand` 或應用程式自行丟例外來假造 response-loss。

## 固定來源

- source commit：`<see git commit containing this report>`
- Mongo image：`mongo:8.0.32-noble`，沿用 `infra/g10-fault-compose.yml` 固定 digest
- Toxiproxy image：`2.12.0`，沿用固定 digest
- Node image：`24.21.0`，沿用固定 digest
- App Mongo URI 僅經 Toxiproxy；observer／interferer 直連 Mongo

## 驗證命令與結果

```text
npm run test:g10c:unit   PASS — 9 suites / 67 tests
npm run test:g10b:unit   PASS — 8 suites / 65 tests
npm run test:g10:fault-topology PASS
npm run test:g10c:fault  PASS — 2 suites / 4 tests
npm run test:g10b:fault  PASS — 2 suites / 3 tests
```

G10c fault run 的 Docker compose cleanup 通過，測試產生的 container、network 與 npm cache volume 均移除。

## 真實 G10c 情境

1. 透過實際 HTTP 管理端點送出 qualification 更新。
2. direct interferer 開啟 Mongo `hangBeforeCommitingTxn`。
3. 監聽 app driver 的 `commitTransaction` 已送出。
4. Toxiproxy downstream timeout 暫停回應，解除 Mongo barrier。
5. direct observer 以共同 snapshot 確認 qualification 已完整提交。
6. 重置 proxy 連線，使原 HTTP 請求收到 `503 REQUEST_STATUS_UNCONFIRMED`。
7. G10c scheduler 只執行 retained original commit／canonical read，不重跑 G08 CRUD。
8. canonical confirmation 成功後釋放 registry、issued persistence lease 與 Mongo session。
9. 觀察 session 終止後沒有 late transaction 或 CRUD command。

同一 fault suite 另包含獨立 Mongo driver wire probe，確認 commit response-loss 本身是真實發生，且 direct observer 看見已提交資料。

## 單元層補強

- Management ticket：原始 commit、canonical confirmation、terminal cleanup。
- Recognition ticket：canonical redacted event、replay registry settlement、session cleanup。
- Recognition 不重跑 business callback；沒有 canonical event projection 時 fail-closed。
- bridge wake 使用 microtask，避免在 pause 尚未完成時提前 claim ticket。

## 邊界

本證據只驗 response-loss／unknown settlement 與原子保存，不宣稱 G11 部署/reset lifecycle 或 G12 完整交付已完成。
