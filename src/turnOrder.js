// Очерёдность ходов (этап 4): случайность выбора следующего (FR-09) и защита от молчания (FR-10).
// Модуль без зависимостей от ST, проверяется тестом в Node.
// «Ход» здесь, как в модели данных ТЗ, — одна запись с одним автором: мастер или один из героев.

import { rollDie } from './dice.js';
import { HERO_IDS } from './prompts.js';

export const ACTOR_IDS = ['hero1', 'hero2', 'master'];

/**
 * Обновляет счётчики молчания после хода: автор хода — 0, остальным героям +1.
 * @param {Array<{silence?: number}>} heroes
 * @param {'master'|'hero1'|'hero2'} author
 */
export function updateSilence(heroes, author) {
    heroes.forEach((hero, index) => {
        hero.silence = HERO_IDS[index] === author ? 0 : (hero.silence ?? 0) + 1;
    });
}

/**
 * Решает, кто ходит следующим.
 * 1. Герой, который молчит `silenceThreshold` ходов и больше, ходит обязательно (FR-10). 0 — защита выключена.
 * 2. После героя всегда мастер: он описывает последствия.
 * 3. После мастера с вероятностью `randomness` % выбор мастера заменяется случайным (FR-09).
 * @param {object} params
 * @param {'master'|'hero1'|'hero2'} params.author кто только что сходил
 * @param {'master'|'hero1'|'hero2'} [params.masterChoice] кого назвал мастер в [NEXT]
 * @param {number[]} params.silence счётчики молчания героя 1 и героя 2
 * @param {number} params.randomness 0–100
 * @param {number} params.silenceThreshold
 * @param {(sides: number) => number} [params.roll] кубик 1..sides, по умолчанию криптостойкий
 * @returns {{next: 'master'|'hero1'|'hero2', reason: 'silence'|'after-hero'|'random'|'master'}}
 */
export function chooseNext({ author, masterChoice, silence, randomness, silenceThreshold, roll = rollDie }) {
    if (silenceThreshold > 0) {
        const silent = HERO_IDS
            .map((id, index) => ({ id, silence: silence[index] ?? 0 }))
            .filter((hero) => hero.id !== author && hero.silence >= silenceThreshold)
            .sort((a, b) => b.silence - a.silence);
        if (silent.length) return { next: silent[0].id, reason: 'silence' };
    }

    if (author !== 'master') return { next: 'master', reason: 'after-hero' };

    if (randomness > 0 && roll(100) <= randomness) {
        return { next: ACTOR_IDS[roll(ACTOR_IDS.length) - 1], reason: 'random' };
    }
    return { next: ACTOR_IDS.includes(masterChoice) ? masterChoice : 'hero1', reason: 'master' };
}
