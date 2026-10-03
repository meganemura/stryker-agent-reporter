import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { buildScopeLine, sourceFile } from '../src/build-lines.ts';
import type { MutantSite } from '../src/build-lines.ts';

const repeatedLine = 'const aToB = edgesByPair.get(`${a}->${b}`) ?? [];';
const repeatedSource = [
  repeatedLine,
  'const other = 1;',
  'if (x) {',
  `  ${repeatedLine}`,
  '}',
  '',
].join('\n');
const replacement = 'edgesByPair.get(`${a}->${b}`) && []';

function logicalSite(line: number, startColumn: number, endColumn: number): MutantSite {
  return {
    location: {
      start: { line, column: startColumn },
      end: { line, column: endColumn },
    },
    mutatorName: 'LogicalOperator',
    replacement,
  };
}

const firstRepeatedSite = logicalSite(1, 14, 49);
const secondRepeatedSite = logicalSite(4, 16, 51);
const repeatedSites = [firstRepeatedSite, secondRepeatedSite];

function shiftedSite(site: MutantSite, lineOffset: number): MutantSite {
  return {
    ...site,
    location: {
      start: { ...site.location.start, line: site.location.start.line + lineOffset },
      end: { ...site.location.end, line: site.location.end.line + lineOffset },
    },
  };
}

describe('source-bound mutant keys', () => {
  it('assigns literal keys to repeated source windows', () => {
    const file = sourceFile('src/rules/cycles.ts', repeatedSource);

    assert.equal(file.keyOf(firstRepeatedSite), '8764c5229f05');
    assert.equal(file.keyOf(secondRepeatedSite), '2e79224b8652');
    assert.equal(file.sourceHash, '7c1cae4b334c6a13');
  });

  it('uses each selected site key for every generated subset', () => {
    const sumSource = 'const s = a + a + a;\n';
    const sumSites: MutantSite[] = [
      {
        location: { start: { line: 1, column: 13 }, end: { line: 1, column: 14 } },
        mutatorName: 'ArithmeticOperator',
        replacement: '-',
      },
      {
        location: { start: { line: 1, column: 17 }, end: { line: 1, column: 18 } },
        mutatorName: 'ArithmeticOperator',
        replacement: '-',
      },
    ];
    const cases = [
      { path: 'src/rules/cycles.ts', source: repeatedSource, sites: repeatedSites },
      { path: 'src/sum.ts', source: sumSource, sites: sumSites },
    ];

    for (const { path, source, sites } of cases) {
      const fullKeys = buildScopeLine(sourceFile(path, source), sites).keys;
      for (let mask = 0; mask < 2 ** sites.length; mask++) {
        const selected = sites.filter((_, index) => (mask & (1 << index)) !== 0);
        const expected = fullKeys.filter((_, index) => (mask & (1 << index)) !== 0);
        assert.deepEqual(
          buildScopeLine(sourceFile(path, source), selected).keys,
          expected,
          `subset ${path} mask ${mask}`,
        );
      }
    }
  });

  it('keeps same-line sites distinct when only the second site is selected', () => {
    const file = sourceFile('src/sum.ts', 'const s = a + a + a;\n');
    const firstSite: MutantSite = {
      location: { start: { line: 1, column: 13 }, end: { line: 1, column: 14 } },
      mutatorName: 'ArithmeticOperator',
      replacement: '-',
    };
    const secondSite: MutantSite = {
      location: { start: { line: 1, column: 17 }, end: { line: 1, column: 18 } },
      mutatorName: 'ArithmeticOperator',
      replacement: '-',
    };

    assert.equal(file.keyOf(firstSite), '93f2288d0ea2');
    assert.equal(file.keyOf(secondSite), '886b670f93c5');
    assert.deepEqual(buildScopeLine(file, [secondSite]).keys, ['886b670f93c5']);
  });

  it('hashes the path, window, offsets, mutator, replacement, and window ordinal', () => {
    const hashInput = [
      'src/sum.ts',
      'const s = a + a + a;',
      '12',
      '13',
      'ArithmeticOperator',
      '-',
      '0',
    ].join('\0');
    const hash = createHash('sha1').update(hashInput).digest('hex').slice(0, 12);

    assert.equal(hash, '93f2288d0ea2');
    assert.equal(
      sourceFile('src/sum.ts', 'const s = a + a + a;\n').keyOf({
        location: { start: { line: 1, column: 13 }, end: { line: 1, column: 14 } },
        mutatorName: 'ArithmeticOperator',
        replacement: '-',
      }),
      hash,
    );
  });

  it('keeps keys when a repeated window is added below the sites', () => {
    const file = sourceFile('src/rules/cycles.ts', `${repeatedSource}${repeatedLine}\n`);

    assert.equal(file.keyOf(firstRepeatedSite), '8764c5229f05');
    assert.equal(file.keyOf(secondRepeatedSite), '2e79224b8652');
  });

  it('keeps keys when an unrelated line is added above the sites', () => {
    const file = sourceFile('src/rules/cycles.ts', `// header\n${repeatedSource}`);

    assert.equal(file.keyOf(shiftedSite(firstRepeatedSite, 1)), '8764c5229f05');
    assert.equal(file.keyOf(shiftedSite(secondRepeatedSite, 1)), '2e79224b8652');
  });

  it('counts matching windows above each site', () => {
    const source = `${repeatedLine}\n${repeatedSource}`;
    const file = sourceFile('src/rules/cycles.ts', source);

    assert.equal(file.keyOf(shiftedSite(firstRepeatedSite, 1)), '2e79224b8652');
    assert.equal(file.keyOf(shiftedSite(secondRepeatedSite, 1)), '6d6e470c3170');
    assert.equal(file.keyOf(logicalSite(1, 14, 49)), '8764c5229f05');
  });

  it('keeps a multi-line key when each line gains indentation', () => {
    const first = sourceFile('src/m.ts', 'f(\n  a,\n  b);\n').keyOf({
      location: { start: { line: 1, column: 1 }, end: { line: 3, column: 5 } },
      mutatorName: 'BlockStatement',
      replacement: '{}',
    });
    const reindented = sourceFile(
      'src/m.ts',
      'if (y) {\n    f(\n      a,\n      b);\n}\n',
    ).keyOf({
      location: { start: { line: 2, column: 5 }, end: { line: 4, column: 9 } },
      mutatorName: 'BlockStatement',
      replacement: '{}',
    });

    assert.equal(first, '411109d4f87a');
    assert.equal(reindented, '411109d4f87a');
  });
});
