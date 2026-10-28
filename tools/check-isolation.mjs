// Проверка изоляции (NFR-01, PLAN 8.3) по файлу «💾 Лог промптов»: тайное одного героя не попало в промпты другого,
// записка мастеру — в промпты героев. Этапы 11–13: до 10 героев (hero1…hero10), общая память по группам (memory:public:B).
// Запуск: node tools/check-isolation.mjs rpg-prompts-....txt
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
const HERO_ROLE = /^(?:memory:)?(hero\d+)$/;
const isPublicMemory = (role) => /^memory:public(?::[A-E])?$/.test(role);
const secrets = {}; // heroN → Map(текст → откуда)
const groups = {}; // heroN → группы из «Твоя группа: X»
const notes = new Map();
for (const e of entries) {
    const hero = e.role.match(HERO_ROLE)?.[1];
    if (hero) secrets[hero] ??= new Map();
    if (hero && hero === e.role) {
        const group = e.prompt.match(/^Твоя группа: ([^.\n]+)/m)?.[1];
        if (group) (groups[hero] ??= new Set()).add(group);
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
    const viewer = e.role.match(HERO_ROLE)?.[1];
    const foreign = Object.entries(secrets)
        .filter(([id]) => viewer ? id !== viewer : isPublicMemory(e.role))
        .map(([, map]) => map);
    for (const map of foreign) {
        for (const [secret, where] of map) {
            // Цели и мысли бывают короткими общими фразами; короче 12 символов не проверяем, чтобы не ловить «—».
            if (secret.length >= 12 && e.prompt.includes(secret)) problems.push(`#${e.id} ${e.role}: чужое тайное — ${where}: «${secret.slice(0, 80)}»`);
        }
    }
    if (viewer || isPublicMemory(e.role)) {
        for (const [note, where] of notes) if (e.prompt.includes(note)) problems.push(`#${e.id} ${e.role}: записка мастеру из ${where}: «${note}»`);
    }
}

console.log(`Запросов: ${entries.length}`, counts);
const collected = Object.keys(secrets).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((id) => `${id} — ${secrets[id].size}${groups[id] ? ` (группы: ${[...groups[id]].join(', ')})` : ''}`);
console.log(`Тайного собрано: ${collected.join('; ') || 'ничего'}; записок — ${notes.size}`);
console.log(problems.length ? `УТЕЧКИ (${problems.length}):\n${problems.join('\n')}` : 'Утечек нет: 0 (NFR-01)');
process.exitCode = problems.length ? 1 : 0;
