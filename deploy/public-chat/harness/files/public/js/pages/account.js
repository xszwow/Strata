(() => {
  const page = document.body.dataset.accountPage;
  const token = localStorage.getItem("token");
  if (page === "settings" ? !token : !!token) {
    location.replace(page === "settings" ? "login.html" : "chat.html");
    return;
  }
  const byId = (id) => document.getElementById(id);
  const showMessage = (text, success = false) => {
    for (const id of ["error-msg", "success-msg"])
      byId(id).classList.remove("show");
    const node = byId(success ? "success-msg" : "error-msg");
    node.textContent = text;
    node.classList.add("show");
  };
  const clearMessages = () => {
    for (const id of ["error-msg", "success-msg"])
      byId(id).classList.remove("show");
  };
  async function request(url, body, method = body ? "POST" : "GET") {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(page === "settings" ? { Authorization: "Bearer " + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (page === "settings" && response.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      location.replace("login.html");
    }
    if (!response.ok) throw new Error(data.error || "请求失败，请稍后重试");
    return data;
  }
  for (const button of document.querySelectorAll("[data-toggle-password]")) {
    button.addEventListener("click", () => {
      const input = byId(button.dataset.togglePassword);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.textContent = show ? "隐藏" : "显示";
      button.setAttribute("aria-pressed", String(show));
      button.setAttribute(
        "aria-label",
        (show ? "隐藏" : "显示") + input.labels[0].textContent,
      );
    });
  }
  if (page !== "settings") {
    const register = page === "register";
    const form = byId(register ? "register-form" : "login-form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = byId("submit-btn");
      if (button.disabled) return;
      const username = byId("username").value.trim();
      const password = byId("password").value;
      if (!username || !password) return showMessage("请填写用户名和密码");
      if (register) {
        if (username.length < 3 || username.length > 20)
          return showMessage("用户名需要 3–20 个字符");
        if (password.length < 6) return showMessage("密码至少需要 6 个字符");
        if (password !== byId("confirmPassword").value) {
          byId("confirmPassword").setAttribute("aria-invalid", "true");
          byId("confirmPassword").focus();
          return showMessage("两次输入的密码不一致");
        }
        byId("confirmPassword").removeAttribute("aria-invalid");
      }
      clearMessages();
      button.disabled = true;
      button.textContent = register ? "正在创建…" : "正在登录…";
      try {
        const data = await request("/api/auth/" + page, {
          username,
          password,
          ...(register ? { inviteCode: byId("inviteCode").value.trim() } : {}),
        });
        localStorage.setItem("token", data.token);
        localStorage.setItem("user", JSON.stringify(data.user));
        showMessage(
          register
            ? `账号已创建，可用额度 ${data.freeMessages ?? 0} 次。`
            : "登录成功，正在进入…",
          true,
        );
        location.replace("chat.html");
      } catch (error) {
        showMessage(
          error.message === "Failed to fetch"
            ? "网络连接失败，请稍后重试"
            : error.message,
        );
        button.disabled = false;
        button.textContent = register ? "创建账号" : "登录";
      }
    });
    return;
  }

  let profile;
  let busy = false;
  async function loadProfile() {
    byId("retry-profile").hidden = true;
    try {
      profile = await request("/api/user/profile");
      byId("username").textContent = profile.username;
      const date = new Date(profile.createdAt);
      byId("join-date").textContent = Number.isFinite(date.getTime())
        ? "注册于 " + date.toLocaleDateString("zh-CN")
        : "IVYUN 助手账号";
      byId("free-messages").textContent = profile.freeMessages ?? 0;
      byId("api-status").classList.toggle("configured", !!profile.hasApiKey);
      byId("status-text").textContent = profile.hasApiKey ? "已连接" : "未添加";
      byId("key-preview").textContent = profile.hasApiKey
        ? profile.apiKeyPreview
        : "有额度即可开始对话";
      byId("delete-btn").hidden = !profile.hasApiKey;
      byId("apiKey").placeholder = profile.hasApiKey
        ? "输入新密钥以替换当前密钥"
        : "输入你的 API 密钥";
    } catch (error) {
      byId("username").textContent = "暂时无法加载账号";
      byId("status-text").textContent = "加载失败";
      byId("retry-profile").hidden = false;
      showMessage(
        error.message === "Failed to fetch"
          ? "网络连接失败，请重新加载账号信息"
          : error.message,
      );
    }
  }
  function setBusy(value) {
    busy = value;
    byId("save-btn").disabled = value;
    byId("delete-btn").disabled = value;
    byId("apiKey").disabled = value;
  }
  byId("api-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const apiKey = byId("apiKey").value.trim();
    if (!apiKey) {
      byId("apiKey").focus();
      return showMessage("请输入 API 密钥");
    }
    clearMessages();
    setBusy(true);
    byId("save-btn").textContent = "正在验证…";
    try {
      await request("/api/user/verify-api-key", { apiKey });
      byId("save-btn").textContent = "正在保存…";
      await request("/api/user/api-key", { apiKey });
      byId("apiKey").value = "";
      showMessage("密钥验证通过，已保存。", true);
      await loadProfile();
    } catch (error) {
      showMessage(error.message);
    } finally {
      setBusy(false);
      byId("save-btn").textContent = "验证并保存";
    }
  });
  byId("delete-btn").addEventListener("click", async () => {
    if (
      busy ||
      !profile?.hasApiKey ||
      !confirm("移除当前 API 密钥？剩余对话额度仍可使用。")
    )
      return;
    clearMessages();
    setBusy(true);
    try {
      await request("/api/user/api-key", null, "DELETE");
      byId("apiKey").value = "";
      showMessage("API 密钥已移除。", true);
      await loadProfile();
    } catch (error) {
      showMessage(error.message);
    } finally {
      setBusy(false);
    }
  });
  byId("retry-profile").addEventListener("click", () => {
    clearMessages();
    void loadProfile();
  });
  byId("logout-btn").addEventListener("click", () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    location.replace("login.html");
  });
  function selectSettings() {
    const names = { account: "账号", api: "API 密钥", support: "帮助与支持" };
    const section = Object.hasOwn(names, location.hash.slice(1))
      ? location.hash.slice(1)
      : "account";
    for (const panel of document.querySelectorAll(".settings-section"))
      panel.hidden = panel.id !== section;
    for (const link of document.querySelectorAll(".settings-nav a")) {
      if (link.hash === "#" + section)
        link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    byId("settings-title").textContent = names[section];
    if (section === "support")
      document.querySelector(".support-panel").open = true;
  }
  addEventListener("hashchange", selectSettings);
  selectSettings();
  void loadProfile();
})();
