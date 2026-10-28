// Очерёдность ходов (этап 4): случайность выбора следующего (FR-09) и защита от молчания (FR-10).
// Модуль без зависимостей от ST, проверяется тестом в Node.
// «Ход» здесь, как в модели данных ТЗ, — одна запись с одним автором: мастер или один из героев.

import { rollDie } from './dice.js';
import { heroId, heroIndex } from './heroes.js';

/**
 * Порог молчания с поправкой на число героев (этап 11, FR-10): при пяти героях каждый ждёт своей очереди
 * минимум 4 хода, и порог 4 срабатывал бы почти на каждом ходе, отнимая выбор у мастера.
 * @param {number} threshold порог из настроек; 0 — защита выключена
 * @param {number} activeCount сколько героев сейчас могут ходить
 */
export function effectiveSilenceThreshold(threshold, activeCount) {
    if (!(threshold > 0)) return 0;
    return Math.max(threshold, 2 * activeCount - 1);
}

/**
 * Обновляет счётчики молчания после хода: автор хода — 0, остальным героям +1.
 * Герой без сознания, погибший (PLAN 8.5) или ушедший из сцены (FR-35) не «молчит»: его счётчик стоит на месте.
 * @param {Array<{silence?: number, condition?: string, group?: string|null}>} heroes
 * @param {string} author master или heroN
 */
export function updateSilence(heroes, author) {
    heroes.forEach((hero, index) => {
        if ((hero.condition && hero.condition !== 'ok') || hero.group === null) return;
        hero.silence = heroId(index) === author ? 0 : (hero.silence ?? 0) + 1;
    });
}

/**
 * Решает, кто ходит следующим.
 * 1. Герой, который молчит порог ходов и больше (effectiveSilenceThreshold), ходит обязательно (FR-10). 0 — защита выключена.
 * 2. После героя всегда мастер: он описывает последствия.
 * 3. После мастера с вероятностью `randomness` % выбор мастера заменяется случайным (FR-09).
 * Герои, которые не могут ходить (без сознания, погиб — PLAN 8.5, заморожен — FR-35), из выбора выпадают: вместо них
 * другой герой или мастер.
 * @param {object} params
 * @param {string} params.author кто только что сходил: master или heroN
 * @param {string} [params.masterChoice] кого назвал мастер в [NEXT]
 * @param {number[]} params.silence счётчики молчания героев по порядку
 * @param {number} params.randomness 0–100
 * @param {number} params.silenceThreshold
 * @param {boolean[]} [params.active] может ли ходить каждый герой, по умолчанию все
 * @param {(sides: number) => number} [params.roll] кубик 1..sides, по умолчанию криптостойкий
 * @returns {{next: string, reason: 'silence'|'after-hero'|'random'|'master'|'unavailable'}}
 */
export function chooseNext({ author, masterChoice, silence, randomness, silenceThreshold, active, roll = rollDie }) {
    const ids = silence.map((_, index) => heroId(index));
    const canAct = (id) => id === 'master' || (ids.includes(id) && active?.[heroIndex(id)] !== false);
    const threshold = effectiveSilenceThreshold(silenceThreshold, ids.filter(canAct).length);
    if (threshold > 0) {
        const silent = ids
            .map((id, index) => ({ id, silence: silence[index] ?? 0 }))
            .filter((hero) => hero.id !== author && canAct(hero.id) && hero.silence >= threshold)
            .sort((a, b) => b.silence - a.silence);
        if (silent.length) return { next: silent[0].id, reason: 'silence' };
    }

    if (author !== 'master') return { next: 'master', reason: 'after-hero' };

    if (randomness > 0 && roll(100) <= randomness) {
        const pool = [...ids, 'master'].filter(canAct);
        return { next: pool[roll(pool.length) - 1], reason: 'random' };
    }
    const chosen = masterChoice === 'master' || ids.includes(masterChoice) ? masterChoice : ids[0];
    if (canAct(chosen)) return { next: chosen, reason: 'master' };
    // Мастер назвал героя, который не может ходить: ход другому герою в строю, иначе снова мастеру.
    const other = ids.find((id) => id !== chosen && canAct(id));
    return { next: other ?? 'master', reason: 'unavailable' };
}
