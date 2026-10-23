// Общие константы расширения.

export const EXTENSION_KEY = 'rpgAutosession';
export const LOG_PREFIX = '[RPG-автосессия]';

// Корень папки расширения в URL, например /scripts/extensions/third-party/ST-for-some-persona/
export const EXTENSION_ROOT = new URL('..', import.meta.url).pathname;

export const MASTER_NAME = 'Мастер';
export const MASTER_AVATAR = `${EXTENSION_ROOT}assets/master.svg`;

export const STATE_VERSION = 1;
