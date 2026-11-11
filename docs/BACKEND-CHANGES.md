# App changes needed for Shinro live

For the backend team, `Quest1Codes/shinro`, branch `camunda-demo-graph-deployment-main`.
The infrastructure is built and running (see [TODO.md](TODO.md) for status). These are the changes on the app side that it needs. Last updated 2026-11-11.

Items 1–3 block demo sessions on EKS; the EKS cluster is deployed once they're in.

**Status 2026-11-11:** items 1, 2, 3, 4 (group mapping), 5, 7 (`/docs`, console hint, metrics) and the terminal image's Debian fix are **done** in commit `4b1c5d3f` ("App changes for the live demo on EKS"). They're switched on by settings the Shinro EC2 now sets: `DEMO_EKS_CLUSTER`, `DEMO_EKS_REGION`, `DEMO_SANDBOX_NODE_POOL`, `DEMO_SESSION_API_URL`, `DEMO_CAMUNDA_CONSOLE_URL`, `DEMO_TEMPORAL_UI_ROUTE_SECRET`, `DEMO_METRICS_NAMESPACE`, `API_DOCS_ENABLED=false`. **Still open:** item 6 (`api-env` settings incl. `DEMO_LLM_PRICES_USD_PER_MTOK` for the spend metric, UI build, public page), the Go dependency bumps and the Temporal image (item 8).

---

## 1. Authenticate to EKS without the `aws` CLI

**File:** `apps/api/agents/demo/kube.py` (`_api_client`)

**Problem:** the API loads a kubeconfig (`DEMO_KUBECONFIG=/etc/shinro/kubeconfig`) whose login step runs `aws eks get-token`. The API image has no `aws` binary, so every Kubernetes call fails. The API log already shows `No such file or directory: 'aws'`.

**Change:** build the EKS bearer token in Python with **boto3** instead:

- Presign an STS `GetCallerIdentity` request with the header `x-k8s-aws-id: shinro-live` (the cluster name), expiry 60 s.
- The token is `k8s-aws-v1.` + the presigned URL, base64url-encoded, padding stripped.
- Give it to the Kubernetes client as a bearer token, with the cluster endpoint and CA from `eks:DescribeCluster` (cluster `shinro-live`) or from the kubeconfig.
- Tokens last 15 minutes: refresh before then.

It runs as the Shinro EC2's instance role (`shinro-live-shinro-host`). That role is already allowed into the cluster as Kubernetes group `shinro:session-controller`; nothing else to configure.

## 2. Schedule session pods onto the sandbox nodes

**File:** `apps/api/etc/demo/session.yaml.tmpl`, both the `temporal` and `terminal` Deployments.

**Why:** sandbox code is LLM-generated, so it runs on its own tainted node group, away from the cluster's own components. Pods without the toleration stay `Pending` forever.

**Add to each pod spec:**

```yaml
tolerations:
  - { key: shinro.ai/sandbox, operator: Equal, value: "true", effect: NoSchedule }
nodeSelector:
  shinro.ai/pool: sandbox
```

## 3. Reach the API through its public address

**File:** `apps/api/etc/demo/session.yaml.tmpl`

**Why:** as you asked, there is no private path from EKS to the Shinro EC2 any more. Sandboxes call the API the same way any user does.

**Changes:**

- Remove the `shinro-api` **Service** and **Endpoints** objects.
- In the terminal container: `SHINRO_API_URL=https://temporal.shinro.ai/v2`.
- NetworkPolicy egress for session pods:
  - DNS (kube-dns, UDP/TCP 53)
  - the namespace's own Temporal (7233)
  - **TCP 443 to `0.0.0.0/0` except `10.60.0.0/16` and `169.254.169.254/32`**: the public API, the Go proxy and Maven Central are reachable; the internal network and the metadata service are not.

### Rules the cluster already enforces

No change needed; just don't break them, or the cluster refuses the request:

- Session namespaces are named `demo-<hex>` and labelled `pod-security.kubernetes.io/enforce: restricted`.
- The session controller may create, change and delete namespaces, services, endpoints, resource quotas, limit ranges, deployments and network policies, and read pods and pod logs. Nothing else (no secrets, no exec, no RBAC).

---

## 4. Login: use the demo pool, map the stream group

**Files:** `apps/api/core/oauth/cognito.py`, `apps/api/core/rbac.py`

- The Shinro EC2 already sets `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET` and `COGNITO_DOMAIN` for the new demo pool `shinro-live-demo`, with callback `https://temporal.shinro.ai/v2/oauth/callback`. Please confirm that's all the API needs.
- The pool has one Cognito **group per stream**, named after it: `temporal`. The API only maps `demo-users` to the Demo role. Please map `temporal` (and future stream groups) to Demo as well.

## 5. Temporal UI lookup (for `demo-temporal-ui.shinro.ai`)

Each user must see **their own** Temporal UI. nginx on the Shinro EC2 asks the API which one:

- **Request:** `GET /v2/demo/temporal-ui/route` with headers `X-Auth-Request-Email` (set by nginx after login; never trust it from a browser) and `X-Original-URI`.
- **Response if the user has a session:** `200` with `X-Accel-Redirect: /_temporal/<node-ip>/<nodeport><original-uri>`. nginx then proxies there itself, and only to addresses in `10.60.x.x` and ports 30000–32767.
- **Response otherwise:** `404` with a "start a migration" page.
- **Session template:** expose Temporal's UI port **8233** on a **NodePort** service.

The route is internal: nginx returns 404 for it from the internet.

## 6. Settings and content

- **Secrets Manager `shinro-live/shinro/api-env`:** replace `{}` with a JSON object of the API's settings, e.g. `{"LLM_API_KEY": "…"}`. These override the defaults the server sets. Same for `shinro-live/shinro/tool-exec-env` if tool-exec needs anything. The API reads them on restart.
- **UI build** → `s3://shinro-live-ui-425106880357/temporal/` (`index.html` + `assets/`), built with `VITE_API_URL=https://temporal.shinro.ai/v2` and `VITE_WS_URL=wss://temporal.shinro.ai/v2`.
- **Public landing page** → `s3://shinro-live-site-425106880357/temporal.shinro.ai/index.html`. It must not use `/assets/`, which goes to the app.

## 7. Smaller items

- **`/docs` off in production:** FastAPI `docs_url`, `redoc_url`, `openapi_url` = `None`. nginx already blocks these paths.
- **Show `demo` / `demo`** beside the Camunda console link in the chat (the second login, into Camunda's own read-only account).
- **Publish 3 metrics** to CloudWatch namespace `ShinroLive/App`, no dimensions. The alarms are already waiting for them:

  | Metric | Value | Alarm |
  |---|---|---|
  | `ActiveSessions` | current number of sessions | 18 of the cap of 20 |
  | `SessionStartFailures` | 1 per failed start | 3 or more in 15 min |
  | `LlmSpendUsd` | dollars per LLM call | over $50 in a day |

## 8. Before go-live

- **Third-party script in the UI:** `apps/ui/index.html` loads `https://cdn.gpteng.co/gptengineer.js` (left from GPT Engineer / Lovable). Every visitor runs it inside the app with their session. Remove it, or self-host it with a Subresource Integrity hash.

- **Dependency vulnerabilities** found by OSV-Scanner in the release pipeline (first run, 2026-11-11): **675**, almost all from old Go versions declared in `go.mod`.
  - 656: Go standard library 1.26.0 / 1.26.1 / 1.24.2, declared in 14 `go.mod` files under `tools/` (sqlserver, new-relic, memcached, camunda, gap_to_click, acr). Fix: set each `go` directive (or a `toolchain` line) to the latest Go 1.26 patch, and rebuild with a current `golang:1.26` image.
  - `github.com/klauspost/compress` (6), `github.com/andybalholm/brotli` (6), `golang.org/x/crypto` 0.58.0 (2): update.
  - `pytest` 8.0 and npm `deepmerge` (dev/test only): update when convenient.
  - The pipeline only warns about these for now. When they're fixed, set `OSV_BLOCKING: "1"` in `.github/workflows/live-release-main.yml`.

- **Image vulnerabilities** found by ECR scanning:
  - `shinro-live-terminal`: 12 HIGH in the Debian 12 base (krb5, util-linux, zlib, glibc). Update packages at build (`apt-get upgrade`) or move to Debian 13.
  - `temporalio/temporal:1.10.0`: 1 CRITICAL (zlib). Move to a newer Temporal release once it ships a fixed zlib.
