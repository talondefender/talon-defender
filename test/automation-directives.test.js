import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const directivesPath = path.join(repoRoot, 'automation', 'directives.json');

const readDirectives = async () => JSON.parse(await fs.readFile(directivesPath, 'utf8'));

test('generic consent automation includes supported CMP families', async () => {
  const directives = await readDirectives();
  const byId = new Map(directives.map(entry => [entry.id, entry]));

  const oneTrust = byId.get('onetrust-dismiss');
  assert.ok(oneTrust, 'missing onetrust-dismiss directive');
  assert.equal(oneTrust.category, 'consent');

  const consentManager = byId.get('consentmanager-hide');
  assert.ok(consentManager, 'missing consentmanager-hide directive');
  assert.equal(consentManager.category, 'consent');
  assert.equal(consentManager.action, 'hide');
  assert.deepEqual(consentManager.hosts, ['*']);
  assert.ok(
    consentManager.selectors.includes('#cmp-ui-iframe'),
    'consentmanager-hide should target the CMP iframe shell'
  );
  assert.ok(
    consentManager.selectors.includes('[id^="cmpbox"]'),
    'consentmanager-hide should target consentmanager box roots'
  );
  assert.ok(
    consentManager.selectors.includes('.cmpboxinner'),
    'consentmanager-hide should target consentmanager inner shells'
  );
});
