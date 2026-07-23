// 오디오 재생 + 진폭 envelope 립싱크.
//
// 이 경로는 TTS 공급자와 무관하다. 오디오 바이트를 받아 AnalyserNode로
// RMS를 뽑아 비셈 가중치로 쓰므로, 스텁이든 SBV2든 클라우드 TTS든
// 바이트만 주면 그대로 동작한다.
//
// 브라우저 자동재생 정책 때문에 첫 재생 전에 사용자 제스처가 한 번 필요하다.
// SBV2로 바꿔도 이 제약은 그대로라 지금 만들어 두는 게 낭비가 아니다.

const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];

// 기본 재생 볼륨. 사용자가 조절하면 이 값을 덮어쓴다(localStorage에 기억).
const DEFAULT_VOLUME = 0.5;

// userId: Discord 유저별로 볼륨을 기억한다(같은 기기를 여러 계정이 써도 분리).
export function createSpeech(avatar, { userId } = {}) {
  const storeKey = `marou-volume:${userId ?? 'local'}`;
  let ctx = null;
  let analyser = null;
  let gain = null; // 출력 볼륨. 립싱크는 analyser(gain 앞)에서 읽어 볼륨과 무관하다.
  let volume = (() => {
    const saved = Number(localStorage.getItem(storeKey));
    return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : DEFAULT_VOLUME;
  })();
  let ready = false;
  let current = null; // 재생 중인 소스
  // 문장이 도착하는 대로 쌓고 순서대로 이어 재생한다.
  // 합성이 재생보다 빠르므로 큐가 비면 잠시 멈췄다가 다음 문장을 받는다.
  const queue = [];
  let draining = false;
  let onDrainedCb = null;
  let onEventCb = null; // 텔레메트리 (play-start/end/error/suspended)

  const ensureContext = () => {
    if (!ctx) {
      ctx = new (window.AudioContext ?? window.webkitAudioContext)();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
      // source → analyser → gain → destination.
      // 볼륨(gain)은 analyser 뒤에 둔다 — 립싱크는 analyser에서 원음 진폭을 읽으므로
      // 볼륨을 낮춰도 입 움직임은 그대로다.
      gain = ctx.createGain();
      gain.gain.value = volume;
      analyser.connect(gain);
      gain.connect(ctx.destination);
    }
    return ctx;
  };

  const clearMouth = () => {
    for (const v of VISEMES) avatar.setViseme(v, 0);
  };

  // 재생 중인 소스만 멈춘다. 큐는 건드리지 않는다 —
  // play()가 큐를 비우면, 첫 문장 디코딩 중에 도착한 다음 문장들이 사라진다.
  const stopCurrent = () => {
    if (!current) return;
    const source = current;
    current = null;
    try {
      source.stop();
    } catch {
      // 이미 끝난 소스
    }
    clearMouth();
  };

  return {
    get ready() {
      return ready;
    },

    // 사용자 제스처 안에서 호출해야 한다.
    async prime() {
      ensureContext();
      if (ctx.state === 'suspended') await ctx.resume();
      ready = ctx.state === 'running';
      return ready;
    },

    async play(base64, mime) {
      if (!base64) return;
      ensureContext();
      if (ctx.state === 'suspended') {
        // 제스처 없이 도착한 경우. 소리는 포기하고 조용히 넘어간다.
        console.warn('[speech] AudioContext가 suspended 상태 — 재생 생략');
        onEventCb?.('suspended');
        return;
      }

      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const buffer = await ctx.decodeAudioData(bytes.buffer);

      stopCurrent(); // 이전 소스만 정리. 큐를 비우면 안 된다(뒤 문장 소실)

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      current = source;

      const data = new Uint8Array(analyser.fftSize);
      let raf = 0;

      const tick = () => {
        if (current !== source) return;
        analyser.getByteTimeDomainData(data);

        // RMS — 0..1
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const open = Math.min(1, rms * 3.2);

        // 진폭만으로는 입모양이 단조로우니, 느린 오실레이터로
        // 모음 사이를 오가게 해서 말하는 것처럼 보이게 한다.
        // (정확한 음소 립싱크는 나중 과제)
        const t = ctx.currentTime;
        const blend = (Math.sin(t * 5.3) + 1) / 2;
        const primary = blend < 0.5 ? 'aa' : 'oh';
        const secondary = blend < 0.5 ? 'ih' : 'ou';

        for (const v of VISEMES) avatar.setViseme(v, 0);
        avatar.setViseme(primary, open * 0.75);
        avatar.setViseme(secondary, open * 0.3);

        raf = requestAnimationFrame(tick);
      };

      onEventCb?.(`play ${buffer.duration.toFixed(1)}s`);
      return new Promise((resolve) => {
        source.onended = () => {
          cancelAnimationFrame(raf);
          if (current === source) {
            current = null;
            clearMouth();
          }
          onEventCb?.('ended');
          resolve();
        };
        source.start();
        tick();
      });
    },

    // 문장 단위로 들어온 오디오를 순서대로 이어 재생한다.
    // onStart는 그 문장이 실제로 소리나기 시작할 때 불린다(자막 동기화용).
    enqueue(base64, onStart) {
      queue.push({ base64, onStart });
      if (!draining) this.drain();
    },

    async drain() {
      draining = true;
      while (queue.length) {
        const { base64, onStart } = queue.shift();
        onStart?.();
        if (!base64) continue;
        try {
          await this.play(base64);
        } catch (err) {
          console.error('[speech] 재생 실패:', err);
          onEventCb?.(`error ${err?.message ?? err}`);
        }
      }
      draining = false;
      onDrainedCb?.();
    },

    // 큐가 실제로 다 재생됐을 때 알림. 종료 판단은 서버 추정이 아니라 여기가 진실이다.
    onDrained(fn) {
      onDrainedCb = fn;
    },

    onEvent(fn) {
      onEventCb = fn;
    },

    get busy() {
      return draining || queue.length > 0;
    },

    // 전체 중단: 큐 폐기 + 현재 소스 정지. 새 응답이 시작될 때만 쓴다.
    stop() {
      queue.length = 0;
      stopCurrent();
    },

    // 재생 볼륨 (0~1). 립싱크에는 영향 없다.
    getVolume() {
      return volume;
    },
    setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      if (gain) gain.gain.value = volume;
      localStorage.setItem(storeKey, String(volume));
    },
  };
}
