import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const popupRulesetDirectory = new URL(
  '../rulesets/scripting/popup/',
  import.meta.url
);

const hostnameSearch = (hostnames, target) => {
  let left = 0;
  let right = hostnames.length;
  while (left < right) {
    const index = (left + right) >>> 1;
    const candidate = hostnames[index];
    let difference = target.length - candidate.length;
    if (difference === 0) {
      if (target === candidate) return index;
      difference = target < candidate ? -1 : 1;
    }
    if (difference < 0) right = index;
    else left = index + 1;
  }
  return -1;
};

test('every generated popup hostname satisfies the runtime binary-search invariant', async () => {
  const files = (await readdir(popupRulesetDirectory))
    .filter(name => name.endsWith('.js'))
    .sort();
  assert.ok(files.length > 0);

  const expectedNewHosts = new Set([
    'dailyrumor-jp.co.in',
    'dial2day.com',
    'sa-movie.com',
    'animevice.net',
    'proxyify.info',
    'yifysearch.com',
    'movienewsgo.xyz',
    'yewfjsdi.it.com',
    'clovermovies.com',
    'meimei-movie.com',
    'mytvsoapforum.com',
    'w-solarmovies.com',
    'gomoviescdn.online',
  ]);

  for (const file of files) {
    const source = await readFile(new URL(file, popupRulesetDirectory), 'utf8');
    const context = { self: {} };
    vm.runInNewContext(source, context, { filename: file });
    const detailsList = context.self.preventPopupDetails;
    assert.ok(Array.isArray(detailsList), `${file} did not publish popup details`);
    for (const details of detailsList) {
      for (const lane of ['block', 'allow']) {
        const hostnames = details?.[lane]?.hostnames;
        assert.ok(Array.isArray(hostnames), `${file}/${lane} hostnames missing`);
        for (const hostname of hostnames) {
          assert.notEqual(
            hostnameSearch(hostnames, hostname),
            -1,
            `${file}/${lane} binary search misses ${hostname}`
          );
          expectedNewHosts.delete(hostname);
        }
        const regexes = details?.[lane]?.regexes;
        assert.ok(Array.isArray(regexes), `${file}/${lane} regexes missing`);
        assert.equal(regexes.length % 2, 0, `${file}/${lane} regex pairs broken`);
      }
    }
  }
  assert.deepEqual([...expectedNewHosts], []);
});
