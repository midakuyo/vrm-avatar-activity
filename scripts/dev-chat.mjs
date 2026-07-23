#!/usr/bin/env node
// 개발용 대화 테스트. DEV_FAKE_USER 우회로를 타므로 Origin 없이 실행해야 한다.
//
//   docker compose run --rm --no-deps activity node /app/../scripts/dev-chat.mjs <scope> "<말>"
//
// scope: dm | public | private   — 실제 스코프 해석을 그대로 탄다.
// 실제 서버를 오염시키지 않도록 테스트 전용 스노우플레이크를 쓴다.
const TEST_GUILD = '900000000000000001';
const TEST_CHANNEL = { dm: '900000000000000010', public: '900000000000000011', private: '900000000000000012' };

const scope = process.argv[2] ?? 'public';
const text = process.argv[3] ?? '안녕!';
const channelId = TEST_CHANNEL[scope];
if (!channelId) {
  console.error('scope는 dm | public | private 중 하나');
  process.exit(1);
}
const guildId = scope === 'dm' ? null : TEST_GUILD;

const ws = new WebSocket(process.env.WS_URL ?? 'ws://activity:5173/ws');  // 컨테이너 내부 = 사설 IP = 내부망
const timer = setTimeout(() => { console.error('시간 초과'); process.exit(1); }, 60000);

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'hello', channelId, guildId, isPublic: scope === 'public' }));
  setTimeout(() => ws.send(JSON.stringify({ type: 'prompt', text })), 400);
};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'auth') console.log(`[auth] canSpeak=${m.canSpeak} name=${m.name ?? '-'}`);
  if (m.type === 'speak') {
    const ex = (Array.isArray(m.expression) ? m.expression : [m.expression])
      .filter(Boolean).map((e) => `${e.name}:${e.weight}`).join('+') || '-';
    console.log(`[${ex}] ${m.text}`);
  }
  if (m.type === 'state' && m.state === 'idle') { clearTimeout(timer); process.exit(0); }
};
ws.onerror = () => { console.error('연결 실패 (ALLOW_STANDALONE=1 인지 확인)'); process.exit(1); };
