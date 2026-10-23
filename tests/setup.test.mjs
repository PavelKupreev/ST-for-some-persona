// Старт игры: карточка мира и листы героев (PLAN 3.1, 3.3, 3.5). Запуск: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    blankSheet, buildHeroesPrompt, buildWorldPrompt, createHero, extractJson, parseHeroSheets, parseWorldCard, startProblems,
} from '../src/setup.js';
import { ParseError } from '../src/parse.js';

const WORLD_JSON = {
    setting: 'Королевство под тенью драконов.',
    rules: ['Драконы правят небом', 'Магия стоит памяти', 'Чудовища приходят волнами'],
    era: 'раннее средневековье',
    tone: 'мрачный',
    powerLevel: 'средний',
};

const hero = (name, stats = { STR: 12, DEX: 15, CON: 13, INT: 10, WIS: 11, CHA: 14 }) => ({
    name, stats, hp: 12, inventory: ['меч', 'верёвка'], globalGoal: `цель ${name}`, microGoal: `микро ${name}`,
});

test('карточка мира: чистый JSON', () => {
    const world = parseWorldCard(JSON.stringify(WORLD_JSON), 'фэнтези, драконы');
    assert.equal(world.prompt, 'фэнтези, драконы');
    assert.equal(world.setting, WORLD_JSON.setting);
    assert.deepEqual(world.rules, WORLD_JSON.rules);
    assert.equal(world.powerLevel, 'средний');
});

test('карточка мира: markdown, пояснения, висячая запятая, правила строкой', () => {
    const raw = 'Вот мир:\n```json\n{"Setting": "Острова", "rules": "1. Море живое\\n2. Луна двойная\\n3. Соль — деньги", "era": "эпоха парусов", "tone": "приключение", "power_level": "низкий",}\n```\nУдачи!';
    const world = parseWorldCard(raw, 'x');
    assert.equal(world.setting, 'Острова');
    assert.deepEqual(world.rules, ['Море живое', 'Луна двойная', 'Соль — деньги']);
    assert.equal(world.powerLevel, 'низкий');
});

test('карточка мира: больше 5 правил обрезаются', () => {
    const world = parseWorldCard(JSON.stringify({ ...WORLD_JSON, rules: ['1', '2', '3', '4', '5', '6', '7'] }));
    assert.equal(world.rules.length, 5);
});

test('карточка мира: битый JSON и пропущенные поля → ParseError', () => {
    assert.throws(() => parseWorldCard('Не могу придумать мир'), ParseError);
    assert.throws(() => parseWorldCard('{"setting": "x", "rules": ['), ParseError);
    assert.throws(() => parseWorldCard(JSON.stringify({ setting: 'x' })), /правила, эпоха, тон, уровень силы/);
});

test('листы героев: порядок по именам, клампинг статов и HP', () => {
    const raw = JSON.stringify({ heroes: [hero('Лиа', { STR: 25, DEX: 0, CON: '14', INT: 10.4, WIS: 9, CHA: 8 }), { ...hero('Арен'), hp: { max: 1500 } }] });
    const [aren, lia] = parseHeroSheets(raw, ['Арен', 'Лиа']);
    assert.equal(aren.globalGoal, 'цель Арен');
    assert.equal(aren.hp, 999);
    assert.deepEqual(lia.stats, { STR: 20, DEX: 1, CON: 14, INT: 10, WIS: 9, CHA: 8 });
    assert.deepEqual(lia.inventory, ['меч', 'верёвка']);
});

test('листы героев: голый массив, полные названия статов, чужие имена → по порядку', () => {
    const long = { strength: 8, dexterity: 16, constitution: 12, intelligence: 14, wisdom: 10, charisma: 13 };
    const raw = '```\n[' + JSON.stringify(hero('Alice', long)) + ',' + JSON.stringify(hero('Bob')) + ']\n```';
    const [first, second] = parseHeroSheets(raw, ['Арен', 'Лиа']);
    assert.equal(first.stats.DEX, 16);
    assert.equal(first.microGoal, 'микро Alice');
    assert.equal(second.stats.CHA, 14);
});

test('листы героев: битый JSON, один герой, нет статов → ParseError', () => {
    assert.throws(() => parseHeroSheets('{"heroes": [', ['А', 'Б']), ParseError);
    assert.throws(() => parseHeroSheets(JSON.stringify({ heroes: [hero('А')] }), ['А', 'Б']), ParseError);
    const noStats = { ...hero('Б'), stats: { STR: 10 } };
    assert.throws(() => parseHeroSheets(JSON.stringify({ heroes: [hero('А'), noStats] }), ['А', 'Б']), /Лист героя Б: нет статов DEX/);
});

test('extractJson прощает мусор вокруг и возвращает null без JSON', () => {
    assert.deepEqual(extractJson('ok {"a": [1, 2,],} end'), { a: [1, 2] });
    assert.equal(extractJson('просто текст'), null);
});

test('промпты старта содержат язык игры и данные карточек (NFR-06)', () => {
    const worldPrompt = buildWorldPrompt({ prompt: 'фэнтези, драконы', language: 'English' }).map((m) => m.content).join('\n');
    assert.ok(worldPrompt.includes('на языке: English') && worldPrompt.includes('фэнтези, драконы'));

    const cards = [{ name: 'Арен', description: '{{char}} — вор, друг {{user}}' }, { name: 'Лиа', personality: 'упрямая' }];
    const heroesPrompt = buildHeroesPrompt({ world: WORLD_JSON, cards, language: 'русский' }).map((m) => m.content).join('\n');
    for (const needle of ['на языке: русский', 'Арен — вор, друг Лиа', 'Характер: упрямая', 'Магия стоит памяти', '"heroes"']) {
        assert.ok(heroesPrompt.includes(needle), `нет «${needle}»`);
    }
});

test('готовность к старту: ровно 2 карточки и листы для них (FR-03)', () => {
    const world = { ...WORLD_JSON };
    const heroes = [createHero({ avatar: 'a.png', name: 'А' }, blankSheet()), createHero({ avatar: 'b.png', name: 'Б' }, blankSheet())];
    assert.deepEqual(startProblems({ world, heroes, selected: ['a.png', 'b.png'] }), []);
    assert.match(startProblems({ world, heroes, selected: ['a.png'] })[0], /1 из 2/);
    assert.match(startProblems({ world, heroes, selected: ['a.png', 'b.png', 'c.png'] })[0], /3 из 2/);
    assert.match(startProblems({ world, heroes, selected: ['a.png', 'c.png'] })[0], /не сгенерированы/);
    assert.match(startProblems({ world: null, heroes, selected: ['a.png', 'b.png'] })[0], /нет карточки мира/);
    heroes[1].stats.STR = 21;
    assert.match(startProblems({ world, heroes, selected: ['a.png', 'b.png'] })[0], /Б: статы вне 1–20 \(STR\)/);
});
