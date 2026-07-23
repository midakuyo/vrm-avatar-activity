// 유저 md 본문의 항목 단위 조작 (docs/memory-emotion-plan.md ⑥).
//
// 통재작성은 반복될수록 사실이 조용히 유실·변형된다(drift). 그래서 LLM에는
// 번호 붙은 항목 목록을 주고 연산(ADD/UPDATE/DELETE/TOUCH)만 받는다 —
// 연산이 없는 항목은 바이트 그대로 유지되므로 drift가 구조적으로 불가능하다.
//
// 본문 형식: '## 섹션' 제목 + '- ' 불릿. 항목 id는 위에서부터 1번.

import { machineCheck } from './memguard.js';

// 인젝션 페이로드가 실릴 공간을 줄이는 상한 (docs/privacy-plan.md 3겹)
const ITEM_MAX_LEN = Number(process.env.MEMORY_ITEM_MAX_LEN ?? 120);
const ITEMS_MAX = Number(process.env.MEMORY_ITEMS_MAX ?? 40);

// 항목 끝의 망각곡선 메타 주석 (⑩): <!-- 2026-07-22 S3 -->
// day = 마지막 회상(TOUCH·ADD·UPDATE) 날짜, s = 강도(회상마다 +1).
// 주입(listForPrompt)에는 노출하지 않는다 — 토큰 낭비·LLM 혼란 방지.
const META = /\s*<!--\s*(\d{4}-\d{2}-\d{2})?\s*S(\d+)\s*-->\s*$/;
const dayNum = (d) => (d ? Date.parse(d) / 86_400_000 : NaN);
const todayStr = () => new Date().toISOString().slice(0, 10);

// 본문 → { title, sections: [{name, items:[{id, text, day, s}]}] }
export function parseItems(body, fallbackTitle = '') {
  const lines = (body ?? '').split('\n');
  let title = fallbackTitle;
  const sections = [];
  let current = null;
  let id = 0;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('# ') && !t.startsWith('## ')) {
      title = t.slice(2).trim() || title;
    } else if (t.startsWith('## ')) {
      current = { name: t.slice(3).trim(), items: [] };
      sections.push(current);
    } else if (t.startsWith('- ')) {
      if (!current) {
        current = { name: '기타', items: [] };
        sections.push(current);
      }
      id += 1;
      let text = t.slice(2).trim();
      const m = text.match(META);
      const day = m?.[1] ?? null;
      const s = m ? Number(m[2]) : 1;
      if (m) text = text.slice(0, m.index).trim();
      current.items.push({ id, text, day, s });
    }
    // 그 외 줄(빈 줄·잡문)은 버린다 — 항목 규율이 곧 검증 가능성이다.
  }
  return { title, sections };
}

export function buildBody(doc) {
  const parts = [`# ${doc.title || '유저'}`];
  for (const sec of doc.sections) {
    if (!sec.items.length) continue;
    parts.push('', `## ${sec.name}`);
    for (const item of sec.items) {
      const meta = ` <!-- ${item.day ?? todayStr()} S${item.s ?? 1} -->`;
      parts.push(`- ${item.text}${meta}`);
    }
  }
  return parts.join('\n') + '\n';
}

// 보유율 R = e^(−t/S). t = 마지막 회상 후 경과일, S = 강도. 낮을수록 흐릿한 기억.
// rethink가 "무엇부터 축약할지"의 근거 (MemoryBank). 날짜 없으면 R=1(갓 생김).
export function retention(item, today = todayStr()) {
  const t = dayNum(today) - dayNum(item.day);
  if (!Number.isFinite(t) || t <= 0) return 1;
  return Math.exp(-t / Math.max(1, item.s ?? 1));
}

// LLM에 보여줄 번호 목록. 메타 주석은 text에서 이미 분리돼 노출되지 않는다.
export function listForPrompt(doc) {
  const lines = [];
  for (const sec of doc.sections) {
    for (const item of sec.items) lines.push(`${item.id}. [${sec.name}] ${item.text}`);
  }
  return lines.join('\n') || '(아직 없음)';
}

// rethink에 줄 힌트: 가장 흐릿한(R 낮은) 항목들 — "이것부터 합치거나 줄여라".
export function fadingItems(doc, n = 5) {
  const all = [];
  for (const sec of doc.sections) for (const item of sec.items) all.push(item);
  return all
    .map((item) => ({ text: item.text, r: retention(item) }))
    .sort((a, b) => a.r - b.r)
    .slice(0, n)
    .filter((x) => x.r < 0.6)
    .map((x) => x.text);
}

// 항목 텍스트 정리. ⑩ 메타(<!-- 날짜 S# -->)를 텍스트에서 굳이 지우지 않는다:
// buildBody가 진짜 메타를 항상 줄 끝에 덧붙이고 META 정규식이 $ 앵커라,
// 텍스트에 낀 주석은 메타로 오인될 수 없다(우리 메타가 늘 마지막에 매칭).
// 지우려 HTML 주석 패턴을 replace 하면 살균기로 오인돼 오탐만 낳는다(CodeQL).
const cleanText = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ITEM_MAX_LEN);

// 연산 적용. 반환: { doc, applied, dropped } — dropped는 감사 로그용 사유 포함.
// TOUCH는 ⑩(망각곡선)의 자리 — 지금은 기록만 하고 아무것도 바꾸지 않는다.
export function applyOps(doc, ops, { validate } = {}) {
  const applied = [];
  const dropped = [];
  const byId = new Map();
  for (const sec of doc.sections) for (const item of sec.items) byId.set(item.id, { sec, item });
  let count = byId.size;

  const today = todayStr();
  for (const op of ops ?? []) {
    const kind = String(op.op ?? '').toUpperCase();
    if (kind === 'NOOP') continue;
    if (kind === 'TOUCH') {
      // 회상 (⑩) — 이번 대화에서 언급된 항목의 강도 S를 올리고 시계를 리셋한다.
      const found = byId.get(Number(op.id));
      if (found) {
        found.item.s = (found.item.s ?? 1) + 1;
        found.item.day = today;
        applied.push({ op: 'TOUCH', id: found.item.id });
      }
      continue;
    }
    if (kind === 'ADD') {
      const text = cleanText(op.text);
      if (!text) continue;
      if (count >= ITEMS_MAX) {
        dropped.push({ op, why: 'items-max' });
        continue;
      }
      const name = cleanText(op.section) || '기타';
      // text는 2겹 훅(기계+LLM 판정), section은 기계 필터로 검증한다 — 섹션 이름도
      // buildBody에서 '## '로 본문에 박혀 프롬프트에 주입되는 페이로드 통로다
      // (리뷰: 무검증이던 필드). validate 훅의 판정 맵은 op.text 전용이라 재사용 불가.
      const verdict = validate?.(text, op) || machineCheck(name);
      if (verdict) {
        dropped.push({ op, why: verdict });
        continue;
      }
      let sec = doc.sections.find((s) => s.name === name);
      if (!sec) {
        sec = { name, items: [] };
        doc.sections.push(sec);
      }
      sec.items.push({ id: 0, text, day: today, s: 1 }); // id는 재직렬화 후 다시 매겨진다
      count += 1;
      applied.push({ op: 'ADD', section: name, text });
    } else if (kind === 'UPDATE') {
      const found = byId.get(Number(op.id));
      const text = cleanText(op.text);
      if (!found || !text) {
        dropped.push({ op, why: 'bad-target' });
        continue;
      }
      const verdict = validate?.(text, op);
      if (verdict) {
        dropped.push({ op, why: verdict });
        continue;
      }
      applied.push({ op: 'UPDATE', id: found.item.id, from: found.item.text, text });
      found.item.text = text;
      found.item.s = (found.item.s ?? 1) + 1; // 갱신도 회상이다
      found.item.day = today;
    } else if (kind === 'DELETE') {
      const found = byId.get(Number(op.id));
      if (!found) {
        dropped.push({ op, why: 'bad-target' });
        continue;
      }
      found.sec.items = found.sec.items.filter((i) => i !== found.item);
      byId.delete(Number(op.id));
      count -= 1;
      applied.push({ op: 'DELETE', id: op.id, text: found.item.text });
    } else if (kind) {
      dropped.push({ op, why: 'unknown-op' });
    }
  }
  return { doc, applied, dropped };
}
