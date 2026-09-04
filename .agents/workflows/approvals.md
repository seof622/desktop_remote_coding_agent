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

## 금지 사항

- Gateway가 자동으로 승인을 수락하지 않는다.
- 클라이언트가 서버가 제공하지 않은 결정을 보내도록 허용하지 않는다.
- 승인 정보를 다른 Thread 또는 Turn에 재사용하지 않는다.
