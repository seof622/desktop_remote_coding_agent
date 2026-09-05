# Mobile Test Dashboard Plan

## Goal

Tailscale에 연결된 스마트폰 브라우저에서 Gateway의 Project 등록, Codex Session/Run 시작,
이벤트 수신, interrupt를 수동 검증할 수 있는 단일 페이지 테스트 대시보드를 제공한다.

## Scope and non-goals

### Scope

- `GET /dashboard`에서 데이터가 없는 정적 HTML/CSS/JS 대시보드 제공
- Token 입력 후 Health, Provider, Project, Session, Run, interrupt API 제어
- 정규화된 Gateway Event를 실시간 표시
- 브라우저 WebSocket의 제약을 위해 `Sec-WebSocket-Protocol: gateway-v1.<token>` 인증 지원

### Non-goals

- Token 저장, device pairing, 사용자 계정, 다중 사용자 UI
- Phase 2 Approval 결정, Git/Build/Test 제어, Provider 원본 ID 표시
- 제품 수준 모바일 앱 또는 외부 CDN/analytics

## Affected boundaries

- Mobile API: 정적 `GET /dashboard`와 WebSocket subprotocol 인증을 추가한다.
- Gateway: 정적 응답 보안 헤더, Token 비교, 이벤트 구독을 제공한다.
- Codex App Server: 기존 Gateway API를 통해서만 간접 제어하며 변경하지 않는다.
- Workspace: 사용자가 기존 Project 등록 API에 명시한 경로만 검증·등록한다.

## State, error, and reconnect behavior

- Token은 JavaScript 메모리에만 두며 새로고침·페이지 닫기 시 사라진다.
- REST 실패와 WebSocket close/error는 안전한 메시지로 화면에 표시한다.
- 선택 Session의 마지막 sequence를 메모리에 보존하고 재연결 시 `afterSequence`로 이어받는다.
- Run은 기존 Gateway 상태 전이와 단일 활성 Run 제약을 그대로 따른다.

## Security and approval considerations

- `/dashboard`만 공개 정적 리소스 예외이며 API 데이터·WebSocket은 모두 Token 인증이 필요하다.
- 대시보드는 no-store, no-referrer, CSP, nosniff 헤더를 사용하며 외부 script/style을 불러오지 않는다.
- Token은 URL, LocalStorage, 로그, 오류 메시지, 화면 이벤트에 쓰지 않는다.
- WebSocket Token은 URL query가 아니라 `gateway-v1.<token>` subprotocol으로만 전달한다.
- Dashboard는 Approval을 만들거나 자동 승인하지 않는다.

## Test plan

- 공개 Dashboard HTML에는 Token이나 내부 경로가 포함되지 않는지 확인한다.
- Dashboard API 요청은 Bearer Token 없이는 계속 401인지 확인한다.
- WebSocket은 올바른 subprotocol Token만 수락하고 잘못된 Token은 거절하는지 확인한다.
- 정규화 이벤트를 escape하여 DOM에 표시하고, reconnect sequence를 유지하는지 수동 검증한다.

## Documentation updates

- README에 Dashboard 접속, Token 입력, WebSocket 인증과 제한 사항을 기록한다.
- `.agents/api-contracts.md`에 Dashboard 공개 정적 리소스 예외와 WebSocket subprotocol 계약을 기록한다.

## API change checklist

- [x] `GET /dashboard`와 WebSocket subprotocol 인증 계약을 설명했다.
- [x] 기존 Bearer REST/WS 클라이언트는 그대로 동작해 하위 호환된다.
- [x] 공개 Dashboard는 데이터가 없고, API·WebSocket은 Token을 검증한다.
- [x] sequence 기반 이벤트 재연결과 오류 표시 동작을 정의했다.
- [x] Token을 URL·저장소·로그·오류에 노출하지 않는다.
- [x] README와 `.agents/` 문서를 구현과 함께 갱신했다.
- [x] 정상·잘못된 Token WebSocket 인증을 자동 테스트했다. 실제 스마트폰의 재연결 sequence는 수동 검증한다.
