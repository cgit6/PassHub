# G06a 人員認證 primitive —限定 gate evidence

## 判定

G06a human-auth primitive gate **PASS**。本關只交付人員登入／JWT／目前帳號狀態／角色的窄能力與唯讀 Mongo account reader；沒有接 Source credential auth、HTTP／Nest route、rate／capacity、use-case、部署或完整 v1。因此本關不新增完整 requirement V。

架構 review **PASS**；independent tester formal unit **88/88 PASS**。PM 另以隔離 writable workspace、exact Node image 及 exact Mongo image 重跑本關與既有相鄰 gate。所有正式計數以下列最後一次單一、清理後的隔離重跑為準；一次因同一 compose project 被重疊啟動而造成的無效 runner collision 不列入正式計數，已 teardown 後重新以單一 runner 完整通過。

## Contract and implementation

契約來源為 D61、D122、D150、business §3.2–§3.4／§8.3 及 implementation-plan 的 Auth 段：

- `createHumanAuth` 只接受窄的 `HumanAccountReaderPort`、`HumanPasswordDeriverPort`、32-byte injected JWT key 與可控 clock；回傳 internal capability。principal 是空的、frozen、由同一 capability 的 private provenance 發出，不能由 plain object、foreign instance 或另一 capability 偽造。
- login 僅接受 exact `{username,password}`，各 1–128 UTF-8 bytes，保留大小寫／空白／Unicode 原值，拒絕額外鍵、陣列、null、unpaired surrogate。未知、錯密碼、停用帳號皆走 generic `INVALID_CREDENTIALS`，並使用固定 dummy scrypt 路徑；帳號 shape、UUID、role、salt／hash／參數損壞則為去敏 technical failure。
- JWT 僅 HS256、獨立注入 32-byte key、exact claims `sub`／`iat`／`exp`／`iss=PassHub`／`aud=human-api`，TTL 900 秒；verify 嚴格 algorithms／issuer／audience／maxAge，並核 integer claims、UUID v4、`exp=iat+900`、`iat<=now`、未過期。無 refresh、logout、register 或 password-reset。
- seed password 使用 async scrypt `N=131072,r=8,p=1,keyLength=64,maxmem=268435456`，每帳號 lower-hex salt 至少 16 bytes；hash comparison 使用固定長度 `timingSafeEqual`。每次 verify 依 token `sub` 重查目前 `enabled`／`role`；帳號刪除或停用立即使 token 失效，`assertRole` 只接受發出的 opaque principal。
- `MongoHumanAccountReader` 僅對 `users` 做 two narrow `findOne` reads，`readPreference=primary`、`readConcern=majority`，projection 分別是登入必要欄位與 `_id/role/enabled`；沒有 write、transaction 或 retry orchestration。實際 Mongo integration 驗證 Operator／Viewer、generic failure、role／enabled 變更與 token invalidation。
- 錯誤只輸出 typed、secret-free `HumanAuthError`：input／credentials／token／role／clock／configuration／dependency／reentrant／frozen；不回顯 password、salt、hash、token 或 cause。

這些是 G06a 的 primitive contract，不把 Source alias.secret、source active／direction、Access decision／Event、HTTP status／Bearer route 或 deployment secret handling 偷併入本關。

## Exact verification

Pinned Node image：

```text
node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
```

Pinned Mongo image：

```text
mongo:8.0.32-noble@sha256:01354084d2ae665d2e79b79b0cdc50c2c0c98873618912d9a2c8c9cb5c3d24e6
```

Repo 以 bind mount 複製至 container writable temporary workspace；`dist`／`coverage`／host `node_modules` 沒有清除或 chown。exact Node 內執行：

```bash
npm ci --ignore-scripts
npm run build
npm run test:g06a:unit
npm run test:g06a:integration
npm run test:unit
npm run test:g04a
npm run test:g04b
npm run test:boundary
npm run test:g06a:boundary
npm run test:negative-compile
npm run test:g06a:negative-compile
npm run test:coverage
```

結果：

- `npm ci --ignore-scripts` exit 0；423 packages／0 vulnerabilities；Node／npm 為 `v24.21.0`／`11.19.0`。
- G06a unit：1 suite／**88 tests passed**；G06a true Mongo：1 suite／**5 tests passed**。
- full unit：10 suites／**277 tests passed**。
- G04a true Mongo：1 suite／**9 tests passed**；G04b true Mongo：1 suite／**57 tests passed**；兩者均使用 exact Mongo 8.0.32 `rs0` compose，測後 teardown。
- G03c boundary：`selected=25 edges=59 forbidden=0 directRawComparison=0`；G06a boundary：`files=12 edges=21 forbidden=0`。
- G03c 與 G06a negative public-surface compile 均 exit 0，所有 `@ts-expect-error` 反例均被消耗；build／typecheck 均 exit 0。
- coverage：10 suites／277 tests passed；aggregate **56.86% statements／59.70% branches／53.62% functions／59.41% lines**。`src/auth/application/human-auth.ts` 為 **96.42% statements／96.52% branches／96.29% functions／99.31% lines**；coverage 是觀察值，不是 release threshold。
- secret scan：對 `src`／`test`／`scripts` 的 private-key、AWS key、credentialed Mongo URI pattern scan 無命中；host `git diff --check` exit 0。

True Mongo reader 的正式觀察為只讀 primary／majority，沒有 write／transaction／retry command；這不等於 deployment、HTTP route、timing-side-channel 或全系統 operational guarantee。

## Source fingerprints

以下為 working tree fingerprints，非 clean source commit：

```text
package.json                                      715455784f90505cb42a3bc4466b04b0471da5d3de07c5a83dcb2297d1807341
package-lock.json                                 70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b
src/auth/application/human-auth.ts                1de6401674816cc8899e60167ecdf8979c54305cdf4c2c9ae967225510d4ff71
src/auth/infrastructure/mongo-human-account-reader.ts 343a1f193e9d5514b922d9a01878a9db04f245e9a27d3d20e3a47c7c08d30c27
test/unit/g06a-human-auth.test.ts                 03133c00d401db052d2ec463bada135524abe3e11bb1b90b6f1689e80a9f03c7
test/integration/g06a-human-auth-mongo.test.ts    6ad857e5258c9a07a4d763909e5009bbc8c71737334ea5c4c5e627ff0bdbc737
```

## Requirement disposition and limits

完整 requirement V 維持 **10**：A01（既有）＋A11–A16、B13、B41、B42（G04b 新增9）；完整 requirement U 維持 **126**。G06a 不新增完整 requirement V。

- **B22–B28**：人員登入 primitive 有直接 evidence，但完整 Operator／Viewer HTTP route、Source auth／direction／active、同步准入、業務權限與 recognition wiring 尚未驗，因此逐項維持 U。
- **A06–A07**：Auth domain／ports 與 Source boundary 有 static evidence，但 Auth／Sources runtime composition、Source credential integration、Access route wiring 未驗，維持 U。
- **M03、E06**：seed fixture／secret-free errors／scan 與本 gate 測試通過不等於 deployment secret separation、完整秘密生命週期或 136-row test coverage，維持 U。
- 其餘所有要求仍依既有矩陣為 U；本 gate 不把 JWT／scrypt／current role evidence 擴張成 HTTP、部署、rate/capacity、timing-side-channel、Source auth、use-case、Mongo write lifecycle 或完整 v1。

## Stop and handoff

依 25 STOP，停止於 **G06a**；下一合法 gate 為 **G06b Source authentication／security facts**。本次不開始 G06b、G07 HTTP、G08 use-case、G10 transport／confirmation 或 G11 maintenance/deployment。
