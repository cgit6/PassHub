# G03c boundary / opaque-scope evidence

日期：2026-09-20（Asia/Taipei）  
狀態：G03c限定局部驗收通過並停止於G03c；本輪獨立 Jest、import boundary、negative compile、runtime public-surface及package resolution均通過。下一合法G04a尚未開始；不包含G04、HTTP、Mongo。

## 精確環境與重跑

固定 Node image：

```text
node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
```

完整串行命令：

```text
npm ci
npm run build
npm run test:unit
npm run test:coverage
npm run test:boundary
npm run test:negative-compile
```

結果：全部 exit 0。

- Jest：6 suites、37 tests passed；既有 26 tests 全數保留，G03c 新增 11 tests。
- Coverage：lines 84.76%（512/604）、statements 84.91%（518/610）、functions 88.34%（91/103）、branches 84.13%（366/435）。
- Import graph：`selected=18 edges=40 forbidden=0 directRawComparison=0`。
- Negative compile：exit 0；public package surface 的 stage、setPresence、raw repository、handle factory、兩種 plan factory 皆由 `@ts-expect-error` 真正消耗編譯錯誤。

## Jest 驗收範圍

`test/unit/g03c-boundary.test.ts` 使用假的窄 ports，直接驗證：

- management、recognition、query 三個 wrapper identity 不同；管理不取得辨識能力，query 不取得 write capability。
- WeakMap opaque handle：fake、cross-scope（相同 scopeId）、不同 owner/context、closed scope、cross-media plan、A/B plan mismatch。
- qualification incarnation/version 與 face mapping incarnation/version 的 stale fail-closed。
- FACE_MATCHED 無 mapping 轉為 `FACE_SUBJECT_NOT_MAPPED`；不一致 mapping 拒絕。
- FACE_UNKNOWN 不解析 persistence，plan 無 qualification/mapping mutation effects。
- EXIT plan 保留 `faceMappingEffect: RELEASE`。
- inactive source 不呼叫任何 QR/Face resolver，但仍 stage `SOURCE_INACTIVE`。
- redacted query output 不含 token、external subject、HMAC、comparison reference 等欄位。
- public runtime export 不含 plan factory；plain forged management/recognition plans 拒絕。

## Boundary / public surface

`scripts/check-g03c-boundary.mjs` 從 domain/application roots 建立可追蹤 local import graph，拒絕 Nest/Express/Mongo/Auth/HTTP dependency 與 production 直接 raw comparison import；本輪選中 18 個節點，兩類違規皆為 0。

`test/negative/public-surface.ts` 以 package self-reference `passhub` 對 build 後 declaration 執行嚴格 `tsc --noEmit`，不是文字掃描。若 public surface 重新暴露任何 staging setter、raw repository 或 opaque handle/plan factory，該 fixture 會因 unused `@ts-expect-error` 失敗。

## SHA-256（本輪相關檔）

```text
package.json                                      8a4bc15a707ad12b484d80ea46f5cea3516c99375b314d9fe967763f60138f20
package-lock.json                                 70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b
test/unit/g03c-boundary.test.ts                   bf325147dd3a6bb5955957dd79199e068fbf92a68b45bc4a919a7dcad6c54746
test/negative/public-surface.ts                   89f598f600022b796d35ff012d106eae08546126500e17c2c55f8ace0a662e5b
scripts/check-g03c-boundary.mjs                   eec7fc28685b768d6ac316ac54b60899f41baa5855555d9e1dceb897121ef3de
scripts/check-g03c-negative-compile.mjs           b7e1101571ae925b94d9763ded648bd47d09337762bc56dbbb7142c2b42238f4
src/index.ts                                      05dd56934b7242eeb558b65244b17f8b8a0f0ffb835cce51a1465987d673a9f4
src/composition/access-composition.ts             3b6ffcaebfe38c640f88a06957ec8bcce8c6b10079099d2c3ad363a955f8a534
src/access/application/index.ts                   4fad112a597f98d49d390a083af9401011944aeaf877547ed81927bed4749511
```

## 限制

本輪僅以 fake ports 驗證 scope/application boundary；未聲稱 Mongo transaction、HTTP contract、Nest controller、Auth 或 G04 persistence correctness。coverage 是整體 source coverage，不是 G03c requirement completion percentage。

`ManageQualifications.create` 的 `Promise<void>` 是 G08a 前待收斂的輸出契約；本關不猜 QR DTO。D156 formal clean `sourceCommit` 屬 G12 release 規則；本報告只記錄 working-tree SHA／檔案指紋，不冒稱 clean commit。
