import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as dlm from 'aws-cdk-lib/aws-dlm';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { CAMUNDA_PUBLIC_HOST, PREFIX, SIZES, SSM_PREFIX } from '../config';
import { SsmParams, ssmName } from '../constructs/ssm-params';

export const BUNDLE_DIR = path.join(__dirname, '..', '..', 'assets', 'camunda-bundle');

/** Services in assets/camunda-bundle/docker-compose.yaml; each logs to its own group. */
export const CAMUNDA_SERVICES = ['orchestration', 'identity', 'postgres', 'keycloak', 'elasticsearch', 'oms-app'] as const;

/** Generated into Secrets Manager as shinro-live/camunda/<name>; read at boot by bin/render-env.sh. */
export const CAMUNDA_SECRETS = [
  'keycloak-admin-password',
  'postgres-password',
  'orchestration-client-secret',
  'identity-client-secret',
  'oms-app-client-secret',
  /** The only one Shinro's tool-exec is given (CAMUNDA-DEPLOYMENT section 6). */
  'shinro-assessment-client-secret',
] as const;

export const BACKUP_TAG = { key: 'shinro-live:backup', value: 'camunda-daily' } as const;

/**
 * Step 3b: the shared demo Camunda 8.8 (PLAN-v2 Stack 5, CAMUNDA-DEPLOYMENT.md).
 *
 * One private EC2, no public IP, no SSH. UserData only fetches the bundle and
 * runs its bootstrap.sh, and the bundle's S3 location is read from SSM, so
 * editing the bundle never changes UserData and never replaces the server
 * (gotcha 5.3). Apply a bundle change with bin/update.sh over SSM.
 *
 * The network comes from the SSM values step 1 published, not from
 * CloudFormation exports, so the Network stack stays free to change.
 */
export class CamundaHostStack extends cdk.Stack {
  readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const network = (name: string) => ssm.StringParameter.valueForStringParameter(this, ssmName('network', name));
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: network('vpc-id'),
      availabilityZones: cdk.Fn.split(',', network('azs'), 2),
      privateSubnetIds: cdk.Fn.split(',', network('private-subnet-ids'), 2),
    });
    const camundaSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'CamundaSg', network('sg/camunda'), {
      mutable: false,
    });

    // ---- Secrets: generated here, never typed by a person ----
    const secrets = CAMUNDA_SECRETS.map((name) => {
      const secret = new secretsmanager.Secret(this, `Secret-${name}`, {
        secretName: `${PREFIX}/camunda/${name}`,
        description: `Shared demo Camunda: ${name}`,
        // Letters and digits only: these land in .env and YAML unquoted.
        generateSecretString: { passwordLength: 40, excludePunctuation: true },
      });
      cdk.Validations.of(secret).acknowledge({
        id: 'AwsSolutions::AwsSolutions-SMG4',
        reason: 'Seeded into Keycloak at first boot; rotating would desync it. Rotate by changing the secret and re-running bin/update.sh.',
      });
      return secret;
    });

    // ---- Logs: one group per Compose service (awslogs driver) ----
    for (const service of CAMUNDA_SERVICES) {
      new logs.LogGroup(this, `Logs-${service}`, {
        logGroupName: `/${PREFIX}/camunda/${service}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }

    // ---- The bundle: zipped to the CDK asset bucket, located through SSM ----
    const bundle = new s3assets.Asset(this, 'Bundle', { path: BUNDLE_DIR, exclude: ['.env', '.env.tmp', '.gitkeep'] });
    const bundleUrl = new ssm.StringParameter(this, 'BundleUrl', {
      parameterName: ssmName('camunda', 'bundle-s3-url'),
      stringValue: bundle.s3ObjectUrl,
    });

    // ---- Instance role: SSM access, its own secrets and logs, nothing else ----
    const role = new iam.Role(this, 'Role', {
      roleName: `${PREFIX}-camunda-host`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Shared demo Camunda EC2',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });
    for (const secret of secrets) secret.grantRead(role);
    bundle.grantRead(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${ssmName('camunda').slice(1)}/*` })],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          this.formatArn({
            service: 'logs',
            resource: 'log-group',
            resourceName: `/${PREFIX}/camunda/*`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    const arn = (service: string, resource: string) => `arn:aws:${service}:${this.region}:${this.account}:${resource}`;
    for (const [finding, reason] of [
      ['Action::s3:GetBucket*', 'Asset.grantRead: reads the bundle zip from the CDK asset bucket.'],
      ['Action::s3:GetObject*', 'Asset.grantRead: reads the bundle zip from the CDK asset bucket.'],
      ['Action::s3:List*', 'Asset.grantRead: reads the bundle zip from the CDK asset bucket.'],
      [`Resource::arn:aws:s3:::cdk-hnb659fds-assets-${this.account}-${this.region}/*`, 'Asset.grantRead scopes to the asset bucket; the zip key changes with every bundle edit.'],
      [`Resource::${arn('ssm', `parameter${ssmName('camunda')}/*`)}`, 'Only its own settings under /shinro/live/camunda.'],
      [`Resource::${arn('logs', `log-group:/${PREFIX}/camunda/*`)}`, 'Only its own log groups, one per Compose service.'],
    ]) {
      cdk.Validations.of(role).acknowledge({ id: `AwsSolutions::AwsSolutions-IAM5[${finding}]`, reason });
    }

    // Fixed forever: everything that changes lives in the bundle.
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      'exec > >(tee -a /var/log/shinro-camunda-boot.log) 2>&1',
      'dnf install -y -q unzip',
      'mkdir -p /opt/camunda',
      `url=$(aws ssm get-parameter --region ${this.region} --name ${ssmName('camunda', 'bundle-s3-url')} --query Parameter.Value --output text)`,
      'aws s3 cp "$url" /tmp/camunda-bundle.zip',
      'unzip -oq /tmp/camunda-bundle.zip -d /opt/camunda && rm /tmp/camunda-bundle.zip',
      'chmod +x /opt/camunda/bin/*.sh',
      '/opt/camunda/bin/bootstrap.sh',
    );

    this.instance = new ec2.Instance(this, 'Instance', {
      instanceName: `${PREFIX}-camunda`,
      vpc,
      vpcSubnets: { subnets: [vpc.privateSubnets[0]] },
      associatePublicIpAddress: false,
      securityGroup: camundaSg,
      instanceType: new ec2.InstanceType(SIZES.camundaInstance),
      // Pinned in cdk.context.json, so a new AMI never replaces the server by surprise.
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
        cachedInContext: true,
      }),
      role,
      userData,
      requireImdsv2: true,
      propagateTagsToVolumeOnCreation: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(SIZES.camundaDiskGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });
    // First boot reads the bundle location, so it must exist first.
    this.instance.node.addDependency(bundleUrl);
    cdk.Tags.of(this.instance).add('shinro-live:role', 'camunda');
    cdk.Tags.of(this.instance).add(BACKUP_TAG.key, BACKUP_TAG.value);
    for (const [id, reason] of [
      ['AwsSolutions-EC28', 'Basic 5-minute monitoring plus the CloudWatch agent is enough for a demo host.'],
      ['AwsSolutions-EC29', 'Termination protection would block the replacements CloudFormation needs. Daily snapshots cover recovery (T-19).'],
    ]) {
      cdk.Validations.of(this.instance).acknowledge({ id: `AwsSolutions::${id}`, reason });
    }
    for (const policy of ['AmazonSSMManagedInstanceCore', 'CloudWatchAgentServerPolicy']) {
      cdk.Validations.of(role).acknowledge({
        id: `AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/${policy}]`,
        reason: 'AWS-maintained baseline for SSM Session Manager and the CloudWatch agent.',
      });
    }

    // ---- Backups (T-19): daily snapshots of the disk, keep 7 ----
    // The disk holds Elasticsearch and Keycloak's Postgres. The instance is shared,
    // so one bad change affects every prospect until it's restored.
    const dlmRole = new iam.Role(this, 'BackupRole', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSDataLifecycleManagerServiceRole')],
    });
    cdk.Validations.of(dlmRole).acknowledge({
      id: 'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole]',
      reason: 'The AWS-maintained service role policy for Data Lifecycle Manager.',
    });
    new dlm.CfnLifecyclePolicy(this, 'Backups', {
      description: `${PREFIX} camunda daily snapshots keep 7`,
      state: 'ENABLED',
      executionRoleArn: dlmRole.roleArn,
      policyDetails: {
        resourceTypes: ['VOLUME'],
        targetTags: [{ key: BACKUP_TAG.key, value: BACKUP_TAG.value }],
        schedules: [
          {
            name: 'daily-keep-7',
            createRule: { interval: 24, intervalUnit: 'HOURS', times: ['03:00'] },
            retainRule: { count: 7 },
            copyTags: true,
          },
        ],
      },
    });

    // ---- What other stacks and the instance read by name ----
    new SsmParams(this, 'Params', 'camunda', {
      'public-host': CAMUNDA_PUBLIC_HOST,
      'instance-id': this.instance.instanceId,
    });
    // Read by the Shinro EC2 at boot for nginx and tool-exec (CAMUNDA-DEPLOYMENT section 3).
    new ssm.StringParameter(this, 'PrivateIp', {
      parameterName: `${SSM_PREFIX}/camunda-private-ip`,
      stringValue: this.instance.instancePrivateIp,
    });

    new cdk.CfnOutput(this, 'InstanceId', { value: this.instance.instanceId });

    // Imported from SSM, so CDK knows the VPC only by id: it has no route tables
    // to offer and the id itself is never referenced. Both are expected.
    cdk.Validations.of(this).acknowledge({
      id: 'Annotation::@aws-cdk/aws-ec2:noSubnetRouteTableId',
      reason: 'The VPC is imported from SSM; nothing here reads subnet route tables.',
    });
    cdk.Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::W2001',
      reason: 'fromVpcAttributes requires a VPC id; the instance only needs the subnet and security group.',
    });
  }
}
