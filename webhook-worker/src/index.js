/**
 * Polymarket (Instatus) status webhook → Telegram
 *
 * Signature verification follows official Instatus docs:
 * https://instatus.com/help/webhooks
 * HMAC-SHA256(secret, JSON.stringify(parsedPayload)) → hex
 * compared to header x-instatus-webhook-signature
 */

import { STATUS_LABELS, COMPONENT_IMPACTS } from "./config.js";
import {
  getComponentMeta,
  buildOpsEnglish,
  withOpsReference,
  componentOpsScenario,
  incidentOpsScenario,
  durationMinsFromStart,
  maintenanceUtcWindow,
} from "./ops-copy.js";

const STATUS_PAGE_URL = "https://status.polymarket.com";

function normalizeStatusKey(status) {
  return String(status || "")
    .trim()
    .toUpperCase()
    .replace(/[_-\s]/g, "");
}

function label(status) {
  if (!status) return "未知";
  const key = normalizeStatusKey(status);
  return STATUS_LABELS[key] || String(status);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** e.g. "2026-08-04 06:32 UTC / 14:32 北京" */
function formatNowTime() {
  const now = new Date();
  const utc = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())} ${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())} UTC`;
  // Beijing = UTC+8
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const beijing = `${pad2(bj.getUTCHours())}:${pad2(bj.getUTCMinutes())} 北京`;
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

function componentImpactLine(componentId, componentName) {
  return getComponentMeta(componentId, componentName).impactZh;
}

function componentDisplayName(component) {
  if (!component) return "未知组件";
  const name = String(component.name || component.id || "未知组件").trim();
  const impact = COMPONENT_IMPACTS[component.id];
  if (impact?.group) return `${impact.group} / ${name}`;
  return name;
}

function hexFromBuffer(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a, b) {
  const aa = String(a || "").toLowerCase();
  const bb = String(b || "").toLowerCase();
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) {
    out |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  }
  return out === 0;
}

/** Official Instatus algorithm: HMAC-SHA256(secret, JSON.stringify(payload)).digest('hex') */
async function verifyInstatusSignature(payload, signature, secret) {
  if (!signature || !secret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(JSON.stringify(payload))
  );
  return timingSafeEqualHex(hexFromBuffer(mac), signature.trim());
}

async function sendTelegram(env, text) {
  const token = env.BOT_TOKEN;
  const chatId = env.CHAT_ID;
  if (!token || !chatId) {
    throw new Error("BOT_TOKEN / CHAT_ID not configured");
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
    throw new Error(`Telegram failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function payloadSummary(payload) {
  const kinds = [];
  if (payload?.incident) {
    kinds.push({
      kind: "incident",
      id: payload.incident.id || null,
      name: payload.incident.name || null,
      status: payload.incident.status || null,
    });
  }
  if (payload?.maintenance) {
    kinds.push({
      kind: "maintenance",
      id: payload.maintenance.id || null,
      name: payload.maintenance.name || null,
      status: payload.maintenance.status || null,
    });
  }
  if (payload?.component || payload?.component_update) {
    kinds.push({
      kind: "component",
      id: payload.component?.id || payload.component_update?.component_id || null,
      name: payload.component?.name || null,
      status: payload.component_update?.new_status || payload.component?.status || null,
    });
  }
  return {
    topKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    events: kinds,
  };
}

function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function buildMessages(payload) {
  const when = formatNowTime();
  const pageUrl = payload?.page?.url || STATUS_PAGE_URL;
  const messages = [];

  if (payload.incident) {
    const inc = payload.incident;
    const subject = String(inc.name || "Service").trim();
    const status = normalizeStatusKey(inc.status);
    const link = inc.url || pageUrl;
    const latestUpdate = Array.isArray(inc.incident_updates)
      ? inc.incident_updates[inc.incident_updates.length - 1]
      : null;
    const detail =
      (latestUpdate?.body && String(latestUpdate.body).trim()) || subject;
    const meta = getComponentMeta(null, subject);

    if (status === "RESOLVED") {
      const duration = formatDuration(inc.created_at || inc.started);
      const statusLine = duration
        ? `状态：${label("RESOLVED")}（持续 ${duration}）`
        : `状态：${label("RESOLVED")}`;
      const zh = [
        `✅ 已恢复 | Polymarket ${subject}`,
        statusLine,
        `时间：${when}`,
        `🔗 ${link}`,
      ].join("\n");
      messages.push(
        withOpsReference(
          zh,
          buildOpsEnglish("resolved", {
            labelEn: meta.labelEn,
            impactEn: meta.impactEn,
            durationMins: durationMinsFromStart(inc.created_at || inc.started),
          })
        )
      );
    } else {
      const scenario = incidentOpsScenario(inc.status, { isNew: true });
      const zh = [
        `🆕 新故障 | Polymarket ${subject}`,
        `状态：${label(inc.status)}`,
        `时间：${when}`,
        `详情：${detail}`,
        `🔗 ${link}`,
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

  if (payload.component_update || payload.component) {
    const comp = payload.component || {};
    const update = payload.component_update || {};
    const newStatus = update.new_status || comp.status;
    const oldStatus = update.old_status || update.previous_status;
    const title = componentDisplayName(comp);
    const meta = getComponentMeta(comp.id || update.component_id, comp.name);
    const scenario = componentOpsScenario(newStatus, oldStatus);
    const zh = [
      `⚠️ 组件状态变化 | ${title}`,
      componentImpactLine(comp.id || update.component_id, comp.name),
      `状态变为：${label(newStatus)}`,
      `时间：${when}`,
      `🔗 ${pageUrl}`,
    ].join("\n");
    messages.push(
      withOpsReference(
        zh,
        buildOpsEnglish(scenario, {
          labelEn: meta.labelEn,
          impactEn: meta.impactEn,
          utcWindow: maintenanceUtcWindow({
            start: update.created_at,
            duration: null,
          }),
        })
      )
    );
  }

  if (payload.maintenance) {
    const m = payload.maintenance;
    const subject = String(m.name || "维护").trim();
    const status = normalizeStatusKey(m.status);
    const link = m.url || pageUrl;
    const meta = getComponentMeta(null, subject);
    const window = maintenanceUtcWindow(m);

    if (status === "COMPLETED") {
      const zh = [
        `✅ 已恢复 | Polymarket ${subject}`,
        `状态：${label("COMPLETED")}`,
        `时间：${when}`,
        `🔗 ${link}`,
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
    } else {
      const zh = [
        `🛠️ 计划维护 | Polymarket ${subject}`,
        `状态：${label(m.status)}`,
        `时间：${when}`,
        `详情：计划维护 / ${subject}`,
        `🔗 ${link}`,
      ].join("\n");
      messages.push(
        withOpsReference(
          zh,
          buildOpsEnglish("maintenance", {
            labelEn: meta.labelEn,
            impactEn: meta.impactEn,
            utcWindow: window,
          })
        )
      );
    }
  }

  return messages;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return new Response(
          JSON.stringify({
            ok: true,
            service: "pm-status-webhook",
            hint: "POST Instatus webhooks to /webhook",
          }),
          { headers: { "content-type": "application/json; charset=utf-8" } }
        );
      }

      if (request.method === "POST" && (url.pathname === "/webhook" || url.pathname === "/")) {
        if (!env.WEBHOOK_SECRET) {
          logEvent("webhook.reject", { reason: "WEBHOOK_SECRET_missing", httpStatus: 503 });
          return new Response("WEBHOOK_SECRET not configured", { status: 503 });
        }
        if (!env.BOT_TOKEN || !env.CHAT_ID) {
          logEvent("webhook.reject", { reason: "telegram_secrets_missing", httpStatus: 503 });
          return new Response("BOT_TOKEN/CHAT_ID not configured", { status: 503 });
        }

        let payload;
        try {
          payload = await request.json();
        } catch {
          logEvent("webhook.reject", { reason: "invalid_json", httpStatus: 400 });
          return new Response("Invalid JSON", { status: 400 });
        }

        const signature = request.headers.get("x-instatus-webhook-signature");
        const summary = payloadSummary(payload);
        if (!signature) {
          logEvent("webhook.reject", {
            reason: "signature_missing",
            httpStatus: 400,
            ...summary,
          });
          return new Response("Signature missing", { status: 400 });
        }

        const valid = await verifyInstatusSignature(
          payload,
          signature,
          env.WEBHOOK_SECRET
        );
        if (!valid) {
          logEvent("webhook.reject", {
            reason: "invalid_signature",
            httpStatus: 401,
            hasSignature: true,
            signatureLen: signature.trim().length,
            ...summary,
          });
          return new Response("Invalid signature", { status: 401 });
        }

        const messages = buildMessages(payload);
        if (messages.length === 0) {
          logEvent("webhook.ok_no_forward", {
            reason: "no_matching_event_fields",
            httpStatus: 200,
            forwarded: 0,
            ...summary,
          });
          return new Response(
            JSON.stringify({ ok: true, forwarded: 0, note: "no matching event fields" }),
            { headers: { "content-type": "application/json; charset=utf-8" } }
          );
        }

        for (let i = 0; i < messages.length; i++) {
          await sendTelegram(env, messages[i]);
          logEvent("webhook.telegram_sent", {
            index: i + 1,
            total: messages.length,
            chars: messages[i].length,
          });
        }

        logEvent("webhook.ok", {
          httpStatus: 200,
          forwarded: messages.length,
          ...summary,
        });
        return new Response(JSON.stringify({ ok: true, forwarded: messages.length }), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      logEvent("webhook.error", {
        httpStatus: 500,
        message: err?.message || String(err),
      });
      console.error("Unhandled error:", err?.stack || err?.message || String(err));
      return new Response(`Internal error: ${err?.message || String(err)}`, { status: 500 });
    }
  },
};
