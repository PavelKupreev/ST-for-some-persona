// Вывод сообщений в чат ST от имени мастера и героев (FR-17).

import { MASTER_AVATAR, MASTER_NAME } from './constants.js';

/**
 * Добавляет сообщение в конец текущего чата, рисует его и сохраняет чат.
 * @param {object} params
 * @param {string} params.name имя автора
 * @param {string} params.avatar URL аватара
 * @param {string} params.text текст сообщения (markdown/HTML как в обычном чате ST)
 * @param {object} [params.extra] служебные данные расширения, сохраняются в message.extra.rpgAutosession
 * @param {boolean} [params.isSystem] служебное сообщение (остановка, ошибка): ST помечает его скрытым от ИИ
 * @returns {Promise<number>} индекс сообщения в чате
 */
export async function postMessage({ name, avatar, text, extra = {}, isSystem = false }) {
    const context = SillyTavern.getContext();
    if (!context.getCurrentChatId()) throw new Error('Чат не открыт');

    const message = {
        name,
        is_user: false,
        is_system: isSystem,
        send_date: new Date().toISOString(),
        mes: text,
        force_avatar: avatar,
        extra: {
            api: 'manual',
            model: 'rpg-autosession',
            rpgAutosession: extra,
        },
    };

    context.chat.push(message);
    const messageId = context.chat.length - 1;
    context.addOneMessage(message);
    await context.eventSource.emit(context.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await context.saveChat();
    return messageId;
}

export function postAsMaster(text, extra = {}) {
    return postMessage({ name: MASTER_NAME, avatar: MASTER_AVATAR, text, extra: { author: 'master', ...extra } });
}

/**
 * @param {object} character карточка из context.characters
 * @param {string} text
 * @param {object} [extra]
 */
export function postAsCharacter(character, text, extra = {}) {
    const { getThumbnailUrl } = SillyTavern.getContext();
    const avatar = character.avatar && character.avatar !== 'none'
        ? getThumbnailUrl('avatar', character.avatar)
        : 'img/ai4.png';
    return postMessage({ name: character.name, avatar, text, extra: { characterAvatar: character.avatar, ...extra } });
}

/** Служебное сообщение в чат: остановка сессии, ошибка (раздел 9 ТЗ). В промпты не попадает: они строятся из state.turns. */
export function postSystemNote(text) {
    return postMessage({ name: 'Автосессия', avatar: MASTER_AVATAR, text, extra: { author: 'system' }, isSystem: true });
}
