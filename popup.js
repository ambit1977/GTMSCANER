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
   * 現在のタブのページから GTM コンテナID およびその他の Google タグスクリプトを取得
   * @returns {Promise<{ gtmContainerIds: string[], otherScripts: Array<{ url: string, id: string, kind: string }> }>}
   */
  function getContainerIdsFromPage() {
    return new Promise(function (resolve, reject) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (!tabs[0]) {
          resolve({ gtmContainerIds: [], otherScripts: [] });
          return;
        }
        chrome.scripting.executeScript(
          {
            target: { tabId: tabs[0].id },
            func: function () {
              var gtmIds = [];
              var scripts = document.querySelectorAll('script[src*="googletagmanager.com/gtm.js"]');
              for (var i = 0; i < scripts.length; i++) {
                var m = scripts[i].src.match(/[?&]id=([^&]+)/);
                if (m) gtmIds.push(m[1]);
              }
              var iframes = document.querySelectorAll('noscript iframe[src*="googletagmanager.com/ns.html"]');
              for (var j = 0; j < iframes.length; j++) {
                var n = iframes[j].src.match(/[?&]id=([^&]+)/);
                if (n && gtmIds.indexOf(n[1]) === -1) gtmIds.push(n[1]);
              }
              var other = [];
              var all = document.querySelectorAll('script[src*="googletagmanager.com"]');
              for (var k = 0; k < all.length; k++) {
                var src = all[k].src || '';
                var idMatch = src.match(/[?&]id=([^&]+)/);
                var id = idMatch ? idMatch[1] : '';
                if (src.indexOf('/gtm.js') !== -1) continue;
                var kind = 'Google スクリプト';
                if (src.indexOf('/gtag/') !== -1 || src.indexOf('gtag') !== -1) {
                  if (id.indexOf('G-') === 0) kind = 'Google タグ (GA4)';
                  else if (id.indexOf('UA-') === 0) kind = 'Universal Analytics';
                  else kind = 'Google タグ (gtag)';
                }
                other.push({ url: src, id: id, kind: kind });
              }
              return { gtmContainerIds: gtmIds, otherScripts: other };
            }
          },
          function (results) {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            var data = results && results[0] && results[0].result ? results[0].result : { gtmContainerIds: [], otherScripts: [] };
            if (!data.gtmContainerIds) data.gtmContainerIds = [];
            if (!data.otherScripts) data.otherScripts = [];
            resolve(data);
          }
        );
      });
    });
  }

  /**
   * gtm.js を取得（公開直後の最新版を取得するためキャッシュを使わない）
   */
  function fetchGtmJs(containerId) {
    var url = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(containerId);
    return fetch(url, { cache: 'no-store' }).then(function (r) {
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
      var tagCount = (t.tagsUserDefined != null && t.tagsInternal != null) ? t.tagsUserDefined : t.tags;
      var tagSuffix = (t.tagsInternal > 0) ? ' <span class="count-sub">（配信時 ' + t.tags + ' 件）</span>' : '';
      var varText = '変数 ' + t.variables + ' 件';
      if (t.variablesBuiltin != null && t.variablesCustom != null) {
        if (t.variablesCustom === 0) {
          varText = '変数 ' + t.variables + ' 件（すべて組み込み）';
        } else {
          varText = '変数 ' + t.variables + ' 件（組み込み ' + t.variablesBuiltin + ' / カスタム ' + t.variablesCustom + '）';
        }
      }
      html += '<div class="summary-bar">タグ ' + tagCount + ' 件' + tagSuffix + ' · トリガー ' + t.triggers + ' 件 · ' + varText + '</div>';
      html += '<p class="count-note">※ タグはユーザー定義のみの件数で表示（GTM管理画面に近い数）。トリガー・変数は gtm.js の resource ベースのため、管理画面の数と一致しない場合があります（述語との対応、変数のインライン化など）。</p>';

      if (report.containerSizeBytes != null && report.pageSpeedImpact) {
        var p = report.pageSpeedImpact;
        var impactClass = 'impact-' + (p.level === 0 ? 'light' : p.level === 1 ? 'medium' : p.level === 2 ? 'heavy' : 'very-heavy');
        var excessText = p.excessKB != null ? '（ベースライン比 +' + p.excessKB + ' KB）' : '';
        html += '<div class="section speed-section">';
        html += '<div class="section-title">コンテナサイズ・ページ速度への影響</div>';
        html += '<div class="speed-summary ' + impactClass + '">';
        html += '<span class="speed-size">gtm.js: ' + p.sizeKB + ' KB' + excessText + '</span>';
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

      if (report.zones && report.zones.length > 0) {
        html += '<div class="section"><div class="section-title">ゾーン情報</div>';
        html += '<p class="zone-note">GTM ゾーン設定（タグの内訳には含めていません）</p>';
        html += '<ul class="zone-list">';
        report.zones.forEach(function (zone, idx) {
          html += '<li class="zone-item">';
          html += '<span class="zone-name">' + escapeHtml(zone.name) + '</span>';
          if (zone.details && zone.details.length > 0) {
            html += '<ul class="zone-details">';
            zone.details.forEach(function (d) {
              html += '<li>' + escapeHtml(d) + '</li>';
            });
            html += '</ul>';
          }
          html += '</li>';
        });
        html += '</ul></div>';
      }

      html += '<div class="section"><div class="section-title">トリガー（種別の行をクリックで展開 → 正規表現・値・発火タグを表示）</div>';
      if (!report.triggerDetails || report.triggerDetails.length === 0) {
        html += '<p class="empty">なし</p>';
      } else {
        var triggerIdPrefix = 'trg-' + (report.containerId || '').replace(/[^a-zA-Z0-9]/g, '') + '-';
        var byType = {};
        report.triggerDetails.forEach(function (tr) {
          var label = tr.typeLabel || tr.type || 'その他';
          if (!byType[label]) byType[label] = [];
          byType[label].push(tr);
        });
        var typeOrder = Object.keys(byType).sort(function (a, b) { return byType[b].length - byType[a].length; });
        html += '<ul class="trigger-type-list">';
        typeOrder.forEach(function (label) {
          var triggers = byType[label];
          if (!triggers || triggers.length === 0) return;
          var typeId = triggerIdPrefix + label.replace(/[^a-zA-Z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/g, '_');
          var innerHtml = '';
          triggers.forEach(function (tr) {
            var condHtml = '';
            if (tr.conditionDetails && tr.conditionDetails.length > 0) {
              condHtml = '<ul class="trigger-conditions">';
              tr.conditionDetails.forEach(function (c) {
                condHtml += '<li>' + escapeHtml(c) + '</li>';
              });
              condHtml += '</ul>';
            } else {
              condHtml = '<p class="empty">条件の詳細なし</p>';
            }
            var tagsHtml = '';
            if (tr.firingTagNames && tr.firingTagNames.length > 0) {
              tagsHtml = '<p class="trigger-firing-tags">このトリガーで発火するタグ: ' + tr.firingTagNames.map(function (n) { return escapeHtml(n); }).join(', ') + '</p>';
            } else {
              tagsHtml = '<p class="trigger-firing-tags empty">このトリガーで発火するタグはありません</p>';
            }
            innerHtml += '<div class="trigger-detail-block"><span class="trigger-detail-title">#' + tr.index + ' ' + escapeHtml(tr.typeLabel || tr.type) + '</span>' + condHtml + tagsHtml + '</div>';
          });
          html += '<li class="trigger-type-item">';
          html += '<button type="button" class="trigger-type-btn" data-id="' + typeId + '" aria-expanded="false">';
          html += '<span class="trigger-type-label">' + escapeHtml(label) + '</span>';
          html += '<span class="trigger-type-count">' + triggers.length + ' 件</span>';
          html += '</button>';
          html += '<div id="' + typeId + '" class="trigger-type-drilldown" hidden>' + innerHtml + '</div>';
          html += '</li>';
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
          var builtinBadge = s.isBuiltIn ? ' <span class="var-builtin">組み込み</span>' : '';
          html += '<li><span class="label">' + escapeHtml(s.label) + '</span> <span class="count">' + s.count + ' 件</span>' + builtinBadge + '</li>';
        });
        html += '</ul>';
      }
      html += '</div>';

      if (report.namedVariables && report.namedVariables.length > 0) {
        html += '<div class="section"><div class="section-title">主な変数（名前付き）</div>';
        html += '<ul class="named-vars">';
        report.namedVariables.slice(0, 24).forEach(function (v) {
          var builtInBadge = v.isBuiltIn ? ' <span class="var-builtin">組み込み</span>' : '';
          html += '<li><code>' + escapeHtml(v.name) + '</code> <span class="var-type">' + escapeHtml(v.type) + '</span>' + builtInBadge + '</li>';
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
      .then(function (data) {
        var ids = data.gtmContainerIds || [];
        var otherScripts = data.otherScripts || [];
        if (ids.length === 0) {
          setStatus('');
          var msg = '<div class="section"><div class="error">このページでは GTM コンテナ（gtm.js）が検出されませんでした。</div>';
          if (otherScripts.length > 0) {
            msg += '<div class="section other-scripts"><div class="section-title">読み込まれている Google 関連スクリプト</div>';
            msg += '<p class="other-scripts-note">GTM ではなく Google タグ (gtag.js) 等で実装されている可能性があります。</p><ul class="other-scripts-list">';
            otherScripts.forEach(function (s) {
              msg += '<li><span class="other-scripts-kind">' + escapeHtml(s.kind) + '</span>';
              if (s.id) msg += ' <code>' + escapeHtml(s.id) + '</code>';
              msg += '</li>';
            });
            msg += '</ul></div>';
          } else {
            msg += '<p class="empty">ページ読み込み後に GTM が挿入される場合は、しばらく待ってから再スキャンしてください。</p>';
          }
          msg += '</div>';
          resultEl.innerHTML = msg;
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
        scroll.querySelectorAll('.trigger-type-btn').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            var panel = document.getElementById(id);
            if (!panel) return;
            var isOpen = !panel.hidden;
            panel.hidden = isOpen;
            btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
          });
        });
      })
      .catch(function (err) {
        setStatus('');
        scanBtn.disabled = false;
        resultEl.innerHTML = '<div class="error">エラー: ' + escapeHtml(err.message) + '</div>';
      });
  }

  scanBtn.addEventListener('click', runScan);
})();
