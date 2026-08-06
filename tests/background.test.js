"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function loadBackground({ createDocument, downloadImpl } = {}) {
  let listener;
  let filenameListener;
  const forwarded = [];
  const downloadCalls = [];
  const chrome = {
    runtime: {
      id: "test-extension",
      getURL: (file) => `chrome-extension://test/${file}`,
      onMessage: {
        addListener(value) {
          listener = value;
        },
      },
      async sendMessage(message) {
        forwarded.push(message);
        return { ok: true };
      },
    },
    offscreen: createDocument ? { createDocument } : undefined,
    storage: { local: { async set() {} } },
    downloads: {
      download(options) {
        downloadCalls.push(options);
        return downloadImpl ? downloadImpl(options) : Promise.resolve(1);
      },
      onDeterminingFilename: {
        addListener(value) {
          filenameListener = value;
        },
        removeListener(value) {
          if (filenameListener === value) filenameListener = null;
        },
      },
    },
  };
  vm.runInNewContext(backgroundSource, {
    chrome,
    console,
    setTimeout,
    clearTimeout,
  }, { filename: "background.js" });
  return {
    getListener: () => listener,
    getFilenameListener: () => filenameListener,
    forwarded,
    downloadCalls,
  };
}

function dispatch(listener, message) {
  return new Promise((resolve, reject) => {
    const keepChannelOpen = listener(message, {}, resolve);
    if (keepChannelOpen !== true) {
      reject(new Error("メッセージチャネルが非同期応答用に維持されませんでした。"));
    }
  });
}

test("getContextsがなくてもcreateDocumentでoffscreen文書を作成して再利用する", async () => {
  let createCount = 0;
  const loaded = loadBackground({
    async createDocument() {
      createCount += 1;
    },
  });
  const listener = loaded.getListener();

  assert.deepEqual(await dispatch(listener, { target: "background", type: "START_JOB", job: {} }), { ok: true });
  assert.deepEqual(await dispatch(listener, { target: "background", type: "CANCEL_JOB" }), { ok: true });
  assert.equal(createCount, 1);
  assert.equal(loaded.forwarded.length, 2);
  assert.ok(loaded.forwarded.every((message) => message.target === "offscreen"));
});

test("createDocumentもない場合はポップアップ互換モードを要求する", async () => {
  const loaded = loadBackground();
  const response = await dispatch(loaded.getListener(), {
    target: "background",
    type: "START_JOB",
    job: {},
  });

  assert.equal(response.ok, false);
  assert.equal(response.usePopupRunner, true);
  assert.match(response.error, /Offscreen Documents API/);
  assert.equal(loaded.forwarded.length, 0);
});

test("指定ファイル名とuniquifyでダウンロードし、仮名がUUIDでも上書き提案する", async () => {
  const loaded = loadBackground();
  const response = await dispatch(loaded.getListener(), {
    target: "background",
    type: "DOWNLOAD_BLOB",
    url: "blob:chrome-extension://test/random-id",
    filename: "指定した名前.pdf",
  });

  assert.equal(response.ok, true);
  assert.equal(loaded.downloadCalls[0].url, "blob:chrome-extension://test/random-id");
  assert.equal(loaded.downloadCalls[0].filename, "指定した名前.pdf");
  assert.equal(loaded.downloadCalls[0].saveAs, false);
  assert.equal(loaded.downloadCalls[0].conflictAction, "uniquify");

  let suggestion;
  loaded.getFilenameListener()({
    url: "blob:chrome-extension://test/random-id",
    filename: "2e7e9047-f76f-4c73-826e-c3ec35f05556.pdf",
  }, (value) => {
    suggestion = value;
  });
  assert.equal(suggestion.filename, "指定した名前.pdf");
  assert.equal(suggestion.conflictAction, "uniquify");
});
