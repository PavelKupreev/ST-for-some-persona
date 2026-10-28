// Ходы игры: мастер → выбранный герой (FR-08), броски (FR-13, FR-14), очерёдность (FR-09, FR-10).
// Этап 2 — «Один ход» по кнопке, этап 4 — те же шаги в цикле автосессии (src/autosession.js).
// Промпты собираются из state.turns, а не из сообщений чата: в чате мысли лежат спойлером,
// и брать их оттуда значило бы рисковать утечкой к другому герою (NFR-01).
// Этапы 11–14: до 10 героев, группы и фокус мастера (FR-34, FR-35), режимы (FR-33, FR-37), ход игрока (FR-36).

import { LOG_PREFIX } from './constants.js';
import { getSettings } from './settings.js';
import { getState, saveState } from './state.js';
import { callModel } from './llm.js';
import { postAsCharacter, postAsMaster } from './chat.js';
import { formatRoll, resolveCheck, rollDie } from './dice.js';
import { parseHeroResponse, parseMasterResponse, parsePlayerText, normalizeNext } from './parse.js';
import { buildHeroPrompt, buildMasterPrompt } from './prompts.js';
import { chooseNext, updateSilence } from './turnOrder.js';
import { consumeMasterNote } from './intervention.js';
import { applyStateChanges } from './heroState.js';
import { findAbility, useAbility } from './abilities.js';
import { applySummaries, buildSummaryPrompts, turnsToCompress } from './memory.js';
import { activeHeroes, applyVitality, heroCondition, hoursFromText, isActive } from './vitality.js';
import { buildDialoguePrompt, companions, dialogueNext, isDialogue, parseDialogueResponse } from './dialogue.js';
import { groupMembers, hasManyGroups, heroById, heroGroup, heroId, heroIndex, isHeroId, liveGroups, moveHero, turnGroup } from './heroes.js';
import { modelsFor, usesDice } from './modes.js';

const MASTER_MAX_TOKENS = 700;
const HERO_MAX_TOKENS = 500;
const DIALOGUE_MAX_TOKENS = 1500;
const SUMMARY_MAX_TOKENS = 600;

/**
 * Один ход одного актора: мастера (с бросками и описанием исхода) или героя, на кого указывает state.session.next.
 * Если ход сорвался, очередь не сдвигается: следующий вызов повторит его (FR-22).
 * Все герои погибли (настройка «При HP 0» = смерть) — хода нет, allDead: автосессия останавливается.
 * Очередь игрока (FR-36) — хода нет, playerTurn: автосессия ждёт игрока.
 * @returns {Promise<{author: string, report: string, sceneEnd: boolean, allDead?: boolean, playerTurn?: boolean, halt?: string}>}
 */
export async function playStep() {
    const state = requireGame();
    const chatId = SillyTavern.getContext().getCurrentChatId();
    if (isDialogue(state)) return dialogueStep(state, chatId);
    if (usesDice(state) && state.heroes.every((hero) => heroCondition(hero) === 'dead')) {
        return { author: 'none', report: '💀 Все герои погибли, игра окончена', sceneEnd: false, allDead: true };
    }
    if (!liveGroups(state).length) {
        return { author: 'none', report: '🚪 Все персонажи ушли из сцены: верните кого-нибудь в группу в «Персонажах»', sceneEnd: false, halt: 'все персонажи вне сцены' };
    }
    ensureFocus(state);

    let index = heroIndex(state.session.next);
    // Герой выбыл, пока ход ждал очереди (например, ранен в описании исхода): вместо него ходит мастер.
    if (index !== -1 && !isActive(state.heroes[index])) index = -1;
    // Герой другой группы: сначала мастер переходит к ней и описывает, что там сейчас (FR-34).
    if (index !== -1 && heroGroup(state.heroes[index]) !== state.session.focus) {
        switchFocus(state, heroGroup(state.heroes[index]), heroId(index));
        index = -1;
    }
    if (index !== -1 && heroId(index) === state.session.player) return waitForPlayer(state, index);

    const step = index === -1
        ? await masterTurn(state, chatId)
        : await heroTurn(state, index, chatId);
    return finishStep(state, step, chatId);
}

/**
 * После хода мастера или героя (в том числе игрока): молчание, выбор следующего, сохранение, сжатие памяти, отчёт.
 * @param {object} state
 * @param {{author: string, masterChoice?: string, sceneEnd?: boolean, detail?: string}} step
 */
async function finishStep(state, step, chatId) {
    const settings = getSettings();
    updateSilence(state.heroes, step.author);
    const choice = chooseNext({
        author: step.author,
        masterChoice: step.masterChoice,
        silence: state.heroes.map((hero) => hero.silence ?? 0),
        randomness: settings.randomness,
        silenceThreshold: settings.silenceThreshold,
        active: activeHeroes(state),
    });
    state.session.next = choice.next;
    state.turns[state.turns.length - 1].next = choice.next;
    await saveState();
    logChoice(state, step, choice);
    await compressMemory(state, chatId);

    const label = step.author === 'master' ? 'Мастер' : heroById(state, step.author)?.name ?? step.author;
    const reason = { random: ' (случайный выбор)', silence: ' (давно молчал)' }[choice.reason] ?? '';
    const lines = [`${label}${step.detail ? `: ${step.detail}` : ''} → ${describeNext(state)}${reason}`];
    if (step.sceneEnd) lines.push('🏁 Мастер отметил конец сцены');
    const allDead = usesDice(state) && state.heroes.every((hero) => heroCondition(hero) === 'dead');
    if (allDead) lines.push('💀 Все герои погибли, игра окончена');
    return { author: step.author, report: lines.join('\n'), sceneEnd: Boolean(step.sceneEnd), allDead };
}

// ---------- Группы и фокус мастера (FR-34) ----------

/** Группа в фокусе должна быть живой: иначе — группа первого героя в строю. */
function ensureFocus(state) {
    const groups = liveGroups(state);
    if (groups.includes(state.session.focus)) return;
    const first = state.heroes.find(isActive);
    state.session.focus = first ? heroGroup(first) : groups[0];
    state.session.cut = state.turns.length > 0;
}

/** Мастер переходит к другой группе: его следующий ход — описание для неё; wanted — кому потом передать ход. */
function switchFocus(state, group, wanted = '') {
    if (!group || group === state.session.focus) return;
    console.log(`${LOG_PREFIX} мастер переходит к группе ${group}${wanted ? ` ради ${wanted}` : ''}`);
    state.session.focus = group;
    state.session.cut = true;
    state.session.wanted = wanted;
    state.session.next = 'master';
}

/** Метка группы перед сообщением в чате, если групп больше одной. */
function withGroupTag(state, text, group) {
    return hasManyGroups(state) ? `<small class="rpga-group-tag">Группа ${group}</small>\n\n${text}` : text;
}

// ---------- Игрок (FR-36) ----------

function waitForPlayer(state, index) {
    state.session.awaitingPlayer = true;
    const name = state.heroes[index].name;
    return { author: 'none', report: `✍️ Ваш ход за ${name}: напишите его в поле ввода ST и нажмите «✍️ Сходить»`, sceneEnd: false, playerTurn: true, playerName: name };
}

/** Чей ход сейчас по очереди: heroN, master или null. */
export function expectedActor(state) {
    return isDialogue(state) ? dialogueNext(state) : state.session.next;
}

/**
 * Ход игрока (FR-36): текст из поля ввода ST уходит в чат от имени персонажа и в историю как ход героя.
 * @param {string} text
 * @returns {Promise<{author: string, report: string, sceneEnd: boolean, allDead?: boolean}>}
 */
export async function playPlayerTurn(text) {
    const state = requireGame();
    const chatId = SillyTavern.getContext().getCurrentChatId();
    const id = state.session.player;
    const index = heroIndex(id);
    const hero = state.heroes[index];
    if (!hero) throw new Error('Выберите в меню 🎲, за кого играть');
    if (expectedActor(state) !== id) throw new Error(`Сейчас не ход ${hero.name}`);
    const character = findCharacter(hero);
    if (!character) throw new Error(`Карточка «${hero.name}» не найдена в библиотеке ST`);
    const group = heroGroup(hero);

    if (isDialogue(state)) {
        const clean = String(text ?? '').trim();
        if (!clean) throw new Error('Пустой ход: напишите, что говорит или делает персонаж');
        state.turns.push({ n: state.turns.length + 1, author: id, group, text: clean, byPlayer: true });
        state.session.awaitingPlayer = false;
        await saveState();
        await postAsCharacter(character, withGroupTag(state, clean, group), { author: id, turn: state.turns.length, byPlayer: true });
        return finishDialogueStep(state, index, chatId);
    }

    const parsed = parsePlayerText(text);
    state.turns.push({ n: state.turns.length + 1, author: id, group, ...parsed, byPlayer: true });
    state.session.awaitingPlayer = false;
    await saveState();
    await postAsCharacter(character, withGroupTag(state, formatHeroMessage(parsed), group), { author: id, turn: state.turns.length, byPlayer: true });
    return finishStep(state, { author: id }, chatId);
}

/**
 * «Один ход» по кнопке (этап 2): ход мастера и, если он передал слово герою, ход этого героя.
 * @returns {Promise<string>} краткий отчёт для панели
 */
export async function playOneTurn() {
    const first = await playStep();
    const report = [first.report];
    const next = getState()?.session.next;
    if (first.author === 'master' && isHeroId(next) && next !== getState()?.session.player) {
        report.push((await playStep()).report);
    }
    return report.join('\n');
}

/**
 * Без мастера (PLAN 10.1, FR-33): одна реплика персонажа, чья очередь. Мастера, бросков и HP нет.
 * Ход сорвался — очередь та же, следующий вызов повторит реплику (FR-22).
 */
async function dialogueStep(state, chatId) {
    const id = dialogueNext(state);
    if (!id) {
        return { author: 'none', report: '🚪 Нет группы, где могут разговаривать двое: переведите персонажей в одну группу', sceneEnd: false, halt: 'не с кем разговаривать' };
    }
    const index = heroIndex(id);
    if (id === state.session.player) return waitForPlayer(state, index);
    const settings = getSettings();
    const hero = state.heroes[index];
    const character = findCharacter(hero);
    if (!character) throw new Error(`Карточка «${hero.name}» не найдена в библиотеке ST`);

    const raw = await callModel({
        role: id,
        model: settings.heroModel,
        messages: buildDialoguePrompt({ state, heroIndex: index, card: toPromptCard(character), language: settings.language }),
        maxTokens: DIALOGUE_MAX_TOKENS,
    });
    assertSameChat(chatId);
    const { text } = parseDialogueResponse(raw, { name: hero.name, otherNames: companions(state, index) });

    const group = heroGroup(hero);
    state.turns.push({ n: state.turns.length + 1, author: id, group, text });
    await saveState();
    await postAsCharacter(character, withGroupTag(state, text, group), { author: id, turn: state.turns.length });
    return finishDialogueStep(state, index, chatId);
}

async function finishDialogueStep(state, index, chatId) {
    state.session.next = dialogueNext(state) ?? 'hero1';
    state.turns[state.turns.length - 1].next = state.session.next;
    await saveState();
    await compressMemory(state, chatId);
    return { author: heroId(index), report: `${state.heroes[index].name} → ${describeNext(state)}`, sceneEnd: false, allDead: false };
}

function requireGame() {
    const state = getState();
    if (!state) throw new Error('Сначала откройте чат');
    if (isDialogue(state) ? state.heroes.length < 2 : !state.heroes.length) {
        throw new Error(isDialogue(state) ? 'Выберите карточки на «📖 Странице игры», вкладка «Игра»' : 'Нет героев: подготовьте мир и героев в «Старте игры»');
    }
    return state;
}

// Пока модель думала, пользователь мог открыть другой чат: тогда писать некуда.
function assertSameChat(chatId) {
    if (SillyTavern.getContext().getCurrentChatId() !== chatId) {
        throw new Error('Во время хода открыт другой чат: ход не записан, вернитесь в чат игры и нажмите «Продолжить»');
    }
}

function logChoice(state, step, choice) {
    const who = (id) => (isHeroId(id) ? `${id} (${heroById(state, id)?.name ?? '?'})` : id);
    const why = {
        silence: `защита от молчания, порог ${getSettings().silenceThreshold}`,
        random: `случайность ${getSettings().randomness} %, мастер выбрал ${who(step.masterChoice)}`,
        'after-hero': 'после героя ходит мастер',
        master: 'выбор мастера',
        unavailable: `мастер выбрал ${who(step.masterChoice)}, но он не может действовать`,
    }[choice.reason];
    console.log(`${LOG_PREFIX} следующий ход: ${who(choice.next)} — ${why}; молчание: ${state.heroes.map((hero) => `${hero.name} ${hero.silence}`).join(', ')}`);
}

async function masterTurn(state, chatId) {
    const settings = getSettings();
    const models = modelsFor(settings, state);
    const heroNames = state.heroes.map((hero) => hero.name);
    const cards = state.heroes.map((hero) => toPromptCard(findCharacter(hero)));
    const scene = { focus: state.session.focus, cut: state.session.cut, wanted: state.session.wanted };
    let rolls = [];

    // Броски уже сделаны, а описание исхода сорвалось: повторяем только его, кубики не перебрасываем.
    if (!state.session.pendingOutcome) {
        const check = decideCheck(state, settings.checkFrequency);
        const note = state.session.masterNote;
        const ask = async (checkMode) => {
            const raw = await callModel({
                role: 'master',
                model: models.master,
                messages: buildMasterPrompt({ state, cards, language: settings.language, check: checkMode, deathMode: settings.deathMode, scene }),
                maxTokens: MASTER_MAX_TOKENS,
            });
            assertSameChat(chatId);
            const result = parseMasterResponse(raw, { heroNames });
            result.rolls = result.rolls.map((tag) => planRoll(state, tag, heroNames)).filter(Boolean);
            return result;
        };
        let parsed = await ask(check);
        if (check.mode === 'forbidden' && parsed.rolls.length) {
            console.warn(`${LOG_PREFIX} бросок в этом ходе не положен (частота проверок ${settings.checkFrequency} %), метки пропущены`, parsed.rolls);
            parsed.rolls = [];
        } else if (check.mode === 'required' && !parsed.rolls.length) {
            // Переспрос (PLAN 8.2): один раз, с напоминанием. Не помогло — ход идёт без броска, как раньше.
            console.warn(`${LOG_PREFIX} мастер не поставил обязательную проверку для ${check.hero}, переспрашиваю`);
            const retry = await ask({ ...check, reminder: true });
            if (retry.rolls.length) parsed = retry;
            else console.warn(`${LOG_PREFIX} мастер и после напоминания не поставил проверку для ${check.hero}, ход без броска`);
        }

        // Записку пользователь писал на ближайший ход мастера (FR-19).
        useNote(state, note);

        if (!parsed.rolls.length) {
            await recordMasterTurn(state, parsed.text, [], parsed.sceneEnd, parsed.changes, { hours: elapsedHours(parsed) });
            return { author: 'master', masterChoice: afterMaster(state, parsed), sceneEnd: parsed.sceneEnd };
        }

        // До броска исход неизвестен: урон, предметы и время из части «попытка» не применяем (PLAN 8.2).
        // Применение способности без броска (use) не теряем: оно не зависит от исхода.
        const early = parsed.changes.filter((change) => change.hp || Object.keys(change.stats).length || change.add.length || change.remove.length);
        if (early.length || parsed.hours) console.warn(`${LOG_PREFIX} блок STATE до броска пропущен: исход ещё не известен`, early, parsed.hours);
        const attemptChanges = parsed.changes
            .filter((change) => change.use.length)
            .map((change) => ({ ...change, hp: 0, stats: {}, add: [], remove: [] }));

        // Мастер остановился на попытке: бросаем, показываем плашки, просим описать исход (FR-13, FR-14).
        rolls = parsed.rolls.map((plan) => performRoll(state, plan));
        state.session.pendingOutcome = true;
        // Способность, проверенная броском, уже прокачана: в описании исхода её «use» второй раз не считаем.
        state.session.rolledAbilities = rolls.filter((roll) => roll.ability).map((roll) => `${roll.hero}:${roll.ability}`);
        const abilityLines = rolls.map((roll) => roll.abilityLine).filter(Boolean);
        await recordMasterTurn(state, parsed.text, rolls, false, attemptChanges, { extraLines: abilityLines });
        for (const roll of rolls) {
            await postAsMaster(roll.line, { kind: 'roll', roll });
            if (roll.abilityLine) await postAsMaster(`📋 ${roll.abilityLine}`, { kind: 'state', turn: state.turns.length });
        }
    }

    // Новая записка, пришедшая, пока мастер думал над первой частью хода, уходит в описание исхода.
    const outcomeNote = state.session.masterNote;
    const outcomeRaw = await callModel({
        role: 'master',
        model: models.master,
        messages: buildMasterPrompt({ state, cards, language: settings.language, mode: 'outcome', deathMode: settings.deathMode, scene }),
        maxTokens: MASTER_MAX_TOKENS,
    });
    assertSameChat(chatId);
    const outcome = parseMasterResponse(outcomeRaw, { heroNames });
    if (outcome.rolls.length) {
        console.warn(`${LOG_PREFIX} мастер поставил новые броски в описании исхода, они пропущены`, outcome.rolls);
    }
    useNote(state, outcomeNote);
    state.session.pendingOutcome = false;
    const skipUses = state.session.rolledAbilities ?? [];
    state.session.rolledAbilities = [];
    await recordMasterTurn(state, outcome.text, [], outcome.sceneEnd, outcome.changes, { skipUses, hours: elapsedHours(outcome) });
    if (!rolls.length) rolls = state.turns.findLast((turn) => turn.rolls?.length)?.rolls ?? [];
    return {
        author: 'master',
        masterChoice: afterMaster(state, outcome),
        sceneEnd: outcome.sceneEnd,
        detail: rolls.map((roll) => roll.line).join('; '),
    };
}

/**
 * Сжатие старых ходов в скрытую память (FR-26), когда несжатых ходов больше порога из настроек.
 * Сорвалось — не беда: ход уже сделан, история пока длиннее, попробуем после следующего хода.
 */
async function compressMemory(state, chatId) {
    const settings = getSettings();
    const turns = turnsToCompress(state, settings.memoryThreshold);
    if (!turns.length) return;
    try {
        const summaries = {};
        for (const { key, messages } of buildSummaryPrompts({ state, turns, language: settings.language })) {
            summaries[key] = await callModel({ role: `memory:${key}`, model: modelsFor(settings, state).master, messages, maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.3 });
        }
        assertSameChat(chatId);
        const memory = applySummaries(state, turns, summaries);
        await saveState();
        console.log(`${LOG_PREFIX} память: сжаты ходы ${turns[0].n}–${memory.upTo}`, memory);
    } catch (error) {
        console.warn(`${LOG_PREFIX} не удалось сжать память, попробую после следующего хода`, error);
        toastr.warning(`Не удалось сжать память: ${error.message}`, 'RPG-автосессия');
    }
}

// Игровое время хода: "time" из STATE, а если мастер его забыл, но написал «спустя сутки», — из текста (PLAN 8.5).
function elapsedHours(parsed) {
    if (parsed.hours) return parsed.hours;
    const hours = hoursFromText(parsed.text);
    if (hours) console.log(`${LOG_PREFIX} мастер не указал "time", время взято из текста: ${hours} ч`);
    return hours;
}

function useNote(state, note) {
    if (consumeMasterNote(state.session, note)) console.log(`${LOG_PREFIX} записка передана мастеру и снята: «${note}»`);
}

/**
 * Частота проверок (новое, PLAN 4.8): после действия героя с вероятностью `frequency` % мастер обязан
 * проверить его броском, иначе бросков нет. 0 — игра без кубиков, 100 — проверка на каждое действие.
 * Ход мастера не после героя (открытие сцены, мастер → мастер) идёт без бросков.
 */
function decideCheck(state, frequency) {
    const last = state.turns[state.turns.length - 1];
    const author = last?.author;
    // Проверяется только действие героя той же группы прямо перед ходом мастера; в «Романтике» кубиков нет (FR-37).
    if (!usesDice(state) || !isHeroId(author) || turnGroup(last) !== state.session.focus) return { mode: 'forbidden' };
    const required = frequency > 0 && rollDie(100) <= frequency;
    console.log(`${LOG_PREFIX} проверка действия ${author}: ${required ? 'нужна' : 'нет'} (частота ${frequency} %)`);
    return required ? { mode: 'required', hero: author } : { mode: 'forbidden' };
}

// Изменения HP, статов, инвентаря и применения способностей из блока [STATE ...] (FR-15, FR-31) применяются сразу
// и видны всем: строки идут в историю и в чат. extraLines — прокачка способностей от бросков, их чат получает после плашек.
// hours — прошедшее игровое время; после изменений герои с HP 0 выбывают, отлежавшие сутки встают (PLAN 8.5).
// Переходы между группами и уход из сцены (FR-35) — тоже из блока STATE: n — номер этого хода мастера.
async function recordMasterTurn(state, text, rolls, sceneEnd, changes = [], { extraLines = [], skipUses = [], hours = 0 } = {}) {
    const n = state.turns.length + 1;
    const group = state.session.focus;
    const changeLines = [
        ...applyStateChanges(state.heroes, changes, { skipUses }),
        ...applyVitality(state, { hours, mode: getSettings().deathMode }),
        ...applyMoves(state, changes, n),
    ];
    if (changeLines.length) console.log(`${LOG_PREFIX} изменения состояния героев:`, changeLines, changes);
    state.turns.push({ n, author: 'master', group, text, rolls, changes: [...extraLines, ...changeLines], next: null, sceneEnd: Boolean(sceneEnd) });
    state.session.cut = false;
    state.session.wanted = '';
    await saveState();
    await postAsMaster(withGroupTag(state, text, group), { turn: n, group });
    if (changeLines.length) await postAsMaster(changeLines.map((line) => `📋 ${line}`).join('\n'), { kind: 'state', turn: n });
}

/**
 * «group» и «leave» из блока STATE (FR-35): герой переходит в другую группу, возвращается или уходит из сцены.
 * @returns {string[]} строки для чата и истории
 */
export function applyMoves(state, changes, n) {
    const lines = [];
    for (const change of changes) {
        const hero = heroById(state, change.hero);
        if (!hero) continue;
        const was = heroGroup(hero);
        const target = change.leave ? null : change.group;
        if (target === undefined || (target === null && !change.leave) || !moveHero(hero, target, n)) continue;
        if (target === null) lines.push(`🚪 ${hero.name} уходит из сцены и больше не действует, пока не вернётся`);
        else if (was === null) lines.push(`↩️ ${hero.name} возвращается в сцену (группа ${target})`);
        else lines.push(`➡️ ${hero.name} переходит в группу ${target}`);
    }
    return lines;
}

/** Кого мастер назвал следующим; [NEXT: master B] — переход к группе B (FR-34). */
function afterMaster(state, parsed) {
    if (parsed.next === 'master' && parsed.nextGroup && parsed.nextGroup !== state.session.focus && groupMembers(state, parsed.nextGroup).length) {
        switchFocus(state, parsed.nextGroup);
        return 'master';
    }
    return resolveNext(state, parsed.next);
}

/**
 * Чья проверка и чего: способность героя (PLAN 6.4), навык или характеристика. Непонятная метка → null, броска не будет.
 * @param {object} state
 * @param {{sides: number, stat: string|null, skill: string|null, check: string, dc: number, target: string}} tag
 * @param {string[]} heroNames
 */
function planRoll(state, tag, heroNames) {
    const target = normalizeNext(tag.target, heroNames);
    const index = isHeroId(target) && state.heroes[heroIndex(target)] ? heroIndex(target) : lastActiveHero(state);
    const ability = findAbility(state.heroes[index], tag.check);
    if (ability) return { ...tag, heroIndex: index, ability, stat: ability.stat, skill: null };
    if (tag.stat) return { ...tag, heroIndex: index, ability: null };
    console.warn(`${LOG_PREFIX} непонятная проверка «${tag.check}» в ${tag.raw}: это не характеристика и не способность героя, бросок пропущен`);
    return null;
}

function performRoll(state, plan) {
    const hero = state.heroes[plan.heroIndex];
    const natural = rollDie(plan.sides);
    const proficient = Boolean(plan.skill && hero.skills?.includes(plan.skill));
    const bonus = plan.ability?.level ?? 0;
    const result = resolveCheck({ natural, sides: plan.sides, score: hero.stats[plan.stat] ?? 10, dc: plan.dc, proficient, bonus });
    const line = formatRoll(result, { heroName: hero.name, stat: plan.stat, skill: plan.skill, ability: plan.ability });
    // Применение способности прокачивает её при любом исходе броска.
    const abilityLine = plan.ability ? useAbility(hero, plan.ability).line : '';
    return {
        hero: heroId(plan.heroIndex),
        stat: plan.stat,
        skill: plan.skill,
        ability: plan.ability?.name ?? null,
        ...result,
        line,
        abilityLine,
    };
}

/** Кто из героев группы в фокусе ходил последним; если никто — первый герой группы. */
function lastActiveHero(state) {
    const focus = state.session.focus;
    for (let i = state.turns.length - 1; i >= 0; i--) {
        const turn = state.turns[i];
        if (isHeroId(turn.author) && turnGroup(turn) === focus && state.heroes[heroIndex(turn.author)]) return heroIndex(turn.author);
    }
    return groupMembers(state, focus)[0] ?? 0;
}

/** Мастер забыл [NEXT] → ход тому герою группы в фокусе, кто дольше молчал. */
function resolveNext(state, next) {
    if (next) return next;
    const members = groupMembers(state, state.session.focus).filter((index) => isActive(state.heroes[index]));
    const chosen = members.length
        ? heroId(members.reduce((best, index) => ((state.heroes[index].silence ?? 0) > (state.heroes[best].silence ?? 0) ? index : best)))
        : 'master';
    console.warn(`${LOG_PREFIX} мастер не указал [NEXT], выбран ${chosen}`);
    return chosen;
}

async function heroTurn(state, index, chatId) {
    const settings = getSettings();
    const hero = state.heroes[index];
    const id = heroId(index);
    const character = findCharacter(hero);
    if (!character) throw new Error(`Карточка «${hero.name}» не найдена в библиотеке ST`);

    const raw = await callModel({
        role: id,
        model: modelsFor(settings, state).hero,
        messages: buildHeroPrompt({ state, heroIndex: index, card: toPromptCard(character), language: settings.language }),
        maxTokens: HERO_MAX_TOKENS,
    });
    assertSameChat(chatId);
    const others = state.heroes.filter((_, i) => i !== index).map((other) => other.name);
    const parsed = parseHeroResponse(raw, { foreignNames: [...others, 'Мастер', 'Master'] });

    const group = heroGroup(hero);
    state.turns.push({ n: state.turns.length + 1, author: id, group, ...parsed });
    await saveState();

    await postAsCharacter(character, withGroupTag(state, formatHeroMessage(parsed), group), { author: id, turn: state.turns.length });
    return { author: id };
}

/** Реплика, намерение курсивом и мысли свёрнутым спойлером (FR-11, FR-16). */
export function formatHeroMessage({ speech, intent, thoughts }) {
    const parts = [];
    if (speech) parts.push(`«${speech}»`);
    if (intent) parts.push(`*${intent.replace(/\*/g, '')}*`);
    if (thoughts) {
        parts.push(`<details class="rpga-thoughts"><summary>💭 Мысли</summary>\n\n${escapeHtml(thoughts)}\n\n</details>`);
    }
    return parts.join('\n\n');
}

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function describeNext(state) {
    const hero = heroById(state, state.session.next);
    if (!hero) return hasManyGroups(state) ? `мастер (группа ${state.session.focus})` : 'снова мастер';
    return hero.name;
}

function findCharacter(hero) {
    return SillyTavern.getContext().characters.find((character) => character.avatar === hero.cardAvatar) ?? null;
}

export function toPromptCard(character) {
    if (!character) return null;
    return {
        name: character.name,
        description: character.description ?? character.data?.description ?? '',
        personality: character.personality ?? character.data?.personality ?? '',
        scenario: character.scenario ?? character.data?.scenario ?? '',
    };
}
