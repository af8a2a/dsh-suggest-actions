window.__ModuleLoader__.load({
  id: "dsh-suggest-actions",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;

    var name = "dsh-suggest-actions";
    // `sessions` gives the Session-bound prompt verb; `locale` localizes the card.
    var inject = ["slots", "locale", "sessions"];

    var NS = "dsh-suggest-actions";
    var ENDPOINT = "/dsh-suggest-actions/suggest";
    var STYLE_ID = "dsh-suggest-actions/style";

    // ---------- copy ----------
    var DICT = {
      zh: {
        "card.aria": "下一步建议",
        "card.hint": "点一下就把这句话发出去",
        "card.dismiss": "忽略这些建议",
        "card.failed": "没能发出这条消息，再点一次试试",
      },
      en: {
        "card.aria": "Suggested next steps",
        "card.hint": "Click a suggestion to send it",
        "card.dismiss": "Dismiss these suggestions",
        "card.failed": "That message did not go out — try again",
      },
    };
    var boundT = null;
    function t(key) {
      if (boundT) {
        try {
          var value = boundT(key);
          if (value && value !== key) return value;
        } catch (e) { /* fall through to the bundled default */ }
      }
      return (DICT.zh[key] || key);
    }

    // ---------- freshness store ----------
    // turnTail renders for every closed Turn. Only the newest one should show a
    // card, so each mounted tail publishes its seq and a monotonic per-Session
    // watermark decides. Publishing also gates the model call: an older tail
    // never fetches after a newer one has been seen.
    var latestBySession = new Map();
    var latestListeners = new Set();
    var payloadCache = new Map();
    var dismissedCards = new Set();
    var CACHE_LIMIT = 40;

    function publishSeq(sessionId, seq) {
      var current = latestBySession.get(sessionId);
      if (current !== undefined && current >= seq) return false;
      latestBySession.set(sessionId, seq);
      latestListeners.forEach(function (listener) { listener(); });
      return true;
    }
    function subscribeLatest(listener) {
      latestListeners.add(listener);
      return function () { latestListeners.delete(listener); };
    }
    function useLatestSeq(sessionId) {
      var pair = useState(function () { return latestBySession.get(sessionId); });
      var setSeq = pair[1];
      useEffect(function () {
        setSeq(latestBySession.get(sessionId));
        return subscribeLatest(function () { setSeq(latestBySession.get(sessionId)); });
      }, [sessionId]);
      return pair[0];
    }

    function cacheGet(key) {
      var hit = payloadCache.get(key);
      if (!hit) return undefined;
      payloadCache.delete(key);
      payloadCache.set(key, hit);
      return hit;
    }
    function cacheSet(key, value) {
      payloadCache.delete(key);
      payloadCache.set(key, value);
      while (payloadCache.size > CACHE_LIMIT) payloadCache.delete(payloadCache.keys().next().value);
    }

    /** Ask the Host for this Turn's card payload; `null` means "show nothing". */
    async function fetchSuggestions(sessionId, seq, signal) {
      var key = sessionId + ":" + seq;
      var cached = cacheGet(key);
      if (cached) return cached;
      var response;
      try {
        response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ sessionId: sessionId, seq: seq }),
          signal: signal,
        });
      } catch (error) {
        if (signal && signal.aborted) return null;
        return null;
      }
      if (!response.ok) return null;
      var payload;
      try { payload = await response.json(); } catch (e) { return null; }
      if (!payload || payload.ok !== true || !Array.isArray(payload.actions) || payload.actions.length === 0) return null;
      cacheSet(key, payload);
      return payload;
    }

    // ---------- sending ----------
    /**
     * Send one chip's text exactly as the composer would: a local submission
     * echo, then the prompt round-trip. Placement is left to the Host.
     */
    async function sendPrompt(binding, text) {
      var session = binding && binding.session;
      if (!session) throw new Error("suggest-actions: the Session is not available");
      var mode = "queue";
      var submission = typeof session.beginSubmission === "function"
        ? session.beginSubmission({ mode: mode, text: text, attachments: [], onRetire: function () {} })
        : undefined;
      try {
        var requestId = submission && submission.requestId;
        var result = await session.prompt([{ type: "text", text: text }], mode, undefined, requestId);
        if (!result || result.ok !== true) {
          if (submission && typeof submission.abandon === "function") submission.abandon();
          throw new Error("suggest-actions: prompt was rejected");
        }
      } catch (error) {
        if (submission && typeof submission.abandon === "function") submission.abandon();
        throw error;
      }
    }

    // ---------- card ----------
    function SuggestActionsCard(props) {
      var sessionId = props.sessionId;
      var mySeq = Number(props.seq);
      var turnValue = props.turn && props.turn.turn !== undefined ? props.turn.turn : props.turn;
      var latest = useLatestSeq(sessionId);
      var dataState = useState(null);
      var data = dataState[0];
      var setData = dataState[1];
      var statusState = useState("idle"); // idle | sent | failed
      var status = statusState[0];
      var setStatus = statusState[1];
      var dismissedState = useState(function () {
        return dismissedCards.has(sessionId + ":" + mySeq);
      });
      var dismissed = dismissedState[0];
      var setDismissed = dismissedState[1];
      var dismiss = useCallback(function () {
        dismissedCards.add(sessionId + ":" + mySeq);
        if (dismissedCards.size > 200) dismissedCards.clear();
        setDismissed(true);
      }, [sessionId, mySeq]);
      var mountedState = useState(false);
      var mounted = mountedState[0];
      var setMounted = mountedState[1];

      // Publish before fetching: a newer Turn claims the slot, an older one stays silent.
      useEffect(function () {
        if (!Number.isFinite(mySeq)) return;
        if (publishSeq(sessionId, mySeq)) setMounted(true);
        else setMounted((latestBySession.get(sessionId) || -Infinity) === mySeq);
      }, [sessionId, mySeq]);

      useEffect(function () {
        if (!mounted || !Number.isFinite(mySeq)) return;
        var controller = new AbortController();
        var alive = true;
        fetchSuggestions(sessionId, mySeq, controller.signal).then(function (payload) {
          if (!alive) return;
          if (payload) setData(payload);
        });
        return function () {
          alive = false;
          controller.abort();
        };
      }, [mounted, sessionId, mySeq]);

      var send = useCallback(function (action) {
        var binding;
        try {
          binding = props.getBinding();
        } catch (e) {
          return;
        }
        if (!binding) return;
        setStatus("sent");
        Promise.resolve(sendPrompt(binding, action.prompt || action.label)).then(function () {
          dismiss();
        }, function () {
          setStatus("failed");
        });
      }, [props.getBinding, dismiss]);

      if (!mounted || dismissed || status === "sent") return null;
      if (latest !== undefined && latest > mySeq) return null;
      if (!data) return null;

      var actions = data.actions || [];
      var hint = status === "failed" ? t("card.failed") : t("card.hint");
      return h("div", {
        className: "dsa-card",
        role: "group",
        "aria-label": t("card.aria"),
        "data-suggest-actions": String(mySeq),
        "data-turn": turnValue === undefined ? undefined : String(turnValue),
      }, [
        h("div", { className: "dsa-main", key: "main" }, [
          h("div", { className: "dsa-question", key: "q" }, data.question),
          h("div", { className: "dsa-chips", key: "chips" }, actions.map(function (action, index) {
            return h("button", {
              type: "button",
              className: "dsa-chip" + (index === 0 ? " dsa-chip-primary" : ""),
              key: action.label + ":" + index,
              onClick: function () { send(action); },
              title: action.prompt || action.label,
            }, [
              h("span", { className: "dsa-chip-label", key: "label" }, action.label),
              h("kbd", { className: "dsa-kbd", key: "kbd", "aria-hidden": "true" }, "↵"),
            ]);
          })),
          h("div", { className: "dsa-hint", key: "hint" }, hint),
        ]),
        h("button", {
          type: "button",
          className: "dsa-dismiss",
          key: "dismiss",
          "aria-label": t("card.dismiss"),
          title: t("card.dismiss"),
          onClick: dismiss,
        }, "✕"),
      ]);
    }

    // ---------- styles ----------
    var CSS = [
      ".dsa-card{position:relative;display:flex;gap:10px;align-items:flex-start;box-sizing:border-box;",
      "width:min(100%,760px);margin:14px auto 2px;padding:16px 18px 14px;",
      "border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.28));",
      "border-radius:18px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));",
      "color:var(--dsw-alias-label-primary,#1a1a1a);font-size:14px;line-height:22px}",
      ".dsa-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}",
      ".dsa-question{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#1a1a1a)}",
      ".dsa-chips{display:flex;flex-wrap:wrap;gap:8px}",
      ".dsa-chip{display:inline-flex;align-items:center;gap:8px;max-width:100%;",
      "padding:6px 12px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.4));",
      "border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;",
      "cursor:pointer;transition:background-color .12s,border-color .12s}",
      ".dsa-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));",
      "border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.55))}",
      ".dsa-chip:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4d6bfe);outline-offset:2px}",
      ".dsa-chip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsa-kbd{display:none;font:inherit;font-size:11px;line-height:14px;padding:1px 5px;border-radius:5px;",
      "border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.3));",
      "color:var(--dsw-alias-label-caption,#6b6b6b)}",
      ".dsa-chip:hover .dsa-kbd,.dsa-chip:focus-visible .dsa-kbd{display:inline-block}",
      ".dsa-hint{font-size:12px;line-height:16px;color:var(--dsw-alias-label-caption,#6b6b6b)}",
      ".dsa-dismiss{position:absolute;top:10px;right:10px;width:24px;height:24px;padding:0;",
      "border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-caption,#6b6b6b);",
      "font-size:12px;line-height:24px;cursor:pointer}",
      ".dsa-dismiss:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));",
      "color:var(--dsw-alias-label-primary,#1a1a1a)}",
      "@media (prefers-reduced-motion:reduce){.dsa-chip{transition:none}}",
    ].join("");

    function installStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = name;
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---------- apply ----------
    function apply(ctx) {
      installStyles();
      try {
        if (ctx.locale && typeof ctx.locale.register === "function") {
          ctx.locale.register(NS, DICT);
          boundT = ctx.locale.bind(NS);
        }
      } catch (e) { /* keep the bundled Chinese copy */ }

      ctx.slots.inject("conversation.chat.turnTail", function () {
        return ctx.slots.register({
          name: "conversation.chat.turnTail",
          id: name,
          locale: NS,
          inject: function (sessionId) {
            return {
              sessionId: sessionId,
              getBinding: function () { return ctx.sessions.binding(sessionId); },
            };
          },
        }, SuggestActionsCard);
      });
    }

    module.exports = { name: name, inject: inject, apply: apply };
    return module.exports;
  },
});
