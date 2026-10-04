# G12e CI Pipeline（待遠端執行）

## Result

`PASS` — CI workflow 已在 GitHub hosted runner 實際成功執行，解除 G12e STOP。

## Implemented workflow

- Workflow：`.github/workflows/ci.yml`
- Source commit：`c1bb0871c78d2b258f64bdfbfe1005025f6e6e8a`
- Successful remote run：`37190525677`（`c1bb0871c78d2b258f64bdfbfe1005025f6e6e8a`）
- Runner：`ubuntu-24.04`
- Toolchain：`.nvmrc`（Node 24.21.0）與 npm cache
- Workflow checker：`npm run check:g12e:workflow`，22 項必要命令／契約均存在

Workflow 目前包含：`npm ci`、toolchain assertion、build、完整 unit、5 組 HTTP e2e、9 組現行 boundary、OpenAPI、G12c requirements 與 `git diff --check`。

## Local equivalent evidence

- `npm run check:g12e:workflow` → PASS（`remoteRun: NOT_EXECUTED`）
- `npm run build` → PASS
- HTTP e2e：G07a 41、G07b 7、G08a 12、G08b 6、G09a 13，合計 69 tests PASS
- G12c requirements、OpenAPI、boundary checks → PASS

## Limits

第一次 run `37188396914` 的 UID 假設失敗已由 `c1bb087` 修正；成功 run 已驗證動態 foreign-UID 選擇。Integration／Mongo、fault、maintenance 不由本 workflow 冒充已完成，仍由各自 gate／既有 evidence 負責。
