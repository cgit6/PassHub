# G08b 完整辨識處理鏈限定驗收報告

- 日期：2026-09-27
- 結論：PASS；依25 STOP停止於G08b
- 下一合法gate：G09a（尚未開始）
- 基線commit：`63e17fe19ab6015c1e903de87f49ef5af7d926ca`
- 證據性質：working-tree gate evidence；不是G12要求的clean sourceCommit release evidence

## 驗收範圍

本關只驗收G08b辨識用例及完整保存：

- `POST /recognition/attempts`只接受已認證Source及exact `QR_SCANNED`、`FACE_MATCHED`、`FACE_UNKNOWN` DTO；payload不能指定Source、方向、qualificationId或client時間。
- Source目前active／direction由可信事實讀取；QR／Face只作替代媒介，不接圖片、RTSP、confidence、活體或真實辨識API。
- 正常新嘗試由既有純規則產生單一reason，保存Event；接受結果另與Presence及必要Face映射釋放共同原子保存。
- 同Source＋externalEventId＋同內容回放已保存Event；同鍵異內容為409且沒有第二筆Event；不同Source的相同externalEventId互相獨立。
- HTTP成功投影只由已保存Event產生，不暴露QR token、完整subject、comparison artifact、credential、incarnation或version。
- 無法確定保存效果時只回安全503並交unknown handoff；G08b不自行確認、重試或宣稱rollback。

## 架構四輪審查與修正

最初只讀預審為READY，另列出必要seam；以下四輪才是production architecture review：

1. R1 `NEEDS_CHANGES`：發現validator多餘key facts使合法G07b handoff失敗、artifact executor可structural fallback並重建artifact、G07b從rendered JSON反解析replay、G08a／G08b未共用handler／FIFO dispatcher、source binding與persistence facts外洩，以及dependency未construction capture／錯誤分類不精確。修正為四鍵交接、具provenance且fail-closed的唯一artifact、typed original／replay plans、internal四路由dispatcher、收窄public surface、construction capture及精確錯誤分類。
2. R2 `NEEDS_CHANGES`：發現RecognitionDataPort／SourceFactsPort保留可變方法receiver、persisted Event未核request facts與reason／transition invariant，以及任意callback可發trusted factory且internal barrel過曝。修正為frozen narrow bound adapters、唯一Event invariant validator、封閉production factory及opaque type。
3. R3 `NEEDS_CHANGES`：發現`assertOptions`未在construction驗SourceBound factory的WeakMap provenance，foreign frozen object會延至首請求才503。修正為internal direct provenance assertion，啟動時fail-fast且不由barrel／package公開。
4. R4 `PASS`：foreign factory啟動即拒、assertion不公開；合法HTTP首次`replayed:false`／回放`true`／conflict 409／existing-only absent、artifact只產生一次、dependency capture、Event mismatch轉UNKNOWN、四路由共用dispatcher及public surface均未回退。Production build、boundary／negative及G08a／G06b回歸通過。

## 正式測試證據

正式tester結果：

| 項目 | 結果 |
|---|---:|
| G08b unit | 1 suite／42 tests PASS |
| 真Node／Nest／Express HTTP e2e | 1 suite／6 tests PASS |
| 真MongoDB 8.0.32 replica-set integration | 1 suite／3 tests PASS |
| G08b combined | 3 suites／51 tests PASS |
| full unit regression | 16 suites／521 tests PASS |
| boundary | `files=7 edges=36 publicLeaks=0 forbidden=0` |
| negative public-surface compile | PASS；expected errors全數被消耗 |
| production build | PASS |

PM於文件封存前另重跑：

```text
npm run test:g08b
  unit 42/42
  HTTP e2e 6/6
  MongoDB 8.0.32 replica-set integration 3/3
  boundary files=7 edges=36 publicLeaks=0 forbidden=0
  negative public-surface compile PASS

npm run test:unit
  16 suites / 521 tests PASS
```

真Mongo runner使用：

- Node：`node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`（Node `v24.21.0`、npm `11.19.0`）
- MongoDB：`mongo:8.0.32-noble@sha256:01354084d2ae665d2e79b79b0cdc50c2c0c98873618912d9a2c8c9cb5c3d24e6`，單成員`rs0`且為writable primary

主機上的額外PM重跑環境為Node `v24.12.0`／npm `11.6.2`；它不取代上述exact image證據。

## Coverage

G08b選定三個suites的aggregate coverage：

- statements：82.81%
- branches：82.01%
- functions：93.47%
- lines：85.09%

這只描述G08b選定unit／HTTP／Mongo suites觸及的production範圍，**不是repository全面高覆蓋、不是136項要求完成率，也不證明未執行的fault／query／deployment情境**。

## 需求矩陣裁定

矩陣結構審計為136個unique requirement IDs，無重複。G08b只將完整、直接且可重跑支持的下列9項由U升為V：

- A05–A09：EXIT映射釋放完整行為，以及Auth／Sources／Access／HTTP／Mongo的窄能力、依賴方向與用例保存分工。
- B08：僅接模擬Face MATCHED／UNKNOWN，不接影像或真辨識API。
- B27：已認證但停用Source保存`SOURCE_INACTIVE`拒絕Event，未認證則是技術錯誤且不持久化。
- B35：不同Source使用相同externalEventId仍為獨立事件鍵。
- B52：沒有qualificationId辨識捷徑，只接受QR或模擬Face結果。

矩陣由13V／123U變為22V／114U。B21、B26、B28–B34、B36–B40、B43、L01–L06、L24–L27、L36、E01、E03、E06等雖有局部證據，因完整跨媒介／全reason／並行／生命期／fault或全表面驗收尚未閉合而維持U。

## 明確限制與STOP

本關沒有證明或開始：

- G09a／G09b安全查詢、keyset、filters與效能fixture。
- G10真正transport loss、driver abort／commit confirmation、unknown自動確認與續辦、私密hold／release／drain、allowlist logging或Toxiproxy fault matrix。
- G11 reset、maintenance、NGINX、systemd、Docker部署與public HTTPS。
- OpenAPI完整契約、clean install、CI、公開Demo、G12逐136要求release audit或完整v1。
- 不同externalEventId的完整並行ENTRY／EXIT勝負矩陣、管理與辨識競爭、全部reason經真HTTP＋真Mongo的逐項閉合。

因此只可宣稱「G08b限定辨識處理鏈已通過」。停止於G08b；G09a尚未開始。
