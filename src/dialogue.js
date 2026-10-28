// Режим «Без мастера» (этап 10, этап 12, FR-33): персонажи из карточек ST по очереди разговаривают друг с другом.
// Без мастера, кубиков, HP, листов и Историка. Модуль без зависимостей от ST, проверяется тестом в Node.
//
// Ход — одно обычное сообщение ролевого чата: речь, действия и описание вперемешку, без меток и мыслей.
// Персонажей 2–10, каждая группа (FR-34) — свой разговор: внутри группы по кругу, группы по очереди.
//
// Изоляция та же, что у героев в RPG (NFR-01): в промпт идут только своя карточка, имена собеседников
// и видимая часть разговора своей группы. Мысли (из ходов, сыгранных в старом формате) и чужие карточки сюда не передаются.

import { HISTORY_LIMIT, formatCard, formatMemory, languageRule, visibleTurns } from './prompts.js';
import { ParseError } from './parse.js';
import { GROUPS, groupMembers, heroById, heroGroup, heroId, heroIndex, isHeroId, turnGroup } from './heroes.js';
import { gameMode } from './modes.js';

/** Режим «Без мастера» (в чатах этапа 10 — mode: 'dialogue'). */
export function isDialogue(state) {
    return Boolean(state) && gameMode(state) === 'free';
}

/** Что мешает начать разговор; пустой список — можно. */
export function dialogueProblems({ selected, count = 2 }) {
    return selected.length === count ? [] : [`выбрано карточек: ${selected.length} из ${count}`];
}

/** Группы, где могут разговаривать хотя бы двое, по порядку A–E. */
export function talkingGroups(state) {
    return GROUPS.filter((group) => groupMembers(state, group).length >= 2);
}

/**
 * Кто говорит следующим: группы по очереди, внутри группы — по кругу в порядке карточек.
 * Персонаж один в своей группе молчит: ему не с кем говорить. Реплики мастера (режим переключали) не считаются.
 * @param {{heroes: object[], turns: Array<{author: string, group?: string}>}} state
 * @returns {string|null} heroN; null — ни в одной группе нет двоих
 */
export function dialogueNext(state) {
    const groups = talkingGroups(state);
    if (!groups.length) return null;
    const heroTurns = state.turns.filter((turn) => isHeroId(turn.author));
    const last = heroTurns.at(-1);
    const lastGroup = last ? turnGroup(last) : null;
    const group = lastGroup === null ? groups[0] : groups[(groups.indexOf(lastGroup) + 1) % groups.length] ?? groups[0];
    const members = groupMembers(state, group);
    const lastInGroup = heroTurns.findLast((turn) => turnGroup(turn) === group && members.includes(heroIndex(turn.author)));
    if (!lastInGroup) return heroId(members[0]);
    return heroId(members[(members.indexOf(heroIndex(lastInGroup.author)) + 1) % members.length]);
}

/**
 * Промпт одного сообщения персонажа.
 * @param {object} params
 * @param {object} params.state
 * @param {number} params.heroIndex
 * @param {import('./prompts.js').PromptCard} params.card карточка только этого персонажа
 * @param {string} params.language
 * @returns {Array<{role: string, content: string}>}
 */
export function buildDialoguePrompt({ state, heroIndex: index, card, language }) {
    const hero = state.heroes[index];
    const id = heroId(index);
    const others = companions(state, index);
    const otherName = others[0] ?? 'собеседник';
    const topic = state.scene?.premise?.trim();

    const system = [
        others.length > 1
            ? `Ты — ${hero.name}. Ты разговариваешь с персонажами ${others.join(', ')}. Это живой разговор, без ведущего и без игровых правил.`
            : `Ты — ${hero.name}. Ты разговариваешь с персонажем ${otherName}. Это живой разговор двоих, без ведущего и без игровых правил.`,
        `Говори и действуй только за ${hero.name}. Никогда не пиши реплики, действия и мысли за ${others.join(', ') || otherName}.`,
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

    const history = formatDialogueHistory(state, id);
    const user = [
        ...formatMemory(state, id),
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

/** Имена других персонажей группы. */
export function companions(state, index) {
    const group = heroGroup(state.heroes[index]);
    if (!group) return [];
    return groupMembers(state, group).filter((other) => other !== index).map((other) => state.heroes[other].name);
}

/**
 * Разговор глазами viewer: последние ходы его группы после сжатой памяти. Мысли не выводятся ничьи.
 * Ходы старого формата (speech/intent, сыгранные до этапа 10) и ходы мастера (режим переключали из RPG) тоже показываются.
 * @param {object} state
 * @param {string} viewer heroN
 */
export function formatDialogueHistory(state, viewer) {
    return visibleTurns(state, viewer).slice(-HISTORY_LIMIT).map((turn) => {
        if (turn.author === 'master') return `Мастер: ${turn.text}`;
        const name = heroById(state, turn.author)?.name ?? turn.author;
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
 * Ответ персонажа → текст сообщения. Снимает своё имя в начале и обрезает то, что модель начала писать за собеседников.
 * @param {string} raw
 * @param {{name: string, otherName?: string, otherNames?: string[]}} names
 * @returns {{text: string}}
 */
export function parseDialogueResponse(raw, { name, otherName, otherNames = [] }) {
    let text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
    text = text.replace(new RegExp(`^\\*{0,2}${escapeRegExp(name)}\\*{0,2}\\s*:\\*{0,2}\\s*`, 'i'), '').trim();
    const names = [...otherNames, otherName].filter(Boolean).map(escapeRegExp);
    const foreign = names.length ? new RegExp(`^\\s*\\*{0,2}(?:${names.join('|')})\\*{0,2}\\s*:`, 'i') : /(?!)/;
    const lines = text.split('\n');
    const cut = lines.findIndex((line) => foreign.test(line));
    if (cut !== -1) text = lines.slice(0, cut).join('\n').trim();
    if (!text) throw new ParseError('Пустой ответ персонажа', raw);
    return { text };
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
