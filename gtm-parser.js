/**
 * GTMコンテナ（gtm.js）のテキストから resource オブジェクトを抽出し、
 * タグ・トリガー（predicates）・変数（macros）の概要を返す
 */
(function (global) {
  'use strict';

  /**
   * "key": の直後から始まるオブジェクト/配列の終わりまでを括弧対応で抽出
   * @param {string} str - ソース文字列
   * @param {number} start - 開始インデックス（最初の { または [ の直後）
   * @returns {{ value: string, endIndex: number } | null}
   */
  function extractBalanced(str, start) {
    const open = str[start];
    const close = open === '[' ? ']' : '}';
    let depth = 1;
    let i = start + 1;
    let inString = false;
    let escape = false;
    let quote = null;

    while (i < str.length && depth > 0) {
      const c = str[i];

      if (escape) {
        escape = false;
        i++;
        continue;
      }

      if (c === '\\' && inString) {
        escape = true;
        i++;
        continue;
      }

      if (!inString) {
        if (c === '"' || c === "'") {
          inString = true;
          quote = c;
        } else if (c === open) {
          depth++;
        } else if (c === close) {
          depth--;
        }
      } else if (c === quote) {
        inString = false;
      }

      i++;
    }

    if (depth !== 0) return null;
    return { value: str.slice(start, i), endIndex: i };
  }

  /**
   * gtm.js のソースから var data = { ... } の resource 部分を取得
   * @param {string} source - gtm.js のソースコード
   * @returns {object | null} resource オブジェクト
   */
  function extractResource(source) {
    const resourceMatch = source.match(/"resource"\s*:\s*(\{)/);
    if (!resourceMatch) return null;

    const startIndex = resourceMatch.index + resourceMatch[0].length - 1;
    const result = extractBalanced(source, startIndex);
    if (!result) return null;

    try {
      return JSON.parse(result.value);
    } catch (e) {
      return null;
    }
  }

  /**
   * マクロ（変数）の概要を整形
   * @param {Array} macros
   * @returns {Array<{ type: string, name?: string, key?: string }>}
   */
  function summarizeMacros(macros) {
    if (!Array.isArray(macros)) return [];
    return macros.map(function (m, index) {
      const type = m.function || m.type || 'unknown';
      const name = m.name || m.vtp_name || ('Variable ' + (index + 1));
      const key = m.key || (m.vtp_variableId ? 'id:' + m.vtp_variableId : undefined);
      return { type: String(type), name: name, key: key };
    });
  }

  /**
   * タグの概要を整形
   * @param {Array} tags
   * @returns {Array<{ name: string, type: string, triggerIds?: string[] }>}
   */
  function summarizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(function (t) {
      const name = t.name || t.vtp_tagName || t.id || 'Unnamed';
      const type = t.type || t.function || t.vtp_tagType || 'unknown';
      const triggerIds = t.firingTriggerId || t.triggerId || t.vtp_firingTriggerId;
      return {
        name: String(name),
        type: String(type),
        triggerIds: Array.isArray(triggerIds) ? triggerIds : (triggerIds ? [triggerIds] : undefined)
      };
    });
  }

  /**
   * 述語（トリガー）の概要を整形
   * @param {Array} predicates
   * @returns {Array<{ index: number, type?: string, raw?: object }>}
   */
  function summarizePredicates(predicates) {
    if (!Array.isArray(predicates)) return [];
    return predicates.map(function (p, index) {
      const type = p.type || p.function || p.eventId || ('Trigger ' + (index + 1));
      return {
        index: index + 1,
        type: String(type),
        raw: p
      };
    });
  }

  /**
   * ルールの概要（タグとトリガーの対応）
   * @param {Array} rules
   * @returns {Array<object>}
   */
  function summarizeRules(rules) {
    if (!Array.isArray(rules)) return [];
    return rules.map(function (r, index) {
      return {
        index: index + 1,
        predicateId: r.predicateId ?? r.triggerId,
        tagId: r.tagId,
        raw: r
      };
    });
  }

  /**
   * タグタイプを人間が読めるラベルに変換
   */
  var TAG_TYPE_LABELS = {
    __ua: 'Universal Analytics (GA3)',
    __googtag: 'Google タグ (GA4)',
    __awct: 'Google 広告 コンバージョン',
    __sp: 'Google 広告 (リマーケ等)',
    __img: 'イメージ ピクセル',
    __html: 'カスタム HTML',
    __paused: '一時停止中',
    __flc: 'Floodlight コンバージョン',
    __fls: 'Floodlight 売上',
    __gclidw: 'gclid 書き込み',
    __baut: '認証系',
    __tg: 'タグ (汎用)',
    __cl: 'カスタム タグ',
    __lcl: 'ローカル ストレージ',
    __opt: 'Google Optimize',
    __e: 'カスタムイベント',
    __d: 'カスタム タグ',
    __r: 'カスタム タグ'
  };

  /**
   * トリガー（述語）タイプのラベル
   */
  var TRIGGER_TYPE_LABELS = {
    _eq: '等しい',
    _re: '正規表現に一致',
    _cn: '含む',
    _sw: '次で始まる',
    _ew: '次で終わる',
    _lt: 'より小さい',
    _gt: 'より大きい'
  };

  /**
   * 変数タイプのラベル
   */
  var VARIABLE_TYPE_LABELS = {
    __j: 'JavaScript 変数',
    __c: '定数',
    __v: 'データレイヤー変数',
    __u: 'URL',
    __e: 'カスタムイベント',
    __jsm: 'カスタム JavaScript',
    __d: 'DOM',
    __k: 'Cookie',
    __f: '1st Party Cookie',
    __aev: '自動イベント変数',
    __awec: 'Google 広告',
    __smm: 'カスタム',
    __r: '参照'
  };

  function getTagTypeLabel(type) {
    if (TAG_TYPE_LABELS[type]) return TAG_TYPE_LABELS[type];
    if (String(type).indexOf('__cvt_') === 0) return 'コンバージョン タグ';
    return type;
  }

  function getTriggerTypeLabel(type) {
    return TRIGGER_TYPE_LABELS[type] || type;
  }

  function getVariableTypeLabel(type) {
    return VARIABLE_TYPE_LABELS[type] || type;
  }

  /**
   * コンテナサイズとタグ数からページ速度への影響を評価
   * @param {number} byteLength - gtm.js のバイト数
   * @param {object} totals - { tags, triggers, variables }
   * @returns {{ sizeKB: number, level: string, label: string, details: string[] }}
   */
  function computePageSpeedImpact(byteLength, totals) {
    var sizeKB = byteLength ? (byteLength / 1024) : 0;
    var tags = (totals && totals.tags) || 0;
    var details = [];

    var sizeLevel = 0;
    if (sizeKB >= 500) { sizeLevel = 3; details.push('コンテナが非常に大きい（' + sizeKB.toFixed(1) + ' KB）'); }
    else if (sizeKB >= 300) { sizeLevel = 2; details.push('コンテナが大きい（' + sizeKB.toFixed(1) + ' KB）'); }
    else if (sizeKB >= 100) { sizeLevel = 1; details.push('コンテナサイズ: ' + sizeKB.toFixed(1) + ' KB'); }
    else if (byteLength > 0) { details.push('コンテナサイズ: ' + sizeKB.toFixed(1) + ' KB（軽量）'); }

    var tagLevel = 0;
    if (tags >= 200) { tagLevel = 3; details.push('タグ数が非常に多い（' + tags + ' 件）'); }
    else if (tags >= 100) { tagLevel = 2; details.push('タグ数が多い（' + tags + ' 件）'); }
    else if (tags >= 50) { tagLevel = 1; details.push('タグ数: ' + tags + ' 件'); }

    var level = Math.max(sizeLevel, tagLevel);
    var label = level === 0 ? '軽量' : level === 1 ? '普通' : level === 2 ? 'やや重い' : '重い';
    return { sizeKB: Math.round(sizeKB * 10) / 10, level: level, label: label, details: details };
  }

  /**
   * 解析結果を集計して「意味のある」要約を返す
   * @param {object} report - parseGtmJs の戻り値
   * @param {object} [options] - { gtmJsByteLength: number } を渡すとコンテナサイズ・ページ速度影響を追加
   */
  function analyzeReport(report, options) {
    if (report.error) return report;

    var tagByType = {};
    report.tags.forEach(function (t) {
      var label = getTagTypeLabel(t.type);
      tagByType[label] = (tagByType[label] || 0) + 1;
    });
    var tagSummary = Object.keys(tagByType).map(function (label) {
      return { label: label, count: tagByType[label] };
    }).sort(function (a, b) { return b.count - a.count; });

    var triggerByType = {};
    report.triggers.forEach(function (tr) {
      var label = getTriggerTypeLabel(tr.type);
      triggerByType[label] = (triggerByType[label] || 0) + 1;
    });
    var triggerSummary = Object.keys(triggerByType).map(function (label) {
      return { label: label, count: triggerByType[label] };
    }).sort(function (a, b) { return b.count - a.count; });

    var variableByType = {};
    var namedVariables = [];
    report.variables.forEach(function (v) {
      var typeLabel = getVariableTypeLabel(v.type);
      variableByType[typeLabel] = (variableByType[typeLabel] || 0) + 1;
      var name = (v.name || '').trim();
      if (name && name.indexOf('Variable ') !== 0 && name !== typeLabel) {
        namedVariables.push({ name: name, type: typeLabel });
      }
    });
    var variableSummary = Object.keys(variableByType).map(function (label) {
      return { label: label, count: variableByType[label] };
    }).sort(function (a, b) { return b.count - a.count; });

    var totals = {
      tags: report.tags.length,
      triggers: report.triggers.length,
      variables: report.variables.length
    };

    var out = {
      containerId: report.containerId,
      version: report.version,
      error: report.error,
      tagSummary: tagSummary,
      triggerSummary: triggerSummary,
      variableSummary: variableSummary,
      namedVariables: namedVariables,
      totals: totals
    };

    if (options && options.gtmJsByteLength != null) {
      out.containerSizeBytes = options.gtmJsByteLength;
      out.pageSpeedImpact = computePageSpeedImpact(options.gtmJsByteLength, totals);
    }

    return out;
  }

  /**
   * gtm.js ソースを解析してレポート用オブジェクトを返す
   * @param {string} gtmJsSource - gtm.js のテキスト
   * @param {string} containerId - コンテナID（例: GTM-XXXXXX）
   * @returns {object} レポート
   */
  function parseGtmJs(gtmJsSource, containerId) {
    const resource = extractResource(gtmJsSource);
    if (!resource) {
      return {
        containerId: containerId,
        error: 'resource を抽出できませんでした',
        tags: [],
        triggers: [],
        variables: [],
        rules: []
      };
    }

    const version = resource.version || resource.v || '';
    const report = {
      containerId: containerId,
      version: version,
      tags: summarizeTags(resource.tags || []),
      triggers: summarizePredicates(resource.predicates || []),
      variables: summarizeMacros(resource.macros || []),
      rules: summarizeRules(resource.rules || []),
      rawResource: {
        tagCount: (resource.tags && resource.tags.length) || 0,
        predicateCount: (resource.predicates && resource.predicates.length) || 0,
        macroCount: (resource.macros && resource.macros.length) || 0,
        ruleCount: (resource.rules && resource.rules.length) || 0
      }
    };
    return report;
  }

  global.GTMParser = {
    extractResource: extractResource,
    parseGtmJs: parseGtmJs,
    analyzeReport: analyzeReport,
    computePageSpeedImpact: computePageSpeedImpact,
    getTagTypeLabel: getTagTypeLabel,
    getTriggerTypeLabel: getTriggerTypeLabel,
    getVariableTypeLabel: getVariableTypeLabel,
    summarizeMacros: summarizeMacros,
    summarizeTags: summarizeTags,
    summarizePredicates: summarizePredicates,
    summarizeRules: summarizeRules
  };
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this);
