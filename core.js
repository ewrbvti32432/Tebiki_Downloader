(function initCore(globalScope) {
  "use strict";

  const ALLOWED_ORIGINS = Object.freeze([
    "https://moshi-navi.kawai-juku.ac.jp",
    "https://kawaijuku.meclib.jp",
  ]);
  const MAX_PAGES = 300;
  const MIN_DIGITS = 1;
  const MAX_DIGITS = 12;

  function parsePdfUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error("開いているページのURLを読み取れませんでした。");
    }

    if (!ALLOWED_ORIGINS.includes(url.origin) || url.username || url.password || url.port) {
      throw new Error("河合塾模試ナビまたはkawaijuku.meclib.jpのPDFページを開いてから実行してください。");
    }

    const decodedPath = decodeURIComponent(url.pathname);

    const pdfMatch = decodedPath.match(/^(.*\/)(\d+)\.pdf$/i);
    if (pdfMatch) {
      const fileNumber = pdfMatch[2];
      return {
        origin: url.origin,
        directoryUrl: new URL(pdfMatch[1], url.origin).href,
        currentPage: Number(fileNumber),
        digits: fileNumber.length,
        prefix: fileNumber.slice(0, -String(Number(fileNumber)).length),
        originalUrl: url.href,
      };
    }

    const indexMatch = decodedPath.match(/^(.*\/book\/)index\.html$/i);
    if (indexMatch) {
      const pdfDir = new URL("pdf/", new URL(indexMatch[1], url.origin)).href;
      const hash = decodeURIComponent(url.hash || "");
      const hashPageMatch = hash.match(/(?:^|[\/#?&])page_no=(\d+)(?:$|[\/#?&])/i);
      const queryPage = url.searchParams.get("page_no");
      const pageText = queryPage && /^\d+$/.test(queryPage)
        ? queryPage
        : hashPageMatch?.[1];
      const currentPage = pageText ? Number(pageText) : 1;
      return {
        origin: url.origin,
        directoryUrl: pdfDir,
        currentPage: Number.isSafeInteger(currentPage) ? currentPage : 1,
        digits: 4,
        prefix: "",
        originalUrl: url.href,
      };
    }

    throw new Error("学習の手引き、または学習の手引きのPDFを表示した状態で実行してください。");
  }

  function parseInteger(value, label) {
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) {
      throw new Error(`${label}は0以上の整数で指定してください。`);
    }
    const number = Number(text);
    if (!Number.isSafeInteger(number)) {
      throw new Error(`${label}が大きすぎます。`);
    }
    return number;
  }

  function sanitizeFilename(value) {
    const text = String(value || "").trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
    const withoutExtension = text.replace(/\.pdf$/i, "").trim();
    return `${withoutExtension || "merged-pages"}.pdf`;
  }

  function validateOptions(input) {
    const autoDetect = input.autoDetect === true || input.autoDetect === "true";
    const start = autoDetect ? 1 : parseInteger(input.start, "開始番号");
    const digits = parseInteger(input.digits, "桁数");

    let end, count;

    if (autoDetect) {
      end = null;
    } else {
      end = parseInteger(input.end, "終了番号");
      if (start > end) {
        throw new Error("終了番号は開始番号以上にしてください。");
      }
      if (String(end).length > digits) {
        throw new Error("終了番号が指定した桁数に収まりません。桁数を増やしてください。");
      }
      if (end - start + 1 > MAX_PAGES) {
        throw new Error(`一度に結合できるのは${MAX_PAGES}ページまでです。`);
      }
    }

    if (digits < MIN_DIGITS || digits > MAX_DIGITS) {
      throw new Error(`桁数は${MIN_DIGITS}〜${MAX_DIGITS}で指定してください。`);
    }
    if (input.missingPolicy !== "stop" && input.missingPolicy !== "skip") {
      throw new Error("欠番時の処理を選択してください。");
    }

    if (!autoDetect) {
      count = end - start + 1;
    }

    return {
      start,
      end,
      digits,
      count: count !== undefined ? count : null,
      filename: sanitizeFilename(input.filename),
      missingPolicy: input.missingPolicy,
      autoDetect,
    };
  }

  function formatPageNumber(number, digits) {
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error("ページ番号が不正です。");
    }
    const value = String(number);
    if (value.length > digits) {
      throw new Error("ページ番号が桁数に収まりません。");
    }
    return value.padStart(digits, "0");
  }

  function buildPdfUrl(directoryUrl, number, digits) {
    let directory;
    try {
      directory = new URL(directoryUrl);
    } catch {
      throw new Error("PDF取得元のURLが不正です。");
    }
    if (!ALLOWED_ORIGINS.includes(directory.origin)
      || directory.username
      || directory.password
      || directory.port
      || !directory.pathname.endsWith("/")) {
      throw new Error("PDF取得元は対応する河合塾サイトのディレクトリURLで指定してください。");
    }
    return new URL(`${formatPageNumber(number, digits)}.pdf`, directory).href;
  }

  const api = {
    ALLOWED_ORIGIN: ALLOWED_ORIGINS[0],
    ALLOWED_ORIGINS,
    MAX_PAGES,
    MIN_DIGITS,
    MAX_DIGITS,
    parsePdfUrl,
    sanitizeFilename,
    validateOptions,
    formatPageNumber,
    buildPdfUrl,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.PdfRangeCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
