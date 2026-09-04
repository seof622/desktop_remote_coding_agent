# 0002. Phase 1 Gateway 기술 기준

## Status

Accepted

## Context

Phase 1은 Windows/WSL2에서 Codex App Server를 stdio로 제어하고, Tailscale 내부의 모바일
클라이언트에 인증된 HTTP/WebSocket Gateway를 제공해야 한다. Project, Session, Run, 최근 이벤트는
Gateway 재시작과 모바일 재연결 뒤에도 추적할 수 있어야 한다.

런타임·웹 프레임워크·저장소·기본 네트워크 정책을 늦게 결정하면 Provider adapter와 외부 API가
서로 다른 방식으로 구현될 위험이 있다.

## Decision

Phase 1 Gateway의 기술 기준을 다음과 같이 채택한다.

- **런타임/언어:** Node.js 22 LTS와 TypeScript strict mode를 사용한다.
- **HTTP/WebSocket:** Fastify와 `@fastify/websocket`을 사용한다. REST와 WebSocket 인증·오류 처리·로그를
  하나의 Gateway 프로세스에서 관리한다.
- **입력 검증:** HTTP 요청, WebSocket 클라이언트 메시지, Provider notification은 경계에서 schema로 검증한다.
- **영속 저장소:** 로컬 SQLite를 사용한다. Project, Gateway ID와 Provider 원본 ID의 매핑, Session, Run,
  제한된 AgentEvent 기록을 저장한다.
- **저장 위치:** `GATEWAY_DATA_DIR`을 사용한다. 개발 기본값은 작업 디렉터리의 `data/`이며, 운영에서는
  사용자별·백업 가능한 별도 경로를 명시적으로 설정한다. 데이터 디렉터리는 Git에 커밋하지 않는다.
- **이벤트 보존:** Session별 최근 1,000개 이벤트와 최대 7일치를 보존하며, 둘 중 먼저 도달하는 한도를 적용한다.
  보존 범위 밖의 재연결 요청에는 전체 상태 재조회가 필요함을 응답한다.
- **네트워크:** 기본 listen host는 loopback이다. 원격 사용은 `GATEWAY_BIND_HOST`에 명시한 Tailscale IP에서만
  허용하며, `0.0.0.0` 또는 공용 인터페이스 바인딩은 Phase 1에서 지원하지 않는다.
- **인증:** 모든 HTTP와 WebSocket 연결은 `GATEWAY_CLIENT_TOKEN`으로 인증한다. Token은 환경 변수에서만 읽고
  저장소, 로그, 오류 응답, Git에 기록하지 않는다. OS 비밀 저장소 연동은 후속 확장이다.
- **CodexProvider 통신:** `codex app-server`와 Gateway 내부 stdio JSONL JSON-RPC로만 통신한다. 모바일에는
  App Server listener를 열지 않는다.
- **Codex 계약 관리:** 지원할 Codex CLI/App Server 버전은 첫 통합 구현 시 명시적으로 pin한다. 해당 버전의
  schema를 생성해 typecheck와 통합 테스트에 사용하되, 생성 산출물은 저장소에 커밋하지 않는다.

## Consequences

- Node.js의 child process와 stream API로 App Server stdio lifecycle을 직접 관리할 수 있다.
- Fastify의 단일 서버에서 인증, REST, WebSocket, 구조화 로그를 일관되게 적용할 수 있다.
- SQLite는 별도 서버 없이 재연결에 필요한 상태를 보존하지만, 다중 Desktop 또는 다중 Gateway 동기화는 지원하지 않는다.
- 이벤트 보존 한도는 저장소 증가를 제한하지만, 오래된 이벤트가 필요한 클라이언트는 상태 조회를 다시 수행해야 한다.
- loopback 기본값과 명시적 Tailscale IP는 실수로 공용 네트워크에 노출할 위험을 낮춘다.
- `GATEWAY_CLIENT_TOKEN` 환경 변수 방식은 MVP 설정을 단순하게 하지만, 장기적으로 OS 비밀 저장소와 device pairing이 필요하다.
- Provider 중립 모델은 유지하지만, Phase 1 구현과 테스트는 CodexProvider 하나에만 집중한다.
