// Полноэкранная страница (этап 7, FR-27): вкладки «Игра» (мир, герои, старт), «Летопись», «Настройки».
// Поля и кнопки на ней те же, что раньше были на панели расширений: обработчики подписаны по id и не знают, где они лежат.

import { EXTENSION_ROOT } from './constants.js';

const TABS = ['game', 'chronicle', 'settings'];
const TAB_KEY = 'rpgAutosession.pageTab';

/** @type {Record<string, () => void>} что перерисовать при открытии вкладки */
const onShow = {};

export async function renderPage() {
    const response = await fetch(`${EXTENSION_ROOT}page.html`);
    if (!response.ok) throw new Error(`Не удалось загрузить page.html: ${response.status}`);
    $('body').append(await response.text());
}

export function isPageOpen() {
    return !$('#rpga_page').prop('hidden');
}

/**
 * Открывает страницу на вкладке tab (по умолчанию — последней открытой).
 * @param {'game'|'chronicle'|'settings'} [tab]
 */
export function openPage(tab) {
    $('#rpga_page').prop('hidden', false);
    showTab(tab ?? rememberedTab());
}

export function closePage() {
    $('#rpga_page').prop('hidden', true);
}

export function showTab(tab) {
    if (!TABS.includes(tab)) tab = TABS[0];
    $('#rpga_page .rpga-tab').each(function () {
        $(this).toggleClass('rpga-tab-active', $(this).data('tab') === tab);
    });
    $('#rpga_page .rpga-pane').each(function () {
        $(this).prop('hidden', $(this).data('pane') !== tab);
    });
    try {
        localStorage.setItem(TAB_KEY, tab);
    } catch {
        // вкладка просто не запомнится
    }
    onShow[tab]?.();
}

function rememberedTab() {
    try {
        return localStorage.getItem(TAB_KEY) ?? TABS[0];
    } catch {
        return TABS[0];
    }
}

/**
 * @param {Partial<Record<'game'|'chronicle'|'settings', () => void>>} renderers
 */
export function bindPage(renderers = {}) {
    Object.assign(onShow, renderers);
    $('#rpga_open_page').on('click', () => openPage());
    $('#rpga_page_close').on('click', closePage);
    $('#rpga_page').on('click', '.rpga-tab', function () {
        showTab($(this).data('tab'));
    });
    // Клик по затемнённому фону вокруг страницы закрывает её.
    $('#rpga_page').on('click', function (event) {
        if (event.target === this) closePage();
    });
    $(document).on('keydown', (event) => {
        if (event.key === 'Escape' && isPageOpen()) closePage();
    });
}
