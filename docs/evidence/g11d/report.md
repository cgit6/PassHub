# G11d — exact reset／stable seed evidence

狀態：**待三角色最終覆核**（本報告只記錄工程證據，不先升格 gate）。

## 驗證範圍

G11d 只提供 private maintenance capability：對 `passhub_demo` 的七個既定 collection 逐一 `deleteMany({})`，在同一 Mongo transaction 內寫入 canonical stable seed；不建立 public route、不刪 database／collection／volume，也不處理排程或故障控制。

七個 target 為 `qualifications`、`faceSlots`、`events`、`users`、`sources`、`metadata`、`managementReceipts`。其他 collection 與其他 database 不在 reset scope。

## Clean runtime

- command：`node scripts/g11/test-g11d-runtime.mjs`
- source commit：`f879d8f7fc900019da79e4fe9e853ce7fa39a17e`
- `sourceDirty=false`
- source SHA-256：`fb7cecf2c4422a41a3e279afedb898809ad8f876ed56eae931b66247bb1f9700`
- generated compose SHA-256：`87a5751bcfc63b6520a3a226385caef62fb9919615a4e89f51273195f39390be`
- 完整機器輸出保留於 [`runtime-clean.json`](./runtime-clean.json)。

結果為 8/8 cases：exact allowlist、transaction rollback seam、sequential reset、stable seed、new epoch／null claim、index preservation、其他資料不變、第二次受控重跑。

第一次 reset 的七項刪除／寫入數量為 `1/1、2/2、0/0、1/1、2/2、1/1、0/0`；第二次相同。兩次都直接讀回 metadata，確認 epoch 更新且 `writeRunClaim === null`，並比較第二次資料與 canonical seed。

## Unit and boundary checks

- `npm run test:g11d:unit`：1 suite／6 tests PASS。
- `npm run build`：PASS。
- `node --check scripts/g11/test-g11d-runtime.mjs`：PASS。
- dirty source 預設拒絕；`--allow-dirty-development` 只供本地開發，不可作正式 evidence。
- 測試 teardown 的 `compose down --volumes` 僅清理隔離測試資源，不是 G11d reset 行為。

## Gate boundary

G11d 不證明 G11e 的 flock／systemd 排程、G11f 的完整故障矩陣，亦不代表 G11g 或完整 v1 release 已完成。
