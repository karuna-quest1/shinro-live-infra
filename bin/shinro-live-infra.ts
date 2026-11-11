#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { REGION } from '../lib/config';
import { buildApp } from '../lib/app';

// Everything lives in us-east-1 (PLAN 5.14). Fail loudly rather than deploy elsewhere.
const cliRegion = process.env.CDK_DEFAULT_REGION;
if (cliRegion && cliRegion !== REGION) {
  throw new Error(
    `Shinro live must deploy to ${REGION}, but the AWS CLI region is ${cliRegion}. ` +
      `Run with AWS_REGION=${REGION}.`,
  );
}

buildApp(new cdk.App());
