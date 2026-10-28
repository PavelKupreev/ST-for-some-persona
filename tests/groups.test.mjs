// До 10 героев, группы, режимы и ход игрока (этапы 11–14, FR-03, FR-33–FR-37). Запуск: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { canSee, hasManyGroups, liveGroups, moveHero, normalizeGroup, resolveHero } from '../src/heroes.js';
import { gameMode, heroCount, modelsFor, usesDice } from '../src/modes.js';
import { chooseNext, effectiveSilenceThreshold, updateSilence } from '../src/turnOrder.js';
import { dialogueNext } from '../src/dialogue.js';
import { normalizeNext, parseMasterResponse, parsePlayerText, ParseError } from '../src/parse.js';
import { extractStateChanges } from '../src/heroState.js';
import { buildHeroPrompt, buildMasterPrompt } from '../src/prompts.js';
import { applySummaries, buildSummaryPrompts } from '../src/memory.js';

const NAMES = ['Арен', 'Лиа', 'Мира', 'Мирабель', 'Грокк', 'Ода', 'Тил', 'Вэй', 'Кассий', 'Юна'];
const text = (messages) => messages.map((m) => m.content).join('\n');

function hero(name, group = 'A', extra = {}) {
    return {
        cardAvatar: `${name}.png`, name, stats: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        hp: { current: 10, max: 10 }, inventory: [], globalGoal: `тайна ${name}`, microGoal: `микро ${name}`,
        silence: 0, group, homeGroup: group, ...extra,
    };
}

// Четыре героя: Арен и Лиа в группе A, Мира и Грокк в группе B.
function fourHeroes() {
    return {
        mode: 'adventure',
        world: { setting: 'Пограничье', rules: [], era: '', tone: '', powerLevel: '' },
        heroes: [hero('Арен', 'A'), hero('Лиа', 'A'), hero('Мира', 'B'), hero('Грокк', 'B')],
        scene: { premise: '' },
        turns: [
            { n: 1, author: 'master', group: 'A', text: 'Трактир в городе.', rolls: [] },
            { n: 2, author: 'hero1', group: 'A', speech: 'Эля!', intent: 'иду к стойке', thoughts: 'мысль Арена' },
            { n: 3, author: 'master', group: 'B', text: 'Лес у реки.', rolls: [] },
            { n: 4, author: 'hero3', group: 'B', speech: 'Тише.', intent: 'прячусь', thoughts: 'мысль Миры' },
        ],
        session: { masterNote: '', next: 'hero2', focus: 'B' },
    };
}

const card = (name) => ({ name, description: `{{char}} — ${name}.` });

test('hero10 не путается с hero1, имя — самое длинное совпадение', () => {
    assert.equal(resolveHero('hero10', NAMES), 'hero10');
    assert.equal(resolveHero('Герой 10', NAMES), 'hero10');
    assert.equal(resolveHero('hero1', NAMES), 'hero1');
    assert.equal(resolveHero('hero11', NAMES), null);
    assert.equal(resolveHero('идёт Мирабель', NAMES), 'hero4');
    assert.equal(resolveHero('Мира', NAMES, { exact: true }), 'hero3');
    assert.equal(normalizeNext('[hero10]', NAMES), 'hero10');
});

test('группы: кириллица и номера, переход и видимость по времени пребывания', () => {
    assert.equal(normalizeGroup('Группа В'), 'B');
    assert.equal(normalizeGroup('3'), 'C');
    assert.equal(normalizeGroup('Z'), null);

    const lia = hero('Лиа', 'A');
    assert.ok(moveHero(lia, 'B', 4));
    assert.ok(canSee(lia, 'hero2', { n: 3, author: 'master', group: 'A' }), 'видела A до ухода');
    assert.ok(!canSee(lia, 'hero2', { n: 5, author: 'master', group: 'A' }), 'не видит A после ухода');
    assert.ok(!canSee(lia, 'hero2', { n: 3, author: 'master', group: 'B' }), 'не видит B до прихода');
    assert.ok(canSee(lia, 'hero2', { n: 6, author: 'master', group: 'B' }));

    assert.ok(moveHero(lia, null, 7));
    assert.equal(lia.group, null);
    assert.ok(!canSee(lia, 'hero2', { n: 8, author: 'master', group: 'B' }), 'замороженный ничего не видит');
});

test('isolation на 4 героях: герой не видит ходов, тайн и мыслей чужой группы', () => {
    const state = fourHeroes();
    const prompt = text(buildHeroPrompt({ state, heroIndex: 1, card: card('Лиа'), language: 'русский' }));
    for (const secret of ['Лес у реки', 'Тише.', 'прячусь', 'мысль Миры', 'мысль Арена', 'тайна Миры', 'тайна Арен', 'тайна Грокк', 'микро Арен']) {
        assert.ok(!prompt.includes(secret), `утечка «${secret}»`);
    }
    for (const needle of ['Трактир в городе', 'Эля!', 'Твоя группа: A']) assert.ok(prompt.includes(needle), `нет «${needle}»`);

    const master = text(buildMasterPrompt({ state, cards: state.heroes.map((h) => card(h.name)), language: 'русский', scene: { focus: 'B' } }));
    for (const needle of ['[A] Мастер: Трактир', '[B] Мастер: Лес', 'мысль Миры', 'master B']) assert.ok(master.includes(needle), `нет у мастера «${needle}»`);
});

test('память по группам: пересказ группы собирается только из её ходов', () => {
    const state = fourHeroes();
    const prompts = buildSummaryPrompts({ state, turns: state.turns, language: 'русский' });
    const byKey = Object.fromEntries(prompts.map((p) => [p.key, text(p.messages)]));
    assert.ok(byKey.public.includes('Трактир') && !byKey.public.includes('Лес у реки'));
    assert.ok(byKey['public:B'].includes('Лес у реки') && !byKey['public:B'].includes('Трактир'));
    assert.ok(!byKey.public.includes('мысль Арена'), 'в общую память мысли не идут');

    applySummaries(state, state.turns, { public: 'было в A', 'public:B': 'было в B', hero1: 'думал Арен' });
    const lia = text(buildHeroPrompt({ state, heroIndex: 1, card: card('Лиа'), language: 'русский' }));
    assert.ok(lia.includes('было в A') && !lia.includes('было в B') && !lia.includes('думал Арен'));
});

test('очередь на 5 героях: порог молчания растёт, замороженный не ходит и не молчит', () => {
    assert.equal(effectiveSilenceThreshold(4, 2), 4);
    assert.equal(effectiveSilenceThreshold(4, 5), 9);
    assert.equal(effectiveSilenceThreshold(0, 5), 0);

    const heroes = ['a', 'b', 'c', 'd', 'e'].map((name) => hero(name));
    heroes[4].group = null;
    heroes[4].silence = 3;
    updateSilence(heroes, 'hero1');
    assert.deepEqual(heroes.map((h) => h.silence), [0, 1, 1, 1, 3]);

    const silence = [0, 9, 0, 0, 20];
    const active = [true, true, true, true, false];
    assert.deepEqual(chooseNext({ author: 'master', silence, randomness: 0, silenceThreshold: 4, active }), { next: 'hero2', reason: 'silence' });
    assert.equal(chooseNext({ author: 'master', masterChoice: 'hero5', silence: [0, 0, 0, 0, 0], randomness: 0, silenceThreshold: 4, active }).reason, 'unavailable');
    assert.equal(chooseNext({ author: 'master', masterChoice: 'hero4', silence: [0, 0, 0, 0, 0], randomness: 0, silenceThreshold: 4, active }).next, 'hero4');
});

test('без мастера: 3 персонажа в двух группах — говорит только группа, где двое, по кругу', () => {
    const state = { mode: 'free', heroes: [hero('Арен', 'A'), hero('Лиа', 'B'), hero('Мира', 'A')], turns: [] };
    assert.equal(dialogueNext(state), 'hero1');
    state.turns.push({ n: 1, author: 'hero1', group: 'A', text: 'привет' });
    assert.equal(dialogueNext(state), 'hero3');
    state.turns.push({ n: 2, author: 'hero3', group: 'A', text: 'и тебе' });
    assert.equal(dialogueNext(state), 'hero1');
    state.heroes[2].group = 'B';
    assert.equal(dialogueNext(state), 'hero2');
    state.heroes[0].group = null;
    state.heroes[1].group = 'C';
    assert.equal(dialogueNext(state), null);
});

test('[NEXT: master B] переводит мастера к группе B, STATE двигает героя', () => {
    const parsed = parseMasterResponse('Ночь опускается.\n[NEXT: master группа В]', { heroNames: NAMES });
    assert.equal(parsed.next, 'master');
    assert.equal(parsed.nextGroup, 'B');
    assert.equal(parseMasterResponse('Ночь.\n[NEXT: hero2]', { heroNames: NAMES }).nextGroup, null);

    const { changes } = extractStateChanges('Текст.\n[STATE {"Лиа": {"group": "B"}, "Арен": {"leave": true}}]', NAMES);
    const lia = changes.find((c) => c.hero === 'hero2');
    const aren = changes.find((c) => c.hero === 'hero1');
    assert.equal(lia.group, 'B');
    assert.equal(aren.leave, true);
});

test('ход игрока: *курсив* — действие, остальное — речь, пустой — ошибка', () => {
    assert.deepEqual(parsePlayerText('*достаёт нож* Не подходи! *шагает назад*'), { speech: 'Не подходи!', intent: 'достаёт нож шагает назад', thoughts: '' });
    assert.deepEqual(parsePlayerText('Привет'), { speech: 'Привет', intent: '', thoughts: '' });
    assert.deepEqual(parsePlayerText('**кивает**'), { speech: '', intent: 'кивает', thoughts: '' });
    assert.throws(() => parsePlayerText('   '), ParseError);
});

test('режимы: старые значения, число героев, кубики и модели романтики', () => {
    assert.equal(gameMode({ mode: 'rpg' }), 'adventure');
    assert.equal(gameMode({ mode: 'dialogue' }), 'free');
    assert.equal(gameMode({}), 'adventure');
    assert.equal(heroCount({ mode: 'free', setup: { count: 1 } }), 2);
    assert.equal(heroCount({ mode: 'romance', setup: { count: 1 } }), 1);
    assert.equal(heroCount({ mode: 'adventure', setup: { count: 42 } }), 10);
    assert.ok(usesDice({ mode: 'adventure' }) && !usesDice({ mode: 'romance' }));

    const settings = { masterModel: 'm', heroModel: 'h', romanceMasterModel: ' rm ', romanceHeroModel: '' };
    assert.deepEqual(modelsFor(settings, { mode: 'adventure' }), { master: 'm', hero: 'h' });
    assert.deepEqual(modelsFor(settings, { mode: 'romance' }), { master: 'rm', hero: 'h' });
});

test('романтика: мастер без кубиков, правило 18+', () => {
    const state = { ...fourHeroes(), mode: 'romance', heroes: [hero('Арен'), hero('Лиа')], turns: [] };
    const master = text(buildMasterPrompt({ state, cards: [card('Арен'), card('Лиа')], language: 'русский', scene: { focus: 'A' } }));
    assert.ok(!master.includes('[ROLL'), 'в романтике нет бросков');
    assert.ok(master.includes('18+'));
    assert.ok(!hasManyGroups(state));
    assert.deepEqual(liveGroups(state), ['A']);
});
