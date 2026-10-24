// Герой при HP 0 и игровое время (PLAN 8.5, FR-32). Запуск: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOCKOUT_HOURS, activeHeroes, applyVitality, conditionText, parseHours, resetVitality } from '../src/vitality.js';
import { applyStateChanges, extractStateChanges } from '../src/heroState.js';

const makeState = () => ({
    heroes: [
        { name: 'Мира', hp: { current: 3, max: 10 }, stats: {}, inventory: [] },
        { name: 'Grokk', hp: { current: 18, max: 18 }, stats: {}, inventory: [] },
    ],
});

test('время из блока STATE: часы, дни, строки', () => {
    assert.equal(extractStateChanges('Ночь прошла.\n[STATE {"time": 8}]').hours, 8);
    assert.equal(extractStateChanges('[STATE {"hero1": {"hp": -2}, "время": "2 дня"}]').hours, 48);
    assert.equal(parseHours('1d'), 24);
    assert.equal(parseHours('30 мин'), 0.5);
    assert.equal(parseHours('бесконечность'), 0);
    assert.equal(extractStateChanges('[STATE {"time": 8}]').text, '', 'блок с одним временем вырезается');
});

test('без смерти: HP 0 — отключка минимум на сутки, лечение не будит, через сутки встаёт с HP ≥ 1', () => {
    const state = makeState();
    applyStateChanges(state.heroes, extractStateChanges('[STATE {"hero1": {"hp": -10}}]').changes);
    const lines = applyVitality(state, { mode: 'knockout' });
    assert.match(lines[0], /Мира без сознания/);
    assert.deepEqual(activeHeroes(state), [false, true]);
    assert.match(conditionText(state.heroes[0], 0), new RegExp(`ещё ${KNOCKOUT_HOURS} ч`));

    applyStateChanges(state.heroes, extractStateChanges('[STATE {"hero1": {"hp": 5}}]').changes);
    applyVitality(state, { hours: 23, mode: 'knockout' });
    assert.deepEqual(activeHeroes(state), [false, true], 'жёсткая отключка: лечение и 23 часа не будят');

    const wake = applyVitality(state, { hours: 1, mode: 'knockout' });
    assert.ok(wake.some((line) => /Мира приходит в себя \(HP 5\/10\)/.test(line)));
    assert.deepEqual(activeHeroes(state), [true, true]);
});

test('со смертью: HP 0 — погиб навсегда, лечение не действует', () => {
    const state = makeState();
    state.heroes[0].hp.current = 0;
    assert.match(applyVitality(state, { mode: 'death' })[0], /Мира погибает/);
    assert.deepEqual(applyStateChanges(state.heroes, extractStateChanges('[STATE {"hero1": {"hp": 5}}]').changes), []);
    applyVitality(state, { hours: 100, mode: 'death' });
    assert.equal(state.heroes[0].hp.current, 0);
    assert.deepEqual(activeHeroes(state), [false, true]);
});

test('новая сцена: все в строю, часы с нуля', () => {
    const state = makeState();
    state.heroes[0].hp.current = 0;
    applyVitality(state, { hours: 5, mode: 'death' });
    resetVitality(state);
    assert.deepEqual(state.clock, { hours: 0 });
    assert.deepEqual(activeHeroes(state), [true, true]);
});

test('мастер забыл "time": время из текста «спустя сутки» (повторный прогон, PLAN 8.5)', async () => {
    const { hoursFromText } = await import('../src/vitality.js');
    assert.equal(hoursFromText('Spустя сутки, в лесу восстанавливается спокойствие.'), 24, 'латиница в слове, как в живом прогоне');
    assert.equal(hoursFromText('Спустя сутки… прошли сутки.'), 24);
    assert.equal(hoursFromText('Через два дня они вышли к реке.'), 48);
    assert.equal(hoursFromText('Прошло три часа.'), 3);
    assert.equal(hoursFromText('Минула ночь.'), 12);
    assert.equal(hoursFromText('Two days later the rain stops.'), 48);
    assert.equal(hoursFromText('Они идут через лес, через реку.'), 0);
    assert.equal(hoursFromText('Grokk бьёт через силу.'), 0);
});

test('мастер не пишет плашку броска сам', async () => {
    const { parseMasterResponse } = await import('../src/parse.js');
    const parsed = parseMasterResponse('Grokk трясёт Миру.\n\n🎲 Grokk, CON: [ROLL d20 CON DC15 hero1]', { heroNames: ['Grokk', 'Мира'] });
    assert.equal(parsed.text, 'Grokk трясёт Миру.');
    assert.equal(parsed.rolls.length, 1);
});
