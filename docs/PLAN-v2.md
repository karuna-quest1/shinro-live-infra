# Shinro Live Infra — CDK Deployment Plan, Version 2 (the "explain everything" edition)

> **What this document is.** The deployment plan for the Shinro demo infrastructure, written so that every technical term is explained from the ground up — with an everyday analogy — *before* it is used. No technical term has been removed. Each one is explained so you can use it confidently and explain it to someone else.
>
> **Sources.** The **Camunda to Temporal Changes** tab of `Shinro Deployment Tracker (6).xlsx` (rows cited as `T-10`, `T-28`, … meaning "tracker row 10, row 28") and `image.png` (the architecture diagram). The app team's **demo `DEPLOYMENT.md`** (branch `feat/demo-graph`, PR #395) — what the demo as actually built needs from this plan; its decisions and gaps are folded in below and marked **(DEPLOYMENT)**. The old repo `../shinro-demo-infra` is used **only as a source of patterns**. We do not reuse its EC2 instance, its stack, its SSM names or its ECR repositories.

---

## What changed in this revision (read this if you read the earlier draft)

The user flow has been redesigned. Five changes, and they ripple through everything:

| # | Change | Biggest consequence |
|---|---|---|
| 1 | **The product is split into "streams."** Each stream is a migration path with its own subdomain, e.g. `temporal.shinro.ai` for Camunda → Temporal | Nearly everything is now "one per stream" instead of "one" |
| 2 | **One new Cognito demo pool with a group per stream.** Membership decides which demos a person can open, and a user may be in several | We **create** a demo pool rather than reusing the main one, and run **one oauth2-proxy per stream**, each gating on its own group (4.2) |
| 3 | **Access is requested through a HubSpot form** on the stream page, then granted by hand | The form must record *which stream* was asked for. That field decides which pool the email goes into |
| 4 | **After login the user lands in the chat app** at `temporal.shinro.ai/chat/<convid>` | Each stream subdomain serves *both* a public marketing page and a logged-in app, so CloudFront needs path-based routing |
| 6 | **The Shinro CLI now runs inside the browser**, in a terminal panel on the chat page, backed by a shell in the user's own sandbox | The session pod grows a **terminal container**, shinro-api becomes a **WebSocket relay**, and the sandbox needs **outbound HTTPS for Go modules** — which collides with the deny-by-default egress policy in T-32 (decision 4.17) |
| 5 | **`reference.shinro.ai` is dropped for now** (T-35 deferred). Demo Camunda stays shared at `demo-camunda-instance.shinro.ai`. Each user's Temporal session is served at **one plain hostname, `demo-temporal-ui.shinro.ai`, with no id in the URL** | nginx picks the session from *who is logged in*. This kills the path-prefix problem and the shareable-link problem at once, and matches what T-18 originally described (decision 4.6) |

Two of these contradict things written earlier, and both are called out where they appear: change 2 contradicts **T-13** ("reuse the existing pool, do not create a new one"), and change 5 defers **T-35**.

**Then, from the app team's demo `DEPLOYMENT.md` (how the demo was actually built):**

| # | Change | Biggest consequence |
|---|---|---|
| 7 | **Generated code is built and tested inside the user's terminal container** by `migrate-agent`, not by tool-exec + CodeBuild | **Stack 8 is dropped** (4.18), along with the `session-worker` ECR repo and `codebuild:StartBuild`. A session is **Temporal + terminal**, no separate worker image |
| 8 | **The session is leased when code analysis starts**, not when migration starts | 2.6 rewritten |
| 9 | **The UI is served by nginx on the Shinro EC2** | Three more CloudFront behaviours (`/assets/*`, `/login`, `/settings`) → EC2 (1.11) |
| 10 | **Terminal pods call back into the API** (CLI sign-in, LLM turns) | New SG rule EKS → Shinro EC2, through an internal nginx listener exposing only the CLI routes (Stack 1, Stack 6) |
| 11 | **Decisions closed:** Go modules via an in-VPC proxy (4.17), no warm pool at launch (4.19), the API trusts oauth2-proxy headers (4.21), generated code is lost if a pod is replaced (4.22) | See each decision |

---

## How to read this document

| Part | What's in it | Read it when |
|---|---|---|
| **Part 0** | The whole system as a one-page story, plus the hostname map | First. Always |
| **Part 1** | Fundamentals: networking, AWS, web, login, Kubernetes, CDK. Each term gets "in one sentence → analogy → how it's used here" | When any word in Parts 2–5 feels fuzzy |
| **Part 2** | Step-by-step walk-throughs: "what happens when a user clicks X" | Before explaining the system to anyone |
| **Part 3** | The CDK plan: stacks, what goes in each, build order, runtime config, releases, go-live checklist | When writing code |
| **Part 4** | Open decisions, with options and a recommendation | Before writing code |
| **Part 5** | Gotchas: what goes wrong, why, and how to avoid it | While building, and when answering "but what about…?" |
| **Part 6** | Glossary: every term, alphabetical | Any time |

---

# Part 0 — The whole system in one page

## 0.1 The story

Picture a **conference centre that hosts several separate trade shows at once**. Each trade show is a **stream** — one migration path we sell, such as Camunda → Temporal.

- **The main entrance hall** is `shinro.ai`, the company's marketing page. Anyone can walk in.
- **Each trade show has its own front desk and hall**: `temporal.shinro.ai`, and one subdomain per other stream. Anyone can look at the hall's public brochure page. On that page are two buttons: **"Request a demo"** and **"Sign in."**
- **"Request a demo"** opens a **HubSpot form** (HubSpot is our sales CRM). The visitor leaves their email. The form records which trade show they asked about.
- **Someone on our team reads that request and issues a badge** — by hand — valid for **that trade show only**. Technically: they add the email to that stream's **Cognito user pool**.
- **"Sign in"** sends the visitor to the badge office (**Cognito**) for *that* stream. There's no password: they type their email, get a 6-digit code by email, type it in, and they're through. They land inside the app at `temporal.shinro.ai/chat/<convid>`.
- **Each trade show has its own security guard** checking badges at every door into that show: one **oauth2-proxy** per stream. A Temporal badge means nothing at another show's door, because each guard only recognises badges from their own badge office.
- **The receptionist who walks every visitor to the right room** is **nginx**, running on the **Shinro EC2** server. It is the single front door into the private part of the building.
- **Two demo rooms belong to the Temporal show:**
  - **`demo-camunda-instance.shinro.ai`** — one **shared** Camunda instance that every Temporal-stream visitor looks at. It lives on its own private server with no public address.
  - **`demo-temporal-ui.shinro.ai`** — one address, with **a different room behind it for every visitor**. The receptionist reads your badge and walks you to *your* room; there is no room number to type, and none to share. Each room holds that visitor's own Temporal server **and a live terminal** they can type into from the chat page; the code our tool generates for them is built, tested and run inside that terminal. Rooms are demolished after **2 days**.
- **The private rooms are built inside EKS**, a Kubernetes cluster. Kubernetes is the building manager that finds space, sets rooms up and keeps them running.
- **The brochure stands** are **CloudFront + S3**: the public pages for the main site and every stream, cached worldwide.
- **The utility rooms** are AWS services: **Route 53** (phone book), **ACM** (certificate office), **Secrets Manager** (safe), **CloudWatch** (CCTV and alarms), **ECR** (image warehouse), and the **LLM API** (an outside consultant we pay for).
- **The blueprint** is the **CDK** code we are going to write. It describes all of the above in TypeScript, and AWS builds it.

Keep this picture. Every section below fills in one part of it.

## 0.2 The hostname map

This table is the backbone of the whole design. **Every hostname belongs to exactly one stream**, and that rule is what makes per-stream pools work (decision 4.1).

| Hostname | Stream | Public or logged-in | Served by | Notes |
|---|---|---|---|---|
| `shinro.ai` | none (company) | Public | CloudFront → S3 | Marketing home |
| `temporal.shinro.ai` (path `/`) | temporal | Public | CloudFront → S3 | Stream page with the two buttons |
| `temporal.shinro.ai/chat/<convid>` | temporal | **Logged in** | CloudFront → nginx → shinro-api/UI | The app |
| `temporal.shinro.ai/assets/*`, `/login`, `/settings` | temporal | Mixed | CloudFront → nginx (static UI files) | The UI's own files and routes (DEPLOYMENT decision 1) |
| `temporal.shinro.ai/v2/*` | temporal | **Logged in** | CloudFront → nginx → shinro-api | API and WebSocket |
| `temporal.shinro.ai/oauth2/*` | temporal | Login machinery | CloudFront → nginx → oauth2-proxy-temporal | Start + callback |
| `demo-camunda-instance.shinro.ai` | temporal | **Logged in** | A record → nginx → Camunda private IP | Shared demo Camunda |
| `demo-temporal-ui.shinro.ai` | temporal | **Logged in** | A record → nginx → *your* session's NodePort | One URL for everyone; the logged-in email picks the session |
| `<other>.shinro.ai` | other streams | Mixed | Same pattern, repeated | Added later |
| ~~`reference.shinro.ai`~~ | — | — | — | **Dropped for now** (T-35 deferred) |

Two routing styles appear here, and the difference is deliberate (decision 4.4):
- **Mixed pages** (public page + logged-in app on the same hostname) go through **CloudFront**, because CloudFront can split by path: `/` to S3, `/chat` and `/v2` to the server.
- **Pure app hostnames** (the two demo consoles) point **straight at the Shinro EC2** with an A record, because every path is dynamic and there's nothing to cache.

---

# Part 1 — Fundamentals

Each concept follows the same pattern: **in one sentence** → **analogy** → **in our system**.

## 1.1 Networking basics

### IP address
- **In one sentence:** a number identifying a machine on a network, such as `10.0.3.17` or `54.21.8.200`.
- **Analogy:** a street address.
- **Public vs private:** a **public IP** is reachable from the internet, like a house on a public street. A **private IP** (starting `10.`, `172.16–31.`, or `192.168.`) only works *inside* a private network, like a room number inside a building. You can't post a letter to "Room 214" from outside.
- **In our system:** the Shinro EC2 has a public IP. The Camunda EC2 has **only** a private IP (T-10: "no public IP").

### Elastic IP (EIP)
- **In one sentence:** a public IP you *reserve* in AWS so it survives restarts and replacements.
- **Analogy:** keeping your phone number when you move house.
- **In our system:** the Shinro EC2 gets one, so the A records for the two demo consoles never break.

### Port
- **In one sentence:** a number (0–65535) picking *which program* on a machine you're talking to.
- **Analogy:** the IP is the building's street address; the port is the apartment number.

| Port | Who listens | Note |
|---|---|---|
| 80 | nginx (HTTP) | CloudFront talks to the Shinro EC2 here |
| 443 | nginx (HTTPS) | Browsers reach the two demo consoles here |
| 4180 (×N) | oauth2-proxy, one per stream | Internal to the server only |
| 8000 | shinro-api (FastAPI) | Internal only |
| 7233 | Temporal server (gRPC) | Workers and the validation tool connect here |
| 8233 | Temporal UI (web) | A dev server's built-in console |
| 26500 | Camunda Zeebe (gRPC) | Camunda's engine API |
| 8080/8081 (version-dependent) | Camunda Operate (web) | See decision 4.11 |
| 9200 | Elasticsearch | **Never exposed** (T-12) |
| 30000–32767 | Kubernetes **NodePort** range | How nginx reaches session rooms in EKS |

### DNS (Domain Name System)
- **In one sentence:** the internet's phone book, turning `temporal.shinro.ai` into an IP address.
- **Record types:**
  - **A record**: name → IPv4 address.
  - **Alias record** (a Route 53 feature): name → an AWS resource such as a CloudFront distribution. Behaves like an A record, but AWS keeps the target's addresses current.
  - **CNAME**: name → another name.
  - **Wildcard** `*.shinro.ai`: matches any subdomain that has no record of its own.
- **Key rule: a specific record always beats a wildcard.**
- **In our system:** `shinro.ai` and `*.shinro.ai` point at CloudFront (so every stream page is covered automatically). `demo-camunda-instance` and `demo-temporal-ui` have **their own A records** to the Shinro EIP, which override the wildcard.

### Subdomain
`shinro.ai` is the **domain**. `temporal.shinro.ai` and `demo-camunda-instance.shinro.ai` are **subdomains**. We use **one subdomain per stream**, plus one per shared demo console.

### HTTP, HTTPS, status codes, headers, cookies
- **HTTP** is the language browsers and servers speak: "GET me this page", "POST this form".
- **HTTPS** is HTTP inside an encrypted **TLS** tunnel (1.2). That's the padlock.
- **Status codes**, the server's short answer:
  - `200 OK` / `202 Accepted` — fine.
  - `302 Found` — "go to this other URL" (a **redirect**). Login flows are built almost entirely from redirects.
  - `401 Unauthorized` — "I don't know who you are" (not logged in).
  - `403 Forbidden` — "I know who you are, and no."
  - `404 Not Found` — no such thing here.
  - `502 Bad Gateway` — "the server behind me didn't answer." nginx says this when a backend is down.
- **Headers**: labelled notes attached to a request or response, e.g. `Host: temporal.shinro.ai`, `Authorization: Bearer <token>`, `X-Auth-Request-Email: jane@acme.com`.
- **Cookie**: a small note the server asks the browser to keep and send back on later requests. It's how a site remembers you're logged in. A **cookie domain** of `.shinro.ai` means the browser sends it to *every* `*.shinro.ai` host — which is exactly what we need, and also the source of gotcha 5.19.

### gRPC
- **In one sentence:** a fast binary protocol for programs calling each other over HTTP/2. Not for browsers.
- **In our system:** Temporal workers and the validation tool use gRPC on 7233. Camunda's Zeebe uses 26500.

### WebSocket
- **In one sentence:** a connection that starts as HTTP then "upgrades" into a long-lived two-way channel, so the server can push messages without being asked.
- **In our system:** the Shinro chat streams over WebSocket. nginx must forward the `Upgrade` and `Connection` headers or it silently degrades into reconnect loops. **CloudFront must also be configured to allow it** — the old repo already runs a chat WebSocket through CloudFront, so the pattern is proven in this codebase.

## 1.2 TLS, certificates, ACM

### TLS (Transport Layer Security)
- **In one sentence:** the encryption behind HTTPS.
- **Analogy:** a sealed envelope only the recipient can open, with their ID card stapled on so you know you wrote to the right person.

### Certificate and private key
- A **certificate** is a public ID card for a hostname, signed by a **Certificate Authority (CA)** that browsers trust (Let's Encrypt, Amazon, …).
- The **private key** is the secret proving the server owns that certificate. It must never leave the server.
- A **wildcard certificate** `*.shinro.ai` covers every single-level subdomain.

### SNI (Server Name Indication)
At the start of a TLS handshake the browser announces which hostname it wants. That's how one server on one IP can present the right certificate for many hostnames.

### TLS termination
- **In one sentence:** the point where HTTPS is decrypted.
- **In our system:** two places. **CloudFront** terminates TLS for `shinro.ai` and the stream subdomains. **nginx** terminates TLS for the two demo consoles. From nginx onward (to Camunda, to EKS) traffic is plain HTTP inside the VPC, which T-12 explicitly allows because it never leaves our private network.

### ACM (AWS Certificate Manager)
- **In one sentence:** AWS's free certificate service.
- **The catch (gotcha 5.1):** a normal ACM certificate can only be *attached to AWS services* (CloudFront, load balancers, API Gateway). Its private key can't be downloaded, so **you cannot put it on nginx**. The demo consoles need a different certificate (decision 4.5).
- **Hard rule:** the certificate CloudFront uses must live in the **`us-east-1`** region.

## 1.3 AWS networking: VPC, subnets, NAT, security groups

### VPC (Virtual Private Cloud)
- **In one sentence:** your own private network inside AWS.
- **Analogy:** a fenced company campus. Inside, everything talks over private addresses; outside, only what you deliberately expose is visible.

### Availability Zone (AZ)
A physically separate data centre within a region (`us-east-1a`, `us-east-1b`, …). Spreading across two survives one failing. **EKS requires at least two.**

### Subnet
A slice of the VPC's address range, living in one AZ.
- **Public subnet:** has a route to an **Internet Gateway** (the campus main gate). A server here *with a public IP* is reachable from the internet if its firewall allows.
- **Private subnet** (CDK: `PRIVATE_WITH_EGRESS`): no route in from the internet. Invisible from outside.

### NAT Gateway
- **In one sentence:** lets private-subnet servers make *outgoing* internet connections (pull Docker images, call the LLM API, reach AWS services) while staying unreachable from outside.
- **Analogy:** a one-way mail room. Staff in windowless offices send letters out and get replies; nobody outside can address a letter to them directly.
- **Cost:** roughly $32/month each plus per-GB data. We use **one** to save money — a demo trade-off, since if its AZ fails, private servers lose internet.

### VPC endpoints
Private tunnels from the VPC directly to an AWS service, bypassing the NAT. The S3 one (a "gateway endpoint") is free; ECR and SSM ones cost a little per hour but cut NAT data charges. Optional.

### Security group (SG)
- **In one sentence:** a firewall attached to a server, listing who may connect on which ports.
- **Analogy:** a bouncer with a guest list at each door.
- **Stateful:** if a connection is allowed in, its reply is automatically allowed out. You never write reply rules.
- **SGs can reference other SGs.** "Allow 26500 from *the Shinro SG*" means "from any server wearing the Shinro badge", whatever its IP. That is exactly how T-10 ("Camunda's SG allows only the Shinro EC2") is implemented.

### Managed prefix list (CloudFront origin-facing)
AWS publishes CloudFront's IP ranges as `com.amazonaws.global.cloudfront.origin-facing`. Using it in an SG rule means "only CloudFront may connect."
**Gotcha 5.5:** that single list counts as about **55 rules** against the SG limit of **60**, which is why the old repo uses **a separate SG per port**.

## 1.4 Servers and containers

### EC2
- **In one sentence:** a virtual server in AWS.
- **Instance type** sets its size, e.g. `m7i.xlarge` = 4 vCPU, 16 GiB RAM.
- **EBS volume**: its disk. **gp3** is the standard SSD type. We encrypt it.
- **EBS snapshot**: a point-in-time disk backup.
- **UserData**: a script that runs **once, on first boot**. We use it to install Docker and start everything. **Gotcha 5.3: editing it replaces the whole server.**
- **IMDSv2**: the hardened version of the internal metadata service a server queries to learn about itself and fetch temporary credentials. Requiring v2 blocks a known attack class. The old repo does this. Keep it.

### Docker, image, container, Compose
- **Image**: an app packaged with everything it needs (a frozen meal).
- **Container**: a running copy of an image (the meal heated and served).
- **Docker Compose**: a YAML file listing several containers that run together on one machine and share a private network.
- **In our system:** the Shinro EC2 runs `nginx`, **one `oauth2-proxy` per stream**, `shinro-api`, `redis` and `tool-exec` as one Compose stack.

### ECR (Elastic Container Registry)
AWS's private warehouse for Docker images. EC2 and EKS pull from it; we push the API, tool-exec, Temporal and terminal images to it.

### Redis
A very fast in-memory key-value store. In the diagram it holds Shinro's **state** and the **run lock** — a marker stopping one user from running two migrations at once. It will also hold the **session leases** (2.6).

## 1.5 Identity and access in AWS (IAM)

- **IAM (Identity and Access Management)**: the AWS system deciding *which identity may call which AWS action on which resource*.
- **Policy**: a JSON document listing allowed actions, e.g. "`secretsmanager:GetSecretValue` on secret X".
- **Role**: an identity *without a password* that something "puts on" to gain permissions. Servers, Lambdas, pipelines and people can all assume roles.
- **Instance profile / instance role**: the role an EC2 wears. Code on it gets temporary credentials automatically, so **no AWS keys are ever stored on the server**.
- **Least privilege**: give each role only what it needs. Example: our `shinro-live-user-admin` role can only manage users, and only in the demo pools.

## 1.6 Logging in: authentication, OAuth 2.0, OIDC, tokens

### Authentication vs authorization
- **Authentication (authn)**: *who are you?*
- **Authorization (authz)**: *what may you do?*
- **Analogy:** showing your passport is authentication; your boarding pass deciding which plane you board is authorization.
- **Why it matters here, twice over:**
  1. **oauth2-proxy only does authentication.** It answers "is this a logged-in user of *this stream's* pool?" It does **not** know that "start a Camunda workflow" is forbidden (decision 4.11) or that session `<id>` belongs to a different user (gotcha 5.20).
  2. Our **stream separation** is authentication-based: a Temporal-pool user simply doesn't exist in another stream's pool, so they can't even get a code. That's a strong boundary, and it's why per-stream pools were worth the extra machinery.

### OAuth 2.0
- **In one sentence:** a standard for an app to obtain a **token** from a trusted **authorization server**, so it never handles the user's password itself.
- **Analogy:** a hotel key card. You prove who you are once at reception (the authorization server); reception gives you a card (the token); doors (APIs) check the card, not your passport.

### OIDC (OpenID Connect)
- **In one sentence:** a thin layer on top of OAuth 2.0 adding an **ID token** — a signed statement of *who the user is* (email, groups).
- When people say "log in with OAuth" they nearly always mean OIDC.

### Vocabulary

| Term | Plain meaning | Analogy | In our system |
|---|---|---|---|
| **Identity Provider (IdP)** / Authorization server | Holds users, issues tokens | Hotel reception | **One Cognito demo pool, with a group per stream** |
| **Client** (app client) | An app registered with the IdP; has a `client_id` (public) and usually a `client_secret` (private) | A travel agency with an account at the hotel | One oauth2-proxy client per **stream**, all in the one demo pool |
| **Redirect / callback URL** | Where the IdP returns the browser after login. Must be **registered in advance, exactly** | "Send the key card to this address only" | `https://temporal.shinro.ai/oauth2/callback` |
| **Scope** | A named permission carried in a token | "Pool access" printed on the card | `openid email profile`, plus our custom `camunda/read` |
| **Resource server** | An API that accepts tokens; in Cognito it's also where custom scopes are defined | The gym that accepts the card | A `camunda` resource server with scope `read` (T-13) |
| **Access token** | Token used to call an API | The key card | Sent as `Authorization: Bearer <token>` |
| **ID token** | Token describing the user | A name badge | oauth2-proxy reads the email from it |
| **Refresh token** | Long-lived token for getting new ones without logging in again | A voucher for a replacement card | Revoked on global sign-out |
| **JWT (JSON Web Token)** | The token format: `header.payload.signature`. Anyone can *read* it; only the IdP can *sign* it | A laminated badge with a hologram — readable by all, forgeable by none | Camunda verifies Cognito JWTs (T-14) |
| **JWKS** | A public URL where the IdP publishes the keys for checking signatures | A poster showing what the real hologram looks like | Camunda fetches the temporal pool's JWKS |
| **Issuer (`iss`)** | The URL identifying an IdP. **One pool = one issuer**: `https://cognito-idp.<region>.amazonaws.com/<poolId>` | The hotel's name printed on every card | **N pools = N issuers = N oauth2-proxies** (1.9) |
| **Claim** | A field inside a token (`email`, `cognito:groups`) | A line on the badge | We read `email`; groups are optional now |

### The two OAuth flows we use

A **flow** (or "grant") is a recipe for *how* a token is obtained.

**Flow 1 — Authorization Code flow (humans in browsers).** Used by every oauth2-proxy.

```
1. Browser ──► temporal.shinro.ai/chat/            (no cookie yet)
2.         ◄── 302 redirect to the temporal pool's Cognito login page
3. Browser ──► Cognito: user types email → receives a code by email → types the code
4.         ◄── 302 back to https://temporal.shinro.ai/oauth2/callback?code=abc123
5. oauth2-proxy-temporal (on our server, never in the browser)
           ──► Cognito /oauth2/token : "here is code=abc123 AND my client_secret"
           ◄── ID token + access token (+ refresh token)
6. oauth2-proxy sets an encrypted cookie in the browser → the user is logged in
```

**Why it's safe:** the `code` in step 4 passes through the browser but is useless alone. Trading it for tokens also needs the **client secret**, known only to our server. That's the whole idea, and it's why client secrets live in **Secrets Manager** (T-13).

**Flow 2 — Client Credentials flow (machine to machine).** Used by the Camunda assessment tool.

```
1. assessment tool ──► Cognito /oauth2/token :
                       grant_type=client_credentials, client_id, client_secret, scope=camunda/read
2.                 ◄── access token (a JWT)
3. assessment tool ──► Camunda API, header "Authorization: Bearer <JWT>"
4. Camunda verifies the JWT against Cognito's JWKS and checks the scope → allowed
```

No human, no browser. **Cognito only permits this flow with a custom scope from a resource server**, which is why T-13 says "resource server + custom scope".

## 1.7 Cognito

### The parts
- **User pool**: the user directory *and* the IdP. **One pool = one issuer.**
- **App client**: one registration per app using the pool. Key settings: which **flows** (code vs client credentials), which **scopes**, which **callback and logout URLs**, which **auth flows** (`ALLOW_USER_AUTH` for passwordless), and whether it has a **secret**.
- **Domain**: where the login page and token endpoint live, e.g. `https://shinro-temporal.auth.us-east-1.amazoncognito.com`. **One per pool**, and the prefix must be globally unique.
- **Groups**: labels on users, surfacing in the ID token as `cognito:groups`.
- **Callback URLs cannot contain wildcards.** You can't register `https://*.shinro.ai/oauth2/callback`. Each one is listed explicitly. Limit: 100 per app client.

### One demo pool, one group per stream

This is what gives us "a person who asked for the Temporal demo sees the Temporal demo."

```
          ┌─────────────────────────────────────────────────────┐
          │  pool: shinro-live-demo                             │
          │  passwordless (email OTP) — configured ONCE         │
          │                                                     │
          │  group: temporal ──► oauth2-proxy-temporal ──► temporal.shinro.ai
          │  group: <next>   ──► oauth2-proxy-<next>   ──► <next>.shinro.ai
          │                                                     │
          │  jane@acme.com ∈ {temporal, <next>}   ← may be in several
          └─────────────────────────────────────────────────────┘
```

**One pool, but still one oauth2-proxy per stream.** `--allowed-group` is set per oauth2-proxy *instance*, not per route, so each stream gets its own proxy carrying its own group. The proxy count is identical to the pool-per-stream design — which is the point: **separate pools would buy nothing there.**

**Why not a pool per stream?** That was the earlier design. One pool wins on the things that actually cost time:

| | Pool per stream | **One pool + groups** |
|---|---|---|
| Passwordless setup (6 interlocking settings, below) | **Per pool** | **Once** |
| Domain prefixes, Managed Login brandings | N | 1 |
| Deliverability testing (4.13) | Per pool | Once |
| oauth2-proxy containers | N | N — *no saving either way* |
| A prospect wanting two streams | Two accounts, two OTP streams | **One account, two groups** |
| Onboarding mistake | Wrong pool → **no code arrives**, looks like broken email | Wrong group → login works, clear 403 |
| Cross-stream protection | Token won't validate | `--allowed-group` must be right |

The passwordless row decides it: that setup is the most error-prone part of the design, and doing it once beats doing it N times. The isolation given up is real but low-consequence — a prospect seeing a demo they didn't ask about is a sales awkwardness, not an incident. Sandboxes stay per-user and Camunda stays read-only.

**Users may belong to several groups.** A prospect evaluating two migration paths gets one account, one login and access to both. Free here, impossible with separate pools.

**Still a *new* pool, not the existing one** (4.2) — passwordless on the pool real Shinro customers use would change their login page and their bill.

### Passwordless login with email OTP

**What the user experiences:**
1. They click **Sign in** on `temporal.shinro.ai`.
2. The Cognito login page for the temporal pool appears. They type their email.
3. A 6-digit code (an **OTP**, one-time password) arrives by email.
4. They type it. They're in, landing at `/chat/<convid>`. No password anywhere.

**How it works underneath:** Cognito supports **choice-based authentication**, technically the **`USER_AUTH` flow**. It lets a pool accept sign-in methods ("first factors") other than a password: **email OTP**, SMS OTP, or **passkeys**. We enable email OTP. The code is single-use and expires in minutes. Being able to read it proves you control that inbox, and that *is* the authentication.

**Six things must all be true per pool, or login breaks:**

| # | Requirement | Plain explanation | Where |
|---|---|---|---|
| 1 | **Feature plan = Essentials** (or Plus) | Cognito's price tiers are Lite / Essentials / Plus. Passwordless starts at Essentials. Billed per **MAU** (monthly active user) | Pool setting |
| 2 | **Sign-in policy allows `EMAIL_OTP`** | The on/off switch for email codes | Pool setting |
| 3 | **Email sent via Amazon SES** | Cognito's built-in sender is capped (~50/day) and isn't allowed for OTP. SES is AWS's real email service | Pool email config + SES **verified domain** `shinro.ai` + **DKIM** records + SES **production access** |
| 4 | **Domain uses Managed Login** | Cognito has two login-page generations: the older "Hosted UI" and the newer "Managed Login". Only Managed Login shows passwordless screens | `UserPoolDomain` with the newer managed login version + a **branding** resource |
| 5 | **App client allows `ALLOW_USER_AUTH`** | Lets this client's logins use choice-based sign-in | oauth2-proxy app client |
| 6 | **User has `email` set and `email_verified = true`** | Cognito only sends codes to verified addresses | Set by the admin at creation (1.8) |

**SES words explained:**
- **SES (Simple Email Service)**: AWS's email-sending service.
- **Verified domain**: proving to SES you own `shinro.ai` so you may send as `no-reply@shinro.ai`. **One domain identity serves all pools** — you don't repeat this per stream.
- **DKIM**: a cryptographic signature on outgoing mail, published as DNS records, that receiving servers check. Without it, codes land in spam.
- **SPF / DMARC**: two more DNS records saying which servers may send for your domain and what to do on failure. With DKIM they decide inbox vs spam.
- **SES sandbox**: a new SES account can only send to addresses you've verified yourself. You request **production access** (a support ticket, usually about a day) to send to anyone.

**Nothing about passwordless changes oauth2-proxy.** It still runs the plain Authorization Code flow. *How* the user proves themselves on Cognito's page is invisible to it. A good line for explaining this: **"the login method is Cognito's business; the session cookie is oauth2-proxy's business."**

## 1.8 Getting users in: the request-and-grant loop

**HubSpot** is our sales CRM — where sales keeps contacts. There is **no self-service sign-up**. A customer can log in only because someone on our team put their email in the right pool.

```
 Visitor on temporal.shinro.ai
   │  clicks "Request a demo"
   ▼
 HubSpot form  ── fields: email, name, company, and a STREAM field
   │                      (hidden and pre-filled per page, or a separate form per stream)
   ▼
 A team member reads the request (HubSpot list / notification)
   │  picks the pool that matches the STREAM field
   ▼
 Runs the runbook below  ──►  Cognito pool for that stream
   │
   ▼
 Replies to the visitor: "You're set up — click Sign in and use this email address"
```

**The stream field is the single most important part of the form.** It is the only thing telling the admin which pool to use, and putting someone in the wrong pool gives them access to the wrong demo (gotcha 5.18).

### Runbook: adding a user

A **runbook** is a written step-by-step procedure. The **AWS CLI** (the `aws` command) beats clicking in the console because it's repeatable and you can't silently skip a step.

```bash
# Pick the pool for the stream named on the request. This is the step to get right.
POOL=<the stream's user pool id>          # e.g. the temporal pool
EMAIL=$(echo "Jane.Doe@Acme.com " | tr 'A-Z' 'a-z' | xargs)   # lower-case and trim

# 1. Create the user: no password, email already verified, no Cognito welcome email.
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS

# 2. Put them in the group for the stream they asked about. THIS is the permission.
#    Repeat for each stream they should see — a user may be in several groups.
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" \
  --username "$EMAIL" --group-name "$STREAM"

# 3. ONLY if the check in gotcha 5.15 shows it is needed:
#    set a long random password nobody knows, which moves the user to the CONFIRMED state.
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$EMAIL" \
  --password "$(openssl rand -base64 32)Aa1!" --permanent
```

`$POOL` is the **one** demo pool. `$STREAM` comes from the stream field on the request form and is the only access decision in the runbook.

**A returning prospect asking about a second stream needs step 2 only**, with the new stream. Same account, same login, one more group.

Then reply to the customer: *"You're all set. Go to https://temporal.shinro.ai, click Sign in, enter this email address, and type the code we email you."*

### Why each piece matters

| Piece | What happens without it |
|---|---|
| The right pool | They log in to the wrong stream, or can't log in at all |
| `email_verified=true` | Cognito never sends a code. The user "can't log in" |
| `--message-action SUPPRESS` | Cognito sends "Your temporary password is…", confusing a passwordless user |
| Lower-case + trim | Emails pasted from HubSpot can carry capitals or trailing spaces, creating a duplicate user or a login that doesn't match |

### Runbook: removing a user
1. `aws cognito-idp admin-disable-user …` — blocks new logins, reversible with `admin-enable-user`, and keeps the record as an audit trail.
2. `aws cognito-idp admin-user-global-sign-out …` — revokes refresh tokens.
3. Their oauth2-proxy cookie still works until it expires, which is why we set **8 hours**.
4. `admin-delete-user` only once you're sure.

### Who may do it
CDK creates an IAM role **`shinro-live-user-admin`** allowing only `AdminCreateUser`, `AdminSetUserPassword`, `AdminDisableUser`, `AdminEnableUser`, `AdminUserGlobalSignOut`, `AdminGetUser` and `ListUsers`, and only on **the demo pools** (not the main Shinro pool). The people onboarding customers assume this role.

**Optional helper:** `scripts/add-demo-user.sh <stream> <email>`, which maps the stream name to the right pool id and runs the steps. It should be **idempotent** — running it twice does no harm. Also keep a record (a HubSpot note) of who was added to which stream and when, because nothing else records it.

## 1.9 oauth2-proxy

- **In one sentence:** a small program that performs the Authorization Code login flow *on behalf of* web apps with no login of their own — Temporal UI, Camunda Operate, and our own paths.
- **Analogy:** the security guard beside the receptionist. The receptionist (nginx) asks "is this person OK?"; the guard checks the badge (cookie) and answers yes or no, walking them to the badge office if not.

### One per stream

**A single oauth2-proxy has one `--allowed-group`, set per instance rather than per route.** So we run **one oauth2-proxy container per stream**, all pointing at the *same* demo pool but each gating on its own group, with its own client id, client secret and — critically — its own **cookie name**.

```
nginx server block                      asks                    which pool
──────────────────────────────────────  ──────────────────────  ─────────────
temporal.shinro.ai/*                 →  oauth2-proxy-temporal → shinro-demo-temporal
demo-camunda-instance.shinro.ai/*    →  oauth2-proxy-temporal → shinro-demo-temporal
demo-temporal-ui.shinro.ai/*         →  oauth2-proxy-temporal → shinro-demo-temporal
<next>.shinro.ai/*                   →  oauth2-proxy-<next>   → shinro-demo-<next>
```

Notice the two demo consoles are wired to the **temporal** proxy. That's the hostname-to-stream rule from 0.2 doing its job: those consoles are part of the Temporal demo, so the Temporal guard checks them. If another stream later needs its own Camunda, it gets its own hostname and its own guard (decision 4.3).

### How it works with nginx: "auth_request" mode

```
               ┌───────────────── nginx ──────────────────┐
  request ───► │ 1. auth_request /oauth2/auth              │ ──► oauth2-proxy-<stream>
               │      202 → continue                       │ ◄── 202 + X-Auth-Request-Email
               │      401 → redirect to /oauth2/start      │ ◄── 401  (→ that pool's login page)
               │ 2. proxy_pass to the real destination     │ ──► app / Camunda / session pod
               └───────────────────────────────────────────┘
```

- **`auth_request`** is an nginx feature: before serving a request, nginx fires a tiny internal **sub-request** at oauth2-proxy and waits for yes (2xx) or no (401/403). It's cheap.
- On "yes", oauth2-proxy returns **identity headers** such as `X-Auth-Request-Email`. nginx can use them for routing and pass them upstream.
- **Security rule:** nginx must **overwrite** these headers itself. If it forwarded whatever the browser sent, anyone could claim to be someone else (gotcha 5.7).

### Settings, one by one

| Setting | Meaning |
|---|---|
| `--provider=oidc` | Speak OIDC (works with Cognito) |
| `--oidc-issuer-url=<the demo pool issuer>` | Which IdP to trust. The **same** for every stream's proxy — there is one pool |
| `--allowed-group=<stream>` + `--oidc-groups-claim=cognito:groups` | **The per-stream gate**, and the reason there is still one proxy per stream |
| `--client-id`, `--client-secret` | This proxy's registration in that pool |
| `--cookie-name=_shinro_<stream>` | **Must differ per stream** — see gotcha 5.19 |
| `--cookie-secret` | A random 32-byte key encrypting the cookie. One per stream, in Secrets Manager |
| `--cookie-domain=.shinro.ai` | Send the cookie to all `*.shinro.ai` hosts, so one login covers the stream page *and* its demo consoles |
| `--whitelist-domain=.shinro.ai` | Only redirect back to our own domain after login, so it can't bounce users to a hostile site |
| `--email-domain=*` | Accept any email domain (customers come from many companies) |
| `--cookie-expire=8h` | Log users out after 8 hours, so a removal takes effect within a working day |
| `--reverse-proxy=true` | "I'm behind nginx (and CloudFront); trust the `X-Forwarded-*` headers" |
| `--set-xauthrequest=true` | Return the `X-Auth-Request-*` identity headers to nginx |
| `--skip-provider-button=true` | Go straight to Cognito instead of showing oauth2-proxy's own "Sign in with…" page |

`--allowed-group` is the load-bearing flag here: with one shared pool it is the only thing keeping a stream-A user out of stream B. Generate it from the stream name in the config template so it can never be omitted.

## 1.10 nginx

- **In one sentence:** a fast web server used as a **reverse proxy** — the browser talks to nginx, nginx forwards to the real service.
- **Analogy:** a receptionist who takes your request and walks it to the right back office. You never learn the office's internal room number (its private IP).

### Host-based routing
One IP serves many hostnames. nginx reads the **`Host` header** (and the TLS **SNI**) and picks the matching **`server` block**:

```nginx
server { listen 80;        server_name _;                                 }  # CloudFront → app paths
server { listen 443 ssl;   server_name demo-camunda-instance.shinro.ai;   }  # → Camunda private IP
server { listen 443 ssl;   server_name demo-temporal-ui.shinro.ai;        }  # → the logged-in user's pod
```

### Routing by who is logged in
A `server` block picks the hostname and `location` blocks pick the path — but the per-user Temporal session is chosen by **neither**. It is chosen by the **email** oauth2-proxy hands back, which is what lets every user share one plain URL.

Conceptually nginx answers two questions in order:

```
1. ask oauth2-proxy  "who is this?"             → jane@acme.com
2. ask shinro-api    "where is her session?"    → 10.0.2.31:31234   (or nothing)
3. proxy there                                   (or show "start a migration")
```

**An implementation nuance worth knowing:** nginx allows only **one `auth_request` per `location`**, so these two questions can't simply be stacked in one block. Decision 4.7 gives the two ways to chain them.

### Other nginx terms
- **`proxy_pass`**: forward this request to that address.
- **`upstream`**: the backend being forwarded to.
- **`map`**: a lookup table (e.g. cookie value → which proxy to ask).
- **`auth_request_set`**: capture a header from the auth sub-request's response into a variable.
- **`resolver 127.0.0.11`**: Docker's internal DNS. The old repo explains why it's needed — nginx normally resolves a backend's address *once* at startup, so a recreated container with a new IP produces endless 502s. Using a **variable** in `proxy_pass` plus `resolver` forces periodic re-resolution.
- **`sub_filter`**: rewrites text in a proxied response. A last-resort tool if the Temporal UI can't be told it lives under a path prefix (decision 4.6).
- **`nginx -s reload`**: re-read config without dropping connections.

## 1.11 CloudFront and S3

### S3
- **In one sentence:** AWS's file storage ("object storage"); files live in **buckets**.
- **In our system:** one bucket with **one folder per hostname** — `shinro.ai/`, `temporal.shinro.ai/`, and so on.

### CloudFront
- **In one sentence:** AWS's **CDN** (content delivery network) — caching servers worldwide.
- **Analogy:** brochure stands in every city, so visitors don't travel to headquarters.
- **Distribution**: one CloudFront configuration with its own hostnames and rules.
- **Alias**: a hostname the distribution answers for. Ours: `shinro.ai` and `*.shinro.ai`.
- **Origin**: where CloudFront fetches what it hasn't cached. We have two: the **S3 bucket** and the **Shinro EC2**.
- **Behaviour**: a rule saying "requests matching this *path pattern* go to that origin with these cache settings."

> **The limitation that shapes our design: CloudFront behaviours match on *path*, not on *host*.** You cannot write "requests for `demo-camunda-instance.shinro.ai` go to the EC2." That's precisely why the two demo consoles get their own A records straight to the EC2 instead of riding on the wildcard distribution (decision 4.4). Their root path `/` would otherwise fall into the default behaviour and be served from S3.

**Our behaviours, in order:**

| Path pattern | Origin | Caching | Why |
|---|---|---|---|
| `/chat/*` | Shinro EC2 | **Disabled**, forward all cookies/headers/query | The logged-in app |
| `/v2/*` | Shinro EC2 | **Disabled**, forward everything, WebSocket-capable | API and chat stream |
| `/oauth2/*` | Shinro EC2 | **Disabled**, forward everything | Login start and callback |
| `/assets/*` | Shinro EC2 | Cached (hashed filenames) | The UI's JS/CSS, served by nginx (DEPLOYMENT decision 1) |
| `/login`, `/settings` | Shinro EC2 | **Disabled** | UI routes that must not fall through to S3 |
| `*` (default) | S3 | Cached | Public marketing pages |

> **Why the UI paths go to the EC2:** the built UI is served by nginx on the Shinro EC2, not from S3. Without these behaviours, `/assets/*`, `/login` and `/settings` would fall into the default and come from S3. **Consequence:** the public stream pages in S3 must not use an `/assets/` path of their own — it is claimed by the UI on every hostname.

- **CloudFront Function**: a tiny JavaScript that runs at the edge on every request. Ours reads the `Host` header and rewrites the path, so `temporal.shinro.ai/` becomes `/temporal.shinro.ai/index.html` in S3 — the "site by host" idea from the diagram.
- **OAC (Origin Access Control)**: lets *only* CloudFront read the private S3 bucket, so nobody can bypass the CDN.
- **Origin secret header**: CloudFront adds `X-Origin-Secret: <random>` when calling the EC2, and nginx rejects anything without it. Even if someone finds the EC2's IP, they can't reach the app paths directly. The old repo already implements this (`lib/origin-secret.ts`).

## 1.12 Kubernetes and EKS

### Kubernetes ("k8s")
- **In one sentence:** a system that runs containers across a group of servers, restarts them when they crash, and keeps them isolated.
- **Analogy:** a building manager. You describe what you want ("a room with a Temporal server and a terminal, max 3 CPU"), and they find space, set it up and maintain it.

### EKS (Elastic Kubernetes Service)
AWS runs the Kubernetes brain (the **control plane**); you supply the servers that run containers (the **nodes**).

### Vocabulary

| Term | Plain meaning | Analogy | In our system |
|---|---|---|---|
| **Cluster** | The whole Kubernetes setup | The building | One EKS cluster (T-31) |
| **Control plane** | The Kubernetes API and brain, run by AWS | The manager's office | Private endpoint (gotcha 5.9) |
| **Node** | A server (EC2) running containers | A floor | |
| **Node group** | A set of identical nodes with min/max, able to scale | "1 to N floors" | Sized for ~20 sessions (T-30) |
| **Pod** | Smallest unit: one or more containers running together | A single office | "Temporal + terminal" per session |
| **Deployment** | "Keep N copies of this pod running" | A standing instruction | Temporal dev server, terminal |
| **Service** | A stable address in front of pods | The office's fixed extension | |
| **NodePort** (Service type) | Opens a fixed port (30000–32767) on **every** node's IP, forwarding to the pods | A number that rings through on any floor | How nginx reaches a session without a load balancer (T-31) |
| **Namespace** | A named, isolated folder in the cluster | A private suite with its own door | **One per user session** (T-28) |
| **ResourceQuota / LimitRange** | Caps total CPU/RAM per namespace / per container | A power budget per suite | T-30 |
| **NetworkPolicy** | A firewall *between pods* | Internal doors that open only for certain people | T-32: the session may reach only its own Temporal (plus the CLI listener and module proxy, 4.17) |
| **securityContext** | Per-container safety: `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false` | "No master keys, no moving the furniture" | T-32 — the terminal runs **LLM-generated code** |
| **Manifest** | A YAML file describing k8s objects | The written instruction | The session template |
| **kubectl** | The command-line tool for the cluster | The phone to the office | |
| **ClusterRole / RBAC** | Kubernetes' own permission system | Staff access levels | The session controller gets a limited role |
| **EKS Access Entry** | Connects an **AWS IAM role** to **Kubernetes permissions** | Giving a contractor a building pass | The Shinro EC2 role may create session namespaces |
| **Pod Identity / IRSA** | Gives a pod its own AWS IAM role | | Deliberately **not** used — session pods must not touch AWS |
| **Add-on** | Components AWS installs and updates: **vpc-cni** (pod networking), **coredns** (in-cluster DNS), **kube-proxy** (makes Services and NodePorts work) | Power, phones, mail | |

**NetworkPolicy needs no extra software — up to a point:** the default **VPC CNI** plugin enforces it once `enableNetworkPolicy: "true"` is set in its add-on config, which covers pod-to-pod and IP-range rules. It cannot match **DNS names**, so the moment you want "outbound HTTPS to Go module hosts and nothing else" you need Calico or an in-VPC proxy instead. See decision 4.17.

### Temporal terms
- **Temporal server**: the workflow engine. A **dev server** (`temporal server start-dev`) is a single process with a built-in UI and a **SQLite** database — ideal for throwaway per-user sessions.
- **Worker**: a process running *your* workflow code; it connects to the server and polls a **task queue**.
- **Task queue**: a named line of work. Each migration gets its own so runs don't mix.
- **Temporal namespace**: a Temporal concept, **not** the same as a Kubernetes namespace. Don't conflate them when explaining — each user session has both.
- **Where the UI sits:** each session's Temporal UI is served at the **root** of its own hostname (decision 4.6), which is what it expects by default. No path-prefix configuration is needed — and that is precisely why we chose this URL shape.

### Camunda terms

The local reference stack is `~/Playground/camunda-full`, **Camunda 8.8.32**, and 8.8 changes the shape of this considerably (4.16).

- **Camunda 8**: a workflow engine driven by BPMN diagrams.
- **Consolidated mode**: 8.8 merges Zeebe, Operate and Tasklist into **one** `camunda/camunda` container (Spring profiles `identity,operate,tasklist,broker,consolidated-auth`). There is no separate Operate service any more.
- **Zeebe**: the engine. gRPC on **26500**.
- **Operate / Tasklist / REST API**: all on container port **8080**, at `/operate`, `/tasklist` and `/v2/...`, plus `/sso-callback` for login. Locally that port is published as 8088 — a host mapping, not a Camunda port.
- **Management port 9600** (health, metrics) and **Elasticsearch 9200**: internal only, never exposed (T-12).
- **Keycloak**: the OIDC provider Camunda ships with, running the `camunda-platform` realm on **18080**, backed by **Identity** (8084) and **Postgres**. This is Camunda's own IdP — distinct from Cognito, which guards *our* edge. See decision 4.20.
- **Audience (`aud`)**: Camunda validates this claim against `orchestration-api`. It is the single detail that decides whether Cognito can replace Keycloak (4.20, gotcha 5.33).
- **BPMN / DMN**: workflow and decision diagram formats, seeded per T-15.
- **The OMS app**: a separate job-worker container (`oms-camunda-quest1`, port 8090) that joins the same Docker network and connects to Zeebe. It is part of the demo environment, not part of Camunda.

## 1.13 Other AWS services

| Service | In one sentence | In our system |
|---|---|---|
| **Secrets Manager** | A safe for secrets, guarded by IAM | Per-stream client secrets and cookie secrets, LLM API keys |
| **SSM Parameter Store** | A key-value store for *non-secret* config, by name | `/shinro/live/camunda-private-ip`, pool ids, issuer URLs |
| **SSM Session Manager** | A shell on an EC2 through AWS, **no SSH, no open port 22** | How we log into both servers |
| **SSM Run Command** | Run a command on servers through AWS | Re-sync the config bundle without replacing the server |
| **CloudWatch** | Logs, metrics, alarms, dashboards | Container logs, disk/memory alarms, cost alarm |
| **CloudWatch agent** | An agent that reports memory and disk (AWS doesn't by default) | Both servers |
| **Container Insights** | CloudWatch's Kubernetes metrics | Node and session stats |
| **DLM (Data Lifecycle Manager)** | Scheduled EBS snapshots with automatic cleanup | Daily Camunda disk backups (T-19) |
| **Route 53** | AWS's DNS | The `shinro.ai` hosted zone |
| **Hosted zone** | All DNS records for one domain | `shinro.ai` — already exists, so **import, never create** |
| **CodeBuild** | Managed throwaway build machines | **Not used** — generated code is built in the sandbox (4.18) |
| **SNS** | Notifications | Alarm emails |
| **AWS Budgets** | Alerts when spend crosses a threshold | The "trial cost" alarm |
| **Lambda** | Run a small function with no server | The Camunda health checker |

## 1.14 AWS CDK

### CloudFormation first
**CloudFormation** is AWS's infrastructure-as-code engine: you give it a **template** describing resources, and it creates, updates or deletes them to match. One deployed template = one **stack**.

### What CDK adds
**CDK (Cloud Development Kit)** lets you write that description in TypeScript, and generates the CloudFormation template for you.
**Analogy:** CloudFormation is the construction crew reading blueprints; CDK is the architect's software that draws them.

### Vocabulary

| Term | Plain meaning |
|---|---|
| **App** | The whole CDK program (`bin/shinro-live-infra.ts`); it contains stacks |
| **Stack** | One CloudFormation stack, deployed and deleted as a unit |
| **Construct** | A reusable building block — a class creating one or more resources |
| **`cdk bootstrap`** | One-time setup per account and region (creates a bucket and roles CDK needs) |
| **`cdk synth`** | Turn TypeScript into a CloudFormation template without deploying |
| **`cdk diff`** | Show what *would* change. **Always read it before deploying** — it warns about replacements |
| **`cdk deploy`** | Apply the changes |
| **Context** | Settings passed into the app (`cdk.json` or `-c key=value`). **This is where the stream list lives** |
| **`fromLookup` / `fromXxx`** | **Import** an existing resource read-only (the hosted zone). You can attach things to it but not change its own settings |
| **Cross-stack reference** | Using stack A's value in stack B. CDK makes it a CloudFormation **Export**, which can't be changed while another stack imports it. **Looser alternative:** stack A writes an **SSM parameter** by name, and stack B or the server reads it. The old repo does this |
| **Removal policy** | On stack deletion: `DESTROY` or `RETAIN`. Critical for anything holding users or data |
| **Replacement** | A change CloudFormation can only apply by deleting and recreating the resource |
| **`for` loop over context** | Not a CDK term, but the technique that makes "one per stream" sustainable: iterate the stream list and create the same constructs each time |

## 1.15 The in-browser terminal

The Shinro CLI is a desktop program. This brings it to the chat page: the user clicks **"Run in terminal"** and a real shell appears in the browser, attached to their own sandbox.

| Piece | In one sentence | Runs on |
|---|---|---|
| **xterm.js** | A terminal emulator written in JavaScript — it draws the black box and handles keys, colours and the cursor | The browser |
| **ttyd** | A small server that exposes a shell over a WebSocket so a browser can drive it | The terminal container |
| **tmux** | A *terminal multiplexer*: it keeps a shell session alive and re-attachable after you disconnect | The terminal container |
| **Terminal proxy** | A FastAPI endpoint relaying bytes between the browser's WebSocket and ttyd's, after checking who you are | shinro-api, on the Shinro EC2 |
| **CLI token** | A short-lived credential (scope `demo-cli`, at most 2 hours, never outliving the sandbox) letting the CLI call the API as that user | Minted by the API, tracked in Redis for revocation |
| **One-time code** | A single-use string, valid 60 seconds, swapped for the CLI token *inside* the pod so the token never appears in a URL | Redis |

**Why relay through the API instead of connecting the browser straight to the pod:**
- The pod has no public address. Giving it one would mean a hostname, a certificate and a login *per session*.
- The API already knows who the user is from the oauth2-proxy headers, so it can refuse a terminal for a sandbox the user doesn't own — the same ownership check as 2.7, reused.
- Revocation lives in one place: drop the token from Redis.

**Why tmux:** closing the panel, refreshing the page or sleeping the laptop kills nothing. The user reattaches to the same screen and long commands keep running. Each chat gets its own tmux session and folder (`~/chats/<id>/`), with up to **5 retained** and the least recently used closed first.

**What else is in the container:** the Shinro CLI, the **Go 1.26** toolchain and **`migrate-agent`**, which generates, builds and tests the migrated code right here — so the user never leaves the page, and nothing is built anywhere else (4.18). The session's Temporal dev server runs beside it. That toolchain is what forces decisions 4.17 and 4.18. The image is about **590 MB unpacked** (measured on arm64), smaller than first feared (4.19).

---

# Part 2 — Walk-throughs: what happens when…

## 2.1 A visitor opens `temporal.shinro.ai` (the public stream page)

1. **DNS:** no specific record exists, so the wildcard `*.shinro.ai` matches → **CloudFront**.
2. **CloudFront** serves it over HTTPS using the ACM certificate in us-east-1.
3. The path is `/`, which matches the **default behaviour** → S3.
4. The **CloudFront Function** rewrites the path to `/temporal.shinro.ai/index.html`, so this stream's folder is served.
5. CloudFront fetches it from S3 through **OAC** and returns it, cached at the edge.
6. **No login is involved.** The page shows the two buttons.

## 2.2 The visitor clicks "Request a demo"

1. The button opens the **HubSpot form** — either embedded on the page or opened in a new tab.
2. The form carries a **stream field**, pre-filled with `temporal` because it's on that page.
3. The visitor submits their email. HubSpot notifies the team.
4. The page says something like *"Thanks — we'll email you when your access is ready."* This matters: access is granted by a human, not instantly (decision 4.12).
5. A team member runs the runbook in 1.8 against the **temporal** pool.
6. They reply to the visitor.

## 2.3 The visitor clicks "Sign in"

1. The button is a link to **`https://temporal.shinro.ai/oauth2/start?rd=/chat`**. That's oauth2-proxy's own endpoint, which means the "Sign in" button needs no custom code.
2. **DNS → CloudFront.** The path `/oauth2/*` matches a behaviour pointing at the **Shinro EC2**, with caching disabled and all cookies and query strings forwarded.
3. **nginx** (port 80, origin-secret checked) routes `/oauth2/*` to **oauth2-proxy-temporal**.
4. oauth2-proxy redirects the browser to the **temporal pool's Cognito Managed Login** page.
5. The visitor types their email. **SES** sends a 6-digit code. They type it in.
   - If their email isn't in the demo pool at all, **no code is ever sent**.
   - If it is in the pool but **not in this stream's group**, they get a code, sign in to Cognito successfully, and then oauth2-proxy returns **403** — a visible, diagnosable failure rather than silence (5.18).
6. Cognito redirects to `https://temporal.shinro.ai/oauth2/callback?code=…`, which travels CloudFront → nginx → oauth2-proxy.
7. oauth2-proxy exchanges the code (plus its client secret) for tokens, then sets an encrypted cookie named **`_shinro_temporal`** scoped to `.shinro.ai`.
8. It redirects to `/chat`.

## 2.4 The app opens at `temporal.shinro.ai/chat/<convid>`

1. `/chat/*` matches a CloudFront behaviour → the Shinro EC2, uncached.
2. **nginx** runs `auth_request` against **oauth2-proxy-temporal**. The cookie is valid → `202` plus `X-Auth-Request-Email: jane@acme.com`.
3. nginx **overwrites** the identity headers (gotcha 5.7) and serves the UI's static files itself, proxying API calls to shinro-api. shinro-api creates its own session from those headers (4.21).
4. With no `<convid>`, shinro-api creates or resumes a conversation and redirects to `/chat/<convid>`.
5. The chat WebSocket runs over `/v2/*`, through CloudFront and nginx, with the `Upgrade` headers forwarded.
6. Everything the user does from here — assessment, migration, console links — happens inside this page.

## 2.5 The user opens the shared demo Camunda

1. The app links to **`https://demo-camunda-instance.shinro.ai`**.
2. **DNS:** this host has **its own A record** → the Shinro EIP, so it bypasses CloudFront entirely.
3. **TLS** is terminated by nginx on 443, using the certificate on disk (decision 4.5).
4. nginx runs `auth_request` against **oauth2-proxy-temporal** — the same guard as the stream page, because this hostname belongs to the temporal stream.
   - The user already has the `_shinro_temporal` cookie for `.shinro.ai`, so this is invisible: **no second login.**
5. nginx proxies to `http://<camunda-private-ip>:8080` — in 8.8 one port serves Operate (`/operate`), Tasklist (`/tasklist`), the REST API (`/v2/...`) and the login callback (`/sso-callback`). The **Camunda SG** permits it only from the **Shinro SG** (T-10, T-12).
6. Elasticsearch (9200) and Zeebe's internal ports are never reachable from outside (T-12).
7. The instance is **shared**: every temporal-stream user sees the same Camunda. Which is why it must be effectively read-only (decision 4.11) — one user must not be able to change what the next user sees.

## 2.6 The user starts code analysis (the session lifecycle, T-29/T-30/T-34)

> **Changed (DEPLOYMENT):** the session is leased when **code analysis** starts, not when migration starts, and the code is generated, built and tested **inside the user's terminal container** by `migrate-agent` — not by tool-exec and CodeBuild.

1. **Lease:** shinro-api's **session controller** (Shinro application code, 4.7) reserves a session for this user and creates the namespace through the EKS API (Stack 7). There is no warm pool at launch (4.19). The lease is **idempotent per user**: asking twice returns the same session, and later migrations reuse it.
2. **Lease record:** Redis stores, keyed by the user's email, the Kubernetes namespace name, the NodePort addresses and the expiry time. The session also gets an **internal id**, used for the namespace name and the Redis key — but it **never appears in a URL** (decision 4.6).
3. **Analyse and generate:** `migrate-agent` runs in the user's terminal container, calling back into shinro-api for sign-in and LLM turns (the EKS → API rule in Stack 1). It writes the Temporal project into `~/chats/<id>/`.
4. **Build and test:** in the same container, with Go 1.26 and Go modules from the in-VPC proxy (4.17). Each migration uses **its own Temporal task queue**. Nothing is built on the Shinro host, and no image is pushed (4.18).
5. **Validate:** the validation tool connects from the Shinro EC2 to the session's Temporal **gRPC (7233)** through its NodePort, runs sample workflows and reports results (T-45, T-48).
6. **Link:** the app shows the user **`https://demo-temporal-ui.shinro.ai`** — the same URL for every user.
7. **Expiry:** after the **TTL** (time-to-live — 2 days from assignment) the session controller **deletes** the namespace and the Redis entry. There are no backups; sessions are throwaway by design (T-33), and generated code is lost with them (4.22).

## 2.7 The user opens their Temporal session at `demo-temporal-ui.shinro.ai`

Every user opens the **same URL**. What they get depends on who they are.

1. **DNS:** own A record → Shinro EIP, bypassing CloudFront.
2. **TLS** terminated at nginx.
3. **Authentication:** `auth_request` → **oauth2-proxy-temporal**. The existing `_shinro_temporal` cookie means no new login. nginx captures `X-Auth-Request-Email: jane@acme.com`.
4. **Resolution:** nginx asks shinro-api, over a second internal sub-request, *"where is jane@acme.com's session?"* The API looks up her lease in Redis and answers with an address, e.g. the header `X-Session-Upstream: 10.0.2.31:31234`.
5. **Proxy:** nginx forwards the request there unchanged. The Temporal UI sits at the root of that address *and* at the root of this hostname, so every link and asset URL it generates already resolves correctly. Nothing to strip, nothing to rewrite.
6. **If she has no session** — she hasn't started a migration, or her two days are up — the API returns no address and nginx serves a static page: *"Start a migration to see it here."* This is exactly what T-18 specifies.
7. Because the API resolves this on **every request**, nothing is cached and nothing goes stale. When the namespace is deleted at the TTL, the very next request falls through to step 6 on its own.

**What makes this safe:** there is no session identifier anywhere in the URL, so there is nothing to guess, paste or screenshot. The only thing deciding which session Jane sees is the email nginx received from oauth2-proxy — which is exactly why nginx must set that header itself and never trust one sent by the browser (gotcha 5.20).

## 2.8 The user clicks "Run in terminal"

1. The browser asks `GET /v2/demo/session` for the current sandbox state.
2. It opens `wss://temporal.shinro.ai/v2/demo/terminal?conversation=<chat>`. That path is under `/v2/*`, so it travels **CloudFront (uncached) → nginx → shinro-api** — no new hostname and no new CloudFront behaviour, but the WebSocket upgrade has to survive both hops (gotcha 5.27).
3. The API validates the oauth2-proxy cookie **and the `Origin` header**, and confirms this user owns this chat and has a live sandbox.
4. It mints a **CLI token** (scope `demo-cli`, ≤2 hours, never outliving the sandbox) and stores it in Redis under a **one-time code** valid for 60 seconds.
5. It connects to **ttyd** in the user's terminal container, passing the *code* — never the token.
6. Inside the pod, a `terminal-shell` script swaps the code for the token and the chat context, the CLI authenticates, and **tmux** attaches to `~/chats/<id>/demo-app`.
7. The panel waits for the `shinro ❯` prompt **plus a 400 ms quiet period** before typing anything, so commands aren't swallowed by a shell that isn't ready.
8. Closing the panel leaves everything running. Reopening reattaches to the same screen.

**The security shape, in one line:** the browser never holds a credential for the pod, the pod never holds one for anyone else's chat, and the token can be revoked centrally by deleting one Redis key.

## 2.9 The assessment tool reads Camunda (machine to machine, T-13/T-14)

1. tool-exec requests a token with **client credentials** (Flow 2 in 1.6) from **Keycloak**, not Cognito (decision 4.20): `POST http://<camunda-private-ip>:18080/auth/realms/camunda-platform/protocol/openid-connect/token`, client `shinro-assessment`, audience `orchestration-api`.
2. It calls the REST API at `http://<camunda-private-ip>:8080/v2/...` or Zeebe at `grpc://<camunda-private-ip>:26500` with `Authorization: Bearer <JWT>`.
3. Camunda verifies the JWT against Keycloak's **JWKS** and checks `aud` contains `orchestration-api`.
4. **T-14 called this the riskiest step.** Keeping Keycloak reduces it to configuration, because this exact path already works locally. What changes is only the address, the client and the secret (4.20).

**The connection parameters, local → deployed** — tool-exec is on the Shinro EC2 and reaches Camunda over the VPC, so it uses the **private IP**, never the public hostname:

| Param | Local | Deployed |
|---|---|---|
| Zeebe address | `grpc://localhost:26500` | `grpc://<camunda-private-ip>:26500` |
| Zeebe REST address | `http://localhost:8088` | `http://<camunda-private-ip>:8080` |
| Operate base URL | `http://localhost:8088` | `http://<camunda-private-ip>:8080` |
| Auth method | `oidc` | unchanged |
| Client ID | `orchestration` | **`shinro-assessment`** (5.31) |
| OIDC token URL | `http://localhost:18080/auth/realms/camunda-platform/…/token` | `http://<camunda-private-ip>:18080/auth/realms/camunda-platform/…/token` |
| Audience | `orchestration-api` | unchanged |

gRPC goes **direct, not through nginx** — proxying it needs `grpc_pass` and buys nothing inside the VPC.

---

# Part 3 — The CDK plan

## 3.1 Repository layout

```
bin/shinro-live-infra.ts          # The App: creates stacks in order; region pinned to us-east-1
lib/stacks/
  network-stack.ts                # VPC, subnets, NAT, security groups, CloudFront prefix-list lookup
  edge-stack.ts                   # Route 53, ACM cert, S3 sites, CloudFront + Function + behaviours
  identity-stack.ts               # ONE COGNITO POOL PER STREAM + SES domain + user-admin IAM role
  shinro-host-stack.ts            # Shinro EC2 (nginx, N × oauth2-proxy, api, redis, tool-exec)
  camunda-host-stack.ts           # Camunda EC2 (private), DLM backups, alarms
  eks-stack.ts                    # EKS cluster, node group, add-ons, access entries
  registry-stack.ts               # ECR repositories
  observability-stack.ts          # Log groups, dashboards, cost + capacity alarms
  # (no build-stack.ts: CodeBuild dropped, decision 4.18)
lib/constructs/
  stream-identity.ts              # NEW: everything one stream needs in Cognito. Instantiated per stream
  ...                             # Others copied and adapted from shinro-demo-infra
assets/shinro-bundle/             # docker-compose.yml, nginx.conf.template,
                                  #   oauth2-proxy config template (rendered once per stream), render-env.sh
assets/camunda-bundle/            # Camunda compose (from the "jetson" stack, T-11), render-env.sh
k8s/session-template/             # Session template: namespace, quota, netpol, Temporal, terminal
                                  #   Moves here from the app repo's docker/demo-terminal/kind/session.yaml.tmpl
                                  #   Keep it address-agnostic: the same manifests run on a local
                                  #   kind cluster, which is how the terminal work is developed
scripts/add-demo-user.sh          # <stream> <email> onboarding helper
```

### The stream list is config

Everything per-stream is driven by one list in `cdk.json`, so adding a stream is an edit plus a deploy — never copy-paste:

```jsonc
"shinro:streams": [
  {
    "name": "temporal",                                  // used in resource names
    "subdomain": "temporal.shinro.ai",                   // the stream page + app
    "consoles": [                                        // extra hostnames this stream's proxy guards
      "demo-camunda-instance.shinro.ai",
      "demo-temporal-ui.shinro.ai"
    ]
  }
  // further streams added here
]
```

**Naming rule:** use `live` everywhere the old repo used `demo`, and include the stream name: SSM prefix `/shinro/live/<stream>/`, pools `shinro-live-<stream>`, log groups `/shinro/live/*`, ECR `shinro-live-*`, stacks `ShinroLive*`. The old stack keeps running untouched in the same account and nothing clashes.

## 3.2 What we copy from the old repo (patterns only)

| Old file | What we reuse | What changes |
|---|---|---|
| `lib/constructs/demo-host.ts` | The **UserData** boot script: install Docker + Compose, ECR login, CloudWatch agent, `s3 sync` the bundle, render the env file from SSM/Secrets Manager, `docker compose up`. Plus **IMDSv2**, encrypted **gp3**, **SSM** access, no SSH | Camunda goes in a **private** subnet. A new IAM role scoped to `/shinro/live/*` |
| `lib/constructs/networking.ts` | CloudFront prefix-list lookup; **EIP created separately** from the server (breaks a dependency loop, gotcha 5.4); one SG per port | A **new VPC** with private subnets, instead of the account's default VPC |
| `lib/origin-secret.ts` + nginx template | Origin-secret check, WebSocket headers, Docker `resolver` with variable `proxy_pass` | Add 443 blocks for the two consoles, `auth_request` per stream, and the path-based session route |
| `lib/constructs/runtime-config.ts` | Non-secret config in SSM by name; generated secrets in Secrets Manager; secret ARNs published as SSM params | New prefix; **per-stream** cookie secrets and client secrets |
| `lib/constructs/identity.ts` | The shape of a Cognito pool + client + domain in CDK | Becomes `stream-identity.ts`, instantiated once per stream, with passwordless settings added |
| `lib/constructs/observability.ts` | One log group per Compose service; CloudWatch agent for memory and disk | New service list, including N oauth2-proxies |
| `storage.ts`, `registry.ts`, `ci-role.ts` | Buckets, ECR, CI role | Renamed; new repos for the terminal and Temporal images. **CI is a new workflow** — not the app repo's `.github/workflows/demo-deploy.yml`, which deploys the old `ShinroDemoStack` and doesn't build the terminal image |

## 3.3 Stack by stack

### Stack 1 — `NetworkStack` (T-10, T-31)
**Purpose:** build the fenced campus and its doors.

- `new ec2.Vpc(...)`: **2 AZs** (EKS needs two), **public** subnets (Shinro EC2, NAT) and **private** subnets (`PRIVATE_WITH_EGRESS`: Camunda, EKS), `natGateways: 1`.
- **Security groups:**

| SG | Allows | From | Why |
|---|---|---|---|
| `ShinroCfSg` | 80 | CloudFront prefix list only | App paths arrive via CloudFront |
| `ShinroPublicSg` | 443 (+80 for redirect) | anywhere | The two demo consoles are reached directly. oauth2-proxy protects them |
| `CamundaSg` | 8080, 26500, 18080 | **Shinro SG only** | T-10; ports per 4.16 and `CAMUNDA-DEPLOYMENT.md` §2 |
| EKS node SG | NodePort 30000–32767 | **Shinro SG only** | T-31 |
| `ShinroInternalSg` (on the Shinro EC2) | the internal CLI listener (e.g. 8000) | **EKS node SG only** | Terminal pods call the API for CLI sign-in and LLM turns. nginx on this listener exposes **only the CLI routes**, never the whole API (DEPLOYMENT gap) |
| EKS cluster SG | 443 (Kubernetes API) | **Shinro SG only** | The session controller creates namespaces through the private endpoint |

- Optional **VPC endpoints** (free S3 gateway, plus ECR and SSM) to cut NAT data costs.

### Stack 2 — `EdgeStack`
**Purpose:** the public pages and the phone book.

- `HostedZone.fromLookup({ domainName: "shinro.ai" })` — **import**, never create.
- **ACM certificate** in **us-east-1** for `shinro.ai` + `*.shinro.ai`, DNS-validated (ACM asks for a DNS record to prove ownership; CDK creates it). This one is for CloudFront.
- **S3** site bucket: private, readable only through **OAC**, one folder per hostname.
- **CloudFront distribution:** aliases `shinro.ai` and `*.shinro.ai`; the host→folder **CloudFront Function**; the behaviours from 1.11 (`/chat/*`, `/v2/*`, `/oauth2/*`, `/login`, `/settings` → EC2 uncached; `/assets/*` → EC2 cached; default → S3). The CloudFront Function must apply to the S3 default only.
- **Route 53:**
  - Alias `shinro.ai` and `*.shinro.ai` → CloudFront. *The wildcard means a new stream subdomain needs no DNS change.*
  - **A records** `demo-camunda-instance` and `demo-temporal-ui` → the Shinro EIP. These override the wildcard (1.1).
- ⚠ **Before deploying, list the existing records** (e.g. `demo.shinro.ai` from the old stack) and check the wildcard won't hijack one.

### Stack 3 — `IdentityStack` (supersedes T-13's "reuse the pool")
**Purpose:** one badge office per trade show.

**One pool, created once**, then a small loop over `shinro:streams` for the per-stream pieces.

Once, for the whole product:

- **User pool** `shinro-live-demo`, created and owned by CDK, with:
  - `featurePlan: ESSENTIALS` (requirement 1 in 1.7)
  - `signInPolicy.allowedFirstAuthFactors`: `emailOtp` (requirement 2)
  - `email: UserPoolEmail.withSES(...)` pointing at the shared `shinro.ai` identity (requirement 3)
  - self-sign-up **off** (admin-create-only)
  - **`removalPolicy: RETAIN`** — a deleted pool means every customer loses access with no undo
- **Managed Login domain**: one prefix, e.g. `shinro-demo-<account>`, with `managedLoginVersion: NEWER_MANAGED_LOGIN` plus a `CfnManagedLoginBranding` resource (requirement 4). Brand it with the Shinro logo and a line saying the code expires in a few minutes (4.13).
- **SES**: `ses.EmailIdentity` for `shinro.ai` with **Easy DKIM**, wired to the Route 53 zone so CDK writes the DKIM records. Then request **SES production access** (about a day). Until approved, SES only sends to addresses you've verified yourself.
- **IAM role `shinro-live-user-admin`** (1.8), scoped to this pool's ARN.
- **`RemovalPolicy.RETAIN`** — this one pool now holds *every* demo customer (5.12).

Then, looped over `shinro:streams`:

- **A group** named after the stream (`CfnUserPoolGroup`). Membership *is* the access decision, and **a user may be in several**.
- **App client `oauth2-proxy-<stream>`**: authorization code flow, scopes `openid email profile`, `generateSecret: true`, auth flows including `user: true` (`ALLOW_USER_AUTH`, requirement 5). **Callback URLs**: `https://<subdomain>/oauth2/callback` plus one per entry in that stream's `consoles` list. Logout URLs likewise.
- **Cookie secret**: a generated `secretsmanager.Secret` per stream, so one stream's cookie can't be read by another's proxy.
- **Client secret** → Secrets Manager. Either copy `userPoolClient.userPoolClientSecret` into a secret in CDK, or follow the old repo and let the host call `DescribeUserPoolClient` at boot. Pick one and be consistent.
- **SSM parameters**: the shared pool id and issuer URL, plus each stream's client id, group name and secret ARNs, read by name at boot.

For the **temporal** stream only (T-13, T-14) — **and only if decision 4.20 picks Cognito for Camunda**, which is not the recommendation:
- **Resource server** `camunda` with custom scope `read` → giving `camunda/read`.
- **App client `camunda-assessment`**: client-credentials flow, scope `camunda/read`, `generateSecret: true`.

If Keycloak stays (the recommendation), **none of this is built**. The assessment tool's credential is a *Keycloak* client instead, created by the Camunda bundle and stored in Secrets Manager by Stack 5. Cognito is then used only at the edge, for our own users.

### Stack 4 — `RegistryStack` (T-31, T-34)
ECR repositories: `shinro-live-api`, `shinro-live-tool-exec`, `shinro-live-temporal` (dev-server image, `temporalio/temporal:1.10.0`), and **`shinro-live-terminal`** (the session's terminal image: ttyd, tmux, CLI, Go 1.26, `migrate-agent`). All with **scan on push**, so ECR checks each image for known vulnerabilities.

- **No `session-worker` repo:** generated code is built inside the terminal, not as an image (4.18).
- **Tag every image with the commit SHA**, never `latest`, so any release can be rolled back.
- **Build `linux/amd64`** on an amd64 runner. Only arm64 has been built so far, and emulating amd64 on a Mac is slow.
- The terminal image carries a **pre-populated Go module cache**, so the first build isn't a cold download (4.17).

### Stack 5 — `CamundaHostStack` (T-10, T-11, T-12, T-19, T-20)
**Purpose:** the windowless back office running the shared demo Camunda.
> **Full runbook: [`CAMUNDA-DEPLOYMENT.md`](CAMUNDA-DEPLOYMENT.md)** — trimmed Compose, the nginx block, config tables, clients/roles, the local test gate and the Shinro credentials.


- **New EC2** in a **private** subnet, **no public IP**, `CamundaSg`, SSM role, encrypted gp3 (start at **100 GiB**).
- **Trim the Compose file first.** `camunda-full/docker-compose-full.yaml` runs the whole platform. The demo needs **`orchestration`, `elasticsearch`, `identity`, `keycloak`, `postgres`** plus the **OMS app**. Dropping `optimize`, `web-modeler` (+ its Postgres), `console`, `connectors` and `mailpit` saves several GB and removes four more things that can break. Size **after** trimming — `m7i.xlarge` (16 GiB) is plausible trimmed and tight untrimmed.
- **Ports** (4.16): expose **8080** (web + REST) and **26500** (gRPC) to the Shinro SG only. Keep **9600**, **9200**, **18080**, **8084** and **8090** unreachable from outside the instance.
- **`CamundaSg` correction:** the plan previously said "Operate port + 26500". In 8.8 that is **8080 + 26500** — one web port, not several.

**Config that must change from the local setup** (all in `assets/camunda-bundle/`):

| Setting | Local | Deployed | Why |
|---|---|---|---|
| `server.forward-headers-strategy` | `none` | **`native`** (or `framework`) | Behind nginx-terminated TLS, `none` makes Camunda build `http://` redirect URIs and login fails (gotcha 5.32) |
| `HOST` | `localhost` | `demo-camunda-instance.shinro.ai` | Browser-facing URLs |
| `KEYCLOAK_HOST` | `host.docker.internal` | `keycloak` | Container-to-container; the compose service name |
| `camunda.operate.identity.redirectRootUrl` | `http://localhost:8088/operate` | `https://demo-camunda-instance.shinro.ai/operate` | Same for `tasklist` |
| `CAMUNDA_SECURITY_AUTHENTICATION_OIDC_REDIRECTURI` | `http://localhost:8088/sso-callback` | `https://demo-camunda-instance.shinro.ai/sso-callback` | Must match what the IdP has registered |
| Keycloak admin | `admin/admin` | generated → Secrets Manager | The `.env` warns about this itself |
| All demo client secrets (`secret`, `demo-*-secret`) | literals in `.env` | generated → Secrets Manager | Rendered at boot by `render-env.sh` |
| `initialization.defaultRoles.admin.clients` | `[orchestration]` | **no demo client** | Granting admin to the client Shinro authenticates as is gotcha 5.31 |
| Shinro / OMS client | `orchestration` + `secret` | **`shinro-assessment`**, read-only | Same reason |

- **OIDC provider:** Keycloak stays, per decision 4.20. Camunda's `CAMUNDA_SECURITY_AUTHENTICATION_OIDC_*` properties are generic, so pointing them at Cognito is *configurable* — but the `aud` check makes it unlikely to work (5.33). Instead, add **Cognito as an identity provider inside the `camunda-platform` realm** so the user's existing Cognito session logs them into Camunda silently.
- **Seeding (T-15):** a one-time script deploying the demo BPMN with an **admin** credential demo users never receive. **Seed the OMS app's one BPMN only** — T-15 lists OMS + banking, but banking was removed from the jetson cluster on 2026-11-04 and the demo shows only the OMS app (DEPLOYMENT gap). Seed what the demo shows.
- **Backups (T-19):** a **DLM** policy finding this disk by tag, daily snapshots, keep 7. These matter more than usual now, because the instance is **shared** — if one user corrupts it, every user is affected until it's restored.
- **Alarms (T-20):** CloudWatch agent `mem_used_percent` and `disk_used_percent`.
- **Health check:** a Route 53 health check **cannot reach a private IP**. Instead a scheduled job (a cron on the Shinro EC2, or a small Lambda in the VPC) calls Camunda's health URL and publishes a custom CloudWatch metric; the alarm watches that.
- **Publish the private IP** to SSM at `/shinro/live/camunda-private-ip`, read by the Shinro host at boot (loose coupling, 1.14).

### Stack 6 — `ShinroHostStack` (T-12, T-18)
**Purpose:** the front door, all the guards, and the main application.

- **New EC2** in a **public** subnet with an **EIP** (allocated separately, as in the old repo). SGs: `ShinroCfSg` + `ShinroPublicSg`.
- **Compose services:** `nginx` (also serving the **built UI** as static files — DEPLOYMENT decision 1), **one `oauth2-proxy` per stream**, `shinro-api`, `redis`, `tool-exec`. The compose file and the oauth2-proxy config are **templates rendered once per stream** at boot by `render-env.sh`, driven by the stream list in SSM. Never hand-maintain N copies.
- **Redis on a persistent volume** — a named volume on the EBS disk, not the container's own layer. It holds session leases **and** live CLI tokens (gotcha 5.29).
- **TLS certificate** for `demo-camunda-instance.shinro.ai` and `demo-temporal-ui.shinro.ai`: decision 4.5.
- **nginx configuration:**

| Listener | Host | Path | Does |
|---|---|---|---|
| `:80` | any | `/oauth2/*` | Check origin secret → the right stream's oauth2-proxy (chosen by `Host`) |
| `:80` | any | `/chat/*`, `/v2/*` | Check origin secret → `auth_request` → shinro-api |
| `:443` | `demo-camunda-instance.shinro.ai` | all | `auth_request` (temporal proxy) → Camunda private IP |
| `:443` | `demo-temporal-ui.shinro.ai` | all | `auth_request` (temporal proxy) → session lookup by email (4.7) → that user's NodePort, or the "start a migration" page |
| `:80` | any | `/assets/*`, `/login`, `/settings` | Check origin secret → the built UI's static files |
| internal (e.g. `:8000`) | — | **CLI routes only** | For terminal pods (`ShinroInternalSg`). Everything else on this listener → 404 |

  In every block: **remove and re-set** the `X-Auth-Request-*` headers (gotcha 5.7), and forward `Upgrade`/`Connection` for WebSockets. On `/v2/demo/terminal`, raise the idle timeouts (gotcha 5.27).
- **IAM role:** read `/shinro/live/*` parameters and the named secrets, pull from ECR, `eks:DescribeCluster`, plus an **EKS Access Entry** (created in Stack 7) granting the Kubernetes permissions the session controller needs. No `codebuild:StartBuild` (4.18).
- **Secrets:** per-stream client secrets and cookie secrets, LLM API keys ("our keys, our cost").

### Stack 7 — `EksStack` (T-28, T-30, T-31, T-32)
**Purpose:** the private rooms, one per user.

- **Module:** `aws-cdk-lib/aws-eks`, or `@aws-cdk/aws-eks-v2-alpha` which avoids the extra kubectl Lambda layer (gotcha 5.10).
- **Endpoint access PRIVATE:** the Kubernetes API is reachable only from inside the VPC. While building you may also allow PUBLIC access restricted to your office IP; otherwise run kubectl on the Shinro EC2 via Session Manager.
- **Managed node group** in private subnets, `m7i.large` (2 vCPU, 8 GiB), sized for about **20 sessions** (T-30's working figure), tuned by the load test (T-36). **Sizing (DEPLOYMENT):**

| Container | Requests | Limits |
|---|---|---|
| Terminal | 500m CPU, 1 GiB | 2 CPU, 3 GiB |
| Temporal | 100m CPU, 256 MiB | 1 CPU, 1 GiB |
| One session | 600m CPU, ~1.25 GiB | 3 CPU, 4 GiB |

  By memory requests that is about **5 sessions per node**, so 20 users need **4–5 nodes**. An estimate only: concurrent Go builds use far more than their requests. Set the final count from the load test.
- **Add-ons:** `vpc-cni` with `enableNetworkPolicy: "true"`, `coredns`, `kube-proxy`, and optionally the CloudWatch Observability add-on for Container Insights (T-33). **No Calico:** the in-VPC module proxy (4.17 option c) needs only IP-based rules, which `vpc-cni` handles.
- **Access entry:** the Shinro EC2 role → a custom **ClusterRole** covering only namespaces, deployments, services, quotas and network policies. **Not cluster-admin.** The session controller that uses it is **Shinro application code** (it exists today only as `LocalSessionController` for kind); this stack provides only the cluster role.
- **Firewall:** node SG allows the NodePort range from the Shinro SG only (T-31).
- **No reference namespace.** T-35 is deferred with `reference.shinro.ai` (decision 4.14).
- **What CDK does NOT do:** create per-user session namespaces. The **session controller** (application code in Shinro) creates and deletes them at runtime from `k8s/session-template/`. Each session gets:
  - a **namespace**
  - a **ResourceQuota** + **LimitRange** (CPU/RAM caps)
  - a **NetworkPolicy**: deny by default; pods may reach their own Temporal, DNS, the Shinro EC2's internal CLI listener, and the in-VPC Go module proxy (decision 4.17)
  - a **Temporal dev server** + a NodePort Service for UI (8233) and gRPC (7233). The UI needs **no path configuration**: nginx gives it a whole hostname, so it serves from the root as it does by default (decision 4.6). **Today the UI is cluster-only and accepts traffic only from the terminal** — the template must add the 8233 NodePort and allow it from the Shinro EC2
  - a **terminal container** (ttyd, tmux, the Shinro CLI, Go 1.26, `migrate-agent`) with its own NodePort for the API to reach ttyd (1.15). It builds and runs the generated code, so there is **no separate worker** (4.18). It carries the T-32 **securityContext**: non-root, no privilege escalation, CPU/RAM limits, and a read-only root filesystem **with writable `emptyDir` mounts** for the home directory and the Go build cache (gotcha 5.25)
  - **Template changes from kind:** `imagePullPolicy: Never` → `IfNotPresent` with ECR image names; `SHINRO_API_IP` set to the Shinro EC2's **private** IP (used both as the API endpoint and in the network rules)
  - **ephemeral-storage requests and limits** in the LimitRange — five retained chats, each with its own sample-app copy plus a Go module cache, fill a node disk quickly (gotcha 5.28)

Node-group configuration this forces: **`singleProcessOOMKill`** is a *kubelet* setting under cgroup v2, not a pod field, so it goes in the node group's launch template / kubelet extra args — not the session manifest (gotcha 5.30).

### ~~Stack 8 — `BuildStack` (T-34)~~ — **dropped** (decision 4.18)
The generated code is built and tested inside the user's terminal container by `migrate-agent`. T-34's concern — untrusted LLM-written code must not be built on the Shinro host — is still met, because the sandbox is not the Shinro host. Dropping it removes a stack, an ECR repo, an IAM permission and a polling loop.

### Stack 9 — `ObservabilityStack` (T-20, T-33)
- One log group per Compose service (including each oauth2-proxy), plus Container Insights.
- **Alarms:** Camunda disk/memory/health; Shinro disk/memory; EKS node capacity and disk pressure; session count against the cap of 20 (a custom metric from the API); failed session starts; **LLM spend per day** (sent to CloudWatch by the API); **AWS Budgets** cost alarm.
- Add **per-stream login failure** visibility: a metric filter on oauth2-proxy logs for repeated 403s tells you someone was added to the wrong pool (gotcha 5.18).
- An **SNS topic** emailing the team when an alarm fires.

## 3.4 Build order

Each step is independently deployable and testable. **Don't advance until the "proves" column is true.**

| # | Do | This proves | Rows |
|---|---|---|---|
| 0 | Settle the Part 4 decisions. `cdk bootstrap`. **App side (DEPLOYMENT Phase 1):** the four app blockers done — demo login and entry, LLM key and limits, EKS `SessionController`, hosting code changes — and PR #395 merged | The demo passes on kind with the real login, and `linux/amd64` images build | — |
| 1 | NetworkStack | The VPC exists; private subnets reach the internet via NAT | T-10, T-31 |
| 2 | IdentityStack with **one** stream (temporal): pool, Managed Login, SES, clients | A test user receives an OTP email and signs in on the Cognito page. `curl` obtains a client-credentials token | T-13 (superseded in part) |
| 2a | Run the 1.8 runbook for a test email | They get a code and log in. After `admin-disable-user`, they can't | — |
| 3 | RegistryStack + CamundaHostStack (trimmed Compose, Keycloak retained), and the OMS BPMN seeded | Camunda 8.8 starts privately on 8080/26500; a **`shinro-assessment`** Keycloak token is accepted; a demo user gets **403 on deploy/cancel/modify** (5.31); login works through nginx (5.32) | T-10, T-11, T-14, T-15, T-16 |
| 4 | ShinroHostStack: nginx (with the built UI) + **one** oauth2-proxy + API + Redis + tool-exec + the Camunda console route | `demo-camunda-instance.shinro.ai` logs in end to end | T-12, T-18 |
| 5 | EdgeStack | `temporal.shinro.ai` serves the public page; `/oauth2/start` logs in; `/chat`, `/v2` and the UI paths reach the app; a test user lands in a demo chat and connects to Camunda through the inventory scan | — |
| 6 | EksStack + the session template + session controller + the email→session lookup | Two users open the same `demo-temporal-ui.shinro.ai` and each see **their own** session. A hand-set `X-Auth-Request-Email` changes nothing. After the TTL the page becomes "start a migration". `dev.sh probe`-style checks: one session can't reach another, the Kubernetes API or the metadata service | T-28, T-29, T-30, T-31, T-32 |
| 6a | Terminal container in the session template + the `/v2/demo/terminal` relay + the internal CLI listener | "Run in terminal" opens a shell in **your** sandbox; a refresh reattaches; the one-time code can't be replayed; `go build` works; a pod reaches the CLI routes and **nothing else** on the API; `analyze` and `migrate-agent` both finish | — |
| ~~7~~ | ~~BuildStack~~ — **dropped** (4.18) | — | T-34 |
| 8 | ObservabilityStack + DLM + sandbox egress lock-down (the module proxy, 4.17) | Alarms fire when tested; a sandbox **can't** reach a random public HTTPS host, and Go builds still work | T-19, T-20, T-33 |
| 9 | **Add the second stream** via config — a group, a client and a proxy, **no new pool** | A stream-A-only user gets 403 on stream B; a user added to **both** groups reaches both | — |
| 10 | Load test with **20 concurrent users**: watch LLM spend, the run lock, refusals at the cap and node capacity. Tune quotas and node count; give the Camunda concurrency number to the backend team. Then one full run as a real user, and open the HubSpot form | The system holds at 20 users, and the app team's go-live checklist passes | T-17, T-36 |

**Two sequencing notes:**
- **Why steps 2 and 3 come first:** T-14 (Camunda accepting Cognito tokens) is marked "riskiest, test early." If it fails, the Camunda design changes — find out before building nginx, CloudFront and EKS around it.
- **Step 9 is not optional polish.** Building the second stream is what proves the stream list is really config-driven rather than one stream with hard-coded names. Do it before the design hardens.
- **Dropping `reference.shinro.ai` removed a milestone.** In the earlier plan the read-only reference migration was a complete, demonstrable product before EKS sessions worked. Now **step 6 — per-user sessions — is on the critical path to the first demo.** If that worries you, decision 4.14 covers bringing a simplified version back.

## 3.5 Runtime configuration (from the app team's DEPLOYMENT)

Non-secret values live in SSM under `/shinro/live/temporal/…` and secrets in Secrets Manager; `render-env.sh` writes them into the env file at boot (3.2). **Never** put the Camunda client secret or LLM keys in `.env` files, images or the repo.

**UI build values** — fixed at build time, so the UI is built per stream:

```env
VITE_API_URL=https://temporal.shinro.ai/v2
VITE_WS_URL=wss://temporal.shinro.ai/v2
```

**API values on the Shinro EC2.** The Camunda block is **corrected** from DEPLOYMENT, which still described Cognito for Camunda: per 4.20 and `CAMUNDA-DEPLOYMENT.md` §6, the token comes from **Keycloak** and the client is **`shinro-assessment`**.

```env
FRONTEND_URL=https://temporal.shinro.ai
COOKIE_SECURE=true

DEMO_CAMUNDA_DEPLOYMENT_MODE=self_managed
DEMO_CAMUNDA_AUTH_METHOD=oidc
DEMO_CAMUNDA_ZEEBE_ADDRESS=grpc://<camunda-private-ip>:26500
DEMO_CAMUNDA_REST_URL=http://<camunda-private-ip>:8080
DEMO_CAMUNDA_OPERATE_URL=http://<camunda-private-ip>:8080
DEMO_CAMUNDA_AUTH_URL=http://<camunda-private-ip>:18080/auth/realms/camunda-platform/protocol/openid-connect/token
DEMO_CAMUNDA_CLIENT_ID=shinro-assessment          # secret from Secrets Manager; audience orchestration-api

# Must be set or the demo has no target. Each session has its own Temporal.
DEMO_TEMPORAL_ADDRESS=temporal:7233
DEMO_TEMPORAL_UI_URL=https://demo-temporal-ui.shinro.ai

DEMO_SESSION_TTL_HOURS=48
DEMO_SESSION_MAX_ACTIVE=20
```

- Leave **`DEMO_TERMINAL_UPSTREAM` unset**: the session controller supplies each terminal's address.
- `<camunda-private-ip>` is read from SSM `/shinro/live/camunda-private-ip` (Stack 5).
- The demo catalog (`apps/api/etc/demo_catalog.yaml`) switches its secret references from `env:` to **`aws-sm:`**, so the Shinro EC2 role must be able to read those named secrets (Stack 6).

## 3.6 Releasing a new version

| What changed | How to release | Effect on users |
|---|---|---|
| API or tool-exec | Pull the new image (by SHA), then recreate **only** that service | Chats reconnect. Running terminals keep working |
| UI | Build and replace nginx's static files | Users refresh |
| Terminal image | Point the session template at the new tag | **New sessions only.** Never restart running terminals — that deletes the user's generated code (4.22) |
| Session template | Ship it in the API release | New sessions only |
| Camunda or EC2 hosts | Infra, after reading `cdk diff` | Editing UserData replaces the server (5.3). Plan downtime |

**Rollback:** redeploy the previous SHA for the API or UI. For a bad terminal image, point the template back at the old tag; sessions already on it end at their 48-hour TTL, or delete them. **Test a rollback once before go-live.**

## 3.7 Go-live checklist — the infra items

The app team owns the full list in their DEPLOYMENT. These need infra:

- [ ] A demo user gets from the HubSpot request through Cognito, the email code and login into the app.
- [ ] The Camunda password and client secret appear in no logs, images or chat messages.
- [ ] Expired sessions are deleted (namespace gone, Redis entry gone).
- [ ] Someone owns adding and removing demo users and watching the HubSpot queue (4.15).
- [ ] The LLM budget alarm, the session-count metric and the node-capacity alarm all fire in a test.
- [ ] Rollback has been tested once (3.6).

**Ownership, as agreed with the app team:** infra owns the network, hosts, Cognito, CloudFront/S3, ECR repos, the EKS cluster and its cluster role, Camunda, secrets and alarms. The app team owns the session controller, the session template's contents, the images, the UI build and the LLM limits.

---

# Part 4 — Decisions to make before coding

### 4.1 The hostname-to-stream rule — **adopt this**
**Every hostname belongs to exactly one stream, and that stream's oauth2-proxy guards it.**

This single rule is what makes per-stream pools workable. Without it you hit a dead end: a hostname serving two streams would need nginx to decide *which pool's login page* to show a visitor who arrives with no cookie — and it has no way to know.

Under the rule, `demo-camunda-instance.shinro.ai` and `demo-temporal-ui.shinro.ai` belong to the **temporal** stream. Record the mapping in `shinro:streams` (3.1) so it's enforced by config rather than memory.

### 4.2 Which Cognito pool? — **Resolved: one new demo pool, one group per stream**
- **The decision:** a single new pool `shinro-live-demo`, owned by CDK, with a **group per stream**. Users may belong to several.
- **Two questions, often conflated:**
  1. *New pool or the existing one?* **New.** Passwordless on the pool real Shinro customers use would change their login page and their bill. A separate demo pool removes that risk, and CDK owns it fully — so the "can't configure an imported pool" blocker disappears.
  2. *One pool or one per stream?* **One.** See the table in 1.7.
- **This contradicts T-13**, which says reuse the existing pool and create none. Get it agreed.
- **What one pool buys:** the passwordless configuration — six interlocking settings, the likeliest thing to get wrong — is done **once**, as are the branding, the domain prefix and deliverability testing (4.13). A prospect interested in two streams gets one account.
- **What it gives up:** with separate pools a stream-A token wouldn't validate at stream B's proxy; now `--allowed-group` is what stops it. Low consequence — sandboxes stay per-user, Camunda stays read-only.
- **It costs no extra containers:** `--allowed-group` is per instance, so there's one proxy per stream either way.
- **Set `RemovalPolicy.RETAIN`.** This one pool holds every demo customer (5.12).

### 4.3 What if a later stream needs its own Camunda or Temporal demo?
Today both demo consoles belong to the temporal stream. When another stream needs a shared demo environment, give it **its own hostname** (e.g. `demo-<thing>-instance.shinro.ai`) and list it under that stream's `consoles`. **Do not share one console hostname between two streams** — that breaks rule 4.1. If a genuinely shared environment is ever unavoidable, the fallback is to pick the proxy by inspecting which `_shinro_<stream>` cookie the browser presents, with a disambiguation page when none is present. It works, but it's fiddly; avoid it if you can.

### 4.4 Which hostnames go through CloudFront? — **Resolved, with the reason**
- **Stream subdomains → CloudFront.** They mix a cached public page with uncached logged-in paths, and splitting by path is exactly what CloudFront behaviours do.
- **The two demo consoles → A record straight to the EC2.** Every path is dynamic, they hold long-lived WebSocket and polling connections, and there's nothing to cache.
- **The reason it can't simply be "CloudFront for everything":** CloudFront behaviours match on **path, not host** (1.11). A console's root path `/` would fall into the default behaviour and be served from S3. Putting them on CloudFront would need a **second distribution** with its own aliases — workable, and it would remove the certificate problem in 4.5, but it adds a hop in front of the most latency-sensitive, longest-lived connections we have. **Revisit only if certificate renewal becomes painful.**

### 4.5 Which TLS certificate goes on the Shinro EC2?
nginx needs a certificate **and its private key** on disk for the two console hostnames, and normal ACM certificates can't provide one (gotcha 5.1).
- **certbot + Let's Encrypt** with the `certbot-dns-route53` plugin. certbot proves ownership by writing a temporary DNS record (the "DNS-01 challenge"), which requires the instance role to be allowed to edit the `shinro.ai` zone. Free, auto-renews every 60–90 days. **Recommended.** Get a wildcard `*.shinro.ai` so adding a console hostname later needs no certificate change.
- **ACM exportable certificates:** a newer ACM option where the key *can* be exported. Paid per certificate; check how renewal works.
- **An Application Load Balancer** in front (ACM works there). More cost, and it conflicts with T-18's "nginx is the only public entry."
- **Alarm on expiry regardless of choice.** An expired certificate takes both consoles down at once.

### 4.6 One hostname for every session, routed by who is logged in — **Resolved**

Each user's Temporal session is served at **`demo-temporal-ui.shinro.ai`** — no id, no path. nginx works out *which* session to show from the logged-in user's email (2.7). The Kubernetes namespace behind it is still created per user and still deleted after 2 days; only the **URL** changes.

**Why this beats `…/<id>`:**
- **The path-prefix problem disappears.** Under a prefix, the Temporal UI believes it lives at `/` and emits asset URLs like `/css/app.css`, which lose the id and leave you with a blank, unstyled page. Fixing that means finding and setting a public-path option on a version we haven't deployed yet, or rewriting response bodies with `sub_filter`. At the root of its own hostname, none of this exists.
- **There is no link to leak.** With an id in the URL, one pasted link is a real breach and an ownership check is the only thing preventing it. Ids escape through browser history, screen shares, support tickets and copy-paste. With identity routing there is simply nothing to paste: the only session nginx will route you to is your own.
- **It matches the product.** T-29 and T-30 say a user's later migrations **reuse the same session**, so a user only ever has one. An id in the URL would be addressing something there is only ever one of. Earlier runs stay visible *inside* that session's own Temporal UI, which is where anyone would look for them.
- **It is what T-18 already described** — nginx routing `temporal-ui` to "the logged-in user's session", and showing "Start a migration to see it here" otherwise. The path-based variant had drifted from the tracker; this returns to it.
- **Simpler DNS and certificates:** one A record, one name on the certificate, no wildcard DNS.

**What we give up:** you cannot link to a specific session, so a support engineer can't be handed a URL. They use `kubectl` against the user's namespace instead. For a demo, that's the right trade.

**Rejected:** a subdomain per session (`<id>.demo-temporal-ui.shinro.ai`) also avoids the prefix problem, but it needs wildcard DNS and puts the id back in the URL for no gain.

**Ids don't disappear — they stop being public.** The session keeps an internal id for the namespace name and the Redis key. It just never reaches a browser.

### 4.7 How does nginx find a user's session?
- **Resolved: ask shinro-api on every request**, keyed by the email from oauth2-proxy (2.7, step 4). The API looks up the user's lease in Redis and returns the NodePort address, or nothing if there is no live session.
- **Why not T-29's map file plus `nginx -s reload`:** letting the API container reload nginx means giving it the **Docker socket**, which is effectively **root on the host** — sitting right next to tool-exec, which runs LLM-generated code. Per-request lookup also never goes stale: when the namespace is deleted at the 2-day TTL, the next request simply gets no address back.
- **The nginx nuance:** only **one `auth_request` is allowed per `location`**, and we need two questions answered in order (who are you, then where is your session). Two workable ways:
  - **The internal-jump idiom** — pure nginx, no extra modules:
    ```nginx
    location / {
        auth_request /oauth2/auth;                                   # Q1: who?
        auth_request_set $user $upstream_http_x_auth_request_email;
        error_page 418 = @session;  return 418;                      # jump, keeping $user
    }
    location @session {
        auth_request /session-lookup;                                # Q2: where?
        auth_request_set $up $upstream_http_x_session_upstream;
        proxy_pass http://$up;
    }
    ```
    `/session-lookup` is an internal location proxying to shinro-api with `proxy_set_header X-User $user;`.
  - **njs**, nginx's JavaScript module: make the lookup sub-request in a few lines of JS. Easier to read, one more component to install and keep patched.
- **Cost:** one extra internal request per page load. Negligible, and cacheable in nginx for a few seconds if it ever shows up in a profile.

### 4.8 Which node IP does the API return?
A NodePort answers on *any* node, but nodes come and go as the group scales. Don't freeze one node's IP at session creation. Have the API return a **currently healthy** node's address each time it's asked — which the lookup design in 4.7 makes easy, since it resolves on every request.

**Exception — the terminal Service (DEPLOYMENT gap).** It uses `externalTrafficPolicy: Local`, so the pod sees the API's real source IP and the NetworkPolicy can match it. The side effect: **only the node running the pod answers** on that NodePort. For the terminal, the API must return **the pod's own node**, not any healthy one. The Temporal UI/gRPC Service can keep the default and follow the rule above.

### 4.9 Warm pool or not? (T-30 is undecided)
A **warm pool** is a few empty sessions created in advance so nobody waits. **Recommendation: start without one.** Measure startup in the load test (T-36) and add one only if needed — code generation already takes about a minute, which hides most of the startup. *(Confirmed in 4.19.)*

### 4.10 Which build technology? (T-34 says "decide")
**Moot** — no images are built per migration (4.18).

### 4.11 How is the shared Camunda kept read-only? (T-14 vs T-16) — **more urgent now**
- **The problem:** T-14 says browser access is gated by oauth2-proxy, not Camunda. But oauth2-proxy only does **authentication** (1.6). Once a user is through, what does Operate think they may do?
- **Why it's more urgent than before:** the instance is **shared across every user of the stream**. A user who can deploy or cancel a workflow doesn't just break their own demo — they break the next prospect's, live.
- **The local stack answers this.** `camunda-full` already runs with `camunda.security.authorizations.enabled: true` and `RESOURCE_AUTHORIZATIONS_ENABLED=true`, so **8.8 has built-in resource authorizations** — roles with read/write permissions per resource. That is a far better instrument than anything at the proxy layer.
- **Resolved: (a).** Define a **demo role with read permissions only** and assign demo users to it. Do **not** give them the `admin` role that `initialization.defaultRoles` grants to `demo` locally. oauth2-proxy stays in front as the outer gate.
- **Rejected (b):** nginx blocking write URLs by path and method. Operate uses `POST` for *searches*, so "GET only" breaks the UI.
- **Rejected (c):** one fixed read-only identity injected by nginx — hard to do with OIDC, and it erases per-user audit.
- **The two-logins problem that used to make (a) unattractive is solved by 4.20**: federate Keycloak to Cognito and the second login is silent.
- Still a **release blocker**: verify in build step 3 that a demo user gets 403 on deploy, cancel and modify against the *shared* instance.

### 4.12 Setting expectations on the request form
Access is granted by a human, so the gap between "Request a demo" and "you can sign in" is however long it takes someone to act. Decide and then **say it on the page**: "within one business day" is honest and manageable. Also decide who watches the HubSpot queue, and add a notification so requests don't sit over a weekend.

### 4.13 OTP email deliverability
If the code lands in spam the user simply "can't log in." Send from `no-reply@shinro.ai` with **DKIM + SPF + DMARC** on `shinro.ai`, and test against Gmail and Outlook. Corporate mail filters can delay delivery, and codes expire in minutes, so say so on the branded login page. With one shared pool (4.2) this is configured and tested **once** rather than per stream — a main reason for consolidating.

### 4.14 What replaces `reference.shinro.ai`? (T-35 deferred)
Dropping it is fine, but note what it was doing: it gave every user something to look at that didn't depend on EKS sessions working. Two consequences:
- The first demo now needs the full session machinery (build step 6).
- Consider whether the chat app should show a **recorded or static walkthrough** of a completed migration while a user's own session is being prepared. That's an app decision, not infrastructure, but it covers the same gap for much less work.
If T-35 comes back later, it's a long-lived namespace plus one more hostname under the temporal stream's `consoles` list — the design accommodates it without rework.

### 4.15 Who offboards users?
With no automation, nobody removes anyone unless it's someone's job. Agree on: who holds `shinro-live-user-admin`, where additions are recorded, and **when access ends** — a fixed trial length, removal when the HubSpot deal closes or is lost, or a monthly review of `aws cognito-idp list-users --user-pool-id <pool>` per stream.

### 4.16 Camunda version and ports — **Resolved from `camunda-full`**
**Camunda 8.8.32**, consolidated mode. The real values, to live in **one** CDK config object so nothing is hard-coded twice:

| Port | Serves | Exposure |
|---|---|---|
| **8080** (container) | Operate `/operate`, Tasklist `/tasklist`, REST `/v2/...`, login `/sso-callback` | nginx → Shinro SG only |
| **26500** | Zeebe gRPC | Shinro SG only |
| 9600 | Management / health / metrics | Instance-local (used by the health checker) |
| 9200 | Elasticsearch | Never (T-12) |
| 18080 | Keycloak (`camunda-platform` realm) | Instance-local + Shinro SG for token calls |
| 8084 | Identity | Instance-local |
| 8090 | OMS job-worker app | Instance-local |

The local `8088` is a **host port mapping** of container 8080, not a Camunda port — don't carry it into deployment. Other versions: Elasticsearch 8.17.10, Keycloak `quay-26.6.4`, Identity/Connectors 8.8.15.

### 4.20 Which IdP does *Camunda* trust — Keycloak or Cognito? — **Resolved: Keycloak, no federation**
Distinct from 4.2, which is about *our* users. This is about the token Camunda itself validates.
- **Keep the bundled Keycloak.** It already works in `camunda-full`, which turns T-14 from "riskiest step, spike first" into a configuration change. The containers are ones you are already running, so it costs nothing new.
- **Cognito is unlikely to work** for this: Camunda validates `aud` against `orchestration-api`, and Cognito access tokens carry `client_id` and `scope` but no settable `aud` (gotcha 5.33). Verify against your pool before ruling it in or out.
- **Federation was considered and dropped.** Adding Cognito as an identity provider inside the realm would make the second login invisible, but it costs a Cognito app client, an IdP config, an attribute mapper, a default-IdP redirector and a Camunda mapping rule — and removes **none** of the risky unknowns. **Decided: two gates, no federation.** oauth2-proxy decides *who gets in*; a shared `demo` account with a **read-only** role decides *what they can do*. The prospect logs in twice; print the credentials beside the link.
- **Non-negotiable:** keep oauth2-proxy in front. The instance is shared, so without the Cognito gate anyone who finds the hostname can break every prospect's demo at once.
- **Note what this does *not* fix:** the browser must still reach Keycloak (the front channel). That is a network-reachability problem, independent of who logs in — see the runbook.
- **Consequence for Stack 3:** the Cognito `camunda` resource server and `camunda-assessment` client are not built. The assessment tool uses a Keycloak client instead.
- **Consequence for operations:** Keycloak's Postgres now holds state worth keeping, so it rides the same DLM snapshots as Elasticsearch (Stack 5).

### 4.17 Egress for Go modules — **Resolved: (c), an in-VPC module proxy** (DEPLOYMENT decision 4)
T-32 says the sandbox gets **egress only to its own Temporal**. The terminal needs **public HTTPS** to fetch Go modules. Both can't be true. Note that a *user* now has an interactive shell in that pod, so "allow all outbound HTTPS" means they can fetch — or send — anything.
- **(a) Allow all outbound HTTPS.** Simplest, weakest, and every `go mod download` crosses the NAT at per-GB cost.
- **(b) Allow only Go module hosts by name** (`proxy.golang.org`, `sum.golang.org`). Basic NetworkPolicy matches IPs and pod selectors, **not DNS names** — which is exactly why the design says **Calico**. This supersedes the earlier claim in 1.12 that the VPC CNI is sufficient: it is, until you need FQDN rules.
- **(c) Run a module proxy inside the VPC** (Athens, or an S3-backed `GOPROXY`) and allow egress *only to it*. Tightest, fastest after the first warm-up, no NAT cost per build, and it keeps deny-by-default intact. **Recommended**, with (b) as the fallback.
- Whichever you pick, pre-populate the module cache in the terminal image so a first `go build` isn't a cold download.
- **Decision:** (c). Block all other outbound traffic from the sandbox. Because (c) needs only an IP rule, **Calico is not needed** and Stack 7 keeps `vpc-cni` (DEPLOYMENT gap). Where the proxy runs (a small EC2, or a Deployment in its own namespace) is still to be chosen — it must sit outside every session namespace.

### 4.18 Where does generated code get built — CodeBuild or the sandbox? — **Resolved: the sandbox** (DEPLOYMENT decision 3)
Two designs now describe the same job. **T-34 / Stack 8:** zip the generated project, build it in CodeBuild, push to ECR, start a worker pod. **The terminal design:** the user already has Go and a Temporal dev server in their own sandbox, so the code can be built and run right there.
- They are not complementary; running both means maintaining two paths.
- The sandbox route is simpler and much faster to iterate (no image push/pull per change), and the isolation argument behind T-34 — don't build untrusted code on the Shinro host — is satisfied either way, because the sandbox isn't the Shinro host.
- CodeBuild still wins if you need a **reproducible artifact** per migration, or if the worker must outlive the terminal.
- **Decision:** the sandbox. `migrate-agent` already builds and tests the code in the user's terminal container, so **Stack 8 is dropped** along with the `session-worker` ECR repo, `codebuild:StartBuild` and the polling loop. Accepted cost: no reproducible per-migration artifact, and the code lives only as long as the pod (4.22).

### 4.19 Warm pool — reconsidered — **Resolved: no warm pool at launch** (DEPLOYMENT decision 7)
4.9 said start without one. The terminal image carries the Go toolchain and the CLI; the estimate was 1–2 GB, but it measures **590 MB unpacked** on arm64. **Decision:** start without a warm pool. If the first session on a node is slow, **pre-pull the image with a DaemonSet** before reaching for a warm pool. Re-measure on amd64.

### 4.21 How does the API trust oauth2-proxy? — **Resolved** (DEPLOYMENT decision 6)
shinro-api today authenticates with its own `shinro_auth` cookie. Behind oauth2-proxy, it must instead **create the Shinro session from the identity headers nginx sets** (`X-Auth-Request-Email`), and **never accept those headers from anywhere but nginx**. nginx strips and re-sets them on every block (5.7). The API should also reject requests that reach it other than through nginx — bind it to the Compose network, not a host port.

### 4.22 Is a user's generated code kept if their pod is replaced? — **Resolved: no, accept it for launch** (DEPLOYMENT decision 9)
The code lives in `emptyDir` in the terminal pod. If the pod is replaced — a node is drained, or the image is changed under it — the code is gone. **Rule:** never restart running terminals to roll out a new image; point the template at the new tag so **new sessions only** pick it up, and let old ones end at their TTL. Persistence (a PVC per session) can come later if users complain.

---

# Part 5 — Gotchas: what goes wrong, why, and what to do

### 5.1 ACM certificates can't normally go on EC2
- **Symptom:** you create an ACM certificate for `demo-camunda-instance.shinro.ai` and find no way to give it to nginx.
- **Why:** a standard ACM certificate's private key never leaves AWS; it can only be attached to AWS services.
- **Fix:** certbot with the Route 53 plugin (recommended), ACM exportable certificates, or a load balancer. Decision 4.5.

### 5.2 The wildcard DNS record silently swallows deleted records
- **Symptom:** someone deletes the `demo-camunda-instance` A record. The hostname still resolves — now via `*.shinro.ai` to CloudFront — and the user sees a baffling S3 "403 Access Denied."
- **Why:** a specific record beats the wildcard; without it, the wildcard matches.
- **Fix:** manage every record in CDK so it can't drift. **If a console shows an S3 error, check DNS first.**

### 5.3 Editing UserData replaces the server
- **Symptom:** you add one line to the boot script, run `cdk deploy`, and CloudFormation **deletes and recreates** the EC2. Camunda's data is gone and private IPs change.
- **Why:** UserData only runs on first boot, so a change can only be applied by replacement.
- **Fix:** keep UserData minimal; put everything changeable in the **S3 bundle** and push updates with **SSM Run Command**. **Always read `cdk diff` for "replacement."** This is why the Camunda DLM backups exist.

### 5.4 Allocate the Elastic IP before the instance
- **Symptom:** CDK reports a circular dependency.
- **Why:** CloudFront needs the server's hostname, and the server's config contains CloudFront values — each waits for the other.
- **Fix (the old repo's pattern):** create the EIP first, then CloudFront using it, then the server, and **associate** the EIP last.

### 5.5 The CloudFront prefix list eats security group rules
- **Symptom:** adding a rule to the CloudFront SG fails with "rules limit exceeded."
- **Why:** the prefix list counts as roughly 55 of the 60 allowed rules.
- **Fix:** keep the CloudFront rule in its own SG; use separate SGs for other ports.

### 5.6 The cookie domain covers every subdomain — which is the point, and a footgun
- **What it buys:** `--cookie-domain=.shinro.ai` means signing in on `temporal.shinro.ai` also signs you in at `demo-camunda-instance.shinro.ai`. No second login. This is essential to the design.
- **The side effect:** the browser sends that cookie to *every* `*.shinro.ai` host, including other streams' pages. They can't decrypt it (different cookie secret), but see 5.19 for the name collision this creates.

### 5.7 Identity header spoofing
- **Symptom:** a user sends `X-Auth-Request-Email: admin@shinro.ai` themselves and the app believes it.
- **Fix:** in nginx always **set** the header from the auth sub-request's answer (`proxy_set_header X-Auth-Request-Email $user;`). Never forward what the browser sent. Apps should trust these headers only from nginx.

### 5.8 Private subnets with no way out look like dead servers
- **Symptom:** the Camunda server "boots" but nothing works — it can't pull images and Session Manager can't connect.
- **Why:** without NAT or VPC endpoints, a private subnet can't reach Docker Hub, ECR or SSM.
- **Fix:** NAT (we have one) or VPC endpoints.

### 5.9 A private EKS endpoint means no kubectl from your laptop
**Fix:** run kubectl on the Shinro EC2 via Session Manager, or temporarily allow your IP on a public endpoint while building.

### 5.10 CDK's EKS module needs a matching kubectl layer
`aws-cdk-lib/aws-eks` needs a **kubectl Lambda layer** package (`@aws-cdk/lambda-layer-kubectl-v3x`) matching your Kubernetes version. The `aws-eks-v2-alpha` module avoids it. Pin versions either way.

### 5.11 Renaming a Cognito app client in CDK recreates it
- **Symptom:** you rename a construct ID; CDK deletes the old client and creates a new one with a different id and secret, and every consumer breaks until it re-reads them.
- **Fix:** treat app client construct IDs as permanent. Never rename them.

### 5.12 Deleting the pool deletes every demo customer
No undo, no export. With one shared pool (4.2) the blast radius is now **every demo user across every stream**, so `RemovalPolicy.RETAIN` matters more, not less, and `cdk destroy` on IdentityStack deserves care. The upside: removing a stream from `shinro:streams` now deletes a *group*, not people — strictly safer than the pool-per-stream design.

### 5.13 Same AWS account as the old stack
Use `live` naming everywhere (3.1), unique Cognito domain prefixes, and a distinct `Project` tag so cost reports separate the two.

### 5.14 Region
CloudFront's certificate must be in `us-east-1`. Keep **everything** in us-east-1 to avoid cross-region references. The old repo enforces this in `bin/` with an error; do the same.

### 5.15 Passwordless users and the `FORCE_CHANGE_PASSWORD` state
- **Risk:** `admin-create-user` without a password leaves the user in `FORCE_CHANGE_PASSWORD` ("must set a password at first login"), and email-OTP sign-in may not work from that state.
- **What to do:** test it with one user in build step 2a. If OTP fails, add runbook step 2 (`admin-set-user-password --permanent` with a long random password nobody knows), which moves them to `CONFIRMED` while they still only ever use the code.

### 5.16 Cost of passwordless, multiplied by pools
Essentials is billed per **MAU** (monthly active user) per pool, SES per email (fractions of a cent). With one shared demo pool a person active in two streams is **one** MAU, not two, and there is one line item rather than N. Negligible at demo scale — still check the first bill.

### 5.17 OTP spam
Anyone can type a known customer's email on the right stream page and trigger a code to their inbox. They can't get in without the inbox, but they can annoy. Cognito rate-limits per user. The Plus plan's threat protection is optional and unnecessary for a demo.

### 5.18 The wrong group — and why it is now survivable
- **Symptom:** a customer who asked for stream A was put in stream B's group. They get a code, sign in to Cognito fine, then hit **403** from oauth2-proxy.
- **Why that is good news:** under the earlier pool-per-stream design the same mistake produced **no code at all** — indistinguishable from broken email. Now it is a specific error at a known place.
- **Still easy to do:** the only link between the request and the group is the stream field on the HubSpot form plus a human reading it.
- **Fix:** `add-demo-user.sh <stream> <email>` validates the stream against the configured list and fails on an unknown name. On a 403 report, `aws cognito-idp admin-list-groups-for-user` answers it in seconds. Alarm on repeated oauth2-proxy 403s (Stack 9) — a burst usually means a mis-onboarded customer, not an attack.

### 5.19 Cookie name collisions between streams
- **Symptom:** a user signed into two streams gets randomly logged out of one, or bounced into a redirect loop.
- **Why:** every oauth2-proxy sets its cookie on `.shinro.ai`. If they all use the default name `_oauth2_proxy`, each overwrites the others.
- **Fix:** **a distinct `--cookie-name` per stream**, e.g. `_shinro_temporal`. Generate it from the stream name in the config template so it can't be forgotten.

### 5.20 With identity routing, the email header *is* the access control
- **Why this matters more than it looks:** dropping the id from the URL removed one risk and concentrated another. The **only** thing deciding which session you see is `X-Auth-Request-Email`. That makes gotcha 5.7 load-bearing rather than merely good practice: if any nginx block forwarded a browser-supplied `X-Auth-Request-Email`, a user could read someone else's session by setting one header.
- **Fix:** nginx always sets that header from the auth sub-request's answer, and the session lookup uses nginx's own variable, never anything from the incoming request.
- **Test it explicitly in build step 6:** `curl -H 'X-Auth-Request-Email: someone-else@x.com'` against `demo-temporal-ui.shinro.ai` must still land you on your own session.

### 5.21 A session can vanish while the user is looking at it
- **Symptom:** after two days — or after a manual cleanup — an open Temporal UI tab goes blank, or nginx starts returning `502`.
- **Why:** the namespace was deleted, so the pod behind that NodePort is gone and any open connections drop mid-flight. The TTL doesn't care that someone is mid-click.
- **Fix:** treat "no session" and "backend gone" as the same friendly state. When the API returns no address, serve the "Start a migration to see it here" page (T-18); add `proxy_intercept_errors` with a custom page for 502 and 504 so an expiry mid-session reads as "your demo session has ended" rather than as a crash.
- Also decide whether the app should warn the user as the TTL approaches. That's an app change, not infrastructure, but it's the difference between an expiry feeling deliberate and feeling broken.

### 5.22 CloudFront caching an authenticated page
- **Symptom:** one user sees another user's chat page, or a logged-out visitor sees logged-in content.
- **Why:** a behaviour for `/chat/*` or `/v2/*` left with default caching, so CloudFront stores and re-serves a personalised response.
- **Fix:** caching **disabled** and all cookies, headers and query strings forwarded on `/chat/*`, `/v2/*` and `/oauth2/*`. Verify with `curl -I` that responses carry `Cache-Control: no-store` and `X-Cache: Miss from cloudfront`. **Test this deliberately**, with two browsers, before go-live.

### 5.23 Callback URLs must list every console hostname
- **Symptom:** login works on `temporal.shinro.ai` but fails on `demo-camunda-instance.shinro.ai` with a Cognito error about an invalid `redirect_uri`.
- **Why:** callback URLs can't use wildcards (1.7), and each hostname oauth2-proxy might start a login from needs its own entry.
- **Fix:** build the callback list from the stream's `subdomain` plus every entry in its `consoles` list, in code, so adding a hostname updates Cognito automatically.

### 5.24 Adding a stream touches more than CDK
A new stream needs: the config entry, a deploy, an S3 folder with the stream's page, a HubSpot form (or a new value for the stream field), someone told to watch that queue, **a second allowed `Origin` in the API** (`_origin_allowed` checks a single `FRONTEND_URL` today, which is enough for `temporal.shinro.ai` alone), and a test that a user from another stream can't get in. Write it down as a checklist the first time you do it (build step 9), while it's fresh.

### 5.25 A read-only root filesystem and an interactive shell don't mix
- **Symptom:** the terminal opens, then everything fails — `go build` can't write, the CLI can't create `~/chats/<id>/`, even shell history errors.
- **Why:** T-32's `readOnlyRootFilesystem: true` was written for a non-interactive worker. A shell needs to write.
- **Fix:** keep the root filesystem read-only and mount writable **`emptyDir`** volumes at the home directory, the Go build cache and `/tmp`. You keep most of the hardening and the shell still works. Size them (5.28).

### 5.26 The first session of the day is slow
- **Symptom:** "Run in terminal" hangs for a minute on a node that hasn't run one before.
- **Why:** a large image pull (590 MB unpacked on arm64; re-measure on amd64). Every new node repeats it.
- **Fix:** pre-pull via DaemonSet, or a warm pool (4.19). Either way, show progress in the UI — a silent minute reads as broken.

### 5.27 WebSocket timeouts will drop terminals
- **Symptom:** an idle terminal disconnects after a few minutes; a long `go build` dies mid-output.
- **Why:** there are three idle timeouts in the path — CloudFront, nginx `proxy_read_timeout`, and the API's own. The default nginx value is 60s.
- **Fix:** raise `proxy_read_timeout`/`proxy_send_timeout` on `/v2/demo/terminal` as the old repo already does for the chat stream, and send WebSocket pings. **Test through CloudFront**, not only against nginx directly — CloudFront's idle timeout is separate. tmux means a drop isn't fatal, but a reconnect that loses scrollback still feels broken.

### 5.28 The sandbox disk fills quietly
- **Symptom:** pods get evicted, or a node goes `DiskPressure` and takes *other users'* sessions with it.
- **Why:** five retained chats, each with its own sample-app copy, plus a Go module and build cache, all on node ephemeral storage with no limit.
- **Fix:** set `ephemeral-storage` requests **and limits** in the LimitRange so a runaway session is evicted alone rather than poisoning the node.

### 5.29 Losing Redis now also loses token revocation
- Redis holds the session leases **and** the live CLI tokens. If the Shinro host is replaced (gotcha 5.3), you lose the ability to revoke, and issued tokens keep working until they expire — up to 2 hours.
- **Fix:** keep Redis on a **persistent volume** so a container restart doesn't lose it (Stack 6). For a full host replacement, the same fix as the lease problem — make the sandbox self-describing with namespace labels — plus keep the token TTL short, since the TTL becomes your only backstop.

### 5.30 `singleProcessOOMKill` is a node setting, not a pod setting
- It is a **kubelet** option under cgroup v2, configured in the node group's launch template or kubelet extra args. Putting it in the session manifest does nothing, silently.
- **Why it matters:** without it, one runaway command in a terminal — such as a test run by `migrate-agent` — can OOM the whole container and take down the user's whole terminal.

### 5.31 The demo is authenticating as Camunda's admin client
- **Symptom:** a "read-only" demo instance where the assessment tool can deploy, cancel and delete anything.
- **Why:** `camunda-full` authenticates Shinro *and* the OMS app as client **`orchestration`** with secret `secret`, and `.orchestration/application.yaml` grants that client the **admin** role via `initialization.defaultRoles.admin.clients: [orchestration]`. Harmless locally, directly against T-16 on a **shared** instance.
- **Fix:** a separate client — `shinro-assessment` — with read-only permissions, not listed under `defaultRoles.admin`. Change the OMS app's client too; it carries the same secret today. Treat "the demo client is not an admin" as a step-3 test, not an assumption.

### 5.32 `forward-headers-strategy: none` breaks login behind nginx
- **Symptom:** Camunda login fails with a redirect-URI mismatch, or bounces back to the login page forever.
- **Why:** `.orchestration/application.yaml` sets `server.forward-headers-strategy: none`. nginx terminates TLS (1.2), so Camunda never learns the request was HTTPS and builds `http://demo-camunda-instance.shinro.ai/sso-callback` — which does not match the registered URI.
- **Fix:** set it to **`native`** (or `framework`) and have nginx send `X-Forwarded-Proto: https`, exactly as the old repo's template already does.
- **This is the same class of bug in a third place** — the old repo hit it with HyperDX, oauth2-proxy hits it behind CloudFront, and Camunda hits it behind nginx. Whenever something terminates TLS in front of an app that builds its own redirect URLs, check this first.

### 5.33 Cognito access tokens have no settable `aud`
- **Symptom:** if you point Camunda's OIDC config at Cognito, token validation rejects every call.
- **Why:** `CAMUNDA_SECURITY_AUTHENTICATION_OIDC_AUDIENCES_*` is checked against the token's `aud` claim. Cognito access tokens carry `client_id` and `scope`; the ID token carries `aud`, but the API path uses the access token.
- **Fix:** keep Keycloak (4.20). **Verify this against your own pool before committing either way** — a pre-token-generation Lambda may be able to add claims, but don't plan on it until you have seen a working token.

---

# Part 6 — Glossary (A–Z)

| Term | Short meaning | See |
|---|---|---|
| A record | DNS: name → IPv4 address | 1.1 |
| Access entry (EKS) | Connects an IAM role to Kubernetes permissions | 1.12 |
| Access token | Token used to call an API | 1.6 |
| ACM | AWS's certificate service; keys can't normally be exported | 1.2, 5.1 |
| Add-on (EKS) | AWS-managed cluster components | 1.12 |
| Alias (CloudFront) | A hostname a distribution answers for | 1.11 |
| Alias record (Route 53) | DNS record pointing at an AWS resource | 1.1 |
| App client | An app's registration with a Cognito pool | 1.7 |
| auth_request | nginx asking another service "allow this?" | 1.9 |
| Authentication / Authorization | Who you are / what you may do | 1.6 |
| Authorization Code flow | Browser login: code + client secret → tokens | 1.6 |
| AZ (Availability Zone) | A separate data centre in a region | 1.3 |
| Behaviour (CloudFront) | Path-based routing and cache rule. **Path, never host** | 1.11 |
| BPMN / DMN | Workflow and decision diagram formats | 1.12 |
| Callback / redirect URL | Where Cognito returns the browser. No wildcards | 1.6, 5.23 |
| CDK / App / Stack / Construct | Infrastructure as TypeScript → CloudFormation | 1.14 |
| `cdk bootstrap` / `synth` / `diff` / `deploy` | Set up once / generate / preview / apply | 1.14 |
| Certificate / private key / CA | Public ID card / its secret / the trusted signer | 1.2 |
| Choice-based auth (`USER_AUTH`) | Cognito sign-in by OTP or passkey instead of password | 1.7 |
| CLI token | Short-lived credential (`demo-cli`, ≤2h) letting the CLI act as the user | 1.15 |
| Claim | A field inside a token | 1.6 |
| Consolidated mode | Camunda 8.8 running Zeebe, Operate and Tasklist in one container | 1.12, 4.16 |
| `forward-headers-strategy` | Spring setting; must be `native` behind TLS-terminating nginx | 5.32 |
| Client Credentials flow | Machine-to-machine token, no user | 1.6 |
| CloudFormation | AWS's infrastructure-as-code engine | 1.14 |
| CloudFront / Distribution / Origin | CDN / its config / where it fetches from | 1.11 |
| CloudFront Function | Small edge script rewriting requests | 1.11 |
| CloudWatch / agent / Container Insights | Monitoring / host metrics / k8s metrics | 1.13 |
| ClusterRole / RBAC | Kubernetes' own permissions | 1.12 |
| CodeBuild | Managed isolated build machines — not used (4.18) | 1.13 |
| Cognito user pool | User directory + identity provider. **One per stream** | 1.7 |
| Container / Image / Compose | Running app / packaged app / multi-container file | 1.4 |
| Control plane | The Kubernetes brain, run by AWS | 1.12 |
| Conversation id (`convid`) | Identifies one chat in the app: `/chat/<convid>` | 2.4 |
| Cookie / cookie domain / cookie name | Browser-stored note / which hosts get it / **must differ per stream** | 1.1, 5.19 |
| Cross-stack reference / Export | Sharing values between stacks; can lock you in | 1.14 |
| Deployment / Pod / Service | Keep N pods / container group / stable address | 1.12 |
| DKIM / SPF / DMARC | DNS records keeping your email out of spam | 1.7 |
| DLM | Scheduled EBS snapshots | 1.13 |
| DNS | Name → IP phone book | 1.1 |
| EBS / gp3 / snapshot | Server disk / SSD type / disk backup | 1.4 |
| EC2 / instance type | Virtual server / its size | 1.4 |
| ECR | Private Docker image registry | 1.4 |
| EKS | AWS-managed Kubernetes | 1.12 |
| Elastic IP (EIP) | A reserved, stable public IP | 1.1 |
| Elasticsearch | Search DB behind Camunda Operate; never exposed | 1.12 |
| Email OTP | One-time login code sent by email | 1.7 |
| Essentials / Lite / Plus | Cognito price tiers; passwordless needs Essentials+ | 1.7 |
| `fromLookup` / `fromXxx` | Import an existing resource read-only | 1.14 |
| GOPROXY / module proxy | An in-VPC cache of Go modules, so sandboxes need no public egress | 4.17 |
| gRPC | Fast program-to-program protocol | 1.1 |
| Hosted zone | All DNS records for one domain | 1.13 |
| HTTP / HTTPS / status codes | Web protocol / encrypted / short answers | 1.1 |
| HubSpot | Our sales CRM; hosts the request-a-demo form | 1.8 |
| IAM / role / policy / instance role | AWS permissions system | 1.5 |
| ID token | Token describing the user | 1.6 |
| Idempotent | Doing it twice has the same effect as once | 1.8, 2.6 |
| IdP / Authorization server | Who issues tokens | 1.6 |
| IMDSv2 | Hardened server metadata service | 1.4 |
| Identity (Camunda) | Camunda's own user/role service, fronting Keycloak | 1.12 |
| Issuer (`iss`) | URL identifying an IdP. **One pool = one issuer** | 1.6, 1.9 |
| Keycloak | The OIDC provider Camunda ships with; realm `camunda-platform` on 18080 | 1.12, 4.20 |
| JWT / JWKS | Signed token format / public keys to verify it | 1.6 |
| kubectl | Kubernetes command-line tool | 1.12 |
| Lease (session) | Reserving a session for a user | 2.6 |
| Managed Login | Cognito's newer login pages; required for passwordless | 1.7 |
| Manifest | YAML describing Kubernetes objects | 1.12 |
| Group (Cognito) | Label on users; **membership is the per-stream permission** | 1.7, 1.8 |
| MAU | Monthly active user — Cognito's billing unit, per pool | 1.7, 5.16 |
| NAT Gateway | Outbound-only internet for private subnets | 1.3 |
| Namespace (Kubernetes) | Isolated folder in a cluster; one per session | 1.12 |
| Namespace (Temporal) | Temporal's own grouping — a different thing | 1.12 |
| NetworkPolicy | Firewall between pods | 1.12 |
| nginx / reverse proxy / server block / location | Front-door web server / forwards on / per-host config / per-path config | 1.10 |
| Node / Node group | Kubernetes worker server / scalable set | 1.12 |
| One-time code | 60-second single-use string swapped for the CLI token inside the pod | 1.15 |
| NodePort | Port 30000–32767 open on every node | 1.12 |
| OAC | Lets only CloudFront read the private bucket | 1.11 |
| OAuth 2.0 / OIDC | Token protocol / identity layer on top | 1.6 |
| oauth2-proxy | Login guard for apps with no login. **One per stream** | 1.9 |
| OMS app | The demo job-worker application connected to Zeebe (port 8090) | 1.12 |
| Operate | Camunda's web console, at `/operate` on port 8080 in 8.8 | 1.12 |
| `orchestration` | The single Camunda 8.8 container (Zeebe + Operate + Tasklist + REST), and the name of its OIDC client | 1.12, 5.31 |
| `orchestration-api` | The audience Camunda requires in tokens | 1.12, 5.33 |
| Origin secret | Header proving a request came via our CloudFront | 1.11 |
| Port | Number selecting a program on a machine | 1.1 |
| Prefix list | Named set of IP ranges (e.g. all of CloudFront) | 1.3 |
| Private / public IP | Inside-only / internet-reachable address | 1.1 |
| Private / public subnet | Hidden / reachable part of the VPC | 1.3 |
| Redis | In-memory store: state, run lock, session leases | 1.4 |
| Refresh token | Long-lived token for renewing others | 1.6 |
| Removal policy (DESTROY / RETAIN) | What happens on stack deletion. **RETAIN the pools** | 1.14, 5.12 |
| Replacement | CloudFormation deleting and recreating a resource | 1.14, 5.3 |
| Resource server / Scope | API definition / permission name in a token | 1.6 |
| ResourceQuota / LimitRange | CPU/RAM caps per namespace / container | 1.12 |
| Route 53 | AWS DNS | 1.13 |
| Runbook | A written step-by-step procedure | 1.8 |
| S3 / bucket | File storage / a container for files | 1.11 |
| Secrets Manager | Safe for secrets | 1.13 |
| securityContext | Container safety settings | 1.12 |
| Security group (SG) | Per-server firewall; can reference other SGs | 1.3 |
| SES / sandbox / production access | AWS email / test-only mode / approved to send to anyone | 1.7 |
| Session controller | Shinro app code creating and deleting session namespaces | 2.6, Stack 7 |
| Session id | Internal id for the namespace, Redis key and image tag. **Never in a URL** | 2.6, 4.6 |
| Session lookup | nginx asking shinro-api "where is this user's session?" on every request | 2.7, 4.7 |
| SNI | Hostname announced at the start of TLS | 1.2 |
| SNS | Notifications (alarm emails) | 1.13 |
| SSM Parameter Store / Session Manager / Run Command | Config store / shell without SSH / remote commands | 1.13 |
| **Stream** | One migration path we sell, with its own subdomain, pool and oauth2-proxy | 0.1, 1.7 |
| singleProcessOOMKill | Kubelet (not pod) setting; stops one command OOM-ing the container | 5.30 |
| Task queue | Named line of work in Temporal | 1.12 |
| Terminal proxy | The API endpoint relaying browser WebSocket ↔ ttyd | 1.15 |
| tmux | Terminal multiplexer; keeps the shell alive and re-attachable | 1.15 |
| ttyd | Serves a shell over a WebSocket | 1.15 |
| TLS / TLS termination | HTTPS encryption / where it's decrypted | 1.2 |
| TTL | Time-to-live; sessions last 2 days | 2.6 |
| UserData | First-boot script; editing it replaces the server | 1.4, 5.3 |
| VPC / VPC endpoint | Private network / private tunnel to an AWS service | 1.3 |
| VPC CNI | EKS networking plugin; enforces NetworkPolicy | 1.12 |
| Warm pool | Sessions created in advance | 4.9 |
| WebSocket | Long-lived two-way connection | 1.1 |
| Wildcard (DNS / certificate) | `*.shinro.ai` matches any subdomain | 1.1, 1.2 |
| Worker (Temporal) | Process running workflow code | 1.12 |
| xterm.js | Browser-side terminal emulator | 1.15 |
| Zeebe | Camunda 8's engine (gRPC 26500) | 1.12 |
