"use strict";

const core = globalThis.PdfRangeCore;
const elements = {
  sourcePanel: document.querySelector("#sourcePanel"),
  sourceDirectory: document.querySelector("#sourceDirectory"),
  sourceFile: document.querySelector("#sourceFile"),
  refreshButton: document.querySelector("#refreshButton"),
  form: document.querySelector("#mergeForm"),
  start: document.querySelector("#startNumber"),
  end: document.querySelector("#endNumber"),
  digits: document.querySelector("#digits"),
  missingPolicy: document.querySelector("#missingPolicy"),
  filename: document.querySelector("#filename"),
  autoDetect: document.querySelector("#autoDetect"),
  validationMessage: document.querySelector("#validationMessage"),
  mergeButton: document.querySelector("#mergeButton"),
  idleLabel: document.querySelector(".primary-button__idle"),
  busyLabel: document.querySelector(".primary-button__busy"),
  cancelButton: document.querySelector("#cancelButton"),
  manualSaveButton: document.querySelector("#manualSaveButton"),
  progressPanel: document.querySelector("#progressPanel"),
  progressCount: document.querySelector("#progressCount"),
  progressBar: document.querySelector("#progressBar"),
  statusMessage: document.querySelector("#statusMessage"),
  failureDetails: document.querySelector("#failureDetails"),
  failureList: document.querySelector("#failureList"),
  runtimeNotice: document.querySelector("#runtimeNotice"),
};

let source = null;
let isRunning = false;
let runnerMode = "background";
let hasPendingSave = false;
let manualStartBeforeAuto = "1";

function activatePopupRunner(reason) {
  const runner = globalThis.PdfDownloadRunner;
  if (!runner?.handleMessage) {
    throw new Error(reason || "このブラウザではPDF結合処理を開始できません。");
  }
  runnerMode = "popup";
  elements.runtimeNotice.hidden = false;
  elements.runtimeNotice.textContent = "互換モードで実行します。保存が始まるまでポップアップを閉じないでください。iOSがポップアップを終了すると処理も中断されます。";
  return runner;
}

async function sendRunnerMessage(message) {
  if (runnerMode === "popup") {
    return globalThis.PdfDownloadRunner.handleMessage(message);
  }

  const result = await chrome.runtime.sendMessage({ target: "background", ...message });
  if (!result?.usePopupRunner) {
    return result;
  }
  if (message.type === "CANCEL_JOB") {
    return result;
  }
  return activatePopupRunner(result.error).handleMessage(message);
}

function setValidationMessage(message) {
  elements.validationMessage.textContent = message;
  elements.validationMessage.hidden = !message;
}

function updateAutoDetectUI() {
  const auto = elements.autoDetect.checked && !elements.autoDetect.disabled;
  if (auto) elements.start.value = "1";
  elements.start.disabled = isRunning || auto;
  elements.end.disabled = isRunning || auto;
  elements.end.placeholder = auto ? "自動" : "";
  if (auto && (document.activeElement === elements.start || document.activeElement === elements.end)) {
    document.activeElement.blur();
  }
}

function handleAutoDetectChange() {
  if (elements.autoDetect.checked) {
    manualStartBeforeAuto = elements.start.value || String(source?.currentPage || 1);
    elements.start.value = "1";
  } else {
    elements.start.value = manualStartBeforeAuto || String(source?.currentPage || 1);
  }
  updateAutoDetectUI();
}

function setRunning(running) {
  isRunning = running;
  elements.mergeButton.disabled = running || !source || hasPendingSave;
  elements.refreshButton.disabled = running;
  elements.cancelButton.hidden = !running;
  elements.idleLabel.hidden = running;
  elements.busyLabel.hidden = !running;
  elements.autoDetect.disabled = running;
  for (const control of elements.form.querySelectorAll("input, select")) {
    if (control === elements.autoDetect) continue;
    control.disabled = running;
  }
  updateAutoDetectUI();
}

function renderFailures(failures = [], digits = Number(elements.digits.value) || 1) {
  elements.failureList.replaceChildren();
  for (const failure of failures) {
    const item = document.createElement("li");
    item.textContent = `${core.formatPageNumber(failure.number, digits)}.pdf — ${failure.reason}`;
    elements.failureList.append(item);
  }
  elements.failureDetails.hidden = failures.length === 0;
}

function renderJobState(state) {
  if (!state) return;
  const running = state.status === "running";
  const awaitingSave = state.status === "awaiting-save";
  hasPendingSave = awaitingSave && Boolean(globalThis.PdfDownloadRunner?.hasPendingDownload?.());
  elements.mergeButton.hidden = hasPendingSave;
  elements.manualSaveButton.hidden = !hasPendingSave;
  if (hasPendingSave) {
    const filename = state.settings?.filename || "PDF";
    elements.manualSaveButton.textContent = `${filename}を保存`;
  }
  const total = state.total != null ? state.total : 0;
  const processed = state.processed || 0;
  elements.progressPanel.hidden = false;
  elements.progressBar.max = Math.max(total, 1);
  elements.progressBar.value = processed;
  if (state.total != null) {
    elements.progressCount.textContent = `${processed} / ${total}`;
  } else {
    elements.progressCount.textContent = `${processed} 件取得`;
  }
  elements.statusMessage.textContent = state.message || "";
  elements.statusMessage.dataset.tone = state.tone || "neutral";
  renderFailures(state.failures, state.settings?.digits);
  setRunning(running);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function readCurrentPdf({ preserveInputs = false } = {}) {
  if (isRunning) return;
  setValidationMessage("");
  elements.sourcePanel.dataset.state = "loading";
  elements.sourceDirectory.textContent = "現在のタブを確認中…";
  elements.sourceFile.textContent = "";
  source = null;
  setRunning(false);

  try {
    const [tab, stored] = await Promise.all([
      getActiveTab(),
      chrome.storage.local.get(["missingPolicy", "filename", "autoDetect"]),
    ]);
    source = core.parsePdfUrl(tab?.url || "");
    elements.sourceDirectory.textContent = source.directoryUrl;
    elements.sourceFile.textContent = `検出: ${String(source.currentPage).padStart(source.digits, "0")}.pdf（${source.digits}桁）`;
    if (!preserveInputs || elements.autoDetect.checked) {
      elements.start.value = stored.autoDetect === true ? "1" : String(source.currentPage);
      manualStartBeforeAuto = String(source.currentPage);
      elements.end.value = String(source.currentPage);
      elements.digits.value = String(source.digits);
      elements.missingPolicy.value = stored.missingPolicy === "skip" ? "skip" : "stop";
      if (stored.filename) elements.filename.value = stored.filename;
      elements.autoDetect.checked = stored.autoDetect === true;
    }
    elements.sourcePanel.dataset.state = "ready";
    setRunning(false);
  } catch (error) {
    elements.sourcePanel.dataset.state = "error";
    elements.sourceDirectory.textContent = error.message;
    elements.sourceFile.textContent = "学習の手引き、または学習の手引きのPDFを表示した状態で、もう一度お試しください。";
    setRunning(false);
  }
}

function readOptions() {
  try {
    const settings = core.validateOptions({
      start: elements.start.value,
      end: elements.end.value,
      digits: elements.digits.value,
      filename: elements.filename.value,
      missingPolicy: elements.missingPolicy.value,
      autoDetect: elements.autoDetect.checked,
    });
    setValidationMessage("");
    return settings;
  } catch (error) {
    setValidationMessage(error.message);
    throw error;
  }
}

async function startJob(event) {
  event.preventDefault();
  if (!source || isRunning || hasPendingSave) return;

  let settings;
  try {
    settings = readOptions();
  } catch {
    return;
  }

  await chrome.storage.local.set({
    missingPolicy: settings.missingPolicy,
    filename: settings.filename,
    autoDetect: settings.autoDetect,
  });
  setRunning(true);
  renderJobState({
    status: "running",
    tone: "neutral",
    processed: 0,
    total: settings.count,
    failures: [],
    settings,
    message: settings.autoDetect ? "自動検出を開始します…" : "バックグラウンド処理を準備中…",
  });

  try {
    const result = await sendRunnerMessage({
      type: "START_JOB",
      job: { source, settings },
    });
    if (!result?.ok) throw new Error(result?.error || "処理を開始できませんでした。");
  } catch (error) {
    setRunning(false);
    setValidationMessage(error.message);
  }
}

async function cancelJob() {
  elements.cancelButton.disabled = true;
  try {
    const result = await sendRunnerMessage({ type: "CANCEL_JOB" });
    if (!result?.ok) throw new Error(result?.error || "キャンセルできませんでした。");
  } catch (error) {
    setValidationMessage(error.message);
  } finally {
    elements.cancelButton.disabled = false;
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.jobState) {
    renderJobState(changes.jobState.newValue);
  }
});

elements.form.addEventListener("submit", startJob);
elements.refreshButton.addEventListener("click", () => readCurrentPdf());
elements.cancelButton.addEventListener("click", cancelJob);
elements.autoDetect.addEventListener("change", handleAutoDetectChange);
elements.manualSaveButton.addEventListener("click", () => {
  const result = globalThis.PdfDownloadRunner?.savePendingDownload?.();
  if (!result?.ok) {
    setValidationMessage(result?.error || "PDFを保存できませんでした。");
    return;
  }
  hasPendingSave = false;
  elements.manualSaveButton.hidden = true;
  elements.mergeButton.hidden = false;
  setRunning(false);
});

async function initialize() {
  let { jobState } = await chrome.storage.local.get("jobState");
  if (jobState?.status === "awaiting-save" && !globalThis.PdfDownloadRunner?.hasPendingDownload?.()) {
    jobState = {
      ...jobState,
      status: "error",
      tone: "error",
      message: "保存待ちのPDFはポップアップを閉じたため失われました。もう一度結合してください。",
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ jobState });
  }
  if (jobState?.status === "running" && Date.now() - Number(jobState.updatedAt || 0) > 30_000) {
    jobState = {
      ...jobState,
      status: "error",
      tone: "error",
      message: "ブラウザの終了、ポップアップの終了、または拡張機能の再読み込みにより処理が中断されました。",
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ jobState });
  }
  if (jobState?.status === "running") {
    source = jobState.source;
    elements.sourceDirectory.textContent = source.directoryUrl;
    elements.sourceFile.textContent = `処理中: ${String(source.currentPage).padStart(source.digits, "0")}.pdf を基準にしています`;
    if (jobState.settings) {
      elements.start.value = jobState.settings.autoDetect ? "1" : String(jobState.settings.start);
      manualStartBeforeAuto = String(jobState.settings.start || source.currentPage || 1);
      elements.end.value = jobState.settings.end != null ? String(jobState.settings.end) : "";
      elements.digits.value = String(jobState.settings.digits);
      elements.filename.value = jobState.settings.filename;
      elements.missingPolicy.value = jobState.settings.missingPolicy;
      elements.autoDetect.checked = jobState.settings.autoDetect === true;
    }
    updateAutoDetectUI();
    return;
  }
  await readCurrentPdf();
  if (jobState) renderJobState(jobState);
}

void initialize();