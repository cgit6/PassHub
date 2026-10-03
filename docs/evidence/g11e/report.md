# G11e — 外部排程與唯一 controller

狀態：**PASS（G11e scope）**。

## 已完成責任

- 手動與 systemd timer 共用 `scripts/g11/run-maintenance.sh`。
- 使用固定 local lock descriptor 與 `flock -n`；lock FD 維持到 controller 結束，第二個執行者立即以 busy code 75 結束。
- timer 固定為 `03:00 Asia/Taipei`、`AccuracySec=1s`、`RandomizedDelaySec=0`、`Persistent=false`。
- G11d reset result 先由 `publish-dataset-epoch.mjs` 驗證後，以同目錄 temporary file、`fsync`、atomic rename 更新持久 epoch state；更新失敗保留舊值。
- controller 只讀受保護的 epoch／process identity 檔案，將一次性 ticket 寫到 G11b canonical `/run/passhub/api/bootstrap-ticket.json`；ticket path、ID、wire 與 identity 不進 stdout。
- host／container numeric UID 固定為 `1000:1000`；runtime directory 要求 owner、非 symlink、0700，ticket 要求 0400 與 `O_NOFOLLOW|O_EXCL`。

## 驗證

- `npm run test:g11e:unit`：2 suites／3 tests PASS。
- `npm run test:g11e:static`：5 contract cases PASS。
- `npm run test:g11e:runtime`：5 cases PASS；實際串接 `reset-result → publisher → epoch file → ticket`，並驗證 concurrent controller、ticket mode/wire、shared entry reuse。
- 完整結果保存於 [`runtime.json`](./runtime.json)。

## 邊界

G11e 不執行 G11d reset 本身，只接收其受保護 result handoff；不做 G11f fault injection、extra writer、partial-reset recovery 或 ordinary restart matrix；也不宣稱 G11g 綜合 release 或公開 HTTPS。
