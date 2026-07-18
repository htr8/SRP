// charts-interop.js
const _charts = {};

window.focusElement = function (el) {
    if (el) el.focus();
};

// Document-level Escape handler for components that can't reliably receive focus
// (e.g. plans dropdown, which is inside overflow:hidden containers).
var _escapeHandler = null;
var _escapeHandlerFn = null;
window.srRegisterEscapeHandler = function (dotNetRef, methodName) {
    // Remove any previous handler first
    if (_escapeHandlerFn) document.removeEventListener('keydown', _escapeHandlerFn);
    _escapeHandler = dotNetRef;
    _escapeHandlerFn = function (e) {
        if (e.key === 'Escape') {
            dotNetRef.invokeMethodAsync(methodName);
        }
    };
    document.addEventListener('keydown', _escapeHandlerFn);
};
window.srUnregisterEscapeHandler = function () {
    if (_escapeHandlerFn) {
        document.removeEventListener('keydown', _escapeHandlerFn);
        _escapeHandlerFn = null;
        _escapeHandler = null;
    }
};

function normalizeFill(datasets) {
    return datasets.map(ds => ({
        ...ds,
        fill: ds.fill === "false" ? false : ds.fill === "true" ? true : ds.fill
    }));
}

const xAxis = {
    ticks: {
        color: '#6A8FAF',
        maxRotation: 0,
        autoSkip: true,
        autoSkipPadding: 20
    },
    grid: { color: 'rgba(30,144,255,0.08)' }
};

export async function createLineChart(canvasId, labels, datasets, options) {
    await window.ensureChartJs();
    datasets = normalizeFill(datasets);
    destroyChart(canvasId);
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const yFormat = options?.yFormat || 'dollar';

    const fmtDollar = v => v >= 1e6 ? '$'+(v/1e6).toFixed(1)+'M' : v >= 1e3 ? '$'+(v/1e3).toFixed(0)+'K' : '$'+Math.round(v);

    const yTickCallback = yFormat === 'percent'
        ? v => v.toFixed(0) + '%'
        : fmtDollar;

    const tooltipLabel = yFormat === 'percent'
        ? ctx => ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1) + '%'
        : ctx => ctx.dataset.label + ': $' + Math.round(ctx.parsed.y).toLocaleString();

    const tooltipCfg = { mode: 'index', intersect: false };
    tooltipCfg.callbacks = { label: tooltipLabel };

    _charts[canvasId] = new Chart(canvas, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            layout: { padding: { bottom: 0, left: 0, right: 8, top: 0 } },
            plugins: {
                legend: { display: true, labels: { color: '#8AAEC8', boxWidth: 12 } },
                tooltip: tooltipCfg
            },
            scales: {
                x: xAxis,
                y: {
                    ticks: {
                        color: '#6A8FAF',
                        callback: yTickCallback
                    },
                    grid: { color: 'rgba(30,144,255,0.08)' }
                }
            }
        }
    });
}

export async function createBarChart(canvasId, labels, datasets) {
    await window.ensureChartJs();
    destroyChart(canvasId);
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    _charts[canvasId] = new Chart(canvas, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            layout: { padding: { bottom: 0, left: 0, right: 8, top: 0 } },
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: { label: ctx => ctx.parsed.y.toFixed(1) + '% drawdown' }
                }
            },
            scales: {
                x: xAxis,
                y: {
                    ticks: { color: '#6A8FAF', callback: v => v.toFixed(0) + '%' },
                    grid: { color: 'rgba(30,144,255,0.08)' },
                    min: 0
                }
            }
        }
    });
}

export async function createTornadoChart(canvasId, labels, lowData, highData, baselineRate) {
    await window.ensureChartJs();
    destroyChart(canvasId);
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    _charts[canvasId] = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Downside',
                    data: lowData.map(v => v - baselineRate),
                    backgroundColor: 'rgba(231,76,60,0.7)',
                    borderColor: 'rgba(231,76,60,0.9)',
                    borderWidth: 1,
                    borderSkipped: false,
                },
                {
                    label: 'Upside',
                    data: highData.map(v => v - baselineRate),
                    backgroundColor: 'rgba(46,204,113,0.7)',
                    borderColor: 'rgba(46,204,113,0.9)',
                    borderWidth: 1,
                    borderSkipped: false,
                }
            ]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            layout: { padding: { bottom: 0, left: 0, right: 12, top: 0 } },
            plugins: {
                legend: { display: true, labels: { color: '#8AAEC8', boxWidth: 12 } },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: ctx => {
                            const actual = ctx.parsed.x + baselineRate;
                            const delta = ctx.parsed.x;
                            const sign = delta >= 0 ? '+' : '';
                            return ctx.dataset.label + ': ' + actual.toFixed(1) + '% (' + sign + delta.toFixed(1) + '%)';
                        }
                    }
                },
                annotation: {
                    annotations: {
                        baseline: {
                            type: 'line',
                            xMin: 0,
                            xMax: 0,
                            borderColor: '#F39C12',
                            borderWidth: 2,
                            borderDash: [4, 4],
                            label: {
                                display: true,
                                content: 'Current: ' + baselineRate.toFixed(0) + '%',
                                color: '#F39C12',
                                font: { size: 11 },
                                position: 'start'
                            }
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: '#6A8FAF',
                        callback: v => (v >= 0 ? '+' : '') + v.toFixed(0) + '%'
                    },
                    grid: { color: 'rgba(30,144,255,0.08)' },
                    title: {
                        display: true,
                        text: 'Change in Success Rate',
                        color: '#6A8FAF',
                        font: { size: 11 }
                    }
                },
                y: {
                    ticks: { color: '#6A8FAF' },
                    grid: { display: false },
                    stacked: true
                }
            }
        }
    });
}

export function destroyChart(canvasId) {
    if (_charts[canvasId]) {
        _charts[canvasId].destroy();
        delete _charts[canvasId];
    }
}

// ── Report preview modal portal ───────────────────────────────────────────
// Creates the modal as a direct child of <body> via #report-modal-portal so
// position:fixed is never clipped by overflow:hidden ancestors (WebView2/WKWebView).
window.openReportModal = function (html, dotnetRef, showSave) {
    window.closeReportModal();
    var portal = document.getElementById('report-modal-portal');
    if (!portal) return;

    var backdrop = document.createElement('div');
    backdrop.className = 'rp-backdrop';
    backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) dotnetRef.invokeMethodAsync('InvokeClose');
    });

    var dialog = document.createElement('div');
    dialog.className = 'rp-dialog';

    var toolbar = document.createElement('div');
    toolbar.className = 'rp-toolbar';

    var title = document.createElement('span');
    title.className = 'rp-title';
    title.textContent = 'Report Preview';

    var actions = document.createElement('div');
    actions.className = 'rp-actions';

    var printBtn = document.createElement('button');
    printBtn.className = 'rp-btn rp-btn--secondary';
    printBtn.title = 'Print report';
    printBtn.innerHTML = '&#128438; Print';
    printBtn.addEventListener('click', function () {
        var iframe = portal.querySelector('.rp-iframe');
        if (iframe && iframe.contentWindow) {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
        }
    });
    actions.appendChild(printBtn);

    if (showSave) {
        var saveBtn = document.createElement('button');
        saveBtn.className = 'rp-btn rp-btn--primary';
        saveBtn.title = 'Save as PDF';
        saveBtn.innerHTML = '&#128190; Save PDF';
        saveBtn.addEventListener('click', function () { dotnetRef.invokeMethodAsync('InvokeSave'); });
        actions.appendChild(saveBtn);
    }

    var closeBtn = document.createElement('button');
    closeBtn.className = 'rp-btn rp-btn--close';
    closeBtn.title = 'Close preview';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', function () {
        closeReportModal();                         // instant visual dismiss
        dotnetRef.invokeMethodAsync('InvokeClose'); // sync .NET state
    });
    actions.appendChild(closeBtn);

    toolbar.appendChild(title);
    toolbar.appendChild(actions);

    var body = document.createElement('div');
    body.className = 'rp-body';

    var iframe = document.createElement('iframe');
    iframe.className = 'rp-iframe';
    iframe.title = 'Report preview';
    body.appendChild(iframe);

    dialog.appendChild(toolbar);
    dialog.appendChild(body);
    backdrop.appendChild(dialog);
    portal.appendChild(backdrop);

    // Escape key dismisses the modal
    function handleEscape(e) {
        if (e.key === 'Escape') {
            closeReportModal();
            dotnetRef.invokeMethodAsync('InvokeClose');
        }
    }
    document.addEventListener('keydown', handleEscape);
    portal._escapeHandler = handleEscape;

    var doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open('text/html', 'replace');
    doc.write(html);
    doc.close();
};

window.closeReportModal = function () {
    var portal = document.getElementById('report-modal-portal');
    if (!portal) return;
    if (portal._escapeHandler) {
        document.removeEventListener('keydown', portal._escapeHandler);
        portal._escapeHandler = null;
    }
    portal.innerHTML = '';
};

// ── Report preview helpers (legacy — kept for any direct callers) ─────────
window.setIframeSrcdoc = function (iframeId, html) {
    const iframe = document.getElementById(iframeId);
    if (!iframe) return;
    // Use document.write() instead of srcdoc — works reliably in MAUI WebView2
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open('text/html', 'replace');
    doc.write(html);
    doc.close();
};

window.printIframe = function (iframeId) {
    const iframe = document.getElementById(iframeId);
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
};

// ── Guide modal search ────────────────────────────────────────────────────
window.searchGuideModal = function (bodyId, term) {
    const body = document.getElementById(bodyId);
    if (!body) return;

    // Remove previous highlights by unwrapping all <mark> tags
    body.querySelectorAll('mark.guide-search-highlight').forEach(mark => {
        const parent = mark.parentNode;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
    });

    if (!term || term.trim() === '') return;

    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedTerm, 'gi');
    let firstMatch = null;

    // Walk text nodes and wrap matches in <mark>
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);
    const nodesToProcess = [];
    let node;
    while ((node = walker.nextNode())) {
        if (node.nodeValue.trim() !== '') nodesToProcess.push(node);
    }

    nodesToProcess.forEach(textNode => {
        const text = textNode.nodeValue;
        if (!regex.test(text)) return;
        regex.lastIndex = 0;

        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            if (match.index > lastIdx) {
                frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
            }
            const mark = document.createElement('mark');
            mark.className = 'guide-search-highlight';
            mark.style.cssText = 'background:#ffe082;color:#000;border-radius:2px;';
            mark.textContent = match[0];
            if (!firstMatch) firstMatch = mark;
            frag.appendChild(mark);
            lastIdx = regex.lastIndex;
        }
        if (lastIdx < text.length) {
            frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        }
        textNode.parentNode.replaceChild(frag, textNode);
    });

    if (firstMatch) {
        firstMatch.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
};
