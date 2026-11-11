# Shinro live: security inventory

Inventory of the Shinro live infrastructure for a security review. Every fact below was read from the **live AWS account on 2026-11-11** (read-only calls), not from design documents. Code references are to this repo (`shinro-live-infra`) and the app repo (`Quest1Codes/shinro`).

Scope: the 8 CloudFormation stacks named `ShinroLive*`. The AWS account is **shared with other projects**; those are listed only where they affect Shinro live.

---

## Findings summary

Ordered by severity. "Status" says whether it's already known or planned.

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | **High** | **No CloudTrail trail** in the account. Only the default 90-day Event History exists; no long-term or tamper-evident API log | Not planned yet |
| F2 | **High** | **GuardDuty, Security Hub and AWS Config are not enabled** | Not planned yet |
| F3 | **High** | Deploy user **`cdk-user` has `AdministratorAccess`, 2 active long-lived access keys and no MFA** | Planned: drop to `sts:AssumeRole` on `cdk-*` + ECR push |
| F4 | **High** | **Shared AWS account**: 12 IAM users from several projects (incl. Bedrock API-key users). Any admin there can reach Shinro live resources | Organisation decision |
| F5 | Medium | CDK bootstrap **`cdk-hnb659fds-cfn-exec-role` has `AdministratorAccess`** and EKS **cluster-admin**. Anyone who can assume the CDK deploy role can change anything | CDK default; can be narrowed |
| F6 | Medium | **No WAF** on CloudFront; the two demo consoles are open to the internet on 443, protected only by oauth2-proxy (Cognito login) | Accepted for the demo; revisit before go-live |
| F7 | Medium | Every container on the Shinro EC2 (nginx, oauth2-proxy, API, tool-exec, Redis) can obtain the **instance role** (IMDS hop limit 2, needed by the API). A compromised container can read the host's secrets | By design; could split roles later |
| F8 | Medium | Camunda's **read-only `demo` account is shared by every prospect**; the final proof that a write gets 403 is **not yet run** (release blocker) | Pending approval |
| F9 | Medium | Anyone with **push access to `camunda-demo-graph-deployment-main`** releases code to the live demo (by design of CI/CD). No branch protection confirmed | Needs a repo admin |
| F10 | Low | Secrets are **not rotated** and use the AWS-managed KMS key | Accepted (generated, single-purpose) |
| F11 | Low | Redis has **no password** (reachable only on the host's Docker network, no published port) | Accepted |
| F12 | Low | EKS control-plane and Container Insights **log groups never expire** | Should set retention |
| F13 | Low | Image scans are **report-only** in CI; ECR uses **basic** scanning; dependency scan reports 675 known issues (mostly Go stdlib versions) | App team fixing; then make blocking |
| F14 | Low | **No backup of the Shinro EC2** (Redis: sessions, CLI tokens); Camunda has daily snapshots | Accepted (rebuildable) |
| F15 | Info | SES is in **sandbox**; DKIM pending (Cloudflare records not added) | In progress |

---

## 1. AWS account and region inventory

| Item | Value |
|---|---|
| Account | `425106880357` |
| Organization | `o-u4jodn31vc` (member account) |
| Region | **us-east-1 only** (enforced in code: `bin/shinro-live-infra.ts` refuses any other region) |
| CDK bootstrap | `CDKToolkit`, version 32, qualifier `hnb659fds` |

**Stacks (all `UPDATE_COMPLETE` / `CREATE_COMPLETE`):**

| Stack | Holds |
|---|---|
| `ShinroLiveNetwork` | VPC `10.60.0.0/16`, subnets, NAT, security groups, flow logs |
| `ShinroLiveRegistry` | 4 ECR repos, GitHub release role |
| `ShinroLiveIdentity` | Cognito pool `shinro-live-demo`, SES identity, user-admin role |
| `ShinroLiveCamundaHost` | Camunda EC2 (private), its secrets, daily snapshots |
| `ShinroLiveShinroHost` | Shinro EC2 (public), UI bucket, secrets |
| `ShinroLiveEdge` | CloudFront, site bucket |
| `ShinroLiveEks` | EKS cluster `shinro-live` |
| `ShinroLiveObservability` | 18 alarms, dashboard, budget |

**Compute (all `us-east-1`):**

| Resource | Where | Public? |
|---|---|---|
| Shinro EC2 `i-0577669028065dad8` (`m7i.xlarge`) | Public subnet | Yes: Elastic IP `54.147.229.249` |
| Camunda EC2 `i-05742429429d6e48c` (`m7i.xlarge`) | Private subnet | No |
| EKS `shinro-live` (Kubernetes 1.36): 1 × `t3.medium` system, 2 × `m7i.large` sandbox | Private subnets | No; **API endpoint private only** |
| NAT gateway | Public subnet | Elastic IP `3.212.142.142` (outbound only) |

**Other projects in the same account** (not part of this stack, listed for blast radius): VPCs `quest-vpn-vpc` and the default VPC; the old `ShinroDemoStack` (EC2 + CloudFront `demo.shinro.ai`); a jump server, a tunnel server, an RDS instance; 14 other ECR repos; 3 other Cognito pools.

---

## 2. AWS architecture diagram

```mermaid
flowchart LR
  user[Prospect's browser]
  gh[GitHub Actions<br/>Quest1Codes/shinro]
  subgraph Internet
    cf[CloudFront<br/>temporal.shinro.ai]
    cog[Cognito<br/>shinro-live-demo]
    ses[SES<br/>no-reply@shinro.ai]
    reg[Public registries<br/>Go proxy, Maven Central]
    llm[LLM provider]
  end
  subgraph VPC["VPC 10.60.0.0/16 (us-east-1)"]
    subgraph Public subnet
      shinro["Shinro EC2<br/>nginx · oauth2-proxy · shinro-api<br/>tool-exec · redis"]
      nat[NAT gateway]
    end
    subgraph Private subnets
      camunda["Camunda EC2<br/>Camunda 8.8 · Keycloak · ES<br/>Postgres · OMS app"]
      eks["EKS shinro-live (private API)<br/>one namespace per prospect:<br/>terminal + Temporal dev server"]
    end
  end
  s3site[(S3 site bucket)]
  s3ui[(S3 UI bucket)]
  ecr[(ECR shinro-live-*)]
  sm[(Secrets Manager<br/>shinro-live/*)]

  user -- "HTTPS temporal.shinro.ai" --> cf
  cf -- "/ (OAC)" --> s3site
  cf -- "app paths :80 + origin secret" --> shinro
  user -- "HTTPS consoles :443" --> shinro
  user -- login --> cog
  cog --> ses
  shinro -- "/assets, /chat (VPC endpoint)" --> s3ui
  shinro -- "8080 / 26500 / 18080" --> camunda
  shinro -- "K8s API 443, NodePorts" --> eks
  eks -- "HTTPS 443 only, via NAT" --> nat --> reg
  eks -- "public API via NAT" --> cf
  shinro --> llm
  shinro & camunda --> sm
  gh -- "OIDC, push images" --> ecr
  gh -- "SSM SendCommand (release)" --> shinro
  shinro & eks --> ecr
```

**Trust boundaries:**
1. **Internet → CloudFront → Shinro EC2 :80.** nginx accepts only requests with the CloudFront origin secret; the security group admits only CloudFront's prefix list.
2. **Internet → Shinro EC2 :443 (two consoles).** oauth2-proxy requires a Cognito login in the stream's group; Camunda additionally requires its shared read-only `demo` account.
3. **Shinro EC2 → private VPC.** Only the Shinro EC2's security group may reach Camunda (8080, 26500, 18080), the EKS API (443) and NodePorts.
4. **EKS sandboxes (LLM-generated code).** Strict NetworkPolicy: HTTPS out to the internet only; no private ranges, no metadata service, no other session. Dedicated tainted nodes, IMDS hop limit 1, no AWS rights.
5. **GitHub → AWS.** OIDC role limited to one repo and branch; can push images and run one command on the Shinro EC2; cannot change infrastructure.

---

## 3. IAM users, roles and policies

### Users that deploy or touch Shinro live

| User | Policies | Access keys | MFA | Use |
|---|---|---|---|---|
| `cdk-user` | **`AdministratorAccess`**, `AmazonEC2ContainerRegistryPowerUser` | **2 active** (created 2026-10-01, 2026-11-10) | **No** | `cdk deploy`, manual image push (see F3) |

All 12 IAM users in the account: `bedrock-user`, `BedrockAPIKey-8s02`, `BedrockAPIKey-9bbd`, `cdk-user`, `cli-user`, `nova-api-user`, `ses-user-001`, `shinro-ai-usage-analyzer`, `shinro-autosys-to-astro`, `shinro-demo-user`, `shinro-nr-to-clickstack`, `shinro-sql-to-clickhouse` (F4).

### Roles created by the Shinro live stacks

| Role | Assumed by | Permissions |
|---|---|---|
| `shinro-live-shinro-host` | Shinro EC2 | SSM core, CloudWatch agent; read `/shinro/live/*` SSM; read named secrets (`shinro-live/camunda/shinro-assessment-client-secret`, `oauth2-proxy/*`, `edge/origin-secret`, `shinro/*`, `cloudflare/dns-api-token`); `cognito-idp:DescribeUserPoolClient` on the demo pool; `eks:DescribeCluster` on `shinro-live`; ECR pull on `shinro-live-*`; logs to `/shinro-live/shinro/*`. EKS: group `shinro:session-controller` only |
| `shinro-live-camunda-host` | Camunda EC2 | SSM core, CloudWatch agent; read `/shinro/live/camunda/*`; read its 6 secrets; read the bundle from the CDK asset bucket; logs to `/shinro-live/camunda/*` |
| `shinro-live-github-release` | GitHub OIDC, **only** `repo:Quest1Codes/shinro:ref:refs/heads/camunda-demo-graph-deployment-main`, `aud=sts.amazonaws.com`, 1 h sessions | ECR push/pull on the 4 repos; read/write `/shinro/live/release/*`; `ssm:SendCommand` of `AWS-RunShellScript` **only on instances tagged `shinro-live:role=shinro-host`**; `ec2:DescribeInstances`, command status. **No CloudFormation, no IAM, no secrets** |
| `shinro-live-user-admin` | Principals in this account (via `sts:AssumeRole`) | 11 Cognito admin actions (create/disable/delete user, add/remove group, …) **on the demo pool only** |
| `shinro-live-eks-cloudwatch-agent` | EKS Pod Identity (`amazon-cloudwatch/cloudwatch-agent`) | `CloudWatchAgentServerPolicy` |
| EKS cluster role | `eks.amazonaws.com` | `AmazonEKSClusterPolicy` |
| EKS system node role | EC2 | Worker node, CNI, ECR pull-only, **SSM core** |
| EKS sandbox node role | EC2 | Worker node, CNI, ECR pull-only. **No SSM**; pods can't use it (IMDS hop limit 1 + NetworkPolicy) |
| kubectl provider (2 Lambda roles) | Lambda | Applies Kubernetes manifests at deploy; **EKS cluster-admin** |
| Camunda backup role | DLM | `AWSDataLifecycleManagerServiceRole` |
| Flow-log role, default-SG Lambda role | VPC Flow Logs, Lambda | Write the flow-log group; remove default SG rules once |

### CDK bootstrap roles (shared, created by `cdk bootstrap`)

| Role | Notes |
|---|---|
| `cdk-hnb659fds-deploy-role-…` | Runs CloudFormation change sets |
| `cdk-hnb659fds-cfn-exec-role-…` | **`AdministratorAccess`**, and EKS **cluster-admin** (F5) |
| `cdk-hnb659fds-file-publishing-role-…`, `…image-publishing-role-…`, `…lookup-role-…` | Asset upload; read-only lookups |

### Kubernetes RBAC (EKS)

| Identity | Rights |
|---|---|
| `shinro:session-controller` (Shinro EC2 role) | ClusterRole: create/update/delete namespaces, services, endpoints, resource quotas, limit ranges, deployments, network policies; read pods, pod logs, `deployments/status`. **Fenced by a ValidatingAdmissionPolicy** to namespaces matching `^demo-[0-9a-f]{8,}$` that enforce Pod Security `restricted`. Verified: cannot read secrets, exec into pods, bind roles, list nodes, or touch `kube-system` |
| kubectl provider, CDK cfn-exec role | `AmazonEKSClusterAdminPolicy` |
| Node roles | `system:nodes` |

**Privilege-escalation paths to review:** `cdk-user` (admin) → anything; any principal allowed `sts:AssumeRole` on `cdk-*` → cfn-exec (admin); any principal allowed to assume `shinro-live-user-admin` → manage demo users; a compromised Shinro EC2 container → the host role (F7) → named secrets and the session controller (fenced).

---

## 4. ECS task definitions

**Not used.** There is no ECS. Containers run in two ways:

**a) Docker Compose on EC2**

| Host | Containers | Identity | Published ports |
|---|---|---|---|
| Shinro EC2 | `nginx` 1.30.6, `oauth2-proxy-temporal` v7.15.6, `shinro-api`, `tool-execution`, `redis` (redis-stack-server 7.4.0-v8) | All share the **instance role** (F7) | 80, 443 (nginx only) |
| Camunda EC2 | `orchestration` (Camunda 8.8.32), `identity`, `keycloak`, `postgres`, `elasticsearch`, `oms-camunda-app` | No AWS calls from containers; the host reads secrets at boot | 8080, 26500, 18080 (SG: Shinro only); 8090 on localhost |

App images are pinned by digest from `/shinro/live/release/*`; support images by version. Definitions: `assets/shinro-bundle/docker-compose.yaml`, `assets/camunda-bundle/docker-compose.yaml`. Environment files are rendered at boot into `/opt/*/run/` with mode 600 (root only).

**b) Kubernetes pods on EKS (one namespace per prospect)**, from the app's `apps/api/etc/demo/session.yaml.tmpl`: a Temporal dev server and a terminal (ttyd + CLI). Each pod runs non-root (UID 1000/10001), with a read-only root filesystem, all capabilities dropped, seccomp `RuntimeDefault`, `allowPrivilegeEscalation: false`, no service-account token (terminal), CPU/memory limits and a namespace quota. Namespaces enforce Pod Security `restricted`.

---

## 5. ECR repository configuration

| Repo | Tag mutability | Scan on push | Encryption | Repo policy | Lifecycle |
|---|---|---|---|---|---|
| `shinro-live-api` | IMMUTABLE | Yes | AES256 | None (IAM only) | Keep last 50; untagged removed after 7 days |
| `shinro-live-tool-exec` | IMMUTABLE | Yes | AES256 | None | Same |
| `shinro-live-terminal` | IMMUTABLE | Yes | AES256 | None | Same |
| `shinro-live-temporal` | IMMUTABLE | Yes | AES256 | None | Same |

- Registry scanning: **BASIC** (OS packages only). The CI pipeline also runs Trivy 0.76.1 and OSV-Scanner, **report-only** for now (F13).
- Images are tagged with the git commit SHA and released by digest.
- Removal policy RETAIN: deleting the stack keeps the images.
- Writers: `shinro-live-github-release` (CI) and `cdk-user` (manual). Readers: both host roles and the EKS node roles.

---

## 6. S3 bucket policies and settings

| Bucket | Block Public Access | Encryption | Versioning | Policy | Holds |
|---|---|---|---|---|---|
| `shinro-live-ui-425106880357` | All 4 on | SSE-S3 | Enabled | Deny non-TLS; allow `s3:GetObject` to anyone **only with `aws:SourceVpc` = the Shinro VPC** (via its S3 gateway endpoint). Verified: direct internet read → 403 | Built UI per stream |
| `shinro-live-site-425106880357` | All 4 on | SSE-S3 | Enabled | Deny non-TLS; allow `s3:GetObject` to `cloudfront.amazonaws.com` for this distribution only (OAC) | Public landing pages |
| `cdk-hnb659fds-assets-425106880357-us-east-1` | All 4 on | SSE-KMS | Enabled | Deny non-TLS | CDK assets (host bundles) |

**No customer data is stored in S3.** Prospect data lives in Cognito (emails), Redis (sessions) and the app's chats. No S3 access logging (acknowledged in cdk-nag).

---

## 7. Redis configuration

| Item | Value |
|---|---|
| Where | Container `redis` on the Shinro EC2 (`redis/redis-stack-server:7.4.0-v8`) |
| Network | Docker network `shinro` only; **no published port**; not reachable from the VPC or internet. Aliases `redis`, `redis-stack` |
| Authentication | **None** (F11) |
| TLS | No (local Docker network) |
| Persistence | Append-only file (`--appendonly yes --appendfsync everysec`) on named volume `redis_data` (encrypted EBS) |
| Holds | Demo session leases, short-lived CLI tokens (≤ 2 h), one-time terminal codes (60 s), the tool job stream, app state |
| Clients | `shinro-api`, `tool-exec` |
| Backup | None (F14) |

---

## 8. VPC and security group configuration

**VPC `shinro-live` (`vpc-0ede2c73f20528e80`, `10.60.0.0/16`), 2 AZs:**

| Subnet | CIDR | Route to internet |
|---|---|---|
| public (us-east-1a, 1b) | `10.60.0.0/24`, `10.60.1.0/24` | Internet gateway |
| private (us-east-1a, 1b) | `10.60.16.0/20`, `10.60.32.0/20` | NAT gateway (outbound only) |

- S3 gateway endpoint on all route tables. No interface endpoints.
- **Flow logs:** REJECTED traffic → `/shinro-live/vpc/rejected-flows` (30 days).
- **Default security group:** all rules removed.

**Security groups (inbound):**

| Group | Port | Source |
|---|---|---|
| `shinro-live-shinro-cf` | TCP 80 | CloudFront origin-facing prefix list `pl-3b927c52` only |
| `shinro-live-shinro-public` | TCP 443, 80 | `0.0.0.0/0` (the two consoles; 80 redirects) |
| `shinro-live-shinro-host` | none | (identity badge for the Shinro EC2) |
| `shinro-live-camunda` | TCP 8080, 26500, 18080 | `shinro-live-shinro-host` only |
| `shinro-live-eks-node` | TCP 30000–32767 | `shinro-live-shinro-host` only |
| `shinro-live-eks-control-plane` | TCP 443 | `shinro-live-shinro-host` only |
| `eks-cluster-sg-shinro-live-…` (EKS-managed) | all | itself |

**Outbound:** `shinro-host`, `camunda`, `eks-node` and the EKS cluster group allow all; the port-only groups allow none.

**EKS network policy** (strict mode, verified with live probes): session pods may reach DNS, their own Temporal and **TCP 443 to the internet except all private ranges**; everything else denied, including from the first second of a pod's life. Pods with no policy are denied everything. `kube-system` and `amazon-cloudwatch` have explicit allow-all.

---

## 9. Load balancer and WAF configuration

- **No load balancers** (no ALB, NLB or classic ELB).
- **Public entry points:**

| Entry | Front | Protection |
|---|---|---|
| `temporal.shinro.ai` | **CloudFront** `d2rv7boj8gwvuc.cloudfront.net` (distribution `E3NJMULE8YXV3P`) | TLS 1.2+ (`TLSv1.2_2021`), HTTP→HTTPS, existing ACM cert `shinro.ai` + `*.shinro.ai`; default → private S3 (OAC); app paths → Shinro EC2 :80 with origin secret (`X-Shinro-Origin`, from Secrets Manager); app paths never cached; security response headers on static paths |
| `camunda-demo.shinro.ai`, `demo-temporal-ui.shinro.ai` | **nginx** on the Shinro EC2 :443 | oauth2-proxy (Cognito, stream group); TLS from Let's Encrypt via Cloudflare DNS-01 (self-signed until the token exists); identity headers stripped from clients; Temporal UI routed only to VPC NodePorts |

- nginx returns 404 for `/docs`, `/redoc`, `/openapi.json` and the internal Temporal-UI route; the API also disables them.
- **WAF: none** (F6). No geo restriction, no rate limiting. CloudFront access logs off.

---

## 10. Secrets Manager inventory and policies

All encrypted with the AWS-managed key `aws/secretsmanager`; **no resource policies**; **no rotation** (F10). Access is by IAM only.

| Secret | Created by | Read by | Notes |
|---|---|---|---|
| `shinro-live/camunda/keycloak-admin-password` | CDK (generated) | Camunda EC2 | |
| `shinro-live/camunda/postgres-password` | CDK | Camunda EC2 | |
| `shinro-live/camunda/orchestration-client-secret` | CDK | Camunda EC2 | |
| `shinro-live/camunda/identity-client-secret` | CDK | Camunda EC2 | |
| `shinro-live/camunda/oms-app-client-secret` | CDK | Camunda EC2 | |
| `shinro-live/camunda/shinro-assessment-client-secret` | CDK | Camunda EC2, **Shinro EC2** | Read-only Camunda client used by tool-exec |
| `shinro-live/oauth2-proxy/temporal/cookie-secret` | CDK | Shinro EC2 | |
| `shinro-live/edge/origin-secret` | CDK | Shinro EC2; CloudFront (resolved at deploy) | |
| `shinro-live/shinro/temporal-ui-route-secret` | CDK | Shinro EC2 | nginx → API internal header |
| `shinro-live/shinro/api-env` | CDK (empty `{}`), filled by the app team | Shinro EC2 | LLM keys and app settings |
| `shinro-live/shinro/tool-exec-env` | CDK (empty) | Shinro EC2 | |
| `shinro-live/cloudflare/dns-api-token` | **By hand (not yet created)** | Shinro EC2 | Cloudflare token, DNS edit on `shinro.ai` only |

- Cognito app-client secrets are **not** copied into Secrets Manager; the Shinro EC2 reads them with `DescribeUserPoolClient` at boot.
- Secrets are written to `/opt/*/run/*.env` (root-only, mode 600) on the hosts and passed to containers as environment variables.
- No secrets in the repos, the images or the CloudFormation templates (verified by tests).

---

## 11. CloudTrail and CloudWatch configuration

**CloudTrail:** **no trails configured** (F1). Only the default Event History (management events, 90 days, this region).

**GuardDuty / Security Hub / AWS Config:** **not enabled** (F2).

**CloudWatch Logs:**

| Log group | Retention | Content |
|---|---|---|
| `/shinro-live/shinro/{nginx,shinro-api,tool-exec,redis,oauth2-proxy-temporal}` | 30 days | Container logs (nginx access log in JSON) |
| `/shinro-live/camunda/{orchestration,identity,keycloak,postgres,elasticsearch,oms-app}` | 30 days | Container logs |
| `/shinro-live/vpc/rejected-flows` | 30 days | Rejected VPC traffic |
| `/aws/eks/shinro-live/cluster` | **Never expires** (F12) | EKS API, **audit** and authenticator logs |
| `/aws/containerinsights/shinro-live/performance` | **Never expires** (F12) | Container Insights metrics (container logs off) |

**Metrics and alarms** (`ShinroLiveObservability`): 18 alarms → SNS `shinro-live-alarms` → email (2 confirmed subscribers). They cover EC2 memory, disk, status checks and unhealthy containers (both hosts); certificate expiry; CloudFront 5xx; wrong-group logins (oauth2-proxy 403s); EKS nodes missing or failed, memory and disk; active sessions, failed session starts, daily LLM spend. Dashboard `shinro-live`; monthly budget $800 on `Project=shinro-live`.

---

## 12. Backup configuration

| Data | Backup | Retention |
|---|---|---|
| Camunda EC2 disk (Elasticsearch, Keycloak's Postgres, Camunda data) | **DLM** policy `policy-04eec57e92d0e6fde`: daily snapshot at 03:00 UTC of volumes tagged `shinro-live:backup=camunda-daily` | 7 snapshots |
| Shinro EC2 disk (Redis) | **None** (F14) | Sessions and tokens are short-lived; the host is rebuilt from code |
| S3 UI and site buckets | Versioning enabled | Unlimited versions |
| ECR images | Last 50 per repo; repos retained if the stack is deleted | |
| Cognito pool (all demo users) | `RemovalPolicy.RETAIN` + **deletion protection on** | No export or backup |
| Secrets | Recoverable for 7–30 days after deletion (Secrets Manager default) | |
| Infrastructure | Everything is code (this repo): **not yet committed to git** | |

**AWS Backup:** no plans. Snapshots are **not** copied to another account or region, so they wouldn't survive an account compromise.

---

## 13. External integration inventory

| Integration | Direction | Purpose | Trust / credential |
|---|---|---|---|
| **GitHub Actions** (`Quest1Codes/shinro`, branch `camunda-demo-graph-deployment-main`) | GitHub → AWS | Build, scan, push images; release to the Shinro EC2 | OIDC role `shinro-live-github-release` (no stored keys) |
| **GitHub** (public repos) | AWS → GitHub | Camunda EC2 builds the OMS app from `karuna-quest1/oms-camunda-application@81c57e0`; Docker Compose and Buildx binaries (checksum-verified) | None (public) |
| **Cloudflare** | Admin → Cloudflare; Shinro EC2 → Cloudflare API | DNS for `shinro.ai`; DNS-01 challenge for the consoles' certificate | API token (Zone:DNS:Edit, `shinro.ai` only), in Secrets Manager |
| **Let's Encrypt** | Shinro EC2 → Let's Encrypt | Wildcard certificate `*.shinro.ai` for the consoles | ACME, no account email |
| **Docker Hub, quay.io, Red Hat registry** | Hosts → registries | Camunda, Keycloak, Elasticsearch, Postgres, nginx, Redis, oauth2-proxy, certbot images; base images in CI | Public pulls (versions pinned) |
| **Amazon SES** | AWS → recipients | Login codes from `no-reply@shinro.ai` | DKIM (pending), DMARC |
| **LLM provider** ("QuestKey") | Shinro EC2 → provider | Chat and migration agent | API key in `shinro-live/shinro/api-env` |
| **Go module proxy, Maven Central** | EKS sandboxes → internet | Dependency downloads for generated code | None (public HTTPS only) |
| **HubSpot** | Prospect → HubSpot → team | Demo requests; users added to Cognito by hand | No technical integration with AWS |
| **Langfuse** (optional) | Shinro EC2 → Langfuse | LLM tracing | Disabled (no keys set) |
| **Old `ShinroDemoStack`** | Same account | Previous demo; separate resources | Shares the account (F4) |
