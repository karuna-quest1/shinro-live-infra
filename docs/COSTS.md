# Shinro live: what costs money

Every billable piece of the Shinro live infrastructure, by stack.
Approximate **us-east-1 on-demand** prices, per month, with everything running 24/7.
Last updated 2026-11-11. The `$800` monthly budget alarm (Observability stack) watches the real total.

## Summary

| Area | ≈ $/month |
|---|---|
| EKS (control plane + 3 nodes + logs + metrics) | 290–320 |
| Camunda EC2 | 160–165 |
| Shinro EC2 | 155–160 |
| Network (NAT, public IPs, flow logs) | 40 |
| Data transfer through the NAT | 5–20 |
| Everything else (ECR, secrets, alarms, CloudFront, Cognito, SES) | 15–25 |
| **Total** | **≈ 670–730** |

## By stack

### Network (`ShinroLiveNetwork`)

| Piece | ≈ $/month | Notes |
|---|---|---|
| NAT gateway | 33 | Plus $0.045 per GB through it |
| 2 public IPv4 addresses (NAT `3.212.142.142`, Shinro `54.147.229.249`) | 7 | AWS charges $0.005/hour per public IPv4 |
| VPC flow logs (rejected traffic only) | ~1 | CloudWatch Logs ingestion |

### Registry (`ShinroLiveRegistry`)

| Piece | ≈ $/month | Notes |
|---|---|---|
| ECR storage (4 repos) | 2–7 | ~1.3 GB per release; the last 50 builds per repo are kept, untagged layers removed after 7 days |
| Basic image scanning | 0 | |
| GitHub release role | 0 | |

### Identity (`ShinroLiveIdentity`)

| Piece | ≈ $/month | Notes |
|---|---|---|
| Cognito user pool (Essentials) | 0 | Free up to 10,000 monthly active users |
| SES (login-code emails) | ~0 | $0.10 per 1,000 emails |
| 1 secret (oauth2-proxy cookie) | 0.40 | $0.40 per secret |

### Camunda (`ShinroLiveCamundaHost`)

| Piece | ≈ $/month | Notes |
|---|---|---|
| EC2 `m7i.xlarge` | 147 | |
| 100 GB gp3 disk | 8 | |
| Daily snapshots, 7 kept | 2–5 | Incremental |
| 6 secrets | 2.40 | |
| Container logs (6 log groups, 30 days) | 1–3 | |

### Shinro server (`ShinroLiveShinroHost`)

| Piece | ≈ $/month | Notes |
|---|---|---|
| EC2 `m7i.xlarge` | 147 | |
| 60 GB gp3 disk | 5 | |
| 4 secrets (+1 for the Cloudflare token) | 1.60–2 | |
| Container logs (5 log groups, 30 days) | 1–3 | |
| UI bucket (S3) | ~0 | |

### Edge (`ShinroLiveEdge`)

| Piece | ≈ $/month | Notes |
|---|---|---|
| CloudFront distribution | ~0–2 | The always-free tier covers 1 TB and 10 M requests a month |
| CloudFront Function (host → folder) | 0 | 2 M invocations a month free |
| Site bucket (S3) | ~0 | |

### EKS (`ShinroLiveEks`)

| Piece | ≈ $/month | Notes |
|---|---|---|
| Cluster control plane | 73 | Fixed, even when no sessions run |
| System node, 1 × `t3.medium` | 30 | CoreDNS and add-ons |
| Sandbox nodes, 2 × `m7i.large` | 147 | About +$74 per extra node (≈ 5 sessions each) |
| 3 node disks, 80 GB gp3 each | 19 | |
| Control-plane logs (API, audit, authenticator) | 5–20 | Audit logs grow with activity |
| Container Insights metrics | 10–30 | Container logs are off |
| kubectl Lambda (CDK) | ~0 | Runs only during deploys |

### Observability (`ShinroLiveObservability`)

| Piece | ≈ $/month | Notes |
|---|---|---|
| 18 alarms | 1.80 | $0.10 each |
| Dashboard `shinro-live` | 3 | |
| ~11 custom metrics (memory, disk, containers, certificate, app metrics, logins) | 3–4 | $0.30 each |
| SNS email alerts, AWS Budget | 0 | |

### Data transfer

| Piece | ≈ $/month | Notes |
|---|---|---|
| Traffic through the NAT | 5–20 | Docker Hub pulls, sandbox downloads (Go proxy, Maven Central). ECR and S3 go through the free S3 endpoint |

## Not in this AWS bill

- **GitHub Actions minutes:** the CI/CD pipeline runs on GitHub-hosted runners, billed to the `Quest1Codes` GitHub organisation (about 40–60 runner-minutes per push).
- **LLM usage:** billed by the LLM provider. The `llm-spend-daily` alarm (over $50/day) watches it once the API publishes `LlmSpendUsd`.
- **Other projects in the same account**, including the **old `ShinroDemoStack`** (its own `m7i.xlarge`, about $150/month). Retiring it is the easiest saving once the new demo is live.

## Ways to cut cost

| Option | Saves | Trade-off |
|---|---|---|
| Stop both EC2s and scale EKS nodes to 0 outside demo hours | Up to ~60% of compute | Slower start; someone has to switch it on |
| Savings Plan (1 year) | ~30–40% on EC2 and EKS nodes | A commitment |
| Smaller or Graviton (ARM) instances | ~20–40% per instance | ARM images needed; load test first |
| Fewer EKS control-plane log types | A few $ | Less audit history |
| Retire the old `ShinroDemoStack` | ~$150 | Once nothing depends on it |

## Scaling with use

- **More sessions:** each sandbox node (`m7i.large`) holds about 5 sessions and costs about $74/month. 20 sessions need 4–5 nodes (+$150–220). Change `EKS.sandboxNodes` in `lib/config.ts` and deploy `ShinroLiveEks`.
- **More streams:** a new stream adds almost nothing to AWS (a Cognito group, an app client, a cookie secret, one more oauth2-proxy container). It shares every server.
- **Cost tracking:** all resources carry the tag `Project=shinro-live` (activated as a cost allocation tag on 2026-11-11), so **Billing → Cost Explorer**, grouped by that tag, shows the real figure.
