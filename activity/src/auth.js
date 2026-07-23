// Activity 사용자 인증.
//
// 흐름: sdk.commands.authorize() → 인가 코드 → 백엔드가 secret과 교환 →
//       access_token → sdk.commands.authenticate() → 사용자 정보
//
// 첫 참여 시 사용자에게 인가 모달이 한 번 뜬다. 이게 이 기능의 유일한 비용이다.
// 스코프는 최소로 유지한다 — 나중에 스코프를 추가하면 전원이 다시 프롬프트를 받는다.
const SCOPES = ['identify'];

export async function authenticate(sdk, clientId) {
  // prompt를 지정하지 않는다. 처음 쓰는 사람에겐 인가 모달을 띄우고,
  // 이미 인가한 사람은 그대로 통과시킨다.
  // (prompt: 'none'을 주면 미인가 사용자에게 모달을 안 띄우고 조용히 실패한다.)
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    scope: SCOPES,
  });

  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`토큰 교환 실패 (${res.status})`);

  const { access_token } = await res.json();
  const auth = await sdk.commands.authenticate({ access_token });
  if (!auth?.user) throw new Error('인증 결과에 사용자 정보가 없습니다');

  return {
    id: auth.user.id,
    name: auth.user.global_name || auth.user.username,
    // 백엔드가 이 토큰으로 신원을 직접 확인한다 — 우리가 신고한 id는 믿지 않는다.
    accessToken: access_token,
  };
}
