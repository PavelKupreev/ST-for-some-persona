// Автосессия (этап 4, концепция Б): ходы идут сами, пока их не остановит пользователь, лимит, конец сцены или ошибка.
// Старт / Пауза / Продолжить / Стоп (FR-07), задержка (NFR-05), лимит и счётчик (FR-20),
// стоп в конце сцены (FR-21), пауза на первой ошибке без повторов (FR-22), главная панель (FR-28).
// Поля вмешательства на этой панели — src/intervention.js (этап 5).

import { LOG_PREFIX } from './constants.js';
import { getSettings } from './settings.js';
import { getState, saveState } from './state.js';
import { postSystemNote } from './chat.js';
import { STATS, abilityModifier } from './dice.js';
import { progressText } from './abilities.js';
import { playStep } from './game.js';
import { HERO_IDS } from './prompts.js';
import { startProblems } from './setup.js';
import { refreshButtons, resetScene } from './startPanel.js';
import { renderIntervention } from './intervention.js';

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
    const problems = startProblems({ world: state.world, heroes: state.heroes, selected: state.setup.selected });
    if (problems.length) throw new Error(`Нельзя начать: ${problems.join('; ')}`);
    if (state.turns.length && !confirm('В этом чате уже есть сцена. Начать новую? История сцены очистится, сообщения в чате останутся.\n\nЧтобы продолжить текущую, нажмите «Отмена», затем «Продолжить».')) return;

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

            state.session.turnsLeft = Math.max(0, state.session.turnsLeft - 1);
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
    $('#rpga_session_output').text(text);
}

function renderAll() {
    renderSession();
    refreshButtons();
}

/** Перерисовывает счётчик, статус, кнопки сессии и краткие листы героев. */
export function renderSession() {
    const state = getState();
    $('#rpga_session').toggle(Boolean(state));
    if (!state) return;
    normalizeStatus(state);

    const { status, reason, turnsLeft } = state.session;
    const running = status === 'running';
    $('#rpga_turns_left').text(status === 'idle' ? getSettings().maxTurns : turnsLeft);
    $('#rpga_turns_total').text(`из ${getSettings().maxTurns}`);

    let statusText = STATUS_TEXT[status] ?? status;
    if (running && loop?.request) statusText = loop.request === 'stopped' ? 'Останавливается после текущего хода…' : 'Пауза после текущего хода…';
    else if (reason && !running) statusText += `: ${reason}`;
    if (state.turns.length && status !== 'stopped') {
        const index = HERO_IDS.indexOf(state.session.next);
        statusText += ` · следующий: ${index === -1 ? 'Мастер' : state.heroes[index]?.name ?? '?'}`;
    }
    $('#rpga_session_status').text(statusText).attr('data-status', status);

    $('#rpga_session_pause').toggleClass('rpga-off', !running || Boolean(loop?.request));
    $('#rpga_session_continue').toggleClass('rpga-off', status !== 'paused');
    $('#rpga_session_stop').toggleClass('rpga-off', !(running || status === 'paused') || loop?.request === 'stopped');

    renderHeroCards(state);
    renderIntervention(state);
}

function renderHeroCards(state) {
    const box = $('#rpga_hero_cards').empty();
    if (state.heroes.length !== 2) {
        box.append($('<small>').text('Герои ещё не готовы.'));
        return;
    }
    for (const hero of state.heroes) {
        const { current, max } = hero.hp;
        const percent = max > 0 ? Math.max(0, Math.min(100, Math.round((current / max) * 100))) : 0;
        const card = $('<div class="rpga-hero-mini">').toggleClass('rpga-down', current <= 0);
        card.append($('<div class="rpga-hero-mini-head">')
            .append($('<b>').text(hero.name))
            .append($('<span class="rpga-hp-text">').text(`HP ${current}/${max}`)));
        card.append($('<div class="rpga-hp-bar">').append($('<div class="rpga-hp-fill">').css('width', `${percent}%`)));
        card.append($('<small class="rpga-stat-line">').text(STATS.map((stat) => `${stat} ${hero.stats[stat]} (${formatMod(hero.stats[stat])})`).join(' · ')));
        // Навыки 5e (PLAN 6.3) отключены по просьбе пользователя:
        // card.append($('<small class="rpga-skill-line">').text(`🛠 ${hero.skills?.length ? hero.skills.map((id) => SKILLS[id]?.ru ?? id).join(', ') : '—'}`).attr('title', 'Навыки с владением: +2 к проверке'));
        for (const ability of (hero.abilities ?? []).filter((item) => item.name)) {
            card.append($('<small class="rpga-ability-line">').text(`✨ ${ability.name} · ${progressText(ability)}`).attr('title', ability.description || ability.name));
        }
        card.append($('<small class="rpga-inv-line">').text(`🎒 ${hero.inventory?.length ? hero.inventory.join(', ') : '—'}`).attr('title', 'Инвентарь'));
        card.append($('<small class="rpga-micro-line">').text(`🎯 ${hero.microGoal || '—'}`).attr('title', 'Тайная микроцель: видят только этот герой и мастер'));
        box.append(card);
    }
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
    $('#rpga_session_pause').on('click', () => !$('#rpga_session_pause').hasClass('rpga-off') && pauseSession().catch(showError));
    $('#rpga_session_stop').on('click', () => !$('#rpga_session_stop').hasClass('rpga-off') && stopSession().catch(showError));
}

function showError(error) {
    console.error(LOG_PREFIX, error);
    toastr.error(error.message, 'RPG-автосессия');
}
