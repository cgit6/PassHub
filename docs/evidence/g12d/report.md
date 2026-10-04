# G12d Clean Install／完整測試重跑

## Result

`PASS` — 在 clean detached worktree、固定 Node/npm 及可重現 Docker nested-test 條件下，依 lockfile 安裝並完成 build 與完整 unit suite。

## Formal run

- Source commit：`90aee0d8b5768e634d110f238e45fc8f89ed539e`
- Evidence publication revision：`e998475e7dc328c00107dbf6db505c3e9b2ff816`（只含 gate 文件、稽核器 current-stop 相容性與 evidence；正式 clean test 使用上列 source commit）
- Toolchain image：`node:24.21.0-bookworm-slim`
- Image digest：`sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`
- Node：`v24.21.0`
- npm：`11.19.0`
- Worktree：detached clean checkout，測試後已移除
- Docker nested tests：以 host `/tmp`、Docker CLI、Docker socket 同路徑掛載；外層以非 root 使用者執行並保留 Docker 群組權限，避免權限測試失真

## Commands and results

| Command | Result |
|---|---|
| `npm ci` | PASS；423 packages，0 vulnerabilities |
| `npm run build` | PASS |
| `npm run test:unit` | PASS；81 suites／1290 tests |
| G03c/G06a/G06b/G08a/G08b/G09a/G10/G11a/G11e boundary checks | PASS |
| `npm run check:g12b:openapi` | PASS；8 paths／0 internal routes |
| `npm run check:g12c:requirements` | PASS；136 IDs、4 direct／75 partial／46 structural／11 excluded |
| `git diff --check` | PASS |

## Rejected environment attempts

兩次先前的 clean run 不列正式證據：第一次容器沒有 Docker CLI，foreign-UID 測試得到 `spawn docker ENOENT`；第二次以 root 執行，使 umask／foreign-UID 權限測試失真。兩者均沒有修改 source，最後正式 run 已修正為上述固定條件並全綠。

## Boundary

本關只證明 lockfile 可安裝、TypeScript 可建置、完整 unit suite 與既有靜態契約可重跑；不把它升格為 Mongo integration、CI、Docker Demo、公開 HTTPS 或完整 136 項工程需求完成。下一合法 gate 是 G12e（CI pipeline）。
