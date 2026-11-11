# shinro-live-infra

AWS CDK (TypeScript) for the Shinro live demo: per-stream sign-in, the shared demo Camunda,
and per-user Temporal sandboxes on EKS. Everything deploys to **us-east-1**.

## Docs

- [`docs/CDK-STEPS.md`](docs/CDK-STEPS.md): the build steps, wave by wave. **Start here.**
- [`docs/PLAN.md`](docs/PLAN.md): the plan, condensed.
- [`docs/PLAN-v2.md`](docs/PLAN-v2.md): the same plan with every term explained, plus a glossary.
- [`docs/CAMUNDA-DEPLOYMENT.md`](docs/CAMUNDA-DEPLOYMENT.md): the Camunda runbook.

## Layout

```
bin/shinro-live-infra.ts   the CDK app; region pinned to us-east-1
lib/config.ts              stream list parsing + shared constants (ports, sizes, names)
lib/stacks/                one file per stack
lib/constructs/            reusable pieces, e.g. stream-identity.ts
assets/                    bundles synced to the EC2 hosts (compose, nginx, render-env.sh)
k8s/session-template/      per-user session manifests (used by the app's session controller)
scripts/                   operator scripts, e.g. add-demo-user.sh
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
