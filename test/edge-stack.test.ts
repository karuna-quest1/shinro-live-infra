import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { parseStreams } from '../lib/config';
import { APP_PATHS, EdgeStack, HOST_TO_FOLDER } from '../lib/stacks/edge-stack';

const streams = parseStreams([
  { name: 'temporal', subdomain: 'temporal.shinro.ai', consoles: ['camunda-demo.shinro.ai'] },
  { name: 'next', subdomain: 'next.shinro.ai' },
]);
const app = new cdk.App();
const template = Template.fromStack(
  new EdgeStack(app, 'Edge', { env: { account: '111111111111', region: 'us-east-1' }, config: { streams, sesDomainVerified: false } }),
);
const dist = Object.values(template.toJSON().Resources as Record<string, any>).find((r) => r.Type === 'AWS::CloudFront::Distribution')
  .Properties.DistributionConfig;
const behaviour = (p: string) => dist.CacheBehaviors.find((b: any) => b.PathPattern === p);
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ALL_VIEWER = '216adef6-5c7f-47e4-b989-5492eafa07d3';

test('one alias per stream page; never the apex, a wildcard or a console', () => {
  expect(dist.Aliases).toEqual(['temporal.shinro.ai', 'next.shinro.ai']);
});

test('the existing shinro.ai certificate, TLS 1.2 or newer', () => {
  expect(dist.ViewerCertificate).toMatchObject({
    AcmCertificateArn: expect.stringContaining('certificate/6652dafb'),
    MinimumProtocolVersion: 'TLSv1.2_2021',
    SslSupportMethod: 'sni-only',
  });
});

test('the origin secret is resolved at deploy, never written in the template', () => {
  const ec2 = dist.Origins.find((o: any) => o.DomainName === 'ec2-54-147-229-249.compute-1.amazonaws.com');
  expect(ec2.CustomOriginConfig.OriginProtocolPolicy).toBe('http-only');
  expect(ec2.OriginCustomHeaders).toEqual([
    { HeaderName: 'X-Shinro-Origin', HeaderValue: '{{resolve:secretsmanager:shinro-live/edge/origin-secret:SecretString:::}}' },
  ]);
});

test.each(APP_PATHS)('%s: never cached, everything forwarded (5.22)', (p) => {
  expect(behaviour(p)).toMatchObject({ CachePolicyId: CACHING_DISABLED, OriginRequestPolicyId: ALL_VIEWER });
  expect(behaviour(p).AllowedMethods).toHaveLength(7);
});

test('/assets/* cached, keyed by host so streams never share a build', () => {
  template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
    CachePolicyConfig: { ParametersInCacheKeyAndForwardedToOrigin: { HeadersConfig: { HeaderBehavior: 'whitelist', Headers: ['Host'] } } },
  });
  expect(behaviour('/assets/*').CachePolicyId).not.toBe(CACHING_DISABLED);
});

test('default: private S3 through OAC, host-to-folder function', () => {
  expect(dist.DefaultCacheBehavior.FunctionAssociations[0].EventType).toBe('viewer-request');
  template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
  });
});

test('HTTP redirects to HTTPS everywhere', () => {
  for (const b of [dist.DefaultCacheBehavior, ...dist.CacheBehaviors]) expect(b.ViewerProtocolPolicy).toBe('redirect-to-https');
});

describe('host-to-folder function', () => {
  const handler = new Function(`${HOST_TO_FOLDER}; return handler;`)();
  const route = (uri: string, host = 'Temporal.Shinro.ai') => handler({ request: { uri, headers: { host: { value: host } } } }).uri;
  test.each([
    ['/', '/temporal.shinro.ai/index.html'],
    ['/pricing', '/temporal.shinro.ai/pricing/index.html'],
    ['/pricing/', '/temporal.shinro.ai/pricing/index.html'],
    ['/img/logo.png', '/temporal.shinro.ai/img/logo.png'],
  ])('%s -> %s', (uri, expected) => expect(route(uri)).toBe(expected));
});
