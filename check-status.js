#!/usr/bin/env node
/**
 * Polymarket Status → Telegram monitor
 *
 * Data sources (Instatus public API, no auth):
 *   - https://status.polymarket.com/v3/summary.json  (page + activeIncidents)
 *   - https://status.polymarket.com/v3/components.json (11 nested components)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  getComponentMeta,
  buildOpsEnglish,
  withOpsReference,
  componentOpsScenario,
  incidentOpsScenario,
  maintenanceOpsScenario,
  maintenanceBeijingWindow,
  durationMinsFromStart,
} from "./config/ops-copy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });

const SUMMARY_URL =
  process.env.SUMMARY_URL || "https://status.polymarket.com/v3/summary.json";
const COMPONENTS_URL =
  process.env.COMPONENTS_URL || "https://status.polymarket.com/v3/components.json";
const STATE_FILE = join(__dirname, "last_state.json");
const STATUS_LABELS_FILE = join(__dirname, "config", "status-labels.zh.json");
const FETCH_TIMEOUT_MS = 20_000;
const STATUS_PAGE_URL = "https://status.polymarket.com";

function loadJsonConfig(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.warn(`Failed to load config ${path}: ${err.message}`);
    return null;
  }
}

const STATUS_LABELS = loadJsonConfig(STATUS_LABELS_FILE)?.labels || {};

function normalizeStatusKey(status) {
  return String(status || "")
    .trim()
    .toUpperCase()
    .replace(/[_-\s]/g, "");
}

/** Human-readable Chinese status; never paste raw API enums into Telegram text. */
function label(status) {
  if (!status) return "未知";
  const key = normalizeStatusKey(status);
  return STATUS_LABELS[key] || STATUS_LABELS[status] || String(status);
}

function componentImpact(comp) {
  return getComponentMeta(comp.id, componentLabel(comp)).impactZh;
}

/** e.g. "2026-08-04 06:32 UTC / 14:32 北京" */
function formatNowTime() {
  const now = new Date();
  const utcParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  const bjParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  const utc = `${utcParts.year}-${utcParts.month}-${utcParts.day} ${utcParts.hour}:${utcParts.minute} UTC`;
  const beijing = `${bjParts.hour}:${bjParts.minute} 北京`;
  return `${utc} / ${beijing}`;
}

function formatDuration(startedAt) {
  if (!startedAt) return null;
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return null;
  const mins = Math.max(0, Math.round((Date.now() - start.getTime()) / 60_000));
  if (mins < 60) return `${mins}分钟`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours}小时` : `${hours}小时${rem}分钟`;
}

function componentLabel(comp) {
  const name = (comp.name || comp.id || "").trim();
  const group = comp.group ? String(comp.group).trim() : "";
  return group ? `${group} / ${name}` : name;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "polymarket-status-bot/1.0" },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCurrentStatus() {
  const [summary, componentsPayload] = await Promise.all([
    fetchJson(SUMMARY_URL),
    fetchJson(COMPONENTS_URL),
  ]);

  const page = summary?.page ?? {};

  // activeIncidents may be missing or empty when nothing is ongoing
  const rawIncidents = Array.isArray(summary?.activeIncidents)
    ? summary.activeIncidents
    : [];

  const rawMaintenances = Array.isArray(summary?.activeMaintenances)
    ? summary.activeMaintenances
    : [];

  // { components: [ { id, name, status, group } ] }
  const rawComponents = Array.isArray(componentsPayload?.components)
    ? componentsPayload.components
    : Array.isArray(componentsPayload)
      ? componentsPayload
      : [];

  const components = rawComponents
    .filter((c) => c?.id)
    .map((c) => ({
      id: c.id,
      name: String(c.name || c.id).trim(),
      status: c.status || "UNKNOWN",
      group: c.group?.name ? String(c.group.name).trim() : null,
    }));

  const incidents = rawIncidents.map((i) => ({
    id: i.id || i.url || `${i.name}-${i.started}`,
    name: String(i.name || "Untitled incident").trim(),
    status: i.status || "UNKNOWN",
    impact: i.impact || null,
    started: i.started || null,
    updatedAt: i.updatedAt || null,
    url: i.url || null,
  }));

  const maintenances = rawMaintenances.map((m) => ({
    id: m.id || m.url || `${m.name}-${m.start}`,
    name: String(m.name || "Untitled maintenance").trim(),
    status: m.status || "UNKNOWN",
    start: m.start || null,
    duration: m.duration ?? null,
    url: m.url || null,
  }));

  return {
    pageStatus: page.status || "UNKNOWN",
    pageUrl: page.url || "https://status.polymarket.com",
    components,
    incidents,
    maintenances,
    lastChecked: new Date().toISOString(),
  };
}

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return normalizeState(JSON.parse(readFileSync(STATE_FILE, "utf8")));
  } catch (err) {
    console.warn(`Failed to parse ${STATE_FILE}, treating as first run:`, err.message);
    return null;
  }
}

/** Normalize legacy object-map formats into arrays used for comparison. */
function normalizeState(raw) {
  if (!raw || typeof raw !== "object") return null;

  let components = [];
  if (Array.isArray(raw.components)) {
    components = raw.components.map((c) => ({
      id: c.id,
      name: String(c.name || c.id || "").trim(),
      status: c.status || "UNKNOWN",
      group: c.group ?? null,
    }));
  } else if (raw.components && typeof raw.components === "object") {
    // Legacy: { [id]: "OPERATIONAL" } or { [id]: { name, status, group } }
    components = Object.entries(raw.components).map(([id, value]) => {
      if (value && typeof value === "object") {
        return {
          id,
          name: String(value.name || id).trim(),
          status: value.status || "UNKNOWN",
          group: value.group ?? null,
        };
      }
      return { id, name: id, status: String(value), group: null };
    });
  }

  let incidents = [];
  if (Array.isArray(raw.incidents)) {
    incidents = raw.incidents.map((i) => ({
      id: i.id,
      name: String(i.name || i.id || "").trim(),
      status: i.status || "UNKNOWN",
      started: i.started || null,
    }));
  } else if (raw.incidents && typeof raw.incidents === "object") {
    // Legacy: { [id]: { name, status } }
    incidents = Object.entries(raw.incidents).map(([id, value]) => ({
      id,
      name: String(value?.name || id).trim(),
      status: value?.status || "UNKNOWN",
      started: value?.started || null,
    }));
  } else if (Array.isArray(raw.incidentIds)) {
    incidents = raw.incidentIds.map((id) => ({
      id,
      name: id,
      status: "UNKNOWN",
      started: null,
    }));
  }

  return {
    pageStatus: raw.pageStatus || "UNKNOWN",
    components,
    incidents,
    maintenances: Array.isArray(raw.maintenances)
      ? raw.maintenances.map((m) => ({
          id: m.id,
          name: String(m.name || m.id || "").trim(),
          status: m.status || "UNKNOWN",
          start: m.start || null,
          duration: m.duration ?? null,
          url: m.url || null,
        }))
      : [],
    lastChecked: raw.lastChecked || raw.updatedAt || null,
  };
}

function saveState(current) {
  const state = {
    pageStatus: current.pageStatus,
    components: current.components.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      group: c.group,
    })),
    incidents: current.incidents.map((i) => ({
      id: i.id,
      name: i.name,
      status: i.status,
      started: i.started || null,
    })),
    maintenances: current.maintenances.map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      start: m.start || null,
      duration: m.duration ?? null,
      url: m.url || null,
    })),
    lastChecked: current.lastChecked,
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function diff(prev, current) {
  const messages = [];
  const pageUrl = current.pageUrl || STATUS_PAGE_URL;
  const when = formatNowTime();

  // --- Incidents (highest priority) ---
  const prevIncidentsById = new Map((prev.incidents || []).map((i) => [i.id, i]));
  const currentIncidentIds = new Set(current.incidents.map((i) => i.id));

  for (const inc of current.incidents) {
    const old = prevIncidentsById.get(inc.id);
    const subject = inc.name || "Service";
    const meta = getComponentMeta(null, subject);
    if (!old) {
      const scenario = incidentOpsScenario(inc.status, { isNew: true });
      const zh = [
        `🆕 新故障 | Polymarket ${subject}`,
        `状态：${label(inc.status)}`,
        `时间：${when}`,
        `详情：${inc.name}`,
        `🔗 ${inc.url || pageUrl}`,
      ].join("\n");
      messages.push(
        withOpsReference(
          zh,
          buildOpsEnglish(scenario, {
            labelEn: meta.labelEn,
            impactEn: meta.impactEn,
          })
        )
      );
    } else if (old.status !== inc.status) {
      const scenario = incidentOpsScenario(inc.status);
      const zh = [
        `⚠️ 状态更新 | Polymarket ${subject}`,
        `${label(old.status)} → ${label(inc.status)}`,
        `时间：${when}`,
        `🔗 ${inc.url || pageUrl}`,
      ].join("\n");
      messages.push(
        withOpsReference(
          zh,
          buildOpsEnglish(scenario, {
            labelEn: meta.labelEn,
            impactEn: meta.impactEn,
            durationMins: durationMinsFromStart(old.started || inc.started),
          })
        )
      );
    }
  }

  for (const [id, old] of prevIncidentsById) {
    if (!currentIncidentIds.has(id)) {
      const subject = old.name || id;
      const meta = getComponentMeta(null, subject);
      const duration = formatDuration(old.started);
      const statusLine = duration
        ? `状态：${label("RESOLVED")}（持续 ${duration}）`
        : `状态：${label("RESOLVED")}`;
      const zh = [
        `✅ 已恢复 | Polymarket ${subject}`,
        statusLine,
        `时间：${when}`,
        `🔗 ${pageUrl}`,
      ].join("\n");
      messages.push(
        withOpsReference(
          zh,
          buildOpsEnglish("resolved", {
            labelEn: meta.labelEn,
            impactEn: meta.impactEn,
            durationMins: durationMinsFromStart(old.started),
          })
        )
      );
    }
  }

  // --- Maintenances (activeMaintenances from summary) ---
  const prevMaintenancesById = new Map(
    (prev.maintenances || []).map((m) => [m.id, m])
  );
  const currentMaintenanceIds = new Set(current.maintenances.map((m) => m.id));

  for (const m of current.maintenances) {
    const old = prevMaintenancesById.get(m.id);
    const subject = m.name || "维护";
    const meta = getComponentMeta(null, subject);
    const window = maintenanceBeijingWindow(m);
    if (!old) {
      const scenario = maintenanceOpsScenario(m.status, { isNew: true });
      const zh = [
        `🛠️ 计划维护 | Polymarket ${subject}`,
        `状态：${label(m.status)}`,
        window ? `窗口：${window}` : null,
        `时间：${when}`,
        `🔗 ${m.url || pageUrl}`,
      ]
        .filter(Boolean)
        .join("\n");
      messages.push(
        withOpsReference(
          zh,
          buildOpsEnglish(scenario, {
            labelEn: meta.labelEn,
            impactEn: meta.impactEn,
            beijingWindow: window,
          })
        )
      );
    } else if (old.status !== m.status) {
      const scenario = maintenanceOpsScenario(m.status);
      const title =
        normalizeStatusKey(m.status) === "COMPLETED"
          ? `✅ 维护完成 | Polymarket ${subject}`
          : `🛠️ 维护更新 | Polymarket ${subject}`;
      const zh = [
        title,
        `${label(old.status)} → ${label(m.status)}`,
        window ? `窗口：${window}` : null,
        `时间：${when}`,
        `🔗 ${m.url || pageUrl}`,
      ]
        .filter(Boolean)
        .join("\n");
      messages.push(
        withOpsReference(
          zh,
          buildOpsEnglish(scenario, {
            labelEn: meta.labelEn,
            impactEn: meta.impactEn,
            beijingWindow: window,
          })
        )
      );
    }
  }

  for (const [id, old] of prevMaintenancesById) {
    if (!currentMaintenanceIds.has(id)) {
      const subject = old.name || id;
      const meta = getComponentMeta(null, subject);
      const zh = [
        `✅ 维护完成 | Polymarket ${subject}`,
        `状态：${label("COMPLETED")}`,
        `时间：${when}`,
        `🔗 ${old.url || pageUrl}`,
      ].join("\n");
      messages.push(
        withOpsReference(
          zh,
          buildOpsEnglish("maintenance_done", {
            labelEn: meta.labelEn,
            impactEn: meta.impactEn,
          })
        )
      );
    }
  }

  // --- Components: compare by id + status only ---
  const prevComponentsById = new Map((prev.components || []).map((c) => [c.id, c]));
  for (const comp of current.components) {
    const old = prevComponentsById.get(comp.id);
    if (!old) continue;
    if (old.status !== comp.status) {
      const meta = getComponentMeta(comp.id, componentLabel(comp));
      const scenario = componentOpsScenario(comp.status, old.status);
      const zh = [
        `⚠️ 组件状态变化 | ${componentLabel(comp)}`,
        meta.impactZh,
        `${label(old.status)} → ${label(comp.status)}`,
        `时间：${when}`,
        `🔗 ${pageUrl}`,
      ].join("\n");
      messages.push(
        withOpsReference(
          zh,
          buildOpsEnglish(scenario, {
            labelEn: meta.labelEn,
            impactEn: meta.impactEn,
          })
        )
      );
    }
  }

  return messages;
}

async function sendTelegram(text) {
  const token = process.env.BOT_TOKEN;
  const chatId = process.env.CHAT_ID;

  if (!token || !chatId) {
    throw new Error("BOT_TOKEN and CHAT_ID environment variables are required");
  }

  const url = `${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(
      `Telegram sendMessage failed: HTTP ${res.status} ${JSON.stringify(body)}`
    );
  }
}

async function main() {
  let current;
  try {
    current = await fetchCurrentStatus();
  } catch (err) {
    console.error(`Fetch failed, skipping this poll: ${err.message}`);
    process.exit(0);
  }

  console.log(
    `Fetched status: page=${current.pageStatus}, components=${current.components.length}, incidents=${current.incidents.length}, maintenances=${current.maintenances.length}`
  );

  const prev = loadState();

  if (!prev) {
    saveState(current);
    console.log("First run: state saved, no notifications sent.");
    return;
  }

  const messages = diff(prev, current);

  if (messages.length === 0) {
    saveState(current);
    console.log("No changes. State updated.");
    return;
  }

  let sendFailures = 0;
  for (const text of messages) {
    try {
      await sendTelegram(text);
      console.log("Sent notification:\n" + text + "\n");
    } catch (err) {
      sendFailures += 1;
      console.error(`Failed to send Telegram message: ${err.message}`);
    }
  }

  if (sendFailures > 0) {
    console.error(
      `${sendFailures}/${messages.length} Telegram message(s) failed; state not updated.`
    );
    process.exit(1);
  }

  saveState(current);
  console.log("State updated.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
