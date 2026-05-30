const fileInput = document.getElementById('fileInput');
const pickFileBtn = document.getElementById('pickFileBtn');
const processBtn = document.getElementById('processBtn');
const downloadBtn = document.getElementById('downloadBtn');
const previewBtn = document.getElementById('previewBtn');
const fileName = document.getElementById('fileName');
const statusText = document.getElementById('statusText');
const stats = document.getElementById('stats');
const warningBox = document.getElementById('warningBox');
const errorBox = document.getElementById('errorBox');
const inlinePreviewTable = document.getElementById('previewTable');
const previewSummary = document.getElementById('previewSummary');
const previewModal = document.getElementById('previewModal');
const closePreviewBtn = document.getElementById('closePreviewBtn');
const previewModalSummary = document.getElementById('previewModalSummary');
const reviewModalSummary = document.getElementById('reviewModalSummary');
const modalPreviewTable = document.getElementById('modalPreviewTable');
const reviewSection = document.getElementById('reviewSection');
const reviewPreviewTable = document.getElementById('reviewPreviewTable');
const dropzone = document.getElementById('dropzone');

let selectedFile = null;
let cleanedCsv = '';
let cleanedFilename = 'cleaned.csv';
let previewState = {
  header: null,
  rows: [],
  reviewHeader: null,
  reviewRows: [],
};

pickFileBtn.addEventListener('click', () => fileInput.click());
processBtn.addEventListener('click', processFile);
downloadBtn.addEventListener('click', downloadCleanedFile);
previewBtn.addEventListener('click', openPreviewModal);
closePreviewBtn.addEventListener('click', closePreviewModal);
fileInput.addEventListener('change', () => setSelectedFile(fileInput.files?.[0] || null));

previewModal.addEventListener('click', (event) => {
  if (event.target === previewModal || event.target.hasAttribute('data-modal-close')) {
    closePreviewModal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !previewModal.classList.contains('hidden')) {
    closePreviewModal();
  }
});

dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('dragging');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragging');
});

dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  const [file] = event.dataTransfer.files;
  if (file) {
    setSelectedFile(file);
  }
});

function setSelectedFile(file) {
  selectedFile = file;
  cleanedCsv = '';
  cleanedFilename = 'cleaned.csv';
  previewState = {
    header: null,
    rows: [],
    reviewHeader: null,
    reviewRows: [],
  };

  downloadBtn.disabled = true;
  previewBtn.disabled = true;
  processBtn.disabled = !file;
  fileName.textContent = file ? file.name : 'Файл не выбран';
  statusText.textContent = file ? 'Файл готов к обработке' : 'Ожидание загрузки';
  clearMessages();
  renderInlinePreview();
  renderStats(null);
  closePreviewModal();
}

async function processFile() {
  if (!selectedFile) {
    return;
  }

  setBusy(true);
  clearMessages();
  statusText.textContent = 'Чтение файла...';

  try {
    const content = await selectedFile.text();
    statusText.textContent = 'Отправка на сервер...';

    const response = await fetch('/api/clean', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: selectedFile.name,
        content,
      }),
    });

    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Не удалось обработать файл.');
    }

    cleanedCsv = payload.cleanedCsv;
    cleanedFilename = payload.filename;
    previewState = {
      header: payload.previewHeader || null,
      rows: payload.tableRows || payload.previewRows || [],
      reviewHeader: payload.reviewHeader || null,
      reviewRows: payload.reviewRows || [],
    };

    statusText.textContent = 'Очистка завершена';
    downloadBtn.disabled = false;
    previewBtn.disabled = previewState.rows.length === 0 && previewState.reviewRows.length === 0;

    renderStats(payload.stats);
    renderInlinePreview();
    renderModalPreview();

    if (payload.stats?.warnings?.length) {
      warningBox.textContent = payload.stats.warnings.join(' ');
      warningBox.classList.remove('hidden');
    }
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : 'Неизвестная ошибка.';
    errorBox.classList.remove('hidden');
    statusText.textContent = 'Ошибка обработки';
  } finally {
    setBusy(false);
  }
}

function setBusy(isBusy) {
  processBtn.disabled = isBusy || !selectedFile;
  pickFileBtn.disabled = isBusy;
  previewBtn.disabled = isBusy || (!previewState.rows.length && !previewState.reviewRows.length);
  dropzone.classList.toggle('busy', isBusy);
}

function renderStats(data) {
  if (!data) {
    stats.innerHTML = '';
    return;
  }

  const cards = [
    ['Исходных строк', data.originalRows ?? '0'],
    ['Итоговых строк', data.finalRows ?? '0'],
    ['Категорий уточнено', data.categoryInferred ?? '0'],
    ['Строк на проверку', data.reviewRows ?? '0'],
    ['Удалено пустых', data.removedEmptyRows ?? '0'],
    ['Удалено дублей', data.removedDuplicates ?? '0'],
    ['AI batches', data.aiBatches ?? '0'],
  ];

  stats.innerHTML = cards
    .map(
      ([label, value]) => `
        <div class="stat-card">
          <span>${label}</span>
          <strong>${value}</strong>
        </div>
      `,
    )
    .join('');
}

function renderInlinePreview() {
  renderTable(inlinePreviewTable, previewState.header, previewState.rows.slice(0, 10), {
    emptyText: 'Предпросмотр пока пуст',
  });

  previewSummary.textContent = previewState.rows.length
    ? `${previewState.rows.length} строк`
    : 'Нет данных';
}

function renderModalPreview() {
  renderTable(modalPreviewTable, previewState.header, previewState.rows, {
    emptyText: 'Таблица пока пуста',
  });

  renderTable(reviewPreviewTable, previewState.reviewHeader, previewState.reviewRows, {
    emptyText: 'Нет строк, требующих пересмотра',
  });

  reviewSection.classList.toggle('hidden', previewState.reviewRows.length === 0);
  previewModalSummary.textContent = previewState.rows.length
    ? `${previewState.rows.length} строк`
    : 'Нет данных';
  reviewModalSummary.textContent = previewState.reviewRows.length
    ? `${previewState.reviewRows.length} строк`
    : '0 строк';
}

function renderTable(tableElement, headerValues, rows, options = {}) {
  const tableHead = tableElement.querySelector('thead');
  const tableBody = tableElement.querySelector('tbody');
  const emptyText = options.emptyText || 'Нет данных';
  const maxRows = options.maxRows || null;

  tableHead.innerHTML = '';
  tableBody.innerHTML = '';

  const firstRowWidth = rows?.[0]?.length || 0;
  const columns = headerValues?.length || firstRowWidth;

  if (!columns) {
    tableBody.innerHTML = `<tr><td class="empty-state">${emptyText}</td></tr>`;
    return;
  }

  const theadRow = document.createElement('tr');
  for (let index = 0; index < columns; index += 1) {
    const th = document.createElement('th');
    th.textContent = headerValues?.[index] || `Колонка ${index + 1}`;
    theadRow.appendChild(th);
  }
  tableHead.appendChild(theadRow);

  const visibleRows = maxRows ? rows.slice(0, maxRows) : rows;
  if (!visibleRows.length) {
    tableBody.innerHTML = `<tr><td class="empty-state" colspan="${columns}">${emptyText}</td></tr>`;
    return;
  }

  for (const row of visibleRows) {
    const tr = document.createElement('tr');
    for (let index = 0; index < columns; index += 1) {
      const td = document.createElement('td');
      td.textContent = row?.[index] ?? '';
      tr.appendChild(td);
    }
    tableBody.appendChild(tr);
  }
}

function openPreviewModal() {
  if (!previewState.rows.length && !previewState.reviewRows.length) {
    return;
  }

  previewModal.classList.remove('hidden');
  previewModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  closePreviewBtn.focus();
}

function closePreviewModal() {
  previewModal.classList.add('hidden');
  previewModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function downloadCleanedFile() {
  if (!cleanedCsv) {
    return;
  }

  const blob = new Blob([cleanedCsv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = cleanedFilename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function clearMessages() {
  warningBox.textContent = '';
  warningBox.classList.add('hidden');
  errorBox.textContent = '';
  errorBox.classList.add('hidden');
}
