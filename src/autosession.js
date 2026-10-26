// Автосессия (этап 4, концепция Б): ходы идут сами, пока их не остановит пользователь, лимит, конец сцены или ошибка.
// Старт / Пауза / Продолжить / Стоп (FR-07), задержка (NFR-05), лимит и счётчик (FR-20),
// стоп в конце сцены (FR-21), пауза на первой ошибке без повторов (FR-22), главная панель (FR-28).
// Поля вмешательства на этой панели — src/intervention.js (этап 5).

import { LOG_PREFIX } from './constants.js';
import { getSettings } from './settings.js';
import { getState, saveState } from './state.js';
import { postSystemNote } from './chat.js';
import { STATS, abilityModifier } from './dice.js';
import { ABILITY_MAX_LEVEL, LEVEL_AT, progressText, usesToNext } from './abilities.js';
import { playStep } from './game.js';
import { HERO_IDS } from './prompts.js';
import { readyProblems, refreshButtons, resetScene } from './startPanel.js';
import { isDialogue } from './dialogue.js';
import { renderIntervention } from './intervention.js';
import { unchronicledWarning } from './chronicle.js';
import { renderChronicle } from './historian.js';
import { conditionText, heroCondition } from './vitality.js';
import { $$, ask } from './dom.js';

/**
 * Цикл, который крутится в этой вкладке. Живёт только в памяти: после перезагрузки ST
 * сессия со статусом running считается поставленной на паузу (NFR-08).
 * @type {{chatId: string, request: ''|'paused'|'stopped', wake: (() => void)|null} | null}
 */
let loop = null;

const STATUS_TEXT = { idle: 'Не начата', running: 'Идёт', paused: 'Пауза', stopped: 'Остановлена' };

function currentChatId() {
    return SillyTavern.getContext().getCurrentChatId();
}

function requireState() {
    const state = getState();
    if (!state) throw new Error('Сначала откройте чат');
    return state;
}

function ownsChat() {
    return Boolean(loop) && loop.chatId === currentChatId();
}

/** Сессия чата помечена «идёт», но цикла в этой вкладке нет (перезагрузка, смена чата) — это пауза. */
function normalizeStatus(state) {
    if (state.session.status === 'running' && !ownsChat()) {
        state.session.status = 'paused';
        state.session.reason = 'сессия прервана перезагрузкой или сменой чата';
    }
}

// ---------- Кнопки ----------

async function startSession() {
    const state = requireState();
    if (ownsChat()) return;
    const problems = readyProblems(state);
    if (problems.length) throw new Error(`Нельзя начать: ${problems.join('; ')}`);
    if (state.turns.length && !ask(`В этом чате уже есть сцена. Начать новую? История сцены очистится, сообщения в чате останутся.\n\nЧтобы продолжить текущую, нажмите «Отмена», затем «Продолжить».${unchronicledWarning(state)}`)) return;

    resetScene(state);
    state.session.turnsLeft = getSettings().maxTurns;
    await runLoop(state);
}

async function continueSession() {
    const state = requireState();
    normalizeStatus(state);
    if (state.session.status !== 'paused') return;
    // Лимит исчерпан: «Продолжить» даёт ещё N ходов (FR-20).
    if (state.session.turnsLeft <= 0) state.session.turnsLeft = getSettings().maxTurns;
    await runLoop(state);
}

async function pauseSession() {
    await requestHalt('paused');
}

async function stopSession() {
    await requestHalt('stopped');
}

// Пауза и Стоп не обрывают генерацию: текущий ход доигрывается, новый не начинается (UC-03).
async function requestHalt(status) {
    const state = requireState();
    normalizeStatus(state);
    if (ownsChat()) {
        loop.request = status;
        loop.wake?.();
        renderSession();
        return;
    }
    if (status === 'stopped' && state.session.status === 'paused') {
        await halt(state, 'stopped', 'остановлено пользователем');
    }
}

// ---------- Цикл ----------

async function runLoop(state) {
    loop = { chatId: currentChatId(), request: '', wake: null };
    state.session.status = 'running';
    state.session.reason = '';
    await saveState();
    renderAll();
    sessionOutput('Сессия идёт...');

    try {
        for (;;) {
            if (loop.chatId !== currentChatId()) {
                console.warn(`${LOG_PREFIX} открыт другой чат, автосессия прервана`);
                return;
            }
            if (loop.request) {
                await halt(state, loop.request, loop.request === 'stopped' ? 'остановлено пользователем' : 'пауза по кнопке');
                return;
            }

            let step;
            try {
                step = await playStep();
            } catch (error) {
                // FR-22: первая же ошибка — пауза, без автоповторов. Очередь не сдвинута, «Продолжить» повторит ход.
                console.error(LOG_PREFIX, error, error.raw ?? '');
                if (loop.chatId !== currentChatId()) return;
                await halt(state, 'paused', `ошибка: ${error.message}`, { error: true });
                return;
            }

            if (step.author !== 'none') state.session.turnsLeft = Math.max(0, state.session.turnsLeft - 1);
            if (step.allDead) {
                await saveState();
                sessionOutput(step.report);
                await halt(state, 'stopped', 'все герои погибли');
                return;
            }

            await saveState();
            sessionOutput(step.report);
            renderAll();

            if (state.session.turnsLeft <= 0) {
                await halt(state, 'paused', 'лимит ходов исчерпан');
                return;
            }
            if (step.sceneEnd && getSettings().stopAtSceneEnd) {
                await halt(state, 'paused', 'сцена завершена');
                return;
            }
            await sleep(getSettings().turnDelaySec * 1000);
        }
    } finally {
        loop = null;
        renderAll();
    }
}

function sleep(ms) {
    if (loop.request || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        loop.wake = () => {
            clearTimeout(timer);
            resolve();
        };
    }).finally(() => {
        if (loop) loop.wake = null;
    });
}

async function halt(state, status, reason, { error = false } = {}) {
    state.session.status = status;
    state.session.reason = reason;
    await saveState();

    const icon = error ? '⚠️' : status === 'stopped' ? '⏹' : '⏸';
    const title = status === 'stopped' ? 'Автосессия остановлена' : 'Автосессия на паузе';
    const hint = status === 'stopped' ? 'Новая сессия — кнопка «Старт».' : 'Чтобы продолжить, нажмите «Продолжить».';
    await postSystemNote(`${icon} **${title}:** ${reason}. ${hint}`).catch((noteError) => console.error(LOG_PREFIX, noteError));

    const notify = error ? toastr.error : toastr.info;
    notify(`${title}: ${reason}`, 'RPG-автосессия');
    sessionOutput(`${icon} ${title}: ${reason}`);
}

// ---------- Главная панель (FR-28) ----------

function sessionOutput(text) {
    $$('#rpga_session_output').text(text);
}

function renderAll() {
    renderSession();
    refreshButtons();
    renderChronicle();
}

/** Перерисовывает счётчик, статус, кнопки сессии и краткие листы героев. */
export function renderSession() {
    const state = getState();
    $$('#rpga_session').toggle(Boolean(state));
    if (!state) return;
    normalizeStatus(state);

    const { status, reason, turnsLeft } = state.session;
    const running = status === 'running';
    $$('#rpga_turns_left').text(status === 'idle' ? getSettings().maxTurns : turnsLeft);
    $$('#rpga_turns_total').text(`/${getSettings().maxTurns}`);

    let statusText = STATUS_TEXT[status] ?? status;
    if (running && loop?.request) statusText = loop.request === 'stopped' ? 'Останавливается после текущего хода…' : 'Пауза после текущего хода…';
    else if (reason && !running) statusText += `: ${reason}`;
    if (state.turns.length && status !== 'stopped') {
        const index = HERO_IDS.indexOf(state.session.next);
        statusText += ` · следующий: ${index === -1 ? 'Мастер' : state.heroes[index]?.name ?? '?'}`;
    }
    $$('#rpga_session_status').text(statusText).attr('data-status', status);
    $$('#rpga_page_session').text(`${statusText} · ходов ${status === 'idle' ? getSettings().maxTurns : turnsLeft}/${getSettings().maxTurns}`).attr('data-status', status);

    $$('#rpga_session_pause').toggleClass('rpga-off', !running || Boolean(loop?.request));
    $$('#rpga_session_continue').toggleClass('rpga-off', status !== 'paused');
    $$('#rpga_session_stop').toggleClass('rpga-off', !(running || status === 'paused') || loop?.request === 'stopped');

    // Простой диалог (PLAN 10.1): ни Историка, ни вмешательства в мастера.
    const dialogue = isDialogue(state);
    $$('#rpga_chronicle_write').toggle(!dialogue);
    $$('.rpga-tab[data-tab="chronicle"]').toggle(!dialogue);
    $$('#rpga_one_turn').attr('title', dialogue ? 'Одна реплика персонажа, чья очередь' : 'Один ход: мастер и, если он передал слово, герой');

    renderHeroCards(state);
    renderIntervention(state);
}

// Вкладка «Персонажи» на странице игры (этап 9): профиль героя целиком — видит только пользователь.
function renderHeroCards(state) {
    const box = $$('#rpga_hero_cards').empty();
    const empty = isDialogue(state) ? 'Выберите две карточки во вкладке «Игра».' : 'Герои ещё не готовы: выберите две карточки и создайте листы во вкладке «Игра».';
    $$('#rpga_heroes_empty').text(state.heroes.length === 2 ? '' : empty);
    if (state.heroes.length !== 2) return;
    const clock = state.clock?.hours ?? 0;
    const profile = isDialogue(state) ? dialogueProfile : heroProfile;
    state.heroes.forEach((hero, index) => box.append(profile(state, hero, index, clock)));
}

// В простом диалоге у персонажа нет листа: только аватар, имя и последние мысли.
function dialogueProfile(state, hero, index) {
    const card = $('<article class="rpga-profile">');
    card.append($('<header class="rpga-profile-head">')
        .append($('<img class="rpga-profile-avatar" alt="">').attr('src', avatarUrl(hero)))
        .append($('<div class="rpga-profile-title">')
            .append($('<h3>').text(hero.name))
            .append($('<small>').text(`Собеседник ${index + 1} · реплик: ${state.turns.filter((turn) => turn.author === HERO_IDS[index]).length}`))));
    const thoughts = state.turns.findLast((turn) => turn.author === HERO_IDS[index] && turn.thoughts)?.thoughts;
    if (thoughts) {
        card.append($('<details class="rpga-profile-thoughts" open>')
            .append($('<summary>').text('💭 Последние мысли'))
            .append($('<p>').text(thoughts)));
    }
    return card;
}

function heroProfile(state, hero, index, clock) {
    const { current, max } = hero.hp;
    const percent = max > 0 ? Math.max(0, Math.min(100, Math.round((current / max) * 100))) : 0;
    const condition = heroCondition(hero);
    const card = $('<article class="rpga-profile">').attr('data-condition', condition);

    const avatar = $('<img class="rpga-profile-avatar" alt="">').attr('src', avatarUrl(hero));
    const badge = { ok: '⚔️ в строю', down: '💤 без сознания', dead: '💀 погиб' }[condition];
    card.append($('<header class="rpga-profile-head">')
        .append(avatar)
        .append($('<div class="rpga-profile-title">')
            .append($('<h3>').text(hero.name))
            .append($('<small>').text(`Герой ${index + 1} · ${badge}`).attr('title', conditionText(hero, clock)))
            .append($('<div class="rpga-hp-bar rpga-hp-big">')
                .append($('<div class="rpga-hp-fill">').css('width', `${percent}%`))
                .append($('<span class="rpga-hp-label">').text(`HP ${current} / ${max}`)))));
    if (condition !== 'ok') card.append($('<small class="rpga-condition-line">').text(conditionText(hero, clock)));

    const stats = $('<div class="rpga-profile-stats">');
    for (const stat of STATS) {
        stats.append($('<div class="rpga-stat-tile">')
            .append($('<small>').text(stat))
            .append($('<b>').text(hero.stats[stat]))
            .append($('<span>').text(formatMod(hero.stats[stat]))));
    }
    card.append(stats);

    const abilities = (hero.abilities ?? []).filter((item) => item.name);
    if (abilities.length) {
        const list = $('<div class="rpga-profile-abilities">').append($('<h4>').text('✨ Способности'));
        for (const ability of abilities) {
            const next = usesToNext(ability);
            const from = LEVEL_AT[ability.level - 1] ?? 0;
            const progress = next === null ? 100 : Math.round(((ability.uses - from) / Math.max(1, next - from)) * 100);
            list.append($('<div class="rpga-profile-ability">')
                .append($('<div class="rpga-profile-ability-head">')
                    .append($('<b>').text(ability.name))
                    .append($('<small>').text(`${ability.stat} · ${'★'.repeat(ability.level)}${'☆'.repeat(ABILITY_MAX_LEVEL - ability.level)}`)))
                .append($('<div class="rpga-level-bar">').append($('<div class="rpga-level-fill">').css('width', `${progress}%`)))
                .append($('<small class="rpga-ability-progress">').text(progressText(ability)))
                .append(ability.description ? $('<p>').text(ability.description) : null));
        }
        card.append(list);
    }

    const inventory = $('<div class="rpga-profile-inventory">').append($('<h4>').text('🎒 Инвентарь'));
    const chips = $('<div class="rpga-chips">');
    (hero.inventory?.length ? hero.inventory : ['пусто']).forEach((item) => chips.append($('<span class="rpga-chip">').text(item)));
    card.append(inventory.append(chips));

    card.append($('<div class="rpga-profile-goals">')
        .append($('<p>').append($('<b>').text('🌟 Цель: ')).append(document.createTextNode(hero.globalGoal || '—')))
        .append($('<p>').attr('title', 'Видят только этот герой и мастер').append($('<b>').text('🎯 Микроцель (тайная): ')).append(document.createTextNode(hero.microGoal || '—'))));

    const thoughts = state.turns.findLast((turn) => turn.author === HERO_IDS[index] && turn.thoughts)?.thoughts;
    if (thoughts) {
        card.append($('<details class="rpga-profile-thoughts">')
            .append($('<summary>').text('💭 Последние мысли'))
            .append($('<p>').text(thoughts)));
    }
    return card;
}

function avatarUrl(hero) {
    if (!hero.cardAvatar || hero.cardAvatar === 'none') return new URL('/img/ai4.png', location.href).href;
    const { getThumbnailUrl } = SillyTavern.getContext();
    // Вкладка страницы открыта по другому адресу: путь к миниатюре делаем абсолютным.
    return new URL(getThumbnailUrl('avatar', hero.cardAvatar), location.href).href;
}

function formatMod(score) {
    const mod = abilityModifier(score);
    return mod >= 0 ? `+${mod}` : String(mod);
}

/** Подписывает кнопки сессии. Кнопки подписывает index.js через общий bindButton. */
export function bindSession(bindButton) {
    bindButton('#rpga_session_start', startSession);
    bindButton('#rpga_session_continue', continueSession);
    // Пауза и Стоп должны срабатывать, пока «Старт» или «Продолжить» ждут конца цикла, поэтому без общей блокировки.
    $$('#rpga_session_pause').on('click', () => !$$('#rpga_session_pause').hasClass('rpga-off') && pauseSession().catch(showError));
    $$('#rpga_session_stop').on('click', () => !$$('#rpga_session_stop').hasClass('rpga-off') && stopSession().catch(showError));
}

function showError(error) {
    console.error(LOG_PREFIX, error);
    toastr.error(error.message, 'RPG-автосессия');
}
