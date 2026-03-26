import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('adaptive subsystems register the shared shadow DOM helper before their runtime files', async () => {
  const source = await readSource('js/scripting-manager.js');

  assert.match(source, /const TALON_SHADOW_DOM_HELPER_PATH = '\/js\/scripting\/shadow-dom-helper\.js'/);
  assert.match(source, /TALON_SHADOW_DOM_HELPER_PATH,\s*'\/js\/scripting\/native-heuristics\.js'/);
  assert.match(source, /TALON_SHADOW_DOM_HELPER_PATH,\s*'\/js\/scripting\/automation\.js'/);
  assert.match(source, /TALON_SHADOW_DOM_HELPER_PATH,\s*'\/js\/scripting\/remote-cosmetics\.js'/);
  assert.match(source, /TALON_SHADOW_DOM_HELPER_PATH,\s*'\/js\/scripting\/post-hide-cleanup\.js'/);
});

test('remote cosmetics uses local style ownership instead of background CSS messaging', async () => {
  const source = await readSource('js/scripting/remote-cosmetics.js');

  assert.doesNotMatch(source, /what:\s*'insertCSS'/);
  assert.doesNotMatch(source, /what:\s*'removeCSS'/);
  assert.match(source, /STYLE_MARKER_ATTR = 'data-talon-remote-cosmetics'/);
  assert.match(source, /ensureDocumentStyle\(cssText\)/);
  assert.match(source, /syncShadowStyles\(\)/);
});

test('automation queries shadow roots and applies hide styling only to marked nodes', async () => {
  const source = await readSource('js/scripting/automation.js');

  assert.match(source, /shadowController\?\.enumerateRoots\?\.\(\)/);
  assert.match(source, /const styleText = `\$\{attrSelector\}\{display:none!important;visibility:hidden!important;\}`;/);
  assert.match(source, /for \( const selector of selectors \) \{/);
});
