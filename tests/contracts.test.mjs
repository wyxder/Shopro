import assert from 'node:assert/strict';
import test from 'node:test';
import { runContracts } from '../scripts/contracts.mjs';

const result = runContracts();

for (const item of result.checks) {
    test(`${item.id} ${item.name}`, () => {
        assert.equal(item.ok, true, item.detail);
    });
}

test('C-10 契约自检无失败项', () => {
    assert.equal(result.failed, 0, `存在 ${result.failed} 项失败`);
});