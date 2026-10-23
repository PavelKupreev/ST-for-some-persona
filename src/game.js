// Ход по кнопке (этап 2, концепция А): мастер → выбранный им герой (FR-08), броски (FR-13, FR-14).
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

const MASTER_MAX_TOKENS = 900;
const HERO_MAX_TOKENS = 500;

/**
 * Одно нажатие «Один ход»: если очередь мастера — ход мастера (с бросками и описанием исхода),
 * затем, если мастер передал ход герою, — ход этого героя.
 * Если ход сорвался, очередь не сдвигается: следующее нажатие повторит его.
 * @returns {Promise<string>} краткий отчёт для панели
 */
export async function playOneTurn() {
    const state = requireGame();
    const report = [];

    if (state.session.next === 'master' || !state.session.next) {
        await masterTurn(state, report);
    }
    const heroIndex = HERO_IDS.indexOf(state.session.next);
    if (heroIndex !== -1) {
        await heroTurn(state, heroIndex, report);
    }
    return report.join('\n');
}

function requireGame() {
    const state = getState();
    if (!state) throw new Error('Сначала откройте чат');
    if (state.heroes.length !== 2) throw new Error('Нет героев: подготовьте мир и героев в «Старте игры»');
    return state;
}

async function masterTurn(state, report) {
    const settings = getSettings();
    const heroNames = state.heroes.map((hero) => hero.name);
    const cards = state.heroes.map((hero) => toPromptCard(findCharacter(hero)));

    const raw = await callModel({
        role: 'master',
        model: settings.masterModel,
        messages: buildMasterPrompt({ state, cards, language: settings.language }),
        maxTokens: MASTER_MAX_TOKENS,
    });
    const parsed = parseMasterResponse(raw, { heroNames });

    // Записку пользователь писал на ближайший ход мастера (FR-19).
    state.session.masterNote = '';

    if (!parsed.rolls.length) {
        await recordMasterTurn(state, parsed.text, [], resolveNext(state, parsed.next));
        report.push(`Мастер → ${describeNext(state)}`);
        return;
    }

    // Мастер остановился на попытке: бросаем, показываем плашки, просим описать исход (FR-13, FR-14).
    const rolls = parsed.rolls.map((tag) => performRoll(state, tag, heroNames));
    await recordMasterTurn(state, parsed.text, rolls, null);
    for (const roll of rolls) {
        await postAsMaster(roll.line, { kind: 'roll', roll });
    }

    const outcomeRaw = await callModel({
        role: 'master',
        model: settings.masterModel,
        messages: buildMasterPrompt({ state, cards, language: settings.language, mode: 'outcome' }),
        maxTokens: MASTER_MAX_TOKENS,
    });
    const outcome = parseMasterResponse(outcomeRaw, { heroNames });
    if (outcome.rolls.length) {
        console.warn(`${LOG_PREFIX} мастер поставил новые броски в описании исхода, они пропущены`, outcome.rolls);
    }
    await recordMasterTurn(state, outcome.text, [], resolveNext(state, outcome.next));
    report.push(`Мастер: ${rolls.map((roll) => roll.line).join('; ')} → ${describeNext(state)}`);
}

async function recordMasterTurn(state, text, rolls, next) {
    state.turns.push({ n: state.turns.length + 1, author: 'master', text, rolls, next });
    if (next) state.session.next = next;
    await saveState();
    await postAsMaster(text, { turn: state.turns.length });
}

/**
 * @param {object} state
 * @param {{sides: number, stat: string, dc: number, target: string}} tag
 * @param {string[]} heroNames
 */
function performRoll(state, tag, heroNames) {
    const target = normalizeNext(tag.target, heroNames);
    const heroIndex = HERO_IDS.includes(target) ? HERO_IDS.indexOf(target) : lastActiveHero(state);
    const hero = state.heroes[heroIndex];
    const natural = rollDie(tag.sides);
    const result = resolveCheck({ natural, sides: tag.sides, score: hero.stats[tag.stat] ?? 10, dc: tag.dc });
    return {
        hero: HERO_IDS[heroIndex],
        stat: tag.stat,
        ...result,
        line: formatRoll(result, { heroName: hero.name, stat: tag.stat }),
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

async function heroTurn(state, heroIndex, report) {
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
    const parsed = parseHeroResponse(raw, { foreignNames: [other.name, 'Мастер', 'Master'] });

    state.turns.push({ n: state.turns.length + 1, author: HERO_IDS[heroIndex], ...parsed });
    hero.silence = 0;
    other.silence = (other.silence ?? 0) + 1;
    state.session.next = 'master';
    await saveState();

    await postAsCharacter(character, formatHeroMessage(parsed), { author: HERO_IDS[heroIndex], turn: state.turns.length });
    report.push(`Ход: ${hero.name}`);
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
