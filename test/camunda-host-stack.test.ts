import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { CAMUNDA_PUBLIC_HOST, STREAMS_CONTEXT_KEY } from '../lib/config';
import { BACKUP_TAG, BUNDLE_DIR, CAMUNDA_SECRETS, CAMUNDA_SERVICES, CamundaHostStack } from '../lib/stacks/camunda-host-stack';

const app = new cdk.App();
const stack = new CamundaHostStack(app, 'Camunda', { env: { account: '111111111111', region: 'us-east-1' } });
const template = Template.fromStack(stack);
const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, any> }>;
const instance = Object.values(resources).find((r) => r.Type === 'AWS::EC2::Instance')!.Properties;

const bundleFile = (f: string) => fs.readFileSync(path.join(BUNDLE_DIR, f), 'utf8');
const compose = yaml.load(bundleFile('docker-compose.yaml')) as { services: Record<string, any> };
const orchestrationConfig = yaml.load(bundleFile('.orchestration/application.yaml')) as any;

describe('instance', () => {
  test('private: no public IP, private subnet, Camunda security group', () => {
    expect(instance.NetworkInterfaces).toHaveLength(1);
    const nic = instance.NetworkInterfaces[0];
    expect(nic.AssociatePublicIpAddress).toBe(false);
    expect(JSON.stringify(nic.SubnetId)).toContain('privatesubnetids');
    expect(JSON.stringify(nic.GroupSet)).toContain('sgcamunda');
  });

  test('m7i.xlarge, encrypted 100 GiB gp3, IMDSv2, no key pair', () => {
    expect(instance.InstanceType).toBe('m7i.xlarge');
    expect(instance.BlockDeviceMappings[0].Ebs).toMatchObject({ VolumeSize: 100, VolumeType: 'gp3', Encrypted: true });
    expect(instance.KeyName).toBeUndefined();
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
    });
  });

  test('UserData is a fixed string, so bundle edits never replace the server (5.3)', () => {
    const userData = instance.UserData['Fn::Base64'];
    expect(typeof userData).toBe('string');
    expect(userData).toContain('/shinro/live/camunda/bundle-s3-url');
    // No asset bucket and no content hash: those change with every bundle edit.
    expect(userData).not.toMatch(/cdk-hnb659fds-assets|[0-9a-f]{64}/);
  });

  test('tagged for daily backups, kept 7 days (T-19)', () => {
    expect(instance.Tags).toContainEqual({ Key: BACKUP_TAG.key, Value: BACKUP_TAG.value });
    expect(instance.PropagateTagsToVolumeOnCreation).toBe(true);
    template.hasResourceProperties('AWS::DLM::LifecyclePolicy', {
      PolicyDetails: {
        TargetTags: [{ Key: BACKUP_TAG.key, Value: BACKUP_TAG.value }],
        Schedules: [{ RetainRule: { Count: 7 } }],
      },
    });
  });
});

describe('secrets', () => {
  test.each(CAMUNDA_SECRETS)('%s is generated, never written in the template', (name) => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `shinro-live/camunda/${name}`,
      GenerateSecretString: { PasswordLength: 40, ExcludePunctuation: true },
    });
  });

  test('no SecretString literals anywhere', () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/"SecretString"/);
  });
});

test('publishes what the Shinro EC2 needs', () => {
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/shinro/live/camunda-private-ip' });
  for (const name of ['public-host', 'bundle-s3-url', 'instance-id']) {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/shinro/live/camunda/${name}` });
  }
  template.hasResourceProperties('AWS::SSM::Parameter', { Value: CAMUNDA_PUBLIC_HOST });
});

test('one log group per Compose service', () => {
  for (const service of CAMUNDA_SERVICES) {
    template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: `/shinro-live/camunda/${service}` });
  }
});

describe('bundle', () => {
  test('runs exactly the six services in section 2', () => {
    expect(Object.keys(compose.services).sort()).toEqual([...CAMUNDA_SERVICES].sort());
  });

  test('publishes only 8080, 26500 and 18080; 8090 on localhost only', () => {
    const published = Object.values(compose.services).flatMap((s) => (s.ports ?? []) as string[]);
    expect(published.sort()).toEqual(['127.0.0.1:8090:8090', '18080:18080', '26500:26500', '8080:8080'].sort());
  });

  test('forward-headers-strategy is native (gotcha 5.32)', () => {
    expect(orchestrationConfig.server['forward-headers-strategy']).toBe('native');
  });

  test('demo and shinro-assessment are never admin (gotcha 5.31, decision 4.11)', () => {
    const admin = orchestrationConfig.camunda.security.initialization.defaultRoles.admin;
    expect(admin.users ?? []).not.toContain('demo');
    expect(admin.clients).not.toContain('shinro-assessment');
  });

  test('no literal secrets or upstream defaults in the bundle', () => {
    for (const f of ['docker-compose.yaml', 'camunda.env', '.identity/application.yaml', '.orchestration/application.yaml']) {
      const text = bundleFile(f);
      expect(text).not.toMatch(/demo-[a-z]+-secret|demo-postgres-password|:-?secret\b|PASSWORD=admin|password: "?\$\{KEYCLOAK_ADMIN_PASSWORD:admin/);
    }
  });

  test('every secret the compose file uses is rendered at boot', () => {
    const renderEnv = bundleFile('bin/render-env.sh');
    for (const name of CAMUNDA_SECRETS) expect(renderEnv).toContain(`secret ${name}`);
  });

  test('the public host is a console of exactly one stream (rule 4.1)', () => {
    const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
    const owners = (cdkJson.context[STREAMS_CONTEXT_KEY] as { consoles?: string[] }[]).filter((s) =>
      (s.consoles ?? []).includes(CAMUNDA_PUBLIC_HOST),
    );
    expect(owners).toHaveLength(1);
  });
});
