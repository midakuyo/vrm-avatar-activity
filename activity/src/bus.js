// 백엔드(봇)와의 WebSocket. 같은 오리진의 /ws로 붙는다.
// 접속하면 hello로 자기 channelId를 신고한다 (Discord 밖이면 null → 구경꾼 모드).
// 끊기면 계속 재시도한다 — dev 서버 재시작 때마다 수동 새로고침하지 않으려고.
export function connectBus(onMessage, hello = {}) {
  let socket;
  let retry = 0;
  let closed = false;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${proto}//${location.host}/ws`);

    socket.addEventListener('open', () => {
      retry = 0;
      socket.send(JSON.stringify({ type: 'hello', ...hello }));
      onMessage({ type: '_status', connected: true });
    });

    socket.addEventListener('message', (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        console.warn('[bus] 파싱 실패:', e.data);
      }
    });

    socket.addEventListener('close', (e) => {
      // 4401 = 서버가 인증 문제로 거부. 재시도해봐야 같은 결과라 그만둔다.
      if (e.code === 4401) {
        closed = true;
        onMessage({ type: '_status', connected: false, denied: e.reason || '접속 거부' });
        return;
      }
      onMessage({ type: '_status', connected: false });
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(open, 500 * 2 ** (retry - 1));
    });

    // close가 뒤따르므로 재연결은 여기서 걸지 않는다.
    socket.addEventListener('error', () => socket.close());
  };

  open();

  return {
    send(payload) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
        return true;
      }
      return false;
    },
    close() {
      closed = true;
      socket?.close();
    },
  };
}
