// check_sources_queue_retry.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// ============================================================
// 配置
// ============================================================

const CONFIG_PATH = path.join(__dirname, "LunaTV-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");

const MAX_DAYS = 30;
const WARN_STREAK = 3;

const ENABLE_SEARCH_TEST = true;

// 默认测试关键词
// 也可以通过命令行传入：
// node check_sources_queue_retry.js "斗罗大陆,熊出没,庆余年"
const SEARCH_KEYWORDS = (
  process.argv[2] || "斗罗大陆,熊出没,庆余年"
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const TIMEOUT_MS = 10000;

// 并发限制
const CONCURRENT_LIMIT = 10;

// 最大重试次数
const MAX_RETRY = 3;

// 重试间隔
const RETRY_DELAY_MS = 500;


// ============================================================
// 加载配置
// ============================================================

if (!fs.existsSync(CONFIG_PATH)) {
  console.error("❌ 配置文件不存在:", CONFIG_PATH);
  process.exit(1);
}

let config;

try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
} catch (err) {
  console.error("❌ 配置文件 JSON 格式错误:", err.message);
  process.exit(1);
}

if (!config.api_site || typeof config.api_site !== "object") {
  console.error("❌ 配置中不存在 api_site");
  process.exit(1);
}

const apiEntries = Object.values(config.api_site)
  .filter((s) => s && s.api)
  .map((s) => ({
    name: s.name || "未命名资源",
    api: s.api,
    detail: s.detail || "-",
    disabled: !!s.disabled,
  }));


// ============================================================
// 读取历史记录
// ============================================================

let history = [];

if (fs.existsSync(REPORT_PATH)) {
  try {
    const old = fs.readFileSync(REPORT_PATH, "utf-8");

    const match = old.match(/```json\n([\s\S]+?)\n```/);

    if (match) {
      try {
        history = JSON.parse(match[1]);

        if (!Array.isArray(history)) {
          history = [];
        }
      } catch (err) {
        console.warn("⚠️ 历史 JSON 解析失败，将重新开始记录");
        history = [];
      }
    }
  } catch (err) {
    console.warn("⚠️ 读取历史报告失败:", err.message);
  }
}


// ============================================================
// 当前 CST 时间
// ============================================================

const now =
  new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 16) + " CST";


// ============================================================
// 工具函数
// ============================================================

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


// ------------------------------------------------------------
// 安全 GET
// ------------------------------------------------------------

const safeGet = async (url) => {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      });

      if (res.status >= 200 && res.status < 300) {
        return {
          success: true,
          status: res.status,
          data: res.data,
        };
      }

      if (attempt < MAX_RETRY) {
        await delay(RETRY_DELAY_MS);
      }
    } catch (err) {
      if (attempt < MAX_RETRY) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  return {
    success: false,
    status: 0,
    data: null,
  };
};


// ------------------------------------------------------------
// 从各种常见 API JSON 结构中提取列表
// ------------------------------------------------------------

const extractList = (data) => {
  if (!data) return [];

  // API 直接返回数组
  if (Array.isArray(data)) {
    return data;
  }

  // 常见结构
  const candidates = [
    data.list,
    data.data?.list,
    data.data?.data,
    data.data,
    data.result?.list,
    data.result?.data,
    data.result?.data?.list,
  ];

  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
};


// ------------------------------------------------------------
// 判断搜索结果是否真正包含关键词
// ------------------------------------------------------------

const resultContainsKeyword = (item, keyword) => {
  if (!item) return false;

  const text = JSON.stringify(item);

  if (text.includes(keyword)) {
    return true;
  }

  // 常见影视字段再次单独检查
  const fields = [
    "name",
    "vod_name",
    "title",
    "vodName",
    "vod_title",
    "vodTitle",
    "showName",
    "show_name",
  ];

  for (const field of fields) {
    if (
      item[field] !== undefined &&
      String(item[field]).includes(keyword)
    ) {
      return true;
    }
  }

  return false;
};


// ------------------------------------------------------------
// 测试单个关键词
// ------------------------------------------------------------

const testSearch = async (api, keyword) => {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const url = `${api}?wd=${encodeURIComponent(keyword)}`;

      const res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      });

      // HTTP 错误
      if (res.status < 200 || res.status >= 300) {
        if (attempt < MAX_RETRY) {
          await delay(RETRY_DELAY_MS);
          continue;
        }

        return {
          status: "❌",
          detail: `HTTP ${res.status}`,
        };
      }

      // 返回不是对象
      if (
        !res.data ||
        (typeof res.data !== "object" &&
          !Array.isArray(res.data))
      ) {
        return {
          status: "❌",
          detail: "返回格式异常",
        };
      }

      const list = extractList(res.data);

      // 有返回，但没有找到列表
      if (!list.length) {
        return {
          status: "⚠️",
          detail: "无结果",
        };
      }

      // 检查关键词
      const matched = list.some((item) =>
        resultContainsKeyword(item, keyword)
      );

      if (matched) {
        return {
          status: "✅",
          detail: `命中 ${list.length} 条`,
        };
      }

      return {
        status: "⚠️",
        detail: `有 ${list.length} 条结果但未匹配关键词`,
      };
    } catch (err) {
      if (attempt < MAX_RETRY) {
        await delay(RETRY_DELAY_MS);
      } else {
        return {
          status: "❌",
          detail: "请求失败",
        };
      }
    }
  }

  return {
    status: "❌",
    detail: "请求失败",
  };
};


// ------------------------------------------------------------
// 测试多个关键词
// ------------------------------------------------------------

const testAllSearches = async (api) => {
  const searchResults = {};

  for (const keyword of SEARCH_KEYWORDS) {
    searchResults[keyword] = await testSearch(api, keyword);
  }

  return searchResults;
};


// ------------------------------------------------------------
// 队列并发执行
// ------------------------------------------------------------

const queueRun = (tasks, limit) => {
  let index = 0;
  let active = 0;

  const results = new Array(tasks.length);

  return new Promise((resolve) => {
    const next = () => {
      while (active < limit && index < tasks.length) {
        const i = index++;

        active++;

        Promise.resolve()
          .then(() => tasks[i]())
          .then((res) => {
            results[i] = res;
          })
          .catch((err) => {
            results[i] = {
              error: err.message || String(err),
            };
          })
          .finally(() => {
            active--;
            next();
          });
      }

      if (index >= tasks.length && active === 0) {
        resolve(results);
      }
    };

    next();
  });
};


// ============================================================
// 搜索状态汇总
// ============================================================

const formatSearchStatus = (searchResults) => {
  if (!searchResults || typeof searchResults !== "object") {
    return "-";
  }

  return SEARCH_KEYWORDS
    .map((keyword) => {
      const result = searchResults[keyword];

      if (!result) {
        return `${keyword}:❓`;
      }

      return `${keyword}:${result.status}`;
    })
    .join(" ");
};


// ============================================================
// 主逻辑
// ============================================================

(async () => {
  console.log("");
  console.log("========================================");
  console.log("🚀 LunaTV 源接口健康检测");
  console.log("========================================");
  console.log("");

  console.log(`📡 源数量: ${apiEntries.length}`);
  console.log(`🔎 测试关键词: ${SEARCH_KEYWORDS.join(" / ")}`);
  console.log(`⚡ 并发限制: ${CONCURRENT_LIMIT}`);
  console.log(`🔁 最大重试: ${MAX_RETRY}`);
  console.log("");

  const tasks = apiEntries.map(
    ({ name, api, disabled }) =>
      async () => {
        // ----------------------------------------------------
        // 禁用源
        // ----------------------------------------------------

        if (disabled) {
          console.log(`🚫 ${name} - 已禁用`);

          return {
            name,
            api,
            disabled,
            success: false,
            searchResults: {},
            searchStatus: "已禁用",
          };
        }

        // ----------------------------------------------------
        // 第一阶段：测试 API 本身
        // ----------------------------------------------------

        console.log(`⏳ 检测: ${name}`);

        const apiResult = await safeGet(api);

        if (!apiResult.success) {
          console.log(`❌ ${name} - API 不可用`);

          return {
            name,
            api,
            disabled,
            success: false,
            searchResults: {},
            searchStatus: "接口不可用",
          };
        }

        // ----------------------------------------------------
        // 第二阶段：搜索测试
        // ----------------------------------------------------

        let searchResults = {};

        if (ENABLE_SEARCH_TEST) {
          searchResults = await testAllSearches(api);
        }

        const searchStatus = formatSearchStatus(searchResults);

        console.log(
          `✅ ${name} - API 正常 - ${searchStatus}`
        );

        return {
          name,
          api,
          disabled,
          success: true,
          searchResults,
          searchStatus,
        };
      }
  );

  // ==========================================================
  // 执行检测
  // ==========================================================

  const todayResults = await queueRun(
    tasks,
    CONCURRENT_LIMIT
  );


  // ==========================================================
  // 保存当天记录
  // ==========================================================

  const todayRecord = {
    date: new Date().toISOString().slice(0, 10),
    keyword: SEARCH_KEYWORDS.join(","),
    results: todayResults,
  };

  history.push(todayRecord);

  // 只保留最近 MAX_DAYS 天
  if (history.length > MAX_DAYS) {
    history = history.slice(-MAX_DAYS);
  }


  // ==========================================================
  // 统计
  // ==========================================================

  const stats = {};

  for (const {
    name,
    api,
    detail,
    disabled,
  } of apiEntries) {
    stats[api] = {
      name,
      api,
      detail,
      disabled,

      ok: 0,
      fail: 0,

      fail_streak: 0,

      trend: "",

      searchStatus: "-",
      searchResults: {},

      status: "❌",
    };


    // --------------------------------------------------------
    // 统计成功 / 失败
    // --------------------------------------------------------

    for (const day of history) {
      if (!day.results) continue;

      const rec = day.results.find(
        (x) => x.api === api
      );

      if (!rec) continue;

      if (rec.success) {
        stats[api].ok++;
      } else {
        stats[api].fail++;
      }
    }


    // --------------------------------------------------------
    // 连续失败次数
    // --------------------------------------------------------

    let streak = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const rec = history[i].results?.find(
        (x) => x.api === api
      );

      if (!rec) continue;

      if (rec.success) {
        break;
      }

      streak++;
    }

    stats[api].fail_streak = streak;


    // --------------------------------------------------------
    // 成功率
    // --------------------------------------------------------

    const total =
      stats[api].ok +
      stats[api].fail;

    stats[api].successRate =
      total > 0
        ? (
            (stats[api].ok / total) *
            100
          ).toFixed(1) + "%"
        : "-";


    // --------------------------------------------------------
    // 最近 7 天趋势
    // --------------------------------------------------------

    const recent = history.slice(-7);

    stats[api].trend = recent
      .map((day) => {
        const r = day.results?.find(
          (x) => x.api === api
        );

        if (!r) return "-";

        return r.success ? "✅" : "❌";
      })
      .join("");


    // --------------------------------------------------------
    // 今天的搜索结果
    // --------------------------------------------------------

    const latest = todayResults.find(
      (x) => x.api === api
    );

    if (latest) {
      stats[api].searchStatus =
        latest.searchStatus || "-";

      stats[api].searchResults =
        latest.searchResults || {};
    }


    // --------------------------------------------------------
    // 综合状态
    // --------------------------------------------------------

    if (disabled) {
      stats[api].status = "🚫";
    } else if (streak >= WARN_STREAK) {
      stats[api].status = "🚨";
    } else if (latest?.success) {
      stats[api].status = "✅";
    } else {
      stats[api].status = "❌";
    }
  }


  // ==========================================================
  // 生成 Markdown
  // ==========================================================

  let md = "";

  md += "# 源接口健康检测报告\n\n";

  md += `最近更新时间：${now}\n\n`;

  md += `**总源数:** ${apiEntries.length} | `;

  md += `**检测关键词:** ${SEARCH_KEYWORDS.join(
    "、"
  )}\n\n`;


  // ----------------------------------------------------------
  // 统计概览
  // ----------------------------------------------------------

  const enabledStats = Object.values(stats).filter(
    (s) => !s.disabled
  );

  const healthyCount = enabledStats.filter(
    (s) => s.status === "✅"
  ).length;

  const warningCount = enabledStats.filter(
    (s) => s.status === "🚨"
  ).length;

  const failedCount = enabledStats.filter(
    (s) => s.status === "❌"
  ).length;

  const disabledCount = Object.values(stats).filter(
    (s) => s.disabled
  ).length;


  md += "## 检测概览\n\n";

  md += `- 🟢 正常：${healthyCount}\n`;
  md += `- 🚨 连续失败：${warningCount}\n`;
  md += `- ❌ 当前失败：${failedCount}\n`;
  md += `- 🚫 已禁用：${disabledCount}\n\n`;


  // ----------------------------------------------------------
  // 主表格
  // ----------------------------------------------------------

  md +=
    "| 状态 | 资源名称 | 地址 | API | 搜索功能 | 成功次数 | 失败次数 | 成功率 | 最近7天趋势 |\n";

  md +=
    "|------|---------|-----|-----|---------|---------:|--------:|-------:|--------------|\n";


  const sorted = Object.values(stats).sort(
    (a, b) => {
      const order = {
        "🚨": 1,
        "❌": 2,
        "✅": 3,
        "🚫": 4,
      };

      return (
        (order[a.status] || 99) -
        (order[b.status] || 99)
      );
    }
  );


  for (const s of sorted) {
    const detailLink =
      typeof s.detail === "string" &&
      s.detail.startsWith("http")
        ? `[Link](${s.detail})`
        : s.detail;

    const apiLink = `[Link](${s.api})`;

    md += `| ${s.status} | ${s.name} | ${detailLink} | ${apiLink} | ${s.searchStatus} | ${s.ok} | ${s.fail} | ${s.successRate} | ${s.trend} |\n`;
  }


  // ==========================================================
  // 搜索详细结果
  // ==========================================================

  md += "\n## 🔎 今日搜索测试详情\n\n";

  md +=
    "| 资源名称 | API 状态 | " +
    SEARCH_KEYWORDS.join(" | ") +
    " |\n";

  md +=
    "|---------|---------|" +
    SEARCH_KEYWORDS.map(() => "---------|").join("") +
    "\n";


  for (const s of sorted) {
    const latest = todayResults.find(
      (x) => x.api === s.api
    );

    if (!latest) continue;

    let row =
      `| ${s.name} | ` +
      `${latest.success ? "✅ 正常" : "❌ 失败"} |`;

    for (const keyword of SEARCH_KEYWORDS) {
      const result =
        latest.searchResults?.[keyword];

      if (!result) {
        row += " ❓ |";
      } else {
        row += ` ${result.status} ${result.detail} |`;
      }
    }

    md += row + "\n";
  }


  // ==========================================================
  // 状态说明
  // ==========================================================

  md += "\n## 📖 状态说明\n\n";

  md +=
    "- ✅ API 正常，搜索结果中成功匹配关键词\n";

  md +=
    "- ⚠️ API 正常，但没有结果或结果没有匹配关键词\n";

  md +=
    "- ❌ API 请求失败或返回格式异常\n";

  md +=
    "- 🚨 连续失败达到预警阈值\n";

  md +=
    "- 🚫 配置中已禁用的源\n";


  // ==========================================================
  // 历史 JSON
  // ==========================================================

  md +=
    "\n<details>\n" +
    "<summary>📜 点击展开查看历史检测数据 (JSON)</summary>\n\n";

  md +=
    "```json\n" +
    JSON.stringify(history, null, 2) +
    "\n```\n";

  md += "</details>\n";


  // ==========================================================
  // 写入报告
  // ==========================================================

  fs.writeFileSync(
    REPORT_PATH,
    md,
    "utf-8"
  );


  // ==========================================================
  // 最终输出
  // ==========================================================

  console.log("");
  console.log("========================================");
  console.log("✅ 检测完成");
  console.log("========================================");
  console.log(`📄 报告: ${REPORT_PATH}`);
  console.log(`📡 源数量: ${apiEntries.length}`);
  console.log(`🟢 正常: ${healthyCount}`);
  console.log(`🚨 连续失败: ${warningCount}`);
  console.log(`❌ 失败: ${failedCount}`);
  console.log(`🚫 禁用: ${disabledCount}`);
  console.log("");
})();
