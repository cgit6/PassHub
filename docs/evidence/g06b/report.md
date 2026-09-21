# G06b Source 認證／安全 facts primitive — 限定 gate evidence

## 判定

G06b Source-auth／安全 facts primitive gate **PASS**。第二輪架構 review **PASS**；independent tester final gate **PASS**。PM另依D42／D61／D122／D145／D150、production contract、兩輪架構結果與tester evidence獨立核對，並在隔離writable temporary workspace以exact Node／Mongo images串行重跑指定驗證。

本關只交付Source credential verification、sourceId-only opaque principal、唯讀Mongo credential reader及internal composition。沒有交付HTTP／Nest controller、route role isolation、Access active／direction業務決策、Event／Presence、管理API、G08、rate／capacity或部署。依25 STOP停止於G06b，下一合法gate為G07a。

## Contract and implementation

- Credential grammar是exact `entry|exit`.`43-char base64url secret`；不trim、不case-fold、不decode-reencode。alias與secret皆由原始輸入精確處理。
- Verifier對raw secret作SHA-256；Mongo保存的credential digest為64位小寫hex，讀取後嚴格解成32-byte Buffer，再以`timingSafeEqual`比對。未知alias、wrong secret及malformed credential對外皆為generic invalid credential；dummy path維持同類摘要／比較工作，但本關不宣稱完整timing-side-channel保證。
- 成功結果只發出由同capability provenance保護、frozen且opaque的Source principal；唯一業務資料是`sourceId`。plain object、foreign capability或偽造值不能作為有效principal。
- Inactive Source仍可認證成功。G06b不讀取或快取active／direction作認證拒絕；後續Access須在當輪交易／可信讀取重讀current active／direction，再執行業務次序及Event／Presence保存。
- Mongo reader只讀credential verification需要的projection，固定`readPreference=primary`與`readConcern=majority`；沒有write、transaction或retry orchestration。
- Auth不import Sources concrete，Sources不import Auth，Access不取得credential／Auth能力；composition僅為internal seam，不暴露於package public surface。
- 錯誤分類為secret-free typed input／credentials／dependency／crypto／reentrant／frozen。錯誤不回顯credential、secret、digest或raw cause。

## Review findings and fixes

第一輪architecture review為 **CHANGES_REQUIRED**：

- hostile Proxy dependency result的`ownKeys`／`get`／`isFrozen`等trap可讓raw Error／secret越過原去敏路徑；
- `createHash`／`update`／`digest`／`timingSafeEqual` intrinsic throw後，verifier未永久freeze。

修正後，`sanitizeVerification`／`sanitizeRecord`完整捕捉dependency-result inspection，統一轉成不帶cause的typed dependency error，且依policy不因dependency failure freeze；`freezeCrypto()`則讓第一次crypto intrinsic fault回typed crypto failure，後續固定回`SOURCE_CREDENTIAL_FROZEN`。第二輪architecture以hostile Proxy及四種crypto fault重驗後 **PASS**。

Independent tester首次77-case suite發現ordinary `{code:'SOURCE_CREDENTIAL_CRYPTO_FAILURE'}` 可偽裝為Auth crypto classification，gate **BLOCKED**（76 pass／1 fail）。修正為`src/shared/internal/source-credential-verifier-error.ts`唯一class identity nominal seam：Sources re-export同一constructor，Auth只從shared/internal取得class並以`instanceof`加exact code分類，不import Sources。plain object及ordinary Error偽造name／code均分類dependency，只有真nominal instance分類crypto。architecture複核 **PASS**；tester final 78/78 **PASS**。

## Exact verification

Pinned images：

```text
node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
mongo:8.0.32-noble@sha256:01354084d2ae665d2e79b79b0cdc50c2c0c98873618912d9a2c8c9cb5c3d24e6
```

Repo內容複製至隔離、可寫的temporary workspace；沒有清除或chown host既有root-owned `dist`。Mongo runners串行執行以避免compose project collision。exact Node內執行：

```bash
npm ci --ignore-scripts
npm run build
npm run test:g06b:unit
npm run test:g06b:integration
npm run test:unit
npm run test:g06a:unit
npm run test:g06a:integration
npm run test:g04a
npm run test:g04b
npm run test:boundary
npm run test:g06a:boundary
npm run test:g06b:boundary
npm run test:negative-compile
npm run test:g06a:negative-compile
npm run test:g06b:negative-compile
npm run test:coverage
```

結果：

- `npm ci --ignore-scripts` exit 0；423 packages／0 vulnerabilities；Node `v24.21.0`、npm `11.19.0`。
- G06b unit：1 suite／**78 tests passed**；G06b true Mongo：1 suite／**4 tests passed**。
- Full unit：11 suites／**355 tests passed**。
- G06a unit：1 suite／**88 tests passed**；G06a true Mongo：1 suite／**5 tests passed**。
- G04a true Mongo：1 suite／**9 tests passed**；G04b true Mongo：1 suite／**57 tests passed**；Mongo runners均使用exact Mongo 8.0.32單節點`rs0`並在測後teardown。
- G03c boundary：`selected=25 edges=59 forbidden=0 directRawComparison=0`；G06a boundary：`files=16 edges=28 forbidden=0`；G06b boundary：`files=47 edges=97 forbidden=0`。
- G03c、G06a、G06b三組negative public-surface compile均exit 0，所有預期反例被消耗；build／typecheck exit 0。
- Coverage：11 suites／355 tests passed；aggregate **58.72% statements／61.48% branches／55.57% functions／61.11% lines**；`source-auth.ts` **97.46%／95.83%／100%／98.50%**；`source-credential-verifier.ts` **96.00%／93.87%／94.11%／97.05%**。coverage是觀察值，不是release threshold或requirement完成率。
- Probable private-key、AWS key及credentialed Mongo URI pattern secret scan無命中；host `git diff --check` exit 0。

一次非正式host-style G04a setup在temporary workspace遇到root-owned `dist` EACCES，尚未選取或執行測試；清理Mongo後，正式驗證改為上述exact Node writable-container流程並完整PASS。此setup failure不列入正式case計數。

## Source fingerprints

基準Git commit為`8403a36`；以下為working-tree fingerprints，不冒稱clean source commit：

```text
package.json                                                        9e81068ec05e2119633b28430bd1a91c561f526c95a7c8841d8b008ed1ce1301
package-lock.json                                                   70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b
jest.g06b.unit.config.cjs                                           aba8d327ba2ceeccc86e830221ef4bb18dccb9a3f48838ba2a95e864cf05f86b
jest.g06b.integration.config.cjs                                    b1a4dc94b3d26ef507a0b4accfa49e1b39afca99bbb0e157222533953b49c1a5
scripts/test-g06b-integration.mjs                                   e9fbbeb645c4cf6fc240027114b5a405913d4f301fdcdc80643b4cfb2b6aa70c
scripts/check-g06b-boundary.mjs                                     f287920716a08045adc519dbce43483a215b3b64fc6bcbbf5186b90fbc82ffe5
scripts/check-g06b-negative-compile.mjs                             bcb92e092023571db0dc4a531d2429a8ced8b3c6bd5e22e93d3826fe002078dd
src/auth/application/source-auth.ts                                 04ddfa72b2bf319871bbc330684313eabcad8375a4f8af7e7fd515846b1fa2ce
src/auth/domain/source-auth-error.ts                                f56a46c487170966f415bec0a07a5d3e85cb66e36d9b1c210552f2f0ca5953cf
src/auth/domain/source-principal.ts                                 eb0252a1fc3ed32ff6cb337e77527738bee236fecb44121ba2c48364af65627a
src/auth/ports/source-credential-verifier-port.ts                   3fcf3f5bc9ee1aeff475c1df61c85333f276d993705cee1b4c76ffc009df9b0c
src/sources/application/source-credential-verifier.ts               e1f36b2adef4ce7933d708469b5d7bf21b88c88f85318e568c66592f54eb650f
src/sources/infrastructure/mongo-source-credential-reader.ts        9c87741620dca45d0b2c3a2061c264571de2c2053fcb5721a3d373fc99d485bb
src/sources/ports/source-credential-record-reader-port.ts           a4fb66588a13951d28e5081bc99414c67ee3c79f694b6866f634325943afbfbb
src/sources/ports/source-credential-verification-port.ts            a2f67962bac6719c54beea0c4d1cb075f4bc3518011b471bb5c93d8f7245fb32
src/composition/internal/source-auth-composition.ts                  c390ebbd67dfc695f9f2e2529625ca36a616b8ffe355e88876d2194f75500689
src/shared/internal/source-credential-verifier-error.ts             b7efd60c8432041e167268098cbdbc1ffa01839682e7e65e90e7fda4c17c4fec
test/unit/g06b-source-auth.test.ts                                  830140909a44799d87073bd9dcddc07f51c49c13dc07b726b8a605da4be32841
test/integration/g06b-source-auth-mongo.test.ts                     45b61130b690470ff11bb93cff261953d1ffd95c3b3d8829d802bc54b938c232
test/negative/g06b-public-surface.ts                                c8ce46e5f62be0d23e104f451ed120c295ea4d198b05158b1800897e2636b881
```

## Requirement disposition and limits

完整requirement V維持 **10**：A01（既有）＋A11–A16、B13、B41、B42（G04b新增9）；完整requirement U維持 **126**。G06b不新增完整requirement V。

- **B22–B28**：Source credential primitive已有直接evidence，但HTTP route、Operator／Viewer isolation、同步準入、Access當輪current active／direction重讀與業務順序尚未驗，逐項維持U。
- **A06–A07**：Auth／Sources ports、nominal internal seam與static boundary已有局部evidence，但完整runtime composition、HTTP及Access use-case wiring未驗，維持U。
- **M03**：reader與secret scan通過不等於deployment secret separation、rotation或完整秘密生命週期，維持U。
- **E06**：本gate測試完整通過不等於136-row完整e2e／故障矩陣，維持U。
- 其餘所有要求依既有矩陣維持U；本關不把credential verifier、opaque principal或Mongo reader擴張成HTTP、role isolation、rate／capacity、完整timing-side-channel、Event／Presence、deployment或完整v1。

## Stop and handoff

依25 STOP，停止於 **G06b**。下一合法gate為 **G07a bounded raw／JSON前置入口**；本次不開始G07a、不做HTTP、Access business decision／Event、管理API、G08或部署。
