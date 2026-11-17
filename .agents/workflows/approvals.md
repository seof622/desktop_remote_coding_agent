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
- Provider request ID는 Gateway 프로세스별 연결 인스턴스 ID와 App Server 연결 세대에 함께 묶는다.
  프로세스 재시작으로 세대 숫자가 다시 시작돼도 이전 연결의 ID와 충돌하거나 성공·오류 응답을 보내지 않는다.
- `turn/start` 응답과 승인 요청이 같은 stream chunk로 도착해도 Gateway가 Turn ID를 저장한 뒤 승인 요청을
  처리하도록 시작 중인 Run의 Provider 이벤트를 잠시 보관한다. 응답의 Turn ID와 다른 승인 요청은 거절한다.
- Command와 File Change는 schema에 정의된 `accept`, `acceptForSession`, `decline`, `cancel`만 응답할 수 있다.
  execpolicy 또는 network policy amendment 객체는 지원하지 않는다.
- `availableDecisions`가 없으면 세션 범위를 넓히는 `acceptForSession`을 제외한 보수적 기본 결정을 사용한다.
- Permission 요청/응답 fixture와 안전한 오류 경로는 존재하지만, 실제 scope·거절 conformance 검증 전까지
  capability를 활성화하지 않는다.
- Gateway는 Provider 중립 `apr_` Approval과 Provider 원본 binding을 별도 SQLite table에 저장한다.
  동일 연결 인스턴스·세대와 request ID의 동일 요청은 기존 Approval을 반환하고, 다른 소속이나 내용으로 재사용하면 거부한다.
- decision claim은 SQLite transaction에서 `Pending` 상태를 한 번만 변경한다. Provider가 허용하지 않은 결정,
  중복 결정, 종료된 Run의 결정은 거부한다.
- Run이 `Completed`, `Interrupted`, `Failed`로 전이하면 해당 Run의 미해결 Approval을 같은 transaction에서
  `Resolved`로 종료한다.
- Command와 File Change는 `approval.requested` 이벤트와 조회 API로 노출하며 capability가 활성화돼 있다.
  표시용 command, cwd, reason, grant root는 길이·제어문자·secret·개인 경로를 정리하고 Project 기준 경로로 변환한다.
- 모바일 결정 API는 허용 목록과 Pending 상태를 검증한 뒤 내부 binding으로 Provider response를 한 번만 전달한다.
  성공 후 `Busy`, Provider 확인·Run 종료·전달 실패 후 `approval.resolved`를 발행한다.
- Provider response 전달 실패는 결정을 Pending으로 되돌리지 않고 `PROVIDER_RESPONSE_FAILED`로 resolve한 뒤
  Run을 실패 처리한다. Provider가 먼저 해결한 요청도 `PROVIDER_RESOLVED`로 종료해 재사용을 막는다.
- Gateway 재시작 시 저장된 미해결 Approval은 `PROVIDER_APPROVAL_UNAVAILABLE`로 resolve하고 이벤트를 저장한다.
  현재 버전은 이전 Provider request를 재바인딩하거나 결정을 재생하지 않는다.
- Permission approval은 실제 scope·거절 conformance 검증 전까지 capability가 `false`이며 안전하게 거절한다.
- `0.159.3`에서 loopback inference로 빈 profile의 무권한 결과, 요청 profile의 turn/session 응답과 interrupt를
  확인했다. 실제 Windows scope 적용 검증은 별도 명령 승인이 요구되어 실패했으므로 capability는 false를 유지한다.
  프로토콜 검증 성공을 실제 권한 enforcement 검증으로 취급하지 않는다.
- Permission 표시 데이터는 `fileSystem.entries` 및 legacy read/write 접근 모드를 포함하며 경로를 마스킹한다.
  알 수 없는 entry는 표시에서 조용히 누락하지 않고 알 수 없는 범위로 표현한다.
- 실제 연동 검증은 `npm run verify:gateway`로 재실행한다. `0.163.0`에서 명령 취소·미제공 decline 거부,
  파일 변경 거절·취소·중복 결정·Pending interrupt·재연결 replay·Permission 미지원 실패·재시작 복구를 확인했다.
  명령 수락/세션 수락, 실제 모델, 스마트폰 및 Permission enforcement의 검증 완료로 해석하지 않는다.
- filesystem enforcement는 marker 미생성과 명령 실행의 시작·종료 증거를 함께 확인한다.
  별도 Command Approval 차단이나 프로세스 시작 실패는 권한 거절 성공이 아닌 미검증 실패다.
- `0.169.0` Windows 재검증에서도 기본 계약은 통과했으나, unelevated의 승인 후 쓰기는
  `sandbox-layout-unsupported`, MXC는 `sandbox-unavailable`로 미검증이다. 무권한 쓰기 차단만으로
  turn 만료·session 유지·격리 검증 완료를 주장하지 않는다. Permission capability는 계속 false다.
- Permission 검증 도구는 파일 전용 요청과 혼합 요청을 구분하고 9개 scope 결과를 수집한다.
  일부라도 실패하면 실패 종료 코드를 유지한다. 쓰기 거절은 시작·종료뿐 아니라 오류 출력도 요구한다.
  `--windows-readiness`는 준비 상태 조회 전용이며 OS setup을 수행하지 않는다.
- `2026-11-17` Ubuntu 24.04 WSL2와 Linux `0.169.0`에서 파일 전용 enforcement 9개가 통과했다.
  승인 후 쓰기·turn 만료·session 유지·다른 Session 격리를 확인했다. Gateway 연동도 통과했으나
  network enforcement와 Permission cancel 의미는 미검증이므로 Permission capability는 false를 유지한다.
  fixture는 OS별 shell을 사용하며, 명령 승인 검사는 명시적 escalation 요청을 거절·취소한다.
  승인 표시 텍스트의 `/tmp` 등 POSIX 절대 경로도 마스킹한다.
- `2026-11-16` 사용자가 실제 Codex·Tailscale 스마트폰의 안내된 명령/파일 승인·재연결·Pending interrupt
  수동 검증 완료를 보고했다. 제공되는 Session 승인도 안내 범위에 포함되지만, Session 간 권한 격리와
  Permission enforcement 검증 완료로 해석하지 않는다. 실기기 화면·결정별 로그·CLI 버전은 직접 확인하지 않았다.
- Dashboard는 서버가 마스킹한 `display`를 텍스트로 표시하고 `availableDecisions` 중 지원하는 결정만 제공한다.
  결정 중 버튼을 잠그며 자동 재전송하지 않는다. 연결·승인 이벤트·결정 결과 뒤 Pending 목록을 재조회한다.
  과거 replay로 종료된 카드를 재생하지 않으며, Session/Token 전환 후 늦은 응답은 무시한다.
  상태 조회 실패 또는 socket 종료 시 결정 버튼을 잠그고 목록 새로고침으로 복구한다.

## 금지 사항

- Gateway가 자동으로 승인을 수락하지 않는다.
- 클라이언트가 서버가 제공하지 않은 결정을 보내도록 허용하지 않는다.
- 승인 정보를 다른 Thread 또는 Turn에 재사용하지 않는다.
