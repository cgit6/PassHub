# G12a — Release baseline 與需求帳本凍結

狀態：**PASS（限定 release baseline）**。

## 驗證命令

```text
npm run check:g12a:baseline
```

在 detached clean worktree 執行，source commit 為 `f7bdd19f53f1159386b9e4e0405c6f82ba3cfa98`，`sourceDirty=false`。

## 驗證結果

- G02–G11g 前置 evidence report 共 27 份，均存在且非空。
- 正式要求矩陣包含 125 個 ID；明確排除區段包含 11 個 ID，合計 136 個唯一 ID。
- G11g manifest 綁定 `516cabd34a72e38b3927539478ca25c1dc69de43`，且已保存 source/config/image fingerprints、秘密掃描與 cleanup 結果。
- `requirements-traceability.md` 已同步目前停止點：G11g 完成，下一合法 gate 為 G12。
- 保存文件與設定指紋：`bfb57ed8472c045c96a11b52ecf963ad1b4893d2525e44590dc1cdf79f8a89ab`。

## 邊界與停止

本關只凍結 release baseline 與需求帳本，不宣稱 OpenAPI、CI、clean install、Docker Demo、public HTTPS 或完整 v1 已完成。G12b 是下一個合法子關；本關不修改業務 API 或 production code。
