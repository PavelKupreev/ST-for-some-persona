// Режимы игры (новое, этап 12, FR-33): «Без мастера», «Приключение», «Романтика 18+».
// Модуль без зависимостей от ST, проверяется тестом в Node.

import { MAX_HEROES } from './heroes.js';

export const MODES = ['free', 'adventure', 'romance'];

// Чаты прошлых версий: RPG (этапы 1–9) и простой диалог (этап 10).
const LEGACY_MODES = { rpg: 'adventure', dialogue: 'free' };

export const MODE_TITLES = {
    free: 'Без мастера',
    adventure: 'Приключение',
    romance: 'Романтика 18+',
};

/** Режим чата; старые значения переводятся, неизвестное — «Приключение». */
export function gameMode(state) {
    const mode = state?.mode;
    if (MODES.includes(mode)) return mode;
    return LEGACY_MODES[mode] ?? 'adventure';
}

/** Есть мастер: «Приключение» и «Романтика». В «Без мастера» персонажи говорят сами по очереди. */
export function hasMaster(state) {
    return gameMode(state) !== 'free';
}

/** Кубики, HP, способности и смерть — только в «Приключении». */
export function usesDice(state) {
    return gameMode(state) === 'adventure';
}

export function isRomance(state) {
    return gameMode(state) === 'romance';
}

/** Сколько персонажей можно выбрать: без мастера разговаривать должны хотя бы двое. */
export function heroCountRange(state) {
    return { min: hasMaster(state) ? 1 : 2, max: MAX_HEROES };
}

/** Число персонажей из настройки старта, приведённое к допустимому для режима. */
export function heroCount(state) {
    const { min, max } = heroCountRange(state);
    const count = Number.parseInt(state?.setup?.count, 10);
    return Math.min(max, Math.max(min, Number.isFinite(count) ? count : 2));
}

// Правило взрослого контента (FR-37): одно на все промпты «Романтики».
export const ADULT_RULE = 'Это история для взрослых. Все персонажи — совершеннолетние (18+). Романтика и откровенные сцены допустимы, когда к ним ведут чувства и обоюдное согласие персонажей: пиши их прямо, без цензуры и без морализаторства, но со вкусом.';

/**
 * Модели мастера и героев для режима (FR-29): в «Романтике» — свои, если заданы в настройках (многие модели
 * отказываются писать откровенные сцены), иначе обычные.
 * @param {{masterModel: string, heroModel: string, romanceMasterModel?: string, romanceHeroModel?: string}} settings
 * @param {object} state
 * @returns {{master: string, hero: string}}
 */
export function modelsFor(settings, state) {
    if (!isRomance(state)) return { master: settings.masterModel, hero: settings.heroModel };
    return {
        master: settings.romanceMasterModel?.trim() || settings.masterModel,
        hero: settings.romanceHeroModel?.trim() || settings.heroModel,
    };
}
