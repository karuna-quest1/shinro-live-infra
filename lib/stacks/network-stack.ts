import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { CAMUNDA_PORTS, EXISTING_EIPS, NODEPORT_RANGE, PREFIX, SHINRO_PORTS } from '../config';
import { SsmParams } from '../constructs/ssm-params';

/** Doesn't overlap the account's existing VPCs (10.0.0.0/16, 172.31.0.0/16). */
export const VPC_CIDR = '10.60.0.0/16';

const CLOUDFRONT_ORIGIN_FACING = 'com.amazonaws.global.cloudfront.origin-facing';

/**
 * Step 1 (T-10, T-31): the VPC and every security group (PLAN-v2 Stack 1).
 *
 * The Shinro EC2 wears three groups: `shinroHost` (its identity, which other
 * groups allow traffic from) plus `shinroCf` and `shinroPublic` (one per entry
 * point). Sandbox pods reach the API through its public address, like any
 * user, so nothing in the VPC accepts traffic from EKS nodes (backend, 2026-11-10).
 */
export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly shinroHostSg: ec2.SecurityGroup;
  readonly shinroCfSg: ec2.SecurityGroup;
  readonly shinroPublicSg: ec2.SecurityGroup;
  readonly camundaSg: ec2.SecurityGroup;
  readonly eksNodeSg: ec2.SecurityGroup;
  readonly eksControlPlaneSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // 2 AZs because EKS needs two. One NAT gateway to save cost: if its AZ
    // fails, private servers lose internet (accepted for a demo, PLAN 1.3).
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: PREFIX,
      ipAddresses: ec2.IpAddresses.cidr(VPC_CIDR),
      maxAzs: 2,
      natGateways: 1,
      natGatewayProvider: ec2.NatProvider.gateway({ eipAllocationIds: [EXISTING_EIPS.nat] }),
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        // /20 leaves room for EKS pods, which take VPC addresses.
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
      ],
      // Free; keeps S3 traffic (bundles, ECR layers) off the NAT.
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });

    // Rejected connections only: enough to see which security group blocked
    // what, at a fraction of the cost of logging all traffic (cdk-nag VPC7).
    this.vpc.addFlowLog('RejectedFlows', {
      trafficType: ec2.FlowLogTrafficType.REJECT,
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'FlowLogs', {
          logGroupName: `/${PREFIX}/vpc/rejected-flows`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      ),
    });

    const sg = (sgId: string, description: string, allowAllOutbound: boolean) =>
      new ec2.SecurityGroup(this, sgId, {
        vpc: this.vpc,
        securityGroupName: `${PREFIX}-${sgId.replace(/Sg$/, '').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
        description,
        allowAllOutbound,
      });

    // Identity badge for the Shinro EC2. No ingress of its own.
    this.shinroHostSg = sg('shinroHostSg', 'Shinro EC2 identity; other groups allow traffic from it', true);

    // Its own group: the CloudFront prefix list counts as ~55 of the 60 rules allowed (gotcha 5.5).
    this.shinroCfSg = sg('shinroCfSg', 'HTTP from CloudFront only', false);
    const cloudFront = ec2.PrefixList.fromLookup(this, 'CloudFrontOriginFacing', {
      prefixListName: CLOUDFRONT_ORIGIN_FACING,
    });
    this.shinroCfSg.addIngressRule(
      ec2.Peer.prefixList(cloudFront.prefixListId),
      ec2.Port.tcp(SHINRO_PORTS.http),
      'App paths via CloudFront',
    );

    // The two demo consoles are reached directly; oauth2-proxy guards them.
    this.shinroPublicSg = sg('shinroPublicSg', 'HTTPS for the demo consoles', false);
    this.shinroPublicSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(SHINRO_PORTS.https), 'Demo consoles');
    this.shinroPublicSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(SHINRO_PORTS.http), 'Redirect to HTTPS');
    cdk.Validations.of(this.shinroPublicSg).acknowledge({
      id: 'AwsSolutions::AwsSolutions-EC23',
      reason: 'Intentional: the two demo consoles are public on 443 (80 only redirects). oauth2-proxy guards them (PLAN-v2 Stack 1).',
    });

    this.camundaSg = sg('camundaSg', 'Camunda EC2: reachable from the Shinro EC2 only (T-10)', true);
    for (const [name, port] of [
      ['Orchestration web and REST', CAMUNDA_PORTS.web],
      ['Zeebe gRPC', CAMUNDA_PORTS.zeebeGrpc],
      ['Keycloak', CAMUNDA_PORTS.keycloak],
    ] as const) {
      this.camundaSg.addIngressRule(this.shinroHostSg, ec2.Port.tcp(port), `${name} from Shinro`);
    }

    // Extra group on EKS nodes; EKS adds its own cluster group for node <-> control plane traffic.
    this.eksNodeSg = sg('eksNodeSg', 'EKS nodes: session NodePorts from the Shinro EC2 only (T-31)', true);
    this.eksNodeSg.addIngressRule(
      this.shinroHostSg,
      ec2.Port.tcpRange(NODEPORT_RANGE.from, NODEPORT_RANGE.to),
      'Session NodePorts from Shinro',
    );

    // Attached to the EKS cluster's private API endpoint by the EKS stack.
    this.eksControlPlaneSg = sg('eksControlPlaneSg', 'EKS API: the Shinro session controller only', false);
    this.eksControlPlaneSg.addIngressRule(this.shinroHostSg, ec2.Port.tcp(SHINRO_PORTS.https), 'Kubernetes API from Shinro');

    new SsmParams(this, 'Params', 'network', {
      'vpc-id': this.vpc.vpcId,
      azs: this.vpc.availabilityZones.join(','),
      'public-subnet-ids': this.vpc.publicSubnets.map((s) => s.subnetId).join(','),
      'private-subnet-ids': this.vpc.privateSubnets.map((s) => s.subnetId).join(','),
      'sg/shinro-host': this.shinroHostSg.securityGroupId,
      'sg/shinro-cf': this.shinroCfSg.securityGroupId,
      'sg/shinro-public': this.shinroPublicSg.securityGroupId,
      'sg/camunda': this.camundaSg.securityGroupId,
      'sg/eks-node': this.eksNodeSg.securityGroupId,
      'sg/eks-control-plane': this.eksControlPlaneSg.securityGroupId,
    });
  }
}
