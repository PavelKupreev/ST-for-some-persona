// Логгер промптов (NFR-03): при включённом переключателе печатает полный запрос в консоль браузера.
// Кроме консоли, все запросы и ответы вкладки копятся в памяти, их можно скачать файлом «💾 Лог промптов»
// (новое, PLAN 8.3): сохранение консоли теряет свёрнутые группы, а по файлу изоляцию проверяет скрипт.

import { LOG_PREFIX } from './constants.js';
import { getSettings } from './settings.js';

// Столько последних запросов держим в памяти: при ~10 КБ на запрос это до 10 МБ.
const BUFFER_LIMIT = 1000;

let requestCounter = 0;
/** @type {Array<{id: number, time: string, role: string, model: string, transport: string, messages: Array<{role: string, content: string}>, response?: string, error?: string}>} */
const buffer = [];

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
    buffer.push({ id, time: new Date().toISOString(), role, model, transport, messages: messages.map(({ role: from, content }) => ({ role: from, content })) });
    if (buffer.length > BUFFER_LIMIT) buffer.shift();
    if (!getSettings().logPrompts) return id;

    console.groupCollapsed(`${LOG_PREFIX} запрос #${id} → ${role} (${model}, ${transport})`);
    for (const message of messages) {
        console.log(`--- ${message.role} ---\n${message.content}`);
    }
    console.groupEnd();
    return id;
}

export function logResponse(id, role, text) {
    const entry = buffer.find((item) => item.id === id);
    if (entry) entry.response = text;
    if (!getSettings().logPrompts) return;
    console.groupCollapsed(`${LOG_PREFIX} ответ #${id} ← ${role}`);
    console.log(text);
    console.groupEnd();
}

export function logError(id, role, error) {
    const entry = buffer.find((item) => item.id === id);
    if (entry) entry.error = error?.message ?? String(error);
    // Ошибки печатаем всегда, независимо от переключателя.
    console.error(`${LOG_PREFIX} ошибка запроса #${id} (${role}):`, error);
}

/** Сколько запросов накоплено. */
export function promptLogSize() {
    return buffer.length;
}

export function clearPromptLog() {
    buffer.length = 0;
}

/**
 * Текст файла лога. Разметка строгая, её разбирает скрипт проверки изоляции:
 * «===== #12 → hero2 | model | время =====», затем «--- system ---», «--- user ---», «--- ответ ---» или «--- ошибка ---».
 * Ключа API здесь нет: он идёт в заголовке запроса, а не в сообщениях.
 */
export function promptLogText() {
    return buffer.map((entry) => [
        `===== #${entry.id} → ${entry.role} | ${entry.model} | ${entry.time} =====`,
        ...entry.messages.flatMap((message) => [`--- ${message.role} ---`, message.content]),
        ...(entry.error ? ['--- ошибка ---', entry.error] : ['--- ответ ---', entry.response ?? '(ответа нет)']),
        '',
    ].join('\n')).join('\n');
}
