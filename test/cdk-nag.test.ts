import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { buildApp } from '../lib/app';

/**
 * Runs the cdk-nag AWS Solutions rules over the whole app, exactly as
 * `cdk synth` does. A new finding fails here: fix it, or acknowledge it on
 * the resource with Validations.of(construct).acknowledge({ id, reason }).
 */
test('cdk-nag: no unacknowledged findings', () => {
  const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
  const cachedLookups = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.context.json'), 'utf8'));
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'nag-'));

  process.env.CDK_DEFAULT_ACCOUNT = '425106880357';
  const app = new cdk.App({ outdir, context: { ...cdkJson.context, ...cachedLookups } });
  buildApp(app);

  expect(() => app.synth()).not.toThrow();
});
