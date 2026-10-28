// Герои по номерам и группы (новое, этапы 11 и 13, FR-03, FR-34, FR-35).
// Модуль без зависимостей от ST, проверяется тестом в Node.
//
// Герой N — `heroN` (hero1…hero10), номер — место в state.heroes. Так хранятся автор хода, очередь и ключи памяти,
// поэтому чаты на двух героях из прошлых версий читаются без переделки.
//
// Группа — отдельная сцена (A–E): герой видит только ходы своей группы. hero.group — текущая группа,
// null — герой ушёл из сцены и заморожен. hero.presence — где и когда он был: [{group, from, to}],
// он видит ходы группы с номерами from < n ≤ to (to = null — до сих пор). Нет presence — всю сцену в своей группе.

export const MAX_HEROES = 10;
export const GROUPS = ['A', 'B', 'C', 'D', 'E'];
export const DEFAULT_GROUP = 'A';

export function heroId(index) {
    return `hero${index + 1}`;
}

/** Номер героя в state.heroes по id `heroN`; -1 — это не герой (мастер, система). */
export function heroIndex(id) {
    const match = /^hero(\d+)$/.exec(String(id ?? ''));
    return match ? Number(match[1]) - 1 : -1;
}

export function isHeroId(id) {
    return heroIndex(id) >= 0;
}

/** Герой по id или undefined. */
export function heroById(state, id) {
    const index = heroIndex(id);
    return index === -1 ? undefined : state.heroes[index];
}

/**
 * Ссылка на героя в ответе модели: «hero3», «Hero 3», «герой 3» или имя.
 * @param {string} value
 * @param {string[]} heroNames имена героев по порядку
 * @param {object} [options]
 * @param {boolean} [options.exact] имя должно совпасть целиком (ключ JSON), иначе достаточно вхождения ([NEXT: идёт Арен])
 * @returns {string|null} `heroN` или null
 */
export function resolveHero(value, heroNames = [], { exact = false } = {}) {
    const v = String(value ?? '').toLowerCase().replace(/[*_`"«»]/g, '').trim();
    if (!v) return null;
    const limit = heroNames.length || MAX_HEROES;
    const numbered = v.match(exact ? /^(?:hero|герой|героиня)\s*[#№]?\s*(\d+)$/ : /(?:hero|герой|героиня)\s*[#№]?\s*(\d+)/);
    if (numbered) {
        const index = Number(numbered[1]) - 1;
        return index >= 0 && index < limit ? heroId(index) : null;
    }
    // Самое длинное подходящее имя: «Мира» не должна перебить «Мирабель».
    let best = -1;
    heroNames.forEach((name, index) => {
        const lower = String(name ?? '').toLowerCase().trim();
        if (!lower) return;
        const found = exact ? v === lower : v.includes(lower);
        if (found && (best === -1 || lower.length > heroNames[best].length)) best = index;
    });
    return best === -1 ? null : heroId(best);
}

// ---------- Группы ----------

// Кириллица, похожая на латиницу, и номера групп: модель пишет «группа В» и «group 2».
const GROUP_ALIASES = { А: 'A', Б: 'B', В: 'B', С: 'C', Д: 'D', Е: 'E', 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' };

/** «b», «Группа В», «2» → B; непонятное → null. */
export function normalizeGroup(value) {
    const v = String(value ?? '').trim().replace(/^(?:группа|group)\s*/i, '').toUpperCase();
    if (GROUPS.includes(v)) return v;
    return GROUP_ALIASES[v] ?? null;
}

/** Текущая группа героя; null — заморожен (ушёл из сцены). */
export function heroGroup(hero) {
    if (hero?.group === null) return null;
    return GROUPS.includes(hero?.group) ? hero.group : DEFAULT_GROUP;
}

export function isFrozen(hero) {
    return heroGroup(hero) === null;
}

/** Группа, в которой был сыгран ход; в чатах до этапа 13 — A. */
export function turnGroup(turn) {
    return GROUPS.includes(turn?.group) ? turn.group : DEFAULT_GROUP;
}

/** Группы, в которых сейчас есть незамороженные герои, по порядку A–E. */
export function liveGroups(state) {
    const used = new Set(state.heroes.map(heroGroup).filter(Boolean));
    return GROUPS.filter((group) => used.has(group));
}

/** Больше одной группы в игре: нужны метки групп в чате и истории мастера. */
export function hasManyGroups(state) {
    const used = new Set([
        ...state.heroes.map(heroGroup).filter(Boolean),
        ...state.heroes.map((hero) => hero.homeGroup).filter(Boolean),
        ...(state.turns ?? []).map(turnGroup),
    ]);
    return used.size > 1;
}

/** Номера героев группы (без замороженных). */
export function groupMembers(state, group) {
    return state.heroes.map((hero, index) => (heroGroup(hero) === group ? index : -1)).filter((index) => index !== -1);
}

/** Где был герой: по умолчанию — вся сцена в текущей группе. */
export function presence(hero) {
    if (hero?.presence?.length) return hero.presence;
    const group = heroGroup(hero);
    return group ? [{ group, from: 0, to: null }] : [];
}

/**
 * Переводит героя в другую группу или уводит из сцены (FR-35).
 * @param {object} hero
 * @param {string|null} group новая группа; null — ушёл из сцены (заморожен)
 * @param {number} at номер последнего хода, который герой ещё видит в старой группе
 * @returns {boolean} что-то изменилось
 */
export function moveHero(hero, group, at) {
    if (heroGroup(hero) === group) return false;
    const list = presence(hero).map((item) => ({ ...item }));
    for (const item of list) if (item.to === null) item.to = at;
    if (group) list.push({ group, from: at, to: null });
    hero.presence = list;
    hero.group = group;
    return true;
}

/** Новая сцена: герой в своей стартовой группе, с чистой историей пребывания. */
export function resetGroup(hero) {
    hero.group = GROUPS.includes(hero.homeGroup) ? hero.homeGroup : heroGroup(hero) ?? DEFAULT_GROUP;
    delete hero.presence;
}

/**
 * Видит ли герой ход (FR-12, FR-34): свои ходы — всегда, чужие — только ходы своей группы за время, пока он в ней был.
 * @param {object} hero
 * @param {string} id `heroN` этого героя
 * @param {{n: number, author: string, group?: string}} turn
 */
export function canSee(hero, id, turn) {
    if (turn.author === id) return true;
    const group = turnGroup(turn);
    return presence(hero).some((item) => item.group === group && turn.n > item.from && (item.to === null || turn.n <= item.to));
}

/** Группа, чью память видит герой: текущая, а у замороженного — последняя, где он был. */
export function memoryGroup(hero) {
    return heroGroup(hero) ?? presence(hero).at(-1)?.group ?? DEFAULT_GROUP;
}
