# Phase 2 Plan: Remote Approval

## Goal

Tailscale로 연결된 인증된 모바일 클라이언트가 Codex Run 중 발생한 Command, File Change,
Permission Approval을 안전하게 확인하고, Provider가 허용한 결정 중 하나를 정확히 한 번 전달할 수 있게 한다.

구현할 수직 슬라이스는 다음과 같다.

```text
Codex server request
  -> Gateway Approval 저장
  -> approval.requested 전송
  -> 모바일 결정
  -> 소속·상태·허용 결정 검증
  -> Codex JSON-RPC response
  -> approval.resolved 전송
```

## Scope and non-goals

### 포함 범위

- `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`의 Provider adapter 처리
- Gateway가 발급한 Approval ID와 Provider 원본 request ID, Thread, Turn, Item 관계의 내부 매핑
- Pending Approval 영속화, 조회, 모바일 재연결 후 복구
- Provider가 제공한 `availableDecisions`와 Gateway가 안전하게 지원하는 결정의 교집합만 노출
- 승인 종류별 안전한 정보 표시와 민감정보 마스킹
- 단일 결정 원자 처리, 중복·지연·교차 Session 결정 거부
- `serverRequest/resolved` 및 Provider/Run 종료에 따른 Approval 종료
- 테스트 대시보드의 Pending Approval 목록과 결정 UI

### 제외 범위

- 자동 승인, 규칙 기반 무인 승인, 범용 JSON-RPC 전달
- 임의의 filesystem/network 권한 확대 또는 요청 내용을 수정한 권한 부여
- Execpolicy·network policy amendment 같은 Provider별 영구 정책 편집
- Push notification, 다중 사용자 역할·권한, 승인 위임
- Git/Build/Test 제어(Phase 3)

## Affected boundaries

- **Mobile API:** Approval 조회·결정 REST endpoint와 `approval.requested`,
  `approval.resolved` 이벤트를 추가한다. Provider 원본 ID와 원본 JSON-RPC payload는 노출하지 않는다.
- **Gateway:** Approval 도메인 모델, SQLite 영속화, 상태 전이, 소속 검증, 원자적 결정 claim,
  재연결 동기화를 담당한다.
- **Codex App Server:** stdio JSON-RPC server request를 응답 전까지 보관하고, 승인 종류별 response로
  변환한다. 지원하지 않는 메서드와 결정은 명시적으로 거절한다.
- **Workspace:** 명령·경로·권한 범위는 표시용으로만 읽고, Gateway가 직접 실행하거나 요청 범위를
  넓히지 않는다. 경로는 등록 Project와의 관계를 판정하고 외부 표시 정책을 적용한다.

## Protocol baseline

계획 작성 시 `codex-cli 0.153.4`의 `app-server generate-json-schema --experimental` 결과에서 다음 계약을
확인했다. 생성 schema는 임시 검증 산출물이며 저장소에 커밋하지 않는다.

- Command: `item/commandExecution/requestApproval`
- File Change: `item/fileChange/requestApproval`
- Permission: `item/permissions/requestApproval`
- Provider-side resolution: `serverRequest/resolved`
- Command/File 기본 결정: `accept`, `acceptForSession`, `decline`, `cancel`
- Permission 응답: 요청된 permission profile과 `turn` 또는 `session` scope

구현 시 지원 Codex 버전을 다시 확인하고 생성 schema를 fixture/type 검증의 기준으로 삼는다.
Permission 거절의 정확한 JSON-RPC 오류 의미와 Provider 재시작 후 승인 재발행 동작은 실제 App Server
conformance test로 확정하기 전까지 capability를 `false`로 유지한다.

## Domain model

Gateway의 Provider 중립 Approval은 최소한 다음 정보를 가진다.

```text
Approval
  id: apr_...                     # 외부에 노출하는 Gateway ID
  type: Command | FileChange | Permission
  status: Pending | Accepted | Declined | Cancelled | Resolved
  projectId, sessionId, runId, itemId
  availableDecisions[]            # Gateway가 검증·정규화한 결정만
  display                         # 종류별 안전한 표시 데이터
  requestedAt, decidedAt?, resolvedAt?
  resolutionReason?

ProviderApprovalBinding           # adapter/저장소 내부 전용
  providerRequestId
  providerSessionId
  providerRunId
  providerItemId
  providerApprovalId?
  connectionGeneration
```

- `apr_` ID만 모바일 API와 이벤트에 사용한다.
- Command 표시 데이터는 action kind, 마스킹된 command, Project 기준 cwd, reason을 포함한다.
- File Change 표시 데이터는 item 식별 정보, reason, 요청된 grant root의 안전한 표현만 포함한다.
- Permission 표시 데이터는 요청된 filesystem entry와 network enabled 여부를 정규화해 포함한다.
- 원본 request ID와 전체 Provider payload는 외부 응답·이벤트·로그에 포함하지 않는다.

## Mobile API contract

### REST

```text
GET  /approvals?sessionId={optional}&status=Pending
GET  /approvals/{approvalId}
POST /approvals/{approvalId}/decision
```

결정 요청의 Provider 중립 형태:

```json
{ "decision": "accept" }
```

초기 안정 계약의 decision은 `accept`, `acceptForSession`, `decline`, `cancel`만 허용한다.
Permission은 외부 decision을 다음과 같이 adapter가 정확히 매핑할 수 있을 때만 capability로 노출한다.

- `accept` -> 요청된 범위를 그대로 `turn` scope로 부여
- `acceptForSession` -> 요청된 범위를 그대로 `session` scope로 부여
- `decline` / `cancel` -> conformance test로 확인한 거절 응답 또는 안전한 JSON-RPC 오류

클라이언트는 반드시 Approval 응답의 `availableDecisions`에 포함된 값만 보여주고 전송한다.
결정 성공 응답은 최신 Approval을 반환한다. 중복 결정, 종료된 Approval, Session/Run 소속 불일치는 `409`,
형식 또는 허용 목록 밖 결정은 `400`, 없는 리소스는 `404`로 응답한다.

### WebSocket events

```text
approval.requested
approval.resolved
agent.status
```

`approval.requested` payload는 `approvalId`, `type`, `status`, `itemId`, `availableDecisions`, `display`를
포함한다. `approval.resolved`는 `approvalId`, 최종 status, 안전한 resolution reason을 포함한다.
기존 event envelope와 Session별 sequence를 그대로 사용하므로 Phase 1 클라이언트에는 추가 이벤트로서
하위 호환된다.

## State, error, and reconnect behavior

### 상태 전이

```text
Pending -> Accepted -> Resolved
        -> Declined -> Resolved
        -> Cancelled -> Resolved
        -> Resolved                 # Provider가 먼저 해결하거나 Run이 종료된 경우
```

- 결정 endpoint는 SQLite transaction으로 `Pending` 상태를 한 번만 claim한다.
- claim한 결정과 Provider response 전송 결과를 기록해 동시 요청이 두 번 응답하지 못하게 한다.
- Provider response 전송 실패 시 결정을 Pending으로 되돌려 재전송하지 않는다. Provider request handle의
  유효성을 알 수 없으므로 안전하게 `Resolved` 처리하고 재시도가 불가능하다는 오류 이벤트를 발행한다.
- `serverRequest/resolved`, Run 완료·중단·실패, Provider 연결 종료는 관련 Pending Approval을 종료한다.
- Pending Approval 동안 Gateway 상태는 `WaitingApproval`, 결정 전달 후 Run이 계속되면 `Busy`로 돌아간다.

### 모바일 재연결

- Approval과 관련 이벤트를 결정 전에 영속화한다.
- 클라이언트는 재연결 시 기존 `afterSequence` 이벤트 재전송과 `GET /approvals?...status=Pending`을 함께
  사용해 놓친 요청을 복구한다.
- 동일 Approval 이벤트를 다시 받아도 `approvalId`로 중복 UI를 만들지 않는다.

### Gateway/Provider 재시작

- Provider request ID는 연결에 종속되므로 이전 연결의 ID로 결정을 재전송하지 않는다.
- Gateway 재시작 후 저장된 Pending Approval은 `AwaitingProviderRecovery` 내부 복구 상태로 취급한다.
- `thread/resume` 뒤 Provider가 동일 Thread/Turn/Item/approval ID의 요청을 다시 발행한 경우에만 새
  request ID를 바인딩하고 Pending으로 복구한다.
- Provider가 요청을 재발행하지 않거나 Run 복구를 지원하지 않으면 Approval을 안전하게 `Resolved` 처리하고
  `PROVIDER_APPROVAL_UNAVAILABLE`을 전달한다. 자동 승인이나 오래된 결정 재생은 하지 않는다.

## Security and approval considerations

- 모든 Approval endpoint와 WebSocket은 기존 Client Token 인증을 사용한다.
- `approvalId` 형식뿐 아니라 Project, Session, Run, Item, Provider binding 전체 관계를 검증한다.
- `availableDecisions`가 있으면 그 목록과 Gateway 지원 목록의 교집합만 허용한다. 목록이 없으면 승인 종류별
  보수적 기본값만 사용하며 capability와 제한 사항을 표시한다.
- `acceptForSession`은 현재 Session 범위만 허용하며 다른 Session이나 Project로 확장하지 않는다.
- Permission accept는 요청된 permission profile을 그대로 echo하며 filesystem/network 범위를 추가·확대하지 않는다.
- command, cwd, reason, path는 길이 제한·제어문자 제거·Project 기준 경로 표시·민감 인자 마스킹을 거친다.
- 로그에는 Gateway 상관관계 ID와 상태만 남기고 Token, 원본 request ID, 전체 command, 개인 절대 경로,
  authorization header를 기록하지 않는다.
- 알 수 없는 승인 종류, 알 수 없는 결정, 복합 policy amendment는 거절하며 자동으로 단순 accept로 축소하지 않는다.

## Implementation milestones

현재 진행 상태:

- [x] `codex-cli 0.153.4` 생성 schema를 다시 확인하고 Command, File Change, Permission request/response와
  `serverRequest/resolved` 계약 fixture를 추가했다.
- [x] JSON-RPC 성공·오류 response와 App Server 연결 세대 검증, 정확한 승인 method 분기를 구현했다.
- [x] `turn/start` 응답과 같은 stream chunk에 포함된 승인 요청을 Run ID 매핑 후 처리하도록 이벤트 순서를
  보정하고 통합 회귀 테스트를 추가했다.
- [x] Command/File Change의 기본 결정을 adapter에서 검증하고 복합 policy amendment를 제외했다.
- [ ] 외부 승인 capability 활성화는 저장소·결정 API·수직 슬라이스가 함께 동작하는 시점으로 미룬다.
  부분 구현을 모바일에 사용 가능한 기능처럼 광고하지 않기 위한 조정이다.

1. **Codex 계약 fixture와 adapter 경계**
   - 지원 버전 schema에서 세 승인 request/response와 resolved notification fixture를 만든다.
   - JSON-RPC server request의 성공 response, 오류 response, connection generation을 구현한다.
   - Command/File부터 capability를 켜고 Permission은 conformance test 통과 후 켠다.
2. **Approval 저장소와 상태 머신**
   - Approval 및 내부 Provider binding table과 migration을 추가한다.
   - 중복 request upsert, 원자적 decision claim, 관련 Run 종료 시 일괄 resolve를 구현한다.
3. **Gateway API와 이벤트**
   - 조회·결정 endpoint, 입력/소속/결정 검증, `approval.requested/resolved` 이벤트를 추가한다.
   - 기존 이벤트 replay와 Pending 목록 복구를 연결한다.
4. **Command/File Change 수직 슬라이스**
   - 안전한 표시 데이터와 네 가지 기본 결정을 실제 App Server에 매핑한다.
   - accept, acceptForSession, decline, cancel 및 Provider 선해결을 검증한다.
5. **Permission 수직 슬라이스**
   - 요청 permission을 정규화하고 동일 범위만 turn/session scope로 응답한다.
   - 거절·취소와 재시작 복구 동작을 실제 App Server에서 확인한 뒤 capability를 활성화한다.
6. **모바일 테스트 대시보드와 실기기 검증**
   - Pending 카드, 안전한 상세, 허용된 결정 버튼, 중복 클릭 방지를 추가한다.
   - Tailscale 스마트폰에서 요청·수락·거절·취소·재연결을 검증한다.

## Test plan

### Unit

- 승인 종류별 schema 검증과 안전한 표시 데이터 변환
- Gateway/Provider ID 매핑 및 잘못된 Session/Run/Item 관계 거부
- `availableDecisions` 교집합, 미지원 복합 결정 거부
- Pending 상태의 단일 claim과 동시 결정 중 하나만 성공
- 종료·이미 결정·알 수 없는 Approval의 재사용 거부
- command/path/reason 길이 제한, 제어문자 제거, 민감정보 마스킹
- Permission 요청 범위보다 넓은 response를 만들 수 없음

### Integration

- 가짜 App Server의 Command/File/Permission server request를 영속화하고 JSON-RPC response를 한 번만 전달
- accept, acceptForSession, decline, cancel과 `serverRequest/resolved` 상태 전이
- 결정 전 모바일 WebSocket 단절 후 이벤트 replay와 Pending 조회
- Provider 선해결, Run 완료·interrupt·실패, App Server 종료 시 Pending 정리
- Gateway 재시작 후 이전 provider request ID를 사용하지 않고 재발행된 요청만 재바인딩
- HTTP 인증 실패, 잘못된 소속, 중복 결정, 미지원 결정의 안전한 오류 응답

### Manual / real-runtime

- Command와 File Change 각각에서 수락·거절·취소가 실제 Codex Run에 반영되는지 확인한다.
- `acceptForSession`이 해당 Session을 넘어서 적용되지 않는지 확인한다.
- Permission의 turn/session scope와 거절 동작을 지원 Codex 버전에서 검증한다.
- 스마트폰 연결 단절 중 Pending 요청을 만든 뒤 재연결하여 중복 없이 복구되는지 확인한다.
- 실제 command, 개인 경로, Token, Provider request ID가 로그나 외부 오류에 노출되지 않는지 확인한다.

## Documentation updates

- 구현과 같은 변경에서 README의 Phase 2 REST/WebSocket 계약, capability, 운영 제한을 갱신한다.
- `.agents/api-contracts.md`에 Approval endpoint, event payload, 오류·재연결 의미를 추가한다.
- `.agents/workflows/approvals.md`에 실제 상태 전이와 Provider 재시작 복구 제한을 반영한다.
- 되돌리기 어려운 Provider request 복구 또는 Permission 매핑 결정이 생기면 ADR을 추가한다.

## API change checklist

- [x] 추가할 REST endpoint와 WebSocket 이벤트 계약을 계획에 정의했다.
- [x] 새 이벤트·endpoint 추가 방식이며 기존 Phase 1 클라이언트와 하위 호환됨을 확인했다.
- [x] 인증, 입력 검증, Approval/Session/Run/Item 소속 검증을 계획했다.
- [x] 이벤트 순서, 중복 UI 방지, 모바일 및 Provider 재연결 동작을 정의했다.
- [x] 외부 오류와 로그에서 command, 경로, Provider ID, Token을 보호하도록 정의했다.
- [ ] 구현 시 README와 `.agents/` 계약 문서를 갱신한다.
- [ ] 구현 시 정상·실패·거절·취소·중복·재연결 테스트를 통과시킨다.
