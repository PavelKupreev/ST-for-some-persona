// Юнит-тест кубиков (PLAN 2.5). Запуск: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { abilityModifier, formatRoll, parseRollTags, resolveCheck, rollDie, stripRollTags } from '../src/dice.js';

test('таблица модификаторов 5e', () => {
    const table = {
        1: -5, 2: -4, 3: -4, 4: -3, 5: -3, 6: -2, 7: -2, 8: -1, 9: -1, 10: 0,
        11: 0, 12: 1, 13: 1, 14: 2, 15: 2, 16: 3, 17: 3, 18: 4, 19: 4, 20: 5,
    };
    for (const [score, mod] of Object.entries(table)) {
        assert.equal(abilityModifier(Number(score)), mod, `значение ${score}`);
    }
});

test('обычная проверка: успех на равенстве с DC', () => {
    const r = resolveCheck({ natural: 10, sides: 20, score: 14, dc: 12 });
    assert.deepEqual([r.modifier, r.total, r.success], [2, 12, true]);
    assert.equal(resolveCheck({ natural: 9, sides: 20, score: 14, dc: 12 }).success, false);
});

test('натуральная 1 — провал при любом модификаторе', () => {
    const r = resolveCheck({ natural: 1, sides: 20, score: 20, dc: 2 });
    assert.equal(r.total, 6);
    assert.equal(r.success, false);
    assert.equal(r.fumble, true);
});

test('натуральная 20 — критический успех даже против DC 30', () => {
    const r = resolveCheck({ natural: 20, sides: 20, score: 1, dc: 30 });
    assert.equal(r.success, true);
    assert.equal(r.critical, true);
});

test('плашка в формате ТЗ', () => {
    const r = resolveCheck({ natural: 13, sides: 20, score: 14, dc: 12 });
    assert.equal(formatRoll(r), '🎲 d20+2 = 15 vs DC 12 ✅');
    assert.equal(formatRoll(resolveCheck({ natural: 5, sides: 20, score: 8, dc: 12 }), { heroName: 'Лиа', stat: 'STR' }),
        '🎲 Лиа, STR: d20-1 = 4 vs DC 12 ❌');
    assert.match(formatRoll(resolveCheck({ natural: 1, sides: 20, score: 18, dc: 5 })), /❌ \(натуральная 1/);
});

test('разбор меток броска', () => {
    const text = 'Арен тянется к ключу. [ROLL d20 DEX DC12 hero1]\nИ ещё [roll: d20 ЛОВ DC 15] и мусор [ROLL d20 XYZ DC10].';
    // Незнакомая проверка не отбрасывается: это может быть способность героя (PLAN 6.4), её узнаёт game.js.
    const rolls = parseRollTags(text);
    assert.equal(rolls.length, 3);
    assert.deepEqual(rolls.map((r) => [r.sides, r.stat, r.dc, r.target]), [[20, 'DEX', 12, 'hero1'], [20, 'DEX', 15, ''], [20, null, 10, '']]);
    assert.equal(rolls[2].check, 'XYZ');
    assert.equal(stripRollTags('Попытка. [ROLL d20 STR DC10]'), 'Попытка.');
});

test('кубик: значения 1..sides, обе границы достижимы, перекоса по модулю нет', () => {
    // Подменённый генератор: максимум Uint32 должен отбрасываться (лежит в «хвосте»), затем 0 → 1, 19 → 20.
    const queue = [2 ** 32 - 1, 0, 19];
    const fake = (array) => { array[0] = queue.shift(); return array; };
    assert.equal(rollDie(20, fake), 1);
    assert.equal(rollDie(20, fake), 20);

    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
        const value = rollDie(20);
        assert.ok(value >= 1 && value <= 20);
        seen.add(value);
    }
    assert.equal(seen.size, 20);
    assert.throws(() => rollDie(1));
});
