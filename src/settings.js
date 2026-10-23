// Настройки расширения в extensionSettings (FR-29). Общие для всех чатов, живут в settings.json пользователя ST.
// Ключ OpenRouter для прямого режима хранится только здесь и никогда не попадает в метаданные чата (NFR-04).

import { EXTENSION_KEY } from './constants.js';

export const DEFAULT_SETTINGS = Object.freeze({
    // Способ вызова моделей: direct — напрямую в OpenRouter (основной, решение спайка 1.2),
    // backend — через сервер ST (ключ из «Подключений API»), запасной.
    transport: 'direct',
    openrouterKey: '',
    masterModel: 'openai/gpt-4o',
    heroModel: 'openai/gpt-4o-mini',
    language: 'русский',
    maxTurns: 20,
    randomness: 20,
    checkFrequency: 50, // % действий героев, которые мастер проверяет броском (новое, PLAN 4.8)
    silenceThreshold: 4,
    stopAtSceneEnd: true,
    turnDelaySec: 3,
    logPrompts: false,
});

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[EXTENSION_KEY]) {
        extensionSettings[EXTENSION_KEY] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = extensionSettings[EXTENSION_KEY];
    // Досыпаем новые ключи после обновления расширения.
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = value;
    }
    return settings;
}

export function updateSettings(patch) {
    Object.assign(getSettings(), patch);
    SillyTavern.getContext().saveSettingsDebounced();
}
