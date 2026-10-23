// Скрытая память (PLAN 6.2, FR-26) и изоляция мыслей (NFR-01).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_KEEP, applySummaries, buildSummaryPrompts, turnsToCompress } from '../src/memory.js';
import { buildHeroPrompt, buildMasterPrompt } from '../src/prompts.js';

function makeState(count) {
    const hero = (name) => ({
        cardAvatar: `${name}.png`, name, stats: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        hp: { current: 10, max: 10 }, inventory: [], globalGoal: '', microGoal: '', silence: 0,
    });
    const turns = [];
    for (let n = 1; n <= count; n++) {
        const author = ['master', 'hero1', 'master', 'hero2'][(n - 1) % 4];
        turns.push(author === 'master'
            ? { n, author, text: `событие ${n}`, rolls: [] }
            : { n, author, speech: `реплика ${n}`, intent: `действие ${n}`, thoughts: `тайна-${author}-${n}` });
    }
    return {
        world: { setting: 'Город', rules: [] },
        heroes: [hero('Арен'), hero('Лиа')],
        scene: { premise: '' },
        turns,
        memory: null,
        session: { masterNote: '', next: 'master' },
    };
}

const cards = [{ name: 'Арен' }, { name: 'Лиа' }];
const text = (messages) => messages.map((m) => m.content).join('\n');

test('до порога сжимать нечего, после — всё, кроме последних ходов', () => {
    assert.equal(turnsToCompress(makeState(30), 30).length, 0);
    const state = makeState(31);
    const turns = turnsToCompress(state, 30);
    assert.equal(turns.length, 31 - MEMORY_KEEP);
    assert.equal(turns[0].n, 1);
    assert.equal(turnsToCompress(state, 0).length, 0, '0 — сжатие выключено');
});

test('промпт общей памяти без мыслей, промпт мыслей героя — только его мысли', () => {
    const state = makeState(31);
    const prompts = buildSummaryPrompts({ state, turns: turnsToCompress(state, 30), language: 'русский' });
    const byKey = Object.fromEntries(prompts.map((p) => [p.key, text(p.messages)]));
    assert.deepEqual(Object.keys(byKey).sort(), ['hero1', 'hero2', 'public']);
    assert.doesNotMatch(byKey.public, /тайна-/);
    assert.match(byKey.public, /реплика 2/);
    assert.match(byKey.hero1, /тайна-hero1-2/);
    assert.doesNotMatch(byKey.hero1, /тайна-hero2/);
    assert.doesNotMatch(byKey.hero2, /тайна-hero1/);
});

test('после сжатия промпты короче, память видна, чужих мыслей нет', () => {
    const state = makeState(31);
    const before = text(buildHeroPrompt({ state, heroIndex: 0, card: cards[0], language: 'русский' })).length;
    const turns = turnsToCompress(state, 30);
    applySummaries(state, turns, { public: 'ОБЩАЯ-ПАМЯТЬ', hero1: 'МЫСЛИ-АРЕНА', hero2: 'МЫСЛИ-ЛИИ' });
    assert.equal(state.memory.upTo, 21);

    const hero1 = text(buildHeroPrompt({ state, heroIndex: 0, card: cards[0], language: 'русский' }));
    const hero2 = text(buildHeroPrompt({ state, heroIndex: 1, card: cards[1], language: 'русский' }));
    const master = text(buildMasterPrompt({ state, cards, language: 'русский' }));

    assert.ok(hero1.length < before, 'промпт героя стал короче');
    assert.doesNotMatch(hero1, /событие 1\b/, 'сжатые ходы не попадают в историю');
    assert.match(hero1, /ОБЩАЯ-ПАМЯТЬ/);
    assert.match(hero1, /МЫСЛИ-АРЕНА/);
    assert.doesNotMatch(hero1, /МЫСЛИ-ЛИИ/);
    assert.match(hero2, /МЫСЛИ-ЛИИ/);
    assert.doesNotMatch(hero2, /МЫСЛИ-АРЕНА/);
    assert.doesNotMatch(hero2, /тайна-hero1/);
    assert.match(master, /МЫСЛИ-АРЕНА/);
    assert.match(master, /МЫСЛИ-ЛИИ/);
});

test('повторное сжатие учитывает прежнюю память и сдвигает границу', () => {
    const state = makeState(31);
    applySummaries(state, turnsToCompress(state, 30), { public: 'ПЕРВАЯ' });
    for (let n = 32; n <= 52; n++) state.turns.push({ n, author: 'master', text: `событие ${n}`, rolls: [] });
    const turns = turnsToCompress(state, 30);
    assert.equal(turns[0].n, 22);
    const prompt = text(buildSummaryPrompts({ state, turns, language: 'русский' })[0].messages);
    assert.match(prompt, /ПЕРВАЯ/);
});
