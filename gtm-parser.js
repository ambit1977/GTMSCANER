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

  /** 組み込み変数とみなす名前の接頭辞・名前パターン */
  var BUILTIN_VARIABLE_PREFIXES = ['gtm.', 'google_tag_'];
  var BUILTIN_VARIABLE_NAMES = {
    'PAGE_URL': true, 'PAGE_PATH': true, 'PAGE_HOSTNAME': true, 'PAGE_REFERrer': true,
    'CLICK_URL': true, 'CLICK_TEXT': true, 'CLICK_TARGET': true, 'CLICK_ELEMENT': true, 'CLICK_CLASSES': true, 'CLICK_ID': true,
    'FORM_ID': true, 'FORM_TEXT': true, 'FORM_TARGET': true, 'FORM_URL': true, 'FORM_CLASSES': true, 'FORM_ELEMENT': true,
    'EVENT': true, 'CONTAINER_ID': true, 'CONTAINER_VERSION': true, 'DEBUG_MODE': true,
    'RANDOM_NUMBER': true, 'NEW_HISTORY_FRAGMENT': true, 'OLD_HISTORY_FRAGMENT': true, 'HISTORY_SOURCE': true,
    'ERROR_URL': true, 'ERROR_MESSAGE': true, 'ERROR_LINE': true, 'ENVIRONMENT_NAME': true
  };

  function isBuiltInVariable(name, type) {
    if (!name || typeof name !== 'string') return false;
    var n = name.trim();
    if (BUILTIN_VARIABLE_NAMES[n]) return true;
    for (var i = 0; i < BUILTIN_VARIABLE_PREFIXES.length; i++) {
      if (n.indexOf(BUILTIN_VARIABLE_PREFIXES[i]) === 0) return true;
    }
    if (n.indexOf('gtm.') === 0) return true;
    return false;
  }

  /** 名前未設定時のデフォルト名パターン（この場合も組み込みとみなす） */
  var DEFAULT_VAR_NAME_RE = /^Variable \d+$/;

  /**
   * マクロ（変数）の概要を整形（組み込みかどうかフラグ付き）
   * 名前が「Variable 1」などデフォルトのまま＝GTM標準のマクロなので組み込みとする
   * @param {Array} macros
   * @returns {Array<{ type: string, name?: string, key?: string, isBuiltIn: boolean }>}
   */
  function summarizeMacros(macros) {
    if (!Array.isArray(macros)) return [];
    return macros.map(function (m, index) {
      const type = m.function || m.type || 'unknown';
      const explicitName = m.name || m.vtp_name;
      const name = explicitName || ('Variable ' + (index + 1));
      const key = m.key || (m.vtp_variableId ? 'id:' + m.vtp_variableId : undefined);
      const hasExplicitName = !!explicitName;
      const isBuiltIn = !hasExplicitName || DEFAULT_VAR_NAME_RE.test(String(name)) || isBuiltInVariable(name, type);
      return { type: String(type), name: name, key: key, isBuiltIn: isBuiltIn };
    });
  }

  /** GTM が自動追加する内部タグの type（管理画面の「タグの数」に含まれない想定） */
  var INTERNAL_TAG_TYPES = { _fsl: true, _hl: true, _ytl: true };
  /** ゾーン情報として別扱いする type（タグの内訳には含めない） */
  var ZONE_TAG_TYPE = '__zone';

  function isInternalTagType(type) {
    if (!type || typeof type !== 'string') return false;
    var t = type.trim();
    if (INTERNAL_TAG_TYPES[t]) return true;
    return false;
  }

  /**
   * タグの概要を整形（id を追加してトリガー→タグ対応に利用）
   * @param {Array} tags
   * @returns {Array<{ id: string, name: string, type: string, triggerIds?: string[], isInternal?: boolean }>}
   */
  function summarizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(function (t, index) {
      const name = t.name || t.vtp_tagName || t.id || 'Unnamed';
      const type = t.type || t.function || t.vtp_tagType || 'unknown';
      const triggerIds = t.firingTriggerId || t.triggerId || t.vtp_firingTriggerId;
      const id = t.tagId != null ? String(t.tagId) : String(index);
      const isInternal = isInternalTagType(type);
      return {
        id: id,
        name: String(name),
        type: String(type),
        triggerIds: Array.isArray(triggerIds) ? triggerIds : (triggerIds ? [triggerIds] : undefined),
        isInternal: isInternal
      };
    });
  }

  /**
   * ゾーン用の raw オブジェクトから表示用の詳細キー・値を抽出
   * @param {object} raw - __zone タイプのタグの生オブジェクト
   * @returns {string[]} 表示用の「キー: 値」配列
   */
  function extractZoneDetails(raw) {
    if (!raw || typeof raw !== 'object') return [];
    var details = [];
    var skipKeys = { type: true, function: true, tagId: true };
    for (var k in raw) {
      if (!raw.hasOwnProperty(k) || skipKeys[k]) continue;
      var v = raw[k];
      if (v === undefined || v === '') continue;
      var key = k.replace(/^vtp_/, '');
      var disp = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (disp.length > 200) disp = disp.slice(0, 197) + '...';
      details.push(key + ': ' + disp);
    }
    return details;
  }

  /**
   * vtp_childContainers の list/map 形式から nickname（ゾーン名）を取得
   * 例: ["list",["map","publicId","GTM-XXX","nickname","検証用軽いコンテナ"]]
   * @param {*} vtp_childContainers - resource 内の vtp_childContainers の値
   * @returns {string|null} 最初の子コンテナの nickname、なければ null
   */
  function getZoneNicknameFromChildContainers(vtp_childContainers) {
    if (!Array.isArray(vtp_childContainers)) return null;
    var list = vtp_childContainers.length >= 2 ? vtp_childContainers[1] : vtp_childContainers[0];
    if (!Array.isArray(list)) return null;
    if (list[0] === 'map') {
      for (var j = 1; j < list.length - 1; j += 2) {
        if (list[j] === 'nickname' && typeof list[j + 1] === 'string') return list[j + 1];
      }
      return null;
    }
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!Array.isArray(item) || item[0] !== 'map') continue;
      for (var k = 1; k < item.length - 1; k += 2) {
        if (item[k] === 'nickname' && typeof item[k + 1] === 'string') return item[k + 1];
      }
    }
    return null;
  }

  /**
   * ゾーン用 raw オブジェクトから表示名を取得（vtp_childContainers の nickname を優先）
   * @param {object} z - __zone タイプのタグの生オブジェクト
   * @returns {string}
   */
  function getZoneDisplayName(z) {
    if (z.name && String(z.name).trim()) return String(z.name).trim();
    if (z.vtp_tagName && String(z.vtp_tagName).trim()) return String(z.vtp_tagName).trim();
    if (z.vtp_name && String(z.vtp_name).trim()) return String(z.vtp_name).trim();
    if (z.vtp_zoneName && String(z.vtp_zoneName).trim()) return String(z.vtp_zoneName).trim();
    var nickname = getZoneNicknameFromChildContainers(z.vtp_childContainers);
    if (nickname && nickname.trim()) return nickname.trim();
    return 'ゾーン';
  }

  /**
   * resource.tags のうち __zone のものをゾーン情報として整形
   * @param {Array} rawTags - resource.tags の要素のうち type === '__zone' のもの
   * @returns {Array<{ name: string, details: string[], raw?: object }>}
   */
  function summarizeZoneItems(rawTags) {
    if (!Array.isArray(rawTags)) return [];
    return rawTags.map(function (z) {
      var name = getZoneDisplayName(z);
      var details = extractZoneDetails(z);
      return { name: String(name), details: details, raw: z };
    });
  }

  /**
   * 述語（トリガー）の生オブジェクトから条件の値・正規表現などを抽出
   * @param {object} raw - 生の predicate オブジェクト
   * @returns {string[]} 表示用の条件文字列
   */
  function extractPredicateConditionDetails(raw) {
    if (!raw || typeof raw !== 'object') return [];
    var details = [];
    var keys = ['vtp_regex', 'vtp_pattern', 'vtp_value', 'vtp_matchType', 'arg0', 'arg1', 'vtp_ignoreCase', 'vtp_negate'];
    if (raw.vtp_regex != null) details.push('正規表現: ' + raw.vtp_regex);
    if (raw.vtp_pattern != null) details.push('パターン: ' + raw.vtp_pattern);
    if (raw.vtp_value != null) details.push('値: ' + raw.vtp_value);
    if (raw.arg0 != null) details.push('左辺: ' + (Array.isArray(raw.arg0) ? JSON.stringify(raw.arg0) : raw.arg0));
    if (raw.arg1 != null) details.push('右辺: ' + (Array.isArray(raw.arg1) ? JSON.stringify(raw.arg1) : raw.arg1));
    for (var k in raw) {
      if (raw.hasOwnProperty(k) && k.indexOf('vtp_') === 0 && keys.indexOf(k) === -1 && raw[k] !== '' && raw[k] != null) {
        details.push(k.replace('vtp_', '') + ': ' + (typeof raw[k] === 'object' ? JSON.stringify(raw[k]) : String(raw[k])));
      }
    }
    if (details.length === 0) {
      for (var k2 in raw) {
        if (raw.hasOwnProperty(k2) && raw[k2] !== undefined && raw[k2] !== '') {
          var v = raw[k2];
          var disp = typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v);
          if (disp.length > 80) disp = disp.slice(0, 77) + '...';
          details.push(k2 + ': ' + disp);
        }
      }
    }
    return details;
  }

  /**
   * 述語（トリガー）の概要を整形（条件のドリルダウン用 details 付き）
   * @param {Array} predicates
   * @returns {Array<{ index: number, predicateIndex: number, type?: string, conditionDetails: string[], raw?: object }>}
   */
  function summarizePredicates(predicates) {
    if (!Array.isArray(predicates)) return [];
    return predicates.map(function (p, index) {
      const type = p.type || p.function || p.eventId || ('Trigger ' + (index + 1));
      var conditionDetails = extractPredicateConditionDetails(p);
      return {
        index: index + 1,
        predicateIndex: index,
        type: String(type),
        conditionDetails: conditionDetails,
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

  /** 空コンテナ（タグ・トリガー・ユーザー変数なし）時の gtm.js 想定サイズ（KB）。これをゼロとして超過分を評価する。 */
  var BASELINE_SIZE_KB = 280;

  /**
   * コンテナサイズとタグ数からページ速度への影響を評価
   * ベースライン（空コンテナ相当）をゼロとし、超過分で「やや重い」などを判定する
   * @param {number} byteLength - gtm.js のバイト数
   * @param {object} totals - { tags, triggers, variables }
   * @returns {{ sizeKB: number, excessKB: number, baselineKB: number, level: number, label: string, details: string[] }}
   */
  function computePageSpeedImpact(byteLength, totals) {
    var sizeKB = byteLength ? (byteLength / 1024) : 0;
    var excessKB = Math.max(0, sizeKB - BASELINE_SIZE_KB);
    var tags = (totals && totals.tags) || 0;
    var details = [];

    details.push('実サイズ: ' + sizeKB.toFixed(1) + ' KB（ベースライン ' + BASELINE_SIZE_KB + ' KB + ' + excessKB.toFixed(1) + ' KB）');

    var sizeLevel = 0;
    if (excessKB >= 400) { sizeLevel = 3; details.push('カスタム設定が非常に多い（+' + excessKB.toFixed(0) + ' KB）'); }
    else if (excessKB >= 200) { sizeLevel = 2; details.push('カスタム設定が多い（+' + excessKB.toFixed(0) + ' KB）'); }
    else if (excessKB >= 80) { sizeLevel = 1; details.push('カスタム設定の追加: +' + excessKB.toFixed(0) + ' KB'); }

    var tagLevel = 0;
    if (tags >= 150) { tagLevel = 3; details.push('タグ数が非常に多い（' + tags + ' 件）'); }
    else if (tags >= 80) { tagLevel = 2; details.push('タグ数が多い（' + tags + ' 件）'); }
    else if (tags >= 30) { tagLevel = 1; details.push('タグ数: ' + tags + ' 件'); }

    var level = Math.max(sizeLevel, tagLevel);
    var label = level === 0 ? '軽量' : level === 1 ? '普通' : level === 2 ? 'やや重い' : '重い';
    return {
      sizeKB: Math.round(sizeKB * 10) / 10,
      excessKB: Math.round(excessKB * 10) / 10,
      baselineKB: BASELINE_SIZE_KB,
      level: level,
      label: label,
      details: details
    };
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
    var variableBuiltinByType = {};
    var namedVariables = [];
    report.variables.forEach(function (v) {
      var typeLabel = getVariableTypeLabel(v.type);
      variableByType[typeLabel] = (variableByType[typeLabel] || 0) + 1;
      if (v.isBuiltIn) variableBuiltinByType[typeLabel] = (variableBuiltinByType[typeLabel] || 0) + 1;
      var name = (v.name || '').trim();
      if (name && name.indexOf('Variable ') !== 0 && name !== typeLabel) {
        namedVariables.push({ name: name, type: typeLabel });
      }
    });
    var variableSummary = Object.keys(variableByType).map(function (label) {
      var count = variableByType[label];
      var builtinCount = variableBuiltinByType[label] || 0;
      return { label: label, count: count, isBuiltIn: builtinCount === count };
    }).sort(function (a, b) { return b.count - a.count; });

    var tagById = {};
    report.tags.forEach(function (t) { tagById[t.id] = t; });

    var triggerDetails = report.triggers.map(function (tr) {
      var firingTagIds = [];
      var firingTagNames = [];
      var trId1 = String(tr.index);
      var trId0 = String(tr.predicateIndex);
      report.tags.forEach(function (t) {
        if (!t.triggerIds) return;
        var match = t.triggerIds.some(function (id) {
          return id === tr.index || id === tr.predicateIndex || String(id) === trId1 || String(id) === trId0;
        });
        if (match) {
          firingTagIds.push(t.id);
          firingTagNames.push(t.name || ('タグ#' + t.id));
        }
      });
      return {
        index: tr.index,
        predicateIndex: tr.predicateIndex,
        type: tr.type,
        typeLabel: getTriggerTypeLabel(tr.type),
        conditionDetails: tr.conditionDetails || [],
        firingTagIds: firingTagIds,
        firingTagNames: firingTagNames
      };
    });

    namedVariables.forEach(function (v) {
      var orig = report.variables.filter(function (x) { return (x.name || '') === v.name; })[0];
      v.isBuiltIn = orig ? orig.isBuiltIn : false;
    });

    var builtinVarCount = report.variables.filter(function (v) { return v.isBuiltIn; }).length;
    var customVarCount = report.variables.length - builtinVarCount;

    var tagsUserDefined = report.tags.filter(function (t) { return !t.isInternal; }).length;
    var tagsInternal = report.tags.length - tagsUserDefined;

    var totals = {
      tags: report.tags.length,
      tagsUserDefined: tagsUserDefined,
      tagsInternal: tagsInternal,
      triggers: report.triggers.length,
      variables: report.variables.length,
      variablesBuiltin: builtinVarCount,
      variablesCustom: customVarCount
    };

    var out = {
      containerId: report.containerId,
      version: report.version,
      error: report.error,
      tagSummary: tagSummary,
      triggerSummary: triggerSummary,
      triggerDetails: triggerDetails,
      variableSummary: variableSummary,
      namedVariables: namedVariables,
      variables: report.variables,
      tagById: tagById,
      zones: report.zones || [],
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
        rules: [],
        zones: []
      };
    }

    const allTags = resource.tags || [];
    const tagItems = allTags.filter(function (t) {
      var type = t.type || t.function || t.vtp_tagType || '';
      return type !== ZONE_TAG_TYPE;
    });
    const zoneItems = allTags.filter(function (t) {
      var type = t.type || t.function || t.vtp_tagType || '';
      return type === ZONE_TAG_TYPE;
    });

    const version = resource.version || resource.v || '';
    const report = {
      containerId: containerId,
      version: version,
      tags: summarizeTags(tagItems),
      zones: summarizeZoneItems(zoneItems),
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
