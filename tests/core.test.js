"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parsePdfUrl,
  validateOptions,
  formatPageNumber,
  buildPdfUrl,
  sanitizeFilename,
} = require("../core.js");

test("4桁のPDF URLから可変ディレクトリと番号を解析する", () => {
  const result = parsePdfUrl("https://moshi-navi.kawai-juku.ac.jp/tebiki/0000/__example_book_4digit__/book/pdf/0091.pdf");
  assert.equal(result.directoryUrl, "https://moshi-navi.kawai-juku.ac.jp/tebiki/0000/__example_book_4digit__/book/pdf/");
  assert.equal(result.currentPage, 91);
  assert.equal(result.digits, 4);
});

test("5桁かつ00001.pdfから始まるURLを解析できる", () => {
  const result = parsePdfUrl("https://moshi-navi.kawai-juku.ac.jp/tebiki/0000/__example_book_5digit__/book/pdf/00001.pdf#page=1");
  assert.equal(result.currentPage, 1);
  assert.equal(result.digits, 5);
});

test("meclib旧形式のPDF URLを解析できる", () => {
  const result = parsePdfUrl("https://kawaijuku.meclib.jp/library/books/__example_legacy_book__/book/pdf/0001.pdf?from=test#page=1");
  assert.equal(result.origin, "https://kawaijuku.meclib.jp");
  assert.equal(result.directoryUrl, "https://kawaijuku.meclib.jp/library/books/__example_legacy_book__/book/pdf/");
  assert.equal(result.currentPage, 1);
  assert.equal(result.digits, 4);
});

test("許可サイト外と数字で終わらないURLを拒否する", () => {
  assert.throws(() => parsePdfUrl("https://example.com/0001.pdf"), /河合塾模試ナビまたは/);
  assert.throws(() => parsePdfUrl("https://moshi-navi.kawai-juku.ac.jp/book/pdf/index.pdf"), /学習の手引き/);
  assert.throws(() => parsePdfUrl("https://kawaijuku.meclib.jp.evil.example/0001.pdf"), /河合塾模試ナビまたは/);
  assert.throws(() => parsePdfUrl("http://kawaijuku.meclib.jp/library/books/x/book/pdf/0001.pdf"), /河合塾模試ナビまたは/);
});

test("指定桁数でゼロ埋めURLを生成する", () => {
  assert.equal(formatPageNumber(1, 4), "0001");
  assert.equal(formatPageNumber(1, 5), "00001");
  assert.equal(
    buildPdfUrl("https://moshi-navi.kawai-juku.ac.jp/a/b/pdf/", 91, 5),
    "https://moshi-navi.kawai-juku.ac.jp/a/b/pdf/00091.pdf",
  );
  assert.equal(
    buildPdfUrl("https://kawaijuku.meclib.jp/library/books/__example_legacy_book__/book/pdf/", 91, 4),
    "https://kawaijuku.meclib.jp/library/books/__example_legacy_book__/book/pdf/0091.pdf",
  );
  assert.throws(
    () => buildPdfUrl("https://example.com/a/b/pdf/", 1, 4),
    /対応する河合塾サイト/,
  );
});

test("有効な入力を正規化する", () => {
  assert.deepEqual(
    validateOptions({ start: "1", end: "91", digits: "4", filename: "解答.pdf", missingPolicy: "skip" }),
    { start: 1, end: 91, digits: 4, count: 91, filename: "解答.pdf", missingPolicy: "skip", autoDetect: false },
  );
});

test("逆順、上限超過、桁あふれを拒否する", () => {
  assert.throws(
    () => validateOptions({ start: "9", end: "1", digits: "4", filename: "x", missingPolicy: "stop" }),
    /終了番号/,
  );
  assert.throws(
    () => validateOptions({ start: "1", end: "301", digits: "4", filename: "x", missingPolicy: "stop" }),
    /300ページ/,
  );
  assert.throws(
    () => validateOptions({ start: "1", end: "10000", digits: "4", filename: "x", missingPolicy: "stop" }),
    /桁数/,
  );
});

test("Windowsで使えない文字を保存名から除去する", () => {
  assert.equal(sanitizeFilename("解答:前期/数学"), "解答_前期_数学.pdf");
  assert.equal(sanitizeFilename("  "), "merged-pages.pdf");
});

test("index.htmlの手引きページURLからPDFディレクトリに変換する", () => {
  const result = parsePdfUrl("https://moshi-navi.kawai-juku.ac.jp/tebiki/0000/__example_current_book__/book/index.html#target/page_no=1");
  assert.equal(result.origin, "https://moshi-navi.kawai-juku.ac.jp");
  assert.equal(result.directoryUrl, "https://moshi-navi.kawai-juku.ac.jp/tebiki/0000/__example_current_book__/book/pdf/");
  assert.equal(result.currentPage, 1);
  assert.equal(result.digits, 4);
});

test("index.htmlの手引きページURL（別年度）も変換できる", () => {
  const result = parsePdfUrl("https://moshi-navi.kawai-juku.ac.jp/tebiki/0000/__example_previous_book__/book/index.html#target/page_no=1");
  assert.equal(result.directoryUrl, "https://moshi-navi.kawai-juku.ac.jp/tebiki/0000/__example_previous_book__/book/pdf/");
  assert.equal(result.currentPage, 1);
  assert.equal(result.digits, 4);
});

test("index.htmlのpage_no=2や3を表示中ページとして解析できる", () => {
  const page2 = parsePdfUrl("https://moshi-navi.kawai-juku.ac.jp/tebiki/0000/__example_current_book__/book/index.html#target/page_no=2");
  const page3 = parsePdfUrl("https://moshi-navi.kawai-juku.ac.jp/tebiki/0000/__example_previous_book__/book/index.html#target/page_no=3");
  assert.equal(page2.currentPage, 2);
  assert.equal(page3.currentPage, 3);
});

test("queryのpage_noも表示中ページとして解析できる", () => {
  const result = parsePdfUrl("https://moshi-navi.kawai-juku.ac.jp/tebiki/0000/__example_current_book__/book/index.html?page_no=7");
  assert.equal(result.currentPage, 7);
});

test("index.html以外のHTMLページは拒否する", () => {
  assert.throws(
    () => parsePdfUrl("https://moshi-navi.kawai-juku.ac.jp/tebiki/0000/__example_current_book__/book/other.html"),
    /学習の手引き/,
  );
});

test("autoDetect=true で end が null、count が null になる", () => {
  const result = validateOptions({
    start: "1", end: "", digits: "4", filename: "test.pdf",
    missingPolicy: "stop", autoDetect: true,
  });
  assert.equal(result.start, 1);
  assert.equal(result.end, null);
  assert.equal(result.count, null);
  assert.equal(result.autoDetect, true);
  assert.equal(result.digits, 4);
});

test("autoDetect=true では表示中ページに関係なく1から開始する", () => {
  const result = validateOptions({
    start: "5", end: "1", digits: "4", filename: "test.pdf",
    missingPolicy: "stop", autoDetect: true,
  });
  assert.equal(result.start, 1);
  assert.equal(result.end, null);
});

test("autoDetect=false（デフォルト）では既存のバリデーションが有効", () => {
  assert.throws(
    () => validateOptions({ start: "9", end: "1", digits: "4", filename: "x", missingPolicy: "stop" }),
    /終了番号/,
  );
});
