import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { parseStreams } from '../lib/config';
import { EdgeStack, HOST_TO_FOLDER } from '../lib/stacks/edge-stack';

const streams = parseStreams([
  { name: 'temporal', subdomain: 'temporal.shinro.ai', consoles: ['camunda-demo.shinro.ai'] },
  { name: 'next', subdomain: 'next.shinro.ai' },
]);
const app = new cdk.App();
const template = Template.fromStack(
  new EdgeStack(app, 'Edge', { env: { account: '111111111111', region: 'us-east-1' }, config: { streams, sesDomainVerified: false } }),
);
const env = { account: '111111111111', region: 'us-east-1' };
const distributions = Object.values(template.toJSON().Resources as Record<string, any>)
  .filter((r) => r.Type === 'AWS::CloudFront::Distribution')
  .map((r) => r.Properties.DistributionConfig);
const withAlias = (host: string) => distributions.find((d) => d.Aliases.includes(host));
const dist = withAlias('temporal.shinro.ai');
const consoleDist = withAlias('camunda-demo.shinro.ai');
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

test('default: the app on the EC2, never cached, everything forwarded (5.22)', () => {
  // Everything but /assets/* is the app: /, /auth/callback (login return),
  // /settings/:tab, /chat/:id ... would 403 from an empty landing bucket.
  const ec2 = dist.Origins.find((o: any) => o.DomainName === 'ec2-54-147-229-249.compute-1.amazonaws.com');
  expect(dist.DefaultCacheBehavior).toMatchObject({
    TargetOriginId: ec2.Id, CachePolicyId: CACHING_DISABLED, OriginRequestPolicyId: ALL_VIEWER, Compress: false,
  });
  expect(dist.DefaultCacheBehavior.AllowedMethods).toHaveLength(7);
  expect(dist.DefaultCacheBehavior.FunctionAssociations).toBeUndefined();
  expect(dist.CacheBehaviors.map((b: any) => b.PathPattern)).toEqual(['/assets/*']);
});


test('/assets/* cached, keyed by host so streams never share a build', () => {
  template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
    CachePolicyConfig: { ParametersInCacheKeyAndForwardedToOrigin: { HeadersConfig: { HeaderBehavior: 'whitelist', Headers: ['Host'] } } },
  });
  expect(behaviour('/assets/*').CachePolicyId).not.toBe(CACHING_DISABLED);
});

test('landing page parts kept for later: private site bucket and host-to-folder function, nothing routed to them', () => {
  template.resourceCountIs('AWS::CloudFront::Function', 1);
  template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 0);
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/shinro/live/edge/site-bucket' });
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

describe('console distribution', () => {
  test('consoles get their own distribution: aliases are exactly the consoles', () => {
    expect(consoleDist.Aliases).toEqual(['camunda-demo.shinro.ai']);
    expect(dist.Aliases).not.toContain('camunda-demo.shinro.ai');
  });

  test('default behaviour: EC2 origin, never cached, everything forwarded, all methods, https only', () => {
    expect(consoleDist.DefaultCacheBehavior).toMatchObject({
      CachePolicyId: CACHING_DISABLED,
      OriginRequestPolicyId: ALL_VIEWER,
      ViewerProtocolPolicy: 'redirect-to-https',
    });
    expect(consoleDist.DefaultCacheBehavior.AllowedMethods).toHaveLength(7);
    // Operate and the Temporal UI set their own frame and CSP headers.
    expect(consoleDist.DefaultCacheBehavior.ResponseHeadersPolicyId).toBeUndefined();
    expect(consoleDist.CacheBehaviors ?? []).toEqual([]);
  });

  test('origin: same EC2 name, :80, origin secret resolved at deploy, 60 s read timeout', () => {
    expect(consoleDist.Origins).toHaveLength(1);
    const o = consoleDist.Origins[0];
    expect(o.DomainName).toBe('ec2-54-147-229-249.compute-1.amazonaws.com');
    expect(o.CustomOriginConfig).toMatchObject({ OriginProtocolPolicy: 'http-only', HTTPPort: 80, OriginReadTimeout: 60 });
    expect(o.OriginCustomHeaders).toEqual([
      { HeaderName: 'X-Shinro-Origin', HeaderValue: '{{resolve:secretsmanager:shinro-live/edge/origin-secret:SecretString:::}}' },
    ]);
  });

  test('the existing certificate, TLS 1.2 or newer', () => {
    expect(consoleDist.ViewerCertificate).toMatchObject({
      AcmCertificateArn: expect.stringContaining('certificate/6652dafb'),
      MinimumProtocolVersion: 'TLSv1.2_2021',
      SslSupportMethod: 'sni-only',
    });
  });

  test('id and domain published to SSM for alarms and the runbook', () => {
    for (const name of ['/shinro/live/edge/console-distribution-id', '/shinro/live/edge/console-distribution-domain']) {
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: name });
    }
  });

  test('no consoles anywhere: no console distribution, no console parameters', () => {
    const t = Template.fromStack(
      new EdgeStack(new cdk.App(), 'NoConsoles', {
        env,
        config: { streams: parseStreams([{ name: 'next', subdomain: 'next.shinro.ai' }]), sesDomainVerified: false },
      }),
    );
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
    expect(JSON.stringify(t.toJSON())).not.toContain('console-distribution');
  });
});
