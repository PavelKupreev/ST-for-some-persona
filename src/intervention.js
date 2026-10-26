// Вмешательство пользователя (этап 5, UC-04): тайная микроцель герою (FR-18) и одноразовая записка мастеру (FR-19).
// Промпты уже берут их из состояния (src/prompts.js): микроцель — у героя и мастера, записка — только у мастера.
// Здесь — запись в состояние и поля на главной панели.

import { LOG_PREFIX } from './constants.js';
import { getState, saveState } from './state.js';
import { HERO_IDS } from './prompts.js';
import { $$ } from './dom.js';
import { isDialogue } from './dialogue.js';

export const INTERVENTION_MAX_LENGTH = 500;

function cleanText(text, what) {
    const value = String(text ?? '').trim();
    if (!value) throw new Error(`Напишите ${what}`);
    if (value.length > INTERVENTION_MAX_LENGTH) throw new Error(`${what[0].toUpperCase()}${what.slice(1)} длиннее ${INTERVENTION_MAX_LENGTH} символов`);
    return value;
}

/**
 * Новая микроцель заменяет прежнюю (по одной на героя). Действует со следующего вызова модели.
 * @returns {string} прежняя микроцель
 */
export function applyMicroGoal(state, heroIndex, text) {
    const hero = state.heroes[heroIndex];
    if (!hero) throw new Error('Выберите героя');
    const previous = hero.microGoal ?? '';
    hero.microGoal = cleanText(text, 'микроцель');
    return previous;
}

/** Записка ждёт ближайшего хода мастера; новая неотправленная записка заменяет старую. */
export function applyMasterNote(session, text) {
    session.masterNote = cleanText(text, 'записку');
}

/**
 * Мастер ответил на промпт с запиской `sent` — она израсходована. Если пользователь, пока мастер думал,
 * написал новую, её не трогаем: она уйдёт в следующий ход мастера.
 * @returns {boolean} записка снята
 */
export function consumeMasterNote(session, sent) {
    if (!sent || session.masterNote !== sent) return false;
    session.masterNote = '';
    return true;
}

// ---------- Главная панель (FR-28) ----------

/** Поля вмешательства: список героев, текущая записка. Вызывается из renderSession. */
export function renderIntervention(state) {
    // В простом диалоге (PLAN 10.1) мастера нет: ни записки, ни микроцели.
    const ready = state.heroes.length === 2 && !isDialogue(state);
    $$('#rpga_intervene').toggle(ready);
    if (!ready) return;

    // Панель перерисовывается после каждого хода: список пересобираем, только если сменились герои,
    // иначе раскрытый пользователем выпадающий список закрылся бы посреди выбора.
    const select = $$('#rpga_micro_hero');
    const names = state.heroes.map((hero) => hero.name);
    if (select.find('option').map((_, option) => option.textContent).get().join('\n') !== names.join('\n')) {
        const chosen = select.val();
        select.empty();
        names.forEach((name, index) => select.append($('<option>').val(HERO_IDS[index]).text(name)));
        select.val(HERO_IDS.includes(chosen) ? chosen : HERO_IDS[0]);
    }
    showCurrentMicroGoal(state);

    const note = state.session.masterNote;
    $$('#rpga_note_status').text(note ? `✉️ Ждёт ближайшего хода мастера: «${note}»` : '');
    $$('#rpga_note_cancel').toggleClass('rpga-off', !note);
    refreshInterventionButtons();
}

function showCurrentMicroGoal(state) {
    const hero = state.heroes[HERO_IDS.indexOf($$('#rpga_micro_hero').val())];
    $$('#rpga_micro_text').attr('placeholder', hero?.microGoal ? `Сейчас: ${hero.microGoal}` : 'сходить в магазин');
}

function refreshInterventionButtons() {
    $$('#rpga_micro_set').toggleClass('rpga-off', !String($$('#rpga_micro_text').val()).trim());
    $$('#rpga_note_send').toggleClass('rpga-off', !String($$('#rpga_note_text').val()).trim());
}

function requireHeroes() {
    const state = getState();
    if (!state) throw new Error('Сначала откройте чат');
    if (state.heroes.length !== 2) throw new Error('Нет героев: подготовьте их в «Старте игры»');
    return state;
}

/**
 * Подписывает поля вмешательства. Кнопки — через общий bindButton из index.js.
 * @param {(selector: string, handler: () => Promise<void>) => void} bindButton
 * @param {() => void} onChange перерисовать панели после изменения
 */
export function bindIntervention(bindButton, onChange) {
    $$('#rpga_micro_hero').on('change', () => {
        const state = getState();
        if (state) showCurrentMicroGoal(state);
    });
    $$('#rpga_micro_text, #rpga_note_text').on('input', refreshInterventionButtons);

    bindButton('#rpga_micro_set', async () => {
        const state = requireHeroes();
        const heroIndex = HERO_IDS.indexOf($$('#rpga_micro_hero').val());
        const previous = applyMicroGoal(state, heroIndex, $$('#rpga_micro_text').val());
        const hero = state.heroes[heroIndex];
        await saveState();
        console.log(`${LOG_PREFIX} микроцель ${HERO_IDS[heroIndex]} (${hero.name}): «${previous || '—'}» → «${hero.microGoal}»`);
        $$('#rpga_micro_text').val('');
        onChange();
        toastr.success(`${hero.name}: «${hero.microGoal}». Видят только ${hero.name} и мастер, со следующего хода.`, 'Микроцель');
    });

    bindButton('#rpga_note_send', async () => {
        const state = requireHeroes();
        applyMasterNote(state.session, $$('#rpga_note_text').val());
        await saveState();
        console.log(`${LOG_PREFIX} записка мастеру ждёт его хода: «${state.session.masterNote}»`);
        $$('#rpga_note_text').val('');
        onChange();
        toastr.success('Мастер получит её в ближайший ход, герои не увидят.', 'Записка мастеру');
    });

    bindButton('#rpga_note_cancel', async () => {
        const state = requireHeroes();
        if (!state.session.masterNote) return;
        console.log(`${LOG_PREFIX} записка мастеру отозвана: «${state.session.masterNote}»`);
        state.session.masterNote = '';
        await saveState();
        onChange();
    });
}
