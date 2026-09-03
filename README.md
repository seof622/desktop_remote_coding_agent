# desktop_remote_coding_agent

## 프로젝트 개요

Windows 데스크탑에서 실행되며, 스마트폰 클라이언트로부터 원격 명령을 받아 Codex CLI 및 개발 도구를 실행하는 Agent 애플리케이션이다.

사용자는 외부 네트워크에서 스마트폰을 통해 데스크탑의 개발 환경에 접근하고, Codex에게 개발 작업을 지시하거나 빌드·테스트·Git 작업을 수행할 수 있어야 한다.

포트포워딩을 사용할 수 없는 환경을 전제로 하며, Tailscale 등의 사설 오버레이 네트워크를 통해 접근하는 것을 기본 구조로 한다.

---

## 핵심 목표

- Windows 데스크탑의 개발 환경을 스마트폰에서 원격 제어
- Codex CLI 원격 실행 및 기존 세션 유지
- 스마트폰 연결이 끊겨도 실행 중인 작업 지속
- 여러 프로젝트 등록 및 선택
- 코드 변경 내역과 실행 결과 확인
- 위험 작업에 대한 사용자 승인

---

## 실행 환경

### 필수

- Windows 11
- WSL2
- Git
- Codex CLI
- SSH Server
- Tailscale

### 선택

- Docker / Docker Desktop
- tmux
- Node.js
- Python
- 기타 프로젝트별 개발 도구

---

## 시스템 구성

```text
Mobile Client
     │
     │ Tailscale Network
     ▼
Desktop Remote Coding Agent
     │
     ├── Project Manager
     ├── Session Manager
     ├── Codex Controller
     ├── Command Executor
     ├── Git Manager
     └── Event / Log Manager
             │
             ▼
           WSL2
             │
             ├── Codex CLI
             ├── Git
             ├── Build
             ├── Test
             └── Docker
```

---

## 기능 요구사항

### FR-D01. Agent 실행

- Windows 시작 시 자동 실행 가능
- 스마트폰 클라이언트의 연결 요청 수신
- 상태 표시
  - Online
  - Busy
  - Idle
  - Error

### FR-D02. 프로젝트 등록

프로젝트별 최소 정보:

- 프로젝트 ID
- 프로젝트 이름
- 프로젝트 경로
- Git Repository 여부
- 기본 Branch
- 실행 환경

예시:

```json
{
  "id": "smart-home",
  "name": "Smart Home",
  "path": "/home/user/projects/smart-home",
  "defaultBranch": "main"
}
```

### FR-D03. 프로젝트 조회

스마트폰에서 다음 정보 조회 가능:

- 프로젝트 이름
- 현재 Branch
- Git 변경 여부
- 최근 작업 시간
- 실행 중인 Codex Session

### FR-D04. Codex Session 생성

- 선택한 프로젝트에서 새 Codex Session 생성
- 해당 프로젝트 디렉터리를 Working Directory로 사용

### FR-D05. Codex Session 유지

- 스마트폰 연결이 종료되어도 Session 유지
- 재연결 후 기존 Session 재접속
- tmux 또는 유사한 세션 유지 방식 사용 가능

### FR-D06. Codex 명령 전달

스마트폰의 자연어 명령을 Codex CLI에 전달한다.

예:

```text
로그인 API 구현해줘.
기존 authentication 모듈 구조를 최대한 유지하고
테스트까지 작성해.
```

### FR-D07. 실시간 출력 전달

다음 정보를 스마트폰으로 실시간 전달:

- Codex 응답
- Shell 출력
- Build 결과
- Test 결과
- Error 로그

### FR-D08. Shell Command 실행

제한된 Shell Command 실행 지원.

예:

```bash
git status
git diff
npm test
pytest
docker compose ps
```

위험한 명령은 기본적으로 제한한다.

### FR-D09. Git 상태 확인

조회 대상:

- 현재 Branch
- 변경된 파일
- 추가된 파일
- 삭제된 파일
- staged 파일
- commit 상태

### FR-D10. Git Diff 제공

- 변경 코드 diff 조회
- 파일 단위 diff 지원

### FR-D11. Git 작업 수행

지원 작업:

- branch 생성
- branch 변경
- git add
- commit
- push

Commit 및 Push는 사용자 승인을 요구하도록 설정할 수 있다.

### FR-D12. Build 실행

프로젝트별 Build Command 설정 지원.

예:

```json
{
  "buildCommand": "./gradlew build",
  "testCommand": "./gradlew test"
}
```

### FR-D13. Test 실행

결과에 최소 다음 정보를 제공:

- 성공 여부
- 실행 시간
- 실패 테스트
- 주요 Error Message

### FR-D14. 작업 취소

- 실행 중인 Codex 작업 중단
- 실행 중인 Shell Command 중단

### FR-D15. 로그 저장

저장 항목:

- 작업 요청
- 작업 시작 시간
- 실행 명령
- 종료 상태
- 오류
- 사용자 승인 기록

---

## 승인 시스템

위험 작업 예시:

- git push
- 파일 대량 삭제
- branch 삭제
- Docker container 삭제
- dependency 대규모 변경
- 시스템 명령 실행

위험 작업은 즉시 실행하지 않고 클라이언트에 승인 요청을 전달한다.

```text
Codex requests:

git push origin feature/login

[Approve]
[Reject]
```

---

## API 요구사항

예시 REST API:

```text
GET    /projects
GET    /projects/{id}

GET    /sessions
POST   /sessions
DELETE /sessions/{id}

POST   /sessions/{id}/message

GET    /git/status
GET    /git/diff

POST   /commands

POST   /approval/{id}/approve
POST   /approval/{id}/reject
```

실시간 통신:

```text
WS /sessions/{id}/stream
```

---

## 인증 요구사항

초기 MVP:

- API Token
- Device Token

확장:

- Device Pairing
- Public Key Authentication

기본적으로 Tailscale Network 내부에서만 Agent API 접근을 허용한다.

---

## 보안 요구사항

- Agent API를 공용 인터넷에 직접 노출하지 않음
- Tailscale 내부 IP에서만 접근
- Shell Command allowlist 지원
- 시스템 중요 디렉터리 접근 제한
- 위험 작업 Approval 지원
- Token 및 Secret을 Git Repository에 저장하지 않음

---

## 비기능 요구사항

### 안정성

스마트폰 네트워크가 변경되거나 연결이 끊겨도 Desktop Session은 유지되어야 한다.

### 복구성

Agent 재시작 후 이전 Session 및 작업 기록을 최대한 복구할 수 있어야 한다.

### 성능

- 명령 전달 지연 최소화
- 실시간 로그 즉시 전달

---

## MVP 범위

1차 버전:

- Tailscale 기반 연결
- Project 목록 조회
- Codex Session 생성
- Codex Prompt 전송
- Codex 출력 Streaming
- Session 유지
- Git Status
- Git Diff
- Test 실행
- 작업 Cancel

2차 버전 후보:

- Commit
- Push
- Approval 시스템

---

## 향후 확장

- 여러 Desktop 연결
- 여러 Codex Agent 병렬 실행
- GitHub Issue 기반 작업 생성
- Pull Request 자동 생성
- 스마트폰 Push Notification
- 작업 완료 알림
- 작업 Queue
- Agent별 권한 설정
- 음성 명령
- AI 기반 작업 요약
