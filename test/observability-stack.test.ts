import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { parseStreams } from '../lib/config';
import { ObservabilityStack } from '../lib/stacks/observability-stack';

const streams = parseStreams([{ name: 'temporal', subdomain: 'temporal.shinro.ai' }]);
const app = new cdk.App();
const template = Template.fromStack(
  new ObservabilityStack(app, 'Obs', {
    env: { account: '111111111111', region: 'us-east-1' },
    config: { streams, sesDomainVerified: false },
    alarmEmails: ['oncall@example.com'],
  }),
);
const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map((r) => r.Properties);
const byName = (n: string) => alarms.find((a) => a.AlarmName === `shinro-live-${n}`)!;

test.each(['Camunda', 'Shinro'])('%s: memory, disk, status check and containers alarms', (host) => {
  for (const kind of ['memory', 'disk', 'status-check', 'containers']) expect(byName(`${host}-${kind}`)).toBeDefined();
  // The agent's disk metric carries path and fstype; without them the alarm sees nothing.
  expect(byName(`${host}-disk`).Dimensions.map((d: any) => d.Name).sort()).toEqual(['InstanceId', 'fstype', 'path']);
});

test('EKS: nodes missing or failed, memory and disk', () => {
  expect(byName('eks-nodes-missing')).toMatchObject({ Namespace: 'ContainerInsights', MetricName: 'cluster_node_count', Threshold: 3 });
  for (const n of ['eks-nodes-failed', 'eks-memory', 'eks-disk']) {
    expect(byName(n).Dimensions).toEqual([{ Name: 'ClusterName', Value: 'shinro-live' }]);
  }
});

test('a dead host or a broken health timer alarms instead of going quiet', () => {
  for (const n of ['Camunda-containers', 'Shinro-containers', 'Camunda-status-check', 'certificate-expiry', 'eks-nodes-missing']) {
    expect(byName(n).TreatMissingData).toBe('breaching');
  }
});

test('app metrics stay quiet until the API publishes them', () => {
  for (const n of ['sessions-near-cap', 'session-start-failures', 'llm-spend-daily']) {
    expect(byName(n)).toMatchObject({ Namespace: 'ShinroLive/App', TreatMissingData: 'notBreaching' });
  }
  expect(byName('sessions-near-cap').Threshold).toBe(18);
});

test('every alarm notifies the topic, on alarm and on recovery', () => {
  for (const a of alarms) {
    expect(a.AlarmActions).toHaveLength(1);
    expect(a.OKActions).toHaveLength(1);
  }
});

test('wrong-group logins counted per stream (gotcha 5.18)', () => {
  template.hasResourceProperties('AWS::Logs::MetricFilter', {
    LogGroupName: '/shinro-live/shinro/oauth2-proxy-temporal',
    MetricTransformations: [{ MetricNamespace: 'ShinroLive/Login', MetricName: 'Denied-temporal', MetricValue: '1' }],
  });
});

test('email subscribers and Budgets may publish', () => {
  template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'oncall@example.com' });
  const policy = JSON.stringify(Object.values(template.findResources('AWS::SNS::TopicPolicy'))[0].Properties);
  expect(policy).toContain('budgets.amazonaws.com');
});

test('monthly budget on the Project tag', () => {
  template.hasResourceProperties('AWS::Budgets::Budget', {
    Budget: { BudgetLimit: { Amount: 800, Unit: 'USD' }, CostFilters: { TagKeyValue: ['user:Project$shinro-live'] } },
  });
});

test.each(['camunda-bundle', 'shinro-bundle'])('%s reports UnhealthyContainers every 5 minutes', (bundle) => {
  const dir = path.join(__dirname, '..', 'assets', bundle, 'bin');
  expect(fs.readFileSync(path.join(dir, 'health.sh'), 'utf8')).toContain('--metric-name UnhealthyContainers');
  expect(fs.readFileSync(path.join(dir, 'bootstrap.sh'), 'utf8')).toMatch(/OnUnitActiveSec=5min[\s\S]*health\.timer/);
});

describe('console distribution', () => {
  const withConsoles = Template.fromStack(
    new ObservabilityStack(new cdk.App(), 'ObsConsoles', {
      env: { account: '111111111111', region: 'us-east-1' },
      config: {
        streams: parseStreams([{ name: 'temporal', subdomain: 'temporal.shinro.ai', consoles: ['camunda-demo.shinro.ai'] }]),
        sesDomainVerified: false,
      },
      alarmEmails: ['oncall@example.com'],
    }),
  );

  test('5xx alarms like the app one, on the console distribution read from SSM', () => {
    const alarm = Object.values(withConsoles.findResources('AWS::CloudWatch::Alarm'))
      .map((r) => r.Properties)
      .find((a) => a.AlarmName === 'shinro-live-cloudfront-consoles-5xx');
    expect(alarm).toMatchObject({ MetricName: '5xxErrorRate', Threshold: 10, EvaluationPeriods: 3 });
    expect(JSON.stringify(withConsoles.toJSON().Parameters)).toContain('/shinro/live/edge/console-distribution-id');
  });

  test('no consoles: no console alarm and no lookup of a parameter that does not exist', () => {
    expect(byName('cloudfront-consoles-5xx')).toBeUndefined();
    expect(JSON.stringify(template.toJSON())).not.toContain('console-distribution-id');
  });
});

test('SES reputation alarms sit below the AWS review thresholds', () => {
  expect(byName('ses-bounce-rate')).toMatchObject({ Namespace: 'AWS/SES', MetricName: 'Reputation.BounceRate', Threshold: 0.04 });
  expect(byName('ses-complaint-rate')).toMatchObject({ Namespace: 'AWS/SES', MetricName: 'Reputation.ComplaintRate', Threshold: 0.0008 });
});
