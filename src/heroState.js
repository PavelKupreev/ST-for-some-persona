// Изменения состояния героев от мастера (FR-15): HP, статы, инвентарь.
// Мастер пишет отдельный JSON-блок с меткой, код применяет его к листам героев.
// Модуль без зависимостей от ST, проверяется тестом в Node.
//
// Формат: [STATE {"hero1": {"hp": -5, "stats": {"DEX": -1}, "add": ["ключ"], "remove": ["факел"], "use": ["Огненный шар"]}}]
// hp и stats — изменения (дельты), а не новые значения. use — применённые без броска способности (PLAN 6.4).
// Вместо hero1/hero2 можно имя героя.

import { STATS, normalizeStat } from './dice.js';
import { findAbility, useAbility } from './abilities.js';

const STAT_MIN = 1;
const STAT_MAX = 20;

// Начало блока: [STATE, [СОСТОЯНИЕ:, [CHANGES, [ИЗМЕНЕНИЯ — дальше JSON до парной скобки и закрывающая ].
const STATE_START = /\[\s*(?:STATE|СОСТОЯНИЕ|CHANGES|ИЗМЕНЕНИЯ)\s*[:=]?\s*(?=\{)/gi;
// Тот же JSON, но в блоке ```json ... ``` без метки.
const FENCED_JSON = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi;

/**
 * Достаёт блоки изменений из ответа мастера.
 * @param {string} text ответ мастера
 * @param {string[]} heroNames имена героя 1 и героя 2
 * @returns {{text: string, changes: Array<{hero: 'hero1'|'hero2', hp: number, stats: Record<string, number>, add: string[], remove: string[], use: string[]}>}}
 *   text — ответ без блоков; блок, который не удалось разобрать, тоже вырезается, чтобы JSON не попал в чат
 */
export function extractStateChanges(text, heroNames = []) {
    let source = String(text ?? '');
    const changes = [];
    const cuts = [];

    for (const match of source.matchAll(STATE_START)) {
        const jsonStart = match.index + match[0].length;
        const jsonEnd = matchingBrace(source, jsonStart);
        if (jsonEnd === -1) {
            cuts.push([match.index, source.length]);
            continue;
        }
        let end = jsonEnd + 1;
        const close = source.slice(end).match(/^\s*\]/);
        if (close) end += close[0].length;
        // Блок на отдельной строке убираем вместе с переводом строки.
        if (source[end] === '\n' && (match.index === 0 || source[match.index - 1] === '\n')) end++;
        cuts.push([match.index, end]);
        changes.push(...normalizeChanges(parseJson(source.slice(jsonStart, jsonEnd + 1)), heroNames));
    }
    for (const [start, end] of cuts.reverse()) source = source.slice(0, start) + source.slice(end);

    source = source.replace(FENCED_JSON, (whole, body) => {
        const found = normalizeChanges(parseJson(body), heroNames);
        if (!found.length) return whole;
        changes.push(...found);
        return '';
    });

    return { text: source.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), changes: mergeChanges(changes) };
}

/**
 * Применяет изменения к героям и возвращает строки для чата и истории: «Арен: HP 12 → 7 (−5)».
 * HP держится в 0…максимум, статы в 1–20. Убрать можно только то, что есть в инвентаре.
 * @param {object[]} heroes state.heroes
 * @param {ReturnType<typeof extractStateChanges>['changes']} changes
 * @param {object} [options]
 * @param {string[]} [options.skipUses] «hero1:Огненный шар» — способности, уже засчитанные броском в этом ходе
 * @returns {string[]}
 */
export function applyStateChanges(heroes, changes, { skipUses = [] } = {}) {
    const lines = [];
    for (const change of changes) {
        const hero = heroes[change.hero === 'hero2' ? 1 : 0];
        if (!hero) continue;
        const parts = [];
        const abilityLines = [];

        if (change.hp) {
            const before = hero.hp.current;
            hero.hp.current = Math.max(0, Math.min(hero.hp.max, before + change.hp));
            if (hero.hp.current !== before) {
                parts.push(`HP ${before} → ${hero.hp.current} (${signed(hero.hp.current - before)})${hero.hp.current === 0 ? ', без сознания' : ''}`);
            }
        }

        for (const [stat, delta] of Object.entries(change.stats)) {
            const before = hero.stats[stat] ?? 10;
            hero.stats[stat] = Math.max(STAT_MIN, Math.min(STAT_MAX, before + delta));
            if (hero.stats[stat] !== before) parts.push(`${stat} ${before} → ${hero.stats[stat]}`);
        }

        hero.inventory ??= [];
        for (const item of change.remove) {
            const index = findItem(hero.inventory, item);
            if (index === -1) continue;
            parts.push(`− ${hero.inventory[index]}`);
            hero.inventory.splice(index, 1);
        }
        for (const item of change.add) {
            hero.inventory.push(item);
            parts.push(`+ ${item}`);
        }

        // Одна способность за блок засчитывается один раз; уже прокачанная броском — не засчитывается.
        const used = new Set();
        for (const name of change.use ?? []) {
            const ability = findAbility(hero, name);
            if (!ability || used.has(ability) || skipUses.includes(`${change.hero}:${ability.name}`)) continue;
            used.add(ability);
            abilityLines.push(useAbility(hero, ability).line);
        }

        if (parts.length) lines.push(`${hero.name}: ${parts.join(', ')}`);
        lines.push(...abilityLines);
    }
    return lines;
}

function normalizeChanges(json, heroNames) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return [];
    // Допускаем обёртку {"changes": {...}} или {"heroes": {...}}.
    const inner = json.changes ?? json.heroes ?? json.изменения;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return normalizeChanges(inner, heroNames);

    const result = [];
    for (const [key, value] of Object.entries(json)) {
        const hero = heroId(key, heroNames);
        if (!hero || !value || typeof value !== 'object') continue;
        const change = { hero, hp: 0, stats: {}, add: [], remove: [], use: [] };
        for (const [field, raw] of Object.entries(value)) {
            const name = field.toLowerCase();
            if (['hp', 'хиты', 'хп', 'damage', 'урон', 'heal', 'лечение'].includes(name)) {
                let delta = toInt(raw);
                // «урон: 5» — это минус 5, даже если знак не поставлен.
                if (['damage', 'урон'].includes(name)) delta = -Math.abs(delta);
                if (['heal', 'лечение'].includes(name)) delta = Math.abs(delta);
                change.hp += delta;
            } else if (['stats', 'статы', 'abilities'].includes(name) && raw && typeof raw === 'object') {
                for (const [stat, delta] of Object.entries(raw)) {
                    const id = normalizeStat(stat);
                    if (id && toInt(delta)) change.stats[id] = (change.stats[id] ?? 0) + toInt(delta);
                }
            } else if (normalizeStat(field) && STATS.includes(normalizeStat(field))) {
                const id = normalizeStat(field);
                if (toInt(raw)) change.stats[id] = (change.stats[id] ?? 0) + toInt(raw);
            } else if (['add', 'gain', 'получил', 'добавить', 'items_add'].includes(name)) {
                change.add.push(...toList(raw));
            } else if (['remove', 'lose', 'lost', 'потерял', 'убрать', 'items_remove'].includes(name)) {
                change.remove.push(...toList(raw));
            } else if (['use', 'used', 'ability', 'abilities', 'способность', 'способности', 'применил'].includes(name)) {
                change.use.push(...toList(raw));
            } else if (['inventory', 'инвентарь'].includes(name) && raw && typeof raw === 'object' && !Array.isArray(raw)) {
                change.add.push(...toList(raw.add ?? raw.добавить));
                change.remove.push(...toList(raw.remove ?? raw.убрать));
            }
        }
        if (change.hp || Object.keys(change.stats).length || change.add.length || change.remove.length || change.use.length) result.push(change);
    }
    return result;
}

function mergeChanges(changes) {
    const byHero = new Map();
    for (const change of changes) {
        const target = byHero.get(change.hero);
        if (!target) {
            byHero.set(change.hero, change);
            continue;
        }
        target.hp += change.hp;
        for (const [stat, delta] of Object.entries(change.stats)) target.stats[stat] = (target.stats[stat] ?? 0) + delta;
        target.add.push(...change.add);
        target.remove.push(...change.remove);
        target.use.push(...change.use);
    }
    return [...byHero.values()];
}

function heroId(key, heroNames) {
    const v = String(key).toLowerCase().trim();
    if (/^(?:hero\s*1|герой\s*1)$/.test(v)) return 'hero1';
    if (/^(?:hero\s*2|герой\s*2)$/.test(v)) return 'hero2';
    const index = heroNames.findIndex((name) => name && name.toLowerCase() === v);
    return index === 0 ? 'hero1' : index === 1 ? 'hero2' : null;
}

// Индекс парной закрывающей скобки для { в позиции start, с учётом строк JSON.
function matchingBrace(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (char === '\\') i++;
            else if (char === '"') inString = false;
        } else if (char === '"') {
            inString = true;
        } else if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function parseJson(body) {
    for (const candidate of [body, body.replace(/,\s*([}\]])/g, '$1')]) {
        try {
            return JSON.parse(candidate);
        } catch {
            // пробуем следующий вариант
        }
    }
    return null;
}

function findItem(inventory, item) {
    const wanted = item.toLowerCase();
    const exact = inventory.findIndex((own) => own.toLowerCase() === wanted);
    if (exact !== -1) return exact;
    return inventory.findIndex((own) => own.toLowerCase().includes(wanted) || wanted.includes(own.toLowerCase()));
}

function toInt(value) {
    const number = parseInt(String(value).replace(/[−–—]/g, '-'), 10);
    return Number.isFinite(number) ? number : 0;
}

function toList(value) {
    const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n]/) : [];
    return items.map((item) => String(item).trim()).filter(Boolean);
}

function signed(number) {
    return number > 0 ? `+${number}` : `−${Math.abs(number)}`;
}
