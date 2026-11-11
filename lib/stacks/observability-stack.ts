import * as cdk from 'aws-cdk-lib/core';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EKS, LiveConfig, OBSERVABILITY, PREFIX, SESSIONS, TAGS } from '../config';
import { ssmName } from '../constructs/ssm-params';

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly config: LiveConfig;
  /** People emailed when an alarm fires. Each confirms once by email. */
  readonly alarmEmails: readonly string[];
}

/** The two hosts and the CloudWatch namespace their agent and health timer write to. */
export const HOSTS = [
  { name: 'Camunda', namespace: 'ShinroLive/Camunda', instanceParam: ssmName('camunda', 'instance-id') },
  { name: 'Shinro', namespace: 'ShinroLive/Shinro', instanceParam: ssmName('shinro', 'instance-id') },
] as const;

/**
 * App metrics the API publishes to OBSERVABILITY.appNamespace (a contract with
 * the app team). Their alarms treat missing data as OK, so they stay quiet
 * until the API starts sending.
 */
export const APP_METRICS = {
  activeSessions: 'ActiveSessions',
  sessionStartFailures: 'SessionStartFailures',
  llmSpendUsd: 'LlmSpendUsd',
} as const;

/**
 * Step 8: alarms, one dashboard, and the cost budget (PLAN-v2 Stack 9).
 *
 * Instance ids are read from SSM at deploy. If a host is replaced, deploy this
 * stack again so its alarms follow the new instance.
 *
 * EKS alarms read Container Insights (the add-on in the EKS stack). Dropped: the in-VPC Go module proxy; sandboxes
 * download modules from the public registries (architecture, 2026-11-10).
 */
export class ObservabilityStack extends cdk.Stack {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    // ---- Where alarms go ----
    this.topic = new sns.Topic(this, 'Alarms', {
      topicName: `${PREFIX}-alarms`,
      displayName: 'Shinro live alarms',
      enforceSSL: true,
    });
    cdk.Validations.of(this.topic).acknowledge({
      id: 'AwsSolutions::AwsSolutions-SNS2',
      reason: 'CloudWatch alarms cannot publish to a topic encrypted with the AWS-managed SNS key; alarm text holds no secrets.',
    });
    for (const email of props.alarmEmails) this.topic.addSubscription(new subscriptions.EmailSubscription(email));
    // AWS Budgets publishes cost alerts here too.
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );

    const notify = new actions.SnsAction(this.topic);
    const alarms: cloudwatch.Alarm[] = [];
    const alarm = (id: string, metric: cloudwatch.IMetric, props: Omit<cloudwatch.AlarmProps, 'metric'>) => {
      const a = new cloudwatch.Alarm(this, id, { alarmName: `${PREFIX}-${id}`, actionsEnabled: true, ...props, metric });
      a.addAlarmAction(notify);
      a.addOkAction(notify);
      alarms.push(a);
      return a;
    };
    const fiveMin = cdk.Duration.minutes(5);

    // ---- Both hosts: memory, disk, reachability, containers ----
    const dashboardHostWidgets: cloudwatch.IWidget[] = [];
    for (const host of HOSTS) {
      const instanceId = ssm.StringParameter.valueForStringParameter(this, host.instanceParam);
      const agent = (metricName: string, extra: Record<string, string> = {}) =>
        new cloudwatch.Metric({
          namespace: host.namespace,
          metricName,
          dimensionsMap: { InstanceId: instanceId, ...extra },
          period: fiveMin,
          statistic: 'Maximum',
        });
      const memory = agent('mem_used_percent');
      const disk = agent('disk_used_percent', { path: '/', fstype: 'xfs' });
      const unhealthy = agent('UnhealthyContainers');

      alarm(`${host.name}-memory`, memory, {
        alarmDescription: `${host.name} EC2 memory above 85% for 15 minutes.`,
        threshold: 85,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.MISSING,
      });
      alarm(`${host.name}-disk`, disk, {
        alarmDescription: `${host.name} EC2 root disk above 80%.`,
        threshold: 80,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.MISSING,
      });
      alarm(`${host.name}-status-check`, new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed',
        dimensionsMap: { InstanceId: instanceId },
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }), {
        alarmDescription: `${host.name} EC2 failed its AWS status checks (unreachable or impaired).`,
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      alarm(`${host.name}-containers`, unhealthy, {
        alarmDescription:
          `A Compose service on the ${host.name} EC2 is down or unhealthy for 15 minutes, ` +
          'or the host stopped reporting. Check `docker compose ps` over SSM.',
        threshold: 1,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });

      dashboardHostWidgets.push(
        new cloudwatch.GraphWidget({ title: `${host.name}: memory and disk %`, left: [memory, disk], leftYAxis: { min: 0, max: 100 }, width: 8 }),
        new cloudwatch.GraphWidget({ title: `${host.name}: unhealthy containers`, left: [unhealthy], leftYAxis: { min: 0 }, width: 4 }),
      );
    }

    // ---- EKS (Container Insights; the add-on is in the EKS stack) ----
    // Cluster-wide figures: an average can hide one busy node, so thresholds sit lower.
    const eks = (metricName: string, statistic: string) =>
      new cloudwatch.Metric({
        namespace: 'ContainerInsights',
        metricName,
        dimensionsMap: { ClusterName: PREFIX },
        period: fiveMin,
        statistic,
      });
    const expectedNodes = 1 + EKS.sandboxNodes.desired;
    alarm('eks-nodes-missing', eks('cluster_node_count', 'Minimum'), {
      alarmDescription:
        `Fewer than ${expectedNodes} EKS nodes for 10 minutes (1 system + ${EKS.sandboxNodes.desired} sandbox), ` +
        'or Container Insights stopped reporting. Sessions may not start.',
      threshold: expectedNodes,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    alarm('eks-nodes-failed', eks('cluster_failed_node_count', 'Maximum'), {
      alarmDescription: 'An EKS node is NotReady for 10 minutes.',
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const eksMemory = eks('node_memory_utilization', 'Average');
    const eksDisk = eks('node_filesystem_utilization', 'Average');
    alarm('eks-memory', eksMemory, {
      alarmDescription: 'EKS nodes average above 75% memory for 15 minutes: sessions are close to the nodes\' capacity. Add sandbox nodes (EKS.sandboxNodes).',
      threshold: 75,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    });
    alarm('eks-disk', eksDisk, {
      alarmDescription: 'EKS nodes average above 70% disk: sessions keep code and Go/Maven caches on node disk (gotcha 5.28).',
      threshold: 70,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    });

    // ---- The consoles' certificate (Shinro EC2, bin/certs.sh) ----
    const certDays = new cloudwatch.Metric({
      namespace: 'ShinroLive/Shinro',
      metricName: 'CertificateDaysToExpiry',
      period: cdk.Duration.days(1),
      statistic: 'Minimum',
    });
    alarm('certificate-expiry', certDays, {
      alarmDescription:
        'The demo consoles\' certificate expires within 14 days, or renewal stopped reporting. ' +
        'Check the Cloudflare token (shinro-live/cloudflare/dns-api-token) and `systemctl status shinro-certs`.',
      threshold: 14,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    // ---- CloudFront (stream pages and app) ----
    const distributionId = ssm.StringParameter.valueForStringParameter(this, ssmName('edge', 'distribution-id'));
    const cf = (metricName: string, statistic: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName,
        dimensionsMap: { DistributionId: distributionId, Region: 'Global' },
        period: fiveMin,
        statistic,
      });
    const errors5xx = cf('5xxErrorRate', 'Average');
    alarm('cloudfront-5xx', errors5xx, {
      alarmDescription: 'More than 10% of requests to the stream pages failed with a 5xx for 15 minutes (often: Shinro EC2 or nginx down).',
      threshold: 10,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ---- Wrong-group logins (gotcha 5.18): oauth2-proxy 403s per stream ----
    for (const stream of props.config.streams) {
      const group = logs.LogGroup.fromLogGroupName(this, `ProxyLogs-${stream.name}`, `/${PREFIX}/shinro/oauth2-proxy-${stream.name}`);
      new logs.MetricFilter(this, `Denied-${stream.name}`, {
        logGroup: group,
        // oauth2-proxy's access log: `... "/oauth2/callback" HTTP/1.1 "<agent>" 403 ...`
        filterPattern: logs.FilterPattern.literal('" 403 "'),
        metricNamespace: 'ShinroLive/Login',
        metricName: `Denied-${stream.name}`,
        metricValue: '1',
      });
      alarm(`login-denied-${stream.name}`, new cloudwatch.Metric({
        namespace: 'ShinroLive/Login',
        metricName: `Denied-${stream.name}`,
        period: cdk.Duration.minutes(15),
        statistic: 'Sum',
      }), {
        alarmDescription:
          `Signed-in users were refused 3+ times in 15 minutes on the ${stream.name} consoles. ` +
          `Usually someone is missing from the "${stream.name}" Cognito group (gotcha 5.18).`,
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

    // ---- App metrics (the API publishes them; quiet until it does) ----
    const app = (metricName: string, statistic: string, period = fiveMin) =>
      new cloudwatch.Metric({ namespace: OBSERVABILITY.appNamespace, metricName, period, statistic });
    const activeSessions = app(APP_METRICS.activeSessions, 'Maximum');
    alarm('sessions-near-cap', activeSessions, {
      alarmDescription: `Active demo sessions at ${SESSIONS.maxActive - 2}+ of the cap of ${SESSIONS.maxActive}. New prospects will soon be turned away.`,
      threshold: SESSIONS.maxActive - 2,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm('session-start-failures', app(APP_METRICS.sessionStartFailures, 'Sum', cdk.Duration.minutes(15)), {
      alarmDescription: 'Demo sessions failed to start 3+ times in 15 minutes (EKS capacity, images or permissions).',
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm('llm-spend-daily', app(APP_METRICS.llmSpendUsd, 'Sum', cdk.Duration.days(1)), {
      alarmDescription: 'LLM spend above $50 in a day ("our keys, our cost").',
      threshold: 50,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ---- Cost budget, for everything tagged Project=shinro-live ----
    new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName: `${PREFIX}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: OBSERVABILITY.monthlyBudgetUsd, unit: 'USD' },
        costFilters: { TagKeyValue: [`user:Project$${TAGS.Project}`] },
      },
      notificationsWithSubscribers: [
        { threshold: 80, type: 'ACTUAL' },
        { threshold: 100, type: 'FORECASTED' },
      ].map(({ threshold, type }) => ({
        notification: { comparisonOperator: 'GREATER_THAN', notificationType: type, threshold, thresholdType: 'PERCENTAGE' },
        subscribers: [{ subscriptionType: 'SNS', address: this.topic.topicArn }],
      })),
    });

    // ---- One dashboard ----
    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: PREFIX,
      widgets: [
        [new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms, width: 24, height: 4 })],
        dashboardHostWidgets.slice(0, 2).concat(dashboardHostWidgets.slice(2, 4)),
        [
          new cloudwatch.GraphWidget({ title: 'CloudFront requests', left: [cf('Requests', 'Sum')], width: 8 }),
          new cloudwatch.GraphWidget({ title: 'CloudFront 5xx %', left: [errors5xx], width: 8 }),
          new cloudwatch.SingleValueWidget({ title: 'Certificate days left', metrics: [certDays], width: 8 }),
        ],
        [
          new cloudwatch.GraphWidget({ title: 'EKS nodes', left: [eks('cluster_node_count', 'Minimum'), eks('cluster_failed_node_count', 'Maximum')], width: 8 }),
          new cloudwatch.GraphWidget({ title: 'EKS memory and disk % (average)', left: [eksMemory, eksDisk], leftYAxis: { min: 0, max: 100 }, width: 8 }),
          new cloudwatch.GraphWidget({ title: 'EKS pods running', left: [eks('cluster_number_of_running_pods', 'Maximum')], width: 8 }),
        ],
        [
          new cloudwatch.GraphWidget({ title: 'Active sessions (cap 20)', left: [activeSessions], width: 12 }),
          new cloudwatch.GraphWidget({ title: 'LLM spend per day ($)', left: [app(APP_METRICS.llmSpendUsd, 'Sum', cdk.Duration.days(1))], width: 12 }),
        ],
      ],
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: this.topic.topicArn });
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards/dashboard/${PREFIX}`,
    });
  }
}
