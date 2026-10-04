# G11g evidence — integrated maintenance audit

狀態：**PASS（maintenance 綜合證據；非完整產品 release）**

## 驗證

在 detached clean worktree、Node／npm toolchain 與外部 dependency link 下執行：

```text
npm run test:maintenance
```

結果：`status=PASS`、`sourceDirty=false`、470 個受掃描檔案無秘密命中、Docker containers／networks／volumes／API images 均為空；動態 `passhub-g11[a-g]-<id>` Compose 專案、設定指紋、來源指紋與完整 manifest 見 `runtime.json`。正式 manifest 的 clean run verified commit 為 `516cabd`。

整合器確認 G11a、G11b、G11c、G11d、G11e、G11f 的 tracked report／runtime evidence 均存在且狀態有效，並重跑 G11e static contract 與 G11f unit suite（1 suite／14 tests）。

## 邊界與保留限制

- G11f 的 marker／API／Mongo／writer fault cases 中，部分是 canonical policy observations；不得在此報告改寫成完整 Docker／Mongo fault injection。
- 本 gate 不宣稱公開 HTTPS、CI、OpenAPI、完整 v1、SLA 或 production 個資生命週期。
- 本 gate 只整合既有 evidence，不改寫前置 gate 的責任範圍；完整交付 audit 仍屬 G12。
