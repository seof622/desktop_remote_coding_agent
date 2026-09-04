# 0001. Gateway로 App Server를 감싼다

## Status

Accepted

## Context

모바일 클라이언트가 Codex 작업을 원격으로 시작·관찰·승인해야 한다. Codex App Server는 rich client용
JSON-RPC 인터페이스를 제공하지만, 해당 프로토콜을 외부 모바일 클라이언트의 공개 계약으로 쓰면 보안과
호환성 경계를 제어하기 어렵다.

## Decision

Desktop Gateway Agent가 App Server와 로컬로 통신한다. 모바일에는 Tailscale 경로의 인증된 REST 및
WebSocket API만 제공하고, Gateway가 이벤트·승인·프로젝트·Git·Build·Test를 제품용 모델로 변환한다.

## Consequences

- 모바일 API와 App Server의 구현 변경을 분리할 수 있다.
- 인증, 입력 검증, 승인 검증, 로그 마스킹을 Gateway 한 곳에서 적용한다.
- Gateway가 상태 동기화와 이벤트 변환을 책임져야 하므로 구현 범위가 늘어난다.
