# shinro-live-infra

AWS CDK (TypeScript) for the Shinro live demo: per-stream sign-in, the shared demo Camunda,
and per-user Temporal sandboxes on EKS. Everything deploys to **us-east-1**.

## Docs

- [`docs/CDK-STEPS.md`](docs/CDK-STEPS.md): the build steps, wave by wave. **Start here.**
- [`docs/PLAN.md`](docs/PLAN.md): the plan, condensed.
- [`docs/PLAN-v2.md`](docs/PLAN-v2.md): the same plan with every term explained, plus a glossary.
- [`docs/CAMUNDA-DEPLOYMENT.md`](docs/CAMUNDA-DEPLOYMENT.md): the Camunda runbook.
- [`docs/TODO.md`](docs/TODO.md): open items.
- [`docs/BACKEND-CHANGES.md`](docs/BACKEND-CHANGES.md): what the app team needs to change.
- [`docs/SECURITY-INVENTORY.md`](docs/SECURITY-INVENTORY.md): security review inventory and findings.
- [`docs/COSTS.md`](docs/COSTS.md): what costs money.
- [`docs/superpowers/plans/`](docs/superpowers/plans/): change plans (e.g. consoles behind CloudFront).

## Layout

```
bin/shinro-live-infra.ts   the CDK app; region pinned to us-east-1
lib/config.ts              stream list parsing + shared constants (ports, sizes, names)
lib/stacks/                one file per stack
lib/constructs/            reusable pieces: ci-role.ts (GitHub release role), ssm-params.ts
assets/                    bundles synced to the EC2 hosts (compose, nginx, render scripts)
test/                      Jest tests, incl. cdk-nag and render.py
scripts/                   operator scripts: delete-sandbox.py (see scripts/README.md)
```

## Streams

Per-stream resources come from `shinro:streams` in `cdk.json`. Adding a stream is a config
edit plus a deploy. Every hostname must belong to exactly one stream; synth fails otherwise.

## Commands

```bash
npm test                         # unit tests
npx cdk synth                    # build CloudFormation templates
npx cdk diff  <Stack>            # read this for "replacement" before every deploy
npx cdk deploy <Stack>
```

Run with `AWS_REGION=us-east-1`; the app refuses any other region.
