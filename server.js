import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = resolve('public');
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const SEARCH_MODEL = process.env.OPENAI_SEARCH_MODEL || 'gpt-4o-mini-search-preview';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 60000);
const OPENAI_MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES || 2);
const REVIEW_LABEL = 'Пересмотр';
const GENERIC_CATEGORY_KEYS = new Set([
  'аудио',
  'аксессуары',
  'электроника',
  'периферия',
  'компоненты',
  'техника',
  'оборудование',
  'прочее',
  'разное',
  'другое',
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function loadEnvFile() {
  const envPath = resolve('.env');
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      return serveStatic(res, 'index.html');
    }

    if (req.method === 'GET' && req.url === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/api/clean') {
      const body = await readJsonBody(req);
      const result = await processCsvJob(body);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && req.url?.startsWith('/')) {
      const maybeAsset = req.url.slice(1);
      if (maybeAsset) {
        return serveStatic(res, maybeAsset);
      }
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown server error';
    sendJson(res, 400, { ok: false, error: message });
  }
}).listen(PORT, () => {
  console.log(`CSV cleaner running at http://localhost:${PORT}`);
});

async function processCsvJob(body) {
  const filename = sanitizeFilename(body?.filename || 'price-list.csv');
  const content = typeof body?.content === 'string' ? body.content : '';

  if (!content.trim()) {
    throw new Error('CSV content is empty.');
  }

  if (Buffer.byteLength(content, 'utf8') > MAX_BODY_BYTES) {
    throw new Error('CSV content is too large for this demo server.');
  }

  const analysis = parseCsvDocument(content);
  const stats = {
    originalRows: analysis.rows.length + (analysis.hadHeader ? 1 : 0),
    originalColumns: analysis.columnCount,
    removedPreambleRows: 0,
    removedEmptyRows: 0,
    removedDuplicates: 0,
    aiBatches: 0,
    categoryInferred: 0,
    reviewRows: 0,
    finalRows: 0,
    warnings: [],
  };

  const strippedAnalysis = stripLeadingPreambleRows(analysis);
  stats.removedPreambleRows += strippedAnalysis.removedPreambleRows;

  const locallyCleaned = cleanRowsLocally(strippedAnalysis.document);
  stats.removedEmptyRows = locallyCleaned.removedEmptyRows;
  stats.removedDuplicates = locallyCleaned.removedDuplicates;

  let finalDocument = locallyCleaned.document;
  if (OPENAI_API_KEY) {
    const aiResult = await cleanWithOpenAI(locallyCleaned.document);
    stats.aiBatches = aiResult.batches;
    if (aiResult.warning) {
      stats.warnings.push(aiResult.warning);
    }
    if (aiResult.document) {
      finalDocument = aiResult.document;
    }
  } else {
    stats.warnings.push('OPENAI_API_KEY is not set. Only local cleanup was applied.');
  }

  const strippedFinal = stripLeadingPreambleRows(finalDocument);
  stats.removedPreambleRows += strippedFinal.removedPreambleRows;
  finalDocument = strippedFinal.document;

  const categoryResult = await enrichCategoriesAndBuildReview(finalDocument);
  finalDocument = categoryResult.document;
  stats.categoryInferred = categoryResult.categoryInferred;
  stats.reviewRows = categoryResult.reviewRows.length;
  if (categoryResult.warning) {
    stats.warnings.push(categoryResult.warning);
  }

  stats.finalRows = finalDocument.rows.length;
  const previewHeader = finalDocument.hadHeader ? finalDocument.header : null;
  const tableRows = finalDocument.hadHeader ? finalDocument.rows.slice(1) : finalDocument.rows.slice();
  const previewRows = tableRows.slice(0, 10);
  const reviewHeader = categoryResult.reviewHeader;
  const reviewRows = categoryResult.reviewRows.slice(0, 200);
  const cleanedCsv = serializeCsv(finalDocument.rows, finalDocument.delimiter);
  const cleanedFilename = buildCleanFilename(filename);

  return {
    ok: true,
    filename: cleanedFilename,
    delimiter: finalDocument.delimiter,
    hadHeader: finalDocument.hadHeader,
    previewHeader,
    stats,
    previewRows,
    tableRows,
    reviewHeader,
    reviewRows,
    cleanedCsv,
  };
}

async function cleanWithOpenAI(document) {
  const hasHeader = Boolean(document.hadHeader && document.rows.length);
  const headerRow = hasHeader ? normalizeRow(document.rows[0], document.columnCount || document.rows[0].length) : null;
  const bodyRows = hasHeader ? document.rows.slice(1) : document.rows.slice();
  const batches = chunkRows(bodyRows, 30);
  const cleanedRows = [];
  let batchCount = 0;
  let lastWarning = '';

  for (const batch of batches) {
    batchCount += 1;
    const response = await callOpenAIForBatch({
      delimiter: document.delimiter,
      hadHeader: false,
      header: null,
      rows: batch,
    });

    if (response.warning) {
      lastWarning = response.warning;
    }

    if (Array.isArray(response.rows) && response.rows.length) {
      cleanedRows.push(...response.rows);
    } else {
      cleanedRows.push(...batch);
    }
  }

  return {
    batches: batchCount,
    warning: lastWarning,
    document: {
      delimiter: document.delimiter,
      hadHeader: hasHeader,
      header: headerRow,
      rows: hasHeader ? [headerRow, ...cleanedRows] : cleanedRows,
      columnCount: document.columnCount,
    },
  };
}

async function enrichCategoriesAndBuildReview(document) {
  const hasHeader = Boolean(document.hadHeader && document.rows.length);
  const headerRow = hasHeader ? normalizeRow(document.rows[0], document.columnCount || document.rows[0].length) : null;
  const bodyRows = hasHeader ? document.rows.slice(1) : document.rows.slice();
  const columnCount = Math.max(
    document.columnCount || 0,
    headerRow?.length || 0,
    ...bodyRows.map((row) => row.length),
  );
  const normalizedHeader = hasHeader ? normalizeRow(headerRow, columnCount) : null;
  const normalizedRows = bodyRows.map((row) => normalizeRow(row, columnCount));
  const columnMap = inferColumnMap(normalizedHeader, columnCount);
  const categoryRequests = [];
  let warning = '';
  let categoryInferred = 0;

  normalizedRows.forEach((row, index) => {
    const context = buildRowContext(row, columnMap);
    if (columnMap.category !== null) {
      const currentCategory = normalizeCategoryLabel(context.category);
      const localCategory = inferCategoryLocally(context.name, currentCategory || context.category);
      const resolvedBeforeAi = resolveCategoryForRow(context.category, null, localCategory);
      if (resolvedBeforeAi && resolvedBeforeAi !== context.category) {
        row[columnMap.category] = resolvedBeforeAi;
        categoryInferred += 1;
      }
    }

    if (!shouldInferCategory(context, columnMap)) {
      return;
    }

    categoryRequests.push({
      index,
      name: context.name,
      currentCategory: context.category,
      supplier: context.supplier,
      article: context.article,
      price: context.price,
      quantity: context.quantity,
      currency: context.currency,
    });
  });

  if (categoryRequests.length) {
    const categoryResult = OPENAI_API_KEY
      ? await inferCategoriesWithOpenAI(categoryRequests)
      : { suggestions: new Map(), warning: '' };

    warning = categoryResult.warning || '';

    for (const request of categoryRequests) {
      const targetRow = normalizedRows[request.index];
      const currentContext = buildRowContext(targetRow, columnMap);
      const aiSuggestion = categoryResult.suggestions.get(request.index);
      const fallbackCategory = inferCategoryLocally(request.name, request.currentCategory);
      const resolvedCategory = resolveCategoryForRow(
        currentContext.category,
        aiSuggestion,
        fallbackCategory,
      );

      if (!resolvedCategory) {
        continue;
      }

      if (columnMap.category !== null && columnMap.category < targetRow.length) {
        if (isMissingCategory(currentContext.category) || isGenericCategory(currentContext.category)) {
          targetRow[columnMap.category] = resolvedCategory;
          categoryInferred += 1;
        }
      }
    }
  }

  const reviewHeader = hasHeader
    ? [...normalizedHeader, REVIEW_LABEL]
    : [...Array.from({ length: columnCount }, (_, index) => `Колонка ${index + 1}`), REVIEW_LABEL];
  const mainRows = [];
  const reviewRows = [];
  fillUniformCurrency(normalizedRows, columnMap);
  for (const row of normalizedRows) {
    const context = buildRowContext(row, columnMap);
    const reasons = [];

    if (isMissingName(context.name)) {
      reasons.push('пустое наименование');
    }

    if (isMissingPrice(context.price)) {
      reasons.push('цена не указана');
    }

    if (isMissingQuantity(context.quantity)) {
      reasons.push('количество не указано');
    }

    if (isMissingSupplier(context.supplier)) {
      reasons.push('поставщик не указан');
    }

    if (isLikelyPersonReference(context.name) || isLikelyPersonReference(context.supplier)) {
      reasons.push('похоже на человека');
    }

    if (reasons.length) {
      reviewRows.push([...row, `${REVIEW_LABEL}: ${reasons.join(', ')}`]);
      continue;
    }

    mainRows.push(row);
  }

  return {
    document: {
      delimiter: document.delimiter,
      hadHeader: hasHeader,
      header: normalizedHeader,
      rows: hasHeader ? [normalizedHeader, ...mainRows] : mainRows,
      columnCount,
    },
    reviewHeader,
    reviewRows,
    categoryInferred,
    warning,
  };
}

async function inferCategoriesWithOpenAI(requests) {
  const chunks = chunkRows(requests, 8);
  const suggestions = new Map();
  let warning = '';
  let offset = 0;

  for (const chunk of chunks) {
    const response = await callOpenAIForCategoryBatch(chunk);
    if (response.warning) {
      warning = response.warning;
    }

    for (const item of response.items || []) {
      if (typeof item.index !== 'number' || item.index < 0 || item.index >= chunk.length) {
        continue;
      }

      if (item.category) {
        suggestions.set(offset + item.index, {
          category: item.category,
          confidence: item.confidence ?? 0,
          note: item.note || '',
        });
      }
    }

    offset += chunk.length;
  }

  return { suggestions, warning };
}

async function callOpenAIForCategoryBatch(batchItems) {
  const systemPrompt = [
    'You identify the most likely product category for retail CSV rows.',
    'Use web search when needed to resolve the product from its name.',
    'Return only valid JSON.',
    'Do not explain anything.',
    'Do not change price, supplier, or article values.',
    'Prefer concise retail categories in Russian.',
    'If you are unsure, return null for the category and a low confidence score.',
  ].join(' ');

  const payload = {
    items: batchItems,
    instructions: {
      outputShape: {
        items: [
          {
            index: 'number',
            category: 'string or null',
            confidence: 'number between 0 and 1',
            note: 'short string',
          },
        ],
      },
      returnOnlyJSON: true,
    },
  };

  const requestBody = {
    model: SEARCH_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };

  let response;
  let lastError = '';
  for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt += 1) {
    try {
      response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }, OPENAI_TIMEOUT_MS);
      if (response.ok) {
        break;
      }
      const text = await response.text();
      lastError = `OpenAI category request failed (${response.status}): ${text.slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown OpenAI category request error';
    }
  }

  if (!response || !response.ok) {
    return {
      warning: '',
      items: [],
    };
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  const json = extractJsonObject(raw);
  const parsedItems = Array.isArray(json?.items) ? json.items : [];

  return {
    items: parsedItems
      .map((item) => ({
        index: Number(item?.index),
        category: normalizeCategoryLabel(item?.category),
        confidence: Number(item?.confidence) || 0,
        note: String(item?.note || '').trim(),
      }))
      .filter((item) => Number.isFinite(item.index)),
  };
}

function inferColumnMap(header, columnCount) {
  const normalizedHeader = Array.isArray(header) ? header.map((value) => normalizeKey(value)) : [];
  const fallback = {
    name: columnCount > 0 ? 0 : null,
    price: columnCount > 1 ? 1 : null,
    quantity: columnCount > 2 ? 2 : null,
    category: columnCount > 3 ? 3 : null,
    currency: columnCount > 4 ? 4 : null,
    supplier: columnCount > 5 ? 5 : null,
    article: columnCount > 6 ? 6 : null,
  };

  if (!normalizedHeader.length) {
    return fallback;
  }

  return {
    name: findHeaderIndex(normalizedHeader, ['наименование', 'название', 'товар', 'product', 'name']) ?? fallback.name,
    price: findHeaderIndex(normalizedHeader, ['цена', 'price', 'стоимость']) ?? fallback.price,
    quantity: findHeaderIndex(normalizedHeader, ['колво', 'quantity', 'qty', 'остаток', 'stock']) ?? fallback.quantity,
    category: findHeaderIndex(normalizedHeader, ['категория', 'category', 'тип']) ?? fallback.category,
    currency: findHeaderIndex(normalizedHeader, ['валюта', 'currency']) ?? fallback.currency,
    supplier: findHeaderIndex(normalizedHeader, ['поставщик', 'supplier', 'vendor']) ?? fallback.supplier,
    article: findHeaderIndex(normalizedHeader, ['артикул', 'sku', 'article', 'code']) ?? fallback.article,
  };
}

function findHeaderIndex(normalizedHeader, aliases) {
  for (const alias of aliases) {
    const normalizedAlias = normalizeKey(alias);
    const exactIndex = normalizedHeader.findIndex((value) => value === normalizedAlias);
    if (exactIndex !== -1) {
      return exactIndex;
    }

    const containsIndex = normalizedHeader.findIndex((value) => value && (value.includes(normalizedAlias) || normalizedAlias.includes(value)));
    if (containsIndex !== -1) {
      return containsIndex;
    }
  }
  return null;
}

function buildRowContext(row, columnMap) {
  return {
    name: getCellValue(row, columnMap.name),
    price: getCellValue(row, columnMap.price),
    quantity: getCellValue(row, columnMap.quantity),
    category: getCellValue(row, columnMap.category),
    currency: getCellValue(row, columnMap.currency),
    supplier: getCellValue(row, columnMap.supplier),
    article: getCellValue(row, columnMap.article),
  };
}

function getCellValue(row, index) {
  if (index === null || index === undefined || index < 0) {
    return '';
  }
  return normalizeTextValue(row?.[index] ?? '');
}

function shouldInferCategory(context, columnMap) {
  if (columnMap.category === null) {
    return false;
  }
  if (isMissingName(context.name)) {
    return false;
  }
  return isMissingCategory(context.category) || isGenericCategory(context.category);
}

function isMissingName(value) {
  return isBlankOrNullLike(value);
}

function isMissingPrice(value) {
  return isBlankOrNullLike(value);
}

function isMissingQuantity(value) {
  return isBlankOrNullLike(value);
}

function isMissingSupplier(value) {
  return isBlankOrNullLike(value);
}

function isMissingCategory(value) {
  return isBlankOrNullLike(value);
}

function isGenericCategory(value) {
  const key = normalizeKey(value);
  if (!key) {
    return false;
  }
  return GENERIC_CATEGORY_KEYS.has(key);
}

function isLikelyPersonReference(value) {
  const text = normalizeTextValue(value);
  if (!text) {
    return false;
  }

  const key = normalizeKey(text);
  const personHints = [
    'менеджер',
    'ассистент',
    'директор',
    'продавец',
    'кассир',
    'специалист',
    'сотрудник',
    'фио',
    'имя',
  ];

  if (personHints.some((hint) => key.includes(hint))) {
    return true;
  }

  if (/^[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}$/.test(text)) {
    return true;
  }

  return false;
}

function normalizeCategoryLabel(value) {
  const text = normalizeTextValue(value);
  if (!text) {
    return '';
  }

  const key = normalizeKey(text);
  const canonicalMappings = [
    { match: ['ноутбук', 'laptop', 'macbook'], value: 'Ноутбуки' },
    { match: ['смартфон', 'phone', 'iphone', 'galaxy', 'xiaomi', 'redmi', 'pixel', 'huawei', 'oneplus'], value: 'Смартфоны' },
    { match: ['наушник', 'headphone', 'earbud', 'airpods'], value: 'Наушники' },
    { match: ['мыш', 'mouse'], value: 'Мыши' },
    { match: ['клавиат', 'keyboard'], value: 'Клавиатуры' },
    { match: ['монитор', 'display'], value: 'Мониторы' },
    { match: ['планшет', 'tablet', 'ipad'], value: 'Планшеты' },
    { match: ['видеокарт', 'gpu', 'rtx', 'radeon'], value: 'Видеокарты' },
    { match: ['процессор', 'cpu', 'ryzen', 'intelcore'], value: 'Процессоры' },
    { match: ['материнск', 'motherboard'], value: 'Материнские платы' },
    { match: ['ssd', 'hdd', 'накопител'], value: 'Накопители' },
    { match: ['кабель', 'заряд', 'адаптер', 'usbhub', 'usbхаб', 'hub'], value: 'Аксессуары' },
    { match: ['камера', 'webcam'], value: 'Веб-камеры' },
  ];

  for (const mapping of canonicalMappings) {
    if (mapping.match.some((needle) => key.includes(needle))) {
      return mapping.value;
    }
  }

  if (/^[A-Z0-9\s-]+$/.test(text)) {
    return text;
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fillUniformCurrency(rows, columnMap) {
  if (columnMap.currency === null) {
    return 0;
  }

  const uniqueValues = new Set();
  for (const row of rows) {
    const value = normalizeCurrencyValue(row?.[columnMap.currency] ?? '');
    if (value) {
      uniqueValues.add(value);
    }
  }

  if (uniqueValues.size !== 1) {
    return 0;
  }

  const [currency] = uniqueValues;
  let filled = 0;
  for (const row of rows) {
    if (isBlankOrNullLike(row?.[columnMap.currency] ?? '')) {
      row[columnMap.currency] = currency;
      filled += 1;
    }
  }

  return filled;
}

function normalizeCurrencyValue(value) {
  return normalizeTextValue(value).toUpperCase();
}

function inferCategoryLocally(name, currentCategory) {
  const existing = normalizeCategoryLabel(currentCategory);
  if (existing && !isGenericCategory(existing) && !isMissingCategory(existing)) {
    return existing;
  }

  const text = normalizeKey(name);
  if (!text) {
    return '';
  }

  const mappings = [
    { match: ['ноутбук', 'laptop', 'xps', 'thinkpad', 'macbook'], value: 'Ноутбуки' },
    { match: ['наушник', 'headphone', 'earbud', 'wh1000', 'airpods'], value: 'Наушники' },
    { match: ['мыш', 'mouse', 'mxmaster'], value: 'Мыши' },
    { match: ['клавиат', 'keyboard', 'mxkeys'], value: 'Клавиатуры' },
    { match: ['монитор', 'display'], value: 'Мониторы' },
    { match: ['смартфон', 'iphone', 'galaxy', 'xiaomi', 'pixel', 'huawei'], value: 'Смартфоны' },
    { match: ['планшет', 'ipad', 'tablet'], value: 'Планшеты' },
    { match: ['usb', 'кабель', 'заряд', 'адаптер', 'хаб', 'hub'], value: 'Аксессуары' },
    { match: ['ssd', 'hdd', 'накопител'], value: 'Накопители' },
    { match: ['процессор', 'corei', 'ryzen'], value: 'Процессоры' },
    { match: ['видеокарт', 'rtx', 'gpu'], value: 'Видеокарты' },
    { match: ['материнск', 'motherboard'], value: 'Материнские платы' },
  ];

  for (const mapping of mappings) {
    if (mapping.match.some((needle) => text.includes(needle))) {
      return mapping.value;
    }
  }

  return '';
}

function resolveCategoryForRow(currentCategory, aiSuggestion, fallbackCategory) {
  const normalizedCurrent = normalizeCategoryLabel(currentCategory);
  const aiCategory = normalizeCategoryLabel(aiSuggestion?.category);
  const aiConfidence = Number(aiSuggestion?.confidence) || 0;
  const localCategory = normalizeCategoryLabel(fallbackCategory);

  if (aiCategory && !isGenericCategory(aiCategory) && aiConfidence >= 0.4) {
    return aiCategory;
  }

  if (localCategory && !isGenericCategory(localCategory)) {
    return localCategory;
  }

  if (aiCategory && !normalizedCurrent) {
    return aiCategory;
  }

  return normalizedCurrent;
}

function normalizeKey(value) {
  return normalizeTextValue(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '');
}

async function callOpenAIForBatch({ delimiter, hadHeader, header, rows }) {
  const systemPrompt = [
    'You clean CSV-like price list rows.',
    'Return only valid JSON.',
    'Do not explain anything.',
    'Keep the same number of columns in every row.',
    'Do not invent new rows.',
    'Ignore any leading text that is not part of the table, and never convert such text into data rows.',
    'Preserve business meaning.',
    'Trim whitespace, normalize obvious noise, normalize prices and numbers when safe, and keep the table structure intact.',
    'If something is ambiguous, leave the cell unchanged.',
  ].join(' ');

  const payload = {
    delimiter,
    hadHeader,
    header,
    rows,
    instructions: {
      outputShape: {
        header: hadHeader ? 'array of strings matching the original header length' : 'null',
        rows: 'array of arrays of strings with the same number of columns as the input rows',
      },
      returnOnlyJSON: true,
    },
  };

  const requestBody = {
    model: DEFAULT_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };

  let response;
  let lastError = '';
  for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt += 1) {
    try {
      response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }, OPENAI_TIMEOUT_MS);
      if (response.ok) {
        break;
      }
      const text = await response.text();
      lastError = `OpenAI request failed (${response.status}): ${text.slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown OpenAI request error';
    }
  }

  if (!response || !response.ok) {
    return {
      warning: lastError || 'OpenAI request failed. Local cleanup was used for this batch.',
      rows,
    };
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  const json = extractJsonObject(raw);

  if (!json) {
    return {
      warning: 'OpenAI returned an unparseable response. Local cleanup was used for this batch.',
      rows,
    };
  }

  const inferredColumns = Math.max(
    header?.length ?? 0,
    ...rows.map((row) => countMeaningfulCells(row)),
    0
  );
  const expectedColumns = inferredColumns || rows[0]?.length || 1;
  const normalizedHeader = hadHeader ? normalizeRow(json.header ?? header, expectedColumns) : null;
  const normalizedRows = Array.isArray(json.rows)
    ? json.rows.map((row) => normalizeRow(row, expectedColumns))
    : rows;

  return {
    rows: normalizedRows,
    header: normalizedHeader,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return null;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanRowsLocally(document) {
  const seen = new Set();
  const rows = [];
  let removedEmptyRows = 0;
  let removedDuplicates = 0;

  if (document.hadHeader && document.header) {
    rows.push(normalizeRow(document.header, document.columnCount));
  }

  for (const row of document.rows) {
    const normalized = normalizeRow(row, document.columnCount);
    if (isEmptyRow(normalized)) {
      removedEmptyRows += 1;
      continue;
    }

    const key = normalized.join('\u0001');
    if (seen.has(key)) {
      removedDuplicates += 1;
      continue;
    }

    seen.add(key);
    rows.push(normalized);
  }

  return {
    removedEmptyRows,
    removedDuplicates,
    document: {
      delimiter: document.delimiter,
      hadHeader: document.hadHeader,
      header: document.header,
      rows,
    },
  };
}

function parseCsvDocument(content) {
  const delimiter = detectDelimiter(content);
  const rows = stripLeadingPreambleRows({
    delimiter,
    hadHeader: false,
    header: null,
    rows: parseDelimitedRows(content, delimiter),
    columnCount: 0,
  }).document.rows;
  const columnCount = Math.max(...rows.map((row) => row.length), 0);
  const hadHeader = detectHeader(rows);

  if (hadHeader && rows.length) {
    const header = rows[0].slice();
    return {
      delimiter,
      hadHeader: true,
      header: normalizeRow(header, columnCount),
      rows: rows.slice(1).map((row) => normalizeRow(row, columnCount)),
      columnCount,
    };
  }

  return {
    delimiter,
    hadHeader: false,
    header: null,
    rows: rows.map((row) => normalizeRow(row, columnCount)),
    columnCount,
  };
}

function stripLeadingPreambleRows(document) {
  const sourceRows = Array.isArray(document.rows) ? document.rows : [];
  if (!sourceRows.length) {
    return { document, removedPreambleRows: 0 };
  }

  if (document.hadHeader) {
    const headerRow = sourceRows[0] || [];
    const bodyRows = sourceRows.slice(1);
    const bodyStartIndex = findTableStartIndex(bodyRows);
    if (bodyStartIndex <= 0) {
      return { document, removedPreambleRows: 0 };
    }

    return {
      document: {
        ...document,
        rows: [headerRow, ...bodyRows.slice(bodyStartIndex)],
      },
      removedPreambleRows: bodyStartIndex,
    };
  }

  const startIndex = findTableStartIndex(sourceRows);
  if (startIndex <= 0) {
    return { document, removedPreambleRows: 0 };
  }

  return {
    document: {
      ...document,
      rows: sourceRows.slice(startIndex),
    },
    removedPreambleRows: startIndex,
  };
}

function detectDelimiter(text) {
  const sampleLines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 12);
  const candidates = [',', ';', '\t', '|'];
  let winner = ',';
  let bestScore = -1;

  for (const delimiter of candidates) {
    let score = 0;
    for (const line of sampleLines) {
      score += countDelimiterOutsideQuotes(line, delimiter);
    }
    if (score > bestScore) {
      bestScore = score;
      winner = delimiter;
    }
  }

  return winner;
}

function countDelimiterOutsideQuotes(line, delimiter) {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === delimiter) {
      count += 1;
    }
  }
  return count;
}

function detectHeader(rows) {
  if (rows.length < 2) {
    return true;
  }

  const firstRow = rows[0];
  if (firstRow.length < 2) {
    return false;
  }

  const firstScore = firstRow.reduce((sum, cell) => sum + scoreHeaderLike(cell), 0) / firstRow.length;
  const sampleData = rows.slice(1, Math.min(rows.length, 6));
  const dataScore = sampleData.flat().reduce((sum, cell) => sum + scoreDataLike(cell), 0) / Math.max(sampleData.flat().length, 1);

  return firstScore >= 0.5 && firstScore >= dataScore;
}

function findTableStartIndex(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    if (!isProbablyTableRow(rows[index])) {
      continue;
    }

    let support = 0;
    const currentWidth = countMeaningfulCells(rows[index]);
    for (let offset = 1; offset <= 4 && index + offset < rows.length; offset += 1) {
      const nextRow = rows[index + offset];
      const nextWidth = countMeaningfulCells(nextRow);
      if (nextWidth >= 2 && Math.abs(nextWidth - currentWidth) <= 1 && isProbablyTableRow(nextRow)) {
        support += 1;
      }
    }

    if (support >= 1) {
      return index;
    }
  }

  return 0;
}

function isProbablyTableRow(row) {
  const cells = (row || []).map((value) => normalizeTextValue(value)).filter(Boolean);
  if (cells.length < 2) {
    return false;
  }

  const totalLength = cells.reduce((sum, cell) => sum + cell.length, 0);
  const averageLength = totalLength / cells.length;
  const hasNumericCell = cells.some((cell) => /[0-9]/.test(cell) || /[%$₽€£]/.test(cell));
  const shortCellCount = cells.filter((cell) => cell.length <= 25).length;

  return hasNumericCell || shortCellCount >= 2 || averageLength <= 25;
}

function countMeaningfulCells(row) {
  return (row || []).filter((value) => normalizeTextValue(value) !== '').length;
}

function scoreHeaderLike(value) {
  const text = normalizeTextValue(value);
  if (!text) {
    return 0;
  }
  const letters = (text.match(/[A-Za-zА-Яа-я]/g) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  return letters > digits ? 1 : 0;
}

function scoreDataLike(value) {
  const text = normalizeTextValue(value);
  if (!text) {
    return 0;
  }
  if (/^-?[\d\s.,]+(?:[%$₽€£])?$/.test(text)) {
    return 1;
  }
  return 0.25;
}

function parseDelimitedRows(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }

    if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);

  return rows.filter((currentRow, index) => index > 0 || currentRow.some((cellValue) => String(cellValue).trim() !== ''));
}

function normalizeRow(row, expectedColumns) {
  const normalized = Array.from({ length: expectedColumns }, (_, index) => normalizeTextValue(row?.[index] ?? ''));
  if (row && row.length > expectedColumns) {
    const overflow = row.slice(expectedColumns - 1).map((value) => normalizeTextValue(value)).join(' ');
    normalized[expectedColumns - 1] = normalizeTextValue([normalized[expectedColumns - 1], overflow].filter(Boolean).join(' '));
  }
  return normalized;
}

function normalizeTextValue(value) {
  return String(value ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBlankOrNullLike(value) {
  const text = normalizeTextValue(value);
  if (!text) {
    return true;
  }

  const normalized = text.toLowerCase();
  return normalized === 'null' || normalized === 'none' || normalized === 'nan';
}

function isEmptyRow(row) {
  return row.every((value) => isBlankOrNullLike(value));
}

function serializeCsv(rows, delimiter) {
  return rows.map((row) => row.map((cell) => escapeCsvCell(cell, delimiter)).join(delimiter)).join('\n');
}

function escapeCsvCell(value, delimiter) {
  const text = String(value ?? '');
  if (text === '') {
    return '';
  }
  if (text.includes('"') || text.includes('\n') || text.includes('\r') || text.includes(delimiter)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function chunkRows(rows, size) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function sanitizeFilename(filename) {
  return String(filename)
    .replace(/^[\\/]+/, '')
    .replace(/[<>:"|?*\u0000-\u001F]/g, '_')
    .trim() || 'price-list.csv';
}

function buildCleanFilename(filename) {
  const safe = sanitizeFilename(filename);
  const dotIndex = safe.lastIndexOf('.');
  if (dotIndex === -1) {
    return `${safe}_cleaned.csv`;
  }
  return `${safe.slice(0, dotIndex)}_cleaned${safe.slice(dotIndex)}`;
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('Request body is too large.');
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON request body.');
  }
}

async function serveStatic(res, relativePath) {
  const safePath = relativePath === 'index.html' ? 'index.html' : relativePath.replace(/\.\./g, '');
  const filePath = join(PUBLIC_DIR, safePath);
  const ext = extname(filePath).toLowerCase();
  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
