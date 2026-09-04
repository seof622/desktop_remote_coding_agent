# Git, Build, and Test Workflow

## Git

- Git 상태와 diff는 Gateway가 직접 제공하며 Codex 메시지 파싱 결과에 의존하지 않는다.
- branch, staged/unstaged 변경, added/modified/deleted, ahead/behind를 명확히 구분한다.
- diff 조회는 읽기 전용이어야 하며 repository 상태를 바꾸지 않는다.

## Build and Test

- 프로젝트별로 등록된 build/test 명령만 실행하며 cwd가 등록 Workspace인지 검증한다.
- stdout/stderr는 구조화해 스트리밍하고 exit code, 실행 시간, 취소 결과를 제공한다.
- 실행 중 취소 요청을 처리하고, 종료된 프로세스의 출력을 새 작업에 연결하지 않는다.
- 명령·출력에 비밀값이 포함될 수 있는지 고려해 로그와 모바일 표시를 마스킹한다.
