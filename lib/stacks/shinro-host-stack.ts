import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct, IConstruct } from 'constructs';
import {
  CAMUNDA_DEMO_USERNAME,
  CAMUNDA_PUBLIC_HOST,
  DOMAIN,
  EKS,
  EXISTING_EIPS,
  HOST_ROLE_TAG,
  IDENTITY,
  INITIAL_RELEASE,
  LiveConfig,
  OBSERVABILITY,
  PREFIX,
  SESSIONS,
  SIZES,
  SUPPORT_IMAGES,
  TEMPORAL_UI_PUBLIC_HOST,
} from '../config';
import { ssmName } from '../constructs/ssm-params';
import { VPC_CIDR } from './network-stack';

export const SHINRO_BUNDLE_DIR = path.join(__dirname, '..', '..', 'assets', 'shinro-bundle');

/** Compose services with their own log group; one oauth2-proxy per stream is added. */
export const SHINRO_SERVICES = ['nginx', 'shinro-api', 'tool-exec', 'redis'] as const;

/** Secrets the host reads by name. Those marked "by hand" are created outside CDK. */
export const SHINRO_SECRET_NAMES = {
  originSecret: `${PREFIX}/edge/origin-secret`,
  apiEnv: `${PREFIX}/shinro/api-env`,
  toolExecEnv: `${PREFIX}/shinro/tool-exec-env`,
  /** nginx sends it on the internal Temporal UI lookup; the API checks it. */
  temporalUiRouteSecret: `${PREFIX}/shinro/temporal-ui-route-secret`,
  /** By hand: Cloudflare token, Zone > DNS > Edit on shinro.ai only. */
  cloudflareToken: `${PREFIX}/cloudflare/dns-api-token`,
  /**
   * The API's master password for encrypting stored secrets (AUTH_SECRET):
   * Camunda configs, LLM provider credentials. Pre-existing and deliberately
   * NOT created here -- CloudFormation would generate a new value and every
   * record already encrypted with the old one would be unreadable for good.
   * Read by name only (the role's shinro-live/shinro/* grant covers it).
   */
  authSecret: `${PREFIX}/shinro/auth-secret`,
} as const;

export interface ShinroHostStackProps extends cdk.StackProps {
  readonly config: LiveConfig;
}

/**
 * Step 4: the Shinro EC2, the front door (PLAN-v2 Stack 6).
 *
 * nginx (app paths from CloudFront; the two consoles on 443), one oauth2-proxy
 * per stream (consoles only: the API signs users in itself), shinro-api with
 * the session controller, tool-exec and Redis.
 *
 * Like the Camunda host, UserData only fetches the bundle and runs its
 * bootstrap; everything per stream is rendered at boot by bin/render.py from
 * SSM and Secrets Manager. The app images come from /shinro/live/release
 * (written by CI), falling back to INITIAL_RELEASE.
 */
export class ShinroHostStack extends cdk.Stack {
  readonly instance: ec2.Instance;
  readonly uiBucket: s3.Bucket;
  readonly docsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ShinroHostStackProps) {
    super(scope, id, props);
    const { streams } = props.config;
    const registry = `${this.account}.dkr.ecr.${this.region}.amazonaws.com`;

    const network = (name: string) => ssm.StringParameter.valueForStringParameter(this, ssmName('network', name));
    const vpcId = network('vpc-id');
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId,
      availabilityZones: cdk.Fn.split(',', network('azs'), 2),
      publicSubnetIds: cdk.Fn.split(',', network('public-subnet-ids'), 2),
    });
    const sg = (name: string) =>
      ec2.SecurityGroup.fromSecurityGroupId(this, `Sg-${name}`, network(`sg/${name}`), { mutable: false });

    // ---- The built UI: private, readable only from inside this VPC ----
    // nginx proxies /assets, /chat, /login and /settings to <stream>/... here.
    // Requests travel the VPC's S3 gateway endpoint, which sets aws:SourceVpc.
    this.uiBucket = new s3.Bucket(this, 'UiBucket', {
      bucketName: `${PREFIX}-ui-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.uiBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'ReadFromTheVpcOnly',
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject'],
        resources: [this.uiBucket.arnForObjects('*')],
        conditions: { StringEquals: { 'aws:SourceVpc': vpcId } },
      }),
    );
    cdk.Validations.of(this.uiBucket).acknowledge({
      id: 'AwsSolutions::AwsSolutions-S1',
      reason: 'Static UI files read by nginx only; nginx logs every request already.',
    });

    // ---- Reports and inventory files ----
    // The Camunda inventory tool refuses to run without somewhere to put the
    // report (tools/tool_execution/tools/camunda_inventory_fetcher.py); the API
    // and tool-exec both read it as DOC_BUCKET_NAME. Never public, and never
    // served to a browser: the API streams objects back itself.
    this.docsBucket = new s3.Bucket(this, 'DocsBucket', {
      bucketName: `${PREFIX}-docs-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    cdk.Validations.of(this.docsBucket).acknowledge({
      id: 'AwsSolutions::AwsSolutions-S1',
      reason: 'Reports written and read by the instance role only; the API logs each access.',
    });

    // ---- Secrets ----
    // CloudFront sends this header to the origin (step 5); nginx refuses :80 without it.
    const originSecret = new secretsmanager.Secret(this, 'OriginSecret', {
      secretName: SHINRO_SECRET_NAMES.originSecret,
      description: 'Header value CloudFront adds so nginx knows a request came through it',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    // The app team fills these with a JSON object of NAME: value pairs
    // (LLM keys and the rest). render.py merges them into the env files.
    const appEnv = (key: 'apiEnv' | 'toolExecEnv', what: string) =>
      new secretsmanager.Secret(this, `AppEnv-${key}`, {
        secretName: SHINRO_SECRET_NAMES[key],
        description: `${what}: JSON object of extra environment variables, filled in by the app team`,
        secretStringValue: cdk.SecretValue.unsafePlainText('{}'),
      });
    const appSecrets = [appEnv('apiEnv', 'shinro-api'), appEnv('toolExecEnv', 'tool-exec')];
    const routeSecret = new secretsmanager.Secret(this, 'TemporalUiRouteSecret', {
      secretName: SHINRO_SECRET_NAMES.temporalUiRouteSecret,
      description: 'Header nginx sends on the internal Temporal UI lookup (X-Shinro-Route-Secret)',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    for (const secret of [originSecret, routeSecret, ...appSecrets]) {
      cdk.Validations.of(secret).acknowledge({
        id: 'AwsSolutions::AwsSolutions-SMG4',
        reason: 'Rotated by hand: the origin secret with CloudFront, the route secret by re-running roll.sh, app settings by the app team.',
      });
    }

    // ---- Logs ----
    for (const service of [...SHINRO_SERVICES, ...streams.map((s) => `oauth2-proxy-${s.name}`)]) {
      new logs.LogGroup(this, `Logs-${service}`, {
        logGroupName: `/${PREFIX}/shinro/${service}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }

    // ---- What render.py reads ----
    const bundle = new s3assets.Asset(this, 'Bundle', {
      path: SHINRO_BUNDLE_DIR,
      exclude: ['run', 'run/**', '.gitkeep', '__pycache__'],
    });
    const bundleUrl = new ssm.StringParameter(this, 'BundleUrl', {
      parameterName: ssmName('shinro', 'bundle-s3-url'),
      stringValue: bundle.s3ObjectUrl,
    });
    const hostConfig = new ssm.StringParameter(this, 'HostConfig', {
      parameterName: ssmName('shinro', 'config'),
      description: 'Shinro EC2 settings, read by bin/render.py',
      stringValue: cdk.Stack.of(this).toJsonString({
        region: this.region,
        registry,
        domain: DOMAIN,
        uiBucketHost: `${this.uiBucket.bucketName}.s3.${this.region}.amazonaws.com`,
        docsBucket: this.docsBucket.bucketName,
        camundaHost: CAMUNDA_PUBLIC_HOST,
        camundaDemoUsername: CAMUNDA_DEMO_USERNAME,
        temporalUiHost: TEMPORAL_UI_PUBLIC_HOST,
        sessionTtlHours: SESSIONS.ttlHours,
        sessionMaxActive: SESSIONS.maxActive,
        sessionHours: IDENTITY.sessionHours,
        eksClusterName: PREFIX,
        sandboxNodePool: 'sandbox',
        metricsNamespace: OBSERVABILITY.appNamespace,
        supportImages: SUPPORT_IMAGES,
        // nginx sends Temporal UI traffic only to private addresses in this VPC.
        // No backslashes here: CDK's JSON for this value doesn't escape them.
        vpcPrefix: VPC_CIDR.replace(/\.0\.0\/16$/, ''),
        releaseDefaults: {
          commit: INITIAL_RELEASE.commit,
          ...Object.fromEntries(Object.entries(INITIAL_RELEASE.images).map(([k, v]) => [`${k}-image`, v])),
        },
      }),
    });
    const streamsParam = new ssm.StringParameter(this, 'Streams', {
      parameterName: ssmName('streams'),
      description: 'The stream list from cdk.json, read by bin/render.py',
      stringValue: JSON.stringify(streams),
    });

    // ---- Instance role ----
    const role = new iam.Role(this, 'Role', {
      roleName: EKS.shinroHostRoleName,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Shinro EC2: nginx, oauth2-proxy, shinro-api, tool-exec, redis',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });
    bundle.grantRead(role);
    // shinro-api and tool-exec both run under this role; tool-exec uploads the
    // inventory report and the API streams reports back to the browser.
    this.docsBucket.grantReadWrite(role);
    const arn = (service: string, resource: string, region = this.region) =>
      `arn:aws:${service}:${region}:${this.account}:${resource}`;
    const statements: [string[], string[]][] = [
      // Everything under /shinro/live: streams, identity, camunda, eks, release, its own config.
      [['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'], [arn('ssm', 'parameter/shinro/live'), arn('ssm', 'parameter/shinro/live/*')]],
      // Named secrets only. The -?????? is Secrets Manager's random suffix.
      [
        ['secretsmanager:GetSecretValue'],
        [
          arn('secretsmanager', `secret:${PREFIX}/camunda/shinro-assessment-client-secret-??????`),
          // The shared Operate login render.py prints in the chat (CAMUNDA-DEPLOYMENT 5.5).
          arn('secretsmanager', `secret:${PREFIX}/camunda/demo-user-password-??????`),
          arn('secretsmanager', `secret:${PREFIX}/oauth2-proxy/*`),
          arn('secretsmanager', `secret:${PREFIX}/edge/origin-secret-??????`),
          arn('secretsmanager', `secret:${PREFIX}/shinro/*`),
          arn('secretsmanager', `secret:${SHINRO_SECRET_NAMES.cloudflareToken}-??????`),
        ],
      ],
      // Client secrets stay in Cognito; render.py reads them at boot.
      [['cognito-idp:DescribeUserPoolClient'], [ssm.StringParameter.valueForStringParameter(this, ssmName('identity', 'pool-arn'))]],
      // The session controller's cluster (step 6). Kubernetes rights come from its access entry.
      [['eks:DescribeCluster'], [arn('eks', `cluster/${PREFIX}`)]],
      [['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'], [arn('ecr', `repository/${PREFIX}-*`)]],
      [['ecr:GetAuthorizationToken'], ['*']],
      [['logs:CreateLogStream', 'logs:PutLogEvents'], [arn('logs', `log-group:/${PREFIX}/shinro/*`)]],
    ];
    for (const [actions, resources] of statements) role.addToPolicy(new iam.PolicyStatement({ actions, resources }));

    // ---- The instance ----
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      'exec > >(tee -a /var/log/shinro-boot.log) 2>&1',
      'dnf install -y -q unzip',
      'mkdir -p /opt/shinro-live',
      `url=$(aws ssm get-parameter --region ${this.region} --name ${ssmName('shinro', 'bundle-s3-url')} --query Parameter.Value --output text)`,
      'aws s3 cp "$url" /tmp/shinro-bundle.zip',
      'unzip -oq /tmp/shinro-bundle.zip -d /opt/shinro-live && rm /tmp/shinro-bundle.zip',
      'chmod +x /opt/shinro-live/bin/*',
      '/opt/shinro-live/bin/bootstrap.sh',
    );

    this.instance = new ec2.Instance(this, 'Instance', {
      instanceName: `${PREFIX}-shinro`,
      vpc,
      vpcSubnets: { subnets: [vpc.publicSubnets[0]] },
      securityGroup: sg('shinro-host'),
      instanceType: new ec2.InstanceType(SIZES.shinroInstance),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.X86_64, cachedInContext: true }),
      role,
      userData,
      // IMDSv2 only, with hop limit 2, not 1: the API runs in a container and uses the instance role
      // (named secrets, the EKS token). Nothing untrusted runs on this host.
      httpTokens: ec2.HttpTokens.REQUIRED,
      httpPutResponseHopLimit: 2,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(SIZES.shinroDiskGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });
    this.instance.addSecurityGroup(sg('shinro-cf'));
    this.instance.addSecurityGroup(sg('shinro-public'));
    this.instance.node.addDependency(bundleUrl, hostConfig, streamsParam);
    // The CI release role may run commands only on instances with this tag (step 3a).
    cdk.Tags.of(this.instance).add(HOST_ROLE_TAG.key, HOST_ROLE_TAG.shinroHost);

    // The existing Elastic IP, associated last (gotcha 5.4). The consoles' A records point here.
    new ec2.CfnEIPAssociation(this, 'Eip', {
      allocationId: EXISTING_EIPS.shinroHost,
      instanceId: this.instance.instanceId,
    });

    // ---- Published for other stacks and people ----
    new ssm.StringParameter(this, 'UiBucketParam', { parameterName: ssmName('shinro', 'ui-bucket'), stringValue: this.uiBucket.bucketName });
    new ssm.StringParameter(this, 'PrivateIp', { parameterName: ssmName('shinro', 'private-ip'), stringValue: this.instance.instancePrivateIp });
    new ssm.StringParameter(this, 'InstanceIdParam', { parameterName: ssmName('shinro', 'instance-id'), stringValue: this.instance.instanceId });
    new cdk.CfnOutput(this, 'InstanceId', { value: this.instance.instanceId });
    new cdk.CfnOutput(this, 'UiBucketName', { value: this.uiBucket.bucketName });
    new cdk.CfnOutput(this, 'DocsBucketName', { value: this.docsBucket.bucketName });
    new cdk.CfnOutput(this, 'CloudflareRecords', {
      description: 'Add in Cloudflare: A records, DNS only (grey cloud)',
      value: streams.flatMap((s) => s.consoles).map((h) => `${h} -> 54.147.229.249`).join(', '),
    });

    // ---- Accepted findings, each with its reason ----
    // cdk-nag names the bucket by its logical id, which CDK hashes; read it
    // from the construct so renaming DocsBucket can't silently un-suppress.
    const docsBucketLogicalRef = this.getLogicalId(this.docsBucket.node.defaultChild as cdk.CfnElement);
    const accepted: [IConstruct, string, string][] = [
      [this.instance, 'AwsSolutions-EC28', 'Basic monitoring plus the CloudWatch agent is enough for a demo host.'],
      [this.instance, 'AwsSolutions-EC29', 'Termination protection would block replacements CloudFormation needs.'],
      ...['AmazonSSMManagedInstanceCore', 'CloudWatchAgentServerPolicy'].map(
        (p): [IConstruct, string, string] => [role, `AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/${p}]`, 'AWS-maintained baseline for Session Manager and the CloudWatch agent.'],
      ),
      ...['Action::s3:GetBucket*', 'Action::s3:GetObject*', 'Action::s3:List*', `Resource::arn:aws:s3:::cdk-hnb659fds-assets-${this.account}-${this.region}/*`].map(
        (f): [IConstruct, string, string] => [role, `AwsSolutions-IAM5[${f}]`, 'Asset.grantRead: reads the bundle zip from the CDK asset bucket.'],
      ),
      [role, `AwsSolutions-IAM5[Resource::${arn('ssm', 'parameter/shinro/live/*')}]`, 'Read-only, own prefix: streams, identity, camunda, eks and release values.'],
      [role, `AwsSolutions-IAM5[Resource::${arn('secretsmanager', `secret:${PREFIX}/camunda/shinro-assessment-client-secret-??????`)}]`, "Secrets Manager's random name suffix."],
      [role, `AwsSolutions-IAM5[Resource::${arn('secretsmanager', `secret:${PREFIX}/camunda/demo-user-password-??????`)}]`, "Secrets Manager's random name suffix."],
      [role, `AwsSolutions-IAM5[Resource::${arn('secretsmanager', `secret:${PREFIX}/oauth2-proxy/*`)}]`, 'One cookie secret per stream.'],
      [role, `AwsSolutions-IAM5[Resource::${arn('secretsmanager', `secret:${PREFIX}/edge/origin-secret-??????`)}]`, "Secrets Manager's random name suffix."],
      [role, `AwsSolutions-IAM5[Resource::${arn('secretsmanager', `secret:${PREFIX}/shinro/*`)}]`, "The app team's settings secrets."],
      [role, `AwsSolutions-IAM5[Resource::${arn('secretsmanager', `secret:${SHINRO_SECRET_NAMES.cloudflareToken}-??????`)}]`, "Secrets Manager's random name suffix."],
      [role, `AwsSolutions-IAM5[Resource::${arn('ecr', `repository/${PREFIX}-*`)}]`, 'Pull only, from the shinro-live-* repositories.'],
      [role, 'AwsSolutions-IAM5[Resource::*]', 'ecr:GetAuthorizationToken has no resource-level scoping.'],
      [role, `AwsSolutions-IAM5[Resource::${arn('logs', `log-group:/${PREFIX}/shinro/*`)}]`, 'Only its own log groups.'],
      ...['Action::s3:Abort*', 'Action::s3:DeleteObject*', `Resource::<${docsBucketLogicalRef}.Arn>/*`].map(
        (f): [IConstruct, string, string] => [role, `AwsSolutions-IAM5[${f}]`, 'grantReadWrite on the reports bucket: object names are generated per conversation, and s3_repo.delete_prefix removes a conversation\'s files.'],
      ),
      [this, 'Annotation::@aws-cdk/aws-ec2:noSubnetRouteTableId', 'The VPC is imported from SSM; nothing here reads route tables.'],
      [this, 'CloudFormation-Validate::W2001', 'fromVpcAttributes needs these ids; the instance uses the subnet and security groups.'],
    ];
    for (const [scope, id, reason] of accepted) {
      cdk.Validations.of(scope).acknowledge({ id: id.startsWith('AwsSolutions-') ? `AwsSolutions::${id}` : id, reason });
    }
  }
}
