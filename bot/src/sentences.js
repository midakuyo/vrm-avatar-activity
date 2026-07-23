import { takeEmotion } from './emotions.js';
// 스트리밍으로 들어오는 텍스트 조각을 문장 단위로 잘라 내보낸다.
//
// 목적은 TTFB다. 응답 전체를 기다렸다가 한 번에 합성하면 첫 소리까지 몇 초가
// 걸리지만, 첫 문장이 완성되는 즉시 합성하면 그 시간이 크게 줄어든다.

// 종결 부호 뒤에 닫는 따옴표·괄호가 붙을 수 있고, 그 다음에 공백이 와야 문장 끝으로 본다.
// (공백 조건이 없으면 "3.14" 같은 것도 잘린다)
const SENTENCE_END = /[.!?…~。！？]+["'”’)\]】」』]*\s/;

// 종결 부호 없이 길어지는 응답이 한 덩어리로 뭉치지 않도록 하는 안전장치.
const SOFT_LIMIT = Number(process.env.SENTENCE_SOFT_LIMIT ?? 60);
const SOFT_BREAK = /[,、·:;]\s|\s/g;

// 첫 조각만 짧게 끊어 첫 소리를 앞당기는 기능.
// 합성 시간이 오디오 길이에 비례하므로 지연은 줄지만, **문장 중간에서 잘려**
// "오늘은 인터넷에서 귀여운 라이브" / "방송을 보는 건 어때?" 처럼 어색하게 들린다.
// 지연(약 +0.7초)보다 자연스러움을 택해 기본은 꺼둔다. 켜려면 22 정도를 준다.
const FIRST_LIMIT = Number(process.env.SENTENCE_FIRST_LIMIT ?? 0);
const FIRST_MIN = 10;

// 0이면 문장 분할 자체를 하지 않고 응답 전체를 한 번에 합성한다.
// 가장 자연스럽지만 첫 소리가 가장 늦다.
const STREAM = process.env.SENTENCE_STREAM !== '0';

function takeOne(buffer, limit) {
  const m = SENTENCE_END.exec(buffer);
  if (m) {
    const cut = m.index + m[0].length;
    return [buffer.slice(0, cut).trim(), buffer.slice(cut)];
  }

  // 너무 길어지면 쉼표나 띄어쓰기에서 끊는다.
  if (buffer.length > limit) {
    SOFT_BREAK.lastIndex = 0;
    let last = -1;
    let m2;
    while ((m2 = SOFT_BREAK.exec(buffer)) !== null) {
      if (m2.index > limit) break;
      last = m2.index + m2[0].length;
    }
    if (last >= FIRST_MIN) return [buffer.slice(0, last).trim(), buffer.slice(last)];
  }

  return [null, buffer];
}

export async function* toSentences(deltas) {
  let buffer = '';
  let first = true;

  for await (const delta of deltas) {
    buffer += delta;
    if (!STREAM) continue; // 전부 모았다가 아래에서 한 번에 내보낸다
    for (;;) {
      // FIRST_LIMIT이 0이면 첫 조각도 일반 규칙을 따른다(중간에서 자르지 않음).
      const limit = first && FIRST_LIMIT > 0 ? FIRST_LIMIT : SOFT_LIMIT;
      const [sentence, rest] = takeOne(buffer, limit);
      if (!sentence) break;
      buffer = rest;
      first = false;
      yield sentence;
    }
  }

  // 마지막 조각에는 종결 부호 뒤 공백이 없으므로 여기서 흘려보낸다.
  const tail = buffer.trim();
  if (tail) yield tail;
}

// 문장 스트림 → 감정을 뗀 유닛. { emotion, intensity, reason, subtitle(한국어 문장) }.
// 라벨은 다음 마커까지 유지되지만 강도·이유는 마커가 붙은 그 문장의 것이다.
//
// 이월(pending): 문장 분리기는 "[happy!] " 의 '!]' + 공백을 종결로 오인해 마커만
// 있는 조각을 만든다. 그 조각의 강도·이유를 버리지 않고 다음 실문장에 붙인다 —
// 이게 없으면 느낌표 강도는 대부분 무드에 반영되지 못한다.
// 이중 언어(일본어 음성)는 여기서 하지 않는다 — sessions.js가 자막을 번역해 TTS에 넘긴다.
export async function* toUnits(deltas, { emotion = 'neutral' } = {}) {
  let cur = emotion;
  let pending = null; // { blend, intensity, reason } — 마커뿐인 조각에서 이월
  for await (const raw of toSentences(deltas)) {
    const { emotion: e, intensity, blend, reason, marked, text } = takeEmotion(raw, cur);
    cur = e;
    if (!text) {
      if (marked) pending = { blend, intensity, reason };
      continue;
    }
    const src = marked ? { blend, intensity, reason } : (pending ?? { blend, intensity, reason });
    pending = null;
    yield {
      emotion: e,
      intensity: src.intensity ?? intensity,
      // 마커 없는 문장은 직전 라벨을 단일 블렌드로 이어 밀어준다 (무드 유지).
      blend: src.blend ?? [{ label: e, intensity: src.intensity ?? 1 }],
      reason: src.reason ?? reason,
      subtitle: text,
    };
  }
}
