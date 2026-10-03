# G11f evidence — fail-closed faults and controlled rerun

狀態：**PASS（限定責任範圍）**

## 驗證命令

在 detached clean worktree、外部唯讀 dependency link、Node 24 exact toolchain 下執行：

```text
npm run test:g11f:unit
npm run test:g11f:runtime
```

結果為 1 suite／14 tests PASS；runtime `sourceDirty=false`、cleanup 完成。固定來源指紋與 case manifest 見 `runtime.json`。

## 真實 runtime 證據

- G11d 在同一個 Mongo runtime 先完成第一次 transaction reset。
- 同一個 Mongo runtime 故意產生 malformed private reset handoff；真實 `publish-dataset-epoch.mjs` 回 `G11E_EPOCH_PUBLISH_FAILED`，已發布 epoch 不變。
- 同一個 Mongo runtime 接著以新 epoch 執行第二次 G11d reset，驗證 stable seed、indexes、未管理資料與 `writeRunClaim=null`，證明受控重跑收斂，而非兩個獨立 Mongo 的近似測試。
- 真實 G11e `run-maintenance.sh` 消費 G11d 產生的 handoff 並簽發 0400 ticket。
- 兩個真實 controller 同時執行時，第二個由 flock 回 `75/G11E_CONTROLLER_BUSY`；ticket 建立前的鎖競爭已驗證。

## Policy fault matrix

canonical `g11f-fault-controller.ts` 以 fail-closed 規則覆蓋 marker off、API running、Mongo 非 PRIMARY、extra writer、ordinary same-epoch restart、unknown reset、lock 與 ticket 無效。unit 與 runtime 均驗證 closed decision 不進入 reset decision。

其中前八個輸入是 adapter observation policy cases，不宣稱每一項都已透過獨立 Docker process fault 注入；G11c 已保存 API／Mongo 停機與 no-late-work 證據，G11e 保存 flock／controller 證據。本 gate 的新增真實生命週期證據是同 Mongo partial handoff／rerun 與 G11e lock contention。

## 邊界

本 gate 不新增公開維護 API，不改業務資料範圍，不宣稱正式 SLA；G11g 仍須整合本報告、所有前置 gate 指紋、秘密掃描、cleanup 與三角色最終覆核。
