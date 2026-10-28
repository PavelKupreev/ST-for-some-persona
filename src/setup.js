// Старт игры (этап 3): карточка мира (FR-01, FR-02) и листы героев (FR-04, FR-05).
// Модуль без зависимостей от ST: промпты и разбор JSON проверяются тестом в Node.

import { STATS } from './dice.js';
// Навыки 5e (PLAN 6.3) отключены по просьбе пользователя:
// import { SKILLS, SKILL_IDS, normalizeSkillList } from './dice.js';
import { ABILITY_MAX_LEVEL, normalizeAbilityList } from './abilities.js';
import { ParseError } from './parse.js';
import { languageRule } from './prompts.js';
import { DEFAULT_GROUP, GROUPS } from './heroes.js';
import { ADULT_RULE } from './modes.js';

export const STAT_MIN = 1;
export const STAT_MAX = 20;
export const HP_MAX = 999;
const CARD_LIMIT = 3000;

/**
 * Промпт мастера: короткий промпт мира → карточка мира в JSON (FR-01).
 * @param {object} params
 * @param {string} params.prompt промпт пользователя, например «фэнтези, драконы»
 * @param {string} params.language язык игры
 * @param {'adventure'|'romance'} [params.mode] режим игры (FR-33)
 */
export function buildWorldPrompt({ prompt, language, mode = 'adventure' }) {
    const system = [
        mode === 'romance'
            ? `Ты — Мастер-рассказчик взрослой романтической истории. Готовишь мир, где героям предстоит влюбляться, ревновать и выбирать. ${ADULT_RULE}`
            : 'Ты — Мастер (DM) настольной ролевой игры по правилам D&D 5e. Готовишь мир для новой кампании.',
        languageRule(language, 'Все значения в JSON'),
        '',
        'Ответь только JSON-объектом, без пояснений и без markdown:',
        '{',
        '  "setting": "сеттинг одним предложением",',
        '  "rules": ["3–5 правил мира: что здесь устроено не так, как в нашем мире"],',
        '  "era": "эпоха",',
        '  "tone": "тон истории",',
        mode === 'romance'
            ? '  "powerLevel": "уровень откровенности и накала страстей"'
            : '  "powerLevel": "уровень силы героев и мира"',
        '}',
        'Ключи оставь как в образце, на английском.',
    ];
    return [
        { role: 'system', content: system.join('\n') },
        { role: 'user', content: `Промпт мира: ${prompt}` },
    ];
}

/**
 * Разбирает карточку мира из ответа мастера.
 * @param {string} raw
 * @param {string} prompt исходный промпт, сохраняется в карточке
 * @returns {{prompt: string, setting: string, rules: string[], era: string, tone: string, powerLevel: string}}
 * @throws {ParseError}
 */
export function parseWorldCard(raw, prompt = '') {
    const json = extractJson(raw);
    if (!json || Array.isArray(json)) throw new ParseError('Мастер прислал не JSON-объект карточки мира', raw);

    const world = {
        prompt,
        setting: pickString(json, ['setting', 'сеттинг']),
        rules: toList(pickValue(json, ['rules', 'правила'])).slice(0, 5),
        era: pickString(json, ['era', 'эпоха']),
        tone: pickString(json, ['tone', 'тон']),
        powerLevel: pickString(json, ['powerLevel', 'power_level', 'power', 'уровень силы']),
    };
    const missing = [
        !world.setting && 'сеттинг',
        !world.rules.length && 'правила',
        !world.era && 'эпоха',
        !world.tone && 'тон',
        !world.powerLevel && 'уровень силы',
    ].filter(Boolean);
    if (missing.length) throw new ParseError(`В карточке мира нет полей: ${missing.join(', ')}`, raw);
    return world;
}

/**
 * Промпт мастера: мир и карточки → листы героев (FR-04). Для «Романтики» — без статов и способностей, с отношениями (FR-37).
 * @param {object} params
 * @param {object} params.world карточка мира
 * @param {Array<{name: string, description?: string, personality?: string, scenario?: string}>} params.cards карточки,
 *   для которых нужны листы
 * @param {string[]} [params.others] имена героев, у которых листы уже есть: они тоже в игре
 * @param {string} params.language
 * @param {'adventure'|'romance'} [params.mode]
 */
export function buildHeroesPrompt({ world, cards, others = [], language, mode = 'adventure' }) {
    const names = cards.map((card) => card.name);
    const everyone = [...names, ...others];
    const romance = mode === 'romance';
    const many = names.length > 1;
    const example = romance
        ? `  {"name": "${names[0]}", "inventory": ["..."], "globalGoal": "...", "microGoal": "...", "relations": {${everyone.filter((name) => name !== names[0]).map((name) => `"${name}": "..."`).join(', ')}}}`
        : `  {"name": "${names[0]}", "stats": {"STR": 10, "DEX": 10, "CON": 10, "INT": 10, "WIS": 10, "CHA": 10}, "hp": 10, "abilities": [{"name": "...", "description": "...", "stat": "INT"}], "inventory": ["..."], "globalGoal": "...", "microGoal": "..."}`;
    const system = [
        romance
            ? `Ты — Мастер-рассказчик взрослой романтической истории. Готовишь ${many ? 'листы героев' : 'лист героя'} к первой сцене. ${ADULT_RULE}`
            : `Ты — Мастер (DM) настольной ролевой игры по правилам D&D 5e. Готовишь ${many ? `листы героев (${names.length})` : 'лист героя'} к первой сцене.`,
        languageRule(language, 'Все текстовые значения в JSON'),
        '',
        'Для каждого героя:',
        ...(romance ? [
            '- inventory — 1–4 вещи, которые при нём;',
            '- globalGoal — глубокое желание или цель, выведенные из предыстории карточки, одним-двумя предложениями;',
            '- microGoal — тайное желание на ближайшую сцену: конкретное, достижимое, о нём не знают другие герои;',
            '- relations — отношение к каждому другому герою короткой строкой (симпатия, недоверие, давняя обида, тайная влюблённость), по карточкам.',
        ] : [
            '- статы STR, DEX, CON, INT, WIS, CHA — целые числа от 1 до 20, по характеру и предыстории карточки (обычный человек ~10, сильная сторона 14–17);',
            '- hp — максимум хитов, целое число (обычно 8–20 для героя первого уровня, с учётом CON);',
            // Навыки 5e (PLAN 6.3) отключены:
            // `- skills — 2–4 навыка 5e, которыми герой владеет, по его предыстории и сильным статам; только id из списка: ${SKILL_IDS.map((id) => `${id} (${SKILLS[id].ru})`).join(', ')};`,
            `- abilities — 1–2 уникальные способности героя по его карточке и миру (например «Огненный шар», «Гигантификация», «Теневой шаг»): name — название, description — что делает на 1-м уровне и как усиливается к ${ABILITY_MAX_LEVEL}-му, одним-двумя предложениями; stat — характеристика проверки (STR, DEX, CON, INT, WIS, CHA);`,
            '- inventory — 2–5 стартовых предметов, подходящих миру и герою;',
            '- globalGoal — глобальная цель, выведенная из предыстории карточки, одним-двумя предложениями;',
            `- microGoal — стартовая микроцель на ближайшую сцену: конкретная, достижимая, тайная от ${everyone.length > 1 ? 'других героев' : 'всех'}.`,
        ]),
        ...(others.length ? ['', `Листы героев ${others.join(', ')} уже готовы: они тоже в игре, но для них листы не нужны.`] : []),
        '',
        `Ответь только JSON, без пояснений и без markdown, героев в том же порядке (${names.join(', ')}):`,
        '{"heroes": [',
        `${example}${many ? ',' : ''}`,
        ...(many ? [`  {"name": "${names[1]}", ...}${names.length > 2 ? ', ...' : ''}`] : []),
        ']}',
        '',
        '### МИР',
        formatWorldShort(world),
        '',
        ...cards.flatMap((card, index) => [
            `### ГЕРОЙ ${index + 1}: ${card.name}`,
            formatCardShort(card, everyone.find((name) => name !== card.name) ?? 'собеседник'),
            '',
        ]),
    ];
    return [
        { role: 'system', content: system.join('\n') },
        { role: 'user', content: `Составь ${many ? 'листы героев' : 'лист героя'} ${names.join(', ')}.` },
    ];
}

/**
 * Разбирает листы героев. Герои сопоставляются по имени, иначе по порядку.
 * @param {string} raw
 * @param {string[]} names имена героев, для которых просили листы
 * @param {object} [options]
 * @param {'adventure'|'romance'} [options.mode]
 * @param {string[]} [options.allNames] все герои игры: отношения романтики только к ним
 * @returns {Array<{stats: Record<string, number>, hp: number, abilities: object[], inventory: string[], globalGoal: string, microGoal: string,
 *   relations?: Record<string, string>}>}
 * @throws {ParseError}
 */
export function parseHeroSheets(raw, names, { mode = 'adventure', allNames = names } = {}) {
    const json = extractJson(raw);
    let list = Array.isArray(json) ? json : pickValue(json ?? {}, ['heroes', 'герои', 'characters']);
    // Один герой: модель иногда присылает сам лист без списка.
    if (!list && names.length === 1 && json && typeof json === 'object' && !Array.isArray(json)) list = [json];
    if (!Array.isArray(list) || list.length < names.length) {
        throw new ParseError(`Мастер прислал не список из ${names.length} ${names.length === 1 ? 'героя' : 'героев'}`, raw);
    }

    const byName = (name) => list.find((item) => typeof item?.name === 'string' && item.name.trim().toLowerCase() === name.trim().toLowerCase());
    const ordered = names.map((name, index) => byName(name) ?? list[index]);

    return ordered.map((item, index) => {
        try {
            return mode === 'romance' ? normalizeRomanceSheet(item, names[index], allNames) : normalizeSheet(item);
        } catch (error) {
            throw new ParseError(`Лист героя ${names[index]}: ${error.message}`, raw);
        }
    });
}

// Лист «Романтики» (FR-37): цели, вещи и отношения к другим героям; статы и HP — заглушки для общего кода.
function normalizeRomanceSheet(item, name, allNames) {
    if (!item || typeof item !== 'object') throw new Error('нет данных');
    const raw = pickValue(item, ['relations', 'relationships', 'отношения']);
    const relations = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw)) {
            const other = allNames.find((candidate) => candidate.toLowerCase() === key.trim().toLowerCase());
            if (other && other !== name && String(value ?? '').trim()) relations[other] = String(value).trim();
        }
    }
    return {
        ...blankSheet(),
        inventory: toList(pickValue(item, ['inventory', 'items', 'инвентарь'])),
        globalGoal: pickString(item, ['globalGoal', 'global_goal', 'goal', 'desire', 'цель']),
        microGoal: pickString(item, ['microGoal', 'micro_goal', 'microgoal', 'микроцель', 'желание']),
        relations,
    };
}

function normalizeSheet(item) {
    if (!item || typeof item !== 'object') throw new Error('нет данных');
    const rawStats = pickValue(item, ['stats', 'abilityScores', 'ability_scores', 'статы']) ?? item;
    const stats = {};
    for (const [key, value] of Object.entries(rawStats)) {
        const stat = key.slice(0, 3).toUpperCase();
        if (STATS.includes(stat) && stats[stat] === undefined) stats[stat] = toInt(value);
    }
    const missing = STATS.filter((stat) => !Number.isFinite(stats[stat]));
    if (missing.length) throw new Error(`нет статов ${missing.join(', ')}`);

    const hpValue = pickValue(item, ['hp', 'HP', 'hitPoints', 'хиты']);
    const hp = toInt(typeof hpValue === 'object' && hpValue ? hpValue.max ?? hpValue.current : hpValue);
    if (!Number.isFinite(hp)) throw new Error('нет HP');

    return {
        stats: Object.fromEntries(STATS.map((stat) => [stat, clamp(stats[stat], STAT_MIN, STAT_MAX)])),
        hp: clamp(hp, 1, HP_MAX),
        // skills: normalizeSkillList(pickValue(item, ['skills', 'proficiencies', 'навыки'])), // навыки 5e отключены
        abilities: normalizeAbilityList(pickValue(item, ['abilities', 'powers', 'способности'])),
        inventory: toList(pickValue(item, ['inventory', 'items', 'инвентарь'])),
        globalGoal: pickString(item, ['globalGoal', 'global_goal', 'goal', 'цель']),
        microGoal: pickString(item, ['microGoal', 'micro_goal', 'microgoal', 'микроцель']),
    };
}

/** Пустой лист для ручного ввода, когда генерация не удалась (UC-02). */
export function blankSheet() {
    return {
        stats: Object.fromEntries(STATS.map((stat) => [stat, 10])),
        hp: 10,
        // skills: [], // навыки 5e отключены
        abilities: [],
        inventory: [],
        globalGoal: '',
        microGoal: '',
        relations: {},
    };
}

/**
 * Герой для состояния игры из карточки ST и листа.
 * @param {{avatar: string, name: string}} card
 * @param {ReturnType<typeof blankSheet>} sheet
 * @param {string} [group] стартовая группа (FR-34)
 */
export function createHero(card, sheet, group = DEFAULT_GROUP) {
    const home = GROUPS.includes(group) ? group : DEFAULT_GROUP;
    return {
        cardAvatar: card.avatar,
        name: card.name,
        stats: { ...sheet.stats },
        hp: { current: sheet.hp, max: sheet.hp },
        // skills: [...(sheet.skills ?? [])], // навыки 5e отключены
        abilities: (sheet.abilities ?? []).map((ability) => ({ ...ability })),
        inventory: [...sheet.inventory],
        globalGoal: sheet.globalGoal,
        microGoal: sheet.microGoal,
        relations: { ...(sheet.relations ?? {}) },
        group: home,
        homeGroup: home,
        silence: 0,
    };
}

/**
 * Что не так с готовностью к старту; пустой список — можно стартовать (FR-03, FR-05).
 * @param {object} params
 * @param {number} [params.count] сколько персонажей задано (FR-03)
 * @param {boolean} [params.sheets] нужны статы и HP (в «Романтике» их нет)
 */
export function startProblems({ world, heroes, selected, count = 2, sheets = true }) {
    const problems = [];
    if (!world?.setting) problems.push('нет карточки мира');
    if (selected.length !== count) problems.push(`выбрано карточек: ${selected.length} из ${count}`);
    else if (heroes.length !== selected.length || heroes.some((hero, index) => hero.cardAvatar !== selected[index])) problems.push('листы героев не сгенерированы для выбранных карточек');
    else if (sheets) {
        for (const hero of heroes) {
            const bad = STATS.filter((stat) => !(hero.stats[stat] >= STAT_MIN && hero.stats[stat] <= STAT_MAX));
            if (bad.length) problems.push(`${hero.name}: статы вне 1–20 (${bad.join(', ')})`);
            if (!(hero.hp.max >= 1)) problems.push(`${hero.name}: HP должно быть больше 0`);
        }
    }
    return problems;
}

/**
 * Достаёт JSON из ответа модели: снимает ```json, берёт от первой скобки до последней,
 * прощает висячие запятые.
 * @returns {any} разобранный JSON или null
 */
export function extractJson(raw) {
    const text = String(raw ?? '').replace(/```(?:json)?/gi, '').trim();
    const start = text.search(/[[{]/);
    if (start === -1) return null;
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (end <= start) return null;
    const body = text.slice(start, end + 1);
    for (const candidate of [body, body.replace(/,\s*([}\]])/g, '$1')]) {
        try {
            return JSON.parse(candidate);
        } catch {
            // пробуем следующий вариант
        }
    }
    return null;
}

function pickValue(object, keys) {
    const wanted = keys.map((key) => key.toLowerCase());
    for (const [key, value] of Object.entries(object)) {
        if (wanted.includes(key.toLowerCase())) return value;
    }
    return undefined;
}

function pickString(object, keys) {
    const value = pickValue(object, keys);
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function toList(value) {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\n|;/) : [];
    return items.map((item) => String(item ?? '').replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
}

function toInt(value) {
    const number = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    return Number.isFinite(number) ? Math.round(number) : NaN;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function formatWorldShort(world) {
    if (!world) return '—';
    return [
        `Сеттинг: ${world.setting || '—'}`,
        `Эпоха: ${world.era || '—'}. Тон: ${world.tone || '—'}. Уровень силы: ${world.powerLevel || '—'}`,
        ...(world.rules ?? []).map((rule) => `- ${rule}`),
    ].join('\n');
}

function formatCardShort(card, otherName) {
    const text = [
        card.description && `Описание: ${card.description}`,
        card.personality && `Характер: ${card.personality}`,
        card.scenario && `Предыстория: ${card.scenario}`,
    ].filter(Boolean).join('\n')
        .replace(/\{\{char\}\}/gi, card.name).replace(/\{\{user\}\}/gi, otherName);
    return text.length > CARD_LIMIT ? `${text.slice(0, CARD_LIMIT)}…` : text || '(карточка пустая)';
}
