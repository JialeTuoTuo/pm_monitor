/**
 * Shared Dev (zh) + ops (en) message helpers.
 * English block is reference-only for ops to copy — never auto-forwarded elsewhere.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPACTS = JSON.parse(
  readFileSync(join(__dirname, "component-impacts.json"), "utf8")
).byId;

export function getComponentMeta(componentId, fallbackName = "") {
  const row = componentId ? IMPACTS[componentId] : null;
  return {
    labelZh: row?.labelZh || fallbackName || "相关服务",
    labelEn: row?.labelEn || fallbackName || "service",
    impactZh: row?.impact || (fallbackName ? `影响：${fallbackName} 相关功能可能受影响` : "影响：相关功能可能受影响"),
    impactEn: row?.impactEn || "",
    group: row?.group || null,
    name: row?.name || fallbackName,
  };
}

function optionalImpactEn(impactEn) {
  const t = (impactEn || "").trim();
  return t ? ` May affect ${t}.` : "";
}

/** durationMins: number | null */
export function formatDurationEn(durationMins) {
  if (durationMins == null || Number.isNaN(durationMins)) return null;
  const mins = Math.max(0, Math.round(durationMins));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${h} hr` : `${h} hr ${rem} min`;
}

export function durationMinsFromStart(startedAt) {
  if (!startedAt) return null;
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - start.getTime()) / 60_000));
}

/**
 * @param {'new_incident'|'investigating'|'resolved'|'degraded'|'maintenance'|'maintenance_done'} scenario
 * @param {{ labelEn: string, impactEn?: string, durationMins?: number|null, beijingWindow?: string|null }} opts
 */
export function buildOpsEnglish(scenario, opts) {
  const labelEn = (opts.labelEn || "service").trim();
  const impactBit = optionalImpactEn(opts.impactEn);
  const dur = formatDurationEn(opts.durationMins);

  switch (scenario) {
    case "new_incident":
      return `⚠️ Polymarket: ${labelEn} is down/degraded. Team is investigating.${impactBit} Will update once resolved.`;
    case "investigating":
      return `🔧 Polymarket: ${labelEn} issue identified, fix in progress.${impactBit} ETA update soon.`;
    case "resolved":
      return dur
        ? `✅ Polymarket: ${labelEn} issue resolved (down ~${dur}). All good now.`
        : `✅ Polymarket: ${labelEn} issue resolved. All good now.`;
    case "degraded":
      return `⚠️ Polymarket: ${labelEn} running slow.${impactBit} No action needed, may resolve shortly.`;
    case "maintenance": {
      const window = (opts.beijingWindow || "").trim() || "TBD";
      const affect = (opts.impactEn || "").trim() || "related features";
      return `🔧 Polymarket: scheduled maintenance on ${labelEn}, ${window}. May affect ${affect} during this window.`;
    }
    case "maintenance_done":
      return `✅ Polymarket: maintenance on ${labelEn} complete. Back to normal.`;
    default:
      return `⚠️ Polymarket: ${labelEn} status update.${impactBit}`.trim();
  }
}

/** Append ops English reference block under Dev Chinese message. */
export function withOpsReference(zhMessage, enCopy) {
  if (!enCopy) return zhMessage;
  return [
    zhMessage,
    "",
    "——",
    "📋 运营英文参考",
    enCopy,
  ].join("\n");
}

/** Map component API status → ops English scenario */
export function componentOpsScenario(newStatusKey, oldStatusKey) {
  const s = String(newStatusKey || "").toUpperCase().replace(/[_-\s]/g, "");
  const old = String(oldStatusKey || "").toUpperCase().replace(/[_-\s]/g, "");
  if (s === "OPERATIONAL") {
    return old === "UNDERMAINTENANCE" ? "maintenance_done" : "resolved";
  }
  if (s === "DEGRADEDPERFORMANCE" || s === "MINOROUTAGE") return "degraded";
  if (s === "UNDERMAINTENANCE") return "maintenance";
  // PARTIALOUTAGE / MAJOROUTAGE / unknown outage-like
  return "new_incident";
}

/** Map incident API status → ops English scenario */
export function incidentOpsScenario(statusKey, { isNew = false, isResolved = false } = {}) {
  if (isResolved) return "resolved";
  const s = String(statusKey || "").toUpperCase().replace(/[_-\s]/g, "");
  if (s === "RESOLVED") return "resolved";
  if (s === "IDENTIFIED" || s === "MONITORING") return "investigating";
  if (s === "INVESTIGATING" || isNew) return "new_incident";
  return isNew ? "new_incident" : "investigating";
}
