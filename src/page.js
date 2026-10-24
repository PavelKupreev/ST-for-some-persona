// Страница игры (этап 7, FR-27; этап 9 — отдельная вкладка браузера): «Персонажи», «Игра», «Летопись», «Настройки».
// Разметку страницы (page.html) ST загружает у себя, там же подписаны все обработчики. «📖 Страница игры» открывает
// вкладку game.html, и та просит ST перенести в неё готовый узел #rpga_page. Вся игра по-прежнему идёт во вкладке ST:
// вкладка страницы — только экран и пульт, поэтому ST должна оставаться открытой.
// Закрыли вкладку — узел возвращается в ST. Перезагрузили ST — вкладка сама подключится к новой копии расширения.

import { EXTENSION_ROOT, LOG_PREFIX } from './constants.js';
import { $$, setPageDocument } from './dom.js';

const TABS = ['heroes', 'game', 'chronicle', 'settings'];
const TAB_KEY = 'rpgAutosession.pageTab';
const WINDOW_NAME = 'rpga_game';

/** @type {Record<string, () => void>} что перерисовать при открытии вкладки */
const onShow = {};
/** @type {HTMLElement|null} узел страницы: живёт в ST, пока вкладка не открыта */
let pageNode = null;
/** @type {Window|null} */
let pageWindow = null;
let pendingTab = null;

export async function renderPage() {
    const response = await fetch(`${EXTENSION_ROOT}page.html`);
    if (!response.ok) throw new Error(`Не удалось загрузить page.html: ${response.status}`);
    $('body').append(await response.text());
    pageNode = document.getElementById('rpga_page');
    // Вкладка страницы ищет расширение у своего opener — у вкладки ST (см. game-window.js).
    window.rpgAutosession = { instance: `${Date.now()}-${Math.random()}`, attachPage };
}

export function isPageOpen() {
    return Boolean(pageWindow && !pageWindow.closed && pageNode?.ownerDocument === pageWindow.document);
}

/**
 * Открывает страницу во вкладке браузера на вкладке tab (по умолчанию — последней открытой).
 * @param {'heroes'|'game'|'chronicle'|'settings'} [tab]
 */
export function openPage(tab) {
    if (isPageOpen()) {
        if (tab) showTab(tab);
        pageWindow.focus();
        return;
    }
    pendingTab = tab ?? null;
    pageWindow = window.open(`${EXTENSION_ROOT}game.html`, WINDOW_NAME);
    if (!pageWindow) {
        toastr.warning('Браузер не дал открыть вкладку: разрешите всплывающие окна для SillyTavern и нажмите ещё раз.', 'RPG-автосессия');
    }
}

/**
 * Вызывает game-window.js из вкладки страницы: переносим в неё узел страницы и стили ST.
 * @param {Window} win
 */
function attachPage(win) {
    if (!pageNode) return;
    pageWindow = win;
    const doc = win.document;
    doc.getElementById('rpga_page')?.remove(); // узел от прежней копии ST, если ST перезагружали
    copyStyles(doc);
    doc.body.append(doc.adoptNode(pageNode));
    pageNode.hidden = false;
    doc.getElementById('rpga_window_wait')?.setAttribute('hidden', '');
    setPageDocument(doc);
    win.addEventListener('pagehide', () => detachPage(win), { once: true });
    showTab(pendingTab ?? rememberedTab());
    pendingTab = null;
    for (const render of Object.values(onShow)) render();
    console.log(`${LOG_PREFIX} страница игры открыта во вкладке`);
}

// Вкладку закрыли или перезагрузили: узел страницы возвращается в ST, где на него подписаны обработчики.
function detachPage(win) {
    if (pageNode?.ownerDocument === win.document) {
        document.body.append(document.adoptNode(pageNode));
        pageNode.hidden = true;
    }
    if (pageWindow === win) pageWindow = null;
    setPageDocument(null);
}

// Тема ST (цвета, шрифты, размеры) — в стилях и CSS-переменных документа ST: даём вкладке те же.
function copyStyles(doc) {
    doc.head.querySelectorAll('[data-rpga-copied]').forEach((node) => node.remove());
    for (const source of document.querySelectorAll('link[rel="stylesheet"], style')) {
        const copy = source.tagName === 'LINK' ? doc.createElement('link') : doc.createElement('style');
        if (source.tagName === 'LINK') {
            copy.rel = 'stylesheet';
            copy.href = source.href;
        } else {
            copy.textContent = source.textContent;
        }
        copy.dataset.rpgaCopied = '';
        doc.head.append(copy);
    }
    doc.documentElement.setAttribute('style', document.documentElement.getAttribute('style') ?? '');
    doc.body.className = `${document.body.className} rpga-window`;
}

export function showTab(tab) {
    if (!TABS.includes(tab)) tab = TABS[0];
    $$('#rpga_page .rpga-tab').each(function () {
        $(this).toggleClass('rpga-tab-active', $(this).data('tab') === tab);
    });
    $$('#rpga_page .rpga-pane').each(function () {
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
 * @param {Partial<Record<'heroes'|'game'|'chronicle'|'settings', () => void>>} renderers
 */
export function bindPage(renderers = {}) {
    Object.assign(onShow, renderers);
    $$('#rpga_open_page').on('click', () => openPage());
    $$('#rpga_page').on('click', '.rpga-tab', function () {
        showTab($(this).data('tab'));
    });
    // ST закрывают или перезагружают: вкладке страницы нечем управлять, она покажет заглушку и подождёт новую копию.
    window.addEventListener('pagehide', () => {
        if (isPageOpen()) pageWindow.document.getElementById('rpga_window_wait')?.removeAttribute('hidden');
    });
}
