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

## 공통 규칙

- 모바일 클라이언트에 Codex App Server JSON-RPC를 직접 노출하지 않는다.
- 보안·승인·이벤트 계약 변경은 README와 관련 `.agents/` 문서를 같은 변경에서 갱신한다.
- Token, 비밀값, 실제 내부 IP/호스트명, 사용자별 절대 경로를 커밋하지 않는다.
- 새 기능은 입력 검증, 오류 응답, 로그의 민감정보 마스킹, 테스트를 함께 고려한다.
- 되돌리기 어려운 아키텍처 결정은 `.agents/decisions/`에 ADR로 기록한다.
