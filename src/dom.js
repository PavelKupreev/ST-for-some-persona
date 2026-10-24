// Где лежит разметка расширения (этап 9). Меню и кнопки управления — в строке ввода ST, а страница игры
// переезжает в отдельную вкладку браузера (src/page.js). Код по-прежнему ищет элементы по id, но через $$:
// он смотрит и в документ ST, и в документ вкладки страницы, когда она открыта.

let pageDocument = null;

/** Документ вкладки страницы игры или null, если страница сейчас в ST. */
export function setPageDocument(doc) {
    pageDocument = doc && doc !== document ? doc : null;
}

/** jQuery по селектору в документе ST и во вкладке страницы игры. */
export function $$(selector) {
    const local = $(selector);
    if (!pageDocument || pageDocument.defaultView?.closed) return local;
    return local.add($(selector, pageDocument));
}

/** Окно, где сейчас пользователь: confirm и скачивание должны случиться там, иначе их не видно. */
export function activeWindow() {
    const win = pageDocument?.defaultView;
    if (win && !win.closed && pageDocument.hasFocus()) return win;
    return window;
}

/** confirm в той вкладке, где пользователь нажал кнопку. */
export function ask(message) {
    return activeWindow().confirm(message);
}

/** Скачать файл из той вкладки, где пользователь. */
export function downloadFile(blob, fileName) {
    const doc = activeWindow().document;
    const url = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = fileName;
    doc.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
