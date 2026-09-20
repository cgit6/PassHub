# G02｜鎖版 package、編譯與測試工具基線

驗證日期：2026-09-19（Asia/Taipei）  
目標平台：linux/amd64  
Git 狀態：repository 尚無首次 commit，因此本關只能保存 working-tree 檔案雜湊；不能冒稱已有 clean source commit。正式 sourceCommit 證據仍由 G12 阻擋。

## D166 後的證據狀態

正式 unit runner 已改為精確鎖版 Jest 30.5.2（型別套件 `@types/jest` 30.0.0）；原 `node:test`／`node:assert` 測試已逐檔改寫，不再是正式 runner。Jest 以編譯後 JavaScript 執行，`maxWorkers=1`、`detectOpenHandles=true`、`forceExit=false`；Node24 ESM 相容性由 script 的 `NODE_OPTIONS=--experimental-vm-modules` 明示控制。

## 本關範圍

- 建立單一 root npm package，不使用 workspace。
- 鎖定 D125 的 Node、TypeScript、NestJS、Express、JWT、Swagger 及 MongoDB driver 版本。
- 使用 CommonJS、`module=Node20`、`target=ES2023`、strict TypeScript、legacy decorators／metadata。
- 正式基線使用 TypeScript 編譯後 JavaScript 的 Jest 30.5.2；不包裝或呼叫舊 `node:test` runner。
- 解析並實跑 Toxiproxy 2.12.0 的官方 GHCR linux/amd64 digest。
- 不建立 API、domain、MongoDB connection、Docker Compose 或業務功能。

## 鎖定結果

- Node image：`node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`
- image runtime：Node `v24.21.0`、npm `11.19.0`
- Toxiproxy index：`ghcr.io/shopify/toxiproxy:2.12.0@sha256:9378ed52a28bc50edc1350f936f518f31fa95f0d15917d6eb40b8e376d1a214e`
- Toxiproxy linux/amd64：`ghcr.io/shopify/toxiproxy:2.12.0@sha256:a3e244375123dad8849091bcc59775e188624d3f602db01901f9af855682fef8`
- 實際版本輸出：`toxiproxy-server version 2.12.0`
- 官方來源：[Shopify Toxiproxy package](https://github.com/Shopify/toxiproxy/pkgs/container/toxiproxy)、[v2.12.0 release](https://github.com/Shopify/toxiproxy/releases/tag/v2.12.0)

`package.json` 的 17 個直接 dependency／devDependency 皆使用精確版本，逐一與 lockfile 的安裝版本相等；lockfileVersion 為 3。`npm ci` 當次 registry audit 顯示 0 vulnerabilities，但這不等於完整安全或未來仍為零。

## 實際驗證

以下命令均使用上述精確 Node image、`--platform linux/amd64`、非 root workspace UID，以及容器內暫存 npm cache：

| 驗證 | 結果 |
|---|---|
| `npm install --package-lock-only --ignore-scripts` | exit 0；建立 lockfile |
| 精確 image 內 `npm ci --ignore-scripts` | exit 0；added 423 packages，audited 424 |
| 精確 image 內 `npm run build` | exit 0；strict TypeScript 編譯成功 |
| 精確 image 內 `npm run test:unit` | exit 0；5 suites、26 tests pass、0 fail、0 skipped |
| 精確 image 內 `npm run test:coverage` | exit 0；5 suites、26 tests pass；statements 94.13%、branches 92.67%、functions 94.23%、lines 94.03% |
| `npm ls --depth=0`（lock 對應） | exit 0；17 個直接套件均為預期精確版本 |
| exact Toxiproxy amd64 image `-version` | exit 0；回報 2.12.0 |

Smoke test 只證明鎖定的 Nest、Express、JWT、Swagger、MongoDB driver 能由編譯後 CommonJS 載入；不證明 API 接線、MongoDB 交易或業務規則成立。

## 檔案指紋

| 檔案 | SHA-256 |
|---|---|
| `package.json` | `a97de05fbb8d8cb378eea68abb65a3905fc1bf392c456ecfa5b2499f4dbafa89` |
| `package-lock.json` | `70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b` |
| `tsconfig.json` | `b3b50b1fbb675b7c5960b103c6937faaaba0cf46c024866b885e8791f69d608f` |
| `jest.config.cjs` | `91a214d158039a446df507e74a4afb7a18ebb813496fea29a5833f9baa086bec` |
| `infra/toolchain-images.json` | `30d56ed9263d9a4c1c8e626624c1b34746e5c3b26eee65c45e75c52f8ef05395` |
| `src/composition/toolchain-smoke.ts` | `1189d549b3cc25bc105318ef69d8c4b1ec7d3a38e5676fa9dd7975742ef629f1` |
| `test/unit/toolchain-smoke.test.ts` | `b06279de18b60a695800d1851b015509ce61552c680094bb539d68142ef802c2` |

## Gate 判定

**G02 PASS（本 gate 範圍）**：精確 Node 24.21.0 image 內 clean `npm ci`、build、Jest unit 與 coverage 全部 exit 0。此 gate 只證 package／編譯／測試工具基線；不解鎖 API、模組接線、MongoDB 交易或其他完整工程要求。repository 尚無首次 commit，故無 sourceCommit；本報告保存 working-tree SHA。
