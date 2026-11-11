import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseStreams, streamHosts, STREAMS_CONTEXT_KEY } from '../lib/config';

const temporal = {
  name: 'temporal',
  subdomain: 'temporal.shinro.ai',
  consoles: ['camunda-demo.shinro.ai', 'demo-temporal-ui.shinro.ai'],
};

describe('parseStreams', () => {
  test('accepts the temporal stream', () => {
    expect(parseStreams([temporal])).toEqual([temporal]);
  });

  test('cdk.json holds a valid stream list', () => {
    const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
    const streams = parseStreams(cdkJson.context[STREAMS_CONTEXT_KEY]);
    expect(streams.map((s) => s.name)).toContain('temporal');
  });

  test('defaults consoles to an empty list', () => {
    expect(parseStreams([{ name: 'next', subdomain: 'next.shinro.ai' }])[0].consoles).toEqual([]);
  });

  test.each([
    ['missing list', undefined, /non-empty array/],
    ['empty list', [], /non-empty array/],
    ['bad name', [{ ...temporal, name: 'Temporal' }], /name must match/],
    ['foreign domain', [{ ...temporal, subdomain: 'temporal.example.com' }], /single-level subdomain/],
    ['two levels deep', [{ ...temporal, consoles: ['a.b.shinro.ai'] }], /single-level subdomain/],
    ['bare apex', [{ ...temporal, subdomain: 'shinro.ai' }], /single-level subdomain/],
  ])('rejects %s', (_label, raw, message) => {
    expect(() => parseStreams(raw)).toThrow(message);
  });

  test('rejects duplicate stream names', () => {
    const other = { name: 'temporal', subdomain: 'other.shinro.ai' };
    expect(() => parseStreams([temporal, other])).toThrow(/duplicate stream name/);
  });

  test('rejects a hostname shared by two streams (rule 4.1)', () => {
    const other = { name: 'next', subdomain: 'next.shinro.ai', consoles: ['demo-temporal-ui.shinro.ai'] };
    expect(() => parseStreams([temporal, other])).toThrow(/already belongs to stream "temporal"/);
  });
});

test('streamHosts lists the subdomain and every console (callback URLs, 5.23)', () => {
  expect(streamHosts(temporal)).toEqual([
    'temporal.shinro.ai',
    'camunda-demo.shinro.ai',
    'demo-temporal-ui.shinro.ai',
  ]);
});
