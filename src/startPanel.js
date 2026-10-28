// Панель «Старт игры» (этап 3): режим → мир → карточки (1–10) и группы → листы героев → завязка. «Старт» автосессии — в src/autosession.js.
// Черновик хранится прямо в состоянии чата (chatMetadata), поэтому переживает перезагрузку ST.

import { LOG_PREFIX } from './constants.js';
import { getSettings } from './settings.js';
import { getState, saveState } from './state.js';
import { callModel } from './llm.js';
import { STATS } from './dice.js';
// Навыки 5e (PLAN 6.3) отключены по просьбе пользователя:
// import { SKILLS, SKILL_IDS } from './dice.js';
import { ABILITIES_MAX, ABILITY_MAX_LEVEL, blankAbility, progressText } from './abilities.js';
import { ParseError } from './parse.js';
import { DEFAULT_GROUP, GROUPS, heroById, liveGroups, resetGroup } from './heroes.js';
import { MODES, MODE_TITLES, gameMode, hasMaster, heroCount, heroCountRange, isRomance, modelsFor, usesDice } from './modes.js';
import {
    HP_MAX, STAT_MAX, STAT_MIN, blankSheet, buildHeroesPrompt, buildWorldPrompt, createHero, parseHeroSheets, parseWorldCard, startProblems,
} from './setup.js';
import { playOneTurn, toPromptCard } from './game.js';
import { renderSession } from './autosession.js';
import { unchronicledWarning } from './chronicle.js';
import { renderChronicle } from './historian.js';
import { resetVitality } from './vitality.js';
import { dialogueProblems, isDialogue } from './dialogue.js';
import { $$, ask } from './dom.js';

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
    $$('#rpga_game_output').text(text);
}

/** Перерисовывает всю панель старта из состояния текущего чата. */
export function renderStartPanel() {
    const state = getState();
    $$('#rpga_start_block').toggle(Boolean(state));
    $$('#rpga_no_chat').toggle(!state);
    if (!state) return;

    renderMode(state);
    $$('#rpga_hero_count').attr(heroCountRange(state)).val(heroCount(state));
    $$('#rpga_world_prompt').val(state.setup.worldPrompt || state.world?.prompt || '');
    renderWorldForm(state);
    renderCardList(state);
    renderRoster(state);
    renderHeroForms(state);
    $$('#rpga_premise').val(state.scene.premise ?? '');
    refreshButtons();
}

// ---------- 12.1 Режим: без мастера, приключение, романтика (FR-33) ----------

const MODE_HINTS = {
    free: 'Без мастера, кубиков и листов: персонажи по очереди отвечают друг другу обычными сообщениями — речь, действия, описание. Ход — одно сообщение. В каждой группе свой разговор.',
    adventure: 'Мастер ведёт сюжет по правилам D&D 5e: кубики, HP, способности, летопись.',
    romance: 'Взрослая романтическая история: мастер-рассказчик без кубиков и HP, у героев желания и отношения друг к другу. Откровенные сцены допустимы. Модели для этого режима можно задать в «Настройках».',
};

function renderMode(state) {
    const mode = gameMode(state);
    const dialogue = isDialogue(state);
    $$('#rpga_mode').val(mode);
    $$('#rpga_mode_hint').text(MODE_HINTS[mode]);
    $$('.rpga-rpg-only').toggle(!dialogue);
    $$('.rpga-dialogue-only').toggle(dialogue);
    $$('#rpga_heroes_title').text(dialogue ? '1. Собеседники' : '2. Герои');
    $$('#rpga_premise_title').text(dialogue ? '2. Место и тема разговора' : '3. Завязка сцены');
    $$('#rpga_premise').attr('placeholder', dialogue ? 'Пусто — персонажи сами найдут, о чём поговорить' : 'Пусто — мастер придумает завязку сам');
}

async function onModeChange() {
    const state = getState();
    if (!state) return;
    const mode = String($(this).val());
    if (state.session.status === 'running') {
        $(this).val(state.mode);
        toastr.warning('Идёт сессия: сначала нажмите «Пауза» или «Стоп»', 'RPG-автосессия');
        return;
    }
    const before = gameMode(state);
    state.mode = MODES.includes(mode) ? mode : 'adventure';
    // Листы «Приключения» и «Романтики» разные (статы против отношений): при смене между ними — перегенерировать.
    if (hasMaster(state) && before !== state.mode && before !== 'free' && state.heroes.length) {
        toastr.info(`Листы героев составлены для режима «${MODE_TITLES[before]}». Для «${MODE_TITLES[state.mode]}» нажмите «Сгенерировать».`, 'RPG-автосессия');
    }
    state.setup.count = heroCount(state);
    syncDialogueHeroes(state);
    await saveState();
    renderStartPanel();
    renderSession();
    renderChronicle();
    gameOutput(describeGame());
}

/**
 * Без мастера листы не нужны: персонажи — это просто выбранные карточки (пустой лист, чтобы работал общий код).
 * Листы для тех же карточек сохраняются: при возврате в режим с мастером они на месте.
 */
function syncDialogueHeroes(state) {
    if (!isDialogue(state) || state.setup.selected.length !== heroCount(state) || heroesMatchSelection(state)) return;
    const cards = state.setup.selected.map(findCard);
    if (cards.some((card) => !card)) return;
    state.heroes = cards.map((card) => state.heroes.find((hero) => hero.cardAvatar === card.avatar) ?? createHero(card, blankSheet(), groupOf(state, card.avatar)));
}

/** Стартовая группа карточки (FR-34). */
function groupOf(state, avatar) {
    return GROUPS.includes(state.setup.groups?.[avatar]) ? state.setup.groups[avatar] : DEFAULT_GROUP;
}

/** Что мешает начать в текущем режиме; пустой список — можно стартовать. */
export function readyProblems(state) {
    if (isDialogue(state)) return dialogueProblems({ selected: state.setup.selected, count: heroCount(state) });
    return startProblems({ world: state.world, heroes: state.heroes, selected: state.setup.selected, count: heroCount(state), sheets: usesDice(state) });
}

async function onCountChange() {
    const state = getState();
    if (!state) return;
    const { min, max } = heroCountRange(state);
    const value = Number.parseInt(String($(this).val()), 10);
    if (!Number.isFinite(value)) return;
    state.setup.count = Math.min(max, Math.max(min, value));
    if (value !== state.setup.count) $(this).val(state.setup.count);
    // Лишние отмеченные карточки снимаем с конца.
    if (state.setup.selected.length > state.setup.count) state.setup.selected = state.setup.selected.slice(0, state.setup.count);
    syncDialogueHeroes(state);
    saveSoon();
    renderCardList(state);
    renderRoster(state);
    renderHeroForms(state);
    refreshButtons();
}

// ---------- 3.1 Мир ----------

function renderWorldForm(state) {
    const world = state.world;
    $$('#rpga_world_form').toggle(Boolean(world));
    if (!world) return;
    $$('#rpga_world_form [data-world]').each(function () {
        const key = $(this).data('world');
        $(this).val(key === 'rules' ? (world.rules ?? []).join('\n') : world[key] ?? '');
    });
}

async function expandWorld() {
    const state = requireState();
    const prompt = String($$('#rpga_world_prompt').val()).trim();
    if (!prompt) throw new Error('Напишите промпт мира');
    if (state.world && !ask('Карточка мира уже есть. Заменить её новой?')) return;

    gameOutput('Мастер придумывает мир...');
    const settings = getSettings();
    const raw = await callModel({
        role: 'master-world',
        model: modelsFor(settings, state).master,
        messages: buildWorldPrompt({ prompt, language: settings.language, mode: isRomance(state) ? 'romance' : 'adventure' }),
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

// ---------- 3.2, 11.2 Выбор карточек ----------

function renderCardList(state) {
    const filter = String($$('#rpga_card_filter').val() ?? '').trim().toLowerCase();
    const list = $$('#rpga_card_list').empty();
    const selected = state.setup.selected;

    for (const character of characters()) {
        if (filter && !character.name.toLowerCase().includes(filter) && !selected.includes(character.avatar)) continue;
        const order = selected.indexOf(character.avatar);
        const row = $('<label class="rpga-card">')
            .append($('<input type="checkbox">').val(character.avatar).prop('checked', order !== -1))
            .append($('<img alt="">').attr('src', `/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}`))
            .append($('<span class="rpga-card-name">').text(character.name))
            .append($('<span class="rpga-card-order">').text(order === -1 ? '' : `${isDialogue(state) ? 'Собеседник' : 'Герой'} ${order + 1}`));
        list.append(row);
    }
    if (!list.children().length) list.append($('<small>').text(characters().length ? 'Ничего не найдено' : 'В библиотеке ST нет карточек'));
    const count = heroCount(state);
    $$('#rpga_pick_count').text(`Выбрано: ${selected.length} из ${count}`).toggleClass('rpga-bad', selected.length !== count);
}

// Состав и группы (новое, FR-34): у каждой выбранной карточки своя стартовая группа.
function renderRoster(state) {
    const box = $$('#rpga_roster').empty();
    const { selected } = state.setup;
    if (!selected.length) return;
    box.append($('<label>').text('Группы: персонажи разных групп не видят и не слышат друг друга, весть передаёт только мастер'));
    selected.forEach((avatar, index) => {
        const card = findCard(avatar);
        const select = $('<select class="text_pole rpga-roster-group">').attr('data-avatar', avatar);
        for (const group of GROUPS) select.append($('<option>').val(group).text(`Группа ${group}`));
        select.val(groupOf(state, avatar));
        box.append($('<div class="rpga-roster-row">')
            .append($('<span>').text(`${index + 1}. ${card?.name ?? avatar}`))
            .append(select));
    });
    if (state.turns.length) box.append($('<small>').text('Сцена уже идёт: новая группа подействует с новой сцены. Перевести героя сейчас можно в «🧝 Персонажах».'));
}

async function onRosterGroupChange() {
    const state = getState();
    if (!state) return;
    const avatar = String($(this).data('avatar'));
    const group = String($(this).val());
    state.setup.groups = { ...(state.setup.groups ?? {}), [avatar]: group };
    const hero = state.heroes.find((item) => item.cardAvatar === avatar);
    if (hero) {
        hero.homeGroup = group;
        if (!state.turns.length) resetGroup(hero);
    }
    saveSoon();
    renderSession();
}

function onCardToggle() {
    const state = getState();
    if (!state) return;
    const avatar = String($(this).val());
    const selected = state.setup.selected.filter((item) => item !== avatar);
    if ($(this).prop('checked')) {
        if (selected.length >= heroCount(state)) {
            $(this).prop('checked', false);
            toastr.warning(`Уже выбрано ${heroCount(state)}: снимите отметку с другой карточки или увеличьте «Число персонажей»`, 'RPG-автосессия');
            return;
        }
        selected.push(avatar);
    }
    state.setup.selected = selected;
    syncDialogueHeroes(state);
    saveSoon();
    renderCardList(state);
    renderRoster(state);
    renderHeroForms(state);
    refreshButtons();
}

// ---------- 3.3 Листы героев ----------

function heroesMatchSelection(state) {
    const { selected } = state.setup;
    return selected.length > 0 && selected.length === heroCount(state) && state.heroes.length === selected.length
        && state.heroes.every((hero, index) => hero.cardAvatar === selected[index]);
}

function selectedCards(state) {
    const count = heroCount(state);
    if (state.setup.selected.length !== count) throw new Error(`Выберите карточек: ${count}`);
    const cards = state.setup.selected.map(findCard);
    if (cards.some((card) => !card)) throw new Error('Одна из выбранных карточек не найдена в библиотеке ST');
    return cards;
}

// Листы для тех карточек, у которых их ещё нет; уже готовые остаются как есть (FR-04, этап 11).
function keptHero(state, card) {
    return state.heroes.find((hero) => hero.cardAvatar === card.avatar) ?? null;
}

const SHEET_TOKENS_PER_HERO = 600;

async function generateHeroes() {
    const state = requireState();
    if (!state.world) throw new Error('Сначала создайте карточку мира');
    const cards = selectedCards(state);
    let missing = cards.filter((card) => !keptHero(state, card));
    if (!missing.length) {
        if (!ask('Листы всех героев уже есть. Перегенерировать все и затереть правки?')) return;
        missing = cards;
    }
    const kept = cards.filter((card) => !missing.includes(card));

    gameOutput(`Мастер составляет ${missing.length === 1 ? `лист героя ${missing[0].name}` : `листы героев (${missing.length})`}...`);
    const settings = getSettings();
    const mode = isRomance(state) ? 'romance' : 'adventure';
    const raw = await callModel({
        role: 'master-heroes',
        model: modelsFor(settings, state).master,
        messages: buildHeroesPrompt({ world: state.world, cards: missing.map(toPromptCard), others: kept.map((card) => card.name), language: settings.language, mode }),
        maxTokens: Math.max(SETUP_MAX_TOKENS, SHEET_TOKENS_PER_HERO * missing.length),
        temperature: 0.8,
    });

    let sheets;
    try {
        sheets = parseHeroSheets(raw, missing.map((card) => card.name), { mode, allNames: cards.map((card) => card.name) });
    } catch (error) {
        if (!(error instanceof ParseError)) throw error;
        console.warn(LOG_PREFIX, 'не разобран ответ с листами героев', error.raw);
        throw new Error(`${error.message}. Нажмите «Сгенерировать» ещё раз или «Заполнить вручную».`);
    }
    state.heroes = cards.map((card) => {
        const index = missing.indexOf(card);
        return index === -1 ? keptHero(state, card) : createHero(card, sheets[index], groupOf(state, card.avatar));
    });
    await saveState();
    renderHeroForms(state);
    refreshButtons();
    renderSession();
    gameOutput(isRomance(state) ? 'Листы героев готовы. Поправьте цели, желания и отношения, если нужно.' : 'Листы героев готовы. Поправьте статы, HP, цели и микроцели, если нужно.');
}

async function fillHeroesManually() {
    const state = requireState();
    const cards = selectedCards(state);
    const all = cards.every((card) => keptHero(state, card));
    if (all && !ask('Листы всех героев уже есть. Сбросить их к пустым?')) return;
    state.heroes = cards.map((card) => (!all && keptHero(state, card)) || createHero(card, blankSheet(), groupOf(state, card.avatar)));
    await saveState();
    renderHeroForms(state);
    refreshButtons();
    renderSession();
    gameOutput(isRomance(state) ? 'Пустые листы созданы. Заполните цели, желания и отношения.' : 'Пустые листы созданы: все статы 10, HP 10. Заполните цели и микроцели.');
}

function renderHeroForms(state) {
    const box = $$('#rpga_hero_forms').empty();
    if (!heroesMatchSelection(state)) {
        if (state.setup.selected.length === heroCount(state)) {
            const missing = state.setup.selected.filter((avatar) => !state.heroes.some((hero) => hero.cardAvatar === avatar)).length;
            box.append($('<small>').text(missing
                ? `Листов нет у карточек: ${missing}. Нажмите «Сгенерировать» (готовые листы останутся) или «Заполнить вручную».`
                : 'Порядок карточек изменился: нажмите «Сгенерировать», готовые листы останутся.'));
        }
        return;
    }
    const romance = isRomance(state);
    state.heroes.forEach((hero, index) => {
        const form = $('<div class="rpga-hero-form">').attr('data-hero', index);
        form.append($('<b>').text(`Герой ${index + 1}: ${hero.name}`));

        if (romance) {
            form.append($('<label>').text('Вещи при себе (через запятую)'));
            form.append($('<input type="text" class="text_pole" data-field="inventory">').val(hero.inventory.join(', ')));
            form.append($('<label>').text('Глубокое желание или цель'));
            form.append($('<textarea class="text_pole" rows="2" data-field="globalGoal">').val(hero.globalGoal));
            form.append($('<label>').text('Тайное желание на сцену (другие герои не знают)'));
            form.append($('<textarea class="text_pole" rows="2" data-field="microGoal">').val(hero.microGoal));
            form.append($('<label>').text('Отношения: по строке «Имя — отношение»'));
            form.append($('<textarea class="text_pole" rows="3" data-field="relations">').val(relationsText(hero)));
            box.append(form);
            return;
        }

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

        // Навыки с владением (PLAN 6.3) отключены по просьбе пользователя:
        // form.append($('<label>').text('Навыки с владением'));
        // const skills = $('<div class="rpga-skills">');
        // for (const id of SKILL_IDS) {
        //     skills.append($('<label class="rpga-skill">').attr('title', `${SKILLS[id].en}, ${SKILLS[id].stat}`).append(
        //         $('<input type="checkbox">').attr('data-skill', id).prop('checked', Boolean(hero.skills?.includes(id))),
        //         $('<span>').text(`${SKILLS[id].ru} · ${SKILLS[id].stat}`),
        //     ));
        // }
        // form.append(skills);

        form.append(renderAbilityEditor(hero));

        form.append($('<label>').text('Инвентарь (через запятую)'));
        form.append($('<input type="text" class="text_pole" data-field="inventory">').val(hero.inventory.join(', ')));
        form.append($('<label>').text('Глобальная цель'));
        form.append($('<textarea class="text_pole" rows="2" data-field="globalGoal">').val(hero.globalGoal));
        form.append($('<label>').text('Микроцель (тайная от других героев)'));
        form.append($('<textarea class="text_pole" rows="2" data-field="microGoal">').val(hero.microGoal));
        box.append(form);
    });
}

function relationsText(hero) {
    return Object.entries(hero.relations ?? {}).map(([name, text]) => `${name} — ${text}`).join('\n');
}

// «Мира — доверяет» по строкам → {Мира: 'доверяет'}; имена — только героев игры.
function parseRelations(text, state, self) {
    const names = state.heroes.map((hero) => hero.name).filter((name) => name !== self.name);
    const relations = {};
    for (const line of String(text).split('\n')) {
        const match = line.match(/^\s*([^—–:-]+?)\s*[—–:-]\s*(.+)$/);
        const name = match && names.find((candidate) => candidate.toLowerCase() === match[1].trim().toLowerCase());
        if (name) relations[name] = match[2].trim();
    }
    return relations;
}

// Уникальные способности (новое, PLAN 6.4): название, характеристика, уровень, описание; до ABILITIES_MAX штук.
function renderAbilityEditor(hero) {
    hero.abilities ??= [];
    const box = $('<div class="rpga-abilities">');
    box.append($('<label>').text(`Уникальные способности (растут от применения, уровень 1–${ABILITY_MAX_LEVEL})`));
    hero.abilities.forEach((ability, index) => {
        const row = $('<div class="rpga-ability">').attr('data-ability', index);
        const head = $('<div class="rpga-ability-head">');
        head.append($('<input type="text" class="text_pole" placeholder="Название" data-afield="name">').val(ability.name));
        const stat = $('<select class="text_pole" data-afield="stat" title="Характеристика проверки">');
        for (const id of STATS) stat.append($('<option>').val(id).text(id));
        head.append(stat.val(ability.stat));
        head.append($('<input type="number" class="text_pole" data-afield="level" title="Уровень">').attr({ min: 1, max: ABILITY_MAX_LEVEL }).val(ability.level));
        head.append($('<div class="menu_button rpga-ability-del" title="Удалить способность">✕</div>'));
        row.append(head);
        row.append($('<small class="rpga-ability-progress">').text(`Применений: ${ability.uses} · ${progressText(ability)}`));
        row.append($('<textarea class="text_pole" rows="2" placeholder="Что делает и как усиливается" data-afield="description">').val(ability.description));
        box.append(row);
    });
    if (hero.abilities.length < ABILITIES_MAX) box.append($('<div class="menu_button rpga-ability-add">+ Способность</div>'));
    return box;
}

function onAbilityButton(event) {
    const state = getState();
    if (!state || !heroesMatchSelection(state)) return;
    const button = $(event.currentTarget);
    const hero = state.heroes[Number(button.closest('.rpga-hero-form').data('hero'))];
    hero.abilities ??= [];
    if (button.hasClass('rpga-ability-add')) {
        if (hero.abilities.length < ABILITIES_MAX) hero.abilities.push(blankAbility());
    } else {
        hero.abilities.splice(Number(button.closest('.rpga-ability').data('ability')), 1);
    }
    renderHeroForms(state);
    saveSoon();
}

function onAbilityFieldInput(input, hero) {
    const ability = hero.abilities?.[Number(input.closest('.rpga-ability').data('ability'))];
    if (!ability) return;
    const field = input.data('afield');
    const value = String(input.val());
    if (field === 'level') {
        const level = parseInt(value, 10);
        const valid = level >= 1 && level <= ABILITY_MAX_LEVEL;
        input.toggleClass('rpga-bad', !valid);
        if (valid) ability.level = level;
    } else {
        ability[field] = field === 'stat' ? value : value.trim();
    }
}

function onHeroFieldInput() {
    const state = getState();
    if (!state || !heroesMatchSelection(state)) return;
    const input = $(this);
    const hero = state.heroes[Number(input.closest('.rpga-hero-form').data('hero'))];
    const value = String(input.val());
    const stat = input.data('stat');
    const field = input.data('field');
    const skill = input.data('skill');

    if (input.data('afield')) {
        onAbilityFieldInput(input, hero);
    } else if (skill) {
        const own = new Set(hero.skills ?? []);
        if (input.prop('checked')) own.add(skill);
        else own.delete(skill);
        hero.skills = SKILL_IDS.filter((id) => own.has(id));
    } else if (stat) {
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
    } else if (field === 'relations') {
        hero.relations = parseRelations(value, state, hero);
    } else if (field) {
        hero[field] = value.trim();
    }
    saveSoon();
    refreshButtons();
}

// ---------- 3.4 Завязка и старт ----------

export function refreshButtons() {
    const state = getState();
    if (!state) return;
    const hasPrompt = Boolean(String($$('#rpga_world_prompt').val()).trim());
    const picked = state.setup.selected.length === heroCount(state);
    $$('#rpga_world_expand').toggleClass('rpga-off', !hasPrompt);
    $$('#rpga_heroes_generate').toggleClass('rpga-off', !picked || !state.world);
    $$('#rpga_heroes_manual').toggleClass('rpga-off', !picked);

    const problems = readyProblems(state);
    const running = state.session.status === 'running';
    $$('#rpga_session_start').toggleClass('rpga-off', problems.length > 0 || running);
    const where = isDialogue(state) ? 'Карточки выбирают' : 'Мир и героев готовят';
    $$('#rpga_start_hint').text(problems.length ? `Чтобы начать: ${problems.join('; ')}. ${where} на «📖 Странице игры», вкладка «Игра».` : '');
    // «Один ход» (концепция А) работает и без автосессии: первое нажатие открывает сцену.
    $$('#rpga_one_turn').toggleClass('rpga-off', running || (!state.turns.length && problems.length > 0));
    $$('#rpga_reset_scene').toggleClass('rpga-off', running || !state.turns.length);
}

/**
 * Чистая сцена: история, очередь и сессия с нуля, хиты героев полные.
 * Неотправленная записка мастеру остаётся: её часто пишут до старта, на первый ход (FR-19).
 */
export function resetScene(state) {
    syncDialogueHeroes(state);
    // Сыгранная сцена уходит в прошлое: следующая получит новый номер, летопись начнёт её с первого хода.
    if (state.turns.length) state.scene.number = (state.scene.number ?? 1) + 1;
    state.scene.chronicledUpTo = 0;
    state.turns = [];
    state.memory = null;
    Object.assign(state.session, {
        status: 'idle', reason: '', turnsLeft: 0, next: 'master', pendingOutcome: false, cut: false, wanted: '', awaitingPlayer: false, resumeAfterPlayer: false,
    });
    for (const hero of state.heroes) {
        hero.silence = 0;
        hero.hp.current = hero.hp.max;
        // Новая сцена: все в своих стартовых группах, ушедшие возвращаются (FR-35).
        resetGroup(hero);
    }
    state.session.focus = liveGroups(state)[0] ?? DEFAULT_GROUP;
    // Новая сцена: павшие и отключённые снова в строю, игровые часы с нуля (PLAN 8.5).
    resetVitality(state);
}

export async function resetSceneClick() {
    const state = requireState();
    if (!ask(`Очистить историю сцены? Мир и герои останутся, сообщения в чате и летопись тоже.${unchronicledWarning(state)}`)) return;
    resetScene(state);
    await saveState();
    refreshButtons();
    renderSession();
    renderChronicle();
    gameOutput(`История сцены очищена.\n${describeGame()}`);
}

export async function oneTurn() {
    const state = requireState();
    if (state.session.status === 'running') throw new Error('Идёт автосессия: сначала нажмите «Пауза»');
    if (!state.turns.length) {
        const problems = readyProblems(state);
        if (problems.length) throw new Error(`Нельзя начать: ${problems.join('; ')}`);
        clearTimeout(saveTimer);
        resetScene(state);
        await saveState();
    }
    gameOutput('Ход идёт...');
    try {
        const report = await playOneTurn();
        gameOutput(`${report}\n\n${describeGame()}`);
    } finally {
        refreshButtons();
        renderSession();
        renderChronicle();
    }
}

export function describeGame() {
    const state = getState();
    if (!state || !state.heroes.length) return '';
    const nextName = heroById(state, state.session.next)?.name ?? 'Мастер';
    if (isDialogue(state)) {
        return [
            `Без мастера: ${state.heroes.map((hero) => hero.name).join(', ')}.`,
            state.turns.length ? `Реплик в разговоре: ${state.turns.length}. Следующим говорит: ${nextName}.` : 'Разговор ещё не начался.',
        ].join('\n');
    }
    return [
        ...state.heroes.map((hero, index) => (usesDice(state)
            ? `Герой ${index + 1}: ${hero.name}, HP ${hero.hp.current}/${hero.hp.max}. Микроцель: ${hero.microGoal || '—'}`
            : `Герой ${index + 1}: ${hero.name}. Желание: ${hero.microGoal || '—'}`)),
        state.turns.length ? `Записей в истории сцены: ${state.turns.length}. Следующий ход: ${nextName}.` : 'Сцена ещё не началась.',
    ].join('\n');
}

/** Подписывает поля панели старта. Кнопки подписывает index.js через общий bindButton. */
export function bindStartPanel(bindButton) {
    bindButton('#rpga_world_expand', expandWorld);
    $$('#rpga_mode').on('change', function () {
        onModeChange.call(this).catch((error) => {
            console.error(LOG_PREFIX, error);
            toastr.error(error.message, 'RPG-автосессия');
        });
    });
    $$('#rpga_hero_count').on('change', function () {
        onCountChange.call(this).catch((error) => {
            console.error(LOG_PREFIX, error);
            toastr.error(error.message, 'RPG-автосессия');
        });
    });
    $$('#rpga_roster').on('change', '.rpga-roster-group', function () {
        onRosterGroupChange.call(this).catch((error) => {
            console.error(LOG_PREFIX, error);
            toastr.error(error.message, 'RPG-автосессия');
        });
    });
    bindButton('#rpga_heroes_generate', generateHeroes);
    bindButton('#rpga_heroes_manual', fillHeroesManually);
    bindButton('#rpga_one_turn', oneTurn);
    bindButton('#rpga_reset_scene', resetSceneClick);

    $$('#rpga_world_prompt').on('input', function () {
        const state = getState();
        if (state) {
            state.setup.worldPrompt = String($(this).val());
            saveSoon();
        }
        refreshButtons();
    });
    $$('#rpga_world_form').on('input', '[data-world]', onWorldFieldInput);
    $$('#rpga_card_filter').on('input', () => {
        const state = getState();
        if (state) renderCardList(state);
    });
    $$('#rpga_card_list').on('change', 'input[type="checkbox"]', onCardToggle);
    $$('#rpga_hero_forms').on('input', 'input:not([type=checkbox]), textarea', onHeroFieldInput);
    $$('#rpga_hero_forms').on('change', 'input[type=checkbox], select', onHeroFieldInput);
    $$('#rpga_hero_forms').on('click', '.rpga-ability-add, .rpga-ability-del', onAbilityButton);
    $$('#rpga_premise').on('input', function () {
        const state = getState();
        if (!state) return;
        state.scene.premise = String($(this).val());
        saveSoon();
    });
}
