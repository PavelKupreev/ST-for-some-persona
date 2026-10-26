// Простой диалог (новое, PLAN 10.1): два персонажа из карточек ST по очереди разговаривают друг с другом.
// Без мастера, кубиков, HP, листов и Историка. Модуль без зависимостей от ST, проверяется тестом в Node.
//
// Изоляция та же, что у героев в RPG (NFR-01): в промпт идут только своя карточка, имя собеседника
// и видимая часть разговора. Мысли собеседника и его карточка сюда не передаются.

import { HERO_IDS, formatCard, formatHistory, formatMemory, languageRule } from './prompts.js';

export const GAME_MODES = ['rpg', 'dialogue'];

/** @param {{mode?: string}} state */
export function isDialogue(state) {
    return state?.mode === 'dialogue';
}

/** Что мешает начать диалог; пустой список — можно. */
export function dialogueProblems({ selected }) {
    return selected.length === 2 ? [] : [`выбрано карточек: ${selected.length} из 2`];
}

/**
 * Кто говорит следующим: строго по очереди, первым — персонаж 1.
 * @param {{turns: Array<{author: string}>}} state
 * @returns {'hero1'|'hero2'}
 */
export function dialogueNext(state) {
    const last = state.turns.findLast((turn) => HERO_IDS.includes(turn.author));
    return last?.author === 'hero1' ? 'hero2' : 'hero1';
}

/**
 * Промпт одной реплики персонажа.
 * @param {object} params
 * @param {object} params.state
 * @param {0|1} params.heroIndex
 * @param {import('./prompts.js').PromptCard} params.card карточка только этого персонажа
 * @param {string} params.language
 * @returns {Array<{role: string, content: string}>}
 */
export function buildDialoguePrompt({ state, heroIndex, card, language }) {
    const hero = state.heroes[heroIndex];
    const otherName = state.heroes[1 - heroIndex].name;
    const topic = state.scene?.premise?.trim();

    const system = [
        `Ты — ${hero.name}. Ты разговариваешь с персонажем ${otherName}. Это живой разговор двоих, без ведущего и без игровых правил.`,
        `Говори и действуй только за ${hero.name}. Никогда не пиши реплики, действия и мысли за ${otherName}.`,
        'Отвечай на то, что сказал собеседник, оставайся в характере, не повторяйся. Разговор может менять тему, как в жизни.',
        languageRule(language),
        '',
        '### ТВОЯ КАРТОЧКА',
        formatCard(card, hero.name, otherName),
        '',
        '### МЕСТО И ТЕМА РАЗГОВОРА',
        topic || 'Не заданы: исходи из своей карточки и того, что уже прозвучало.',
        '',
        '### ФОРМАТ ОТВЕТА',
        'Ровно три части с метками, без другого текста:',
        'РЕПЛИКА: что ты говоришь вслух, не больше одного абзаца (или «—», если молчишь)',
        'ДЕЙСТВИЕ: жест, движение или выражение лица одним коротким предложением (или «—»)',
        'МЫСЛИ: что ты думаешь на самом деле; это видишь только ты',
    ];

    const history = formatHistory(state, { viewer: HERO_IDS[heroIndex] });
    const user = [
        ...formatMemory(state, HERO_IDS[heroIndex]),
        '### РАЗГОВОР',
        history || '(разговор ещё не начался)',
        '',
        history ? `Твоя очередь, ${hero.name}.` : `Начни разговор, ${hero.name}.`,
    ];

    return [
        { role: 'system', content: system.join('\n') },
        { role: 'user', content: user.join('\n') },
    ];
}
