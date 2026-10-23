// Логгер промптов (NFR-03): при включённом переключателе печатает полный запрос в консоль браузера.

import { LOG_PREFIX } from './constants.js';
import { getSettings } from './settings.js';

let requestCounter = 0;

/**
 * @param {object} info
 * @param {string} info.role кто вызывает модель: master / hero1 / hero2 / historian / test
 * @param {string} info.model id модели OpenRouter
 * @param {string} info.transport backend / direct
 * @param {Array<{role: string, content: string}>} info.messages
 * @returns {number} номер запроса, чтобы связать его с ответом
 */
export function logPrompt({ role, model, transport, messages }) {
    const id = ++requestCounter;
    if (!getSettings().logPrompts) return id;

    console.groupCollapsed(`${LOG_PREFIX} запрос #${id} → ${role} (${model}, ${transport})`);
    for (const message of messages) {
        console.log(`--- ${message.role} ---\n${message.content}`);
    }
    console.groupEnd();
    return id;
}

export function logResponse(id, role, text) {
    if (!getSettings().logPrompts) return;
    console.groupCollapsed(`${LOG_PREFIX} ответ #${id} ← ${role}`);
    console.log(text);
    console.groupEnd();
}

export function logError(id, role, error) {
    // Ошибки печатаем всегда, независимо от переключателя.
    console.error(`${LOG_PREFIX} ошибка запроса #${id} (${role}):`, error);
}
