# Security Requirements

## 네트워크와 인증

- Desktop Agent는 Tailscale 내부 접근을 기본으로 하며 공용 인터넷에 직접 노출하지 않는다.
- Codex App Server는 모바일 또는 외부 네트워크에 직접 공개하지 않는다.
- 클라이언트 인증 토큰은 저장소·로그·오류 메시지·테스트 fixture에 넣지 않는다.
- 실제 값 대신 환경 변수명과 예시 값만 문서화한다.

## 권한과 승인

- Gateway는 허용된 동작만 중계하며 임의 JSON-RPC 호출을 허용하지 않는다.
- 서버가 제공한 `availableDecisions`가 있으면 그것을 우선한다.
- 요청 범위보다 넓은 filesystem 또는 network 권한을 부여하지 않는다.
- Approval의 request ID와 threadId, turnId, itemId의 연결을 검증한다.
- 이미 해결된 Approval은 재사용하거나 다시 결정할 수 없어야 한다.

## 로그와 오류

- Token, secret, authorization header, 개인 경로, 민감한 command 인자를 로그에 남기지 않는다.
- 보안 검증 실패는 원인을 진단할 수 있게 기록하되, 요청의 민감한 원문은 노출하지 않는다.
