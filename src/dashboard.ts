export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gateway Mobile Test Dashboard</title>
  <style>
    :root { color-scheme: dark; --bg:#07111f; --card:#0e2035; --line:#244564; --text:#e9f3ff; --muted:#9bb2cb; --blue:#4aa3ff; --green:#3ddc97; --red:#ff6b7a; }
    * { box-sizing:border-box; } body { margin:0; background:linear-gradient(145deg,#06101f,#0b1d32); color:var(--text); font:16px system-ui,-apple-system,"Segoe UI",sans-serif; }
    main { max-width:840px; margin:auto; padding:20px 14px 48px; } h1 { margin:0 0 6px; font-size:24px; } h2 { font-size:17px; margin:0 0 12px; } p,small { color:var(--muted); } .card { background:rgba(14,32,53,.94); border:1px solid var(--line); border-radius:14px; padding:16px; margin:14px 0; box-shadow:0 12px 30px rgba(0,0,0,.18); }
    .row { display:flex; gap:9px; align-items:center; flex-wrap:wrap; } .row > * { flex:1 1 160px; } input,textarea,select,button { border-radius:9px; border:1px solid #396183; background:#09192a; color:var(--text); font:inherit; padding:10px; width:100%; } textarea { min-height:100px; resize:vertical; } button { cursor:pointer; background:#1669c3; border-color:#398fe9; font-weight:650; } button.secondary { background:#16324e; } button.danger { background:#8c2435; border-color:#c94659; } button:disabled { opacity:.5; cursor:not-allowed; }
    #status { font-size:14px; color:var(--muted); } #status.ok { color:var(--green); } #status.error { color:var(--red); } .list { display:grid; gap:8px; } .item { border:1px solid #294967; background:#09192a; padding:10px; border-radius:9px; text-align:left; } .item.selected { outline:2px solid var(--blue); } .item strong,.item small { display:block; overflow-wrap:anywhere; } #events { min-height:170px; max-height:460px; overflow:auto; background:#050c15; border-radius:9px; padding:10px; display:grid; gap:10px; align-content:start; }
    .event-line { color:var(--muted); border-bottom:1px solid #142436; padding:2px 3px 8px; overflow-wrap:anywhere; font:12px ui-monospace,SFMono-Regular,Consolas,monospace; } .answer { border:1px solid #28567d; border-left:4px solid var(--blue); background:#0a1b2d; border-radius:10px; padding:12px; } .answer-head { display:flex; justify-content:space-between; gap:12px; color:#8fc8ff; font-size:13px; margin-bottom:8px; } .answer-status { color:var(--green); white-space:nowrap; } .answer-text { margin:0; color:var(--text); white-space:pre-wrap; overflow-wrap:anywhere; font:15px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif; }
    .hint { font-size:13px; margin:8px 0 0; } .hidden { display:none; }
    .approval { border:1px solid #396183; border-radius:10px; padding:12px; background:#09192a; } .approval h3 { font-size:16px; margin:0 0 8px; } .approval pre { white-space:pre-wrap; overflow-wrap:anywhere; font:14px/1.5 system-ui,sans-serif; } .approval small { display:block; overflow-wrap:anywhere; } #approval-status { font-size:14px; }
  </style>
</head>
<body>
<main>
  <h1>Gateway 테스트 대시보드</h1>
  <p>Token은 이 페이지 메모리에만 보관됩니다. 새로고침하면 사라집니다.</p>

  <section class="card">
    <h2>1. 연결</h2>
    <div class="row"><input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="Gateway Client Token"><button id="connect">연결</button></div>
    <div class="row"><button id="refresh" class="secondary" disabled>목록 새로고침</button><button id="clear-token" class="secondary" disabled>Token 지우기</button></div>
    <p id="status" role="status">연결 전</p>
  </section>

  <section class="card">
    <h2>2. 프로젝트 등록</h2>
    <div class="row"><input id="project-name" placeholder="프로젝트 이름"><input id="workspace-path" autocomplete="off" placeholder="PC의 절대 Workspace 경로"></div>
    <button id="add-project" disabled>프로젝트 등록</button>
    <p class="hint">등록된 허용 Workspace 경로만 사용할 수 있습니다.</p>
    <div id="projects" class="list"></div>
  </section>

  <section class="card">
    <h2>3. Session</h2>
    <button id="start-session" disabled>선택 프로젝트에서 Codex Session 시작</button>
    <div id="sessions" class="list"></div>
  </section>

  <section class="card">
    <h2>4. 작업 실행</h2>
    <textarea id="prompt" placeholder="Codex에게 요청할 작업을 입력하세요"></textarea>
    <div class="row"><button id="start-run" disabled>작업 시작</button><button id="interrupt" class="danger" disabled>실행 중단</button></div>
  </section>

  <section class="card">
    <h2>5. 승인 대기</h2>
    <p class="hint">선택한 Session의 요청을 표시합니다. Session 선택 전에는 전체 요청을 표시합니다. 세션 승인은 해당 Session에 적용됩니다.</p>
    <p id="approval-status" role="status">연결 후 승인 목록을 조회합니다.</p>
    <div id="approvals" class="list" aria-live="polite"></div>
  </section>

  <section class="card">
    <h2>답변 및 실시간 이벤트</h2>
    <div id="events" aria-live="polite">대기 중…</div>
  </section>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { token: "", projectId: "", sessionId: "", sequence: 0, socket: null, answers: new Map(), approvals: new Map(), deciding: new Set(), approvalReady: false, approvalQuery: 0, context: 0 };
  const status = (message, kind = "") => { const target = $("status"); target.textContent = message; target.className = kind; };
  const eventRoot = () => { const root = $("events"); if (root.dataset.active !== "true") { root.replaceChildren(); root.dataset.active = "true"; } return root; };
  const resetEvents = () => { state.answers.clear(); const root = $("events"); root.replaceChildren(); root.dataset.active = "false"; root.textContent = "선택한 Session의 이벤트 대기 중…"; };
  const log = (type, payload) => { const line = document.createElement("div"); line.className = "event-line"; line.textContent = new Date().toLocaleTimeString() + "  " + type + "  " + JSON.stringify(payload); eventRoot().prepend(line); };
  const appendAnswerDelta = (event) => {
    const runId = event.runId || "unknown-run";
    let answer = state.answers.get(runId);
    if (!answer) {
      const card = document.createElement("article"); card.className = "answer";
      const head = document.createElement("div"); head.className = "answer-head";
      const title = document.createElement("strong"); title.textContent = "Codex 답변";
      const answerStatus = document.createElement("span"); answerStatus.className = "answer-status"; answerStatus.textContent = "작성 중";
      const text = document.createElement("pre"); text.className = "answer-text";
      head.append(title, answerStatus); card.append(head, text); eventRoot().prepend(card);
      answer = { card, status: answerStatus, text }; state.answers.set(runId, answer);
    }
    answer.text.textContent += event.payload.delta;
  };
  const renderEvent = (event) => {
    if (event.type === "approval.requested" || event.type === "approval.resolved") syncApprovals();
    if (event.type === "agent.message.delta" && typeof event.payload?.delta === "string") { appendAnswerDelta(event); return; }
    if (event.type === "run.completed" && event.runId) {
      const answer = state.answers.get(event.runId);
      if (answer) answer.status.textContent = event.payload?.status || "완료";
    }
    log(event.type || "event", event.payload || {});
  };
  const setEnabled = (connected) => { ["refresh","clear-token","add-project"].forEach((id) => $(id).disabled = !connected); $("start-session").disabled = !connected || !state.projectId; $("start-run").disabled = !connected || !state.sessionId; $("interrupt").disabled = !connected || !state.sessionId; };
  const headers = () => ({ "Authorization": "Bearer " + state.token, "Content-Type": "application/json" });
  const api = async (path, options = {}) => { const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error((body.error && body.error.message) || "요청에 실패했습니다."); return body; };
  const decisions = { accept: "이번 요청 승인", acceptForSession: "이 Session에서 승인", decline: "거절", cancel: "취소" };
  const renderApprovals = () => {
    const root = $("approvals"); root.replaceChildren();
    for (const approval of state.approvals.values()) {
      const card = document.createElement("article"); card.className = "approval";
      const title = document.createElement("h3"); title.textContent = ({ command: "명령 승인", fileChange: "파일 변경 승인", permission: "권한 승인" })[approval.type] || "승인 요청";
      const detail = document.createElement("small"); detail.textContent = "Session: " + approval.sessionId + " · Run: " + approval.runId;
      const display = approval.display || {}; const lines = [];
      for (const [key, label] of [["command", "명령"], ["cwd", "작업 위치"], ["grantRoot", "변경 허용 위치"], ["reason", "사유"]]) {
        if (typeof display[key] === "string") lines.push(label + ": " + display[key]);
      }
      const text = document.createElement("pre"); text.textContent = lines.join("\n") || "추가 표시 정보 없음";
      const buttons = document.createElement("div"); buttons.className = "row";
      for (const decision of new Set(approval.availableDecisions || [])) {
        if (!Object.hasOwn(decisions, decision)) continue;
        const button = document.createElement("button"); button.textContent = decisions[decision];
        if (decision === "decline" || decision === "cancel") button.className = "secondary";
        button.disabled = !state.token || !state.approvalReady || state.deciding.has(approval.id);
        button.onclick = () => decideApproval(approval.id, decision); buttons.append(button);
      }
      card.append(title, detail, text, buttons); root.append(card);
    }
  };
  const resetApprovals = () => { state.approvalQuery++; state.approvalReady = false; state.approvals.clear(); state.deciding.clear(); renderApprovals(); $("approval-status").textContent = "승인 목록 조회 대기 중…"; };
  const syncApprovals = async () => {
    if (!state.token) return;
    const context = state.context, sessionId = state.sessionId, query = ++state.approvalQuery;
    const current = () => context === state.context && sessionId === state.sessionId && query === state.approvalQuery && !!state.token;
    state.approvalReady = false; renderApprovals();
    try {
      const params = new URLSearchParams({ status: "Pending" }); if (sessionId) params.set("sessionId", sessionId);
      const approvals = await api("/approvals?" + params.toString());
      if (!current()) return;
      state.approvals = new Map(approvals.filter((item) => item.status === "Pending" && (!sessionId || item.sessionId === sessionId)).map((item) => [item.id, item]));
      state.approvalReady = true; renderApprovals();
      $("approval-status").textContent = state.approvals.size ? "승인 대기 " + state.approvals.size + "건" : "대기 중인 승인 요청이 없습니다.";
    } catch { if (current()) { renderApprovals(); $("approval-status").textContent = "승인 상태를 확인하지 못했습니다. 목록 새로고침으로 복구하세요."; } }
  };
  const decideApproval = async (id, decision) => {
    const approval = state.approvals.get(id);
    if (!state.token || !state.approvalReady || state.deciding.has(id) || !approval?.availableDecisions.includes(decision)) return;
    const context = state.context, sessionId = state.sessionId;
    state.deciding.add(id); state.approvalQuery++; renderApprovals();
    $("approval-status").textContent = "결정을 전달하는 중…";
    let failed = false;
    try { await api("/approvals/" + encodeURIComponent(id) + "/decision", { method: "POST", body: JSON.stringify({ decision }) }); }
    catch { failed = true; }
    if (context !== state.context || sessionId !== state.sessionId) return;
    state.deciding.delete(id);
    await syncApprovals();
    if (context !== state.context || sessionId !== state.sessionId) return;
    if (failed) $("approval-status").textContent = "결정 전달을 확인하지 못했습니다. 자동 재전송하지 않았습니다. " + $("approval-status").textContent;
  };
  const base64Url = (text) => btoa(unescape(encodeURIComponent(text))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const closeSocket = () => { if (state.socket) { state.socket.close(); state.socket = null; } };
  const connectEvents = () => {
    closeSocket();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const protocol = "gateway-v1." + base64Url(state.token);
    const query = new URLSearchParams();
    if (state.sessionId) query.set("sessionId", state.sessionId);
    if (state.sequence) query.set("afterSequence", String(state.sequence));
    const suffix = query.size ? "?" + query.toString() : "";
    const socket = new WebSocket(scheme + "//" + location.host + "/events" + suffix, [protocol]);
    state.socket = socket;
    socket.onopen = () => { if (state.socket !== socket) return; status("연결됨 · 실시간 이벤트 수신 중", "ok"); syncApprovals(); };
    socket.onmessage = (message) => { if (state.socket !== socket || !state.token) return; const event = JSON.parse(message.data); if (state.sessionId && event.sessionId !== state.sessionId) return; if (state.sessionId && event.sequence) { if (event.sequence <= state.sequence) return; state.sequence = event.sequence; } renderEvent(event); };
    socket.onerror = () => { if (state.socket === socket) status("실시간 연결 오류", "error"); };
    socket.onclose = () => { if (state.socket === socket && state.token) { state.socket = null; state.approvalQuery++; state.approvalReady = false; renderApprovals(); status("실시간 연결이 종료되었습니다. 목록 새로고침으로 다시 연결하세요.", "error"); } };
  };
  const renderProjects = (projects) => { const root = $("projects"); root.replaceChildren(); projects.forEach((project) => { const button = document.createElement("button"); button.className = "item" + (project.id === state.projectId ? " selected" : ""); const title = document.createElement("strong"); title.textContent = project.name; const detail = document.createElement("small"); detail.textContent = project.workspacePath; button.append(title, detail); button.onclick = () => { state.projectId = project.id; renderProjects(projects); setEnabled(true); }; root.append(button); }); };
  const renderSessions = (sessions) => { const root = $("sessions"); root.replaceChildren(); sessions.forEach((session) => { const button = document.createElement("button"); button.className = "item" + (session.id === state.sessionId ? " selected" : ""); const title = document.createElement("strong"); title.textContent = session.status + " · " + session.id; const detail = document.createElement("small"); detail.textContent = "Project: " + session.projectId; button.append(title, detail); button.onclick = () => { const changed = state.sessionId !== session.id; state.sessionId = session.id; state.sequence = changed ? 0 : state.sequence; if (changed) { resetEvents(); resetApprovals(); } setEnabled(true); renderSessions(sessions); connectEvents(); }; root.append(button); }); };
  const refresh = async () => { const context = state.context; const [health, providers, projects, sessions] = await Promise.all([api("/health"), api("/providers"), api("/projects"), api("/sessions")]); if (context !== state.context || !state.token) return; renderProjects(projects); renderSessions(sessions); log("gateway.ready", { status: health.status, providers: providers.map((item) => item.providerId) }); setEnabled(true); await syncApprovals(); };
  $("connect").onclick = async () => { const token = $("token").value.trim(); if (!token) return status("Token을 입력하세요.", "error"); state.context++; closeSocket(); resetApprovals(); state.token = token; const context = state.context; try { await refresh(); if (context === state.context && state.token) connectEvents(); } catch (error) { if (context !== state.context) return; state.token = ""; resetApprovals(); setEnabled(false); status(error.message || "인증에 실패했습니다.", "error"); } };
  $("clear-token").onclick = () => { state.context++; state.token = ""; $("token").value = ""; closeSocket(); resetApprovals(); resetEvents(); state.projectId = ""; state.sessionId = ""; state.sequence = 0; $("projects").replaceChildren(); $("sessions").replaceChildren(); setEnabled(false); status("Token을 지웠습니다."); };
  $("refresh").onclick = async () => { const context = state.context; try { await refresh(); if (context === state.context && state.token) connectEvents(); } catch (error) { if (context === state.context) status(error.message || "새로고침에 실패했습니다.", "error"); } };
  $("add-project").onclick = async () => { try { const project = await api("/projects", { method: "POST", body: JSON.stringify({ name: $("project-name").value.trim(), workspacePath: $("workspace-path").value.trim() }) }); state.projectId = project.id; await refresh(); } catch (error) { status(error.message || "프로젝트 등록에 실패했습니다.", "error"); } };
  $("start-session").onclick = async () => { try { const session = await api("/sessions", { method: "POST", body: JSON.stringify({ providerId: "codex", projectId: state.projectId }) }); state.sessionId = session.id; state.sequence = 0; resetEvents(); resetApprovals(); await refresh(); connectEvents(); } catch (error) { status(error.message || "Session 시작에 실패했습니다.", "error"); } };
  $("start-run").onclick = async () => { try { await api("/sessions/" + state.sessionId + "/runs", { method: "POST", body: JSON.stringify({ text: $("prompt").value.trim() }) }); $("prompt").value = ""; } catch (error) { status(error.message || "작업 시작에 실패했습니다.", "error"); } };
  $("interrupt").onclick = async () => { try { await api("/sessions/" + state.sessionId + "/interrupt", { method: "POST", body: "{}" }); } catch (error) { status(error.message || "작업 중단에 실패했습니다.", "error"); } };
  window.addEventListener("beforeunload", closeSocket); setEnabled(false);
})();
</script>
</body>
</html>`;
