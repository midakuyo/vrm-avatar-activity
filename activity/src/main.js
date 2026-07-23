import { createAvatarStage } from './avatar.js';
import { mountAdminPanel } from './admin.js';
import { connectBus } from './bus.js';
import { mountChat } from './chat.js';
import { createSpeech } from './speech.js?v=2';
import { createMotion } from './motion.js';

const stage = document.getElementById('stage');
const status = document.getElementById('status');
const panel = document.getElementById('panel');
const meta = document.getElementById('meta');
const conn = document.getElementById('conn');
const speech = document.getElementById('speech');
const thought = document.getElementById('thought');

const MODEL_URL = '/models/sample.vrm';

// 생각 풍선 (⑬) — 음성 없이 잠시 떴다 사라진다. 새 생각이 오면 타이머를 리셋한다.
let thoughtTimer = null;
function showThought(text) {
  if (!thought) return;
  thought.textContent = text;
  thought.classList.add('show');
  clearTimeout(thoughtTimer);
  // 길이에 비례해 머문다 (읽을 시간). 최소 3초, 최대 8초.
  const holdMs = Math.min(8000, Math.max(3000, text.length * 220));
  thoughtTimer = setTimeout(() => thought.classList.remove('show'), holdMs);
}

// Discord는 iframe URL에 frame_id / instance_id / platform을 붙여준다.
// 이게 없으면 SDK 생성자가 throw하므로, 일반 브라우저인지 먼저 판별한다.
const params = new URLSearchParams(window.location.search);
const insideDiscord = params.has('frame_id') && params.has('instance_id');

async function connectDiscord() {
  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;
  if (!clientId) throw new Error('VITE_DISCORD_CLIENT_ID가 없습니다.');

  const { DiscordSDK } = await import('@discord/embedded-app-sdk');
  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  // 인증 실패는 화면에 표시한다 — 이제 인증이 없으면 대화가 안 되므로 중요하다.
  let user = null;
  let authError = null;
  try {
    const { authenticate } = await import('./auth.js');
    user = await authenticate(sdk, clientId);
    console.log('[auth] 인증 완료:', user.name);
  } catch (err) {
    authError = err?.message ?? String(err);
    console.warn('[auth] 인증 실패:', authError);
  }

  return { sdk, user, authError };
}

// 볼륨 컨트롤 (디스코드 스타일) — 아이콘에 호버하면 세로 슬라이더 팝업, 클릭은 음소거 토글.
// 감정/포즈/비셈 디버그 버튼은 제거됨 (위치 조절은 관리자 패널 ⚙에 남아 있다).
function buildVolume(voice) {
  const box = document.createElement('div');
  box.id = 'vol';

  const icon = document.createElement('button');
  icon.type = 'button';
  icon.id = 'vol-icon';

  const pop = document.createElement('div');
  pop.id = 'vol-pop';
  const slider = document.createElement('input');
  Object.assign(slider, {
    type: 'range', min: 0, max: 100, step: 5,
    value: Math.round(voice.getVolume() * 100),
  });
  slider.setAttribute('orient', 'vertical'); // Firefox 세로 슬라이더
  pop.appendChild(slider);

  const render = () => {
    const v = voice.getVolume();
    icon.textContent = v === 0 ? '🔇' : v < 0.5 ? '🔉' : '🔊';
    slider.value = String(Math.round(v * 100));
  };
  render();

  slider.addEventListener('input', () => {
    voice.setVolume(Number(slider.value) / 100);
    render();
  });

  // 아이콘 클릭 = 음소거 토글 (직전 볼륨 기억)
  let last = voice.getVolume() || 0.5;
  icon.addEventListener('click', () => {
    if (voice.getVolume() > 0) { last = voice.getVolume(); voice.setVolume(0); }
    else { voice.setVolume(last || 0.5); }
    render();
  });

  box.append(pop, icon);
  panel.appendChild(box);
  panel.classList.remove('hidden');
}

try {
  let sdk = null;
  let user = null;
  let authError = null;
  if (insideDiscord) ({ sdk, user, authError } = await connectDiscord());

  const avatar = await createAvatarStage(stage, MODEL_URL, {
    onProgress: (p) => {
      status.textContent = `모델 불러오는 중… ${Math.round(p * 100)}%`;
    },
  });

  status.classList.add('hidden');
  document.getElementById('gate').classList.remove('hidden');

  meta.textContent = sdk
    ? [
        `guild    ${sdk.guildId ?? '—'}`,
        `channel  ${sdk.channelId ?? '—'}`,
        `instance ${sdk.instanceId}`,
        `platform ${sdk.platform}`,
      ].join('\n')
    : 'standalone (Discord 밖)';
  meta.style.whiteSpace = 'pre';

  const chat = mountChat();
  const voice = createSpeech(avatar, { userId: user?.id });
  buildVolume(voice); // 볼륨 컨트롤(기본 50%, 유저별 기억) — 패널을 보이게 한다

  // Mixamo 클립이 있으면 프리셋 포즈 대신 실제 애니메이션.
  // idle.fbx가 없으면 조용히 기존 포즈로 폴백한다 (에셋은 사용자가 배치).
  const motion = createMotion(avatar.vrm);
  // 임시(관리자 모드용): 콘솔에서 motionCtl.setScale('idle', 0.4) 로 폭 조정
  window.motionCtl = motion;
  (async () => {
    // <상태>-<번호>.fbx 를 1번부터 연속으로 탐색한다. 없으면 그 상태는 idle이 대신한다.
    // (파일이 없으면 Vite가 index.html을 돌려주고 FBX 파싱이 실패한다 — 그걸 '없음'으로 취급)
    const loadPool = async (state) => {
      let n = 0;
      for (let i = 1; i <= 6; i++) {
        try {
          await motion.load(state, `/models/anim/${state}-${i}.fbx`);
          n++;
        } catch {
          break;
        }
      }
      if (n) console.log(`[motion] ${state} 클립 ${n}개`);
      return n;
    };

    if (await loadPool('idle')) {
      avatar.attachMotion(motion);
      motion.setState('idle');
      await loadPool('thinking');
      await loadPool('speaking');
    } else {
      console.log('[motion] 클립 없음 — 프리셋 포즈 유지');
    }
  })();

  // 백엔드가 신원을 확인해줄 때까지는 말할 수 없다고 본다.
  // connectBus 콜백에서 참조하므로 먼저 선언한다.
  let setCanSpeak = () => {};

  // 자동재생 정책상 첫 소리 전에 사용자 제스처가 한 번 필요하다.
  const gate = document.getElementById('gate');
  const unlock = async () => {
    if (await voice.prime()) gate.classList.add('hidden');
  };
  gate.addEventListener('click', unlock);

  // 표정은 백엔드의 무드 레이어가 계산한 것을 그대로 그린다.
  // 여운(감쇠)도 백엔드가 관리하므로 여기서 따로 낮추지 않는다.
  // 형식: [{name, weight}, ...] (인접 프리셋 블렌드) — 옛 단일 객체도 허용.
  const applyExpression = (expression) => {
    if (!expression) return;
    const list = Array.isArray(expression) ? expression : [expression];
    if (!list.length || !list[0]?.name) return;
    avatar.setEmotionMix(list);
  };

  // idle은 백엔드의 '논리적 종료'일 뿐이다. 백엔드는 재생 완료 시각을 추정만
  // 하므로(네트워크·디코딩 지연을 모름), idle에서 오디오를 멈추면 마지막 문장들이
  // 잘린다. 실제 종료는 재생 큐가 비었을 때(onDrained)이고, 정지는 새 응답이
  // 시작될 때(thinking)만 한다.
  let curState = 'idle';
  const applyState = (state, expression) => {
    curState = state;
    if (motion.active) {
      motion.setState(state === 'thinking' ? 'thinking' : state === 'speaking' ? 'speaking' : 'idle');
    } else {
      avatar.setPose(state === 'thinking' ? 'think' : 'idle');
    }
    applyExpression(expression);
    if (state === 'thinking') {
      voice.stop(); // 직전 응답의 잔여 오디오 정리
      speech.classList.remove('show');
    }
    if (state === 'idle' && !voice.busy) speech.classList.remove('show');
  };
  voice.onDrained(() => {
    if (curState === 'idle') speech.classList.remove('show');
  });

  // 백엔드가 상태의 진실을 갖고, 여기는 그대로 그리기만 한다.
  const bus = connectBus(
    (msg) => {
      switch (msg.type) {
        case '_status':
          conn.classList.toggle('ok', msg.connected);
          conn.textContent = msg.connected
            ? '● 연결됨'
            : msg.denied
              ? `● ${msg.denied}`
              : '● 연결 끊김';
          if (msg.denied) setCanSpeak(false, 'not-allowed');
          break;
        case 'chat':
          chat.push(msg.author, msg.text);
          break;
        case 'speak': {
          // 생각 풍선 (⑬) — 음성 없이 별도 스타일로 바로 띄우고 잠시 뒤 사라진다.
          if (msg.mode === 'thought') {
            showThought(msg.text);
            applyExpression(msg.expression);
            break;
          }
          // 자막·표정은 그 문장이 실제로 소리날 때 바뀐다.
          const tag = msg.text.slice(0, 12);
          bus.send({ type: 'clog', m: `recv "${tag}" audio=${msg.audio ? Math.round(msg.audio.length / 1366) + 'KB' : 'null'}` });
          voice.enqueue(msg.audio, () => {
            bus.send({ type: 'clog', m: `show "${tag}"` });
            speech.textContent = msg.text;
            speech.classList.add('show');
            applyExpression(msg.expression);
          });
          break;
        }
        case 'state':
          applyState(msg.state, msg.expression);
          break;

        // 백엔드가 신원을 확인한 결과. 말할 수 없으면 입력창을 잠근다.
        case 'auth':
          setCanSpeak(msg.canSpeak, msg.reason);
          break;

        // 대화 도중 합류했을 때 받는 현재 상태.
        // 진행 중인 발화의 오디오는 없으므로 자막만 띄운다.
        case 'snapshot':
          for (const line of msg.recent ?? []) {
            chat.push(line.author, line.text, line.ageMs);
          }
          applyState(msg.state, msg.expression);
          if (msg.speech) {
            speech.textContent = msg.speech;
            speech.classList.add('show');
          }
          break;
      }
    },
    {
      channelId: sdk?.channelId ?? null,
      guildId: sdk?.guildId ?? null,
      // id를 보내지 않는다 — 백엔드가 이 토큰으로 Discord에 직접 물어 확인한다.
      accessToken: user?.accessToken ?? null,
    },
  );

  voice.onEvent((m) => bus.send({ type: 'clog', m }));

  // iframe 쪽 입력창 — 패널 첫 줄에 얹는다
  const form = document.createElement('form');
  form.id = 'ask';
  const askInput = document.createElement('input');
  askInput.placeholder = '확인 중…';
  askInput.maxLength = 500;
  askInput.autocomplete = 'off';
  askInput.disabled = true;
  const askBtn = document.createElement('button');
  askBtn.type = 'submit';
  askBtn.textContent = '보내기';
  askBtn.disabled = true;
  form.append(askInput, askBtn);

  setCanSpeak = (can, reason) => {
    askInput.disabled = !can;
    askBtn.disabled = !can;
    askInput.placeholder = can
      ? '아바타에게 말 걸기…'
      : reason === 'not-allowed'
        ? '허용된 사용자만 대화할 수 있어요'
        : authError
          ? `인증 실패: ${authError}`
          : '관전 모드 — 인증이 필요해요';
  };
  // 인증에 실패했다면 연결 결과를 기다리지 말고 바로 알린다.
  if (authError) setCanSpeak(false, 'unauthenticated');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = askInput.value.trim();
    if (!text) return;
    if (bus.send({ type: 'prompt', text })) askInput.value = '';
  });
  panel.prepend(form);

  // 카메라·포즈 튜닝 패널은 개발용 — URL에 ?admin 이 있을 때만 뜬다.
  // 배포된 봇에선 안 보인다(깔끔한 레이아웃). 이 프레임워크를 포크해 다른 VRM을
  // 쓰는 사람은 로컬에서 ?admin 으로 카메라·위치를 다시 잡을 수 있다.
  if (new URLSearchParams(location.search).has('admin')) mountAdminPanel(avatar);

  // 콘솔에서 직접 만져볼 수 있게 열어둔다.
  window.avatar = avatar;
  console.log('모델이 가진 표현식:', avatar.availableExpressions());
} catch (err) {
  console.error(err);
  status.innerHTML = `<p class="warn">불러오기 실패</p><p>${err.message}</p>`;
}
