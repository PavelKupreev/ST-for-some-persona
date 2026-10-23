// Уникальные прокачиваемые способности (новое, PLAN 6.4, FR-31).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ABILITY_MAX_LEVEL, findAbility, levelForUses, normalizeAbilityList, progressText, useAbility } from '../src/abilities.js';
import { formatRoll, parseRollTags, resolveCheck } from '../src/dice.js';
import { applyStateChanges, extractStateChanges } from '../src/heroState.js';
import { parseHeroSheets } from '../src/setup.js';
import { buildHeroPrompt, buildMasterPrompt } from '../src/prompts.js';

function makeHero(name, abilities) {
    return {
        name, stats: { STR: 10, DEX: 10, CON: 10, INT: 16, WIS: 10, CHA: 10 }, hp: { current: 10, max: 10 }, inventory: [],
        abilities: normalizeAbilityList(abilities),
    };
}

test('уровень растёт от применений: 3 → ур. 2, 7 → ур. 3, 18 → максимум', () => {
    assert.deepEqual([0, 2, 3, 6, 7, 12, 18, 40].map(levelForUses), [1, 1, 2, 2, 3, 4, 5, 5]);
    const hero = makeHero('Мира', [{ name: 'Огненный шар', stat: 'INT' }]);
    const ball = hero.abilities[0];
    assert.equal(progressText(ball), 'ур. 1 · 0/3');
    useAbility(hero, ball);
    useAbility(hero, ball);
    const third = useAbility(hero, ball);
    assert.equal(third.leveledUp, true);
    assert.equal(third.line, 'Мира: ✨ Огненный шар — уровень 2! (ур. 2 · 3/7)');
    for (let i = 0; i < 30; i++) useAbility(hero, ball);
    assert.equal(ball.level, ABILITY_MAX_LEVEL);
    assert.equal(progressText(ball), 'ур. 5, максимум');
});

test('поиск способности по названию из ответа мастера', () => {
    const hero = makeHero('Grokk', [{ name: 'Гигантификация', stat: 'STR' }, { name: 'Теневой шаг', stat: 'DEX' }]);
    assert.equal(findAbility(hero, 'теневой шаг')?.name, 'Теневой шаг');
    assert.equal(findAbility(hero, 'Гигант')?.name, 'Гигантификация');
    assert.equal(findAbility(hero, 'Полёт'), null);
});

test('бросок способности: стат способности + уровень, плашка с названием', () => {
    const [tag] = parseRollTags('[ROLL d20 Огненный шар DC14 hero1]');
    assert.deepEqual([tag.check, tag.stat, tag.target], ['Огненный шар', null, 'hero1']);
    const result = resolveCheck({ natural: 10, sides: 20, score: 16, dc: 14, bonus: 2 });
    assert.equal(result.modifier, 5);
    assert.equal(formatRoll(result, { heroName: 'Мира', stat: 'INT', ability: { name: 'Огненный шар', level: 2 } }),
        '🎲 Мира, Огненный шар (INT, ур. 2): d20+5 = 15 vs DC 14 ✅');
});

test('применение без броска через STATE use, повтор в одном блоке и уже засчитанное броском не считаются', () => {
    const heroes = [makeHero('Мира', [{ name: 'Огненный шар', stat: 'INT' }]), makeHero('Grokk', [{ name: 'Теневой шаг', stat: 'DEX' }])];
    const { changes } = extractStateChanges('[STATE {"hero1": {"use": ["Огненный шар", "огненный шар"]}, "Grokk": {"use": "Теневой шаг", "hp": -2}}]', ['Мира', 'Grokk']);
    const lines = applyStateChanges(heroes, changes, { skipUses: ['hero2:Теневой шаг'] });
    assert.equal(heroes[0].abilities[0].uses, 1);
    assert.equal(heroes[1].abilities[0].uses, 0);
    assert.deepEqual(lines, ['Мира: ✨ Огненный шар (ур. 1 · 1/3)', 'Grokk: HP 10 → 8 (−2)']);
});

test('листы героев: способности разбираются, уровень 1, не больше трёх', () => {
    const raw = JSON.stringify({ heroes: [
        { name: 'Мира', stats: { STR: 8, DEX: 12, CON: 10, INT: 16, WIS: 12, CHA: 10 }, hp: 8, abilities: [{ name: 'Огненный шар', description: 'Шар пламени', stat: 'INT' }], inventory: [] },
        { name: 'Grokk', stats: { STR: 17, DEX: 10, CON: 15, INT: 8, WIS: 10, CHA: 9 }, hp: 14, abilities: ['Гигантификация', { name: 'a' }, { name: 'b' }, { name: 'c' }], inventory: [] },
    ] });
    const [mira, grokk] = parseHeroSheets(raw, ['Мира', 'Grokk']);
    assert.deepEqual(mira.abilities, [{ name: 'Огненный шар', description: 'Шар пламени', stat: 'INT', level: 1, uses: 0 }]);
    assert.equal(grokk.abilities.length, 3);
    assert.equal(grokk.stats.STR, 17, 'статы не путаются со способностями');
});

test('способности видны герою и мастеру; чужих герой не видит', () => {
    const state = {
        world: null, turns: [], session: {},
        heroes: [makeHero('Мира', [{ name: 'Огненный шар', stat: 'INT', description: 'Шар пламени' }]), makeHero('Grokk', [{ name: 'Гигантификация', stat: 'STR' }])],
    };
    const hero1 = buildHeroPrompt({ state, heroIndex: 0, card: { name: 'Мира' }, language: 'русский' }).map((m) => m.content).join('\n');
    const master = buildMasterPrompt({ state, cards: [{ name: 'Мира' }, { name: 'Grokk' }], language: 'русский' }).map((m) => m.content).join('\n');
    assert.match(hero1, /- Огненный шар \(INT, ур\. 1 · 0\/3\): Шар пламени/);
    assert.doesNotMatch(hero1, /Гигантификация/);
    assert.match(master, /Огненный шар/);
    assert.match(master, /Гигантификация/);
    assert.match(master, /"use"/);
});
