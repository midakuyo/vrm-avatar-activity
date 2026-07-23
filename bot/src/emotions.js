// 문장 앞머리의 감정 마커를 떼어낸다.
//   "[happy] 안녕!"            → { emotion:'happy', intensity:1,   text:'안녕!' }
//   "[happy!!] 대박!"          → { emotion:'happy', intensity:1.8, text:'대박!' }
//   "[happy:0.8] 좋네"         → { emotion:'happy', intensity:0.8, text:'좋네' }
//   "[happy!|칭찬받아서] 고마워" → { …, intensity:1.4, reason:'칭찬받아서' }
//
// 규칙 (docs/memory-emotion-plan.md ③⑨):
// - 라벨은 VRM 표정 프리셋과 1:1
// - 마커가 없으면 직전 감정 유지 (강도는 유지하지 않고 1로 복귀)
// - 강도는 3형식 동시 수용 — 프롬프트는 느낌표만 지시하지만, 모델을 키워
//   숫자 지시로 바꿔도 코드 무수정 (숫자는 0~1 클램프, ! ×1.4, !! ×1.8)
// - 이유 구절은 '|' 뒤 — 로그·관계 레이어(⑭)·Reflection(⑤)의 재료. 자막에는 안 나간다
// - 화이트리스트 밖 라벨은 무시하되, 문장 앞의 대괄호 그룹 자체는 반드시 제거
//   (남기면 TTS가 "대괄호 해피"를 소리 내어 읽는다 — 이게 최대 실패 모드)
// - 작은 모델이 형식을 어기는 것을 전제로 한다 — 어떤 부분이 깨져도 라벨만 건진다

export const EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];

// 문장 앞의 대괄호 그룹. 이유 구절이 있어 길 수 있다. 라벨이 아니어도 제거 대상.
// (상한이 짧으면 긴 이유가 붙은 마커 전체가 인식 밖으로 벗어난다 — 여유 있게)
const LEADING = /^\s*\[([^\]\n]{1,120})\]\s*/;
// 문장 중간에 낀 화이트리스트 라벨 마커 — 제거만 한다.
// 접미 문법을 좁게 매칭하면 [happy!:0.8] 같은 변칙 조합이 자막·TTS로 유출되므로,
// 라벨로 시작하는 대괄호 그룹은 접미가 무엇이든 통째로 제거한다.
const INLINE = new RegExp(`\\s*\\[(?:${EMOTIONS.join('|')})\\b[^\\]\\n]*\\]\\s*`, 'gi');

// 대괄호 내용 해석: (토큰 공백구분 1개 이상)(|이유)?
//   토큰 = label(!|!!|:숫자)?  →  단일이면 blend 길이 1, 여러 개면 감정 블렌드.
//   블렌드는 인접 감정 혼동(느긋↔기쁨)의 해법 — 하나를 강요하는 대신 섞어 착지시킨다.
const TOKEN = /^([a-z]+)(!{1,2})?(?::(\d*\.?\d+))?$/i;

function tokenIntensity(m) {
  if (m[2]) return m[2] === '!' ? 1.4 : 1.8;
  if (m[3] !== undefined) {
    const n = Number(m[3]);
    // 0은 "무드에 영향 없음"이 아니라 형식 실수일 가능성이 높다 — 바닥 0.05.
    return Number.isFinite(n) ? Math.min(1, Math.max(0.05, n)) : 1;
  }
  return 1;
}

// 반환: { blend: [{label, intensity}], reason }. blend가 비면 유효 라벨 없음.
function parseMarker(content) {
  const bar = content.indexOf('|');
  const head = (bar === -1 ? content : content.slice(0, bar)).trim();

  const blend = [];
  for (const tok of head.split(/\s+/).filter(Boolean)) {
    const m = TOKEN.exec(tok);
    // 강도 표기가 깨져도([happy:abc] 등) 라벨만은 건진다 — 앞머리 영단어로 폴백.
    const label = (m ? m[1] : tok.match(/^[a-z]+/i)?.[0] ?? '').toLowerCase();
    if (!EMOTIONS.includes(label)) continue;
    blend.push({ label, intensity: m ? tokenIntensity(m) : 1 });
  }
  // 이유는 유효 라벨이 하나라도 있을 때만 — 미지 마커의 잡문이 이유로 오귀속되지 않게.
  if (!blend.length) return { blend: [], reason: null };
  const reason = bar === -1 ? null : content.slice(bar + 1).trim() || null;
  return { blend, reason };
}

// 블렌드에서 대표 라벨·강도 (최대 가중치). 표정 스냅샷·음성 스타일·라벨 이월용.
function dominant(blend) {
  return blend.reduce((x, y) => (y.intensity > x.intensity ? y : x));
}

// marked: 이 문장에서 실제로 화이트리스트 마커를 소비했는가.
// 문장 분리기가 "[happy!] " 를 마커만 있는 조각으로 잘라내는 경우가 있어서(느낌표가
// 종결 부호로 오인됨), 호출부(toUnits)가 marked·빈 text 조합을 보고 강도를 다음
// 문장으로 이월한다 — 이게 없으면 강도가 무드에 전혀 반영되지 않는다.
export function takeEmotion(sentence, current = 'neutral') {
  let text = sentence;
  let emotion = current;
  let intensity = 1; // 마커 없는 문장은 직전 라벨 유지 + 기본 강도
  let reason = null;
  let marked = false;
  let blend = null; // 마커의 감정 블렌드 [{label,intensity}] — 무드 push용

  // 앞머리 마커는 여러 개 붙을 수도 있다 ("[happy][relaxed] ...")
  let m;
  while ((m = LEADING.exec(text)) !== null) {
    const parsed = parseMarker(m[1]);
    if (parsed.blend.length) {
      // 별개 대괄호가 여럿이면 합쳐 하나의 블렌드로 본다 ("[happy][relaxed]").
      blend = (blend ?? []).concat(parsed.blend);
      const dom = dominant(blend);
      emotion = dom.label;
      intensity = dom.intensity;
      marked = true;
    }
    if (parsed.reason) reason = parsed.reason;
    text = text.slice(m[0].length);
  }

  // 이유 구절에 ']'가 들어가면 LEADING이 반쪽에서 끊겨 "잔여]" 꼬리가 남는다.
  // 마커를 소비한 직후에만, 앞머리의 고아 닫는 대괄호 조각을 정리한다.
  if (marked) text = text.replace(/^[^\[\]\n]{0,40}\]\s*/, '');

  text = text.replace(INLINE, ' ').replace(/\s{2,}/g, ' ').trim();

  return { emotion, intensity, blend, reason, marked, text };
}
