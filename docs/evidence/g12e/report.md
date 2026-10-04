# G12e CI Pipeline（待遠端執行）

## Result

`PARTIAL` — CI workflow 已建立並通過本地結構稽核與等價命令，但尚未在 GitHub hosted runner 實際執行；因此不解除 G12e STOP，也不把 E08 升為完成。

## Implemented workflow

- Workflow：`.github/workflows/ci.yml`
- Source commit：`cec5d29c447ff49a97bca9457bdbf7c8d89f3187`
- Runner：`ubuntu-24.04`
- Toolchain：`.nvmrc`（Node 24.21.0）與 npm cache
- Workflow checker：`npm run check:g12e:workflow`，22 項必要命令／契約均存在

Workflow 目前包含：`npm ci`、toolchain assertion、build、完整 unit、5 組 HTTP e2e、9 組現行 boundary、OpenAPI、G12c requirements 與 `git diff --check`。

## Local equivalent evidence

- `npm run check:g12e:workflow` → PASS（`remoteRun: NOT_EXECUTED`）
- `npm run build` → PASS
- HTTP e2e：G07a 41、G07b 7、G08a 12、G08b 6、G09a 13，合計 69 tests PASS
- G12c requirements、OpenAPI、boundary checks → PASS

## Remaining blocker

尚無 GitHub Actions run ID、hosted runner log、實際 CI commit／artifact。需要將 workflow commit 推到遠端並取得成功 run；在此之前不得把 G12e 標為 PASS。Integration／Mongo、fault、maintenance 也不由本地靜態 workflow checker 冒充已完成。
