// 모션 컨트롤러 — Mixamo 클립을 상태(idle/thinking/speaking)에 매핑해 크로스페이드한다.
//
// 상태마다 클립 변형을 여러 개 둘 수 있다 (idle-1, idle-2 …).
//   - 상태에 들어갈 때 변형 중 하나를 무작위로 고른다
//   - idle에 오래 머물면 다른 변형으로 천천히 갈아탄다 (가만히 있어도 살아 보이게)
//
// 클립이 하나도 없으면 active=false 그대로이고, 호출부는 기존 프리셋 포즈로
// 폴백한다. 표정·비셈은 blendshape 채널이라 본 애니메이션과 겹치지 않는다.

import * as THREE from 'three';
import { loadMixamoAnimation } from './loadMixamoAnimation.js';

const FADE_S = 0.4;
// idle 변형 전환 주기(초). 약간의 무작위를 섞어 기계적으로 보이지 않게 한다.
const IDLE_VARY_S = 14;

// 상태별 움직임 폭. 1 = 원본, 0 = 첫 프레임 자세에 고정.
// 각 키프레임을 클립의 기준 자세(첫 프레임) 쪽으로 보간해 폭만 줄인다 —
// 자세 자체는 유지되므로 팔이 올라가거나 하지 않는다.
const STATE_SCALE = { idle: 0.5 };

export function createMotion(vrm) {
  const mixer = new THREE.AnimationMixer(vrm.scene);
  const pools = new Map(); // state -> [action, ...]
  const clipsByState = new Map(); // state -> [{ clip, orig }, ...] (폭 조정용 원본 보관)
  // 상태별 공유 기준 자세 (트랙 이름 -> 첫 클립의 첫 프레임 값).
  // 변형들을 각자의 첫 프레임이 아니라 같은 자세로 당겨야, 변형 간 크로스페이드에서
  // 기본 자세 차이가 미끄러지듯 드러나는 걸 막을 수 있다.
  const stateRefs = new Map();

  // track.values를 제자리에서 덮어쓴다. mixer의 인터폴런트가 같은 배열을
  // 참조하므로 재생 중에도 즉시 반영된다.
  const applyScale = (clip, orig, factor, refs) => {
    const qRef = new THREE.Quaternion();
    const q = new THREE.Quaternion();
    clip.tracks.forEach((track, ti) => {
      const src = orig[ti];
      const dst = track.values;
      const ref = refs?.get(track.name) ?? src;
      if (track instanceof THREE.QuaternionKeyframeTrack) {
        qRef.fromArray(ref, 0);
        for (let i = 0; i < src.length; i += 4) {
          q.fromArray(src, i).slerp(qRef, 1 - factor).toArray(dst, i);
        }
      } else {
        // 위치 트랙(hips 등): 기준 자세의 같은 성분을 향해 선형 축소
        const size = track.getValueSize();
        for (let i = 0; i < src.length; i++) {
          const r = ref[i % size];
          dst[i] = r + (src[i] - r) * factor;
        }
      }
    });
  };
  let current = null;
  let state = null;
  let active = false;
  let sinceSwitch = 0;
  let nextVary = IDLE_VARY_S + Math.random() * 8;
  let lastTime = 0; // idle 변주의 루프 경계 감지용

  const pickFrom = (pool) => {
    if (pool.length === 1) return pool[0];
    // 지금 것과 다른 변형을 고른다
    const candidates = pool.filter((a) => a !== current);
    return candidates[Math.floor(Math.random() * candidates.length)];
  };

  const playAction = (next, fade = FADE_S) => {
    if (!next || next === current) return;
    next.reset().play();
    if (current) {
      current.crossFadeTo(next, fade, false);
    } else {
      next.fadeIn(fade);
    }
    current = next;
    sinceSwitch = 0;
    lastTime = 0;
    nextVary = IDLE_VARY_S + Math.random() * 8;
  };

  return {
    // idle 클립이 하나라도 로드되면 true — 호출부가 포즈 시스템을 끄는 기준.
    get active() {
      return active;
    },

    async load(name, url) {
      const clip = await loadMixamoAnimation(url, vrm);
      const orig = clip.tracks.map((t) => t.values.slice());
      if (!clipsByState.has(name)) clipsByState.set(name, []);
      clipsByState.get(name).push({ clip, orig });

      // 이 상태의 첫 클립이 기준 자세가 된다 (idle-1이 먼저 로드된다)
      if (!stateRefs.has(name)) {
        const refs = new Map();
        for (const t of clip.tracks) refs.set(t.name, t.values.slice(0, t.getValueSize()));
        stateRefs.set(name, refs);
      }

      const scale = STATE_SCALE[name];
      if (scale != null && scale < 1) applyScale(clip, orig, scale, stateRefs.get(name));

      const action = mixer.clipAction(clip);
      if (!pools.has(name)) pools.set(name, []);
      pools.get(name).push(action);
      if (name === 'idle') active = true;
      return name;
    },

    // 움직임 폭 실시간 조정 (0~1). 재생 중에도 즉시 반영된다.
    setScale(name, factor) {
      const entries = clipsByState.get(name);
      if (!entries?.length) return;
      const f = Math.max(0, Math.min(1, factor));
      for (const { clip, orig } of entries) applyScale(clip, orig, f, stateRefs.get(name));
    },

    // 상태 전환. 해당 상태의 클립이 없으면 idle 풀로 대신한다.
    setState(name) {
      const pool = pools.get(name) ?? pools.get('idle');
      if (!pool?.length) return;
      state = name;
      playAction(pickFrom(pool));
    },

    update(dt) {
      mixer.update(dt);
      sinceSwitch += dt;
      // idle에 오래 머물면 변형을 갈아탄다. 전환은 느긋하게(1초).
      // 아무 순간에나 끊지 않고 루프가 한 바퀴 끝나는 시점까지 기다린다 —
      // 두 클립 다 시작 자세 근처라 크로스페이드가 가장 덜 어색한 순간이다.
      const idlePool = pools.get('idle');
      if (state === 'idle' && idlePool?.length > 1 && sinceSwitch > nextVary && current) {
        const wrapped = current.time < lastTime; // LoopRepeat은 time이 [0, duration)으로 감긴다
        lastTime = current.time;
        if (wrapped) playAction(pickFrom(idlePool), 1.0);
      }
    },
  };
}
