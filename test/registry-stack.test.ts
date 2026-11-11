import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { RegistryStack } from '../lib/stacks/registry-stack';

const app = new cdk.App();
const template = Template.fromStack(
  new RegistryStack(app, 'Reg', { env: { account: '111111111111', region: 'us-east-1' } }),
);

test.each(['api', 'tool-exec', 'temporal', 'terminal'])('repo shinro-live-%s: scanned, immutable, kept', (name) => {
  template.hasResource('AWS::ECR::Repository', {
    Properties: {
      RepositoryName: `shinro-live-${name}`,
      ImageScanningConfiguration: { ScanOnPush: true },
      ImageTagMutability: 'IMMUTABLE',
    },
    DeletionPolicy: 'Retain',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/shinro/live/registry/${name}-uri` });
});

test('exactly four repos, no session-worker (4.18)', () => {
  template.resourceCountIs('AWS::ECR::Repository', 4);
});

describe('GitHub release role', () => {
  const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: 'shinro-live-github-release' } });
  const role = Object.values(roles)[0];
  const policyDoc = JSON.stringify(Object.values(template.findResources('AWS::IAM::Policy'))[0].Properties.PolicyDocument);

  test('only pushes to the release branch of Quest1Codes/shinro can assume it', () => {
    const statement = role.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(statement.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(statement.Principal.Federated).toBe(
      'arn:aws:iam::425106880357:oidc-provider/token.actions.githubusercontent.com',
    );
    expect(statement.Condition).toEqual({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': 'repo:Quest1Codes/shinro:ref:refs/heads/camunda-demo-graph-deployment-main',
      },
    });
  });

  test('imports the existing OIDC provider instead of creating one', () => {
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  });

  test('SendCommand on instances requires the shinro-host tag', () => {
    expect(policyDoc).toContain('"ssm:resourceTag/shinro-live:role":"shinro-host"');
  });

  test('may upload the UI (put and list only, no delete) to the UI bucket only', () => {
    expect(policyDoc).toContain('"s3:PutObject"');
    expect(policyDoc).toContain('arn:aws:s3:::shinro-live-ui-111111111111/*');
    expect(policyDoc).not.toMatch(/s3:DeleteObject|s3:\*|s3:PutBucket/);
  });

  test('cannot deploy CloudFormation or pass roles', () => {
    expect(policyDoc).not.toMatch(/cloudformation:|iam:PassRole|sts:AssumeRole"/);
  });
});
