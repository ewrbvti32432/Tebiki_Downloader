"use strict";

const OFFSCREEN_PATH = "offscreen.html";
let creatingOffscreen = null;
let offscreenReady = false;

async function ensureOffscreenDocument() {
  if (typeof chrome.offscreen?.createDocument !== "function") {
    throw new Error("このブラウザはOffscreen Documents APIに対応していません。");
  }
  if (offscreenReady) return;

  const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (typeof chrome.runtime.getContexts === "function") {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl],
    });
    if (contexts.length > 0) {
      offscreenReady = true;
      return;
    }
  }

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["BLOBS"],
      justification: "取得した単ページPDFを結合し、ダウンロード用Blobを保持するため",
    }).finally(() => {
      creatingOffscreen = null;
    });
  }
  await creatingOffscreen;
  offscreenReady = true;
}

async function forwardToOffscreen(message) {
  try {
    await ensureOffscreenDocument();
    return await chrome.runtime.sendMessage({
      ...message,
      target: "offscreen",
    });
  } catch (error) {
    return {
      ok: false,
      usePopupRunner: true,
      error: error?.message || "バックグラウンド処理を開始できませんでした。",
    };
  }
}

function installFilenameOverride(url, filename) {
  const event = chrome.downloads?.onDeterminingFilename;
  if (typeof event?.addListener !== "function") return () => {};

  let active = true;
  let timeoutId = null;
  const cleanup = () => {
    if (!active) return;
    active = false;
    if (timeoutId !== null) clearTimeout(timeoutId);
    try {
      event.removeListener?.(listener);
    } catch {
      // 一部の互換ブラウザではremoveListenerが未実装でも問題ない。
    }
  };
  const listener = (item, suggest) => {
    if (!active) return;
    const sameUrl = item?.url === url || item?.finalUrl === url;
    const initiatedHere = Boolean(chrome.runtime?.id)
      && item?.byExtensionId === chrome.runtime.id;
    if (!sameUrl && !initiatedHere) return;

    try {
      suggest({ filename, conflictAction: "uniquify" });
    } finally {
      setTimeout(cleanup, 0);
    }
  };

  event.addListener(listener);
  timeoutId = setTimeout(cleanup, 60_000);
  timeoutId?.unref?.();
  return cleanup;
}

async function downloadUniquely(url, filename) {
  if (typeof chrome.downloads?.download !== "function") {
    throw new Error("このブラウザは拡張機能からのダウンロードに対応していません。");
  }

  const cleanupOverride = installFilenameOverride(url, filename);
  try {
    const result = chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify",
    });
    if (result && typeof result.then === "function") {
      return await result;
    }
    // Orionなど一部の互換実装はPromiseもIDも返さないが、呼び出し自体で保存を開始する。
    return result ?? null;
  } catch (error) {
    cleanupOverride();
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "background") return false;

  if (message.type === "START_JOB" || message.type === "CANCEL_JOB") {
    forwardToOffscreen(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  if (message.type === "STATE_UPDATE") {
    chrome.storage.local.set({ jobState: message.state })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "DOWNLOAD_BLOB") {
    downloadUniquely(message.url, message.filename).then((downloadId) => {
      sendResponse({ ok: true, downloadId });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }

  return false;
});
