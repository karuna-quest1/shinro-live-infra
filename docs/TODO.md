# Shinro live: to-do

Everything still to do outside the CDK code, grouped by who does it.
Last updated 2026-11-11. Step details are in [CDK-STEPS.md](CDK-STEPS.md).

## Where things stand

| Stack | Status |
|---|---|
| Network | ✅ Deployed |
| Registry | ✅ Deployed (images pushed by hand at app commit `c6ce73da`) |
| Identity | ✅ Deployed, waiting for the Cloudflare email records |
| CamundaHost | ✅ Deployed and healthy |
| ShinroHost | ✅ Deployed and healthy (`54.147.229.249`) |
| Edge | ✅ Deployed (`d2rv7boj8gwvuc.cloudfront.net`) |
| Eks | ✅ Deployed and checked (cluster `shinro-live`); real-session test after the next release |
| Observability | ✅ Deployed (18 alarms incl. EKS, dashboard `shinro-live`, $800 budget) |

**Most urgent:** the Cloudflare records (1) and the app team's settings and UI (4).

---

## 1. You: Cloudflare (`shinro.ai` → DNS → Records)

Every record **DNS only** (grey cloud). Type only the short name; Cloudflare adds `.shinro.ai`.

| Done | Type | Name | Content / Target | Proxy | For |
|---|---|---|---|---|---|
| ☐ | CNAME | `temporal` | `d2rv7boj8gwvuc.cloudfront.net` | DNS only | The stream page and app (CloudFront) |
| ☐ | A | `camunda-demo` | `54.147.229.249` | DNS only | Camunda console (Shinro EC2) |
| ☐ | A | `demo-temporal-ui` | `54.147.229.249` | DNS only | Temporal console (Shinro EC2) |
| ☐ | CNAME | `gwht4p562hqmnm524nvozrz5swlkkw5j._domainkey` | `gwht4p562hqmnm524nvozrz5swlkkw5j.dkim.amazonses.com` | DNS only | Login-code emails (DKIM 1/3) |
| ☐ | CNAME | `yvvhgvszg5wkwgo6xpgd2qrrju5omqok._domainkey` | `yvvhgvszg5wkwgo6xpgd2qrrju5omqok.dkim.amazonses.com` | DNS only | Login-code emails (DKIM 2/3) |
| ☐ | CNAME | `w5aniopsmpizplkvssmupngqd32g2l3n._domainkey` | `w5aniopsmpizplkvssmupngqd32g2l3n.dkim.amazonses.com` | DNS only | Login-code emails (DKIM 3/3) |
| ☐ | TXT | `_dmarc` | `v=DMARC1; p=none;` | – | Email trust (DMARC) |

Plus:

- [ ] **API token** for the consoles' HTTPS certificate: My Profile → API Tokens → Create Token → "Edit zone DNS", Zone → DNS → Edit, Specific zone `shinro.ai` only. Then in AWS (us-east-1): Secrets Manager → Store a new secret → Other type → **Plaintext**, the token only → name **`shinro-live/cloudflare/dns-api-token`** → no rotation.
- [ ] Tell Claude, who runs the certificate step on the server and checks the padlock.

No Cloudflare access yet? Ask whoever registered `shinro.ai` (April 2025) to invite you with a DNS-only role, or to add the records.

## 2. You: AWS

- [ ] **SES production access**, once SES shows `shinro.ai` as *Verified* (after the DKIM records): SES → Account dashboard → Request production access. Takes about a day. Until then login codes only reach addresses verified in SES.
- [ ] **Redeploy Identity** after Claude flips `shinro:sesDomainVerified` to `true` (switches on email-code login): `npx cdk deploy ShinroLiveIdentity`.
- [x] **Deploy EKS** (2026-11-11).
- [ ] **Tidy `cdk-user`:** add back the inline policy allowing `sts:AssumeRole` on `arn:aws:iam::425106880357:role/cdk-*`, keep `AmazonEC2ContainerRegistryPowerUser` (+ `ReadOnlyAccess` for checks), then detach `AdministratorAccess`.
- [x] **Alarms:** put the team's email(s) in `cdk.json` → `"shinro:alarmEmails": ["…"]`. Then, in this order: `npx cdk deploy ShinroLiveCamundaHost ShinroLiveShinroHost` → Claude runs `update.sh` on both → `npx cdk deploy ShinroLiveObservability`. Each email gets a confirmation link from AWS; click it.
- [x] **Activate the cost tag:** Billing → Cost allocation tags → find `Project` → Activate. Without it the $800 budget sees $0. Takes up to a day to show.
- [ ] Optional: approve the last Camunda check (section 6).

## 3. Your lead

- [ ] **Camunda license.** Camunda 8 self-managed is free for non-production only. Is a sales demo covered, or is there a license? (Camunda is already running.)
- [ ] **`quest1platform.com`.** Its A record in Route 53 still points at `3.212.142.142`, now the NAT's address. Delete the record, or point it somewhere real.
- [ ] **`shinro.ai` apex.** It currently fails HTTPS. Who owns it? (Not part of this stack.)
- [ ] **Who onboards demo users** and when access ends (PLAN 4.15). They use the role `shinro-live-user-admin` and the runbook in PLAN-v2 1.8.

## 4. App / backend team

Full details, ready to send: [BACKEND-CHANGES.md](BACKEND-CHANGES.md).

**2026-11-11:** most code changes are done (commit `4b1c5d3f`); see the status at the top of BACKEND-CHANGES.md. Remaining: settings, UI, public page, dependency bumps.

Settings and content:
- [ ] **`shinro-live/shinro/api-env`** (Secrets Manager): replace `{}` with a JSON object of the API's settings, LLM keys and the rest, e.g. `{"LLM_API_KEY": "…"}`. Same for `shinro-live/shinro/tool-exec-env` if needed. Tell Claude afterwards to restart the API.
- [ ] **UI build** (automated once the pipeline change is pushed; manual until then) → `s3://shinro-live-ui-425106880357/temporal/` (`index.html` + `assets/`), built with `VITE_API_URL=https://temporal.shinro.ai/v2` and `VITE_WS_URL=wss://temporal.shinro.ai/v2`.
- [ ] **Public landing page** → `s3://shinro-live-site-425106880357/temporal.shinro.ai/index.html`. It must not use `/assets/` (that path goes to the app).

Code changes (details in CDK-STEPS step 4 and 6):
- [ ] **EKS token via boto3.** The API image has no `aws` command, so its kubeconfig can't log in (the API logs `No such file or directory: 'aws'`). **Blocks demo sessions.**
- [ ] **Treat the `temporal` Cognito group as the Demo role** (the API only maps `demo-users`).
- [ ] **Confirm** the API's `COGNITO_*` settings for the new pool `shinro-live-demo` (pre-filled by the server).
- [ ] **Temporal UI lookup:** `GET /v2/demo/temporal-ui/route` with `X-Auth-Request-Email` and `X-Original-URI` → `200` + `X-Accel-Redirect: /_temporal/<node-ip>/<nodeport><uri>`, or `404` with a "start a migration" page.
- [ ] **Session template** (`apps/api/etc/demo/session.yaml.tmpl`):
  - toleration `shinro.ai/sandbox=true:NoSchedule` + nodeSelector `shinro.ai/pool: sandbox`
  - drop the `shinro-api` Service + Endpoints; `SHINRO_API_URL=https://temporal.shinro.ai/v2`
  - NetworkPolicy egress: DNS, own Temporal, TCP 443 to `0.0.0.0/0` except `10.60.0.0/16` and `169.254.169.254/32`
  - expose Temporal's UI (8233) on a NodePort
- [ ] **`/docs` off in production:** FastAPI `docs_url`, `redoc_url`, `openapi_url` = `None` (nginx already blocks them).
- [ ] **Show `demo` / `demo`** beside the Camunda console link in the chat (the second login).
- [ ] **Publish 3 metrics** to CloudWatch namespace `ShinroLive/App` (no dimensions): `ActiveSessions` (current count), `SessionStartFailures` (1 per failed start), `LlmSpendUsd` (dollars spent per call). The alarms are already waiting for them.

Before go-live:
- [ ] Fix image vulnerabilities: **12 HIGH** in `shinro-live-terminal` (Debian base: krb5, util-linux, zlib, glibc), **1 CRITICAL** in `temporalio/temporal:1.10.0` (zlib).

## 5. CI/CD (parked)

- [ ] A GitHub admin of `Quest1Codes/shinro` sets the Actions **variable** `AWS_LIVE_RELEASE_ROLE_ARN` = `arn:aws:iam::425106880357:role/shinro-live-github-release`.
- [ ] Deploy `ShinroLiveRegistry` (adds that role).
- [ ] Commit and push `.github/workflows/live-release-main.yml` in `~/shinro` (already written, uncommitted) to `camunda-temporal-deployment-main`.
- [ ] Confirm GitHub-hosted runners work (the old pipeline hit a billing block).
- [ ] Until then: `AWS_PROFILE=cdk-dev scripts/push-images.sh` builds and pushes by hand.
- [ ] **UI in the pipeline (2026-11-11):** written. The `ui` job builds `apps/ui` only when its git tree changed since the last UI release (`/shinro/live/release/ui-tree`); the release uploads assets, rolls the API, then switches `index.html`. Deploy `ShinroLiveRegistry` (UI bucket write for the GitHub role), then push `c190f849` on `camunda-temporal-deployment-main`.

## 6. Claude

- [x] Write the **Observability** stack (step 8).
- [x] EKS alarms deployed (2026-11-11): 18 alarms in total, both emails confirmed.
- [ ] After the Cloudflare token: run the certificate step and check both consoles.
- [ ] After SES is verified: flip `shinro:sesDomainVerified` and check an email code arrives.
- [ ] After `api-env` is filled: restart the API and check it.
- [ ] **Last Camunda check** (release blocker): an actual write as `demo` / `shinro-assessment` must get 403. Proving it needs a real write attempt (e.g. starting one order); if the block fails, one demo order is created. Needs your OK.
- [ ] After EKS: check node groups, network policy, and that a session starts.
- [x] Real session on EKS: starts, lands on sandbox nodes, isolated (2026-11-11).
- [x] Network policy **strict mode** + allow-all for the system namespaces; isolation test passes with no delay (2026-11-11).
- [ ] Remaining checks: step 2a (onboarding a test user), 6a (terminal), 9 (second stream by config), 10 (load test).
