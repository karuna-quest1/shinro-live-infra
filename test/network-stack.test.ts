import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { NetworkStack, VPC_CIDR } from '../lib/stacks/network-stack';

const env = { account: '111111111111', region: 'us-east-1' };

function synth(): Template {
  const app = new cdk.App();
  return Template.fromStack(new NetworkStack(app, 'Net', { env }));
}

const template = synth();

/** Security group logical ids whose names start with the given construct id. */
function sgId(construct: string): string {
  const [id] = Object.keys(template.findResources('AWS::EC2::SecurityGroup')).filter((k) => k.startsWith(construct));
  if (!id) throw new Error(`no security group ${construct}`);
  return id;
}

/** All ingress rules, inline and standalone, targeting a group. */
function ingressOf(construct: string): Record<string, unknown>[] {
  const id = sgId(construct);
  const inline = (template.toJSON().Resources[id].Properties.SecurityGroupIngress ?? []) as Record<string, unknown>[];
  const standalone = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'))
    .map((r) => r.Properties)
    .filter((p) => JSON.stringify(p.GroupId).includes(id));
  return [...inline, ...standalone];
}

const fromGroup = (rule: Record<string, unknown>) => JSON.stringify(rule.SourceSecurityGroupId ?? '');

test('VPC: 2 AZs, public + private subnets, one NAT', () => {
  template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: VPC_CIDR });
  template.resourceCountIs('AWS::EC2::Subnet', 4);
  template.resourceCountIs('AWS::EC2::NatGateway', 1);
  // Reuses an existing Elastic IP; the account is at its limit.
  template.resourceCountIs('AWS::EC2::EIP', 0);
  template.hasResourceProperties('AWS::EC2::NatGateway', { AllocationId: 'eipalloc-0e3b4fda5c095dacf' });
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' });
});

test('Camunda accepts 8080, 26500 and 18080 from the Shinro host group only (T-10)', () => {
  const rules = ingressOf('camundaSg');
  expect(rules.map((r) => r.FromPort).sort()).toEqual([18080, 26500, 8080].sort());
  for (const rule of rules) {
    expect(rule.CidrIp).toBeUndefined();
    expect(fromGroup(rule)).toContain(sgId('shinroHostSg'));
  }
});

test('CloudFront group: port 80 from the origin-facing prefix list only', () => {
  const rules = ingressOf('shinroCfSg');
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ FromPort: 80, ToPort: 80 });
  expect(rules[0].SourcePrefixListId).toBeDefined();
});

test('Public group: 443 and 80 from anywhere', () => {
  const rules = ingressOf('shinroPublicSg');
  expect(rules.map((r) => [r.FromPort, r.CidrIp]).sort()).toEqual([
    [443, '0.0.0.0/0'],
    [80, '0.0.0.0/0'],
  ].sort());
});

test('EKS nodes accept the NodePort range from Shinro only (T-31)', () => {
  const rules = ingressOf('eksNodeSg');
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ FromPort: 30000, ToPort: 32767 });
  expect(fromGroup(rules[0])).toContain(sgId('shinroHostSg'));
});

test('nothing in the VPC accepts traffic from EKS nodes (sandboxes use the public API)', () => {
  const all = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).map((r) => r.Properties);
  expect(all.filter((p) => JSON.stringify(p.SourceSecurityGroupId ?? '').includes(sgId('eksNodeSg')))).toEqual([]);
  template.resourceCountIs('AWS::EC2::SecurityGroup', 6);
});

test('EKS API accepts 443 from Shinro only', () => {
  const rules = ingressOf('eksControlPlaneSg');
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ FromPort: 443 });
  expect(fromGroup(rules[0])).toContain(sgId('shinroHostSg'));
});

test('only the public group is open to the internet', () => {
  for (const sg of ['shinroHostSg', 'shinroCfSg', 'camundaSg', 'eksNodeSg', 'eksControlPlaneSg']) {
    expect(ingressOf(sg).filter((r) => r.CidrIp === '0.0.0.0/0')).toEqual([]);
  }
});

test('publishes ids to SSM under /shinro/live/network', () => {
  for (const name of ['vpc-id', 'private-subnet-ids', 'sg/shinro-host', 'sg/camunda', 'sg/eks-node']) {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/shinro/live/network/${name}` });
  }
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: Match.stringLikeRegexp('^/shinro/live/') });
});
