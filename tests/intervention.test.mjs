// Вмешательство (PLAN 5.1, 5.2): микроцель видят только её герой и мастер (FR-18), записка одноразовая и только у мастера (FR-19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMasterNote, applyMicroGoal, consumeMasterNote } from '../src/intervention.js';
import { buildHeroPrompt, buildMasterPrompt } from '../src/prompts.js';

function makeState() {
    const hero = (name, micro) => ({
        cardAvatar: `${name}.png`, name, stats: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        hp: { current: 10, max: 10 }, inventory: [], globalGoal: `цель ${name}`, microGoal: micro, silence: 0,
    });
    return {
        world: { setting: 'Город', rules: [], era: '', tone: '', powerLevel: '' },
        heroes: [hero('Арен', 'старая микроцель'), hero('Лиа', 'узнать про письмо')],
        scene: { premise: '' },
        turns: [{ n: 1, author: 'master', text: 'Рынок шумит.', rolls: [], next: 'hero1' }],
        session: { masterNote: '', next: 'hero1' },
    };
}

const cards = [{ name: 'Арен', description: 'вор' }, { name: 'Лиа', description: 'наёмница' }];
const text = (messages) => messages.map((m) => m.content).join('\n');
const heroPrompt = (state, index) => text(buildHeroPrompt({ state, heroIndex: index, card: cards[index], language: 'русский' }));
const masterPrompt = (state) => text(buildMasterPrompt({ state, cards, language: 'русский' }));

test('новая микроцель заменяет старую и видна только герою и мастеру', () => {
    const state = makeState();
    const previous = applyMicroGoal(state, 0, '  украсть ключ ');
    assert.equal(previous, 'старая микроцель');
    assert.equal(state.heroes[0].microGoal, 'украсть ключ');

    assert.ok(heroPrompt(state, 0).includes('украсть ключ'));
    assert.ok(!heroPrompt(state, 0).includes('старая микроцель'));
    assert.ok(masterPrompt(state).includes('украсть ключ'));
    assert.ok(!heroPrompt(state, 1).includes('украсть ключ'), 'утечка микроцели героя 1 во второго');
    assert.ok(heroPrompt(state, 1).includes('узнать про письмо'), 'своя микроцель героя 2 на месте');
});

test('микроцель: пустой текст и неверный герой отклоняются', () => {
    const state = makeState();
    assert.throws(() => applyMicroGoal(state, 0, '   '), /Напишите микроцель/);
    assert.throws(() => applyMicroGoal(state, 5, 'что-то'), /Выберите героя/);
    assert.throws(() => applyMicroGoal(state, 0, 'я'.repeat(501)), /длиннее/);
    assert.equal(state.heroes[0].microGoal, 'старая микроцель');
});

test('записка попадает только к мастеру и снимается после его хода', () => {
    const state = makeState();
    applyMasterNote(state.session, 'пусть пойдёт дождь');
    assert.ok(masterPrompt(state).includes('пусть пойдёт дождь'));
    for (const index of [0, 1]) assert.ok(!heroPrompt(state, index).includes('пусть пойдёт дождь'));

    assert.equal(consumeMasterNote(state.session, 'пусть пойдёт дождь'), true);
    assert.equal(state.session.masterNote, '');
    assert.ok(!masterPrompt(state).includes('ЗАПИСКА'), 'записка не должна повториться в следующем ходе');
});

test('записка, написанная пока мастер думал, не теряется', () => {
    const state = makeState();
    applyMasterNote(state.session, 'пусть пойдёт дождь');
    const sent = state.session.masterNote;
    applyMasterNote(state.session, 'пусть придёт стража');
    assert.equal(consumeMasterNote(state.session, sent), false);
    assert.equal(state.session.masterNote, 'пусть придёт стража');
    assert.equal(consumeMasterNote(state.session, ''), false, 'ход без записки ничего не снимает');
    assert.equal(state.session.masterNote, 'пусть придёт стража');
});
