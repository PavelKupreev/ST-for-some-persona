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

// Навыки 5e (новое, PLAN 6.3): id → характеристика и русское название. Владение даёт бонус мастерства.
export const SKILLS = {
    ATHLETICS: { stat: 'STR', ru: 'Атлетика', en: 'Athletics' },
    ACROBATICS: { stat: 'DEX', ru: 'Акробатика', en: 'Acrobatics' },
    SLEIGHT: { stat: 'DEX', ru: 'Ловкость рук', en: 'Sleight of Hand' },
    STEALTH: { stat: 'DEX', ru: 'Скрытность', en: 'Stealth' },
    ARCANA: { stat: 'INT', ru: 'Магия', en: 'Arcana' },
    HISTORY: { stat: 'INT', ru: 'История', en: 'History' },
    INVESTIGATION: { stat: 'INT', ru: 'Анализ', en: 'Investigation' },
    NATURE: { stat: 'INT', ru: 'Природа', en: 'Nature' },
    RELIGION: { stat: 'INT', ru: 'Религия', en: 'Religion' },
    ANIMALS: { stat: 'WIS', ru: 'Уход за животными', en: 'Animal Handling' },
    INSIGHT: { stat: 'WIS', ru: 'Проницательность', en: 'Insight' },
    MEDICINE: { stat: 'WIS', ru: 'Медицина', en: 'Medicine' },
    PERCEPTION: { stat: 'WIS', ru: 'Восприятие', en: 'Perception' },
    SURVIVAL: { stat: 'WIS', ru: 'Выживание', en: 'Survival' },
    DECEPTION: { stat: 'CHA', ru: 'Обман', en: 'Deception' },
    INTIMIDATION: { stat: 'CHA', ru: 'Запугивание', en: 'Intimidation' },
    PERFORMANCE: { stat: 'CHA', ru: 'Выступление', en: 'Performance' },
    PERSUASION: { stat: 'CHA', ru: 'Убеждение', en: 'Persuasion' },
};
export const SKILL_IDS = Object.keys(SKILLS);

// Бонус мастерства героя 1-го уровня в 5e.
export const PROFICIENCY_BONUS = 2;

const squash = (value) => String(value).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я]/g, '');
const SKILL_ALIASES = Object.fromEntries(SKILL_IDS.flatMap((id) => [
    [squash(id), id], [squash(SKILLS[id].ru), id], [squash(SKILLS[id].en), id],
]));
// Частые варианты, которые пишут модели.
Object.assign(SKILL_ALIASES, { sleightofhands: 'SLEIGHT', animalhandling: 'ANIMALS', внимательность: 'PERCEPTION', расследование: 'INVESTIGATION', аркана: 'ARCANA', магическиезнания: 'ARCANA', исполнение: 'PERFORMANCE', артистизм: 'PERFORMANCE', лечение: 'MEDICINE' });

/** «Скрытность», «stealth», «Sleight of Hand», «STEALTH» → id навыка или null. */
export function normalizeSkill(raw) {
    return SKILL_ALIASES[squash(raw)] ?? null;
}

/** Список навыков из ответа модели или поля формы: id без повторов, неизвестные отброшены. */
export function normalizeSkillList(value) {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n]/) : [];
    return [...new Set(items.map(normalizeSkill).filter(Boolean))];
}

// [ROLL d20 DEX DC12], [ROLL: d20 DEX DC 12 hero2], [roll d20 ЛОВ DC12 Арен], [ROLL d20 Ловкость рук DC14 hero1]
const ROLL_TAG = /\[\s*ROLL\s*:?\s*d(\d+)\s+([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё _-]*?)\s+DC\s*(\d+)\s*([^\]]*)\]/gi;

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
 * @returns {Array<{raw: string, sides: number, stat: string|null, skill: string|null, check: string, dc: number, target: string}>}
 *   check — что проверяется, как написал мастер; stat — характеристика или null, если это не стат и не навык
 *   (например, уникальная способность героя: её узнаёт game.js по листу героя);
 *   skill — id навыка, если вместо характеристики указан навык (stat тогда — его характеристика);
 *   target — необязательный хвост метки (hero1 / hero2 / имя героя), пустая строка если не указан
 */
export function parseRollTags(text) {
    const rolls = [];
    for (const match of String(text).matchAll(ROLL_TAG)) {
        const skill = normalizeStat(match[2]) ? null : normalizeSkill(match[2]);
        const stat = skill ? SKILLS[skill].stat : normalizeStat(match[2]);
        rolls.push({
            raw: match[0],
            sides: Number(match[1]),
            stat,
            skill,
            check: match[2].trim(),
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
 * @param {boolean} [params.proficient] герой владеет навыком проверки: + бонус мастерства (PLAN 6.3)
 * @param {number} [params.bonus] дополнительный бонус, например уровень уникальной способности (PLAN 6.4)
 */
export function resolveCheck({ natural, sides, score, dc, proficient = false, bonus = 0 }) {
    const modifier = abilityModifier(score) + (proficient ? PROFICIENCY_BONUS : 0) + bonus;
    const total = natural + modifier;
    const fumble = sides === 20 && natural === 1;
    const critical = sides === 20 && natural === 20;
    const success = fumble ? false : critical ? true : total >= dc;
    return { natural, sides, modifier, total, dc, success, critical, fumble, proficient };
}

/**
 * Текст плашки: «🎲 Арен, DEX: d20+2 = 15 vs DC 12 ✅», с навыком — «🎲 Арен, Скрытность (DEX, владение): d20+4 = …»,
 * со способностью — «🎲 Мира, Огненный шар (INT, ур. 2): d20+5 = …».
 */
export function formatRoll(result, { heroName = '', stat = '', skill = null, ability = null } = {}) {
    const sign = result.modifier >= 0 ? '+' : '-';
    const label = ability
        ? `${ability.name} (${stat}, ур. ${ability.level})`
        : skill && SKILLS[skill] ? `${SKILLS[skill].ru} (${stat || SKILLS[skill].stat}${result.proficient ? ', владение' : ''})` : stat;
    const who = [heroName, label].filter(Boolean).join(', ');
    let line = `🎲 ${who ? `${who}: ` : ''}d${result.sides}${sign}${Math.abs(result.modifier)} = ${result.total} vs DC ${result.dc} ${result.success ? '✅' : '❌'}`;
    if (result.critical) line += ' (натуральная 20, критический успех)';
    if (result.fumble) line += ' (натуральная 1, провал)';
    return line;
}
