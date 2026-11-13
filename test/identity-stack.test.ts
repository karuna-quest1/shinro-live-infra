import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { IDENTITY, LiveConfig, parseStreams } from '../lib/config';
import { IdentityStack, USER_ADMIN_ACTIONS } from '../lib/stacks/identity-stack';

const env = { account: '111111111111', region: 'us-east-1' };
const temporal = {
  name: 'temporal',
  subdomain: 'temporal.shinro.ai',
  consoles: ['camunda-demo.shinro.ai', 'temporal-demo.shinro.ai'],
};

function synth(config: Partial<LiveConfig> = {}): Template {
  const app = new cdk.App();
  const full: LiveConfig = { streams: parseStreams([temporal]), sesDomainVerified: false, ...config };
  return Template.fromStack(new IdentityStack(app, 'Identity', { env, config: full }));
}

const ofType = (t: Template, type: string) =>
  Object.entries(t.toJSON().Resources as Record<string, any>).filter(([, r]) => r.Type === type);

const before = synth();
const after = synth({ sesDomainVerified: true });

describe('the demo pool', () => {
  test('one pool, Essentials, admin-create only, kept if the stack is deleted (5.12)', () => {
    before.resourceCountIs('AWS::Cognito::UserPool', 1);
    before.hasResource('AWS::Cognito::UserPool', {
      Properties: {
        UserPoolName: 'shinro-live-demo',
        UserPoolTier: 'ESSENTIALS',
        DeletionProtection: 'ACTIVE',
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      },
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('before SES is verified: Cognito sender, no email codes yet', () => {
    before.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: { SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] } },
      EmailConfiguration: { EmailSendingAccount: 'COGNITO_DEFAULT' },
    });
  });

  test('after: email-code sign-in through SES as no-reply@shinro.ai', () => {
    after.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: { SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'] } },
      EmailConfiguration: { EmailSendingAccount: 'DEVELOPER' },
    });
    const pool = ofType(after, 'AWS::Cognito::UserPool')[0][1].Properties;
    expect(pool.EmailConfiguration.From).toContain('no-reply@shinro.ai');
    expect(JSON.stringify(pool.EmailConfiguration.SourceArn)).toContain('identity/shinro.ai');
  });

  test('flipping the SES switch keeps the same pool (no replacement)', () => {
    expect(ofType(after, 'AWS::Cognito::UserPool')[0][0]).toBe(ofType(before, 'AWS::Cognito::UserPool')[0][0]);
  });

  test('Managed Login domain, newer version (requirement 4)', () => {
    before.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'shinro-live-demo-111111111111',
      ManagedLoginVersion: 2,
    });
  });

  test('SES identity for shinro.ai', () => {
    before.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: 'shinro.ai' });
  });
});

describe('the staff group', () => {
  test('developer exists, alongside the stream group and no others', () => {
    before.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'developer' });
    before.resourceCountIs('AWS::Cognito::UserPoolGroup', 2);
  });

  test('its name is the one core/rbac.py maps to Role.DEVELOPER', () => {
    // Lowercase: map_groups_to_roles lowercases the group before the lookup.
    expect(IDENTITY.staffGroup).toBe('developer');
  });

  test('it is created once, not per stream', () => {
    const two = synth({ streams: parseStreams([temporal, { name: 'next', subdomain: 'next.shinro.ai' }]) });
    expect(ofType(two, 'AWS::Cognito::UserPoolGroup').map(([, r]) => r.Properties.GroupName).sort())
      .toEqual(['developer', 'next', 'temporal']);
  });
});

describe('per stream', () => {
  test('a group named after the stream', () => {
    before.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'temporal' });
  });

  test('oauth2-proxy client: code flow, secret, ALLOW_USER_AUTH, every host as callback (5.23)', () => {
    before.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'oauth2-proxy-temporal',
      GenerateSecret: true,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: ['openid', 'email', 'profile'],
      ExplicitAuthFlows: ['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      CallbackURLs: [
        'https://temporal.shinro.ai/oauth2/callback',
        'https://camunda-demo.shinro.ai/oauth2/callback',
        'https://temporal-demo.shinro.ai/oauth2/callback',
      ],
    });
  });

  test('a Managed Login branding per client (each stream proxy + the API)', () => {
    before.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 2);
  });

  test('its own cookie secret', () => {
    before.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'shinro-live/oauth2-proxy/temporal/cookie-secret',
      GenerateSecretString: { PasswordLength: 32 },
    });
  });

  test("the API's own client: callback on every stream page", () => {
    before.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'shinro-api',
      GenerateSecret: true,
      AllowedOAuthFlows: ['code'],
      ExplicitAuthFlows: ['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      CallbackURLs: ['https://temporal.shinro.ai/v2/oauth/callback'],
    });
    before.hasResourceProperties('AWS::SSM::Parameter', { Name: '/shinro/live/identity/api-client-id' });
  });

  test('adding a stream leaves the existing client untouched (5.11)', () => {
    const two = synth({
      streams: parseStreams([temporal, { name: 'next', subdomain: 'next.shinro.ai' }]),
    });
    const ids = (t: Template) => ofType(t, 'AWS::Cognito::UserPoolClient').map(([id]) => id);
    expect(ids(two)).toEqual(expect.arrayContaining(ids(before)));
    two.resourceCountIs('AWS::Cognito::UserPoolClient', 3);
    two.resourceCountIs('AWS::Cognito::UserPool', 1);
    two.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'next' });
  });

  test('publishes client id, group and cookie secret ARN to SSM', () => {
    for (const name of ['client-id', 'group', 'cookie-secret-arn']) {
      before.hasResourceProperties('AWS::SSM::Parameter', { Name: `/shinro/live/identity/streams/temporal/${name}` });
    }
    for (const name of ['pool-id', 'issuer-url', 'login-url']) {
      before.hasResourceProperties('AWS::SSM::Parameter', { Name: `/shinro/live/identity/${name}` });
    }
  });
});

test('user-admin role: only the runbook actions, only on the demo pool', () => {
  before.hasResourceProperties('AWS::IAM::Role', { RoleName: 'shinro-live-user-admin' });
  const [, policy] = ofType(before, 'AWS::IAM::Policy')[0];
  const statements = policy.Properties.PolicyDocument.Statement;
  expect(statements).toHaveLength(1);
  expect([...statements[0].Action].sort()).toEqual([...USER_ADMIN_ACTIONS].sort());
  expect(JSON.stringify(statements[0].Resource)).toContain('PoolD3F588B8');
});

describe('bounces and complaints', () => {
  const t = synth({ sesDomainVerified: true });

  test('one configuration set, default for the domain and used by Cognito', () => {
    t.hasResourceProperties('AWS::SES::ConfigurationSet', {
      Name: IDENTITY.sesConfigurationSet,
      ReputationOptions: { ReputationMetricsEnabled: true },
      SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
    });
    t.hasResourceProperties('AWS::SES::EmailIdentity', {
      ConfigurationSetAttributes: { ConfigurationSetName: { Ref: Match.stringLikeRegexp('^EmailEvents') } },
    });
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      EmailConfiguration: { ConfigurationSet: { Ref: Match.stringLikeRegexp('^EmailEvents') } },
    });
  });

  test('bounce, complaint, reject and rendering failure go to the feedback topic; deliveries do not', () => {
    const [, dest] = ofType(t, 'AWS::SES::ConfigurationSetEventDestination')[0];
    const d = dest.Properties.EventDestination;
    expect(d.Enabled).not.toBe(false);
    expect([...d.MatchingEventTypes].sort()).toEqual(['bounce', 'complaint', 'reject', 'renderingFailure']);
    expect(d.SnsDestination.TopicARN).toEqual({ Ref: expect.stringMatching(/^EmailFeedback/) });
    t.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'shinro-live-email-feedback' });
  });

  test('feedback emails subscribe to the topic', () => {
    const app = new cdk.App();
    const full: LiveConfig = { streams: parseStreams([temporal]), sesDomainVerified: true };
    const s = Template.fromStack(new IdentityStack(app, 'IdFb', { env, config: full, feedbackEmails: ['ops@example.com'] }));
    s.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
  });
});
