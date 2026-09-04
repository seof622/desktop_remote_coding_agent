# Implementation Workflow

## 작업 순서

1. 요청을 Phase 1, Approval, Development Controls 또는 향후 확장으로 분류한다.
2. 영향을 받는 경계(모바일 API, Gateway, App Server, Workspace)를 확인한다.
3. `.agents/templates/README.md`의 기준에 따라 Feature Plan 또는 API Change Checklist가 필요한지 판단한다.
4. 입력 검증, 상태 전이, 재연결, 취소, 오류 처리를 설계한다.
5. 최소 단위로 구현하고 관련 테스트를 추가하거나 갱신한다.
6. 변경된 계약·보안 원칙·운영 방법을 문서화한다.

## 구현 품질

- 긴 작업과 스트리밍은 취소 가능해야 하며, 종료 후 리소스를 정리한다.
- 외부 프로세스 실패와 App Server 비정상 종료를 정상적인 오류 경로로 처리한다.
- 동시 요청이 같은 Thread, Turn, Approval을 경쟁하지 않도록 상태를 원자적으로 관리한다.
- 로그는 운영 진단에 충분한 상관관계 ID를 포함하되 민감정보는 마스킹한다.

## 완료 기준

- 정상 흐름, 거절/취소 흐름, App Server 오류 또는 연결 단절 흐름을 점검한다.
- 변경 범위에 맞는 테스트·typecheck·build를 실행하고 결과를 남긴다.
- 알려진 제한 사항 또는 후속 작업은 README 또는 적절한 ADR에 기록한다.
