# Deploying the shared demo Camunda

How the Camunda 8.8 demo instance is deployed and reached, and what credentials Shinro is given.

**Reference stack:** `~/Playground/camunda-full` (Camunda **8.8.32**, consolidated mode). This document records only what *changes* between that stack and the deployed one.

**Related:** [`PLAN.md`](PLAN.md) §3.3 Stack 5 and decisions 4.11 / 4.16 / 4.20. [`PLAN-v2.md`](PLAN-v2.md) explains the underlying concepts.

**Status:** the login design in §3–§4 was **verified end to end on a laptop on 2026-11-04** — see §7. Read-only enforcement (§5.1) is the one part still unproven.

---

## 1. The decision

**Two gates, no federation.**

```
browser → nginx → oauth2-proxy (Cognito) → Camunda → Keycloak → camunda-viewer-… → Operate
                  └── only invited users get this far ──┘
```

| Gate | Decides | Credential |
|---|---|---|
| **oauth2-proxy / Cognito** | *Who may reach the instance at all* | The user's own email + one-time code |
| **Keycloak** | *What they may do once inside* | A shared `demo` account with a **read-only** role |

**Why not federate Keycloak to Cognito.** It would make the second login invisible, but it costs a Cognito app client, an identity-provider config, an attribute mapper, a default-IdP redirector and a Camunda mapping rule — and it removes none of the risky unknowns in §7. A shared read-only account is simpler to reason about and easier to lock down.

**What we accept:** the prospect logs in twice, and there is no per-user audit inside Camunda. Both are fine for a read-only shared demo. Print `demo` / `demo` on the chat page beside the link.

**What we do not accept:** exposing the instance without the Cognito gate. The instance is shared, so one person deleting a process definition breaks the demo for every prospect, live.

---

## 2. What runs on the Camunda EC2

Private subnet, no public IP. Trim `docker-compose-full.yaml` to:

| Service | Port | Purpose |
|---|---|---|
| `orchestration` | **8080**, **26500** | Zeebe + Operate + Tasklist + REST, all one container |
| `keycloak` | 18080 | OIDC provider, realm `camunda-platform` |
| `identity` | 8084 | Seeds Keycloak clients and roles |
| `postgres` | 5432 | Keycloak's store |
| `elasticsearch` | 9200 | Operate's data |
| `oms-camunda-app` | 8090 | The demo job worker |

**Drop:** `optimize`, `web-modeler` (+ `web-modeler-db`), `console`, `connectors`, `mailpit`. Several GB saved and five fewer things to break. Size the instance *after* trimming.

### Security group

| Port | From | Why |
|---|---|---|
| 8080 | Shinro SG only | nginx proxies browsers here; tool-exec calls the REST API |
| 26500 | Shinro SG only | tool-exec's Zeebe gRPC |
| **18080** | **Shinro SG only** | **nginx proxies the browser here — this rule is new** |
| everything else | nobody | 9200, 9600, 8084, 5432, 8090 stay instance-local |

---

## 3. nginx on the Shinro EC2

One hostname, two upstreams, split on `/auth`.

> **Why the split exists.** An OIDC login has two conversations: the **front channel** (redirects the *browser* makes) and the **back channel** (calls the *Camunda server* makes). Camunda redirects the browser to Keycloak, so the browser needs a public address for it. The server's own calls stay internal. Without this, login dies after a successful Cognito sign-in with a connection error.

```nginx
server {
  listen 443 ssl;
  server_name camunda-demo.shinro.ai;
  # certbot cert — see PLAN 4.5

  # ---- oauth2-proxy (the Cognito gate) ----
  location /oauth2/ {
    proxy_pass http://oauth2-proxy-temporal:4180;
    proxy_set_header Host                    $host;
    proxy_set_header X-Real-IP               $remote_addr;
    proxy_set_header X-Forwarded-Proto       https;
    proxy_set_header X-Forwarded-Host        $host;
    proxy_set_header X-Auth-Request-Redirect $request_uri;
  }

  location = /oauth2/auth {
    internal;
    proxy_pass http://oauth2-proxy-temporal:4180;
    proxy_pass_request_body off;
    proxy_set_header Content-Length    "";
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Uri   $request_uri;
  }

  location @signin { return 302 https://$host/oauth2/start?rd=$request_uri; }

  # ---- Keycloak: the FRONT CHANNEL. The browser must reach this. ----
  location /auth/ {
    auth_request /oauth2/auth;
    error_page 401 = @signin;
    set $kc "<camunda-private-ip>:18080";
    proxy_pass http://$kc$request_uri;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Port  443;
  }

  # ---- Camunda: everything else ----
  location / {
    auth_request /oauth2/auth;
    error_page 401 = @signin;
    set $cam "<camunda-private-ip>:8080";
    proxy_pass http://$cam$request_uri;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Port  443;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        $connection_upgrade;
    proxy_read_timeout 3600s;
  }

  # land on Operate, not the launchpad
  location = / {
    auth_request /oauth2/auth;
    error_page 401 = @signin;
    return 302 /operate;
  }
}
```

`<camunda-private-ip>` is read at boot from SSM `/shinro/live/camunda-private-ip`. Use a **variable** in `proxy_pass` so nginx re-resolves rather than caching a dead address at startup.

---

## 4. Config changes from `camunda-full`

### 4.1 `orchestration`

| Setting | Local | Deployed |
|---|---|---|
| `server.forward-headers-strategy` | `none` | **`native`** |
| `OIDC_AUTHORIZATIONURI` | `http://localhost:18080/auth/realms/…/auth` | `https://camunda-demo.shinro.ai/auth/realms/camunda-platform/protocol/openid-connect/auth` |
| `OIDC_TOKENURI` | `http://host.docker.internal:18080/…/token` | `http://keycloak:18080/auth/realms/camunda-platform/protocol/openid-connect/token` |
| `OIDC_JWKSETURI` | `http://host.docker.internal:18080/…/certs` | `http://keycloak:18080/auth/realms/camunda-platform/protocol/openid-connect/certs` |
| `OIDC_REDIRECTURI` | `http://localhost:8088/sso-callback` | `https://camunda-demo.shinro.ai/sso-callback` |
| `CAMUNDA_IDENTITY_ISSUERBACKENDURL` | `http://host.docker.internal:18080/auth/realms/camunda-platform` | `http://keycloak:18080/auth/realms/camunda-platform` |
| `operate.identity.redirectRootUrl` | `http://localhost:8088/operate` | `https://camunda-demo.shinro.ai/operate` |
| `tasklist.identity.redirectRootUrl` | `http://localhost:8088/tasklist` | `https://camunda-demo.shinro.ai/tasklist` |

**Public for the browser, internal for the server.** That is the whole fix.

> `forward-headers-strategy: none` is the single most likely cause of a login loop. nginx terminates TLS, so without this Camunda believes the request was HTTP and builds an `http://…/sso-callback` redirect URI that no longer matches.

### 4.2 `keycloak`

| Setting | Value |
|---|---|
| `KC_HOSTNAME` | `https://camunda-demo.shinro.ai/auth` |
| `KC_PROXY_HEADERS` | `xforwarded` |
| `KC_HTTP_ENABLED` | `true` (TLS terminates at nginx) |
| `KC_BOOTSTRAP_ADMIN_USERNAME` / `PASSWORD` | generated → Secrets Manager (**not** `admin`/`admin`) |

`KC_HOSTNAME` makes the token **issuer** the public URL regardless of which address is called, which is what keeps `iss` consistent between the two channels. See §7.

### 4.3 `.env`

| Variable | Local | Deployed |
|---|---|---|
| `HOST` | `localhost` | `camunda-demo.shinro.ai` |
| `KEYCLOAK_HOST` | `host.docker.internal` | `keycloak` |
| every `*_SECRET`, `KEYCLOAK_ADMIN_PASSWORD` | literals | generated → Secrets Manager, rendered at boot by `render-env.sh` |

Nothing secret is written into the bundle. The instance resolves secrets by name at boot.

---

## 5. Users, clients and roles

Four identities. Keeping them separate is what makes "read-only" true.

| Identity | Type | Used by | Permissions |
|---|---|---|---|
| `orchestration` | client | **Camunda itself**, for its own browser login | Leave exactly as-is |
| `camunda-viewer-<uid>` | user | Every prospect, in a browser | **Read only** |
| `shinro-assessment` | client (m2m) | tool-exec / the assessment tool | **Read only** |
| `oms-app` | client (m2m) | The OMS job worker | Write — it drives the demo workflows |

### 5.1 Make `demo` read-only

In `.orchestration/application.yaml`, `demo` is currently granted **admin**:

```yaml
camunda:
  security:
    initialization:
      defaultRoles:
        admin:
          users:
            - demo          # ← remove
          clients:
            - orchestration # ← keep: this is Camunda's own client
```

Remove `demo` from `admin` and give it a read-only role instead. 8.8 ships default roles (`admin` and `connectors` are already in use here) — **check whether your version provides a `readonly` role**; if it does, assign `demo` to it. If not, define a role granting only read permissions on process definitions, process instances and decisions.

Also trim the `demo` user's realm roles in `.identity/application.yaml` — it currently holds `ManagementIdentity`, `Optimize`, `Web Modeler Admin`, `Console` and `Orchestration`. With those components dropped (§2), only a read-level `Orchestration` role is needed.

### 5.2 Add `shinro-assessment` (read-only m2m)

Model it on the existing `connectors` preset in `.identity/application.yaml`, which is already exactly this shape:

```yaml
component-presets:
  shinro:
    applications:
      - name: Shinro Assessment
        id: shinro-assessment
        type: m2m
        secret: ${VALUES_KEYCLOAK_INIT_SHINRO_SECRET}
        permissions:
          - audience: "orchestration-api"
            definition: read:*          # read only — no write:*
```

**Do not reuse `orchestration` for Shinro.** That client is listed under `defaultRoles.admin.clients`, so today the assessment tool authenticates as a full admin on an instance every prospect shares.

**Check the `aud` claim once the client exists.** In the §7 test, a client-credentials token for `orchestration` came back with `aud = ["orchestration","account"]` — **not** `orchestration-api`. Camunda accepted it only because `AUDIENCES_0` happens to be `orchestration`. Since Shinro is configured with audience `orchestration-api`, confirm that `shinro-assessment` actually receives that audience (an audience protocol mapper, which the `permissions: audience:` block above is meant to create), or the call will be rejected. Decode the token and look:

```bash
# aud must contain orchestration-api
<token> | cut -d. -f2 | base64 -d | python3 -m json.tool
```

### 5.3 Move the OMS app off `orchestration` too

`docker-compose.oms.yaml` currently uses `CAMUNDA_CLIENT_ID: orchestration` with secret `secret`. Give it `oms-app` with `write:*` on `orchestration-api` — it needs to activate and complete jobs, but it does not need admin.

---

### 5.4 Register the public redirect URI on the Keycloak client

**Found during the §7 test, and easy to miss:** there are **two** redirect-URI settings and they must match.

| Setting | Where | Value |
|---|---|---|
| `CAMUNDA_SECURITY_AUTHENTICATION_OIDC_REDIRECTURI` | Camunda env (§4.1) | `https://camunda-demo.shinro.ai/sso-callback` |
| The client's **registered** `redirectUris` | **Keycloak**, client `orchestration` | the same URL |

§4.1 covers the first. The second is separate: the `orchestration` client ships registered for `http://localhost:8088/sso-callback` only, so the first login attempt fails with:

```
We are sorry...
Invalid parameter: redirect_uri
```

The error names no setting and appears *after* a successful Cognito sign-in, which makes it easy to misread as a Cognito or nginx problem.

**Fix:** set the `orchestration` application's `root-url` to `https://camunda-demo.shinro.ai` in `.identity/application.yaml`, so the identity preset seeds the right value. Verify after deploy with:

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  '<keycloak>/auth/admin/realms/camunda-platform/clients?clientId=orchestration' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["redirectUris"])'
```

### 5.5 The shared Operate account is generated, not `demo`/`demo`

The account every prospect signs in with used to be Camunda's upstream default,
`demo`/`demo`, written into `.identity/application.yaml`. It now comes from
outside the bundle:

| Half | Source | Read by |
|---|---|---|
| username | `CAMUNDA_DEMO_USERNAME` in `lib/config.ts` (readable prefix + random tail) → SSM `/shinro/live/camunda/demo-username` | `bin/render-env.sh`, and `render.py` via the Shinro host config |
| password | Secrets Manager `shinro-live/camunda/demo-user-password` (40 chars, generated) | `bin/render-env.sh` only |

It is printed in the chat beside the console link, so it is not a secret in the
usual sense — it is one more thing a prospect cannot guess, behind the Cognito
gate that already stops everyone else.

**Three files move together.** The name appears in `.identity/application.yaml`
(which seeds the Keycloak user), in `.orchestration/application.yaml` (which
grants it `readonly-admin`) and in the app's `etc/demo_catalog.yaml` (which
prints it). Change one and the account either cannot sign in, signs in and sees
nothing, or is advertised to the prospect under the wrong name.

**Changing the name leaves the old user behind.** Identity creates users that are
missing; it does not rename them. After a name change the realm holds *both*, and
the old one keeps working with its old password until it is deleted:

```bash
TOKEN=$(curl -fsS -d client_id=admin-cli -d "username=$KEYCLOAK_ADMIN_USER" \
  -d "password=$KEYCLOAK_ADMIN_PASSWORD" -d grant_type=password \
  http://localhost:18080/auth/realms/master/protocol/openid-connect/token \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# List what the realm actually holds, then delete the stale one by id.
curl -fsS -H "Authorization: Bearer $TOKEN" \
  'http://localhost:18080/auth/admin/realms/camunda-platform/users?briefRepresentation=true'
curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" \
  "http://localhost:18080/auth/admin/realms/camunda-platform/users/<id>"
```

Whether restarting `identity` updates an *existing* user's password is untested
here — nothing is logged either way. Do not rely on it: deleting the old user and
letting the create path run is the behaviour that is known to work.

## 6. What Shinro is given

Two consumers, and they share nothing.

| Consumer | Credential | Route |
|---|---|---|
| The prospect's browser | Cognito session cookie | Public hostname, through nginx |
| tool-exec / assessment tool | `shinro-assessment` Keycloak secret | Private IPs, **never** through nginx |

### The migration connection parameters

```
Project name:        <per migration, e.g. petclinic3>
Deployment mode:     self-managed
Zeebe address:       grpc://<camunda-private-ip>:26500
Zeebe REST address:  http://<camunda-private-ip>:8080
Operate base URL:    http://<camunda-private-ip>:8080
Auth method:         oidc
Client ID:           shinro-assessment
Client secret:       <from Secrets Manager>
OIDC token URL:      http://<camunda-private-ip>:18080/auth/realms/camunda-platform/protocol/openid-connect/token
Audience:            orchestration-api
```

**Three things change from your local config:**

| | Local | Deployed |
|---|---|---|
| Host | `localhost` | `<camunda-private-ip>` |
| Web/REST port | `8088` | `8080` |
| Client | `orchestration` / `secret` | `shinro-assessment` / Secrets Manager |

Everything else — auth method, audience, the token URL's path — is unchanged.

**Notes:**
- `8088` is only a local *host port mapping* of container `8080`. It does not exist in deployment.
- gRPC goes **direct**, not through nginx. Proxying it needs `grpc_pass` and buys nothing inside the VPC.
- tool-exec uses the **back channel only** — no browser, so no public hostname and no Cognito.
- The browser-facing link shown in chat stays `https://camunda-demo.shinro.ai`.

---

## 7. Verified locally — 2026-11-04

**This design has been run end to end** against `camunda-full` (Camunda 8.8.32, Keycloak `quay-26.6.4`) on a laptop, with nginx in front doing the `/auth` split and a self-signed cert. All four assumptions passed. oauth2-proxy and Cognito were deliberately left out to isolate the Camunda↔Keycloak question.

### Results

| Assumption | Predicted confidence | Result |
|---|---|---|
| `/auth` doesn't collide with Camunda's paths | High | ✅ Camunda returns **404** on `/auth` and `/auth/` — the prefix is free |
| **`KC_HOSTNAME` with a path suffix works in Keycloak 26** | **Low — "most likely to fight you"** | ✅ **Works.** `KC_HOSTNAME=https://<host>/auth` alongside the image's existing `KC_HTTP_RELATIVE_PATH=/auth` produced correct URLs with **no `/auth/auth` doubling** |
| **Camunda accepts `iss` = public URL while fetching JWKS internally** | **Low** | ✅ **Accepted.** `200` on `/v2/topology` and `/v2/process-definitions/search`; `401` without a token |
| `/` is a launchpad, not Operate | Medium | ✅ `location = /` → `302 /operate` works |

**Neither documented fallback is needed.** Keycloak does not need its own hostname, and Camunda's back-channel calls do not need to be routed through nginx.

### The login flow, as observed

```
GET /operate          → 302  /oauth2/authorization/oidc
                      → 302  https://<host>/auth/realms/camunda-platform/protocol/openid-connect/auth
                             ?redirect_uri=https://<host>/sso-callback     ← https, correct host
POST camunda-viewer-… → 302  /sso-callback?code=…
                      → 200  /operate?continue      <title>Operate</title>
```

Two things this proves beyond the table:

- **`forward-headers-strategy: native` works and is required.** The `redirect_uri` came back as **https** with the correct host. With the shipped `none`, Camunda would have built an `http://` URI and the login would have failed on mismatch — exactly the failure gotcha 5.32 predicts.
- **The issuer is consistent across both channels.** With `KC_HOSTNAME` set, a token requested from the *internal* endpoint (`http://keycloak:18080/...`) still carries `iss = https://<host>/auth/realms/camunda-platform`. That is what makes the public/internal split in §4.1 safe.

### Also confirmed

- **The trimmed service set runs.** `orchestration`, `elasticsearch`, `keycloak`, `identity`, `postgres` started and served the full login with `optimize`, `web-modeler`, `console`, `connectors` and `mailpit` absent — validating §2.
- The `camunda/keycloak` image **already sets `KC_HTTP_RELATIVE_PATH=/auth`**, so the `/auth` prefix is native to it rather than something we impose.

### What is still unproven

**Read-only enforcement.** The `demo` user holds `Orchestration`, `ManagementIdentity`, `Web Modeler Admin`, `Console` and `Optimize`. A `POST /v2/deployments` with the browser session returned `401`, which looks like CSRF rather than an authorization decision, so it proves nothing either way. §5.1 and decision 4.11 remain open and must be tested separately.

---

## 8. Deployment checklist

**Build**
- [ ] Trim the Compose file to the six services in §2
- [ ] Apply §4.1–4.3 config changes
- [ ] Add `shinro-assessment` and `oms-app` clients; remove `demo` from the admin role
- [ ] Generate every secret into Secrets Manager; `render-env.sh` resolves them at boot
- [ ] Open 18080 from the Shinro SG
- [ ] Add the §3 server block to the nginx bundle

**Prove (build step 3 in the plan)**
- [ ] One Cognito login, then `demo`/`demo`, lands on **Operate**
- [ ] A `shinro-assessment` token is **accepted** — this is the `iss` check, the likeliest failure
- [ ] The same token is **refused** for deploy, cancel and modify
- [ ] `demo` cannot deploy, cancel or modify in the UI
- [ ] `curl https://camunda-demo.shinro.ai/auth/` without a cookie **redirects to login**, and never serves Keycloak
- [ ] Nothing but 8080, 26500 and 18080 is reachable from the Shinro host; nothing at all from anywhere else

**Operate**
- [ ] DLM snapshots cover Elasticsearch **and** Keycloak's Postgres
- [ ] Health check publishes a custom CloudWatch metric (a Route 53 health check cannot reach a private IP)
- [ ] Seeded workflows confirmed — T-15 lists OMS + banking, but banking was removed from the jetson cluster on 2026-11-04

---

## 9. Known open items

1. ~~**Which workflows get seeded.**~~ — **resolved**: the OMS app deploys `order-processing` itself on startup; no seed script.
2. **The exact read-only role name** in 8.8: **resolved 2026-11-10**, it's `readonly-admin`, and on the deployed instance only `demo` and `shinro-assessment` hold it (admin = `orchestration`, `oms-app`). **Still open:** proving a write as `demo` gets 403 on deploy/cancel/modify (§5.1, decision 4.11).
3. ~~**The `aud` claim on `shinro-assessment`**~~ — **resolved 2026-11-10**: `aud` = `shinro-assessment`, `orchestration-api`, `account`.
4. **Second login UX.** Prospects must be told `demo`/`demo`. Decide where that appears in the chat UI.

~~`KC_HOSTNAME` with a path~~ — **resolved by the §7 test.** It works; no separate hostname needed.
