// Сборщики промптов мастера (FR-08) и героев (FR-12, NFR-01).
// Модуль без зависимостей от ST: карточки персонажей передаёт вызывающий код, поэтому изоляцию можно проверить тестом.
//
// Изоляция: промпт героя собирается только из его собственных полей и видимой части ходов.
// Мысли, цели и микроцель другого героя сюда не передаются вообще, а не вырезаются потом.
// Этапы 11–13: героев 1–10, ходы видны только своей группе (src/heroes.js), режимы «Приключение» и «Романтика» (src/modes.js).

import { STATS, abilityModifier } from './dice.js';
// Навыки 5e (PLAN 6.3) отключены по просьбе пользователя, код оставлен закомментированным.
// import { PROFICIENCY_BONUS, SKILLS, SKILL_IDS } from './dice.js';
import { ABILITY_MAX_LEVEL, formatAbilities } from './abilities.js';
import { KNOCKOUT_HOURS, conditionText, formatClock, isActive } from './vitality.js';
import {
    DEFAULT_GROUP, GROUPS, canSee, groupMembers, hasManyGroups, heroById, heroGroup, heroId, memoryGroup, turnGroup,
} from './heroes.js';
import { ADULT_RULE, isRomance } from './modes.js';

// Сколько последних ходов попадает в промпт. Более старые сжимаются в память (src/memory.js, FR-26).
export const HISTORY_LIMIT = 40;
const CARD_LIMIT = 3000;

/**
 * @typedef {object} PromptCard то, что нужно из карточки ST
 * @property {string} name
 * @property {string} [description]
 * @property {string} [personality]
 * @property {string} [scenario]
 */

/**
 * Инструкция языка игры (NFR-06). Одна на все промпты, чтобы язык карточки не перебивал настройку.
 * @param {string} language
 * @param {string} [subject] что именно писать на этом языке
 */
export function languageRule(language, subject = 'Весь текст') {
    return `${subject} пиши на языке: ${language || 'русский'}. Это правило важнее языка карточек и примеров: даже если карточка на другом языке, отвечай на языке игры (имена собственные можно не переводить).`;
}

const ROLL_FORMAT = [
    '  Формат метки: [ROLL d20 ПРОВЕРКА DCn ГЕРОЙ], где n — сложность 5–25, ГЕРОЙ — id героя (hero1, hero2, …),',
    '  ПРОВЕРКА — характеристика STR, DEX, CON, INT, WIS, CHA или, если герой применяет уникальную способность, её название из листа.',
    // Навыки 5e (PLAN 6.3) отключены:
    // `  ПРОВЕРКА — навык 5e (${SKILL_IDS.join(', ')}) или, если ни один навык не подходит, характеристика STR, DEX, CON, INT, WIS, CHA.`,
    '  Примеры: [ROLL d20 DEX DC12 hero1], [ROLL d20 Огненный шар DC14 hero2]',
];

// Уникальные способности (PLAN 6.4, FR-31): сила растёт с уровнем, применение прокачивает.
const ABILITY_RULES = [
    `- Уникальные способности героев — их главная сила. Уровень 1–${ABILITY_MAX_LEVEL}: чем выше, тем мощнее эффект (урон, дальность, длительность, масштаб). Описывай эффект соответственно уровню.`,
    '  Каждое применение прокачивает способность. Применение с неочевидным исходом проверяй броском по названию способности (к броску прибавится её уровень);',
    '  применение без броска отметь в блоке STATE полем "use": [ROLL] и "use" для одного применения вместе не ставь.',
];

// Изменения листа героя (FR-15): мастер пишет их отдельным блоком, код применяет.
const STATE_RULES = [
    '- Если у героя изменились HP, статы или инвентарь (урон, лечение, нашёл, потерял, потратил предмет), добавь отдельной строкой блок:',
    '  [STATE {"hero1": {"hp": -5, "add": ["ржавый ключ"], "remove": ["факел"]}, "hero2": {"stats": {"STR": -1}, "use": ["Теневой шаг"]}}]',
    '  hp и stats — изменения со знаком, а не новые значения; add и remove — предметы; use — применённые без броска способности. Указывай только то, что изменилось. Нет изменений — нет блока.',
    '  Урон и потерю предметов давай только как исход действий или событий, броски не выдумывай.',
    '  Статы (stats) меняй редко: только за тяжёлое увечье, проклятие или поворотное достижение, а не за обычный успех.',
    '  Если прошло заметное игровое время (отдых, ночь, дорога, ожидание), добавь в блок "time" — сколько часов прошло: [STATE {"time": 8}].',
];

// Что бывает при HP 0 (новое, PLAN 8.5): настройка «При HP 0».
function deathRule(deathMode) {
    return deathMode === 'death'
        ? '- При HP 0 герой погибает навсегда. Смертельный урон давай только как прямое следствие риска или провала, не случайно.'
        : `- При HP 0 герой не умирает, а теряет сознание минимум на ${KNOCKOUT_HOURS} ч игрового времени: очнётся, только когда пройдёт это время (его считает код по "time"). Урон давай честно.`;
}

// Герои — игроки: мастер не решает за них (наблюдение этапа 2, приёмка PLAN 8.2).
const HERO_AGENCY_RULES = [
    '- Герои — живые игроки. Их действия, слова, решения, передвижения, чувства и мысли пишут только они сами.',
    '  Ты описываешь лишь результат того, что герой уже заявил в своём ходе, и то, что с ним делает мир (удар, падение, рана).',
    '  Нельзя: «Мира отступает», «Grokk соглашается», «она понимает, что должна…», «он решает её защитить», «его охватывает ярость».',
    '- Хочешь, чтобы герой что-то сделал, — дай повод (угроза, вопрос NPC, находка, звук) и передай ему ход через [NEXT].',
    '- Последствия для тела и вещей героя (рана, падение, яд, ожог, сломанный предмет) — это действие мира, а не решение за героя: описывай их и отражай в блоке STATE.',
];

// Мир опасен (доработка после приёмки, PLAN 8.6): без этого мастер почти не наносил урон даже на провалах.
const DAMAGE_RULES = [
    '- Мир опасен, не щади героев. Провал (❌) рискованного действия, удар врага, ловушка, падение, яд, огонь отнимают HP: каждый такой исход — урон в блоке STATE (hp со знаком минус).',
    '  Ориентир урона (у героев 10–20 HP): лёгкий 1–3, обычный удар или падение 3–7, тяжёлый 6–10, смертельная угроза 10–15. Натуральная 1 — заметный урон или потеря предмета.',
    '  Без урона обходятся только провалы без опасности: не убедил, не нашёл, не понял.',
];

// Романтика 18+ (новое, FR-37): без кубиков, хитов и боя; мастер меняет отношения героев.
const ROMANCE_RULES = [
    '- Кубиков, хитов, боя и смерти в этой истории нет: исход поступков определяй сам, исходя из характеров, чувств и обстоятельств.',
    '- Веди сюжет к встречам, искушениям, признаниям и выбору: давай героям поводы сблизиться, поссориться, приревновать, открыться.',
    '- Если изменилось отношение героя к другому герою (влюблённость, ревность, обида, доверие), добавь отдельной строкой блок:',
    '  [STATE {"hero1": {"relations": {"hero2": "влюблена, но боится признаться"}}}]',
    '  relations — новое отношение целиком, короткой строкой; меняй его, только когда в сцене случилось что-то важное для двоих.',
    '  Предметы — "add" и "remove". Если прошло заметное игровое время, добавь "time" в часах: [STATE {"time": 8}]. Нет изменений — нет блока.',
];

// Уход из сцены и переход между группами (новое, FR-35).
const MOVE_RULES = [
    '- Если герой уходит из сцены один (уезжает, уходит в другое место без остальных, засыпает надолго), отметь это в блоке STATE: {"hero2": {"leave": true}} — он перестанет действовать, пока его не вернут.',
    '  Если герой возвращается в сцену или присоединяется к другой группе, укажи её букву: {"hero2": {"group": "A"}}.',
];

// Изолированные группы (новое, FR-34): мастер ведёт одну группу за раз.
function groupRules(state, focus) {
    const lines = GROUPS.map((group) => {
        const names = groupMembers(state, group).map((index) => state.heroes[index].name);
        return names.length ? `${group} — ${names.join(', ')}` : '';
    }).filter(Boolean);
    const away = state.heroes.filter((hero) => heroGroup(hero) === null).map((hero) => hero.name);
    if (away.length) lines.push(`вне сцены — ${away.join(', ')}`);
    return [
        '',
        '### ГРУППЫ',
        `Группы: ${lines.join('; ')}. Сейчас в фокусе группа ${focus}.`,
        '- Группы находятся в разных местах и не видят и не слышат друг друга. Пиши только о том, что происходит с группой в фокусе и вокруг неё.',
        '- Герои одной группы не знают, что говорят и делают другие. Передать весть можно только событием в сцене группы-получателя (гонец, письмо, слух, далёкий крик), когда ты ведёшь её.',
        '- Чтобы перейти к другой группе, поставь [NEXT: master B] или назови героя из неё: следующий ход начнётся с твоего описания для этой группы.',
        '- Встретились группы — переведи героев в одну группу блоком STATE с "group".',
    ];
}

const NO_OUTCOME_BEFORE_ROLL = '  До броска не описывай ни успеха, ни провала, ни урона и не ставь блок STATE: всё это будет в описании исхода после броска.';

// Правила бросков зависят от настройки «Частота проверок»: в этом ходе бросок обязателен, запрещён или на усмотрение мастера.
function checkRules(check) {
    if (check.mode === 'forbidden') return ['- Метки броска [ROLL ...] в этом ходе не ставь: исход действий определи сам.'];
    const lead = check.mode === 'required'
        ? '- Действие героя в этом ходе требует проверки: поставь метку броска и остановись на моменте попытки, исход не описывай: его опишешь после броска.'
        : '- Если исход действия героя неочевиден, поставь метку броска и остановись на моменте попытки, исход не описывай: его опишешь после броска.';
    return [lead, NO_OUTCOME_BEFORE_ROLL, ...ROLL_FORMAT];
}

function checkTask(check) {
    if (check.mode === 'required') {
        const task = `Последнее действие ${check.hero ?? 'героя'} проверь броском: поставь ровно одну метку [ROLL d20 СТАТ DCn ${check.hero ?? 'hero1'}] с подходящим статом и сложностью и остановись на попытке.`;
        // Переспрос (PLAN 8.2): мастер в первый раз метку не поставил.
        return check.reminder ? `В прошлом ответе ты не поставил обязательную метку броска. Ответь заново. ${task} Без метки ответ не принимается.` : task;
    }
    if (check.mode === 'forbidden') return 'Бросков в этом ходе нет.';
    return '';
}

/**
 * Промпт мастера: мир, герои группы в фокусе целиком, остальные кратко, история сцены, записка пользователя.
 * @param {object} params
 * @param {object} params.state состояние игры из chatMetadata
 * @param {Array<PromptCard|null>} params.cards карточки героев по порядку
 * @param {string} params.language язык игры
 * @param {'turn'|'outcome'} [params.mode] turn — обычный ход, outcome — описать исход после бросков
 * @param {{mode: 'free'|'required'|'forbidden', hero?: string}} [params.check] нужна ли проверка кубиком в этом ходе
 *   (настройка «Частота проверок»): free — решает мастер, required — обязательна для героя hero, forbidden — без бросков;
 *   reminder — переспрос, когда обязательную метку мастер не поставил
 * @param {'knockout'|'death'} [params.deathMode] настройка «При HP 0» (PLAN 8.5)
 * @param {{focus?: string, cut?: boolean, wanted?: string}} [params.scene] группа в фокусе (FR-34); cut — мастер только что
 *   перешёл к ней; wanted — герой, которому после описания передать ход
 * @returns {Array<{role: string, content: string}>}
 */
export function buildMasterPrompt({ state, cards, language, mode = 'turn', check = { mode: 'free' }, deathMode = 'knockout', scene = {} }) {
    const names = state.heroes.map((hero) => hero.name);
    const romance = isRomance(state);
    const many = hasManyGroups(state);
    const focus = scene.focus ?? DEFAULT_GROUP;
    const clockHours = state.clock?.hours ?? 0;
    const players = names.length === 1
        ? `Герой (${names[0]}) — отдельный игрок. Ты никогда не пишешь его реплики, мысли, чувства и решения: только мир, NPC и последствия его действий.`
        : `Герои (${names.join(', ')}) — отдельные игроки. Ты никогда не пишешь их реплики, мысли, чувства и решения: только мир, NPC и последствия действий героев.`;
    const ids = state.heroes.map((_, index) => `[NEXT: ${heroId(index)}]`).join(', ');
    const system = [
        romance
            ? 'Ты — Мастер-рассказчик взрослой романтической истории. Ты описываешь мир, обстановку и настроение момента, озвучиваешь всех NPC и ведёшь сюжет.'
            : 'Ты — Мастер (DM) настольной ролевой игры по правилам D&D 5e. Ты рассказчик, судья исходов и голос всех NPC.',
        ...(romance ? [ADULT_RULE] : []),
        players,
        languageRule(language),
        '',
        '### ПРАВИЛА ОТВЕТА',
        '- Коротко: 1–2 абзаца, не больше 100 слов. Третье лицо, настоящее время.',
        '- Твоя часть — результат действий героев, реакция мира, глобальные события и речь NPC (прямой речью).',
        '- Не пересказывай и не цитируй реплики героев, не пиши за них ни слова, ни мыслей, ни новых действий: их реплики уже есть в истории, герои говорят сами.',
        ...HERO_AGENCY_RULES,
        ...(romance ? ROMANCE_RULES : [
            ...checkRules(check),
            ...STATE_RULES,
            ...DAMAGE_RULES,
            deathRule(deathMode),
            ...ABILITY_RULES,
        ]),
        ...MOVE_RULES,
        `- Последней строкой всегда выбери, кто действует дальше: ${ids} или [NEXT: master] (если сцене нужно ещё твоё описание)${many ? ', [NEXT: master B] — перейти к группе B' : ''}. Героя без сознания, погибшего или ушедшего из сцены не выбирай.`,
        '- Двигай сюжет к глобальным целям героев, давай поводы для микроцелей, но не раскрывай одному герою тайны другого.',
        '- Когда сцена логически завершена (цель сцены достигнута или провалена, герои покидают место, наступает пауза в событиях), опиши финал и поставь отдельной строкой метку [КОНЕЦ СЦЕНЫ] перед [NEXT: ...]. Не ставь её посреди событий.',
        ...(many ? groupRules(state, focus) : []),
        '',
        '### МИР',
        formatWorld(state.world),
        `Игровое время: ${formatClock(clockHours)}`,
        '',
        ...state.heroes.flatMap((hero, index) => (!many || heroGroup(hero) === focus
            ? fullHero(state, hero, index, cards[index], clockHours, many)
            : shortHero(state, hero, index, clockHours))),
    ];

    let task = masterTask(state, mode, { focus, cut: scene.cut, wanted: scene.wanted, many });
    if (mode !== 'outcome' && !romance) task = [task, checkTask(check)].filter(Boolean).join(' ');
    if (!romance) task = [task, downReminder(state)].filter(Boolean).join(' ');

    const user = [
        ...formatMemory(state, 'master'),
        '### ИСТОРИЯ СЦЕНЫ',
        formatHistory(state, { viewer: 'master' }) || '(сцена ещё не началась)',
        '',
    ];
    if (state.session?.masterNote) {
        user.push('### ЗАПИСКА ОТ ПОЛЬЗОВАТЕЛЯ (выполни в этом ходе, героям не раскрывай)', state.session.masterNote, '');
    }
    user.push('### ЗАДАНИЕ', task);

    return [
        { role: 'system', content: system.join('\n') },
        { role: 'user', content: user.join('\n') },
    ];
}

// Герой группы в фокусе (или единственной группы): карточка, лист, цели, мысли.
function fullHero(state, hero, index, card, clockHours, many) {
    const companion = companionNames(state, index)[0] ?? 'собеседник';
    return [
        `### ГЕРОЙ ${index + 1}: ${hero.name} (${heroId(index)})${many ? ` — группа ${heroGroup(hero)}` : ''}`,
        formatCard(card, hero.name, companion),
        `Состояние: ${conditionText(hero, clockHours)}`,
        isRomance(state) ? formatRomanceSheet(hero) : formatSheet(hero),
        `Глобальная цель: ${hero.globalGoal || '—'}`,
        `Микроцель (тайная, знают только этот герой и ты): ${hero.microGoal || '—'}`,
        `Последние мысли: ${lastThoughts(state, index) || '—'}`,
        '',
    ];
}

// Герой другой группы или вне сцены: без карточки и листа, чтобы промпт не разрастался при 10 героях.
function shortHero(state, hero, index, clockHours) {
    const group = heroGroup(hero);
    return [
        `### ГЕРОЙ ${index + 1}: ${hero.name} (${heroId(index)}) — ${group ? `группа ${group}, сейчас не в фокусе` : 'вне сцены'}`,
        `Состояние: ${conditionText(hero, clockHours)}`,
        `Глобальная цель: ${hero.globalGoal || '—'}`,
        `Микроцель (тайная): ${hero.microGoal || '—'}`,
        '',
    ];
}

/** Имена других героев группы этого героя (без ушедших из сцены). */
export function companionNames(state, index) {
    const group = heroGroup(state.heroes[index]);
    if (!group) return [];
    return groupMembers(state, group).filter((other) => other !== index).map((other) => state.heroes[other].name);
}

/**
 * Промпт героя: мир, своя карточка, свой лист, цели, микроцель, мысли и видимая история своей группы.
 * @param {object} params
 * @param {object} params.state
 * @param {number} params.heroIndex
 * @param {PromptCard} params.card карточка только этого героя
 * @param {string} params.language
 * @returns {Array<{role: string, content: string}>}
 */
export function buildHeroPrompt({ state, heroIndex: index, card, language }) {
    const hero = state.heroes[index];
    const id = heroId(index);
    const romance = isRomance(state);
    const companions = companionNames(state, index);

    const system = [
        romance
            ? `Ты играешь персонажа ${hero.name} во взрослой романтической истории. Ведущий — Мастер: он описывает мир, озвучивает NPC и решает, чем обернутся твои поступки.`
            : `Ты играешь персонажа ${hero.name} в настольной ролевой игре. Ведущий — Мастер: он описывает мир, озвучивает NPC и решает исходы действий.`,
        ...(romance ? [ADULT_RULE] : []),
        companions.length
            ? `Рядом с тобой ${companions.length === 1 ? 'второй герой' : 'другие герои'} — ${companions.join(', ')}. Ты говоришь и действуешь только за ${hero.name}.`
            : `Других героев рядом нет: вокруг только мир и NPC, которых озвучивает Мастер. Ты говоришь и действуешь только за ${hero.name}.`,
        `Никогда не пиши реплики и действия за ${[...companions, 'Мастера'].join(', ')} и не описывай исход своих действий — его решит Мастер.`,
        ...(hasManyGroups(state) ? [`Твоя группа: ${heroGroup(hero) ?? 'вне сцены'}. Ты знаешь только то, что видел и слышал сам.`] : []),
        languageRule(language),
        '',
        '### МИР',
        formatWorld(state.world),
        '',
        '### ТВОЯ КАРТОЧКА',
        formatCard(card, hero.name, companions[0] ?? 'собеседник'),
        '',
        '### ТВОЙ ЛИСТ ПЕРСОНАЖА',
        romance ? formatRomanceSheet(hero) : formatSheet(hero),
        '',
        '### ТВОЯ ГЛОБАЛЬНАЯ ЦЕЛЬ',
        hero.globalGoal || '—',
        '',
        `### ТВОЯ ТАЙНАЯ МИКРОЦЕЛЬ (${companions.length ? 'другие герои о ней не знают' : 'о ней знаешь только ты'})`,
        hero.microGoal || '—',
        '',
        romance
            ? 'Действуй по своим чувствам и желаниям. Как далеко зайти, решаешь ты сам, по характеру и тому, как складываются отношения.'
            : 'Твои уникальные способности — твоя сила, применяй их, когда это уместно: чем чаще применяешь, тем сильнее они становятся. Исход применения решает Мастер.',
        '',
        '### ФОРМАТ ОТВЕТА',
        'Ровно три части с метками, без другого текста:',
        'РЕПЛИКА: что ты говоришь вслух, не больше одного абзаца (или «—», если молчишь)',
        'НАМЕРЕНИЕ: что ты пытаешься сделать, одним-двумя предложениями, без исхода',
        'МЫСЛИ: что ты думаешь на самом деле; это видишь только ты',
    ];

    const user = [
        ...formatMemory(state, id),
        '### ЧТО ПРОИСХОДИЛО',
        formatHistory(state, { viewer: id }) || '(сцена ещё не началась)',
        '',
        `Твой ход, ${hero.name}.`,
    ];

    return [
        { role: 'system', content: system.join('\n') },
        { role: 'user', content: user.join('\n') },
    ];
}

/**
 * История сцены глазами viewer: последние HISTORY_LIMIT ходов после сжатой памяти.
 * master видит всё, включая мысли героев и все группы (с метками групп, если их больше одной).
 * Герой видит ходы своей группы за время, пока он в ней, свои ходы и только свои мысли (FR-12, FR-34).
 * @param {object} state
 * @param {object} options
 * @param {string} options.viewer master или heroN
 */
export function formatHistory(state, { viewer }) {
    return formatTurns(state, visibleTurns(state, viewer).slice(-HISTORY_LIMIT), { viewer, groups: viewer === 'master' && hasManyGroups(state) });
}

/** Несжатые ходы, которые видит viewer (master — все). */
export function visibleTurns(state, viewer) {
    const upTo = state.memory?.upTo ?? 0;
    const live = state.turns.filter((turn) => turn.n > upTo);
    const hero = heroById(state, viewer);
    return hero ? live.filter((turn) => canSee(hero, viewer, turn)) : live;
}

/**
 * Ходы глазами viewer. public — без чьих-либо мыслей (для общей памяти).
 * @param {object} state
 * @param {object[]} turns
 * @param {object} options
 * @param {string} options.viewer master, heroN или public
 * @param {boolean} [options.groups] подписать группу хода: «[B] Мастер: …»
 */
export function formatTurns(state, turns, { viewer, groups = false }) {
    return turns.map((turn) => {
        const tag = groups ? `[${turnGroup(turn)}] ` : '';
        if (turn.author === 'master') {
            const lines = [`${tag}Мастер: ${turn.text}`];
            for (const roll of turn.rolls ?? []) lines.push(roll.line);
            for (const change of turn.changes ?? []) lines.push(`📋 ${change}`);
            return lines.join('\n');
        }

        const name = heroById(state, turn.author)?.name ?? turn.author;
        const own = viewer === turn.author;
        // Без мастера (этап 10): ход — одно сообщение без реплики и намерения.
        if (turn.text && !turn.speech && !turn.intent) return `${tag}${own ? `Ты (${name})` : name}: ${turn.text}`;
        const lines = [`${tag}${own ? `Ты (${name})` : name}: ${turn.speech ? `«${turn.speech}»` : '(молчит)'}`];
        if (turn.intent) lines.push(`  действие: ${turn.intent}`);
        if (turn.thoughts && (own || viewer === 'master')) {
            lines.push(`  ${own ? 'твои мысли' : 'мысли'}: ${turn.thoughts}`);
        }
        return lines.join('\n');
    }).join('\n\n');
}

/**
 * Общая память по группам (FR-26, FR-34). В чатах до этапа 13 память одна — это память группы A.
 * @returns {Record<string, string>}
 */
export function groupMemories(memory) {
    const groups = { ...(memory?.groups ?? {}) };
    if (memory?.public && !groups[DEFAULT_GROUP]) groups[DEFAULT_GROUP] = memory.public;
    return groups;
}

/**
 * Блок памяти (FR-26). Общую память группы видят её герои, мастер — все группы.
 * Пересказ мыслей героя — только он сам и мастер (NFR-01).
 * @param {object} state
 * @param {string} viewer master или heroN
 * @returns {string[]} строки промпта, пусто, если памяти нет
 */
export function formatMemory(state, viewer) {
    const memory = state.memory;
    if (!memory?.upTo) return [];
    const groups = groupMemories(memory);
    const lines = [];
    if (viewer === 'master' && hasManyGroups(state)) {
        for (const group of GROUPS) {
            if (groups[group]) lines.push(`### ПАМЯТЬ ГРУППЫ ${group}: ЧТО БЫЛО РАНЬШЕ`, groups[group], '');
        }
        if (!lines.length) lines.push('### ПАМЯТЬ: ЧТО БЫЛО РАНЬШЕ', '—', '');
    } else {
        const hero = heroById(state, viewer);
        lines.push('### ПАМЯТЬ: ЧТО БЫЛО РАНЬШЕ', groups[hero ? memoryGroup(hero) : DEFAULT_GROUP] || '—', '');
    }
    state.heroes.forEach((hero, index) => {
        const id = heroId(index);
        const thoughts = memory.thoughts?.[id];
        if (!thoughts || (viewer !== 'master' && viewer !== id)) return;
        const title = viewer === id ? 'ТВОИ ПРЕЖНИЕ МЫСЛИ' : `ПРЕЖНИЕ МЫСЛИ ГЕРОЯ ${index + 1} (${hero.name ?? id})`;
        lines.push(`### ${title}`, thoughts, '');
    });
    return lines;
}

// Без "time" часы стоят, и отключённый герой не очнётся никогда (повторный прогон приёмки, PLAN 8.5).
function downReminder(state) {
    const down = state.heroes.filter((hero) => hero.condition === 'down');
    if (!down.length) return '';
    const clock = state.clock?.hours ?? 0;
    const who = down.map((hero) => `${hero.name} (ещё ${Math.max(0, Math.round(((hero.downUntil ?? 0) - clock) * 10) / 10)} ч)`).join(', ');
    return `Без сознания: ${who}. Если в этом ходе проходит игровое время, обязательно укажи его в блоке [STATE {"time": часы}], иначе герой не очнётся. Не описывай, что он приходит в себя: это покажет код, когда пройдёт время.`;
}

function masterTask(state, mode, { focus = DEFAULT_GROUP, cut = false, wanted = '', many = false } = {}) {
    if (mode === 'outcome') {
        return 'Броски выше уже сделаны. Опиши исход строго по их результатам (✅ успех, ❌ провал): только результат заявленного действия, дальше героев не веди. Если провал опасен (бой, ловушка, высота, магия), нанеси урон блоком STATE. Новых меток броска не ставь. Последней строкой — [NEXT: ...].';
    }
    const members = many ? groupMembers(state, focus).map((index) => state.heroes[index]) : state.heroes;
    if (members.length && !members.some(isActive)) {
        const who = many ? `Все герои группы ${focus}` : state.heroes.length === 1 ? 'Герой' : 'Все герои';
        return `${who} сейчас не могут действовать. Опиши, что происходит вокруг них, и промотай время блоком STATE с "time", пока кто-то не очнётся. Последней строкой — [NEXT: master].`;
    }
    const pass = wanted ? ` Последней строкой передай ход ${heroById(state, wanted)?.name ?? wanted}: [NEXT: ${wanted}].` : ' Последней строкой — [NEXT: ...].';
    const groupTurns = state.turns.filter((turn) => !many || turnGroup(turn) === focus);
    if (!groupTurns.length) {
        const premise = state.scene?.premise?.trim();
        const where = many ? `Начни сцену группы ${focus} (${members.map((hero) => hero.name).join(', ')}): место, обстановка, что происходит прямо сейчас, где находятся герои.` : 'Начни сцену: место, обстановка, что происходит прямо сейчас, где находятся герои.';
        return `${where} ${premise
            ? `Завязка от пользователя: ${withPeriod(premise)}`
            : 'Завязки нет: придумай её сам, исходя из мира, предыстории и целей героев, и сразу дай героям повод действовать.'}${pass}`;
    }
    if (cut) {
        return `Действие переходит к группе ${focus} (${members.map((hero) => hero.name).join(', ')}). Опиши, что происходит с ними сейчас, пока ты вёл другие группы, и дай им повод действовать. События других групп им неизвестны.${pass}`;
    }
    // Мастер → мастер: героям ещё нечего было сказать, и именно тут мастер чаще всего двигал их сам (приёмка, PLAN 8.2).
    const again = groupTurns[groupTurns.length - 1].author === 'master'
        ? ' Прошлый ход тоже был твоим, герои ещё не ответили: не двигай их, а дай им повод действовать.'
        : '';
    return `Продолжи сцену: опиши последствия последнего действия и реакцию мира и NPC.${again}${pass}`;
}

function withPeriod(text) {
    return /[.!?…»"]$/.test(text) ? text : `${text}.`;
}

function lastThoughts(state, index) {
    const id = heroId(index);
    for (let i = state.turns.length - 1; i >= 0; i--) {
        if (state.turns[i].author === id && state.turns[i].thoughts) return state.turns[i].thoughts;
    }
    return '';
}

export function formatWorld(world) {
    if (!world) return '—';
    return [
        `Сеттинг: ${world.setting || '—'}`,
        `Эпоха: ${world.era || '—'}`,
        `Тон: ${world.tone || '—'}`,
        `Уровень силы: ${world.powerLevel || '—'}`,
        'Правила мира:',
        ...(world.rules?.length ? world.rules.map((rule) => `- ${rule}`) : ['- —']),
    ].join('\n');
}

export function formatCard(card, name, otherName) {
    if (!card) return '(карточка не найдена)';
    const parts = [
        card.description && `Описание: ${card.description}`,
        card.personality && `Характер: ${card.personality}`,
        card.scenario && `Предыстория: ${card.scenario}`,
    ].filter(Boolean);
    const text = substituteMacros(parts.join('\n'), name, otherName);
    return text.length > CARD_LIMIT ? `${text.slice(0, CARD_LIMIT)}…` : text || '(карточка пустая)';
}

// В карточках ST встречаются {{char}} и {{user}}. Здесь «user» — другой герой рядом.
function substituteMacros(text, name, otherName) {
    return text.replace(/\{\{char\}\}/gi, name).replace(/\{\{user\}\}/gi, otherName);
}

// Лист героя «Романтики» (FR-37): без статов, хитов и способностей.
function formatRomanceSheet(hero) {
    const relations = Object.entries(hero.relations ?? {}).filter(([, text]) => text).map(([name, text]) => `${name} — ${text}`);
    return [
        `Отношения: ${relations.length ? relations.join('; ') : '—'}`,
        `Инвентарь: ${hero.inventory?.length ? hero.inventory.join(', ') : '—'}`,
    ].join('\n');
}

function formatSheet(hero) {
    const stats = STATS.map((stat) => {
        const score = hero.stats?.[stat] ?? 10;
        const mod = abilityModifier(score);
        return `${stat} ${score} (${mod >= 0 ? '+' : ''}${mod})`;
    }).join(', ');
    const inventory = hero.inventory?.length ? hero.inventory.join(', ') : '—';
    // Навыки 5e (PLAN 6.3) отключены:
    // const skills = hero.skills?.length
    //     ? hero.skills.filter((id) => SKILLS[id]).map((id) => `${SKILLS[id].ru} (${id}, ${SKILLS[id].stat})`).join(', ')
    //     : '—';
    // ...`\nНавыки с владением (+${PROFICIENCY_BONUS} к проверке): ${skills}`
    return [
        `Статы: ${stats}`,
        `HP: ${hero.hp?.current ?? '?'}/${hero.hp?.max ?? '?'}`,
        ...formatAbilities(hero),
        `Инвентарь: ${inventory}`,
    ].join('\n');
}
