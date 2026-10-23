// Проверка изоляции промптов (PLAN 2.1, 2.2, NFR-01). Запуск: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHeroPrompt, buildMasterPrompt } from '../src/prompts.js';

const SECRET_GOAL_1 = 'стать королём воров';
const SECRET_MICRO_1 = 'украсть ключ';
const SECRET_THOUGHT_1 = 'Лиа мне не нравится';
const SECRET_CARD_1 = 'тайно служит культу';
const NOTE = 'пусть пойдёт дождь';

function makeState() {
    const hero = (name, goal, micro) => ({
        cardAvatar: `${name}.png`, name, stats: { STR: 10, DEX: 14, CON: 12, INT: 10, WIS: 10, CHA: 10 },
        hp: { current: 10, max: 10 }, inventory: ['нож'], globalGoal: goal, microGoal: micro, silence: 0,
    });
    return {
        world: { setting: 'Пограничье', rules: ['Магия редка'], era: 'средневековье', tone: 'тревожный', powerLevel: 'низкий' },
        heroes: [hero('Арен', SECRET_GOAL_1, SECRET_MICRO_1), hero('Лиа', 'найти брата', 'узнать про письмо')],
        scene: { premise: '' },
        turns: [
            { n: 1, author: 'master', text: 'Трактир шумит.', rolls: [], next: 'hero1' },
            { n: 2, author: 'hero1', speech: 'Эля!', intent: 'Иду к стойке', thoughts: SECRET_THOUGHT_1 },
            { n: 3, author: 'master', text: 'Арен тянется.', rolls: [{ line: '🎲 Арен, DEX: d20+2 = 15 vs DC 12 ✅' }], next: 'hero2' },
            { n: 4, author: 'hero2', speech: 'Кто ты?', intent: 'Смотрю на Арена', thoughts: 'Он что-то скрывает' },
        ],
        session: { masterNote: NOTE, next: 'hero2' },
    };
}

const cards = [
    { name: 'Арен', description: `{{char}} — вор, ${SECRET_CARD_1}.` },
    { name: 'Лиа', description: '{{char}} — наёмница, ищет брата. Не доверяет {{user}}.' },
];

const text = (messages) => messages.map((m) => m.content).join('\n');

test('промпт мастера содержит все блоки', () => {
    const prompt = text(buildMasterPrompt({ state: makeState(), cards, language: 'русский' }));
    for (const needle of ['### МИР', '### ГЕРОЙ 1: Арен', '### ГЕРОЙ 2: Лиа', 'DEX 14 (+2)', SECRET_GOAL_1, SECRET_MICRO_1,
        SECRET_THOUGHT_1, 'Он что-то скрывает', '### ИСТОРИЯ СЦЕНЫ', '🎲 Арен', '### ЗАПИСКА ОТ ПОЛЬЗОВАТЕЛЯ', NOTE, 'русский']) {
        assert.ok(prompt.includes(needle), `нет «${needle}»`);
    }
});

test('промпт героя 2 не содержит тайн героя 1 и записки', () => {
    const prompt = text(buildHeroPrompt({ state: makeState(), heroIndex: 1, card: cards[1], language: 'русский' }));
    for (const secret of [SECRET_GOAL_1, SECRET_MICRO_1, SECRET_THOUGHT_1, SECRET_CARD_1, NOTE]) {
        assert.ok(!prompt.includes(secret), `утечка «${secret}»`);
    }
    // Своё и видимое на месте.
    for (const needle of ['найти брата', 'узнать про письмо', 'Он что-то скрывает', '«Эля!»', 'Иду к стойке', '🎲 Арен', 'Не доверяет Арен']) {
        assert.ok(prompt.includes(needle), `нет «${needle}»`);
    }
});

test('промпт героя 1 не содержит тайн героя 2', () => {
    const prompt = text(buildHeroPrompt({ state: makeState(), heroIndex: 0, card: cards[0], language: 'русский' }));
    for (const secret of ['найти брата', 'узнать про письмо', 'Он что-то скрывает', 'наёмница', NOTE]) {
        assert.ok(!prompt.includes(secret), `утечка «${secret}»`);
    }
    assert.ok(prompt.includes(SECRET_THOUGHT_1));
});

test('первый ход мастера просит начать сцену с завязкой', () => {
    const state = makeState();
    state.turns = [];
    state.scene.premise = 'Вечер в трактире';
    const prompt = text(buildMasterPrompt({ state, cards, language: 'русский' }));
    assert.ok(prompt.includes('Начни сцену') && prompt.includes('Вечер в трактире'));
});

test('пустая завязка: мастер придумывает её сам', () => {
    const state = makeState();
    state.turns = [];
    state.scene.premise = '  ';
    const prompt = text(buildMasterPrompt({ state, cards, language: 'русский' }));
    assert.ok(prompt.includes('Начни сцену') && prompt.includes('Завязки нет: придумай её сам'));
});

test('язык игры попадает в промпты мастера и героев (NFR-06)', () => {
    const state = makeState();
    for (const prompt of [
        text(buildMasterPrompt({ state, cards, language: 'English' })),
        text(buildHeroPrompt({ state, heroIndex: 0, card: cards[0], language: 'English' })),
        text(buildHeroPrompt({ state, heroIndex: 1, card: cards[1], language: 'English' })),
    ]) {
        assert.ok(prompt.includes('на языке: English'));
    }
});

test('частота проверок: обязательный бросок, запрет и свободный режим в промпте мастера', () => {
    const required = text(buildMasterPrompt({ state: makeState(), cards, language: 'русский', check: { mode: 'required', hero: 'hero2' } }));
    assert.match(required, /проверь броском: поставь ровно одну метку \[ROLL d20 СТАТ DCn hero2\]/);
    const forbidden = text(buildMasterPrompt({ state: makeState(), cards, language: 'русский', check: { mode: 'forbidden' } }));
    assert.match(forbidden, /не ставь/);
    assert.doesNotMatch(forbidden, /Формат метки/);
    const free = text(buildMasterPrompt({ state: makeState(), cards, language: 'русский' }));
    assert.match(free, /Если исход действия героя неочевиден/);
    assert.match(free, /не пиши за них/);
});
