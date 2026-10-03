# G11a 部署拓撲基線證據

## 結論狀態

- 工程驗收：PASS。
- 獨立覆核：PM、架構與測試三方最終只讀覆核均 PASS；G11a STOP 已解除，下一合法 gate 為 G11b。
- 證據來源 commit：`320f5430753d4eda795f113b12a15dbe9dc3e004`。
- 正式 run 使用該 commit 的隔離 detached worktree；執行前 `git status --porcelain --untracked-files=no` 為空，並先跑乾淨 `npm ci`。主工作區另有既存使用者修改 `src/access/domain/access-decision.ts`，但它不在隔離 worktree、production image build context或正式 full-unit run中；本 gate未包含或改寫它。

## 本關範圍

G11a 只建立並驗證 production deployment shell：單一 Nginx HTTPS proxy、單一 Node.js API、單一 MongoDB replica-set member、固定網路邊界、外部 secrets、容器限制、可信代理解析、維護 marker 擋流 smoke 與優雅停止。API 對非 G11a probe 路徑仍回 `SERVICE_NOT_READY`；業務 composition、write claim、reset controller、systemd 與公開部署分屬後續 gate。

## 環境

- exact Node image：`node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`
- Node.js `v24.21.0`
- npm `11.19.0`
- Docker `29.0.0`（build `3d4129b`）
- Docker Compose `v2.40.3`
- Linux `6.6.87.2-microsoft-standard-WSL2 x86_64`

## 正式命令與結果

### G11a exact evidence runner

正式命令在上述 exact Node image 內、host network、隔離 clean worktree、共享 `/tmp` 與 Docker socket執行；驗證容器另外只安裝 `curl`、`git`、`openssl`、CA及掛載host Docker CLI／Compose plugin，Node/npm仍由固定image提供。容器內命令：

```bash
git status --porcelain --untracked-files=no
npm ci
npm run test:g11a
npm run test:unit
```

Exit code：`0`。

- Jest：`1 suite / 18 tests`，全部通過，failed／pending／todo 均為 0，未中斷。
- 靜態契約：11 個 exact cases 全部通過。
- 真實 runtime：8 個 exact cases 全部通過。
- runner 在 cleanup 完成後才接受完整 case manifest。

靜態 cases：

```text
G11A_TOPOLOGY_SERVICES
G11A_TOPOLOGY_IMAGES
G11A_TOPOLOGY_PORTS
G11A_TOPOLOGY_NETWORKS
G11A_RUNTIME_POLICY
G11A_SECRET_AND_MOUNT_BOUNDARY
G11A_NGINX_TLS
G11A_NGINX_PROXY_POLICY
G11A_NGINX_MAINTENANCE_FENCE
G11A_NGINX_LOG_POLICY
G11A_MONGO_AUTH_ENTRYPOINT
```

Runtime cases：

```text
G11A_RUNTIME_API_IMAGE
G11A_RUNTIME_MONGO_PRIMARY
G11A_RUNTIME_CONTAINER_POLICY
G11A_RUNTIME_PROXY_IDENTITY
G11A_RUNTIME_NETWORK_ISOLATION
G11A_RUNTIME_MAINTENANCE_FENCE
G11A_RUNTIME_GRACEFUL_STOP
G11A_RUNTIME_CLEANUP
```

### 全專案單元回歸

命令同樣在上述 exact toolchain container內執行：

```bash
npm run test:unit
```

Exit code：`0`；`59 suites / 1009 tests` 全部通過，failed 0、snapshots 0。

### 文字與清理檢查

```bash
git diff --check
docker ps -a --format '{{.Label "com.docker.compose.project"}}' | sort -u | rg '^passhub-g11a-'
docker network ls --format '{{.Label "com.docker.compose.project"}}' | sort -u | rg '^passhub-g11a-'
docker volume ls --format '{{.Label "com.docker.compose.project"}}' | sort -u | rg '^passhub-g11a-'
docker image ls --format '{{.Repository}}:{{.Tag}}' | rg '^passhub-g11a-'
```

四個查詢的 `rg` 均為「無匹配」（exit `1`），前置 Docker 枚舉命令成功；沒有任何 `passhub-g11a-` 前綴的 container project label、network project label、volume project label或專屬 image tag 殘留。每次 runtime 另以本次 exact隨機project名稱做 fail-closed cleanup assertion。

## 真實情境證據

- 以 `infra/g11/api.Dockerfile` 建置實際 production image；smoke compose 只開 probe mode，不替換 command 或 bind-mount toy server。
- Mongo 以 root secret、keyfile、`--auth` 啟動，初始化 `rs0` 後確認單一 writable PRIMARY。
- API 讀取外部 Mongo/JWT/comparison secrets、連線真 Mongo，並確認 replica-set shape 後才 listen。
- Nginx 是唯一 host port；API 與 Mongo 沒有 host port。
- proxy 不在 database network，且從 edge network 對 Mongo 固定 IP `172.31.212.10:27017` 的 TCP 連線失敗。
- Nginx 覆寫來訪者自行提供的 forwarding headers；API 只有在 socket peer 等於固定 proxy IP 時採用單一合法 `X-Forwarded-For`。解析已抽為 production ingress 元件，不只存在於 probe branch。
- `/internal/ready` 經公共 Nginx 固定回 404。
- marker 存在時 HTTPS 回 503，且 API observation counter 不增加。
- API 收到 SIGTERM 後在 30 秒 grace 內以 exit 0 結束，未 OOM。
- cleanup 對 compose resources、built image 與含秘密的 temporary tree 分階段 best-effort；多重失敗用 AggregateError 保存，任何前段錯誤都不會跳過秘密檔清理。

## 去敏指紋

以下由正式 runner 輸出；不包含 secret 值：

```text
sourceCommit=320f5430753d4eda795f113b12a15dbe9dc3e004
sourceSha256=e0a6fcf56aac4eef373280b38ee24f514c503d493c700696771cd040a2458bb5
apiImageId=sha256:bd657847d1e6de5a017c70afaba00e59fdcd19dbde5d5b15d3b2293dce7fe500
dockerfileSha256=6d022c40336cbc94c9ac1de707957c2790dd9b7d6637fc9a34a8f2b65f51afe3
composeSha256=9637ed74abbd520321f3ce2bfcf4e631a7f7966aa11fe3694d4e3198442561f9
smokeComposeSha256=bc7af6ed155dde95c8c97291c9de67d97113d8cd244653b196169794be3af6e8
nginxSha256=7e39b67ea25799386207926438109a243841e75c7c5c35cc8af36d4c9d8c6960
mongoEntrypointSha256=224cd6b610bf25fa4fcadfdc9c066aff628f3fd3936269cec8ef2ee9dd9d8141
```

## 覆核修正紀錄

首輪與第二輪覆核曾拒絕 toy probe、未實作 production entrypoint、Mongo 無認證、只驗 DNS 隔離、未封 internal route、契約 checker 過寬、trusted-proxy 只在 probe branch、timeout/cleanup 可能留下資源或秘密、缺少 exact manifest 與指紋等問題。本版本已逐項修改並以對應負例、真實 runtime 或 cleanup 斷言驗證。

第三輪 PM 與tester覆核已 PASS。架構覆核先後發現主機Node/npm低於D125固定基線，以及正式run仍受主工作區tracked dirty檔影響；這兩次綠燈均不作正式證據。最終正式run改在 commit `320f5430753d4eda795f113b12a15dbe9dc3e004` 的隔離clean worktree中，以 exact Node 24.21.0/npm 11.19.0 image執行乾淨`npm ci`與全部命令。runner自身亦會在tracked status非空時fail closed，並對全部tracked files計算source fingerprint。

第一次exact-toolchain嘗試未使用host network，驗證容器的loopback無法到達host發布的HTTPS port，因此於HTTPS probe失敗並完成cleanup；這是驗證環境錯誤，不列入正式PASS。後續使用host network但仍指向主dirty workspace的run也只作診斷。只有最後的exact-toolchain＋host-network＋clean-worktree完整run是本報告採用的正式結果。

## 未解鎖範圍

- 尚未接入既有完整業務 HTTP composition。
- 尚未建立 Mongo-backed writeRunClaim、runTicket、bootstrap/local-ready。
- 尚未建立完整 marker/drain/API+Mongo stop controller。
- 尚未執行七 collection reset/seed、systemd 排程、fault matrix 或公開 HTTPS 部署。
- G11a 不使公開 Demo、G11b–G11g 或 G12 完成交付成立。
