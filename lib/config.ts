/**
 * Shared configuration for every Shinro live stack.
 *
 * Per-stream values come from the `shinro:streams` context in cdk.json, so
 * adding a stream is a config edit plus a deploy (PLAN §3.1). Everything else
 * that more than one stack needs lives here, in one place (PLAN 4.16).
 */

/** Everything is deployed here: CloudFront's certificate must be in us-east-1 (PLAN 5.14). */
export const REGION = 'us-east-1';

export const DOMAIN = 'shinro.ai';

/** The shared demo Camunda's browser hostname. Owned by the temporal stream (rule 4.1). */
export const CAMUNDA_PUBLIC_HOST = `camunda-demo.${DOMAIN}`;

/** Each user's own Temporal UI, routed by who is logged in (decision 4.6). Owned by the temporal stream. */
export const TEMPORAL_UI_PUBLIC_HOST = `temporal-demo.${DOMAIN}`;

/** Prefix for stack ids, resource names, ECR repos and log groups. `live`, never `demo` (PLAN 5.13). */
export const PREFIX = 'shinro-live';
export const STACK_PREFIX = 'ShinroLive';
export const SSM_PREFIX = '/shinro/live';

export const TAGS: Readonly<Record<string, string>> = {
  Project: PREFIX,
  ManagedBy: 'cdk',
};

/** Camunda 8.8.32, consolidated mode (PLAN 4.16, CAMUNDA-DEPLOYMENT §2). */
export const CAMUNDA_PORTS = {
  /** Operate, Tasklist, REST /v2, /sso-callback. Shinro SG only. */
  web: 8080,
  /** Zeebe gRPC. Shinro SG only. */
  zeebeGrpc: 26500,
  /** Keycloak: token calls and the browser login front channel. Shinro SG only. */
  keycloak: 18080,
  /** Instance-local only. */
  management: 9600,
  elasticsearch: 9200,
  identity: 8084,
  omsApp: 8090,
} as const;

export const SHINRO_PORTS = {
  http: 80,
  https: 443,
  /** shinro-api, inside the Shinro EC2 only. */
  api: 8000,
  oauth2Proxy: 4180,
} as const;

export const NODEPORT_RANGE = { from: 30000, to: 32767 } as const;

/**
 * Elastic IPs the account already owns, reused instead of allocating new ones
 * (the account is at its Elastic IP limit). CloudFormation never owns these,
 * so deleting a stack leaves them allocated.
 */
export const EXISTING_EIPS = {
  /** 3.212.142.142, formerly `q1-platform`. Outbound address of the private subnets. */
  nat: 'eipalloc-0e3b4fda5c095dacf',
  /** 54.147.229.249, formerly on `octavarium-tunnel-aws`. Shinro EC2, step 4; disassociate it first. */
  shinroHost: 'eipalloc-05ca28a7b9ce7ad74',
} as const;

export const SIZES = {
  shinroInstance: 'm7i.xlarge',
  shinroDiskGiB: 60,
  camundaInstance: 'm7i.xlarge',
  camundaDiskGiB: 100,
  eksNodeInstance: 'm7i.large',
  /** CoreDNS and add-ons only; sandboxes never run here. */
  eksSystemNodeInstance: 't3.medium',
  eksNodeDiskGiB: 80,
} as const;

export const EKS = {
  version: '1.36',
  /** Session namespaces the app creates: demo-<hex> (apps/api/etc/demo/session.yaml.tmpl). */
  sessionNamespacePattern: '^demo-[0-9a-f]{8,}$',
  /** The Shinro EC2's role (step 4). The access entry names it, so deploy step 4 before EKS. */
  shinroHostRoleName: 'shinro-live-shinro-host',
  /** Kubernetes group the Shinro EC2's access entry maps to. */
  sessionControllerGroup: 'shinro:session-controller',
  /** Sandbox nodes carry this taint and label; the session template tolerates and selects it. */
  sandboxTaint: { key: 'shinro.ai/sandbox', value: 'true' },
  nodePoolLabel: 'shinro.ai/pool',
  /** About 5 sessions per node by memory; 20 sessions need 4-5 (PLAN-v2 Stack 7). Set from the load test. */
  sandboxNodes: { min: 1, desired: 2, max: 5 },
} as const;

/**
 * The GitHub Actions pipeline that builds and releases the app images.
 * Only pushes to this one branch of this one repo can assume the CI role.
 */
export const GITHUB_CI = {
  repo: 'Quest1Codes/shinro',
  branch: 'camunda-temporal-deployment-main',
  /** Already in the account; one provider per issuer, so it is imported, never created. */
  oidcProviderArn: 'arn:aws:iam::425106880357:oidc-provider/token.actions.githubusercontent.com',
} as const;

/** The one demo user pool shared by every stream (decision 4.2, supersedes T-13). */
export const IDENTITY = {
  poolName: 'shinro-live-demo',
  fromEmail: `no-reply@${DOMAIN}`,
  fromName: 'Shinro',
  /** oauth2-proxy cookie and refresh token lifetime (PLAN 1.8). */
  sessionHours: 8,
  /**
   * Quest1 staff: real migrations as well as the demo. The app maps this exact
   * (lowercase) group name to Role.DEVELOPER itself, in core/rbac.py's
   * DEFAULT_GROUP_ROLE_MAPPING, so the name is a contract with the app repo.
   *
   * Never granted from a demo request: Role.DEVELOPER can create real
   * conversations and read and write secrets (onboarding runbook, PLAN 1.8).
   * It does NOT open the consoles on its own; oauth2-proxy gates those on the
   * stream group, so staff need this group AND the stream's.
   */
  staffGroup: 'developer',
} as const;

/**
 * Set to true in cdk.json once SES shows shinro.ai as verified (its DKIM records
 * are in Cloudflare). Until then the pool can't use the SES sender, so email-code
 * sign-in stays off. Flipping it is an in-place update.
 */
export const SES_VERIFIED_CONTEXT_KEY = 'shinro:sesDomainVerified';

/**
 * The public edge (step 5). shinro.ai's DNS is at Cloudflare, so nothing here
 * writes DNS; CDK prints the records to add by hand.
 */
export const EDGE = {
  /** Existing, issued and auto-renewing: shinro.ai + *.shinro.ai, us-east-1 (CloudFront needs us-east-1). */
  certificateArn: 'arn:aws:acm:us-east-1:425106880357:certificate/6652dafb-ca48-4701-b95d-81fbde33ed15',
  /**
   * The Shinro EC2's public name, from its fixed Elastic IP (EXISTING_EIPS.shinroHost).
   * CloudFront needs a DNS name, not an IP. Derived from the IP, never from the
   * instance, whose own name can change with the IP it boots with.
   */
  shinroOrigin: 'ec2-54-147-229-249.compute-1.amazonaws.com',
  /** nginx refuses :80 requests without this header carrying the origin secret. */
  originHeader: 'X-Shinro-Origin',
} as const;

/** Alarms and the cost budget (step 8). */
export const OBSERVABILITY = {
  /** Context key: a list of emails subscribed to the alarm topic. Each must confirm by email. */
  alarmEmailsContextKey: 'shinro:alarmEmails',
  /**
   * Monthly budget for everything tagged Project=shinro-live. Estimate: NAT ~$35,
   * two m7i.xlarge ~$320, EKS ~$250, the rest ~$50. Needs the Project tag
   * activated as a cost allocation tag (Billing console), or it sees $0.
   */
  monthlyBudgetUsd: 800,
  /** Metrics the API publishes (contract with the app team; alarms wait for data). */
  appNamespace: 'ShinroLive/App',
} as const;

/** Tag the CI role may run release commands on (the Shinro EC2, step 4). */
export const HOST_ROLE_TAG = { key: 'shinro-live:role', shinroHost: 'shinro-host' } as const;

/** Off-the-shelf images on the Shinro EC2, pinned. */
export const SUPPORT_IMAGES = {
  nginx: 'nginx:1.30.6-alpine',
  oauth2Proxy: 'quay.io/oauth2-proxy/oauth2-proxy:v7.15.6',
  redis: 'redis/redis-stack-server:7.4.0-v8',
  certbot: 'certbot/dns-cloudflare:v5.9.0',
} as const;

/**
 * The release the Shinro EC2 starts on when /shinro/live/release/* is empty
 * (CI/CD parked). Pushed by scripts/push-images.sh at app commit c6ce73da.
 */
export const INITIAL_RELEASE = {
  commit: 'c6ce73da94b4615f10f3cbdd5d96292b047c5e7e',
  images: {
    api: 'shinro-live-api@sha256:8af8edd8e4cbc871b0f77d761ec76afdc13e75bcc25c946d8d5a0aef957d975c',
    'tool-exec': 'shinro-live-tool-exec@sha256:b327d0f527d74974083d4b8085ffa1c72ce46e0cb52569484610d7103dd9dc63',
    terminal: 'shinro-live-terminal@sha256:8dce11fe216e80ad5c8492ebe114d71f8db00a8a97dd82b9db762e988d581f4f',
    temporal: 'shinro-live-temporal@sha256:982e53357ed4a8bdfcb5e3593620120834a71a9cbec4d78d99ff7f64010efb9c',
  },
} as const;

export const SESSIONS = {
  ttlHours: 48,
  maxActive: 20,
} as const;

export interface StreamConfig {
  /** Short lowercase name; used in resource names, the Cognito group and the cookie name. */
  readonly name: string;
  /** The stream's public page and app, e.g. temporal.shinro.ai. Served through CloudFront. */
  readonly subdomain: string;
  /** Extra hostnames this stream's oauth2-proxy guards. Served through the console distribution (EdgeStack). */
  readonly consoles: readonly string[];
}

export interface LiveConfig {
  readonly streams: readonly StreamConfig[];
  /** SES can send as shinro.ai, so email-code sign-in can be switched on. */
  readonly sesDomainVerified: boolean;
}

export const STREAMS_CONTEXT_KEY = 'shinro:streams';

const STREAM_NAME = /^[a-z][a-z0-9-]{1,30}$/;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function isShinroHost(host: string): boolean {
  const suffix = `.${DOMAIN}`;
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, -suffix.length);
  // Exactly one label: the *.shinro.ai wildcard certificate covers one level only.
  return HOST_LABEL.test(label);
}

/**
 * Parse and validate the stream list. Throws with a readable message on bad
 * config, so a typo fails at synth instead of at deploy.
 */
export function parseStreams(raw: unknown): StreamConfig[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Context "${STREAMS_CONTEXT_KEY}" must be a non-empty array of streams`);
  }

  const names = new Set<string>();
  const hostOwner = new Map<string, string>();

  return raw.map((entry, i) => {
    const where = `${STREAMS_CONTEXT_KEY}[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${where} must be an object`);
    }
    const { name, subdomain, consoles = [] } = entry as Record<string, unknown>;

    if (typeof name !== 'string' || !STREAM_NAME.test(name)) {
      throw new Error(`${where}.name must match ${STREAM_NAME} (got ${JSON.stringify(name)})`);
    }
    if (names.has(name)) {
      throw new Error(`${where}: duplicate stream name "${name}"`);
    }
    // A stream of this name would create a second group with the same
    // GroupName as the staff group, and the deploy would fail.
    if (name === IDENTITY.staffGroup) {
      throw new Error(`${where}: "${name}" is reserved for the staff group`);
    }
    names.add(name);

    if (!Array.isArray(consoles) || consoles.some((c) => typeof c !== 'string')) {
      throw new Error(`${where}.consoles must be an array of hostnames`);
    }
    if (typeof subdomain !== 'string') {
      throw new Error(`${where}.subdomain must be a hostname`);
    }

    // Rule 4.1: every hostname belongs to exactly one stream.
    for (const host of [subdomain, ...(consoles as string[])]) {
      if (!isShinroHost(host)) {
        throw new Error(`${where}: "${host}" must be a single-level subdomain of ${DOMAIN}`);
      }
      const owner = hostOwner.get(host);
      if (owner !== undefined) {
        throw new Error(`${where}: "${host}" already belongs to stream "${owner}" (rule 4.1)`);
      }
      hostOwner.set(host, name);
    }

    return { name, subdomain, consoles: [...(consoles as string[])] };
  });
}

/** Every hostname a stream's oauth2-proxy can start a login from (PLAN 5.23). */
export function streamHosts(stream: StreamConfig): string[] {
  return [stream.subdomain, ...stream.consoles];
}

/** Read and validate the app's config from CDK context. */
export function loadConfig(scope: { node: { tryGetContext(key: string): unknown } }): LiveConfig {
  const verified = scope.node.tryGetContext(SES_VERIFIED_CONTEXT_KEY);
  return {
    streams: parseStreams(scope.node.tryGetContext(STREAMS_CONTEXT_KEY)),
    // CLI context (-c key=true) arrives as a string.
    sesDomainVerified: verified === true || verified === 'true',
  };
}

/** Props every stack takes: pinned region and explicit stack tags. */
export function liveStackProps(description: string): {
  env: { account: string | undefined; region: string };
  description: string;
  tags: Record<string, string>;
} {
  return {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
    description,
    tags: { ...TAGS },
  };
}
