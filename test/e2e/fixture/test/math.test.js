import assert from 'node:assert/strict';
import { test } from 'node:test';

import { add, subtract } from '../src/math.js';

test('add adds two numbers', () => {
  assert.equal(add(2, 3), 5);
});

test('subtract subtracts two numbers', () => {
  assert.equal(subtract(5, 3), 2);
});
