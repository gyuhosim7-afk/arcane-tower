var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
import { DurableObject } from "cloudflare:workers";
var MAX_PLAYERS = 40;
var clean = /* @__PURE__ */ __name((v, n) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").slice(0, n), "clean");
var num = /* @__PURE__ */ __name((v, lo, hi) => Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : lo, "num");
var ELS = ["fire", "water", "ice", "wind", "earth", "thunder", "holy", "dark", "none"];
var worker_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/town") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
      const ch = clean(url.searchParams.get("ch") || "1", 3).replace(/\D/g, "") || "1";
      return env.TOWN.get(env.TOWN.idFromName("town-" + ch)).fetch(req);
    }
    return new Response("arcane-tower town server ok", { headers: { "access-control-allow-origin": "*" } });
  }
};
var Town = class extends DurableObject {
  static {
    __name(this, "Town");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }
  async fetch() {
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) return new Response("full", { status: 503 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID().slice(0, 8), p: null, lastChat: 0, n: 0, win: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }
  others(ws) {
    return this.ctx.getWebSockets().filter((w) => w !== ws);
  }
  send(ws, o) {
    try {
      ws.send(JSON.stringify(o));
    } catch {
    }
  }
  broadcast(from, o) {
    const s = JSON.stringify(o);
    for (const w of this.others(from)) try {
      w.send(s);
    } catch {
    }
  }
  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment();
    const now = Date.now();
    if (now - a.win > 1e3) {
      a.win = now;
      a.n = 0;
    }
    if (++a.n > 30 || typeof raw !== "string" || raw.length > 600) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === "hi") {
      a.p = {
        id: a.id,
        nick: clean(m.nick, 12) || "\uB9C8\uBC95\uC0AC",
        title: clean(m.title, 16),
        el: ELS.includes(m.el) ? m.el : "none",
        job: clean(m.job, 10),
        lv: num(m.lv, 1, 999) | 0,
        rb: m.rb >= 0 && m.rb <= 6 ? m.rb | 0 : -1,
        x: num(m.x, 0, 4e3),
        y: num(m.y, 0, 4e3),
        f: m.f < 0 ? -1 : 1,
        w: 0
      };
      ws.serializeAttachment(a);
      const list = this.others(ws).map((w) => w.deserializeAttachment().p).filter(Boolean);
      this.send(ws, { t: "all", me: a.id, list });
      this.broadcast(ws, { t: "join", p: a.p });
      return;
    }
    if (!a.p) return;
    if (m.t === "mv") {
      a.p.x = num(m.x, 0, 4e3);
      a.p.y = num(m.y, 0, 4e3);
      a.p.f = m.f < 0 ? -1 : 1;
      a.p.w = m.w ? 1 : 0;
      ws.serializeAttachment(a);
      this.broadcast(ws, { t: "mv", id: a.id, x: a.p.x, y: a.p.y, f: a.p.f, w: a.p.w });
    } else if (m.t === "chat") {
      const msg = clean(m.m, 80).trim();
      if (!msg || now - a.lastChat < 700) return;
      a.lastChat = now;
      ws.serializeAttachment(a);
      const o = { t: "chat", id: a.id, nick: a.p.nick, m: msg };
      this.broadcast(ws, o);
      this.send(ws, o);
    } else if (m.t === "info") {
      a.p.title = clean(m.title, 16);
      a.p.lv = num(m.lv, 1, 999) | 0;
      a.p.el = ELS.includes(m.el) ? m.el : a.p.el;
      a.p.job = clean(m.job, 10);
      ws.serializeAttachment(a);
      this.broadcast(ws, { t: "join", p: a.p });
    }
  }
  leave(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.p) this.broadcast(ws, { t: "bye", id: a.id });
  }
  async webSocketClose(ws) {
    this.leave(ws);
    try {
      ws.close();
    } catch {
    }
  }
  async webSocketError(ws) {
    this.leave(ws);
  }
};

// ../../../../tmp/claude-0/-home-user/ba38a04a-c062-5679-be2e-75777790e3d6/scratchpad/wr/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../tmp/claude-0/-home-user/ba38a04a-c062-5679-be2e-75777790e3d6/scratchpad/wr/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-QJ5F0d/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../../tmp/claude-0/-home-user/ba38a04a-c062-5679-be2e-75777790e3d6/scratchpad/wr/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-QJ5F0d/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Town,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
