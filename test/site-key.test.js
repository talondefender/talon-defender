import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isKnownPublicSuffix,
  normalizeAutoPromotedHostname,
  registrableDomain,
} from '../js/site-key.js';

test('registrableDomain resolves common multi-label public suffixes', () => {
  assert.equal(registrableDomain('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('shop.example.com.au'), 'example.com.au');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
  assert.equal(registrableDomain('media.foo.co.jp'), 'foo.co.jp');
});

test('registrableDomain fails closed for localhost, IPs, and uncertain hosts', () => {
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(registrableDomain('2001:db8::1'), '2001:db8::1');
  assert.equal(registrableDomain('foo.example.unknown'), 'example.unknown');
  assert.equal(registrableDomain('foo.bar.co.zz'), 'foo.bar.co.zz');
});

test('auto-promotion normalization rejects bare public suffixes', () => {
  assert.equal(isKnownPublicSuffix('co.uk'), true);
  assert.equal(normalizeAutoPromotedHostname('co.uk'), '');
  assert.equal(normalizeAutoPromotedHostname('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(normalizeAutoPromotedHostname('  SHOP.EXAMPLE.COM.AU  '), 'example.com.au');
});
