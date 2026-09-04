# Agent Instructions

이 프로젝트는 스마트폰과 로컬 Codex App Server 사이의 **Desktop Gateway Agent**를 만든다.
목표는 원격 터미널 화면 공유가 아니라, 안전하고 안정적인 Gateway API를 제공하는 것이다.

## 시작 전 필독

작업 전 아래 문서를 읽고, 작업 범위에 맞는 문서를 추가로 확인한다.

1. `.agents/architecture.md`
2. `.agents/security.md`
3. `.agents/workflows/implementation.md`
4. `.agents/phases/mvp-phase-1.md` (MVP 범위 작업 시)

API 또는 WebSocket 이벤트를 바꾸면 `.agents/api-contracts.md`를, 승인 흐름을 바꾸면
`.agents/workflows/approvals.md`를, Git/Build/Test 기능을 바꾸면
`.agents/workflows/git-build-test.md`를 반드시 확인한다.

## 템플릿 사용과 갱신

- 새 Provider adapter, 외부 API/이벤트 계약, 상태 전이, 승인·권한 흐름 또는 여러 경계에 걸친 기능은
  구현 전에 `.agents/templates/feature-plan.md`로 계획을 작성한다.
- 외부 REST/WebSocket 계약을 추가·변경·제거하면 구현 또는 PR 설명에
  `.agents/templates/api-change.md`의 체크 항목을 반영한다.
- 오탈자 같은 작은 문서·코드 변경에는 템플릿을 만들 필요가 없다.
- 템플릿은 반복되는 작업에서 누락되는 검토 항목이 확인되었거나, 공통 개발 절차·계약 기준이 바뀌었을 때 갱신한다.
  일회성 기능의 세부 내용은 템플릿이 아니라 해당 기능의 계획 또는 ADR에 기록한다.

## 작업 완료 시각 요약

- 아래 중 하나에 해당하는 작업이 완료되면 최종 응답에 간결한 한국어 요약 인포그래픽을 인라인으로 제공한다.
  - 여러 구성 요소·상태·비동기 흐름·보안 경계를 다루는 실질적인 소스코드 구현 또는 변경
  - 구현 순서, 구성 요소 관계, 상태 전이, API 계약을 새로 정의하거나 크게 바꾸는 Plan 문서 작성·갱신
- 이미지의 목적은 복잡한 작업 내용을 빠르게 파악하게 하는 것이다. 변경 관계가 단순하면 이미지보다 짧은 텍스트 요약을 우선한다.
- 단순 문서 수정, 지침·템플릿 관리, 리네임, 포맷 변경, 작은 설정 변경, 단순 커밋·푸시, 짧은 질의 응답에는 이미지를 생성하지 않는다.
- 이미지 생성 전에는 변경 파일, 검증 결과, 커밋·푸시 상태를 확인한다. 이미지에는 확인된 사실만 담는다.
- 코드 작업에는 동작 흐름·영향받는 구성 요소·검증 결과를, Plan 작업에는 목표·핵심 설계·단계·다음 작업을 포함한다.
- 목적·주요 결정 또는 변경·반영 결과·검증·다음 작업을 포함하되, 해당하지 않는 항목은 생략한다.
- Git 정보는 실제로 수행된 경우에만 commit hash와 push 대상·결과를 표시한다.
- 이미지는 대화용 preview이며, 사용자가 요청하지 않는 한 프로젝트 asset으로 저장하거나 커밋하지 않는다.
- Token, secret, authorization header, 실제 내부 IP·개인 경로·민감 command는 이미지에 포함하지 않는다.
- 이미지 생성 기능을 사용할 수 없으면 같은 정보를 구조화된 텍스트 카드로 제공한다.
- 짧은 질의 응답, 진행 중 업데이트, 사용자 입력을 기다리는 작업에는 완료 이미지를 생성하지 않는다.

요약 구성과 사용 기준은 `.agents/templates/completion-summary.md`를 따른다.

## 공통 규칙

- 모바일 클라이언트에 Codex App Server JSON-RPC를 직접 노출하지 않는다.
- 보안·승인·이벤트 계약 변경은 README와 관련 `.agents/` 문서를 같은 변경에서 갱신한다.
- Token, 비밀값, 실제 내부 IP/호스트명, 사용자별 절대 경로를 커밋하지 않는다.
- 새 기능은 입력 검증, 오류 응답, 로그의 민감정보 마스킹, 테스트를 함께 고려한다.
- 되돌리기 어려운 아키텍처 결정은 `.agents/decisions/`에 ADR로 기록한다.
