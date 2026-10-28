// Изменения состояния героев от мастера (PLAN 6.1, FR-15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStateChanges, extractStateChanges } from '../src/heroState.js';
import { parseMasterResponse } from '../src/parse.js';

const names = ['Арен', 'Лиа'];

function makeHeroes() {
    const hero = (name) => ({
        name, stats: { STR: 10, DEX: 14, CON: 12, INT: 10, WIS: 10, CHA: 10 },
        hp: { current: 12, max: 12 }, inventory: ['факел', 'кинжал'],
    });
    return [hero('Арен'), hero('Лиа')];
}

test('критерий FR-15: мастер нанёс 5 урона — HP уменьшилось на 5', () => {
    const heroes = makeHeroes();
    const { text, changes } = extractStateChanges('Стрела впивается в плечо.\n[STATE {"hero1": {"hp": -5}}]\n[NEXT: hero1]', names);
    assert.equal(text, 'Стрела впивается в плечо.\n[NEXT: hero1]');
    const lines = applyStateChanges(heroes, changes);
    assert.equal(heroes[0].hp.current, 7);
    assert.deepEqual(lines, ['Арен: HP 12 → 7 (−5)']);
});

test('статы и инвентарь, ключ по имени героя, вложенный JSON', () => {
    const heroes = makeHeroes();
    const { changes } = extractStateChanges('[СОСТОЯНИЕ: {"Лиа": {"stats": {"STR": -1}, "add": ["ржавый ключ"], "remove": ["Факел"]}}]', names);
    const lines = applyStateChanges(heroes, changes);
    assert.equal(heroes[1].stats.STR, 9);
    assert.deepEqual(heroes[1].inventory, ['кинжал', 'ржавый ключ']);
    assert.equal(lines[0], 'Лиа: STR 10 → 9, − факел, + ржавый ключ');
});

test('HP не уходит ниже 0 и выше максимума, статы держатся в 1–20', () => {
    const heroes = makeHeroes();
    applyStateChanges(heroes, extractStateChanges('[STATE {"hero1": {"hp": -50, "DEX": 10}, "hero2": {"heal": 30}}]', names).changes);
    assert.equal(heroes[0].hp.current, 0);
    assert.equal(heroes[0].stats.DEX, 20);
    assert.equal(heroes[1].hp.current, 12);
});

test('«урон: 5» без знака — это минус', () => {
    const heroes = makeHeroes();
    applyStateChanges(heroes, extractStateChanges('[STATE {"hero2": {"урон": 5}}]', names).changes);
    assert.equal(heroes[1].hp.current, 7);
});

test('блок в ```json без метки тоже понимается; посторонний JSON не трогаем', () => {
    const { text, changes } = extractStateChanges('Текст.\n```json\n{"hero1": {"hp": 3}}\n```', names);
    assert.equal(text, 'Текст.');
    assert.equal(changes[0].hp, 3);
    const other = extractStateChanges('```json\n{"weather": "rain"}\n```', names);
    assert.equal(other.changes.length, 0);
});

test('нет предмета — убирать нечего, строка не появляется', () => {
    const heroes = makeHeroes();
    const lines = applyStateChanges(heroes, extractStateChanges('[STATE {"hero1": {"remove": ["меч"]}}]', names).changes);
    assert.deepEqual(lines, []);
    assert.deepEqual(heroes[0].inventory, ['факел', 'кинжал']);
});

test('битый блок вырезается из текста, JSON в чат не попадает', () => {
    const { text, changes } = extractStateChanges('Дверь открыта.\n[STATE {"hero1": {"hp": -2', names);
    assert.equal(text, 'Дверь открыта.');
    assert.equal(changes.length, 0);
});

test('parseMasterResponse возвращает changes и не путает их с [NEXT] и [ROLL]', () => {
    const parsed = parseMasterResponse('Ловушка срабатывает.\n[STATE {"hero1": {"hp": -3}}]\n[ROLL d20 DEX DC12 hero2]\n[NEXT: hero2]', { heroNames: names });
    assert.equal(parsed.text, 'Ловушка срабатывает.');
    assert.equal(parsed.next, 'hero2');
    assert.equal(parsed.rolls.length, 1);
    assert.deepEqual(parsed.changes, [{ hero: 'hero1', hp: -3, stats: {}, add: [], remove: [], use: [], relations: {}, group: null, leave: false }]);
});
