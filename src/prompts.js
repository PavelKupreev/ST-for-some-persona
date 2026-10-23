// Сборщики промптов мастера (FR-08) и героев (FR-12, NFR-01).
// Модуль без зависимостей от ST: карточки персонажей передаёт вызывающий код, поэтому изоляцию можно проверить тестом.
//
// Изоляция: промпт героя собирается только из его собственных полей и видимой части ходов.
// Мысли, цели и микроцель другого героя сюда не передаются вообще, а не вырезаются потом.

import { STATS, abilityModifier } from './dice.js';

export const HERO_IDS = ['hero1', 'hero2'];

// Сколько последних ходов попадает в промпт. Сжатие старых ходов — этап 6 (FR-26).
export const HISTORY_LIMIT = 40;
const CARD_LIMIT = 3000;

/**
 * @typedef {object} PromptCard то, что нужно из карточки ST
 * @property {string} name
 * @property {string} [description]
 * @property {string} [personality]
 * @property {string} [scenario]
 */

/**
 * Промпт мастера: мир, оба героя целиком, история сцены, записка пользователя.
 * @param {object} params
 * @param {object} params.state состояние игры из chatMetadata
 * @param {PromptCard[]} params.cards карточки героя 1 и героя 2
 * @param {string} params.language язык игры
 * @param {'turn'|'outcome'} [params.mode] turn — обычный ход, outcome — описать исход после бросков
 * @returns {Array<{role: string, content: string}>}
 */
export function buildMasterPrompt({ state, cards, language, mode = 'turn' }) {
    const names = state.heroes.map((hero) => hero.name);
    const system = [
        'Ты — Мастер (DM) настольной ролевой игры по правилам D&D 5e. Ты рассказчик, судья исходов и голос всех NPC.',
        `Два героя (${names[0]} и ${names[1]}) — отдельные игроки. Ты никогда не пишешь их реплики, мысли и решения: только мир, NPC и последствия действий героев.`,
        `Пиши на языке: ${language}. Это правило важнее языка карточек.`,
        '',
        '### ПРАВИЛА ОТВЕТА',
        '- 1–3 абзаца повествования от третьего лица, настоящее время. Речь NPC — прямой речью.',
        '- Если исход действия героя неочевиден, поставь метку броска и остановись на моменте попытки, исход не описывай: его опишешь после броска.',
        '  Формат метки: [ROLL d20 СТАТ DCn ГЕРОЙ], где СТАТ — STR, DEX, CON, INT, WIS или CHA, n — сложность 5–25, ГЕРОЙ — hero1 или hero2.',
        '  Пример: [ROLL d20 DEX DC12 hero1]',
        '- Последней строкой всегда выбери, кто действует дальше: [NEXT: hero1], [NEXT: hero2] или [NEXT: master] (если сцене нужно ещё твоё описание).',
        '- Двигай сюжет к глобальным целям героев, давай поводы для микроцелей, но не раскрывай одному герою тайны другого.',
        '',
        '### МИР',
        formatWorld(state.world),
        '',
        ...state.heroes.flatMap((hero, index) => [
            `### ГЕРОЙ ${index + 1}: ${hero.name} (${HERO_IDS[index]})`,
            formatCard(cards[index], hero.name, names[1 - index]),
            formatSheet(hero),
            `Глобальная цель: ${hero.globalGoal || '—'}`,
            `Микроцель (тайная, знают только этот герой и ты): ${hero.microGoal || '—'}`,
            `Последние мысли: ${lastThoughts(state, index) || '—'}`,
            '',
        ]),
    ];

    const task = mode === 'outcome'
        ? 'Броски выше уже сделаны. Опиши исход строго по их результатам (✅ успех, ❌ провал). Новых меток броска не ставь. Последней строкой — [NEXT: ...].'
        : state.turns.length
            ? 'Продолжи сцену: опиши последствия последнего действия и реакцию мира и NPC. Последней строкой — [NEXT: ...].'
            : `Начни сцену: место, обстановка, что происходит прямо сейчас, где находятся герои. Завязка: ${state.scene?.premise || 'придумай сам, исходя из мира и целей героев'}. Последней строкой — [NEXT: ...].`;

    const user = [
        '### ИСТОРИЯ СЦЕНЫ',
        formatHistory(state, { viewer: 'master' }) || '(сцена ещё не началась)',
        '',
    ];
    if (state.session?.masterNote) {
        user.push('### ЗАПИСКА ОТ ПОЛЬЗОВАТЕЛЯ (выполни в этом ходе, героям не раскрывай)', state.session.masterNote, '');
    }
    user.push('### ЗАДАНИЕ', task);

    return [
        { role: 'system', content: system.join('\n') },
        { role: 'user', content: user.join('\n') },
    ];
}

/**
 * Промпт героя: мир, своя карточка, свои статы, цели, микроцель, мысли и видимая история.
 * @param {object} params
 * @param {object} params.state
 * @param {0|1} params.heroIndex
 * @param {PromptCard} params.card карточка только этого героя
 * @param {string} params.language
 * @returns {Array<{role: string, content: string}>}
 */
export function buildHeroPrompt({ state, heroIndex, card, language }) {
    const hero = state.heroes[heroIndex];
    const otherName = state.heroes[1 - heroIndex].name;

    const system = [
        `Ты играешь персонажа ${hero.name} в настольной ролевой игре. Ведущий — Мастер: он описывает мир, озвучивает NPC и решает исходы действий.`,
        `Рядом с тобой второй герой — ${otherName}. Ты говоришь и действуешь только за ${hero.name}.`,
        `Никогда не пиши реплики и действия за ${otherName} или за Мастера и не описывай исход своих действий — его решит Мастер.`,
        `Пиши на языке: ${language}. Это правило важнее языка карточки.`,
        '',
        '### МИР',
        formatWorld(state.world),
        '',
        '### ТВОЯ КАРТОЧКА',
        formatCard(card, hero.name, otherName),
        '',
        '### ТВОЙ ЛИСТ ПЕРСОНАЖА',
        formatSheet(hero),
        '',
        '### ТВОЯ ГЛОБАЛЬНАЯ ЦЕЛЬ',
        hero.globalGoal || '—',
        '',
        `### ТВОЯ ТАЙНАЯ МИКРОЦЕЛЬ (${otherName} о ней не знает)`,
        hero.microGoal || '—',
        '',
        '### ФОРМАТ ОТВЕТА',
        'Ровно три части с метками, без другого текста:',
        'РЕПЛИКА: что ты говоришь вслух, не больше одного абзаца (или «—», если молчишь)',
        'НАМЕРЕНИЕ: что ты пытаешься сделать, одним-двумя предложениями, без исхода',
        'МЫСЛИ: что ты думаешь на самом деле; это видишь только ты',
    ];

    const user = [
        '### ЧТО ПРОИСХОДИЛО',
        formatHistory(state, { viewer: HERO_IDS[heroIndex] }) || '(сцена ещё не началась)',
        '',
        `Твой ход, ${hero.name}.`,
    ];

    return [
        { role: 'system', content: system.join('\n') },
        { role: 'user', content: user.join('\n') },
    ];
}

/**
 * История сцены глазами viewer.
 * master видит всё, включая мысли героев. Герой видит общую часть и только свои мысли.
 * @param {object} state
 * @param {object} options
 * @param {'master'|'hero1'|'hero2'} options.viewer
 */
export function formatHistory(state, { viewer }) {
    return state.turns.slice(-HISTORY_LIMIT).map((turn) => {
        if (turn.author === 'master') {
            const lines = [`Мастер: ${turn.text}`];
            for (const roll of turn.rolls ?? []) lines.push(roll.line);
            return lines.join('\n');
        }

        const heroIndex = HERO_IDS.indexOf(turn.author);
        const name = state.heroes[heroIndex]?.name ?? turn.author;
        const own = viewer === turn.author;
        const lines = [`${own ? `Ты (${name})` : name}: ${turn.speech ? `«${turn.speech}»` : '(молчит)'}`];
        if (turn.intent) lines.push(`  действие: ${turn.intent}`);
        if (turn.thoughts && (own || viewer === 'master')) {
            lines.push(`  ${own ? 'твои мысли' : 'мысли'}: ${turn.thoughts}`);
        }
        return lines.join('\n');
    }).join('\n\n');
}

function lastThoughts(state, heroIndex) {
    const id = HERO_IDS[heroIndex];
    for (let i = state.turns.length - 1; i >= 0; i--) {
        if (state.turns[i].author === id && state.turns[i].thoughts) return state.turns[i].thoughts;
    }
    return '';
}

function formatWorld(world) {
    if (!world) return '—';
    return [
        `Сеттинг: ${world.setting || '—'}`,
        `Эпоха: ${world.era || '—'}`,
        `Тон: ${world.tone || '—'}`,
        `Уровень силы: ${world.powerLevel || '—'}`,
        'Правила мира:',
        ...(world.rules?.length ? world.rules.map((rule) => `- ${rule}`) : ['- —']),
    ].join('\n');
}

function formatCard(card, name, otherName) {
    if (!card) return '(карточка не найдена)';
    const parts = [
        card.description && `Описание: ${card.description}`,
        card.personality && `Характер: ${card.personality}`,
        card.scenario && `Предыстория: ${card.scenario}`,
    ].filter(Boolean);
    const text = substituteMacros(parts.join('\n'), name, otherName);
    return text.length > CARD_LIMIT ? `${text.slice(0, CARD_LIMIT)}…` : text || '(карточка пустая)';
}

// В карточках ST встречаются {{char}} и {{user}}. Здесь «user» — второй герой.
function substituteMacros(text, name, otherName) {
    return text.replace(/\{\{char\}\}/gi, name).replace(/\{\{user\}\}/gi, otherName);
}

function formatSheet(hero) {
    const stats = STATS.map((stat) => {
        const score = hero.stats?.[stat] ?? 10;
        const mod = abilityModifier(score);
        return `${stat} ${score} (${mod >= 0 ? '+' : ''}${mod})`;
    }).join(', ');
    const inventory = hero.inventory?.length ? hero.inventory.join(', ') : '—';
    return `Статы: ${stats}\nHP: ${hero.hp?.current ?? '?'}/${hero.hp?.max ?? '?'}\nИнвентарь: ${inventory}`;
}
