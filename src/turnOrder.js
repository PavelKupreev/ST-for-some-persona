// Очерёдность ходов (этап 4): случайность выбора следующего (FR-09) и защита от молчания (FR-10).
// Модуль без зависимостей от ST, проверяется тестом в Node.
// «Ход» здесь, как в модели данных ТЗ, — одна запись с одним автором: мастер или один из героев.

import { rollDie } from './dice.js';
import { HERO_IDS } from './prompts.js';

export const ACTOR_IDS = ['hero1', 'hero2', 'master'];

/**
 * Обновляет счётчики молчания после хода: автор хода — 0, остальным героям +1.
 * Герой без сознания или погибший (PLAN 8.5) не «молчит»: его счётчик стоит на месте.
 * @param {Array<{silence?: number, condition?: string}>} heroes
 * @param {'master'|'hero1'|'hero2'} author
 */
export function updateSilence(heroes, author) {
    heroes.forEach((hero, index) => {
        if (hero.condition && hero.condition !== 'ok') return;
        hero.silence = HERO_IDS[index] === author ? 0 : (hero.silence ?? 0) + 1;
    });
}

/**
 * Решает, кто ходит следующим.
 * 1. Герой, который молчит `silenceThreshold` ходов и больше, ходит обязательно (FR-10). 0 — защита выключена.
 * 2. После героя всегда мастер: он описывает последствия.
 * 3. После мастера с вероятностью `randomness` % выбор мастера заменяется случайным (FR-09).
 * Герои, которые не могут ходить (без сознания, погиб — PLAN 8.5), из выбора выпадают: вместо них второй герой или мастер.
 * @param {object} params
 * @param {'master'|'hero1'|'hero2'} params.author кто только что сходил
 * @param {'master'|'hero1'|'hero2'} [params.masterChoice] кого назвал мастер в [NEXT]
 * @param {number[]} params.silence счётчики молчания героя 1 и героя 2
 * @param {number} params.randomness 0–100
 * @param {number} params.silenceThreshold
 * @param {boolean[]} [params.active] может ли ходить герой 1 и герой 2, по умолчанию оба
 * @param {(sides: number) => number} [params.roll] кубик 1..sides, по умолчанию криптостойкий
 * @returns {{next: 'master'|'hero1'|'hero2', reason: 'silence'|'after-hero'|'random'|'master'|'unavailable'}}
 */
export function chooseNext({ author, masterChoice, silence, randomness, silenceThreshold, active = [true, true], roll = rollDie }) {
    const canAct = (id) => id === 'master' || active[HERO_IDS.indexOf(id)] !== false;
    if (silenceThreshold > 0) {
        const silent = HERO_IDS
            .map((id, index) => ({ id, silence: silence[index] ?? 0 }))
            .filter((hero) => hero.id !== author && canAct(hero.id) && hero.silence >= silenceThreshold)
            .sort((a, b) => b.silence - a.silence);
        if (silent.length) return { next: silent[0].id, reason: 'silence' };
    }

    if (author !== 'master') return { next: 'master', reason: 'after-hero' };

    if (randomness > 0 && roll(100) <= randomness) {
        const pool = ACTOR_IDS.filter(canAct);
        return { next: pool[roll(pool.length) - 1], reason: 'random' };
    }
    const chosen = ACTOR_IDS.includes(masterChoice) ? masterChoice : 'hero1';
    if (canAct(chosen)) return { next: chosen, reason: 'master' };
    // Мастер назвал героя, который не может ходить: ход второму герою, если он в строю, иначе снова мастеру.
    const other = HERO_IDS.find((id) => id !== chosen && canAct(id));
    return { next: other ?? 'master', reason: 'unavailable' };
}
