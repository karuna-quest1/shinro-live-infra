import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { OBSERVABILITY, STACK_PREFIX, TAGS, liveStackProps, loadConfig } from './config';
import { CamundaHostStack } from './stacks/camunda-host-stack';
import { EdgeStack } from './stacks/edge-stack';
import { EksStack } from './stacks/eks-stack';
import { IdentityStack } from './stacks/identity-stack';
import { NetworkStack } from './stacks/network-stack';
import { ObservabilityStack } from './stacks/observability-stack';
import { RegistryStack } from './stacks/registry-stack';
import { ShinroHostStack } from './stacks/shinro-host-stack';

/** Adds every stack to the app. Shared by bin/ and the cdk-nag test so both check the same thing. */
export function buildApp(app: cdk.App): void {
  for (const [key, value] of Object.entries(TAGS)) {
    cdk.Tags.of(app).add(key, value);
  }

  // Validates the stream list at synth time, before any stack exists.
  const config = loadConfig(app);

  // Stacks are added wave by wave (docs/CDK-STEPS.md).
  const alarmEmails = app.node.tryGetContext(OBSERVABILITY.alarmEmailsContextKey) ?? [];
  if (!Array.isArray(alarmEmails) || alarmEmails.some((e) => typeof e !== 'string' || !e.includes('@'))) {
    throw new Error(`Context "${OBSERVABILITY.alarmEmailsContextKey}" must be a list of email addresses`);
  }

  // Wave B
  new NetworkStack(app, `${STACK_PREFIX}Network`, liveStackProps('Shinro live: VPC and security groups (step 1)'));
  new RegistryStack(app, `${STACK_PREFIX}Registry`, liveStackProps('Shinro live: ECR repositories (step 3a)'));
  new IdentityStack(app, `${STACK_PREFIX}Identity`, {
    ...liveStackProps('Shinro live: demo user pool, groups and oauth2-proxy clients (step 2)'),
    config,
    feedbackEmails: alarmEmails,
  });

  // Wave C
  new CamundaHostStack(app, `${STACK_PREFIX}CamundaHost`, liveStackProps('Shinro live: shared demo Camunda 8.8 (step 3b)'));

  // Wave D
  new ShinroHostStack(app, `${STACK_PREFIX}ShinroHost`, {
    ...liveStackProps('Shinro live: the Shinro EC2, nginx, oauth2-proxy, API, tool-exec, redis (step 4)'),
    config,
  });

  // Wave E
  new EdgeStack(app, `${STACK_PREFIX}Edge`, {
    ...liveStackProps('Shinro live: CloudFront and the public pages for every stream (step 5)'),
    config,
  });
  new EksStack(app, `${STACK_PREFIX}Eks`, liveStackProps('Shinro live: sandbox cluster, one namespace per demo user (step 6)'));

  // Wave F
  new ObservabilityStack(app, `${STACK_PREFIX}Observability`, {
    ...liveStackProps('Shinro live: alarms, dashboard and cost budget (step 8)'),
    config,
    alarmEmails,
  });

  // Security checks on every synth, diff and deploy (cdk-nag, AWS Solutions rules).
  // Accepted findings are acknowledged next to the resource, with a reason.
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
}
