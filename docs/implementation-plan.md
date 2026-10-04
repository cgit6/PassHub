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
updated: "2026-10-04"
---

# PassHub v1 實作契約與逐關驗收方案

## 快速檢索卡

- 核心問題：把已採用的業務與架構討論交給實作者，避免自行補架構、丟要求或用測試數量取代證據。
- 當前結論：P01–P15規劃已收斂；G02–G11g、G12a與G12b已有各自限定證據並通過 gate，目前停止於 G12b。G11 依 D187 拆成 G11a–G11g 七個 STOP，G12 依本輪拆成 G12a–G12h，下一合法 gate 為 G12c；矩陣仍須由各 gate 的直接證據逐項更新，完整 v1 尚未完成。
- 關鍵爭點：G04a 真 Mongo 8.0.32 已證明窄 face reverse-unique release/reuse 交易情境；G02只證工具鏈可用，不證API、模組接線或完整交易 adapter。
- 適用於：單API／單logicalplace／單次Qualification／QR或模擬Face的公開共享sandbox；Nest預設Express、strictTS、官方Mongo driver。
- 不適用於：真實人臉辨識／硬體門禁、多據點／多租戶、多API、跨崩潰／reset續辦、正式SLA或業務復原。
- 待驗證：G10 fault／control／logs，以及完整G05b確認整合、clean install、Docker、CI、OpenAPI、public HTTPS。G09b限定效能證據不等於SLA、容量規劃或完整v1工程通過。

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

六個業務 collection（D142–D145）：qualifications、faceSlots、events、users、sources、metadata；G10c 另加入一個內部 canonical confirmation collection `managementReceipts`。業務_id與incarnation server UUID，metadata _id="system"單例例外；version非負safe integer且overflow阻擋；日期BSON Date，nullable欄必存null。完整欄位及cross-shape以D145為準，不能把此摘要當刪欄授權；完整 reset 的精確 target 依 D187 為上述七個 collection。

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
- 技術400/401/403/404/409/429/503；detail的合法UUID查無統一404 `RESOURCE_NOT_FOUND`，格式錯誤400；Face新槽滿507；create201含唯一qrToken、update/revoke200安全摘要。已認證query的Mongo read失敗503 `PERSISTENCE_UNAVAILABLE`，不回partial／null。
- management**無冪等或progress API**；lostcreate response不能取回QR，盲retry可能新增資格，不能教自動retrycreate。
- 共用安全Event投影：eventId/sourceId/direction/kind/outcome/reasonCode/receivedAt/recordedAt/nullable qualificationId/presenceTransition；DBreason映reasonCode。qual投影保留矩陣B48完整摘要／有效faceBound，不刪撤銷原因／時間。

Nest bodyParser:false，composition app.use raw receiver在init/listen之前；不把rawBody:true和停parser混搭。自有functional入口非自動DI/filter。request body 16KiB／絕對upload5s；成功response最多256KiB，超限fail closed、不截斷或回partial。fatal UTF8且BOM保留後明拒。depthfilter（非完整parser）先於native JSON.parse，再cookedduplicate keyscan；rootobject最多2objectlayers，business body任何array拒。Content-Type application/json僅optional charset UTF8，Encoding absent/identity，其餘415。Owned headers及decodedquery重復拒、不merge。req.close不當abort，res.close僅自身HTTP owner，finish非clientreceipt。（D147／D151／D180）

待測限制（D146／D148／D149）：connections64/rawreaders16；origin32；validation普通write4/login1/query1＋retry2；HTTP普通28＋retry4不借；scrypt1無queue、queryDB1、canonical replay2、originalconfirm1獨立串行；真工作未收束不因HTTP終結還額。registry4096／faceSlots4096獨立。fixed-minute login IP5/global20、query account60/global120、recognition Source30/global60、management account10/global20；IPmap256去過期不evictlive。既有原項不因retry限速取消。Header/keepalive候選5s在G07a核API/ranges/coverage，不冒稱已全部硬保證。

### 7. 查詢、效能、日志與私密控制

G09a先採writer-quiescence read-observation lease：Human Auth、角色及strict path/query驗證與既有準入後，若存在`provisional`／`queued`／`running`／`blocked`／`unknown` writer，立即503 `TECHNICAL_BUSY`且不等待。只有quiescent可取得短lease；lease期間新writer可同步登記但不得開始，query在finally釋放。query不進完整writer FIFO、不寫DB、不做惰性cleanup。取得lease時固定一個`observedAt`，整個list／detail及其`expired`／`faceBound`衍生值共用；資料庫讀取失敗回503 `PERSISTENCE_UNAVAILABLE`，不得回partial／null。（D180）

三個list的業務payload exact `{items,nextCursor}`，空頁／末頁`nextCursor=null`；兩個detail直接回單item，不用`{item}`wrapper。共用HTTP層仍按既有契約帶`currentDatasetEpoch`。Qualification list/detail item exact keys為`qualificationId/displayName/validFrom/validUntil/presence/expired/revokedAt/revocationReason/expiredTerminalAt/faceBound/createdAt/updatedAt`，可空值保留`null`，所有日期為UTC毫秒ISO。Event list/detail沿既有B49 exact安全投影。合法小寫UUID查無qualification／event均404 `RESOURCE_NOT_FOUND`；UUID格式錯誤400。（D180）

D152三list keyset：quals createdAt/_id DESC；inside enteredAt/_id DESC；events receivedAt/_id DESC，3filtersAND。limit預設20/decimal1–100無leadingzero。cursor canonical unpaddedbase64url≤512ASCII：
```text
["p1",epoch,endpoint,qualificationFilter|null,outcome|null,reasonCode|null,lastTime,lastId]
```
endpoint限qualifications/inside/events，前兩filtersnull；綁route/filters/epoch、嚴格格式/roundtrip，old epoch409。這是內部cursorarray，不開business array；不跨頁snapshot，資料改變或晚Event可能需刷新第一頁。query四非unique索引：qual createdAt/_id、qual presence/enteredAt/_id、event receivedAt/_id、event qualificationId/receivedAt/_id；保留唯一約束。

`lastTime`必為UTC毫秒ISO字串；cursor必為canonical unpadded base64url，末頁與空頁均回`null`。`limit`不綁入cursor，可在續頁改變且仍為decimal 1–100；舊epoch回409，route／filter mismatch回400。成功response序列化上限256KiB，request仍16KiB；超限不回部分page。（D180）

G09b只直接量測production Mongo query adapter，不走HTTP／Auth／read lease，也不得改業務API、production查詢語意或公開Demo資料。正式命令`npm run test:perf -- --gate g09b`，環境固定Node 24.21、MongoDB 8.0.32單成員`rs0`、隔離performance DB與1800秒總期限；cleanup錯誤另報且不得蓋掉原錯。（D182）

fixture literal seed為`passhub-g09b-v1-20260927`。所有UUIDv4、digest、BSON時間及插入／排序順序均以canonical UTF-8 label frame與SHA-256派生；UUID明設v4 version／variant bits，禁止`Math.random`、`randomUUID`與執行當下時間。canonical NDJSON依collection再`_id`排序後計fixture SHA-256。10,000 Qualification精確分布為4,000 active `NOT_ENTERED`、1,000 revoked `NOT_ENTERED`、1,000 expired-terminal `NOT_ENTERED`、2,000 `INSIDE`、2,000 `EXITED`；4,000 Face slots只綁2,000 active及2,000 `INSIDE`，`slotCount=4000`。40,000 Event精確為HOT Qualification 5,000 rejected／`QUALIFICATION_EXPIRED`＋5,000 accepted、其他Qualification 10,000 rejected／`QUALIFICATION_EXPIRED`＋10,000 accepted，以及10,000筆null-qualification `FACE_UNKNOWN`。fixture是隔離查詢資料，不冒充公開Demo或完整真實來訪歷史。

十個case為Qualification list、INSIDE list及Event的無filter／qualification／outcome／reason／qualification+outcome／qualification+reason／outcome+reason／三者AND。Event參數固定HOT／`REJECTED`／`QUALIFICATION_EXPIRED`，預期match counts依序40,000／10,000／25,000／15,000／5,000／5,000／15,000／5,000；Qualification／INSIDE分別10,000／2,000。每case各測first與fixed-next，`limit=20`、adapter fetch 21；next key由獨立oracle第20項預定，預期第二頁為第21–40項，並用第41項判定next cursor。每個被測sort／filter至少建立64筆同time tie bucket，逐ID驗無gap／duplicate。

BEFORE／AFTER各`10 cases × 2 pages × 100 measured`，合計4,000 raw samples；每格先10次warmup。測量以`process.hrtime.bigint()`包住完整production adapter await及projection，全部串行、保留全部outliers。每格100筆ns升序後nearest-rank p50／p95使用zero-based indices 49／94，另記runtime。BEFORE只drop `g04b_qualification_created_v1`、`g04b_qualification_inside_v1`、`g04b_event_received_v1`、`g04b_event_qualification_received_v1`四個non-unique query indexes；AFTER以既定keys精確重建。`_id`、unique／partial、comparison、user及source indexes不得變；同DB同fixture、每階段清plan cache、不用hint或`allowDiskUse`，報告明示固定before→after造成的cache／order bias。

command-monitoring client須捕捉真正adapter aggregate command，再以`executionStats`重放；每個state／case／page一份，共40份。主cursor與Face lookup分開保存／摘要；完整sanitized explain留私有run，公開只留summary。兩個index states都先通過counts、fixture hash、schema／reference／Event invariants、index inventory、十case first／next exact IDs、tie gap／duplicate、before-after outputs相同、4,000 sample count、40 explains及環境／source指紋。任一正確性／證據失敗即STOP；AFTER較慢、無改善或`COLLSCAN`如實報告而不算正確性失敗，也不得宣稱改善。

正式run位於`output/evidence/g09b/g09b-b2-1669530-1790525819869/`，manifest hash為`618a074e5e58c94b90ed5d98791ca47964d77e6b74a409b561a64b5953a52ada`；raw及完整explains保持ignored。tracked公開[報告](evidence/g09b/report.md)與三份精簡JSON保存clean `sourceCommit`、code／lock／config／fixture hashes、4,000 raw與40 explains摘要。G10 fault／logs／private control及G11部署均未由G09b完成。

D153 allowlist logs：request/operation UUID、epoch/run/owner/phase/round/group/budget/fixedcode，不dumpcommand/reply/drivererror/body/fullsubject/secret/hash。128records×≤2KiB，5files×10MiB/private0700/0600，best-effort drop＋LOGGING_DEGRADED非必要Event失敗；host-only logs:read按operationUUID。

private Unix socket 0700dir/0600socket：status/hold/release/drain。hold先同步revision/veto屏障才ACK；D153所稱「尚未交driver步驟」由D184精確化為G07尚未invoke的完整G08 writer-work Promise，不再細分G08內部層級或Mongo command。G07以permission check→issuedPersistence++→invoke work零await交付；一旦invoke，整個scope／transaction／cleanup Promise可晚wire且不再被manual／maintenance攔截。release只自身control/epoch/run/revision，不解unknown/maintenance/補額度。current-last replay bounded，舊revision拒絕不重做，無歷史無界cache。drain只等完整G08 work與已invoke query，不證validation／Auth DB或DB隔離。

#### G10a D184 精確開發契約

- **internal composition**：建立pure synchronous nominal `RuntimeControl`，搭配`RuntimeIdentity`、`OperationToken`及private `WeakMap` provenance；FS logger、Unix socket adapter及CLI分離且不public export。每個strict ingress完整接受的HTTP request新生requestUUID；可信retry沿用既有operationId作operationUUID。epoch／run／ownerRef／route只能由composition capability注入並凍結作log context，permission每次讀current；G07b以private WeakMap binding把capability傳入G08，不擴public DTO。G10a不consume unknown recovery，也不實作G10b／G10c／G11責任。
- **writer-work permission seam**：每writer最多invoke G08一次。manual gate阻擋所有READY writer，不預判rate／registry／ORIGINAL；release wake一次後依FIFO start，executor內才可能rate reject、registry JOINED／REPLAY或ORIGINAL。前三者與invalid皆G08=0；只有通過rate／registry／prework terminal checks的eligible ORIGINAL同步`permission check → issuedPersistence++ → invoke G08 work`零await且exact once，完整Promise settle才decrement。existing-only join／replay是memory path，不註冊READY且不受manual；maintenance仍可按入口策略先行。invoke後不攔內部Mongo。
- **maintenance／query／drain**：maintenance優先。新writer同步入口503 `TECHNICAL_BUSY`＋`KNOWN_NO_EFFECT`＋DB0/Event0並exact release；READY queued以新增nominal prestart disposition直接SETTLED KNOWN_NO_EFFECT並觸發既有settled observer cleanup，禁止`rejectQueued`／BLOCKED；WAITING_VALIDATION同步標maintenanceCanceled，validator及已起Auth DB可收束，但不得register／invoke G08，回503並exact cleanup；新validation不啟動。reservation／origin／validation／HTTP leases依生命週期exact once釋放。query固定`check → activeQueryReads++ → sync invoke queryWork`零await，sync throw／finally exact decrement；veto 503／DB0，已invoke可完成。drain只等完整G08 `issuedPersistence`與`activeQueryReads`，不等validation／Auth DB，故DRAINED不證其結束或DB isolation。canonical replay memory-only不阻不計，unknown confirmation不做。
- **控制狀態**：timeout採monotonic clock，wire 1–30000ms；`DRAINED|NOT_DRAINED`均永久保留maintenance且不證rollback／隔離。revision內部bigint、wire canonical decimal、從0起；成功hold／release／drain permission mutation各增一，drain完成不再加。manual僅一個；hold server發UUID controlId；release須exact controlId／epoch／run／expectedRevision且只清manual。
- **transition／replay／failure**：優先序固定`wire/DTO → epoch/run（LOGS_READ豁免） → current exact join/conflict/busy → last exact replay/conflict → expectedRevision → command precondition`。pre-mutation reject不占current／last；一旦permission mutation發生，success或固定`INTERNAL_UNAVAILABLE` terminal都先cache為last才做socket I/O，state不rollback；drain wait／serialization／internal failure亦維持maintenance，current exact join相同terminal且STATUS仍可查。只保留last，後續state推進後較舊expectedRevision回stale。STATUS／LOGS_READ不占replay slot。
- **uniform logger closed schema**：exact keys為`schemaVersion/timestamp/kind/code/requestUUID/operationUUID/datasetEpoch/processRunId/ownerRef/route/phase/round/group/budgetRemainingMs/budgetRemainingUnits/commandName/driverRequestId/requestControlId/controlId/revision`且不適用為null。schema=`g10a.log.v1`；所有records的datasetEpoch／processRunId必填canonical lowercase UUID；timestamp為UTC ms ISO；ownerRef為UUID|null；route=`MANAGEMENT_CREATE|MANAGEMENT_UPDATE|MANAGEMENT_REVOKE|RECOGNITION|QUERY|LOGIN|CONTROL|null`；phase=`INGRESS|ADMISSION|PERSISTENCE|DRIVER|CONTROL|null`；round=integer 1..3|null；group=`EXECUTION|CONFIRMATION|null`；budgetRemainingMs=integer 0..15000|null；budgetRemainingUnits=integer 0..7|null；driverRequestId=nonnegative safe integer|null；revision=canonical decimal|null。
- **logger enum／field matrix**：code恰為`REQUEST_ACCEPTED/OPERATION_REGISTERED/OPERATION_BLOCKED/BUSINESS_STEP_REGISTERED/BUSINESS_STEP_ISSUED/BUSINESS_STEP_SETTLED/DRIVER_STARTED/DRIVER_SUCCEEDED/DRIVER_FAILED/HOLD_ACKNOWLEDGED/RELEASE_ACKNOWLEDGED/DRAIN_STARTED/DRAINED/DRAIN_NOT_DRAINED/CONTROL_REJECTED`；commandName恰為`find|aggregate|insert|update|delete|findAndModify|commitTransaction|abortTransaction|endSessions`，其他忽略。REQUEST_ACCEPTED=RUNTIME／INGRESS，request必填、operation／owner null，route可業務／QUERY／LOGIN；OPERATION_*=RUNTIME／ADMISSION且request／operation／owner／業務route必填；BUSINESS_STEP_*=RUNTIME／PERSISTENCE且同前必填、四budget全null或全非null。DRIVER_*=DRIVER／DRIVER且command／driverRequestId必填：業務route另需request／operation／owner，QUERY／LOGIN則request必填而operation／owner null。六個CONTROL codes的request／operation／owner／round／group／budgets／command／driverRequestId全null，route／phase為CONTROL，requestControlId／datasetEpoch／processRunId／revision必填；controlId只在HOLD_ACKNOWLEDGED／RELEASE_ACKNOWLEDGED／DRAIN_STARTED／DRAINED／DRAIN_NOT_DRAINED必填，CONTROL_REJECTED為null。所有未適用欄必為null。
- **logger容量／故障**：final UTF-8 JSON＋LF≤2048 bytes；oversize與queue-full都drop newest、droppedCount飽和遞增並立即sticky degraded。single async FIFO writer的等待queue為128、不含currently-writing。其他serialize／open／write／rotate失敗也sticky degraded至process結束並sink後續，不另寫degraded record、不遞迴、不改business／control outcome。append不等I/O；private flush／close最多2秒，超時drop remaining並degraded；不承諾fsync、crash durability或恢復。
- **檔案／LOGS_READ**：logger absolute dir新建0700、files0600、same euid、regular且非symlink；active＋`.1`…`.4`各≤10MiB，rotation／startup錯誤sticky degraded。LOGS_READ收canonical lowercase operationUUID及optional safe-integer limit 1–100（default20），不帶epoch／run且豁免replay；按`.4`→active snapshot，latest limit再chronological，empty=`[]/false`、超過limit才truncated=true，逐record驗exact schema。archives ENOENT skip，healthy active必有；其他、parse／I/O error=`LOG_READ_UNAVAILABLE` no partial。D185限定同 Unix UID 為受信任的單一服務主體；不宣稱純 Node pathname API 能防禦同 UID check-to-use path replacement。
- **LOGS_READ mutex／FD**：mutex acquisition可Abort。鎖內按`.4`→active readonly open，以lstat＋fstat驗same inode／regular／owner／0600並固定byte lengths，隨即unlock；鎖外分塊讀open FD snapshot lengths，rotation rename／delete不影響。AbortSignal timeout、成功與失敗finally close全部FD；late reader無response／state change，下一append／rotation／read可取得mutex。healthy init在同mutex建立active；fresh active-only成功，init後active ENOENT失敗。
- **control path／socket ownership**：AF_UNIX only、no TCP。dir不存在時，absolute direct parent須existing real dir且`realpath(parent)==parent`；nonrecursive mkdir0700，EEXIST race重新lstat。final dir須real／non-symlink／same euid／0700；socket須direct child、resolved dirname exact、固定basename非`.`／`..`，失敗startup fail且不改其他path。socket0600、same euid、DAC only、CLI same uid。existing symlink／non-socket／wrong owner fail；same-owner先connect，active fail；僅ECONNREFUSED且dev＋ino二次相同才unlink。shutdown只unlink自身created same inode。D185限定同 UID 為受信任主體；不宣稱防禦同 UID path replacement。
- **framing／request validation／watchdog**：one connection one request／response then close。transport/framing只檢strict UTF-8/no BOM、half-close EOF、唯一final LF、no trailing／second LF、request including LF≤4096；fatal UTF8／BOM／oversize／EOF前2s timeout／LF違規／第9 active一律destroy noresponse/effect0，max8。frame合法後JSON syntax、root非plain object／array、任意深度duplicate、unknown／extra／missing key、wrong type/value回INVALID_REQUEST；duplicate須在JSON.parse前偵測。root可安全解析且唯一canonical requestControlId才保留，否則null。response single NDJSON oneLF≤256KiB。D186限定STATUS／HOLD／RELEASE為無I/O、不可等待的同步臨界區，故不套 event-loop processing watchdog；LOGS_READ為2秒，DRAIN為`timeoutMs+1000ms`。read-only timeout回LOG_READ_UNAVAILABLE或INTERNAL_UNAVAILABLE。mutation pre-state-change timeout不占current／last，postmutation timeout先cache last INTERNAL_UNAVAILABLE且state不rollback，late task不得再改state／last；DRAIN observation須支援AbortSignal。response write另有2秒deadline，timeout／backpressure立即destroy；disconnect不rollback，partial bytes由CLI拒絕，cached mutation可exact replay。
- **CLI**：只接受完整single NDJSON＋EOF。exit0 stdout success／stderr empty；exit2 stdout server error／stderr server code＋LF；exit3 stdout empty且按優先序只輸出一碼＋LF：完整候選frame但response framing／UTF8／JSON／schema invalid→`CONTROL_PROTOCOL_ERROR`；任一terminal時received>0但未有complete valid response+EOF→`CONTROL_RESPONSE_PARTIAL`；received0 deadline→`CONTROL_REQUEST_TIMEOUT`；received0 connected socket/write error→`CONTROL_TRANSPORT_ERROR`；未connect→`CONTROL_CONNECT_FAILED`。非DRAIN deadline8000ms、DRAIN=`timeoutMs+7000ms`，大於server acquisition2＋processing(2或t+1)＋write2並留2s。
- **commands／responses**：wire `v="c1"`且所有UUID canonical lowercase；malformed回INVALID_REQUEST，well-formed epoch／run mismatch才STALE_EPOCH／STALE_RUN。STATUS exact `v/requestControlId/command/epoch/run`；HOLD＋expectedRevision；RELEASE＋expectedRevision/controlId；DRAIN＋expectedRevision/timeoutMs；LOGS_READ exact `v/requestControlId/command/operationUUID[/limit]`且無epoch/run/replay。expectedRevision regex=`0|[1-9][0-9]*`，timeoutMs safe integer1..30000，limit safe integer1..100。success exact 10 keys=`v/requestControlId/ok/command/outcome/revision/controlId/snapshot/records/truncated`；outcome=`STATUS|HELD|RELEASED|DRAINED|NOT_DRAINED|LOGS_READ`，revision全success必填且LOGS_READ dispatch-captured。controlId只在HOLD回新ID、RELEASE回匹配ID、DRAIN回maintenance ID，其餘null；snapshot只在STATUS／HOLD／RELEASE／DRAIN非null，records／truncated只在LOGS_READ非null，其餘null。error exact `v/requestControlId/ok=false/code`，parsed canonical ID保留否則null；codes恰`INVALID_REQUEST|STALE_EPOCH|STALE_RUN|STALE_REVISION|REQUEST_CONTROL_CONFLICT|CONTROL_BUSY|MANUAL_HOLD_EXISTS|NO_MANUAL_HOLD|CONTROL_ID_MISMATCH|MAINTENANCE_HOLD_EXISTS|LOG_READ_UNAVAILABLE|INTERNAL_UNAVAILABLE`。
- **status invariants**：snapshot top-level exact keys=`epoch/run/revision/phase/manual/maintenance/writers/issuedPersistence/activeQueryReads/registryUnknown/logging`；phase恰為`RUNNING|MANUAL_HOLD|MAINTENANCE_DRAINING|MAINTENANCE_HELD|MANUAL_AND_MAINTENANCE_DRAINING|MANUAL_AND_MAINTENANCE_HELD`。manual exact own keys=`{active:boolean,controlId:canonical-lowercase-UUID|null}`、no extra、active iff ID；maintenance exact own keys=`{active:boolean,controlId:canonical-lowercase-UUID|null,outcome:null|WAITING|DRAINED|NOT_DRAINED|INTERNAL_UNAVAILABLE}`、no extra，inactive iff ID/outcome null，active iff ID nonnull且outcome非null，WAITING iff draining phase、terminal iff held phase。writers exact=`provisional/queued/running/blocked/unknown`；manual下所有READY仍queued，invoke後才running／issued。counts saturated safe integer；logging exact `{status:HEALTHY|LOGGING_DEGRADED,droppedCount}`。
- **正式驗收**：`npm run test:g10a`；unit每case10s／total60s，socket／integration每case60s／total300s；Node24.21、MongoDB8.0.32 rs0。PC驗manual阻全部READY、不預判、release FIFO；eligible ORIGINAL exact1，rate／JOINED／REPLAY／invalid=0，existing-only memory join/replay不註冊READY並繞manual，maintenance仍按入口處理。另驗完整G08 Promise drain、invoke後late wire、maintenance new／READY／validation三生命期、late Auth DB不被誤算隔離、query linearization、LOGIN／所有record的epoch-run、frame-vs-JSON error layer、深層duplicate、requestControlId保存、nested snapshot exact own keys／no-extra、slow LOGS_READ abort後FD全close與mutex canary、fresh／missing active、完整socket path／framing／watchdog、CLI 8000／`timeoutMs+7000ms` boundary與exit3 precedence。private evidence保存manifest/results/socket/rotation/control/mongo/secret/cleanup及safe tracked report；clean hashes、primary failure優先。
- **gate邊界**：G10a通過也不自動將136矩陣任何U升V；B50／E05／L07–L12／L36／E06／M05／M07均仍含後續gate責任。完成本gate即STOP，不開始G10b。

### 8. 真fault驗收與部署維護

D138–D139 fault opt-in isolated testDB、真HTTP/driver/server，observer direct readonly snapshot txn共同看Event/Presence/Mapping/slot/version before-after、majority確認，不由單筆順序讀假部分保存。Toxiproxy全appMongo地址（含replsetdiscover）經proxy；commit barrier hangBeforeCommitingTxn→drop downstream→解除barrier確認→observer共同snapshot確定after→app真unknown→remove drop→原canonical replay。server HostUnreachable reply不是回程loss；SDAM繞路/heartbeat使未commit/observer傷/barrier未解均invalidfail，不能pass。finite snapshots結合原子性來源與fault位置，不當allmoments證明。production無failpoints/故障控制服務。

D154–D155 LinuxCompose oneAPI、Mongo singlemember replica set非HA、NGINX HTTPS。host/domain/cert用戶環境前提。host初2vCPU/4GiB/20GiBfree，API768MiB/Mongo1536MiB/proxy128MiB未量測。無API/DBhostports／DockerSocket。固定proxyIP/32，overwriteXFF remoteAddr；requestbuffering off/HTTP1.1/nextupstream off/body16KiB/readsend15s非wholedeadline。marker公共503。

每日外部systemd OnCalendar=*-*-* 03:00:00 Asia/Taipei、AccuracySec1s/RandomizedDelaySec0/Persistentfalse，漏排不白天補清庫；需時間sync/tzdata/triggergate。固定local flock exclusive nonblocking、不unlink inode。runbook：

1. host lock／persistent marker封公網。
2. private drain最多30s；逾時仍進安全停機，不跳隔離。
3. 停既定唯一API，核舊process消失；不因此推DB舊workgone。
4. 停Mongo核舊DBprocess消失，重啟journal恢復完成PRIMARY。
5. **只處理 passhub_demo 的七個已知 collection**：qualifications、faceSlots、events、users、sources、metadata、managementReceipts，逐一 sequential `deleteMany({})` 並保留 indexes；seed 穩定公開假 credentials、新 epoch、null claim 與獨立 vectors。部署秘密保持外部管理且不換，不存入 seed 或資料庫；不 drop DB／collection／volume／其他 DB，seed 非全庫原子。（D187）
6. 私密一次runTicket限定新epoch/processRunId：bootstrap檢配置/PRIMARY/schema/index/shape/vectors/claim，不要求ready、不做業務。
7. bootstrap過才私密授權該run、localready，host marker仍封；成功handoff才開公網。
8. 停止/恢復/clear/seed/claim/startup/ready任何未知失敗維持veto/APIoff/marker；額外writer或未知container不盲停/越步。ordinarysameEpochrestart關寫，不靠空庫自heal。

API/Mongo SIGTERM grace30s，API無自動restart；stoprequest/graceexpiry不是消失證據。NGINX access_logoff/error /dev/null、Mongo不收原始query/command/profiling、Demo logpath /dev/null候選及container/controller去敏；knownsecret掃描覆全表面。取捨是不提供原始代理/DB診斷，有限scan非永不洩漏保證。

### 9. 固定31個STOP點

前關通過才進表後關，每子關交差異／要求D／command exit／指紋／真情境證據及覆核即停止。失敗、不相容、無效fault、缺證立即停；不auto還原使用者檔案或fallback。G04a／G04b敗必回設計討論。**G00、G01a／G01b 及 G02–G11g 已有各自限定局部通過證據；目前停止於 G11g，下一合法 gate 為 G12。**

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
| G08a | 管理用例及完整保存 | PASS：unit 52／true HTTP e2e 12／true Mongo 8.0.32 integration 10；Operator-only、strict DTO、create／PATCH／revoke、QR一次、安全摘要、惰性逾期、Face 4096容量／重用／衝突、交易原子性及unknown-effect停寫 |
| G08b | 完整辨識處理鏈 | PASS：unit 42／true HTTP e2e 6／true Mongo 8.0.32 integration 3；QR／Face／UNKNOWN、Source-only strict DTO、安全Event投影、正常回放／conflict、停用Source拒絕Event、Face ENTRY→EXIT原子保存及unknown-effect停寫；並行完整業務勝負與真transport-loss仍分屬後續證據 |
| G09a | 安全查詢／keyset | PASS：unit 92／true HTTP e2e 13／true Mongo 8.0.32 integration 16；read-observation lease、五查詢、keyset／AND filters、exact投影、錯誤分類及去敏 |
| G09b | PASS：分case查詢效能 | clean `dd0bc14`、固定10k／4k／40k fixture、10 cases×2 pages×2 states、4,000 raw、40 executionStats；correctness／inventory／hash全綠，E04升V |
| G10a | PASS：allowlist日志／私密控制屏障 | 正式 evidence 見 `docs/evidence/g10a/report.md`；logger／FS／socket／control／permission seam 已有直接證據 |
| G10b | PASS：precommit終止／abort完整清理 | clean `77e8c21`、private run `g10b-41a126f2424d49c6a89df8f9b7d200e6`；unit 8／65、topology PASS、真fault 2 suites／3 tests：112與11000均`NO_APP_PARTIAL_EFFECT`；exact Docker cleanup PASS。僅證precommit，G10c仍未完成。 |
| G10c | PASS：真傳輸未知確認與 canonical 收束 | `4aa5f4f`；G10c unit 9／67、fault 2 suites／4 tests；實際 HTTP→G07→G08a→G04b 管理更新經 Mongo `hangBeforeCommitingTxn` 與 Toxiproxy downstream timeout，direct observer 確認完整提交，scheduler canonical confirmation、session/lease cleanup、no-late CRUD 全通過；另有獨立 wire probe。 |
| G11a | PASS：部署拓撲基線 | 正式證據見 `docs/evidence/g11a/report.md`；exact clean source/toolchain 下18 unit／11 static／8 runtime、full unit 59 suites／1009 tests，三角色覆核PASS |
| G11b | PASS：持久寫入權與兩階段啟動 | b1–b3、b4 nominal bridge／bootstrap／single-use ready、b5 production process/container 均已通過；33 個 exact unit tests、12 個 clean process cases、去敏與 cleanup 證據見 `docs/evidence/g11b/report.md`；解鎖 G11c |
| G11c | PASS：維護入口與停機隔離 | `docs/evidence/g11c/report.md`；4 suites／27 unit tests、clean runtime composition runner；persistent marker、private drain≤30s、API／Mongo原process disappearance、同volume writable PRIMARY、三次no-late observation及cleanup均有證據 |
| G11d | PASS：精確 reset／seed | clean `f879d8f`；6 unit tests、clean Mongo runtime 8/8 cases；七 collection transaction、保 indexes、stable seed、新 epoch／null claim、其他資料不變；證據見 `docs/evidence/g11d/report.md` |
| G11e | PASS：外部排程與唯一 controller | `docs/evidence/g11e/report.md`；2 suites／3 tests、static 5 cases、runtime 5 cases；local nonblocking flock、reset-result→epoch→ticket handoff、同一手動／timer command、Asia/Taipei 03:00、Persistent=false |
| G11f | PASS：fail-closed 與受控重跑 | `docs/evidence/g11f/report.md`；clean source `53c05aa`、1 suite／14 tests、同一 Mongo partial handoff 真 publisher rejection、G11f decision 授權後新 epoch rerun、真實 G11e ticket／flock；其餘 marker／API／Mongo／writer fault 為明示的 policy-only observation |
| G11g | PASS：綜合 maintenance 證據 | `docs/evidence/g11g/report.md`；`npm run test:maintenance`、10份前置 evidence、470檔秘密掃描、Docker cleanup、source/config/image fingerprints、G11e static與G11f unit；G11f policy-only限制保留 |
| G12a | PASS：Release baseline 與需求帳本凍結 | `docs/evidence/g12a/report.md`；27份前置 evidence、125正式＋11排除＝136 IDs、clean source、G11g provenance與文件指紋，三角色覆核PASS |
| G12b | PASS：OpenAPI 與可重跑 curl Demo | `docs/evidence/g12b/report.md`；8 path templates／10 methods、0 internal routes、OpenAPI check、build、G08a／G08b／G09a HTTP e2e，三角色覆核PASS |
| G12c–G12h | 尚未開始：完整交付證據 audit | boundary／requirements、clean install、CI、Docker Demo、public HTTPS與最終 release audit，依子關逐一驗證 |

各gate對136IDs見矩陣§10.1；子情境細化見§10，**名字存在不代表覆蓋或通過**。G11不增加業務，只驗部署/reset；G12綜合既有責任，不寫新平臺。不同suite選擇器是將來script傳給Node runner的測試pattern，實作後確認選中數>0及情境符合，不能零測試exit0當gate成功。

### 10. 命令dictionary、期限及artifact

下面是root package的統一命令字典。G02–G11g 已依各自報告建立並執行對應限定命令與證據；其餘 G12 命令只有在對應子關實際建立、執行並保存證據後，才可視為完成：

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
- D156正式證據綁clean source/code等、報告revision可異；D166取代其Node unit runner選擇為Jest並使既有Node unit evidence失效；D157撤回大原型並建立25個STOP，D187再把原單一G11拆成七關，因此目前共31個逐責任STOP。

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

G05c evidence supplemental: exact Node image、G05c 51 tests、全 unit 189、G05a 21、G05b 80、boundary／negative compile／coverage及registry fail-closed boundary均已由 `docs/evidence/g05c/report.md` 保存；G06a evidence 另由 `docs/evidence/g06a/report.md` 保存，含 unit 88、true Mongo integration 5、full unit 277；G06b evidence 由 `docs/evidence/g06b/report.md` 保存，含 unit 78、true Mongo integration 4、full unit 355；G07a evidence由 `docs/evidence/g07a/report.md` 保存，含strict JSON unit 32、true HTTP e2e 41、combined 73、full unit 387；G07b evidence由 `docs/evidence/g07b/report.md` 保存，含unit 40、true HTTP e2e 5、combined 45、full unit 427；G08a evidence由 `docs/evidence/g08a/report.md` 保存，含unit 52、true HTTP e2e 12、true Mongo 8.0.32 integration 10、coverage combined 74及full unit 479；G08b evidence由 `docs/evidence/g08b/report.md` 保存，含unit 42、true HTTP e2e 6、true Mongo 8.0.32 integration 3、combined 51及full unit 521；G09a evidence由 `docs/evidence/g09a/report.md` 保存，含unit 92、true HTTP e2e 13、true Mongo 8.0.32 integration 16、combined 121及full unit 613；G09b evidence由 `docs/evidence/g09b/report.md`保存，含4,000 raw、40 cells、40 executionStats及完整correctness／inventory／hash核對。本段不把限定query benchmark推論為G10真故障／控制／logs、G11部署、SLA或完整API完成。

當前停止點為 **G12b 已完成 OpenAPI／curl 文件與既有 HTTP 對齊；下一合法動作為進入 G12c**。G11f 的 policy-only fault cases 不得在 G12 擴張為完整 production fault coverage；矩陣狀態只可依直接證據逐項更新。

安全採用P01–P15契約、31STOP與136矩陣，另受D166正式Jest runner決策約束。G02–G11e各自限定evidence已保存；G04a/G04b另記錄真Mongo 8.0.32、9／57 integration。`ManageQualifications` 已於G08a收斂為公開discriminated result；G08b辨識回覆只由已保存Event映射；G09a查詢維持exact去敏投影；G09b只量測同一Mongo adapter。不得由此推論G11f–G11g maintenance、公開runtime或SLA成立。各gate的clean source commit只證該gate provenance，不冒稱G12完整release evidence。
