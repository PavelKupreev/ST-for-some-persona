// Вкладка страницы игры (этап 9). Своей логики нет: просит расширение во вкладке ST (window.opener)
// перенести сюда готовую страницу. Раз в 2 с проверяет связь: ST перезагрузили — подключается к новой копии,
// ST закрыли — показывает заглушку.
(function () {
    let instance = null;

    function host() {
        try {
            const opener = window.opener;
            return opener && !opener.closed ? opener.rpgAutosession ?? null : null;
        } catch {
            return null;
        }
    }

    function tick() {
        const api = host();
        const wait = document.getElementById('rpga_window_wait');
        if (!api) {
            instance = null;
            wait.hidden = false;
            return;
        }
        if (api.instance !== instance) {
            instance = api.instance;
            api.attachPage(window);
        }
    }

    tick();
    setInterval(tick, 2000);
})();
