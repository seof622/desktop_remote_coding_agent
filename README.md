# desktop_remote_coding_agent

스마트폰에서 Windows 데스크탑의 AI 코딩 에이전트 환경을 원격으로 제어하기 위한 **Desktop Gateway Agent**다.

이 프로젝트의 핵심 역할은 특정 CLI의 터미널 화면을 원격으로 전달하는 것이 아니라,
**AI 코딩 에이전트와 모바일 클라이언트 사이의 안전하고 안정적인 Gateway**가 되는 것이다.
초기 구현 Provider는 Codex App Server다.

> 목표: 포트포워딩 없이 스마트폰에서 AI 코딩 작업을 시작하고, 진행 상황을 확인하고,
> 명령/파일 변경 승인을 처리하고, 작업 결과와 Git 변경 사항을 검토한다.

---

## 핵심 아키텍처

```text
┌──────────────────────┐
│ Mobile Client        │
│ Flutter / Android    │
└──────────┬───────────┘
           │
           │ Tailscale
           │ HTTPS / WebSocket
           ▼
┌──────────────────────────────┐
│ Desktop Remote Coding Agent  │
│                              │
│  - Client API                │
│  - Auth                      │
│  - Project Manager           │
│  - Agent Session/Run Manager │
│  - Provider Adapter          │
│  - Approval Router           │
│  - Event Mapper              │
│  - Git / Build / Test API    │
└──────────────┬───────────────┘
               │ Provider-specific protocol
       ┌───────┴────────────────┐
       ▼                        ▼
┌───────────────────┐  ┌──────────────────────────┐
│ Codex App Server  │  │ Future Agent Providers   │
│ Adapter           │  │ (adapter per runtime)    │
└─────────┬─────────┘  └─────────────┬────────────┘
          ▼                          ▼
   Codex App Server           Other agent runtimes
               │
               ▼
┌──────────────────────────────┐
│ WSL2 / Project Workspace     │
│ Git / Build / Test / Docker  │
└──────────────────────────────┘
```

## 왜 Gateway 구조인가?

각 AI 코딩 에이전트는 대화, 작업 실행, 승인, 이벤트를 서로 다른 방식으로 제공할 수 있다.
Desktop Agent는 Provider별 adapter와 로컬 통신하고, 모바일에는 우리가 관리하는 REST/WebSocket API만 노출한다.

초기 Provider인 Codex App Server의 WebSocket transport는 experimental 성격이 있으므로,
모바일이 App Server에 직접 연결하지 않는다.

SSH/tmux는 주 통신 방식이 아니라 장애 대응 및 디버깅용 fallback으로만 사용한다.

## Agent Provider 모델

Gateway의 외부 API와 내부 공통 도메인은 특정 Provider 용어에 묶이지 않는다.

```text
AgentSession
  └── AgentRun
       └── AgentEvent
```

CodexProvider에서는 이를 아래처럼 매핑한다.

```text
AgentSession -> Codex Thread
AgentRun     -> Codex Turn
AgentEvent   -> Codex Item 또는 notification
```

각 Provider adapter는 가능한 기능을 선언한다. 예를 들어 세션 재개, 이벤트 스트리밍,
명령 승인, 파일 변경 승인, 실행 중단, Workspace 접근은 Provider마다 지원 여부가 다를 수 있다.
모바일 클라이언트는 capability를 바탕으로 지원하지 않는 기능을 숨기거나 명확히 미지원으로 표시한다.

처음부터 여러 Provider를 구현하지는 않는다. MVP에서는 `CodexProvider`만 제공하고,
추후 다른 런타임은 별도 adapter로 추가한다. Provider별 프로토콜, 자격 증명, 이벤트 형식은
adapter 내부에 격리하며 공통 Gateway API로 새지 않게 한다.

---

## Codex App Server 모델

`CodexProvider`가 사용하는 초기 Provider 구현 모델이다.

```text
Thread
  └── Turn
       ├── User Message
       ├── Agent Message
       ├── Command Execution
       ├── File Change
       └── 기타 Item
```

기본 lifecycle:

```text
Agent 시작
  ↓
Codex App Server 실행
  ↓
initialize
  ↓
initialized
  ↓
thread/start 또는 thread/resume
  ↓
turn/start
  ↓
item/* 이벤트 streaming
  ↓
필요 시 approval
  ↓
turn/completed
```

---

## 실행 환경

### 필수

- Windows 11
- WSL2
- Git
- Codex CLI / Codex App Server
- Tailscale

### 선택

- Docker / Docker Desktop
- Node.js
- Python
- 프로젝트별 SDK / Build Tool
- SSH Server / tmux

---

## 기능 요구사항

### FR-D01. Gateway 실행 및 상태 관리

- Windows 또는 WSL2에서 실행
- 선택적 자동 시작
- 상태 제공
  - Online
  - Idle
  - Busy
  - WaitingApproval
  - Error

### FR-D02. Agent Provider 관리

- 선택된 Provider의 시작/종료 및 상태 조회
- Provider 비정상 종료 감지
- Provider별 재시작·재연결 동작 처리
- Provider가 지원하면 저장된 Session 재조회/Resume 및 진행 중 Run 유실 가능 여부 표시
- MVP에서는 Codex App Server를 `CodexProvider`로 관리

### FR-D03. Provider 초기화

CodexProvider는 연결 직후 아래 순서를 보장한다.

```text
initialize
↓
initialized
```

초기화 이전에는 다른 Codex 요청을 보내지 않는다. 다른 Provider는 해당 런타임의
초기화·인증 수명 주기를 adapter 내부에서 처리한다.

### FR-D04. 프로젝트 관리

```json
{
  "id": "smart-home",
  "name": "Smart Home",
  "path": "/home/user/projects/smart-home",
  "defaultBranch": "main",
  "buildCommand": "./gradlew build",
  "testCommand": "./gradlew test"
}
```

- 프로젝트 등록/제거/조회
- Workspace 경로 검증
- Git Branch / 변경 여부 조회

### FR-D05. Agent Session 생성

- 선택된 Provider에 새 Session 생성 요청
- Provider가 Workspace 경로를 지원하면 등록된 프로젝트 경로만 전달
- Gateway Session ID와 Provider의 원본 ID를 매핑·저장
- 프로젝트-Session 연결 관리
- CodexProvider는 `thread/start`를 사용

### FR-D06. Agent Session Resume

- Provider가 지원할 때 기존 Session을 다시 선택해 이어서 작업
- 모바일 연결이 끊겨도 Gateway Session 상태를 복구
- CodexProvider는 `thread/resume`를 사용

### FR-D07. Agent Run 시작

모바일 자연어 요청을 선택된 Provider에 전달한다. CodexProvider는 `turn/start`를 사용한다.

### FR-D08. 실시간 이벤트 Streaming

Gateway는 Provider의 이벤트를 정규화해 모바일에 전달한다. CodexProvider가 수신하는 주요 원본 이벤트는 다음과 같다.

- `turn/started`
- `item/started`
- `item/agentMessage/delta`
- `item/completed`
- `turn/completed`

다른 Provider는 다른 원본 이벤트를 사용할 수 있다. 모바일에는 정규화된 이벤트 형태로 전달하고,
지원하지 않는 이벤트는 capability 또는 제한 사항으로 명확히 표시한다.

### FR-D09. Command Approval 중계

Command approval을 지원하는 Provider의 요청을 중계한다. CodexProvider의 대상은 다음과 같다.

```text
item/commandExecution/requestApproval
```

모바일에 다음 정보를 제공한다.

- command
- cwd
- reason
- sessionId
- runId
- itemId
- available decisions

결정 예:

- accept
- acceptForSession
- decline
- cancel

Provider가 `availableDecisions`를 제공하면 이를 우선 사용한다. 지원하지 않는 Provider에서는
명령 승인을 임의로 흉내 내거나 자동 수락하지 않는다.

### FR-D10. File Change Approval 중계

File change approval을 지원하는 Provider의 요청을 중계한다. CodexProvider의 대상은 다음과 같다.

```text
item/fileChange/requestApproval
```

변경 대상과 사유를 모바일에서 확인하고 승인/거절할 수 있어야 한다.

### FR-D11. Permission Approval 중계

Permission approval을 지원하는 Provider에서 처리한다. CodexProvider는 지원 가능한 Codex 버전에서:

```text
item/permissions/requestApproval
```

을 처리한다.

예:

- 추가 filesystem access
- network access

요청 범위보다 넓은 권한을 부여하지 않는다.

### FR-D12. Approval 상태 관리

```text
Pending
  ↓
Accepted / Declined / Cancelled
  ↓
Resolved
```

Provider의 승인 해결 이벤트를 수신하면 모바일 승인 UI도 종료할 수 있도록 이벤트를 전달한다.
CodexProvider에서는 `serverRequest/resolved`를 사용한다.

### FR-D13. Agent Run 중단

모바일 Stop 요청을 Provider의 실행 중단 기능으로 연결한다. 지원하지 않는 Provider는
명확히 미지원으로 응답한다. CodexProvider는 Turn interrupt 기능을 사용한다.

### FR-D14. Git 상태 조회

- 현재 Branch
- Modified / Added / Deleted
- staged 여부
- Ahead / Behind

### FR-D15. Git Diff

- 파일별 diff
- 전체 diff
- staged / unstaged 구분

Git 기능은 Codex 텍스트 출력 파싱에 의존하지 않고 Agent가 직접 제공한다.

### FR-D16. Build / Test

- 프로젝트별 Build/Test 명령
- stdout/stderr streaming
- exit code
- 실행 시간
- cancel

### FR-D17. 로그

- Client 연결/해제
- Provider / Session / Run 생성
- Approval 요청/결정
- Build/Test
- 오류

Secret과 Token은 기록하지 않는다.

### FR-D18. 재연결

재연결 후 다음 상태를 다시 동기화할 수 있어야 한다.

- Agent 상태
- Session 목록
- 진행 중 Run
- Pending Approval
- 최근 이벤트

Provider가 해당 상태를 제공하지 않으면 Gateway는 마지막으로 확인한 상태와 제한 사항을 표시한다.

---

## Mobile API 초안

Provider별 프로토콜을 그대로 외부에 노출하지 않고, Provider 중립적인 애플리케이션 API로 추상화한다.

### REST

```text
GET    /health

GET    /projects
POST   /projects
GET    /projects/{projectId}

GET    /providers
GET    /providers/{providerId}/capabilities

GET    /sessions
POST   /sessions
GET    /sessions/{sessionId}
POST   /sessions/{sessionId}/resume

POST   /sessions/{sessionId}/runs
POST   /sessions/{sessionId}/interrupt

GET    /projects/{projectId}/git/status
GET    /projects/{projectId}/git/diff

POST   /projects/{projectId}/build
POST   /projects/{projectId}/test

GET    /approvals
POST   /approvals/{approvalId}/decision
```

### WebSocket

```text
WS /events
```

주요 이벤트:

```text
agent.status
session.started
run.started
agent.message.delta
command.started
command.completed
file.change
approval.requested
approval.resolved
run.completed
build.output
test.output
error
```

---

## 인증 및 네트워크

```text
Smartphone
    │
    │ Tailscale
    ▼
Desktop Agent
```

- Port Forwarding 불필요
- 공용 인터넷 직접 노출 금지
- Tailscale 내부 접근만 허용하는 구성 지원
- Client Token 사용
- Token을 Repository에 저장하지 않음
- 향후 Device Pairing / Public Key 인증 확장

---

## 보안 원칙

- Codex App Server를 포함한 Provider runtime을 외부에 직접 노출하지 않는다.
- Mobile Client에 임의의 Provider 프로토콜 호출 권한을 주지 않는다.
- Desktop Agent가 허용된 동작만 중계한다.
- Approval request ID와 Session/Run/Event ID를 검증한다.
- 이미 resolve된 Approval은 재사용하지 않는다.
- Codex를 포함한 각 Provider의 sandbox/permission 정책을 우회하지 않는다.

---

## MVP

### Phase 1 — Remote Codex Provider

- Tailscale 연결
- Agent 실행
- App Server 실행 및 initialize
- 프로젝트 등록
- CodexProvider 등록 및 capability 제공
- `thread/start` / `thread/resume` / `turn/start` 매핑
- Agent Message Streaming
- Run completed
- Run interrupt

### Phase 2 — Remote Approval

- Command Approval
- File Change Approval
- Permission Approval
- 승인 결과 전달
- Pending Approval 복구

### Phase 3 — Development Controls

- Git Status
- Git Diff
- Build
- Test
- 실행 로그

---

## Non-Goals

초기 버전에서는 다음을 목표로 하지 않는다.

- 모바일 전체 IDE
- 원격 데스크탑 화면 Streaming
- 특정 Provider의 터미널 UI parsing
- Provider runtime의 experimental transport를 모바일에 직접 공개
- Desktop Agent의 공용 인터넷 공개

---

## 향후 확장

- 여러 Desktop
- 여러 Provider의 Session 병렬 실행
- Push Notification 기반 Approval 알림
- GitHub Issue → Codex Task
- Pull Request 생성/리뷰
- CI 상태 확인
- 작업 Queue
- 음성 명령
- 작업 완료 요약
- 추가 AI 코딩 에이전트 Provider adapter
