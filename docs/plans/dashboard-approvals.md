# Dashboard Approval UI Plan

## Goal

기존 승인 API를 모바일 테스트 대시보드에 연결해 Command/File Change 요청을 확인하고 결정한다.

## Scope and non-goals

- Pending 카드, 안전한 상세, `availableDecisions`에 포함된 버튼, 중복 클릭 방지.
- 선택 Session 또는 전체 Session의 대기 목록 조회, 재연결 및 이벤트 후 상태 재조회.
- Permission 활성화와 실제 Codex·스마트폰 검증은 후속 작업이다.

## Affected boundaries

- Mobile API: 기존 `/approvals` 조회·결정 및 승인 이벤트 사용. 외부 계약 변경 없음.
- Gateway: 정적 대시보드 코드만 변경.
- Codex App Server: 기존 adapter를 통한 결정 전달.
- Workspace: 서버가 마스킹한 표시 데이터만 출력.

## State, error, and reconnect behavior

- 승인 이벤트는 최신 Pending 목록 재조회의 신호로 사용해 과거 replay가 종료된 요청을 되살리지 않는다.
- 조회 세대와 Token/Session 문맥을 검증해 늦은 응답을 무시한다.
- 결정 전 모든 해당 카드 버튼을 잠그고, 성공·실패 후 목록을 재조회한다. 자동 재전송하지 않는다.
- 상태 재조회 실패 시 결정을 잠그고 새로고침으로 복구한다.
- Token 제거 시 승인 카드와 이벤트를 지우고 이전 socket callback을 무시한다.

## Security and approval considerations

- 서버의 `display`만 `textContent`로 표시한다. 원본 Provider ID를 사용하지 않는다.
- 알려진 결정과 서버 허용 목록의 교집합만 버튼으로 만든다.
- Token은 메모리에만 유지하고 승인 결정은 사용자 클릭으로만 수행한다.

## Test plan

- 실제 대시보드 script를 DOM/socket/fetch harness에서 실행한다.
- 안전한 표시, 제한된 결정, 중복 클릭, 실패 복구, 종료 이벤트와 과거 replay를 검증한다.
- Session 전환·Token 제거 후 늦은 응답 및 socket callback이 UI를 복구하지 못하는지 검증한다.
- 전체 테스트, typecheck, build 실행. 실기기 검증은 미수행으로 기록한다.

## Documentation updates

README, 모바일 대시보드 계획, Phase 2 진행 상태 및 승인 workflow에 UI 동작과 검증 제한을 반영한다.
