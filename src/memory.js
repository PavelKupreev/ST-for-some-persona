// Скрытая память (FR-26): старые ходы сжимаются в краткие пересказы, промпты остаются короткими.
// Модуль без зависимостей от ST, проверяется тестом в Node. Вызов модели — в game.js.
//
// Изоляция (NFR-01) держится так же, как в промптах: пересказ собирается только из того, что можно показать.
//   groups.A        — общая память группы A: реплики, действия, ответы мастера, броски, без чьих-либо мыслей.
//                     Видят герои группы и мастер (FR-34). В чатах до этапа 13 — поле public, это память группы A.
//   thoughts.heroN  — пересказ мыслей героя N. Видят только герой N и мастер.

import { DEFAULT_GROUP, GROUPS, heroId, heroIndex, turnGroup } from './heroes.js';
import { formatTurns, groupMemories, languageRule } from './prompts.js';

// Сколько последних ходов остаётся в истории целиком после сжатия: не больше 10 и не больше половины порога,
// иначе при пороге около 10 сжатие запускалось бы на каждом ходе (приёмка, PLAN 8.4).
export const MEMORY_KEEP = 10;

/** Сколько ходов оставить несжатыми при пороге threshold. */
export function keepAfterCompress(threshold) {
    return Math.max(1, Math.min(MEMORY_KEEP, Math.floor(threshold / 2)));
}
export const SUMMARY_MAX_WORDS = 250;

export function emptyMemory() {
    return { upTo: 0, groups: {}, thoughts: {} };
}

/** Память чата; в старых чатах её нет или она одна на всех (public). */
export function getMemory(state) {
    if (!state.memory) state.memory = emptyMemory();
    const memory = state.memory;
    memory.thoughts ??= {};
    memory.groups = groupMemories(memory);
    delete memory.public;
    return memory;
}

/** Ключ пересказа общей памяти группы: public для A (как до этапа 13), public:B для остальных. */
export function publicKey(group) {
    return group === DEFAULT_GROUP ? 'public' : `public:${group}`;
}

/** Ходы, которые ещё не попали в память. */
export function liveTurns(state) {
    const upTo = state.memory?.upTo ?? 0;
    return state.turns.filter((turn) => turn.n > upTo);
}

/**
 * Какие ходы пора сжать: когда несжатых больше порога, сжимаем всё, кроме последних keepAfterCompress(threshold).
 * @param {object} state
 * @param {number} threshold порог из настроек; 0 — сжатие выключено
 * @returns {object[]} ходы для сжатия (пусто, если рано)
 */
export function turnsToCompress(state, threshold) {
    if (!(threshold > 0)) return [];
    const live = liveTurns(state);
    if (live.length <= threshold) return [];
    return live.slice(0, Math.max(0, live.length - keepAfterCompress(threshold)));
}

/**
 * Промпты для пересказа. Каждый собирается только из того, что положено видеть его читателю.
 * @param {object} params
 * @param {object} params.state
 * @param {object[]} params.turns ходы, которые сжимаем
 * @param {string} params.language
 * @returns {Array<{key: string, messages: Array<{role: string, content: string}>}>} key — public, public:B или heroN
 */
export function buildSummaryPrompts({ state, turns, language }) {
    const memory = getMemory(state);
    // Общая память — отдельно по каждой группе: в пересказ группы попадают только её ходы (FR-34).
    const prompts = GROUPS
        .map((group) => ({ group, groupTurns: turns.filter((turn) => turnGroup(turn) === group) }))
        .filter(({ groupTurns }) => groupTurns.length)
        .map(({ group, groupTurns }) => ({
            key: publicKey(group),
            messages: summaryMessages({
                language,
                what: 'общую память ролевой игры: события, решения, найденное и потерянное, NPC и их отношение к героям, раны, обещания и незакрытые нити сюжета',
                previous: memory.groups[group],
                fresh: formatTurns(state, groupTurns, { viewer: 'public' }),
            }),
        }));

    state.heroes.forEach((hero, index) => {
        const id = heroId(index);
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
    for (const [key, text] of Object.entries(summaries)) {
        if (text === undefined) continue;
        if (key === 'public') memory.groups[DEFAULT_GROUP] = text.trim();
        else if (key.startsWith('public:') && GROUPS.includes(key.slice(7))) memory.groups[key.slice(7)] = text.trim();
        else if (heroIndex(key) !== -1) memory.thoughts[key] = text.trim();
    }
    memory.upTo = Math.max(memory.upTo, ...turns.map((turn) => turn.n));
    return memory;
}
