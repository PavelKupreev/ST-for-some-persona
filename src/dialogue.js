// Простой диалог (новое, PLAN 10.1): два персонажа из карточек ST по очереди разговаривают друг с другом.
// Без мастера, кубиков, HP, листов и Историка. Модуль без зависимостей от ST, проверяется тестом в Node.
//
// Ход — одно обычное сообщение ролевого чата: речь, действия и описание вперемешку, без меток и мыслей.
//
// Изоляция та же, что у героев в RPG (NFR-01): в промпт идут только своя карточка, имя собеседника
// и видимая часть разговора. Мысли (из ходов, сыгранных в старом формате) и карточка собеседника сюда не передаются.

import { HERO_IDS, HISTORY_LIMIT, formatCard, formatMemory, languageRule } from './prompts.js';
import { ParseError } from './parse.js';

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
 * Промпт одного сообщения персонажа.
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
        '### КАК ПИСАТЬ',
        `Пиши одно сообщение ролевого чата от лица ${hero.name}, как в SillyTavern.`,
        'Прямая речь — в кавычках «…». Действия, жесты, мимика и описание обстановки — *курсивом*.',
        'Речь, действие и описание можно смешивать в любом порядке.',
        'Длину выбирай по ситуации: от одной короткой фразы до нескольких абзацев; обычно 1–3 абзаца средней длины.',
        'Без меток, заголовков, пояснений вне роли и без своего имени в начале.',
    ];

    const history = formatDialogueHistory(state, HERO_IDS[heroIndex]);
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

/**
 * Разговор глазами viewer: последние ходы после сжатой памяти. Мысли не выводятся ничьи.
 * Ходы старого формата (speech/intent, сыгранные до этапа 10) и ходы мастера (режим переключали из RPG) тоже показываются.
 * @param {object} state
 * @param {'hero1'|'hero2'} viewer
 */
export function formatDialogueHistory(state, viewer) {
    const upTo = state.memory?.upTo ?? 0;
    return state.turns.filter((turn) => turn.n > upTo).slice(-HISTORY_LIMIT).map((turn) => {
        if (turn.author === 'master') return `Мастер: ${turn.text}`;
        const name = state.heroes[HERO_IDS.indexOf(turn.author)]?.name ?? turn.author;
        const label = viewer === turn.author ? `Ты (${name})` : name;
        return `${label}: ${turn.text ?? legacyText(turn)}`;
    }).join('\n\n');
}

function legacyText({ speech, intent }) {
    const parts = [];
    if (speech) parts.push(`«${speech}»`);
    if (intent) parts.push(`*${intent}*`);
    return parts.join(' ') || '(молчит)';
}

/**
 * Ответ персонажа → текст сообщения. Снимает своё имя в начале и обрезает то, что модель начала писать за собеседника.
 * @param {string} raw
 * @param {{name: string, otherName: string}} names
 * @returns {{text: string}}
 */
export function parseDialogueResponse(raw, { name, otherName }) {
    let text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
    text = text.replace(new RegExp(`^\\*{0,2}${escapeRegExp(name)}\\*{0,2}\\s*:\\*{0,2}\\s*`, 'i'), '').trim();
    const foreign = new RegExp(`^\\s*\\*{0,2}${escapeRegExp(otherName)}\\*{0,2}\\s*:`, 'i');
    const lines = text.split('\n');
    const cut = lines.findIndex((line) => foreign.test(line));
    if (cut !== -1) text = lines.slice(0, cut).join('\n').trim();
    if (!text) throw new ParseError('Пустой ответ персонажа', raw);
    return { text };
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
