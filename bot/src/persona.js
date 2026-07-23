// 캐릭터 카드 로더 — persona.md 하나가 캐릭터다.
//
// 왜 env가 아니라 파일인가: 성격 서술은 산문(멀티라인)인데 env는 한 줄 문법이다.
// 이 장르의 관례(Open-LLM-VTuber의 캐릭터 YAML, SillyTavern의 캐릭터 카드)도
// "캐릭터 = 구조화된 파일"이다. env(LLM_SYSTEM_PROMPT·PERSONA_*)는 폴백으로 남긴다.
//
// 형식 (frontmatter + 본문, 기억 파일들과 같은 문법 — 의존성 0):
//   ---
//   big_five: { o: 0.3, c: 0.2, e: 0.7, a: 0.6, n: 0.3 }
//   temper_scale: 0.3        ← 선택
//   ---
//   너는 ... (시스템 프롬프트 산문, 멀티라인 자유)

import { readFileSync } from 'node:fs';

const FILE = process.env.PERSONA_FILE ?? '/app/persona.md';

function parse(raw) {
  let body = raw;
  let bigFive = null;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    const head = fm[1];
    const inline = /big_five:\s*\{([^}]*)\}/.exec(head);
    if (inline) {
      bigFive = {};
      for (const k of ['o', 'c', 'e', 'a', 'n']) {
        const m = new RegExp(`\\b${k}\\s*:\\s*(-?\\d*\\.?\\d+)`).exec(inline[1]);
        if (m) bigFive[k] = Number(m[1]);
      }
    }
    const t = /temper_scale:\s*(-?\d*\.?\d+)/.exec(head);
    if (t) (bigFive ??= {}).temper = Number(t[1]);
  }
  const prompt = body.trim();
  return prompt || bigFive ? { prompt, bigFive } : null;
}

function load() {
  try {
    // 파일이 없으면(또는 마운트 실수로 디렉터리면) 조용히 null — env 폴백이 받는다.
    return parse(readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

export const persona = load();

if (persona) {
  const b = persona.bigFive;
  console.log(
    `[persona] ${FILE} 로드 — 프롬프트 ${persona.prompt.length}자` +
      (b ? `, big five o=${b.o ?? '-'} c=${b.c ?? '-'} e=${b.e ?? '-'} a=${b.a ?? '-'} n=${b.n ?? '-'}` : ''),
  );
}
