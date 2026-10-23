// Тест разбора ответов героя и мастера (PLAN 2.3). Запуск: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { ParseError, parseHeroResponse, parseMasterResponse } from '../src/parse.js';

const foreignNames = ['Лиа', 'Мастер'];

// Десять ответов в разной разметке, которую выдают реальные модели.
const GOOD = [
    ['РЕПЛИКА: Эй, хозяин, налей-ка эля!\nНАМЕРЕНИЕ: Подхожу к стойке.\nМЫСЛИ: Ключи висят слева.',
        { speech: 'Эй, хозяин, налей-ка эля!', intent: 'Подхожу к стойке.', thoughts: 'Ключи висят слева.' }],
    ['**Реплика:** «Привет»\n**Намерение:** Сажусь у огня\n**Мысли:** Скучно', { speech: 'Привет', intent: 'Сажусь у огня', thoughts: 'Скучно' }],
    ['## Реплика\nКто здесь?\n\n## Намерение\nОглядываюсь\n\n## Мысли\nНе нравится мне это',
        { speech: 'Кто здесь?', intent: 'Оглядываюсь', thoughts: 'Не нравится мне это' }],
    ['SPEECH: Hello there.\nINTENT: I wave.\nTHOUGHTS: Suspicious.', { speech: 'Hello there.', intent: 'I wave.', thoughts: 'Suspicious.' }],
    ['РЕПЛИКА: —\nНАМЕРЕНИЕ: Молча прячу письмо за пазуху.\nМЫСЛИ: Никто не должен его прочесть.',
        { speech: '', intent: 'Молча прячу письмо за пазуху.', thoughts: 'Никто не должен его прочесть.' }],
    ['{"speech": "Ладно", "intent": "Киваю", "thoughts": "Посмотрим"}', { speech: 'Ладно', intent: 'Киваю', thoughts: 'Посмотрим' }],
    ['```json\n{"РЕПЛИКА": "Да", "НАМЕРЕНИЕ": "Встаю", "МЫСЛИ": "Пора"}\n```', { speech: 'Да', intent: 'Встаю', thoughts: 'Пора' }],
    ['Реплика — Слушай, Лиа, у меня план.\nДействие — Наклоняюсь к ней.\nМысли — Она согласится.',
        { speech: 'Слушай, Лиа, у меня план.', intent: 'Наклоняюсь к ней.', thoughts: 'Она согласится.' }],
    ['РЕПЛИКА: Первая строка.\nВторая строка той же реплики.\nНАМЕРЕНИЕ: Иду к двери.',
        { speech: 'Первая строка.\nВторая строка той же реплики.', intent: 'Иду к двери.', thoughts: '' }],
    ['РЕПЛИКА: Пойдём!\nЛиа: Нет, подожди.\nНАМЕРЕНИЕ: Тяну её за руку.\nМЫСЛИ: Время уходит.',
        { speech: 'Пойдём!', intent: 'Тяну её за руку.', thoughts: 'Время уходит.' }],
];

GOOD.forEach(([raw, expected], index) => {
    test(`ответ героя #${index + 1} разбирается`, () => {
        assert.deepEqual(parseHeroResponse(raw, { foreignNames }), expected);
    });
});

test('неразбираемый ответ героя → ошибка', () => {
    assert.throws(() => parseHeroResponse('Я просто иду к стойке и заказываю эль.', { foreignNames }), ParseError);
    assert.throws(() => parseHeroResponse('', { foreignNames }), ParseError);
    assert.throws(() => parseHeroResponse('РЕПЛИКА: —\nНАМЕРЕНИЕ: —\nМЫСЛИ: Хм.', { foreignNames }), ParseError);
});

test('мастер: текст, бросок и следующий', () => {
    const raw = 'Трактирщик хмурится. Арен тянется к ключам. [ROLL d20 DEX DC12 hero1]\n[NEXT: hero2]';
    const result = parseMasterResponse(raw, { heroNames: ['Арен', 'Лиа'] });
    assert.equal(result.text, 'Трактирщик хмурится. Арен тянется к ключам.');
    assert.equal(result.next, 'hero2');
    assert.equal(result.rolls.length, 1);
});

test('мастер: следующий по имени, без скобок, мастер', () => {
    const names = { heroNames: ['Арен', 'Лиа'] };
    assert.equal(parseMasterResponse('Текст.\n[NEXT: Лиа]', names).next, 'hero2');
    assert.equal(parseMasterResponse('Текст.\n**Следующий:** Арен', names).next, 'hero1');
    assert.equal(parseMasterResponse('Текст.\n[СЛЕДУЮЩИЙ: мастер]', names).next, 'master');
    assert.equal(parseMasterResponse('Текст без метки.', names).next, null);
    assert.throws(() => parseMasterResponse('[NEXT: hero1]', names), ParseError);
});
