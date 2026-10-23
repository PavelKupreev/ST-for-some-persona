// Точка входа расширения «RPG-автосессия».
// Этап 1: панель с настройками моделей и тестовыми кнопками для проверки каркаса.
// Этап 2: ход по кнопке (мастер → герой, броски, мысли спойлером).
// Этап 3: старт игры — мир, две карточки, листы героев, завязка, язык игры (src/startPanel.js).
// Этап 4: автосессия — цикл ходов, лимит, конец сцены, пауза на ошибке, главная панель (src/autosession.js).

import { EXTENSION_ROOT, LOG_PREFIX } from './src/constants.js';
import { getSettings, updateSettings } from './src/settings.js';
import { getState, saveState } from './src/state.js';
import { callModel } from './src/llm.js';
import { postAsCharacter, postAsMaster } from './src/chat.js';
import { bindStartPanel, describeGame, gameOutput, renderStartPanel } from './src/startPanel.js';
import { bindSession, renderSession } from './src/autosession.js';

const PING_MESSAGES = [
    { role: 'system', content: 'Ты помогаешь проверить подключение. Отвечай одной короткой фразой на русском.' },
    { role: 'user', content: 'Назови свою модель и скажи «готов».' },
];

async function renderPanel() {
    const response = await fetch(`${EXTENSION_ROOT}panel.html`);
    if (!response.ok) throw new Error(`Не удалось загрузить panel.html: ${response.status}`);
    $('#extensions_settings2').append(await response.text());
}

function bindSettings() {
    const settings = getSettings();

    $('#rpga_transport').val(settings.transport).on('change', function () {
        updateSettings({ transport: String($(this).val()) });
        toggleKeyBlock();
    });
    $('#rpga_openrouter_key').val(settings.openrouterKey).on('input', function () {
        updateSettings({ openrouterKey: String($(this).val()).trim() });
    });
    $('#rpga_master_model').val(settings.masterModel).on('input', function () {
        updateSettings({ masterModel: String($(this).val()).trim() });
    });
    $('#rpga_hero_model').val(settings.heroModel).on('input', function () {
        updateSettings({ heroModel: String($(this).val()).trim() });
    });
    $('#rpga_language').val(settings.language).on('input', function () {
        updateSettings({ language: String($(this).val()).trim() || 'русский' });
    });
    $('#rpga_log_prompts').prop('checked', settings.logPrompts).on('change', function () {
        updateSettings({ logPrompts: $(this).prop('checked') });
    });

    bindNumber('#rpga_max_turns', 'maxTurns', 1, 500);
    bindNumber('#rpga_turn_delay', 'turnDelaySec', 0, 60, { integer: false });
    bindNumber('#rpga_randomness', 'randomness', 0, 100);
    bindNumber('#rpga_check_frequency', 'checkFrequency', 0, 100);
    bindNumber('#rpga_silence', 'silenceThreshold', 0, 50);
    $('#rpga_stop_scene_end').prop('checked', settings.stopAtSceneEnd).on('change', function () {
        updateSettings({ stopAtSceneEnd: $(this).prop('checked') });
    });

    toggleKeyBlock();
}

// Числовая настройка: сохраняем только допустимое значение, при уходе из поля показываем сохранённое.
function bindNumber(selector, key, min, max, { integer = true } = {}) {
    $(selector).val(getSettings()[key]).on('input', function () {
        const raw = Number($(this).val());
        if ($(this).val() === '' || !Number.isFinite(raw)) return;
        const value = integer ? Math.round(raw) : raw;
        updateSettings({ [key]: Math.min(max, Math.max(min, value)) });
        renderSession();
    }).on('change', function () {
        $(this).val(getSettings()[key]);
    });
}

function toggleKeyBlock() {
    $('#rpga_key_block').toggle(getSettings().transport === 'direct');
}

function output(text) {
    $('#rpga_test_output').text(text);
}

// 1.2: по очереди вызываем модель мастера и модель героев, не трогая подключение ST.
async function testModels() {
    const { masterModel, heroModel, transport } = getSettings();
    const lines = [`Способ: ${transport}`];
    output(lines.join('\n') + '\nЖдём ответы...');

    for (const [label, role, model] of [['A (мастер)', 'test-master', masterModel], ['B (герои)', 'test-hero', heroModel]]) {
        const started = performance.now();
        try {
            const text = await callModel({ role, model, messages: PING_MESSAGES, maxTokens: 60 });
            const seconds = ((performance.now() - started) / 1000).toFixed(1);
            lines.push(`✅ ${label} ${model} за ${seconds} с: ${text.trim()}`);
        } catch (error) {
            lines.push(`❌ ${label} ${model}: ${error.message}`);
        }
        output(lines.join('\n'));
    }
}

// 1.3: счётчик в метаданных чата, должен пережить перезагрузку ST.
async function testState() {
    const state = getState();
    if (!state) {
        output('Сначала откройте чат.');
        return;
    }
    state.debug.counter += 1;
    await saveState();
    output(`Счётчик этого чата: ${state.debug.counter}. Перезагрузите страницу и откройте чат снова: число должно сохраниться.`);
}

function showStateOnChatChange() {
    const state = getState();
    output(state ? `Открыт чат, счётчик: ${state.debug.counter}` : '');
    // Сначала сессия: она переводит «идёт» без живого цикла в паузу, от этого зависят кнопки старта.
    renderSession();
    renderStartPanel();
    gameOutput(describeGame());
}

// 1.4: одно сообщение от мастера и одно от героя.
async function testMessages() {
    const context = SillyTavern.getContext();
    if (!context.getCurrentChatId()) {
        output('Сначала откройте чат.');
        return;
    }
    const character = context.characters[context.characterId] ?? context.characters[0];
    if (!character) {
        output('В библиотеке нет ни одной карточки персонажа.');
        return;
    }

    await postAsMaster('*Туман стелется над дорогой. Где-то вдали воет волк.* Проверка: так пишет мастер.');
    await postAsCharacter(character, `Проверка: так говорит ${character.name}.`);
    output(`Отправлены сообщения от «Мастера» и от «${character.name}».`);
}

function bindButton(selector, handler, show = output) {
    $(selector).on('click', async function () {
        const button = $(this);
        if (button.hasClass('disabled') || button.hasClass('rpga-off')) return;
        button.addClass('disabled');
        try {
            await handler();
        } catch (error) {
            console.error(LOG_PREFIX, error);
            show(`Ошибка: ${error.message}`);
            toastr.error(error.message, 'RPG-автосессия');
        } finally {
            button.removeClass('disabled');
        }
    });
}

jQuery(async () => {
    try {
        await renderPanel();
        bindSettings();
        bindButton('#rpga_test_models', testModels);
        bindButton('#rpga_test_state', testState);
        bindButton('#rpga_test_messages', testMessages);
        bindStartPanel((selector, handler) => bindButton(selector, handler, gameOutput));
        bindSession((selector, handler) => bindButton(selector, handler, (text) => $('#rpga_session_output').text(text)));

        renderSession();

        const { eventSource, eventTypes } = SillyTavern.getContext();
        eventSource.on(eventTypes.CHAT_CHANGED, showStateOnChatChange);

        console.log(`${LOG_PREFIX} загружено`);
    } catch (error) {
        console.error(`${LOG_PREFIX} ошибка запуска`, error);
    }
});
