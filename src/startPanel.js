// Панель «Старт игры» (этап 3): мир → две карточки → листы героев → завязка → «Старт».
// Черновик хранится прямо в состоянии чата (chatMetadata), поэтому переживает перезагрузку ST.

import { LOG_PREFIX } from './constants.js';
import { getSettings } from './settings.js';
import { getState, saveState } from './state.js';
import { callModel } from './llm.js';
import { STATS } from './dice.js';
import { ParseError } from './parse.js';
import { HERO_IDS } from './prompts.js';
import {
    HP_MAX, STAT_MAX, STAT_MIN, blankSheet, buildHeroesPrompt, buildWorldPrompt, createHero, parseHeroSheets, parseWorldCard, startProblems,
} from './setup.js';
import { playOneTurn, toPromptCard } from './game.js';

const SETUP_MAX_TOKENS = 1500;
const SAVE_DELAY_MS = 600;

let saveTimer = null;

function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveState().catch((error) => console.error(LOG_PREFIX, error)), SAVE_DELAY_MS);
}

function requireState() {
    const state = getState();
    if (!state) throw new Error('Сначала откройте чат');
    return state;
}

function characters() {
    return SillyTavern.getContext().characters ?? [];
}

function findCard(avatar) {
    return characters().find((character) => character.avatar === avatar) ?? null;
}

export function gameOutput(text) {
    $('#rpga_game_output').text(text);
}

/** Перерисовывает всю панель старта из состояния текущего чата. */
export function renderStartPanel() {
    const state = getState();
    $('#rpga_start_block').toggle(Boolean(state));
    $('#rpga_no_chat').toggle(!state);
    if (!state) return;

    $('#rpga_world_prompt').val(state.setup.worldPrompt || state.world?.prompt || '');
    renderWorldForm(state);
    renderCardList(state);
    renderHeroForms(state);
    $('#rpga_premise').val(state.scene.premise ?? '');
    refreshButtons();
}

// ---------- 3.1 Мир ----------

function renderWorldForm(state) {
    const world = state.world;
    $('#rpga_world_form').toggle(Boolean(world));
    if (!world) return;
    $('#rpga_world_form [data-world]').each(function () {
        const key = $(this).data('world');
        $(this).val(key === 'rules' ? (world.rules ?? []).join('\n') : world[key] ?? '');
    });
}

async function expandWorld() {
    const state = requireState();
    const prompt = String($('#rpga_world_prompt').val()).trim();
    if (!prompt) throw new Error('Напишите промпт мира');
    if (state.world && !confirm('Карточка мира уже есть. Заменить её новой?')) return;

    gameOutput('Мастер придумывает мир...');
    const settings = getSettings();
    const raw = await callModel({
        role: 'master-world',
        model: settings.masterModel,
        messages: buildWorldPrompt({ prompt, language: settings.language }),
        maxTokens: SETUP_MAX_TOKENS,
        temperature: 0.8,
    });
    // Ошибка разбора долетит до bindButton: промпт останется в поле, можно повторить (UC-01).
    state.world = parseWorldCard(raw, prompt);
    await saveState();
    renderWorldForm(state);
    refreshButtons();
    gameOutput('Карточка мира готова. Поправьте любые поля, правки сохраняются сразу.');
}

function onWorldFieldInput() {
    const state = getState();
    if (!state?.world) return;
    const key = $(this).data('world');
    const value = String($(this).val());
    state.world[key] = key === 'rules' ? value.split('\n').map((rule) => rule.trim()).filter(Boolean) : value.trim();
    saveSoon();
    refreshButtons();
}

// ---------- 3.2 Выбор двух карточек ----------

function renderCardList(state) {
    const filter = String($('#rpga_card_filter').val() ?? '').trim().toLowerCase();
    const list = $('#rpga_card_list').empty();
    const selected = state.setup.selected;

    for (const character of characters()) {
        if (filter && !character.name.toLowerCase().includes(filter) && !selected.includes(character.avatar)) continue;
        const order = selected.indexOf(character.avatar);
        const row = $('<label class="rpga-card">')
            .append($('<input type="checkbox">').val(character.avatar).prop('checked', order !== -1))
            .append($('<img alt="">').attr('src', `/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}`))
            .append($('<span class="rpga-card-name">').text(character.name))
            .append($('<span class="rpga-card-order">').text(order === -1 ? '' : `Герой ${order + 1}`));
        list.append(row);
    }
    if (!list.children().length) list.append($('<small>').text(characters().length ? 'Ничего не найдено' : 'В библиотеке ST нет карточек'));
    $('#rpga_pick_count').text(`Выбрано: ${selected.length} из 2`).toggleClass('rpga-bad', selected.length !== 2);
}

function onCardToggle() {
    const state = getState();
    if (!state) return;
    const avatar = String($(this).val());
    const selected = state.setup.selected.filter((item) => item !== avatar);
    if ($(this).prop('checked')) selected.push(avatar);
    state.setup.selected = selected;
    saveSoon();
    renderCardList(state);
    renderHeroForms(state);
    refreshButtons();
}

// ---------- 3.3 Листы героев ----------

function heroesMatchSelection(state) {
    const { selected } = state.setup;
    return selected.length === 2 && state.heroes.length === 2 && state.heroes.every((hero, index) => hero.cardAvatar === selected[index]);
}

function selectedCards(state) {
    if (state.setup.selected.length !== 2) throw new Error('Выберите ровно две карточки');
    const cards = state.setup.selected.map(findCard);
    if (cards.some((card) => !card)) throw new Error('Одна из выбранных карточек не найдена в библиотеке ST');
    return cards;
}

async function generateHeroes() {
    const state = requireState();
    if (!state.world) throw new Error('Сначала создайте карточку мира');
    const cards = selectedCards(state);
    if (heroesMatchSelection(state) && !confirm('Листы героев уже есть. Перегенерировать и затереть правки?')) return;

    gameOutput('Мастер составляет листы героев...');
    const settings = getSettings();
    const raw = await callModel({
        role: 'master-heroes',
        model: settings.masterModel,
        messages: buildHeroesPrompt({ world: state.world, cards: cards.map(toPromptCard), language: settings.language }),
        maxTokens: SETUP_MAX_TOKENS,
        temperature: 0.8,
    });

    let sheets;
    try {
        sheets = parseHeroSheets(raw, cards.map((card) => card.name));
    } catch (error) {
        if (!(error instanceof ParseError)) throw error;
        console.warn(LOG_PREFIX, 'не разобран ответ с листами героев', error.raw);
        throw new Error(`${error.message}. Нажмите «Сгенерировать» ещё раз или «Заполнить вручную».`);
    }
    state.heroes = cards.map((card, index) => createHero(card, sheets[index]));
    await saveState();
    renderHeroForms(state);
    refreshButtons();
    gameOutput('Листы героев готовы. Поправьте статы, HP, цели и микроцели, если нужно.');
}

async function fillHeroesManually() {
    const state = requireState();
    const cards = selectedCards(state);
    if (heroesMatchSelection(state) && !confirm('Листы героев уже есть. Сбросить их к пустым?')) return;
    state.heroes = cards.map((card) => createHero(card, blankSheet()));
    await saveState();
    renderHeroForms(state);
    refreshButtons();
    gameOutput('Пустые листы созданы: все статы 10, HP 10. Заполните цели и микроцели.');
}

function renderHeroForms(state) {
    const box = $('#rpga_hero_forms').empty();
    if (!heroesMatchSelection(state)) {
        if (state.setup.selected.length === 2) box.append($('<small>').text('Для выбранных карточек листов ещё нет: нажмите «Сгенерировать» или «Заполнить вручную».'));
        return;
    }
    state.heroes.forEach((hero, index) => {
        const form = $('<div class="rpga-hero-form">').attr('data-hero', index);
        form.append($('<b>').text(`Герой ${index + 1}: ${hero.name}`));

        const stats = $('<div class="rpga-stats">');
        for (const stat of STATS) {
            stats.append($('<label>').text(stat).append(
                $('<input type="number" class="text_pole">').attr({ min: STAT_MIN, max: STAT_MAX, 'data-stat': stat }).val(hero.stats[stat]),
            ));
        }
        stats.append($('<label>').text('HP').append(
            $('<input type="number" class="text_pole">').attr({ min: 1, max: HP_MAX, 'data-field': 'hp' }).val(hero.hp.max),
        ));
        form.append(stats);

        form.append($('<label>').text('Инвентарь (через запятую)'));
        form.append($('<input type="text" class="text_pole" data-field="inventory">').val(hero.inventory.join(', ')));
        form.append($('<label>').text('Глобальная цель'));
        form.append($('<textarea class="text_pole" rows="2" data-field="globalGoal">').val(hero.globalGoal));
        form.append($('<label>').text('Микроцель (тайная от второго героя)'));
        form.append($('<textarea class="text_pole" rows="2" data-field="microGoal">').val(hero.microGoal));
        box.append(form);
    });
}

function onHeroFieldInput() {
    const state = getState();
    if (!state || !heroesMatchSelection(state)) return;
    const input = $(this);
    const hero = state.heroes[Number(input.closest('.rpga-hero-form').data('hero'))];
    const value = String(input.val());
    const stat = input.data('stat');
    const field = input.data('field');

    if (stat) {
        hero.stats[stat] = parseInt(value, 10);
        input.toggleClass('rpga-bad', !(hero.stats[stat] >= STAT_MIN && hero.stats[stat] <= STAT_MAX));
    } else if (field === 'hp') {
        const hp = parseInt(value, 10);
        hero.hp.max = hp;
        // До старта текущие хиты равны максимуму; в идущей сцене не даём текущим превысить максимум.
        hero.hp.current = state.turns.length ? Math.min(hero.hp.current, hp) : hp;
        input.toggleClass('rpga-bad', !(hp >= 1));
    } else if (field === 'inventory') {
        hero.inventory = value.split(',').map((item) => item.trim()).filter(Boolean);
    } else if (field) {
        hero[field] = value.trim();
    }
    saveSoon();
    refreshButtons();
}

// ---------- 3.4 Завязка и старт ----------

function refreshButtons() {
    const state = getState();
    if (!state) return;
    const hasPrompt = Boolean(String($('#rpga_world_prompt').val()).trim());
    const twoCards = state.setup.selected.length === 2;
    $('#rpga_world_expand').toggleClass('rpga-off', !hasPrompt);
    $('#rpga_heroes_generate').toggleClass('rpga-off', !twoCards || !state.world);
    $('#rpga_heroes_manual').toggleClass('rpga-off', !twoCards);

    const problems = startProblems({ world: state.world, heroes: state.heroes, selected: state.setup.selected });
    $('#rpga_start').toggleClass('rpga-off', problems.length > 0);
    $('#rpga_start_hint').text(problems.length ? `Чтобы начать: ${problems.join('; ')}.` : '');
    $('#rpga_one_turn').toggleClass('rpga-off', !state.turns.length);
}

async function startGame() {
    const state = requireState();
    const problems = startProblems({ world: state.world, heroes: state.heroes, selected: state.setup.selected });
    if (problems.length) throw new Error(`Нельзя начать: ${problems.join('; ')}`);
    if (state.turns.length && !confirm('В этом чате уже идёт сцена. Начать заново? История сцены очистится, сообщения в чате останутся.')) return;

    clearTimeout(saveTimer);
    state.scene.premise = String($('#rpga_premise').val()).trim();
    resetScene(state);
    for (const hero of state.heroes) hero.hp.current = hero.hp.max;
    await saveState();

    gameOutput(state.scene.premise ? 'Мастер открывает сцену по вашей завязке...' : 'Завязки нет, мастер придумывает её сам...');
    try {
        const report = await playOneTurn();
        gameOutput(`Сцена началась.\n${report}\n\n${describeGame()}`);
    } finally {
        // Даже если ход сорвался на середине, часть сцены уже записана и «Один ход» должен ожить.
        refreshButtons();
    }
}

export function resetScene(state) {
    state.turns = [];
    state.session.next = 'master';
    state.session.masterNote = '';
    for (const hero of state.heroes) hero.silence = 0;
}

export async function resetSceneClick() {
    const state = requireState();
    if (!confirm('Очистить историю сцены? Мир и герои останутся, сообщения в чате тоже.')) return;
    resetScene(state);
    await saveState();
    refreshButtons();
    gameOutput(`История сцены очищена.\n${describeGame()}`);
}

export async function oneTurn() {
    gameOutput('Ход идёт...');
    try {
        const report = await playOneTurn();
        gameOutput(`${report}\n\n${describeGame()}`);
    } finally {
        refreshButtons();
    }
}

export function describeGame() {
    const state = getState();
    if (!state || state.heroes.length !== 2) return '';
    const next = state.session.next;
    const nextName = HERO_IDS.includes(next) ? state.heroes[HERO_IDS.indexOf(next)].name : 'Мастер';
    return [
        ...state.heroes.map((hero, index) => `Герой ${index + 1}: ${hero.name}, HP ${hero.hp.current}/${hero.hp.max}. Микроцель: ${hero.microGoal || '—'}`),
        state.turns.length ? `Записей в истории сцены: ${state.turns.length}. Следующий ход: ${nextName}.` : 'Сцена ещё не началась.',
    ].join('\n');
}

/** Подписывает поля панели старта. Кнопки подписывает index.js через общий bindButton. */
export function bindStartPanel(bindButton) {
    bindButton('#rpga_world_expand', expandWorld);
    bindButton('#rpga_heroes_generate', generateHeroes);
    bindButton('#rpga_heroes_manual', fillHeroesManually);
    bindButton('#rpga_start', startGame);
    bindButton('#rpga_one_turn', oneTurn);
    bindButton('#rpga_reset_scene', resetSceneClick);

    $('#rpga_world_prompt').on('input', function () {
        const state = getState();
        if (state) {
            state.setup.worldPrompt = String($(this).val());
            saveSoon();
        }
        refreshButtons();
    });
    $('#rpga_world_form').on('input', '[data-world]', onWorldFieldInput);
    $('#rpga_card_filter').on('input', () => {
        const state = getState();
        if (state) renderCardList(state);
    });
    $('#rpga_card_list').on('change', 'input[type="checkbox"]', onCardToggle);
    $('#rpga_hero_forms').on('input', 'input, textarea', onHeroFieldInput);
    $('#rpga_premise').on('input', function () {
        const state = getState();
        if (!state) return;
        state.scene.premise = String($(this).val());
        saveSoon();
    });
}
