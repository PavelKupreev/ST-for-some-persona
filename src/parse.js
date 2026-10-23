// Разбор ответов моделей (FR-11, FR-08). Терпимый к разметке: жирный шрифт, заголовки, английские метки, JSON.
// Модуль без зависимостей от ST, проверяется тестом в Node.

import { parseRollTags, stripRollTags } from './dice.js';
import { extractStateChanges } from './heroState.js';

export class ParseError extends Error {
    constructor(message, raw) {
        super(message);
        this.name = 'ParseError';
        this.raw = raw;
    }
}

const HERO_LABELS = {
    speech: ['РЕПЛИКА', 'РЕЧЬ', 'СЛОВА', 'SPEECH', 'SAY', 'SAYS', 'DIALOGUE', 'LINE', 'REPLY'],
    intent: ['НАМЕРЕНИЕ', 'ДЕЙСТВИЕ', 'INTENT', 'INTENTION', 'ACTION'],
    thoughts: ['МЫСЛИ', 'МЫСЛЬ', 'THOUGHTS', 'THOUGHT', 'INNER THOUGHTS'],
};

const LABEL_TO_FIELD = Object.fromEntries(
    Object.entries(HERO_LABELS).flatMap(([field, labels]) => labels.map((label) => [label, field])),
);

// Метка в начале строки: «РЕПЛИКА:», «**Намерение:**», «## Мысли», «[THOUGHTS]», «- Action —».
const LABEL_LINE = new RegExp(
    String.raw`^[ \t>#*_\-\[]*(${Object.keys(LABEL_TO_FIELD).sort((a, b) => b.length - a.length).join('|')})[\]*_ \t]*(?:[:：—–\-][ \t*_]*|$)`,
    'gimu',
);

// Так модель обозначает «ничего»: герой молчит или ничего не делает.
const EMPTY_VALUES = new Set(['', '-', '—', '–', 'нет', 'ничего', 'молчит', '(молчит)', 'none', 'nothing', 'n/a', '...', '…']);

/**
 * Разбирает ответ героя на реплику, намерение и мысли.
 * @param {string} raw ответ модели
 * @param {object} [options]
 * @param {string[]} [options.foreignNames] имена, за которых герой не должен говорить (второй герой, «Мастер»)
 * @returns {{speech: string, intent: string, thoughts: string}}
 * @throws {ParseError} если в ответе нет ни реплики, ни намерения
 */
export function parseHeroResponse(raw, { foreignNames = [] } = {}) {
    const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text) throw new ParseError('Пустой ответ героя', raw);

    const parts = parseLabeled(text) ?? parseJson(text);
    if (!parts) throw new ParseError('В ответе героя нет меток РЕПЛИКА / НАМЕРЕНИЕ / МЫСЛИ', raw);

    const result = {
        speech: cleanValue(cutForeignLines(parts.speech, foreignNames)),
        intent: cleanValue(cutForeignLines(parts.intent, foreignNames)),
        thoughts: cleanValue(parts.thoughts),
    };
    if (!result.speech && !result.intent) {
        throw new ParseError('Герой не дал ни реплики, ни намерения', raw);
    }
    return result;
}

function parseLabeled(text) {
    const matches = [...text.matchAll(LABEL_LINE)];
    if (!matches.length) return null;

    const parts = { speech: '', intent: '', thoughts: '' };
    matches.forEach((match, index) => {
        const field = LABEL_TO_FIELD[match[1].toUpperCase()];
        const start = match.index + match[0].length;
        const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
        const value = text.slice(start, end).trim();
        // Повтор метки: дописываем, а не затираем.
        parts[field] = parts[field] ? `${parts[field]}\n${value}` : value;
    });
    return parts;
}

function parseJson(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let json;
    try {
        json = JSON.parse(match[0]);
    } catch {
        return null;
    }
    if (!json || typeof json !== 'object') return null;

    const pick = (field) => {
        for (const [key, value] of Object.entries(json)) {
            if (LABEL_TO_FIELD[key.toUpperCase()] === field && typeof value === 'string') return value;
        }
        return '';
    };
    const parts = { speech: pick('speech'), intent: pick('intent'), thoughts: pick('thoughts') };
    return parts.speech || parts.intent || parts.thoughts ? parts : null;
}

// Риск из ТЗ: герой начинает говорить за другого. Обрезаем текст со строки «Имя:».
function cutForeignLines(value, foreignNames) {
    if (!value || !foreignNames.length) return value;
    const lines = value.split('\n');
    const index = lines.findIndex((line) => {
        const head = line.replace(/^[\s*_>]+/, '');
        return foreignNames.some((name) => name && head.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    });
    return index === -1 ? value : lines.slice(0, index).join('\n');
}

function cleanValue(value) {
    let result = String(value ?? '').trim();
    // Снимаем обёртку из звёздочек и кавычек: **«Привет»** → Привет.
    for (let i = 0; i < 3; i++) {
        const before = result;
        result = result.replace(/^\*{1,2}([\s\S]*?)\*{1,2}$/, '$1').trim();
        result = result.replace(/^[«"“]([^«»"“”]*)[»"”]$/, '$1').trim();
        if (result === before) break;
    }
    return EMPTY_VALUES.has(result.toLowerCase()) ? '' : result;
}

// [NEXT: hero1], [NEXT hero2], [СЛЕДУЮЩИЙ: мастер], [NEXT: Арен]
const NEXT_TAG = /\[\s*(?:NEXT|СЛЕДУЮЩИЙ|ДАЛЕЕ)\s*[:=—–-]?\s*([^\]]*)\]/gi;
// Без скобок, отдельной строкой: «NEXT: hero1», «**Следующий:** Лиа»
const NEXT_LINE = /^[ \t*_]*(?:NEXT|СЛЕДУЮЩИЙ|ДАЛЕЕ)[ \t*_]*[:=—–-][ \t*_]*(.+?)[ \t*_]*$/gim;
// Конец сцены (FR-21): [КОНЕЦ СЦЕНЫ], [SCENE END], [END OF SCENE], [END_SCENE], [СЦЕНА ЗАВЕРШЕНА]
const SCENE_END_TAG = /\[\s*(?:КОНЕЦ[\s_-]*СЦЕНЫ|СЦЕНА[\s_-]*ЗАВЕРШЕНА|SCENE[\s_-]*END|END[\s_-]*(?:OF[\s_-]*)?SCENE)\s*\]/gi;

/**
 * Разбирает ответ мастера: видимый текст, метки бросков и выбор следующего.
 * @param {string} raw
 * @param {object} [options]
 * @param {string[]} [options.heroNames] имена героя 1 и героя 2, чтобы понять «[NEXT: Арен]»
 * @returns {{text: string, next: 'hero1'|'hero2'|'master'|null, rolls: ReturnType<typeof parseRollTags>, sceneEnd: boolean,
 *   changes: ReturnType<typeof extractStateChanges>['changes']}} changes — изменения HP, статов и инвентаря (FR-15)
 */
export function parseMasterResponse(raw, { heroNames = [] } = {}) {
    const trimmed = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
    if (!trimmed) throw new ParseError('Пустой ответ мастера', raw);
    // Блок изменений вырезаем первым: внутри JSON могут быть скобки и слова, похожие на метки.
    const { text: source, changes } = extractStateChanges(trimmed, heroNames);

    let next = null;
    for (const match of [...source.matchAll(NEXT_TAG), ...source.matchAll(NEXT_LINE)]) {
        next = normalizeNext(match[1], heroNames) ?? next;
    }

    const rolls = parseRollTags(source);
    const sceneEnd = SCENE_END_TAG.test(source);
    SCENE_END_TAG.lastIndex = 0;
    let text = stripRollTags(source.replace(NEXT_TAG, '').replace(NEXT_LINE, '').replace(SCENE_END_TAG, ''));
    text = text.replace(/^\s*\**(?:Мастер|Master|DM)\**\s*:\s*/i, '').trim();
    // Мастер не говорит за героев: строки «Мира: ...» и «**Мира:** ...» вырезаем, у героев свои ходы.
    text = dropSpeakerLines(text, heroNames);
    if (!text) throw new ParseError('В ответе мастера нет текста, только служебные метки', raw);

    return { text, next, rolls, sceneEnd, changes };
}

function dropSpeakerLines(text, names) {
    const valid = names.filter(Boolean).map((name) => name.toLowerCase());
    if (!valid.length) return text;
    const kept = text.split('\n').filter((line) => {
        const head = line.replace(/^[\s*_>«"-]+/, '').toLowerCase();
        return !valid.some((name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[*_\\s]*:`).test(head));
    });
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Приводит «hero1», «Герой 2», «мастер» или имя героя к hero1 / hero2 / master.
 * @returns {'hero1'|'hero2'|'master'|null}
 */
export function normalizeNext(value, heroNames = []) {
    const v = String(value ?? '').toLowerCase().replace(/[*_`"«»]/g, '').trim();
    if (!v) return null;
    if (/hero\s*1|герой\s*1/.test(v)) return 'hero1';
    if (/hero\s*2|герой\s*2/.test(v)) return 'hero2';
    if (/master|мастер|\bdm\b/.test(v)) return 'master';
    const index = heroNames.findIndex((name) => name && v.includes(name.toLowerCase()));
    return index === 0 ? 'hero1' : index === 1 ? 'hero2' : null;
}
