import * as cdk from 'aws-cdk-lib/core';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { DOMAIN, IDENTITY, LiveConfig, PREFIX, REGION, SES_VERIFIED_CONTEXT_KEY, streamHosts } from '../config';
import { SsmParams } from '../constructs/ssm-params';

export interface IdentityStackProps extends cdk.StackProps {
  readonly config: LiveConfig;
  /** People emailed for each bounce or complaint (the alarm recipients). Each confirms once by email. */
  readonly feedbackEmails?: readonly string[];
}

/** Actions the onboarding team may take, on the demo pool only (PLAN 1.8). */
export const USER_ADMIN_ACTIONS = [
  'AdminCreateUser',
  'AdminAddUserToGroup',
  'AdminRemoveUserFromGroup',
  'AdminListGroupsForUser',
  'AdminSetUserPassword',
  'AdminDisableUser',
  'AdminEnableUser',
  'AdminUserGlobalSignOut',
  'AdminDeleteUser',
  'AdminGetUser',
  'ListUsers',
].map((a) => `cognito-idp:${a}`);

/**
 * Step 2: one demo user pool for every stream, one group and one oauth2-proxy
 * app client per stream (PLAN-v2 Stack 3, decision 4.2; supersedes T-13).
 *
 * Passwordless sign-in needs six settings (PLAN 1.7). Five are set here; the
 * sixth (email_verified) is set per user by the onboarding runbook. Email-code
 * sign-in and the SES sender switch on once `shinro:sesDomainVerified` is true.
 *
 * shinro.ai's DNS is at Cloudflare, not Route 53, so this stack can't write the
 * DKIM records: it prints them as outputs to add there by hand.
 *
 * Client secrets are not copied into Secrets Manager: the Shinro host reads
 * them at boot with DescribeUserPoolClient (decided here, PLAN-v2 Stack 3).
 */
export class IdentityStack extends cdk.Stack {
  readonly pool: cognito.UserPool;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    const { streams, sesDomainVerified } = props.config;

    // ---- SES bounces and complaints ----
    // The account suppression list already stops mail to addresses that bounced
    // or complained. This tells us, so the user can be fixed or removed in
    // Cognito (runbook: docs/CDK-STEPS.md step 2a, "Bounces and complaints").
    // Delivery events are left out: one email per sign-in would be noise.
    const feedbackTopic = new sns.Topic(this, 'EmailFeedback', {
      topicName: `${PREFIX}-email-feedback`,
      displayName: 'Shinro live: email bounces and complaints',
      enforceSSL: true,
    });
    cdk.Validations.of(feedbackTopic).acknowledge({
      id: 'AwsSolutions::AwsSolutions-SNS2',
      reason: 'SES cannot publish to a topic encrypted with the AWS-managed SNS key; messages hold a recipient address and SMTP status only.',
    });
    for (const email of props.feedbackEmails ?? []) feedbackTopic.addSubscription(new subscriptions.EmailSubscription(email));

    const emailEvents = new ses.ConfigurationSet(this, 'EmailEvents', {
      configurationSetName: IDENTITY.sesConfigurationSet,
      reputationMetrics: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    emailEvents.addEventDestination('BouncesAndComplaints', {
      destination: ses.EventDestination.snsTopic(feedbackTopic),
      events: [
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.RENDERING_FAILURE,
      ],
    });

    // ---- SES: send codes as no-reply@shinro.ai, signed with DKIM ----
    const sender = new ses.EmailIdentity(this, 'SenderDomain', {
      identity: ses.Identity.domain(DOMAIN),
      configurationSet: emailEvents, // default for every send from the domain
    });

    // ---- The pool ----
    this.pool = new cognito.UserPool(this, 'Pool', {
      userPoolName: IDENTITY.poolName,
      featurePlan: cognito.FeaturePlan.ESSENTIALS, // requirement 1
      // Requirement 2. The password factor can't be switched off, but nobody has
      // one: users are created without a password (runbook, PLAN 1.8).
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: sesDomainVerified } },
      // Requirement 3.
      email: sesDomainVerified
        ? cognito.UserPoolEmail.withSES({
            fromEmail: IDENTITY.fromEmail,
            fromName: IDENTITY.fromName,
            sesRegion: REGION,
            sesVerifiedDomain: DOMAIN,
            configurationSetName: emailEvents.configurationSetName,
          })
        : cognito.UserPoolEmail.withCognito(),
      selfSignUpEnabled: false, // admin-create only (PLAN 1.8)
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: { email: { required: true, mutable: true } },
      accountRecovery: cognito.AccountRecovery.NONE,
      passwordPolicy: {
        minLength: 16,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OFF,
      deletionProtection: true,
      // Every demo customer across every stream lives here (gotcha 5.12).
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    for (const [rule, reason] of [
      ['AwsSolutions-COG2', 'Passwordless: the emailed one-time code is the factor. A second factor would block prospects.'],
      ['AwsSolutions-COG8', 'Threat protection needs the Plus plan; not worth it for an invite-only demo pool.'],
    ]) {
      cdk.Validations.of(this.pool).acknowledge({ id: `AwsSolutions::${rule}`, reason });
    }

    // Requirement 4: the newer Managed Login, the only one with passwordless screens.
    const domain = this.pool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `${IDENTITY.poolName}-${this.account}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // ---- Quest1 staff: both real and demo migrations ----
    // Not per stream, and not handed out from a demo request (IDENTITY.staffGroup).
    new cognito.UserPoolGroup(this, 'GroupStaff', {
      userPool: this.pool,
      groupName: IDENTITY.staffGroup,
      description: 'Quest1 staff: real migrations as well as the demo (app Role.DEVELOPER)',
    });

    // ---- Per stream: a group, an app client, a cookie secret ----
    const streamParams: Record<string, string> = {};
    for (const stream of streams) {
      new cognito.UserPoolGroup(this, `Group-${stream.name}`, {
        userPool: this.pool,
        groupName: stream.name,
        description: `Access to the ${stream.name} demo at ${stream.subdomain}`,
      });

      // Construct id is permanent: renaming it recreates the client (gotcha 5.11).
      const client = this.pool.addClient(`OAuth2Proxy-${stream.name}`, {
        userPoolClientName: `oauth2-proxy-${stream.name}`,
        generateSecret: true,
        authFlows: { user: true }, // requirement 5: ALLOW_USER_AUTH
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
          // One per hostname oauth2-proxy can start a login from (gotcha 5.23).
          callbackUrls: streamHosts(stream).map((h) => `https://${h}/oauth2/callback`),
          logoutUrls: streamHosts(stream).map((h) => `https://${h}/`),
        },
        supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
        preventUserExistenceErrors: true,
        accessTokenValidity: cdk.Duration.hours(1),
        idTokenValidity: cdk.Duration.hours(1),
        refreshTokenValidity: cdk.Duration.hours(IDENTITY.sessionHours),
      });

      // Managed Login needs a style per app client. Cognito's default look for
      // now; the logo and "the code expires in a few minutes" line come later (4.13).
      const branding = new cognito.CfnManagedLoginBranding(this, `Branding-${stream.name}`, {
        userPoolId: this.pool.userPoolId,
        clientId: client.userPoolClientId,
        useCognitoProvidedValues: true,
      });
      branding.node.addDependency(domain);

      // Its own cookie secret, so one stream's proxy can't read another's cookie.
      const cookieSecret = new secretsmanager.Secret(this, `CookieSecret-${stream.name}`, {
        secretName: `${PREFIX}/oauth2-proxy/${stream.name}/cookie-secret`,
        description: `oauth2-proxy cookie secret for the ${stream.name} stream`,
        // 32 characters = a 32-byte AES key, which oauth2-proxy requires.
        generateSecretString: { passwordLength: 32, excludePunctuation: true },
      });
      cdk.Validations.of(cookieSecret).acknowledge({
        id: 'AwsSolutions::AwsSolutions-SMG4',
        reason: 'Rotating it signs every user out; done by hand if ever needed.',
      });

      streamParams[`streams/${stream.name}/client-id`] = client.userPoolClientId;
      streamParams[`streams/${stream.name}/group`] = stream.name;
      streamParams[`streams/${stream.name}/cookie-secret-arn`] = cookieSecret.secretArn;
    }

    // ---- The Shinro API's own login (core/oauth/cognito.py, /v2/oauth/callback) ----
    // oauth2-proxy guards only the two consoles; the app signs users in itself.
    // One client for every stream's page. Construct id is permanent (gotcha 5.11).
    const apiClient = this.pool.addClient('ShinroApi', {
      userPoolClientName: 'shinro-api',
      generateSecret: true,
      authFlows: { user: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: streams.map((st) => `https://${st.subdomain}/v2/oauth/callback`),
        logoutUrls: streams.map((st) => `https://${st.subdomain}/`),
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.hours(IDENTITY.sessionHours),
    });
    new cognito.CfnManagedLoginBranding(this, 'Branding-shinro-api', {
      userPoolId: this.pool.userPoolId,
      clientId: apiClient.userPoolClientId,
      useCognitoProvidedValues: true,
    }).node.addDependency(domain);
    streamParams['api-client-id'] = apiClient.userPoolClientId;

    // ---- The onboarding role (PLAN 1.8): manage users, on this pool only ----
    const userAdmin = new iam.Role(this, 'UserAdmin', {
      roleName: `${PREFIX}-user-admin`,
      description: 'Adds and removes demo users in the shinro-live-demo pool only',
      assumedBy: new iam.AccountRootPrincipal(),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    userAdmin.addToPolicy(new iam.PolicyStatement({ actions: USER_ADMIN_ACTIONS, resources: [this.pool.userPoolArn] }));

    // ---- Read by the Shinro host at boot ----
    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${this.pool.userPoolId}`;
    new SsmParams(this, 'Params', 'identity', {
      'pool-id': this.pool.userPoolId,
      'pool-arn': this.pool.userPoolArn,
      'issuer-url': issuer,
      'login-url': domain.baseUrl(),
      ...streamParams,
    });

    // ---- What to do by hand ----
    new cdk.CfnOutput(this, 'PoolId', { value: this.pool.userPoolId });
    new cdk.CfnOutput(this, 'UserAdminRoleArn', { value: userAdmin.roleArn });
    sender.dkimRecords.forEach((record, i) => {
      new cdk.CfnOutput(this, `CloudflareDkim${i + 1}`, {
        description: 'Add in Cloudflare: CNAME, DNS only (grey cloud)',
        value: cdk.Fn.join(' -> ', [record.name, record.value]),
      });
    });
    new cdk.CfnOutput(this, 'CloudflareDmarc', {
      description: 'Add in Cloudflare: TXT record',
      // p=none only reports; move to quarantine once reports show nothing else sends as shinro.ai.
      value: `_dmarc.${DOMAIN} -> "v=DMARC1; p=none; rua=mailto:<a team mailbox>"`,
    });
    new cdk.CfnOutput(this, 'NextStep', {
      value: sesDomainVerified
        ? 'Email-code sign-in is on. Request SES production access if not done.'
        : `After SES shows ${DOMAIN} as verified, set "${SES_VERIFIED_CONTEXT_KEY}": true in cdk.json and deploy again.`,
    });
  }
}
