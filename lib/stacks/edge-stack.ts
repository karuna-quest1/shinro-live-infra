import * as cdk from 'aws-cdk-lib/core';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EDGE, LiveConfig, PREFIX } from '../config';
import { SsmParams } from '../constructs/ssm-params';
import { SHINRO_SECRET_NAMES } from './shinro-host-stack';

export interface EdgeStackProps extends cdk.StackProps {
  readonly config: LiveConfig;
}

/** Paths served by the Shinro EC2 and never cached (PLAN 1.11, gotcha 5.22). */
export const APP_PATHS = ['/v2/*', '/chat', '/chat/*', '/login', '/settings'] as const;

/**
 * Viewer-request function on the default (S3) behaviour only: each hostname
 * has its own folder, and a path without a file name gets index.html.
 * temporal.shinro.ai/pricing -> s3://<site>/temporal.shinro.ai/pricing/index.html
 */
export const HOST_TO_FOLDER = `function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  var uri = request.uri;
  if (uri.endsWith('/')) {
    uri += 'index.html';
  } else if (uri.lastIndexOf('.') <= uri.lastIndexOf('/')) {
    uri += '/index.html';
  }
  request.uri = '/' + host + uri;
  return request;
}`;

/**
 * Step 5: the public front door (PLAN-v2 Stack 2), for every stream's hostname.
 *
 *   default      -> private S3 site bucket, one folder per hostname (the public page)
 *   /assets/*    -> the Shinro EC2, cached, keyed by host (each stream has its own UI build)
 *   app paths    -> the Shinro EC2, never cached, everything forwarded, WebSockets
 *
 * The two demo consoles don't come through here: they're A records straight to
 * the Shinro EC2 (decision 4.4).
 *
 * shinro.ai's DNS is at Cloudflare: no Route 53 here. The stack prints the
 * CNAME to add per stream. The certificate is the existing one.
 */
export class EdgeStack extends cdk.Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { streams } = props.config;

    // ---- The public pages ----
    const site = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `${PREFIX}-site-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    cdk.Validations.of(site).acknowledge({
      id: 'AwsSolutions::AwsSolutions-S1',
      reason: 'Public marketing pages; read only through CloudFront (OAC).',
    });

    // ---- The Shinro EC2 ----
    const shinro = new origins.HttpOrigin(EDGE.shinroOrigin, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      // nginx refuses :80 without it. Resolved by CloudFormation at deploy, never in the template.
      customHeaders: {
        [EDGE.originHeader]: cdk.SecretValue.secretsManager(SHINRO_SECRET_NAMES.originSecret).unsafeUnwrap(),
      },
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
    });

    const app: cloudfront.BehaviorOptions = {
      origin: shinro,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // Host, cookies, query strings, everything: nginx picks the stream by Host,
      // the app needs its login cookie, and the terminal is a WebSocket.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      compress: false,
    };

    // Each stream builds its own UI, so the cache key includes the host.
    const assetsCache = new cloudfront.CachePolicy(this, 'AssetsCache', {
      cachePolicyName: `${PREFIX}-assets-by-host`,
      comment: 'Built UI assets: hashed file names, cached long, keyed by host',
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Host'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      defaultTtl: cdk.Duration.days(1),
      maxTtl: cdk.Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${PREFIX}: stream pages and app`,
      domainNames: streams.map((s) => s.subdomain),
      certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', EDGE.certificateArn),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: new cloudfront.Function(this, 'HostToFolder', {
              functionName: `${PREFIX}-host-to-folder`,
              comment: 'Each hostname has its own folder in the site bucket',
              runtime: cloudfront.FunctionRuntime.JS_2_0,
              code: cloudfront.FunctionCode.fromInline(HOST_TO_FOLDER),
            }),
          },
        ],
      },
      additionalBehaviors: {
        ...Object.fromEntries(APP_PATHS.map((p) => [p, app])),
        '/assets/*': {
          origin: shinro,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // Host is in the cache key, so CloudFront forwards it: nginx picks the stream by it.
          cachePolicy: assetsCache,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
    });

    // ---- Published, and what to add in Cloudflare ----
    new SsmParams(this, 'Params', 'edge', {
      'distribution-id': this.distribution.distributionId,
      'distribution-domain': this.distribution.distributionDomainName,
      'site-bucket': site.bucketName,
    });
    new cdk.CfnOutput(this, 'CloudflareRecords', {
      description: 'Add in Cloudflare: CNAME, DNS only (grey cloud)',
      value: cdk.Fn.join(', ', streams.map((s) => `${s.subdomain.split('.')[0]} -> ${this.distribution.distributionDomainName}`)),
    });
    new cdk.CfnOutput(this, 'SiteBucketName', { value: site.bucketName });

    for (const [id, reason] of [
      ['AwsSolutions-CFR1', 'A public sales demo; no country restrictions.'],
      ['AwsSolutions-CFR2', 'No WAF yet: invite-only demo, the app requires login. Revisit before go-live.'],
      ['AwsSolutions-CFR3', 'Access logs not kept for the demo; nginx logs every app request.'],
      ['AwsSolutions-CFR5', 'The origin is the Shinro EC2 on :80 inside AWS, locked to CloudFront by prefix list and origin secret.'],
    ]) {
      cdk.Validations.of(this.distribution).acknowledge({ id: `AwsSolutions::${id}`, reason });
    }
  }
}
