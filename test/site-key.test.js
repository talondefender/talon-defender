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
  assert.equal(registrableDomain('foo.github.io'), 'foo.github.io');
  assert.equal(registrableDomain('bar.appspot.com'), 'bar.appspot.com');
  assert.equal(registrableDomain('a.b.k12.ca.us'), 'b.k12.ca.us');
  assert.equal(registrableDomain('foo.city.kawasaki.jp'), 'city.kawasaki.jp');
});

test('registrableDomain preserves localhost and IPs and falls back sanely for unknown suffixes', () => {
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(registrableDomain('2001:db8::1'), '2001:db8::1');
  assert.equal(registrableDomain('foo.example.unknown'), 'example.unknown');
  assert.equal(registrableDomain('foo.bar.co.zz'), 'co.zz');
});

test('auto-promotion normalization rejects bare public suffixes', () => {
  assert.equal(isKnownPublicSuffix('co.uk'), true);
  assert.equal(isKnownPublicSuffix('github.io'), true);
  assert.equal(isKnownPublicSuffix('appspot.com'), true);
  assert.equal(isKnownPublicSuffix('k12.ca.us'), true);
  assert.equal(isKnownPublicSuffix('city.kawasaki.jp'), false);
  assert.equal(normalizeAutoPromotedHostname('co.uk'), '');
  assert.equal(normalizeAutoPromotedHostname('github.io'), '');
  assert.equal(normalizeAutoPromotedHostname('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(normalizeAutoPromotedHostname('foo.github.io'), 'foo.github.io');
  assert.equal(normalizeAutoPromotedHostname('  SHOP.EXAMPLE.COM.AU  '), 'example.com.au');
});
