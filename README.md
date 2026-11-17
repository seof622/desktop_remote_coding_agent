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

## Phase 1 실행

Node.js 22.5 이상과 Codex CLI가 필요하다. 현재 지원 기준은 `codex-cli 0.153.0`이며, 이 버전에서
생성한 App Server schema와 `initialize` → `initialized` → `thread/start` 수직 경로를 확인했다.
Gateway는 `codex app-server`를 자식 프로세스의 stdio JSON-RPC로만 실행하며, App Server 포트를 열거나
모바일에 JSON-RPC를 노출하지 않는다.

```powershell
$env:GATEWAY_CLIENT_TOKEN = "32자 이상인-임의의-비밀-토큰을-여기에-설정"
$env:GATEWAY_WORKSPACE_ROOTS = "C:\\Work\\Projects"
npm install
npm run dev
```

Windows에서 Gateway 터미널에 `spawn codex ENOENT`가 표시되면, Node 프로세스가 Codex 실행 파일을
PATH에서 찾지 못한 것이다. 같은 PowerShell에서 `CODEX_COMMAND`를 설치된 실행 파일로 명시한 뒤 Gateway를
다시 시작한다.

```powershell
$env:CODEX_COMMAND = (Get-ChildItem "$env:LOCALAPPDATA\OpenAI\Codex\bin" -Recurse -Filter codex.exe |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName)
npm run dev
```

기본 주소는 `127.0.0.1:8787`이다. Tailscale 기기에서 사용하려면 `GATEWAY_BIND_HOST`에
명시적인 Tailscale IPv4 주소(`100.64.0.0/10`)만 설정할 수 있다. `0.0.0.0`이나 공용
인터페이스 바인딩은 거부한다.

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `GATEWAY_CLIENT_TOKEN` | 없음, 필수 | 32자 이상 Client Token. 로그·DB·응답에 저장하지 않는다. |
| `GATEWAY_BIND_HOST` | `127.0.0.1` | loopback 또는 명시적인 Tailscale IPv4 주소 |
| `GATEWAY_PORT` | `8787` | Gateway HTTP/WebSocket 포트 |
| `GATEWAY_DATA_DIR` | `data/` | SQLite 상태 저장 경로. Git에 포함하지 않는다. |
| `GATEWAY_WORKSPACE_ROOTS` | 현재 작업 디렉터리 | 허용 Workspace root 목록. Windows에서는 `;`, Linux에서는 `:`로 구분 |
| `CODEX_COMMAND` | `codex` | Codex CLI 실행 파일 |
| `CODEX_APP_SERVER_ARGS` | `app-server` | Codex App Server 인자 |

### WSL2 개발 환경

`2026-11-17` 로컬 환경에 Ubuntu 24.04 WSL2와 일반 사용자 `dev`, Node.js `22.23.5`,
Codex CLI `0.169.0`, Git·Python·빌드 도구·bubblewrap을 구성했다. Ubuntu를 기본 배포판으로
지정했으며 Docker용 배포판은 유지했다. Windows 저장소를 보존하고 Linux 파일시스템의
`~/code/desktop_remote_coding_agent`에 별도 Git 작업 사본과 Linux 의존성을 설치했다.
두 작업 사본은 자동 동기화되지 않는다. 기존 비밀값·Codex 인증·DB·미추적 파일은 복사하지 않았다.

PowerShell에서 개발 셸을 연다.

```powershell
wsl -d Ubuntu-24.04 --cd ~
```

WSL 셸에서는 다음 명령을 사용한다. 실제 모델을 사용하려면 WSL의 Codex에 별도로 로그인한다.

```bash
cd ~/code/desktop_remote_coding_agent
codex login --device-auth
gateway-dev
```

`gateway-dev`는 이 로컬 환경에 구성한 실행 명령이다. 빌드 결과를 실행하므로 소스를 변경하면
`npm run build` 후 다시 시작한다. 설정과 무작위 Client Token은 저장소 밖의
`~/.config/desktop-gateway/environment`에 권한 `600`으로 저장하고 launcher가 읽는다.
DB는 `~/.local/share/desktop-gateway`를 사용한다. 인증 파일이나 Token을 저장소·로그에 복사하지 않는다.
`dev`는 비밀번호를 지정하지 않은 일반 사용자이며 필요한 관리자 작업은 PowerShell의
`wsl -d Ubuntu-24.04 -u root`로 별도 수행할 수 있다.

Gateway는 loopback에만 바인딩하며 자동 시작 서비스나 Tailscale 원격 경로는 구성하지 않았다.
로컬 인증 health 점검 후 서버를 종료했다. Windows의 Tailscale 연결만으로 WSL Gateway의 모바일
접근까지 검증됐다고 해석하지 않는다. Codex App Server는 Gateway의 stdio 자식 프로세스로 유지한다.

WSL에서 재검증하는 명령은 다음과 같다.

```bash
npm test
npm run typecheck
npm run build
npm run verify:permissions
npm run verify:permissions -- --enforcement --permissions=filesystem
npm run verify:gateway
```

WSL 자동 테스트 61개, typecheck·build, 기본 Permission 계약과 파일 enforcement 9개,
Gateway HTTP/WebSocket·재연결·재시작 및 인증 health 검증이 통과했다. fixture는 OS에 맞는
PowerShell/Bash 명령을 사용하고 Command 승인 검사는 명시적 escalation을 요청한 뒤 거절·취소한다.
승인 표시에서는 `/tmp` 등을 포함한 POSIX 절대 경로를 마스킹한다.
실제 모델·모바일 연결·network enforcement·Permission cancel 의미는 미검증이며
Permission capability는 계속 `false`다. Windows 네이티브 sandbox 제약은 별도 과제로 남는다.

## Mobile API

Provider별 프로토콜을 외부에 노출하지 않는, 현재 구현된 Provider 중립적 API다. `GET /dashboard`는
Token·Project·Session 데이터를 포함하지 않는 공개 정적 테스트 화면이다. 그 외 모든 HTTP API에는
`Authorization: Bearer <GATEWAY_CLIENT_TOKEN>` 헤더가 필요하다.

### 스마트폰 브라우저 테스트

Tailscale에 연결된 스마트폰에서 `http://<Gateway-Tailscale-IP>:8787/dashboard`를 열고 Token을 직접
입력하면, Project 등록·Codex Session/Run 시작·interrupt·이벤트 수신을 테스트할 수 있다. Token은 해당
페이지의 메모리에만 존재하며 새로고침하거나 닫으면 삭제된다.

Dashboard의 REST 요청은 Bearer 인증을 사용한다. 브라우저 WebSocket은 임의 `Authorization` 헤더를 설정할 수
없으므로 `Sec-WebSocket-Protocol: gateway-v1.<base64url(Client Token)>`으로 인증한다. Token을 URL이나
브라우저 저장소에 넣지 않는다. 이 화면은 검증용이며 Command/File Change 승인 UI를 제공한다.
선택 Session의 대기 요청을 표시하며, Session 선택 전에는 전체 요청을 보여준다. 서버가 허용한 결정만
버튼으로 제공하고 결정 중 중복 클릭을 차단한다. 이벤트 수신·재연결·결정 후 최신 Pending 목록을 조회해
종료된 요청의 과거 replay를 카드로 되살리지 않는다. 조회 실패 또는 연결 종료 시 버튼을 잠그며
`목록 새로고침`으로 복구한다. 결정은 자동 재전송하지 않는다. Git, Build/Test 제어는 지원하지 않는다.

### REST

```text
GET    /health
GET    /dashboard                 # 공개 정적 테스트 화면, 데이터 없음

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

GET    /sessions/{sessionId}/events?afterSequence={number}

GET    /approvals?sessionId={optional}&status={optional}
GET    /approvals/{approvalId}
POST   /approvals/{approvalId}/decision
```

`POST /projects`는 `{ "name", "workspacePath" }`를 받고, 경로가 정규화된 허용 root 하위인지
검증한다. `POST /sessions`는 `{ "providerId": "codex", "projectId" }`,
`POST /sessions/{sessionId}/runs`는 `{ "text" }`를 받는다. Gateway가 발급하는 `prj_`, `ses_`,
`run_`, `evt_`, `apr_`, `itm_` ID만 외부에 반환하며 Codex Thread/Turn/Item/request ID는 노출하지 않는다.

Approval 결정 요청은 `{ "decision": "accept" }` 형태이며 `accept`, `acceptForSession`, `decline`, `cancel`
중 해당 Approval의 `availableDecisions`에 포함된 값만 허용한다. Command와 File Change approval을 지원하며,
Permission approval은 실제 Codex conformance 검증 전까지 capability가 `false`다. command, cwd, reason,
grant root는 길이 제한, 제어문자 제거, secret·개인 경로 마스킹, Project 기준 상대 경로 변환 후 노출한다.

오류는 `{ "error": { "code", "message" } }` 형태다. 잘못된 입력은 `400`, 인증 실패는 `401`,
허용되지 않은 Workspace는 `403`, 리소스 없음은 `404`, 상태 충돌은 `409`, Provider 시작/통신 실패는
`503`으로 반환한다. 오류에는 Token, App Server 원문 오류, 개인 경로 또는 명령 인자가 포함되지 않는다.

### WebSocket

```text
WS /events?sessionId={optional}&afterSequence={optional}
```

주요 이벤트:

```text
agent.status, session.started, run.started, agent.message.delta,
approval.requested, approval.resolved, run.completed, error
```

이벤트 envelope는 `eventId`, `sequence`, `type`, `occurredAt`, `providerId`, `projectId`,
`sessionId`, 선택적 `runId`, `payload`를 포함한다. 하나의 Session 내 sequence는 증가 순서로
보존된다. 연결 시 `afterSequence` 이후의 보존 이벤트를 먼저 재전송한 뒤 실시간 이벤트를 보낸다.
Session별 최근 1,000개 및 7일 이내 이벤트만 보존하므로 범위 밖이면 Session/Run 상태를 다시 조회해야 한다.

Command와 File Change approval은 요청을 SQLite에 먼저 저장한 뒤 `approval.requested`를 발행한다.
결정은 한 번만 원자적으로 claim하고 Codex App Server에 정확한 JSON-RPC response를 전달한다.
`serverRequest/resolved`, Run 종료 또는 Provider response 전달 실패 시 `approval.resolved`를 발행한다.
모바일 재연결 시 기존 이벤트 replay와 Pending Approval 조회를 함께 사용한다. Dashboard에서 Command/File Change
요청과 허용된 결정을 확인할 수 있다. UI 자동 테스트와 아래 로컬 fixture 연동 검증은 통과했으며,
실제 모델·Tailscale 스마트폰 승인 수동 검증은 `2026-11-16` 사용자 완료 보고로 기록했다.
검증 범위는 아래 수동 검증 기록을 따른다.
Gateway 재시작 시 이전 연결의 미해결 Approval은
`PROVIDER_APPROVAL_UNAVAILABLE`로 종료하며 오래된 Provider request ID를 재생하지 않는다. Permission approval은
자동 수락하지 않고 안전하게 실패한다.

### 스마트폰 승인 수동 검증 기록

`2026-11-16`, 사용자가 안내된 실제 Codex·Tailscale 스마트폰 검증 절차를 모두 완료했다고 보고했다.
일반 답변·스트리밍, Command/File Change의 수락·거절·취소와 제공되는 Session 승인,
연결 복구 후 Pending 조회·종료된 카드 재등장 방지, 승인 대기 중 interrupt를 수동 검증 범위로 기록한다.
이 기록은 사용자 보고이며 에이전트가 실기기 화면이나 실행 로그를 직접 확인한 결과는 아니다.
실제 CLI 버전과 결정별 로그는 별도로 수집하지 않았다. Session 승인의 세부 적용 범위·다른 Session과의
격리 및 Permission의 실제 권한 적용·만료·취소 의미 검증은 이 완료 보고로 확정하지 않는다.
Permission capability는 계속 `false`다.

### Permission 승인 검증

`npm run verify:permissions`는 설치된 Codex App Server와 loopback Responses fixture를 사용한다.
독립 임시 `CODEX_HOME`과 ephemeral Thread를 사용하며 실제 모델 호출·계정 인증·사용자 프로젝트 수정은 하지 않는다.
실행 파일을 찾지 못하면 `CODEX_CONFORMANCE_COMMAND`에 Codex 실행 파일을 지정한다.

`codex-cli 0.159.3`에서 빈 Permission profile의 무권한 결과, 요청 profile 그대로의 turn/session scope 응답,
다음 Turn 및 별도 Session의 요청 처리, Pending 중 interrupt를 확인했다. `request_permissions_tool` feature는
검증 프로세스에서만 활성화한다. 기본 검증 성공은 실제 sandbox 권한 적용·만료가 검증됐다는 뜻이 아니다.

`npm run verify:permissions -- --enforcement`는 독립 임시 폴더의 marker 쓰기로 filesystem 권한 거절,
turn 만료, session 유지 및 별도 Session 분리를 추가 검사한다. 명령의 시작·종료 출력과 실제 marker를 함께
확인하며, 추가 명령 승인 또는 프로세스 실행 실패는 권한 거절 성공으로 세지 않는다. 외부 사이트에 접속하지 않으며
네트워크 권한 적용은 검증하지 않는다. 현재 Windows 격리 환경에서는 별도 명령 승인이 요구되어
`command-approval-required`로 실패했다. 일반 WSL 배포판도 확인되지 않아 capability는 `false`를
유지한다. Windows sandbox 설정 또는 적절한 검증 환경이 필요하며 network 권한의 실제 적용은 별도 검증해야 한다.
검증 도구는 OS sandbox 설정을 자동 변경하거나 명령 승인을 자동 수락하지 않는다.

기존 sandbox를 임시 프로세스에만 지정한 `--enforcement --windows-sandbox=unelevated`에서는 무권한
파일 쓰기 거절을 확인했지만, 권한 승인 후 분리된 쓰기 root를 적용하는 실행이 sandbox에서 거부되었다.
도구는 이를 `sandbox-layout-unsupported`로 실패 처리한다. 설정 저장·관리자 setup은 수행하지 않았으며,
이 결과는 승인 후 권한 적용·만료·세션 유지의 검증 완료를 의미하지 않는다.

`2026-11-16`, `codex-cli 0.169.0`에서도 기본 Permission 계약과 Pending interrupt는 통과했다.
Windows 전용 재검증은 다음 명령을 사용한다.

```powershell
npm.cmd run verify:permissions -- --windows-readiness
npm.cmd run verify:permissions -- --enforcement --windows-sandbox=unelevated --permissions=filesystem
```

`--windows-readiness`는 준비 상태만 조회하며 설치를 수행하지 않는다. 이번 임시 환경의 응답은
`notConfigured`였다. `--permissions=filesystem`은 network 권한을 요청하지 않고 파일 쓰기만 검사한다.
기본값 `mixed`는 기존 filesystem/network 요청 계약을 유지한다. 실제 network enforcement는 두 모드 모두 미검증이다.
enforcement는 deny/turn/session 각각에서 첫 Turn·다음 Turn·별도 Session의 9개 결과를 수집하며,
하나라도 미검증이면 종료 코드 1과 `summary.filesystemVerified=false`를 반환한다.

unelevated 검사에서는 무권한 쓰기 차단 6개를 확인했으나 승인 후 쓰기가 필요한 3개는
`sandbox-layout-unsupported`로 실행되지 않았다. 따라서 turn 만료·session 유지·격리의 전체 검증은
미완료다. MXC 검사도 `sandbox-unavailable`로 9개 모두 실행되지 않았다. 관리자 setup과 OS 정책 변경은
수행하지 않았으며 Permission capability는 계속 `false`다. 거절 성공 판정은 명령 시작·종료,
쓰기 오류 출력, marker 미생성을 함께 요구한다.

권한 표시 데이터는 Codex의 `fileSystem.entries`와 legacy `read`/`write`를 읽어 접근 모드·특수 범위를 표시한다.
개인 경로는 Project 상대 경로 또는 `<outside-workspace>`로 변환하며, Dashboard는 이를 텍스트로 표시한다.

### 실제 Gateway 연동 검증

`npm run verify:gateway`는 실제 App Server와 독립 loopback inference fixture를 Gateway HTTP/WebSocket에
연결한다. 임시 CODEX_HOME·Workspace·SQLite DB와 메모리에서 생성한 Client Token을 사용한다. 실제 모델 호출,
사용자 자격 증명 사용, OS 설정 변경, 명령·파일 변경 승인 수락은 하지 않는다. fixture 모델 식별자는 도구
카탈로그를 선택하기 위한 `gpt-6.1-sol`이며, 응답은 모두 로컬 fixture가 생성한다.

`2026-10-21`, `codex-cli 0.163.0`에서 다음 검증을 통과했다.

- 명령 취소 및 제공되지 않은 `decline` 결정의 `400` 거부 (해당 요청의 허용 목록은 accept/cancel).
- 파일 변경 거절·취소, 중복 결정의 `409` 거부, 실시간 승인 이벤트와 브라우저 WebSocket 재연결 replay.
- 승인 대기 중 interrupt와 Pending 정리, Permission 미지원 요청의 `APPROVAL_UNSUPPORTED` 실패 처리.
- Gateway 상태 재시작 후 오래된 승인 종료·결정 거부·해결 이벤트 replay 및 새 Provider 연결의 승인 처리.
- 승인·이벤트의 Token, Provider binding 및 fixture 절대 경로 비노출. 명령·파일 변경 marker 미생성.

출력의 `summary.coverage`와 `skipped`를 함께 확인한다. 런타임이 파일 변경 도구를 제공하지 않으면 그 검증을
미수행으로 표시한다. 명령 수락·세션 수락의 실제 실행, Permission의 실제 권한 적용, 실제 모델 및 Tailscale
스마트폰 화면 검증은 이 도구의 성공 범위에 포함하지 않는다. PowerShell 실행 정책이 npm.ps1을 차단하면
`npm.cmd run verify:gateway`처럼 npm.cmd를 사용한다. `npm run typecheck`는 검증 스크립트도 검사한다.

`2026-11-16`, `0.169.0`에서도 위 Gateway 연동 검증을 통과했다. 종료된 작업의 늦은 inference 요청이
다음 검사 상태를 덮어쓰지 않도록 loopback fixture의 상태를 고유한 테스트 prompt별로 분리했다.

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
