# PassHub G12b curl Demo

這是既有十條業務端點的操作範例，不新增 API。請先在本機 Demo 啟動服務，並設定：

```bash
export BASE_URL=http://localhost:3000
export OPERATOR_TOKEN='<預置 Operator JWT>'
export VIEWER_TOKEN='<預置 Viewer JWT>'
export ENTRY_SOURCE='entry.<demo-secret>'
export EXIT_SOURCE='exit.<demo-secret>'
export DATASET_EPOCH='<目前 dataset epoch>'
```

`DATASET_EPOCH` 必須使用登入／查詢回覆提供的目前世代；不要把它寫死在 repository。以下時間請替換成未來的 UTC 毫秒 ISO 字串。

## 主流程：建立 → QR ENTRY → INSIDE → Face EXIT

```bash
create_body=$(jq -n --arg from "$VALID_FROM" --arg until "$VALID_UNTIL" \
  '{displayName:"G12b Demo Visitor",validFrom:$from,validUntil:$until,face:{provider:"DemoFace",externalSubjectId:"demo-subject-001"}}')
create=$(curl --fail-with-body -sS -X POST "$BASE_URL/qualifications" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "PassHub-Dataset-Epoch: $DATASET_EPOCH" -H 'content-type: application/json' \
  --data "$create_body")
qualification_id=$(jq -er '.qualificationId' <<<"$create")
qr_token=$(jq -er '.qrToken' <<<"$create")

curl --fail-with-body -sS -X POST "$BASE_URL/recognition/attempts" \
  -H "Authorization: Source $ENTRY_SOURCE" -H "PassHub-Dataset-Epoch: $DATASET_EPOCH" \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg token "$qr_token" '{externalEventId:"demo-entry-001",kind:"QR_SCANNED",token:$token}')"

curl --fail-with-body -sS "$BASE_URL/qualifications/inside" \
  -H "Authorization: Bearer $VIEWER_TOKEN"

curl --fail-with-body -sS -X POST "$BASE_URL/recognition/attempts" \
  -H "Authorization: Source $EXIT_SOURCE" -H "PassHub-Dataset-Epoch: $DATASET_EPOCH" \
  -H 'content-type: application/json' \
  --data '{"externalEventId":"demo-exit-001","kind":"FACE_MATCHED","provider":"DemoFace","externalSubjectId":"demo-subject-001"}'

curl --fail-with-body -sS "$BASE_URL/qualifications/$qualification_id" \
  -H "Authorization: Bearer $VIEWER_TOKEN"
curl --fail-with-body -sS "$BASE_URL/events" \
  -H "Authorization: Bearer $VIEWER_TOKEN"
```

## 必要限制案例

- `FACE_UNKNOWN` 只保存 `FACE_UNKNOWN` 拒絕事件，不建立訪客資料。
- 同一 Source＋`externalEventId` 重送同內容回放首次結果；不同內容是 `IDEMPOTENCY_CONFLICT`。
- QR 與 Face 是替代輸入，不要同時提交兩種媒介。
- 不要把 `qualificationId`、圖片、confidence、RTSP URL 或 client timestamp 放進辨識 payload。
- 建立回覆遺失時不要盲目重送 create；QR 不提供查回或補發。

這份文件不包含 `/internal/ready`、runtime control socket、reset、claim 或 runTicket 介面；那些是維護能力，不是公開業務 API。
