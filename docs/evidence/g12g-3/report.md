# G12g-3 雙 Compose profile

狀態：**PASS（Compose 靜態拓撲與 Local dirty-development 回歸限定證據；非真 Atlas 相容或部署證據）**

## 完成範圍

- 保留 `infra/g11/compose.yml` 作為 `LOCAL_SELF_HOSTED` 拓撲；新增獨立 `infra/g11/compose.atlas.yml` 作為 `ATLAS_MANAGED` 拓撲。兩者使用同一 API image、production command、pinned NGINX image及同一 NGINX config。
- Local project 固定為 `passhub-g11`，保留 API、MongoDB 8.0.32、proxy、`mongo-data`、database network、Mongo root secrets及keyfile。
- Atlas project 固定為 `passhub-g12g3-atlas`，只有exact `api`＋`proxy`及`edge` network；沒有Mongo service、database network、top-level named volume、root／keyfile／maintenance secret或API host port。
- Atlas API只取得application Mongo URI、JWT及comparison三個file-backed secret references；descriptor directory固定掛載至`/run/passhub/dataset`，為read-only且禁止Compose自動建立host path。
- 靜態契約拒絕raw `x-*` decoy、Mongo URI literal、缺少Local `mongo-data`、錯誤project identity、API／proxy／NGINX mount drift，以及固定危險host source。三個secret host files必須為互異絕對路徑，且不能與已知可寫runtime tree或descriptor tree重疊。
- Compose checker只以synthetic canary執行兩份`docker compose config --format json`；沒有呼叫`create`／`up`、沒有啟動Atlas profile、沒有讀取或連線真Atlas。

## 驗證結果

- Exact full-unit toolchain：pinned Node image `node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`，Node `v24.21.0`、npm `11.19.0`、Docker `29.0.0`；`npm run test:unit`為86 suites／1454 tests PASS。
- Host orchestration：Node `v24.12.0`、npm `11.6.2`、Docker `29.0.0`、Compose `v2.40.3`。host版本低於package engine，因此只負責Docker／專項development-gate orchestration，不冒充exact-toolchain release evidence。
- `npm run test:g12g3`：1 suite／67 tests及20個exact Compose checker cases PASS。
- `npm run test:g12g1`：3 suites／65 tests、boundary、9個錯誤checker mutation拒絕、1個terminal正例接受，以及132正式＋11排除＝143 requirements baseline PASS；文件狀態更新後另重跑current-state checker。
- `npm run test:g12g2`：2 suites／37 tests、boundary、runner safety 3 cases及真Local Mongo integration 1 test PASS。
- G11a Local functional regression：`test:g11a:unit` 18 tests、`check:g11a:topology` 11 cases、`test:g11a:runtime` 8 cases及cleanup全部PASS。因tracked worktree dirty，沒有執行會要求clean source的umbrella `npm run test:g11a`；這是18＋11＋8 dirty-development component regression，不取代G11a歷史clean evidence或G12h最終重跑。
- G12f Local regression：`check:g12f:docker-demo` 17 checks、`demo:g12f:docker` 8 cases及cleanup全部PASS；同樣只屬dirty-development regression。
- `git diff --check` PASS；本輪13個直接檔案沒有Mongo URI literal、Atlas host literal或inline Atlas URI環境值。`dist`沒有root-owned entry；相關Docker containers／networks／volumes及host-visible test temp均已清理。

詳細命令、結果、工具版本、runtime image與檔案指紋見`runtime.json`。

## 獨立覆核

- 專案經理確認本關只閉合雙Compose靜態拓撲與Local回歸，A18、M11、M12、M15、M13及E10不得升格為完整`V`。
- 架構師三輪唯讀覆核依序找出並促成修正：raw decoy context、writable host alias、project identity及危險secret host path。最終架構覆核PASS，未發現G12g-4越界。
- 獨立測試員重讀規格與契約後，按序重跑G12g-1／2／3、G11a、G12f及exact full unit，判定functional PASS。

## 證據限制

- 受測工作樹以HEAD `8322ce3d7f859212b0c35b6fac2ec057fcf0b669`為基底，包含尚未提交的G12g-0至g-3差異；這是development-gate evidence，不是clean release evidence。
- 本關沒有真Atlas連線、URI、SRV／TLS／auth、managed session／transaction、schema／index、initializer、app／maintenance最小權限或credential separation runtime證據。
- 唯讀descriptor只證Compose raw／normalized mount契約與source isolation；尚未證真container mount owner／mode startup、atomic publish或no-hot-reload整合。
- 沒有blue／green maintenance、safe-reuse、跨profile業務等價、protected CI、公開HTTPS、scheduler、HA或SLA證據。
- Checker只宣稱正常與handled-error cleanup；沒有宣稱SIGTERM／SIGINT interrupt-safe temp cleanup。
- A18、M11、M12、M15、M13及E10均維持`U`，只追加本關直接支持的局部切片。
- 下一合法子關為G12g-4；直到該關才需要受保護的Atlas application／maintenance credentials及隔離測試資料庫。本關在此STOP。
