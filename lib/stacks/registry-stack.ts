import * as cdk from 'aws-cdk-lib/core';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { PREFIX } from '../config';
import { CiRole } from '../constructs/ci-role';
import { SsmParams } from '../constructs/ssm-params';

/** Image name suffix -> what it holds. No session-worker repo (decision 4.18). */
export const REPOS = {
  api: 'shinro-api',
  'tool-exec': 'tool-exec',
  temporal: 'Temporal dev server (temporalio/temporal:1.10.0)',
  terminal: 'Session terminal: ttyd, tmux, CLI, Go, migrate-agent, warm module cache',
} as const;

/**
 * Step 3a (T-31): ECR repositories (PLAN-v2 Stack 4).
 *
 * Tags are immutable because every image is tagged by commit SHA, never
 * `latest`, so a release can always be rolled back to an exact build.
 * The CI role lets GitHub Actions push here and release (lib/constructs/ci-role.ts).
 */
export class RegistryStack extends cdk.Stack {
  readonly repos: Record<keyof typeof REPOS, ecr.Repository>;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const repos = {} as Record<keyof typeof REPOS, ecr.Repository>;
    for (const name of Object.keys(REPOS) as (keyof typeof REPOS)[]) {
      repos[name] = new ecr.Repository(this, `Repo-${name}`, {
        repositoryName: `${PREFIX}-${name}`,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        encryption: ecr.RepositoryEncryption.AES_256,
        // Keep images if the stack is deleted; a running host may still need them.
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [
          { description: 'Drop untagged layers', tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: cdk.Duration.days(7) },
          { description: 'Keep the last 50 builds', tagStatus: ecr.TagStatus.ANY, maxImageCount: 50 },
        ],
      });
    }
    this.repos = repos;

    new CiRole(this, 'Ci', { repos: Object.values(repos) });

    new SsmParams(
      this,
      'Params',
      'registry',
      Object.fromEntries(Object.entries(repos).map(([name, repo]) => [`${name}-uri`, repo.repositoryUri])),
    );
  }
}
