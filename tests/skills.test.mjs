// Навыки 5e с владением (новое, PLAN 6.3). Отключены по просьбе пользователя 23.10.2026: в промпты и форму не попадают,
// разбор меток и бросок с владением в dice.js оставлены.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRoll, normalizeSkill, normalizeSkillList, parseRollTags, resolveCheck } from '../src/dice.js';
import { parseHeroSheets } from '../src/setup.js';
import { buildHeroPrompt } from '../src/prompts.js';

test('навык узнаётся по id, русскому и английскому названию', () => {
    assert.equal(normalizeSkill('STEALTH'), 'STEALTH');
    assert.equal(normalizeSkill('Скрытность'), 'STEALTH');
    assert.equal(normalizeSkill('Sleight of Hand'), 'SLEIGHT');
    assert.equal(normalizeSkill('ловкость рук'), 'SLEIGHT');
    assert.equal(normalizeSkill('Уход за животными'), 'ANIMALS');
    assert.equal(normalizeSkill('полёт'), null);
    assert.deepEqual(normalizeSkillList(['Perception', 'Восприятие', 'чепуха', 'ATHLETICS']), ['PERCEPTION', 'ATHLETICS']);
});

test('метка броска с навыком: характеристика навыка, многословные названия', () => {
    const rolls = parseRollTags('[ROLL d20 STEALTH DC12 hero1] [ROLL d20 Ловкость рук DC14 hero2] [ROLL d20 DEX DC10] [ROLL d20 Полёт DC10]');
    assert.equal(rolls.filter((roll) => roll.stat).length, 3);
    assert.deepEqual([rolls[0].skill, rolls[0].stat, rolls[0].target], ['STEALTH', 'DEX', 'hero1']);
    assert.deepEqual([rolls[1].skill, rolls[1].stat, rolls[1].dc, rolls[1].target], ['SLEIGHT', 'DEX', 14, 'hero2']);
    assert.deepEqual([rolls[2].skill, rolls[2].stat], [null, 'DEX']);
});

test('владение даёт +2, без владения — только модификатор характеристики', () => {
    const own = resolveCheck({ natural: 8, sides: 20, score: 14, dc: 12, proficient: true });
    assert.equal(own.modifier, 4);
    assert.equal(own.success, true);
    const plain = resolveCheck({ natural: 8, sides: 20, score: 14, dc: 12 });
    assert.equal(plain.modifier, 2);
    assert.equal(plain.success, false);
    assert.equal(formatRoll(own, { heroName: 'Арен', stat: 'DEX', skill: 'STEALTH' }), '🎲 Арен, Скрытность (DEX, владение): d20+4 = 12 vs DC 12 ✅');
    assert.equal(formatRoll(plain, { heroName: 'Арен', stat: 'DEX', skill: 'STEALTH' }), '🎲 Арен, Скрытность (DEX): d20+2 = 10 vs DC 12 ❌');
});

test.skip('листы героев: навыки разбираются, лишние отброшены (навыки отключены)', () => {
    const raw = JSON.stringify({ heroes: [
        { name: 'Арен', stats: { STR: 10, DEX: 16, CON: 12, INT: 10, WIS: 12, CHA: 8 }, hp: 10, skills: ['STEALTH', 'Восприятие', 'летать'], inventory: [] },
        { name: 'Лиа', stats: { STR: 15, DEX: 10, CON: 14, INT: 10, WIS: 10, CHA: 12 }, hp: 12, inventory: [] },
    ] });
    const [aren, lia] = parseHeroSheets(raw, ['Арен', 'Лиа']);
    assert.deepEqual(aren.skills, ['STEALTH', 'PERCEPTION']);
    assert.deepEqual(lia.skills, []);
});

test.skip('навыки героя видны в его промпте (навыки отключены)', () => {
    const hero = (name, skills) => ({ name, stats: { STR: 10, DEX: 14, CON: 10, INT: 10, WIS: 10, CHA: 10 }, hp: { current: 10, max: 10 }, skills, inventory: [] });
    const state = { world: null, heroes: [hero('Арен', ['STEALTH']), hero('Лиа', ['ATHLETICS'])], turns: [], session: {} };
    const prompt = buildHeroPrompt({ state, heroIndex: 0, card: { name: 'Арен' }, language: 'русский' }).map((m) => m.content).join('\n');
    assert.match(prompt, /Навыки с владением \(\+2 к проверке\): Скрытность \(STEALTH, DEX\)/);
});
