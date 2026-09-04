# Architecture Principles

## 역할과 경계

Desktop Remote Coding Agent는 모바일 클라이언트와 하나 이상의 AI 코딩 Agent Provider 사이의 Gateway다.

```text
Mobile Client <-> Desktop Gateway Agent <-> Provider Adapter <-> Agent Runtime <-> Workspace
```

- 모바일에는 Provider 중립적인 제품용 REST/WebSocket API만 제공한다.
- Codex App Server와의 JSON-RPC 통신은 `CodexProvider` adapter 내부 구현이다.
- 다른 agent runtime은 별도 adapter로 추가하며, Provider별 프로토콜·자격 증명·이벤트 형식을 Gateway 전체로 퍼뜨리지 않는다.
- Git, Build, Test 정보는 특정 Provider의 텍스트 출력을 파싱하지 않고 Gateway가 직접 수집한다.
- SSH/tmux는 장애 대응·디버깅 fallback이며 주 통신 경로가 아니다.

## 상태와 수명 주기

- Gateway 상태는 `Online`, `Idle`, `Busy`, `WaitingApproval`, `Error`를 명확히 구분한다.
- 공통 도메인은 `AgentSession`, `AgentRun`, `AgentEvent`를 사용한다. Codex의 Thread/Turn/Item은 CodexProvider 내부 매핑 용어다.
- Provider는 세션 재개, 이벤트 스트리밍, 승인, 중단 등 지원 기능을 capability로 선언한다.
- CodexProvider 연결 직후에는 `initialize` 완료 후 `initialized`를 보낸다. 그 전에는 다른 Codex 요청을 보내지 않는다.
- 재연결 시 Gateway 상태, Session 목록, 진행 중 Run, Pending Approval, 최근 이벤트를 다시 동기화할 수 있어야 한다. Provider가 해당 상태를 제공하지 않으면 그 제한을 표시한다.

## 변경 기준

외부 API 스키마, 이벤트 이름, 상태 전이, 재연결 의미를 바꾸는 변경은 호환성 영향을 먼저 적고
`.agents/api-contracts.md`와 README를 함께 갱신한다.
