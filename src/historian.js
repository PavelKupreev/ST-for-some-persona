// Историк и страница летописи (этап 7, FR-23–FR-25, UC-06). Промпт, разбор и Markdown — в src/chronicle.js.
// Историк работает на модели мастера (допущение ТЗ). Главы только добавляются в конец (FR-24);
// «Пробная глава» нужна, чтобы подобрать стиль: её можно сохранить, только если она про новые ходы.

import { LOG_PREFIX } from './constants.js';
import { getSettings } from './settings.js';
import { getState, saveState } from './state.js';
import { callModel } from './llm.js';
import { toPromptCard } from './game.js';
import { modelsFor } from './modes.js';
import {
    CHAPTER_MAX_TURNS, HISTORIAN_STYLES, appendChapter, buildHistorianPrompt, chapterHtml, chapterRange, chronicleCursor, chronicleMarkdown,
    exportFileName, parseChapter, pendingTurns, unchronicledCount,
} from './chronicle.js';
import { isPageOpen, showTab } from './page.js';
import { $$, downloadFile } from './dom.js';

const HISTORIAN_MAX_TOKENS = 2000;
const HISTORIAN_TEMPERATURE = 0.8;

/** Историк сейчас пишет: вторую главу параллельно не начинаем. */
let writing = false;

/**
 * Пробная глава, живёт только в памяти вкладки.
 * @type {{chatId: string, scene: number, upTo: number, fromTurn: number, toTurn: number, saveable: boolean, title: string, text: string} | null}
 */
let preview = null;

function requireGame() {
    const state = getState();
    if (!state) throw new Error('Сначала откройте чат');
    if (!state.heroes.length) throw new Error('Нет героев: подготовьте мир и героев на странице игры');
    return state;
}

function chatId() {
    return SillyTavern.getContext().getCurrentChatId();
}

function cards(state) {
    const { characters } = SillyTavern.getContext();
    return state.heroes.map((hero) => toPromptCard(characters.find((character) => character.avatar === hero.cardAvatar)));
}

async function runHistorian(state, turns) {
    if (writing) throw new Error('Историк уже пишет главу, подождите');
    writing = true;
    renderChronicle();
    const started = chatId();
    try {
        const settings = getSettings();
        const raw = await callModel({
            role: 'historian',
            model: modelsFor(settings, state).master,
            messages: buildHistorianPrompt({ state, turns, cards: cards(state), language: settings.language, style: settings.historianStyle }),
            maxTokens: HISTORIAN_MAX_TOKENS,
            temperature: HISTORIAN_TEMPERATURE,
        });
        if (chatId() !== started) throw new Error('Пока Историк писал, открыт другой чат: глава не записана');
        return { ...parseChapter(raw, (state.chronicle?.length ?? 0) + 1), style: settings.historianStyle };
    } finally {
        writing = false;
    }
}

/** «📜 Летопись»: новая глава по ходам с прошлой главы, в конец летописи (FR-23, FR-24). */
export async function writeChapter() {
    const state = requireGame();
    const turns = pendingTurns(state);
    if (!turns.length) throw new Error('С прошлой главы не было новых ходов: летописцу пока не о чем писать');

    const before = chronicleCursor(state);
    toastr.info(`Историк пишет главу по ходам ${turns[0].n}–${turns.at(-1).n}…`, 'RPG-автосессия');
    try {
        const parsed = await runHistorian(state, turns);
        const fresh = getState();
        const after = chronicleCursor(fresh);
        if (after.scene !== before.scene || after.upTo !== before.upTo) throw new Error('Пока Историк писал, сцена или летопись изменились: глава не записана');
        const chapter = appendChapter(fresh, parsed, turns);
        await saveState();
        // Пробная глава про те же ходы больше не сохраняется: граница сдвинулась.
        if (preview?.saveable) preview.saveable = false;
        console.log(`${LOG_PREFIX} летопись: глава ${chapter.n} «${chapter.title}», ${chapterRange(chapter)}`);
        // Вкладку браузера после долгого запроса открыть нельзя (блокировщик всплывающих окон): показываем главу, только если страница уже открыта.
        toastr.success(`Глава ${chapter.n}: «${chapter.title}»${isPageOpen() ? '' : '. Читать — «📖 Страница игры» → «Летопись»'}`, 'Летопись');
        if (isPageOpen()) {
            showTab('chronicle');
            scrollToChapter(chapter.n);
        }
    } finally {
        renderChronicle();
    }
}

/**
 * «🧪 Пробная глава»: та же глава без сохранения, чтобы подобрать стиль.
 * Есть новые ходы — пишет по ним (такую можно сохранить). Нет — переписывает последнюю главу для сравнения.
 */
async function tryChapter() {
    const state = requireGame();
    let turns = pendingTurns(state);
    let saveable = true;
    const last = state.chronicle.at(-1);
    if (!turns.length) {
        const { scene } = chronicleCursor(state);
        turns = last && last.scene === scene ? state.turns.filter((turn) => turn.n >= last.fromTurn && turn.n <= last.toTurn) : [];
        saveable = false;
        if (!turns.length) throw new Error('Нет ходов для пробной главы: сыграйте несколько ходов');
    }

    // Переписывая последнюю главу, Историк не должен видеть её как «прошлую».
    const view = saveable ? state : { ...state, chronicle: state.chronicle.slice(0, -1) };
    $$('#rpga_chronicle_status').text('🧪 Историк пишет пробную главу…');
    const parsed = await runHistorian(view, turns);
    const { scene, upTo } = chronicleCursor(getState());
    preview = { chatId: chatId(), scene, upTo, fromTurn: turns[0].n, toTurn: turns.at(-1).n, saveable, ...parsed };
    renderChronicle();
    $$('#rpga_chronicle_preview')[0]?.scrollIntoView({ block: 'start' });
}

async function keepPreview() {
    const state = requireGame();
    const cursor = chronicleCursor(state);
    if (!preview?.saveable || preview.chatId !== chatId() || preview.scene !== cursor.scene || preview.upTo !== cursor.upTo) {
        throw new Error('Эту пробную главу уже нельзя сохранить: летопись изменилась');
    }
    const turns = state.turns.filter((turn) => turn.n >= preview.fromTurn && turn.n <= preview.toTurn);
    const chapter = appendChapter(state, preview, turns);
    await saveState();
    preview = null;
    toastr.success(`Глава ${chapter.n}: «${chapter.title}»`, 'Летопись');
    renderChronicle();
    scrollToChapter(chapter.n);
}

function dropPreview() {
    preview = null;
    renderChronicle();
}

/** «⬇️ Экспорт .md» (FR-25): только главы, без настроек и ключа. */
function exportChronicle() {
    const state = getState();
    if (!state?.chronicle?.length) throw new Error('Летопись пуста: экспортировать нечего');
    downloadFile(new Blob([chronicleMarkdown(state)], { type: 'text/markdown;charset=utf-8' }), exportFileName(state));
}

function scrollToChapter(n) {
    $$(`#rpga_chapter_${n}`)[0]?.scrollIntoView({ block: 'start' });
}

// ---------- Страница летописи ----------

/** Перерисовывает вкладку «Летопись»: состояние, пробную главу, оглавление и главы. */
export function renderChronicle() {
    const state = getState();
    const chapters = state?.chronicle ?? [];
    const pending = state ? unchronicledCount(state) : 0;

    let status;
    if (!state) status = 'Откройте чат: летопись хранится в нём.';
    else if (writing) status = '✍️ Историк пишет…';
    else if (!pending) status = chapters.length ? 'Все сыгранные ходы уже в летописи.' : 'Летопись пуста: сыграйте несколько ходов и нажмите «📜 Написать главу».';
    else {
        const turns = pendingTurns(state);
        status = `Новых ходов для главы: ${pending} (${chapterRange({ scene: chronicleCursor(state).scene, fromTurn: turns[0].n, toTurn: turns.at(-1).n })})`;
        if (pending > CHAPTER_MAX_TURNS) status += `; в одну главу войдут первые ${CHAPTER_MAX_TURNS}`;
    }
    $$('#rpga_chronicle_status').text(status);
    $$('.rpga-chronicle-write').toggleClass('rpga-off', !state || writing || !pending);
    $$('#rpga_chronicle_try').toggleClass('rpga-off', !state || writing || (!pending && !chapters.length));
    $$('#rpga_chronicle_export').toggleClass('rpga-off', !chapters.length);

    renderPreview();

    const toc = $$('#rpga_chronicle_toc').empty();
    if (chapters.length > 1) {
        toc.append($('<b>').text('Оглавление'));
        const list = $('<ol>').appendTo(toc);
        for (const chapter of chapters) {
            list.append($('<li>').append($('<a href="#">').text(chapter.title).attr('data-chapter', chapter.n)));
        }
    }

    const box = $$('#rpga_chronicle_chapters').empty();
    for (const chapter of chapters) {
        box.append($('<article class="rpga-chapter">').attr('id', `rpga_chapter_${chapter.n}`)
            .append($('<h3 class="rpga-chapter-title">').text(`Глава ${chapter.n}. ${chapter.title}`))
            .append($('<small class="rpga-chapter-meta">').text(withStyle(chapterRange(chapter), chapter.style)))
            .append($('<div class="rpga-chapter-text">').html(chapterHtml(chapter.text))));
    }
}

/** «Сцена 1 · ходы 1–8 · Сага»; у глав до выбора стиля стиль не указан. */
function withStyle(text, style) {
    const label = HISTORIAN_STYLES[style]?.label;
    return label ? `${text} · ${label}` : text;
}

function renderPreview() {
    const show = Boolean(preview) && preview.chatId === chatId();
    $$('#rpga_chronicle_preview').prop('hidden', !show);
    if (!show) return;
    const range = chapterRange({ scene: preview.scene, fromTurn: preview.fromTurn, toTurn: preview.toTurn });
    const meta = withStyle(range, preview.style);
    $$('#rpga_chronicle_preview_meta').text(preview.saveable ? `${meta} · не сохранена` : `${meta} · другая версия последней главы, только для сравнения`);
    $$('#rpga_chronicle_preview_title').text(preview.title);
    $$('#rpga_chronicle_preview_text').html(chapterHtml(preview.text));
    $$('#rpga_chronicle_keep').toggleClass('rpga-off', !preview.saveable);
}

/** Подписывает кнопки летописи. Кнопки подписывает index.js через общий bindButton. */
export function bindChronicle(bindButton) {
    bindButton('#rpga_chronicle_write', writeChapter);
    bindButton('#rpga_chronicle_write_page', writeChapter);
    bindButton('#rpga_chronicle_try', tryChapter);
    bindButton('#rpga_chronicle_keep', keepPreview);
    bindButton('#rpga_chronicle_export', async () => exportChronicle());
    $$('#rpga_chronicle_drop').on('click', dropPreview);
    $$('#rpga_chronicle_toc').on('click', 'a[data-chapter]', function (event) {
        event.preventDefault();
        scrollToChapter($(this).data('chapter'));
    });
}
