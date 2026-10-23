// Вызов моделей OpenRouter (спайк 1.2, FR-29).
// Два способа, оба не трогают текущее подключение ST:
//   backend — запрос идёт через сервер ST (/api/backends/chat-completions/generate) с подменой модели;
//             ключ OpenRouter берётся сервером из «Подключений API», расширение его не видит.
//   direct  — запрос напрямую в https://openrouter.ai с ключом из настроек расширения.

import { getSettings } from './settings.js';
import { logError, logPrompt, logResponse } from './logger.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Модель зависла или OpenRouter не отвечает: дольше не ждём, ход считается сорвавшимся (FR-22).
export const REQUEST_TIMEOUT_SEC = 120;

/**
 * Отправляет сообщения модели и возвращает текст ответа.
 * @param {object} params
 * @param {string} params.role кто вызывает: master / hero1 / hero2 / historian / test (для лога)
 * @param {string} params.model id модели OpenRouter, например openai/gpt-4o-mini
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} params.messages
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<string>}
 * @throws {Error} при ошибке API или пустом ответе
 */
export async function callModel({ role, model, messages, maxTokens = 800, temperature = 0.9, signal }) {
    if (!model) throw new Error(`Не задана модель для «${role}»`);

    const { transport } = getSettings();
    const requestId = logPrompt({ role, model, transport, messages });

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_SEC * 1000);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;

    try {
        const text = transport === 'direct'
            ? await callDirect({ model, messages, maxTokens, temperature, signal: combined })
            : await callBackend({ model, messages, maxTokens, temperature, signal: combined });

        if (!text || !text.trim()) throw new Error('Модель вернула пустой ответ');
        logResponse(requestId, role, text);
        return text;
    } catch (error) {
        const failure = timeout.signal.aborted
            ? new Error(`модель «${model}» не ответила за ${REQUEST_TIMEOUT_SEC} с`)
            : error;
        logError(requestId, role, failure);
        throw failure;
    } finally {
        clearTimeout(timer);
    }
}

async function callBackend({ model, messages, maxTokens, temperature, signal }) {
    const { ChatCompletionService } = SillyTavern.getContext();
    if (!ChatCompletionService) {
        throw new Error('В этой версии ST нет ChatCompletionService: обновите ST или включите прямой режим');
    }

    const result = await ChatCompletionService.processRequest({
        stream: false,
        chat_completion_source: 'openrouter',
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
    }, {}, true, signal);

    return typeof result?.content === 'string' ? result.content : '';
}

async function callDirect({ model, messages, maxTokens, temperature, signal }) {
    const { openrouterKey } = getSettings();
    if (!openrouterKey) throw new Error('Для прямого режима нужен ключ OpenRouter в настройках расширения');

    const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openrouterKey}`,
            'HTTP-Referer': 'https://sillytavern.app',
            'X-Title': 'SillyTavern RPG Autosession',
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
        signal,
    });

    const json = await response.json().catch(() => null);
    if (!response.ok || json?.error) {
        throw new Error(json?.error?.message || `OpenRouter ответил ${response.status}`);
    }
    return json?.choices?.[0]?.message?.content ?? '';
}
