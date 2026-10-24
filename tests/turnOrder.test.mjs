// Очерёдность ходов (PLAN 4.2, 4.3): случайность FR-09 и защита от молчания FR-10. Запуск: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseNext, updateSilence } from '../src/turnOrder.js';

// Кубик по заранее заданной последовательности: первый вызов — проверка процента, второй — кто ходит.
const fixedRolls = (...values) => () => values.shift();

const base = { author: 'master', masterChoice: 'hero1', silence: [0, 0], randomness: 0, silenceThreshold: 4 };

test('случайность 0 %: всегда выбор мастера', () => {
    for (let i = 0; i < 200; i++) {
        assert.deepEqual(chooseNext(base), { next: 'hero1', reason: 'master' });
    }
});

test('случайность 100 %: выбор всегда случайный и встречаются все три варианта', () => {
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
        const choice = chooseNext({ ...base, randomness: 100 });
        assert.equal(choice.reason, 'random');
        seen.add(choice.next);
    }
    assert.deepEqual([...seen].sort(), ['hero1', 'hero2', 'master']);
});

test('случайность 30 %: d100 ≤ 30 — случайно, иначе мастер', () => {
    assert.deepEqual(chooseNext({ ...base, randomness: 30, roll: fixedRolls(30, 2) }), { next: 'hero2', reason: 'random' });
    assert.deepEqual(chooseNext({ ...base, randomness: 30, roll: fixedRolls(31) }), { next: 'hero1', reason: 'master' });
});

test('после героя ходит мастер, случайность там не действует', () => {
    assert.deepEqual(chooseNext({ ...base, author: 'hero1', randomness: 100 }), { next: 'master', reason: 'after-hero' });
});

test('порог 4: герой 2 молчал 4 хода — следующий ход его, даже против мастера и случайности', () => {
    assert.deepEqual(chooseNext({ ...base, silence: [0, 4], randomness: 100 }), { next: 'hero2', reason: 'silence' });
    assert.deepEqual(chooseNext({ ...base, author: 'hero1', silence: [0, 4] }), { next: 'hero2', reason: 'silence' });
    assert.deepEqual(chooseNext({ ...base, silence: [0, 3] }), { next: 'hero1', reason: 'master' });
});

test('оба молчат дольше порога — ходит тот, кто молчит дольше; порог 0 выключает защиту', () => {
    assert.equal(chooseNext({ ...base, silence: [5, 7] }).next, 'hero2');
    assert.deepEqual(chooseNext({ ...base, silence: [9, 9], silenceThreshold: 0 }), { next: 'hero1', reason: 'master' });
});

test('счётчики молчания: автор хода 0, остальные +1, мастер прибавляет обоим', () => {
    const heroes = [{ silence: 2 }, {}];
    updateSilence(heroes, 'master');
    assert.deepEqual(heroes.map((hero) => hero.silence), [3, 1]);
    updateSilence(heroes, 'hero1');
    assert.deepEqual(heroes.map((hero) => hero.silence), [0, 2]);
});

test('сценарий: мастер всё время зовёт героя 1 — герой 2 вступает не позже чем через 4 хода молчания', () => {
    const heroes = [{ silence: 0 }, { silence: 0 }];
    let next = 'master';
    const authors = [];
    for (let i = 0; i < 12; i++) {
        const author = next;
        authors.push(author);
        updateSilence(heroes, author);
        next = chooseNext({ ...base, author, silence: heroes.map((hero) => hero.silence) }).next;
    }
    let run = 0;
    for (const author of authors) {
        run = author === 'hero2' ? 0 : run + 1;
        assert.ok(run <= 4, `герой 2 молчит ${run} ходов: ${authors.join(' ')}`);
    }
    assert.ok(authors.includes('hero2'));
});

test('герой без сознания или погиб: не выбирается ни мастером, ни случаем, ни защитой от молчания (PLAN 8.5)', () => {
    const down = { ...base, active: [false, true] };
    assert.deepEqual(chooseNext(down), { next: 'hero2', reason: 'unavailable' });
    assert.deepEqual(chooseNext({ ...down, silence: [9, 0] }), { next: 'hero2', reason: 'unavailable' });
    for (let i = 0; i < 200; i++) assert.notEqual(chooseNext({ ...down, randomness: 100 }).next, 'hero1');
    assert.deepEqual(chooseNext({ ...base, active: [false, false] }), { next: 'master', reason: 'unavailable' });
    assert.deepEqual(chooseNext({ ...base, masterChoice: 'hero2', active: [false, true] }), { next: 'hero2', reason: 'master' });
});

test('герой не в строю не копит молчание', () => {
    const heroes = [{ silence: 2, condition: 'down' }, { silence: 1 }];
    updateSilence(heroes, 'master');
    assert.deepEqual(heroes.map((hero) => hero.silence), [2, 2]);
});
