# G04b atomic persistence adapter

狀態：**PASS（G04b 限定 gate）**。這是完整原子保存 adapter 的真 Mongo 證據；G04b 新增 9 項直接 requirement evidence，連同既有 A01 後目前共 10 項 V、其餘 126 項維持 U；不是完整 v1／HTTP／部署 release 證據。

## 交付邊界

本 gate 交付並核對：

- 六個 collection（`users`、`sources`、`qualifications`、`faceSlots`、`events`、`metadata`）的 validator、required/type/null/cross-shape 規則、唯一索引與 bootstrap；startup 對既有資料做 fail-closed integrity scan，不修復、不覆寫。
- `G04bMongoPersistenceAdapter` 的單一手動 `ClientSession`／transaction scope。交易使用 snapshot／primary／majority+j=true；同一 transaction 的 driver 操作共用 session 且以 await 順序執行，不使用 `withTransaction` 或 `Promise.all`。
- accepted 與 rejected 的 Presence、Face mapping 變更、Access Event 共同保存；拒絕 Event 保存失敗回技術錯誤，不冒稱已完整保存的業務拒絕。
- Source 的 `_id + incarnation + version + direction + active` freshness guard 與 version increment；qualification、mapping、QR lookup 及 Face binding／release／recognition guards。
- QR／Face 精確解析與 D117 comparison artifact；`FACE_UNKNOWN` 與 `FACE_SUBJECT_NOT_MAPPED` 分流；不配置陌生 Face slot。
- `sourceId + externalEventId` Event unique index、同 artifact replay、不同 artifact conflict，以及 duplicate key、write conflict、aborted transaction、schema validation、unknown commit 的 typed 分類。
- 一次 read-only canonical snapshot lookup（Event＋qualification／mapping／metadata 的一致 redacted projection）；既存 Event 先於目前 source／mapping／qualification 狀態重判，因此 replay 不受現況變動影響。

## 可重跑證據

在工作樹中實際重跑：

| 命令 | 結果 |
|---|---|
| `npm run test:g04b` | 真 MongoDB `8.0.32` `rs0`；1 suite／57 tests passed；compose teardown 完成 |
| `npm run test:g04a` | 1 suite／9 tests passed；同 exact Mongo image |
| `npm run test:unit` | 6 suites／37 tests passed |
| `npm run test:boundary` | `selected=21 edges=55 forbidden=0 directRawComparison=0` |
| `npm run test:negative-compile` | exit 0；expected public-surface errors 全部 consumed |
| `npm run build` | exit 0（integration runner 及 unit 驗證前均成功） |
| `git diff --check` | exit 0 |

上述合計為 **8 suites／103 tests**。G04b 的正式 57 cases 包含 13 項本輪回歸：canonical replay 經 source／mapping／qualification 變動仍回 persisted result、UUID validators、既有 legacy Event／face-slot orphan／incarnation／slotCount／Event source-direction integrity、active 狀態與 acceptance shape、以及首次 Face bind 與 unmapped recognition 競爭等。G04a fixtures 已改為合法 UUID，9 cases 全綠。

Mongo 執行映像為：

`mongo:8.0.32-noble@sha256:01354084d2ae665d2e79b79b0cdc50c2c0c98873618912d9a2c8c9cb5c3d24e6`

本次驗收檔案 working-tree SHA（repository 尚無 clean source commit；clean commit 綁定 G12）：

```text
package.json                            f330e8895f32066da16970a90b461c1141692fea0f2ee48b3ff05460ed7844e0
package-lock.json                       70fce3c9a46f686e6bca2e6f6e66894c6e4510ffbc6bd4518d781f2f2bb9320b
jest.g04b.integration.config.cjs       8119eab0638675f71501bfe04fe52188bf90e26b7d390149a906b32bc2372a07
infra/g04b-mongo-compose.yml            458172127c412fba8885a70a1930783266cd5f51fb0d10c19017c52f356369b1
scripts/test-g04b-integration.mjs      83464bbc8e30434226d1f7e37a3927e9c0afcca7f720edc8733c4eb3dabf8826
src/infrastructure/mongo/g04b-schema.ts c553b2078a51d90993308747c11198c6d5a6ab304186a7562993a938efd22e52
src/infrastructure/mongo/g04b-persistence-adapter.ts d6a8cec99cb3a911f9c7e097ae4ef05a753f17c483ce3d936bfe82e3e70f25b3
test/integration/g04b-atomic-persistence.test.ts cb7c46d26edd286e2e05411b9f644b6e446f6433dc9d21982deabf99db122a79
```

## Review process and corrective history

- Architect review：PASS；independent tester formal run：57/57 PASS。PM independently reran the commands above and inspected source／tests／contracts.
- Earlier defect fixed：existing Event is canonicalized before current source freshness／direction／metadata checks, so a same-ID same-artifact replay remains persisted replay after current source, mapping or qualification mutation.
- Earlier schema gap fixed：UUID validators now cover Event／qualification references and face-slot identity／incarnation；startup inspects existing rows and rejects orphan, wrong-incarnation, slotCount and Event source-direction inconsistencies without repair。
- Earlier evidence gap fixed：13 formal regression cases added；G04a fixtures use legal UUIDs；exact G04b selector is isolated from G04a。

## Same-ID concurrent contract

同一 `source + externalEventId + comparison artifact` 的首次真正並行請求，G04b 僅保證最多一筆 `COMMITTED`；另一筆可因 112／未知提交結果回 typed `WRITE_CONFLICT`、`UNKNOWN_COMMIT_RESULT` 或 `UNKNOWN/UNCONFIRMED`。winner 尚未可見時，一次 canonical lookup 得到 null 是合法未知，不要求兩個 Promise 立即 resolve 或立即收斂。winner commit 可見後的再次同 ID／同 artifact 請求必須 `REPLAYED`；retry loop、budget、immediate convergence 與跨 scope 重判屬 G05/G08b/G10。

不同 `externalEventId` 的並行 ENTRY conflict 也不在本 gate 自動新 scope 重判或產生 `ALREADY_INSIDE`；G04b 回 typed conflict／unknown，由後續 G05 coordination／完整用例重排與保存業務 Event。

## 明確限制與下一關

本 gate 不宣稱：

- G05 FIFO、registry／epoch、執行／確認 budget、immediate convergence 或上層跨 scope 重排；
- G08 HTTP／Nest／auth／e2e／capacity／public API；
- G10 真 transport-loss、confirmation loop、abort／termination protocol、maintenance 或 deployment；
- 完整 136 requirements、clean source commit 或 v1 release。

因此 G04b 後下一合法 gate 為 **G05a FIFO operation coordinator**；未獲該 gate 證據前，不能把上述剩餘能力寫成已完成。
