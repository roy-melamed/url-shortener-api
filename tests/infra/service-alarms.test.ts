import { App, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ServiceAlarms } from '../../infra/lib/service-alarms.ts';
import { synthesizedStack } from './synthesized-stack.ts';

const { template, json } = synthesizedStack();
const resources = (type: string) =>
  Object.entries(json.Resources).filter(([, resource]) => resource.Type === type);
const id = (type: string, prefix: string) => {
  const entry = resources(type).find(([logicalId]) => logicalId.startsWith(prefix));
  expect(entry, `${type} ${prefix}`).toBeDefined();
  return entry![0];
};
const alarm = (prefix: string) => {
  const entry = resources('AWS::CloudWatch::Alarm').find(([logicalId]) =>
    logicalId.startsWith(`ServiceAlarms${prefix}`),
  );
  expect(entry).toBeDefined();
  return entry![1].Properties!;
};
const apiId = { Ref: id('AWS::ApiGatewayV2::Api', 'HttpApi') };
const apiDimensions = [{ Name: 'ApiId', Value: apiId }];
const routeDimensions = (method: string, resource: string) => [
  ...apiDimensions,
  { Name: 'Method', Value: method },
  { Name: 'Resource', Value: resource },
  { Name: 'Stage', Value: '$default' },
];
interface MetricQuery {
  Id: string;
  Expression?: string;
  Period?: number;
  ReturnData: boolean;
  MetricStat?: {
    Metric: { Namespace: string; MetricName: string; Dimensions: unknown[] };
    Period: number;
    Stat: string;
  };
}
const queries = (name: string) => alarm(name).Metrics as MetricQuery[];

describe('historical AWS service alarms (URL-16)', () => {
  it('creates exactly seven enabled actionable alarms, one topic and no forced subscriptions', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 7);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::SNS::Subscription', 0);
    const topicId = id('AWS::SNS::Topic', 'ServiceAlarmsNotifications');
    for (const [, resource] of resources('AWS::CloudWatch::Alarm')) {
      const properties = resource.Properties!;
      expect(properties.ActionsEnabled).not.toBe(false);
      expect(properties.AlarmActions).toEqual([{ Ref: topicId }]);
      expect(properties.OKActions).toEqual([{ Ref: topicId }]);
      expect(properties.InsufficientDataActions).toBeUndefined();
      expect(properties.TreatMissingData).toBe('missing');
      expect(properties.ComparisonOperator).toBe('GreaterThanThreshold');
      expect(properties.DatapointsToAlarm).toBe(properties.EvaluationPeriods);
      expect(properties.AlarmDescription).toMatch(/Inspect|Check/);
    }
    expect(JSON.stringify(template.toJSON().Outputs.AlarmNotificationTopicArn)).toContain(topicId);
    const policy = resources('AWS::SNS::TopicPolicy')[0]![1].Properties!.PolicyDocument as {
      Statement: Record<string, unknown>[];
    };
    expect(policy.Statement).toContainEqual(
      expect.objectContaining({
        Action: 'sns:Publish',
        Effect: 'Allow',
        Principal: { Service: 'cloudwatch.amazonaws.com' },
        Resource: { Ref: topicId },
        Condition: {
          StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
          ArnEquals: {
            'aws:SourceArn': resources('AWS::CloudWatch::Alarm').map(([logicalId]) => ({
              'Fn::GetAtt': [logicalId, 'Arn'],
            })),
          },
        },
      }),
    );
  });

  it('computes a percentage from actual API 5xx/count sums in a five-minute window', () => {
    expect(alarm('ServerErrorRate')).toMatchObject({ Threshold: 1, EvaluationPeriods: 1 });
    const metrics = queries('ServerErrorRate');
    expect(metrics.find((query) => query.Expression)).toMatchObject({
      Expression: 'IF(requests > 0, 100 * errors / requests, 0)',
      ReturnData: true,
    });
    for (const [queryId, metricName] of [
      ['errors', '5xx'],
      ['requests', 'Count'],
    ]) {
      expect(metrics.find((query) => query.Id === queryId)).toMatchObject({
        ReturnData: false,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/ApiGateway',
            MetricName: metricName,
            Dimensions: apiDimensions,
          },
          Period: 300,
          Stat: 'Sum',
        },
      });
    }
  });

  it('requires ten consecutive minutes of redirect p95 over 120ms and covers GET and HEAD', () => {
    expect(alarm('RedirectLatency')).toMatchObject({ Threshold: 120, EvaluationPeriods: 10 });
    const metrics = queries('RedirectLatency');
    expect(metrics.find((query) => query.Expression)).toMatchObject({
      Expression: 'MAX([get, head])',
      ReturnData: true,
    });
    for (const method of ['GET', 'HEAD']) {
      expect(metrics.find((query) => query.Id === method.toLowerCase())).toMatchObject({
        MetricStat: {
          Metric: {
            Namespace: 'AWS/ApiGateway',
            MetricName: 'IntegrationLatency',
            Dimensions: routeDimensions(method, '/{slug}'),
          },
          Period: 60,
          Stat: 'p95',
        },
      });
    }
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      DefaultRouteSettings: { DetailedMetricsEnabled: true },
    });
  });

  it('counts readiness failures in two consecutive one-minute windows, not arbitrary API errors', () => {
    expect(alarm('ReadinessFailures')).toMatchObject({
      Namespace: 'AWS/ApiGateway',
      MetricName: '5xx',
      Dimensions: routeDimensions('GET', '/readyz'),
      Statistic: 'Sum',
      Period: 60,
      Threshold: 0,
      EvaluationPeriods: 2,
      DatapointsToAlarm: 2,
    });
  });

  it.each([
    ['ClickDeadLetters', 'ClickDlq', 'ApproximateNumberOfMessagesVisible', 0],
    ['AggregationLag', 'ClickQueue', 'ApproximateAgeOfOldestMessage', 300],
  ] as const)(
    'wires %s to its actual queue with strict threshold and seconds units',
    (name, prefix, metric, threshold) => {
      const queueId = id('AWS::SQS::Queue', prefix);
      expect(alarm(name)).toMatchObject({
        Namespace: 'AWS/SQS',
        MetricName: metric,
        Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [queueId, 'QueueName'] } }],
        Statistic: 'Maximum',
        Period: 60,
        Threshold: threshold,
        EvaluationPeriods: 1,
      });
    },
  );

  it('compares actual proxy backend connections with allowed capacity, not client connections or a guessed limit', () => {
    expect(alarm('ProxyConnectionUtilization')).toMatchObject({
      Threshold: 80,
      EvaluationPeriods: 1,
    });
    const metrics = queries('ProxyConnectionUtilization');
    expect(metrics.find((query) => query.Expression)).toMatchObject({
      Expression: 'IF(allowed > 0, 100 * used / allowed)',
      ReturnData: true,
    });
    for (const [queryId, metricName] of [
      ['used', 'DatabaseConnections'],
      ['allowed', 'MaxDatabaseConnectionsAllowed'],
    ]) {
      expect(metrics.find((query) => query.Id === queryId)).toMatchObject({
        MetricStat: {
          Metric: {
            Namespace: 'AWS/RDS',
            MetricName: metricName,
            Dimensions: [{ Name: 'ProxyName', Value: { Ref: id('AWS::RDS::DBProxy', 'DbProxy') } }],
          },
          Stat: 'Sum',
          Period: 60,
        },
      });
    }
  });

  it('alarms on any actual maintenance Lambda error', () => {
    expect(alarm('MaintenanceFailure')).toMatchObject({
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Dimensions: [
        { Name: 'FunctionName', Value: { Ref: id('AWS::Lambda::Function', 'MaintenanceFn') } },
      ],
      Statistic: 'Sum',
      Period: 60,
      Threshold: 0,
      EvaluationPeriods: 1,
    });
  });

  it('accepts an owner-managed topic without creating or subscribing another topic', () => {
    const stack = new Stack(new App(), 'ServiceAlarmReuseTest');
    const topic = new sns.Topic(stack, 'OwnerNotifications');
    const maintenanceFunction = new lambda.Function(stack, 'Maintenance', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => {};'),
    });
    const monitoring = new ServiceAlarms(stack, 'Monitoring', {
      api: new apigwv2.HttpApi(stack, 'Api'),
      clickQueue: new sqs.Queue(stack, 'Clicks'),
      clickDlq: new sqs.Queue(stack, 'DeadLetters'),
      maintenanceFunction,
      proxyName: 'test-proxy',
      notificationTopic: topic,
    });
    expect(monitoring.notificationTopic).toBe(topic);
    expect(monitoring.alarms).toHaveLength(7);
    const reused = Template.fromStack(stack);
    reused.resourceCountIs('AWS::SNS::Topic', 1);
    reused.resourceCountIs('AWS::SNS::Subscription', 0);
    reused.resourceCountIs('AWS::CloudWatch::Alarm', 7);
  });
});
