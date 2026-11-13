// Tool names and labels from Strata's existing Chrome extension bridge (browser/tools.cjs).
const BrowserProtocol = Object.freeze({
  // Shared by server configuration, model guidance and persisted UI records.
  limits: Object.freeze({ maxActions: 200, maxToolCallsPerRound: 8, wrapUpCalls: 10 }),
  labels: Object.freeze({
    browser_observe: "读取页面",
    browser_tabs: "查看标签页",
    browser_select_tab: "切换标签页",
    browser_navigate: "打开页面",
    browser_click: "点击页面",
    browser_type: "输入内容",
    browser_press: "按键操作",
    browser_scroll: "滚动页面",
    browser_back: "返回上一页",
    browser_wait: "等待页面",
    browser_finish: "结束浏览器任务",
  }),
  displayTool(name) {
    return Object.hasOwn(this.labels, name) || name === "task_update";
  },
  title(name, input) {
    if (name === "task_update") return "更新待办";
    let params = input;
    if (typeof params === "string") {
      try {
        params = JSON.parse(params);
      } catch {
        params = null;
      }
    }
    if (name === "browser_type" && params?.submit === true) return "输入并提交";
    if (name === "browser_navigate" && typeof params?.url === "string") {
      try {
        const url = new URL(params.url);
        // A direct search URL is still navigation, but its visible purpose is
        // search. Do not infer typing/clicks from page text or model narration.
        if (
          ["http:", "https:"].includes(url.protocol) &&
          /\/(?:search|s)\/?$/i.test(url.pathname) &&
          ["q", "query", "wd", "word", "text", "keyword", "p", "k"].some(
            (key) => url.searchParams.get(key)?.trim(),
          )
        )
          return "搜索网页";
      } catch {
        // Invalid/partial arguments keep the tool's ordinary title.
      }
    }
    return this.labels[name] || "浏览器操作";
  },
  validId(value) {
    return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  },
});
if (typeof module !== "undefined") module.exports = BrowserProtocol;
