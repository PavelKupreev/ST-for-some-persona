// Ходы игры: мастер → выбранный герой (FR-08), броски (FR-13, FR-14), очерёдность (FR-09, FR-10).
// Этап 2 — «Один ход» по кнопке, этап 4 — те же шаги в цикле автосессии (src/autosession.js).
// Промпты собираются из state.turns, а не из сообщений чата: в чате мысли лежат спойлером,
// и брать их оттуда значило бы рисковать утечкой ко второму герою (NFR-01).

import { LOG_PREFIX } from './constants.js';
import { getSettings } from './settings.js';
import { getState, saveState } from './state.js';
import { callModel } from './llm.js';
import { postAsCharacter, postAsMaster } from './chat.js';
import { formatRoll, resolveCheck, rollDie } from './dice.js';
import { parseHeroResponse, parseMasterResponse, normalizeNext } from './parse.js';
import { HERO_IDS, buildHeroPrompt, buildMasterPrompt } from './prompts.js';
import { chooseNext, updateSilence } from './turnOrder.js';
import { consumeMasterNote } from './intervention.js';
import { applyStateChanges } from './heroState.js';
import { findAbility, useAbility } from './abilities.js';
import { applySummaries, buildSummaryPrompts, turnsToCompress } from './memory.js';

const MASTER_MAX_TOKENS = 700;
const HERO_MAX_TOKENS = 500;
const SUMMARY_MAX_TOKENS = 600;

/**
 * Один ход одного актора: мастера (с бросками и описанием исхода) или героя, на кого указывает state.session.next.
 * Если ход сорвался, очередь не сдвигается: следующий вызов повторит его (FR-22).
 * @returns {Promise<{author: string, report: string, sceneEnd: boolean}>}
 */
export async function playStep() {
    const state = requireGame();
    const chatId = SillyTavern.getContext().getCurrentChatId();
    const heroIndex = HERO_IDS.indexOf(state.session.next);

    const step = heroIndex === -1
        ? await masterTurn(state, chatId)
        : await heroTurn(state, heroIndex, chatId);

    const settings = getSettings();
    updateSilence(state.heroes, step.author);
    const choice = chooseNext({
        author: step.author,
        masterChoice: step.masterChoice,
        silence: state.heroes.map((hero) => hero.silence),
        randomness: settings.randomness,
        silenceThreshold: settings.silenceThreshold,
    });
    state.session.next = choice.next;
    state.turns[state.turns.length - 1].next = choice.next;
    await saveState();
    logChoice(state, step, choice);
    await compressMemory(state, chatId);

    const label = step.author === 'master' ? 'Мастер' : state.heroes[heroIndex].name;
    const reason = { random: ' (случайный выбор)', silence: ' (давно молчал)' }[choice.reason] ?? '';
    const lines = [`${label}${step.detail ? `: ${step.detail}` : ''} → ${describeNext(state)}${reason}`];
    if (step.sceneEnd) lines.push('🏁 Мастер отметил конец сцены');
    return { author: step.author, report: lines.join('\n'), sceneEnd: Boolean(step.sceneEnd) };
}

/**
 * «Один ход» по кнопке (этап 2): ход мастера и, если он передал слово герою, ход этого героя.
 * @returns {Promise<string>} краткий отчёт для панели
 */
export async function playOneTurn() {
    const first = await playStep();
    const report = [first.report];
    if (first.author === 'master' && HERO_IDS.includes(getState()?.session.next)) {
        report.push((await playStep()).report);
    }
    return report.join('\n');
}

function requireGame() {
    const state = getState();
    if (!state) throw new Error('Сначала откройте чат');
    if (state.heroes.length !== 2) throw new Error('Нет героев: подготовьте мир и героев в «Старте игры»');
    return state;
}

// Пока модель думала, пользователь мог открыть другой чат: тогда писать некуда.
function assertSameChat(chatId) {
    if (SillyTavern.getContext().getCurrentChatId() !== chatId) {
        throw new Error('Во время хода открыт другой чат: ход не записан, вернитесь в чат игры и нажмите «Продолжить»');
    }
}

function logChoice(state, step, choice) {
    const who = (id) => (HERO_IDS.includes(id) ? `${id} (${state.heroes[HERO_IDS.indexOf(id)].name})` : id);
    const why = {
        silence: `защита от молчания, порог ${getSettings().silenceThreshold}`,
        random: `случайность ${getSettings().randomness} %, мастер выбрал ${who(step.masterChoice)}`,
        'after-hero': 'после героя ходит мастер',
        master: 'выбор мастера',
    }[choice.reason];
    console.log(`${LOG_PREFIX} следующий ход: ${who(choice.next)} — ${why}; молчание: ${state.heroes.map((hero) => `${hero.name} ${hero.silence}`).join(', ')}`);
}

async function masterTurn(state, chatId) {
    const settings = getSettings();
    const heroNames = state.heroes.map((hero) => hero.name);
    const cards = state.heroes.map((hero) => toPromptCard(findCharacter(hero)));
    let rolls = [];

    // Броски уже сделаны, а описание исхода сорвалось: повторяем только его, кубики не перебрасываем.
    if (!state.session.pendingOutcome) {
        const check = decideCheck(state, settings.checkFrequency);
        const note = state.session.masterNote;
        const raw = await callModel({
            role: 'master',
            model: settings.masterModel,
            messages: buildMasterPrompt({ state, cards, language: settings.language, check }),
            maxTokens: MASTER_MAX_TOKENS,
        });
        assertSameChat(chatId);
        const parsed = parseMasterResponse(raw, { heroNames });
        parsed.rolls = parsed.rolls.map((tag) => planRoll(state, tag, heroNames)).filter(Boolean);
        if (check.mode === 'forbidden' && parsed.rolls.length) {
            console.warn(`${LOG_PREFIX} бросок в этом ходе не положен (частота проверок ${settings.checkFrequency} %), метки пропущены`, parsed.rolls);
            parsed.rolls = [];
        } else if (check.mode === 'required' && !parsed.rolls.length) {
            console.warn(`${LOG_PREFIX} мастер не поставил обязательную проверку для ${check.hero}`);
        }

        // Записку пользователь писал на ближайший ход мастера (FR-19).
        useNote(state, note);

        if (!parsed.rolls.length) {
            await recordMasterTurn(state, parsed.text, [], parsed.sceneEnd, parsed.changes);
            return { author: 'master', masterChoice: resolveNext(state, parsed.next), sceneEnd: parsed.sceneEnd };
        }

        // Мастер остановился на попытке: бросаем, показываем плашки, просим описать исход (FR-13, FR-14).
        rolls = parsed.rolls.map((plan) => performRoll(state, plan));
        state.session.pendingOutcome = true;
        // Способность, проверенная броском, уже прокачана: в описании исхода её «use» второй раз не считаем.
        state.session.rolledAbilities = rolls.filter((roll) => roll.ability).map((roll) => `${roll.hero}:${roll.ability}`);
        const abilityLines = rolls.map((roll) => roll.abilityLine).filter(Boolean);
        await recordMasterTurn(state, parsed.text, rolls, false, parsed.changes, { extraLines: abilityLines });
        for (const roll of rolls) {
            await postAsMaster(roll.line, { kind: 'roll', roll });
            if (roll.abilityLine) await postAsMaster(`📋 ${roll.abilityLine}`, { kind: 'state', turn: state.turns.length });
        }
    }

    // Новая записка, пришедшая, пока мастер думал над первой частью хода, уходит в описание исхода.
    const outcomeNote = state.session.masterNote;
    const outcomeRaw = await callModel({
        role: 'master',
        model: settings.masterModel,
        messages: buildMasterPrompt({ state, cards, language: settings.language, mode: 'outcome' }),
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
    await recordMasterTurn(state, outcome.text, [], outcome.sceneEnd, outcome.changes, { skipUses });
    if (!rolls.length) rolls = state.turns.findLast((turn) => turn.rolls?.length)?.rolls ?? [];
    return {
        author: 'master',
        masterChoice: resolveNext(state, outcome.next),
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
            summaries[key] = await callModel({ role: `memory:${key}`, model: settings.masterModel, messages, maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.3 });
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

function useNote(state, note) {
    if (consumeMasterNote(state.session, note)) console.log(`${LOG_PREFIX} записка передана мастеру и снята: «${note}»`);
}

/**
 * Частота проверок (новое, PLAN 4.8): после действия героя с вероятностью `frequency` % мастер обязан
 * проверить его броском, иначе бросков нет. 0 — игра без кубиков, 100 — проверка на каждое действие.
 * Ход мастера не после героя (открытие сцены, мастер → мастер) идёт без бросков.
 */
function decideCheck(state, frequency) {
    const author = state.turns[state.turns.length - 1]?.author;
    if (!HERO_IDS.includes(author)) return { mode: 'forbidden' };
    const required = frequency > 0 && rollDie(100) <= frequency;
    console.log(`${LOG_PREFIX} проверка действия ${author}: ${required ? 'нужна' : 'нет'} (частота ${frequency} %)`);
    return required ? { mode: 'required', hero: author } : { mode: 'forbidden' };
}

// Изменения HP, статов, инвентаря и применения способностей из блока [STATE ...] (FR-15, FR-31) применяются сразу
// и видны всем: строки идут в историю и в чат. extraLines — прокачка способностей от бросков, их чат получает после плашек.
async function recordMasterTurn(state, text, rolls, sceneEnd, changes = [], { extraLines = [], skipUses = [] } = {}) {
    const changeLines = applyStateChanges(state.heroes, changes, { skipUses });
    if (changeLines.length) console.log(`${LOG_PREFIX} изменения состояния героев:`, changeLines, changes);
    state.turns.push({ n: state.turns.length + 1, author: 'master', text, rolls, changes: [...extraLines, ...changeLines], next: null, sceneEnd: Boolean(sceneEnd) });
    await saveState();
    await postAsMaster(text, { turn: state.turns.length });
    if (changeLines.length) await postAsMaster(changeLines.map((line) => `📋 ${line}`).join('\n'), { kind: 'state', turn: state.turns.length });
}

/**
 * Чья проверка и чего: способность героя (PLAN 6.4), навык или характеристика. Непонятная метка → null, броска не будет.
 * @param {object} state
 * @param {{sides: number, stat: string|null, skill: string|null, check: string, dc: number, target: string}} tag
 * @param {string[]} heroNames
 */
function planRoll(state, tag, heroNames) {
    const target = normalizeNext(tag.target, heroNames);
    const heroIndex = HERO_IDS.includes(target) ? HERO_IDS.indexOf(target) : lastActiveHero(state);
    const ability = findAbility(state.heroes[heroIndex], tag.check);
    if (ability) return { ...tag, heroIndex, ability, stat: ability.stat, skill: null };
    if (tag.stat) return { ...tag, heroIndex, ability: null };
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
        hero: HERO_IDS[plan.heroIndex],
        stat: plan.stat,
        skill: plan.skill,
        ability: plan.ability?.name ?? null,
        ...result,
        line,
        abilityLine,
    };
}

/** Кто из героев ходил последним; если никто — герой 1. */
function lastActiveHero(state) {
    for (let i = state.turns.length - 1; i >= 0; i--) {
        const index = HERO_IDS.indexOf(state.turns[i].author);
        if (index !== -1) return index;
    }
    return 0;
}

/** Мастер забыл [NEXT] → ход тому герою, кто дольше молчал. */
function resolveNext(state, next) {
    if (next) return next;
    const fallback = HERO_IDS[1 - lastActiveHero(state)];
    const hasHeroTurns = state.turns.some((turn) => HERO_IDS.includes(turn.author));
    const chosen = hasHeroTurns ? fallback : 'hero1';
    console.warn(`${LOG_PREFIX} мастер не указал [NEXT], выбран ${chosen}`);
    return chosen;
}

async function heroTurn(state, heroIndex, chatId) {
    const settings = getSettings();
    const hero = state.heroes[heroIndex];
    const other = state.heroes[1 - heroIndex];
    const character = findCharacter(hero);
    if (!character) throw new Error(`Карточка «${hero.name}» не найдена в библиотеке ST`);

    const raw = await callModel({
        role: HERO_IDS[heroIndex],
        model: settings.heroModel,
        messages: buildHeroPrompt({ state, heroIndex, card: toPromptCard(character), language: settings.language }),
        maxTokens: HERO_MAX_TOKENS,
    });
    assertSameChat(chatId);
    const parsed = parseHeroResponse(raw, { foreignNames: [other.name, 'Мастер', 'Master'] });

    state.turns.push({ n: state.turns.length + 1, author: HERO_IDS[heroIndex], ...parsed });
    await saveState();

    await postAsCharacter(character, formatHeroMessage(parsed), { author: HERO_IDS[heroIndex], turn: state.turns.length });
    return { author: HERO_IDS[heroIndex] };
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
    const index = HERO_IDS.indexOf(state.session.next);
    return index === -1 ? 'снова мастер' : state.heroes[index].name;
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
