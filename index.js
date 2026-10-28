// Точка входа расширения «RPG-автосессия».
// Этап 1: панель с настройками моделей и тестовыми кнопками для проверки каркаса.
// Этап 2: ход по кнопке (мастер → герой, броски, мысли спойлером).
// Этап 3: старт игры — мир, две карточки, листы героев, завязка, язык игры (src/startPanel.js).
// Этап 4: автосессия — цикл ходов, лимит, конец сцены, пауза на ошибке, главная панель (src/autosession.js).
// Этап 5: вмешательство — тайная микроцель герою и записка мастеру (src/intervention.js).
// Этап 7: страница игры с вкладками (src/page.js), Историк и летопись (src/historian.js).
// Этап 9: меню и кнопки управления над строкой ввода (src/dock.js), страница игры в отдельной вкладке браузера.
// Этапы 11–14: до 10 персонажей, режимы игры, группы (src/heroes.js, src/modes.js), игра за персонажа (src/player.js).

import { LOG_PREFIX } from './src/constants.js';
import { getSettings, updateSettings } from './src/settings.js';
import { getState, saveState } from './src/state.js';
import { callModel } from './src/llm.js';
import { postAsCharacter, postAsMaster } from './src/chat.js';
import { bindStartPanel, describeGame, gameOutput, renderStartPanel } from './src/startPanel.js';
import { bindSession, renderSession } from './src/autosession.js';
import { bindIntervention } from './src/intervention.js';
import { bindPage, renderPage } from './src/page.js';
import { bindChronicle, renderChronicle } from './src/historian.js';
import { clearPromptLog, promptLogSize, promptLogText } from './src/logger.js';
import { $$, downloadFile } from './src/dom.js';
import { bindDock, renderDock } from './src/dock.js';
import { bindPlayer } from './src/player.js';

const PING_MESSAGES = [
    { role: 'system', content: 'Ты помогаешь проверить подключение. Отвечай одной короткой фразой на русском.' },
    { role: 'user', content: 'Назови свою модель и скажи «готов».' },
];


function bindSettings() {
    const settings = getSettings();

    $$('#rpga_transport').val(settings.transport).on('change', function () {
        updateSettings({ transport: String($(this).val()) });
        toggleKeyBlock();
    });
    $$('#rpga_openrouter_key').val(settings.openrouterKey).on('input', function () {
        updateSettings({ openrouterKey: String($(this).val()).trim() });
    });
    $$('#rpga_master_model').val(settings.masterModel).on('input', function () {
        updateSettings({ masterModel: String($(this).val()).trim() });
    });
    $$('#rpga_hero_model').val(settings.heroModel).on('input', function () {
        updateSettings({ heroModel: String($(this).val()).trim() });
    });
    $$('#rpga_romance_master_model').val(settings.romanceMasterModel).on('input', function () {
        updateSettings({ romanceMasterModel: String($(this).val()).trim() });
    });
    $$('#rpga_romance_hero_model').val(settings.romanceHeroModel).on('input', function () {
        updateSettings({ romanceHeroModel: String($(this).val()).trim() });
    });
    $$('#rpga_language').val(settings.language).on('input', function () {
        updateSettings({ language: String($(this).val()).trim() || 'русский' });
    });
    $$('#rpga_historian_style').val(settings.historianStyle).on('change', function () {
        updateSettings({ historianStyle: String($(this).val()) });
    });
    $$('#rpga_death_mode').val(settings.deathMode).on('change', function () {
        updateSettings({ deathMode: String($(this).val()) });
    });
    $$('#rpga_log_prompts').prop('checked', settings.logPrompts).on('change', function () {
        updateSettings({ logPrompts: $(this).prop('checked') });
    });

    bindNumber('#rpga_max_turns', 'maxTurns', 1, 500, { after: clampTurnsLeft });
    bindNumber('#rpga_turn_delay', 'turnDelaySec', 0, 60, { integer: false });
    bindNumber('#rpga_randomness', 'randomness', 0, 100);
    bindNumber('#rpga_check_frequency', 'checkFrequency', 0, 100);
    bindNumber('#rpga_silence', 'silenceThreshold', 0, 50);
    bindNumber('#rpga_memory_threshold', 'memoryThreshold', 0, 200);
    $$('#rpga_stop_scene_end').prop('checked', settings.stopAtSceneEnd).on('change', function () {
        updateSettings({ stopAtSceneEnd: $(this).prop('checked') });
    });

    toggleKeyBlock();
}

// Числовая настройка: сохраняем только допустимое значение, при уходе из поля показываем сохранённое.
function bindNumber(selector, key, min, max, { integer = true, after } = {}) {
    $$(selector).val(getSettings()[key]).on('input', function () {
        const raw = Number($(this).val());
        if ($(this).val() === '' || !Number.isFinite(raw)) return;
        const value = integer ? Math.round(raw) : raw;
        updateSettings({ [key]: Math.min(max, Math.max(min, value)) });
        after?.(getSettings()[key]);
        renderSession();
    }).on('change', function () {
        $(this).val(getSettings()[key]);
    });
}

// «💾 Лог промптов» (новое, PLAN 8.3): все запросы и ответы этой вкладки одним .txt.
function downloadPromptLog() {
    if (!promptLogSize()) throw new Error('Лог пуст: запросов к моделям в этой вкладке ещё не было');
    downloadFile(new Blob([promptLogText()], { type: 'text/plain;charset=utf-8' }), `rpg-prompts-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`);
    $$('#rpga_prompt_log_status').text(`Скачано запросов: ${promptLogSize()}`);
}

function clearLog() {
    clearPromptLog();
    $$('#rpga_prompt_log_status').text('Лог очищен');
}

// Лимит уменьшили: остаток ходов не может быть больше нового лимита, иначе «13 из 5» (PLAN 8.7).
function clampTurnsLeft(maxTurns) {
    const state = getState();
    if (!state || state.session.turnsLeft <= maxTurns) return;
    state.session.turnsLeft = maxTurns;
    saveState().catch((error) => console.error(LOG_PREFIX, error));
}

function toggleKeyBlock() {
    $$('#rpga_key_block').toggle(getSettings().transport === 'direct');
}

function output(text) {
    $$('#rpga_test_output').text(text);
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
    renderChronicle();
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
    $$(selector).on('click', async function () {
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
        await renderDock();
        await renderPage();
        bindPage({ heroes: renderSession, game: renderStartPanel, chronicle: renderChronicle });
        bindSettings();
        bindButton('#rpga_test_models', testModels);
        bindButton('#rpga_test_state', testState);
        bindButton('#rpga_test_messages', testMessages);
        const logStatus = (text) => $$('#rpga_prompt_log_status').text(text);
        bindButton('#rpga_prompt_log_download', downloadPromptLog, logStatus);
        bindButton('#rpga_prompt_log_clear', clearLog, logStatus);
        bindStartPanel((selector, handler) => bindButton(selector, handler, gameOutput));
        const sessionOutput = (text) => $$('#rpga_session_output').text(text);
        bindSession((selector, handler) => bindButton(selector, handler, sessionOutput));
        bindIntervention((selector, handler) => bindButton(selector, handler, sessionOutput), () => {
            renderSession();
            renderStartPanel();
        });

        bindChronicle((selector, handler) => bindButton(selector, handler, (text) => $$('#rpga_chronicle_status').text(text)));
        bindDock();
        bindPlayer();

        renderSession();
        renderChronicle();

        const { eventSource, eventTypes } = SillyTavern.getContext();
        eventSource.on(eventTypes.CHAT_CHANGED, showStateOnChatChange);

        console.log(`${LOG_PREFIX} загружено`);
    } catch (error) {
        console.error(`${LOG_PREFIX} ошибка запуска`, error);
    }
});
