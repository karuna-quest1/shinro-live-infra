# Shinro Live Infra — CDK Deployment Plan (condensed)

**This is the short version.** Same plan, same section numbers as [`PLAN-v2.md`](PLAN-v2.md) — so "decision 4.6" or "gotcha 5.20" means the same thing in both. v2 explains every term from the ground up and holds the glossary; this one assumes you know them. **Keep the two in step when either changes.**

**Sources:** the *Camunda to Temporal Changes* tab of `Shinro Deployment Tracker (6).xlsx` (rows cited `T-10`, `T-28`, …) and `image.png`. `../shinro-demo-infra` is a source of **patterns only** — none of its EC2, stack, SSM names or ECR repos are reused.

## Design decisions baked in

1. **Streams.** The product is split per migration path. Each stream gets a subdomain (`temporal.shinro.ai`), its own Cognito pool and its own oauth2-proxy.
2. **One new demo pool, one group per stream** — created by CDK. Group membership decides which demos a person can open, and **a user may be in several**. **Contradicts T-13** ("reuse the existing pool"); see 4.2.
3. **Access is requested via a HubSpot form** on the stream page, then granted **by hand**. No self-sign-up, no sync job.
4. **Passwordless** — Cognito email OTP. No passwords anywhere.
5. **After login the user lands in the app** at `temporal.shinro.ai/chat/<convid>`.
6. **`reference.shinro.ai` dropped** (T-35 deferred, see 4.14). Demo Camunda is **shared**. Per-user Temporal sessions are served at **one hostname with no id in the URL** (4.6).
8. **Camunda keeps Keycloak as its IdP** (4.20). Cognito guards *our* edge; Keycloak is what Camunda validates tokens against. Local reference stack: `~/Playground/camunda-full`, **Camunda 8.8.32**, consolidated mode.
7. **The CLI runs in the browser** — a terminal panel on the chat page, backed by a real shell in the user's sandbox. Adds a terminal container to the session pod, makes shinro-api a WebSocket relay, and **contradicts T-32's egress rule** (4.17).

---

# 0. Hostname map

**Rule 4.1: every hostname belongs to exactly one stream, and that stream's oauth2-proxy guards it.**

| Hostname | Stream | Auth | Path → served by |
|---|---|---|---|
| `shinro.ai` | — | public | CloudFront → S3 |
| `temporal.shinro.ai` `/` | temporal | public | CloudFront → S3 (folder per host) |
| `temporal.shinro.ai` `/chat/*`, `/v2/*`, `/oauth2/*` | temporal | **logged in** | CloudFront → nginx → api / oauth2-proxy |
| `demo-camunda-instance.shinro.ai` | temporal | **logged in** | A record → nginx → Camunda private IP |
| `demo-temporal-ui.shinro.ai` | temporal | **logged in** | A record → nginx → *the logged-in user's* NodePort |
| `<next>.shinro.ai` | next | mixed | same pattern, loop-driven |

Two routing styles, deliberately (4.4): **mixed public+app hostnames → CloudFront** (it splits by path); **pure app hostnames → A record straight to EC2** (nothing to cache, long-lived connections).

---

# 1. Components

| Where | Runs | Notes |
|---|---|---|
| **Shinro EC2** (public subnet, EIP) | nginx, **N × oauth2-proxy** (one per stream), shinro-api, redis, tool-exec — one Compose stack | Only public entry besides CloudFront (T-18). TLS on disk via certbot (4.5). api also relays terminal WebSockets (2.8) |
| **Camunda EC2** (private subnet, no public IP) | Camunda **8.8.32** consolidated (`orchestration` = Zeebe + Operate + Tasklist + REST) + Elasticsearch + Keycloak + Identity + Postgres + OMS app (T-11) | SG allows Shinro SG only (T-10, T-12). **Shared** across all stream users. Ports: 4.16 |
| **EKS** (private subnets) | One namespace per user: Temporal dev server + worker + **terminal container** (ttyd, tmux, CLI, Go 1.26) | Created/deleted at runtime by the session controller, **not** by CDK. TTL 2 days / 48 h |
| **CloudFront + S3** | Marketing + per-stream pages; `/chat`, `/v2`, `/oauth2` proxied to EC2 | Behaviours match **path, not host** — the reason for 4.4 |
| **Cognito** | **One** demo pool, passwordless (email OTP) over SES, **one group per stream** | CDK owns it. `RemovalPolicy.RETAIN` — it holds every demo customer |
| **Supporting** | Secrets Manager, SSM (params + Session Manager), ECR, CodeBuild, CloudWatch, DLM, Route 53, ACM, SNS, Budgets | |

**Auth split:** oauth2-proxy does **authentication only** — "is this a user of *this stream's* pool?" It does not enforce read-only Camunda (4.11) or decide which session you see (that's the email lookup, 4.7).

**Stream isolation is group-based:** one shared demo pool, one oauth2-proxy per stream, each gating on `--allowed-group=<stream>`. That flag is load-bearing — generate it from the stream name so it can't be omitted (5.18, 5.19). Pool-per-stream was the earlier design; it saved no oauth2-proxy containers (`--allowed-group` is per instance either way) and cost N passwordless configurations. See 4.2.

---

# 2. Request flows

**2.1 Public stream page.** `temporal.shinro.ai/` → wildcard DNS → CloudFront → default behaviour → CloudFront Function rewrites host→folder → S3 via OAC. No login.

**2.2 "Request a demo".** Button opens the HubSpot form carrying a **stream field** (pre-filled per page). Team member reads it, creates the user in the **one** demo pool and adds them to **that stream's group**, replies. A returning prospect asking about a second stream needs only the extra group. Page must set expectations on turnaround (4.12).

**2.3 "Sign in".** Button links to `/oauth2/start?rd=/chat` — oauth2-proxy's own endpoint, so no custom code. CloudFront `/oauth2/*` → nginx → oauth2-proxy-temporal → Cognito Managed Login → email + OTP via SES → `/oauth2/callback?code=…` → token exchange with client secret → cookie `_shinro_temporal` on `.shinro.ai` → redirect to `/chat`. **Email not in the demo pool ⇒ no code is ever sent. In the pool but not in this stream's group ⇒ code arrives, Cognito login succeeds, then oauth2-proxy 403** — a visible failure, not silence (5.18).

**2.4 The app.** `/chat/*` → CloudFront (uncached) → nginx `auth_request` → oauth2-proxy → `202` + `X-Auth-Request-Email`. nginx **overwrites** identity headers (5.7) and proxies. No `<convid>` ⇒ api creates/resumes a conversation and redirects. Chat WebSocket runs over `/v2/*`.

**2.5 Shared demo Camunda.** `demo-camunda-instance.shinro.ai` → own A record (bypasses CloudFront) → TLS at nginx → `auth_request` to **the temporal proxy** → existing `.shinro.ai` cookie means **no second login** → proxy to `http://<camunda-private-ip>:**8080**` (8.8 serves `/operate`, `/tasklist`, `/v2/...`, `/sso-callback` on one port). Elasticsearch 9200, management 9600, Keycloak 18080 never exposed (T-12).

**2.6 Starting a migration** (T-29/T-30/T-34):
1. **Lease** a session — warm pool or create. Idempotent per user; later migrations reuse it.
2. **Lease record** in Redis keyed by email: namespace, NodePort address, expiry. Internal session id used for the namespace name, Redis key and image tag — **never in a URL** (4.6).
3. **Codegen** in tool-exec (LLM API).
4. **Build** the generated project in **CodeBuild**, never on the Shinro host (T-34) → image in ECR.
5. **Run** the worker pod in the user's namespace on that migration's task queue, replacing the previous one.
6. **Validate** — the tool connects from the Shinro EC2 to the session's Temporal gRPC (7233) via NodePort (T-45, T-48).
7. **Link** the user to `https://demo-temporal-ui.shinro.ai` — same URL for everyone.
8. **Expire** at TTL (2 days): namespace and Redis entry deleted. No backups (T-33).

**2.7 Opening the Temporal session.** `demo-temporal-ui.shinro.ai` → A record → TLS at nginx → `auth_request` → oauth2-proxy gives `X-Auth-Request-Email` → second internal sub-request to shinro-api: *"where is jane@acme.com's session?"* → `X-Session-Upstream: 10.0.2.31:31234` → proxy there unchanged. UI sits at the root of both the address and the hostname, so **no prefix to strip or rewrite**. No session (not started, or expired) ⇒ static page *"Start a migration to see it here"* (T-18). Resolved per request, so nothing goes stale.

**2.8 "Run in terminal".** `GET /v2/demo/session` for state, then `wss://…/v2/demo/terminal?conversation=<chat>` — under `/v2/*`, so CloudFront (uncached) → nginx → shinro-api, **no new hostname or behaviour**. API checks the oauth2-proxy cookie *and* `Origin`, confirms the user owns this chat and has a live sandbox, mints a **CLI token** (scope `demo-cli`, ≤2 h, never outliving the sandbox) stored in Redis under a **one-time code** (60 s), then connects to **ttyd** in the pod passing the *code*, never the token. In-pod `terminal-shell` swaps code→token, CLI authenticates, **tmux** attaches to `~/chats/<id>/demo-app`. Panel waits for `shinro ❯` + 400 ms quiet before typing. Closing the panel kills nothing; reopening reattaches. Per chat: own tmux session and folder, **5 retained, LRU evicted**.

**2.9 Assessment tool → Camunda** (T-13/T-14). Client-credentials token from **Keycloak** (4.20), not Cognito: `http://<camunda-private-ip>:18080/auth/realms/camunda-platform/…/token`, client `shinro-assessment`, audience `orchestration-api` → `Bearer` call to `http://<camunda-private-ip>:8080/v2/...` or `grpc://<camunda-private-ip>:26500`. gRPC goes **direct, not via nginx**. Connection params, local → deployed:

| Param | Local | Deployed |
|---|---|---|
| Zeebe address | `grpc://localhost:26500` | `grpc://<camunda-private-ip>:26500` |
| Zeebe REST / Operate base URL | `http://localhost:8088` | `http://<camunda-private-ip>:8080` |
| Auth method | `oidc` | unchanged |
| Client ID | `orchestration` | **`shinro-assessment`** (5.31) |
| OIDC token URL | `http://localhost:18080/auth/realms/camunda-platform/…/token` | same path on `<camunda-private-ip>` |
| Audience | `orchestration-api` | unchanged |

Because this path already works locally, T-14 is now configuration, not a spike. Client-credentials token from the **temporal pool**, scope `camunda/read` → `Bearer` call to Zeebe/Operate on the private IP → Camunda verifies against that pool's JWKS. **Riskiest step in the plan. Test first.**

---

# 3. The CDK plan

## 3.1 Layout

```
bin/shinro-live-infra.ts
lib/stacks/   network | edge | identity | shinro-host | camunda-host | eks | registry | build | observability
lib/constructs/stream-identity.ts     # everything one stream needs in Cognito; instantiated per stream
assets/shinro-bundle/                 # compose, nginx.conf.template, oauth2-proxy config template, render-env.sh
assets/camunda-bundle/                # jetson Camunda compose (T-11)
k8s/                                  # session template: ns, quota, limitrange, netpol, Temporal, terminal, worker
                                      #   address-agnostic — same manifests run on a local kind cluster
scripts/add-demo-user.sh              # <stream> <email>
```

**Stream list is config** (`cdk.json`) — adding a stream is an edit plus a deploy, never copy-paste:

```jsonc
"shinro:streams": [
  { "name": "temporal",
    "subdomain": "temporal.shinro.ai",
    "consoles": ["demo-camunda-instance.shinro.ai", "demo-temporal-ui.shinro.ai"] }
]
```

**Naming:** `live` wherever the old repo used `demo`, plus the stream name — `/shinro/live/<stream>/`, pools `shinro-live-<stream>`, ECR `shinro-live-*`, stacks `ShinroLive*`. The old stack keeps running untouched.

## 3.2 Reuse from `shinro-demo-infra` (patterns only)

| Old file | Reuse | Change |
|---|---|---|
| `constructs/demo-host.ts` | UserData: docker+compose, ECR login, CW agent, `s3 sync` bundle, `render-env.sh`, `compose up`; IMDSv2, encrypted gp3, SSM, no SSH | Camunda in a private subnet; role scoped to `/shinro/live/*` |
| `constructs/networking.ts` | CloudFront prefix-list lookup; **EIP created separately** (5.4); one SG per port (5.5) | New VPC with private subnets instead of the default VPC |
| `origin-secret.ts` + nginx template | Origin-secret check, WebSocket headers, Docker `resolver` + variable `proxy_pass` | Add 443 blocks for the two consoles, per-stream `auth_request`, the session lookup |
| `constructs/runtime-config.ts` | SSM params by name, generated secrets, ARNs published as params | **Per-stream** cookie and client secrets |
| `constructs/identity.ts` | Shape of pool + client + domain | → `stream-identity.ts`, per stream, with passwordless settings |
| `constructs/observability.ts` | Log group per Compose service, CW agent for mem/disk | New service list incl. N proxies |
| `storage.ts`, `registry.ts`, `ci-role.ts` | As-is | Renamed; worker + Temporal repos |

## 3.3 Stacks

**1. NetworkStack** (T-10, T-31) — VPC, 2 AZs, public + `PRIVATE_WITH_EGRESS`, `natGateways: 1`. SGs: `ShinroCfSg` (80 ← CloudFront prefix list), `ShinroPublicSg` (443/80 ← anywhere), `CamundaSg` (Operate + 26500 ← Shinro SG only), EKS node SG (30000–32767 ← Shinro SG only). Optional VPC endpoints (free S3 gateway + ECR/SSM).

**2. EdgeStack** — import `shinro.ai` hosted zone (never create). ACM cert in **us-east-1** for `shinro.ai` + `*.shinro.ai`. Private S3 site bucket + OAC, folder per host. One distribution, aliases `shinro.ai` + `*.shinro.ai`, host→folder CloudFront Function, behaviours: `/chat/*`, `/v2/*`, `/oauth2/*` → EC2 **uncached, forward everything, WebSocket-capable**; default → S3. Route 53: aliases to CloudFront (wildcard means a new stream needs no DNS change) + **A records** for the two consoles → Shinro EIP. ⚠ Audit existing records first.

**3. IdentityStack** (supersedes part of T-13) — **once:** pool `shinro-live-demo` with `featurePlan: ESSENTIALS`, `signInPolicy.allowedFirstAuthFactors: emailOtp`, `UserPoolEmail.withSES(...)`, self-sign-up off, **`RemovalPolicy.RETAIN`**; one Managed Login domain (`managedLoginVersion: NEWER_MANAGED_LOGIN` + `CfnManagedLoginBranding`); SES `EmailIdentity` for `shinro.ai` with Easy DKIM wired to the zone, then request **production access** (~1 day); IAM role `shinro-live-user-admin` scoped to this pool.
**Looped over `shinro:streams`:** a `CfnUserPoolGroup` named after the stream (membership = the access decision; users may be in several); app client `oauth2-proxy-<stream>` (auth-code, `openid email profile`, `generateSecret`, auth flow `user: true` for `ALLOW_USER_AUTH`, callbacks = subdomain + every `consoles` entry, 5.23); a cookie secret per stream; secrets → Secrets Manager; SSM params for the shared pool id/issuer plus each stream's client id, group name and secret ARNs.
Temporal stream only, **and only if 4.20 picks Cognito for Camunda (not the recommendation)**: resource server `camunda` + scope `read`; app client `camunda-assessment` (client-credentials, `camunda/read`, `generateSecret`). If Keycloak stays, none of this is built.

**4. RegistryStack** (T-31, T-34) — ECR `shinro-live-{api,tool-exec,temporal,session-worker}`, scan on push, lifecycle rule expiring session-worker images after a few days.

**5. CamundaHostStack** (T-10/11/12/19/20) — full runbook: **[`CAMUNDA-DEPLOYMENT.md`](CAMUNDA-DEPLOYMENT.md)**. — private subnet, no public IP, `CamundaSg`, SSM role, encrypted gp3 100 GiB, start `m7i.xlarge` (Elasticsearch is memory-hungry). UserData = old pattern + jetson compose; OIDC/JWT point at the **temporal pool issuer** (T-14). Seed BPMN with an admin credential users never get (T-15). ⚠ T-15 lists **OMS + banking**, but banking was removed from the jetson cluster on 2026-11-04 — **confirm what is actually being seeded** before writing the script.
**Trim the Compose file first:** keep `orchestration`, `elasticsearch`, `identity`, `keycloak`, `postgres` + the OMS app; drop `optimize`, `web-modeler` (+ its Postgres), `console`, `connectors`, `mailpit`. Several GB saved; size *after* trimming.
**Config changes from `camunda-full`:** `server.forward-headers-strategy` `none`→**`native`** (5.32); `HOST`→`demo-camunda-instance.shinro.ai`; `KEYCLOAK_HOST`→`keycloak`; `operate`/`tasklist` `redirectRootUrl` and `OIDC_REDIRECTURI`→the public https host; Keycloak admin `admin/admin` and every `demo-*-secret`→generated into Secrets Manager; remove `orchestration` from `initialization.defaultRoles.admin.clients` and give Shinro/OMS a read-only `shinro-assessment` client (5.31).
**Keycloak stays** (4.20); add Cognito as an OIDC identity provider inside the `camunda-platform` realm so the second login is silent. Keycloak's Postgres joins the DLM snapshots. **DLM** daily snapshots, keep 7 (T-19) — matters more because the instance is shared. Alarms on mem/disk; health via a cron or in-VPC Lambda publishing a custom metric (Route 53 health checks can't reach a private IP). Publish private IP to `/shinro/live/camunda-private-ip`.

**6. ShinroHostStack** (T-12, T-18) — public subnet + EIP (allocated separately, 5.4), `ShinroCfSg` + `ShinroPublicSg`. Compose: nginx, **one oauth2-proxy per stream**, api, redis, tool-exec — compose and proxy configs are **templates rendered per stream at boot** from the SSM stream list. certbot wildcard cert (4.5).

| Listen | Host | Path | Action |
|---|---|---|---|
| 80 | any | `/oauth2/*` | origin secret → that host's stream proxy |
| 80 | any | `/chat/*`, `/v2/*` | origin secret → `auth_request` → shinro-api |
| 443 | `demo-camunda-instance` | all | `auth_request` (temporal proxy) → Camunda private IP |
| 443 | `demo-temporal-ui` | all | `auth_request` → session lookup by email (4.7) → user's NodePort, else the "start a migration" page |

Everywhere: strip-and-set `X-Auth-Request-*` (5.7); forward `Upgrade`/`Connection`. Role: read `/shinro/live/*` + named secrets, ECR pull, `eks:DescribeCluster`, `codebuild:StartBuild`, plus an EKS Access Entry from Stack 7.

**7. EksStack** (T-28/30/31/32) — `aws-cdk-lib/aws-eks` or `aws-eks-v2-alpha` (5.10). Endpoint **PRIVATE** (5.9). Managed node group in private subnets, `m7i.large`, min 1, max sized for ~20 sessions (T-30), tuned by T-36. Add-ons: `vpc-cni` with `enableNetworkPolicy: "true"`, `coredns`, `kube-proxy`, optional Container Insights. Access entry: Shinro EC2 role → ClusterRole limited to namespaces/deployments/services/quotas/netpols — **not cluster-admin**. Node SG NodePort range ← Shinro SG only. **No reference namespace** (4.14).
Note `vpc-cni` NetworkPolicy matches pods and IP ranges but **not DNS names** — see 4.17 before assuming it is enough.
**CDK does not create session namespaces.** The session controller does, at runtime, from `k8s/session-template/`: namespace + ResourceQuota + LimitRange (**including `ephemeral-storage` limits**, 5.28) + NetworkPolicy (default deny; own Temporal, DNS, Shinro API, and Go module egress per 4.17) + Temporal dev server + Service (NodePort 8233 UI, 7233 gRPC, **no path config needed**, 4.6) + **terminal container** (ttyd/tmux/CLI/Go 1.26, own NodePort for the API to reach ttyd) + worker, with T-32 securityContext (non-root, no privilege escalation, CPU/RAM limits, read-only rootfs **plus writable `emptyDir` for home, Go cache and `/tmp`**, 5.25).
**Node group must set `singleProcessOOMKill`** — a kubelet/cgroup-v2 option in the launch template, not a pod field (5.30).

**8. BuildStack** (T-34) — **only if 4.18 keeps it.** CodeBuild project, no access to anything sensitive. In: generated project zipped to S3. Out: `shinro-live-session-worker:<session-id>` in ECR. api calls `StartBuild` and polls. Keeps LLM-generated code off the Shinro host.

**9. ObservabilityStack** (T-20, T-33) — log group per Compose service incl. each proxy; Container Insights. Alarms: Camunda disk/mem/health, Shinro disk/mem, EKS node capacity, session count (custom metric), failed session starts, **AWS Budgets** cost. Metric filter on oauth2-proxy 403s surfaces wrong-pool onboarding (5.18). SNS → email.

## 3.4 Build order

| # | Do | Proves | Rows |
|---|---|---|---|
| 0 | Settle Part 4. `cdk bootstrap` | — | — |
| 1 | NetworkStack | VPC up, NAT egress works | T-10, T-31 |
| 2 | IdentityStack: the pool + **one** stream's group and client | Test user gets an OTP email and signs in; `curl` gets a client-credentials token | T-13 (part) |
| 2a | Run the onboarding runbook for a test email | Code arrives, login works; after `admin-disable-user` it doesn't | — |
| 3 | RegistryStack + CamundaHostStack (trimmed Compose, Keycloak kept) | 8.8 boots privately on 8080/26500; a `shinro-assessment` Keycloak token is accepted; demo user gets **403 on deploy/cancel/modify** (5.31); login works through nginx (5.32) | T-10/11/14/15/16 |
| 4 | ShinroHostStack: nginx + one proxy + Camunda route | `demo-camunda-instance.shinro.ai` login end to end | T-12, T-18 |
| 5 | EdgeStack | Stream page public; `/oauth2/start` logs in; `/chat` + `/v2` reach the app | — |
| 6 | EksStack + session template + controller + email→session lookup | Two users on one URL each see **their own** session; a hand-set `X-Auth-Request-Email` changes nothing; after TTL → "start a migration" | T-28/29/30/31/32 |
| 6a | Terminal container + `/v2/demo/terminal` relay | "Run in terminal" opens a shell in **your** sandbox; refresh reattaches; the one-time code can't be replayed; `go build` works | — |
| 7 | BuildStack **(only if 4.18 keeps it)** | Generated worker runs in the session | T-34 |
| 8 | ObservabilityStack + DLM | Alarms fire on test | T-19/20/33 |
| 9 | **Add the second stream** via config — group + client + proxy, **no new pool** | Stream-A-only user gets 403 on stream B; a user in **both** groups reaches both | — |
| 10 | Load test; tune quotas, node max; hand Camunda concurrency to backend | Holds at target users | T-17, T-36 |

- **2–3 first** because T-14 is flagged "riskiest, test early."
- **9 is not polish** — it's what proves the stream list isn't one hard-coded stream.
- **Dropping `reference.shinro.ai` removed the pre-EKS milestone.** Step 6 is now on the critical path to the first demo (4.14).

---

# 4. Decisions

**4.1 Hostname→stream rule — adopt.** Every hostname belongs to exactly one stream; that stream's proxy guards it. Without it, a shared hostname leaves nginx unable to pick a login page for a cookie-less visitor. Both consoles belong to **temporal**. Enforced via `shinro:streams`.

**4.2 Which pool — resolved: one new demo pool, one group per stream.** Two questions, often conflated. *(i) New pool or existing?* **New** — passwordless on the pool real Shinro customers use would change their login page and bill; a separate pool removes that and CDK owns it fully. *(ii) One pool or one per stream?* **One.** The passwordless setup (six interlocking settings, the likeliest thing to get wrong) is done once, as are branding, domain prefix and deliverability testing; a prospect wanting two streams gets one account; a wrong-group slip fails *visibly* rather than silently. **No extra containers either way** — `--allowed-group` is per oauth2-proxy instance, so there's one proxy per stream regardless. Gives up: a stream-A token now validates at stream B's proxy, with `--allowed-group` the only gate — low consequence, since sandboxes stay per-user and Camunda read-only. Contradicts T-13; get it agreed. **`RemovalPolicy.RETAIN`** (5.12).

**4.3 A later stream needing its own Camunda/Temporal.** Give it **its own hostname** under that stream's `consoles`. Never share a console hostname between streams. Last-resort fallback if unavoidable: pick the proxy from which `_shinro_<stream>` cookie is present, with a disambiguation page when none is.

**4.4 What goes through CloudFront — resolved.** Stream subdomains yes (they mix cached public pages with uncached app paths). The two consoles no (all dynamic, long-lived connections). **Why not everything:** CloudFront behaviours match **path, not host**, so a console's `/` would fall to the default behaviour and hit S3. Putting them behind CloudFront needs a second distribution — workable, and it would remove 4.5, but it adds a hop in front of the most latency-sensitive connections. Revisit only if cert renewal hurts.

**4.5 TLS on the Shinro EC2.** **certbot + `certbot-dns-route53`** (DNS-01; instance role may edit the zone; free, auto-renews). Get a **wildcard** so new console hostnames need no cert change. Alternatives: ACM exportable certs (paid, check renewal); an ALB (costs more, conflicts with T-18). **Alarm on expiry** either way — it takes both consoles down at once.

**4.6 One hostname per session, routed by identity — resolved.** `demo-temporal-ui.shinro.ai`, no id, no path; nginx picks the session from the logged-in email. Namespace is still per-user and still deleted at 2 days — only the URL changed. Beats `…/<id>` because: the path-prefix problem vanishes (no public-path setting to find, no `sub_filter`); there is no link to leak; T-29/T-30 say a user has only one session, so an id addressed something singular; and it is what **T-18** already described. Costs: no linkable session for support — use `kubectl`. Rejected: subdomain per session (needs wildcard DNS, puts the id back). Internal ids remain for namespace, Redis key and image tag.

**4.7 Finding a user's session — resolved.** shinro-api answers per request, keyed by email, from Redis. Not T-29's map file + `nginx -s reload`: that needs the Docker socket in the API container (root-equivalent, beside tool-exec) and goes stale. **nginx nuance:** only one `auth_request` per `location`, and two questions are needed. Either the internal-jump idiom (`error_page 418 = @session; return 418;` with a second `auth_request` in the named location) or **njs**.

**4.8 Which node IP.** NodePort answers on any node, but nodes churn. Don't freeze one at creation — the API returns a currently-healthy node each time, which per-request lookup makes easy.

**4.9 Warm pool (T-30 undecided).** Start without. Measure in T-36. Codegen already hides ~1 min of startup.

**4.10 Build technology (T-34).** **CodeBuild** (managed, isolated, IAM-scoped) over in-cluster Kaniko.

**4.11 Read-only shared Camunda (T-14 vs T-16) — resolved.** The instance is **shared**, so a user who can deploy or cancel breaks the *next* prospect's demo live. `camunda-full` already runs `authorizations.enabled: true` + `RESOURCE_AUTHORIZATIONS_ENABLED=true`, so **8.8 has built-in resource authorizations**. **Use (a):** a demo role with read permissions only; do **not** grant the `admin` role that `defaultRoles` gives `demo` locally. Rejected: (b) nginx blocking writes by path/method — Operate uses `POST` for searches; (c) a fixed injected identity — awkward with OIDC and kills per-user audit. The two-logins objection is solved by 4.20. **Still a release blocker: verify 403 on deploy/cancel/modify in step 3.**

**4.12 Expectations on the request form.** Access is human-granted. Decide and **state the turnaround** on the page ("within one business day"), decide who watches the HubSpot queue, and add a notification so requests don't sit over a weekend.

**4.13 OTP deliverability.** `no-reply@shinro.ai` with DKIM + SPF + DMARC; test Gmail and Outlook. Corporate filters delay mail and codes expire in minutes — say so on the branded login page. With one shared pool this is tested **once** rather than per stream.

**4.14 What replaces `reference.shinro.ai` (T-35 deferred).** It used to give users something to look at that didn't need EKS. Consider a recorded or static walkthrough in the app while a session is preparing (an app change, far cheaper). If T-35 returns it's a long-lived namespace plus one hostname in `consoles` — no rework.

**4.15 Offboarding.** No automation means nobody removes anyone unless it's their job. Agree: who holds `shinro-live-user-admin`, where additions are recorded, and when access ends (fixed trial, HubSpot deal closed/lost, or a monthly `list-users` review per pool).

**4.16 Camunda version and ports — resolved from `camunda-full`.** **8.8.32**, consolidated. Into **one** CDK config object: **8080** (container) = Operate `/operate` + Tasklist `/tasklist` + REST `/v2/...` + `/sso-callback` → nginx, Shinro SG only; **26500** Zeebe gRPC → Shinro SG only; 9600 management, 9200 Elasticsearch, 18080 Keycloak, 8084 Identity, 8090 OMS → instance-local (18080 also reachable from the Shinro SG for token calls). The local **8088 is a host port mapping of 8080** — don't carry it over. Also: Elasticsearch 8.17.10, Keycloak `quay-26.6.4`, Identity/Connectors 8.8.15.

**4.20 Which IdP does *Camunda* trust? Resolved: Keycloak, no federation.** Distinct from 4.2 (our users). **Keep the bundled Keycloak** — it already works locally, turning T-14 from a spike into configuration. **Cognito likely can't work**: Camunda checks `aud` against `orchestration-api` and Cognito access tokens have no settable `aud` (5.33). **Federation dropped:** it would hide the second login but costs a Cognito client, IdP config, mapper, redirector and a Camunda mapping rule while removing none of the risky unknowns. **Two gates instead:** oauth2-proxy/Cognito decides *who gets in*; a shared `demo` user with a **read-only** role decides *what they can do*. Prospect logs in twice; print the creds beside the link. **Keep oauth2-proxy in front** — the instance is shared, so without it anyone with the hostname breaks every demo at once. **Does not fix the front channel:** the browser must still reach Keycloak. **Consequence:** Stack 3 builds no Cognito `camunda` resource server or `camunda-assessment` client. → **[`CAMUNDA-DEPLOYMENT.md`](CAMUNDA-DEPLOYMENT.md)**

**4.17 Egress for Go modules — contradicts T-32, resolve it.** T-32 grants egress **only to the session's Temporal**; the terminal needs **public HTTPS** for Go modules, and a *user* now has an interactive shell in that pod. (a) allow all outbound HTTPS — simplest, weakest, NAT cost per build; (b) allow Go module hosts **by name** — basic NetworkPolicy can't match DNS, which is why the design says **Calico**; (c) **in-VPC module proxy** (Athens or S3-backed `GOPROXY`), egress only to it — tightest, fastest after warm-up, keeps deny-by-default. **Recommended: (c), fallback (b).** Pre-populate the module cache in the image either way.

**4.18 Where generated code is built — CodeBuild or the sandbox?** T-34/Stack 8 says zip → CodeBuild → ECR → worker pod. The terminal design says the user already has Go and a Temporal dev server in their own sandbox. **Not complementary — pick one.** Sandbox is simpler and far faster to iterate, and T-34's isolation argument holds either way (the sandbox isn't the Shinro host). CodeBuild wins only if you need a reproducible per-migration artifact or a worker outliving the terminal. **Decide before step 7 — if the sandbox wins, Stack 8 disappears** along with an ECR repo, an IAM permission and a polling loop.

**4.19 Warm pool — may now flip.** 4.9 said skip it. The terminal image carries the Go toolchain and CLI (likely 1–2 GB), so on-demand creation makes the user wait for a pull. Either pre-pull via DaemonSet (keeps 4.9) or keep a small warm pool. **Measure the pull time — that is the whole argument.**

---

# 5. Gotchas

**5.1 ACM certs can't go on EC2.** The private key never leaves AWS. Use certbot (4.5).
**5.2 The wildcard swallows deleted records.** Delete a console's A record and it silently resolves to CloudFront → confusing S3 403. Manage every record in CDK; on an S3 error from a console, check DNS first.
**5.3 Editing UserData replaces the server** — wipes Camunda data, moves IPs. Keep UserData minimal, changeable things in the S3 bundle, update via SSM Run Command. **Read `cdk diff` for "replacement" every time.**
**5.4 EIP before instance.** CloudFront needs the hostname; the instance config needs CloudFront values. Allocate the EIP first, associate last.
**5.5 The CloudFront prefix list eats ~55 of 60 SG rules.** Keep it in its own SG.
**5.6 Cookie domain `.shinro.ai`** gives SSO across a stream's hostnames (required) and sends the cookie to every subdomain (harmless — different secrets — but see 5.19).
**5.7 Identity header spoofing.** Always `proxy_set_header X-Auth-Request-Email $user;` from the auth sub-request. Never forward a browser-sent one. **Load-bearing**, see 5.20.
**5.8 Private subnets need egress.** No NAT/endpoints ⇒ no image pulls, no Session Manager — looks like a dead instance.
**5.9 Private EKS endpoint** ⇒ no kubectl from a laptop. Use the Shinro EC2 via SSM, or temporarily allow your IP.
**5.10 CDK `aws-eks` needs a matching kubectl Lambda layer.** `aws-eks-v2-alpha` avoids it. Pin versions.
**5.11 Renaming an app client construct ID recreates it** — new id and secret, every consumer breaks. Treat those IDs as permanent.
**5.12 Deleting the pool deletes every demo customer,** no undo, no export. One shared pool means the blast radius is all streams at once, so `RETAIN` matters more. Upside: removing a stream from config now deletes a *group*, not people.
**5.13 Same account as the old stack.** `live` naming, unique Cognito domain prefixes, distinct `Project` tag.
**5.14 Region.** CloudFront's cert must be in us-east-1. Keep everything there; enforce it in `bin/` like the old repo.
**5.15 `FORCE_CHANGE_PASSWORD`.** `admin-create-user` without a password leaves users in that state and OTP may not work. Test in step 2a; if it fails, add `admin-set-user-password --permanent` with a long random password nobody knows.
**5.16 Passwordless cost.** Essentials is per-MAU per pool. With one shared pool a user active in two streams is **one** MAU, and there's one line item, not N. Check the first bill anyway.
**5.17 OTP spam.** Anyone can trigger a code to a known customer's inbox. They can't get in; Cognito rate-limits. Plus-plan threat protection not needed.
**5.18 Wrong group — now survivable.** Put in stream B's group but logging in to stream A ⇒ code arrives, Cognito login succeeds, then **403** from oauth2-proxy. Under the old pool-per-stream design the same slip produced *no code at all*, indistinguishable from broken email; now it's a specific error at a known place. `add-demo-user.sh <stream> <email>` validates the stream; on a 403 report use `admin-list-groups-for-user`. Alarm on repeated oauth2-proxy 403s (Stack 9).
**5.19 Cookie name collisions.** Every proxy sets a cookie on `.shinro.ai`; with the default name they overwrite each other (random logouts, redirect loops). **Distinct `--cookie-name` per stream**, generated from the stream name.
**5.20 With identity routing, the email header *is* the access control.** Removing the id concentrated the risk: the only thing choosing your session is `X-Auth-Request-Email`. Test explicitly in step 6 — `curl -H 'X-Auth-Request-Email: someone-else@x.com'` must still land you on your own session.
**5.21 A session can vanish mid-browse.** At TTL the pod disappears and open connections drop. Treat "no session" and "backend gone" as one friendly state: the "start a migration" page plus `proxy_intercept_errors` with a custom 502/504 page. Consider warning the user as TTL approaches (app change).
**5.22 CloudFront caching an authenticated page** ⇒ one user sees another's content. Caching **disabled** and forward everything on `/chat/*`, `/v2/*`, `/oauth2/*`. Verify with two browsers and `curl -I` before go-live.
**5.23 Callback URLs can't use wildcards.** Build the list from the stream's `subdomain` + every `consoles` entry in code, so adding a hostname updates Cognito automatically.
**5.24 Adding a stream touches more than CDK:** config entry, deploy, S3 folder with the stream's page, HubSpot form or stream value, someone assigned to that queue, and a cross-stream access test. Write the checklist during step 9.

**5.25 Read-only rootfs vs an interactive shell.** T-32's `readOnlyRootFilesystem` was written for a non-interactive worker; a shell must write. Keep it read-only, mount writable `emptyDir` at home, the Go cache and `/tmp`. Size them (5.28).
**5.26 First session on a node is slow** — a 1–2 GB image pull. Pre-pull via DaemonSet or warm pool (4.19); show progress, since a silent minute reads as broken.
**5.27 WebSocket timeouts drop terminals.** Three idle timeouts in the path (CloudFront, nginx `proxy_read_timeout` — default 60 s, the API). Raise them as the old repo already does for chat, and send pings. tmux makes a drop survivable, not invisible.
**5.28 Sandbox disk fills quietly.** 5 retained chats × sample-app copy + Go caches on node ephemeral storage. No limit ⇒ `DiskPressure` evicts **other users'** pods. Set `ephemeral-storage` requests **and** limits.
**5.29 Losing Redis now also loses CLI-token revocation.** Redis holds leases **and** live tokens; after a host replacement (5.3) issued tokens work until they expire (≤2 h). Same fix as the lease gap — self-describing namespace labels — plus keep token TTLs short.
**5.30 `singleProcessOOMKill` is a kubelet setting, not a pod field.** In the session manifest it does nothing, silently. Without it one runaway command OOMs the container and takes the user's Temporal and worker with it.

**5.31 The demo authenticates as Camunda's admin client.** `camunda-full` runs Shinro *and* the OMS app as client `orchestration`/`secret`, and `defaultRoles.admin.clients: [orchestration]` makes that client an admin. Fine locally; against T-16 on a shared instance. Use a read-only `shinro-assessment` client for both. Test it in step 3.
**5.32 `forward-headers-strategy: none` breaks login behind nginx.** Camunda never learns the request was HTTPS, builds an `http://…/sso-callback` redirect URI, and login fails on mismatch. Set `native` (or `framework`) + nginx `X-Forwarded-Proto: https`. **Third sighting of this bug class** — HyperDX in the old repo, oauth2-proxy behind CloudFront, now Camunda behind nginx.
**5.33 Cognito access tokens have no settable `aud`.** Camunda checks `AUDIENCES_*` against `aud`; Cognito access tokens carry `client_id`/`scope` only (the ID token has `aud`, but the API path uses the access token). Keep Keycloak (4.20) — and verify against your own pool before committing either way.

---

*Terms, analogies and the A–Z glossary: [`PLAN-v2.md`](PLAN-v2.md).*
