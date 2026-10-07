"use strict";
const form = document.querySelector("#login-form");
const error = document.querySelector("#login-error");
const dashboard = document.querySelector("#dashboard");
const project = document.querySelector("#project");
const status = document.querySelector("#status");
const result = document.querySelector("#result");
const loginPanel = document.querySelector("#login-panel");
const codexHome = document.querySelector("#codex-home");
const PROJECT_KEY = "codex.selectedProject";
const api = async (url, options) => { const response = await fetch(url, options); if (!response.ok) throw new Error("request_failed"); return response.status === 204 ? null : response.json(); };
const refreshStatus = async () => { if (!project.value) return; const value = await api(`/api/status?projectId=${encodeURIComponent(project.value)}`); status.textContent = value.active ? "Running" : humanState(value.state); status.classList.toggle("running", value.active); };
const humanState = (value) => String(value || "idle").toLowerCase().replaceAll("_", " ").replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase());
const updateProjectDetails = () => { const option = project.options[project.selectedIndex]; codexHome.textContent = `Codex: ${option?.dataset.codexHome || "default"}`; };
const loadProjects = async () => { const projects = await api("/api/projects"); for (const item of projects) { const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; option.dataset.codexHome = item.codexHome || "default"; project.append(option); } const saved = localStorage.getItem(PROJECT_KEY); if (saved && [...project.options].some((option) => option.value === saved)) project.value = saved; updateProjectDetails(); await refreshStatus(); };
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.querySelector("#password").value;
  document.querySelector("#password").value = "";
  try {
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (!response.ok) { error.hidden = false; return; }
    form.hidden = true; loginPanel.hidden = true; dashboard.hidden = false;
    await loadProjects();
  } catch { error.textContent = "Unable to reach the server."; error.hidden = false; }
});
project.addEventListener("change", () => { localStorage.setItem(PROJECT_KEY, project.value); updateProjectDetails(); void refreshStatus(); });
document.querySelector("#task-form").addEventListener("submit", async (event) => { event.preventDefault(); const button = event.currentTarget.querySelector("button[type=submit]"); button.disabled = true; status.textContent = "Running"; status.classList.add("running"); result.className = "result-empty"; result.textContent = "Running task…"; const poller = setInterval(() => { void refreshStatus(); }, 1000); try { const value = await api("/api/task", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": (await api("/api/auth/me")).csrfToken }, body: JSON.stringify({ projectId: project.value, prompt: document.querySelector("#prompt").value }) }); result.className = "result-card"; result.replaceChildren(); const title = document.createElement("strong"); title.textContent = value?.outcome === "completed" ? "Task completed" : value?.outcome === "question" ? "Agent needs an answer" : value?.outcome === "stopped" ? "Task stopped" : "Task failed"; const message = document.createElement("p"); message.textContent = value?.summary || value?.question || value?.message || "The task finished without a summary."; const id = document.createElement("span"); id.className = "task-id"; id.textContent = value?.id ? `Task ${value.id}` : "Task finished"; result.append(title, message, id); document.querySelector("#prompt").value = ""; await refreshStatus(); } catch { result.textContent = "Unable to run task. Check the selected project and try again."; } finally { clearInterval(poller); button.disabled = false; } });
document.querySelector("#stop").addEventListener("click", async () => { try { const csrfToken = (await api("/api/auth/me")).csrfToken; await api("/api/stop", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ projectId: project.value }) }); result.className = "result-card"; result.textContent = "Stop requested."; await refreshStatus(); } catch { result.textContent = "Unable to stop task."; } });
