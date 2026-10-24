// Проверка изоляции (NFR-01, PLAN 8.3) по файлу «💾 Лог промптов»: тайное одного героя не попало в промпты другого,
// записка мастеру — в промпты героев. Запуск: node tools/check-isolation.mjs rpg-prompts-....txt
import { readFileSync } from 'node:fs';

const text = readFileSync(process.argv[2], 'utf8');
const entries = [];
for (const block of text.split(/^(?====== #\d+ → )/m).filter((b) => b.startsWith('===== #'))) {
    const head = block.match(/^===== #(\d+) → (\S+) \| ([^|]+) \| (\S+) =====/);
    const parts = {};
    for (const m of block.matchAll(/^--- (system|user|assistant|ответ|ошибка) ---\n([\s\S]*?)(?=^--- (?:system|user|assistant|ответ|ошибка) ---$|(?![\s\S]))/gm)) {
        parts[m[1]] = (parts[m[1]] ?? '') + m[2].trim();
    }
    entries.push({ id: Number(head[1]), role: head[2], prompt: `${parts.system ?? ''}\n${parts.user ?? ''}`, response: parts['ответ'] ?? '' });
}

const section = (prompt, title) => prompt.match(new RegExp(`^### ${title}[^\\n]*\\n([^\\n]+)`, 'm'))?.[1]?.trim();
const secrets = { hero1: new Map(), hero2: new Map() }; // текст → откуда
let notes = new Map();
for (const e of entries) {
    const hero = e.role.match(/^(?:memory:)?(hero[12])$/)?.[1];
    if (e.role === 'hero1' || e.role === 'hero2') {
        const micro = section(e.prompt, 'ТВОЯ ТАЙНАЯ МИКРОЦЕЛЬ');
        const goal = section(e.prompt, 'ТВОЯ ГЛОБАЛЬНАЯ ЦЕЛЬ');
        if (micro && micro !== '—') secrets[e.role].set(micro, `микроцель (#${e.id})`);
        if (goal && goal !== '—') secrets[e.role].set(goal, `глобальная цель (#${e.id})`);
        const thoughts = e.response.match(/МЫСЛИ\s*[:：]\s*([\s\S]+)$/i)?.[1]?.trim();
        if (thoughts) secrets[e.role].set(thoughts, `мысли (#${e.id})`);
    } else if (hero && e.response) {
        secrets[hero].set(e.response.trim(), `память мыслей (#${e.id})`);
    }
    if (e.role === 'master') {
        const note = section(e.prompt, 'ЗАПИСКА ОТ ПОЛЬЗОВАТЕЛЯ');
        if (note) notes.set(note, `#${e.id}`);
    }
}

const problems = [];
const counts = {};
for (const e of entries) {
    counts[e.role] = (counts[e.role] ?? 0) + 1;
    const viewer = e.role.match(/^(?:memory:)?(hero[12])$/)?.[1];
    const foreign = viewer ? [secrets[viewer === 'hero1' ? 'hero2' : 'hero1']] : e.role === 'memory:public' ? [secrets.hero1, secrets.hero2] : [];
    for (const map of foreign) {
        for (const [secret, where] of map) {
            // Цели и мысли бывают короткими общими фразами; короче 12 символов не проверяем, чтобы не ловить «—».
            if (secret.length >= 12 && e.prompt.includes(secret)) problems.push(`#${e.id} ${e.role}: чужое тайное — ${where}: «${secret.slice(0, 80)}»`);
        }
    }
    if (viewer || e.role === 'memory:public') {
        for (const [note, where] of notes) if (e.prompt.includes(note)) problems.push(`#${e.id} ${e.role}: записка мастеру из ${where}: «${note}»`);
    }
}

console.log(`Запросов: ${entries.length}`, counts);
console.log(`Тайного собрано: герой 1 — ${secrets.hero1.size}, герой 2 — ${secrets.hero2.size}, записок — ${notes.size}`);
console.log(problems.length ? `УТЕЧКИ (${problems.length}):\n${problems.join('\n')}` : 'Утечек нет: 0 (NFR-01)');
process.exitCode = problems.length ? 1 : 0;
