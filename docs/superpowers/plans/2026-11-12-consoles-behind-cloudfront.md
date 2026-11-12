# Consoles Behind CloudFront Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `camunda-demo.shinro.ai` and `temporal-demo.shinro.ai` through a second CloudFront distribution using the existing ACM `*.shinro.ai` certificate, then remove the EC2's public :443, certbot, the Cloudflare token and the self-signed certificate.

**Architecture:** A new `ConsoleDistribution` in `EdgeStack` (aliases = every stream's `consoles`, default behaviour → the Shinro EC2 on :80, never cached, everything forwarded, same origin secret). `render.py` emits each console's nginx server block on `:80`, gated by the existing `$origin_ok` map. Phase A adds the new path next to the old one (no downtime); Cloudflare DNS is switched by hand; Phase C deletes the old path.

**Tech Stack:** AWS CDK v2 (TypeScript), Jest + `aws-cdk-lib/assertions`, Python 3 `render.py` (stdlib), nginx 1.30, Docker Compose on AL2023.

**Spec:** this conversation's decision (PLAN-v2 §4.4/4.5 "revisit CloudFront for the consoles") — current self-signed console certificate expires 2026-12-10; no Cloudflare token exists.

## Global Constraints

- Certificate: reuse `EDGE.certificateArn` (`…/6652dafb-…`); no new ACM certificate, no certbot afterwards.
- Viewer TLS `TLSv1.2_2021`, `sni-only`, `PRICE_CLASS_100`, `HTTP2_AND_3`, `redirect-to-https`.
- Origin: `EDGE.shinroOrigin` on :80 `http-only`, header `EDGE.originHeader` = `{{resolve:secretsmanager:shinro-live/edge/origin-secret…}}` (never a literal).
- Never rename existing construct ids (`Distribution`, `shinroCfSg`, …): renames replace resources (gotcha 5.11).
- Hostnames, Cognito callback URLs, oauth2-proxy cookies (`.shinro.ai`) stay exactly as they are.
- DNS is Cloudflare, records **DNS only (grey cloud)**; CDK only prints them.
- Phase C must not start until Phase A is verified in browsers and the CNAMEs have been live ≥ 24 h.

## Review Focus

1. A request to the EC2's :80 with a console `Host` but no/wrong `X-Shinro-Origin` must never be proxied — expect a 301 to `https://<host>` (Task 1 test).
2. Console blocks behind CloudFront must still send `X-Forwarded-Proto https`, or Camunda/Keycloak build `http://` redirects and loop (Task 1 test).
3. WebSocket upgrade headers must reach Camunda/Temporal UI through the new :80 blocks (Task 1 test).
4. A config where no stream has consoles must synthesize no console distribution and no 5xx alarm for it (Task 2 and Task 3 tests).
5. Console requests slower than the 60 s CloudFront origin read timeout return 504 — checked by hand in Task 4 Step 6; if seen, request the quota increase to 180 s and set `readTimeout` accordingly.

---

## Phase A — add the CloudFront path (old path keeps working)

### Task 1: nginx console blocks on :80 behind CloudFront

**Files:**
- Modify: `assets/shinro-bundle/bin/render.py` (the "consoles" section, lines ~360–470)
- Test: `test/shinro-host-stack.test.ts` (the `render.py (with a fake AWS CLI)` describe)

**Interfaces:**
- Produces: `render.py` function `console_servers(host: str, body: str) -> str` returning, for one console host, a `listen 80` server block (CloudFront entry) **and** the existing `listen 443 ssl` block (`tls(host)`), both with the same `body` (the location blocks built today). The trailing "Plain HTTP on a console host goes to HTTPS" server is removed — the :80 block now owns those hostnames.

- [ ] **Step 1: Write the failing tests** in the render describe:

```ts
test('consoles are served on :80 for CloudFront, origin-checked', () => {
  const c = run('nginx/20-consoles.conf');
  for (const host of ['camunda-demo.shinro.ai', 'temporal-demo.shinro.ai']) {
    const block = c.slice(c.indexOf(`listen 80;\n  server_name ${host};`));
    expect(block).toContain('if ($origin_ok = 0) { return 301 https://$host$request_uri; }');
  }
});
test('console :80 blocks tell upstreams the viewer used https, and pass WebSocket upgrades', () => {
  const c = run('nginx/20-consoles.conf');
  const http = c.slice(c.indexOf('listen 80;\n  server_name camunda-demo.shinro.ai;'));
  expect(http).toContain('proxy_set_header X-Forwarded-Proto https;');
  expect(http).toContain('proxy_set_header Upgrade           $http_upgrade;');
});
test('no separate plain-HTTP redirect server for console hosts any more', () => {
  expect(run('nginx/20-consoles.conf')).not.toContain('Plain HTTP on a console host goes to HTTPS');
});
```
Also update the existing header-room assertion: `proxy_buffer_size 16k;` count becomes **8** (2 hosts × 2 locations × 2 listeners).

- [ ] **Step 2: Run** `npx jest test/shinro-host-stack.test.ts -t render` — Expected: the three new tests FAIL, buffer count FAILS (4 ≠ 8).

- [ ] **Step 3: Implement `console_servers(host, body)`** in `render.py`: build `body` once per console exactly as today; emit
  `server {\n  listen 80;\n  server_name {host};\n  if ($origin_ok = 0) { return 301 https://$host$request_uri; }\n{body}\n}` followed by today's `server {{{tls(host)}\n{body}\n}}`. `$origin_ok` is the map already defined in `10-app.conf` (http context, shared). Delete the `redirects` server.

- [ ] **Step 4: Run** `npx jest test/shinro-host-stack.test.ts` — Expected: PASS.

- [ ] **Step 5: Validate with real nginx** (render output from the test tmp dir, or re-render with the fake CLI):
  `docker run --rm -v <bundle>/nginx/nginx.conf:/etc/nginx/nginx.conf:ro -v <bundle>/run/nginx:/etc/nginx/conf.d:ro -v /tmp/fakecert:/etc/letsencrypt/live/shinro.ai:ro nginx:1.30.6-alpine nginx -t` (with a throwaway self-signed pair in `/tmp/fakecert`). Expected: `syntax is ok` / `test is successful`.

- [ ] **Step 6: Commit** — `git commit -am "Consoles: serve on :80 behind CloudFront, origin-checked (443 kept for cutover)"`

### Task 2: Console distribution in EdgeStack

**Files:**
- Modify: `lib/stacks/edge-stack.ts`, `lib/config.ts` (comment on `StreamConfig.consoles` only)
- Test: `test/edge-stack.test.ts`

**Interfaces:**
- Consumes: `streamHosts`/`StreamConfig.consoles` from `lib/config.ts`; the existing `shinro` `HttpOrigin` and `app` behaviour options in `EdgeStack`.
- Produces: `EdgeStack.consoleDistribution: cloudfront.Distribution | undefined` (construct id `ConsoleDistribution`); SSM `/shinro/live/edge/console-distribution-id` and `/shinro/live/edge/console-distribution-domain` (only when it exists); CfnOutput `CloudflareConsoleRecords` (`camunda-demo -> dxxxx.cloudfront.net, …`).

- [ ] **Step 1: Write the failing tests** (reuse the file's `template`; locate the distribution whose `Aliases` contain `camunda-demo.shinro.ai`):

```ts
test('consoles get their own distribution: aliases are exactly the consoles', () => {
  expect(consoleDist.Aliases).toEqual(['camunda-demo.shinro.ai']);
  expect(dist.Aliases).not.toContain('camunda-demo.shinro.ai');
});
test('console default behaviour: EC2 origin, never cached, everything forwarded, all methods, https only', () => {
  expect(consoleDist.DefaultCacheBehavior).toMatchObject({
    CachePolicyId: CACHING_DISABLED, OriginRequestPolicyId: ALL_VIEWER, ViewerProtocolPolicy: 'redirect-to-https',
  });
  expect(consoleDist.DefaultCacheBehavior.AllowedMethods).toHaveLength(7);
  expect(consoleDist.DefaultCacheBehavior.ResponseHeadersPolicyId).toBeUndefined(); // consoles set their own frame/CSP headers
});
test('console origin: same EC2 name, :80, origin secret resolved at deploy, 60 s read timeout', () => {
  const o = consoleDist.Origins[0];
  expect(o.DomainName).toBe('ec2-54-147-229-249.compute-1.amazonaws.com');
  expect(o.CustomOriginConfig).toMatchObject({ OriginProtocolPolicy: 'http-only', OriginReadTimeout: 60 });
  expect(o.OriginCustomHeaders[0].HeaderValue).toContain('{{resolve:secretsmanager:shinro-live/edge/origin-secret');
});
test('console distribution uses the existing certificate, TLS 1.2+', () => {
  expect(consoleDist.ViewerCertificate).toMatchObject({ AcmCertificateArn: expect.stringContaining('certificate/6652dafb'), MinimumProtocolVersion: 'TLSv1.2_2021' });
});
test('no consoles anywhere: no console distribution', () => {
  const t = Template.fromStack(new EdgeStack(new cdk.App(), 'E2', { env, config: { streams: parseStreams([{ name: 'next', subdomain: 'next.shinro.ai' }]), sesDomainVerified: false } }));
  t.resourceCountIs('AWS::CloudFront::Distribution', 1);
});
```
Update the existing "one alias per stream page" test only if needed (it must still pass unchanged).

- [ ] **Step 2: Run** `npx jest test/edge-stack.test.ts` — Expected: new tests FAIL (`consoleDist` undefined).

- [ ] **Step 3: Implement** in `EdgeStack`: `const consoleHosts = streams.flatMap((s) => s.consoles)`; if non-empty, `new cloudfront.Distribution(this, 'ConsoleDistribution', { comment: \`${PREFIX}: demo consoles\`, domainNames: consoleHosts, certificate (same imported one), minimumProtocolVersion, httpVersion, priceClass as the main one, defaultBehavior: app })` — `app` is the existing behaviour object (no response-headers policy). Add the two SSM keys to the existing `SsmParams` map conditionally, the CfnOutput, and the same four cdk-nag acknowledgements. Update the class doc comment ("The two demo consoles don't come through here…") and `StreamConfig.consoles` comment ("served through the console distribution").

- [ ] **Step 4: Run** `npx jest test/edge-stack.test.ts test/cdk-nag.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "Edge: second CloudFront distribution for the demo consoles"`

### Task 3: 5xx alarm for the console distribution

**Files:**
- Modify: `lib/stacks/observability-stack.ts` (CloudFront section, ~line 203)
- Test: `test/observability-stack.test.ts`

**Interfaces:**
- Consumes: SSM `/shinro/live/edge/console-distribution-id` (Task 2).
- Produces: alarm id suffix `cloudfront-consoles-5xx`.

- [ ] **Step 1: Failing test** — `test('console distribution 5xx alarms like the app one', …)`: an alarm whose name contains `cloudfront-consoles-5xx`, `MetricName: '5xxErrorRate'`, `Threshold: 10`, `EvaluationPeriods: 3`; and, for a config with no consoles, no such alarm.
- [ ] **Step 2: Run** `npx jest test/observability-stack.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — generalise the existing `cf(metricName, statistic)` helper to take the distribution id; add the alarm only when any stream has consoles; description: "More than 10% of console requests (Camunda Operate, Temporal UI) failed with a 5xx for 15 minutes."
- [ ] **Step 4: Run** `npx jest` (whole suite) — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "Observability: 5xx alarm for the console distribution"`

### Task 4: Deploy Phase A and cut DNS over (runbook, human-in-the-loop)

**Files:**
- Modify: `docs/CDK-STEPS.md` (step 4/5 sections: consoles now via CloudFront; Phase C pending)

- [ ] **Step 1:** `npx cdk diff ShinroLiveShinroHost ShinroLiveEdge ShinroLiveObservability` — Expected: Host changes only the bundle asset/`BundleUrl`; Edge **adds** `ConsoleDistribution` + params and does **not** modify `Distribution`; Observability adds one alarm.
- [ ] **Step 2:** `npx cdk deploy ShinroLiveShinroHost`, then on the host (SSM Run Command) `/opt/shinro-live/bin/update.sh` and `/opt/shinro-live/bin/roll.sh nginx`. Check: `curl -sI -H 'Host: camunda-demo.shinro.ai' http://localhost/` → `301 Location: https://camunda-demo.shinro.ai/`; with `-H "X-Shinro-Origin: $(origin secret)"` → `302` to `/oauth2/start` (oauth2-proxy). Existing `https://camunda-demo.shinro.ai` still works (old A record).
- [ ] **Step 3:** `npx cdk deploy ShinroLiveEdge`, record `CloudflareConsoleRecords`; **then** `npx cdk deploy ShinroLiveObservability` (it reads `edge/console-distribution-id` from SSM at deploy, so Edge must finish first — the stacks have no CDK dependency between them).
- [ ] **Step 4: Test before DNS**: `curl -sI --connect-to camunda-demo.shinro.ai:443:<dxxxx>.cloudfront.net:443 https://camunda-demo.shinro.ai/` → `302` to `/oauth2/start`, valid Amazon-issued cert. Same for `temporal-demo`.
- [ ] **Step 5: Cloudflare (by hand):** replace the two **A** records with **CNAME** `camunda-demo` / `temporal-demo` → `<dxxxx>.cloudfront.net`, DNS only. `dig +short camunda-demo.shinro.ai` returns CloudFront addresses.
- [ ] **Step 6: Browser end-to-end** (private window): log in at `temporal.shinro.ai` → open Camunda link → Operate loads after the `demo/demo` Keycloak login; start a migration → Temporal UI link shows the user's namespace; leave Operate and Temporal UI open 10 min and click around (watch for 504s — Review Focus 5); `/oauth2/sign_out` works. Check `/shinro-live/shinro/nginx` logs show console requests arriving on :80.
- [ ] **Step 7: Commit docs** — `git commit -am "docs: consoles served through CloudFront (Phase A)"`

## Phase C — remove the old path (≥ 24 h after Task 4 Step 6 passes)

### Task 5: Remove :443, certbot, the Cloudflare token and the public security group

**Files:**
- Modify: `assets/shinro-bundle/bin/render.py` (drop the `tls(host)` block and `cert` variable), `assets/shinro-bundle/bin/roll.sh` (drop the `certs` step), `assets/shinro-bundle/bin/bootstrap.sh` (replace the shinro-certs timer creation with: `systemctl disable --now shinro-certs.timer 2>/dev/null || true; rm -f /etc/systemd/system/shinro-certs.{service,timer}`), `assets/shinro-bundle/docker-compose.yaml` (remove `"443:443"` and the `/etc/letsencrypt` mount; header comment), delete `assets/shinro-bundle/bin/certs.sh`
- Modify: `lib/config.ts` (remove `SUPPORT_IMAGES.certbot`), `lib/stacks/shinro-host-stack.ts` (remove `cloudflareToken` name, its IAM grant + nag ack, `addSecurityGroup(sg('shinro-public'))`, the A-record `CloudflareRecords` output, comments), `lib/stacks/network-stack.ts` (remove `shinroPublicSg`, its SSM param), `lib/stacks/observability-stack.ts` (remove `certificate-expiry` alarm)
- Test: `test/shinro-host-stack.test.ts`, `test/network-stack.test.ts`, `test/observability-stack.test.ts`

- [ ] **Step 1: Update tests first:** render — `expect(c).not.toContain('listen 443')`, `expect(c).not.toContain('ssl_certificate')`, buffer count back to **4**; host — instance has **two** security groups, role policy has no `cloudflare` resource, `images.env` has no `CERTBOT_IMAGE`; network — replace "Public group: 443 and 80 from anywhere" with "nothing in the VPC is open to 0.0.0.0/0" and drop `sg/shinro-public` from the SSM test; observability — remove `certificate-expiry` from the dead-host list and assert it is absent.
- [ ] **Step 2: Run** `npx jest` — Expected: those tests FAIL.
- [ ] **Step 3: Implement** the removals listed under Files.
- [ ] **Step 4: Run** `npx jest` and `npx cdk synth -q` — Expected: PASS, synth clean (cdk-nag included).
- [ ] **Step 5: Validate nginx** as Task 1 Step 5, without the cert mount — Expected: `test is successful`.
- [ ] **Step 6: Commit** — `git commit -am "Consoles: drop :443, certbot and the public security group"`

### Task 6: Deploy Phase C in dependency order

- [ ] **Step 1:** `npx cdk diff` all three stacks. Expected: Host — SecurityGroupIds update (in-place, no replacement), IAM policy shrink, bundle; Network — `shinroPublicSg` + one SSM param removed; Observability — one alarm removed. **Stop if any diff shows instance or distribution replacement.**
- [ ] **Step 2:** `npx cdk deploy ShinroLiveShinroHost` (detaches the SG first), then on the host: `update.sh` (disables the cert timer) and `roll.sh` (all services, so nginx is recreated without :443).
- [ ] **Step 3:** `npx cdk deploy ShinroLiveNetwork ShinroLiveObservability`.
- [ ] **Step 4: Verify:** `curl -m5 https://54.147.229.249` and `curl -m5 http://54.147.229.249` time out (port closed); both consoles and `temporal.shinro.ai` still work end to end (repeat Task 4 Step 6 briefly); `systemctl status shinro-certs.timer` → not found.
- [ ] **Step 5:** Delete the Cloudflare A-record notes from `docs/CDK-STEPS.md`, mark PLAN-v2 §4.4/4.5 "Superseded: consoles through CloudFront (2026-11)". Commit `docs: Phase C done`.
