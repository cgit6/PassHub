# G07a bounded raw／JSON 前置入口 — 限定 gate evidence

## 判定

G07a bounded raw／JSON ingress gate **PASS**。第二輪架構 review **PASS**；independent tester final gate **PASS**。PM另依 D146–D151、production contract、兩輪架構結果及 tester evidence 獨立核對，並在隔離 writable temporary workspace 以 exact Node image 重跑指定驗證。

本關只交付 Nest／Express 前方的 bounded raw ingress、嚴格 JSON object parser 與唯一受限 Node HTTP server seam。它沒有交付 G07b 同步準入／分池／existing-only／FIFO 等待生命期，也沒有交付認證路由、rate limit、controller、use-case、Access Event／Presence、Mongo driver、G08、G10、G11 或部署。依25 STOP停止於G07a；下一合法gate為G07b，本輪未開始。

## Contract and implementation

- `createPassHubHttpApplication()`以 `bodyParser:false` 建立 Nest application；`BoundedExpressAdapter.initHttpServer()`建立、登記並回傳唯一 Node HTTP server。server固定 `headersTimeout=5_000`、`keepAliveTimeout=5_000`、`keepAliveTimeoutBuffer=0`、`maxConnections=64`；`getHttpServer()`、回傳server、`app.listen()`及`app.close()`操作同一實例。
- ingress middleware在第一個應用觀察點即固定5秒deadline。reader取得後只排剩餘時間；header／query／media檢查或reader等待不能重啟upload預算。reader上限16，第17個同步回`503`並關閉連線；reader／timer／buffer在成功、拒絕、timeout、abort、同步throw及async reject路徑exact-once清理。
- body上限16,384 bytes，使用固定大小buffer；16,384接受、16,385拒絕。`POST`／`PATCH`需要body，其他method若有framing body即拒絕。本關只接受exact JSON media type；`Content-Encoding` absent或exact `identity`接受，其他值拒絕。
- raw duplicate ownership檢查涵蓋 `content-type`、`content-encoding`、`authorization`、epoch及retry-mode headers；不依Node合併後header值判斷。query以嚴格percent／UTF-8 decode後判斷重複名稱。
- parser使用fatal UTF-8解碼，拒絕leading BOM；只接受root object，最多兩層object、不接受array，再由原生`JSON.parse`覆蓋完整grammar。duplicate key依每個object scope、以cooked property name判斷；結果freeze後才交給downstream。
- ingress error回覆只有固定`{code}`且`Cache-Control: no-store`，不回顯body、header、query、secret或raw downstream cause。完整parse及handoff後client close不取消downstream；本關不把handoff冒充G07b admission或FIFO登記。

## Review findings and fixes

第一輪architecture review為 **CHANGES_REQUIRED**，有三項精確finding：

1. 原 `http-application` 先讓 Nest／Express adapter建立內部server，又另行`createServer`，造成`getHttpServer()`不等於回傳server；`app.listen()`使用未套limits的隱藏server，`app.close()`也關不到回傳server。修正為 `BoundedExpressAdapter` override `initHttpServer()`，建立且`setHttpServer()`唯一受限server；factory回傳`getHttpServer()`。真實 identity／listen／close測試通過。
2. 新 `http-application.ts`及internal index被舊G06b boundary遞迴納入composition/internal，誤觸G06b排除feature。修正G06b boundary選檔為明確 `source-auth-composition.ts` 加G06b實際範圍；重驗仍為`files=47 edges=97 forbidden=0`，沒有放寬G06b production邊界。
3. 原upload 5秒timer在header／query／media檢查與reader acquisition後才開始，不符合application observation起算。修正為middleware首行以`performance.now()`固定deadline，取得reader後只排remaining時間；真HTTP慢body約5,011ms回`408`且reader歸零。

首輪其餘 query／body scope、downstream去敏、hostile reader／parser及build檢查均通過；上述修正後第二輪architecture review **PASS**。

Independent tester一次非正式初跑在64-connection case後立即teardown，出現1個測試端socket清理競賽（33／34），不是production assertion失敗。test-only修正等待`connectionCount===0`後，final e2e擴充為41／41；本PM exact rerun亦為41／41。

## Exact verification

Pinned image：

```text
node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
```

Repo內容複製至隔離、可寫的temporary workspace；host production／tests／package未由PM修改。exact image內Node為`v24.21.0`、npm為`11.19.0`，串行執行：

```bash
npm ci --ignore-scripts
npm run build
npm run test:g07a:unit
npm run test:g07a:e2e
npm run test:g07a:coverage
npm run test:unit
npm run test:coverage
npm run test:boundary
npm run test:g06a:boundary
npm run test:g06b:boundary
npm run test:g07a:boundary
npm run test:negative-compile
npm run test:g06a:negative-compile
npm run test:g06b:negative-compile
npm run test:g07a:negative-compile
```

結果：

- `npm ci --ignore-scripts` exit 0；423 packages／0 vulnerabilities；build／typecheck exit 0。
- G07a strict JSON unit：1 suite／**32 tests passed**。
- G07a true Node／Nest／Express e2e：1 suite／**41 tests passed**；包含約5,010ms慢body、約5,189ms headers timeout及約5,007ms keep-alive timeout的真socket觀察。
- G07a combined coverage：2 suites／**73 tests passed**；**88.50% statements／77.96% branches／87.75% functions／93.27% lines**。
- Full unit：12 suites／**387 tests passed**。Full coverage亦為12 suites／387 tests，aggregate **55.21% statements／58.16% branches／52.93% functions／57.69% lines**。coverage只作觀察，不是requirement完成率。
- G03c boundary：`selected=25 edges=59 forbidden=0 directRawComparison=0`；G06a：`files=16 edges=28 forbidden=0`；G06b：`files=47 edges=97 forbidden=0`；G07a：`files=4 edges=13 createServers=1 directListens=0 g07b=0 publicLeaks=0 forbidden=0`。
- G03c、G06a、G06b、G07a四組negative public-surface compile均exit 0，所有預期反例被消耗。
- G07a tests覆蓋fatal UTF-8、BOM、depth／array、native JSON grammar、per-scope cooked duplicate keys；16,384／16,385 bytes；media／encoding；五個owned raw duplicate headers；decoded query duplicates；absolute upload deadline；16 readers／第17個503；abort／exact return；64／第65連線；headers／keep-alive timeout；唯一server identity；redaction／no-store；同步throw／async reject。
- probable private-key、AWS key及credentialed Mongo URI pattern的唯讀scan無命中；最終host `git diff --check`另於文件同步完成後執行。

## Source fingerprints

基準Git commit為`8403a36627307a8eefc012710c6fa3700ab95134`；以下為受測working-tree fingerprints，不冒稱clean source commit：

```text
src/shared/internal/http/strict-json-object.ts                     ac6235124c80bfbd47ec324ace2f094536c0e6dbc11bdc295ccab41f212c3285
src/shared/internal/http/bounded-json-ingress.ts                   57333b1e045452413a92a705b1471f173a8235fe7c52f44b52640e8943b879c3
src/shared/internal/http/index.ts                                  28e567b3db93d96fdf7e0af4a366366110185915a0531699138515e1ed13d375
src/composition/internal/http-application.ts                       d90320fb87ab5b13bab033ce59ec3c2bb842fc7aa081d54b24b2d2c87e1fe04b
src/composition/internal/index.ts                                  2c9487b49bce8b317c56a6fb408bf7b17ba4ab7ef255606745d5914fadfcecc1
test/unit/g07a-strict-json.test.ts                                 c4e9e2c4e066529048b162bff72dfdae4b3f723a98f1dfb27949468bb2e58d5e
test/e2e/g07a-http-ingress.test.ts                                 1dbba287139b0511f903286562177af1282319fe8b44e868b6def8e9ddf1d027
test/negative/g07a-public-surface.ts                               566f195721bbd0a001ff27e681602ac4dccd21871066d1d0ad6e9d0eaccf9be7
scripts/check-g07a-boundary.mjs                                    985e807ce6ab20d9dc55b199c771dedd3a44bb92e9eaefce94e1f381754fbfda
scripts/check-g07a-negative-compile.mjs                            06204e8c2497e0e1bf18a282003c6647c63bea7cbebfe51650ad826542e6fde1
jest.g07a.unit.config.cjs                                          b7e644deb478b6a8ce0cf726a411ab0adeb3268f93064806aa0df6738f7490b8
jest.g07a.e2e.config.cjs                                           ba61bff30f28fa9c2ab362866aadc374465f6d737d39d47715ab8aea909697fc
jest.g07a.coverage.config.cjs                                      1ecc5fc3b00ac2c031a515ba0b12ee57c4850cb241f889d0474aab8aeaace721
package.json                                                       a6e7ef85cb696780912d9dfa03afe04fd25005d30c031e2de8c24cdb215c3b53
package-lock.json                                                  70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b
tsconfig.json                                                      b3b50b1fbb675b7c5960b103c6937faaaba0cf46c024866b885e8791f69d608f
```

## Requirement disposition and limits

完整requirement V維持 **10**：A01（既有）＋A11–A16、B13、B41、B42（G04b新增9）；完整requirement U維持 **126**。G07a不新增完整requirement V。

- **B04、B50、B52**：raw ingress與去敏錯誤已有局部證據，但完整API envelope、回覆owner、認證後Event detail及其端到端行為未完成，維持U。
- **L01、L24–L35**：body／reader／連線／timeout等G07a切片已有直接證據，但G07b admission pools、rate limits、validation／scrypt／query／canonical資源、完整operation lifecycle與deployment proxy仍未完成，逐項維持U。
- **M04**：Node server本地limits已證，不等於trusted proxy、部署入口、來源IP或公開runtime完成，維持U。
- **E01、E06、X01–X11**：本gate unit／true HTTP e2e／negative／boundary通過，只能支持G07a局部contract；完整API e2e、全136要求、故障、維護、部署與release證據尚未完成，逐項維持U。
- 本關不證G07b同步準入／FIFO／existing-only／一次回覆owner，也不證Auth route、rate limiting、controller／use-case、Access Event／Presence、Mongo、transport-loss、maintenance或完整v1。

## Stop and handoff

依25 STOP，停止於 **G07a**。下一合法gate為 **G07b 同步準入與HTTP等待生命期**；G07b尚未開始，本輪不修改production、tests或package。
