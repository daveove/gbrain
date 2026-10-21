/**
 * DAV-7074: /mcp request-log ingress classification. Row-level persistence is
 * pinned in test/e2e/serve-http-oauth.test.ts; this file pins the pure rules.
 */

import { describe, test, expect } from 'bun:test';
import { isLoopbackPeer, requestIngress, withIngress } from '../src/mcp/request-ingress.ts';

function headers(map: Record<string, string>): (name: string) => string | undefined {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return name => lower.get(name.toLowerCase());
}

describe('isLoopbackPeer', () => {
  test('accepts IPv4, IPv6 and IPv4-mapped loopback', () => {
    for (const peer of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopbackPeer(peer)).toBe(true);
  });
  test('rejects everything else', () => {
    for (const peer of [undefined, '', '100.99.109.104', '10.0.0.1', '::ffff:10.0.0.1', '1127.0.0.1', 'fe80::1']) {
      expect(isLoopbackPeer(peer)).toBe(false);
    }
  });
});

describe('requestIngress', () => {
  test('loopback peer with the Funnel header is funnel, even with a user login present', () => {
    expect(requestIngress(headers({ 'Tailscale-Funnel-Request': '?1' }), '127.0.0.1')).toBe('funnel');
    expect(requestIngress(headers({ 'Tailscale-Funnel-Request': '?1', 'Tailscale-User-Login': 'a@b.c' }), '::1')).toBe('funnel');
  });
  test('loopback peer with a tailnet user login is tailnet', () => {
    expect(requestIngress(headers({ 'Tailscale-User-Login': 'a@b.c' }), '127.0.0.1')).toBe('tailnet');
  });
  test('loopback peer without Tailscale headers (or with an empty login) is loopback', () => {
    expect(requestIngress(headers({}), '127.0.0.1')).toBe('loopback');
    expect(requestIngress(headers({ 'Tailscale-User-Login': '' }), '127.0.0.1')).toBe('loopback');
  });
  test('a non-loopback peer is network and its Tailscale headers are ignored', () => {
    expect(requestIngress(headers({ 'Tailscale-Funnel-Request': '?1' }), '203.0.113.9')).toBe('network');
    expect(requestIngress(headers({ 'Tailscale-User-Login': 'a@b.c' }), '100.99.109.104')).toBe('network');
    expect(requestIngress(headers({}), undefined)).toBe('network');
  });
});

describe('withIngress', () => {
  test('adds ingress to an object without mutating it', () => {
    const params = { tool_count: 3 };
    expect(withIngress(params, 'funnel')).toEqual({ tool_count: 3, ingress: 'funnel' });
    expect(params).toEqual({ tool_count: 3 });
  });
  test('null and non-object params become an ingress-only object', () => {
    expect(withIngress(null, 'loopback')).toEqual({ ingress: 'loopback' });
    expect(withIngress(undefined, 'tailnet')).toEqual({ ingress: 'tailnet' });
    expect(withIngress(['x'], 'network')).toEqual({ ingress: 'network' });
  });
  test('the server value wins over a client argument named ingress', () => {
    expect(withIngress({ ingress: 'loopback', query: 'q' }, 'funnel')).toEqual({ ingress: 'funnel', query: 'q' });
  });
});
