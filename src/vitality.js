// Герой при HP 0 и игровое время (новое, PLAN 8.5, FR-32).
// Настройка «При HP 0»: death — герой погибает и больше не ходит; knockout — жёсткая отключка
// минимум на игровые сутки: герой не ходит, пока по игровым часам не пройдёт KNOCKOUT_HOURS.
// Время двигает мастер: в блоке [STATE {"time": 8}] он пишет, сколько игровых часов прошло.
// Модуль без зависимостей от ST, проверяется тестом в Node.

import { isFrozen } from './heroes.js';

export const DEATH_MODES = ['knockout', 'death'];
export const KNOCKOUT_HOURS = 24;
// Больше за один блок не промотать: модель иногда путает часы с минутами.
const MAX_HOURS_PER_BLOCK = 24 * 30;

/** Игровые часы с начала сцены; в чатах до этапа 8 их нет. */
export function getClock(state) {
    state.clock ??= { hours: 0 };
    return state.clock;
}

/** Состояние героя: ok — в строю, down — без сознания, dead — погиб. */
export function heroCondition(hero) {
    return hero?.condition ?? 'ok';
}

/** Может ли герой ходить: в строю и не ушёл из сцены (FR-35). */
export function isActive(hero) {
    return heroCondition(hero) === 'ok' && !isFrozen(hero);
}

/** Может ли ходить каждый герой, по порядку. */
export function activeHeroes(state) {
    return state.heroes.map((hero) => isActive(hero));
}

/**
 * Сколько игровых часов прошло по блоку STATE: число — часы, строка «8», «8 ч», «2 дня», «1d».
 * @returns {number} 0, если времени нет или оно непонятное
 */
export function parseHours(raw) {
    if (raw === undefined || raw === null) return 0;
    if (typeof raw === 'object') return parseHours(raw.hours ?? raw.часы ?? 0) + 24 * parseHours(raw.days ?? raw.дни ?? 0);
    const text = String(raw).trim().toLowerCase().replace(',', '.');
    const match = text.match(/^\+?(\d+(?:\.\d+)?)\s*([a-zа-яё.]*)$/);
    if (!match) return 0;
    const value = Number(match[1]);
    const unit = match[2];
    const hours = /^(d|day|days|д|дн|дня|дней|день|сут|сутки|суток)/.test(unit) ? value * 24
        : /^(m|min|мин)/.test(unit) ? value / 60
            : value;
    return Math.min(MAX_HOURS_PER_BLOCK, Math.max(0, Math.round(hours * 10) / 10));
}

const COUNT_WORDS = { один: 1, одна: 1, одни: 1, a: 1, an: 1, one: 1, два: 2, две: 2, двое: 2, пару: 2, пара: 2, two: 2, три: 3, трое: 3, three: 3, несколько: 3, several: 3 };
const UNIT_HOURS = [
    [/^(?:сут|дн|день|day)/, 24],
    [/^(?:ноч|night)/, 12],
    [/^(?:недел|week)/, 168],
    [/^(?:час|hour)/, 1],
];
// «спустя сутки», «через два дня», «прошло три часа», «минула ночь», «two days later», «hours pass».
const TIME_PHRASES = [
    /(?:[сs][пp]устя|через|прошл[оаи]?|прош[её]л|минул[оаи]?|миновал[оаи]?)\s+(?:(\d+|[а-яё]+)\s+)?(сут(?:ки|ок)|дн(?:я|ей)|день|ноч(?:ь|и|ей)|час(?:а|ов)?|недел[яиюь])/gi,
    /(\d+|a|an|one|two|three|several)\s+(hours?|days?|nights?|weeks?)\s+(?:later|pass(?:ed|es)?|went by)/gi,
];

/**
 * Запасной путь (приёмка, PLAN 8.5): мастер пишет «спустя сутки» в тексте, но забывает "time" в STATE.
 * Берём самый длинный найденный промежуток, чтобы «спустя сутки… прошли сутки» не дало двое суток.
 * @returns {number} часы, 0 — время в тексте не названо
 */
export function hoursFromText(text) {
    let best = 0;
    for (const pattern of TIME_PHRASES) {
        for (const match of String(text ?? '').matchAll(pattern)) {
            const word = match[1]?.toLowerCase();
            const count = !word ? 1 : /^\d+$/.test(word) ? Number(word) : COUNT_WORDS[word];
            if (!count) continue;
            const unit = match[2].toLowerCase();
            const hours = UNIT_HOURS.find(([test]) => test.test(unit))?.[1] ?? 0;
            best = Math.max(best, Math.min(MAX_HOURS_PER_BLOCK, count * hours));
        }
    }
    return best;
}

/** «день 2, 14 ч» по игровым часам. */
export function formatClock(hours) {
    const day = Math.floor(hours / 24) + 1;
    const hour = Math.round((hours % 24) * 10) / 10;
    return `день ${day}, ${hour} ч с начала сцены`;
}

/**
 * После изменений хода: двигает игровое время, отключает или убивает героев с HP 0, будит тех, чьи сутки прошли.
 * @param {object} state
 * @param {object} params
 * @param {number} params.hours сколько игровых часов прошло в этом ходе
 * @param {'knockout'|'death'} params.mode настройка «При HP 0»
 * @returns {string[]} строки для чата и истории
 */
export function applyVitality(state, { hours = 0, mode = 'knockout' }) {
    const clock = getClock(state);
    const lines = [];
    if (hours > 0) {
        clock.hours = Math.round((clock.hours + hours) * 10) / 10;
        lines.push(`⏳ Прошло ${hours} ч игрового времени (${formatClock(clock.hours)})`);
    }

    for (const hero of state.heroes) {
        const condition = heroCondition(hero);
        if (condition === 'dead') {
            hero.hp.current = 0;
            continue;
        }
        if (condition === 'ok' && hero.hp.current <= 0) {
            if (mode === 'death') {
                hero.condition = 'dead';
                lines.push(`💀 ${hero.name} погибает и больше не участвует в игре`);
            } else {
                hero.condition = 'down';
                hero.downUntil = clock.hours + KNOCKOUT_HOURS;
                lines.push(`💤 ${hero.name} без сознания: не действует минимум ${KNOCKOUT_HOURS} ч игрового времени`);
            }
            continue;
        }
        if (condition === 'down' && clock.hours >= (hero.downUntil ?? 0)) {
            hero.condition = 'ok';
            delete hero.downUntil;
            hero.hp.current = Math.max(1, hero.hp.current);
            lines.push(`🌅 ${hero.name} приходит в себя (HP ${hero.hp.current}/${hero.hp.max})`);
        }
    }
    return lines;
}

/** Строка состояния героя для промпта мастера и панели. */
export function conditionText(hero, clockHours = 0) {
    const condition = heroCondition(hero);
    if (isFrozen(hero) && condition === 'ok') return 'ушёл из сцены, не действует, пока его не вернут';
    if (condition === 'dead') return 'погиб, больше не действует';
    if (condition === 'down') {
        const left = Math.max(0, Math.round(((hero.downUntil ?? 0) - clockHours) * 10) / 10);
        return `без сознания, не действует ещё ${left} ч игрового времени`;
    }
    return 'в строю';
}

/** Новая сцена: все в строю, часы с нуля. */
export function resetVitality(state) {
    state.clock = { hours: 0 };
    for (const hero of state.heroes) {
        delete hero.condition;
        delete hero.downUntil;
    }
}
