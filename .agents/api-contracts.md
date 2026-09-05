# API and Event Contract Rules

## 외부 API 원칙

- 외부 REST/WebSocket 계약은 Codex JSON-RPC나 특정 Provider 구조를 그대로 복제하지 않는다.
- 안정적인 제품 용어를 사용하고 내부 전송 방식 변경이 모바일 클라이언트를 깨지 않게 한다.
- 리소스 ID는 불투명한 값으로 취급하며, 클라이언트 입력은 형식과 소속 관계를 검증한다.
- Session과 Run은 Gateway가 발급한 ID로 참조하며, Provider 원본 ID는 adapter 내부에서 매핑한다.
- Provider별 지원 기능은 capability로 노출한다. 지원하지 않는 기능을 성공처럼 보이게 대체하지 않는다.

## 이벤트

MVP의 대표 이벤트는 `agent.status`, `session.started`, `run.started`,
`agent.message.delta`, `command.started`, `command.completed`, `file.change`,
`approval.requested`, `approval.resolved`, `run.completed`, `build.output`,
`test.output`, `error`다.

- 이벤트에는 가능한 한 `providerId`, `projectId`, `sessionId`, `runId`, `eventId` 등 추적에 필요한 상관관계 ID를 포함한다.
- delta 이벤트는 순서가 보장되는지와 재연결 시 복구 방법을 구현·문서에서 명시한다.
- 새 이벤트나 필드 추가는 하위 호환으로 설계한다. 기존 필드의 이름·의미·타입 변경은 breaking change로 다룬다.
- 오류는 사용자에게 안전한 설명을 주고, 내부 세부 정보나 비밀값을 노출하지 않는다.

## 계약 변경 절차

1. 영향받는 REST endpoint 또는 WebSocket 이벤트를 식별한다.
2. 모바일 클라이언트 호환성과 재연결 동작을 검토한다.
3. README 및 이 문서의 관련 설명을 갱신한다.
4. 정상·잘못된 입력·권한 거부·재시도 경로를 테스트한다.

## Phase 1 구현 계약

- `/dashboard`는 Token·Project·Session 데이터를 포함하지 않는 공개 정적 테스트 페이지다. 그 외 모든 HTTP API
  (예: `/health`)와 WebSocket handshake는 Client Token 검증을 통과해야 한다.
- 일반 HTTP와 비브라우저 WebSocket은 `Authorization: Bearer <Client Token>`을 사용한다. 브라우저 대시보드가
  WebSocket 임의 헤더를 설정할 수 없는 제약에 한해, Upgrade 요청의 `Sec-WebSocket-Protocol`에
  `gateway-v1.<base64url(Client Token)>`를 보내는 방식을 지원한다. URL query·저장소·이벤트에는 Token을 넣지
  않으며 기존 Bearer WebSocket 클라이언트는 그대로 호환된다.
- Gateway ID는 `prj_`, `ses_`, `run_`, `evt_` 접두사를 쓰며 Codex Thread/Turn 원본 ID는 외부 응답과
  이벤트에 포함하지 않는다.
- `WS /events`와 `GET /sessions/{sessionId}/events`는 선택적 `afterSequence` 이후의 이벤트를 오름차순으로
  반환한다. Session별 최근 1,000개 또는 7일을 넘는 이벤트는 재전송하지 않으며, 클라이언트는 상태를 재조회한다.
- Phase 1은 `agent.status`, `session.started`, `run.started`, `agent.message.delta`, `run.completed`, `error`
  만 발행한다. Approval·Git·Build/Test 이벤트는 다음 Phase의 계약이다.
