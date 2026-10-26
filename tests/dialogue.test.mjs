// Простой диалог двух персонажей (PLAN 10.1): очередь реплик и изоляция промпта. Запуск: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDialoguePrompt, dialogueNext, dialogueProblems, isDialogue } from '../src/dialogue.js';

const SECRET_THOUGHT_2 = 'Арен что-то скрывает';
const SECRET_CARD_2 = 'тайно служит культу';

function makeState(turns = []) {
    const hero = (name) => ({ cardAvatar: `${name}.png`, name, silence: 0 });
    return {
        mode: 'dialogue',
        heroes: [hero('Арен'), hero('Лиа')],
        scene: { premise: 'таверна, вечер, спор о погоде' },
        turns,
        memory: null,
    };
}

const cardOf = (name) => ({ name, description: `{{char}} беседует с {{user}}`, personality: 'вспыльчив', scenario: '' });

test('режим: по умолчанию RPG, диалог только по явному mode', () => {
    assert.equal(isDialogue({}), false);
    assert.equal(isDialogue({ mode: 'rpg' }), false);
    assert.equal(isDialogue({ mode: 'dialogue' }), true);
});

test('для старта нужны ровно две карточки', () => {
    assert.deepEqual(dialogueProblems({ selected: ['a', 'b'] }), []);
    assert.equal(dialogueProblems({ selected: ['a'] }).length, 1);
    assert.equal(dialogueProblems({ selected: [] }).length, 1);
});

test('очередь: первым персонаж 1, дальше строго по очереди, реплики мастера из RPG не считаются', () => {
    assert.equal(dialogueNext(makeState()), 'hero1');
    assert.equal(dialogueNext(makeState([{ author: 'hero1' }])), 'hero2');
    assert.equal(dialogueNext(makeState([{ author: 'hero1' }, { author: 'hero2' }])), 'hero1');
    assert.equal(dialogueNext(makeState([{ author: 'hero2' }, { author: 'master' }])), 'hero1');
});

test('промпт: своя карточка, имя собеседника и тема; без мастера и игровых правил', () => {
    const [system, user] = buildDialoguePrompt({ state: makeState(), heroIndex: 0, card: cardOf('Арен'), language: 'русский' });
    assert.match(system.content, /Ты — Арен/);
    assert.match(system.content, /Арен беседует с Лиа/);
    assert.match(system.content, /таверна, вечер/);
    assert.match(system.content, /РЕПЛИКА:/);
    assert.doesNotMatch(system.content, /Мастер|HP|бросок|d20/);
    assert.match(user.content, /Начни разговор, Арен/);
});

test('изоляция: мысли собеседника не попадают в промпт, свои — попадают', () => {
    const state = makeState([
        { n: 1, author: 'hero1', speech: 'Добрый вечер', intent: 'кивает', thoughts: 'надо быть осторожнее' },
        { n: 2, author: 'hero2', speech: 'И вам', intent: '', thoughts: SECRET_THOUGHT_2 },
    ]);
    const messages = buildDialoguePrompt({ state, heroIndex: 0, card: cardOf('Арен'), language: 'русский' });
    const text = messages.map((message) => message.content).join('\n');
    assert.doesNotMatch(text, new RegExp(SECRET_THOUGHT_2));
    assert.doesNotMatch(text, new RegExp(SECRET_CARD_2));
    assert.match(text, /надо быть осторожнее/);
    assert.match(text, /Лиа: «И вам»/);
    assert.match(text, /Твоя очередь, Арен/);

    const own = buildDialoguePrompt({ state, heroIndex: 1, card: cardOf('Лиа'), language: 'русский' }).map((m) => m.content).join('\n');
    assert.match(own, new RegExp(SECRET_THOUGHT_2));
    assert.doesNotMatch(own, /надо быть осторожнее/);
});
