// Простой диалог двух персонажей (PLAN 10.1): очередь, изоляция промпта и разбор ответа. Запуск: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDialoguePrompt, dialogueNext, dialogueProblems, isDialogue, parseDialogueResponse } from '../src/dialogue.js';

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
    assert.doesNotMatch(system.content, /РЕПЛИКА:/);
    assert.match(system.content, /курсивом/);
    assert.doesNotMatch(system.content, /Мастер|HP|бросок|d20/);
    assert.match(user.content, /Начни разговор, Арен/);
});

test('изоляция: в промпт идут сообщения разговора, но ничьи мысли и не карточка собеседника', () => {
    const state = makeState([
        // ходы старого формата, сыгранные до этапа 10
        { n: 1, author: 'hero1', speech: 'Добрый вечер', intent: 'кивает', thoughts: 'надо быть осторожнее' },
        { n: 2, author: 'hero2', speech: 'И вам', intent: '', thoughts: SECRET_THOUGHT_2 },
        { n: 3, author: 'hero1', text: '«Дождь опять.» *Арен стряхивает капли с плаща.*' },
        { n: 4, author: 'hero2', text: '*Лиа пожимает плечами.* «Здесь всегда дождь.»' },
    ]);
    const text = buildDialoguePrompt({ state, heroIndex: 0, card: cardOf('Арен'), language: 'русский' }).map((m) => m.content).join('\n');
    assert.doesNotMatch(text, new RegExp(SECRET_THOUGHT_2));
    assert.doesNotMatch(text, new RegExp(SECRET_CARD_2));
    assert.doesNotMatch(text, /надо быть осторожнее/);
    assert.match(text, /Ты \(Арен\): «Добрый вечер» \*кивает\*/);
    assert.match(text, /Лиа: «И вам»/);
    assert.match(text, /Ты \(Арен\): «Дождь опять\.»/);
    assert.match(text, /Лиа: \*Лиа пожимает плечами\.\*/);
    assert.match(text, /Твоя очередь, Арен/);

    const other = buildDialoguePrompt({ state, heroIndex: 1, card: cardOf('Лиа'), language: 'русский' }).map((m) => m.content).join('\n');
    assert.doesNotMatch(other, new RegExp(SECRET_THOUGHT_2));
    assert.doesNotMatch(other, /надо быть осторожнее/);
    assert.match(other, /Ты \(Лиа\): \*Лиа пожимает/);
});

test('ответ: снимается своё имя в начале', () => {
    assert.deepEqual(parseDialogueResponse('Арен: «Привет.» *улыбается*', { name: 'Арен', otherName: 'Лиа' }), { text: '«Привет.» *улыбается*' });
    assert.deepEqual(parseDialogueResponse('**Арен:** «Привет.»', { name: 'Арен', otherName: 'Лиа' }), { text: '«Привет.»' });
    assert.deepEqual(parseDialogueResponse('*Арен садится.* «Ну?»\r\n', { name: 'Арен', otherName: 'Лиа' }), { text: '*Арен садится.* «Ну?»' });
});

test('ответ: обрезается то, что модель начала писать за собеседника', () => {
    const raw = '«Ну что, пойдём?»\r\n\r\n*Арен встаёт.*\r\nЛиа: «Пойдём.»\r\n*Лиа тоже встаёт.*';
    assert.deepEqual(parseDialogueResponse(raw, { name: 'Арен', otherName: 'Лиа' }), { text: '«Ну что, пойдём?»\n\n*Арен встаёт.*' });
});

test('ответ: пустой — ошибка', () => {
    assert.throws(() => parseDialogueResponse('   ', { name: 'Арен', otherName: 'Лиа' }), /Пустой ответ персонажа/);
    assert.throws(() => parseDialogueResponse('Арен:', { name: 'Арен', otherName: 'Лиа' }), /Пустой ответ/);
    assert.throws(() => parseDialogueResponse('Лиа: «Я за него.»', { name: 'Арен', otherName: 'Лиа' }), /Пустой ответ/);
});
