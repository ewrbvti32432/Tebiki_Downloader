(function (root) {
  "use strict";

  const core = root.PdfRangeCore;
  let controller = null;
  let running = false;
  let pendingDownload = null;

  async function updateState(state) {
    const jobState = { updatedAt: Date.now(), ...state };
    if (chrome.storage?.local) {
      await chrome.storage.local.set({ jobState });
      return;
    }
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "STATE_UPDATE",
      state: jobState,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "処理状況を保存できませんでした。");
    }
  }

  async function fetchPdf(url, signal) {
    let response;
    try {
      response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        redirect: "follow",
        signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error("通信できませんでした");
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get("content-type")?.toLowerCase() || "";
    if (!contentType.includes("application/pdf")) {
      throw new Error(contentType.includes("text/html")
        ? "PDFではなくHTMLが返されました（ログイン状態を確認）"
        : `PDFではない応答です (${contentType || "Content-Typeなし"})`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") {
      throw new Error("PDFの内容を確認できませんでした");
    }
    return bytes;
  }

  async function appendPdf(outputPdf, bytes) {
    try {
      const sourcePdf = await globalThis.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: false });
      const indices = sourcePdf.getPageIndices();
      if (indices.length === 0) throw new Error("ページがありません");
      const pages = await outputPdf.copyPages(sourcePdf, indices);
      for (const page of pages) outputPdf.addPage(page);
      return pages.length;
    } catch (error) {
      throw new Error(error.message?.includes("encrypted")
        ? "暗号化PDFのため結合できません"
        : "PDFを解析できませんでした");
    }
  }

  function revokePendingDownload() {
    if (!pendingDownload) return;
    URL.revokeObjectURL(pendingDownload.objectUrl);
    pendingDownload = null;
  }

  function createDownloadObject(bytes, filename) {
    const blob = typeof File === "function"
      ? new File([bytes], filename, { type: "application/pdf" })
      : new Blob([bytes], { type: "application/pdf" });
    return {
      blob,
      objectUrl: URL.createObjectURL(blob),
    };
  }

  async function requestExtensionDownload(objectUrl, filename) {
    try {
      const result = await chrome.runtime.sendMessage({
        target: "background",
        type: "DOWNLOAD_BLOB",
        url: objectUrl,
        filename,
      });
      return result?.ok === true;
    } catch {
      return false;
    }
  }

  async function prepareDownload(bytes, filename, popupMode) {
    revokePendingDownload();
    const { blob, objectUrl } = createDownloadObject(bytes, filename);
    const isOrionPopup = popupMode && Boolean(root.KAGI);

    // Chromium系ではdownloads APIとonDeterminingFilenameを使い、指定名と重複時の(1)付与を維持する。
    // Orion iOSは非同期の自動クリックだとUndefinedになりやすいため、実際のタップで保存させる。
    if (!isOrionPopup && await requestExtensionDownload(objectUrl, filename)) {
      root.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      return { needsUserAction: false };
    }

    if (!popupMode || typeof document === "undefined") {
      URL.revokeObjectURL(objectUrl);
      throw new Error("このブラウザでは指定したファイル名で保存を開始できませんでした。");
    }

    pendingDownload = { blob, objectUrl, filename, successState: null };
    return { needsUserAction: true };
  }

  function savePendingDownload() {
    const pending = pendingDownload;
    if (!pending) {
      return { ok: false, error: "保存待ちのPDFがありません。もう一度結合してください。" };
    }

    // clickイベントから同期的に呼ばれるため、iOS/Orionでもユーザー操作として扱われる。
    const link = document.createElement("a");
    link.href = pending.objectUrl;
    link.download = pending.filename;
    link.type = "application/pdf";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();

    pendingDownload = null;
    root.setTimeout(() => URL.revokeObjectURL(pending.objectUrl), 60_000);
    if (pending.successState) {
      void updateState(pending.successState);
    }
    return { ok: true, filename: pending.filename };
  }

  function hasPendingDownload() {
    return Boolean(pendingDownload);
  }

  async function runJob(job) {
    if (running) return { ok: false, error: "別の結合処理が実行中です。" };
    if (!globalThis.PDFLib?.PDFDocument) {
      return { ok: false, error: "PDF結合ライブラリを読み込めませんでした。" };
    }

    running = true;
    controller = new AbortController();
    const failures = [];
    let successfulFiles = 0;
    let mergedPages = 0;
    const baseState = {
      status: "running",
      total: job.settings.count,
      processed: 0,
      failures,
      settings: job.settings,
      source: job.source,
      startedAt: Date.now(),
      tone: "neutral",
    };

    const popupMode = location.pathname.endsWith("/popup.html");
    await updateState({
      ...baseState,
      message: popupMode
        ? "互換モードで取得を開始しました。完了までポップアップを閉じないでください。"
        : "取得を開始しました。ポップアップは閉じても構いません。",
    });

    try {
      const autoDetect = job.settings.autoDetect === true;
      const loopStart = autoDetect ? 1 : job.settings.start;
      const loopEnd = autoDetect ? core.MAX_PAGES : job.settings.end;
      const outputPdf = await globalThis.PDFLib.PDFDocument.create();
      for (let number = loopStart; number <= loopEnd; number += 1) {
        if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const formatted = core.formatPageNumber(number, job.settings.digits);
        const url = core.buildPdfUrl(job.source.directoryUrl, number, job.settings.digits);

        const currentState = {
          ...baseState,
          processed: number - loopStart,
          total: autoDetect ? null : baseState.total,
          failures: [...failures],
          message: `${formatted}.pdf を取得中…`,
        };
        await updateState(currentState);

        try {
          const bytes = await fetchPdf(url, controller.signal);
          mergedPages += await appendPdf(outputPdf, bytes);
          successfulFiles += 1;
        } catch (error) {
          if (error.name === "AbortError") throw error;
          if (autoDetect) {
            break;
          }
          failures.push({ number, reason: error.message });
          if (job.settings.missingPolicy === "stop") {
            throw new Error(`${formatted}.pdf を取得できなかったため停止しました。${error.message}`);
          }
        }

        await updateState({
          ...baseState,
          processed: number - loopStart + 1,
          total: autoDetect ? null : baseState.total,
          failures: [...failures],
          message: `${formatted}.pdf の処理が完了しました。`,
        });
      }

      if (successfulFiles === 0 || mergedPages === 0) {
        throw new Error("結合できるPDFを1件も取得できませんでした。");
      }

      const totalProcessed = autoDetect ? successfulFiles : job.settings.count;
      const finalBase = { ...baseState, total: totalProcessed, processed: totalProcessed };
      await updateState({ ...finalBase, failures: [...failures], message: `${mergedPages}ページのPDFを作成中…` });
      const result = await outputPdf.save({ useObjectStreams: true });
      const downloadResult = await prepareDownload(result, job.settings.filename, popupMode);
      const suffix = failures.length > 0 ? `（${failures.length}件は取得できずスキップ）` : "";
      const successState = {
        ...finalBase,
        status: "success",
        tone: "success",
        failures: [...failures],
        mergedPages,
        message: `${mergedPages}ページの「${job.settings.filename}」の保存を開始しました。${suffix}`,
      };

      if (downloadResult.needsUserAction) {
        pendingDownload.successState = successState;
        await updateState({
          ...finalBase,
          status: "awaiting-save",
          tone: "neutral",
          failures: [...failures],
          mergedPages,
          message: `結合が完了しました。下の「${job.settings.filename}を保存」をタップしてください。`,
        });
        return { ok: true, awaitingSave: true };
      }

      await updateState(successState);
      return { ok: true };
    } catch (error) {
      const cancelled = error.name === "AbortError";
      revokePendingDownload();
      await updateState({
        ...baseState,
        status: cancelled ? "cancelled" : "error",
        tone: "error",
        failures: [...failures],
        message: cancelled ? "処理をキャンセルしました。" : error.message,
      });
      return { ok: false, error: error.message };
    } finally {
      controller = null;
      running = false;
    }
  }

  function handleMessage(message) {
    if (message.type === "START_JOB") {
      if (running) {
        return { ok: false, error: "別の結合処理が実行中です。" };
      }
      void runJob(message.job);
      return { ok: true };
    }
    if (message.type === "CANCEL_JOB") {
      controller?.abort();
      return { ok: true };
    }
    return { ok: false, error: "未対応の結合操作です。" };
  }

  if (location.pathname.endsWith("/offscreen.html")) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.target !== "offscreen") return false;
      try {
        sendResponse(handleMessage(message));
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    });
  }

  root.PdfDownloadRunner = Object.freeze({
    handleMessage,
    hasPendingDownload,
    savePendingDownload,
  });
})(globalThis);
