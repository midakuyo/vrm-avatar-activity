import { WebSocketServer } from 'ws';
import {
  checkOrigin, verifyUser, isAllowed, isLanRequest, lanIdentity, config,
} from './identity.js';

// Activity iframe들과 백엔드를 잇는 허브.
//
// 접근 통제 (identity.js):
//   내부망 — 인증 없이 허용. 테스트 전용 신원(LAN_USER_ID)을 부여한다.
//   외부망 — Origin + 토큰 검증 + 허용목록을 **모두** 통과해야 한다.
//            통과 전에는 어떤 데이터도 주지 않고, 실패하면 즉시 끊는다.
//            (미인증자가 남의 대화·자막·기억 스냅샷을 보지 못하게)
//
// 인증 유예 시간. 이 안에 hello로 신원을 증명하지 못하면 끊는다.
const AUTH_TIMEOUT_MS = 10_000;

export function createBus(port, { onPrompt, onHello, resolveContext } = {}) {
  const wss = new WebSocketServer({
    port,
    // 핸드셰이크에서 1차로 거른다 — 연결 자체를 막는 게 가장 싸다.
    verifyClient: ({ origin, req }, done) => {
      if (isLanRequest(req)) return done(true);
      if (checkOrigin(origin)) return done(true);
      console.warn(`[bus] 거절: origin=${origin ?? '(없음)'} ip=${req.socket?.remoteAddress}`);
      done(false, 403, 'Forbidden');
    },
  });

  const clients = new Set();

  const drop = (socket, why) => {
    console.warn(`[bus] 연결 종료: ${why}`);
    try {
      socket.close(4401, why);
    } catch {
      // 이미 닫힘
    }
  };

  wss.on('connection', (socket, req) => {
    socket.channelId = null;
    socket.user = null;
    socket.lan = isLanRequest(req);

    // 신원을 증명할 때까지 브로드캐스트 대상에 넣지 않는다.
    // clients에 들어가야 toChannel이 데이터를 보내므로, 이게 유출 차단선이다.
    const deadline = setTimeout(() => {
      if (!socket.user) drop(socket, '인증 시간 초과');
    }, AUTH_TIMEOUT_MS);

    socket.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      if (msg.type === 'hello') {
        socket.channelId = msg.channelId ?? null;
        socket.guildId = msg.guildId ?? null;
        // 공개/비공개 힌트는 내부망 테스트 연결에서만 받는다.
        socket.isPublicHint =
          socket.lan && typeof msg.isPublic === 'boolean' ? msg.isPublic : undefined;

        // 내부망이면 테스트 신원, 아니면 토큰을 Discord에 물어 확인한다.
        const user = socket.lan ? lanIdentity() : await verifyUser(msg.accessToken);

        if (!user) {
          clearTimeout(deadline);
          const why = socket.lan
            ? 'LAN_USER_ID 미설정'
            : msg.accessToken
              ? '토큰 거부됨 (Discord가 인증 실패)'
              : '토큰 없음 (iframe OAuth 미완료)';
          return drop(socket, why);
        }

        // 외부 사용자는 서버가 3단 검증(길드 멤버십·채널 열람권·DM 차단)을 직접 한다.
        // guildId도 iframe 신고값이 아니라 채널에서 도출한 값으로 확정한다 —
        // guildId 사칭으로 허용목록을 여는 우회, 비공개 채널 도청, DM 게이팅 부재를
        // 한 번에 막는다(보안감사 confirmed #1 + 채널/DM 정책). LAN은 망 위치로 통제.
        if (!user.lan && resolveContext) {
          const ctx = await resolveContext(socket.channelId, socket.guildId, user.id);
          if (!ctx?.verified) {
            clearTimeout(deadline);
            return drop(socket, '접근 검증 실패 (비멤버·채널 열람권 없음·DM)');
          }
          socket.guildId = ctx.guildId ?? null; // 검증된 값으로 덮어쓴다
        }

        // 허용목록은 외부(Discord) 사용자용이다. 내부망은 이미 망 위치와
        // ALLOW_LAN/LAN_USER_ID로 통제되므로 다시 거르지 않는다.
        if (!user.lan && !isAllowed({ guildId: socket.guildId, userId: user.id })) {
          clearTimeout(deadline);
          return drop(socket, `허용목록 밖 (user=${user.id})`);
        }

        clearTimeout(deadline);
        socket.user = user;
        clients.add(socket); // 여기서부터 브로드캐스트를 받는다
        // 이름(디스코드 표시명·LAN_USER_NAME)은 PII라 운영 로그에 남기지 않는다.
        // 연결 유형·채널·접속 수만 — 누가 들어왔는지는 기억/텔레메트리가 담당.
        console.log(
          `[bus] 입장: ${user.lan ? '내부망' : 'Discord'} 사용자 ` +
            `channel=${socket.channelId ?? '-'} (총 ${clients.size})`,
        );

        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'auth', canSpeak: true, name: user.name }));
          const snapshot = onHello?.(socket.channelId);
          if (snapshot) socket.send(JSON.stringify(snapshot));
        }
      } else if (msg.type === 'clog' && typeof msg.m === 'string') {
        // 클라이언트 재생 경로 텔레메트리 — Discord 안에서의 실패를 서버 로그로 본다.
        // 자막 조각이 섞이므로 LOG_VERBOSE=0(운영)에서는 남기지 않는다.
        if (socket.user && process.env.LOG_VERBOSE !== '0') {
          console.log(`[client:${socket.user.name}] ${msg.m.slice(0, 120)}`);
        }
      } else if (msg.type === 'prompt' && typeof msg.text === 'string' && msg.text.trim()) {
        if (!socket.user) return drop(socket, '인증 전 요청');
        const result = await onPrompt?.(
          socket.channelId,
          socket.guildId,
          msg.text.trim().slice(0, 500),
          socket.user,
          socket.isPublicHint,
        );
        // 비용 가드에 걸렸으면 입력창을 되살리도록 알린다.
        if (result && !result.ok && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'rejected', reason: result.reason, waitMs: result.waitMs }));
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(deadline);
      if (clients.delete(socket)) console.log(`[bus] 퇴장 (총 ${clients.size})`);
    });
    socket.on('error', (err) => console.error('[bus] 소켓 오류:', err.message));
  });

  console.log(`[bus] WebSocket 대기 중 :${port}`);
  console.log(
    `[bus] 오리진: ${config.origins.join(', ') || '(없음)'}` +
      (config.allowLan ? ` / 내부망 허용${config.lanUser ? ` (테스터 ${config.lanUser})` : ' (LAN_USER_ID 없음 — 실제로는 거절)'}` : '') +
      (config.guilds || config.users
        ? ` / 허용목록: 길드 ${config.guilds}, 유저 ${config.users}`
        : ' / 허용목록 없음 (전체 허용)'),
  );

  return {
    toChannel(channelId, payload) {
      const json = JSON.stringify(payload);
      for (const socket of clients) {
        if (socket.readyState !== socket.OPEN) continue;
        if (socket.channelId === channelId) socket.send(json);
      }
    },
    // 그 채널을 보고 있는 인증된 클라이언트 수. 프로액티브 발화(⑬)의 3중 게이트 —
    // 아무도 안 보는 채널에 혼잣말하면 토큰 낭비다.
    countChannel(channelId) {
      let n = 0;
      for (const socket of clients) {
        if (socket.readyState === socket.OPEN && socket.channelId === channelId) n += 1;
      }
      return n;
    },
  };
}
