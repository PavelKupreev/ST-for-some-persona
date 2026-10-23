// Точка входа расширения «RPG-автосессия».
// Этап 1: панель с настройками моделей и тестовыми кнопками для проверки каркаса.
// Этап 2: ход по кнопке на тестовых данных (мастер → герой, броски, мысли спойлером).

import { EXTENSION_ROOT, LOG_PREFIX } from './src/constants.js';
import { getSettings, updateSettings } from './src/settings.js';
import { getState, saveState } from './src/state.js';
import { callModel } from './src/llm.js';
import { postAsCharacter, postAsMaster } from './src/chat.js';
import { DEMO_PREMISE, DEMO_WORLD, createDemoHero } from './src/demo.js';
import { playOneTurn } from './src/game.js';
import { HERO_IDS } from './src/prompts.js';

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
    $('#rpga_log_prompts').prop('checked', settings.logPrompts).on('change', function () {
        updateSettings({ logPrompts: $(this).prop('checked') });
    });

    toggleKeyBlock();
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
    gameOutput(describeGame());
    $('.rpga-hero-select').val(null);
    fillHeroSelects();
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

function gameOutput(text) {
    $('#rpga_game_output').text(text);
}

// Списки карточек для выбора героев. Библиотека ST грузится позже расширения, поэтому заполняем при открытии списка.
function fillHeroSelects() {
    const { characters } = SillyTavern.getContext();
    const heroes = getState()?.heroes ?? [];
    $('.rpga-hero-select').each(function (index) {
        const select = $(this);
        const selected = select.val() || heroes[index]?.cardAvatar || characters[index]?.avatar;
        select.empty();
        for (const character of characters) {
            select.append($('<option>').val(character.avatar).text(character.name));
        }
        if (selected) select.val(selected);
    });
}

function describeGame() {
    const state = getState();
    if (!state) return '';
    if (state.heroes.length !== 2) return 'Героев нет. Выберите две карточки и нажмите «Тестовые данные».';
    const next = state.session.next;
    const nextName = HERO_IDS.includes(next) ? state.heroes[HERO_IDS.indexOf(next)].name : 'Мастер';
    return [
        ...state.heroes.map((hero, index) => `Герой ${index + 1}: ${hero.name}, HP ${hero.hp.current}/${hero.hp.max}. Микроцель: ${hero.microGoal || '—'}`),
        `Записей в истории сцены: ${state.turns.length}. Следующий ход: ${nextName}.`,
    ].join('\n');
}

async function setupDemo() {
    const state = getState();
    if (!state) throw new Error('Сначала откройте чат');
    const avatars = [$('#rpga_hero1').val(), $('#rpga_hero2').val()];
    if (!avatars[0] || !avatars[1] || avatars[0] === avatars[1]) throw new Error('Выберите две разные карточки');
    if (state.turns.length && !confirm('В этом чате уже идёт сцена. Начать заново с тестовыми данными?')) return;

    const { characters } = SillyTavern.getContext();
    const cards = avatars.map((avatar) => characters.find((character) => character.avatar === avatar));
    state.world = structuredClone(DEMO_WORLD);
    state.heroes = cards.map(createDemoHero);
    state.scene.premise = DEMO_PREMISE;
    resetScene(state);
    await saveState();
    gameOutput(`Тестовые данные записаны в этот чат.\n${describeGame()}`);
}

function resetScene(state) {
    state.turns = [];
    state.session.next = 'master';
    state.session.masterNote = '';
    for (const hero of state.heroes) hero.silence = 0;
}

async function resetSceneClick() {
    const state = getState();
    if (!state) throw new Error('Сначала откройте чат');
    resetScene(state);
    await saveState();
    gameOutput(`История сцены очищена, сообщения в чате остались как были.\n${describeGame()}`);
}

async function oneTurn() {
    gameOutput('Ход идёт...');
    const report = await playOneTurn();
    gameOutput(`${report}\n\n${describeGame()}`);
}

function bindButton(selector, handler, show = output) {
    $(selector).on('click', async function () {
        const button = $(this);
        if (button.hasClass('disabled')) return;
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
        bindButton('#rpga_demo_setup', setupDemo, gameOutput);
        bindButton('#rpga_one_turn', oneTurn, gameOutput);
        bindButton('#rpga_reset_scene', resetSceneClick, gameOutput);
        $('.rpga-hero-select').on('mousedown focus', function () {
            if (!$(this).children().length) fillHeroSelects();
        });

        const { eventSource, eventTypes } = SillyTavern.getContext();
        eventSource.on(eventTypes.CHAT_CHANGED, showStateOnChatChange);

        console.log(`${LOG_PREFIX} загружено`);
    } catch (error) {
        console.error(`${LOG_PREFIX} ошибка запуска`, error);
    }
});
