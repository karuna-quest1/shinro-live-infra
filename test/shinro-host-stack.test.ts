import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { INITIAL_RELEASE, parseStreams } from '../lib/config';
import { SHINRO_BUNDLE_DIR, ShinroHostStack } from '../lib/stacks/shinro-host-stack';

const streams = parseStreams([
  { name: 'temporal', subdomain: 'temporal.shinro.ai', consoles: ['camunda-demo.shinro.ai', 'temporal-demo.shinro.ai'] },
]);
const app = new cdk.App();
const stack = new ShinroHostStack(app, 'Shinro', {
  env: { account: '111111111111', region: 'us-east-1' },
  config: { streams, sesDomainVerified: false },
});
const template = Template.fromStack(stack);
const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: any }>;
const ofType = (type: string) => Object.values(resources).filter((r) => r.Type === type);
const instance = ofType('AWS::EC2::Instance')[0].Properties;

describe('instance', () => {
  test('public subnet, three security groups, tagged for CI releases', () => {
    expect(JSON.stringify(instance.SubnetId)).toContain('publicsubnetids');
    expect(JSON.stringify(instance.SecurityGroupIds)).toMatch(/sgshinrohost.*sgshinrocf.*sgshinropublic/);
    expect(instance.Tags).toContainEqual({ Key: 'shinro-live:role', Value: 'shinro-host' });
  });

  test('IMDSv2 with hop limit 2, so the API container can use the instance role', () => {
    expect(instance.MetadataOptions).toEqual({ HttpTokens: 'required', HttpPutResponseHopLimit: 2 });
  });

  test('UserData is a fixed string (bundle edits never replace the server)', () => {
    expect(typeof instance.UserData['Fn::Base64']).toBe('string');
  });

  test('reuses the existing Elastic IP', () => {
    template.hasResourceProperties('AWS::EC2::EIPAssociation', { AllocationId: 'eipalloc-05ca28a7b9ce7ad74' });
    template.resourceCountIs('AWS::EC2::EIP', 0);
  });

  test("role name matches the EKS access entry", () => {
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'shinro-live-shinro-host' });
  });
});

test('UI bucket: private, readable only from inside the VPC, HTTPS only', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
  });
  const statements = ofType('AWS::S3::BucketPolicy')[0].Properties.PolicyDocument.Statement;
  const read = statements.find((s: any) => s.Sid === 'ReadFromTheVpcOnly');
  expect(read.Action).toBe('s3:GetObject');
  expect(JSON.stringify(read.Condition)).toContain('aws:SourceVpc');
  expect(statements.some((s: any) => s.Effect === 'Deny' && JSON.stringify(s.Condition).includes('SecureTransport'))).toBe(true);
});

test('role can read only named secrets, never all of Secrets Manager', () => {
  const policy = JSON.stringify(ofType('AWS::IAM::Policy')[0].Properties.PolicyDocument);
  expect(policy).not.toMatch(/secret:\*"/);
  expect(policy).not.toMatch(/"secretsmanager:\*"|"ssm:\*"|"ecr:\*"/);
});

describe('the reports bucket', () => {
  test('private, encrypted, kept if the stack is deleted', () => {
    template.hasResource('AWS::S3::Bucket', {
      Properties: {
        BucketName: 'shinro-live-docs-111111111111',
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
        },
      },
      DeletionPolicy: 'Retain',
    });
  });

  test('no bucket policy opens it up the way the UI bucket is opened to the VPC', () => {
    const docs = Object.entries(resources).find(([, r]) => r.Properties?.BucketName === 'shinro-live-docs-111111111111')![0];
    const policies = ofType('AWS::S3::BucketPolicy').filter((r) => JSON.stringify(r.Properties.Bucket).includes(docs));
    // enforceSSL adds a deny-insecure policy; there must be no Allow.
    for (const p of policies) {
      for (const st of p.Properties.PolicyDocument.Statement) expect(st.Effect).toBe('Deny');
    }
  });

  test('the instance role can read and write it', () => {
    const docs = Object.entries(resources).find(([, r]) => r.Properties?.BucketName === 'shinro-live-docs-111111111111')![0];
    const statements = ofType('AWS::IAM::Policy')
      .flatMap((r) => r.Properties.PolicyDocument.Statement as any[])
      .filter((st) => JSON.stringify(st.Resource).includes(docs));
    const actions = statements.flatMap((st) => (Array.isArray(st.Action) ? st.Action : [st.Action]));
    for (const a of ['s3:GetObject', 's3:PutObject', 's3:DeleteObject*', 's3:Abort*']) {
      expect(actions.some((x: string) => x === a || x === `${a}*`)).toBe(true);
    }
  });
});

describe('render.py (with a fake AWS CLI)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  const bundle = path.join(dir, 'bundle');
  fs.cpSync(SHINRO_BUNDLE_DIR, bundle, { recursive: true });
  fs.rmSync(path.join(bundle, 'run'), { recursive: true, force: true });

  // The config parameter exactly as CloudFormation would store it.
  const configParam = ofType('AWS::SSM::Parameter').find((r) => r.Properties.Name === '/shinro/live/shinro/config')!;
  // Two buckets are referenced now, so resolve each Ref to its own name
  // rather than assuming every token is the UI bucket.
  const config = (configParam.Properties.Value['Fn::Join'][1] as unknown[])
    .map((part) => {
      if (typeof part === 'string') return part;
      const ref = (part as { Ref?: string }).Ref;
      const name = ref && resources[ref]?.Properties?.BucketName;
      if (!name) throw new Error(`config has an unresolved token: ${JSON.stringify(part)}`);
      return name as string;
    })
    .join('');
  const state = {
    params: {
      '/shinro/live/shinro/config': config,
      '/shinro/live/streams': JSON.stringify(streams),
      '/shinro/live/camunda-private-ip': '10.60.20.5',
    },
    paths: {
      '/shinro/live/identity': {
        'pool-id': 'us-east-1_TEST', 'issuer-url': 'https://issuer', 'login-url': 'https://login',
        'api-client-id': 'apiclient', 'streams/temporal/client-id': 'proxyclient',
        'streams/temporal/group': 'temporal', 'streams/temporal/cookie-secret-arn': 'arn:cookie',
      },
      '/shinro/live/release': {},
    },
    secrets: {
      'arn:cookie': 'c'.repeat(32),
      'shinro-live/camunda/shinro-assessment-client-secret': 'assess',
      // As long as the real one (48), so map sizing problems show up in nginx -t.
      'shinro-live/edge/origin-secret': 'o'.repeat(48),
      'shinro-live/shinro/api-env': '{"LLM_API_KEY":"k","FRONTEND_URL":"https://override.shinro.ai"}',
      'shinro-live/shinro/tool-exec-env': '{}',
      'shinro-live/shinro/temporal-ui-route-secret': 'r'.repeat(48),
      'shinro-live/shinro/auth-secret': 'a'.repeat(44),
    },
  };
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const bin = path.join(dir, 'fakebin');
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-aws.py'), path.join(bin, 'aws'));
  fs.chmodSync(path.join(bin, 'aws'), 0o755);

  execFileSync('python3', [path.join(bundle, 'bin', 'render.py')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_AWS_STATE: stateFile, RENDER_LOCAL_IP: '10.60.0.10' },
    stdio: 'pipe',
  });
  const run = (f: string) => fs.readFileSync(path.join(bundle, 'run', f), 'utf8');
  const env = (f: string) => Object.fromEntries(run(f).trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  test('the API gets AUTH_SECRET, or every encrypted save returns 503', () => {
    // Without it redis_repo disables encryption: Camunda configs and LLM
    // credentials cannot be stored. Regression, 2026-11-12.
    expect(env('api.env').AUTH_SECRET).toBe('a'.repeat(44));
  });

  test('both env files name the reports bucket, or the inventory tool refuses to run', () => {
    // camunda_inventory_fetcher.py returns "S3 bucket not configured." without it.
    expect(env('api.env').DOC_BUCKET_NAME).toBe('shinro-live-docs-111111111111');
    expect(env('tool-exec.env').DOC_BUCKET_NAME).toBe('shinro-live-docs-111111111111');
  });

  test('app images by digest from the initial release', () => {
    expect(env('images.env').API_IMAGE).toBe(`111111111111.dkr.ecr.us-east-1.amazonaws.com/${INITIAL_RELEASE.images.api}`);
  });

  test("API settings, with the app team's secret winning", () => {
    const api = env('api.env');
    expect(api.DEMO_KUBECONFIG).toBeUndefined();
    expect(api).toMatchObject({
      COGNITO_USER_POOL_ID: 'us-east-1_TEST',
      COGNITO_CLIENT_SECRET: 'secret-for-apiclient',
      DEMO_CAMUNDA_CLIENT_ID: 'shinro-assessment',
      DEMO_CAMUNDA_ZEEBE_ADDRESS: 'grpc://10.60.20.5:26500',
      DEMO_SESSION_CONTROLLER: 'kubernetes',
      DEMO_TEMPORAL_ADDRESS: 'temporal:7233',
      // Switched on by the backend's changes (commit 4b1c5d3f).
      DEMO_EKS_CLUSTER: 'shinro-live',
      DEMO_EKS_REGION: 'us-east-1',
      DEMO_SANDBOX_NODE_POOL: 'sandbox',
      DEMO_SESSION_API_URL: 'https://temporal.shinro.ai/v2',
      DEMO_CAMUNDA_CONSOLE_URL: 'https://camunda-demo.shinro.ai/operate',
      DEMO_TEMPORAL_UI_ROUTE_SECRET: 'r'.repeat(48),
      DEMO_METRICS_NAMESPACE: 'ShinroLive/App',
      API_DOCS_ENABLED: 'false',
      LLM_API_KEY: 'k',
      SEMANTIC_CACHE_REDIS_URL: 'redis://redis:6379/0',
      FRONTEND_URL: 'https://override.shinro.ai',
    });
  });

  test('secret files are root-only', () => {
    for (const f of ['api.env', 'tool-exec.env', 'oauth2-temporal.env']) {
      expect(fs.statSync(path.join(bundle, 'run', f)).mode & 0o077).toBe(0);
    }
  });

  test('oauth2-proxy per stream: own cookie, own group, .shinro.ai, 8 h', () => {
    expect(env('oauth2-temporal.env')).toMatchObject({
      OAUTH2_PROXY_COOKIE_NAME: '_shinro_temporal',
      OAUTH2_PROXY_ALLOWED_GROUPS: 'temporal',
      OAUTH2_PROXY_COOKIE_DOMAINS: '.shinro.ai',
      OAUTH2_PROXY_COOKIE_EXPIRE: '8h',
      OAUTH2_PROXY_OIDC_GROUPS_CLAIM: 'cognito:groups',
    });
  });

  test('oauth2-proxy sessions live in Redis, or a refreshed session answers 500', () => {
    expect(env('oauth2-temporal.env')).toMatchObject({
      OAUTH2_PROXY_SESSION_STORE_TYPE: 'redis',
      // Its own database: db 0 belongs to the app.
      OAUTH2_PROXY_REDIS_CONNECTION_URL: 'redis://redis:6379/2',
    });
    // It cannot come up before the store it keeps sessions in.
    const compose = JSON.parse(run('compose.streams.yaml'));
    expect(compose.services['oauth2-proxy-temporal'].depends_on).toEqual({
      redis: { condition: 'service_healthy' },
    });
  });

  test('both oauth2 locations have header room, or an oversized Set-Cookie is a 500', () => {
    const consoles = run('nginx/20-consoles.conf');
    // One pair per console host and listener: /oauth2/ and the internal /oauth2/auth.
    expect(consoles.match(/proxy_buffer_size 16k;/g)).toHaveLength(8);
    expect(consoles).toContain('proxy_busy_buffers_size 32k;');
  });

  test("Camunda's own login path outranks the oauth2-proxy prefix, or Operate shows only '202 Authenticated'", () => {
    const consoles = run('nginx/20-consoles.conf');
    // Longer prefix than /oauth2/, so nginx picks it; the proxy keeps its own endpoints.
    expect(consoles).toContain('location /oauth2/authorization/ {');
    const camundaLogin = consoles.slice(consoles.indexOf('location /oauth2/authorization/ {'));
    expect(camundaLogin).toContain('set $cam 10.60.20.5:8080;');
  });

  // The listen-80 server block for one console host, up to the next server block.
  const httpBlock = (c: string, host: string) => {
    const start = c.indexOf(`listen 80;\n  server_name ${host};`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = c.indexOf('\nserver {', start);
    return c.slice(start, end === -1 ? undefined : end);
  };

  test('consoles are served on :80 for CloudFront, origin-checked', () => {
    const c = run('nginx/20-consoles.conf');
    for (const host of ['camunda-demo.shinro.ai', 'temporal-demo.shinro.ai']) {
      expect(httpBlock(c, host)).toContain('if ($origin_ok = 0) { return 301 https://$host$request_uri; }');
    }
  });

  test('console :80 blocks tell upstreams the viewer used https, and pass WebSocket upgrades', () => {
    const http = httpBlock(run('nginx/20-consoles.conf'), 'camunda-demo.shinro.ai');
    expect(http).toContain('proxy_set_header X-Forwarded-Proto https;');
    expect(http).toContain('proxy_set_header Upgrade           $http_upgrade;');
  });

  test("console :80 blocks send relative redirects, or nginx's own `return 302 /operate` points browsers at http://", () => {
    for (const host of ['camunda-demo.shinro.ai', 'temporal-demo.shinro.ai']) {
      expect(httpBlock(run('nginx/20-consoles.conf'), host)).toContain('absolute_redirect off;');
    }
  });

  test('no separate plain-HTTP redirect server for console hosts any more', () => {
    expect(run('nginx/20-consoles.conf')).not.toContain('Plain HTTP on a console host goes to HTTPS');
  });

  test('nginx: origin check, docs hidden, identity headers stripped, consoles present', () => {
    const app = run('nginx/10-app.conf');
    expect(app).toContain('if ($origin_ok = 0) { return 403; }');
    expect(app).toMatch(/docs\|redoc\|openapi/);
    expect(app).toContain('proxy_set_header X-Auth-Request-Email "";');
    const consoles = run('nginx/20-consoles.conf');
    expect(consoles).toContain('server_name camunda-demo.shinro.ai;');
    expect(consoles).toContain('server_name temporal-demo.shinro.ai;');
    expect(consoles).toContain('set $kc 10.60.20.5:18080;');
    expect(consoles).toContain(`proxy_set_header X-Shinro-Route-Secret "${'r'.repeat(48)}";`);
    expect(consoles).toContain('"^/_temporal/(?<tip>10\\.60\\.[0-9]{1,3}\\.[0-9]{1,3})/');
  });
});
