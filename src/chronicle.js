// Летопись (этап 7, FR-23–FR-25): Историк по кнопке пишет главу по ходам с прошлой главы.
// Модуль без зависимостей от ST, проверяется тестом в Node. Вызов модели и интерфейс — в src/historian.js.
//
// Историк видит всё: мысли, цели и тайные микроцели обоих героев. Летопись читает пользователь, а не герои,
// поэтому изоляция (NFR-01) здесь не нужна: главы не попадают ни в один промпт мастера или героев.
// Летопись только дополняется (FR-24): главы не переписываются, новая глава — всегда в конец.

import { formatCard, formatTurns, formatWorld, languageRule } from './prompts.js';

// Больше ходов в одну главу не берём: остаток уйдёт в следующую.
export const CHAPTER_MAX_TURNS = 60;
export const CHAPTER_WORDS = '400–700';
// Сколько конца прошлой главы показываем Историку, чтобы новая продолжала её, а не начиналась с нуля.
const PREVIOUS_TAIL = 1500;

/**
 * @typedef {object} Chapter
 * @property {number} n номер главы
 * @property {string} title заголовок
 * @property {number} scene номер сцены
 * @property {number} fromTurn первый ход главы
 * @property {number} toTurn последний ход главы
 * @property {string} text текст главы
 * @property {string} [style] стиль письма Историка (ключ HISTORIAN_STYLES)
 * @property {string} createdAt ISO-время
 */

/**
 * Стили письма Историка (новое, PLAN 7.4): выбираются в настройках. Факты, мотивы и запрет механики общие для всех,
 * стиль меняет только голос, объём и подачу. «chronicle» — исходный стиль, одобренный пользователем.
 */
export const HISTORIAN_STYLES = Object.freeze({
    chronicle: {
        label: 'Летопись',
        hint: 'художественная проза, спокойный рассказчик',
        rules: [
            '- Художественная проза от третьего лица, прошедшее время. Это рассказ для чтения, а не протокол игры.',
            '- Реплики героев и NPC можно приводить прямой речью, коротко и близко к записи.',
            `- Объём ${CHAPTER_WORDS} слов, несколько абзацев.`,
        ],
    },
    saga: {
        label: 'Сага',
        hint: 'эпическое предание, торжественный слог барда',
        rules: [
            '- Пиши как древнюю сагу или предание, которое барды рассказывают у огня: от третьего лица, в прошедшем времени, торжественным, чуть архаичным слогом.',
            '- Крупные мазки: судьба, знамения, клятвы, цена поступков. Героев можно называть по прозвищам, которые они заслужили делами.',
            '- Ритм и повторы, как в устном сказании; меньше бытовых мелочей, больше значимых жестов. Прямой речи мало, только самые весомые слова, как изречения.',
            '- Можно кратко предвещать, но не раскрывать то, чего ещё не было.',
            '- Объём 300–500 слов, короткие весомые абзацы.',
        ],
    },
    novel: {
        label: 'Живой роман',
        hint: 'близко к героям, много диалогов, внутренний голос',
        rules: [
            '- Пиши как современный приключенческий роман: от третьего лица, в прошедшем времени, но близко к героям, будто камера у них за плечом.',
            '- Много живых диалогов: опирайся на реплики из записей, можно слегка их развернуть, сохраняя смысл и характер.',
            '- Чаще показывай внутренний голос героев курсивом (*так*): сомнения, иронию, страхи, то, что они скрывают друг от друга. Чередуй фокус между героями по сценам.',
            '- Простой живой язык, юмор там, где он уместен по характеру героев, короткие абзацы и динамика.',
            '- Объём 500–800 слов.',
        ],
    },
});

export const DEFAULT_HISTORIAN_STYLE = 'chronicle';

/** Номер сцены и граница уже описанных ходов; в старых чатах этих полей нет. */
export function chronicleCursor(state) {
    return {
        scene: state.scene?.number ?? 1,
        upTo: state.scene?.chronicledUpTo ?? 0,
    };
}

/**
 * Ходы для следующей главы: всё, что было после прошлой главы в текущей сцене, не больше CHAPTER_MAX_TURNS.
 * @returns {object[]}
 */
export function pendingTurns(state) {
    const { upTo } = chronicleCursor(state);
    return state.turns.filter((turn) => turn.n > upTo).slice(0, CHAPTER_MAX_TURNS);
}

/** Сколько ходов текущей сцены ещё не попало в летопись (без обрезки по CHAPTER_MAX_TURNS). */
export function unchronicledCount(state) {
    const { upTo } = chronicleCursor(state);
    return state.turns.filter((turn) => turn.n > upTo).length;
}

/** Предупреждение перед очисткой сцены: неописанные ходы Историк потом не увидит. Пусто, если терять нечего. */
export function unchronicledWarning(state) {
    const left = state.turns.filter((turn) => turn.n > chronicleCursor(state).upTo);
    if (!left.length) return '';
    return `\n\nХоды ${left[0].n}–${left.at(-1).n} ещё не попали в летопись: после очистки Историк их не увидит. Чтобы сохранить их, сначала нажмите «📜 Летопись».`;
}

/**
 * Промпт Историка.
 * @param {object} params
 * @param {object} params.state
 * @param {object[]} params.turns ходы главы
 * @param {Array<import('./prompts.js').PromptCard|null>} params.cards карточки героя 1 и героя 2
 * @param {string} params.language
 * @param {keyof typeof HISTORIAN_STYLES} [params.style] стиль письма из настроек
 * @returns {Array<{role: string, content: string}>}
 */
export function buildHistorianPrompt({ state, turns, cards, language, style = DEFAULT_HISTORIAN_STYLE }) {
    const voice = HISTORIAN_STYLES[style] ?? HISTORIAN_STYLES[DEFAULT_HISTORIAN_STYLE];
    const names = state.heroes.map((hero) => hero.name);
    const chapterNumber = (state.chronicle?.length ?? 0) + 1;
    const previous = state.chronicle?.at(-1);

    const system = [
        'Ты — Историк, летописец. Ты превращаешь записи настольной ролевой игры в главу художественной летописи о приключениях двух героев.',
        languageRule(language),
        '',
        '### КАК ПИСАТЬ',
        ...voice.rules,
        '- Объясняй не только что произошло, но и зачем герои это делали и почему: опирайся на их мысли, глобальные цели и тайные микроцели.',
        '  Читатель летописи видит мысли обоих героев и знает их тайны, даже если сами герои друг о друге этого не знают.',
        '- Никакой механики: не упоминай кубики, броски, DC, HP, статы, уровни и ходы. Удачу и неудачу показывай через события, раны — через боль и усталость.',
        '- Не выдумывай событий, решений и реплик, которых не было. Можно добавлять обстановку, ощущения и мелкие детали, не меняющие сюжета.',
        '- Без списков и подзаголовков внутри текста.',
        previous
            ? '- Продолжай прошлую главу, не пересказывая её: читатель её уже прочёл.'
            : '- Это первая глава: коротко введи читателя в мир и представь героев.',
        '',
        '### ФОРМАТ ОТВЕТА',
        'Первая строка — «ЗАГОЛОВОК: » и короткое название главы (2–6 слов). Затем пустая строка и текст главы. Больше ничего.',
    ];

    const user = [
        '### МИР',
        formatWorld(state.world),
        '',
        ...state.heroes.flatMap((hero, index) => [
            `### ГЕРОЙ ${index + 1}: ${hero.name}`,
            formatCard(cards?.[index] ?? null, hero.name, names[1 - index]),
            `Глобальная цель: ${hero.globalGoal || '—'}`,
            `Тайная микроцель: ${hero.microGoal || '—'}`,
            `Способности: ${(hero.abilities ?? []).filter((ability) => ability.name).map((ability) => ability.name).join(', ') || '—'}`,
            '',
        ]),
    ];
    if (previous) {
        const tail = previous.text.length > PREVIOUS_TAIL ? `…${previous.text.slice(-PREVIOUS_TAIL)}` : previous.text;
        user.push(`### КОНЕЦ ПРОШЛОЙ ГЛАВЫ (глава ${previous.n}. ${previous.title})`, tail, '');
    }
    user.push(
        `### ЗАПИСИ ИГРЫ (мысли героев видишь только ты и читатель)`,
        formatTurns(state, turns, { viewer: 'master' }),
        '',
        '### ЗАДАНИЕ',
        `Напиши главу ${chapterNumber} по этим записям.`,
    );

    return [
        { role: 'system', content: system.join('\n') },
        { role: 'user', content: user.join('\n') },
    ];
}

/**
 * Разбирает ответ Историка: заголовок и текст. Терпим к «# Заголовок», «**Глава 2. …**» и отсутствию заголовка.
 * @param {string} raw
 * @param {number} chapterNumber
 * @returns {{title: string, text: string}}
 * @throws {Error} если текста нет
 */
export function parseChapter(raw, chapterNumber) {
    const lines = String(raw ?? '').replace(/\r\n?/g, '\n').trim().split('\n');
    let title = '';
    const first = lines[0]?.trim() ?? '';
    const labelled = first.match(/^[#*\s]*(?:ЗАГОЛОВОК|Заголовок|TITLE|Title)\s*[:：]\s*(.+)$/);
    const heading = first.match(/^#{1,6}\s+(.+)$/) || first.match(/^\*\*(.+)\*\*$/);
    if (labelled || heading) {
        title = (labelled ?? heading)[1];
        lines.shift();
    }
    title = title.replace(/[*_#«»"]/g, '').replace(/^(?:Глава|Chapter)\s+\d+\s*[.:—-]?\s*/i, '').trim();

    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('Историк вернул пустую главу');
    return { title: title || `Глава ${chapterNumber}`, text };
}

/**
 * Добавляет главу в конец летописи и сдвигает границу описанных ходов. Прошлые главы не трогает (FR-24).
 * @param {object} state
 * @param {{title: string, text: string, style?: string}} parsed
 * @param {object[]} turns ходы главы
 * @param {string} [createdAt]
 * @returns {Chapter}
 */
export function appendChapter(state, parsed, turns, createdAt = new Date().toISOString()) {
    if (!turns.length) throw new Error('Нет ходов для главы');
    state.chronicle ??= [];
    const { scene } = chronicleCursor(state);
    const chapter = {
        n: state.chronicle.length + 1,
        title: parsed.title,
        scene,
        fromTurn: turns[0].n,
        toTurn: turns.at(-1).n,
        text: parsed.text,
        style: parsed.style ?? DEFAULT_HISTORIAN_STYLE,
        createdAt,
    };
    state.chronicle.push(chapter);
    state.scene.chronicledUpTo = chapter.toTurn;
    return chapter;
}

/** «Сцена 1 · ходы 1–15» */
export function chapterRange(chapter) {
    const turns = chapter.fromTurn === chapter.toTurn ? `ход ${chapter.fromTurn}` : `ходы ${chapter.fromTurn}–${chapter.toTurn}`;
    return `Сцена ${chapter.scene} · ${turns}`;
}

/**
 * Летопись в Markdown для экспорта (FR-25). Собирается только из глав и имён героев: ключа API в состоянии нет,
 * а сюда не попадают даже настройки.
 * @param {object} state
 * @returns {string}
 */
export function chronicleMarkdown(state) {
    const chapters = state.chronicle ?? [];
    const lines = [`# ${chronicleTitle(state)}`, ''];
    if (state.world?.setting) lines.push(`*${state.world.setting.replace(/\s+/g, ' ').trim()}*`, '');
    if (chapters.length > 1) {
        lines.push('## Оглавление', '');
        for (const chapter of chapters) lines.push(`${chapter.n}. [${chapter.title}](#глава-${chapter.n})`);
        lines.push('');
    }
    for (const chapter of chapters) {
        lines.push(`<a id="глава-${chapter.n}"></a>`, '', `## Глава ${chapter.n}. ${chapter.title}`, '', `*${chapterRange(chapter)}*`, '', chapter.text.trim(), '');
    }
    return `${lines.join('\n').trim()}\n`;
}

export function chronicleTitle(state) {
    const names = state.heroes.map((hero) => hero.name).filter(Boolean);
    return names.length ? `Летопись: ${names.join(' и ')}` : 'Летопись';
}

/** Имя файла без символов, запрещённых в Windows. */
export function exportFileName(state, date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    return `${chronicleTitle(state)} ${day}.md`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Текст главы в безопасный HTML для страницы: абзацы, *курсив*, **жирный**. Разметку модели не доверяем.
 * @param {string} text
 * @returns {string}
 */
export function chapterHtml(text) {
    return String(text ?? '')
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph) => `<p>${inline(escapeHtml(paragraph)).replace(/\n/g, '<br>')}</p>`)
        .join('\n');
}

function inline(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
}

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
