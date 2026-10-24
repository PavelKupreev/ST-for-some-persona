// Сборщики промптов мастера (FR-08) и героев (FR-12, NFR-01).
// Модуль без зависимостей от ST: карточки персонажей передаёт вызывающий код, поэтому изоляцию можно проверить тестом.
//
// Изоляция: промпт героя собирается только из его собственных полей и видимой части ходов.
// Мысли, цели и микроцель другого героя сюда не передаются вообще, а не вырезаются потом.

import { STATS, abilityModifier } from './dice.js';
// Навыки 5e (PLAN 6.3) отключены по просьбе пользователя, код оставлен закомментированным.
// import { PROFICIENCY_BONUS, SKILLS, SKILL_IDS } from './dice.js';
import { ABILITY_MAX_LEVEL, formatAbilities } from './abilities.js';

export const HERO_IDS = ['hero1', 'hero2'];

// Сколько последних ходов попадает в промпт. Более старые сжимаются в память (src/memory.js, FR-26).
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
 * Инструкция языка игры (NFR-06). Одна на все промпты, чтобы язык карточки не перебивал настройку.
 * @param {string} language
 * @param {string} [subject] что именно писать на этом языке
 */
export function languageRule(language, subject = 'Весь текст') {
    return `${subject} пиши на языке: ${language || 'русский'}. Это правило важнее языка карточек и примеров: даже если карточка на другом языке, отвечай на языке игры (имена собственные можно не переводить).`;
}

const ROLL_FORMAT = [
    '  Формат метки: [ROLL d20 ПРОВЕРКА DCn ГЕРОЙ], где n — сложность 5–25, ГЕРОЙ — hero1 или hero2,',
    '  ПРОВЕРКА — характеристика STR, DEX, CON, INT, WIS, CHA или, если герой применяет уникальную способность, её название из листа.',
    // Навыки 5e (PLAN 6.3) отключены:
    // `  ПРОВЕРКА — навык 5e (${SKILL_IDS.join(', ')}) или, если ни один навык не подходит, характеристика STR, DEX, CON, INT, WIS, CHA.`,
    '  Примеры: [ROLL d20 DEX DC12 hero1], [ROLL d20 Огненный шар DC14 hero2]',
];

// Уникальные способности (PLAN 6.4, FR-31): сила растёт с уровнем, применение прокачивает.
const ABILITY_RULES = [
    `- Уникальные способности героев — их главная сила. Уровень 1–${ABILITY_MAX_LEVEL}: чем выше, тем мощнее эффект (урон, дальность, длительность, масштаб). Описывай эффект соответственно уровню.`,
    '  Каждое применение прокачивает способность. Применение с неочевидным исходом проверяй броском по названию способности (к броску прибавится её уровень);',
    '  применение без броска отметь в блоке STATE полем "use": [ROLL] и "use" для одного применения вместе не ставь.',
];

// Изменения листа героя (FR-15): мастер пишет их отдельным блоком, код применяет.
const STATE_RULES = [
    '- Если у героя изменились HP, статы или инвентарь (урон, лечение, нашёл, потерял, потратил предмет), добавь отдельной строкой блок:',
    '  [STATE {"hero1": {"hp": -5, "add": ["ржавый ключ"], "remove": ["факел"]}, "hero2": {"stats": {"STR": -1}, "use": ["Теневой шаг"]}}]',
    '  hp и stats — изменения со знаком, а не новые значения; add и remove — предметы; use — применённые без броска способности. Указывай только то, что изменилось. Нет изменений — нет блока.',
    '  Урон и потерю предметов давай только как исход действий или событий, броски не выдумывай.',
];

// Правила бросков зависят от настройки «Частота проверок»: в этом ходе бросок обязателен, запрещён или на усмотрение мастера.
function checkRules(check) {
    if (check.mode === 'forbidden') return ['- Метки броска [ROLL ...] в этом ходе не ставь: исход действий определи сам.'];
    const lead = check.mode === 'required'
        ? '- Действие героя в этом ходе требует проверки: поставь метку броска и остановись на моменте попытки, исход не описывай: его опишешь после броска.'
        : '- Если исход действия героя неочевиден, поставь метку броска и остановись на моменте попытки, исход не описывай: его опишешь после броска.';
    return [lead, ...ROLL_FORMAT];
}

function checkTask(check) {
    if (check.mode === 'required') return `Последнее действие ${check.hero ?? 'героя'} проверь броском: поставь ровно одну метку [ROLL d20 СТАТ DCn ${check.hero ?? 'hero1'}] с подходящим статом и сложностью.`;
    if (check.mode === 'forbidden') return 'Бросков в этом ходе нет.';
    return '';
}

/**
 * Промпт мастера: мир, оба героя целиком, история сцены, записка пользователя.
 * @param {object} params
 * @param {object} params.state состояние игры из chatMetadata
 * @param {PromptCard[]} params.cards карточки героя 1 и героя 2
 * @param {string} params.language язык игры
 * @param {'turn'|'outcome'} [params.mode] turn — обычный ход, outcome — описать исход после бросков
 * @param {{mode: 'free'|'required'|'forbidden', hero?: string}} [params.check] нужна ли проверка кубиком в этом ходе
 *   (настройка «Частота проверок»): free — решает мастер, required — обязательна для героя hero, forbidden — без бросков
 * @returns {Array<{role: string, content: string}>}
 */
export function buildMasterPrompt({ state, cards, language, mode = 'turn', check = { mode: 'free' } }) {
    const names = state.heroes.map((hero) => hero.name);
    const system = [
        'Ты — Мастер (DM) настольной ролевой игры по правилам D&D 5e. Ты рассказчик, судья исходов и голос всех NPC.',
        `Два героя (${names[0]} и ${names[1]}) — отдельные игроки. Ты никогда не пишешь их реплики, мысли и решения: только мир, NPC и последствия действий героев.`,
        languageRule(language),
        '',
        '### ПРАВИЛА ОТВЕТА',
        '- Коротко: 1–2 абзаца, не больше 100 слов. Третье лицо, настоящее время.',
        '- Твоя часть — результат действий героев, реакция мира, глобальные события и речь NPC (прямой речью).',
        '- Не пересказывай и не цитируй реплики героев, не пиши за них ни слова, ни мыслей, ни новых действий: их реплики уже есть в истории, герои говорят сами.',
        ...checkRules(check),
        ...STATE_RULES,
        ...ABILITY_RULES,
        '- Последней строкой всегда выбери, кто действует дальше: [NEXT: hero1], [NEXT: hero2] или [NEXT: master] (если сцене нужно ещё твоё описание).',
        '- Двигай сюжет к глобальным целям героев, давай поводы для микроцелей, но не раскрывай одному герою тайны другого.',
        '- Когда сцена логически завершена (цель сцены достигнута или провалена, герои покидают место, наступает пауза в событиях), опиши финал и поставь отдельной строкой метку [КОНЕЦ СЦЕНЫ] перед [NEXT: ...]. Не ставь её посреди событий.',
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

    let task = mode === 'outcome'
        ? 'Броски выше уже сделаны. Опиши исход строго по их результатам (✅ успех, ❌ провал). Новых меток броска не ставь. Последней строкой — [NEXT: ...].'
        : state.turns.length
            ? 'Продолжи сцену: опиши последствия последнего действия и реакцию мира и NPC. Последней строкой — [NEXT: ...].'
            : `Начни сцену: место, обстановка, что происходит прямо сейчас, где находятся герои. ${state.scene?.premise?.trim()
                ? `Завязка от пользователя: ${withPeriod(state.scene.premise.trim())}`
                : 'Завязки нет: придумай её сам, исходя из мира, предыстории и целей героев, и сразу дай героям повод действовать.'} Последней строкой — [NEXT: ...].`;

    if (mode !== 'outcome') task = [task, checkTask(check)].filter(Boolean).join(' ');

    const user = [
        ...formatMemory(state, 'master'),
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
        languageRule(language),
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
        'Твои уникальные способности — твоя сила, применяй их, когда это уместно: чем чаще применяешь, тем сильнее они становятся. Исход применения решает Мастер.',
        '',
        '### ФОРМАТ ОТВЕТА',
        'Ровно три части с метками, без другого текста:',
        'РЕПЛИКА: что ты говоришь вслух, не больше одного абзаца (или «—», если молчишь)',
        'НАМЕРЕНИЕ: что ты пытаешься сделать, одним-двумя предложениями, без исхода',
        'МЫСЛИ: что ты думаешь на самом деле; это видишь только ты',
    ];

    const user = [
        ...formatMemory(state, HERO_IDS[heroIndex]),
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
    const upTo = state.memory?.upTo ?? 0;
    return formatTurns(state, state.turns.filter((turn) => turn.n > upTo).slice(-HISTORY_LIMIT), { viewer });
}

/**
 * Ходы глазами viewer. public — без чьих-либо мыслей (для общей памяти).
 * @param {object} state
 * @param {object[]} turns
 * @param {object} options
 * @param {'master'|'hero1'|'hero2'|'public'} options.viewer
 */
export function formatTurns(state, turns, { viewer }) {
    return turns.map((turn) => {
        if (turn.author === 'master') {
            const lines = [`Мастер: ${turn.text}`];
            for (const roll of turn.rolls ?? []) lines.push(roll.line);
            for (const change of turn.changes ?? []) lines.push(`📋 ${change}`);
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

/**
 * Блок памяти (FR-26). Общую память видят все, пересказ мыслей героя — только он сам и мастер (NFR-01).
 * @param {object} state
 * @param {'master'|'hero1'|'hero2'} viewer
 * @returns {string[]} строки промпта, пусто, если памяти нет
 */
export function formatMemory(state, viewer) {
    const memory = state.memory;
    if (!memory?.upTo) return [];
    const lines = ['### ПАМЯТЬ: ЧТО БЫЛО РАНЬШЕ', memory.public || '—', ''];
    HERO_IDS.forEach((id, index) => {
        const thoughts = memory.thoughts?.[id];
        if (!thoughts || (viewer !== 'master' && viewer !== id)) return;
        const title = viewer === id ? 'ТВОИ ПРЕЖНИЕ МЫСЛИ' : `ПРЕЖНИЕ МЫСЛИ ГЕРОЯ ${index + 1} (${state.heroes[index]?.name ?? id})`;
        lines.push(`### ${title}`, thoughts, '');
    });
    return lines;
}

function withPeriod(text) {
    return /[.!?…»"]$/.test(text) ? text : `${text}.`;
}

function lastThoughts(state, heroIndex) {
    const id = HERO_IDS[heroIndex];
    for (let i = state.turns.length - 1; i >= 0; i--) {
        if (state.turns[i].author === id && state.turns[i].thoughts) return state.turns[i].thoughts;
    }
    return '';
}

export function formatWorld(world) {
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

export function formatCard(card, name, otherName) {
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
    // Навыки 5e (PLAN 6.3) отключены:
    // const skills = hero.skills?.length
    //     ? hero.skills.filter((id) => SKILLS[id]).map((id) => `${SKILLS[id].ru} (${id}, ${SKILLS[id].stat})`).join(', ')
    //     : '—';
    // ...`\nНавыки с владением (+${PROFICIENCY_BONUS} к проверке): ${skills}`
    return [
        `Статы: ${stats}`,
        `HP: ${hero.hp?.current ?? '?'}/${hero.hp?.max ?? '?'}`,
        ...formatAbilities(hero),
        `Инвентарь: ${inventory}`,
    ].join('\n');
}
