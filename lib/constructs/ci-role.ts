import * as cdk from 'aws-cdk-lib/core';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { GITHUB_CI, HOST_ROLE_TAG, PREFIX } from '../config';
import { ssmName } from './ssm-params';

export interface CiRoleProps {
  readonly repos: ecr.IRepository[];
}

/**
 * Role GitHub Actions assumes through OIDC to release the app (PLAN 3.6).
 * No AWS keys live in GitHub.
 *
 * It can push images, upload the built UI to the UI bucket, record which
 * image is current under /shinro/live/release/*, and run a command on the
 * Shinro EC2 to roll the services. It cannot deploy CloudFormation: infra changes stay a human
 * decision after reading `cdk diff`.
 */
export class CiRole extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: CiRoleProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    this.role = new iam.Role(this, 'Role', {
      roleName: `${PREFIX}-github-release`,
      description: `GitHub Actions release role: ${GITHUB_CI.repo}@${GITHUB_CI.branch}`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(GITHUB_CI.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // Pushes to this branch only. Other branches, forks and pull requests are refused.
          'token.actions.githubusercontent.com:sub': `repo:${GITHUB_CI.repo}:ref:refs/heads/${GITHUB_CI.branch}`,
        },
      }),
    });

    // ECR login can't be scoped to a repository; push and pull are.
    this.role.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
    for (const repo of props.repos) {
      repo.grantPullPush(this.role);
    }
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:DescribeImages', 'ecr:DescribeImageScanFindings'],
        resources: props.repos.map((r) => r.repositoryArn),
      }),
    );

    // The current release: one parameter per image, read by the host and the session controller.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter', 'ssm:GetParameter', 'ssm:GetParametersByPath'],
        resources: [
          stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: ssmName('release').slice(1) }),
          stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${ssmName('release').slice(1)}/*` }),
        ],
      }),
    );

    // The built UI: upload to the UI bucket (created by the ShinroHost stack, named
    // after the account). Write and list only; no delete, no bucket settings.
    const uiBucket = `arn:aws:s3:::${PREFIX}-ui-${stack.account}`;
    this.role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [uiBucket] }));
    this.role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [`${uiBucket}/*`] }));

    // Roll services on the Shinro EC2: only instances carrying the host tag, only the shell-script document.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [stack.formatArn({ service: 'ec2', resource: 'instance', resourceName: '*' })],
        conditions: { StringEquals: { [`ssm:resourceTag/${HOST_ROLE_TAG.key}`]: HOST_ROLE_TAG.shinroHost } },
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [
          stack.formatArn({ service: 'ssm', account: '', resource: 'document', resourceName: 'AWS-RunShellScript' }),
        ],
      }),
    );
    // Finding the host by tag and following the command can't be scoped further.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances', 'ssm:GetCommandInvocation', 'ssm:ListCommandInvocations'],
        resources: ['*'],
      }),
    );

    const arn = (service: string, resource: string) => `arn:aws:${service}:${stack.region}:${stack.account}:${resource}`;
    for (const [resource, reason] of [
      ['*', 'ecr:GetAuthorizationToken, ec2:DescribeInstances and the SSM command-status calls have no resource-level scoping.'],
      [arn('ssm', `parameter${ssmName('release')}/*`), 'One parameter per released image, all under the release path.'],
      [arn('ec2', 'instance/*'), `SendCommand is limited by the ${HOST_ROLE_TAG.key}=${HOST_ROLE_TAG.shinroHost} tag condition; the host's id is not known in advance.`],
      [`arn:aws:s3:::${PREFIX}-ui-${stack.account}/*`, "Upload the built UI; one folder per stream, file names change every build."],
    ]) {
      cdk.Validations.of(this.role).acknowledge({ id: `AwsSolutions::AwsSolutions-IAM5[Resource::${resource}]`, reason });
    }

    new cdk.CfnOutput(stack, 'CiRoleArn', {
      value: this.role.roleArn,
      description: `Set as the repository variable AWS_LIVE_RELEASE_ROLE_ARN in ${GITHUB_CI.repo}`,
    });
  }
}
