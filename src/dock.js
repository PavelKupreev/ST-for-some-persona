// Панель над строкой ввода ST (этап 9, FR-28): слева иконка 🎲 с меню (Старт, Стоп, Страница игры, Летопись,
// Цель герою, Записка мастеру), справа счётчик ходов и кнопки «Один ход», «Продолжить», «Пауза».
// Кнопки те же, что раньше были на панели расширений, с теми же id: обработчики подписаны в своих модулях.

import { EXTENSION_ROOT } from './constants.js';

export async function renderDock() {
    const response = await fetch(`${EXTENSION_ROOT}dock.html`);
    if (!response.ok) throw new Error(`Не удалось загрузить dock.html: ${response.status}`);
    const html = await response.text();
    // Над формой отправки: иконка меню встаёт над ☰ и 🪄, кнопки управления — над правыми иконками.
    if ($('#send_form').length) $('#send_form').before(html);
    else $('body').append($(html).addClass('rpga-dock-floating'));
}

function setMenu(open) {
    $('#rpga_menu').prop('hidden', !open);
    $('#rpga_menu_button').toggleClass('rpga-dock-icon-active', open);
}

export function bindDock() {
    $('#rpga_menu_button').on('click', () => setMenu($('#rpga_menu').prop('hidden')));
    $('#rpga_menu_button').on('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setMenu($('#rpga_menu').prop('hidden'));
        }
    });
    // «Цель герою» и «Записка мастеру» раскрывают свои поля, второе при этом сворачивается.
    $('#rpga_menu').on('click', '.rpga-menu-toggle', function () {
        const form = $(`#${$(this).data('form')}`);
        const open = form.prop('hidden');
        $('#rpga_menu .rpga-menu-form').prop('hidden', true);
        form.prop('hidden', !open);
        if (open) form.find('textarea').trigger('focus');
    });
    // Разовые действия закрывают меню; поля вмешательства закрываются после отправки.
    $('#rpga_session_start, #rpga_session_stop, #rpga_open_page, #rpga_chronicle_write').on('click', function () {
        if (!$(this).hasClass('rpga-off')) setMenu(false);
    });
    $('#rpga_micro_set, #rpga_note_send').on('click', function () {
        if (!$(this).hasClass('rpga-off')) $(this).closest('.rpga-menu-form').prop('hidden', true);
    });
    $(document).on('click', (event) => {
        if (!$('#rpga_menu').prop('hidden') && !$(event.target).closest('#rpga_menu, #rpga_menu_button').length) setMenu(false);
    });
    $(document).on('keydown', (event) => {
        if (event.key === 'Escape' && !$('#rpga_menu').prop('hidden')) setMenu(false);
    });
}
