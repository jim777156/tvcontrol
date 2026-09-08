/**
 * THE README IS A CLAIM ABOUT THE PRODUCT, SO IT GETS CHECKED LIKE ONE.
 *
 * It went stale in exactly the way an unchecked number always does: the "What
 * is new" section still described 2.3.0 while the package was on 2.5.1, the
 * test count said 736 and then 732 in two places (the suite was at 914), the
 * prompt library had grown from eight files to nine, and the Node floor had
 * moved. Every one of those was true when written.
 *
 * tests/tool_count.test.js already holds the tool counts. These are the other
 * numbers, plus the version heading, which is the one a reader trusts most to
 * tell them whether the page in front of them is current.
 *
 * Run: node --test tests/readme_claims.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

describe('README numbers match the thing they describe', () => {
  it('states the offline test count the suite actually enforces', () => {
    const runner = readFileSync(join(ROOT, 'scripts', 'run_offline_tests.js'), 'utf8');
    const floor = Number(/const EXPECTED_MIN_TESTS = (\d+);/.exec(runner)?.[1]);
    assert.ok(Number.isFinite(floor), 'the suite floor could not be read');

    const claims = [...readme.matchAll(/(\d[\d,]*)\s+(?:deterministic\s+)?offline tests/g)]
      .map((m) => Number(m[1].replace(/,/g, '')));
    assert.ok(claims.length >= 1, 'the README no longer states an offline test count');
    for (const claimed of claims) {
      assert.equal(claimed, floor,
        `README claims ${claimed} offline tests, the suite floor is ${floor}. `
        + 'Raise both together, or the README is advertising a suite that no longer exists.');
    }
  });

  it('its "What is new" section names the version being shipped', () => {
    // The staleness a reader notices first. A page headed "What is new in 2.3.0"
    // on a 2.5.1 package reads as abandoned, whatever else is correct.
    const heading = /## What is new in (\d+)\.(\d+)(?:\.(\d+))?/.exec(readme);
    assert.ok(heading, 'the README no longer has a "What is new in X" heading');
    const [major, minor] = pkg.version.split('.');
    assert.equal(heading[1], major, `README highlights ${heading[0]}, package is ${pkg.version}`);
    assert.equal(heading[2], minor, `README highlights ${heading[0]}, package is ${pkg.version}`);
  });

  it('counts the prompt library correctly', () => {
    const actual = readdirSync(join(ROOT, 'examples', 'prompts')).filter((f) => f.endsWith('.md')).length;
    const words = { Eight: 8, Nine: 9, Ten: 10, Eleven: 11, Twelve: 12 };
    const claim = /\b(Eight|Nine|Ten|Eleven|Twelve) files\b/.exec(readme);
    assert.ok(claim, 'the README no longer states how many prompt files there are');
    assert.equal(words[claim[1]], actual, `README says ${claim[1]} prompt files, there are ${actual}`);

    const headline = Number(/(\d+)\s+prompt-library workflows/.exec(readme)?.[1]);
    assert.equal(headline, actual, `the headline says ${headline} prompt workflows, there are ${actual}`);
  });

  it('counts the verify scripts correctly', () => {
    // run-all.sh is a runner, not one of the numbered end-to-end scripts.
    const actual = readdirSync(join(ROOT, 'examples', 'verify'))
      .filter((f) => /^\d\d-.*\.sh$/.test(f)).length;
    const claimed = Number(/(\d+)\s+verify scripts/.exec(readme)?.[1]);
    assert.equal(claimed, actual, `README claims ${claimed} verify scripts, there are ${actual}`);
  });

  it('states the Node floor from package.json engines, not a rounded-down guess', () => {
    // "Node.js 18+" was true and misleading: engines requires 18.14.1, so 18.0
    // fails install with a message the README does not prepare you for.
    const required = pkg.engines.node.replace(/^[^\d]*/, '');
    assert.ok(
      readme.includes(required),
      `README does not state the engines floor ${required}; a reader on an older 18.x is told they are supported`,
    );
  });

  it('does not still advertise a version older than the one being shipped', () => {
    // Catches the general case: any "in X.Y.Z" prose left behind by a release.
    const stale = [...readme.matchAll(/\bin (\d+)\.(\d+)\.(\d+)\b/g)]
      .map((m) => m.slice(1, 4).map(Number))
      .filter(([maj, min]) => {
        const [pmaj, pmin] = pkg.version.split('.').map(Number);
        return maj < pmaj || (maj === pmaj && min < pmin);
      });
    assert.deepEqual(stale, [], `README still advertises older versions: ${JSON.stringify(stale)}`);
  });
});

describe('README does not use em dashes', () => {
  it('has none, because they are the house tell', () => {
    const lines = readme.split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => line.includes('—'));
    assert.deepEqual(lines, [], 'em dashes found; use commas, colons or parentheses');
  });
});
