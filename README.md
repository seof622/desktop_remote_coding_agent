# desktop_remote_coding_agent

스마트폰에서 Windows 데스크탑의 Codex 개발 환경을 원격으로 제어하기 위한 **Desktop Gateway Agent**다.

이 프로젝트의 핵심 역할은 Codex CLI의 터미널 화면을 원격으로 전달하는 것이 아니라, **Codex App Server와 모바일 클라이언트 사이의 안정적인 Gateway**가 되는 것이다.

> 목표: 포트포워딩 없이 스마트폰에서 Codex 작업을 시작하고, 진행 상황을 확인하고, 명령/파일 변경 승인을 처리하고, 작업 결과와 Git 변경 사항을 검토한다.

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
│  - Thread/Turn Manager       │
│  - Approval Router           │
│  - Event Mapper              │
│  - Git / Build / Test API    │
└──────────────┬───────────────┘
               │
               │ JSON-RPC 2.0
               │ stdio / local socket
               ▼
┌──────────────────────────────┐
│ Codex App Server             │
│                              │
│ Thread → Turn → Item         │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ WSL2 / Project Workspace     │
│ Git / Build / Test / Docker  │
└──────────────────────────────┘
```

## 왜 Gateway 구조인가?

Codex App Server는 rich client를 만들기 위한 JSON-RPC 인터페이스를 제공한다. Desktop Agent는 App Server와 로컬 통신하고, 모바일에는 우리가 관리하는 REST/WebSocket API만 노출한다.

Codex App Server의 WebSocket transport는 experimental 성격이 있으므로 초기 버전에서는 모바일이 App Server에 직접 연결하지 않는다.

SSH/tmux는 주 통신 방식이 아니라 장애 대응 및 디버깅용 fallback으로만 사용한다.

---

## Codex App Server 모델

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

### FR-D01. Agent 실행 및 상태 관리

- Windows 또는 WSL2에서 실행
- 선택적 자동 시작
- 상태 제공
  - Online
  - Idle
  - Busy
  - WaitingApproval
  - Error

### FR-D02. Codex App Server 관리

- App Server 시작/종료
- 비정상 종료 감지
- 재시작 후 저장된 Thread 재조회/Resume
- 진행 중 Turn 유실 가능 여부 표시

### FR-D03. App Server 초기화

연결 직후 아래 순서를 보장한다.

```text
initialize
↓
initialized
```

초기화 이전에는 다른 Codex 요청을 보내지 않는다.

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

### FR-D05. Thread 생성

- `thread/start` 사용
- 프로젝트 경로를 `cwd`로 전달
- Thread ID 저장
- 프로젝트-Thread 연결 관리

### FR-D06. Thread Resume

- `thread/resume` 사용
- 모바일 연결이 끊겨도 기존 Thread를 다시 선택해 이어서 작업

### FR-D07. Turn 시작

모바일 자연어 요청을 `turn/start`로 전달한다.

### FR-D08. 실시간 이벤트 Streaming

주요 이벤트:

- `turn/started`
- `item/started`
- `item/agentMessage/delta`
- `item/completed`
- `turn/completed`

모바일에는 정규화된 이벤트 형태로 전달할 수 있어야 한다.

### FR-D09. Command Approval 중계

대상:

```text
item/commandExecution/requestApproval
```

모바일에 다음 정보를 제공한다.

- command
- cwd
- reason
- threadId
- turnId
- itemId
- available decisions

결정 예:

- accept
- acceptForSession
- decline
- cancel

서버가 `availableDecisions`를 제공하면 이를 우선 사용한다.

### FR-D10. File Change Approval 중계

대상:

```text
item/fileChange/requestApproval
```

변경 대상과 사유를 모바일에서 확인하고 승인/거절할 수 있어야 한다.

### FR-D11. Permission Approval 중계

지원 가능한 Codex 버전에서는:

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

`serverRequest/resolved` 수신 시 모바일 승인 UI도 종료할 수 있도록 이벤트를 전달한다.

### FR-D13. Turn 중단

모바일 Stop 요청을 Codex의 Turn interrupt 기능으로 연결한다.

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
- Thread / Turn 생성
- Approval 요청/결정
- Build/Test
- 오류

Secret과 Token은 기록하지 않는다.

### FR-D18. 재연결

재연결 후 다음 상태를 다시 동기화할 수 있어야 한다.

- Agent 상태
- Thread 목록
- 진행 중 Turn
- Pending Approval
- 최근 이벤트

---

## Mobile API 초안

Codex JSON-RPC를 그대로 외부에 노출하지 않고 애플리케이션 API로 추상화한다.

### REST

```text
GET    /health

GET    /projects
POST   /projects
GET    /projects/{projectId}

GET    /threads
POST   /threads
GET    /threads/{threadId}
POST   /threads/{threadId}/resume

POST   /threads/{threadId}/turns
POST   /threads/{threadId}/interrupt

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
thread.started
turn.started
agent.message.delta
command.started
command.completed
file.change
approval.requested
approval.resolved
turn.completed
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

- Codex App Server를 외부에 직접 노출하지 않는다.
- Mobile Client에 임의의 App Server JSON-RPC 호출 권한을 주지 않는다.
- Desktop Agent가 허용된 동작만 중계한다.
- Approval request ID와 Thread/Turn/Item ID를 검증한다.
- 이미 resolve된 Approval은 재사용하지 않는다.
- Codex sandbox/permission 정책을 우회하지 않는다.

---

## MVP

### Phase 1 — Remote Codex

- Tailscale 연결
- Agent 실행
- App Server 실행 및 initialize
- 프로젝트 등록
- `thread/start`
- `thread/resume`
- `turn/start`
- Agent Message Streaming
- Turn completed
- Turn interrupt

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
- Codex 터미널 UI parsing
- App Server experimental WebSocket을 모바일에 직접 공개
- Desktop Agent의 공용 인터넷 공개

---

## 향후 확장

- 여러 Desktop
- 여러 Codex Thread 병렬 실행
- Push Notification 기반 Approval 알림
- GitHub Issue → Codex Task
- Pull Request 생성/리뷰
- CI 상태 확인
- 작업 Queue
- 음성 명령
- 작업 완료 요약
