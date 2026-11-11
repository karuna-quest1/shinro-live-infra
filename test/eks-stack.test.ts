import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { EKS } from '../lib/config';
import { EksStack } from '../lib/stacks/eks-stack';

const app = new cdk.App();
const template = Template.fromStack(new EksStack(app, 'Eks', { env: { account: '111111111111', region: 'us-east-1' } }));
const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: any; DependsOn?: string[] }>;
const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);
const cluster = ofType('AWS::EKS::Cluster')[0][1].Properties;
const nodegroup = (name: string) => ofType('AWS::EKS::Nodegroup').find(([, r]) => r.Properties.NodegroupName === `shinro-live-${name}`)![1];
const launchTemplate = (prefix: string) => ofType('AWS::EC2::LaunchTemplate').find(([id]) => id.startsWith(prefix))![1].Properties.LaunchTemplateData;
// Stored as JSON text already; decode so checks read the manifests themselves.
const manifests = ofType('Custom::AWSCDK-EKS-KubernetesResource').map(([, r]) =>
  JSON.stringify(typeof r.Properties.Manifest === 'string' ? JSON.parse(r.Properties.Manifest) : r.Properties.Manifest),
);

describe('backend requirements (2026-11-10)', () => {
  test('network-policy enforcement is on in vpc-cni, in strict mode', () => {
    template.hasResourceProperties('AWS::EKS::Addon', {
      AddonName: 'vpc-cni',
      ConfigurationValues: JSON.stringify({ enableNetworkPolicy: 'true', env: { NETWORK_POLICY_ENFORCING_MODE: 'strict' } }),
    });
    // The managed add-on is the only copy, so the setting can't be shadowed.
    expect(cluster.BootstrapSelfManagedAddons).toBe(false);
  });

  test('sandbox pods get their own tainted node group', () => {
    const sandbox = nodegroup('sandbox').Properties;
    expect(sandbox.Taints).toEqual([{ Key: EKS.sandboxTaint.key, Value: EKS.sandboxTaint.value, Effect: 'NO_SCHEDULE' }]);
    expect(sandbox.Labels).toEqual({ [EKS.nodePoolLabel]: 'sandbox' });
    expect(nodegroup('system').Properties.Labels).toEqual({ [EKS.nodePoolLabel]: 'system' });
  });

  test('pods on any node can\'t reach the metadata service (IMDSv2, hop limit 1)', () => {
    for (const lt of ['SystemNodes', 'SandboxNodes']) {
      expect(launchTemplate(lt).MetadataOptions).toEqual({ HttpTokens: 'required', HttpPutResponseHopLimit: 1 });
    }
  });

  test('sandbox nodes have no SSM access; system nodes do', () => {
    const roleOf = (name: string) => {
      const ref = nodegroup(name).Properties.NodeRole['Fn::GetAtt'][0];
      return JSON.stringify(resources[ref].Properties.ManagedPolicyArns);
    };
    expect(roleOf('sandbox')).not.toContain('AmazonSSMManagedInstanceCore');
    expect(roleOf('system')).toContain('AmazonSSMManagedInstanceCore');
  });

  test('the Kubernetes API endpoint is private only', () => {
    expect(cluster.ResourcesVpcConfig).toMatchObject({ EndpointPublicAccess: false, EndpointPrivateAccess: true });
  });
});

test('strict mode never cuts off CoreDNS: kube-system allow-all comes first', () => {
  const [cniId, cni] = ofType('AWS::EKS::Addon').find(([, r]) => r.Properties.AddonName === 'vpc-cni')!;
  void cniId;
  const allow = ofType('Custom::AWSCDK-EKS-KubernetesResource').find(([id]) => id.includes('SystemAllowAll'))!;
  expect(cni.DependsOn).toContain(allow[0]);
  expect(manifests.some((m) => m.includes('"namespace":"kube-system"') && m.includes('"name":"allow-all"'))).toBe(true);
});

test('Container Insights: metrics only, no container logs, no injection, Pod Identity', () => {
  const insights = ofType('AWS::EKS::Addon').find(([, r]) => r.Properties.AddonName === 'amazon-cloudwatch-observability')![1].Properties;
  expect(JSON.parse(insights.ConfigurationValues)).toEqual({ containerLogs: { enabled: false }, applicationSignals: { enabled: false } });
  expect(insights.PodIdentityAssociations[0].ServiceAccount).toBe('cloudwatch-agent');
  template.hasResourceProperties('AWS::EKS::Addon', { AddonName: 'eks-pod-identity-agent' });
});

test("the monitoring namespace is open BEFORE the add-on installs (strict mode deadlock, 2026-11-11)", () => {
  const [allowId] = ofType('Custom::AWSCDK-EKS-KubernetesResource').find(([id]) => id.includes('CloudWatchAllowAll'))!;
  const insights = ofType('AWS::EKS::Addon').find(([, r]) => r.Properties.AddonName === 'amazon-cloudwatch-observability')![1];
  expect(insights.DependsOn).toContain(allowId);
  expect(insights.Properties.ResolveConflicts).toBe('OVERWRITE');
  const manifest = manifests.find((m) => m.includes('"namespace":"amazon-cloudwatch"'))!;
  expect(manifest).toContain('"kind":"Namespace"');
  // Applied, not created: the namespace may already exist.
  const resource = ofType('Custom::AWSCDK-EKS-KubernetesResource').find(([id]) => id.includes('CloudWatchAllowAll'))![1];
  expect(resource.Properties.Overwrite).toBe(true);
});

test('only sandbox nodes carry the NodePort group open to the Shinro EC2', () => {
  expect(JSON.stringify(launchTemplate('SandboxNodes').SecurityGroupIds)).toContain('sgeksnode');
  expect(JSON.stringify(launchTemplate('SystemNodes').SecurityGroupIds)).not.toContain('sgeksnode');
});

test('sandbox kubelet kills only the runaway process on OOM (gotcha 5.30)', () => {
  expect(JSON.stringify(launchTemplate('SandboxNodes').UserData)).toContain('singleProcessOOMKill: true');
});

test('add-ons come up in order: CNI and kube-proxy, then nodes, then CoreDNS', () => {
  const [cniId] = ofType('AWS::EKS::Addon').find(([, r]) => r.Properties.AddonName === 'vpc-cni')!;
  for (const name of ['system', 'sandbox']) expect(nodegroup(name).DependsOn).toContain(cniId);
  const coredns = ofType('AWS::EKS::Addon').find(([, r]) => r.Properties.AddonName === 'coredns')![1];
  expect(coredns.DependsOn!.some((d) => d.startsWith('ClusterNodegroupSystem'))).toBe(true);
});

test('audit logging is on', () => {
  const types = cluster.Logging.ClusterLogging.EnabledTypes.map((t: { Type: string }) => t.Type);
  expect(types).toEqual(expect.arrayContaining(['api', 'audit', 'authenticator']));
});

describe('session controller permissions', () => {
  const rbac = manifests.find((m) => m.includes('ClusterRole'))!;
  const fence = manifests.find((m) => m.includes('ValidatingAdmissionPolicy'))!;

  test("covers every call the app's session controller makes (agents/demo/kube.py)", () => {
    const rules = JSON.parse(rbac)[0].rules as { apiGroups: string[]; resources: string[]; verbs: string[] }[];
    const allowed = (group: string, resource: string, verb: string) =>
      rules.some((r) => r.apiGroups.includes(group) && r.resources.includes(resource) && r.verbs.includes(verb));
    for (const [group, resource, verb] of [
      ['', 'namespaces', 'list'], ['', 'namespaces', 'patch'], ['', 'namespaces', 'delete'],
      ['', 'pods', 'list'], ['', 'services', 'get'], ['apps', 'deployments/status', 'get'],
      // server-side apply of the session template
      ...['namespaces', 'resourcequotas', 'limitranges', 'services'].map((r) => ['', r, 'patch']),
      ['apps', 'deployments', 'patch'], ['networking.k8s.io', 'networkpolicies', 'patch'],
    ]) {
      expect([group, resource, verb, allowed(group, resource, verb)]).toEqual([group, resource, verb, true]);
    }
  });

  test('a scoped ClusterRole, never cluster-admin or wildcards', () => {
    expect(rbac).toContain(`"name":"${EKS.sessionControllerGroup}"`);
    expect(rbac).not.toMatch(/cluster-admin|"\*"/);
    expect(rbac).not.toMatch(/"secrets"|"pods\/exec"|"roles"|"rolebindings"|"clusterroles"/);
  });

  test('an admission policy fences its writes to demo-<hex> namespaces with restricted pod security', () => {
    expect(fence).toContain(EKS.sessionNamespacePattern.replace(/\\/g, '\\\\'));
    expect(fence).toContain("pod-security.kubernetes.io/enforce'] == 'restricted'");
    expect(fence).toContain('"validationActions":["Deny"]');
    expect(fence).toContain('"failurePolicy":"Fail"');
  });
});

test("the Shinro EC2's role maps to the session controller group only, no access policies", () => {
  const entry = ofType('AWS::EKS::AccessEntry').find(([id]) => id.startsWith('ShinroHostAccess'))![1].Properties;
  expect(entry.PrincipalArn).toBe('arn:aws:iam::111111111111:role/shinro-live-shinro-host');
  expect(entry.KubernetesGroups).toEqual([EKS.sessionControllerGroup]);
  expect(entry.AccessPolicies).toBeUndefined();
});

test('publishes the cluster for the Shinro EC2', () => {
  for (const name of ['cluster-name', 'cluster-arn', 'session-controller-group']) {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/shinro/live/eks/${name}` });
  }
});
