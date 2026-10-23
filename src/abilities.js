// Уникальные способности героев (новое, PLAN 6.4, FR-31): «Огненный шар», «Гигантификация», «Теневой шаг».
// Мастер придумывает их на старте по карточке, пользователь правит. Чем чаще герой применяет способность,
// тем выше её уровень: сильнее эффект в описании мастера и больше бонус к броску.
// Модуль без зависимостей от ST, проверяется тестом в Node.

import { STATS, normalizeStat } from './dice.js';

export const ABILITY_MAX_LEVEL = 5;
// Сколько всего применений нужно, чтобы достичь уровня: индекс 0 — уровень 1, индекс 4 — уровень 5.
export const LEVEL_AT = [0, 3, 7, 12, 18];
export const ABILITIES_MAX = 3;

/**
 * @typedef {object} Ability
 * @property {string} name
 * @property {string} description что делает и как растёт
 * @property {string} stat характеристика, от которой бросок
 * @property {number} level 1–5
 * @property {number} uses сколько раз применена
 */

/** Уровень, которого достигает способность за uses применений. */
export function levelForUses(uses) {
    let level = 1;
    LEVEL_AT.forEach((needed, index) => {
        if (uses >= needed) level = index + 1;
    });
    return level;
}

/** Применений до следующего уровня или null на максимуме. */
export function usesToNext(ability) {
    if (ability.level >= ABILITY_MAX_LEVEL) return null;
    return Math.max(LEVEL_AT[ability.level], ability.uses + 1);
}

/** «ур. 2 · 5/7» или «ур. 5, максимум». */
export function progressText(ability) {
    const next = usesToNext(ability);
    return next === null ? `ур. ${ability.level}, максимум` : `ур. ${ability.level} · ${ability.uses}/${next}`;
}

/**
 * Способность из ответа модели или формы: имя обязательно, остальное с разумными значениями по умолчанию.
 * @returns {Ability|null}
 */
export function normalizeAbility(raw) {
    if (typeof raw === 'string') raw = { name: raw };
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name ?? raw.title ?? raw.название ?? '').trim();
    if (!name) return null;
    const uses = Math.max(0, toInt(raw.uses ?? raw.применений, 0));
    const level = clamp(toInt(raw.level ?? raw.уровень, 1), 1, ABILITY_MAX_LEVEL);
    return {
        name,
        description: String(raw.description ?? raw.описание ?? '').trim(),
        stat: normalizeStat(raw.stat ?? raw.ability ?? raw.характеристика ?? '') ?? 'INT',
        level: Math.max(level, levelForUses(uses)),
        uses,
    };
}

export function normalizeAbilityList(value) {
    const list = Array.isArray(value) ? value : [];
    const seen = new Set();
    return list.map(normalizeAbility).filter((ability) => {
        if (!ability || seen.has(ability.name.toLowerCase())) return false;
        seen.add(ability.name.toLowerCase());
        return true;
    }).slice(0, ABILITIES_MAX);
}

/**
 * Ищет способность героя по названию из ответа мастера: сначала точное совпадение, потом вхождение.
 * @returns {Ability|null}
 */
export function findAbility(hero, name) {
    const wanted = squash(name);
    if (!wanted) return null;
    const list = hero?.abilities ?? [];
    return list.find((ability) => squash(ability.name) === wanted)
        ?? list.find((ability) => squash(ability.name).includes(wanted) || wanted.includes(squash(ability.name)))
        ?? null;
}

/**
 * Засчитывает применение: +1 к счётчику, при достижении порога — новый уровень.
 * @returns {{ability: Ability, leveledUp: boolean, line: string}}
 */
export function useAbility(hero, ability) {
    ability.uses += 1;
    const before = ability.level;
    ability.level = Math.min(ABILITY_MAX_LEVEL, Math.max(ability.level, levelForUses(ability.uses)));
    const leveledUp = ability.level > before;
    const line = leveledUp
        ? `${hero.name}: ✨ ${ability.name} — уровень ${ability.level}! (${progressText(ability)})`
        : `${hero.name}: ✨ ${ability.name} (${progressText(ability)})`;
    return { ability, leveledUp, line };
}

/** Строки листа героя для промптов. */
export function formatAbilities(hero) {
    const list = (hero.abilities ?? []).filter((ability) => ability.name?.trim());
    if (!list.length) return ['Уникальные способности: —'];
    return [
        `Уникальные способности (уровень 1–${ABILITY_MAX_LEVEL}, растут от применения; к проверке способности + уровень):`,
        ...list.map((ability) => `- ${ability.name} (${ability.stat}, ${progressText(ability)})${ability.description ? `: ${ability.description}` : ''}`),
    ];
}

export function blankAbility() {
    return { name: '', description: '', stat: STATS[3], level: 1, uses: 0 };
}

function squash(value) {
    return String(value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
}

function toInt(value, fallback) {
    const number = parseInt(value, 10);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
