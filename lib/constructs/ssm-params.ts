import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { SSM_PREFIX } from '../config';

/** Full SSM name for a value under the shared prefix, e.g. ssmName('network', 'vpc-id'). */
export function ssmName(...parts: string[]): string {
  return [SSM_PREFIX, ...parts].join('/');
}

/**
 * Publish values to SSM so other stacks and the hosts read them by name,
 * instead of through CloudFormation exports that lock stacks together.
 */
export class SsmParams extends Construct {
  constructor(scope: Construct, id: string, section: string, values: Record<string, string>) {
    super(scope, id);
    for (const [key, value] of Object.entries(values)) {
      new ssm.StringParameter(this, key, {
        parameterName: ssmName(section, key),
        stringValue: value,
      });
    }
  }
}
