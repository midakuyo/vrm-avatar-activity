// Activity 인증용 토큰 교환 엔드포인트.
//
// iframe은 client secret을 가질 수 없으므로(브라우저에 노출됨) 인가 코드를
// 여기로 보내고, 서버가 secret과 함께 교환한다. 이게 Discord가 문서화한 흐름이다.
//
// 반환한 access_token으로 iframe이 sdk.commands.authenticate()를 호출하면
// Discord가 그 사용자를 확인해준다. 우리는 그 결과의 user.id를 신뢰한다.

import { createServer } from 'node:http';
import { handleWebhookEvent, isConfigured as webhookConfigured } from './webhook-events.js';

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

export const isConfigured = Boolean(CLIENT_ID && CLIENT_SECRET);

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error('본문이 너무 큽니다');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createOAuthServer(port) {
  const server = createServer(async (req, res) => {
    // Discord Webhook Events (설치 감시 + 접근권한 철회 시 데이터 파기).
    // 서명 검증·응답 규정은 webhook-events.js가 전담한다.
    if (req.method === 'POST' && req.url.startsWith('/webhook-events')) {
      return handleWebhookEvent(req, res);
    }
    if (req.method !== 'POST' || !req.url.startsWith('/token')) {
      return send(res, 404, { error: 'not found' });
    }
    if (!isConfigured) {
      return send(res, 503, { error: 'DISCORD_CLIENT_ID/SECRET 미설정' });
    }

    try {
      const { code } = await readJson(req);
      if (!code || typeof code !== 'string') {
        return send(res, 400, { error: 'code 없음' });
      }

      const body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
      });

      const r = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      if (!r.ok) {
        const detail = (await r.text()).slice(0, 200);
        console.error('[oauth] 토큰 교환 실패:', r.status, detail);
        return send(res, 502, { error: '토큰 교환 실패' });
      }

      const data = await r.json();
      // 클라이언트에는 access_token만 준다. refresh_token은 넘기지 않는다.
      send(res, 200, { access_token: data.access_token });
    } catch (err) {
      console.error('[oauth] 오류:', err.message);
      send(res, 400, { error: 'bad request' });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(
      `[oauth] 토큰 교환 대기 중` + (isConfigured ? '' : ' (자격증명 없음 — 503 응답)'),
    );
    console.log(
      `[webhook] /webhook-events ` +
        (webhookConfigured ? '수신 대기 (Ed25519 검증)' : '비활성 — DISCORD_PUBLIC_KEY 미설정(전부 401)'),
    );
  });

  return server;
}
