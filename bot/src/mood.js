import { persona } from './persona.js';
// 무드 레이어 — 이산 감정 라벨을 연속 좌표로 바꿔 누적한다.
//
// 왜 2축인가: 1축(0~100)으로는 슬픔과 분노가 같은 자리에 놓인다. 둘 다 부정적이라
// "0~30 = 슬픔" 같은 규칙을 만들면 화난 상황에서 슬픈 표정이 나온다.
//   valence: 부정(-1) ↔ 긍정(+1)
//   arousal: 차분(-1) ↔ 흥분(+1)
//
// 왜 LLM에게 숫자를 안 시키는가: 작은 모델은 "감정: 73" 같은 숫자를 일관되게 내지
// 못한다. 라벨은 지키기 쉽고 검증도 끝났으므로, 라벨만 받고 숫자 변환은 여기서 한다.
// (마커의 강도 표기 [happy!]는 예외 — 느낌표 개수라서 숫자가 아니다. emotions.js)
//
// 상수의 근거는 docs/research-memory-emotion.md E2·E3·E5:
//   좌표: ALMA Table 2 계열 문헌값 기반
//   게인: WASABI base intensity — 놀람은 표정만 반짝, 무드는 거의 안 민다
//   감쇠: 사분면별 — 인간 실측(슬픔 ~120h vs 놀람 ~30분)의 비율 구조.
//         라벨별이 아니라 사분면별인 이유: 슬픔→놀람 순서로 밀렸을 때 마지막
//         라벨(놀람)의 빠른 감쇠가 슬픔까지 급소멸시키는 부자연을 피한다.

export const POINTS = {
  neutral:   { v:  0.0, a:  0.0, gain: 1.0 },
  happy:     { v:  0.5, a:  0.3, gain: 1.0 },
  relaxed:   { v:  0.5, a: -0.5, gain: 1.0 },
  sad:       { v: -0.5, a: -0.3, gain: 1.0 },
  angry:     { v: -0.5, a:  0.6, gain: 1.0 },
  surprised: { v:  0.1, a:  0.8, gain: 0.3 },
};

const num = (name, fallback) => {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) ? n : fallback;
};

// 이동평균 계수. 클수록 새 감정을 빨리 따라간다.
// (NaN 가드 필수 — 오타 하나로 v,a가 NaN에 고착되고 promptWord 게이트가 뒤집힌다)
const ALPHA = num('MOOD_ALPHA', 0.6);

// 사분면별 감쇠율 (idle tick마다). 지금 어떤 기분권에 있느냐가 지속을 정한다.
const DECAY = {
  sad: num('MOOD_DECAY_SAD', 0.05),       // −v −a: 슬픔은 오래 남는다
  angry: num('MOOD_DECAY_ANGRY', 0.08),   // −v +a
  happy: num('MOOD_DECAY_HAPPY', 0.12),   // +v +a
  relaxed: num('MOOD_DECAY_RELAXED', 0.30), // +v −a: 이완·안도는 금방 중립으로
};

// TTS 운율 계수 — "운율에는 arousal만" (Going Retro: arousal UAR .76, valence .43).
// valence는 스타일 선택(emotion 라벨)이 운반한다.
const SPEED_COEF = num('VOICE_SPEED_COEF', 0.2);
const PITCH_COEF = num('VOICE_PITCH_COEF', 0.05);

// ---- 성격 기질점 (⑪, ALMA + Mehrabian 1996) ----
// Big Five(각 −1~1)를 회귀식으로 "기본 무드" 좌표로 바꾼다. 감쇠가 (0,0)이 아니라
// 이 좌표로 회귀 → "방치하면 캐릭터 기질로 돌아온다". ×0.3으로 옅게(바탕색).
//   valence = 0.21E + 0.59A + 0.19S    (S = 정서안정성 = −신경증)
//   arousal = 0.15O + 0.30A − 0.57N
// 문헌마다 신경증 부호가 뒤집히는 함정 → E/A/O/C/N 5개로 명시적으로 받는다.
// persona.md(캐릭터 카드)가 우선, env(PERSONA_*)는 폴백.
const PF = persona?.bigFive ?? {};
const BIG5 = {
  o: PF.o ?? num('PERSONA_O', 0), c: PF.c ?? num('PERSONA_C', 0), e: PF.e ?? num('PERSONA_E', 0),
  a: PF.a ?? num('PERSONA_A', 0), n: PF.n ?? num('PERSONA_N', 0),
};
const TEMPER_SCALE = PF.temper ?? num('PERSONA_TEMPER_SCALE', 0.3);
const BASELINE = {
  v: clampAbs((0.21 * BIG5.e + 0.59 * BIG5.a + 0.19 * -BIG5.n) * TEMPER_SCALE),
  a: clampAbs((0.15 * BIG5.o + 0.30 * BIG5.a - 0.57 * BIG5.n) * TEMPER_SCALE),
};
function clampAbs(x) { return Math.min(0.6, Math.max(-0.6, x)); }

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// 표정 블렌드용 앵커(중립 제외)를 각도순으로 정렬해 둔다.
const ANCHORS = Object.entries(POINTS)
  .filter(([name]) => name !== 'neutral')
  .map(([name, p]) => ({ name, angle: Math.atan2(p.a, p.v), radius: Math.hypot(p.v, p.a) }))
  .sort((x, y) => x.angle - y.angle);

const TAU = Math.PI * 2;

// angle을 사이에 두는 인접 앵커 쌍 (원형). t = A→B 진행률.
function anchorPair(angle) {
  let hi = ANCHORS.findIndex((p) => p.angle >= angle);
  if (hi === -1) hi = 0; // 마지막 앵커보다 크면 첫 앵커로 감아 돈다
  const lo = (hi - 1 + ANCHORS.length) % ANCHORS.length;
  const A = ANCHORS[lo];
  const B = ANCHORS[hi];
  const span = (B.angle - A.angle + TAU) % TAU || TAU;
  const t = ((angle - A.angle + TAU) % TAU) / span;
  return { A, B, t };
}

// 그 방향에서 도달 가능한 최대 반경 (인접 앵커 반경의 보간).
// EMA는 앵커 너머로 못 가므로, 크기는 절대값이 아니라 이 반경 대비 비율로 써야
// 사분면마다 상한이 달라지는 비대칭이 사라진다 (리뷰: '짙은'이 happy/sad에서 도달 불가였다).
function reachAt(angle) {
  const { A, B, t } = anchorPair(angle);
  return A.radius * (1 - t) + B.radius * t;
}

// 프롬프트 주입용 기분 단어 (③) — 사분면 + 크기. LLM은 숫자가 아니라 단어만 받는다.
const QUADRANT_WORD = { happy: '들뜸', relaxed: '느긋함', angry: '뾰로통함', sad: '시무룩함' };

function quadrant(v, a) {
  if (v < 0) return a < 0 ? 'sad' : 'angry';
  return a < 0 ? 'relaxed' : 'happy';
}

export function createMood() {
  // 새 스코프는 캐릭터 기질에서 시작한다 (백지 0이 아니라). 저장된 세션은 restore가 덮는다.
  let v = BASELINE.v;
  let a = BASELINE.a;
  let label = 'neutral'; // 마지막으로 지시된 라벨 (히스테리시스 기준)

  const magnitude = () => Math.hypot(v, a);
  // 크기의 정규화: 절대값이 아니라 "그 방향에서 도달 가능한 최대치 대비 비율".
  // 앵커 반경이 사분면마다 달라서(happy/sad 0.58 vs surprised 0.81), 절대값 기준이면
  // 표정·짙기의 상한이 감정마다 달라지는 비대칭이 생긴다.
  const relative = () => {
    const mag = magnitude();
    if (mag < 1e-6) return 0;
    return Math.min(1, mag / reachAt(Math.atan2(a, v)));
  };
  const weight = relative;

  const nearest = () => {
    // 음성 스타일용 대표 라벨. 표정은 블렌드라 경계 떨림이 없지만
    // 스타일 ID는 하나만 골라야 하므로 히스테리시스를 유지한다.
    let best = 'neutral';
    let bestD = Infinity;
    for (const [name, p] of Object.entries(POINTS)) {
      const d = Math.hypot(p.v - v, p.a - a) * (name === label ? 0.75 : 1);
      if (d < bestD) {
        bestD = d;
        best = name;
      }
    }
    return best;
  };

  return {
    // 라벨 하나를 무드에 섞는다. intensity는 마커 강도(0~1.8, emotions.js).
    // 실효 계수 = ALPHA × 라벨 게인 × 강도. 과충전을 막기 위해 0.95에서 자른다.
    push(name, intensity = 1) {
      const p = POINTS[name];
      if (!p) return;
      label = name;
      const eff = clamp(ALPHA * p.gain * intensity, 0, 0.95);
      v += (p.v - v) * eff;
      a += (p.a - a) * eff;
    },

    // 감정 블렌드를 무드에 한 번에 섞는다 (⑧ 확장 — 인접 혼동 완화).
    // components: [{label, intensity}]. 가중 중심점 하나로 EMA 한 스텝.
    //   목표 좌표 = Σ w·P / Σw,  게인 = Σ w·gain / Σw  (놀람 게인 0.3이 blend를 옅게)
    //   실효 계수 = ALPHA × 게인 × Σw  (Σw로 총 감정량 반영, push와 동일하게 0.95 컷)
    // 지배 라벨(최대 w)이 히스테리시스·음성 스타일 기준. push의 상위집합.
    pushBlend(components) {
      if (!Array.isArray(components) || !components.length) return;
      let sw = 0, tv = 0, ta = 0, tg = 0;
      let dom = null, domW = -Infinity;
      for (const c of components) {
        const p = POINTS[c?.label];
        const w = Number(c?.intensity);
        if (!p || !(w > 0)) continue;
        sw += w; tv += p.v * w; ta += p.a * w; tg += p.gain * w;
        if (w > domW) { domW = w; dom = c.label; }
      }
      if (sw <= 0) return;
      label = dom;
      const eff = clamp(ALPHA * (tg / sw) * sw, 0, 0.95); // = ALPHA×평균게인×Σw
      v += (tv / sw - v) * eff;
      a += (ta / sw - a) * eff;
    },

    // 조용할 때 서서히 기질점으로 회귀한다 (⑪ — 0이 아니라 BASELINE으로).
    // 감쇠 속도는 현재 사분면이 정한다.
    decay() {
      const rate = DECAY[quadrant(v, a)];
      v -= (v - BASELINE.v) * rate;
      a -= (a - BASELINE.a) * rate;
    },

    get vector() {
      return { v, a };
    },

    // 표정 채널 (⑧): 좌표 각도의 인접 앵커 2개를 가중 블렌드.
    // 최근접 1개 스냅과 달리 경계에서 떨리지 않고 전환이 각도를 따라 흐른다.
    // 반환은 배열 [{name, weight}] — 합이 전체 크기 가중치.
    get expression() {
      const w = weight();
      if (w < 0.05) return [{ name: 'neutral', weight: 0 }];

      const { A, B, t } = anchorPair(Math.atan2(a, v));
      // 필터(0.05)는 반올림 전 원시값에 건다 — 0.0496이 0.05로 올라 통과하는 역전 방지.
      const parts = [
        { name: A.name, weight: w * (1 - t) },
        { name: B.name, weight: w * t },
      ].filter((e) => e.weight >= 0.05);

      // 호 중앙에서 양쪽 다 0.05 미만이어도 무드 자체는 보일 크기다 —
      // 지배 쪽 하나로 표시해 "같은 세기가 각도 따라 안 보이는" 사각지대를 없앤다.
      if (!parts.length) {
        parts.push({ name: t >= 0.5 ? B.name : A.name, weight: w });
      }
      return parts.map((e) => ({ name: e.name, weight: Number(e.weight.toFixed(3)) }));
    },

    // TTS 채널.
    //   speed     — arousal 선형 (계수 0.2, 클램프 0.85~1.25)
    //   pitch     — arousal 선형 (계수 0.05, aivis pitchScale용. Supertonic은 무시)
    //   emotion   — 대표 라벨 (SBV2 스타일 선택 = valence의 운반자)
    //   intensity — 무드 크기 0~1 (SBV2 억양 세기용)
    get voice() {
      return {
        speed: Number(clamp(1 + a * SPEED_COEF, 0.85, 1.25).toFixed(3)),
        // 어댑터에도 클램프가 있지만 계약은 여기서도 지킨다 (speed와 대칭).
        pitch: Number(clamp(a * PITCH_COEF, -0.15, 0.15).toFixed(3)),
        emotion: nearest(),
        intensity: Number(weight().toFixed(3)),
      };
    },

    // 프롬프트 주입용 (③). 옅으면 null — 중립 상태까지 물들이지 않는다.
    // 판정은 방향 상대 비율 — 절대값 기준이면 '짙은'이 happy/sad에서 도달 불가였다.
    get promptWord() {
      const rel = relative();
      if (rel < 0.25) return null;
      const word = QUADRANT_WORD[quadrant(v, a)];
      return `${rel >= 0.7 ? '짙은' : '옅은'} ${word}`;
    },

    // 디스크에서 온 값은 신뢰하지 않는다 — 손상된 session.json이 NaN·범위 밖 값을
    // 들고 오면 무드 전체가 오염된다 (NaN은 decay로도 안 풀린다).
    restore(saved) {
      if (!saved) return;
      v = Number.isFinite(saved.v) ? clamp(saved.v, -1, 1) : 0;
      a = Number.isFinite(saved.a) ? clamp(saved.a, -1, 1) : 0;
      label = typeof saved.label === 'string' && saved.label in POINTS ? saved.label : 'neutral';
    },

    get state() {
      return { v, a, label };
    },
  };
}
