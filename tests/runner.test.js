"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../core.js");

const runnerSource = fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf8");

function loadRunner(pathname) {
  let listenerCount = 0;
  const context = vm.createContext({
    PdfRangeCore: Core,
    PDFLib: { PDFDocument: {} },
    location: { pathname },
    chrome: {
      runtime: {
        onMessage: {
          addListener() {
            listenerCount += 1;
          },
        },
        async sendMessage() {
          return { ok: true };
        },
      },
      storage: { local: { async set() {} } },
    },
    fetch,
    AbortController,
    DOMException,
    Uint8Array,
    Blob,
    URL,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(runnerSource, context, { filename: "offscreen.js" });
  return { context, getListenerCount: () => listenerCount };
}

test("ポップアップでは互換ランナーだけを公開しoffscreenメッセージを横取りしない", () => {
  const loaded = loadRunner("/popup.html");

  assert.equal(loaded.getListenerCount(), 0);
  assert.equal(typeof loaded.context.PdfDownloadRunner?.handleMessage, "function");
  assert.equal(loaded.context.PdfDownloadRunner.handleMessage({ type: "CANCEL_JOB" }).ok, true);
});

test("offscreen文書では従来どおりメッセージリスナーを登録する", () => {
  const loaded = loadRunner("/offscreen.html");

  assert.equal(loaded.getListenerCount(), 1);
  assert.equal(typeof loaded.context.PdfDownloadRunner?.handleMessage, "function");
});
