/** Historical AWS-path alarms only; this does not activate the Oracle runtime. */
import { Duration, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { IHttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';

export interface ServiceAlarmsProps {
  readonly api: IHttpApi;
  readonly clickQueue: IQueue;
  readonly clickDlq: IQueue;
  readonly maintenanceFunction: IFunction;
  readonly proxyName: string;
  /** Optional existing, owner-managed topic. No subscriptions are created. */
  readonly notificationTopic?: sns.ITopic;
}

/**
 * Seven native-metric alarms (URL-16). Owner: URL shortener service; lifecycle:
 * stack-owned, except an explicitly supplied notification topic. Route metrics
 * require detailed metrics on the HTTP API default stage. Readiness is based on
 * actual /readyz requests, not an invented external probe; absent traffic is
 * unknown, never evidence of health. Integration latency includes the Lambda
 * integration, and uses the conservative 120ms cache-miss redirect budget.
 */
export class ServiceAlarms extends Construct {
  readonly notificationTopic: sns.ITopic;
  readonly alarms: readonly cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: ServiceAlarmsProps) {
    super(scope, id);
    this.notificationTopic =
      props.notificationTopic ??
      new sns.Topic(this, 'Notifications', {
        displayName: 'URL shortener operational alarms',
        enforceSSL: true,
      });
    const minute = Duration.minutes(1);
    const gateway = (metricName: string, route?: string, statistic = 'Sum', period = minute) =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName,
        dimensionsMap: {
          ApiId: props.api.apiId,
          ...(route
            ? {
                Stage: '$default',
                Method: route.split(' ')[0]!,
                Resource: route.split(' ')[1]!,
              }
            : {}),
        },
        statistic,
        period,
      });
    const proxyMetric = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName,
        dimensionsMap: { ProxyName: props.proxyName },
        // RDS publishes one sample per underlying proxy instance: Sum both
        // capacity and usage across those instances, not their individual max.
        statistic: 'Sum',
        period: minute,
      });
    const alarm = (
      name: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      evaluationPeriods: number,
      description: string,
    ) =>
      new cloudwatch.Alarm(this, name, {
        metric,
        threshold,
        evaluationPeriods,
        datapointsToAlarm: evaluationPeriods,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.MISSING,
        alarmDescription: description,
      });

    this.alarms = [
      alarm(
        'ServerErrorRate',
        new cloudwatch.MathExpression({
          expression: 'IF(requests > 0, 100 * errors / requests, 0)',
          usingMetrics: {
            errors: gateway('5xx', undefined, 'Sum', Duration.minutes(5)),
            requests: gateway('Count', undefined, 'Sum', Duration.minutes(5)),
          },
          period: Duration.minutes(5),
        }),
        1,
        1,
        '5xx rate >1% over five minutes. Inspect API Gateway and API/redirect Lambda logs; roll back the failing revision if needed.',
      ),
      alarm(
        'RedirectLatency',
        new cloudwatch.MathExpression({
          expression: 'MAX([get, head])',
          usingMetrics: {
            get: gateway('IntegrationLatency', 'GET /{slug}', 'p95'),
            head: gateway('IntegrationLatency', 'HEAD /{slug}', 'p95'),
          },
          period: minute,
        }),
        120,
        10,
        'Redirect integration p95 >120ms for ten consecutive minutes. Inspect redirect traces, cache misses and DB/proxy latency; integration overhead is included.',
      ),
      alarm(
        'ReadinessFailures',
        gateway('5xx', 'GET /readyz'),
        0,
        2,
        '/readyz failed in two consecutive one-minute windows. Check DB connectivity, proxy capacity and API logs. Requires readiness request traffic; no synthetic probe is provisioned.',
      ),
      alarm(
        'ClickDeadLetters',
        props.clickDlq.metricApproximateNumberOfMessagesVisible({
          statistic: 'Maximum',
          period: minute,
        }),
        0,
        1,
        'Click DLQ contains messages. Inspect aggregator failures and redrive only after fixing the cause; preserve event deduplication.',
      ),
      alarm(
        'AggregationLag',
        props.clickQueue.metricApproximateAgeOfOldestMessage({
          statistic: 'Maximum',
          period: minute,
        }),
        300,
        1,
        'Oldest click message is >5 minutes old. Inspect aggregator errors, throttles and DB availability; recover the consumer before replaying.',
      ),
      alarm(
        'ProxyConnectionUtilization',
        new cloudwatch.MathExpression({
          expression: 'IF(allowed > 0, 100 * used / allowed)',
          usingMetrics: {
            used: proxyMetric('DatabaseConnections'),
            allowed: proxyMetric('MaxDatabaseConnectionsAllowed'),
          },
          period: minute,
        }),
        80,
        1,
        'RDS Proxy backend connections >80% of allowed capacity. Inspect connection pinning, long transactions and Lambda concurrency before changing pool limits.',
      ),
      alarm(
        'MaintenanceFailure',
        props.maintenanceFunction.metricErrors({
          statistic: 'Sum',
          period: minute,
        }),
        0,
        1,
        'Maintenance Lambda failed. Inspect its job id and logs; repair and rerun the affected idempotent job. Scheduler delivery failures require separate operational verification.',
      ),
    ];
    const action = new SnsAction(this.notificationTopic);
    for (const serviceAlarm of this.alarms) {
      serviceAlarm.addAlarmAction(action);
      serviceAlarm.addOkAction(action);
    }
    // Alarm actions alone do not add the SNS service permission. Limit publish
    // authority to these exact alarms in this account (confused-deputy guard).
    // Imported topics may be immutable: their owner must apply this policy.
    this.notificationTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.notificationTopic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': Stack.of(this).account },
          ArnEquals: { 'aws:SourceArn': this.alarms.map((serviceAlarm) => serviceAlarm.alarmArn) },
        },
      }),
    );
  }
}
