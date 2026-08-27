// ==UserScript==
// @name         雑談たぬき 全レス表示
// @namespace    https://ckylab.local/
// @version      0.5.2
// @description  雑談たぬき本来の見た目で全レス表示し、アンカー先ポップアップと静的HTML保存を追加します。
// @match        https://b.2ch2.net/test/read.cgi/zatsudan/*
// @match        http://b.2ch2.net/test/read.cgi/zatsudan/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // Node.js からも検証できる純粋関数。ブラウザ側でも同じ実装を使う。
  function buildPageUrls(threadBase, total) {
    const urls = [];
    if (!Number.isFinite(total) || total <= 0) return urls;

    const firstEnd = Math.min(15, total);
    urls.push(`${threadBase}1-${firstEnd}-i`);

    for (let start = 16; start <= total; start += 20) {
      urls.push(`${threadBase}${start}-i`);
    }
    return urls;
  }

  function getExpectedRangeFromUrl(sourceUrl) {
    let pathname;
    try {
      pathname = new URL(sourceUrl, 'https://example.invalid/').pathname;
    } catch {
      return null;
    }

    const tail = pathname.split('/').filter(Boolean).at(-1) || '';
    let match = tail.match(/^(\d+)-(\d+)-?i?$/i);
    if (match) {
      return { start: Number(match[1]), end: Number(match[2]) };
    }

    match = tail.match(/^(\d+)-?i$/i);
    if (match) {
      const start = Number(match[1]);
      return { start, end: start + 19 };
    }

    return null;
  }

  function parseHeaderCandidate(href, anchorText, followingText, sourceUrl) {
    const text = String(anchorText || '').replace(/\u00a0/g, ' ').trim();
    const match = text.match(/^(\d{1,5})\s*[:：]?$/);
    if (!match) return 0;

    const number = Number(match[1]);
    if (!Number.isFinite(number) || number <= 0) return 0;

    // q=番号 がある場合は矛盾していないことだけ確認する。現行の雑談たぬきでは
    // レス見出しの href が q= を持たない表示もあるため、q= 自体は必須にしない。
    try {
      const url = new URL(href || '', sourceUrl || 'https://example.invalid/');
      const q = url.searchParams.get('q');
      if (/^\d{1,5}$/.test(q || '') && Number(q) !== number) return 0;
    } catch {
      // href がURLとして解釈できなくても、見出し本文＋日時で判定を続ける。
    }

    const tail = String(followingText || '').replace(/\u00a0/g, ' ');
    // 「1:主 2026/...」「192:〒 2026/...」「1212: 2026/...」のように、
    // レス番号の直後へ主表示や機能アイコンが少し挟まっても、同じ行に日時があれば見出し。
    // 本文中の単なる数字リンクを誤認しないよう、日時は必須かつ行頭近くに限定する。
    const hasDateAfter = /^\s*[:：]?\s*(?:[^\r\n]{0,16}?)?(?:19|20)\d{2}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}/.test(tail);
    return hasDateAfter ? number : 0;
  }

  function analyzeVisibleLayout(numbers, total) {
    if (!Number.isFinite(total) || total <= 0) return null;
    const visible = [...new Set((numbers || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= total))]
      .sort((a, b) => a - b);
    if (!visible.length || visible[0] !== 1) return null;

    const set = new Set(visible);
    let prefixEnd = 0;
    while (set.has(prefixEnd + 1)) prefixEnd++;

    if (prefixEnd >= total) {
      return {
        prefixEnd: total,
        suffixStart: null,
        missingStart: null,
        missingEnd: null,
        complete: true,
      };
    }

    let suffixStart = null;
    if (set.has(total)) {
      suffixStart = total;
      while (suffixStart > prefixEnd + 1 && set.has(suffixStart - 1)) suffixStart--;
    }

    // 想定している通常表示は「1からの連続部分」＋「最新レスの連続部分」。
    // それ以外の中間クラスタがある場合は、誤った位置へ挿入しないよう安全側で停止する。
    for (const number of visible) {
      const inPrefix = number <= prefixEnd;
      const inSuffix = suffixStart !== null && number >= suffixStart;
      if (!inPrefix && !inSuffix) return null;
    }

    const missingStart = prefixEnd + 1;
    const missingEnd = suffixStart === null ? total : suffixStart - 1;
    if (missingStart > missingEnd) {
      return {
        prefixEnd,
        suffixStart,
        missingStart: null,
        missingEnd: null,
        complete: true,
      };
    }

    return { prefixEnd, suffixStart, missingStart, missingEnd, complete: false };
  }

  function buildNeededPageUrls(threadBase, total, missingStart, missingEnd) {
    if (!Number.isInteger(missingStart) || !Number.isInteger(missingEnd) || missingStart > missingEnd) return [];
    return buildPageUrls(threadBase, total).filter((url) => {
      const range = getExpectedRangeFromUrl(url);
      if (!range) return false;
      const end = Math.min(range.end, total);
      return range.start <= missingEnd && end >= missingStart;
    });
  }


  function getThreadIdentity(url) {
    try {
      const parsed = new URL(url, 'https://example.invalid/');
      const match = parsed.pathname.match(/^\/test\/read\.cgi\/([^/]+)\/(\d+)(?:\/|$)/);
      return match ? { board: match[1], threadId: match[2] } : null;
    } catch {
      return null;
    }
  }

  function parseReplyReference(href, anchorText, sourceUrl) {
    const current = getThreadIdentity(sourceUrl);
    if (!current) return 0;

    const text = String(anchorText || '').replace(/\u00a0/g, ' ').trim();
    const explicit = text.match(/^(?:>>|＞＞)\s*(\d{1,5})$/);
    const bare = text.match(/^(\d{1,5})$/);

    let target;
    try {
      target = new URL(href || '', sourceUrl);
    } catch {
      return 0;
    }

    const targetThread = getThreadIdentity(target.href);
    const sameThread = Boolean(
      targetThread && targetThread.board === current.board && targetThread.threadId === current.threadId
    );

    // 別スレ・外部サイトのリンクは、表示文字が数字でも返信アンカー扱いしない。
    if (targetThread && !sameThread) return 0;
    if (!targetThread && /^(?:https?|ftp):$/i.test(target.protocol)) return 0;

    if (sameThread) {
      const q = target.searchParams.get('q');
      if (/^\d{1,5}$/.test(q || '')) {
        const number = Number(q);
        return number > 0 ? number : 0;
      }

      const hash = target.hash.match(/^#(?:r|res)?(\d{1,5})$/i);
      if (hash) {
        const number = Number(hash[1]);
        return number > 0 ? number : 0;
      }
    }

    if (explicit) {
      const number = Number(explicit[1]);
      return number > 0 ? number : 0;
    }

    // 雑談たぬきの本文内返信は「4」「7」のような数字だけのリンクになることがある。
    // 同一スレURL、#、空href、javascript: のようなローカル動作用リンクに限って許容する。
    const rawHref = String(href || '').trim();
    const localUiLink = sameThread || rawHref === '' || rawHref.startsWith('#') || target.protocol === 'javascript:';
    if (bare && localUiLink) {
      const number = Number(bare[1]);
      return number > 0 ? number : 0;
    }

    return 0;
  }

  function rectsShareVisualLine(a, b) {
    if (!a || !b) return false;
    const aTop = Number(a.top);
    const aBottom = Number(a.bottom);
    const bTop = Number(b.top);
    const bBottom = Number(b.bottom);
    if (![aTop, aBottom, bTop, bBottom].every(Number.isFinite)) return false;

    const aHeight = Math.max(0, Number.isFinite(Number(a.height)) ? Number(a.height) : aBottom - aTop);
    const bHeight = Math.max(0, Number.isFinite(Number(b.height)) ? Number(b.height) : bBottom - bTop);
    const overlap = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
    const minHeight = Math.max(1, Math.min(aHeight || aBottom - aTop, bHeight || bBottom - bTop));

    // 同じテキスト行なら高さのかなりの部分が重なる。境界が少し触れるだけの
    // 前後行を誤認しないよう、最低3pxかつ短い方の45%以上の重なりを要求する。
    return overlap >= Math.max(3, minHeight * 0.45);
  }

  function sanitizeFilename(value) {
    const cleaned = String(value || '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim();
    return cleaned || '雑談たぬき';
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatLocalTimestamp(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
  }

  function formatDisplayTimestamp(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function buildSnapshotFilename(title, total, date = new Date()) {
    const safeTitle = sanitizeFilename(title);
    return `${safeTitle}_全${total}レス_${formatLocalTimestamp(date)}.html`;
  }

  if (typeof window === 'undefined' && typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildPageUrls, getExpectedRangeFromUrl, parseHeaderCandidate, analyzeVisibleLayout, buildNeededPageUrls,
      parseReplyReference, rectsShareVisualLine, buildSnapshotFilename, sanitizeFilename, formatLocalTimestamp,
    };
    return;
  }

  const SCRIPT_ID = 'tanuki-all-responses';
  const BUTTON_ID = `${SCRIPT_ID}-button`;
  const SAVE_BUTTON_ID = `${SCRIPT_ID}-save-button`;
  const POPUP_ID = `${SCRIPT_ID}-popup`;
  const SNAPSHOT_META_ID = `${SCRIPT_ID}-snapshot-meta`;
  const FRAME_ID = `${SCRIPT_ID}-frame`;
  const MAX_PAGES = 150;
  const FRAME_TIMEOUT_MS = 7000;
  const FRAME_SETTLE_TIMEOUT_MS = 2600;
  const REQUEST_DELAY_MS = 120;

  const threadMatch = location.pathname.match(
    /^\/test\/read\.cgi\/([^/]+)\/(\d+)(?:\/|$)/
  );
  if (!threadMatch) return;

  const board = threadMatch[1];
  const threadId = threadMatch[2];
  const threadBase = `${location.origin}/test/read.cgi/${board}/${threadId}/`;

  let running = false;
  let completed = false;
  let abortController = null;
  let responseHeaderCache = null;
  let popupHideTimer = null;

  addStyles();
  addButton();
  addSaveButton();
  installAnchorInteractions();

  function addStyles() {
    if (document.getElementById(`${SCRIPT_ID}-style`)) return;

    const style = document.createElement('style');
    style.id = `${SCRIPT_ID}-style`;
    style.textContent = `
      #${BUTTON_ID}, #${SAVE_BUTTON_ID} {
        position: fixed;
        right: 14px;
        top: 14px;
        z-index: 2147483646;
        appearance: none;
        border: 1px solid rgba(0,0,0,.25);
        border-radius: 999px;
        padding: 9px 14px;
        background: #fff;
        color: #222;
        font: 600 14px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 3px 14px rgba(0,0,0,.18);
        cursor: pointer;
      }
      #${BUTTON_ID}:hover, #${SAVE_BUTTON_ID}:hover { filter: brightness(.97); }
      #${BUTTON_ID}:disabled, #${SAVE_BUTTON_ID}:disabled { opacity: .72; cursor: wait; }
      #${SAVE_BUTTON_ID} { top: 58px; }
      #${POPUP_ID} {
        position: fixed;
        z-index: 2147483647;
        display: none;
        max-width: min(560px, calc(100vw - 24px));
        max-height: min(520px, 62vh);
        overflow: auto;
        box-sizing: border-box;
        padding: 10px 12px;
        border: 1px solid rgba(0,0,0,.28);
        border-radius: 10px;
        background: rgba(255,255,250,.98);
        color: #111;
        box-shadow: 0 8px 30px rgba(0,0,0,.28);
        font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${POPUP_ID} img { max-width: 100%; height: auto; }
      #${FRAME_ID} {
        position: fixed !important;
        left: -10000px !important;
        top: 0 !important;
        width: 2px !important;
        height: 2px !important;
        opacity: 0 !important;
        pointer-events: none !important;
        border: 0 !important;
      }
    `;
    document.head.appendChild(style);
  }

  function addButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '全レス表示';
    button.addEventListener('click', onButtonClick);
    document.body.appendChild(button);
  }


  function addSaveButton() {
    if (document.getElementById(SAVE_BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = SAVE_BUTTON_ID;
    button.type = 'button';
    button.textContent = 'HTML保存';
    button.disabled = true;
    button.title = '全レス表示が完了すると保存できます';
    button.addEventListener('click', onSaveButtonClick);
    document.body.appendChild(button);
  }

  async function onButtonClick() {
    if (running || completed) return;

    const total = getTotalCount(document);
    if (!total) {
      alert('総レス数を取得できなかった。雑談たぬき側のページ構造が変わった可能性があります。');
      return;
    }

    const liveHeaders = findResponseHeaders(document, location.href, null);
    if (!liveHeaders.length) {
      alert('現在ページのレス見出しを検出できませんでした。');
      return;
    }

    const visibleNumbers = [...new Set(liveHeaders.map((item) => item.number))].sort((a, b) => a - b);
    const layout = analyzeVisibleLayout(visibleNumbers, total);
    if (!layout) {
      alert('現在ページのレス配置を安全に解析できませんでした。1レス目と最新レスが見える通常のスレ画面から実行してください。');
      return;
    }
    if (layout.complete) {
      markCompleted(total);
      return;
    }

    const { prefixEnd, suffixStart, missingStart, missingEnd } = layout;
    const pageUrls = buildNeededPageUrls(threadBase, total, missingStart, missingEnd);

    if (!pageUrls.length || pageUrls.length > MAX_PAGES) {
      alert(`ページ数が想定範囲外です（${pageUrls.length}ページ）。処理を中止しました。`);
      return;
    }

    const button = document.getElementById(BUTTON_ID);
    const frame = ensureHiddenFrame();
    const combined = document.createDocumentFragment();
    const foundNumbers = new Set(visibleNumbers);

    running = true;
    abortController = new AbortController();
    button.disabled = true;
    button.textContent = `全レス取得中 0/${pageUrls.length}`;

    try {
      for (let i = 0; i < pageUrls.length; i++) {
        if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');

        const url = pageUrls[i];
        const expected = getExpectedRangeFromUrl(url);
        button.textContent = `全レス取得中 ${i + 1}/${pageUrls.length}`;

        let pageDoc;
        try {
          pageDoc = await loadRenderedDocument(frame, url, expected, total, abortController.signal);
        } catch (frameError) {
          console.warn('[雑談たぬき 全レス表示] iframe取得に失敗。fetchへフォールバックします。', frameError);
          pageDoc = await fetchDocument(url, abortController.signal);
        }

        const extracted = extractNativeFragment(pageDoc, url, missingStart, missingEnd, total);
        if (!extracted.fragment || !extracted.numbers.length) {
          throw new Error(`${expected?.start ?? '?'}番付近のネイティブHTMLを抽出できませんでした。`);
        }

        for (const number of extracted.numbers) foundNumbers.add(number);
        combined.appendChild(document.importNode(extracted.fragment, true));

        if (i < pageUrls.length - 1) await sleep(REQUEST_DELAY_MS);
      }

      const missing = [];
      for (let number = 1; number <= total; number++) {
        if (!foundNumbers.has(number)) missing.push(number);
      }

      if (missing.length) {
        const sample = missing.slice(0, 12).join(', ');
        throw new Error(`全${total}件のうち ${missing.length}件を確認できませんでした（例: ${sample}）。ページにはまだ追加していません。`);
      }

      // 取得が全部成功してから一括挿入する。途中失敗で元ページを半端に壊さないため。
      const refreshedHeaders = findResponseHeaders(document, location.href, null);
      const refreshedAnchors = refreshedHeaders.map((item) => item.anchor);
      let insertionBoundary = null;

      if (suffixStart !== null) {
        // 「1 + 最新15件」の通常表示では、欠けている中間レスを最新レス群の直前へ差し込む。
        const suffixHeader = refreshedHeaders.find((item) => item.number === suffixStart);
        if (!suffixHeader) throw new Error(`挿入位置となる${suffixStart}番レスを見失いました。`);
        insertionBoundary = findPostStartNode(suffixHeader.anchor, refreshedAnchors);
      } else {
        // 末尾側のレスがまだ表示されていない画面なら、連続表示済みの最後のレスの後ろへ追加する。
        const prefixHeader = refreshedHeaders.find((item) => item.number === prefixEnd);
        if (!prefixHeader) throw new Error(`挿入位置となる${prefixEnd}番レスを見失いました。`);
        insertionBoundary = findFooterBoundaryAfter(prefixHeader.anchor, refreshedAnchors);
      }

      if (!insertionBoundary?.parentNode) {
        throw new Error('レスを差し込む位置を特定できませんでした。');
      }

      insertionBoundary.parentNode.insertBefore(combined, insertionBoundary);
      invalidateResponseHeaderCache();
      markCompleted(total);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('[雑談たぬき 全レス表示]', error);
        alert(`全レス表示に失敗しました。\n${error?.message ?? error}`);
      }
    } finally {
      running = false;
      abortController = null;
      frame.remove();
      if (!completed) {
        button.disabled = false;
        button.textContent = '全レス表示';
      }
    }
  }

  function markCompleted(total) {
    completed = true;
    invalidateResponseHeaderCache();

    const button = document.getElementById(BUTTON_ID);
    if (button) {
      button.disabled = true;
      button.textContent = `全${total}レス表示済み`;
      button.title = 'ページを再読み込みすると元の表示に戻ります';
    }

    const saveButton = document.getElementById(SAVE_BUTTON_ID);
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.title = '現在の全レス表示を静的HTMLとして保存します';
    }
  }

  function getTotalCount(doc) {
    const text = doc.body?.innerText ?? doc.body?.textContent ?? '';
    const pageInfo = text.match(/\d+\s*\/\s*\d+\s*頁\s*[（(]\s*(\d+)\s*件\s*[)）]/);
    if (pageInfo) return Number(pageInfo[1]);
    const fallback = text.match(/[（(]\s*(\d+)\s*件\s*[)）]/);
    return fallback ? Number(fallback[1]) : 0;
  }

  function findResponseHeaders(root, sourceUrl, expectedRange) {
    const anchors = [...root.querySelectorAll('a')];
    const results = [];
    const seen = new Set();

    for (const anchor of anchors) {
      const following = collectFollowingLineText(anchor, 100);
      const number = parseHeaderCandidate(
        anchor.getAttribute('href'),
        anchor.textContent,
        following,
        sourceUrl
      );
      if (!number || seen.has(number)) continue;
      if (expectedRange && (number < expectedRange.start || number > expectedRange.end)) continue;

      seen.add(number);
      results.push({ number, anchor });
    }

    results.sort((a, b) => compareDocumentOrder(a.anchor, b.anchor));
    return results;
  }

  function compareDocumentOrder(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & 4) return -1; // DOCUMENT_POSITION_FOLLOWING
    if (pos & 2) return 1;  // DOCUMENT_POSITION_PRECEDING
    return 0;
  }

  function collectFollowingLineText(anchor, maxChars) {
    const root = anchor.ownerDocument?.body || anchor.ownerDocument?.documentElement;
    let node = nextAfterSubtree(anchor, root);
    let text = '';

    while (node && text.length < maxChars) {
      if (node.nodeType === 1) {
        const tag = node.tagName;
        if (tag === 'BR' || tag === 'HR') break;
        if (/^(DIV|P|LI|TR|TABLE|SECTION|ARTICLE|FORM|H[1-6])$/.test(tag) && text.trim()) break;
      } else if (node.nodeType === 3) {
        text += node.nodeValue || '';
      }
      node = nextNodePreorder(node, root);
    }

    return text.slice(0, maxChars);
  }

  function nextAfterSubtree(node, root) {
    let current = node;
    while (current && current !== root) {
      if (current.nextSibling) return current.nextSibling;
      current = current.parentNode;
    }
    return null;
  }

  function nextNodePreorder(node, root) {
    if (node.firstChild) return node.firstChild;
    return nextAfterSubtree(node, root);
  }

  function findPostStartNode(header, allHeaders) {
    let node = header;
    while (node.parentElement && node.parentElement.tagName !== 'BODY' && node.parentElement.tagName !== 'HTML') {
      const parent = node.parentElement;
      let count = 0;
      for (const candidate of allHeaders) {
        if (parent.contains(candidate)) count++;
        if (count > 1) break;
      }
      if (count !== 1) break;
      node = parent;
    }
    return node;
  }

  function findFooterBoundaryAfter(lastHeader, allHeaders) {
    const doc = lastHeader.ownerDocument;
    const selectors = 'a, button, div, span, p, td, th, form, label, strong, b, font';
    const candidates = [];
    const patterns = [
      /^前のレスを取得/,
      /^取得中(?:\s*\.{0,3})?$/,
      /^もうすぐMax件を超えそう/i,
      /^レス数がMAXを超えた/i,
      /^次スレ作成/,
      /^\+?\d*件の新着レス/,
      /^関連スレ一覧/,
      /^投稿$/,
      /^録音(?:＆|&)公開の手順/,
      /^理由$/,
      /^削除依頼$/,
    ];

    for (const element of doc.querySelectorAll(selectors)) {
      if (!isAfterNode(element, lastHeader)) continue;
      const text = normalizeText(element.textContent);
      if (!text || text.length > 120) continue;
      if (patterns.some((pattern) => pattern.test(text))) candidates.push(element);
    }

    // 投稿フォームはテキストが変わっても比較的安定した最後の砦。
    if (!candidates.length) {
      for (const form of doc.querySelectorAll('form')) {
        if (isAfterNode(form, lastHeader)) {
          candidates.push(form);
          break;
        }
      }
    }

    if (!candidates.length) return null;
    candidates.sort(compareDocumentOrder);

    let boundary = candidates[0];
    while (boundary.parentElement && boundary.parentElement.tagName !== 'BODY') {
      const parent = boundary.parentElement;
      if (allHeaders.some((header) => parent.contains(header))) break;
      const text = normalizeText(parent.textContent);
      if (text.length > 320) break;
      boundary = parent;
    }
    return boundary;
  }

  function isAfterNode(node, reference) {
    if (node === reference) return false;
    return Boolean(reference.compareDocumentPosition(node) & 4);
  }

  function normalizeText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function extractNativeFragment(pageDoc, sourceUrl, wantedStart, wantedEnd, total) {
    const expected = getExpectedRangeFromUrl(sourceUrl);
    if (!expected) return { fragment: null, numbers: [] };

    const allPageHeaders = findResponseHeaders(pageDoc, sourceUrl, expected);
    const headers = allPageHeaders.filter(
      (item) => item.number >= wantedStart && item.number <= wantedEnd && item.number <= total
    );
    if (!headers.length) return { fragment: null, numbers: [] };

    const headerElements = allPageHeaders.map((item) => item.anchor);
    const first = headers[0];
    const last = headers.at(-1);
    const startNode = findPostStartNode(first.anchor, headerElements);

    const lastIndex = allPageHeaders.findIndex((item) => item.anchor === last.anchor);
    const nextHeader = lastIndex >= 0 ? allPageHeaders[lastIndex + 1] : null;
    const endBoundary = nextHeader
      ? findPostStartNode(nextHeader.anchor, headerElements)
      : findFooterBoundaryAfter(last.anchor, headerElements);

    if (!startNode || !endBoundary) {
      console.warn('[雑談たぬき 全レス表示] ネイティブ範囲の境界を検出できませんでした', {
        sourceUrl,
        first: first.number,
        last: last.number,
        hasStart: Boolean(startNode),
        hasEnd: Boolean(endBoundary),
      });
      return { fragment: null, numbers: [] };
    }

    const range = pageDoc.createRange();
    try {
      range.setStartBefore(startNode);
      range.setEndBefore(endBoundary);
    } catch (error) {
      console.warn('[雑談たぬき 全レス表示] Range作成に失敗', sourceUrl, error);
      return { fragment: null, numbers: [] };
    }

    const fragment = range.cloneContents();
    fragment.querySelectorAll?.('script, style, noscript').forEach((node) => node.remove());
    rewriteRelativeUrls(fragment, sourceUrl);

    const numbers = headers.map((item) => item.number);
    return { fragment, numbers };
  }

  function rewriteRelativeUrls(root, sourceUrl) {
    for (const element of root.querySelectorAll?.('[href], [src]') || []) {
      for (const attr of ['href', 'src']) {
        const raw = element.getAttribute(attr);
        if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('data:')) continue;

        try {
          const absolute = new URL(raw, sourceUrl);
          if (attr === 'href' && absolute.origin === location.origin) {
            const q = absolute.searchParams.get('q');
            if (/^\d{1,5}$/.test(q || '')) {
              element.setAttribute('href', `${threadBase}i?q=${q}`);
              continue;
            }
          }
          element.setAttribute(attr, absolute.href);
        } catch {
          // URLとして解釈できない属性は元のまま。
        }
      }
    }
  }


  function invalidateResponseHeaderCache() {
    responseHeaderCache = null;
  }

  function getResponseHeaderCache() {
    if (responseHeaderCache) return responseHeaderCache;
    const headers = findResponseHeaders(document, location.href, null);
    responseHeaderCache = {
      headers,
      byNumber: new Map(headers.map((item) => [item.number, item])),
      headerSet: new Set(headers.map((item) => item.anchor)),
    };
    return responseHeaderCache;
  }

  function installAnchorInteractions() {
    document.addEventListener('mouseover', onReferenceMouseOver, true);
    document.addEventListener('mouseout', onReferenceMouseOut, true);
  }

  function getReferenceAnchorFromEvent(event) {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return target.closest('a');
  }

  function isHeaderMetaNumberAnchor(anchor, cache) {
    if (!anchor || !cache) return false;
    const text = String(anchor.textContent || '').replace(/\u00a0/g, ' ').trim();
    if (!/^\d{1,5}$/.test(text)) return false;

    // 返信数（💭の横の数字など）は、レス番号・日時と同じ見出し行に置かれる。
    // アイコン文字そのものには依存せず、直前のレス見出しとの視覚行の重なりで除外する。
    let previousHeader = null;
    for (const item of cache.headers) {
      if (item.anchor === anchor) return true;
      const position = item.anchor.compareDocumentPosition(anchor);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        previousHeader = item.anchor;
        continue;
      }
      if (position & Node.DOCUMENT_POSITION_PRECEDING) break;
    }
    if (!previousHeader) return false;

    return rectsShareVisualLine(anchor.getBoundingClientRect(), previousHeader.getBoundingClientRect());
  }

  function getReferenceNumber(anchor) {
    if (!anchor) return 0;
    const cache = getResponseHeaderCache();
    if (cache.headerSet.has(anchor)) return 0;
    const number = parseReplyReference(anchor.getAttribute('href'), anchor.textContent, location.href);
    if (!cache.byNumber.has(number)) return 0;
    if (isHeaderMetaNumberAnchor(anchor, cache)) return 0;
    return number;
  }

  function onReferenceMouseOver(event) {
    const anchor = getReferenceAnchorFromEvent(event);
    if (!anchor || document.getElementById(POPUP_ID)?.contains(anchor)) return;
    if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return;

    const number = getReferenceNumber(anchor);
    if (!number) return;
    showReferencePopup(anchor, number);
  }

  function onReferenceMouseOut(event) {
    const anchor = getReferenceAnchorFromEvent(event);
    if (!anchor) return;
    if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return;
    schedulePopupHide();
  }

  function ensureReferencePopup() {
    let popup = document.getElementById(POPUP_ID);
    if (popup) return popup;

    popup = document.createElement('div');
    popup.id = POPUP_ID;
    popup.setAttribute('role', 'tooltip');
    popup.addEventListener('mouseenter', cancelPopupHide);
    popup.addEventListener('mouseleave', schedulePopupHide);
    document.body.appendChild(popup);
    return popup;
  }

  function cloneResponseForPopup(number) {
    const cache = getResponseHeaderCache();
    const item = cache.byNumber.get(number);
    if (!item) return null;

    const index = cache.headers.indexOf(item);
    const headerElements = cache.headers.map((entry) => entry.anchor);
    const startNode = findPostStartNode(item.anchor, headerElements);
    const next = cache.headers[index + 1];
    const endBoundary = next
      ? findPostStartNode(next.anchor, headerElements)
      : findFooterBoundaryAfter(item.anchor, headerElements);
    if (!startNode || !endBoundary) return null;

    const range = document.createRange();
    try {
      range.setStartBefore(startNode);
      range.setEndBefore(endBoundary);
    } catch {
      return null;
    }

    const fragment = range.cloneContents();
    fragment.querySelectorAll?.('script, style, noscript, iframe').forEach((node) => node.remove());
    return fragment;
  }

  function showReferencePopup(anchor, number) {
    cancelPopupHide();
    const fragment = cloneResponseForPopup(number);
    if (!fragment) return;

    const popup = ensureReferencePopup();
    popup.replaceChildren(fragment);
    popup.style.visibility = 'hidden';
    popup.style.display = 'block';

    requestAnimationFrame(() => {
      const rect = anchor.getBoundingClientRect();
      const width = popup.offsetWidth;
      const height = popup.offsetHeight;
      const margin = 12;
      let left = Math.min(Math.max(margin, rect.left), Math.max(margin, innerWidth - width - margin));
      let top = rect.bottom + 8;
      if (top + height > innerHeight - margin) top = Math.max(margin, rect.top - height - 8);

      popup.style.left = `${Math.round(left)}px`;
      popup.style.top = `${Math.round(top)}px`;
      popup.style.visibility = 'visible';
    });
  }

  function cancelPopupHide() {
    if (popupHideTimer !== null) {
      clearTimeout(popupHideTimer);
      popupHideTimer = null;
    }
  }

  function schedulePopupHide() {
    cancelPopupHide();
    popupHideTimer = setTimeout(hideReferencePopup, 180);
  }

  function hideReferencePopup() {
    cancelPopupHide();
    const popup = document.getElementById(POPUP_ID);
    if (popup) popup.style.display = 'none';
  }

  async function onSaveButtonClick() {
    if (!completed) {
      alert('先に「全レス表示」を完了してください。');
      return;
    }

    const button = document.getElementById(SAVE_BUTTON_ID);
    const total = getTotalCount(document);
    const savedAt = new Date();
    if (!button || !total) return;

    button.disabled = true;
    button.textContent = '保存中...';
    try {
      const html = createStaticSnapshotHtml(document, total, location.href, savedAt);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      const downloader = document.createElement('a');
      downloader.href = objectUrl;
      downloader.download = buildSnapshotFilename(document.title, total, savedAt);
      downloader.style.display = 'none';
      document.body.appendChild(downloader);
      downloader.click();
      downloader.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    } catch (error) {
      console.error('[雑談たぬき 全レス表示] HTML保存', error);
      alert(`HTML保存に失敗しました。\n${error?.message ?? error}`);
    } finally {
      button.disabled = false;
      button.textContent = 'HTML保存';
    }
  }

  function createStaticSnapshotHtml(doc, total, sourceUrl, savedAt) {
    const root = doc.documentElement.cloneNode(true);

    // 実行コードや一時UIは保存しない。保存物は読むだけの静的スナップショットにする。
    root.querySelectorAll('script, noscript, iframe').forEach((node) => node.remove());
    for (const id of [BUTTON_ID, SAVE_BUTTON_ID, FRAME_ID, POPUP_ID, `${SCRIPT_ID}-style`]) {
      root.querySelector(`#${id}`)?.remove();
    }

    for (const element of root.querySelectorAll('*')) {
      for (const attr of [...element.attributes]) {
        if (/^on/i.test(attr.name)) element.removeAttribute(attr.name);
      }
    }

    const head = root.querySelector('head');
    if (head) {
      head.querySelectorAll('meta[charset], meta[http-equiv="Content-Type" i], base').forEach((node) => node.remove());

      const charset = doc.createElement('meta');
      charset.setAttribute('charset', 'utf-8');
      head.insertBefore(charset, head.firstChild);

      const base = doc.createElement('base');
      base.href = sourceUrl;
      head.insertBefore(base, charset.nextSibling);

      const title = head.querySelector('title');
      if (title) title.textContent = `${doc.title} [全${total}レス保存]`;
    }

    const body = root.querySelector('body');
    if (body) {
      const meta = doc.createElement('div');
      meta.id = SNAPSHOT_META_ID;
      meta.style.cssText = 'margin:8px;padding:8px 10px;border:1px solid #999;background:#fff;color:#222;font:12px/1.5 system-ui,sans-serif;white-space:pre-wrap;';
      meta.textContent = `保存元: ${sourceUrl}\n保存日時: ${formatDisplayTimestamp(savedAt)}\n保存レス数: ${total}`;
      body.insertBefore(meta, body.firstChild);
    }

    return `<!DOCTYPE html>\n${root.outerHTML}`;
  }

  function ensureHiddenFrame() {
    document.getElementById(FRAME_ID)?.remove();
    const frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.tabIndex = -1;
    document.body.appendChild(frame);
    return frame;
  }

  async function loadRenderedDocument(frame, url, expectedRange, total, signal) {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        frame.removeEventListener('load', onLoad);
        frame.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onLoad = () => finish(resolve);
      const onError = () => finish(reject, new Error(`iframeの読み込みに失敗: ${url}`));
      const onAbort = () => finish(reject, new DOMException('Aborted', 'AbortError'));
      const timeout = setTimeout(() => finish(reject, new Error(`iframeの読み込みがタイムアウト: ${url}`)), FRAME_TIMEOUT_MS);

      frame.addEventListener('load', onLoad, { once: true });
      frame.addEventListener('error', onError, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      frame.src = url;
    });

    let doc;
    try {
      doc = frame.contentDocument;
      // X-Frame-Options等で実体を読めない場合はフォールバックへ。
      if (!doc?.body) throw new Error('iframeのdocumentを取得できませんでした。');
    } catch (error) {
      throw new Error(`iframe内容へアクセスできません: ${error?.message ?? error}`);
    }

    await waitForResponseHeaders(doc, url, expectedRange, total, signal);
    return doc;
  }

  async function waitForResponseHeaders(doc, sourceUrl, expectedRange, total, signal) {
    const expectedCount = expectedRange
      ? Math.max(0, Math.min(expectedRange.end, total) - expectedRange.start + 1)
      : 1;
    const started = Date.now();
    let lastCount = -1;
    let stableTicks = 0;

    while (Date.now() - started < FRAME_SETTLE_TIMEOUT_MS) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const count = findResponseHeaders(doc, sourceUrl, expectedRange).length;

      if (count >= expectedCount && expectedCount > 0) return;
      if (count > 0 && count === lastCount) stableTicks++;
      else stableTicks = 0;
      if (count > 0 && stableTicks >= 3) return;

      lastCount = count;
      await sleep(90);
    }

    const finalCount = findResponseHeaders(doc, sourceUrl, expectedRange).length;
    if (!finalCount) throw new Error(`レスDOMが現れませんでした: ${sourceUrl}`);
  }

  async function fetchDocument(url, signal) {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);

    const buffer = await response.arrayBuffer();
    const charset = detectCharset(response.headers.get('content-type'));
    const html = decodeHtml(buffer, charset);
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function detectCharset(contentType) {
    const fromHeader = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
    return normalizeCharset(fromHeader || document.characterSet || 'shift_jis');
  }

  function normalizeCharset(charset) {
    const value = String(charset).toLowerCase().replace(/[_\s]/g, '-');
    if (/^(shift-jis|shiftjis|sjis|windows-31j|cp932|ms932)$/.test(value)) return 'shift_jis';
    if (/^(euc-jp|eucjp)$/.test(value)) return 'euc-jp';
    if (/^utf-?8$/.test(value)) return 'utf-8';
    return value;
  }

  function decodeHtml(buffer, preferredCharset) {
    const candidates = [...new Set([preferredCharset, 'shift_jis', 'utf-8'])];
    let best = '';
    let bestScore = -Infinity;

    for (const charset of candidates) {
      try {
        const text = new TextDecoder(charset).decode(buffer);
        const score = scoreDecodedText(text);
        if (score > bestScore) {
          best = text;
          bestScore = score;
        }
      } catch {
        // 次候補へ。
      }
    }

    if (!best) throw new Error('HTMLの文字コードを判定できませんでした。');
    return best;
  }

  function scoreDecodedText(text) {
    let score = 0;
    if (text.includes('雑談たぬき')) score += 100;
    if (text.includes('頁')) score += 30;
    if (text.includes('件')) score += 20;
    if (text.includes('レス')) score += 20;
    score -= (text.match(/�/g) || []).length * 5;
    return score;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
