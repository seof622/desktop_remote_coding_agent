# Approval Workflow

## 대상

- Command approval: `item/commandExecution/requestApproval`
- File change approval: `item/fileChange/requestApproval`
- Permission approval: `item/permissions/requestApproval` (지원되는 Codex 버전만)

## 상태 전이

```text
Pending -> Accepted | Declined | Cancelled -> Resolved
```

- 승인 요청을 받을 때 request ID와 Thread/Turn/Item ID의 관계를 저장·검증한다.
- 모바일에는 command, cwd, reason, 사용 가능한 결정, 대상 파일 또는 권한 범위를 안전하게 표시한다.
- 모바일 결정은 한 번만 전달한다. 중복·지연·이미 해결된 결정을 안전하게 거절한다.
- `serverRequest/resolved`를 받으면 Pending 상태와 모바일 UI에 종료 이벤트를 반영한다.
- 재연결 후에도 Pending Approval을 다시 조회하거나 복구할 수 있어야 한다.

## 현재 구현 경계

- Codex adapter는 승인 server request를 정확한 method 이름으로만 구분하며, 필수 Thread/Turn/Item과
  요청 시작 시각이 없는 payload는 안전한 JSON-RPC 오류로 거절한다.
- Provider request ID는 App Server 연결 세대와 함께 묶는다. 이전 연결의 ID로 성공·오류 응답을 보내지 않는다.
- `turn/start` 응답과 승인 요청이 같은 stream chunk로 도착해도 Gateway가 Turn ID를 저장한 뒤 승인 요청을
  처리하도록 시작 중인 Run의 Provider 이벤트를 잠시 보관한다. 응답의 Turn ID와 다른 승인 요청은 거절한다.
- Command와 File Change는 schema에 정의된 `accept`, `acceptForSession`, `decline`, `cancel`만 응답할 수 있다.
  execpolicy 또는 network policy amendment 객체는 지원하지 않는다.
- `availableDecisions`가 없으면 세션 범위를 넓히는 `acceptForSession`을 제외한 보수적 기본 결정을 사용한다.
- Permission 요청/응답 fixture와 안전한 오류 경로는 존재하지만, 실제 scope·거절 conformance 검증 전까지
  capability를 활성화하지 않는다.
- Gateway는 Provider 중립 `apr_` Approval과 Provider 원본 binding을 별도 SQLite table에 저장한다.
  동일 연결 세대와 request ID의 동일 요청은 기존 Approval을 반환하고, 다른 소속이나 내용으로 재사용하면 거부한다.
- decision claim은 SQLite transaction에서 `Pending` 상태를 한 번만 변경한다. Provider가 허용하지 않은 결정,
  중복 결정, 종료된 Run의 결정은 거부한다.
- Run이 `Completed`, `Interrupted`, `Failed`로 전이하면 해당 Run의 미해결 Approval을 같은 transaction에서
  `Resolved`로 종료한다.
- 모바일 결정 API가 아직 없으므로 Gateway는 Provider 요청을 자동 승인하지 않고 안전한 오류로 응답한 뒤
  기존 Phase 1 실패 이벤트를 유지한다. 외부 승인 capability도 계속 `false`다.

## 금지 사항

- Gateway가 자동으로 승인을 수락하지 않는다.
- 클라이언트가 서버가 제공하지 않은 결정을 보내도록 허용하지 않는다.
- 승인 정보를 다른 Thread 또는 Turn에 재사용하지 않는다.
