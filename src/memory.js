// Скрытая память (FR-26): старые ходы сжимаются в краткие пересказы, промпты остаются короткими.
// Модуль без зависимостей от ST, проверяется тестом в Node. Вызов модели — в game.js.
//
// Изоляция (NFR-01) держится так же, как в промптах: пересказ собирается только из того, что можно показать.
//   public          — общая память: реплики, действия, ответы мастера, броски, без чьих-либо мыслей. Видят все.
//   thoughts.hero1  — пересказ мыслей героя 1. Видят только герой 1 и мастер.
//   thoughts.hero2  — то же для героя 2.

import { HERO_IDS, formatTurns, languageRule } from './prompts.js';

// Сколько последних ходов остаётся в истории целиком после сжатия.
export const MEMORY_KEEP = 10;
export const SUMMARY_MAX_WORDS = 250;

export function emptyMemory() {
    return { upTo: 0, public: '', thoughts: { hero1: '', hero2: '' } };
}

/** Память чата; в старых чатах её нет. */
export function getMemory(state) {
    if (!state.memory) state.memory = emptyMemory();
    state.memory.thoughts ??= { hero1: '', hero2: '' };
    return state.memory;
}

/** Ходы, которые ещё не попали в память. */
export function liveTurns(state) {
    const upTo = state.memory?.upTo ?? 0;
    return state.turns.filter((turn) => turn.n > upTo);
}

/**
 * Какие ходы пора сжать: когда несжатых больше порога, сжимаем всё, кроме последних MEMORY_KEEP.
 * @param {object} state
 * @param {number} threshold порог из настроек; 0 — сжатие выключено
 * @returns {object[]} ходы для сжатия (пусто, если рано)
 */
export function turnsToCompress(state, threshold) {
    if (!(threshold > 0)) return [];
    const live = liveTurns(state);
    if (live.length <= threshold) return [];
    return live.slice(0, Math.max(0, live.length - MEMORY_KEEP));
}

/**
 * Промпты для пересказа. Каждый собирается только из того, что положено видеть его читателю.
 * @param {object} params
 * @param {object} params.state
 * @param {object[]} params.turns ходы, которые сжимаем
 * @param {string} params.language
 * @returns {Array<{key: 'public'|'hero1'|'hero2', messages: Array<{role: string, content: string}>}>}
 */
export function buildSummaryPrompts({ state, turns, language }) {
    const memory = getMemory(state);
    const prompts = [{
        key: 'public',
        messages: summaryMessages({
            language,
            what: 'общую память ролевой игры: события, решения, найденное и потерянное, NPC и их отношение к героям, раны, обещания и незакрытые нити сюжета',
            previous: memory.public,
            fresh: formatTurns(state, turns, { viewer: 'public' }),
        }),
    }];

    HERO_IDS.forEach((id, index) => {
        const hero = state.heroes[index];
        const fresh = turns
            .filter((turn) => turn.author === id && turn.thoughts)
            .map((turn) => `Ход ${turn.n}. Сказал: ${turn.speech || '—'}. Делал: ${turn.intent || '—'}. Думал: ${turn.thoughts}`)
            .join('\n');
        if (!fresh) return;
        prompts.push({
            key: id,
            messages: summaryMessages({
                language,
                what: `личную память персонажа ${hero?.name ?? id}: что он думает про себя, спутника и NPC, что скрывает, какие у него планы и подозрения`,
                previous: memory.thoughts[id],
                fresh,
            }),
        });
    });
    return prompts;
}

function summaryMessages({ language, what, previous, fresh }) {
    const system = [
        `Ты ведёшь ${what}.`,
        `Сожми прежнюю память и новые события в один связный пересказ не длиннее ${SUMMARY_MAX_WORDS} слов.`,
        'Сохрани имена, ключевые факты, причины поступков и всё, что ещё может пригодиться. Мелочи и пересказ реплик выбрось.',
        'Пиши в прошедшем времени, третьим лицом, без вступлений и заголовков. Ничего не выдумывай.',
        languageRule(language),
    ].join('\n');
    const user = [
        '### ПРЕЖНЯЯ ПАМЯТЬ',
        previous?.trim() || '(пусто)',
        '',
        '### НОВЫЕ СОБЫТИЯ',
        fresh,
    ].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/**
 * Записывает пересказы в память и сдвигает границу сжатых ходов.
 * @param {object} state
 * @param {object[]} turns сжатые ходы
 * @param {Record<string, string>} summaries ключ из buildSummaryPrompts → текст пересказа
 */
export function applySummaries(state, turns, summaries) {
    const memory = getMemory(state);
    if (summaries.public !== undefined) memory.public = summaries.public.trim();
    for (const id of HERO_IDS) {
        if (summaries[id] !== undefined) memory.thoughts[id] = summaries[id].trim();
    }
    memory.upTo = Math.max(memory.upTo, ...turns.map((turn) => turn.n));
    return memory;
}
