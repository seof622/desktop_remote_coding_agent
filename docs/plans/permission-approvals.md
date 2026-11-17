# Permission Approval Plan

## Goal

실제 설치된 Codex App Server에서 권한 승인 scope와 거절·취소를 검증하고, 확인된 계약만 Gateway에 연결한다.

## Scope and non-goals

- 기준: `codex-cli 0.159.3` 생성 schema와 공식 App Server Permission requests 문서.
- 실제 App Server + loopback Responses fixture로 `request_permissions`를 발생시킨다. 실제 모델 호출·계정 인증·파일 실행 없이 계약을 검증한다.
- 선택적 `--enforcement` 모드만 격리된 임시 폴더의 marker 쓰기를 실행한다. 명령 승인은 수락하지 않는다.
- Permission profile 검증, 요청 범위 그대로의 승인, 빈 profile 거절, turn/session scope 매핑 및 표시.
- 검증이 부족하면 capability는 false를 유지하며 검증 도구와 안전한 사전 구현까지만 반영한다.
- 이전 연결의 승인 재바인딩, 자동 승인, 임의 profile 편집, 영구 정책 변경은 제외한다.

## Affected boundaries

- Mobile API: 기존 Approval API/이벤트의 permission variant 사용. endpoint 변경 없음.
- Gateway: 안전한 filesystem 접근 모드·경로·network 표시 및 기존 상태 머신 사용.
- Codex App Server: 원본 요청 profile을 내부에 보관하고 결정별 정확한 응답 생성.
- Workspace: conformance 전용 임시 workspace만 사용. 사용자 프로젝트 명령을 실행하지 않는다.

## State, error, and reconnect behavior

- accept는 요청 profile과 turn scope, acceptForSession은 동일 profile과 session scope.
- decline/cancel은 실제 런타임에서 확인된 무권한 응답으로 매핑한다. cancel의 Run 중단 필요 여부도 확인한다.
- 기존 단일 claim, Provider 선해결, Run 종료, restart 시 stale request 종료 정책을 유지한다.
- 확인되지 않은 버전·profile은 fail closed. 재시작 후 request handle 재사용 금지.

## Security and approval considerations

- 허용 필드·접근 모드·path variant를 검증하고 알 수 없는 profile은 거절한다.
- 결정 payload로 권한을 추가하거나 변경할 수 없도록 내부 원본만 사용한다.
- UI는 접근 종류와 모든 요청 범위를 명시하고 private 경로를 마스킹한다.
- 로컬 mock inference와 독립 CODEX_HOME을 사용해 실제 API 키/사용자 설정을 읽지 않는다.

## Test plan

- 실제 App Server 요청·응답, 빈 profile 거절, turn/session 후속 요청·scope, interrupt·restart cleanup 확인.
- 잘못된 permission 구조·중복 결정·binding 경합·민감 경로 표시 및 Dashboard 검사.
- 전체 테스트·typecheck·build. 실제 모델·스마트폰 검증 여부를 별도 기록.

### 2026-10-21 후속 로컬 검증

- 설치된 `0.163.0`으로 기본 계약과 실제 Gateway HTTP/WebSocket → adapter → App Server 경로를 검증한다.
- 별도 loopback inference fixture와 임시 CODEX_HOME/Workspace/DB를 사용한다. 실제 모델·사용자 자격 증명·프로젝트는 사용하지 않는다.
- Command/File Change 거절·취소, Pending 중 interrupt, WebSocket 재연결 replay, Permission 미지원 거절을 확인한다.
  테스트가 만드는 파일은 격리된 fixture marker뿐이며 명령·파일 변경 승인을 자동 수락하지 않는다.
- 기존 enforcement 도구는 명령 승인 차단을 성공적인 권한 거절 검증으로 세지 않도록 고친다.
  파일 쓰기와 네트워크 결과를 분리하며, 외부 사이트에 대한 암묵적인 네트워크 probe를 제거한다.
- 실제 Gateway 재시작 시 미해결 승인 종료·오래된 결정 거부도 검증한다. 제품 API·capability는 변경하지 않는다.
- OS sandbox 설치·정책 변경 없이 사용할 수 있는 환경을 조회한다. 불가하면 원인과 미검증 범위를 기록한다.

## Documentation updates

### 2026-11-17 WSL2 개발 환경 구성 계획

- 목표: Ubuntu 24.04 WSL2에 일반 개발 사용자, Linux Node.js/Codex와 독립 작업 사본을 구성한다.
- 경계: Mobile API와 Gateway의 capability·승인 상태 전이는 유지한다. App Server는 WSL 내부의
  Linux 실행 파일과 stdio를 사용하고 저장소는 Linux 파일시스템에 둔다.
- 검증 fixture의 명령을 OS별로 선택한다. Windows는 기존 PowerShell 동작을 유지하고 Linux는
  Bash를 사용한다. 경로를 shell 인자로 안전하게 인용하며 같은 실행·쓰기 거절 증거를 요구한다.
- Windows 전용 진단·설정 옵션은 Linux에서 실행 전에 거부한다. 외부 API와 이벤트 계약 변경은 없다.
- 비밀값·기존 사용자 설정·DB·node_modules는 복사하지 않는다. Gateway는 loopback으로만 점검하며
  Codex 인증과 Tailscale 원격 연결은 별도 단계로 남긴다.
- 테스트: 경로 인용·실제 Linux 쓰기 성공/실패 증거, 전체 자동 테스트·typecheck·build,
  기본 Permission 계약·파일 enforcement·Gateway HTTP/WebSocket 연동과 health를 확인한다.
- 실패는 그대로 기록하고 검증에 실패한 Permission capability를 활성화하지 않는다. README와
  이 계획에 실행 환경·확인 결과·남은 작업을 기록한다.
- WSL 실검증에서 `/tmp` 절대 경로가 승인 표시 텍스트에 남는 문제를 확인했다. POSIX 절대 경로를
  경계 기준으로 마스킹하고 URL·상대 경로를 보존하는 회귀 테스트를 추가한다. Command fixture는
  sandbox 실패가 자동 승인 요청으로 이어진다고 가정하지 않고 명시적으로 escalation을 요청하되
  모든 명령 승인에 기존 거절·취소 정책을 유지한다.

### 2026-11-16 Windows 검증 보완 계획

- WSL을 사용하지 않고 설치된 `0.169.0` App Server와 기존 Windows sandbox만 검사한다.
- 파일 쓰기 요청만의 검증과 기존 filesystem/network 혼합 계약 검증을 분리한다.
  파일 검증이 성공해도 network enforcement 성공으로 표시하지 않는다.
- 단일 scope 실패로 전체 검사가 중단되지 않도록 deny/turn/session 및 다음 Turn·별도 Session의
  결과를 모으고, 하나라도 실패하면 최종 종료 코드는 실패를 유지한다.
- `windowsSandbox/readiness` 읽기 전용 진단을 추가한다. 관리자 setup·영구 정책 변경·명령 승인 수락은
  수행하지 않는다. Permission capability와 외부 API·승인 상태 전이는 바꾸지 않는다.
- 현재 CLI 연동 검사에서 종료된 Run의 늦은 inference 요청과 다음 검사가 전역 fixture 상태를 공유하는
  경합이 발견됐다. 고유한 테스트 prompt 식별자로 요청별 상태를 분리하고 회귀 테스트를 추가한다.
- sandbox 실행 증거와 쓰기 거절 증거를 검사하는 회귀 테스트, 전체 테스트·typecheck·build,
  실제 App Server 기본 계약 및 Windows enforcement 검증을 수행한다.

- README, API 계약, 승인 workflow, Phase 2 진행 상태에 확인한 매핑과 제한 기록.
- 계약이 확정되면 permission 거절/cancel 의미를 ADR에 기록.

## API change checklist

- 기존 endpoint·decision·event envelope 유지, Permission display는 기존 variant를 채움.
- 기존 클라이언트는 capability로 지원 여부 확인. 입력 검증·마스킹·replay 정책 유지.
- 구현 결과에 따라 문서와 정상·실패·취소 검증 결과 갱신.

## Sources

- https://learn.chatgpt.com/docs/app-server#permission-requests
- 설치된 CLI에서 생성한 PermissionsRequestApprovalParams/Response schema (임시 산출물, 커밋 제외).
- https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/sandboxing/src/windows.rs
- https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/sandboxing/src/manager.rs

## Verified results and remaining work

- 프로토콜 검증 통과 (`0.159.3`): 빈 profile은 network/filesystem null, scope turn으로 반환된다.
- 동일 요청 profile의 승인은 원래 filesystem write 경로를 유지하며 turn/session scope로 반환된다.
- 새 Turn과 다른 Session에서 권한 도구를 명시적으로 재호출하면 새 요청이 발생한다.
  세션 승인이 이후 도구 요청 자체를 없애는 것으로 해석하지 않는다.
- Pending 중 interrupt로 Run이 interrupted가 되는 것을 확인했다. 정리는 Run 종료 경로도 사용해야 한다.
- filesystem 표시 및 Dashboard 표시 자동 테스트를 추가했다. 외부 계약의 필드·endpoint는 유지한다.
- 실제 filesystem enforcement 검증 실패: Permission 승인 후 marker 쓰기에 추가 Command Approval이 요구된다.
  이를 거절하면 실행되지 않아 권한 적용·turn 만료·session 유지 여부를 확정할 수 없다.
- Windows sandbox 설정 변경과 일반 WSL 설치는 수행하지 않았다. Permission capability는 false 유지.
- network enforcement, 실제 모델·스마트폰, restart, Permission cancel 의미 검증은 미완료.
- 전체 테스트 48개, typecheck, build 및 기본 `verify:permissions` 통과.

### 2026-10-21 재검증 및 보완

- 설치된 `codex-cli 0.163.0`으로 기본 `verify:permissions` 재검증 통과. 실제 모델 호출은 하지 않았다.
- `verify:gateway`를 추가해 실제 HTTP/WebSocket·Gateway·adapter·App Server·SQLite 경계를 검증했다.
  명령 취소, 미제공 decline의 400 거부, 파일 변경 거절·취소, 중복 결정 409, 이벤트 replay,
  Pending interrupt, 미지원 Permission 실패, 재시작 후 stale 승인 종료를 확인했다.
- fixture 모델 식별자는 현재 런타임이 apply_patch 도구를 제공하는 `gpt-6.1-sol`을 사용한다.
  모델 응답은 loopback 서버가 생성하며 외부 모델 호출은 하지 않는다.
- enforcement의 잘못된 성공 판정을 수정했다. marker 미생성만으로 거절 성공이라 판단하지 않고,
  실제 명령의 시작·종료 출력을 요구한다. 별도 명령 승인 차단은 `command-approval-required`로 실패한다.
- 명령 차단·미지원 sandbox 경계·프로세스 실패·불완전 출력·쓰기 결과 불일치에 대한 회귀 테스트 5개를 추가했다.
  외부 example 사이트 네트워크 probe는 제거했고 network enforcement는 명시적으로 미검증이다.
- OS 설정 변경 없는 MXC 읽기 전용 실행 검사도 수행했으나 native MXC unavailable로 실패했다.
  WSL에는 docker-desktop만 조회되었다. sandbox 설치·정책 변경·일반 WSL 설치는 수행하지 않았다.
- Permission capability는 계속 false다. 실제 명령 수락/세션 수락, Permission enforcement·cancel 의미,
  실제 모델·Tailscale 스마트폰 검증은 남아 있다.
- 추가로 설정 저장 없이 `--enforcement --windows-sandbox=unelevated`를 실행했다. 무권한 쓰기 거절은
  명령 시작·종료 증거와 함께 확인했으나, turn 권한 승인 뒤 실행은 Windows restricted-token sandbox의
  split writable root sets 미지원으로 차단되었다 (`sandbox-layout-unsupported`).
- 최종 검증: 전체 자동 테스트 53개, 검증 스크립트를 포함한 typecheck, build, 기본 `verify:permissions`,
  `verify:gateway` 통과. Gateway 재시작 후 새 App Server 연결의 승인·취소도 확인했다.
  `verify:permissions -- --enforcement`는 `command-approval-required`로 실패하며 미검증 상태다.

### 2026-11-16 Windows 재검증 결과

- 사용자 요청에 따라 WSL을 사용하지 않았다. 설치된 `codex-cli 0.169.0`에서 기본 혼합 Permission 계약,
  빈 profile 거절, turn/session scope 응답, Pending interrupt 및 resolved notification을 재확인했다.
- `--windows-readiness` 읽기 전용 진단을 추가했다. 독립 임시 CODEX_HOME에서 응답은 `notConfigured`였다.
  setup·OS 정책 변경은 수행하지 않았다.
- `--permissions=filesystem`으로 network 권한을 요청하지 않는 파일 전용 검증을 추가했다.
  enforcement는 deny/turn/session × 첫 Turn/다음 Turn/별도 Session의 9개 결과를 수집한다.
  일부 실패 뒤에도 나머지 검사를 수행하며 전체 검증 실패 종료 코드를 유지한다.
- unelevated 파일 전용 검사: 무권한 쓰기 차단 6개는 명령 시작·종료, 쓰기 오류 출력 및 marker 미생성으로
  확인했다. turn 승인 첫 실행과 session 승인 첫 실행·다음 Turn의 3개는 `sandbox-layout-unsupported`다.
  승인된 쓰기가 실제로 성공하지 않았으므로 turn 만료·session 유지·격리 전체 검증은 미완료다.
- MXC 파일 전용 검사: 9개 모두 `sandbox-unavailable`이며 실제 명령은 실행되지 않았다.
  파일 미생성을 권한 거절 성공으로 집계하지 않는다. network enforcement도 미검증이다.
- 거절 판정에 쓰기 오류 출력 증거를 추가하고 MXC 미지원 원인을 안전한 code로 구분했다.
  Provider 원문·Token·절대 경로를 새 진단 출력에 포함하지 않는다.
- `verify:gateway` 재실행에서 종료된 Run의 늦은 inference 요청이 다음 검사 전역 상태에 섞이는
  fixture 경합을 발견했다. 고유한 사용자 prompt 식별자로 상태를 분리하고 회귀 테스트를 추가했다.
  보완 후 명령 취소·미제공 결정 거부, 파일 거절·취소, 중복 결정, replay, Pending interrupt,
  Permission fail-closed, 재시작 후 stale 승인 거부와 새 연결 처리가 모두 통과했다.
- 최종 자동 검증: 테스트 58개, typecheck, build, 기본 `verify:permissions`, `verify:gateway` 통과.
  Windows enforcement는 위 원인으로 실패이며 Permission capability는 false 유지.
- 다음 Windows 작업: sandbox 초기 설정 또는 실행 가능한 backend 확보 후 승인된 파일 쓰기를 먼저
  재검증한다. 그 다음 turn 만료·session 유지·격리와 network enforcement·Permission cancel 의미를
  확인한다. PC의 계정·ACL·네트워크 정책을 변경하는 초기 설정은 별도 승인 없이 수행하지 않는다.

### 2026-11-17 WSL2 구성 및 검증 결과

- 사용자 요청으로 Ubuntu 24.04 WSL2를 설치하고 기본 배포판으로 지정했다. Docker 배포판은 유지했다.
- 일반 사용자 `dev`에 Node.js `22.23.5` (공식 배포 SHA256 확인), npm `10.9.9`, Codex `0.169.0`,
  Git `2.43.0`, Python·빌드 도구·bubblewrap을 구성했다. Codex와 Node 모두 Linux 실행 파일이다.
- 저장소의 최신 커밋을 Linux 파일시스템에 별도로 복제하고 이 변경을 반영했다. 비밀값·Windows
  Codex 설정/인증·DB·node_modules·기존 미추적 파일은 복사하지 않았다. 작업 사본은 자동 동기화하지 않는다.
- 로컬 `gateway-dev` launcher와 저장소 밖의 권한 `600` 환경 파일, 무작위 Client Token을 생성했다.
  loopback 기동 후 인증 health 200·미인증 401을 확인하고 서버를 종료했다. 자동 시작·원격 연결은 미구성이다.
- OS별 PowerShell/Bash fixture를 사용한다. Linux에서 sandbox 실패만으로 Command 승인이 발생한다는
  가정을 제거하고 명시적 escalation 요청을 거절·취소했다. 승인 미발생 오류도 안전한 진단으로 표시한다.
- Gateway 연동 검사가 `/tmp` 경로 표시 노출을 발견했다. POSIX 절대 경로 마스킹을 보완하고
  URL·상대 경로 보존 및 shell 메타문자가 든 경로 인용 회귀 테스트를 추가했다.
- Linux 자동 테스트 61개, typecheck·build, 기본 혼합 Permission 계약·Pending interrupt,
  파일 전용 enforcement 9개가 통과했다. 승인 쓰기 3개와 무권한 차단 6개를 실제 실행 증거로 확인했다.
- Gateway 명령 취소·미제공 decline 400 거부, 파일 거절/취소, 중복 결정, 이벤트 replay,
  Pending interrupt, 미지원 Permission 실패와 재시작 복구가 통과했다. Command decline 자체는
  runtime이 제공하지 않아 미검증이며 대신 cancel했다. 명령 수락은 수행하지 않았다.
- 남은 작업: WSL Codex 로그인 및 실제 모델 사용, Tailscale 모바일 연결, network enforcement,
  Permission cancel 의미와 capability 활성화 판단. Windows 네이티브 sandbox 제약은 해결한 것으로 표시하지 않는다.
- Windows 회귀 검증도 테스트 60개 통과·Linux 전용 1개 생략, typecheck·build·Gateway 연동 통과다.
  Gateway 검사는 호스트 sandbox의 사용자 정보 조회 실패 뒤 sandbox 밖에서 재실행했다.
