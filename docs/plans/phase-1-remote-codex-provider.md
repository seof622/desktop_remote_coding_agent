# Phase 1 Plan: Remote Codex Provider

## Goal

Tailscale로 연결된 인증된 모바일 클라이언트가 등록된 Windows/WSL2 Workspace에서
`CodexProvider`를 선택해 Session을 만들고, Run의 진행 메시지와 완료 상태를 실시간으로
확인하며, 실행 중인 Run을 중단할 수 있게 한다.

이 계획의 구현 단위는 다음 수직 슬라이스다.

```text
Project 등록 → Codex Session 생성 → Run 시작 → 이벤트 스트리밍 → 완료 또는 중단
```

## Scope and non-goals

### 포함 범위

- Tailscale 내부에서만 접근하는 Gateway HTTP/WebSocket 서버
- 환경 변수로 제공되는 Client Token 인증과 민감정보 마스킹
- `CodexProvider`의 lifecycle: App Server 프로세스 시작, `initialize`, `initialized`, 종료·실패 감지
- 등록된 Project와 검증된 Workspace 경로만 사용한 Session 생성·재개
- Run 시작, 메시지 delta·상태 이벤트 정규화, 완료, interrupt
- Gateway가 발급하는 `providerId`, `projectId`, `sessionId`, `runId`, `eventId` 매핑과 제한된 최근 이벤트 보존
- `GET /health`, Provider capability 조회, Project/Session/Run 제어, `WS /events`의 최소 계약

### 제외 범위

- Command, file change, permission approval의 모바일 결정 UI 및 중계(Phase 2)
- Git 상태·diff, Build/Test 실행(Phase 3)
- 두 번째 Provider adapter, Provider 선택 UI의 고도화, Provider별 비용·계정 관리
- 공용 인터넷 노출, 터미널 화면 streaming, CLI 출력 parsing

승인이 필요한 Codex 작업은 자동 승인하지 않는다. Phase 2 전에는 안전하게 대기 상태로 표시하거나,
지원하지 않는 흐름으로 종료해야 한다.

## Affected boundaries

| Boundary | Phase 1 responsibility |
| --- | --- |
| Mobile API | Client Token 인증, Provider/Project/Session/Run API, 정규화 이벤트 구독 |
| Gateway core | 상태 관리, Gateway ID 발급, 권한 검증, Provider capability 판정, 이벤트 순서와 최근 기록 |
| CodexProvider | `codex app-server` stdio 프로세스와 JSONL JSON-RPC, 초기화, Thread/Turn/Item 매핑, interrupt |
| Workspace | 등록된 Project path 검증, 해당 경로만 `cwd`로 전달, Git/Build/Test는 이번 범위에서 실행하지 않음 |

### 공통 모델

```text
Provider
  └── Project
       └── AgentSession
            └── AgentRun
                 └── AgentEvent
```

- `CodexProvider`는 `AgentSession -> Thread`, `AgentRun -> Turn`을 매핑한다.
- 원본 Provider ID는 Gateway ID와 분리해 저장한다. 모바일은 Gateway ID만 사용한다.
- Provider capability는 최소한 `resumableSessions`, `eventStreaming`, `interruptRun`,
  `commandApproval`, `fileChangeApproval`, `permissionApproval`, `workspaceAccess`를 제공한다.
- Phase 1의 CodexProvider는 Session 재개·이벤트 스트리밍·Run 중단·Workspace 접근만 `true`로
  광고한다. 승인 capability는 Phase 2 전까지 `false`다.

## Proposed API and event contract

구현 전에 이 초안을 API schema로 확정한다. 모든 요청은 Client Token 인증과 입력 검증을 거치며,
응답은 Provider 원본 ID나 비밀값을 노출하지 않는다.

```text
GET    /health
GET    /providers
GET    /providers/{providerId}/capabilities

GET    /projects
POST   /projects
GET    /projects/{projectId}

GET    /sessions
POST   /sessions
GET    /sessions/{sessionId}
POST   /sessions/{sessionId}/resume

POST   /sessions/{sessionId}/runs
POST   /sessions/{sessionId}/interrupt

WS     /events
```

`POST /sessions`는 `providerId`와 `projectId`를 요구한다. `POST /sessions/{sessionId}/runs`는
text input을 받으며, Session의 Provider·Project 소속을 서버에서 확인한다. `interrupt`는 해당
Session에서 진행 중인 Run만 대상으로 한다.

WebSocket 이벤트는 다음 envelope를 공통으로 사용한다.

```json
{
  "eventId": "evt_…",
  "sequence": 42,
  "type": "agent.message.delta",
  "occurredAt": "2026-09-04T00:00:00Z",
  "providerId": "codex",
  "projectId": "prj_…",
  "sessionId": "ses_…",
  "runId": "run_…",
  "payload": {}
}
```

Phase 1이 발행하는 최소 이벤트는 `agent.status`, `session.started`, `run.started`,
`agent.message.delta`, `run.completed`, `error`다. 내부 Codex 이벤트는 `CodexProvider`에서만
변환한다. `approval.*`, command/file-change 상세 이벤트는 Phase 2까지 외부 계약으로 발행하지 않는다.

## State, error, and reconnect behavior

### 상태

- Gateway: `Online`, `Idle`, `Busy`, `WaitingApproval`, `Error`
- Session: `Active`, `Archived`, `Unavailable`
- Run: `Queued`, `Running`, `Interrupting`, `Completed`, `Interrupted`, `Failed`

동일 Session에는 동시에 하나의 활성 Run만 허용한다. 중복 Run 시작이나 이미 끝난 Run 중단 요청은
명시적인 충돌 또는 상태 오류로 응답한다.

### 오류와 종료

- App Server 시작 실패, stdio 종료, JSON-RPC 오류, 초기화 실패는 상관관계 ID가 포함된 안전한 `error`
  이벤트와 API 오류로 변환한다.
- `initialize`와 `initialized`가 완료되기 전에는 Thread/Turn 요청을 보내지 않는다.
- Provider가 종료되면 활성 Run은 `Failed` 또는 `Interrupted`로 확정하고, 원인을 비밀값 없이 기록한다.
- 모바일 연결 해제는 Provider Run을 자동 중단하지 않는다. 클라이언트는 재연결 후 Session/Run 상태를 조회한다.
- 최근 이벤트는 Session별로 범위를 정해 영속화하고 sequence로 재전송한다. 보존 범위를 벗어난 요청에는
  전체 상태를 다시 조회하도록 응답한다. 정확한 보존 개수·기간은 저장소 결정과 함께 확정한다.

### 재연결

Gateway 재시작 후 영속 저장소에서 Project, Gateway ID와 Provider 원본 ID의 매핑을 읽는다.
CodexProvider가 Session 재개를 지원하면 `thread/resume`로 상태를 확인한다. 이미 끝났거나 Provider가
상태를 제공하지 않으면 Session을 `Unavailable`로 두고 제한 사항을 반환한다.

## Security and approval considerations

- Gateway는 Tailscale 인터페이스 또는 명시적으로 허용된 사설 바인딩에만 listen한다. 공용 인터페이스에는 바인딩하지 않는다.
- API와 WebSocket 모두 Client Token을 검증한다. Token은 환경 변수 또는 OS 비밀 저장소에서만 읽고, 저장소·로그·오류 응답에는 기록하지 않는다.
- Codex App Server는 Gateway 내부의 stdio 연결만 사용한다. 모바일에 JSON-RPC endpoint를 공개하지 않는다.
- Project 등록 시 경로 존재 여부, 허용된 Workspace root 하위 여부, 심볼릭 링크/정규화된 실제 경로를 검증한다.
- Session·Run·interrupt 요청은 Project와 Provider의 소속 관계를 검증한다.
- Phase 1은 Approval 결정을 전송하지 않는다. Provider가 승인을 요청하면 그 범위 또는 명령을 자동 수락하지 않는다.
- 로그는 Gateway ID와 상태를 포함하되 token, authorization header, 개인 경로, 원본 민감 command 인자를 마스킹한다.

## Implementation milestones

1. **기술 기준 확정**
   - Gateway 런타임·웹 프레임워크·WebSocket 구현·검증 라이브러리·영속 저장소를 ADR로 결정한다.
   - 권장 기준안은 Windows/WSL2에서 App Server stdio를 다루기 쉬운 TypeScript/Node.js와 로컬 SQLite다.
   - 실행 가능한 Codex CLI 최소 버전과 App Server schema 생성·호환성 확인 절차를 결정한다.

2. **Gateway skeleton과 보안 기본값**
   - 설정 로딩, Token 인증, Tailscale 바인딩 제한, 구조화 로그와 `/health`를 만든다.
   - Provider registry와 `CodexProvider` interface를 만들고 capability를 반환한다.

3. **CodexProvider lifecycle**
   - `codex app-server`를 stdio로 시작하고 JSONL JSON-RPC request/response/notification을 분리한다.
   - `initialize` 후 `initialized`를 보장하고, 프로세스 종료와 초기화 실패를 상태에 반영한다.

4. **Project와 Session 영속 모델**
   - Project 등록·조회 및 Workspace 검증을 구현한다.
   - Gateway Session/Run ID와 Codex Thread/Turn ID 매핑, 상태 전이, 단일 활성 Run 제약을 구현한다.

5. **Run·이벤트·중단 수직 슬라이스**
   - Session 생성/재개, Run 시작, Codex notification 정규화, WebSocket broadcast, interrupt를 연결한다.
   - sequence 기반의 제한된 이벤트 재전송과 재연결 상태 조회를 구현한다.

6. **실기기 검증과 운영 문서화**
   - Tailscale 환경의 모바일 또는 API 클라이언트에서 전체 수직 슬라이스를 검증한다.
   - 설정 예시, 로컬 실행, 오류 복구, 알려진 제한 사항을 README에 기록한다.

## Test plan

### Unit

- ID 매핑, 상태 전이, 단일 활성 Run 제약, capability 판정
- Token 누락·오류, 입력 schema, Project/Session/Run 소속 관계 검증
- Workspace 경로 정규화와 허용 root 탈출 차단
- Codex JSON-RPC request ID 매칭, 초기화 순서, notification → 공통 이벤트 변환
- 중복 interrupt, 종료된 Run, Provider 오류의 안전한 처리와 로그 마스킹

### Integration

- 가짜 App Server 프로세스를 이용해 initialize, Thread/Turn, delta, completed, interrupt, 비정상 종료를 검증한다.
- HTTP와 WebSocket 모두에서 인증 실패·권한 없는 리소스 접근·잘못된 상태 전이를 검증한다.
- 재연결 후 저장된 Project/Session 조회와 최근 이벤트 재전송을 검증한다.

### Manual / real-runtime

- 실제 Codex App Server에서 등록 Project의 Session 시작, Run stream, 완료, interrupt를 확인한다.
- Tailscale 기기에서 Token 인증과 WebSocket 이벤트 수신을 확인한다.
- 실제 자격 증명·개인 Workspace·Token은 테스트 fixture나 로그에 남기지 않는다.

## Documentation updates

- 구현 시작 전: 기술 기준안과 영속 저장소 선택을 ADR로 확정한다.
- 구현 중: 실제 API schema, 이벤트 payload, 오류 코드, 환경 변수 이름을 README에 추가한다.
- Phase 1 완료 전: 지원 capability, 재연결 보존 범위, 승인 제한, Codex CLI/App Server 버전 호환성을 README에 명시한다.
- 외부 API 계약이 확정 또는 변경될 때마다 `.agents/templates/api-change.md` 체크 항목을 PR 또는 작업 설명에 반영한다.

## Resolved technical baseline

런타임, 저장소, 이벤트 보존, Tailscale 바인딩, Client Token, Codex 계약 관리 기준은
[ADR 0002](../../.agents/decisions/0002-phase-1-technical-baseline.md)에서 확정했다.

Codex CLI/App Server의 정확한 최소 버전은 첫 실제 통합 구현에서 호환성 검증 후 pin한다.

## Implementation record (2026-09-05)

- [x] Fastify HTTP/WebSocket Gateway, Bearer Token 인증, loopback/Tailscale bind 검증, SQLite 상태 저장을 구현했다.
- [x] Project Workspace 정규화·허용 root 검증, Gateway ID 매핑, 단일 활성 Run 상태 전이를 구현했다.
- [x] Codex stdio JSON-RPC lifecycle (`initialize`, `initialized`, Thread/Turn, interrupt)과 최소 이벤트 정규화를 구현했다.
- [x] HTTP 인증, 허용 root 탈출, ID 매핑, 단일 활성 Run, Approval 자동 승인 방지를 자동 테스트로 검증했다.
- [x] `codex-cli 0.153.0`에서 App Server schema 생성 및 `initialize` → `initialized` → `thread/start` 실제 lifecycle을 검증했다.
- [ ] 실제 Run/interrupt와 Tailscale 실기기 연결은 별도 수동 검증이 필요하다.

### API change checklist

- [x] REST endpoint와 WebSocket event envelope를 README 및 `.agents/api-contracts.md`에 명시했다.
- [x] 새 Gateway API이므로 기존 모바일 클라이언트 호환성 영향이 없다.
- [x] 인증, 입력 검증, Workspace 소속 검증을 적용했다.
- [x] sequence 기반 순서·중복 방지와 보존 범위 밖 재조회 동작을 정의했다.
- [x] 외부 오류에 Token, Provider 원문 오류, 개인 경로·명령을 노출하지 않는다.
- [x] 정상, 입력/권한 실패, 상태 충돌, Approval 거절 흐름을 테스트했다.
