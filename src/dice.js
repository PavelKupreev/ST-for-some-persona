// Кубики 5e (FR-13, FR-14). Бросает код, не модель.
// Модуль без зависимостей от ST, чтобы его можно было проверить тестом в Node.

export const STATS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

// Русские сокращения, которые модель может написать вместо английских.
const STAT_ALIASES = {
    STR: 'STR', СИЛ: 'STR', СИЛА: 'STR',
    DEX: 'DEX', ЛОВ: 'DEX', ЛОВКОСТЬ: 'DEX',
    CON: 'CON', ТЕЛ: 'CON', ТЕЛОСЛОЖЕНИЕ: 'CON',
    INT: 'INT', ИНТ: 'INT', ИНТЕЛЛЕКТ: 'INT',
    WIS: 'WIS', МДР: 'WIS', МУД: 'WIS', МУДРОСТЬ: 'WIS',
    CHA: 'CHA', ХАР: 'CHA', ХАРИЗМА: 'CHA',
};

// [ROLL d20 DEX DC12], [ROLL: d20 DEX DC 12 hero2], [roll d20 ЛОВ DC12 Арен]
const ROLL_TAG = /\[\s*ROLL\s*:?\s*d(\d+)\s+([A-Za-zА-Яа-яЁё]+)\s+DC\s*(\d+)\s*([^\]]*)\]/gi;

/** Модификатор характеристики 5e: floor((значение − 10) / 2). */
export function abilityModifier(score) {
    return Math.floor((Number(score) - 10) / 2);
}

export function normalizeStat(raw) {
    return STAT_ALIASES[String(raw).toUpperCase()] ?? null;
}

/**
 * Находит все метки броска в тексте мастера.
 * @param {string} text
 * @returns {Array<{raw: string, sides: number, stat: string, dc: number, target: string}>}
 *   target — необязательный хвост метки (hero1 / hero2 / имя героя), пустая строка если не указан
 */
export function parseRollTags(text) {
    const rolls = [];
    for (const match of String(text).matchAll(ROLL_TAG)) {
        const stat = normalizeStat(match[2]);
        if (!stat) continue;
        rolls.push({
            raw: match[0],
            sides: Number(match[1]),
            stat,
            dc: Number(match[3]),
            target: match[4].trim(),
        });
    }
    return rolls;
}

/** Убирает метки броска из текста, который увидит пользователь. */
export function stripRollTags(text) {
    return String(text).replace(ROLL_TAG, '').replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Честный бросок кубика на crypto.getRandomValues, без перекоса по модулю.
 * @param {number} sides
 * @param {(array: Uint32Array) => Uint32Array} [random] подмена генератора для тестов
 */
export function rollDie(sides, random = (array) => crypto.getRandomValues(array)) {
    if (!Number.isInteger(sides) || sides < 2) throw new Error(`Неверный кубик: d${sides}`);
    const range = 2 ** 32;
    const limit = range - (range % sides);
    const buffer = new Uint32Array(1);
    for (;;) {
        random(buffer);
        if (buffer[0] < limit) return (buffer[0] % sides) + 1;
    }
}

/**
 * Проверка характеристики 5e.
 * Натуральная 1 на d20 — провал при любом модификаторе, натуральная 20 — критический успех.
 * @param {object} params
 * @param {number} params.natural выпавшее на кубике
 * @param {number} params.sides
 * @param {number} params.score значение характеристики героя
 * @param {number} params.dc сложность
 */
export function resolveCheck({ natural, sides, score, dc }) {
    const modifier = abilityModifier(score);
    const total = natural + modifier;
    const fumble = sides === 20 && natural === 1;
    const critical = sides === 20 && natural === 20;
    const success = fumble ? false : critical ? true : total >= dc;
    return { natural, sides, modifier, total, dc, success, critical, fumble };
}

/** Текст плашки: «🎲 Арен, DEX: d20+2 = 15 vs DC 12 ✅». */
export function formatRoll(result, { heroName = '', stat = '' } = {}) {
    const sign = result.modifier >= 0 ? '+' : '-';
    const who = [heroName, stat].filter(Boolean).join(', ');
    let line = `🎲 ${who ? `${who}: ` : ''}d${result.sides}${sign}${Math.abs(result.modifier)} = ${result.total} vs DC ${result.dc} ${result.success ? '✅' : '❌'}`;
    if (result.critical) line += ' (натуральная 20, критический успех)';
    if (result.fumble) line += ' (натуральная 1, провал)';
    return line;
}
