// Старт игры (этап 3): карточка мира (FR-01, FR-02) и листы героев (FR-04, FR-05).
// Модуль без зависимостей от ST: промпты и разбор JSON проверяются тестом в Node.

import { STATS } from './dice.js';
import { ParseError } from './parse.js';
import { languageRule } from './prompts.js';

export const STAT_MIN = 1;
export const STAT_MAX = 20;
export const HP_MAX = 999;
const CARD_LIMIT = 3000;

/**
 * Промпт мастера: короткий промпт мира → карточка мира в JSON (FR-01).
 * @param {object} params
 * @param {string} params.prompt промпт пользователя, например «фэнтези, драконы»
 * @param {string} params.language язык игры
 */
export function buildWorldPrompt({ prompt, language }) {
    const system = [
        'Ты — Мастер (DM) настольной ролевой игры по правилам D&D 5e. Готовишь мир для новой кампании.',
        languageRule(language, 'Все значения в JSON'),
        '',
        'Ответь только JSON-объектом, без пояснений и без markdown:',
        '{',
        '  "setting": "сеттинг одним предложением",',
        '  "rules": ["3–5 правил мира: что здесь устроено не так, как в нашем мире"],',
        '  "era": "эпоха",',
        '  "tone": "тон истории",',
        '  "powerLevel": "уровень силы героев и мира"',
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
 * Промпт мастера: мир и две карточки → статы, HP, цели и микроцели героев (FR-04).
 * @param {object} params
 * @param {object} params.world карточка мира
 * @param {Array<{name: string, description?: string, personality?: string, scenario?: string}>} params.cards
 * @param {string} params.language
 */
export function buildHeroesPrompt({ world, cards, language }) {
    const names = cards.map((card) => card.name);
    const system = [
        'Ты — Мастер (DM) настольной ролевой игры по правилам D&D 5e. Готовишь листы двух героев к первой сцене.',
        languageRule(language, 'Все текстовые значения в JSON'),
        '',
        'Для каждого героя:',
        '- статы STR, DEX, CON, INT, WIS, CHA — целые числа от 1 до 20, по характеру и предыстории карточки (обычный человек ~10, сильная сторона 14–17);',
        '- hp — максимум хитов, целое число (обычно 8–20 для героя первого уровня, с учётом CON);',
        '- inventory — 2–5 стартовых предметов, подходящих миру и герою;',
        '- globalGoal — глобальная цель, выведенная из предыстории карточки, одним-двумя предложениями;',
        '- microGoal — стартовая микроцель на ближайшую сцену: конкретная, достижимая, тайная от второго героя.',
        '',
        'Ответь только JSON, без пояснений и без markdown, героев в том же порядке:',
        '{"heroes": [',
        `  {"name": "${names[0]}", "stats": {"STR": 10, "DEX": 10, "CON": 10, "INT": 10, "WIS": 10, "CHA": 10}, "hp": 10, "inventory": ["..."], "globalGoal": "...", "microGoal": "..."},`,
        `  {"name": "${names[1]}", ...}`,
        ']}',
        '',
        '### МИР',
        formatWorldShort(world),
        '',
        ...cards.flatMap((card, index) => [
            `### ГЕРОЙ ${index + 1}: ${card.name}`,
            formatCardShort(card, names[1 - index]),
            '',
        ]),
    ];
    return [
        { role: 'system', content: system.join('\n') },
        { role: 'user', content: `Составь листы героев ${names[0]} и ${names[1]}.` },
    ];
}

/**
 * Разбирает листы двух героев. Герои сопоставляются по имени, иначе по порядку.
 * @param {string} raw
 * @param {string[]} names имена героя 1 и героя 2
 * @returns {Array<{stats: Record<string, number>, hp: number, inventory: string[], globalGoal: string, microGoal: string}>}
 * @throws {ParseError}
 */
export function parseHeroSheets(raw, names) {
    const json = extractJson(raw);
    const list = Array.isArray(json) ? json : pickValue(json ?? {}, ['heroes', 'герои', 'characters']);
    if (!Array.isArray(list) || list.length < 2) throw new ParseError('Мастер прислал не список из двух героев', raw);

    const byName = (name) => list.find((item) => typeof item?.name === 'string' && item.name.trim().toLowerCase() === name.trim().toLowerCase());
    const ordered = names.map((name, index) => byName(name) ?? list[index]);

    return ordered.map((item, index) => {
        try {
            return normalizeSheet(item);
        } catch (error) {
            throw new ParseError(`Лист героя ${names[index]}: ${error.message}`, raw);
        }
    });
}

function normalizeSheet(item) {
    if (!item || typeof item !== 'object') throw new Error('нет данных');
    const rawStats = pickValue(item, ['stats', 'abilities', 'статы']) ?? item;
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
        inventory: [],
        globalGoal: '',
        microGoal: '',
    };
}

/**
 * Герой для состояния игры из карточки ST и листа.
 * @param {{avatar: string, name: string}} card
 * @param {ReturnType<typeof blankSheet>} sheet
 */
export function createHero(card, sheet) {
    return {
        cardAvatar: card.avatar,
        name: card.name,
        stats: { ...sheet.stats },
        hp: { current: sheet.hp, max: sheet.hp },
        inventory: [...sheet.inventory],
        globalGoal: sheet.globalGoal,
        microGoal: sheet.microGoal,
        silence: 0,
    };
}

/** Что не так с готовностью к старту; пустой список — можно стартовать (FR-03, FR-05). */
export function startProblems({ world, heroes, selected }) {
    const problems = [];
    if (!world?.setting) problems.push('нет карточки мира');
    if (selected.length !== 2) problems.push(`выбрано карточек: ${selected.length} из 2`);
    else if (heroes.length !== 2 || heroes.some((hero, index) => hero.cardAvatar !== selected[index])) problems.push('листы героев не сгенерированы для выбранных карточек');
    else {
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
