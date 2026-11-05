import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGateway } from '../public/gateway.mjs';
import { secureMobileHtml, mobileCsp } from './security.mjs';

test('gateway normalizes HTTPS origins and allows an unconfigured connection', () => {
  assert.equal(normalizeGateway(''), '');
  assert.equal(normalizeGateway('  https://gateway.example:443/ '), 'https://gateway.example');
  assert.equal(normalizeGateway('https://gateway.example:9443', { native: true }), 'https://gateway.example:9443');
});
test('gateway rejects credentials, path, fragments and unprotected remote endpoints', () => {
  for (const value of ['https://user:pass@gateway.example', 'https://gateway.example/api', 'https://gateway.example/?token=x', 'https://gateway.example/#x', 'http://gateway.example', 'javascript:alert(1)', 'http://127.0.0.1.evil.example', 'file:///etc/passwd']) {
    assert.throws(() => normalizeGateway(value));
  }
});
test('native companion never accepts plaintext loopback or LAN endpoints', () => {
  for (const value of ['http://localhost:4317', 'http://127.0.0.1:4317', 'http://[::1]:4317', 'http://192.168.1.20']) {
    assert.throws(() => normalizeGateway(value, { native: true }));
  }
  assert.equal(normalizeGateway('http://127.0.0.1:4317'), 'http://127.0.0.1:4317');
});
test('native asset policy permits HTTPS APIs without permitting remote scripts or frames', () => {
  const page = secureMobileHtml('<html><head><script src="app.js"></script></head></html>');
  assert.ok(page.indexOf('Content-Security-Policy') < page.indexOf('<script'));
  assert.ok(mobileCsp.includes("script-src 'self'"));
  assert.ok(mobileCsp.includes("connect-src 'self' https:"));
  assert.ok(mobileCsp.includes("frame-src 'none'"));
  assert.throws(() => secureMobileHtml('<html></html>'));
  assert.throws(() => secureMobileHtml(page));
});
