# G09b 分 case 查詢效能限定驗收報告

- 驗收日期：2026-09-28
- 結論：PASS；依25 STOP停止於G09b
- 下一合法gate：G10a（尚未開始）
- 受測source commit：`dd0bc1455cbb5698181960f4d1749c2230ca209a`
- 正式run：`g09b-b2-1669530-1790525819869`
- 私有ignored artifact：`output/evidence/g09b/g09b-b2-1669530-1790525819869/`
- 私有manifest SHA-256：`618a074e5e58c94b90ed5d98791ca47964d77e6b74a409b561a64b5953a52ada`
- 證據性質：clean source commit上的固定fixture、真Mongo查詢、raw samples及executionStats；本報告與三份精簡公開摘要屬其後docs working revision

## 1. Gate範圍與重跑方式

正式命令：

```bash
npm run test:perf -- --gate g09b
```

runner只接受clean HEAD，使用Node `v24.21.0`／npm `11.19.0`、MongoDB `8.0.32`單成員`rs0` writable primary及production `G04bMongoPersistenceAdapter`。Node image digest為`sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`；Mongo image由受測commit內已鎖定的`mongo:8.0.32-noble@sha256:01354084d2ae665d2e79b79b0cdc50c2c0c98873618912d9a2c8c9cb5c3d24e6`啟動。

provenance：

- production code hash：`f7d61941b96e5ca5e748da4d4e856e248253aa249f26f191be59a63696ebde9e`
- package-lock hash：`c7eaf49d36fc6f040742b7e7e811677e83b846c57d633ac1b36ba5b80a93256d`
- fixture hash／readback hash：`c86eb1cdd84c5b7ce204bd2d24f96af37d32f67f5e8fba06f8f0f28848f4de48`
- config hash：`dc40ed17af93feafebd2d8934d70c78be09bd1b2c300d5595332b27eb06024df`
- seed-bank hash：`f1eae15a15896df36105d6bbf3d144ff69c720d1eec8a3ecf607ea9b520ca212`
- manifest列出的50個artifact由PM重新計算SHA-256，全部相符；`sourceDirty=false`

## 2. Dataset、cases與正確性門檻

固定seed為`passhub-g09b-v1-20260927`。fixture包含10,000筆Qualification、4,000筆Face slot、40,000筆Event、2個User、2個Source及1筆Metadata：

- Qualification：4,000 active `NOT_ENTERED`、1,000 revoked `NOT_ENTERED`、1,000 expired-terminal `NOT_ENTERED`、2,000 `INSIDE`、2,000 `EXITED`。
- Face slot：2,000綁active `NOT_ENTERED`、2,000綁`INSIDE`，`slotCount=4000`。
- Event：HOT Qualification rejected expired 5,000、HOT accepted 5,000、其他Qualification rejected expired 10,000、其他Qualification accepted 10,000、null-qualification `FACE_UNKNOWN` 10,000。
- cases：Qualification list、INSIDE list，加Event無filter／HOT／`REJECTED`／`QUALIFICATION_EXPIRED`／三種兩兩AND／三者AND，共10 cases；每case各測first及fixed-next。

真Mongo correctness在BEFORE與AFTER均通過：fixture readback hash相同、schema／reference／Event invariants正確、10 cases的first／next exact IDs符合獨立oracle、每個tie bucket至少64筆、無跨頁gap／duplicate，兩種索引狀態結果完全相同。BEFORE只缺四個query non-unique indexes；唯一、partial、comparison、user、source與`_id` indexes保持不變；AFTER精確恢復baseline inventory。

## 3. 量測結果

每個state／case／page先做10次warmup，再串行量測100次；`process.hrtime.bigint()`涵蓋完整adapter await與projection，不刪除outlier。共40 cells、4,000筆raw nanosecond samples。下表為同一正式run的毫秒值；Delta是`(AFTER / BEFORE - 1) × 100%`，負值僅表示本次AFTER觀察值較低。

| Case | Page | BEFORE p50 ms | AFTER p50 ms | p50 Delta | BEFORE p95 ms | AFTER p95 ms | p95 Delta |
|---|---:|---:|---:|---:|---:|---:|---:|
| qualifications-all | first | 122.313 | 112.296 | -8.2% | 157.655 | 138.603 | -12.1% |
| qualifications-all | next | 122.730 | 112.841 | -8.1% | 154.743 | 140.316 | -9.3% |
| inside-all | first | 73.353 | 69.542 | -5.2% | 89.430 | 92.658 | **+3.6%** |
| inside-all | next | 86.607 | 75.097 | -13.3% | 106.052 | 99.104 | -6.6% |
| events-all | first | 26.040 | 1.001 | -96.2% | 31.482 | 2.084 | -93.4% |
| events-all | next | 39.527 | 1.106 | -97.2% | 48.105 | 1.764 | -96.3% |
| events-hot | first | 20.916 | 1.089 | -94.8% | 29.227 | 2.044 | -93.0% |
| events-hot | next | 33.300 | 1.288 | -96.1% | 39.694 | 2.193 | -94.5% |
| events-rejected | first | 25.594 | 1.002 | -96.1% | 32.126 | 2.004 | -93.8% |
| events-rejected | next | 39.553 | 1.275 | -96.8% | 53.897 | 2.376 | -95.6% |
| events-expired | first | 22.274 | 1.318 | -94.1% | 26.661 | 2.728 | -89.8% |
| events-expired | next | 34.334 | 1.326 | -96.1% | 41.216 | 2.617 | -93.7% |
| events-hot-rejected | first | 22.563 | 1.357 | -94.0% | 27.050 | 2.520 | -90.7% |
| events-hot-rejected | next | 35.104 | 1.358 | -96.1% | 46.493 | 2.842 | -93.9% |
| events-hot-expired | first | 20.389 | 1.290 | -93.7% | 27.324 | 2.610 | -90.4% |
| events-hot-expired | next | 33.585 | 1.213 | -96.4% | 41.190 | 2.408 | -94.2% |
| events-rejected-expired | first | 27.062 | 1.028 | -96.2% | 32.262 | 2.328 | -92.8% |
| events-rejected-expired | next | 38.308 | 1.161 | -97.0% | 52.130 | 2.465 | -95.3% |
| events-hot-rejected-expired | first | 22.651 | 1.047 | -95.4% | 28.474 | 2.095 | -92.6% |
| events-hot-rejected-expired | next | 35.466 | 1.360 | -96.2% | 42.503 | 3.626 | -91.5% |

AFTER在20／20 cells的p50較低，在19／20 cells的p95較低；唯一p95例外為`inside-all / first`，由89.430ms變為92.658ms，約增加3.6%。這是結果摘要，不是索引對延遲的單因果證明。公開`summary.json`另逐筆保存上述20組BEFORE／AFTER配對的p50、p95與delta，供機器審閱。

## 4. Explain與公開證據

獨立command-monitoring client逐格捕捉production adapter實際aggregate，再以`executionStats`重放；40／40 cells各只有一次有效capture，capture ID共40個，SHA-256 command identity共20個。相同case／page的BEFORE與AFTER刻意重用相同查詢命令，因此共享command identity，但各自保存所屬索引狀態的executionStats。40份皆保存主cursor摘要，其中8份Qualification／INSIDE explain另有Face `$lookup`摘要；公開`explain-summary.json`逐筆保存安全欄位，完整去敏command及executionStats只保留在ignored正式run。

本次只追蹤以下精簡公開證據，不將`raw.jsonl`、40份完整explain或其他大型私有artifact提交至Git：

- [summary.json](summary.json)
- [fixture-manifest.json](fixture-manifest.json)
- [explain-summary.json](explain-summary.json)
- 本報告

私有正式run由manifest的50個artifact hash保護；若私有檔案不存在，公開摘要仍可供審閱，但不能取代raw的重新計算或宣稱第三方已重跑。

## 5. 限制、矩陣裁定與STOP

- BEFORE固定先於AFTER，兩者雖使用同一DB／fixture且各自清plan cache，仍可能受cache、系統暖機與固定順序影響。
- 實驗只在一台WSL2 x64主機、12 logical CPUs、約25.2GB可見記憶體及單成員MongoDB上執行一次；不是跨主機benchmark、正式容量規劃或SLA。
- 量測production Mongo adapter，不包含HTTP、Auth、read-observation lease、網路代理或多API instance延遲。
- 未使用hint或`allowDiskUse`；未移除outlier。結果不能外推到不同資料分布、硬體、Mongo版本或正式流量。
- G09b只使**E04**取得完整直接證據，由U升V。E06仍包含全系統規則、權限、秘密、冪等、並行、fault、budget與維護，維持U。
- G10 fault／private control／logs、G11 maintenance／deployment、OpenAPI、CI、公開Demo及G12完整release均未完成。

矩陣由28V／108U變為29V／107U。依25 STOP正式停止於G09b；下一合法gate為G10a，尚未開始。
