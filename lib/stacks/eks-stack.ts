import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { KubectlV36Layer } from '@aws-cdk/lambda-layer-kubectl-v36';
import { Construct } from 'constructs';
import { EKS, PREFIX, SIZES } from '../config';
import { SsmParams, ssmName } from '../constructs/ssm-params';

/**
 * Step 6: the cluster that runs one sandbox per demo user (PLAN-v2 Stack 7).
 *
 * The sandboxes run LLM-generated code, so (backend requirements, 2026-11-10):
 *   - NetworkPolicy is enforced (vpc-cni enableNetworkPolicy).
 *   - Sandbox pods get their own tainted node group, and pods there can't
 *     reach the node's metadata service or IAM role (IMDS hop limit 1).
 *   - The Kubernetes API endpoint is private only.
 *   - Nothing in the VPC accepts traffic from the nodes; sandboxes reach the
 *     Shinro API through its public address.
 *
 * CDK does not create sessions. Shinro's session controller does, at runtime,
 * from the app's session template. This stack gives it a ClusterRole that is
 * further fenced by an admission policy to demo-<hex> namespaces only, and
 * an access entry mapping the Shinro EC2's role to it. That role is created
 * by the ShinroHost stack, so deploy ShinroHost first.
 */
export class EksStack extends cdk.Stack {
  readonly cluster: eks.Cluster;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const network = (name: string) => ssm.StringParameter.valueForStringParameter(this, ssmName('network', name));
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: network('vpc-id'),
      availabilityZones: cdk.Fn.split(',', network('azs'), 2),
      privateSubnetIds: cdk.Fn.split(',', network('private-subnet-ids'), 2),
    });
    const controlPlaneSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'ControlPlaneSg', network('sg/eks-control-plane'), {
      mutable: false,
    });
    const nodeSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'NodeSg', network('sg/eks-node'), { mutable: false });

    this.cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: PREFIX,
      version: eks.KubernetesVersion.of(EKS.version),
      vpc,
      vpcSubnets: [{ subnets: vpc.privateSubnets }],
      // Backend requirement: no public endpoint, not even IP-restricted.
      endpointAccess: eks.EndpointAccess.PRIVATE,
      // Extra group on the control plane: 443 from the Shinro EC2 only.
      securityGroup: controlPlaneSg,
      // Our own node groups, not Auto Mode: sandboxes need a taint and IMDS lock-down.
      defaultCapacityType: eks.DefaultCapacityType.NODEGROUP,
      defaultCapacity: 0,
      // The managed add-ons below are the only copies, so their settings stick.
      bootstrapSelfManagedAddons: false,
      clusterLogging: [eks.ClusterLoggingTypes.API, eks.ClusterLoggingTypes.AUDIT, eks.ClusterLoggingTypes.AUTHENTICATOR],
      // Applies the RBAC and admission manifests below from inside the VPC.
      kubectlProviderOptions: {
        kubectlLayer: new KubectlV36Layer(this, 'KubectlLayer'),
        privateSubnets: vpc.privateSubnets,
      },
    });

    // ---- Add-ons ----
    const addon = (name: string, configurationValues?: Record<string, unknown>) =>
      new eks.Addon(this, `Addon-${name}`, { cluster: this.cluster, addonName: name, configurationValues });
    // Backend requirement: without this every NetworkPolicy is silently ignored.
    // Strict: a new pod starts with everything denied until its policies attach,
    // so a sandbox is never unrestricted, not even for its first seconds. It also
    // denies pods no policy selects; the system namespaces get an allow-all below.
    const vpcCni = addon('vpc-cni', { enableNetworkPolicy: 'true', env: { NETWORK_POLICY_ENFORCING_MODE: 'strict' } });
    const kubeProxy = addon('kube-proxy');
    // Nodes only turn Ready once the CNI exists; CoreDNS needs a node to run on.
    // Ordered explicitly because the default add-ons are switched off above.

    // ---- Node groups ----
    const nodeRole = (id: string, extra: string[] = []) =>
      new iam.Role(this, id, {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        managedPolicies: ['AmazonEKSWorkerNodePolicy', 'AmazonEC2ContainerRegistryPullOnly', 'AmazonEKS_CNI_Policy', ...extra].map(
          (p) => iam.ManagedPolicy.fromAwsManagedPolicyName(p),
        ),
      });

    const launchTemplate = (id: string, groups: ec2.ISecurityGroup[], userData?: ec2.UserData) => {
      const lt = new ec2.LaunchTemplate(this, id, {
        launchTemplateName: `${PREFIX}-${id.toLowerCase()}`,
        // Pods can't reach the metadata service, so they never get the node's role.
        requireImdsv2: true,
        httpPutResponseHopLimit: 1,
        securityGroup: this.cluster.clusterSecurityGroup,
        userData,
        blockDevices: [
          {
            deviceName: '/dev/xvda',
            // Sessions keep sample-app copies and Go caches on node disk (gotcha 5.28).
            volume: ec2.BlockDeviceVolume.ebs(SIZES.eksNodeDiskGiB, {
              volumeType: ec2.EbsDeviceVolumeType.GP3,
              encrypted: true,
            }),
          },
        ],
      });
      for (const sg of groups) lt.addSecurityGroup(sg);
      return lt;
    };

    // System: CoreDNS and add-ons. Sandboxes can't land here (they need the toleration
    // only the sandbox group's taint asks for, plus the sandbox nodeSelector).
    const systemLt = launchTemplate('SystemNodes', []);
    const systemNodes = this.cluster.addNodegroupCapacity('System', {
      nodegroupName: `${PREFIX}-system`,
      amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
      instanceTypes: [new ec2.InstanceType(SIZES.eksSystemNodeInstance)],
      minSize: 1,
      desiredSize: 1,
      maxSize: 2,
      subnets: { subnets: vpc.privateSubnets },
      nodeRole: nodeRole('SystemNodeRole', ['AmazonSSMManagedInstanceCore']),
      launchTemplateSpec: { id: systemLt.launchTemplateId!, version: systemLt.latestVersionNumber },
      labels: { [EKS.nodePoolLabel]: 'system' },
    });

    // Sandbox: only session pods. NodePorts open to the Shinro EC2 (eks-node group).
    // singleProcessOOMKill: a runaway generated test kills itself, not the whole
    // terminal container (gotcha 5.30). A kubelet setting, so it goes here.
    const sandboxUserData = new ec2.MultipartUserData();
    sandboxUserData.addPart(
      ec2.MultipartBody.fromRawBody({
        contentType: 'application/node.eks.aws',
        body: [
          'apiVersion: node.eks.aws/v1alpha1',
          'kind: NodeConfig',
          'spec:',
          '  kubelet:',
          '    config:',
          '      singleProcessOOMKill: true',
        ].join('\n'),
      }),
    );
    const sandboxLt = launchTemplate('SandboxNodes', [nodeSg], sandboxUserData);
    const sandboxNodes = this.cluster.addNodegroupCapacity('Sandbox', {
      nodegroupName: `${PREFIX}-sandbox`,
      amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
      instanceTypes: [new ec2.InstanceType(SIZES.eksNodeInstance)],
      minSize: EKS.sandboxNodes.min,
      desiredSize: EKS.sandboxNodes.desired,
      maxSize: EKS.sandboxNodes.max,
      subnets: { subnets: vpc.privateSubnets },
      // No SSM, no SSH: nothing to log in with on a node running untrusted code.
      nodeRole: nodeRole('SandboxNodeRole'),
      launchTemplateSpec: { id: sandboxLt.launchTemplateId!, version: sandboxLt.latestVersionNumber },
      labels: { [EKS.nodePoolLabel]: 'sandbox' },
      taints: [{ key: EKS.sandboxTaint.key, value: EKS.sandboxTaint.value, effect: eks.TaintEffect.NO_SCHEDULE }],
    });

    for (const nodes of [systemNodes, sandboxNodes]) nodes.node.addDependency(vpcCni, kubeProxy);
    const coredns = addon('coredns');
    coredns.node.addDependency(systemNodes);

    // ---- Strict mode: keep the system namespaces as they were (allow all) ----
    // Created before strict mode takes effect, so CoreDNS is never cut off.
    const allowAll = (namespace: string) => ({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'allow-all', namespace },
      spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [{}], egress: [{}] },
    });
    const systemAllowAll = this.cluster.addManifest('SystemAllowAll', allowAll('kube-system'));
    vpcCni.node.addDependency(systemAllowAll);

    // ---- Container Insights: node and pod metrics, no container logs ----
    // Its agent gets AWS access through EKS Pod Identity, not the node role, so the
    // sandbox nodes keep no AWS rights. Container logs stay off: sandbox output
    // (prospects' commands, generated code) never leaves the cluster.
    const podIdentity = addon('eks-pod-identity-agent');
    podIdentity.node.addDependency(systemNodes);
    const agentRole = new iam.Role(this, 'CloudWatchAgentRole', {
      roleName: `${PREFIX}-eks-cloudwatch-agent`,
      assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com').withSessionTags(),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy')],
    });
    const insights = addon('amazon-cloudwatch-observability', {
      containerLogs: { enabled: false },
      // On by default; it can inject instrumentation into pods. Never into sandboxes.
      applicationSignals: { enabled: false },
    });
    (insights.node.defaultChild as eks.CfnAddon).addPropertyOverride('PodIdentityAssociations', [
      { RoleArn: agentRole.roleArn, ServiceAccount: 'cloudwatch-agent' },
    ]);
    // Its namespace and allow-all policy must exist BEFORE the add-on starts its pods:
    // under strict mode, pods in a namespace with no policy can't reach anything, so
    // the add-on would never turn healthy (seen 2026-11-11: stuck in CREATING).
    // overwrite = kubectl apply: works whether or not the namespace already exists
    // (an earlier failed install left it behind).
    const cloudWatchNamespace = new eks.KubernetesManifest(this, 'CloudWatchAllowAll', {
      cluster: this.cluster,
      overwrite: true,
      manifest: [
        { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'amazon-cloudwatch' } },
        allowAll('amazon-cloudwatch'),
      ],
    });
    // The namespace already exists when the add-on installs; let the add-on own its fields.
    (insights.node.defaultChild as eks.CfnAddon).addPropertyOverride('ResolveConflicts', 'OVERWRITE');
    insights.node.addDependency(podIdentity, sandboxNodes, coredns, cloudWatchNamespace);

    // ---- What Shinro's session controller may do ----
    // Exactly what the session template creates, plus reading status. Not cluster-admin.
    const verbs = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'];
    this.cluster.addManifest(
      'SessionControllerRbac',
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRole',
        metadata: { name: EKS.sessionControllerGroup },
        rules: [
          { apiGroups: [''], resources: ['namespaces', 'services', 'endpoints', 'resourcequotas', 'limitranges'], verbs },
          { apiGroups: ['apps'], resources: ['deployments'], verbs },
          { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], verbs },
          { apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list', 'watch'] },
          // The API waits for readiness with read_namespaced_deployment_status (agents/demo/kube.py).
          { apiGroups: ['apps'], resources: ['deployments/status'], verbs: ['get'] },
        ],
      },
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRoleBinding',
        metadata: { name: EKS.sessionControllerGroup },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: EKS.sessionControllerGroup },
        subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: EKS.sessionControllerGroup }],
      },
    );

    // RBAC can't say "only namespaces named demo-*", so an admission policy does:
    // every write by the session controller must be inside a demo-<hex> namespace,
    // and every namespace it creates must enforce the "restricted" pod security level.
    const name = `${PREFIX}-session-controller-scope`;
    const target = "(object != null ? object : oldObject)";
    this.cluster.addManifest(
      'SessionControllerFence',
      {
        apiVersion: 'admissionregistration.k8s.io/v1',
        kind: 'ValidatingAdmissionPolicy',
        metadata: { name },
        spec: {
          failurePolicy: 'Fail',
          matchConstraints: {
            resourceRules: [
              {
                apiGroups: ['', 'apps', 'networking.k8s.io'],
                apiVersions: ['*'],
                operations: ['CREATE', 'UPDATE', 'DELETE'],
                resources: ['*'],
              },
            ],
          },
          matchConditions: [
            { name: 'session-controller-only', expression: `request.userInfo.groups.exists(g, g == '${EKS.sessionControllerGroup}')` },
          ],
          validations: [
            {
              expression: `request.kind.kind == 'Namespace' ? ${target}.metadata.name.matches('${EKS.sessionNamespacePattern}') : request.namespace.matches('${EKS.sessionNamespacePattern}')`,
              message: 'The session controller may only touch demo-<hex> namespaces.',
            },
            {
              expression: `request.kind.kind != 'Namespace' || request.operation == 'DELETE' || (has(object.metadata.labels) && object.metadata.labels['pod-security.kubernetes.io/enforce'] == 'restricted')`,
              message: 'Session namespaces must enforce the restricted pod security level.',
            },
          ],
        },
      },
      {
        apiVersion: 'admissionregistration.k8s.io/v1',
        kind: 'ValidatingAdmissionPolicyBinding',
        metadata: { name },
        spec: { policyName: name, validationActions: ['Deny'] },
      },
    );

    // The Shinro EC2's role -> the session controller's group. Nothing else:
    // no AWS-managed access policy, so its rights are exactly the ClusterRole above.
    new eks.CfnAccessEntry(this, 'ShinroHostAccess', {
      clusterName: this.cluster.clusterName,
      principalArn: `arn:aws:iam::${this.account}:role/${EKS.shinroHostRoleName}`,
      kubernetesGroups: [EKS.sessionControllerGroup],
      type: 'STANDARD',
    });

    // ---- Read by the Shinro EC2 (step 4) ----
    new SsmParams(this, 'Params', 'eks', {
      'cluster-name': this.cluster.clusterName,
      'cluster-arn': this.cluster.clusterArn,
      'session-controller-group': EKS.sessionControllerGroup,
    });
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });

    // ---- Accepted cdk-nag findings and warnings, each with its reason ----
    const managed = (policy: string) => `AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/${policy}]`;
    const accepted: [string, string][] = [
      ...['AmazonEKSClusterPolicy', 'AmazonEKSWorkerNodePolicy', 'AmazonEKS_CNI_Policy', 'AmazonEC2ContainerRegistryPullOnly', 'AmazonEC2ContainerRegistryReadOnly'].map(
        (p): [string, string] => [managed(p), 'The AWS-maintained policies EKS documents for clusters and nodes.'],
      ),
      [managed('AmazonSSMManagedInstanceCore'), 'System nodes only, for debugging over Session Manager. Sandbox nodes have no SSM.'],
      [managed('CloudWatchAgentServerPolicy'), 'Container Insights agent, through EKS Pod Identity only.'],
      ...['service-role/AWSLambdaBasicExecutionRole', 'service-role/AWSLambdaVPCAccessExecutionRole'].map(
        (p): [string, string] => [managed(p), "CDK's kubectl provider Lambda, which applies the manifests from inside the VPC."],
      ),
      [
        'AwsSolutions::AwsSolutions-IAM4[Policy::{"Fn::If":["ClusterKubectlProviderHandlerHasEcrPublic69E09706",{"Fn::Join":["",["arn:",{"Ref":"AWS::Partition"},":iam::aws:policy/AmazonElasticContainerRegistryPublicReadOnly"]]},{"Ref":"AWS::NoValue"}]}]',
        "CDK's kubectl provider; the policy is added only where ECR Public exists.",
      ],
      ['AwsSolutions::AwsSolutions-IAM5[Resource::<ClusterKubectlProviderHandler2E05C68A.Arn>:*]', "CDK's kubectl provider invoking its own handler versions."],
      ['AwsSolutions::AwsSolutions-L1', "CDK's kubectl provider; CDK chooses its runtime."],
      ['Annotation::@aws-cdk/aws-ec2:noSubnetRouteTableId', 'The VPC is imported from SSM; nothing here reads subnet route tables.'],
      ['Annotation::@aws-cdk/aws-eks:clusterMustManuallyTagSubnet', 'No load balancers in this cluster; sessions use NodePorts from the Shinro EC2.'],
      ['CloudFormation-Validate::W2001', 'fromVpcAttributes needs these ids; the cluster uses the subnets and security groups.'],
    ];
    for (const [id, reason] of accepted) cdk.Validations.of(this).acknowledge({ id, reason });
  }
}
