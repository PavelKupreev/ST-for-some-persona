// Летопись (PLAN 7.2, 7.3, FR-23–FR-25).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CHAPTER_MAX_TURNS, appendChapter, buildHistorianPrompt, chapterHtml, chronicleMarkdown, exportFileName,
    parseChapter, pendingTurns, unchronicledWarning,
} from '../src/chronicle.js';

function makeState(count = 6) {
    const hero = (name, goal, micro) => ({
        cardAvatar: `${name}.png`, name, stats: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        hp: { current: 10, max: 10 }, inventory: [], globalGoal: goal, microGoal: micro, silence: 0,
        abilities: [{ name: 'Теневой шаг', description: '', stat: 'DEX', level: 1, uses: 0 }],
    });
    const turns = [];
    for (let n = 1; n <= count; n++) {
        const author = ['master', 'hero1', 'master', 'hero2'][(n - 1) % 4];
        turns.push(author === 'master'
            ? { n, author, text: `событие ${n}`, rolls: n === 3 ? [{ line: '🎲 Арен, DEX: d20+0 = 15 vs DC 12 ✅' }] : [] }
            : { n, author, speech: `реплика ${n}`, intent: `действие ${n}`, thoughts: `мысль-${author}-${n}` });
    }
    return {
        world: { setting: 'Пограничье', rules: ['Магия редка'], era: '', tone: '', powerLevel: '' },
        heroes: [hero('Арен', 'стать королём воров', 'украсть ключ'), hero('Лиа', 'найти брата', 'узнать про письмо')],
        scene: { premise: '', number: 1, chronicledUpTo: 0 },
        turns,
        memory: null,
        chronicle: [],
        session: { masterNote: '', next: 'master' },
    };
}

const text = (messages) => messages.map((m) => m.content).join('\n');

test('Историк видит мысли и тайные цели обоих героев и просит заголовок', () => {
    const state = makeState();
    const prompt = text(buildHistorianPrompt({ state, turns: pendingTurns(state), cards: [null, null], language: 'русский' }));
    for (const secret of ['мысль-hero1-2', 'мысль-hero2-4', 'украсть ключ', 'узнать про письмо', 'стать королём воров', 'найти брата']) {
        assert.ok(prompt.includes(secret), secret);
    }
    assert.match(prompt, /третьего лица/);
    assert.match(prompt, /ЗАГОЛОВОК/);
    assert.match(prompt, /первая глава/);
    assert.match(prompt, /языке: русский/);
});

test('новая глава — по ходам после прошлой, продолжает её конец', () => {
    const state = makeState(10);
    appendChapter(state, { title: 'Трактир', text: 'Первая глава.' }, state.turns.slice(0, 6));
    const turns = pendingTurns(state);
    assert.deepEqual(turns.map((turn) => turn.n), [7, 8, 9, 10]);
    const prompt = text(buildHistorianPrompt({ state, turns, cards: [null, null], language: 'русский' }));
    assert.match(prompt, /КОНЕЦ ПРОШЛОЙ ГЛАВЫ \(глава 1\. Трактир\)/);
    assert.match(prompt, /главу 2/);
    assert.ok(!prompt.includes('событие 5'), 'ходы прошлой главы второй раз не идут');
});

test('в одну главу не больше CHAPTER_MAX_TURNS ходов', () => {
    const state = makeState(CHAPTER_MAX_TURNS + 5);
    assert.equal(pendingTurns(state).length, CHAPTER_MAX_TURNS);
});

test('летопись только дополняется: прошлые главы не меняются (FR-24)', () => {
    const state = makeState(12);
    const first = appendChapter(state, { title: 'Один', text: 'Текст один.' }, state.turns.slice(0, 6), '2026-10-23T10:00:00Z');
    const snapshot = structuredClone(first);
    const second = appendChapter(state, { title: 'Два', text: 'Текст два.' }, pendingTurns(state));
    assert.equal(state.chronicle.length, 2);
    assert.deepEqual(state.chronicle[0], snapshot);
    assert.deepEqual([second.n, second.fromTurn, second.toTurn, second.scene], [2, 7, 12, 1]);
    assert.equal(state.scene.chronicledUpTo, 12);
    assert.equal(pendingTurns(state).length, 0);
    assert.throws(() => appendChapter(state, { title: 'x', text: 'y' }, []), /Нет ходов/);
});

test('разбор ответа Историка терпим к формату заголовка', () => {
    assert.deepEqual(parseChapter('ЗАГОЛОВОК: Ночь в трактире\n\nАрен вошёл.\n\nЛиа ждала.', 1), { title: 'Ночь в трактире', text: 'Арен вошёл.\n\nЛиа ждала.' });
    assert.equal(parseChapter('# Глава 2. Ключ\nТекст', 2).title, 'Ключ');
    assert.equal(parseChapter('**Заголовок: «Письмо»**\n\nТекст', 3).title, 'Письмо');
    assert.equal(parseChapter('**Дорога на север**\n\nТекст', 3).title, 'Дорога на север');
    assert.deepEqual(parseChapter('Просто текст без заголовка.', 4), { title: 'Глава 4', text: 'Просто текст без заголовка.' });
    assert.throws(() => parseChapter('ЗАГОЛОВОК: Пусто\n\n', 5), /пустую главу/);
});

test('предупреждение о неописанных ходах перед очисткой сцены', () => {
    const state = makeState(8);
    assert.match(unchronicledWarning(state), /Ходы 1–8/);
    appendChapter(state, { title: 'Все', text: 'Т.' }, pendingTurns(state));
    assert.equal(unchronicledWarning(state), '');
});

test('экспорт .md: главы с оглавлением, без ключа и настроек (FR-25)', () => {
    const state = makeState(12);
    state.openrouterKey = 'sk-or-SECRET';
    state.settings = { openrouterKey: 'sk-or-SECRET2' };
    appendChapter(state, { title: 'Один', text: 'Арен вошёл.\n\nЛиа ждала.' }, state.turns.slice(0, 6));
    appendChapter(state, { title: 'Два', text: 'Дальше.' }, pendingTurns(state));
    const md = chronicleMarkdown(state);
    assert.match(md, /^# Летопись: Арен и Лиа\n/);
    assert.match(md, /## Оглавление/);
    assert.match(md, /## Глава 1\. Один/);
    assert.match(md, /\*Сцена 1 · ходы 7–12\*/);
    assert.ok(!md.includes('sk-or'), 'ключа в файле нет');
    assert.ok(!md.includes('мысль-'), 'сырых записей игры в файле нет');
    assert.equal(exportFileName(state, new Date('2026-10-23T12:00:00Z')), 'Летопись Арен и Лиа 2026-10-23.md');
});

test('HTML главы экранирует разметку модели', () => {
    const html = chapterHtml('Он сказал: *тихо*.\n\n<script>alert(1)</script> **важно**');
    assert.equal(html, '<p>Он сказал: <i>тихо</i>.</p>\n<p>&lt;script&gt;alert(1)&lt;/script&gt; <b>важно</b></p>');
});

test('стиль письма меняет голос, но не правила фактов (PLAN 7.4)', async () => {
    const { HISTORIAN_STYLES } = await import('../src/chronicle.js');
    const state = makeState();
    const prompt = (style) => text(buildHistorianPrompt({ state, turns: pendingTurns(state), cards: [null, null], language: 'русский', style }));
    assert.deepEqual(Object.keys(HISTORIAN_STYLES), ['chronicle', 'saga', 'novel']);
    assert.match(prompt('saga'), /сагу/);
    assert.match(prompt('novel'), /диалогов/);
    assert.equal(prompt(undefined), prompt('chronicle'), 'по умолчанию — исходный стиль');
    assert.equal(prompt('неизвестный'), prompt('chronicle'));
    for (const style of Object.keys(HISTORIAN_STYLES)) {
        const p = prompt(style);
        assert.match(p, /третьего лица/, style);
        assert.match(p, /Никакой механики/, style);
        assert.match(p, /Не выдумывай событий/, style);
        assert.ok(p.includes('мысль-hero1-2'), style);
    }
    const chapter = appendChapter(state, { title: 'С', text: 'Т.', style: 'saga' }, pendingTurns(state));
    assert.equal(chapter.style, 'saga');
});
