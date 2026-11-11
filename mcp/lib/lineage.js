/*
 * lineage.js — chart-only data mapping, reverse lookup and audit.
 * Read-only, dependency-free, JSON safe; loads after data.js.
 */
(function (global) {
  "use strict";

  var ROLES = ["x", "y", "group", "color", "size", "label", "error"];
  var LINEAGE_TYPES = ["bar", "bar_grouped", "line", "line_multi", "area", "scatter"];
  var REQUIRED_ROLES = {
    bar: ["x", "y"],
    bar_grouped: ["x", "y", "group"],
    line: ["x", "y"],
    line_multi: ["x", "y", "group"],
    area: ["x", "y"],
    scatter: ["x", "y"]
  };

  function isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function clone(v) {
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  }

  function assertDoc(doc, fnName) {
    if (!isObj(doc) || !Array.isArray(doc.elements)) {
      throw new Error((fnName || "FigLineage") + "：doc 须为含 elements 数组的文档对象");
    }
  }

  function issue(code, message, elementId, severity, extra) {
    var out = {
      code: code,
      message: message,
      element_id: elementId === undefined ? null : elementId,
      severity: severity || "warning"
    };
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  function requiredRoles(type) {
    return REQUIRED_ROLES[type] || [];
  }

  function declaredName(v) {
    return typeof v === "string" && v !== "" ? v : null;
  }

  function fieldMatrix(spec, points) {
    var columns = spec.data && isObj(spec.data.inline) && Array.isArray(spec.data.inline.columns)
      ? spec.data.inline.columns : [];
    var mapping = isObj(spec.mapping) ? spec.mapping : {};
    var stats = isObj(spec.statistics) ? spec.statistics : {};
    var ch = isObj(spec.characterization) ? spec.characterization : {};
    var required = requiredRoles(spec.chartType);
    var used = required.slice();
    if (spec.chartType === "scatter") used.push("color");
    if ((spec.chartType === "bar" || spec.chartType === "bar_grouped") &&
        (declaredName(mapping.error) || stats.uncertainty_source === "column")) used.push("error");
    var fields = ROLES.map(function (role) {
      var mappingName = mapping[role], name = mappingName, columnSource = "mapping." + role;
      var validDeclaration = name === undefined || name === null || name === "" || typeof name === "string";
      if (role === "error" && stats.uncertainty_source === "column" && declaredName(stats.uncertainty_column)) {
        name = stats.uncertainty_column;
        columnSource = "statistics.uncertainty_column";
      }
      name = declaredName(name);
      var ci = name === null ? -1 : columns.indexOf(name);
      var rows = [];
      points.forEach(function (p) {
        p.raw_points.forEach(function (rp) {
          if (rp.values[role] !== null && rows.indexOf(rp.source_row) < 0) rows.push(rp.source_row);
        });
      });
      rows.sort(function (a, b) { return a - b; });
      var unit = null, unitSource = null;
      if (role === "x" || role === "y") {
        var axis = role === "x" ? "x" : "y";
        if (typeof stats["unit_" + axis] === "string" && stats["unit_" + axis]) {
          unit = stats["unit_" + axis];
          unitSource = "statistics.unit_" + axis;
        } else if (typeof ch[axis + "_label"] === "string" && ch[axis + "_label"]) {
          unit = ch[axis + "_label"];
          unitSource = "characterization." + axis + "_label";
        }
      }
      return {
        role: role,
        column: name,
        mapping_column: declaredName(mappingName),
        column_source: columnSource,
        column_index: ci,
        declared: name !== null,
        valid_declaration: validDeclaration,
        required: required.indexOf(role) >= 0,
        used: used.indexOf(role) >= 0 && name !== null,
        exists: name !== null && ci >= 0,
        source_rows: rows,
        unit: unit,
        unit_source: unitSource
      };
    });
    var byRole = {};
    fields.forEach(function (f) { byRole[f.role] = clone(f); });
    var columnFields = columns.map(function (name, ci) {
      var roles = fields.filter(function (f) { return f.column_index === ci; }).map(function (f) { return f.role; });
      return { index: ci, name: name, roles: roles };
    });
    return { fields: fields, by_role: byRole, columns: columnFields };
  }

  function sourceDescriptor(spec) {
    var data = isObj(spec.data) ? spec.data : {};
    var stats = isObj(spec.statistics) ? spec.statistics : {};
    var infos = [];
    [["source_info", data.source_info], ["raw_source", data.raw_source],
     ["source", data.source], ["source_ref", data.source_ref]].forEach(function (entry) {
      if (isObj(entry[1])) infos.push({ value: entry[1], path: "data." + entry[0] });
    });
    var candidates = [
      [data.source_ref, "data.source_ref"],
      [data.ref, "data.ref"]
    ];
    infos.forEach(function (entry) {
      ["locator", "uri", "path", "ref", "id", "file_name"].forEach(function (key) {
        candidates.push([entry.value[key], entry.path + "." + key]);
      });
    });
    candidates.push([stats.source_data, "statistics.source_data"]);
    var locatorDeclarations = candidates.filter(function (entry) {
      return typeof entry[0] === "string" && entry[0];
    }).map(function (entry) { return { value: entry[0], field: entry[1] }; });
    var hashes = [[data.raw_source_sha256, "data.raw_source_sha256"],
      [data.source_sha256, "data.source_sha256"]];
    infos.forEach(function (entry) {
      ["sha256", "raw_source_sha256", "source_sha256"].forEach(function (key) {
        hashes.push([entry.value[key], entry.path + "." + key]);
      });
    });
    var hashDeclarations = hashes.filter(function (entry) {
      return typeof entry[0] === "string" && entry[0] && entry[0].toLowerCase() !== "unknown";
    }).map(function (entry) { return { value: entry[0], field: entry[1] }; });
    var declaredHash = hashDeclarations.length ? hashDeclarations[0].value : null;
    var hashMatch = declaredHash === null ? null : /^sha256:([0-9a-fA-F]{64})$/.exec(declaredHash) ||
      /^([0-9a-fA-F]{64})$/.exec(declaredHash);
    var versions = [[data.source_version, "data.source_version"], [data.version, "data.version"]];
    infos.forEach(function (entry) {
      versions.push([entry.value.version, entry.path + ".version"],
        [entry.value.source_version, entry.path + ".source_version"]);
    });
    var versionDeclarations = versions.filter(function (entry) {
      return (typeof entry[0] === "string" && entry[0]) ||
        (typeof entry[0] === "number" && isFinite(entry[0]));
    }).map(function (entry) { return { value: String(entry[0]), field: entry[1] }; });
    return {
      locator: locatorDeclarations.length ? locatorDeclarations[0].value : null,
      locator_source: locatorDeclarations.length ? locatorDeclarations[0].field : null,
      locator_declarations: locatorDeclarations,
      version: versionDeclarations.length ? versionDeclarations[0].value : null,
      version_declarations: versionDeclarations,
      hash_declarations: hashDeclarations,
      raw_source_sha256: hashMatch ? hashMatch[1].toLowerCase() : "unknown",
      sha256: hashMatch ? hashMatch[1].toLowerCase() : "unknown",
      hash_status: hashMatch ? "declared" : "unknown",
      invalid_declared_sha256: declaredHash !== null && !hashMatch ? declaredHash : null,
      inline_rows_available: !!(data.inline && Array.isArray(data.inline.rows))
    };
  }

  function blankChartRecord(el, index) {
    var id = typeof el.id === "string" && el.id ? el.id : null;
    return {
      element_id: id,
      chart_stable_id: id,
      stable_id: id,
      chart_index: index,
      chart_type: null,
      status: "error",
      coverage: "partial",
      error: null,
      points: [],
      series: [],
      glyph_count: 0,
      row_count: null,
      row_mapping_status: "not_performed",
      source_row_indices: [],
      rendered_row_indices: [],
      excluded_rows: [],
      issues: []
    };
  }

  function mappingIssueFromMessage(message, id) {
    var code = "LINEAGE_EXTRACTION_ERROR";
    if (/mapping\./.test(message)) code = "MAPPING_COLUMN_MISSING";
    else if (/未绑定数据行|没有可绘制的数据点|没有可绘制的点/.test(message)) code = "DATA_ROWS_MISSING";
    else if (/characterization/.test(message)) code = "CHARACTERIZATION_MAPPING_INVALID";
    return issue(code, message, id, "error");
  }

  function extractChart(el, index) {
    var record = blankChartRecord(el, index), id = record.element_id;
    if (!id) {
      record.error = "chart 元素缺少非空稳定 id";
      record.issues.push(issue("CHART_ID_MISSING", record.error, null, "error", { chart_index: index }));
      return record;
    }
    var spec = el.chart;
    if (!isObj(spec)) {
      record.error = "chart 元素缺少 chartSpec";
      record.issues.push(issue("CHART_SPEC_MISSING", record.error, id, "error"));
      return record;
    }
    record.chart_type = typeof spec.chartType === "string" ? spec.chartType : null;
    record.mapping = clone(isObj(spec.mapping) ? spec.mapping : {});
    record.source = sourceDescriptor(spec);
    record.row_count = isObj(spec.data) && isObj(spec.data.inline) && Array.isArray(spec.data.inline.rows)
      ? spec.data.inline.rows.length : null;
    if (LINEAGE_TYPES.indexOf(record.chart_type) < 0) {
      record.status = "unsupported";
      record.coverage = "partial";
      record.row_mapping_status = "not_performed";
      record.error = "图表类型「" + String(record.chart_type) + "」不做逐行 lineage 推断";
      var matrixUnsupported = fieldMatrix(spec, []);
      record.field_matrix = matrixUnsupported.fields;
      record.field_matrix_by_role = matrixUnsupported.by_role;
      record.columns = matrixUnsupported.columns;
      record.issues.push(issue("LINEAGE_UNSUPPORTED", record.error +
        "；覆盖率仍为 partial，不判 scientific pass", id, "warning", { chart_type: record.chart_type }));
      return record;
    }
    if (!global.FigData || typeof global.FigData.getChartPoints !== "function") {
      throw new Error("FigLineage：需要先加载提供 getChartPoints 的 data.js");
    }
    try {
      var extracted = global.FigData.getChartPoints(spec);
      var matrix = fieldMatrix(spec, extracted.points);
      record.status = "mapped";
      record.coverage = "mapped";
      record.row_mapping_status = "mapped";
      record.chart_type = extracted.chartType;
      record.row_count = extracted.row_count;
      record.field_matrix = matrix.fields;
      record.field_matrix_by_role = matrix.by_role;
      record.columns = matrix.columns;
      extractRows(record, extracted);
    } catch (e) {
      record.status = record.source && !record.source.inline_rows_available ? "unavailable" : "error";
      record.row_mapping_status = record.status;
      record.error = e && e.message ? e.message : String(e);
      var matrixError = fieldMatrix(spec, []);
      record.field_matrix = matrixError.fields;
      record.field_matrix_by_role = matrixError.by_role;
      record.columns = matrixError.columns;
      var err = !record.source.inline_rows_available
        ? issue("DATA_INLINE_MISSING", record.error +
          "；外部/cached source 没有可用 inline rows，不伪造行映射", id, "error",
          { source: clone(record.source) })
        : mappingIssueFromMessage(record.error, id);
      record.issues.push(err);
    }
    return record;
  }

  function extractRows(record, extracted) {
    var rawSeen = {}, anySeen = {}, pointsBySeries = {};
    extracted.points.forEach(function (p) {
      p.point_id = record.element_id + ":" + p.point_id;
      p.element_id = record.element_id;
      p.chart_stable_id = record.element_id;
      if (!pointsBySeries[p.series_key]) pointsBySeries[p.series_key] = [];
      pointsBySeries[p.series_key].push(p);
      p.raw_points.forEach(function (rp) {
        rp.point_id = p.point_id;
        rp.element_id = record.element_id;
        rp.chart_stable_id = record.element_id;
        rp.semantic_key = p.semantic_key;
        rp.series_key = p.series_key;
        anySeen[rp.source_row] = true;
        if (p.role === "raw") rawSeen[rp.source_row] = true;
      });
    });
    extracted.series.forEach(function (se, si) {
      var ownPoints = pointsBySeries[se.series_key] || [];
      se.point_ids = ownPoints.map(function (p) { return p.point_id; });
      se.element_id = record.element_id;
      se.chart_stable_id = record.element_id;
      se.endpoints.forEach(function (ep) {
        ep.element_id = record.element_id;
        ep.series_key = se.series_key;
        var epPoint = ep.position === "first" ? ownPoints[0] : ownPoints[ownPoints.length - 1];
        ep.point_id = epPoint ? epPoint.point_id : null;
      });
      se.series_index = si;
    });
    record.points = extracted.points;
    record.series = extracted.series;
    record.glyph_count = extracted.points.length;
    record.source_row_indices = Object.keys(rawSeen).map(Number).sort(function (a, b) { return a - b; });
    record.rendered_row_indices = Object.keys(anySeen).map(Number).sort(function (a, b) { return a - b; });
    record.excluded_rows = [];
    for (var r = 0; r < extracted.row_count; r++) {
      if (!rawSeen[r]) record.excluded_rows.push(r);
    }
    if (record.excluded_rows.length) {
      record.issues.push(issue("DATA_ROWS_EXCLUDED", "以下原始行未形成该图 raw glyph：" +
        record.excluded_rows.join(",") + "；不把它们计为有效观测", record.element_id, "warning",
        { source_rows: record.excluded_rows.slice() }));
    }
  }

  function manifest(doc) {
    assertDoc(doc, "manifest");
    var charts = [], layout = [], seen = {}, nonChartCount = 0;
    doc.elements.forEach(function (el, index) {
      if (!el || typeof el !== "object") return;
      if (el.type === "chart") {
        var record = extractChart(el, index);
        if (record.element_id !== null) {
          if (seen[record.element_id]) {
            record.status = "error";
            record.coverage = "partial";
            record.error = "chart stable id 重复：" + record.element_id;
            record.issues.push(issue("CHART_ID_DUPLICATE", record.error, record.element_id, "error",
              { chart_index: index }));
          }
          seen[record.element_id] = true;
        }
        charts.push(record);
      } else {
        nonChartCount++;
        if (el.type === "panel" || el.type === "group" || el.type === "layout") {
          layout.push({
            element_id: typeof el.id === "string" ? el.id : null,
            type: el.type,
            coverage: "not_applicable",
            reason: "layout/容器元素不是数据 chart，不做图元→数据推断"
          });
        }
      }
    });
    var issues = [];
    charts.forEach(function (c) { c.issues.forEach(function (w) { issues.push(clone(w)); }); });
    var mapped = charts.filter(function (c) { return c.status === "mapped"; }).length;
    return {
      schema_version: "fig-lineage/1.0",
      scope: "chart_only",
      coverage: "partial",
      scientific_validation: "not_performed",
      chart_count: charts.length,
      mapped_chart_count: mapped,
      non_chart_element_count: nonChartCount,
      charts: charts,
      layout_elements: layout,
      issues: issues,
      limitations: [
        "仅审计真实 chart 的 columns/rows 与 renderer 映射；layout 和普通图元没有隐式数据血缘",
        "未提供的 raw source SHA/version 标为 unknown，不由 inline rows 伪造原始文件哈希",
        "数据血缘与统计申报检查不是科学有效性、显著性或人工视觉验收"
      ]
    };
  }

  function hasN(stats) {
    return (typeof stats.n_definition === "string" && stats.n_definition !== "") ||
      (typeof stats.biological_replicates === "number" && isFinite(stats.biological_replicates)) ||
      (typeof stats.technical_replicates === "number" && isFinite(stats.technical_replicates));
  }

  function audit(doc) {
    var report = manifest(doc), issues = report.issues;
    function add(code, msg, c, severity, extra) {
      var w = issue(code, msg, c.element_id, severity, extra);
      issues.push(w);
      c.issues.push(clone(w));
    }
    function conflictingDeclarations(declarations, normalize) {
      var seen = {}, conflicts = [];
      (declarations || []).forEach(function (entry) {
        var value = normalize ? normalize(entry.value) : entry.value;
        if (!seen[value]) {
          seen[value] = true;
          conflicts.push(entry);
        }
      });
      return conflicts.length > 1 ? conflicts : null;
    }
    var sourceByLocator = {};
    report.charts.forEach(function (c) {
      var el = null;
      for (var i = 0; i < doc.elements.length; i++) {
        if (doc.elements[i] && doc.elements[i].type === "chart" && doc.elements[i].id === c.element_id) {
          el = doc.elements[i];
          if (c.chart_index === i) break;
        }
      }
      var spec = el && isObj(el.chart) ? el.chart : {}, stats = isObj(spec.statistics) ? spec.statistics : {};
      var fields = c.field_matrix || [];
      fields.forEach(function (f) {
        if (f.declared && !f.exists) {
          add("MAPPING_COLUMN_MISSING", "mapping." + f.role + " 引用列「" + f.column + "」不存在", c, "error",
            { mapping_role: f.role, column: f.column });
        }
        if (!f.valid_declaration) {
          add("MAPPING_FIELD_INVALID", "mapping." + f.role + " 必须是列名字符串或 null", c, "error",
            { mapping_role: f.role });
        }
      });
      if (!hasN(stats)) {
        add("STAT_N_MISSING", "统计未申报 n_definition 或 biological/technical_replicates；不从柱数或点数猜测 n", c, "warning");
      }
      if (typeof stats.center !== "string" || !stats.center || typeof stats.spread !== "string" || !stats.spread) {
        add("STAT_SUMMARY_MISSING", "统计缺少 center/spread 申报；此处仅报告缺口，不判断显著性", c, "warning");
      }
      if ((c.chart_type === "bar" || c.chart_type === "bar_grouped") && stats.center &&
          String(stats.center).trim().toLowerCase() !== "mean") {
        add("SEMANTICS_CONFLICT", "柱图 renderer 使用 mean，但 statistics.center=" + stats.center +
            "；图形聚合口径与申报语义冲突", c, "error", { field: "statistics.center", renderer_aggregate: "mean" });
      }
      ["x", "y"].forEach(function (role) {
        var f = null;
        fields.forEach(function (candidate) { if (candidate.role === role) f = candidate; });
        if (f && f.used && !f.unit) {
          add("UNIT_MISSING", "mapping." + role + "（列「" + f.column + "」）缺少 unit_" + role +
              "；characterization." + role + "_label 也未申报，不解释列名或猜测单位", c, "warning",
            { mapping_role: role, column: f.column, field: "unit_" + role });
        }
      });
      if (stats.uncertainty_source === "column") {
        var errCol = declaredName(stats.uncertainty_column) || declaredName(spec.mapping && spec.mapping.error);
        if (!errCol) add("UNCERTAINTY_COLUMN_MISSING", "uncertainty_source=column 但未申报误差列", c, "error");
        if (declaredName(stats.uncertainty_column) && declaredName(spec.mapping && spec.mapping.error) &&
            stats.uncertainty_column !== spec.mapping.error) {
          add("MAPPING_ERROR_SHADOWED", "实际误差列取 statistics.uncertainty_column=" + stats.uncertainty_column +
              "，与 mapping.error=" + spec.mapping.error + " 不同；两者不一致", c, "error",
            { statistics_column: stats.uncertainty_column, mapping_column: spec.mapping.error });
        }
      }
      if (isObj(spec.characterization) && Array.isArray(spec.characterization.curves)) {
        var hasFit = spec.characterization.curves.some(function (cv) {
          return isObj(cv) && (cv.role === "fit" || cv.role === "component");
        });
        if (hasFit && !declaredName(spec.characterization.fit_source)) {
          add("FIT_SOURCE_MISSING", "存在用户提供的 fit/component 曲线列，但 fit_source 未申报；不称其为已验证拟合", c, "warning");
        }
      }
      if (c.source) {
        if (c.source.invalid_declared_sha256 !== null) {
          add("RAW_SOURCE_SHA_INVALID", "声明的 raw source SHA-256 格式非法，已按 unknown 处理", c, "error",
            { declared_sha256: c.source.invalid_declared_sha256 });
        } else if (c.source.raw_source_sha256 === "unknown") {
          add("RAW_SOURCE_SHA_UNKNOWN", "raw source SHA-256=unknown（未验证）；不以 inline content_sha256 或旧文件哈希冒充本次原始文件哈希", c, "warning",
            { raw_source_sha256: "unknown", verification: "not_verified" });
        }
        if (!c.source.locator) add("SOURCE_LOCATOR_MISSING", "未声明 data.source_ref/ref 或 statistics.source_data", c, "warning");
        var locatorDeclarations = c.source.locator_declarations.filter(function (entry, index, all) {
          return !/\.file_name$/.test(entry.field) || all.length === 1;
        });
        var locatorConflict = conflictingDeclarations(locatorDeclarations);
        if (locatorConflict) {
          add("SOURCE_REFERENCE_CONFLICT", "同一 chart 的 source locator 声明值冲突：" +
            JSON.stringify(locatorConflict), c, "warning", { declarations: locatorConflict });
        }
        var versionConflict = conflictingDeclarations(c.source.version_declarations);
        if (versionConflict) {
          add("SOURCE_VERSION_CONFLICT", "同一 chart 的 source version 声明值冲突：" +
            JSON.stringify(versionConflict), c, "warning", { declarations: versionConflict });
        }
        var hashConflict = conflictingDeclarations(c.source.hash_declarations.filter(function (entry) {
          return /^sha256:[0-9a-fA-F]{64}$/.test(entry.value) || /^[0-9a-fA-F]{64}$/.test(entry.value);
        }), function (value) { return value.replace(/^sha256:/, "").toLowerCase(); });
        if (hashConflict) {
          add("RAW_SOURCE_SHA_CONFLICT", "同一 chart 的 raw source SHA 声明值冲突：" +
            JSON.stringify(hashConflict), c, "error", { declarations: hashConflict });
        }
        if (c.source.locator) {
          var previous = sourceByLocator[c.source.locator];
          if (!previous) sourceByLocator[c.source.locator] = c;
          else {
            var differentHash = c.source.raw_source_sha256 !== "unknown" && previous.source.raw_source_sha256 !== "unknown" &&
              c.source.raw_source_sha256 !== previous.source.raw_source_sha256;
            var differentVersion = c.source.version !== null && previous.source.version !== null &&
              c.source.version !== previous.source.version;
            if (differentHash || differentVersion) {
              add("SOURCE_VERSION_CONFLICT", "同一 source locator 的图表 raw SHA/version 值不同：" +
                  previous.element_id + " 与 " + c.element_id, c, "warning", {
                    other_element_id: previous.element_id, locator: c.source.locator,
                    previous_raw_source_sha256: previous.source.raw_source_sha256,
                    raw_source_sha256: c.source.raw_source_sha256,
                    previous_version: previous.source.version, version: c.source.version,
                    differing_fields: [differentHash ? "raw_source_sha256" : null,
                      differentVersion ? "version" : null].filter(Boolean)
                  });
            }
          }
        }
      }
    });
    report.issue_count = issues.length;
    report.error_count = issues.filter(function (w) { return w.severity === "error"; }).length;
    report.warning_count = issues.length - report.error_count;
    report.status = report.error_count ? "issues_found" : (issues.length ? "warnings" : "mapped_with_partial_coverage");
    return report;
  }

  function lookup(doc, query) {
    assertDoc(doc, "lookup");
    query = query === undefined ? {} : query;
    if (!isObj(query)) throw new Error("lookup：query 须为 {element_id?, source_row?} 对象");
    var id = query.element_id === undefined ? null : query.element_id;
    if (id !== null && (typeof id !== "string" || !id)) throw new Error("lookup：element_id 必须为非空字符串");
    var sourceRow = query.source_row === undefined ? null : query.source_row;
    if (sourceRow !== null && (typeof sourceRow !== "number" || !isFinite(sourceRow) ||
        Math.floor(sourceRow) !== sourceRow || sourceRow < 0)) {
      throw new Error("lookup：source_row 必须是从 0 开始的非负整数原始行号");
    }
    var report = manifest(doc), matchedCharts = report.charts.filter(function (c) {
      return id === null || c.element_id === id;
    });
    if (id !== null && !matchedCharts.length) throw new Error("lookup：chart 元素不存在：" + id);
    if (id !== null && matchedCharts.length > 1) throw new Error("lookup：chart stable id 不唯一：" + id);
    var matches = [], matchedPoints = [];
    matchedCharts.forEach(function (c) {
      c.points.forEach(function (p) {
        var pointMatched = false;
        p.raw_points.forEach(function (rp) {
          if (sourceRow !== null && rp.source_row !== sourceRow) return;
          pointMatched = true;
          matches.push({
            element_id: c.element_id,
            chart_stable_id: c.element_id,
            chart_status: c.status,
            chart_error: c.error,
            chart_type: c.chart_type,
            point_id: p.point_id,
            semantic_key: p.semantic_key,
            series_key: p.series_key,
            series_label: p.series_label,
            aggregate: p.aggregate,
            value: p.value,
            count: p.count,
            source_row: rp.source_row,
            source_rows: p.source_rows.slice(),
            raw_point: clone(rp),
            point: clone(p)
          });
        });
        if (pointMatched) matchedPoints.push(clone(p));
      });
    });
    return {
      schema_version: "fig-lineage/1.0",
      scope: "chart_only",
      coverage: "partial",
      scientific_validation: "not_performed",
      query: { element_id: id, source_row: sourceRow },
      chart_status: id !== null && matchedCharts.length ? matchedCharts[0].status : null,
      chart_error: id !== null && matchedCharts.length ? matchedCharts[0].error : null,
      count: matches.length,
      matches: matches,
      points: matchedPoints
    };
  }

  global.FigLineage = {
    manifest: manifest,
    audit: audit,
    lookup: lookup,
    scope: "chart_only",
    coverage: "partial"
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
