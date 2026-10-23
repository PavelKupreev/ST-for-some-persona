// Состояние игры в метаданных текущего чата (FR-30).
// chatMetadata в ST заменяется целиком при смене чата, поэтому ссылку берём из getContext() при каждом обращении.

import { EXTENSION_KEY, LOG_PREFIX, STATE_VERSION } from './constants.js';

// Поля, которым не место в метаданных чата ни при каких условиях (NFR-04).
const FORBIDDEN_KEYS = ['openrouterKey', 'apiKey', 'api_key'];

export function createEmptyState() {
    return {
        version: STATE_VERSION,
        world: null,
        heroes: [],
        setup: {
            worldPrompt: '', // черновик промпта мира до «Расширить» (FR-01)
            selected: [], // аватары выбранных карточек ST по порядку: герой 1, герой 2 (FR-03)
        },
        scene: {
            premise: '',
        },
        turns: [],
        memory: null,
        chronicle: [],
        session: {
            status: 'idle', // idle / running / paused / stopped
            reason: '', // почему сессия на паузе или остановлена (UC-05, FR-22)
            turnsLeft: 0, // сколько ходов осталось до лимита (FR-20)
            masterNote: '',
            next: 'master', // кто ходит следующим: master / hero1 / hero2
            pendingOutcome: false, // броски сделаны, описание исхода ещё не получено
            rolledAbilities: [], // способности, прокачанные бросками этого хода: «hero1:Огненный шар» (PLAN 6.4)
        },
        debug: {
            counter: 0,
        },
    };
}

export function hasOpenChat() {
    const context = SillyTavern.getContext();
    return Boolean(context.getCurrentChatId());
}

/**
 * Возвращает состояние игры текущего чата, создавая пустое при первом обращении.
 * @returns {ReturnType<typeof createEmptyState> | null} null, если чат не открыт
 */
export function getState() {
    if (!hasOpenChat()) return null;
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[EXTENSION_KEY]) {
        chatMetadata[EXTENSION_KEY] = createEmptyState();
    }
    const state = fillMissing(chatMetadata[EXTENSION_KEY], createEmptyState());
    // Чат с героями из версии до этапа 3: выбор карточек восстанавливаем по героям.
    if (!state.setup.selected.length && state.heroes.length) state.setup.selected = state.heroes.map((hero) => hero.cardAvatar);
    return state;
}

/** Сохраняет метаданные чата на диск (ST пишет их вместе с файлом чата). */
export async function saveState() {
    const state = getState();
    if (!state) return;
    stripSecrets(state);
    await SillyTavern.getContext().saveMetadata();
}

// Состояние, сохранённое старой версией расширения, досыпаем новыми полями.
function fillMissing(target, defaults) {
    for (const [key, value] of Object.entries(defaults)) {
        if (target[key] === undefined) {
            target[key] = value;
        } else if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
            fillMissing(target[key], value);
        }
    }
    return target;
}

function stripSecrets(value) {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEYS.includes(key)) {
            console.warn(`${LOG_PREFIX} удалено поле «${key}» из состояния чата: секретам там не место`);
            delete value[key];
        } else {
            stripSecrets(value[key]);
        }
    }
}
