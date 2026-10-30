const TOKEN_KEY = "oneid_helpdesk_token";

const CATEGORY_LABELS = {
  inquiry: "일반 1:1 문의",
  suggestion: "아이디어 및 기능 추천",
  appeal: "계정 정지 소명",
  bug: "오류 / 버그 제보",
  idea: "아이디어 및 기능 추천",
};

const STATUS_LABELS = {
  pending: "답변 대기",
  in_progress: "처리 중",
  resolved: "답변 완료",
  rejected: "반려 / 종결",
};

let token = localStorage.getItem(TOKEN_KEY) || "";
let currentUser = null;
let adminTickets = [];

// DOM Elements
const authArea = document.querySelector("#authArea");
const suspendedBanner = document.querySelector("#suspendedBanner");
const suspendedReasonText = document.querySelector("#suspendedReasonText");
const quickAppealBtn = document.querySelector("#quickAppealBtn");
const globalNotice = document.querySelector("#globalNotice");

const tabs = document.querySelectorAll(".tab");
const panels = {
  write: document.querySelector("#panel-write"),
  my: document.querySelector("#panel-my"),
  admin: document.querySelector("#panel-admin"),
};

const writeModeBadge = document.querySelector("#writeModeBadge");
const guestFields = document.querySelector("#guestFields");
const guestUsername = document.querySelector("#guestUsername");
const guestNickname = document.querySelector("#guestNickname");
const lookupPin = document.querySelector("#lookupPin");
const writeHint = document.querySelector("#writeHint");

const ticketForm = document.querySelector("#ticketForm");
const categorySelect = document.querySelector("#categorySelect");
const serviceSelect = document.querySelector("#serviceSelect");
const ticketTitle = document.querySelector("#ticketTitle");
const ticketContent = document.querySelector("#ticketContent");
const submitTicketBtn = document.querySelector("#submitTicketBtn");

const myUserSection = document.querySelector("#myUserSection");
const myTicketList = document.querySelector("#myTicketList");
const refreshMyBtn = document.querySelector("#refreshMyBtn");

const lookupForm = document.querySelector("#lookupForm");
const lookupUsername = document.querySelector("#lookupUsername");
const lookupPinInput = document.querySelector("#lookupPinInput");
const lookupTicketList = document.querySelector("#lookupTicketList");

const adminBadge = document.querySelector("#adminBadge");
const adminGateCard = document.querySelector("#adminGateCard");
const adminConsole = document.querySelector("#adminConsole");
const adminLoginPromptBtn = document.querySelector("#adminLoginPromptBtn");
const refreshAdminBtn = document.querySelector("#refreshAdminBtn");
const adminStatusFilter = document.querySelector("#adminStatusFilter");
const adminCategoryFilter = document.querySelector("#adminCategoryFilter");
const adminSearchInput = document.querySelector("#adminSearchInput");
const adminTicketList = document.querySelector("#adminTicketList");

const statTotal = document.querySelector("#statTotal");
const statPending = document.querySelector("#statPending");
const statAppeal = document.querySelector("#statAppeal");
const statResolved = document.querySelector("#statResolved");

const loginModal = document.querySelector("#loginModal");
const loginForm = document.querySelector("#loginForm");
const loginUsername = document.querySelector("#loginUsername");
const loginPassword = document.querySelector("#loginPassword");
const loginError = document.querySelector("#loginError");
const closeLoginBtn = document.querySelector("#closeLoginBtn");
const cancelLoginBtn = document.querySelector("#cancelLoginBtn");

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function showNotice(text, isError = false) {
  globalNotice.textContent = text;
  globalNotice.className = isError ? "notice error" : "notice";
  globalNotice.hidden = false;
  setTimeout(() => {
    if (globalNotice.textContent === text) globalNotice.hidden = true;
  }, 5000);
}

async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.message || "요청을 처리하지 못했습니다.");
  }
  return data;
}

function switchTab(tabName) {
  tabs.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  Object.entries(panels).forEach(([key, panel]) => {
    panel.hidden = key !== tabName;
  });

  if (tabName === "my" && currentUser) {
    loadMyTickets();
  }
  if (tabName === "admin") {
    if (currentUser?.is_admin) {
      adminGateCard.hidden = true;
      adminConsole.hidden = false;
      loadAdminTickets();
    } else {
      adminGateCard.hidden = false;
      adminConsole.hidden = true;
    }
  }
}

tabs.forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function openLoginModal() {
  loginError.hidden = true;
  loginModal.hidden = false;
  loginUsername.focus();
}

function closeLoginModal() {
  loginModal.hidden = true;
  loginForm.reset();
  loginError.hidden = true;
}

closeLoginBtn.addEventListener("click", closeLoginModal);
cancelLoginBtn.addEventListener("click", closeLoginModal);
adminLoginPromptBtn.addEventListener("click", openLoginModal);
loginModal.addEventListener("click", (e) => {
  if (e.target === loginModal) closeLoginModal();
});

function renderAuthUI() {
  if (currentUser) {
    const roleTag = currentUser.is_admin
      ? `<span class="badge status-resolved">총괄관리자</span>`
      : currentUser.global_suspended
      ? `<span class="badge cat-appeal">정지 계정</span>`
      : "";
    authArea.innerHTML = `
      <span class="user-pill">
        ${escapeHtml(currentUser.nickname)} (${escapeHtml(currentUser.username)})
        ${roleTag}
      </span>
      <button id="logoutBtn" class="btn btn-outline btn-sm" type="button">로그아웃</button>
    `;
    document.querySelector("#logoutBtn").addEventListener("click", () => {
      token = "";
      currentUser = null;
      localStorage.removeItem(TOKEN_KEY);
      adminBadge.hidden = true;
      renderAuthUI();
      showNotice("로그아웃되었습니다.");
      switchTab("write");
    });

    writeModeBadge.textContent = `${currentUser.nickname} (${currentUser.username}) 로그인됨`;
    writeModeBadge.className = "mode-badge logged";
    guestFields.hidden = true;
    guestUsername.required = false;
    lookupPin.required = false;
    writeHint.textContent = "로그인한 계정으로 접수되며, '내 문의 내역' 탭에서 즉시 답변을 확인할 수 있습니다.";
    myUserSection.hidden = false;

    if (currentUser.global_suspended) {
      suspendedBanner.hidden = false;
      suspendedReasonText.textContent = `사유: ${currentUser.suspension_reason || "운영 정책 위반"} · 소명서를 제출하시면 관리자가 검토 후 답변해 드립니다.`;
    } else {
      suspendedBanner.hidden = true;
    }

    if (currentUser.is_admin) {
      loadAdminTickets();
    }
  } else {
    authArea.innerHTML = `
      <button id="openLoginBtn" class="btn btn-outline btn-sm" type="button">ONEID 로그인</button>
    `;
    document.querySelector("#openLoginBtn").addEventListener("click", openLoginModal);

    writeModeBadge.textContent = "비로그인 접수 모드";
    writeModeBadge.className = "mode-badge";
    guestFields.hidden = false;
    guestUsername.required = true;
    lookupPin.required = true;
    writeHint.textContent = "정지된 계정이거나 로그인하지 않은 상태에서도 아이디와 조회 비밀번호를 입력해 바로 접수할 수 있습니다.";
    myUserSection.hidden = true;
    suspendedBanner.hidden = true;
    adminGateCard.hidden = false;
    adminConsole.hidden = true;
  }
}

quickAppealBtn.addEventListener("click", () => {
  switchTab("write");
  categorySelect.value = "appeal";
  serviceSelect.value = "ONEID";
  ticketTitle.value = `[계정 정지 소명] ${currentUser ? currentUser.username : ""} 정지 해제 요청`;
  ticketContent.focus();
});

function renderCustomerTicketCard(t) {
  const catClass = t.category === "appeal" ? "cat-appeal" : "";
  const replyBlock = t.admin_reply
    ? `
      <div class="ticket-reply">
        <div class="ticket-reply-head">
          <span>관리자 답변 (${escapeHtml(t.replied_by || "총괄관리자")})</span>
          <span>${formatDate(t.replied_at)}</span>
        </div>
        <p class="ticket-reply-body">${escapeHtml(t.admin_reply)}</p>
      </div>
    `
    : "";

  return `
    <article class="ticket-card">
      <div class="ticket-top">
        <div class="ticket-badges">
          <span class="badge">#${t.ticket_id}</span>
          <span class="badge status-${escapeHtml(t.status)}">${escapeHtml(STATUS_LABELS[t.status] || t.status)}</span>
          <span class="badge ${catClass}">${escapeHtml(CATEGORY_LABELS[t.category] || t.category)}</span>
          <span class="badge">${escapeHtml(t.service_name)}</span>
        </div>
        <span class="ticket-meta">${escapeHtml(t.nickname)} (${escapeHtml(t.username)}) · ${formatDate(t.created_at)}</span>
      </div>
      <h3 class="ticket-title">${escapeHtml(t.title)}</h3>
      <p class="ticket-body">${escapeHtml(t.content)}</p>
      ${replyBlock}
    </article>
  `;
}

async function loadMyTickets() {
  if (!currentUser) return;
  myTicketList.innerHTML = `<div class="empty-state"><p>문의 내역을 불러오는 중…</p></div>`;
  try {
    const items = await api("/api/tickets/my");
    if (!items.length) {
      myTicketList.innerHTML = `<div class="empty-state"><p>아직 접수한 1:1 문의가 없습니다.</p></div>`;
      return;
    }
    myTicketList.innerHTML = items.map(renderCustomerTicketCard).join("");
  } catch (err) {
    myTicketList.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

refreshMyBtn.addEventListener("click", loadMyTickets);

// Submit Inquiry
ticketForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  submitTicketBtn.disabled = true;

  const submittedUsername = currentUser ? currentUser.username : guestUsername.value.trim();
  const submittedPin = lookupPin.value.trim();

  try {
    const payload = {
      category: categorySelect.value,
      service_name: serviceSelect.value,
      title: ticketTitle.value.trim(),
      content: ticketContent.value.trim(),
    };
    if (!currentUser) {
      payload.username = submittedUsername;
      payload.nickname = guestNickname.value.trim() || submittedUsername;
      payload.lookup_pin = submittedPin;
    }

    const res = await api("/api/tickets", { method: "POST", body: payload });
    showNotice(res.message);
    ticketTitle.value = "";
    ticketContent.value = "";

    switchTab("my");
    if (!currentUser && submittedUsername && submittedPin) {
      lookupUsername.value = submittedUsername;
      lookupPinInput.value = submittedPin;
      await runGuestLookup(submittedUsername, submittedPin);
    }
  } catch (err) {
    showNotice(err.message, true);
  } finally {
    submitTicketBtn.disabled = false;
  }
});

async function runGuestLookup(username, pin) {
  lookupTicketList.innerHTML = `<div class="empty-state"><p>조회 중…</p></div>`;
  try {
    const items = await api("/api/tickets/lookup", {
      method: "POST",
      auth: false,
      body: { username, lookup_pin: pin },
    });
    lookupTicketList.innerHTML = items.map(renderCustomerTicketCard).join("");
  } catch (err) {
    lookupTicketList.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

lookupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await runGuestLookup(lookupUsername.value.trim(), lookupPinInput.value.trim());
});

// Admin Console
function updateAdminStats() {
  const total = adminTickets.length;
  const pending = adminTickets.filter((t) => t.status === "pending").length;
  const appeal = adminTickets.filter((t) => t.category === "appeal").length;
  const resolved = adminTickets.filter((t) => t.status === "resolved").length;

  statTotal.textContent = total;
  statPending.textContent = pending;
  statAppeal.textContent = appeal;
  statResolved.textContent = resolved;

  if (currentUser?.is_admin) {
    adminBadge.textContent = pending;
    adminBadge.hidden = false;
  }
}

function renderAdminList() {
  const statusVal = adminStatusFilter.value;
  const catVal = adminCategoryFilter.value;
  const q = adminSearchInput.value.trim().toLowerCase();

  const filtered = adminTickets.filter((t) => {
    if (statusVal !== "all" && t.status !== statusVal) return false;
    if (catVal !== "all" && t.category !== catVal) return false;
    if (q) {
      const hay = `${t.ticket_id} ${t.username} ${t.nickname} ${t.service_name} ${t.title} ${t.content}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    adminTicketList.innerHTML = `<div class="empty-state"><p>조건에 맞는 문의 내역이 없습니다.</p></div>`;
    return;
  }

  adminTicketList.innerHTML = filtered
    .map((t) => {
      const catClass = t.category === "appeal" ? "cat-appeal" : "";
      const suspendedAlert = t.account_suspended
        ? `
          <div class="admin-user-alert">
            <span><strong>정지된 ONEID 계정</strong> · 사유: ${escapeHtml(t.account_suspension_reason || "미기재")}</span>
            <label class="checkbox-inline">
              <input type="checkbox" data-unsuspend="${t.ticket_id}">
              답변 저장 시 계정 정지 즉시 해제
            </label>
          </div>
        `
        : "";

      return `
        <article class="ticket-card" data-ticket-card="${t.ticket_id}">
          <div class="ticket-top">
            <div class="ticket-badges">
              <span class="badge">#${t.ticket_id}</span>
              <span class="badge status-${escapeHtml(t.status)}">${escapeHtml(STATUS_LABELS[t.status] || t.status)}</span>
              <span class="badge ${catClass}">${escapeHtml(CATEGORY_LABELS[t.category] || t.category)}</span>
              <span class="badge">${escapeHtml(t.service_name)}</span>
              ${t.account_exists ? `<span class="badge">ONEID 가입자</span>` : `<span class="badge">비회원/미확인</span>`}
            </div>
            <span class="ticket-meta">
              작성자: <strong>${escapeHtml(t.nickname)}</strong> (${escapeHtml(t.username)}) · ${formatDate(t.created_at)}
            </span>
          </div>

          <h3 class="ticket-title">${escapeHtml(t.title)}</h3>
          <p class="ticket-body">${escapeHtml(t.content)}</p>

          <div class="admin-editor">
            ${suspendedAlert}
            <textarea rows="3" data-reply-input="${t.ticket_id}" placeholder="관리자 공식 답변을 입력해 주세요…">${escapeHtml(t.admin_reply || "")}</textarea>
            <div class="admin-controls-row">
              <div class="admin-controls-left">
                <select data-status-select="${t.ticket_id}">
                  <option value="resolved" ${t.status === "resolved" ? "selected" : ""}>답변 완료</option>
                  <option value="in_progress" ${t.status === "in_progress" ? "selected" : ""}>처리 중</option>
                  <option value="pending" ${t.status === "pending" ? "selected" : ""}>답변 대기</option>
                  <option value="rejected" ${t.status === "rejected" ? "selected" : ""}>반려 / 종결</option>
                </select>
                <button class="btn btn-primary btn-sm" type="button" data-save-reply="${t.ticket_id}">답변 및 상태 저장</button>
              </div>
              <button class="btn btn-danger-outline btn-sm" type="button" data-delete-ticket="${t.ticket_id}">삭제</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

adminStatusFilter.addEventListener("change", renderAdminList);
adminCategoryFilter.addEventListener("change", renderAdminList);
adminSearchInput.addEventListener("input", renderAdminList);
refreshAdminBtn.addEventListener("click", loadAdminTickets);

adminTicketList.addEventListener("click", async (e) => {
  const saveBtn = e.target.closest("[data-save-reply]");
  if (saveBtn) {
    const id = Number(saveBtn.dataset.saveReply);
    const replyEl = adminTicketList.querySelector(`[data-reply-input="${id}"]`);
    const statusEl = adminTicketList.querySelector(`[data-status-select="${id}"]`);
    const unsuspendEl = adminTicketList.querySelector(`[data-unsuspend="${id}"]`);

    saveBtn.disabled = true;
    try {
      const res = await api(`/api/admin/tickets/${id}`, {
        method: "PATCH",
        body: {
          status: statusEl.value,
          admin_reply: replyEl.value,
          unsuspend_account: Boolean(unsuspendEl?.checked),
        },
      });
      showNotice(res.message);
      await loadAdminTickets();
    } catch (err) {
      showNotice(err.message, true);
      saveBtn.disabled = false;
    }
    return;
  }

  const delBtn = e.target.closest("[data-delete-ticket]");
  if (delBtn) {
    const id = Number(delBtn.dataset.deleteTicket);
    if (!confirm(`문의 #${id} 항목을 완전히 삭제할까요?`)) return;
    delBtn.disabled = true;
    try {
      await api(`/api/admin/tickets/${id}`, { method: "DELETE" });
      showNotice(`문의 #${id} 삭제 완료`);
      await loadAdminTickets();
    } catch (err) {
      showNotice(err.message, true);
      delBtn.disabled = false;
    }
  }
});

async function loadAdminTickets() {
  if (!currentUser?.is_admin) return;
  try {
    adminTickets = await api("/api/admin/tickets");
    updateAdminStats();
    renderAdminList();
  } catch (err) {
    adminTicketList.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

// Login Form
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const submitBtn = document.querySelector("#submitLoginBtn");
  submitBtn.disabled = true;

  try {
    const res = await api("/api/auth/login", {
      method: "POST",
      auth: false,
      body: {
        username: loginUsername.value.trim(),
        password: loginPassword.value,
      },
    });
    token = res.access_token;
    currentUser = res.user;
    localStorage.setItem(TOKEN_KEY, token);
    closeLoginModal();
    renderAuthUI();
    showNotice(`${currentUser.nickname}님, ONEID 통합 고객센터에 로그인되었습니다.`);
    if (currentUser.is_admin) {
      switchTab("admin");
    }
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

// Bootstrap
(async function init() {
  const params = new URLSearchParams(location.search);
  const svcParam = params.get("service");
  if (svcParam) {
    const match = Array.from(serviceSelect.options).find(
      (opt) => opt.value.toLowerCase() === svcParam.trim().toLowerCase()
    );
    if (match) serviceSelect.value = match.value;
  }
  const catParam = params.get("category");
  if (catParam && CATEGORY_LABELS[catParam]) {
    categorySelect.value = catParam;
  }

  if (token) {
    try {
      currentUser = await api("/api/auth/me");
    } catch {
      token = "";
      currentUser = null;
      localStorage.removeItem(TOKEN_KEY);
    }
  }
  renderAuthUI();
})();
