# MVP Phase 1: Remote Codex

## 포함 범위

- Tailscale 연결을 전제로 한 Agent 실행
- Codex App Server 실행, 연결, `initialize` / `initialized`
- 프로젝트 등록 및 Workspace 검증
- `thread/start`, `thread/resume`, `turn/start`
- Agent message streaming, `turn/completed`, turn interrupt

## 완료 기준

모바일 클라이언트가 등록된 프로젝트에서 Thread를 시작하거나 재개하고, Turn의 메시지와 완료 상태를
실시간으로 확인하며, 필요할 때 안전하게 중단할 수 있다.

## 제외 범위

Approval 중계는 Phase 2, Git/Build/Test 제어는 Phase 3에서 다룬다. Phase 1 구현에서 이를
우회하거나 자동 승인으로 대체하지 않는다.
