# G11c 維護入口與停機隔離證據

## 結論

G11c 的限定 runtime slice 通過：持久 marker、私密 drain、API 與 Mongo 原 container process 消失、同 volume 的 Mongo writable PRIMARY 復原，以及舊 API work 的 no-late observation 均有直接證據。runner 實際呼叫 `createG11cMaintenanceComposition`、`createG11cMaintenanceMarkerAdapter`、`createG11cPrivateDrainAdapter` 與 `createG11cDockerProcessAdapter`；不是手寫替代流程。此報告不宣稱 G11d reset/seed、G11e 排程與 host lock、G11f 完整故障矩陣或 G11g release audit。

## 可重跑命令

```bash
npm run test:g11c:unit
npm run test:g11c:runtime
```

正式 runtime 使用 detached clean worktree，`sourceDirty=false`；API image 由固定 G11 compose/Dockerfile 建置。測試結束以 `docker compose down --volumes --remove-orphans` 清理 project、volume、network、container、image 與暫存秘密，runner 另以 project label 與 image inspect 逐項確認沒有殘留。

## 直接驗收案例

1. 以 G11b 已驗證的 bootstrap fixture 作為 maintenance 前置資料；fixture 建立在 marker 啟用前，G11c lifecycle 本身不 reset、seed、清 claim 或產生新 epoch。
2. 建立 persistent marker 後，NGINX edge 維持封閉；marker 未在任何後續 phase 移除。
3. 透過既有 G10a AF_UNIX private control socket 先讀 STATUS，再送相同 epoch/run 的 DRAIN；回應為 `DRAINED`，並驗證 revision、controlId、maintenance provenance 及 issued/query counters 為零。
4. 記錄 API container identity 與 PID；`compose stop` 後用同一 identity 的 `docker inspect` 確認 `Running=false`、`Pid=0`、`ExitCode=0`，並確認 private socket 消失。
5. 僅在 API process disappearance 後停止 Mongo；同樣以原 identity/PID 確認消失，再以同一 named volume 啟動 Mongo。
6. 以 Mongo `hello` 真實檢查 `setName=rs0`、`isWritablePrimary=true`、單一 host，且 API 維持停止、marker 維持存在。
7. 復原後連續三次以 Mongo `currentOp` 觀察固定 API network identity，結果皆為零；同時比較 maintenance 前後 metadata 與七個 collection snapshot，未出現晚寫入。

正式結果摘要保存在 [runtime-clean.json](runtime-clean.json)。container ID 以 SHA-256 保存，避免把暫時 runtime identity 當作秘密或公開操作資料；PID、終止狀態、source/image/compose fingerprints 均保留。

## 局部測試與邊界

`npm run test:g11c:unit`：4 suites／27 tests PASS，涵蓋 marker fail-closed、FIFO/symlink/owner/mode 防護、private drain provenance、timeout/NOT_DRAINED、process identity 觀察（含 replacement PID fail-closed）、phase failure stop 與 one-shot lifecycle。真實 runtime runner 另證 Docker/Mongo 順序與復原。

G11c 不提供 public maintenance route，不清除 claim，不執行 reset/seed，不簽發 runTicket，不移除 marker，不啟動第二 API writer；完整七 collection reset/seed 留在 G11d。failure injection 的完整矩陣與 controlled rerun 留在 G11f。
