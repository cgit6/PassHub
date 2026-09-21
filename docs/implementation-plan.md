---
artifact_type: socratic-knowledge
schema_version: 2
id: "20260919-passhub-implementation-plan"
title: "PassHub v1 實作契約與逐關驗收方案"
status: settled
verification: partially-sourced
mode:
  - D
  - E
topics:
  - "modular TypeScript backend"
  - "atomic access decisions"
  - "bounded operation lifecycle"
  - "MongoDB transactions"
  - "requirement traceability"
  - "demo maintenance"
aliases:
  - "PassHub 實作入口"
  - "PassHub 逐關驗收"
created: "2026-09-19"
updated: "2026-09-21"
---

# PassHub v1 實作契約與逐關驗收方案

## 快速檢索卡

- 核心問題：把已採用的業務與架構討論交給實作者，避免自行補架構、丟要求或用測試數量取代證據。
- 當前結論：P01–P15規劃已收斂；G02–G03c、窄 G04a、G04b、G05a FIFO primitive、G05b budget ledger、G05c registry primitive、G06a human-auth primitive、G06b Source-auth／安全facts primitive、G07a bounded raw／JSON ingress及G07b同步準入／HTTP等待生命期已有各自限定證據並通過 gate，依25 STOP停止於G07b。A01、A11–A16、B13、B41、B42 共10項為V（G04b新增9項；G05a／G05b／G05c／G06a／G06b／G07a／G07b不新增完整requirement V），其餘126要求仍U，完整v1仍未完成。
- 關鍵爭點：G04a 真 Mongo 8.0.32 已證明窄 face reverse-unique release/reuse 交易情境；G02只證工具鏈可用，不證API、模組接線或完整交易 adapter。
- 適用於：單API／單logicalplace／單次Qualification／QR或模擬Face的公開共享sandbox；Nest預設Express、strictTS、官方Mongo driver。
- 不適用於：真實人臉辨識／硬體門禁、多據點／多租戶、多API、跨崩潰／reset續辦、正式SLA或業務復原。
- 待驗證：正式G06 Auth route、G08 management／recognition用例、Event／Presence／Mongo接線、G05b/G10/G11整合、clean install、Docker、CI、fault、perf、reset及publicHTTPS。既有各gate限定證據不等於完整v1工程通過。

## 核心問題

作品保留「辨識輸入→映射單次資格→決策→共同保存→安全查詢」閉環。Presence是資格使用狀態，不是真人身分或位置證明。工程品質以責任隔離、真DB原子性、有限故障控制及可重跑證據呈現，不靠增加產品業務。

讀取順序：此文件→[業務規格](business-scope.md)→[136要求矩陣](requirements-traceability.md)→[原始討論](discuss.md)相關D段。此文件是實作入口／索引，不取代D原文的細節。歷史候選不能直接採用；衝突按明確最新採用，不按「最後出現一句話」猜測。

## 形成的知識

### 1. 固定來源與技術基線

直接依賴精確版本、未來lockfile／npm ci、linux amd64驗收；相容性未實測。（D125）

| 項目 | 採用值 |
|---|---|
| Node／TypeScript | 24.21.0 LTS／5.9.3 |
| Nest core/common/platform-express/testing | 全部12.0.3 |
| Express／Nest JWT／jsonwebtoken／Swagger | 5.2.1／12.0.2／9.0.3／12.0.1 |
| Mongo driver／server | 官方7.6.0／8.0.32 |
| 編譯 | CJS、module=node20、target=ES2023、strict、legacy decorators/metadata |
| 測試 | 正式unit runner為Jest 30.5.2（`@types/jest` 30.0.0），先編譯後執行JS；`maxWorkers=1`、`detectOpenHandles=true`、`forceExit=false`，Node24 ESM以`NODE_OPTIONS=--experimental-vm-modules`載入 |
| 故障工具 | Toxiproxy v2.12.0；G02解析官方exact image digest並保存後才能有效fault |

固定映像（D125／D155唯讀manifest鎖定，**未pull/run**）：

- node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
- mongo:8.0.32-noble@sha256:01354084d2ae665d2e79b79b0cdc50c2c0c98873618912d9a2c8c9cb5c3d24e6
- nginx:1.30.5-trixie@sha256:f91bdb7aee4cba26f89b1c5c3aa12742ec3c91c6d70fd7007c6dc797e9676c45
- ghcr.io/shopify/toxiproxy:2.12.0@sha256:9378ed52a28bc50edc1350f936f518f31fa95f0d15917d6eb40b8e376d1a214e（index）；linux/amd64 子映像 sha256:a3e244375123dad8849091bcc59775e188624d3f602db01901f9af855682fef8

### 2. Repository、模組與能力

同一Git／一root npm package，無workspace／產品前端。未來骨架（D140）：

```text
src/composition/
src/access/domain/
src/access/application/
src/access/ports/
src/access/infrastructure/
src/access/http/
src/auth/
src/sources/
src/shared/
src/demo-devices/entry/
src/demo-devices/exit/
test/unit/
test/integration/
test/e2e/
test/fault/
test/fixtures/
docs/
scripts/
infra/docker/
```

shared只必要技術共用。D161依使用者新決定取代D140私密備份方案：不建立PassHub legacy備份，直接將舊backend/frontend移出工作目錄，保留docs、.git、.gitignore與readme.md。盤點未發現兩目錄指向專案外的連結；系統垃圾桶保留可復原項，但不是另建專案備份。新README.md未建立，root readme.md仍保留。

Demo 裝置端固定拆成兩個獨立 client 模組（D162）：`entry` 只使用預置 ENTRY Source credential，`exit` 只使用預置 EXIT Source credential；兩者各自組裝並送出 QR／Face attempt，不能由執行參數覆寫方向或交換機器身分。它們可共用無業務判斷的 HTTP／序列化工具，但不得複製 PassHub 的映射、資格、Presence 或 reason-code 規則，也不是兩套後端辨識模組。

Access公開窄能力（D141）：

- ManageQualifications.create/update/revoke；無ENTRY/EXIT setter。
- RecognizeAttempt.execute；EXIT包含必要釋放完整行為。
- ReadAccessData.quals/inside/events；只去敏唯讀。
- Auth人員／Source驗證；Sources分CredentialVerificationPort供Auth、SourceFactsPort供Access，Access事實讀取綁當輪交易，不使用Auth快照代判active。
- 管理scope與辨識scope用真正不同wrapper，不type cast萬用service。保存只接受唯一domain政策形成的完整plan，不由infra另寫reason。
- opaque解析handle綁actual scope/epoch/owner/media/qualification/mapping版本及incarnation；錯人plan、fake/crossscope/stale/closed均拒絕。無資格分支不能帶資格變更。
- domain不import框架／HTTP／DB/session；application不直依Auth／HTTP／具體Mongo；composition負責接線。負compile／importgraph／provider runtime三者都驗，不只看資料夾。

### 3. 資料與共同保存

六collection（D142–D145）：qualifications、faceSlots、events、users、sources、metadata。業務_id與incarnation server UUID，metadata _id="system"單例例外；version非負safe integer且overflow阻擋；日期BSON Date，nullable欄必存null。完整欄位及cross-shape以D145為準，不能把此摘要當刪欄授權。

- quals保存名稱、區間、createdBy、lookup digest、Presence、入離場／撤銷／明確逾期終結時間及原因、created/updated。自然時鐘逾期不自動生成終結事實；不偷加exitedAt≥enteredAt牆鐘假設。
- faceSlots是目前映射唯一權威；provider/subject精確原值，qualificationId/incarnation同null或同scalarUUID；slot incarnation/version。unique(provider,subject) simple；反向unique qualificationId的partial filter為$type:string。array／missing禁止，不拿partial index代shape驗證。
- **G04a先真Mongo8.0.32測同txn清舊引用→新槽重用同qualificationId**，另多空槽／雙綁／回滾。未過停止回討論，不撤索引或默換guard。
- faceSlots總4096含empty，管理新subject才allocate；日間不刪，釋放留槽；陌生MATCHED與UNKNOWN不allocate。新subject容量滿507 FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED／retryable=false，解綁不回收；count與新槽共同保存，boot核數不heal。
- 成功及依可變事實拒絕真增Source／slot／qual版本；缺QR與建立共寫QRkeyspace guard，缺FaceMATCHED與綁／釋放共寫metadata facekeyspace guard。snapshot／unique／no-op／FIFO均不取代guard。
- Events不可變，Source+externalEventId唯一；可空qual ID；共同保存HMAC/ref與Event、必要Presence／mapping／guard。無Event不得回成功，拒絕Event保存失敗也不得冒稱已稽核拒絕。
- 共同client/session、順序操作，不Promise.all。Core API，不withTransaction；retryReads=false/retryWrites=false/maxAdaptiveRetries=0，不冒稱隱藏方法重送已消失。
- 交易 snapshot/primary/WC majority+jtrue；canonical majority/primary。boot核journal/committed reads/actual majority。腐敗、孤兒、錯incarnation技術阻擋，不選一個或自修；普通版本衝突另分類安全重讀。

### 4. 識別、比較與認證

D117／D119／D120／D122／D145是精確codec來源：

```text
["PassHub/idem/v2","QR_SCANNED",[n,token]]
["PassHub/idem/v2","FACE_MATCHED",[n,provider],[m,externalSubjectId]]
["PassHub/idem/v2","FACE_UNKNOWN"]
```

n/m為原字串UTF8byte長度，server dense array JSON.stringify→UTF8→HMAC-SHA256，frame≤1024bytes，原值不trim/casefold/normalize。Source/eventID是外部鍵不在frame；time/resolvedID/result不在輸入比較。digest/reference由單一凍結能力共算保存。

| 欄位 | 契約 |
|---|---|
| QR發行 | 32 random bytes，unpadded base64url，43chars，成功建立只回一次 |
| QR輸入 | [A-Za-z0-9_-]{1,128}，opaque不decode／不必43；合法未知QR留拒絕Event，格式錯不留 |
| provider | [A-Za-z][A-Za-z0-9._-]{0,63} |
| eventID | [A-Za-z0-9][A-Za-z0-9._:-]{0,127} |
| subject | ≥1codepoint／≤256UTF8bytes，禁C0/C1/U2028/U2029及unpaired surrogate；其他空白可且精確保留 |

lookup＝SHA256(UTF8("PassHub/qr-lookup/v1")+NUL+原token)。digest hex64小寫，timing compare用32-byte Buffer，不存原token。

人員JWT HS256 TTL900，僅sub/iat/exp/iss="PassHub"/aud="human-api"，iat整數≤now、exp=iat+900且>now，strict algorithm/issuer/audience/maxAge。async scrypt N131072/r8/p1/len64/salt≥16bytes/maxmem268435456。每次核目前enabled角色，無refresh/logout。Source alias.secret中secret32randbytes43base64url，以原secretSHA256與32-byte timingSafeEqual核；alias未可信。JWT/HMAC/DB/維護secret獨立注入，ordinary restart不換。metadata獨立literal framehex+knownHMAC vectors、referenceID及existing missing/mixed核對，failclosed，不用同codec再算答案假證正確。

### 5. 時間、有限處理與未知

完整body＋同步basic JSON／完整資源準入後固定receivedAt/序號，**在async Auth之前**；provisional FIFO慢Auth也不可後撤銷超車。相關寫入一完整owner FIFO，唯讀/login不全排。（D146–D149）

| 類別 | 待測初值／邊界 |
|---|---|
| HTTP | 每次5s含Auth/queue；一response owner；不取消原項／補額度 |
| 執行 | 原項首次完整owner起15s／含首次最多3輪；初排隊不算、之後全部等待算 |
| 確認／清理 | 最早未知或確需precommit清理起10s／7格；跨輪/重送不刷新 |
| native precommit abort | 窗口內且≥2格準入、預扣2不退／獨占，兩送共用2000ms；已準入第二送可跨窗、無組內1/2s間隔 |
| unknown commit | 立即原commit→失敗1s canonical→失敗2s原commit，此後2s交替、單call串行、單送1格 |
| command timeout | session2000ms；CRUD及首次commit min(2000,exec剩整ms)；canonical min(2000,confirm剩整ms)；<1不發且不傳0；確認commit固定2000且窗口至少剩2000 |

先封scope禁新業務→收束已發→核phase/owner→licensed abort→受控endSession；本地active時不能無條件finally另abort。缺label也可能unknown。結果出口可以是可信完整canonical，或原txn充分無效果；**兩個出口要放後項，都另須確認全部舊工作不會影響／scope封閉／無晚寫，以及目前owner、同程序資料世代、服務許可及無manual/maintenance否決**。canonical先提供回放不等於可放後項。精確原nonsharded txn server112/11000終止且從未發commit只是無效果複合判據中的證據；NoSuchTransaction/label/Promise/localstate/查無/停程序單獨不足。（D129–D137）

晚canonical回放非再次授權；安全且同process/epoch/owner、執行仍有效、無current manual/maintenance veto依D89續辦；D130永久技術終局候選未採。unknown無證保護相關writes。executor到限只禁新業務，不當rollback；充分無效果/no late且安全收尾、exec耗盡才safe technical terminal。

registry4096含inflight/unknown/canonical/safe terminals，日間無TTL/evict；每新candidate整組reserve，verifiedjoin返自身。所有相關writes/recognition retry必原epoch；old epoch拒絕，不自換新epoch續舊操作。metadata writeRunClaim使用後正常stop不清；**同dataset普通restart不得開寫**，只安全有限readonly canonical回放，查不到未能判定。private fullreset新epoch才重開。（D149）

### 6. API、raw入口與資源

十業務API（D150）；不是開發完成：

| method path | 權限／輸入 |
|---|---|
| POST /auth/login | anonymous username/password |
| POST /qualifications | Operator displayName/validFrom/validUntil/face |
| PATCH /qualifications/:id | Operator上述四欄非空subset |
| POST /qualifications/:id/revoke | Operator reason |
| GET /qualifications | Operator/Viewer limit/cursor |
| GET /qualifications/inside | Operator/Viewer limit/cursor |
| GET /qualifications/:id | Operator/Viewer detail |
| GET /events | Operator/Viewer limit/cursor/qualificationId/outcome/reasonCode |
| GET /events/:id | Operator/Viewer detail，含無資格Event |
| POST /recognition/attempts | Source三互斥DTO |

create face必有null或provider/externalSubjectId物件；patch omitted keep/null remove/object replace。辨識僅externalEventId/kind，加QR token或MATCHED provider/subject，UNKNOWN無附資料。嚴格unknown/duplicate拒絕。displayName1–128UTF8bytes/reason1–512，wellformed禁既定controls、不trim；password1–128原值。日期僅valid YYYY-MM-DDTHH:mm:ss.SSSZ roundtrip。

所有相關writes/retries需PassHub-Dataset-Epoch（missing/malformed400、mismatch409）；辨識PassHub-Retry-Mode:existing-only專用不能升新。login/query/admission errors提供currentepoch，不新建metadata管理API。

- recognition200只有完整保存Event投影，ACCEPTED或REJECTED及replayed boolean；true不是第二次放行。
- trusted202：原externalEventId/receivedAt；stage QUEUED/RUNNING/CONFIRMING/PAUSED_UNKNOWN，confirmationState NOT_STARTED/ACTIVE/EXHAUSTED，control NONE/MANUAL/MAINTENANCE，不帶outcome。
- unverified/unconfirmed503 REQUEST_STATUS_UNCONFIRMED；readonlyrestart查無503 CANONICAL_RESULT_UNCONFIRMED，無不存在/失敗主張。
- safe exec耗盡terminal503 OPERATION_EXECUTION_EXHAUSTED/terminal:true，不是AccessEvent reason或業務REJECTED。
- 技術400/401/403/409/429/503；Face新槽滿507；create201含唯一qrToken、update/revoke200安全摘要。
- management**無冪等或progress API**；lostcreate response不能取回QR，盲retry可能新增資格，不能教自動retrycreate。
- 共用安全Event投影：eventId/sourceId/direction/kind/outcome/reasonCode/receivedAt/recordedAt/nullable qualificationId/presenceTransition；DBreason映reasonCode。qual投影保留矩陣B48完整摘要／有效faceBound，不刪撤銷原因／時間。

Nest bodyParser:false，composition app.use raw receiver在init/listen之前；不把rawBody:true和停parser混搭。自有functional入口非自動DI/filter。16KiB／絕對upload5s；fatal UTF8且BOM保留後明拒。depthfilter（非完整parser）先於native JSON.parse，再cookedduplicate keyscan；rootobject最多2objectlayers，business body任何array拒。Content-Type application/json僅optional charset UTF8，Encoding absent/identity，其餘415。Owned headers及decodedquery重復拒、不merge。req.close不當abort，res.close僅自身HTTP owner，finish非clientreceipt。（D147／D151）

待測限制（D146／D148／D149）：connections64/rawreaders16；origin32；validation普通write4/login1/query1＋retry2；HTTP普通28＋retry4不借；scrypt1無queue、queryDB1、canonical replay2、originalconfirm1獨立串行；真工作未收束不因HTTP終結還額。registry4096／faceSlots4096獨立。fixed-minute login IP5/global20、query account60/global120、recognition Source30/global60、management account10/global20；IPmap256去過期不evictlive。既有原項不因retry限速取消。Header/keepalive候選5s在G07a核API/ranges/coverage，不冒稱已全部硬保證。

### 7. 查詢、效能、日志與私密控制

D152三list keyset：quals createdAt/_id DESC；inside enteredAt/_id DESC；events receivedAt/_id DESC，3filtersAND。limit預設20/decimal1–100無leadingzero。cursor canonical unpaddedbase64url≤512ASCII：
```text
["p1",epoch,endpoint,qualificationFilter|null,outcome|null,reasonCode|null,lastTime,lastId]
```
endpoint限qualifications/inside/events，前兩filtersnull；綁route/filters/epoch、嚴格格式/roundtrip，old epoch409。這是內部cursorarray，不開business array；不跨頁snapshot，資料改變或晚Event可能需刷新第一頁。query四非unique索引：qual createdAt/_id、qual presence/enteredAt/_id、event receivedAt/_id、event qualificationId/receivedAt/_id；保留唯一約束。

isolated performance10000qual/40000Event合法fixture，八種filter組合每種各固定matched/selectivity/params、first+fixednext，每個10warmup100measure，raw/p50/p95與獨立explain keys/docs/execution/env/hardware/fixture/code hash；before-after只變query非uniqueindexes，不預設改善，負結果照報。

D153 allowlist logs：request/operation UUID、epoch/run/owner/phase/round/group/budget/fixedcode，不dumpcommand/reply/drivererror/body/fullsubject/secret/hash。128records×≤2KiB，5files×10MiB/private0700/0600，best-effort drop＋LOGGING_DEGRADED非必要Event失敗；host-only logs:read按operationUUID。

private Unix socket 0700dir/0600socket：status/hold/release/drain。hold先同步revision/veto屏障才ACK，每尚未交driver步驟currentpermission重核，核→pending登記→driver call不await；已交含driverqueue仍可能晚wire，不聲稱撤回。release只自身control/epoch/run/revision，不解unknown/maintenance/補額度。current-last replay bounded，舊revision拒絕不重做，無歷史無界cache。drain不證DB隔離。

### 8. 真fault驗收與部署維護

D138–D139 fault opt-in isolated testDB、真HTTP/driver/server，observer direct readonly snapshot txn共同看Event/Presence/Mapping/slot/version before-after、majority確認，不由單筆順序讀假部分保存。Toxiproxy全appMongo地址（含replsetdiscover）經proxy；commit barrier hangBeforeCommitingTxn→drop downstream→解除barrier確認→observer共同snapshot確定after→app真unknown→remove drop→原canonical replay。server HostUnreachable reply不是回程loss；SDAM繞路/heartbeat使未commit/observer傷/barrier未解均invalidfail，不能pass。finite snapshots結合原子性來源與fault位置，不當allmoments證明。production無failpoints/故障控制服務。

D154–D155 LinuxCompose oneAPI、Mongo singlemember replica set非HA、NGINX HTTPS。host/domain/cert用戶環境前提。host初2vCPU/4GiB/20GiBfree，API768MiB/Mongo1536MiB/proxy128MiB未量測。無API/DBhostports／DockerSocket。固定proxyIP/32，overwriteXFF remoteAddr；requestbuffering off/HTTP1.1/nextupstream off/body16KiB/readsend15s非wholedeadline。marker公共503。

每日外部systemd OnCalendar=*-*-* 03:00:00 Asia/Taipei、AccuracySec1s/RandomizedDelaySec0/Persistentfalse，漏排不白天補清庫；需時間sync/tzdata/triggergate。固定local flock exclusive nonblocking、不unlink inode。runbook：

1. host lock／persistent marker封公網。
2. private drain最多30s；逾時仍進安全停機，不跳隔離。
3. 停既定唯一API，核舊process消失；不因此推DB舊workgone。
4. 停Mongo核舊DBprocess消失，重啟journal恢復完成PRIMARY。
5. **只passhub_demo六collection** sequentialdeleteMany保indexes，seed穩定公開假credentials、新epoch/nullclaim/獨立vectors。部署秘密保持外部管理且不換，不存入seed或資料庫；不dropDB/volume/其他DB，seed非全庫原子。
6. 私密一次runTicket限定新epoch/processRunId：bootstrap檢配置/PRIMARY/schema/index/shape/vectors/claim，不要求ready、不做業務。
7. bootstrap過才私密授權該run、localready，host marker仍封；成功handoff才開公網。
8. 停止/恢復/clear/seed/claim/startup/ready任何未知失敗維持veto/APIoff/marker；額外writer或未知container不盲停/越步。ordinarysameEpochrestart關寫，不靠空庫自heal。

API/Mongo SIGTERM grace30s，API無自動restart；stoprequest/graceexpiry不是消失證據。NGINX access_logoff/error /dev/null、Mongo不收原始query/command/profiling、Demo logpath /dev/null候選及container/controller去敏；knownsecret掃描覆全表面。取捨是不提供原始代理/DB診斷，有限scan非永不洩漏保證。

### 9. 固定25個STOP點

前關通過才進表後關，每子關交差異／要求D／command exit／指紋／真情境證據及覆核即停止。失敗、不相容、無效fault、缺證立即停；不auto還原使用者檔案或fallback。G04a／G04b敗必回設計討論。**G00、G01a/G01b、G02、G03a、G03b、G03c、窄 G04a、G04b、G05a、G05b、G05c、G06a、G06b、G07a及G07b已有本輪限定局部通過證據；目前停止於G07b。**

| Gate | 單一交付責任 | 未來代表驗證／artifact |
|---|---|---|
| G00 | 規劃文件同步及136 trace獨立audit | 文件diff／來源逐項覆核；此關只文件，不證工程 |
| G01a | 依D161盤點直接清除範圍，不另備份 | 已驗backend/frontend為目標、無外部連結；docs/.git/root文件排除，使用者接受不另作專案備份 |
| G01b | 移出舊backend/frontend並驗證保留項 | 已驗原路徑不存在；docs四文件、.git、.gitignore、readme.md存在；trashinfo記原路徑／時間 |
| G02 | 鎖版package／編譯／測試工具基線 | 精確Node 24.21.0映像中npm ci／build／Jest 5 suites/26 tests／coverage全綠；17直接套件與lock一致；Toxiproxy 2.12.0 amd64 exact digest實跑 |
| G03a | 唯一純domain規則 | Jest domain 14 tests全綠，含未知presence／非string reason／未知direction與resolution／非boolean sourceActive；純度掃描維持0違規 |
| G03b | 固定編碼／摘要與啟動向量 | Jest comparison 11 tests全綠，含非string識別值、null／未知kind與startup config corruption；獨立literal vectors保留 |
| G03c | 窄scope／handle／composition | Jest 6 suites／37 tests；boundary selected=18、edges=40、forbidden=0；negative compile、runtime wiring及package public-surface resolution均通過；fake ports限定證據 |
| G04a | Face反向unique替換微型阻塞 | 真Mongo8.0.32 integration face-index／同txn release-reuse、空槽、失敗回滾 |
| G04b | 完整原子保存adapter | PASS：真Mongo 8.0.32 `1 suite／57 tests`；六 collection schema／integrity、共同snapshot、成功與拒絕 freshness、QR／Face解析、comparison artifact、Event unique／replay／conflict、session／transaction／error分類 |
| G05a | FIFO操作權協調器 | PASS：exact Node image、unit 21／慢前項不超車、settlement／owner／fail-closed boundary |
| G05b | 執行／確認共同預算 | PASS：exact Node image、unit 80／15秒3輪、10秒7格、native兩送、continuation、capability fail-closed |
| G05c | registry／epoch／晚callback fence primitive | PASS：exact Node image、unit 51；opaque artifact join／conflict、4096 retention、canonical／safe technical terminal、generation／late callback、epoch／read-only claim、fail-closed trusted boundary |
| G06a | 人員認證能力 | PASS：exact Node／Mongo、unit 88／Mongo integration 5；strict JWT／scrypt／目前角色enabled／opaque principal／primary-majority read-only reader |
| G06b | Source認證／安全facts | PASS：exact Node／Mongo、unit 78／Mongo integration 4；嚴格 alias.secret、SHA-256／32-byte timing-safe compare、sourceId-only opaque principal、inactive auth success、窄接線及 primary-majority read-only reader |
| G07a | bounded raw／JSON前置入口 | PASS：exact Node、unit 32／true Node-Nest-Express e2e 41／combined 73；嚴格UTF8、BOM、深度／重複鍵、raw headers、16KiB／16 readers／64 connections及5秒limits |
| G07b | 同步準入與HTTP等待生命期 | PASS：exact Node、unit 40／true HTTP e2e 5；技術admission composition、分池／rate、existing-only、provisional FIFO、registry reservation／join／replay／conflict、五秒一次回覆owner及unknown handoff |
| G08a | 管理用例及完整保存 | e2e management／建立修改撤銷、QR一次、Face容量 |
| G08b | 完整辨識處理鏈 | e2e recognition／QR Face UNKNOWN、拒絕Event、回放／conflict／並行 |
| G09a | 安全查詢／keyset | e2e query／detail、無資格Event、AND篩選及epoch cursor |
| G09b | 分case查詢效能 | test:perf／固定fixture／八filters、索引前後raw與explain |
| G10a | allowlist日志／私密控制屏障 | integration private-control／有限buffer／rotation、hold release drain許可 |
| G10b | precommit終止／abort完整清理 | 真fault termination／112 11000歸屬、最多兩送、endSession無額外送 |
| G10c | 真傳輸未知確認 | 真fault transport-unknown／precommit未知及commit後回程loss、coherent observer |
| G11 | 部署／reset生命期 | test:maintenance／唯一writer隔離、恢復、精確target、bootstrap ready、失敗off及普通restart |
| G12 | 完整交付證據audit | 全必需套件、OpenAPI／boundary／requirements／cleaninstall、CI／Demo／publicHTTPS及136證據 |

各gate對136IDs見矩陣§10.1；子情境細化見§10，**名字存在不代表覆蓋或通過**。G11不增加業務，只驗部署/reset；G12綜合既有責任，不寫新平臺。不同suite選擇器是將來script傳給Node runner的測試pattern，實作後確認選中數>0及情境符合，不能零測試exit0當gate成功。

### 10. 命令dictionary、期限及artifact

下面是預定scripts，**目前沒有建立或執行**；未來固定由root package提供：

```bash
npm ci
npm run build
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:fault
npm run test:perf
npm run test:maintenance
npm run check:openapi
npm run check:boundary
npm run check:requirements
npm run verify:clean-install
```

suite情境selector：如domain/comparison/scope/face-index/atomic/fifo/budget/registry-owner/human-auth/source-auth/ingress/admission/management/recognition/query/private-control/termination/transport-unknown；scripts需要讓選擇器真正到runner，不copy命令假裝現在可跑。clean install只隔離清潔副本，不清workspace。未來Docker／Demo／private CLI的具體命令在相應gate新增操作文件並驗陌生讀者可重跑，不能因此改業務契約或跳STOP。

| suite | 每case候選秒數 | command total候選秒數 |
|---|---|---|
| unit | 10 | 60 |
| integration/e2e | 60 | 300 |
| fault | 120 | 900 |
| perf | 300 | 1800 |
| maintenance/reset | 600 | 1800 |

testdeadline只fail，不證工作取消/rollback/process已消失；cleanup不得蓋原錯，環境不可證収束就不重用。CI同pins/build/boundary/requirements/unit/integration/e2e/OpenAPI；fault/perf/maintenance具體專項可opt-in，但**完整release必需**，普通green不能免證。

規劃帳本（實作時才建artifact）：

- 私密raw：output/evidence/&lt;runId&gt;/，將來明列gitignore，只準去敏有限trace／結果，不存原token/key/fullsubject。D161未建立舊碼備份或私密inventory。
- 公開去敏報告：docs/evidence/&lt;gate&gt;/，實作時新增必要目錄／report，不在本輪建。包含要求ID、實際code/symbol、test/case、command/exit、env、clean sourceCommit及code/lock/nonsecretconfig/image/fixture hash、secret reference ID非值、remaining issues、reviewer。
- sourceCommit是受測clean code checkout；reportpublicationrevision可不同但核對code/config hashes，避免報告自身SHA循環。dirtyrun只temporary；code/dependency/config/image/fixture變更令相關舊證據失效。
- check:requirements需逐136ID及§10細化map實際test+結果+artifact，負面排除也要審；全U不變成testname存在即R。V須真實重跑、R須獨立讀原需求與code/test。
- G12要求必需fault/perf/maintenance、cleaninstall、Docker斷言Demo、publicHTTPS、OpenAPI、CI及逐136帳本有效同指紋完整；未證不能resume解鎖。pubruntime真實可用前不能宣稱已部署。

## 討論的演化

- D01–D35縮業務；單次資格與Presence明確是獨立作品抽象，不冒充參考系統復刻。
- D59/61/63確定Access內部能力隔離、Auth/Sources分離及依賴方向；D65/67共同txn與單一當前映射。
- D72/76/78保準時完整接收、FIFO／HTTP不取消原項；D89條件式自動續辦不等人工額外批準。
- D114明確本次不斷讨論／每題存驗／默認接受／止於實作前。
- D117 JSON v2替代binaryv1；D129 native兩送跨窗局部取捨；D130較早confirm起點但永久終局候選未採；D131七格。
- D143語法證據不證明sameTxn unique reuse，保先測阻塞；D149 memory/reset epoch/ordinary restart關寫，承認可用性代价。
- D150/151補回既有Eventdetail、確定trusted202/unknown503及嚴格raw入口；D153 hold不撤issued、當前permission非冻結allow。
- D154/155排除bootstrap/ready循環，具體外部停API+DB再恢復清理，漏跑不白天補破壞性reset。
- D156正式證據綁clean source/code等、報告revision可異；D166取代其Node unit runner選擇為Jest並使既有Node unit evidence失效，D157撤回大原型，25固定逐責任STOP。

## 邊界與未解問題

規劃已採用不等工程證明。明確待gate而非暗留自由架构選擇：

| 风險／前提 | 阻塞點 | 失敗處理 |
|---|---|---|
| Face unique同txn釋放重用是否可行 | G04a、先於依賴功能 | 停回設計讨論，不能撤index/fallback |
| pins是否clean compile兼容；Toxiproxy exact digest/可用 | G02已通過；見docs/evidence/g02/report.md | 版本或工具設定變更使本關證據失效，須重跑G02 |
| native實際wire發送/timeout/NoLate證據 | G10b/G10c，G12必需 | 無證unknown保護，不宣稱完整交付 |
| 舊碼無額外專案備份 | D161已由使用者選擇並完成 | 系統垃圾桶仍可復原；D140 legacy backup方案不再執行 |
| host/domain/TLS證書未提供 | G11/G12 public gate | 本地證據與公開部署分開，不購建外部資源 |
| 初值資源／rate／性能未量測 | 對應HTTP/perf/reset關 | 報實測／回归，不假百分比或通行保證 |
| oldprocess或DBwork隔離/seed結果未知 | G11 | marker閉、APIoff，不跳步/自動heal |
| 正式報告與代碼版本不一致 | G12 | 對應證據失效，重跑必要項 |

Q1–Q13各實際細分見discuss原查證block（D105/111/116–125/127/133/135/139/143/147/155）：已核準的窄官方查證已回執；K14完整相容表未取、無法以表證組合運行；unique release/reuse／faulttool實際可用／wire計量仍以gate實測，不凭查證補綠燈。没有新增未授權研究。

## 知識範圍與前提

本文件是D114授權的規劃輸出，不新增外部來源。全部允許來源及最終狀態：

- 全部知識範圍：K1 `/home/sean/PassHub/docs/business-scope.md`；K2 `/home/sean/PassHub/docs/discuss.md`；K3 `/home/sean/PassHub/docs/requirements-traceability.md`；K4 [Node Crypto](https://nodejs.org/api/crypto.html)；K5 [OWASP](https://cheatsheetseries.owasp.org/)；K6 [Buffer](https://nodejs.org/api/buffer.html)；K7 [ECMAScript](https://tc39.es/ecma262/)；K8 [Unicode](https://www.unicode.org/versions/latest/)；K9 [Nest JWT](https://github.com/nestjs/jwt/blob/master/README.md)；K10 [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken/blob/master/README.md)；K11 [Node 發行](https://nodejs.org/en/about/previous-releases)；K12 [Nest 遷移](https://docs.nestjs.com/migration-guide)；K13 [driver 交易](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)；K14 [Mongo 相容](https://www.mongodb.com/docs/drivers/compatibility/)；K15 [官方 driver repo](https://github.com/mongodb/node-mongodb-native)（v7.6.0）；K16 [npm metadata](https://registry.npmjs.org/)；K17 [Docker 官方映像](https://github.com/docker-library/official-images)及 registry manifests；K18 [Mongo8 發行](https://www.mongodb.com/docs/manual/release-notes/8.0/)；K19 [TS5.9](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html)；K20 [abort](https://www.mongodb.com/docs/v8.0/reference/command/aborttransaction/)；K21 [監測](https://www.mongodb.com/docs/drivers/node/current/monitoring-and-logging/monitoring/)；K22 [監測規範](https://github.com/mongodb/specifications/blob/master/source/command-logging-and-monitoring/command-logging-and-monitoring.md)；K23 [交易限制](https://www.mongodb.com/docs/v8.0/core/transactions-production-consideration/)；K24 [交易規範](https://github.com/mongodb/specifications/blob/master/source/transactions/transactions.md)；K25 [server repo](https://github.com/mongodb/mongo)（r8.0.32）。新增 K26 [snapshot](https://www.mongodb.com/docs/v8.0/reference/read-concern-snapshot/)；K27 [majority 讀](https://www.mongodb.com/docs/v8.0/reference/read-concern-majority/)；K28 [write concern](https://www.mongodb.com/docs/v8.0/reference/write-concern/)；K29 [driver CSOT](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/csot/)。均已參考・鎖定，無停止／移除；用途分別為既有業務、決策、追蹤、安全／runtime／交易 API／資料保證的精確前提；LLM 背景開啟，不支持版本／保證數據。
- K30 [Toxiproxy](https://github.com/Shopify/toxiproxy)；K31 [Node24 Test runner](https://nodejs.org/docs/latest-v24.x/api/test.html)；K32 [Jest](https://jestjs.io/docs/getting-started)；K33 [Mongo8 Partial Index](https://www.mongodb.com/docs/v8.0/core/index-partial/)；K34 [Collation](https://www.mongodb.com/docs/v8.0/reference/collation/)；K35 [$type](https://www.mongodb.com/docs/v8.0/reference/operator/query/type/)；K36 [$exists](https://www.mongodb.com/docs/v8.0/reference/operator/query/exists/)；K37 [Nest middleware](https://docs.nestjs.com/middleware)及[raw-body](https://docs.nestjs.com/faq/raw-body)；K38 [Nest v12.0.3 core](https://github.com/nestjs/nest/blob/v12.0.3/packages/core/nest-application.ts)及[Express adapter](https://github.com/nestjs/nest/blob/v12.0.3/packages/platform-express/adapters/express-adapter.ts)；K39 [Node v24.21.0 util](https://github.com/nodejs/node/blob/v24.21.0/doc/api/util.md)；K40 [Express5 API 索引](https://expressjs.com/en/5x/api/)；K41 [Node24 HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html)。K30–K41皆一般參考、已參考・鎖定；用途依序為故障工具、測試候選、索引比較、入口接線與嚴格解碼／HTTP生命期，不支持已實測保證。K40本次未採用任何知識；D166已取代D156的runner選擇，K32為正式Jest runner候選依據，K31只保留歷史Node runner語義。所有來源無停止／移除。
- K42 [systemd v255 time](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd.time.xml)／[timer](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd.timer.xml)：一般參考，已參考・鎖定，排程語義；K43 [Docker stop](https://docs.docker.com/reference/cli/docker/container/stop/)／[inspect](https://docs.docker.com/reference/cli/docker/container/inspect/)／[Compose start](https://docs.docker.com/reference/cli/docker/compose/start/)：一般參考，已參考・鎖定，程序生命期；K44 [Mongo8 shutdown](https://www.mongodb.com/docs/v8.0/reference/command/shutdown/)／[journaling](https://www.mongodb.com/docs/v8.0/tutorial/manage-journaling/)／[deleteMany](https://www.mongodb.com/docs/v8.0/reference/method/db.collection.deletemany/)：一般參考，已參考・鎖定，停止恢復與精確清理；K45 [Nginx proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)／[SSL](https://nginx.org/en/docs/http/ngx_http_ssl_module.html)／[rewrite](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html)：一般參考，已參考・鎖定，入口屏障／轉送；K46 [util-linux v2.39.3 flock](https://raw.githubusercontent.com/util-linux/util-linux/v2.39.3/sys-utils/flock.1.adoc)：一般參考，已參考・鎖定，local互斥。全部K1–K46保留，無停止／移除；LLM背景仍開啟只支持一般推論。

完整實際採用回執在各原D查證块；本輸出就近用D號指向實際事實／API邊界，不聲稱另讀全部repo或當前production。K14完整table不可用；K40只索引未採用功能事實；K32依D166作正式Jest runner依據，K31只保留歷史runner語義。無停止/移除來源。

用戶陈述負責作品目標／業務取捨與持續授權；官方讀證只支持具體API/源語義／manifest，不支持PassHub可運行。LLM背景開啟只一般信息隱藏／故障與測試原則；本輪推論負責契約組合，不能冒稱外部驗證。規劃輸出會混合上述來源，因此partially-sourced；所有工程仍U。

## 交接資訊

G05c evidence supplemental: exact Node image、G05c 51 tests、全 unit 189、G05a 21、G05b 80、boundary／negative compile／coverage及registry fail-closed boundary均已由 `docs/evidence/g05c/report.md` 保存；G06a evidence 另由 `docs/evidence/g06a/report.md` 保存，含 unit 88、true Mongo integration 5、full unit 277、G04a 9／G04b 57、boundary／negative compile／coverage與 secret scan；G06b evidence 由 `docs/evidence/g06b/report.md` 保存，含 unit 78、true Mongo integration 4、full unit 355、G06a 88／Mongo 5、G04a 9／G04b 57、三組boundary／negative compile、coverage與secret scan；G07a evidence由 `docs/evidence/g07a/report.md` 保存，含strict JSON unit 32、true HTTP e2e 41、combined 73、full unit 387、四組boundary／negative compile、coverage、build與secret scan；G07b evidence由 `docs/evidence/g07b/report.md` 保存，含unit 40、true HTTP e2e 5、combined 45、full unit 427、G05a／G05b／G05c及G07a regressions、boundary／negative compile／coverage／build。本段仍不把技術admission seam當成正式G06 Auth、G08 Access／Event／Mongo、完整G05b execution／confirmation接線、G10、G11或完整API完成。

當前停止點為**G07b同步準入／HTTP等待生命期限定證據已通過；依25 STOP規則停止於G07b。G05a／G05b／G05c／G06a／G06b／G07a／G07b不新增完整requirement V；A01、A11–A16、B13、B41、B42共10項為V（G04b新增9項），其餘126要求仍U**。G07b只證技術admission composition：十路由分類、epoch／existing-only、資源分池、fixed-minute rate、provisional FIFO、registry reservation／join／replay／conflict、五秒一次回覆owner及unknown handoff；其validator與work皆為注入seam。正式G06 Auth route、G08 management／recognition用例、Access Event／Presence／Mongo、G05b execution／confirmation ledger接線、G10 driver故障協議、G11 maintenance／deployment仍未解鎖。後續仍逐關回報證據並停止；下一合法gate為G08a，尚未開始。

安全採用P01–P15契約、25STOP與136矩陣，另受D166正式Jest runner決策約束。G02–G07b各自限定evidence已保存；G04a/G04b另記錄真Mongo 8.0.32、9／57 integration、共同保存、freshness、schema/integrity、replay及typed error evidence。不得由G07b技術HTTP／FIFO／registry／capacity seam假設正式Auth／Access業務API、真transport-loss、confirmation、maintenance、deployment或公開runtime成立。`ManageQualifications.create` 的 `Promise<void>` 是G08a前待收斂的輸出契約；G03c不猜QR DTO。D156 formal clean `sourceCommit` 屬G12 release規則，本關只記working-tree SHA，不冒稱clean commit。
