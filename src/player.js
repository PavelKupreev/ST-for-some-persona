// Игра за персонажа (новое, этап 14, FR-36, UC-09): пользователь сам ходит за одного героя.
// «Играть за…» в меню 🎲 выбирает героя; автосессия идёт сама до его хода и встаёт на паузу.
// Ход игрок пишет в обычное поле ввода ST: «✍️ Сходить» над строкой ввода или Enter отправляют его от имени героя,
// а не как сообщение ST (пока ход ждёт игрока, отправку ST перехватываем).

import { LOG_PREFIX } from './constants.js';
import { getState, saveState } from './state.js';
import { heroById, heroId } from './heroes.js';
import { expectedActor, playPlayerTurn } from './game.js';
import { continueSession, renderSession } from './autosession.js';
import { refreshButtons } from './startPanel.js';
import { renderChronicle } from './historian.js';
import { getSettings } from './settings.js';
import { $$ } from './dom.js';

let sending = false;

/** Сессия ждёт хода игрока прямо сейчас. */
export function isWaitingForPlayer(state = getState()) {
    return Boolean(state?.session.player) && state.session.awaitingPlayer && expectedActor(state) === state.session.player;
}

/** Список «Играть за…», кнопка «✍️ Сходить» и подсказка. Вызывается из renderSession. */
export function renderPlayer(state) {
    const select = $$('#rpga_player_hero');
    const options = ['', ...state.heroes.map((_, index) => heroId(index))];
    const labels = ['никого: все персонажи — ИИ', ...state.heroes.map((hero) => hero.name)];
    // Как и в «Цели герою»: пересобираем только при смене героев, чтобы не закрыть раскрытый список.
    if (select.find('option').map((_, option) => option.textContent).get().join('\n') !== labels.join('\n')) {
        select.empty();
        options.forEach((value, index) => select.append($('<option>').val(value).text(labels[index])));
    }
    select.val(heroById(state, state.session.player) ? state.session.player : '');

    const hero = heroById(state, state.session.player);
    const waiting = isWaitingForPlayer(state);
    $$('#rpga_player_send').prop('hidden', !waiting).text(waiting ? `✍️ Сходить за ${hero.name}` : '✍️');
    $$('#rpga_player_status').text(!hero ? ''
        : waiting ? `✍️ Ваш ход за ${hero.name}: напишите его в поле ввода ST (*курсив* — действие) и нажмите «✍️ Сходить» или Enter.`
            : `🎭 Вы играете за ${hero.name}: автосессия остановится на его ходе.`);
    $$('#rpga_menu_button').toggleClass('rpga-dock-icon-waiting', waiting);
}

/**
 * Выбор персонажа игрока. Если сессия ждала хода прежнего персонажа, его ход делает ИИ,
 * и автосессия идёт дальше сама до хода нового (FR-36).
 */
async function setPlayer(id) {
    const state = getState();
    if (!state) return;
    const previous = heroById(state, state.session.player);
    state.session.player = heroById(state, id) ? id : '';
    const resume = state.session.awaitingPlayer && state.session.resumeAfterPlayer && state.session.status === 'paused';
    if (state.session.awaitingPlayer && expectedActor(state) !== state.session.player) state.session.awaitingPlayer = false;
    await saveState();
    const hero = heroById(state, state.session.player);
    console.log(`${LOG_PREFIX} игрок: ${previous?.name ?? '—'} → ${hero?.name ?? '—'}`);
    renderSession();
    toastr.info(hero ? `Вы играете за ${hero.name}${previous ? `, ${previous.name} снова ведёт ИИ` : ''}.` : `Все персонажи снова у ИИ${previous ? `, в том числе ${previous.name}` : ''}.`, 'RPG-автосессия');
    if (resume && !state.session.awaitingPlayer) {
        state.session.resumeAfterPlayer = false;
        await continueSession();
    }
}

/** Ход игрока из поля ввода ST. */
async function submitPlayerTurn() {
    if (sending) return;
    const state = getState();
    if (!isWaitingForPlayer(state)) throw new Error('Сейчас не ваш ход');
    const textarea = $('#send_textarea');
    const resume = state.session.resumeAfterPlayer;
    sending = true;
    try {
        const step = await playPlayerTurn(String(textarea.val() ?? ''));
        textarea.val('').trigger('input');
        const after = getState();
        if (after.session.status !== 'idle') after.session.turnsLeft = Math.max(0, after.session.turnsLeft - 1);
        after.session.resumeAfterPlayer = false;
        await saveState();
        $$('#rpga_session_output').text(step.report);
        renderSession();
        refreshButtons();
        renderChronicle();
        const stop = after.session.turnsLeft <= 0 || step.allDead || (step.sceneEnd && getSettings().stopAtSceneEnd);
        if (resume && after.session.status === 'paused' && !stop) await continueSession();
    } finally {
        sending = false;
    }
}

function showError(error) {
    console.error(LOG_PREFIX, error);
    toastr.error(error.message, 'RPG-автосессия');
}

/** Подписывает «Играть за…», «✍️ Сходить» и перехват отправки ST на время хода игрока. */
export function bindPlayer() {
    $$('#rpga_player_hero').on('change', function () {
        setPlayer(String($(this).val())).catch(showError);
    });
    $$('#rpga_player_send').on('click', () => submitPlayerTurn().catch(showError));

    // Пока ход ждёт игрока, Enter и кнопка отправки ST отправляют ход персонажа, а не обычное сообщение ST.
    // Слушаем в фазе перехвата, чтобы успеть раньше обработчиков ST.
    const intercept = (event) => {
        if (!isWaitingForPlayer()) return false;
        event.preventDefault();
        event.stopImmediatePropagation();
        submitPlayerTurn().catch(showError);
        return true;
    };
    document.getElementById('send_textarea')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.isComposing) intercept(event);
    }, true);
    document.getElementById('send_but')?.addEventListener('click', intercept, true);
}
