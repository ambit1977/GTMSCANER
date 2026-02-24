(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const resultEl = document.getElementById('result');
  const scanBtn = document.getElementById('scanBtn');

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function clearResult() {
    resultEl.innerHTML = '';
  }

  /**
   * 現在のタブのページから GTM コンテナIDの一覧を取得
   */
  function getContainerIdsFromPage() {
    return new Promise(function (resolve, reject) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (!tabs[0]) {
          resolve([]);
          return;
        }
        chrome.scripting.executeScript(
          {
            target: { tabId: tabs[0].id },
            func: function () {
              var ids = [];
              var scripts = document.querySelectorAll('script[src*="googletagmanager.com/gtm.js"]');
              for (var i = 0; i < scripts.length; i++) {
                var m = scripts[i].src.match(/[?&]id=([^&]+)/);
                if (m) ids.push(m[1]);
              }
              var iframes = document.querySelectorAll('noscript iframe[src*="googletagmanager.com/ns.html"]');
              for (var j = 0; j < iframes.length; j++) {
                var n = iframes[j].src.match(/[?&]id=([^&]+)/);
                if (n && ids.indexOf(n[1]) === -1) ids.push(n[1]);
              }
              return ids;
            }
          },
          function (results) {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(results && results[0] && results[0].result ? results[0].result : []);
          }
        );
      });
    });
  }

  /**
   * gtm.js を取得
   */
  function fetchGtmJs(containerId) {
    var url = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(containerId);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  /**
   * 分析レポート用の HTML を生成（集計・要約を表示）
   */
  function renderReport(report) {
    var html = '<div class="report">';
    html += '<div class="report-header">' + escapeHtml(report.containerId) + (report.version ? ' <span class="version">v' + escapeHtml(report.version) + '</span>' : '') + '</div>';

    if (report.error) {
      html += '<div class="section"><div class="error">' + escapeHtml(report.error) + '</div></div>';
    } else {
      var t = report.totals;
      html += '<div class="summary-bar">タグ ' + t.tags + ' 件 · トリガー ' + t.triggers + ' 件 · 変数 ' + t.variables + ' 件</div>';

      if (report.containerSizeBytes != null && report.pageSpeedImpact) {
        var p = report.pageSpeedImpact;
        var impactClass = 'impact-' + (p.level === 0 ? 'light' : p.level === 1 ? 'medium' : p.level === 2 ? 'heavy' : 'very-heavy');
        html += '<div class="section speed-section">';
        html += '<div class="section-title">コンテナサイズ・ページ速度への影響</div>';
        html += '<div class="speed-summary ' + impactClass + '">';
        html += '<span class="speed-size">gtm.js: ' + p.sizeKB + ' KB</span>';
        html += '<span class="speed-label">' + escapeHtml(p.label) + '</span>';
        html += '</div>';
        if (p.details && p.details.length > 0) {
          html += '<ul class="speed-details">';
          p.details.forEach(function (d) {
            html += '<li>' + escapeHtml(d) + '</li>';
          });
          html += '</ul>';
        }
        html += '</div>';
      }

      html += '<div class="section"><div class="section-title">タグの内訳</div>';
      if (!report.tagSummary || report.tagSummary.length === 0) {
        html += '<p class="empty">なし</p>';
      } else {
        html += '<ul class="summary-list">';
        report.tagSummary.forEach(function (s) {
          html += '<li><span class="label">' + escapeHtml(s.label) + '</span> <span class="count">' + s.count + ' 件</span></li>';
        });
        html += '</ul>';
      }
      html += '</div>';

      html += '<div class="section"><div class="section-title">トリガーの種類</div>';
      if (!report.triggerSummary || report.triggerSummary.length === 0) {
        html += '<p class="empty">なし</p>';
      } else {
        html += '<ul class="summary-list">';
        report.triggerSummary.forEach(function (s) {
          html += '<li><span class="label">' + escapeHtml(s.label) + '</span> <span class="count">' + s.count + ' 件</span></li>';
        });
        html += '</ul>';
      }
      html += '</div>';

      html += '<div class="section"><div class="section-title">変数の種類</div>';
      if (!report.variableSummary || report.variableSummary.length === 0) {
        html += '<p class="empty">なし</p>';
      } else {
        html += '<ul class="summary-list">';
        report.variableSummary.forEach(function (s) {
          html += '<li><span class="label">' + escapeHtml(s.label) + '</span> <span class="count">' + s.count + ' 件</span></li>';
        });
        html += '</ul>';
      }
      html += '</div>';

      if (report.namedVariables && report.namedVariables.length > 0) {
        html += '<div class="section"><div class="section-title">主な変数（名前付き）</div>';
        html += '<ul class="named-vars">';
        report.namedVariables.slice(0, 24).forEach(function (v) {
          html += '<li><code>' + escapeHtml(v.name) + '</code> <span class="var-type">' + escapeHtml(v.type) + '</span></li>';
        });
        if (report.namedVariables.length > 24) {
          html += '<li class="more">他 ' + (report.namedVariables.length - 24) + ' 件</li>';
        }
        html += '</ul></div>';
      }
    }
    html += '</div>';
    return html;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function runScan() {
    clearResult();
    setStatus('検出中…');
    scanBtn.disabled = true;

    getContainerIdsFromPage()
      .then(function (ids) {
        if (ids.length === 0) {
          setStatus('');
          resultEl.innerHTML = '<div class="error">このページでは GTM コンテナが検出されませんでした。</div>';
          scanBtn.disabled = false;
          return;
        }
        setStatus(ids.length + ' 件のコンテナを取得中…');
        return Promise.all(ids.map(function (id) {
          return fetchGtmJs(id).then(function (text) {
            if (!window.GTMParser) return { containerId: id, error: 'パーサー未読み込み' };
            var report = window.GTMParser.parseGtmJs(text, id);
            var byteLength = new TextEncoder().encode(text).length;
            return window.GTMParser.analyzeReport(report, { gtmJsByteLength: byteLength });
          }).catch(function (err) {
            return { containerId: id, error: err.message || '取得に失敗しました' };
          });
        }));
      })
      .then(function (reports) {
        setStatus('');
        scanBtn.disabled = false;
        if (!reports) return;
        var scroll = document.createElement('div');
        scroll.className = 'scroll';
        reports.forEach(function (r) {
          scroll.innerHTML += renderReport(r);
        });
        resultEl.appendChild(scroll);
      })
      .catch(function (err) {
        setStatus('');
        scanBtn.disabled = false;
        resultEl.innerHTML = '<div class="error">エラー: ' + escapeHtml(err.message) + '</div>';
      });
  }

  scanBtn.addEventListener('click', runScan);
})();
