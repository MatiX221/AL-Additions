// ==UserScript==
// @name         AL Additions
// @namespace    daiya.al-additions-v3
// @version      0.9.1
// @author       Daiya
// @description  A userscript that adds extra tools to AniList, including a one-way AniList → MyAnimeList sync, a score and progress editor, airing indicators, OP/ED songs and quick links to other sites.
// @license      GPL-3.0-or-later
// @icon         https://anilist.co/img/icons/favicon-32x32.png
// @homepage     https://github.com/Daiya404/AL-Additions#readme
// @homepageURL  https://github.com/Daiya404/AL-Additions
// @source       https://github.com/Daiya404/AL-Additions.git
// @supportURL   https://github.com/Daiya404/AL-Additions/issues
// @downloadURL  https://raw.githubusercontent.com/Daiya404/AL-Additions/main/al-additions.user.js
// @updateURL    https://raw.githubusercontent.com/Daiya404/AL-Additions/main/al-additions.user.js
// @match        https://anilist.co/*
// @match        https://myanimelist.net/*
// @connect      graphql.anilist.co
// @connect      myanimelist.net
// @connect      api.myanimelist.net
// @connect      rs.animethemes.moe
// @connect      api.mangaupdates.com
// @connect      www.mangaupdates.com
// @connect      www.novelupdates.com
// @connect      s4.anilist.co
// @grant        GM_addValueChangeListener
// @grant        GM_deleteValue
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_removeValueChangeListener
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        window.close
// @run-at       document-start
// @noframes
// ==/UserScript==

(function() {
	"use strict";
	var _GM_addValueChangeListener = (() => typeof GM_addValueChangeListener != "undefined" ? GM_addValueChangeListener : void 0)();
	var _GM_deleteValue = (() => typeof GM_deleteValue != "undefined" ? GM_deleteValue : void 0)();
	var _GM_download = (() => typeof GM_download != "undefined" ? GM_download : void 0)();
	var _GM_getValue = (() => typeof GM_getValue != "undefined" ? GM_getValue : void 0)();
	var _GM_listValues = (() => typeof GM_listValues != "undefined" ? GM_listValues : void 0)();
	var _GM_registerMenuCommand = (() => typeof GM_registerMenuCommand != "undefined" ? GM_registerMenuCommand : void 0)();
	var _GM_removeValueChangeListener = (() => typeof GM_removeValueChangeListener != "undefined" ? GM_removeValueChangeListener : void 0)();
	var _GM_setValue = (() => typeof GM_setValue != "undefined" ? GM_setValue : void 0)();
	var _GM_xmlhttpRequest = (() => typeof GM_xmlhttpRequest != "undefined" ? GM_xmlhttpRequest : void 0)();
	var _unsafeWindow = (() => typeof unsafeWindow != "undefined" ? unsafeWindow : void 0)();
	var SETTING_PREFIX = "ala_setting_";
	var ANILIST_SESSION_KEYS = [
		"al_token",
		"al_username",
		"al_user_id",
		"al_score_format",
		"al_token_auth"
	];
	var MEDIA_TYPES = ["ANIME", "MANGA"];
	location.hostname;
	var MAX_TIMEOUT_MS = 2147483647;
	function sleep(ms, signal) {
		if (signal?.aborted) return Promise.reject(createAbortError(signal));
		const delay = Number.isFinite(ms) ? Math.min(MAX_TIMEOUT_MS, Math.max(0, ms)) : 0;
		if (!signal) return new Promise((resolve) => setTimeout(resolve, delay));
		return new Promise((resolve, reject) => {
			let done = false;
			const onAbort = () => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				reject(createAbortError(signal));
			};
			const timer = setTimeout(() => {
				if (done) return;
				done = true;
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, delay);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
	var clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
	var esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;",
		"'": "&#39;"
	})[c]);
	var parseToggle = (v) => v === "false" ? false : !!v;
	var safe = (fn, label) => {
		try {
			return fn();
		} catch (e) {
			console.error("[AL-Additions]", label || "", e);
		}
	};
	var tryOr = async (fn, fallback = null) => {
		try {
			return await fn();
		} catch (_) {
			return fallback;
		}
	};
	function authError(service, message) {
		const e = new Error(message);
		e.auth = service;
		return e;
	}
	function composeAbortSignals(a, b) {
		const noop = () => {};
		if (!a) return {
			signal: b,
			dispose: noop
		};
		if (!b || a === b) return {
			signal: a,
			dispose: noop
		};
		if (a.aborted) return {
			signal: a,
			dispose: noop
		};
		if (b.aborted) return {
			signal: b,
			dispose: noop
		};
		const anyFn = AbortSignal.any;
		if (typeof anyFn === "function") return {
			signal: anyFn([a, b]),
			dispose: noop
		};
		const ac = new AbortController();
		const dispose = () => {
			a.removeEventListener("abort", onAbortA);
			b.removeEventListener("abort", onAbortB);
		};
		const onAbortA = () => {
			dispose();
			ac.abort(a.reason);
		};
		const onAbortB = () => {
			dispose();
			ac.abort(b.reason);
		};
		a.addEventListener("abort", onAbortA, { once: true });
		b.addEventListener("abort", onAbortB, { once: true });
		return {
			signal: ac.signal,
			dispose
		};
	}
	function createAbortError(signal) {
		const reason = signal?.reason;
		if ((reason instanceof Error || typeof DOMException !== "undefined" && reason instanceof DOMException) && reason.name === "AbortError") return reason;
		if (typeof DOMException !== "undefined") return new DOMException("Request aborted", "AbortError");
		const err = new Error("Request aborted");
		err.name = "AbortError";
		return err;
	}
	function isAbortError(err) {
		if (!err || typeof err !== "object") return false;
		const e = err;
		return e.name === "AbortError" || e.message === "Request aborted" || e.message === "Download aborted";
	}
	function raceWithSignal(promise, signal, createAbort = createAbortError) {
		if (!signal) return promise;
		if (signal.aborted) {
			promise.catch(() => {});
			return Promise.reject(createAbort(signal));
		}
		return new Promise((resolve, reject) => {
			let settled = false;
			const onAbort = () => {
				if (settled) return;
				settled = true;
				promise.catch(() => {});
				reject(createAbort(signal));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then((val) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(val);
			}, (err) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(err);
			});
		});
	}
	function isGqlMutation(q) {
		if (typeof q !== "string") return false;
		const stripped = q.replace(/#[^\n\r]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"/g, " ");
		return /\bmutation\b/i.test(stripped);
	}
	function debounce(fn, ms = 0) {
		let t = 0;
		let pendingArgs = null;
		const cancel = () => {
			clearTimeout(t);
			t = 0;
			pendingArgs = null;
		};
		const flush = () => {
			if (!pendingArgs) return;
			const args = pendingArgs;
			cancel();
			fn(...args);
		};
		const debounced = ((...a) => {
			clearTimeout(t);
			pendingArgs = a;
			t = setTimeout(() => {
				t = 0;
				const args = pendingArgs;
				pendingArgs = null;
				if (args) fn(...args);
			}, ms);
		});
		debounced.cancel = cancel;
		debounced.flush = flush;
		return debounced;
	}
	function openTab(url) {
		const parent = typeof document !== "undefined" ? document.body || document.documentElement : null;
		if (!parent) {
			window.open(url, "_blank", "noopener,noreferrer");
			return;
		}
		const a = document.createElement("a");
		a.href = url;
		a.target = "_blank";
		a.rel = "noopener noreferrer";
		parent.appendChild(a);
		a.click();
		a.remove();
	}
	function resolveGm(name, imported) {
		const g = globalThis;
		if (Object.prototype.hasOwnProperty.call(g, name)) return typeof g[name] === "function" ? g[name] : null;
		if (typeof window !== "undefined" && Object.prototype.hasOwnProperty.call(window, name)) {
			const w = window;
			return typeof w[name] === "function" ? w[name] : null;
		}
		return typeof imported === "function" ? imported : null;
	}
	function downloadFile(url, name, opts = {}) {
		let settled = false;
		const shouldOpenTabOnError = () => typeof opts.openTabOnError === "function" ? !!opts.openTabOnError() : opts.openTabOnError !== false;
		const triggerTabFallback = () => {
			if (settled) return;
			settled = true;
			openTab(url);
			opts.onComplete?.("tab");
		};
		const gmDownload = resolveGm("GM_download", _GM_download);
		if (gmDownload) try {
			const handle = gmDownload({
				url,
				name,
				saveAs: !!opts.saveAs,
				onload: () => {
					if (settled) return;
					settled = true;
					opts.onComplete?.("download");
				},
				onerror: (err) => {
					if (settled) return;
					if (err?.error === "aborted") {
						settled = true;
						opts.onAbort?.();
						return;
					}
					if (shouldOpenTabOnError()) triggerTabFallback();
					else {
						settled = true;
						opts.onError?.(err);
					}
				},
				ontimeout: () => {
					if (settled) return;
					if (shouldOpenTabOnError()) triggerTabFallback();
					else {
						settled = true;
						opts.onError?.(new Error("Download timed out"));
					}
				},
				onabort: () => {
					if (settled) return;
					settled = true;
					opts.onAbort?.();
				}
			});
			if (handle && typeof handle.abort === "function") return { abort: () => handle.abort?.() };
			return null;
		} catch (err) {
			if (shouldOpenTabOnError()) triggerTabFallback();
			else if (!settled) {
				settled = true;
				opts.onError?.(err);
			}
			return null;
		}
		if (shouldOpenTabOnError()) triggerTabFallback();
		else {
			settled = true;
			opts.onError?.(new Error("GM_download unavailable"));
		}
		return null;
	}
	var store$1 = {
		get: (k, d) => _GM_getValue(k, d),
		set: (k, v) => _GM_setValue(k, v),
		del: (k) => _GM_deleteValue(k),
		list: () => {
			const fn = resolveGm("GM_listValues", _GM_listValues);
			if (!fn) return [];
			try {
				const keys = fn();
				return Array.isArray(keys) ? keys : [];
			} catch {
				return [];
			}
		},
		watch: (key, cb) => {
			const addFn = resolveGm("GM_addValueChangeListener", _GM_addValueChangeListener);
			if (!addFn) return () => {};
			let id;
			try {
				id = addFn(key, (name, oldVal, newVal, remote) => {
					cb(name, oldVal, newVal, !!remote);
				});
			} catch {
				return () => {};
			}
			return () => {
				if (id === void 0) return;
				const listenerId = id;
				id = void 0;
				const removeFn = resolveGm("GM_removeValueChangeListener", _GM_removeValueChangeListener);
				if (!removeFn) return;
				try {
					removeFn(listenerId);
				} catch {}
			};
		}
	};
	var CORE_DEBUG_SCOPE = "core";
	var CORE_DEBUG_MASTER = {
		scope: CORE_DEBUG_SCOPE,
		title: "Core / Kernel Debug",
		help: "Enable verbose debug logging across core subsystems, settings, and API clients."
	};
	var CORE_DEBUG_CHANNELS = {
		core: {
			id: "general",
			label: "Core",
			title: "Core & Observer",
			help: "Log DOM observer mutations, route changes, module lifecycle, and core bus events."
		},
		settings: {
			id: "settings",
			label: "Settings",
			title: "Settings & Backup",
			help: "Log settings migrations, backup creation, and restore imports."
		},
		anilist: {
			id: "anilist",
			label: "AniList",
			title: "AniList API",
			help: "Log AniList GraphQL caching, subset matching, and API requests."
		},
		mal: {
			id: "mal",
			label: "MAL",
			title: "MyAnimeList API",
			help: "Log MyAnimeList API requests, responses, and override cache refreshes."
		}
	};
	function getDebuggableChannels(debug) {
		if (!debug || debug.debug === false || !debug.channels) return [];
		const out = [];
		for (const [id, ch] of Object.entries(debug.channels)) if (ch && ch.debug === true) out.push([id, ch]);
		return out;
	}
	function isDebugEnabled(scope, channel) {
		try {
			const win = typeof _unsafeWindow !== "undefined" ? _unsafeWindow : window;
			if (win.__ALA_DEBUG__ || win.__ALFL_DEBUG__) return true;
			if (!parseToggle(store$1.get(`ala_setting_devModeEnabled`, false))) return false;
			const raw = store$1.get(`${SETTING_PREFIX}debug`, null);
			let map = null;
			if (raw && typeof raw === "object" && !Array.isArray(raw)) map = raw;
			else if (typeof raw === "string") try {
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) map = parsed;
			} catch {}
			if (!map) return false;
			const entry = Object.prototype.hasOwnProperty.call(map, scope) ? map[scope] : void 0;
			if (!entry || typeof entry !== "object") return false;
			if (!parseToggle(entry.enabled)) return false;
			if (!channel) return true;
			const channels = entry.channels;
			if (!channels || typeof channels !== "object") return true;
			if (!Object.prototype.hasOwnProperty.call(channels, channel)) return true;
			return parseToggle(channels[channel]);
		} catch {
			return false;
		}
	}
	function createLogger(prefix, isEnabled, meta) {
		const logger = {
			label: meta.label,
			title: meta.title,
			help: meta.help,
			canDebug: meta.canDebug,
			enabled: () => {
				try {
					return !!meta.canDebug && !!isEnabled();
				} catch {
					return false;
				}
			},
			debug: ((...args) => {
				if (!logger.enabled()) return;
				console.debug(prefix, ...args);
			}),
			warn: (...args) => {
				console.warn(prefix, ...args);
			},
			error: (...args) => {
				console.error(prefix, ...args);
			}
		};
		return Object.freeze(logger);
	}
	function createCoreLogger(channelOrOpts) {
		if (typeof channelOrOpts === "string") {
			const def = CORE_DEBUG_CHANNELS[channelOrOpts];
			return createLogger(`[${def.label}]`, () => isDebugEnabled(CORE_DEBUG_SCOPE, def.id), {
				label: def.label,
				title: def.title,
				help: def.help,
				canDebug: true
			});
		}
		return createLogger(`[${channelOrOpts.label}]`, () => isDebugEnabled(channelOrOpts.scope, channelOrOpts.channel), {
			label: channelOrOpts.label,
			title: channelOrOpts.title ?? channelOrOpts.label,
			help: channelOrOpts.help,
			canDebug: true
		});
	}
	function jsonGet(key, fallback) {
		try {
			const v = store$1.get(key, null);
			if (v == null) return fallback;
			return typeof v === "string" ? JSON.parse(v) : v;
		} catch (_) {
			return fallback;
		}
	}
	var jsonSet = (key, value) => store$1.set(key, JSON.stringify(value));
	function persistent(key, prune) {
		let loaded = false;
		let cacheData = {};
		const ensure = () => {
			if (!loaded) {
				loaded = true;
				let d = jsonGet(key, {});
				if (!d || typeof d !== "object" || Array.isArray(d)) d = {};
				if (prune) safe(() => prune(d), "cache prune");
				cacheData = d;
			}
			return cacheData;
		};
		const save = debounce(() => safe(() => jsonSet(key, ensure())), 500);
		return {
			get data() {
				return ensure();
			},
			set data(val) {
				loaded = true;
				cacheData = val;
			},
			save,
			cancel: () => save.cancel(),
			flush: () => save.flush()
		};
	}
	var gm = {
		request(url, o = {}) {
			return new Promise((resolve, reject) => _GM_xmlhttpRequest({
				method: "GET",
				timeout: 15e3,
				...o,
				url,
				onload: resolve,
				onerror: () => reject(new Error("Network error")),
				ontimeout: () => reject(new Error("Timeout")),
				onabort: () => reject(new Error("Request aborted"))
			}));
		},
		async text(url, o = {}) {
			const r = await gm.request(url, o);
			if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
			return r.responseText || "";
		},
		async json(url, o = {}) {
			return JSON.parse(await gm.text(url, o));
		}
	};
	function randomString(len) {
		const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		const arr = new Uint8Array(len);
		crypto.getRandomValues(arr);
		let out = "";
		for (let i = 0; i < len; i++) out += chars[arr[i] % 62];
		return out;
	}
	var PREFIX = SETTING_PREFIX;
	var features = [];
	var ROWS = {};
	var hasOwn$2 = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
	function cloneJsonValue(val) {
		if (val === null || typeof val !== "object") return val;
		if (Array.isArray(val)) return val.map((item) => cloneJsonValue(item));
		const out = {};
		for (const key of Object.keys(val)) {
			if (key === "__proto__") continue;
			out[key] = cloneJsonValue(val[key]);
		}
		return out;
	}
	function parseAndNormalizeNumber(v, r) {
		if (typeof v !== "number" && typeof v !== "string") return { ok: false };
		if (typeof v === "string" && v.trim() === "") return { ok: false };
		const n = Math.round(Number(v));
		if (!Number.isFinite(n)) return { ok: false };
		const min = r?.min ?? 0;
		const max = r?.max ?? 100;
		return {
			ok: true,
			value: Math.max(min, Math.min(max, n))
		};
	}
	function parseAndValidateJson(v, r) {
		if (v == null) return { ok: false };
		let val = v;
		if (typeof val === "string") try {
			val = JSON.parse(val);
		} catch (_) {
			return { ok: false };
		}
		val = cloneJsonValue(val);
		if (r?.validate) {
			let check;
			try {
				check = r.validate(val);
			} catch (_) {
				return { ok: false };
			}
			if (check === false) return { ok: false };
			if (check && typeof check === "object") {
				if (check.valid === false) return { ok: false };
				return {
					ok: true,
					value: cloneJsonValue(check.value ?? check.tiers ?? check.config ?? check.overrides ?? val)
				};
			}
		}
		return {
			ok: true,
			value: val
		};
	}
	var textIO = {
		read: (el) => el.value,
		write: (el, v) => {
			el.value = v;
		}
	};
	var TYPES$1 = {
		toggle: {
			normalize: (v) => parseToggle(v),
			html: (r, v) => `<span class="ala-switch"><input type="checkbox" data-key="${esc(r.key)}" ${v ? "checked" : ""}><span class="ala-slider"></span></span>`,
			read: (el) => el.checked,
			write: (el, v) => {
				el.checked = !!v;
			}
		},
		number: {
			normalize: (v, r) => {
				const res = parseAndNormalizeNumber(v, r);
				return res.ok ? res.value : r?.def;
			},
			html: (r, v) => `<input type="number" data-key="${esc(r.key)}" min="${esc(r.min ?? 0)}" max="${esc(r.max ?? 100)}" step="1" inputmode="numeric" value="${esc(v)}">`,
			...textIO
		},
		select: {
			normalize: (v, r) => r?.options?.some((o) => o[0] === v) ? v : r?.def,
			html: (r, v) => `<select data-key="${esc(r.key)}">${(r.options || []).map(([val, label]) => `<option value="${esc(val)}" ${v === val ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`,
			...textIO
		},
		list: {
			normalize: (v, r) => {
				let arr = [];
				if (typeof v === "string") arr = v.split(",").map((x) => x.trim()).filter(Boolean);
				else if (Array.isArray(v)) arr = v.filter((x) => typeof x === "string" || typeof x === "number" && Number.isFinite(x)).map((x) => String(x).trim()).filter(Boolean);
				return arr.length ? arr : Array.isArray(r?.def) ? r.def.slice() : [];
			},
			html: (r, v) => `<input type="text" data-key="${esc(r.key)}" value="${esc((v || []).join(", "))}" autocomplete="off" autocapitalize="off" spellcheck="false">`,
			read: (el) => el.value,
			write: (el, v) => {
				el.value = v.join(", ");
			}
		},
		json: {
			normalize: (v, r) => {
				const res = parseAndValidateJson(v, r);
				return res.ok ? res.value : cloneJsonValue(r?.def);
			},
			html: (r, v) => `<input type="hidden" data-key="${esc(r.key)}" value="${esc(JSON.stringify(v))}"><button type="button" class="ala-btn ala-btn--secondary ala-btn--edit-json" id="ala-btn-edit-${esc(r.key)}">Customize</button>`,
			read: (el) => {
				try {
					return JSON.parse(el.value);
				} catch (_) {
					const key = el.dataset?.key;
					return key && hasOwn$2(ROWS, key) ? cloneJsonValue(ROWS[key].def) : void 0;
				}
			},
			write: (el, v) => {
				el.value = JSON.stringify(v);
			}
		}
	};
	function register(f) {
		const toggleType = f.type || "toggle";
		const toggleDef = f.def !== void 0 ? f.def : toggleType === "json" ? {} : false;
		if (toggleType === "toggle" && toggleDef !== false) throw new Error(`Toggle setting "${f.key}" for module "${f.id}" must default to false`);
		const toggle = {
			key: f.key,
			type: toggleType,
			def: toggleDef,
			legacy: f.legacy || [],
			title: f.title,
			help: f.help
		};
		const options = (f.options || []).map((o) => ({
			...o,
			legacy: o.legacy || []
		}));
		const batch = [toggle, ...options];
		if (f.debug && f.debug.debug !== false) {
			const channelEntries = Object.entries(f.debug.channels || {});
			for (const [chId] of channelEntries) if (chId.toLowerCase() === "general") throw new Error(`Debug channel "${chId}" for module "${f.id}" conflicts with reserved "general" channel`);
		}
		const seenKeys = new Set();
		for (const row of batch) {
			if (seenKeys.has(row.key) || hasOwn$2(ROWS, row.key)) throw new Error(`Duplicate setting: ${row.key}`);
			seenKeys.add(row.key);
		}
		for (const row of batch) {
			row.legacy = [...new Set([row.key, ...row.legacy])];
			ROWS[row.key] = row;
		}
		features.push({
			id: f.id,
			section: f.section || "Other",
			title: f.title,
			help: f.help,
			toggle,
			options,
			layer: f.layer ?? "feature",
			hosts: f.hosts,
			requiresReload: f.requiresReload,
			dependsOn: f.dependsOn,
			after: f.after,
			accounts: f.accounts,
			debug: f.debug,
			standalone: f.standalone
		});
	}
	function registerCoreSetting(o) {
		const rowType = o.type || "toggle";
		const rowDef = o.def !== void 0 ? o.def : rowType === "json" ? {} : false;
		if (rowType === "toggle" && rowDef !== false) throw new Error(`Toggle setting "${o.key}" must default to false`);
		if (hasOwn$2(ROWS, o.key)) throw new Error(`Duplicate setting: ${o.key}`);
		const row = {
			...o,
			type: rowType,
			def: rowDef,
			legacy: [...new Set([o.key, ...o.legacy || []])]
		};
		ROWS[row.key] = row;
		return row;
	}
	function has(key) {
		if (!hasOwn$2(ROWS, key)) throw new Error(`Unknown setting: ${key}`);
		return store$1.get(PREFIX + key, void 0) !== void 0;
	}
	function get(key) {
		if (!hasOwn$2(ROWS, key)) throw new Error(`Unknown setting: ${key}`);
		const r = ROWS[key];
		return TYPES$1[r.type].normalize(store$1.get(PREFIX + key, r.def), r);
	}
	function set(key, raw) {
		if (!hasOwn$2(ROWS, key)) throw new Error(`Unknown setting: ${key}`);
		const r = ROWS[key];
		const normalized = TYPES$1[r.type].normalize(raw, r);
		store$1.set(PREFIX + key, normalized);
	}
	function readLegacyLocalStorage(name) {
		try {
			return localStorage.getItem("ALAdditions:" + name);
		} catch (_) {
			return null;
		}
	}
	function normalizeMigratedValue(r, v) {
		if (r.type === "number") return parseAndNormalizeNumber(v, r);
		if (r.type === "json") {
			const res = parseAndValidateJson(v, r);
			if (!res.ok || res.value == null) return { ok: false };
			return res;
		}
		return {
			ok: true,
			value: TYPES$1[r.type].normalize(v, r)
		};
	}
	function migrate() {
		safe(() => {
			store$1.del("al_token");
		}, "settings migration: al_token");
		for (const r of Object.values(ROWS)) safe(() => {
			if (store$1.get(PREFIX + r.key, void 0) !== void 0) return;
			for (const name of r.legacy) {
				let v = store$1.get(PREFIX + name, void 0);
				if (v === void 0) {
					const raw = readLegacyLocalStorage(name);
					if (raw != null) try {
						v = JSON.parse(raw);
					} catch (_) {
						if (r.type === "json") continue;
						v = raw;
					}
				}
				if (v !== void 0) {
					const normalized = normalizeMigratedValue(r, v);
					if (!normalized.ok) continue;
					store$1.set(PREFIX + r.key, normalized.value);
					break;
				}
			}
		}, `settings migration: ${r.key}`);
	}
	var Settings = {
		has,
		get,
		set,
		register,
		registerCoreSetting,
		migrate
	};
	var coreLog$4 = createCoreLogger("core");
	var providers = new Map();
	var watchersByProvider = new Map();
	function isProviderConnected(providerId) {
		try {
			return !!providers.get(providerId)?.isConnected();
		} catch {
			return false;
		}
	}
	function clearEntryKeyUnsubs(entry) {
		for (const unsub of entry.keyUnsubs) try {
			unsub();
		} catch {}
		entry.keyUnsubs.length = 0;
	}
	function notifyWatcherTransition(entry) {
		if (!entry.active) return;
		const next = isProviderConnected(entry.providerId);
		if (next === entry.lastConnected) return;
		entry.lastConnected = next;
		try {
			entry.cb(next);
		} catch (e) {
			coreLog$4.error(`Account watcher (${entry.providerId}) failed:`, e);
		}
	}
	function bindEntryKeys(entry) {
		clearEntryKeyUnsubs(entry);
		if (!entry.active) return;
		const keys = getAccountSecretKeys(entry.providerId);
		for (const key of keys) entry.keyUnsubs.push(store$1.watch(key, () => {
			notifyWatcherTransition(entry);
		}));
	}
	function reconcileWatchersForProvider(providerId) {
		const set = watchersByProvider.get(providerId);
		if (!set) return;
		for (const entry of [...set]) {
			if (!entry.active) continue;
			bindEntryKeys(entry);
			notifyWatcherTransition(entry);
		}
	}
	function registerAccountProvider(provider) {
		providers.set(provider.id, provider);
		reconcileWatchersForProvider(provider.id);
		return () => {
			if (providers.get(provider.id) === provider) {
				providers.delete(provider.id);
				reconcileWatchersForProvider(provider.id);
			}
		};
	}
	function watchAccountProvider(providerId, cb) {
		const entry = {
			providerId,
			cb,
			active: true,
			lastConnected: isProviderConnected(providerId),
			keyUnsubs: []
		};
		let set = watchersByProvider.get(providerId);
		if (!set) {
			set = new Set();
			watchersByProvider.set(providerId, set);
		}
		set.add(entry);
		bindEntryKeys(entry);
		return () => {
			if (!entry.active) return;
			entry.active = false;
			clearEntryKeyUnsubs(entry);
			set?.delete(entry);
			if (set && set.size === 0 && watchersByProvider.get(providerId) === set) watchersByProvider.delete(providerId);
		};
	}
	function getAccountProvider(id) {
		return providers.get(id);
	}
	function listAccountProviders() {
		return [...providers.values()];
	}
	function getAccountSecretKeys(providerId) {
		if (providerId !== void 0) {
			const p = providers.get(providerId);
			return p ? [...new Set(p.secretKeys)] : [];
		}
		const keys = new Set();
		for (const p of providers.values()) for (const k of p.secretKeys) keys.add(k);
		return [...keys];
	}
	function clearAccountSecrets(providerId) {
		for (const key of getAccountSecretKeys(providerId)) store$1.del(key);
	}
	async function runAccountAuthCallbacks() {
		for (const p of [...providers.values()]) {
			if (!p.onAuthCallback) continue;
			try {
				await p.onAuthCallback();
			} catch (e) {
				coreLog$4.error(`Account auth callback (${p.id}) failed:`, e);
			}
		}
	}
	var coreLog$3 = createCoreLogger("core");
	var ServiceRegistryImpl = class {
		services = new Map();
		watchers = new Map();
		provide(name, impl) {
			const key = String(name);
			const owner = Symbol(key);
			const serviceRecord = {
				impl,
				owner
			};
			this.services.set(key, serviceRecord);
			const subs = this.watchers.get(key);
			if (subs) for (const entry of [...subs]) {
				if (!entry.active) continue;
				this.runCleanup(entry);
				if (this.services.get(key) !== serviceRecord) break;
				if (!entry.active) continue;
				this.invokeWatcher(entry, impl, key);
				if (this.services.get(key) !== serviceRecord) break;
			}
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (this.services.get(key)?.owner !== owner) return;
				this.services.delete(key);
				const currentSubs = this.watchers.get(key);
				if (currentSubs) for (const entry of [...currentSubs]) {
					if (!entry.active) continue;
					this.runCleanup(entry);
					if (this.services.has(key)) break;
				}
			};
		}
		get(name) {
			return this.services.get(String(name))?.impl;
		}
		onAvailable(name, cb) {
			const key = String(name);
			const entry = {
				cb,
				cleanup: null,
				active: true,
				gen: 0
			};
			let subs = this.watchers.get(key);
			if (!subs) {
				subs = new Set();
				this.watchers.set(key, subs);
			}
			subs.add(entry);
			const current = this.services.get(key);
			if (current) this.invokeWatcher(entry, current.impl, key);
			return () => {
				if (!entry.active) return;
				entry.active = false;
				this.runCleanup(entry);
				subs?.delete(entry);
				if (subs && subs.size === 0 && this.watchers.get(key) === subs) this.watchers.delete(key);
			};
		}
		invokeWatcher(entry, impl, key) {
			const myGen = ++entry.gen;
			try {
				const res = entry.cb(impl);
				if (typeof res === "function") {
					if (entry.active && entry.gen === myGen) {
						this.runCleanup(entry);
						entry.cleanup = res;
					} else try {
						res();
					} catch (e) {
						coreLog$3.error("Service subscriber cleanup failed:", e);
					}
				} else if (entry.gen === myGen) entry.cleanup = null;
			} catch (e) {
				coreLog$3.error(`Service watcher for "${key}" failed:`, e);
			}
		}
		runCleanup(entry) {
			if (!entry.cleanup) return;
			const fn = entry.cleanup;
			entry.cleanup = null;
			try {
				fn();
			} catch (e) {
				coreLog$3.error("Service subscriber cleanup failed:", e);
			}
		}
	};
	var EventBusImpl = class {
		listeners = new Map();
		retained = new Map();
		dispatch(key, payload) {
			const set = this.listeners.get(key);
			if (!set) return;
			for (const entry of [...set]) {
				if (!entry.active) continue;
				try {
					entry.cb(payload);
				} catch (e) {
					coreLog$3.error(`Event listener for "${key}" failed:`, e);
				}
			}
		}
		emit(event, ...args) {
			const key = String(event);
			const [payload] = args;
			const existing = this.retained.get(key);
			if (existing) existing.payload = payload;
			this.dispatch(key, payload);
		}
		emitRetained(event, ...args) {
			const key = String(event);
			const [payload] = args;
			this.retained.set(key, { payload });
			this.dispatch(key, payload);
		}
		on(event, cb) {
			const key = String(event);
			const entry = {
				cb,
				active: true
			};
			let set = this.listeners.get(key);
			if (!set) {
				set = new Set();
				this.listeners.set(key, set);
			}
			set.add(entry);
			return () => {
				if (!entry.active) return;
				entry.active = false;
				set?.delete(entry);
				if (set && set.size === 0 && this.listeners.get(key) === set) this.listeners.delete(key);
			};
		}
		onRetained(event, cb) {
			const key = String(event);
			const unsub = this.on(event, cb);
			if (this.retained.has(key)) {
				const entry = this.retained.get(key);
				try {
					cb(entry.payload);
				} catch (e) {
					coreLog$3.error(`Retained event listener for "${key}" failed:`, e);
				}
			}
			return unsub;
		}
		emitRetainedOwned(owner, event, ...args) {
			const key = String(event);
			const [payload] = args;
			this.retained.set(key, {
				payload,
				owner
			});
			this.dispatch(key, payload);
		}
		clearRetainedByOwner(owner) {
			for (const [key, entry] of [...this.retained]) if (entry.owner === owner) this.retained.delete(key);
		}
	};
	var ServiceRegistry = new ServiceRegistryImpl();
	var EventBus = new EventBusImpl();
	function isUrlLike(input, win) {
		if (!input || typeof input !== "object") return false;
		if (typeof URL !== "undefined" && input instanceof URL) return true;
		const WinURL = win?.URL;
		if (typeof WinURL === "function" && input instanceof WinURL) return true;
		return typeof input.href === "string" && typeof input.url !== "string";
	}
	function isRequestLike(input, win) {
		if (!input || typeof input !== "object") return false;
		if (typeof Request !== "undefined" && input instanceof Request) return true;
		const WinRequest = win?.Request;
		return typeof WinRequest === "function" && input instanceof WinRequest;
	}
	function resolvePageWindow() {
		return typeof _unsafeWindow !== "undefined" ? _unsafeWindow : window;
	}
	function isAniListGraphqlUrl(rawUrl) {
		if (!rawUrl) return false;
		if (rawUrl === "/graphql") return true;
		try {
			const u = new URL(rawUrl, location.href);
			return u.origin === "https://graphql.anilist.co" || u.hostname === "anilist.co" && u.pathname.replace(/\/$/, "") === "/graphql";
		} catch {
			return false;
		}
	}
	function normalizeGqlQuery$1(query) {
		return typeof query === "string" ? query : String(query ?? "");
	}
	function normalizeGqlVariables(variables) {
		return variables && typeof variables === "object" && !Array.isArray(variables) ? variables : {};
	}
	function normalizeBearerHeader(header) {
		if (typeof header !== "string") return null;
		const trimmed = header.trim();
		return /^Bearer\s+\S/i.test(trimmed) ? trimmed : null;
	}
	var CoreHooks = (() => {
		let clearingDepth = 0;
		let cacheBridge = null;
		let cacheBridgeOwner = null;
		const fetchOwners = new Set();
		const isFetchOwned = () => fetchOwners.size > 0;
		const gqlListeners = new Set();
		const rpcBlockers = new Set();
		const prefetchTokens = new Set();
		let fallbackInstalled = false;
		let fallbackTargetWin = null;
		let origFetch = null;
		let wrappedFetch = null;
		let deactivateFallback = null;
		function syncMirror() {
			try {
				const win = resolvePageWindow();
				const snapshot = {
					sessionClearing: clearingDepth > 0,
					fetchOwner: isFetchOwned(),
					hasCacheBridge: !!cacheBridge,
					rpcBlockers: rpcBlockers.size,
					prefetchSuppressed: prefetchTokens.size > 0,
					gqlSubscribers: gqlListeners.size
				};
				const existing = win.__alaCoreMirror;
				if (existing && typeof existing === "object" && !Object.isFrozen(existing)) try {
					Object.assign(existing, snapshot);
					return;
				} catch {}
				try {
					win.__alaCoreMirror = snapshot;
				} catch {}
			} catch {}
		}
		function installFallbackFetch() {
			const win = resolvePageWindow();
			const host = win?.location?.hostname || location.hostname;
			if (fallbackInstalled || isFetchOwned() || gqlListeners.size === 0) return;
			if (host !== "anilist.co") return;
			const currentFetch = typeof win.fetch === "function" ? win.fetch : typeof fetch === "function" ? fetch : null;
			if (!currentFetch) return;
			const localOrig = currentFetch;
			let instanceActive = true;
			const canIntercept = () => {
				const curHost = win?.location?.hostname || location.hostname;
				return instanceActive && !isFetchOwned() && gqlListeners.size > 0 && curHost === "anilist.co";
			};
			origFetch = localOrig;
			fallbackTargetWin = win;
			deactivateFallback = () => {
				instanceActive = false;
			};
			wrappedFetch = async function(input, init) {
				const args = arguments;
				if (!canIntercept()) return localOrig.apply(this ?? win, args);
				const rawUrl = typeof input === "string" ? input : isUrlLike(input, win) ? input.href : typeof input?.url === "string" ? input.url : "";
				if ((init?.method || (input && typeof input.method === "string" ? input.method : "GET")).toUpperCase() !== "POST" || !isAniListGraphqlUrl(rawUrl)) return localOrig.apply(this ?? win, args);
				let parsedBody = null;
				try {
					if (typeof init?.body === "string") parsedBody = JSON.parse(init.body);
					else if (isRequestLike(input, win) && !input.bodyUsed && typeof input.clone === "function") {
						const text = await input.clone().text();
						if (text) parsedBody = JSON.parse(text);
					}
				} catch {}
				if (!canIntercept()) return localOrig.apply(this ?? win, args);
				const query = typeof parsedBody?.query === "string" ? parsedBody.query : "";
				const variables = normalizeGqlVariables(parsedBody?.variables);
				const operationName = typeof parsedBody?.operationName === "string" ? parsedBody.operationName : void 0;
				if (query) emitGqlFetch({
					phase: "request",
					url: rawUrl,
					query,
					variables,
					operationName
				});
				const res = await localOrig.apply(this ?? win, args);
				if (query && canIntercept()) {
					let data = void 0;
					let errors = void 0;
					if (res && !res.bodyUsed && typeof res.clone === "function") try {
						const json = await res.clone().json();
						data = json?.data;
						errors = Array.isArray(json?.errors) ? json.errors : void 0;
					} catch {}
					if (canIntercept()) emitGqlFetch({
						phase: "response",
						url: rawUrl,
						query,
						variables,
						operationName,
						status: res.status,
						ok: res.ok,
						data,
						errors
					});
				}
				return res;
			};
			try {
				win.fetch = wrappedFetch;
				fallbackInstalled = true;
			} catch {
				instanceActive = false;
				deactivateFallback = null;
				origFetch = null;
				wrappedFetch = null;
				fallbackTargetWin = null;
			}
		}
		function uninstallFallbackFetch() {
			if (!fallbackInstalled) return;
			deactivateFallback?.();
			deactivateFallback = null;
			try {
				if (fallbackTargetWin && fallbackTargetWin.fetch === wrappedFetch && origFetch) fallbackTargetWin.fetch = origFetch;
			} catch {}
			fallbackInstalled = false;
			origFetch = null;
			wrappedFetch = null;
			fallbackTargetWin = null;
		}
		function emitGqlFetch(event) {
			if (!event || typeof event !== "object") return;
			const query = normalizeGqlQuery$1(event.query);
			const variables = normalizeGqlVariables(event.variables);
			const normalizedEvent = query === event.query && variables === event.variables ? event : {
				...event,
				query,
				variables
			};
			for (const entry of [...gqlListeners]) {
				if (!entry.active) continue;
				try {
					entry.cb(normalizedEvent);
				} catch (e) {
					coreLog$3.error("onGqlFetch listener failed:", e);
				}
			}
		}
		return {
			setSessionClearing(active) {
				clearingDepth = Math.max(0, clearingDepth + (active ? 1 : -1));
				syncMirror();
			},
			isSessionClearing() {
				return clearingDepth > 0;
			},
			getAuthHeader() {
				return normalizeBearerHeader(store$1.get("al_token_auth", null));
			},
			setAuthHeader(header) {
				if (clearingDepth > 0) return;
				if (header == null) {
					store$1.del("al_token_auth");
					return;
				}
				const valid = normalizeBearerHeader(header);
				if (!valid) return;
				store$1.set("al_token_auth", valid);
			},
			clearAuth() {
				try {
					store$1.del("al_token_auth");
				} catch (e) {
					coreLog$3.error("Failed to clear stored auth header:", e);
				}
				try {
					cacheBridge?.clearAuth();
				} catch (e) {
					coreLog$3.error("cacheBridge.clearAuth failed:", e);
				}
			},
			registerCacheBridge(bridge) {
				let active = true;
				const owner = Symbol("cache-bridge");
				cacheBridge = bridge;
				cacheBridgeOwner = owner;
				syncMirror();
				return () => {
					if (!active) return;
					active = false;
					if (cacheBridgeOwner === owner) {
						cacheBridge = null;
						cacheBridgeOwner = null;
						syncMirror();
					}
				};
			},
			getCacheBridge() {
				return cacheBridge;
			},
			markFetchOwner(active) {
				if (!active) {
					if (!isFetchOwned() && gqlListeners.size > 0) installFallbackFetch();
					syncMirror();
					return () => {};
				}
				let released = false;
				const token = Symbol("fetch-owner");
				fetchOwners.add(token);
				uninstallFallbackFetch();
				syncMirror();
				return () => {
					if (released) return;
					released = true;
					fetchOwners.delete(token);
					if (!isFetchOwned() && gqlListeners.size > 0) installFallbackFetch();
					syncMirror();
				};
			},
			hasGqlFetchSubscribers() {
				return gqlListeners.size > 0;
			},
			emitGqlFetch,
			onGqlFetch(cb) {
				const entry = {
					cb,
					active: true
				};
				gqlListeners.add(entry);
				installFallbackFetch();
				syncMirror();
				return () => {
					if (!entry.active) return;
					entry.active = false;
					gqlListeners.delete(entry);
					if (gqlListeners.size === 0) uninstallFallbackFetch();
					syncMirror();
				};
			},
			blockRpc(fn) {
				const entry = {
					cb: fn,
					active: true
				};
				rpcBlockers.add(entry);
				syncMirror();
				return () => {
					if (!entry.active) return;
					entry.active = false;
					rpcBlockers.delete(entry);
					syncMirror();
				};
			},
			isRpcBlocked(query, variables) {
				const normalizedQuery = normalizeGqlQuery$1(query);
				const normalizedVars = normalizeGqlVariables(variables);
				for (const entry of [...rpcBlockers]) {
					if (!entry.active) continue;
					try {
						if (entry.cb(normalizedQuery, normalizedVars)) return true;
					} catch (e) {
						coreLog$3.error("RPC blocker failed:", e);
					}
				}
				return false;
			},
			setPrefetchPaused(paused) {
				if (!paused) return () => {};
				let active = true;
				const token = Symbol("prefetch-pause");
				prefetchTokens.add(token);
				syncMirror();
				return () => {
					if (!active) return;
					active = false;
					prefetchTokens.delete(token);
					syncMirror();
				};
			},
			isPrefetchSuppressed() {
				return prefetchTokens.size > 0;
			}
		};
	})();
	var coreLog$2 = createCoreLogger("core");
	var Core = (() => {
		const navCbs = new Set();
		const bodyCbs = new Set();
		const ownSelectors = new Map();
		const BASE_OWN_UI = [
			"#almal-panel",
			"#almal-toast",
			"#ala-toast",
			"#ala-media-info",
			"#daiya-anisongs",
			"#ala-settings-backdrop"
		];
		let observer = null;
		let readyCancel = null;
		let lastHref = location.href;
		let muteDepth = 0;
		const pageWin = typeof _unsafeWindow !== "undefined" ? _unsafeWindow : window;
		const patchedHistories = new WeakSet();
		const PATCHED_HISTORY_SYM = Symbol.for("ala.historyPatch");
		const NAV_WATCHER_SYM = Symbol.for("ala.navWatcher");
		let navInterval = 0;
		let navListening = false;
		let queued = [];
		let flushTimer = 0;
		const fire = (set, ...args) => {
			for (const entry of [...set]) {
				if (!entry.active) continue;
				safe(() => entry.cb(...args), "core");
			}
		};
		function notifyNav() {
			if (muteDepth > 0 || location.href === lastHref) return;
			lastHref = location.href;
			coreLog$2.debug("Navigation detected:", location.pathname + location.search);
			fire(navCbs);
		}
		function clearGlobalNavWatcher() {
			const prev = globalThis[NAV_WATCHER_SYM];
			if (prev && typeof prev.stop === "function") try {
				prev.stop();
			} catch (_) {}
			try {
				delete globalThis[NAV_WATCHER_SYM];
			} catch (_) {}
		}
		clearGlobalNavWatcher();
		function stopNavWatcher() {
			if (navListening && typeof window !== "undefined") {
				window.removeEventListener("popstate", notifyNav);
				window.removeEventListener("hashchange", notifyNav);
				navListening = false;
			}
			if (navInterval) {
				clearInterval(navInterval);
				navInterval = 0;
			}
			if (globalThis[NAV_WATCHER_SYM]?.stop === stopNavWatcher) try {
				delete globalThis[NAV_WATCHER_SYM];
			} catch (_) {}
		}
		function startNavWatcher() {
			if (navListening || navInterval) return;
			clearGlobalNavWatcher();
			lastHref = location.href;
			if (typeof window !== "undefined") {
				window.addEventListener("popstate", notifyNav);
				window.addEventListener("hashchange", notifyNav);
				navListening = true;
			}
			navInterval = setInterval(notifyNav, 400);
			try {
				globalThis[NAV_WATCHER_SYM] = { stop: stopNavWatcher };
			} catch (_) {}
		}
		function patchHistory(hist) {
			if (!hist || patchedHistories.has(hist)) return;
			patchedHistories.add(hist);
			let state;
			try {
				state = hist[PATCHED_HISTORY_SYM];
				if (!state) {
					state = { notify: notifyNav };
					hist[PATCHED_HISTORY_SYM] = state;
				} else state.notify = notifyNav;
			} catch (_) {
				state = void 0;
			}
			const activeState = state;
			for (const name of ["pushState", "replaceState"]) {
				const orig = hist[name];
				if (typeof orig !== "function") continue;
				if (orig[PATCHED_HISTORY_SYM] && activeState) continue;
				try {
					const wrapped = function(...args) {
						const r = orig.apply(this, args);
						if (activeState) activeState.notify();
						else notifyNav();
						return r;
					};
					wrapped[PATCHED_HISTORY_SYM] = true;
					hist[name] = wrapped;
				} catch (_) {}
			}
		}
		patchHistory(pageWin?.history);
		if (typeof window !== "undefined" && window.history !== pageWin?.history) patchHistory(window.history);
		function ready(cb) {
			if (document.body) {
				safe(cb, "ready");
				return () => {};
			}
			let cancelled = false;
			const onReady = () => {
				if (cancelled) return;
				cancelled = true;
				safe(cb, "ready");
			};
			document.addEventListener("DOMContentLoaded", onReady, { once: true });
			return () => {
				if (cancelled) return;
				cancelled = true;
				document.removeEventListener("DOMContentLoaded", onReady);
			};
		}
		function combinedOwnSelector() {
			if (ownSelectors.size === 0) return BASE_OWN_UI.join(",");
			return [...BASE_OWN_UI, ...ownSelectors.values()].join(",");
		}
		function isOwn(m) {
			const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
			if (!t) return false;
			try {
				return !!t.closest(combinedOwnSelector());
			} catch {
				for (const sel of [...BASE_OWN_UI, ...ownSelectors.values()]) try {
					if (t.closest(sel)) return true;
				} catch {}
				return false;
			}
		}
		function disconnectObserver() {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = 0;
			}
			queued = [];
			if (observer) {
				observer.disconnect();
				observer = null;
			}
			if (readyCancel) {
				readyCancel();
				readyCancel = null;
			}
		}
		function ensureObserver() {
			if (bodyCbs.size === 0 || observer) return;
			if (!document.body) {
				if (!readyCancel) readyCancel = ready(() => {
					readyCancel = null;
					ensureObserver();
				});
				return;
			}
			observer = new MutationObserver((records) => {
				for (const record of records) if (!isOwn(record)) queued.push(record);
				if (queued.length && !flushTimer) flushTimer = setTimeout(() => {
					flushTimer = 0;
					const batch = queued;
					queued = [];
					coreLog$2.debug(`Flushing mutation batch: ${batch.length} record(s) to ${bodyCbs.size} listener(s)`);
					fire(bodyCbs, batch);
				}, 50);
			});
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				characterData: true
			});
		}
		function registerOwnUi(selector) {
			const cleanSel = String(selector || "").trim();
			if (!cleanSel) return () => {};
			let active = true;
			const token = Symbol(cleanSel);
			ownSelectors.set(token, cleanSel);
			return () => {
				if (!active) return;
				active = false;
				ownSelectors.delete(token);
			};
		}
		function onNavigate(cb) {
			const entry = {
				cb,
				active: true
			};
			const wasEmpty = navCbs.size === 0;
			navCbs.add(entry);
			if (wasEmpty) startNavWatcher();
			return () => {
				if (!entry.active) return;
				entry.active = false;
				navCbs.delete(entry);
				if (navCbs.size === 0) stopNavWatcher();
			};
		}
		function onBodyMutation(cb) {
			const entry = {
				cb,
				active: true
			};
			bodyCbs.add(entry);
			ensureObserver();
			return () => {
				if (!entry.active) return;
				entry.active = false;
				bodyCbs.delete(entry);
				if (bodyCbs.size === 0) disconnectObserver();
			};
		}
		const INVALID_SELECTOR = Symbol("invalidSelector");
		function safeQuerySelector(selector) {
			try {
				return document.querySelector(selector);
			} catch {
				return INVALID_SELECTOR;
			}
		}
		function waitForSelector(selector, timeoutMs = 8e3, signal) {
			if (signal?.aborted) return Promise.resolve(null);
			const existing = safeQuerySelector(selector);
			if (existing === INVALID_SELECTOR) return Promise.resolve(null);
			if (existing) return Promise.resolve(existing);
			if (!(timeoutMs > 0)) return Promise.resolve(null);
			return new Promise((resolve) => {
				let done = false;
				let unsub = null;
				let readyUnsub = null;
				let onAbort = null;
				let timer = null;
				const finish = (v) => {
					if (done) return;
					done = true;
					if (timer !== null) {
						clearTimeout(timer);
						timer = null;
					}
					if (onAbort && signal) signal.removeEventListener("abort", onAbort);
					if (readyUnsub) {
						readyUnsub();
						readyUnsub = null;
					}
					if (unsub) {
						unsub();
						unsub = null;
					}
					resolve(v);
				};
				const checkSelector = () => {
					const el = safeQuerySelector(selector);
					if (el === INVALID_SELECTOR) finish(null);
					else if (el) finish(el);
				};
				if (signal) {
					onAbort = () => finish(null);
					signal.addEventListener("abort", onAbort, { once: true });
				}
				if (Number.isFinite(timeoutMs)) timer = setTimeout(() => finish(null), Math.min(timeoutMs, 2147483647));
				unsub = onBodyMutation(checkSelector);
				if (!done && !document.body) readyUnsub = ready(() => {
					readyUnsub = null;
					checkSelector();
				});
			});
		}
		function silently(fn) {
			muteDepth++;
			try {
				fn();
			} finally {
				muteDepth = Math.max(0, muteDepth - 1);
				if (muteDepth === 0) lastHref = location.href;
			}
		}
		return {
			onNavigate,
			onBodyMutation,
			waitForSelector,
			ready,
			silently,
			registerOwnUi
		};
	})();
	var styleRefCounts = new Map();
	var styleGenerations = new Map();
	function prefixAlaId(id) {
		const trimmed = id.trim();
		if (!trimmed) return "";
		return trimmed.startsWith("ala-") ? trimmed : `ala-${trimmed}`;
	}
	function addStyle(id, css) {
		const styleId = prefixAlaId(id) || "ala-style";
		let disposed = false;
		let cancelReady = null;
		styleRefCounts.set(styleId, (styleRefCounts.get(styleId) || 0) + 1);
		const myGen = (styleGenerations.get(styleId) || 0) + 1;
		styleGenerations.set(styleId, myGen);
		const mount = () => {
			if (disposed || styleGenerations.get(styleId) !== myGen) return;
			const parent = document.head || document.documentElement;
			if (!parent) return;
			const text = typeof css === "function" ? css() : css;
			const existing = document.getElementById(styleId);
			if (existing) {
				if (existing.textContent !== text) existing.textContent = text;
				return;
			}
			const s = document.createElement("style");
			s.id = styleId;
			s.textContent = text;
			parent.appendChild(s);
		};
		if (document.head) mount();
		else cancelReady = Core.ready(mount);
		return () => {
			if (disposed) return;
			disposed = true;
			cancelReady?.();
			cancelReady = null;
			const nextCount = (styleRefCounts.get(styleId) || 1) - 1;
			if (nextCount <= 0) {
				styleRefCounts.delete(styleId);
				styleGenerations.delete(styleId);
				document.getElementById(styleId)?.remove();
			} else styleRefCounts.set(styleId, nextCount);
		};
	}
	var scopeLog = createCoreLogger("core");
	var MAX_CLEANUP_ITERATIONS = 1e4;
	var noop$2 = () => {};
	function drainCleanupsReverse(label, cleanups, onError) {
		let iterations = 0;
		while (cleanups.size > 0) {
			const batch = [...cleanups];
			for (let i = batch.length - 1; i >= 0; i--) {
				if (++iterations > MAX_CLEANUP_ITERATIONS) {
					const msg = `Scope "${label}" exceeded max cleanup iterations (${MAX_CLEANUP_ITERATIONS}); aborting teardown.`;
					if (onError) onError(new Error(msg));
					else scopeLog.error(msg);
					cleanups.clear();
					return;
				}
				const fn = batch[i];
				if (!cleanups.has(fn)) continue;
				cleanups.delete(fn);
				try {
					fn();
				} catch (err) {
					if (onError) onError(err);
					else scopeLog.error(`Scope "${label}" failed during cleanup:`, err);
				}
			}
		}
	}
	function createCleanupTracker(opts) {
		const { prefix, signal, isClosed: externalClosed, cleanups = new Set(), onError } = opts;
		const checkClosed = () => signal.aborted || Boolean(externalClosed?.());
		const reportError = (err) => {
			if (onError) onError(err);
			else scopeLog.error(`Scope "${prefix}" failed during cleanup:`, err);
		};
		const track = (fn) => {
			if (checkClosed()) {
				try {
					fn();
				} catch (err) {
					reportError(err);
				}
				return fn;
			}
			let ran = false;
			const wrapped = (() => {
				if (ran) return;
				ran = true;
				cleanups.delete(wrapped);
				fn();
			});
			cleanups.add(wrapped);
			return wrapped;
		};
		const listen = (target, type, listener, options) => {
			if (checkClosed()) return noop$2;
			const isOnce = typeof options === "object" && options !== null && Boolean(options.once);
			let trackedRemove = noop$2;
			const wrappedListener = (ev) => {
				if (isOnce && trackedRemove !== noop$2) cleanups.delete(trackedRemove);
				if (checkClosed()) return;
				if (typeof listener === "function") listener.call(target, ev);
				else listener.handleEvent(ev);
			};
			target.addEventListener(type, wrappedListener, options);
			trackedRemove = track(() => target.removeEventListener(type, wrappedListener, options));
			return trackedRemove;
		};
		const timeout = (fn, ms) => {
			if (checkClosed()) return noop$2;
			let fired = false;
			let cancelTracked = noop$2;
			const id = setTimeout(() => {
				fired = true;
				if (cancelTracked !== noop$2) cleanups.delete(cancelTracked);
				if (!checkClosed()) fn();
			}, ms);
			if (fired) return noop$2;
			cancelTracked = track(() => clearTimeout(id));
			return cancelTracked;
		};
		const dispose = () => {
			drainCleanupsReverse(prefix, cleanups, onError);
		};
		return {
			cleanups,
			isClosed: checkClosed,
			track,
			listen,
			timeout,
			dispose
		};
	}
	var modalLog = createCoreLogger("core");
	var noop$1 = () => {};
	var fallbackSeq = 0;
	var activeModals = new Map();
	var modalStack = [];
	var scrollLockCount = 0;
	var savedOverflow = null;
	function hasActiveModal() {
		return modalStack.length > 0;
	}
	function acquireScrollLock() {
		if (scrollLockCount === 0 && typeof document !== "undefined" && document.documentElement) {
			savedOverflow = document.documentElement.style.overflow;
			document.documentElement.style.overflow = "hidden";
		}
		scrollLockCount++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (scrollLockCount > 0) {
				scrollLockCount--;
				if (scrollLockCount === 0) {
					if (savedOverflow !== null && typeof document !== "undefined" && document.documentElement) document.documentElement.style.overflow = savedOverflow;
					savedOverflow = null;
				}
			}
		};
	}
	function registerModalOverlay(onEscape) {
		const entry = { close: onEscape };
		modalStack.push(entry);
		let disposed = false;
		return {
			isTop: () => !disposed && modalStack[modalStack.length - 1] === entry,
			dispose: () => {
				if (disposed) return;
				disposed = true;
				const idx = modalStack.indexOf(entry);
				if (idx !== -1) modalStack.splice(idx, 1);
			}
		};
	}
	function createDeadModalHandle(id, onError) {
		const dead = document.createElement("div");
		const ac = new AbortController();
		ac.abort();
		return {
			id,
			selector: `#${id}`,
			signal: ac.signal,
			backdrop: dead,
			sheet: dead,
			body: dead,
			footer: dead,
			close: noop$1,
			listen: () => noop$1,
			timeout: () => noop$1,
			onCleanup: (fn) => {
				try {
					fn();
				} catch (err) {
					if (onError) onError(err);
					else modalLog.error(`Modal "${id}" cleanup failed:`, err);
				}
			}
		};
	}
	var MODAL_STYLE_ID = "ala-core-modal-style";
	var MODAL_CSS$1 = `
  .ala-core-backdrop{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:rgba(5,12,20,.72);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
  .ala-core-sheet{display:flex;flex-direction:column;width:100%;max-height:92vh;border-radius:10px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));box-shadow:0 18px 60px rgba(0,0,0,.5);overflow:hidden}
  .ala-core-sheet *{box-sizing:border-box}
  .ala-core-sheet :focus-visible{outline:2px solid rgb(var(--color-blue));outline-offset:2px}
  .ala-core-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid rgba(var(--color-text-lighter),.14)}
  .ala-core-head-text{min-width:0}
  .ala-core-head h2{margin:0;font-size:18px;font-weight:600}
  .ala-core-subtitle{margin-top:2px;font-size:12px;color:rgb(var(--color-text-lighter));line-height:1.4}
  .ala-core-body{flex:1 1 auto;min-height:0;padding:16px 20px;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;scrollbar-gutter:stable}
  .ala-core-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:12px 20px;border-top:1px solid rgba(var(--color-text-lighter),.14)}
  .ala-core-sheet .ala-btn{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 18px;border:1px solid rgba(var(--color-text-lighter),.25);border-radius:4px;background:transparent;color:rgb(var(--color-text));font:inherit;font-size:13px;cursor:pointer}
  .ala-core-sheet .ala-btn--primary{border-color:transparent;background:rgb(var(--color-blue));color:#fff;font-weight:600}
  .ala-core-sheet .ala-btn--danger{border-color:rgba(var(--color-red,224,85,85),.35);color:rgb(var(--color-red,224,85,85))}
  .ala-core-sheet .ala-btn--danger:hover{border-color:transparent;background:rgb(var(--color-red,224,85,85));color:#fff}
  .ala-core-sheet .ala-btn--sm{min-height:32px;padding:0 12px;font-size:12px}
  .ala-core-sheet .ala-btn:hover:not(:disabled){filter:brightness(1.1)}
  .ala-core-sheet .ala-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:36px;height:36px;border:0;border-radius:50%;background:transparent;color:rgb(var(--color-text-lighter));cursor:pointer}
  .ala-core-sheet .ala-icon-btn:hover{background:rgba(var(--color-text-lighter),.14);color:rgb(var(--color-text))}
`;
	function createModal(opts) {
		const modalId = prefixAlaId(opts.id?.trim() || `modal-${++fallbackSeq}`);
		const selector = `#${modalId}`;
		const existingClose = activeModals.get(modalId);
		if (existingClose) existingClose();
		if (!document.body) return createDeadModalHandle(modalId);
		const modalAc = new AbortController();
		let closed = false;
		const lifecycle = createCleanupTracker({
			prefix: modalId,
			signal: modalAc.signal,
			isClosed: () => closed,
			onError: (err) => modalLog.error(`Modal "${modalId}" cleanup failed:`, err)
		});
		const trackModal = lifecycle.track;
		let backdrop = null;
		let onKeyRef = null;
		let overlayHandle = null;
		let releaseScrollLock = null;
		let closeRef = null;
		const cleanupResources = () => {
			if (onKeyRef) {
				document.removeEventListener("keydown", onKeyRef, true);
				onKeyRef = null;
			}
			if (closeRef && activeModals.get(modalId) === closeRef) activeModals.delete(modalId);
			if (overlayHandle) {
				const handle = overlayHandle;
				overlayHandle = null;
				handle.dispose();
			}
			if (releaseScrollLock) {
				const release = releaseScrollLock;
				releaseScrollLock = null;
				release();
			}
			backdrop?.remove();
			lifecycle.dispose();
		};
		const close = () => {
			if (closed) return;
			closed = true;
			modalAc.abort();
			cleanupResources();
			opts.onClose?.();
		};
		closeRef = close;
		try {
			trackModal(addStyle(MODAL_STYLE_ID, MODAL_CSS$1));
			if (opts.style !== void 0) {
				const styleSource = opts.style;
				trackModal(addStyle(`${modalId}-style`, typeof styleSource === "function" ? () => styleSource(selector) : styleSource));
			}
			trackModal(Core.registerOwnUi(selector));
			document.getElementById(modalId)?.remove();
			backdrop = document.createElement("div");
			backdrop.id = modalId;
			backdrop.className = "ala-core-backdrop";
			const titleId = `${modalId}-title`;
			const titleHtml = opts.subtitle ? `<div class="ala-core-head-text"><h2 id="${esc(titleId)}">${esc(opts.title)}</h2><div class="ala-core-subtitle">${esc(opts.subtitle)}</div></div>` : `<h2 id="${esc(titleId)}">${esc(opts.title)}</h2>`;
			backdrop.innerHTML = `
    <div class="ala-core-sheet" style="max-width:${esc(opts.maxWidth || "640px")}" role="dialog" aria-modal="true" aria-labelledby="${esc(titleId)}">
      <header class="ala-core-head">
        ${titleHtml}
        <button class="ala-icon-btn ala-core-close" type="button" aria-label="Close">✕</button>
      </header>
      <div class="ala-core-body">${opts.bodyHtml || ""}</div>
      <footer class="ala-core-foot">${opts.footerHtml || ""}</footer>
    </div>
  `;
			const onKey = (e) => {
				if (e.key !== "Escape") return;
				if (!overlayHandle?.isTop()) return;
				e.preventDefault();
				e.stopImmediatePropagation();
				close();
			};
			onKeyRef = onKey;
			activeModals.set(modalId, close);
			overlayHandle = registerModalOverlay(close);
			releaseScrollLock = acquireScrollLock();
			document.addEventListener("keydown", onKey, true);
			backdrop.querySelector(".ala-core-close")?.addEventListener("click", close);
			backdrop.addEventListener("click", (e) => {
				if (e.target === backdrop) {
					close();
					return;
				}
				if (e.defaultPrevented) return;
				const closeTrigger = (e.target instanceof Element ? e.target : null)?.closest("[data-ala-close]");
				if (closeTrigger && backdrop.contains(closeTrigger) && !closeTrigger.disabled) close();
			});
			document.body.appendChild(backdrop);
		} catch (err) {
			closed = true;
			modalAc.abort();
			cleanupResources();
			throw err;
		}
		const onCleanup = (fn) => {
			trackModal(fn);
		};
		return {
			id: modalId,
			selector,
			signal: modalAc.signal,
			backdrop,
			sheet: backdrop.querySelector(".ala-core-sheet"),
			body: backdrop.querySelector(".ala-core-body"),
			footer: backdrop.querySelector(".ala-core-foot"),
			close,
			listen: lifecycle.listen,
			timeout: lifecycle.timeout,
			onCleanup
		};
	}
	function bindModalAbortSignal(handle, signal, onSettled) {
		if (!signal) return false;
		const onAbort = () => {
			try {
				handle.close();
			} finally {
				onSettled();
			}
		};
		if (signal.aborted) {
			onAbort();
			return true;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		handle.onCleanup(() => signal.removeEventListener("abort", onAbort));
		return false;
	}
	function openConfirmModal(opts, modalFactory = createModal) {
		const normalized = typeof opts === "string" ? { message: opts } : opts;
		const signal = normalized.signal;
		if (signal?.aborted) return Promise.resolve(false);
		const title = normalized.title?.trim() || "Confirm";
		const confirmText = normalized.confirmText?.trim() || "Confirm";
		const cancelText = normalized.cancelText?.trim() || "Cancel";
		const maxWidth = normalized.maxWidth || "420px";
		return new Promise((resolve) => {
			let settled = false;
			let confirmed = false;
			const finish = (value) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			let handle;
			try {
				handle = modalFactory({
					id: normalized.id,
					title,
					subtitle: normalized.subtitle,
					maxWidth,
					bodyHtml: `<p class="ala-core-dialog-msg" style="margin:0;white-space:pre-line;line-height:1.5">${esc(normalized.message)}</p>`,
					footerHtml: `<button type="button" class="ala-btn ala-core-confirm-cancel" data-ala-close>${esc(cancelText)}</button><button type="button" class="ala-btn ${normalized.danger ? "ala-btn--danger" : "ala-btn--primary"} ala-core-confirm-ok">${esc(confirmText)}</button>`,
					onClose: () => finish(confirmed)
				});
			} catch {
				finish(false);
				return;
			}
			if (!handle.backdrop.isConnected || handle.signal.aborted) {
				finish(false);
				return;
			}
			if (bindModalAbortSignal(handle, signal, () => finish(false))) return;
			const okBtn = handle.footer.querySelector(".ala-core-confirm-ok");
			const cancelBtn = handle.footer.querySelector(".ala-core-confirm-cancel");
			if (okBtn) handle.listen(okBtn, "click", () => {
				confirmed = true;
				try {
					handle.close();
				} finally {
					finish(true);
				}
			});
			(normalized.danger ? cancelBtn : okBtn)?.focus?.();
		});
	}
	function openAlertModal(opts, modalFactory = createModal) {
		const normalized = typeof opts === "string" ? { message: opts } : opts;
		const signal = normalized.signal;
		if (signal?.aborted) return Promise.resolve(void 0);
		const title = normalized.title?.trim() || "Notice";
		const okText = normalized.okText?.trim() || "OK";
		const maxWidth = normalized.maxWidth || "420px";
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				resolve(void 0);
			};
			let handle;
			try {
				handle = modalFactory({
					id: normalized.id,
					title,
					subtitle: normalized.subtitle,
					maxWidth,
					bodyHtml: `<p class="ala-core-dialog-msg" style="margin:0;white-space:pre-line;line-height:1.5">${esc(normalized.message)}</p>`,
					footerHtml: `<button type="button" class="ala-btn ala-btn--primary ala-core-alert-ok" data-ala-close>${esc(okText)}</button>`,
					onClose: finish
				});
			} catch {
				finish();
				return;
			}
			if (!handle.backdrop.isConnected || handle.signal.aborted) {
				finish();
				return;
			}
			if (bindModalAbortSignal(handle, signal, finish)) return;
			handle.footer.querySelector(".ala-core-alert-ok")?.focus?.();
		});
	}
	var noop = () => {};
	function createContextScope(opts) {
		const { prefix, signal, isClosed: externalClosed, cleanups: initialCleanups, styleKind = "style", counters = {
			idSeq: 0,
			styleSeq: 0,
			modalSeq: 0
		}, onError, onModalStart, onModalAbort, onModalClose } = opts;
		const lifecycle = createCleanupTracker({
			prefix,
			signal,
			isClosed: externalClosed,
			cleanups: initialCleanups,
			onError
		});
		const cleanups = lifecycle.cleanups;
		const checkClosed = lifecycle.isClosed;
		const track = lifecycle.track;
		const whenAlive = (fn) => {
			if (checkClosed()) return noop;
			return track(fn());
		};
		const onCleanup = (fn) => {
			track(fn);
		};
		const getId = (name) => {
			const trimmed = name?.trim();
			if (!trimmed) return `ala-${prefix}-${++counters.idSeq}`;
			return trimmed.startsWith("ala-") ? trimmed : `ala-${prefix}-${trimmed}`;
		};
		const scopedAddStyle = (idOrCss, maybeCss) => {
			if (checkClosed()) return noop;
			const isOneArg = maybeCss === void 0;
			const css = isOneArg ? idOrCss : maybeCss;
			let styleId;
			if (isOneArg) styleId = `ala-${prefix}-${styleKind}-${++counters.styleSeq}`;
			else {
				const raw = String(idOrCss || "").trim();
				if (!raw) styleId = `ala-${prefix}-${styleKind}-${++counters.styleSeq}`;
				else if (raw.startsWith("ala-")) styleId = raw;
				else styleId = `ala-${prefix}-${raw}${raw.endsWith("-style") ? "" : "-style"}`;
			}
			return track(addStyle(styleId, css));
		};
		const debounce = (fn, ms = 0) => {
			let timerId = 0;
			let pendingArgs = null;
			let trackedCancel = null;
			const cancel = () => {
				if (timerId) {
					clearTimeout(timerId);
					timerId = 0;
				}
				pendingArgs = null;
				if (trackedCancel) {
					cleanups.delete(trackedCancel);
					trackedCancel = null;
				}
			};
			const flush = () => {
				if (!pendingArgs || checkClosed()) {
					cancel();
					return;
				}
				const args = pendingArgs;
				cancel();
				fn(...args);
			};
			const debounced = ((...args) => {
				if (checkClosed()) {
					cancel();
					return;
				}
				if (timerId) {
					clearTimeout(timerId);
					timerId = 0;
				}
				pendingArgs = args;
				if (!trackedCancel) {
					trackedCancel = () => cancel();
					cleanups.add(trackedCancel);
				}
				timerId = setTimeout(() => {
					timerId = 0;
					const argsToRun = pendingArgs;
					pendingArgs = null;
					if (trackedCancel) {
						cleanups.delete(trackedCancel);
						trackedCancel = null;
					}
					if (argsToRun && !checkClosed()) fn(...argsToRun);
				}, ms);
			});
			debounced.cancel = cancel;
			debounced.flush = flush;
			return debounced;
		};
		const raf = (fn) => {
			if (checkClosed()) return noop;
			const hasRaf = typeof requestAnimationFrame === "function";
			const hasCancelRaf = typeof cancelAnimationFrame === "function";
			if (!hasRaf) {
				let fired = false;
				let cancelTracked = noop;
				const timerId = setTimeout(() => {
					fired = true;
					if (cancelTracked !== noop) cleanups.delete(cancelTracked);
					if (!checkClosed()) fn(typeof performance !== "undefined" ? performance.now() : Date.now());
				}, 16);
				if (fired) return noop;
				cancelTracked = track(() => clearTimeout(timerId));
				return cancelTracked;
			}
			let fired = false;
			let cancelTracked = noop;
			const frameId = requestAnimationFrame((ts) => {
				fired = true;
				if (cancelTracked !== noop) cleanups.delete(cancelTracked);
				if (!checkClosed()) fn(ts);
			});
			if (fired) return noop;
			cancelTracked = track(() => {
				if (hasCancelRaf) cancelAnimationFrame(frameId);
			});
			return cancelTracked;
		};
		const interval = (fn, ms) => {
			if (checkClosed()) return noop;
			const id = setInterval(() => {
				if (!checkClosed()) fn();
			}, ms);
			return track(() => clearInterval(id));
		};
		const observe = (target, options, cb) => {
			if (checkClosed() || !target || typeof MutationObserver !== "function") return noop;
			const observer = new MutationObserver((mutations, obs) => {
				if (checkClosed()) return;
				cb(mutations, obs);
			});
			observer.observe(target, options);
			return track(() => observer.disconnect());
		};
		const modal = (modalOpts) => {
			const modalId = getId(modalOpts.id?.trim() || `modal-${++counters.modalSeq}`);
			if (checkClosed()) return createDeadModalHandle(modalId, onError);
			let onCloseFired = false;
			let untracked = false;
			let removeTracked = noop;
			onModalStart?.();
			let handle;
			try {
				handle = createModal({
					...modalOpts,
					id: modalId,
					onClose: () => {
						onCloseFired = true;
						if (!untracked) {
							untracked = true;
							removeTracked();
						}
						try {
							modalOpts.onClose?.();
						} finally {
							onModalClose?.();
						}
					}
				});
			} catch (err) {
				if (!onCloseFired) onModalAbort?.();
				throw err;
			}
			if (!onCloseFired && !handle.backdrop.isConnected) {
				onModalAbort?.();
				return handle;
			}
			if (!untracked && handle.backdrop.isConnected) {
				const trackedClose = track(handle.close);
				removeTracked = () => cleanups.delete(trackedClose);
				return {
					...handle,
					close: trackedClose
				};
			}
			return handle;
		};
		const confirm = (confirmOpts) => {
			if (checkClosed()) return Promise.resolve(false);
			return openConfirmModal(confirmOpts, modal);
		};
		const alert = (alertOpts) => {
			if (checkClosed()) return Promise.resolve(void 0);
			return openAlertModal(alertOpts, modal);
		};
		const waitForSelector = (selector, timeoutMs = 8e3) => {
			if (checkClosed()) return Promise.resolve(null);
			return Core.waitForSelector(selector, timeoutMs, signal);
		};
		return {
			signal,
			cleanups,
			isClosed: checkClosed,
			track,
			whenAlive,
			onCleanup,
			dispose: lifecycle.dispose,
			getId,
			addStyle: scopedAddStyle,
			listen: lifecycle.listen,
			interval,
			timeout: lifecycle.timeout,
			debounce,
			raf,
			observe,
			modal,
			confirm,
			alert,
			waitForSelector
		};
	}
	function scopeAniListClient(getClient, scopeSignal, isClosed) {
		const withScopeSignal = (callerSignal, run) => {
			if (!callerSignal || callerSignal === scopeSignal) return run(scopeSignal);
			const composed = composeAbortSignals(scopeSignal, callerSignal);
			let promise;
			try {
				promise = run(composed.signal);
			} catch (err) {
				composed.dispose();
				return Promise.reject(err);
			}
			return composed.dispose === noop ? promise : promise.finally(composed.dispose);
		};
		return {
			query: (q, variables, optionsOrRetries) => {
				if (isClosed() && isGqlMutation(q)) return Promise.reject(new Error("Context disposed"));
				const baseOpts = typeof optionsOrRetries === "number" ? { retries: optionsOrRetries } : optionsOrRetries || {};
				return withScopeSignal(baseOpts.signal, (signal) => getClient().query(q, variables, {
					...baseOpts,
					signal
				}));
			},
			getMediaList: (target, type, options) => withScopeSignal(options?.signal, (signal) => getClient().getMediaList(target, type, {
				...options,
				signal
			})),
			viewer: (forceFresh, opts) => withScopeSignal(opts?.signal, (signal) => getClient().viewer(forceFresh, {
				...opts,
				signal
			})),
			clearViewer: () => {
				if (!isClosed()) getClient().clearViewer();
			},
			invalidate: (...args) => {
				if (!isClosed()) getClient().invalidate(...args);
			},
			invalidateMediaList: (...args) => {
				if (!isClosed()) getClient().invalidateMediaList(...args);
			},
			hasAuth: (opts) => getClient().hasAuth(isClosed() ? {
				...opts,
				reconcile: false
			} : opts),
			resumeAt: () => getClient().resumeAt(),
			media: {
				get: (id, type, opts) => withScopeSignal(opts?.signal, (signal) => getClient().media.get(id, type, {
					...opts,
					signal
				})),
				save: (id, type, patch, opts) => {
					if (isClosed()) return Promise.reject(new Error("Context disposed"));
					return withScopeSignal(opts?.signal, (signal) => getClient().media.save(id, type, patch, {
						...opts,
						signal
					}));
				}
			}
		};
	}
	var coreLog$1 = createCoreLogger("core");
	var entries = new Map();
	function resolveRegisterMenuCommand() {
		const g = globalThis;
		if (Object.prototype.hasOwnProperty.call(g, "GM_registerMenuCommand")) return typeof g.GM_registerMenuCommand === "function" ? g.GM_registerMenuCommand : null;
		return typeof _GM_registerMenuCommand === "function" ? _GM_registerMenuCommand : null;
	}
	function registerMenuCommand(label, onClick) {
		let entry = entries.get(label);
		if (!entry) {
			entry = {
				handler: null,
				registered: false
			};
			entries.set(label, entry);
		}
		entry.handler = onClick;
		if (!entry.registered) {
			const regFn = resolveRegisterMenuCommand();
			if (regFn) {
				entry.registered = true;
				regFn(label, () => {
					try {
						entry?.handler?.();
					} catch (e) {
						coreLog$1.error(`Menu command "${label}" failed:`, e);
					}
				});
			}
		}
		return () => {
			if (entry && entry.handler === onClick) entry.handler = null;
		};
	}
	var TOAST_ID = "ala-toast";
	var hideTimer = 0;
	var ownUiRegistered = false;
	function showToast(msg, opts = {}) {
		const { type = "info", durationMs = 6e3, closeTab = false } = opts;
		Core.ready(() => {
			if (!ownUiRegistered) {
				ownUiRegistered = true;
				Core.registerOwnUi(`#${TOAST_ID}`);
			}
			let t = document.getElementById(TOAST_ID);
			if (!t) {
				t = document.createElement("div");
				t.id = TOAST_ID;
				t.setAttribute("role", "status");
				t.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:10px 18px;border-radius:4px;color:#fff;font-size:1.2rem;z-index:999999;box-shadow:0 4px 16px rgba(0,0,0,.45);max-width:min(90vw,480px);text-align:center";
				document.body.appendChild(t);
			}
			t.textContent = msg;
			t.style.background = type === "error" ? "#b23b3b" : type === "success" ? "#2f8f5b" : "#2b6cb0";
			t.style.display = "block";
			clearTimeout(hideTimer);
			if (durationMs > 0) hideTimer = setTimeout(() => {
				if (t) t.style.display = "none";
			}, durationMs);
			if (closeTab) setTimeout(() => safe(() => window.close()), 1800);
		});
	}
	var toastSuccess = (msg, opts = {}) => showToast(msg, {
		...opts,
		type: "success"
	});
	var toastError = (msg, opts = {}) => showToast(msg, {
		...opts,
		type: "error"
	});
	var coreLog = createCoreLogger("core");
	var modules = [];
	var LAYER_ORDER = {
		intercept: 0,
		preload: 1,
		service: 2,
		feature: 3,
		shell: 4
	};
	var ID_RE = /^[a-z][A-Za-z0-9]*$/;
	var RESERVED_MODULE_IDS = new Set(["core", "devMode"]);
	var teardownStarters = new WeakMap();
	var configuredServices = null;
	function configureCoreServices(services) {
		configuredServices = services;
	}
	function getCoreApi() {
		if (!configuredServices) throw new Error("[AL-Additions] Core services not configured before module access.");
		return configuredServices.api;
	}
	function getCoreSession() {
		if (!configuredServices) throw new Error("[AL-Additions] Core services not configured before module access.");
		return configuredServices.session;
	}
	var records = [];
	var recordsById = new Map();
	var invalidIds = new Map();
	var liveStatuses = new Map();
	var statusListeners = new Set();
	var deferredStarted = false;
	function currentHost() {
		return location.hostname;
	}
	function resolveHostMatches(hosts, host) {
		return hosts.includes("*") || hosts.includes(host);
	}
	function emitStatusChange(id, status) {
		const prev = liveStatuses.get(id);
		const changed = !prev || prev.active !== status.active || prev.reason !== status.reason || prev.error !== status.error || JSON.stringify(prev.missingDeps || []) !== JSON.stringify(status.missingDeps || []) || JSON.stringify(prev.disabledDeps || []) !== JSON.stringify(status.disabledDeps || []);
		liveStatuses.set(id, status);
		if (changed) for (const cb of [...statusListeners]) try {
			cb(id, status);
		} catch (e) {
			coreLog.error("Module status listener failed:", e);
		}
	}
	function resolveAllStates(stagedEnabled) {
		const host = currentHost();
		const statuses = {};
		const candidates = new Map();
		for (const [badId, status] of invalidIds) statuses[badId] = status;
		for (const rec of records) {
			if (rec.invalidId) {
				statuses[rec.id] = {
					active: false,
					reason: "invalid-id"
				};
				continue;
			}
			if (rec.idCollision) {
				statuses[rec.id] = {
					active: false,
					reason: "id-collision"
				};
				continue;
			}
			if (!resolveHostMatches(rec.hosts, host)) {
				statuses[rec.id] = {
					active: false,
					reason: "host-mismatch"
				};
				continue;
			}
			if (!(stagedEnabled && rec.id in stagedEnabled ? !!stagedEnabled[rec.id] : rec.setting ? !!Settings.get(rec.setting) : true)) {
				statuses[rec.id] = {
					active: false,
					reason: "disabled"
				};
				continue;
			}
			if (rec.standalonePaused) {
				statuses[rec.id] = {
					active: false,
					reason: "standalone-paused"
				};
				continue;
			}
			if (!stagedEnabled && rec.runtimeError) {
				statuses[rec.id] = {
					active: false,
					reason: "error",
					error: rec.runtimeError
				};
				continue;
			}
			candidates.set(rec.id, rec);
		}
		let changed = true;
		while (changed) {
			changed = false;
			for (const [id, rec] of [...candidates]) {
				const missingDeps = [];
				const disabledDeps = [];
				let layerConflict = false;
				let cycleDep = false;
				for (const depId of rec.dependsOn) {
					const depRec = recordsById.get(depId);
					if (!depRec) {
						missingDeps.push(depId);
						continue;
					}
					if (LAYER_ORDER[depRec.layer] > LAYER_ORDER[rec.layer]) {
						layerConflict = true;
						continue;
					}
					if (!candidates.has(depId)) {
						const depStatus = statuses[depId];
						if (depStatus?.reason === "disabled" || depStatus?.reason === "dep-off") disabledDeps.push(depId);
						else if (depStatus?.reason === "cycle") cycleDep = true;
						else missingDeps.push(depId);
					}
				}
				let reason = null;
				if (layerConflict) reason = "layer-conflict";
				else if (missingDeps.length) reason = "dep-unavailable";
				else if (disabledDeps.length) reason = "dep-off";
				else if (cycleDep) reason = "cycle";
				if (reason) {
					statuses[id] = {
						active: false,
						reason,
						...missingDeps.length ? { missingDeps } : {},
						...disabledDeps.length ? { disabledDeps } : {}
					};
					candidates.delete(id);
					changed = true;
				}
			}
		}
		const hardIn = new Map();
		const hardOut = new Map();
		for (const id of candidates.keys()) {
			hardIn.set(id, 0);
			hardOut.set(id, []);
		}
		for (const [id, rec] of candidates) for (const depId of new Set(rec.dependsOn)) if (candidates.has(depId)) {
			hardIn.set(id, (hardIn.get(id) || 0) + 1);
			hardOut.get(depId).push(id);
		}
		const kahnQueue = [];
		for (const [id, deg] of hardIn) if (deg === 0) kahnQueue.push(id);
		const acyclic = new Set();
		while (kahnQueue.length) {
			const id = kahnQueue.shift();
			acyclic.add(id);
			for (const next of hardOut.get(id) || []) {
				const deg = (hardIn.get(next) || 0) - 1;
				hardIn.set(next, deg);
				if (deg === 0) kahnQueue.push(next);
			}
		}
		for (const id of [...candidates.keys()]) if (!acyclic.has(id)) {
			statuses[id] = {
				active: false,
				reason: "cycle"
			};
			candidates.delete(id);
		}
		const ordered = [];
		const layers = [
			"intercept",
			"preload",
			"service",
			"feature",
			"shell"
		];
		const hasHardPath = (startId, targetId, seen = new Set()) => {
			if (startId === targetId) return true;
			if (seen.has(startId)) return false;
			seen.add(startId);
			const mod = candidates.get(startId);
			if (!mod) return false;
			return mod.dependsOn.some((dep) => hasHardPath(dep, targetId, seen));
		};
		for (const layer of layers) {
			const layerMods = [...candidates.values()].filter((m) => m.layer === layer);
			if (!layerMods.length) continue;
			const layerSet = new Set(layerMods.map((m) => m.id));
			const hardDeps = new Map();
			const allDeps = new Map();
			const dependents = new Map();
			for (const m of layerMods) {
				hardDeps.set(m.id, new Set());
				allDeps.set(m.id, new Set());
				dependents.set(m.id, new Set());
			}
			for (const m of layerMods) for (const depId of m.dependsOn) if (layerSet.has(depId) && depId !== m.id) {
				hardDeps.get(m.id).add(depId);
				allDeps.get(m.id).add(depId);
				dependents.get(depId).add(m.id);
			}
			for (const m of layerMods) for (const afterId of m.after) {
				if (!layerSet.has(afterId) || afterId === m.id) continue;
				if (hasHardPath(afterId, m.id)) continue;
				allDeps.get(m.id).add(afterId);
				dependents.get(afterId).add(m.id);
			}
			const remaining = new Set(layerSet);
			while (remaining.size) {
				const ready = [...remaining].filter((id) => allDeps.get(id).size === 0).sort((a, b) => a.localeCompare(b));
				let pick;
				if (ready.length) pick = ready[0];
				else pick = [...remaining].filter((id) => hardDeps.get(id).size === 0).sort((a, b) => a.localeCompare(b))[0] || [...remaining].sort((a, b) => a.localeCompare(b))[0];
				remaining.delete(pick);
				const rec = candidates.get(pick);
				ordered.push(rec);
				statuses[pick] = { active: true };
				for (const next of dependents.get(pick) || []) {
					hardDeps.get(next)?.delete(pick);
					allDeps.get(next)?.delete(pick);
				}
			}
		}
		return {
			statuses,
			ordered
		};
	}
	function syncAllLiveStatuses(statuses) {
		for (const [id, st] of Object.entries(statuses)) {
			if (st.active) {
				const rec = recordsById.get(id);
				if (!rec || !rec.booted || rec.standalonePaused || rec.runtimeError) {
					emitStatusChange(id, { active: false });
					continue;
				}
			}
			emitStatusChange(id, st);
		}
	}
	function createScopedStorage(storagePrefix, isDisposed, wrapWatch = (fn) => fn(), guardClear = false, onClear) {
		return {
			get: (k, d) => store$1.get(`${storagePrefix}${k}`, d),
			set: (k, v) => {
				if (!isDisposed()) store$1.set(`${storagePrefix}${k}`, v);
			},
			del: (k) => {
				if (!isDisposed()) store$1.del(`${storagePrefix}${k}`);
			},
			watch: (k, cb) => {
				if (isDisposed()) return () => {};
				return wrapWatch(() => store$1.watch(`${storagePrefix}${k}`, (_fullKey, oldV, newV, remote) => {
					if (isDisposed()) return;
					cb(k, oldV, newV, remote);
				}));
			},
			clear: () => {
				if (guardClear && isDisposed()) return;
				onClear?.();
				for (const k of store$1.list()) if (k.startsWith(storagePrefix)) store$1.del(k);
			}
		};
	}
	function runCleanupsReverse(id, cleanups) {
		teardownStarters.get(cleanups)?.();
		drainCleanupsReverse(id, cleanups, (err) => {
			coreLog.error(`Module "${id}" failed during cleanup:`, err);
		});
	}
	function createContextForRecord(rec, cleanups, ac) {
		let disposed = false;
		let tearingDown = false;
		const isClosed = () => disposed || tearingDown;
		let localClearingDepth = 0;
		const noop = () => {};
		const activeRequests = new Set();
		const persistentHandles = new Set();
		let pagehideRegistered = false;
		const counters = {
			idSeq: 0,
			styleSeq: 0,
			modalSeq: 0
		};
		teardownStarters.set(cleanups, () => {
			tearingDown = true;
			try {
				ac.abort();
			} catch (e) {
				coreLog.error(`Module "${rec.id}" failed during abort:`, e);
			}
		});
		const rootScope = createContextScope({
			prefix: rec.id,
			signal: ac.signal,
			isClosed,
			cleanups,
			styleKind: "style",
			counters,
			onError: (e) => coreLog.error(`Module "${rec.id}" failed during cleanup:`, e)
		});
		const track = rootScope.track;
		const whenAlive = rootScope.whenAlive;
		track(() => {
			disposed = true;
			while (localClearingDepth > 0) {
				localClearingDepth--;
				try {
					CoreHooks.setSessionClearing(false);
				} catch {}
			}
			ac.abort();
			for (const req of [...activeRequests]) {
				try {
					req.cleanupAbort?.();
				} catch {}
				try {
					req.abort?.();
				} catch {}
				try {
					req.reject?.(new Error("Request aborted"));
				} catch {}
			}
			activeRequests.clear();
		});
		const storagePrefix = `ala_mod_${rec.id}_`;
		const allowedAccounts = new Set(rec.accounts);
		const assertAccountAllowed = (id) => {
			if (!allowedAccounts.has(id)) throw new Error(`Module "${rec.id}" cannot access account provider "${id}" without declaring it in accounts`);
		};
		let mountSeq = 0;
		const addMount = (spec, trackFn, signal) => {
			const resolvedId = spec.id ? rootScope.getId(spec.id) : `ala-${rec.id}-mount-${++mountSeq}`;
			const selector = `#${resolvedId}`;
			if (isClosed() || signal?.aborted) return {
				id: resolvedId,
				selector,
				el: () => null,
				unmount: noop,
				refresh: noop
			};
			let mountedEl = null;
			let elCleanup = null;
			let mountDisposed = false;
			let ownDisposer = null;
			let mountStyleDisposer = null;
			const runElCleanup = () => {
				const fn = elCleanup;
				elCleanup = null;
				if (fn) try {
					fn();
				} catch (e) {
					coreLog.error(`Module "${rec.id}" mount onMount cleanup failed:`, e);
				}
			};
			const invokeOnMount = (el) => {
				runElCleanup();
				if (!spec.onMount) return;
				try {
					const res = spec.onMount(el);
					if (typeof res === "function") {
						if (mountDisposed || isClosed() || signal?.aborted) try {
							res();
						} catch (e) {
							coreLog.error(`Module "${rec.id}" mount onMount cleanup failed:`, e);
						}
						else elCleanup = res;
					}
				} catch (e) {
					coreLog.error(`Module "${rec.id}" mount onMount failed:`, e);
				}
			};
			const ensureStyle = () => {
				if (spec.style !== void 0 && !mountStyleDisposer) {
					const styleCss = spec.style;
					mountStyleDisposer = addStyle(`${resolvedId}-style`, typeof styleCss === "function" ? () => styleCss(selector) : styleCss);
				}
			};
			const ensureOwnUi = () => {
				if (spec.ownUi && !ownDisposer) ownDisposer = Core.registerOwnUi(selector);
			};
			const tryMount = () => {
				if (mountDisposed || isClosed() || signal?.aborted) return;
				if (spec.match && !spec.match()) {
					if (mountedEl) {
						runElCleanup();
						mountedEl.remove();
						mountedEl = null;
					}
					return;
				}
				if (mountedEl?.isConnected) return;
				if (mountedEl) {
					runElCleanup();
					mountedEl = null;
				}
				const existing = document.getElementById(resolvedId);
				if (existing?.isConnected) {
					ensureStyle();
					ensureOwnUi();
					mountedEl = existing;
					invokeOnMount(existing);
					return;
				}
				const anchor = typeof spec.anchor === "string" ? document.querySelector(spec.anchor) : spec.anchor();
				if (!anchor) return;
				const pos = spec.position ?? "afterend";
				if ((pos === "beforebegin" || pos === "afterend") && !anchor.parentElement) return;
				const el = spec.create();
				if (!el) return;
				el.id = resolvedId;
				ensureStyle();
				anchor.insertAdjacentElement(pos, el);
				mountedEl = el;
				ensureOwnUi();
				invokeOnMount(el);
			};
			let unsubReady = noop;
			let unsubNav = noop;
			let unsubBody = noop;
			let disposeTracked = noop;
			const disposeMount = () => {
				if (mountDisposed) return;
				mountDisposed = true;
				signal?.removeEventListener("abort", disposeTracked);
				unsubReady();
				unsubNav();
				unsubBody();
				runElCleanup();
				ownDisposer?.();
				ownDisposer = null;
				mountStyleDisposer?.();
				mountStyleDisposer = null;
				mountedEl?.remove();
				mountedEl = null;
			};
			unsubReady = Core.ready(tryMount);
			unsubNav = Core.onNavigate(tryMount);
			unsubBody = Core.onBodyMutation(tryMount);
			if (isClosed() || signal?.aborted) {
				disposeMount();
				return {
					id: resolvedId,
					selector,
					el: () => null,
					unmount: noop,
					refresh: noop
				};
			}
			disposeTracked = trackFn(disposeMount);
			signal?.addEventListener("abort", disposeTracked, { once: true });
			return {
				id: resolvedId,
				selector,
				el: () => mountDisposed || isClosed() || signal?.aborted ? null : document.getElementById(resolvedId),
				unmount: disposeTracked,
				refresh: tryMount
			};
		};
		const makeHttpClient = (scopeSignal) => {
			const request = (url, opts = {}) => {
				const { signal: callerSignal, ...xhrOpts } = opts || {};
				if (isClosed() || ac.signal.aborted || scopeSignal?.aborted || callerSignal?.aborted) return Promise.reject(new Error("Request aborted"));
				const composed = scopeSignal ? composeAbortSignals(scopeSignal, callerSignal) : {
					signal: callerSignal,
					dispose: noop
				};
				const effectiveSignal = composed.signal;
				if (effectiveSignal?.aborted) {
					composed.dispose();
					return Promise.reject(new Error("Request aborted"));
				}
				return new Promise((resolve, reject) => {
					let handle;
					const entry = { reject };
					activeRequests.add(entry);
					const onAbort = () => {
						try {
							handle?.abort?.();
						} catch {}
						settle(() => reject(new Error("Request aborted")));
					};
					const settle = (fn) => {
						if (!activeRequests.has(entry)) return;
						activeRequests.delete(entry);
						effectiveSignal?.removeEventListener("abort", onAbort);
						composed.dispose();
						fn();
					};
					entry.cleanupAbort = () => {
						effectiveSignal?.removeEventListener("abort", onAbort);
						composed.dispose();
					};
					effectiveSignal?.addEventListener("abort", onAbort, { once: true });
					const g = globalThis;
					const xhr = Object.prototype.hasOwnProperty.call(g, "GM_xmlhttpRequest") && typeof g.GM_xmlhttpRequest === "function" ? g.GM_xmlhttpRequest : _GM_xmlhttpRequest;
					try {
						handle = xhr({
							method: "GET",
							timeout: 15e3,
							...xhrOpts,
							url,
							onload: (res) => settle(() => resolve(res)),
							onerror: () => settle(() => reject(new Error("Network error"))),
							ontimeout: () => settle(() => reject(new Error("Timeout"))),
							onabort: () => settle(() => reject(new Error("Request aborted")))
						});
					} catch (err) {
						settle(() => reject(err));
						return;
					}
					if (effectiveSignal?.aborted) {
						onAbort();
						return;
					}
					entry.abort = () => {
						try {
							handle?.abort?.();
						} catch {}
					};
				});
			};
			const text = async (url, opts) => {
				const r = await request(url, opts);
				if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
				return r.responseText || "";
			};
			const json = async (url, opts) => {
				const r = await request(url, opts);
				if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
				if (opts?.responseType === "json" && r.response !== void 0) return r.response;
				return JSON.parse(r.responseText || "");
			};
			const download = (url, name, opts = {}) => {
				const { signal: callerSignal, ...dlOpts } = opts || {};
				if (isClosed() || ac.signal.aborted || scopeSignal?.aborted || callerSignal?.aborted) return Promise.reject(new Error("Download aborted"));
				const composed = scopeSignal ? composeAbortSignals(scopeSignal, callerSignal) : {
					signal: callerSignal,
					dispose: noop
				};
				const effectiveSignal = composed.signal;
				if (effectiveSignal?.aborted) {
					composed.dispose();
					return Promise.reject(new Error("Download aborted"));
				}
				return new Promise((resolve, reject) => {
					const entry = { reject };
					activeRequests.add(entry);
					let settled = false;
					let handle = null;
					const onAbort = () => {
						settled = true;
						try {
							handle?.abort?.();
						} catch {}
						settle(() => reject(new Error("Download aborted")));
					};
					const settle = (fn) => {
						if (!activeRequests.has(entry)) return;
						activeRequests.delete(entry);
						effectiveSignal?.removeEventListener("abort", onAbort);
						composed.dispose();
						fn();
					};
					entry.cleanupAbort = () => {
						effectiveSignal?.removeEventListener("abort", onAbort);
						composed.dispose();
					};
					effectiveSignal?.addEventListener("abort", onAbort, { once: true });
					handle = downloadFile(url, name, {
						saveAs: dlOpts.saveAs,
						openTabOnError: () => !isClosed() && !ac.signal.aborted && !effectiveSignal?.aborted && dlOpts.openTabOnError !== false,
						onComplete: (outcome) => {
							settled = true;
							settle(() => resolve(outcome));
						},
						onAbort: () => {
							settled = true;
							settle(() => reject(new Error("Download aborted")));
						},
						onError: (err) => {
							settled = true;
							settle(() => reject(err instanceof Error ? err : new Error(String(err || "Download failed"))));
						}
					});
					if (!settled && effectiveSignal?.aborted) {
						onAbort();
						return;
					}
					if (!settled) entry.abort = () => {
						try {
							handle?.abort?.();
						} catch {}
					};
				});
			};
			return {
				request,
				text,
				json,
				download
			};
		};
		const rootHttp = makeHttpClient(ac.signal);
		const onRoute = (matchOrHandler, maybeHandler) => whenAlive(() => {
			const matcher = typeof maybeHandler === "function" ? matchOrHandler : null;
			const handler = maybeHandler ?? matchOrHandler;
			let routeCleanups = new Set();
			let routeAc = null;
			let routeSubDisposed = false;
			const teardownRoute = () => {
				routeAc?.abort();
				routeAc = null;
				runCleanupsReverse(rec.id, routeCleanups);
			};
			const evaluate = () => {
				if (routeSubDisposed || isClosed()) return;
				teardownRoute();
				let url;
				try {
					url = new URL(location.href);
				} catch {
					url = new URL("https://anilist.co/");
				}
				try {
					let matchArr = null;
					if (matcher instanceof RegExp) {
						matchArr = url.pathname.match(matcher);
						if (!matchArr) return;
					} else if (typeof matcher === "function") {
						if (!matcher(url)) return;
					}
					const localAc = new AbortController();
					routeAc = localAc;
					const localCleanups = new Set();
					routeCleanups = localCleanups;
					const routeScope = createContextScope({
						prefix: rec.id,
						signal: localAc.signal,
						isClosed: () => isClosed() || localAc.signal.aborted,
						cleanups: localCleanups,
						styleKind: "route-style",
						counters,
						onError: (e) => coreLog.error(`Module "${rec.id}" failed during cleanup:`, e)
					});
					let routeApiWrapper = null;
					const rc = {
						url,
						pathname: url.pathname,
						match: matchArr,
						signal: localAc.signal,
						getId: routeScope.getId,
						onCleanup: routeScope.onCleanup,
						ready: (cb) => routeScope.whenAlive(() => Core.ready(() => {
							if (!isClosed() && !localAc.signal.aborted) cb();
						})),
						onBodyMutation: (cb) => routeScope.whenAlive(() => Core.onBodyMutation((mutations) => {
							if (!isClosed() && !localAc.signal.aborted) cb(mutations);
						})),
						observe: routeScope.observe,
						listen: routeScope.listen,
						interval: routeScope.interval,
						timeout: routeScope.timeout,
						debounce: routeScope.debounce,
						raf: routeScope.raf,
						mount: (spec) => addMount(spec, routeScope.track, localAc.signal),
						addStyle: routeScope.addStyle,
						modal: routeScope.modal,
						confirm: routeScope.confirm,
						alert: routeScope.alert,
						waitForSelector: routeScope.waitForSelector,
						http: makeHttpClient(localAc.signal),
						get api() {
							if (!routeApiWrapper) routeApiWrapper = scopeAniListClient(getCoreApi, localAc.signal, () => isClosed() || localAc.signal.aborted);
							return routeApiWrapper;
						}
					};
					const res = handler(rc);
					if (typeof res === "function") rc.onCleanup(res);
					else if (res && typeof res.then === "function") Promise.resolve(res).then((maybeCleanup) => {
						if (typeof maybeCleanup === "function") rc.onCleanup(maybeCleanup);
					}, (err) => {
						if (!localAc.signal.aborted) {
							coreLog.error(`Module "${rec.id}" route handler failed:`, err);
							if (routeAc === localAc) teardownRoute();
						}
					});
				} catch (err) {
					coreLog.error(`Module "${rec.id}" route handler failed:`, err);
					teardownRoute();
				}
			};
			evaluate();
			const unsubNav = routeSubDisposed || isClosed() ? noop : Core.onNavigate(evaluate);
			const disposeRouteWatcher = () => {
				if (routeSubDisposed) return;
				routeSubDisposed = true;
				unsubNav();
				teardownRoute();
			};
			return disposeRouteWatcher;
		});
		const contextFetchLeases = new Set();
		const trackedHooks = {
			setSessionClearing: (active) => {
				if (disposed) return;
				if (tearingDown && active) return;
				if (active) {
					localClearingDepth++;
					CoreHooks.setSessionClearing(true);
				} else if (localClearingDepth > 0) {
					localClearingDepth--;
					CoreHooks.setSessionClearing(false);
				}
			},
			isSessionClearing: () => CoreHooks.isSessionClearing(),
			getAuthHeader: () => CoreHooks.getAuthHeader(),
			setAuthHeader: (header) => {
				if (!isClosed()) CoreHooks.setAuthHeader(header);
			},
			clearAuth: () => {
				if (!isClosed()) CoreHooks.clearAuth();
			},
			registerCacheBridge: (bridge) => whenAlive(() => CoreHooks.registerCacheBridge(bridge)),
			getCacheBridge: () => CoreHooks.getCacheBridge(),
			markFetchOwner: (active) => {
				if (!active) {
					if (!disposed) {
						for (const release of [...contextFetchLeases]) release();
						contextFetchLeases.clear();
					}
					return noop;
				}
				if (isClosed()) return noop;
				let leaseRef = noop;
				const rawRelease = CoreHooks.markFetchOwner(true);
				leaseRef = track(() => {
					contextFetchLeases.delete(leaseRef);
					rawRelease();
				});
				contextFetchLeases.add(leaseRef);
				return leaseRef;
			},
			hasGqlFetchSubscribers: () => CoreHooks.hasGqlFetchSubscribers(),
			emitGqlFetch: (event) => {
				if (!isClosed()) CoreHooks.emitGqlFetch(event);
			},
			onGqlFetch: (cb) => whenAlive(() => CoreHooks.onGqlFetch(cb)),
			blockRpc: (fn) => whenAlive(() => CoreHooks.blockRpc(fn)),
			isRpcBlocked: (q, v) => CoreHooks.isRpcBlocked(q, v),
			setPrefetchPaused: (paused) => whenAlive(() => CoreHooks.setPrefetchPaused(paused)),
			isPrefetchSuppressed: () => CoreHooks.isPrefetchSuppressed()
		};
		const debugDef = rec.debug;
		const hasModuleDebug = Boolean(debugDef && debugDef.debug !== false);
		const debugLabel = debugDef?.label || rec.title || rec.id;
		const debugTitle = hasModuleDebug ? debugDef.title || rec.title : rec.title;
		const debugHelp = hasModuleDebug ? debugDef.help ?? rec.help : rec.help;
		const hasDebuggableChannels = getDebuggableChannels(debugDef).length > 0;
		const rootLogger = createLogger(`[${debugLabel}]`, hasModuleDebug ? () => !disposed && isDebugEnabled(rec.id, hasDebuggableChannels ? "general" : void 0) : () => false, {
			label: debugLabel,
			title: debugTitle,
			help: debugHelp,
			canDebug: hasModuleDebug
		});
		const channelLoggers = new Map();
		const getChannelLogger = (chId) => {
			const cached = channelLoggers.get(chId);
			if (cached) return cached;
			const chDef = debugDef?.channels && Object.prototype.hasOwnProperty.call(debugDef.channels, chId) ? debugDef.channels[chId] : void 0;
			if (!chDef) {
				const fallback = Object.freeze({
					id: chId,
					...createLogger(`[${debugLabel} (${chId})]`, () => false, {
						label: chId,
						title: chId,
						canDebug: false
					})
				});
				channelLoggers.set(chId, fallback);
				return fallback;
			}
			const canDebug = hasModuleDebug && chDef.debug === true;
			const chLogger = Object.freeze({
				id: chId,
				...createLogger(`[${debugLabel} (${chDef.label})]`, canDebug ? () => !disposed && isDebugEnabled(rec.id, chId) : () => false, {
					label: chDef.label,
					title: chDef.title || chDef.label,
					help: chDef.help,
					canDebug
				})
			});
			channelLoggers.set(chId, chLogger);
			return chLogger;
		};
		const ctxLog = Object.freeze({
			...rootLogger,
			channel: (chId) => getChannelLogger(String(chId))
		});
		let sessionWrapper = null;
		let apiWrapper = null;
		const getSessionWrapper = () => {
			if (!sessionWrapper) sessionWrapper = {
				peek: (opts) => getCoreSession().peek(isClosed() && opts?.reconcile ? {
					...opts,
					reconcile: false
				} : opts),
				get userId() {
					return getCoreSession().userId;
				},
				get username() {
					return getCoreSession().username;
				},
				get scoreFormat() {
					return getCoreSession().scoreFormat;
				},
				hasAuth: (opts) => getCoreSession().hasAuth(isClosed() ? {
					...opts,
					reconcile: false
				} : opts),
				clear: () => {
					if (!isClosed()) getCoreSession().clear();
				},
				syncFromPage: () => {
					if (!isClosed()) getCoreSession().syncFromPage?.();
				},
				recordHint: (hint) => {
					if (!isClosed()) getCoreSession().recordHint(hint);
				}
			};
			return sessionWrapper;
		};
		const getApiWrapper = () => {
			if (!apiWrapper) apiWrapper = scopeAniListClient(getCoreApi, ac.signal, isClosed);
			return apiWrapper;
		};
		const eventOwner = Symbol(`events:${rec.id}`);
		let retainedTracked = false;
		const cancelAllPersistent = () => {
			for (const h of persistentHandles) h.cancel();
		};
		return {
			id: rec.id,
			title: rec.title,
			help: rec.help,
			signal: ac.signal,
			getId: rootScope.getId,
			get: (key) => Settings.get(key),
			set: (key, val) => {
				if (!isClosed()) Settings.set(key, val);
			},
			storage: createScopedStorage(storagePrefix, () => disposed, whenAlive, false, cancelAllPersistent),
			persistent: (key, prune) => {
				const p = persistent(`${storagePrefix}${key}`, prune);
				const handle = {
					cancel: p.cancel,
					flush: p.flush
				};
				if (!isClosed()) {
					persistentHandles.add(handle);
					if (!pagehideRegistered && typeof window !== "undefined") {
						pagehideRegistered = true;
						rootScope.listen(window, "pagehide", () => {
							if (isClosed()) return;
							for (const h of persistentHandles) h.flush();
						});
					}
					track(() => {
						persistentHandles.delete(handle);
						p.cancel();
					});
				}
				return {
					get data() {
						return p.data;
					},
					set data(val) {
						p.data = val;
					},
					save: () => {
						if (!isClosed()) p.save();
					},
					cancel: () => p.cancel(),
					flush: () => {
						if (!isClosed()) p.flush();
					}
				};
			},
			ready: (cb) => whenAlive(() => Core.ready(cb)),
			onNav: (cb) => whenAlive(() => Core.onNavigate(cb)),
			onBodyMutation: (cb) => whenAlive(() => Core.onBodyMutation(cb)),
			onRoute,
			mount: (spec) => addMount(spec, rootScope.track, ac.signal),
			addStyle: rootScope.addStyle,
			modal: rootScope.modal,
			confirm: rootScope.confirm,
			alert: rootScope.alert,
			listen: rootScope.listen,
			interval: rootScope.interval,
			timeout: rootScope.timeout,
			debounce: rootScope.debounce,
			raf: rootScope.raf,
			observe: rootScope.observe,
			trackEl: (el) => {
				track(() => el.remove());
				return el;
			},
			waitForSelector: rootScope.waitForSelector,
			silently: (fn) => {
				if (!isClosed()) Core.silently(fn);
			},
			ownUi: (selector) => whenAlive(() => Core.registerOwnUi(selector)),
			onCleanup: rootScope.onCleanup,
			http: rootHttp,
			get api() {
				return getApiWrapper();
			},
			get session() {
				return getSessionWrapper();
			},
			accounts: {
				get: (id) => {
					assertAccountAllowed(id);
					return getAccountProvider(id);
				},
				isConnected: (id) => {
					assertAccountAllowed(id);
					return !!getAccountProvider(id)?.isConnected();
				},
				connect: (id) => {
					assertAccountAllowed(id);
					if (!isClosed()) getAccountProvider(id)?.connect();
				},
				disconnect: (id) => {
					assertAccountAllowed(id);
					if (!isClosed()) getAccountProvider(id)?.disconnect();
				},
				clearSecrets: (providerId) => {
					if (providerId !== void 0) {
						assertAccountAllowed(providerId);
						if (!isClosed()) clearAccountSecrets(providerId);
						return;
					}
					if (isClosed()) return;
					for (const id of allowedAccounts) clearAccountSecrets(id);
				},
				watch: (id, cb) => {
					assertAccountAllowed(id);
					return whenAlive(() => watchAccountProvider(id, cb));
				}
			},
			toast: {
				show: (msg, opts) => {
					if (!isClosed()) showToast(msg, opts);
				},
				success: (msg, opts) => {
					if (!isClosed()) toastSuccess(msg, opts);
				},
				error: (msg, opts) => {
					if (!isClosed()) toastError(msg, opts);
				}
			},
			menuCommand: (label, onClick) => whenAlive(() => registerMenuCommand(label, onClick)),
			services: {
				provide: (localName, impl) => whenAlive(() => ServiceRegistry.provide(`${rec.id}:${String(localName)}`, impl)),
				get: (fullName) => ServiceRegistry.get(fullName),
				onAvailable: (fullName, cb) => whenAlive(() => ServiceRegistry.onAvailable(fullName, cb))
			},
			events: {
				emit: (event, ...args) => {
					if (!isClosed()) EventBus.emit(event, ...args);
				},
				emitRetained: (event, ...args) => {
					if (isClosed()) return;
					if (!retainedTracked) {
						retainedTracked = true;
						track(() => EventBus.clearRetainedByOwner(eventOwner));
					}
					EventBus.emitRetainedOwned(eventOwner, event, ...args);
				},
				on: (event, cb) => whenAlive(() => EventBus.on(event, cb)),
				onRetained: (event, cb) => whenAlive(() => EventBus.onRetained(event, cb))
			},
			hooks: trackedHooks,
			log: ctxLog,
			setStandalonePaused: (paused) => {
				if (isClosed()) return;
				const next = !!paused;
				rec.standalonePaused = next;
				if (next) cascadeDispose([rec.id], { preserveStandaloneSeeds: true });
				syncAllLiveStatuses(resolveAllStates().statuses);
			}
		};
	}
	function disposeRecord(rec, resetStandalone = true) {
		rec.bootSeq++;
		const hadCleanups = rec.cleanups.size > 0;
		if (rec.booted || hadCleanups) runCleanupsReverse(rec.id, rec.cleanups);
		rec.abortController = null;
		rec.booted = false;
		rec.runtimeError = void 0;
		if (resetStandalone) rec.standalonePaused = false;
	}
	function getFailedDeps(rec) {
		return rec.dependsOn.filter((depId) => {
			const dep = recordsById.get(depId);
			return !dep || !!dep.runtimeError || dep.standalonePaused || !dep.booted;
		});
	}
	function cascadeDispose(seedIds, opts = {}) {
		const seedSet = new Set(seedIds);
		const toStop = new Set();
		for (const rec of records) if (rec.booted && seedSet.has(rec.id)) toStop.add(rec.id);
		let added = true;
		while (added) {
			added = false;
			for (const rec of records) if (rec.booted && !toStop.has(rec.id) && rec.dependsOn.some((d) => toStop.has(d))) {
				toStop.add(rec.id);
				added = true;
			}
		}
		if (toStop.size === 0) return [];
		const stopOrdered = [...toStop].sort((a, b) => {
			const ra = recordsById.get(a);
			const rb = recordsById.get(b);
			if (LAYER_ORDER[ra.layer] !== LAYER_ORDER[rb.layer]) return LAYER_ORDER[rb.layer] - LAYER_ORDER[ra.layer];
			return rb.id.localeCompare(ra.id);
		});
		const finalStopOrder = [];
		const stoppedSet = new Set();
		const visitStop = (id, stack = new Set()) => {
			if (stoppedSet.has(id) || stack.has(id)) return;
			stack.add(id);
			for (const candidate of stopOrdered) {
				const cr = recordsById.get(candidate);
				if (cr && cr.dependsOn.includes(id)) visitStop(candidate, stack);
			}
			stack.delete(id);
			stoppedSet.add(id);
			finalStopOrder.push(id);
		};
		for (const id of stopOrdered) visitStop(id);
		for (const id of finalStopOrder) {
			const rec = recordsById.get(id);
			if (!rec) continue;
			disposeRecord(rec, !(opts.preserveStandaloneSeeds && seedSet.has(id)));
		}
		return finalStopOrder;
	}
	function bootRecord(rec) {
		if (rec.booted) return Promise.resolve();
		const seq = ++rec.bootSeq;
		rec.runtimeError = void 0;
		const ac = new AbortController();
		const cleanups = new Set();
		rec.cleanups = cleanups;
		rec.abortController = ac;
		rec.booted = true;
		const ctx = createContextForRecord(rec, cleanups, ac);
		coreLog.debug(`Initializing module "${rec.id}" (layer=${rec.layer}, early=${rec.early})`);
		const handleFailure = (err) => {
			if (rec.bootSeq !== seq) return;
			const msg = err instanceof Error ? err.message : String(err);
			coreLog.error(`Module "${rec.id}" failed during setup:`, err);
			cascadeDispose([rec.id]);
			rec.runtimeError = msg;
			syncAllLiveStatuses(resolveAllStates().statuses);
		};
		try {
			const res = rec.setup(ctx);
			if (res && typeof res.then === "function") return Promise.resolve(res).then(() => {
				if (rec.bootSeq !== seq) {
					runCleanupsReverse(rec.id, cleanups);
					return;
				}
				if (rec.standalonePaused) {
					rec.booted = false;
					return;
				}
				if (!rec.runtimeError && rec.booted) emitStatusChange(rec.id, { active: true });
			}, (err) => {
				handleFailure(err);
			});
			if (rec.standalonePaused) {
				rec.booted = false;
				return Promise.resolve();
			}
			if (!rec.runtimeError && rec.booted) emitStatusChange(rec.id, { active: true });
			return Promise.resolve();
		} catch (err) {
			handleFailure(err);
			return Promise.resolve();
		}
	}
	function registerRecord(rec) {
		records.push(rec);
		recordsById.set(rec.id, rec);
		modules.push({
			name: rec.id,
			setting: rec.setting,
			init: rec.legacyInit ?? (() => bootRecord(rec)),
			hosts: rec.hosts,
			early: rec.early,
			layer: rec.layer,
			dependsOn: rec.dependsOn,
			after: rec.after
		});
	}
	function defineModule(meta) {
		if (!ID_RE.test(meta.id) || RESERVED_MODULE_IDS.has(meta.id)) {
			coreLog.error(`Invalid or reserved module ID "${meta.id}". Must match ${ID_RE} and not be reserved.`);
			invalidIds.set(meta.id, {
				active: false,
				reason: "invalid-id"
			});
			emitStatusChange(meta.id, {
				active: false,
				reason: "invalid-id"
			});
			return;
		}
		const existing = recordsById.get(meta.id);
		if (existing) {
			coreLog.error(`Duplicate module ID "${meta.id}" ignored.`);
			existing.idCollision = true;
			emitStatusChange(meta.id, {
				active: false,
				reason: "id-collision"
			});
			return;
		}
		const layer = meta.layer ?? "feature";
		const hosts = meta.hosts?.length ? meta.hosts.slice() : ["anilist.co"];
		const dependsOn = (meta.dependsOn || []).slice();
		const after = (meta.after || []).slice();
		const accounts = meta.accounts ? [...meta.accounts] : [];
		Settings.register({
			id: meta.id,
			key: meta.key,
			section: meta.section,
			title: meta.title,
			help: meta.help,
			type: "toggle",
			def: false,
			legacy: meta.legacy,
			options: meta.options,
			hosts,
			layer,
			requiresReload: meta.requiresReload,
			dependsOn,
			after,
			accounts: accounts.length ? accounts : void 0,
			debug: meta.debug,
			standalone: meta.standalone
		});
		registerRecord({
			id: meta.id,
			title: meta.title,
			help: meta.help,
			setting: meta.key,
			hosts,
			layer,
			early: layer === "intercept" || layer === "preload",
			requiresReload: !!meta.requiresReload,
			dependsOn,
			after,
			accounts,
			debug: meta.debug,
			standalone: meta.standalone,
			migrate: meta.migrate,
			setup: meta.setup,
			invalidId: false,
			idCollision: false,
			standalonePaused: false,
			booted: false,
			bootSeq: 0,
			cleanups: new Set(),
			abortController: null
		});
	}
	function registerShellModule(name, init, hosts = ["anilist.co"]) {
		if (!ID_RE.test(name) || RESERVED_MODULE_IDS.has(name)) {
			coreLog.error(`Invalid or reserved shell module ID "${name}". Must match ${ID_RE} and not be reserved.`);
			invalidIds.set(name, {
				active: false,
				reason: "invalid-id"
			});
			emitStatusChange(name, {
				active: false,
				reason: "invalid-id"
			});
			return;
		}
		const existing = recordsById.get(name);
		if (existing) {
			coreLog.error(`Duplicate module ID "${name}" ignored.`);
			existing.idCollision = true;
			emitStatusChange(name, {
				active: false,
				reason: "id-collision"
			});
			return;
		}
		const runShellInit = (ctx) => {
			const res = init();
			if (typeof res === "function") {
				ctx?.onCleanup(res);
				return;
			}
			return res;
		};
		registerRecord({
			id: name,
			title: name,
			help: "",
			setting: null,
			hosts: hosts.slice(),
			layer: "shell",
			early: false,
			requiresReload: true,
			dependsOn: [],
			after: [],
			accounts: [],
			setup: (ctx) => runShellInit(ctx),
			legacyInit: () => runShellInit(),
			invalidId: false,
			idCollision: false,
			standalonePaused: false,
			booted: false,
			bootSeq: 0,
			cleanups: new Set(),
			abortController: null
		});
	}
	function runMigrations() {
		Settings.migrate();
		for (const layer of [
			"intercept",
			"preload",
			"service",
			"feature",
			"shell"
		]) {
			const layerRecs = records.filter((r) => !r.invalidId && !r.idCollision && r.layer === layer).sort((a, b) => a.id.localeCompare(b.id));
			for (const rec of layerRecs) {
				if (!rec.migrate) continue;
				let migrateDone = false;
				const migrationCtx = {
					id: rec.id,
					storage: createScopedStorage(`ala_mod_${rec.id}_`, () => migrateDone, void 0, true),
					settings: {
						has: (key) => Settings.has(key),
						get: (key) => Settings.get(key),
						set: (key, val) => {
							if (!migrateDone) Settings.set(key, val);
						}
					},
					legacy: {
						get: (key, def) => store$1.get(key, def),
						set: (key, val) => {
							if (!migrateDone) store$1.set(key, val);
						},
						del: (key) => {
							if (!migrateDone) store$1.del(key);
						},
						getLocal: (key) => {
							try {
								return localStorage.getItem(key);
							} catch {
								return null;
							}
						},
						delLocal: (key) => {
							if (migrateDone) return;
							try {
								localStorage.removeItem(key);
							} catch {}
						}
					}
				};
				try {
					rec.migrate(migrationCtx);
				} catch (e) {
					coreLog.error(`Module "${rec.id}" failed during migrate:`, e);
				} finally {
					migrateDone = true;
				}
			}
		}
	}
	function startModules(early) {
		if (!early) deferredStarted = true;
		const graph = resolveAllStates();
		syncAllLiveStatuses(graph.statuses);
		for (const rec of graph.ordered) {
			if (rec.early !== early) continue;
			const failedDeps = getFailedDeps(rec);
			if (failedDeps.length > 0) {
				emitStatusChange(rec.id, {
					active: false,
					reason: "dep-unavailable",
					missingDeps: failedDeps
				});
				continue;
			}
			bootRecord(rec);
		}
	}
	function createModuleHost() {
		return {
			get api() {
				return configuredServices?.api;
			},
			reload(ids) {
				const targetSet = new Set(ids);
				const graph = resolveAllStates();
				const nextActiveIds = new Set(graph.ordered.map((r) => r.id));
				cascadeDispose(records.filter((rec) => rec.booted && (targetSet.has(rec.id) || !nextActiveIds.has(rec.id))).map((rec) => rec.id));
				for (const id of targetSet) {
					const rec = recordsById.get(id);
					if (rec && !rec.booted) {
						rec.runtimeError = void 0;
						if (rec.standalone) {
							let probeRes = false;
							try {
								probeRes = rec.standalone.probe();
							} catch {
								probeRes = false;
							}
							if (probeRes && typeof probeRes.then === "function") {
								rec.standalonePaused = false;
								Promise.resolve(probeRes).then((found) => {
									if (!found) return;
									rec.standalonePaused = true;
									cascadeDispose([rec.id], { preserveStandaloneSeeds: true });
									syncAllLiveStatuses(resolveAllStates().statuses);
								}, () => {});
							} else rec.standalonePaused = !!probeRes;
						} else rec.standalonePaused = false;
					}
				}
				const freshGraph = resolveAllStates();
				syncAllLiveStatuses(freshGraph.statuses);
				for (const rec of freshGraph.ordered) {
					if (rec.booted) continue;
					if (!rec.early && !deferredStarted && !document.body) continue;
					const failedDeps = getFailedDeps(rec);
					if (failedDeps.length > 0) {
						emitStatusChange(rec.id, {
							active: false,
							reason: "dep-unavailable",
							missingDeps: failedDeps
						});
						continue;
					}
					bootRecord(rec);
				}
			},
			getStatus(id) {
				const live = liveStatuses.get(id);
				if (live) return live;
				const st = resolveAllStates().statuses[id];
				if (!st) return {
					active: false,
					reason: "disabled"
				};
				if (st.active) {
					const rec = recordsById.get(id);
					if (!rec || !rec.booted || rec.standalonePaused || rec.runtimeError) return { active: false };
				}
				return st;
			},
			resolveStagedStates(stagedEnabled) {
				return resolveAllStates(stagedEnabled).statuses;
			},
			onStatusChange(cb) {
				statusListeners.add(cb);
				return () => {
					statusListeners.delete(cb);
				};
			},
			async probeStandalone(id) {
				const rec = recordsById.get(id);
				if (!rec?.standalone) return false;
				let found = false;
				try {
					found = !!await rec.standalone.probe();
				} catch {
					found = false;
				}
				rec.standalonePaused = found;
				if (found) cascadeDispose([rec.id], { preserveStandaloneSeeds: true });
				syncAllLiveStatuses(resolveAllStates().statuses);
				return found;
			}
		};
	}
	defineModule({
		id: "behindDots",
		key: "behindDotsEnabled",
		section: "AniList Enhancements",
		layer: "feature",
		requiresReload: false,
		legacy: ["behindDotsEnabled", "airingProgressIndicatorEnabled"],
		title: "Airing Progress Indicator",
		help: "Show an orange indicator when your watched episode count is behind the number of aired episodes.",
		debug: {
			debug: false,
			label: "Airing Dots"
		},
		migrate(m) {
			m.legacy.del("daiya-anilist-airing-cache-v5");
		},
		setup(ctx) {
			const CLASS = "daiya-behind-dot";
			const ORANGE = "rgb(255, 152, 0)";
			const NO_AIRING_TTL = 216e5;
			const AIRING_GRACE = 3e4;
			const ERROR_RETRY = 3e5;
			const PRUNE_AGE = 2592e6;
			const BATCH = 25;
			const CONCURRENCY = 4;
			const OPTIMISTIC_TTL = 2500;
			const QUERY = "query ($ids: [Int]) { Page(page: 1, perPage: 25) { media(id_in: $ids, type: ANIME) { id status nextAiringEpisode { episode airingAt timeUntilAiring } } } }";
			ctx.addStyle(`
      .${CLASS}{background:${ORANGE}!important;background-color:${ORANGE}!important;box-shadow:0 0 5px rgba(255,152,0,.85)!important;opacity:1!important}
      .${CLASS}::before,.${CLASS}::after{background:${ORANGE}!important;background-color:${ORANGE}!important}`);
			const cacheStore = ctx.persistent("daiya-anilist-airing-cache-v5", (d) => {
				for (const id of Object.keys(d)) if (!(Date.now() - Number(d[id]?.updated) < PRUNE_AGE)) delete d[id];
			});
			const cache = cacheStore.data;
			const optimistic = new Map();
			let disposed = false;
			const ANIMELIST_RE = /^\/user\/[^/]+\/animelist\/?$/i;
			const onListPage = () => ANIMELIST_RE.test(location.pathname);
			const idOf = (entry) => entry.querySelector("a[href*=\"/anime/\"]")?.getAttribute("href")?.match(/\/anime\/(\d+)(?:[/?#]|$)/i)?.[1] || null;
			const needsFetch = (id) => {
				const d = cache[id];
				return !d || !Number.isFinite(d.nextCheck) || Date.now() >= d.nextCheck;
			};
			const sectionIsWatching = (wrap) => clean(wrap?.querySelector(".section-name")?.textContent) === "Watching";
			function watchingEntries() {
				const out = [];
				for (const wrap of document.querySelectorAll(".list-wrap")) if (sectionIsWatching(wrap)) out.push(...Array.from(wrap.querySelectorAll(".list-entries .entry")));
				return out;
			}
			function progressOf(entry) {
				const m = entry.querySelector(".progress")?.textContent?.match(/^\s*(\d+)/) || entry.textContent?.match(/(?:^|\s)(\d+)\s*\/\s*(?:\d+|\?)(?:\s|$)/);
				return m ? Number(m[1]) : null;
			}
			function releasingDot(entry) {
				const fast = entry.querySelector(".release-status.RELEASING");
				if (fast) return fast;
				for (const el of entry.querySelectorAll(".release-status, [class*='release-status']")) {
					if (/\bRELEASING\b/i.test(typeof el.className === "string" ? el.className : "")) return el;
					if (/^releasing$/i.test((el.getAttribute("aria-label") || el.getAttribute("title") || "").trim())) return el;
				}
				return null;
			}
			function updateEntry(entry) {
				if (!entry || !entry.isConnected) return null;
				const dot = releasingDot(entry);
				if (!dot || !sectionIsWatching(entry.closest(".list-wrap"))) return null;
				const id = idOf(entry);
				if (!id) return null;
				const watched = progressOf(entry);
				if (!Number.isFinite(watched)) {
					dot.classList.remove(CLASS);
					return id;
				}
				const opt = optimistic.get(id);
				if (opt) {
					if (Date.now() >= opt.expiresAt || watched !== null && watched >= opt.target) optimistic.delete(id);
					else {
						dot.classList.remove(CLASS);
						return id;
					}
				}
				const data = cache[id];
				const behind = !!data && Number.isFinite(data.aired) && watched !== null && watched < data.aired;
				if (dot.classList.contains(CLASS) !== behind) dot.classList.toggle(CLASS, behind);
				return id;
			}
			function makeEntry(media) {
				const next = media.nextAiringEpisode;
				const now = Date.now();
				const base = {
					status: media.status || null,
					updated: now
				};
				if (!next || !Number.isFinite(Number(next.episode))) return {
					...base,
					aired: null,
					nextEpisode: null,
					nextCheck: now + NO_AIRING_TTL
				};
				const timeUntil = Number(next.timeUntilAiring);
				const airingAt = Number(next.airingAt);
				const nextCheck = Number.isFinite(timeUntil) ? now + Math.max(0, timeUntil) * 1e3 + AIRING_GRACE : Number.isFinite(airingAt) ? airingAt * 1e3 + AIRING_GRACE : now + NO_AIRING_TTL;
				return {
					...base,
					aired: Math.max(0, Math.floor(Number(next.episode)) - 1),
					nextEpisode: Number(next.episode),
					nextCheck
				};
			}
			const isIncrease = (el) => {
				for (let n = el, i = 0; i < 4 && n; i++, n = n.parentElement) {
					const label = `${n.getAttribute?.("aria-label") || ""} ${n.getAttribute?.("title") || ""}`.trim().toLowerCase();
					if (/increase|increment|add episode|add chapter|next episode|next chapter/.test(label)) return true;
					const text = (n.textContent || "").trim();
					if (text === "+" || text === "+1") return true;
				}
				return false;
			};
			ctx.onRoute(ANIMELIST_RE, (rc) => {
				if (disposed) return;
				let routeActive = true;
				const isRouteAlive = () => !disposed && routeActive && !rc.signal.aborted;
				const pending = new Set();
				const active = new Set();
				const timers = new Map();
				let running = 0;
				const dirty = new Set();
				let fullScan = false;
				let raf = 0;
				function scanAll() {
					if (!isRouteAlive() || !onListPage()) return;
					const stale = new Set();
					for (const entry of watchingEntries()) {
						const id = updateEntry(entry);
						if (id && needsFetch(id)) stale.add(id);
					}
					queueIDs(stale);
				}
				function repaint(ids) {
					if (!isRouteAlive() || !onListPage()) return;
					for (const entry of watchingEntries()) {
						const id = idOf(entry);
						if (id && ids.has(id)) updateEntry(entry);
					}
				}
				function scheduleRefresh(id, at) {
					const existing = timers.get(id);
					if (existing) existing();
					timers.delete(id);
					if (!isRouteAlive() || !Number.isFinite(at)) return;
					const cancel = rc.timeout(() => {
						timers.delete(id);
						if (!isRouteAlive()) return;
						queueIDs([id]);
						repaint(new Set([id]));
					}, Math.min(Math.max(0, at - Date.now()), 2147483647));
					timers.set(id, cancel);
				}
				async function updateBatch(ids) {
					if (!isRouteAlive()) return;
					const returned = new Set();
					try {
						const data = await rc.api.query(QUERY, { ids: ids.map(Number) });
						if (!isRouteAlive()) return;
						for (const m of data?.Page?.media || []) {
							const id = String(m.id);
							returned.add(id);
							cache[id] = makeEntry(m);
							scheduleRefresh(id, cache[id].nextCheck);
						}
					} catch (err) {
						if (!isRouteAlive() || isAbortError(err)) return;
					}
					if (!isRouteAlive()) return;
					const retryAt = Date.now() + ERROR_RETRY;
					for (const id of ids) {
						if (returned.has(id)) continue;
						const ex = cache[id];
						if (ex && Number.isFinite(ex.aired)) ex.nextCheck = retryAt;
						else cache[id] = {
							aired: null,
							nextEpisode: null,
							status: null,
							nextCheck: retryAt,
							updated: Date.now()
						};
						scheduleRefresh(id, retryAt);
					}
					cacheStore.save();
					if (returned.size) repaint(returned);
				}
				function queueIDs(ids) {
					if (!isRouteAlive()) return;
					for (const raw of ids) {
						const id = String(raw);
						if (!active.has(id)) pending.add(id);
					}
					while (running < CONCURRENCY && pending.size) {
						if (!isRouteAlive()) break;
						const batch = [];
						for (const id of pending) {
							pending.delete(id);
							active.add(id);
							batch.push(id);
							if (batch.length >= BATCH) break;
						}
						running++;
						updateBatch(batch).catch((e) => {
							if (isRouteAlive() && !isAbortError(e)) ctx.log.error("airing batch", e);
						}).finally(() => {
							batch.forEach((id) => active.delete(id));
							running--;
							if (isRouteAlive()) queueIDs([]);
						});
					}
				}
				function flush() {
					raf = 0;
					if (!isRouteAlive() || !onListPage()) {
						dirty.clear();
						fullScan = false;
						return;
					}
					if (fullScan) {
						fullScan = false;
						dirty.clear();
						scanAll();
						return;
					}
					const stale = new Set();
					for (const entry of dirty) {
						const id = updateEntry(entry);
						if (id && needsFetch(id)) stale.add(id);
					}
					dirty.clear();
					queueIDs(stale);
				}
				const mark = () => {
					if (!isRouteAlive()) return;
					if (!raf) raf = requestAnimationFrame(flush);
				};
				const refresh = rc.debounce(scanAll, 100);
				rc.onBodyMutation((muts) => {
					if (!isRouteAlive()) return;
					for (const m of muts) {
						const own = (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest?.(".entry");
						if (own) {
							dirty.add(own);
							mark();
						}
						for (const n of Array.from(m.addedNodes)) {
							if (n.nodeType !== 1) continue;
							const el = n;
							if (el.matches(".entry")) dirty.add(el);
							else {
								el.querySelectorAll(".entry").forEach((e) => dirty.add(e));
								if (el.matches(".list-wrap, .section-name") || el.querySelector(".section-name")) fullScan = true;
							}
							mark();
						}
					}
				});
				rc.listen(document, "pointerdown", (e) => {
					if (!(e.target instanceof Element) || !isIncrease(e.target)) return;
					const entry = e.target.closest(".entry");
					const dot = entry && releasingDot(entry);
					if (!dot || !dot.classList.contains(CLASS)) return;
					const id = idOf(entry);
					const data = id && cache[id];
					const watched = progressOf(entry);
					if (data && Number.isFinite(data.aired) && Number.isFinite(watched) && watched !== null && watched + 1 >= data.aired) {
						optimistic.set(id, {
							target: watched + 1,
							expiresAt: Date.now() + OPTIMISTIC_TTL
						});
						dot.classList.remove(CLASS);
					}
				}, true);
				for (const type of [
					"click",
					"input",
					"change"
				]) rc.listen(document, type, (e) => {
					if (e.target instanceof Element && e.target.closest(".entry")) refresh();
				}, true);
				rc.listen(window, "focus", refresh);
				rc.listen(document, "visibilitychange", () => {
					if (!document.hidden) refresh();
				});
				rc.interval(scanAll, 6e4);
				const startList = () => {
					if (!isRouteAlive()) return;
					scanAll();
					const visibleIds = new Set();
					for (const el of watchingEntries()) {
						const id = idOf(el);
						if (id) visibleIds.add(id);
					}
					for (const id of visibleIds) {
						const entry = cache[id];
						if (entry && Number.isFinite(entry.nextCheck) && Date.now() < entry.nextCheck) scheduleRefresh(id, entry.nextCheck);
					}
					rc.timeout(scanAll, 500);
					rc.timeout(scanAll, 1500);
				};
				rc.ready(startList);
				rc.onCleanup(() => {
					routeActive = false;
					refresh.cancel();
					if (raf) cancelAnimationFrame(raf);
					raf = 0;
					for (const cancel of timers.values()) cancel();
					timers.clear();
					pending.clear();
					dirty.clear();
					fullScan = false;
				});
			});
			ctx.onCleanup(() => {
				disposed = true;
				optimistic.clear();
				document.querySelectorAll(`.${CLASS}`).forEach((el) => el.classList.remove(CLASS));
			});
		}
	});
	var flightConfigs = new WeakMap();
	function attachFlightWaiter(flight, opts) {
		const cfg = flightConfigs.get(flight);
		const makeAbortError = cfg?.makeAbortError ?? createAbortError;
		const onEvict = cfg?.onEvict;
		const check = opts?.check;
		const signal = opts?.signal;
		try {
			check?.();
		} catch (err) {
			return Promise.reject(err);
		}
		if (signal?.aborted) return Promise.reject(makeAbortError(signal));
		flight.waiters++;
		if (!signal) return flight.promise.then((val) => {
			flight.waiters = Math.max(0, flight.waiters - 1);
			check?.();
			return val;
		}, (err) => {
			flight.waiters = Math.max(0, flight.waiters - 1);
			throw err;
		});
		return new Promise((resolve, reject) => {
			let done = false;
			const release = () => {
				if (done) return true;
				done = true;
				signal.removeEventListener("abort", onAbort);
				flight.waiters = Math.max(0, flight.waiters - 1);
				return false;
			};
			const onAbort = () => {
				if (release()) return;
				if (flight.waiters <= 0 && !flight.settled && !flight.controller.signal.aborted) {
					flight.controller.abort();
					onEvict?.(flight);
				}
				reject(makeAbortError(signal));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			flight.promise.then((val) => {
				if (release()) return;
				try {
					check?.();
					resolve(val);
				} catch (err) {
					reject(err);
				}
			}, (err) => {
				if (release()) return;
				reject(err);
			});
		});
	}
	function createSharedFlight(opts) {
		const controller = new AbortController();
		const makeAbortError = opts.createAbortError ?? createAbortError;
		const flight = {
			controller,
			promise: null,
			waiters: 0,
			settled: false,
			wait: (waiterOpts) => attachFlightWaiter(flight, waiterOpts)
		};
		flightConfigs.set(flight, {
			makeAbortError,
			onEvict: opts.onEvict
		});
		let rawPromise;
		try {
			rawPromise = opts.start(controller.signal);
		} catch (err) {
			rawPromise = Promise.reject(err);
		}
		const promise = rawPromise.then((val) => {
			flight.settled = true;
			opts.onSettled?.(flight);
			return val;
		}, (err) => {
			flight.settled = true;
			opts.onSettled?.(flight);
			throw err;
		});
		promise.catch(() => {});
		flight.promise = promise;
		return flight;
	}
	var DEFAULT_ICON = "https://www.google.com/s2/favicons?domain=youtube.com&sz=32";
	var VALID_ICON_SCHEME_RE = /^\s*https?:\/\//i;
	var DEFAULT_ANISONGS_CONFIG = {
		active: [],
		presets: [
			{
				id: "youtube",
				name: "YouTube",
				icon: "https://www.google.com/s2/favicons?domain=youtube.com&sz=32",
				url: "https://www.youtube.com/results?search_query={title}+{artist}"
			},
			{
				id: "youtube_music",
				name: "YouTube Music",
				icon: "https://www.google.com/s2/favicons?domain=music.youtube.com&sz=32",
				url: "https://music.youtube.com/search?q={title}+{artist}"
			},
			{
				id: "spotify",
				name: "Spotify",
				icon: "https://www.google.com/s2/favicons?domain=spotify.com&sz=32",
				url: "https://open.spotify.com/search/{title}%20{artist}"
			},
			{
				id: "apple_music",
				name: "Apple Music",
				icon: "https://www.google.com/s2/favicons?domain=music.apple.com&sz=32",
				url: "https://music.apple.com/us/search?term={title}+{artist}"
			},
			{
				id: "aniplaylist",
				name: "AniPlaylist",
				icon: "https://www.google.com/s2/favicons?domain=aniplaylist.com&sz=32",
				url: "https://aniplaylist.com/{title}"
			},
			{
				id: "youtube_theme",
				name: "YouTube (Anime + Theme)",
				icon: "https://www.google.com/s2/favicons?domain=youtube.com&sz=32",
				url: "https://www.youtube.com/results?search_query={anime}+{theme}"
			},
			{
				id: "youtube_jp",
				name: "YouTube (Japanese Anime + Theme)",
				icon: "https://www.google.com/s2/favicons?domain=youtube.com&sz=32",
				url: "https://www.youtube.com/results?search_query={anime_jp}+{theme}"
			}
		]
	};
	function validateAniSongsConfig(raw) {
		let data = raw;
		if (typeof data === "string") {
			const trimmed = data.trim();
			if (!trimmed) return {
				valid: true,
				config: JSON.parse(JSON.stringify(DEFAULT_ANISONGS_CONFIG))
			};
			try {
				data = JSON.parse(trimmed);
			} catch (e) {
				return {
					valid: false,
					error: `Invalid JSON syntax: ${e.message}`
				};
			}
		}
		if (!data || typeof data !== "object" || Array.isArray(data)) return {
			valid: false,
			error: "Configuration must be an object with \"active\" and \"presets\"."
		};
		if (!Array.isArray(data.presets) || !data.presets.length) return {
			valid: false,
			error: "Configuration must contain at least one preset in \"presets\"."
		};
		const validPresets = [];
		const seenIds = new Set();
		for (let i = 0; i < data.presets.length; i++) {
			const p = data.presets[i];
			if (!p || typeof p !== "object" || Array.isArray(p)) return {
				valid: false,
				error: `Preset at index ${i} is invalid.`
			};
			const id = String(p.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
			const name = String(p.name || "").trim();
			const url = String(p.url || "").trim();
			const rawIcon = p.icon != null ? String(p.icon).trim() : "";
			if (!id) return {
				valid: false,
				error: `Preset at index ${i} requires an ID.`
			};
			if (!name) return {
				valid: false,
				error: `Preset "${id}" requires a name.`
			};
			if (!url || !/^https?:\/\//i.test(url)) return {
				valid: false,
				error: `Preset "${id}" has an invalid URL. Must start with http:// or https://.`
			};
			if (rawIcon && !VALID_ICON_SCHEME_RE.test(rawIcon)) return {
				valid: false,
				error: `Preset "${id}" has an invalid icon URL. Must start with http:// or https://.`
			};
			const icon = rawIcon || DEFAULT_ICON;
			if (seenIds.has(id)) return {
				valid: false,
				error: `Duplicate preset ID "${id}". Each preset ID must be unique.`
			};
			seenIds.add(id);
			validPresets.push({
				id,
				name,
				icon,
				url
			});
		}
		return {
			valid: true,
			config: {
				active: (Array.isArray(data.active) ? data.active : []).map((s) => String(s).trim()).filter((id) => seenIds.has(id)),
				presets: validPresets
			}
		};
	}
	function getValidAniSongsConfig(raw) {
		if (raw === void 0) return JSON.parse(JSON.stringify(DEFAULT_ANISONGS_CONFIG));
		const check = validateAniSongsConfig(raw);
		return check.valid && check.config ? check.config : JSON.parse(JSON.stringify(DEFAULT_ANISONGS_CONFIG));
	}
	function buildProviderUrl(template, params) {
		if (!template || typeof template !== "string") return "#";
		const enc = (s) => encodeURIComponent((s || "").trim());
		const encPlus = (s) => encodeURIComponent((s || "").trim()).replace(/%20/g, "+");
		const format = template.includes("+") ? encPlus : enc;
		const title = (params.title || "").trim();
		const titleRomaji = (params.title_romaji || title).trim();
		const titleJp = (params.title_jp || title).trim();
		const artist = (params.artist || "").trim();
		const artists = (params.artists || artist).trim();
		const anime = (params.anime || "").trim();
		const animeRomaji = (params.anime_romaji || anime).trim();
		const animeEn = (params.anime_en || anime).trim();
		const animeJp = (params.anime_jp || anime).trim();
		const type = params.type || "OP";
		const number = String(params.number || 1);
		const theme = `${type}${number}`;
		const year = params.year != null ? String(params.year).trim() : "";
		const season = (params.season || "").trim();
		const eps = (params.eps || "").trim();
		const query = [title, artist].filter(Boolean).join(" ");
		const queryAnime = [anime, theme].filter(Boolean).join(" ");
		const queryJp = [animeJp, theme].filter(Boolean).join(" ");
		return template.replace(/\{title_romaji\}/gi, format(titleRomaji)).replace(/\{title_jp\}/gi, format(titleJp)).replace(/\{title_native\}/gi, format(titleJp)).replace(/\{title\}/gi, format(title)).replace(/\{artists\}/gi, format(artists)).replace(/\{artist\}/gi, format(artist)).replace(/\{anime_romaji\}/gi, format(animeRomaji)).replace(/\{anime_english\}/gi, format(animeEn)).replace(/\{anime_en\}/gi, format(animeEn)).replace(/\{anime_native\}/gi, format(animeJp)).replace(/\{anime_jp\}/gi, format(animeJp)).replace(/\{anime\}/gi, format(anime)).replace(/\{year\}/gi, format(year)).replace(/\{season\}/gi, format(season)).replace(/\{theme\}/gi, format(theme)).replace(/\{type\}/gi, format(type)).replace(/\{number\}/gi, format(number)).replace(/\{eps\}/gi, format(eps)).replace(/\{query_anime\}/gi, format(queryAnime)).replace(/\{query_jp\}/gi, format(queryJp)).replace(/\{query\}/gi, format(query));
	}
	var buildAniSongsModalCss = (sel) => `
  ${sel} .ala-core-sheet{height:100%}
  ${sel} .ala-as-tabs{display:flex;gap:6px;margin-bottom:16px;border-bottom:1px solid rgba(var(--color-text-lighter),.14);padding-bottom:10px;overflow-x:auto;-webkit-overflow-scrolling:touch}
  ${sel} .ala-as-tab{padding:6px 14px;border:0;border-radius:4px;background:transparent;color:rgb(var(--color-text-lighter));font:inherit;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;transition:all .15s}
  ${sel} .ala-as-tab:hover{color:rgb(var(--color-text));background:rgba(var(--color-text-lighter),.1)}
  ${sel} .ala-as-tab.is-active{color:#fff;background:rgb(var(--color-blue))}

  ${sel} .ala-as-box{padding:14px;border-radius:6px;background:rgb(var(--color-background));margin-bottom:16px}
  ${sel} .ala-as-title{margin:0 0 8px;font-size:13px;font-weight:600;color:rgb(var(--color-blue))}
  ${sel} .ala-as-help{font-size:12px;color:rgb(var(--color-text-lighter));margin:0 0 10px;line-height:1.4}

  ${sel} .ala-as-list{display:grid;gap:6px;margin-bottom:12px;min-width:0}
  ${sel} .ala-as-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;background:rgb(var(--color-foreground));border:1px solid rgba(var(--color-text-lighter),.12);min-width:0;max-width:100%}
  ${sel} .ala-as-item-icon{width:22px;height:22px;object-fit:contain;border-radius:3px;flex-shrink:0}
  ${sel} .ala-as-item-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  ${sel} .ala-as-item-name{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
  ${sel} .ala-as-item-url{font-size:11px;color:rgb(var(--color-text-lighter));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace}
  ${sel} .ala-as-item-actions{display:flex;align-items:center;gap:4px;flex-shrink:0}

  ${sel} .ala-as-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border:1px solid rgba(var(--color-text-lighter),.25);border-radius:14px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));font-size:12px;cursor:pointer;transition:all .15s}
  ${sel} .ala-as-chip:hover{border-color:rgb(var(--color-blue));color:rgb(var(--color-blue))}
  ${sel} .ala-as-chip-group{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}

  ${sel} .ala-as-form{display:grid;gap:8px;margin-top:8px}
  ${sel} .ala-as-form-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  ${sel} .ala-as-field{display:flex;flex-direction:column;gap:4px}
  ${sel} .ala-as-field label{font-size:11px;font-weight:600;color:rgb(var(--color-text-lighter))}
  ${sel} .ala-as-input{width:100%;height:34px;padding:0 8px;border:1px solid rgba(var(--color-text-lighter),.22);border-radius:4px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));font:inherit;font-size:12px}
  ${sel} .ala-as-input:focus{outline:none;border-color:rgb(var(--color-blue))}

  ${sel} .ala-as-var-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;max-height:120px;overflow-y:auto;padding-bottom:2px}
  ${sel} .ala-as-var-tag{padding:3px 7px;border-radius:3px;font-family:monospace;font-size:11px;background:rgba(var(--color-blue),.15);color:rgb(var(--color-blue));cursor:pointer;user-select:none;touch-action:manipulation}
  ${sel} .ala-as-var-tag:hover{background:rgb(var(--color-blue));color:#fff}

  ${sel} .ala-as-textarea{width:100%;height:280px;padding:10px;border:1px solid rgba(var(--color-text-lighter),.22);border-radius:4px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));font-family:monospace,Consolas,Courier;font-size:12px;line-height:1.4;resize:vertical;tab-size:2}
  ${sel} .ala-as-status{padding:8px 12px;border-radius:4px;font-size:12px;margin-top:10px;display:none}
  ${sel} .ala-as-status--success{background:rgba(var(--color-green,70,211,105),.15);color:rgb(var(--color-green,70,211,105));border:1px solid rgba(var(--color-green,70,211,105),.3)}
  ${sel} .ala-as-status--error{background:rgba(var(--color-red,235,87,87),.15);color:rgb(var(--color-red,235,87,87));border:1px solid rgba(var(--color-red,235,87,87),.3)}

  ${sel} .ala-btn:disabled,
  ${sel} .ala-icon-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
    pointer-events: none;
    filter: none !important;
  }

  @media (max-width:700px){
    ${sel}{align-items:flex-end;padding:0}
    ${sel} .ala-core-sheet{width:100%;height:92vh;height:92dvh;max-height:92vh;max-height:92dvh;border-radius:14px 14px 0 0}
    ${sel} .ala-core-head{padding:14px 16px}
    ${sel} .ala-core-body{padding:12px 16px}
    ${sel} .ala-core-foot{padding:10px 16px calc(10px + env(safe-area-inset-bottom, 0px));flex-direction:column-reverse;gap:8px}
    ${sel} .ala-core-foot .ala-btn{width:100%;min-height:42px;justify-content:center}

    ${sel} .ala-as-form-row{grid-template-columns:1fr;gap:6px}
    ${sel} .ala-as-input{height:38px;font-size:14px}

    ${sel} .ala-as-item{flex-wrap:wrap;align-items:flex-start;gap:8px;padding:10px}
    ${sel} .ala-as-item-info{flex:1 1 calc(100% - 36px);min-width:0}
    ${sel} .ala-as-item-url{white-space:normal;word-break:break-all;font-size:10px}
    ${sel} .ala-as-item-actions{width:100%;display:flex;gap:6px;margin-top:4px;padding-top:6px;border-top:1px solid rgba(var(--color-text-lighter),.1)}
    ${sel} .ala-as-item-actions .ala-btn{flex:1 1 0;min-height:36px;justify-content:center;font-size:12px}
    ${sel} .ala-as-item-actions .ala-icon-btn{flex:0 0 36px;height:36px}

    ${sel} .ala-as-form-actions{flex-direction:column;gap:8px;width:100%}
    ${sel} .ala-as-form-actions .ala-btn{width:100%;min-height:42px;margin-left:0!important;justify-content:center;text-align:center}

    ${sel} .ala-as-json-actions{flex-direction:column;gap:8px}
    ${sel} .ala-as-json-actions .ala-btn{width:100%;min-height:42px;margin-left:0!important;justify-content:center}
    ${sel} .ala-as-textarea{height:200px}
  }
  `;
	function openAniSongsModal(ctx) {
		const checkInit = validateAniSongsConfig(ctx.value);
		let stateConfig = checkInit.valid && checkInit.config ? JSON.parse(JSON.stringify(checkInit.config)) : JSON.parse(JSON.stringify(DEFAULT_ANISONGS_CONFIG));
		const modal = ctx.modal({
			id: "anisongs-modal",
			title: "Customize Song Search Providers",
			maxWidth: "660px",
			bodyHtml: `
      <div class="ala-as-tabs">
        <button class="ala-as-tab is-active" data-tab="presets" type="button">Shortcuts &amp; Presets</button>
        <button class="ala-as-tab" data-tab="json" type="button">Import / Export JSON</button>
      </div>

      <div id="ala-as-view-presets">
        <div class="ala-as-box">
          <h3 class="ala-as-title">Active Shortcuts</h3>
          <p class="ala-as-help">These search icons appear directly next to each song on anime pages. Use arrows to reorder.</p>
          <div id="ala-as-active-list" class="ala-as-list"></div>
          <div style="font-size:11px;font-weight:600;color:rgb(var(--color-text-lighter));margin-top:8px">Add inactive preset to shortcuts:</div>
          <div id="ala-as-available-chips" class="ala-as-chip-group"></div>
        </div>

        <div class="ala-as-box">
          <h3 class="ala-as-title">All Presets</h3>
          <p class="ala-as-help">Manage available music and video providers.</p>
          <div id="ala-as-preset-list" class="ala-as-list"></div>

          <div style="border-top:1px solid rgba(var(--color-text-lighter),.12);padding-top:12px;margin-top:12px">
            <h4 id="ala-as-form-heading" style="margin:0 0 8px;font-size:12px;color:rgb(var(--color-blue))">Add Custom Preset</h4>
            <div class="ala-as-form">
              <div class="ala-as-form-row">
                <div class="ala-as-field">
                  <label for="ala-as-in-name">Name</label>
                  <input type="text" id="ala-as-in-name" class="ala-as-input" placeholder="e.g. Deezer">
                </div>
                <div class="ala-as-field">
                  <label for="ala-as-in-icon">Favicon / Icon URL</label>
                  <input type="text" id="ala-as-in-icon" class="ala-as-input" placeholder="e.g. https://www.deezer.com/favicon.ico">
                </div>
              </div>
              <div class="ala-as-field">
                <label for="ala-as-in-url">URL Search Template</label>
                <input type="text" id="ala-as-in-url" class="ala-as-input" placeholder="e.g. https://www.deezer.com/search/{title}%20{artist}">
                <div class="ala-as-var-tags">
                  <span class="ala-as-var-tag" data-var="{title}">{title}</span>
                  <span class="ala-as-var-tag" data-var="{title_jp}">{title_jp}</span>
                  <span class="ala-as-var-tag" data-var="{title_romaji}">{title_romaji}</span>
                  <span class="ala-as-var-tag" data-var="{artist}">{artist}</span>
                  <span class="ala-as-var-tag" data-var="{artists}">{artists}</span>
                  <span class="ala-as-var-tag" data-var="{anime}">{anime}</span>
                  <span class="ala-as-var-tag" data-var="{anime_jp}">{anime_jp}</span>
                  <span class="ala-as-var-tag" data-var="{anime_romaji}">{anime_romaji}</span>
                  <span class="ala-as-var-tag" data-var="{anime_en}">{anime_en}</span>
                  <span class="ala-as-var-tag" data-var="{theme}">{theme}</span>
                  <span class="ala-as-var-tag" data-var="{type}">{type}</span>
                  <span class="ala-as-var-tag" data-var="{number}">{number}</span>
                  <span class="ala-as-var-tag" data-var="{year}">{year}</span>
                  <span class="ala-as-var-tag" data-var="{season}">{season}</span>
                  <span class="ala-as-var-tag" data-var="{query}">{query}</span>
                  <span class="ala-as-var-tag" data-var="{query_anime}">{query_anime}</span>
                  <span class="ala-as-var-tag" data-var="{query_jp}">{query_jp}</span>
                </div>
              </div>
              <div class="ala-as-form-actions" style="display:flex;gap:8px;margin-top:6px">
                <button type="button" class="ala-btn ala-btn--sm ala-btn--primary" id="ala-as-btn-save-preset">Add Preset</button>
                <button type="button" class="ala-btn ala-btn--sm" id="ala-as-btn-cancel-preset" style="display:none">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div id="ala-as-view-json" style="display:none">
        <div class="ala-as-box">
          <h3 class="ala-as-title">Raw JSON Configuration</h3>
          <p class="ala-as-help">View, export, or paste preset definitions and active provider arrays.</p>
          <textarea id="ala-as-json-area" class="ala-as-textarea" spellcheck="false"></textarea>
          <div id="ala-as-json-status" class="ala-as-status"></div>
          <div class="ala-as-json-actions" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button type="button" class="ala-btn ala-btn--primary" id="ala-as-btn-apply-json">Apply JSON</button>
            <button type="button" class="ala-btn" id="ala-as-btn-copy-json">Copy to Clipboard</button>
            <button type="button" class="ala-btn" id="ala-as-btn-reset-defaults" style="margin-left:auto">Reset Defaults</button>
          </div>
        </div>
      </div>
    `,
			footerHtml: `
      <button class="ala-btn ala-btn--primary" id="ala-as-btn-done" type="button">Apply &amp; Save</button>
      <button class="ala-btn" type="button" data-ala-close>Cancel</button>
    `,
			style: buildAniSongsModalCss
		});
		const { backdrop, close } = modal;
		const onClick = (selector, fn) => {
			const el = backdrop.querySelector(selector);
			if (el) modal.listen(el, "click", fn);
		};
		const tabs = backdrop.querySelectorAll(".ala-as-tab");
		const viewPresets = backdrop.querySelector("#ala-as-view-presets");
		const viewJson = backdrop.querySelector("#ala-as-view-json");
		const jsonArea = backdrop.querySelector("#ala-as-json-area");
		const jsonStatus = backdrop.querySelector("#ala-as-json-status");
		tabs.forEach((t) => {
			modal.listen(t, "click", () => {
				tabs.forEach((o) => o.classList.toggle("is-active", o === t));
				const isJson = t.dataset.tab === "json";
				viewPresets.style.display = isJson ? "none" : "block";
				viewJson.style.display = isJson ? "block" : "none";
				if (isJson) {
					jsonArea.value = JSON.stringify(stateConfig, null, 2);
					jsonStatus.style.display = "none";
				}
			});
		});
		const urlInput = backdrop.querySelector("#ala-as-in-url");
		const nameInput = backdrop.querySelector("#ala-as-in-name");
		const iconInput = backdrop.querySelector("#ala-as-in-icon");
		const formHeading = backdrop.querySelector("#ala-as-form-heading");
		const savePresetBtn = backdrop.querySelector("#ala-as-btn-save-preset");
		const cancelPresetBtn = backdrop.querySelector("#ala-as-btn-cancel-preset");
		const activeList = backdrop.querySelector("#ala-as-active-list");
		const availableChips = backdrop.querySelector("#ala-as-available-chips");
		const presetList = backdrop.querySelector("#ala-as-preset-list");
		let editingPresetId = null;
		backdrop.querySelectorAll(".ala-as-var-tag").forEach((chip) => {
			modal.listen(chip, "click", () => {
				const tag = chip.dataset.var || "";
				urlInput.value += tag;
				urlInput.focus();
			});
		});
		const resetForm = () => {
			editingPresetId = null;
			formHeading.textContent = "Add Custom Preset";
			savePresetBtn.textContent = "Add Preset";
			cancelPresetBtn.style.display = "none";
			nameInput.value = "";
			iconInput.value = "";
			urlInput.value = "";
		};
		modal.listen(cancelPresetBtn, "click", resetForm);
		modal.listen(savePresetBtn, "click", async () => {
			if (savePresetBtn.disabled) return;
			const name = nameInput.value.trim();
			const url = urlInput.value.trim();
			const rawIcon = iconInput.value.trim();
			const showFormError = async (msg) => {
				savePresetBtn.disabled = true;
				try {
					await ctx.alert(msg);
				} finally {
					if (!modal.signal.aborted) savePresetBtn.disabled = false;
				}
			};
			if (!name) return void await showFormError("Please enter a preset name.");
			if (!url || !/^https?:\/\//i.test(url)) {
				await showFormError("Please enter a valid URL template starting with http:// or https://.");
				return;
			}
			if (rawIcon && !VALID_ICON_SCHEME_RE.test(rawIcon)) {
				await showFormError("Please enter a valid icon URL starting with http:// or https://.");
				return;
			}
			const icon = rawIcon || `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.replace(/^https?:\/\//i, "").split("/")[0])}&sz=32`;
			if (editingPresetId) {
				const idx = stateConfig.presets.findIndex((p) => p.id === editingPresetId);
				if (idx !== -1) stateConfig.presets[idx] = {
					...stateConfig.presets[idx],
					name,
					icon,
					url
				};
			} else {
				let id = `${name.toLowerCase().replace(/[^a-z0-9_-]/g, "_") || "preset"}_${Math.floor(Math.random() * 1e3)}`;
				const candidateBase = id;
				let suffix = 1;
				while (stateConfig.presets.some((p) => p.id === id)) id = `${candidateBase}_${suffix++}`;
				stateConfig.presets.push({
					id,
					name,
					icon,
					url
				});
				stateConfig.active.push(id);
			}
			resetForm();
			renderUI();
		});
		function renderUI() {
			const presetMap = new Map();
			stateConfig.presets.forEach((p) => presetMap.set(p.id, p));
			stateConfig.active = stateConfig.active.filter((id) => presetMap.has(id));
			if (!stateConfig.active.length) activeList.innerHTML = `<div style="font-size:12px;color:rgb(var(--color-text-lighter));padding:8px 0">No active shortcuts selected. Tap an available preset below to activate it.</div>`;
			else {
				const totalActive = stateConfig.active.length;
				activeList.innerHTML = stateConfig.active.map((id, idx) => {
					const p = presetMap.get(id);
					const isTop = idx === 0;
					const isBottom = idx === totalActive - 1;
					return `
          <div class="ala-as-item" data-id="${esc(p.id)}">
            <img class="ala-as-item-icon" src="${esc(p.icon)}" alt="">
            <div class="ala-as-item-info">
              <span class="ala-as-item-name">${esc(p.name)}</span>
              <span class="ala-as-item-url">${esc(p.url)}</span>
            </div>
            <div class="ala-as-item-actions">
              <button type="button" class="ala-btn ala-btn--sm ala-as-act-up" data-idx="${idx}" ${isTop ? "disabled" : ""} title="Move Up">▲</button>
              <button type="button" class="ala-btn ala-btn--sm ala-as-act-down" data-idx="${idx}" ${isBottom ? "disabled" : ""} title="Move Down">▼</button>
              <button type="button" class="ala-btn ala-btn--sm ala-btn--danger ala-as-act-remove" data-id="${esc(p.id)}" title="Remove from active">✕</button>
            </div>
          </div>
        `;
				}).join("");
			}
			const activeSet = new Set(stateConfig.active);
			const inactivePresets = stateConfig.presets.filter((p) => !activeSet.has(p.id));
			if (!inactivePresets.length) availableChips.innerHTML = `<span style="font-size:12px;color:rgb(var(--color-text-lighter))">All presets are currently active.</span>`;
			else availableChips.innerHTML = inactivePresets.map((p) => `
          <button type="button" class="ala-as-chip ala-as-chip-activate" data-id="${esc(p.id)}">
            <img style="width:14px;height:14px;object-fit:contain" src="${esc(p.icon)}" alt="">
            <span>+ ${esc(p.name)}</span>
          </button>
        `).join("");
			presetList.innerHTML = stateConfig.presets.map((p) => {
				const isActive = activeSet.has(p.id);
				return `
        <div class="ala-as-item" data-id="${esc(p.id)}">
          <img class="ala-as-item-icon" src="${esc(p.icon)}" alt="">
          <div class="ala-as-item-info">
            <span class="ala-as-item-name">
              ${esc(p.name)}
              ${isActive ? `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(var(--color-blue),.15);color:rgb(var(--color-blue))">Active</span>` : ""}
            </span>
            <span class="ala-as-item-url">${esc(p.url)}</span>
          </div>
          <div class="ala-as-item-actions">
            <button type="button" class="ala-btn ala-btn--sm ala-as-btn-edit-preset" data-id="${esc(p.id)}">Edit</button>
            <button type="button" class="ala-icon-btn ala-as-btn-del-preset" data-id="${esc(p.id)}" title="Delete preset">✕</button>
          </div>
        </div>
      `;
			}).join("");
			for (const container of [
				activeList,
				availableChips,
				presetList
			]) container.querySelectorAll("img").forEach((img) => {
				img.addEventListener("error", () => {
					if (img.src !== DEFAULT_ICON) img.src = DEFAULT_ICON;
				}, {
					once: true,
					signal: modal.signal
				});
			});
		}
		modal.listen(activeList, "click", (e) => {
			const target = e.target;
			const upBtn = target.closest(".ala-as-act-up");
			if (upBtn) {
				if (upBtn.disabled) return;
				const idx = Number(upBtn.dataset.idx);
				if (idx > 0) {
					const temp = stateConfig.active[idx - 1];
					stateConfig.active[idx - 1] = stateConfig.active[idx];
					stateConfig.active[idx] = temp;
					renderUI();
				}
				return;
			}
			const downBtn = target.closest(".ala-as-act-down");
			if (downBtn) {
				if (downBtn.disabled) return;
				const idx = Number(downBtn.dataset.idx);
				if (idx < stateConfig.active.length - 1) {
					const temp = stateConfig.active[idx + 1];
					stateConfig.active[idx + 1] = stateConfig.active[idx];
					stateConfig.active[idx] = temp;
					renderUI();
				}
				return;
			}
			const removeBtn = target.closest(".ala-as-act-remove");
			if (removeBtn) {
				const id = removeBtn.dataset.id;
				stateConfig.active = stateConfig.active.filter((a) => a !== id);
				renderUI();
			}
		});
		modal.listen(availableChips, "click", (e) => {
			const btn = e.target.closest(".ala-as-chip-activate");
			if (!btn) return;
			const id = btn.dataset.id;
			if (id && !stateConfig.active.includes(id)) {
				stateConfig.active.push(id);
				renderUI();
			}
		});
		let presetActionPending = false;
		modal.listen(presetList, "click", async (e) => {
			const target = e.target;
			const editBtn = target.closest(".ala-as-btn-edit-preset");
			if (editBtn) {
				if (presetActionPending) return;
				const id = editBtn.dataset.id;
				const p = stateConfig.presets.find((x) => x.id === id);
				if (!p) return;
				editingPresetId = p.id;
				formHeading.textContent = `Edit Preset: ${p.name}`;
				savePresetBtn.textContent = "Update Preset";
				cancelPresetBtn.style.display = "inline-flex";
				nameInput.value = p.name;
				iconInput.value = p.icon;
				urlInput.value = p.url;
				nameInput.focus();
				return;
			}
			const delBtn = target.closest(".ala-as-btn-del-preset");
			if (delBtn) {
				if (presetActionPending || delBtn.disabled) return;
				const id = delBtn.dataset.id;
				if (!id) return;
				if (stateConfig.presets.length <= 1) {
					presetActionPending = true;
					delBtn.disabled = true;
					try {
						await ctx.alert("You must have at least one preset configured.");
					} finally {
						presetActionPending = false;
						if (!modal.signal.aborted && delBtn.isConnected) delBtn.disabled = false;
					}
					return;
				}
				presetActionPending = true;
				delBtn.disabled = true;
				let confirmed = false;
				try {
					confirmed = await ctx.confirm({
						title: "Delete Preset",
						message: "Delete preset?",
						confirmText: "Delete",
						danger: true
					});
				} finally {
					presetActionPending = false;
					if (!modal.signal.aborted && delBtn.isConnected) delBtn.disabled = false;
				}
				if (!confirmed || modal.signal.aborted || ctx.signal.aborted) return;
				stateConfig.presets = stateConfig.presets.filter((p) => p.id !== id);
				stateConfig.active = stateConfig.active.filter((a) => a !== id);
				if (editingPresetId === id) resetForm();
				renderUI();
			}
		});
		const copyJsonBtn = backdrop.querySelector("#ala-as-btn-copy-json");
		if (copyJsonBtn) modal.listen(copyJsonBtn, "click", async () => {
			if (copyJsonBtn.disabled) return;
			copyJsonBtn.disabled = true;
			try {
				try {
					await navigator.clipboard.writeText(jsonArea.value);
				} catch (_) {
					jsonArea.select();
					document.execCommand?.("copy");
				}
				if (modal.signal.aborted || ctx.signal.aborted) return;
				ctx.toast.success("Copied configuration to clipboard!");
			} finally {
				if (!modal.signal.aborted) copyJsonBtn.disabled = false;
			}
		});
		const resetDefaultsBtn = backdrop.querySelector("#ala-as-btn-reset-defaults");
		if (resetDefaultsBtn) modal.listen(resetDefaultsBtn, "click", async () => {
			if (resetDefaultsBtn.disabled) return;
			resetDefaultsBtn.disabled = true;
			try {
				if (!await ctx.confirm({
					title: "Reset Defaults",
					message: "Reset all music search providers and shortcuts to default settings?",
					confirmText: "Reset",
					danger: true
				}) || modal.signal.aborted || ctx.signal.aborted) return;
				stateConfig = JSON.parse(JSON.stringify(DEFAULT_ANISONGS_CONFIG));
				jsonArea.value = JSON.stringify(stateConfig, null, 2);
				resetForm();
				renderUI();
				jsonStatus.className = "ala-as-status ala-as-status--success";
				jsonStatus.textContent = "Reset to default presets.";
				jsonStatus.style.display = "block";
			} finally {
				if (!modal.signal.aborted) resetDefaultsBtn.disabled = false;
			}
		});
		onClick("#ala-as-btn-apply-json", () => {
			const check = validateAniSongsConfig(jsonArea.value);
			if (!check.valid || !check.config) {
				jsonStatus.className = "ala-as-status ala-as-status--error";
				jsonStatus.textContent = check.error || "Invalid configuration JSON";
				jsonStatus.style.display = "block";
				return;
			}
			stateConfig = check.config;
			resetForm();
			renderUI();
			jsonStatus.className = "ala-as-status ala-as-status--success";
			jsonStatus.textContent = "Configuration applied successfully!";
			jsonStatus.style.display = "block";
		});
		const doneBtn = backdrop.querySelector("#ala-as-btn-done");
		if (doneBtn) modal.listen(doneBtn, "click", async () => {
			if (doneBtn.disabled) return;
			const check = validateAniSongsConfig(stateConfig);
			if (!check.valid || !check.config) {
				doneBtn.disabled = true;
				try {
					await ctx.alert(check.error || "Invalid configuration");
				} finally {
					if (!modal.signal.aborted) doneBtn.disabled = false;
				}
				return;
			}
			if (modal.signal.aborted || ctx.signal.aborted) return;
			ctx.onApply(check.config);
			close();
		});
		renderUI();
	}
	var str = (v) => typeof v === "string" ? v.trim() : "";
	var DIRECT_SITE_MAP = {
		spotify: "SPOTIFY",
		youtube: "YOUTUBE",
		youtube_music: "YOUTUBE_MUSIC",
		apple_music: "APPLE_MUSIC"
	};
	function resolveProviderLink(preset, song, groupType) {
		const directSite = DIRECT_SITE_MAP[preset.id];
		const rawDirect = directSite && song.resources ? song.resources[directSite] : null;
		const directUrl = typeof rawDirect === "string" ? rawDirect.trim() : "";
		if (directUrl && /^https?:\/\//i.test(directUrl)) return {
			url: directUrl,
			isDirect: true
		};
		const params = extractSongParams(song, groupType);
		return {
			url: buildProviderUrl(preset.url, params),
			isDirect: false
		};
	}
	function pickVideo(entries) {
		let fallback = null;
		for (const entry of Array.isArray(entries) ? entries : []) {
			const rawVideos = entry?.videos;
			const videos = Array.isArray(rawVideos?.nodes) ? rawVideos.nodes : Array.isArray(rawVideos) ? rawVideos : [];
			for (const video of videos) {
				const link = str(video?.link);
				if (!/^https?:\/\//i.test(link)) continue;
				if (str(video?.source).toUpperCase() === "WEB") return link;
				fallback = fallback || link;
			}
		}
		return fallback;
	}
	var PERFORMER_ROLES = new Set(["PERFORMANCE", "FEATURING"]);
	var relevanceOf = (v) => v != null && Number.isFinite(Number(v)) ? Number(v) : Number.MAX_SAFE_INTEGER;
	function extractSongArtists(song) {
		const mainArtists = [];
		const featArtists = [];
		const seen = new Set();
		if (Array.isArray(song?.staff)) {
			const sorted = [...song.staff].sort((a, b) => relevanceOf(a?.relevance) - relevanceOf(b?.relevance));
			for (const s of sorted) {
				const role = str(s?.role).toUpperCase();
				if (role && !PERFORMER_ROLES.has(role)) continue;
				const name = str(s?.as || s?.alias || s?.artist?.name?.main || s?.artist?.name);
				if (!name || seen.has(name)) continue;
				seen.add(name);
				if (role === "FEATURING") featArtists.push(name);
				else mainArtists.push(name);
			}
		} else if (Array.isArray(song?.artists)) for (const a of song.artists) {
			const name = str(a?.name);
			if (name && !seen.has(name)) {
				seen.add(name);
				mainArtists.push(name);
			}
		}
		const artists = [...mainArtists, ...featArtists];
		return {
			artists,
			credit: mainArtists.length && featArtists.length ? `${mainArtists.join(", ")} feat. ${featArtists.join(", ")}` : artists.join(", ")
		};
	}
	function firstEpisodeNum(eps) {
		const m = (eps || "").match(/\d+/);
		return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER;
	}
	function sortEpisodes(raw) {
		const seen = new Set();
		const parts = raw.split(",").map((p) => p.trim()).filter((p) => {
			if (!p || seen.has(p)) return false;
			seen.add(p);
			return true;
		});
		if (parts.length <= 1) return parts[0] || "";
		parts.sort((a, b) => firstEpisodeNum(a) - firstEpisodeNum(b) || a.localeCompare(b));
		return parts.join(", ");
	}
	function formatEpsTag(eps) {
		if (!eps) return "";
		return `(${/[-,]/.test(eps) ? "eps" : "ep"} ${eps})`;
	}
	var LANGUAGE_GROUP_RE = /\b(english|dub(?:bed)?|spanish|french|german|italian|portuguese|korean|chinese|castilian|latin)\b/i;
	function cleanGroupName(group) {
		return group.replace(/\s+Version\b/i, "").trim();
	}
	var normTitle$1 = (s) => s.trim().toLowerCase();
	function extractRawTheme(theme) {
		const songTitle = str(theme?.song?.title?.romaji || theme?.song?.title);
		if (!songTitle) return null;
		const rawSeqVal = theme?.sequence != null && Number.isFinite(Number(theme.sequence)) ? Math.floor(Number(theme.sequence)) : null;
		const rawSequence = rawSeqVal != null && rawSeqVal >= 1 ? rawSeqVal : null;
		const sequence = rawSequence ?? 1;
		const { artists, credit: artistCredit } = extractSongArtists(theme?.song);
		const entries = [...Array.isArray(theme?.entries) ? theme.entries : Array.isArray(theme?.animethemeentries) ? theme.animethemeentries : []].sort((a, b) => {
			const va = a?.version != null && Number.isFinite(Number(a.version)) ? Number(a.version) : 1;
			const vb = b?.version != null && Number.isFinite(Number(b.version)) ? Number(b.version) : 1;
			if (va !== vb) return va - vb;
			return firstEpisodeNum(str(a?.episodes)) - firstEpisodeNum(str(b?.episodes));
		}).map((e, idx) => {
			const vNum = e?.version != null && Number.isFinite(Number(e.version)) ? Math.floor(Number(e.version)) : idx + 1;
			const ep = sortEpisodes(str(e?.episodes));
			const notes = str(e?.notes);
			return {
				version: vNum,
				label: `v${vNum}`,
				...ep ? { episodes: ep } : {},
				...notes ? { notes } : {},
				url: pickVideo([e])
			};
		});
		const groupName = typeof theme?.group === "object" && theme?.group !== null ? str(theme.group.name) : str(theme?.group);
		const type = str(theme?.type).toUpperCase() === "ED" ? "ED" : "OP";
		const nativeTitle = str(theme?.song?.title?.native);
		const hasJp = !!nativeTitle || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(songTitle);
		const resourcesList = Array.isArray(theme?.song?.resources?.nodes) ? theme.song.resources.nodes : [];
		const resources = {};
		for (const r of resourcesList) {
			const site = str(r?.site).toUpperCase();
			const link = typeof r?.link === "string" ? r.link.trim() : "";
			if (site && /^https?:\/\//i.test(link)) resources[site] = link;
		}
		return {
			type,
			rawSequence,
			sequence,
			title: songTitle,
			titleJp: nativeTitle || (hasJp ? songTitle : void 0),
			artists,
			artistCredit,
			groupName,
			entries,
			resources: Object.keys(resources).length ? resources : void 0
		};
	}
	function buildSongEntry(bucket, meta) {
		const ordered = [...bucket].sort((a, b) => {
			const ag = a.groupName ? 1 : 0;
			const bg = b.groupName ? 1 : 0;
			if (ag !== bg) return ag - bg;
			return a.groupName.localeCompare(b.groupName);
		});
		const primary = ordered[0];
		const merged = ordered.length > 1;
		let versions;
		if (!merged) versions = primary.entries;
		else {
			const hasLanguageSibling = ordered.some((t) => t.groupName && LANGUAGE_GROUP_RE.test(t.groupName));
			versions = [];
			for (const sub of ordered) {
				const grpLabel = sub.groupName ? cleanGroupName(sub.groupName) : hasLanguageSibling ? "Japanese" : "Original";
				const subSongDiffers = normTitle$1(sub.title) !== normTitle$1(primary.title);
				const subEntries = sub.entries.length ? sub.entries : [{
					version: 1,
					label: "v1",
					url: null
				}];
				const multiInSub = subEntries.length > 1;
				for (const e of subEntries) versions.push({
					version: e.version,
					label: multiInSub ? `${grpLabel} v${e.version}` : grpLabel,
					...subSongDiffers ? { songTitle: sub.title } : {},
					...e.episodes ? { episodes: e.episodes } : {},
					...e.notes ? { notes: e.notes } : {},
					url: e.url
				});
			}
		}
		const multiVersion = versions.length > 1;
		const eps = sortEpisodes(versions.map((v) => v.episodes).filter(Boolean).join(", "));
		const epsSuffix = !multiVersion && eps ? ` ${formatEpsTag(eps)}` : "";
		const singleGroupTag = !merged && primary.groupName ? ` (${cleanGroupName(primary.groupName)})` : "";
		return {
			sequence: primary.sequence,
			title: primary.title,
			title_romaji: primary.title,
			title_jp: primary.titleJp,
			artists: primary.artists,
			type: primary.type,
			animeName: meta.animeName,
			animeRomaji: meta.animeRomaji,
			animeEn: meta.animeEn,
			animeJp: meta.animeJp,
			year: meta.year,
			season: meta.season,
			eps: eps || void 0,
			...multiVersion ? { versions } : {},
			resources: primary.resources,
			name: `${primary.sequence}. "${primary.title}"` + (primary.artistCredit ? ` by ${primary.artistCredit}` : "") + epsSuffix + singleGroupTag,
			url: versions.find((v) => v.url)?.url || null
		};
	}
	function groupThemes(anime, meta) {
		const out = {
			OP: [],
			ED: []
		};
		const themeList = Array.isArray(anime?.themes) ? anime.themes : Array.isArray(anime?.animethemes) ? anime.animethemes : [];
		const buckets = {
			OP: new Map(),
			ED: new Map()
		};
		let anonIdx = 0;
		for (const theme of themeList) {
			const raw = extractRawTheme(theme);
			if (!raw) continue;
			const map = buckets[raw.type];
			let key;
			if (raw.rawSequence != null) key = `seq:${raw.rawSequence}`;
			else if (raw.groupName) {
				const target = [...map.entries()].find(([k, items]) => k.startsWith("anon:") && normTitle$1(items[0].title) === normTitle$1(raw.title));
				key = target ? target[0] : `anon:${anonIdx++}`;
			} else key = `anon:${anonIdx++}`;
			const list = map.get(key) || [];
			list.push(raw);
			map.set(key, list);
		}
		for (const type of ["OP", "ED"]) {
			for (const bucket of buckets[type].values()) out[type].push(buildSongEntry(bucket, meta));
			out[type].sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name));
		}
		return out;
	}
	var COLLAPSE_FALLBACK_MS = 260;
	var prefersReducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	var cancelClosingMap = new WeakMap();
	function createCollapsibleVideo(videoUrl) {
		const wrap = document.createElement("div");
		wrap.className = "daiya-anisong-collapsible";
		const inner = document.createElement("div");
		inner.className = "daiya-anisong-collapsible-inner";
		const pad = document.createElement("div");
		pad.className = "daiya-anisong-video-pad";
		const video = document.createElement("video");
		video.controls = true;
		video.preload = "none";
		video.volume = .4;
		video.src = videoUrl;
		video.addEventListener("click", (ev) => ev.stopPropagation());
		pad.appendChild(video);
		inner.appendChild(pad);
		wrap.appendChild(inner);
		return {
			wrap,
			video
		};
	}
	function scheduleFallback(fn, ms, timeout) {
		if (timeout) return timeout(fn, ms);
		let cancelled = false;
		sleep(ms).then(() => {
			if (!cancelled) fn();
		});
		return () => {
			cancelled = true;
		};
	}
	function createSongCard(song, activePresets, groupType, timeout) {
		const el = document.createElement("div");
		el.className = "daiya-anisong-entry";
		const header = document.createElement("div");
		header.className = "daiya-anisong-header";
		const titleSpan = document.createElement("span");
		titleSpan.className = "daiya-anisong-title";
		titleSpan.textContent = song.name;
		header.appendChild(titleSpan);
		if (activePresets.length) {
			const actions = document.createElement("div");
			actions.className = "daiya-anisong-actions";
			activePresets.forEach((p) => {
				if (!p || !p.url) return;
				const a = document.createElement("a");
				a.className = "daiya-anisong-link";
				const { url, isDirect } = resolveProviderLink(p, song, groupType);
				a.href = url;
				a.target = "_blank";
				a.rel = "noopener";
				a.title = isDirect ? `Listen on ${p.name}` : `Search on ${p.name}`;
				a.addEventListener("click", (ev) => ev.stopPropagation());
				const img = document.createElement("img");
				img.className = "daiya-anisong-icon";
				img.src = p.icon;
				img.alt = p.name;
				img.onerror = () => {
					img.src = "https://www.google.com/s2/favicons?domain=youtube.com&sz=32";
				};
				a.appendChild(img);
				actions.appendChild(a);
			});
			header.appendChild(actions);
		}
		el.appendChild(header);
		let active = null;
		const closingByRow = new Map();
		function closePlayer(player) {
			player.video.pause?.();
			player.row?.classList.remove("is-active");
			if (prefersReducedMotion()) {
				player.wrap.remove();
				return;
			}
			closingByRow.set(player.row, player);
			player.wrap.classList.remove("is-open");
			let done = false;
			let cancelTimer = () => {};
			const detach = () => {
				if (done) return false;
				done = true;
				cancelTimer();
				player.wrap.removeEventListener("transitionend", onEnd);
				cancelClosingMap.delete(player.wrap);
				if (closingByRow.get(player.row) === player) closingByRow.delete(player.row);
				return true;
			};
			const finish = () => {
				if (detach()) player.wrap.remove();
			};
			const onEnd = (e) => {
				if (e.target === player.wrap && e.propertyName === "grid-template-rows") finish();
			};
			cancelTimer = scheduleFallback(finish, COLLAPSE_FALLBACK_MS, timeout);
			player.wrap.addEventListener("transitionend", onEnd);
			cancelClosingMap.set(player.wrap, detach);
		}
		function toggleVideo(videoUrl, row) {
			const prev = active;
			if (prev && prev.row === row) {
				active = null;
				closePlayer(prev);
				return;
			}
			const reduced = prefersReducedMotion();
			const revived = closingByRow.get(row) || null;
			let next;
			if (revived) {
				cancelClosingMap.get(revived.wrap)?.();
				next = revived;
			} else {
				const { wrap, video } = createCollapsibleVideo(videoUrl);
				next = {
					wrap,
					video,
					row
				};
				if (row) row.insertAdjacentElement("afterend", next.wrap);
				else el.appendChild(next.wrap);
				if (!reduced) next.wrap.offsetHeight;
			}
			if (prev) closePlayer(prev);
			active = next;
			row?.classList.add("is-active");
			next.wrap.classList.add("is-open");
			Promise.resolve(next.video.play?.()).catch(() => {});
		}
		const versions = Array.isArray(song.versions) && song.versions.length > 1 ? song.versions : null;
		if (versions) {
			el.classList.add("has-versions");
			const list = document.createElement("div");
			list.className = "daiya-anisongs-versions";
			versions.forEach((v) => {
				const row = document.createElement("div");
				row.className = "daiya-anisong-version";
				const badge = document.createElement("span");
				badge.className = "daiya-anisong-version-tag";
				badge.textContent = v.label || (v.version != null ? `v${v.version}` : "");
				row.appendChild(badge);
				const metaParts = [];
				if (v.songTitle) metaParts.push(`"${v.songTitle}"`);
				if (v.episodes) metaParts.push(formatEpsTag(v.episodes));
				if (v.notes) metaParts.push(`— ${v.notes}`);
				if (metaParts.length) {
					const info = document.createElement("span");
					info.className = "daiya-anisong-version-meta";
					info.textContent = metaParts.join(" ");
					row.appendChild(info);
				}
				if (v.url) {
					const verUrl = v.url;
					row.classList.add("has-video");
					row.setAttribute("role", "button");
					row.tabIndex = 0;
					row.addEventListener("click", (e) => {
						if (e.target instanceof HTMLVideoElement) return;
						toggleVideo(verUrl, row);
					});
					row.addEventListener("keydown", (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							toggleVideo(verUrl, row);
						}
					});
				}
				list.appendChild(row);
			});
			el.appendChild(list);
			return el;
		}
		const url = song.url;
		if (!url) return el;
		el.classList.add("has-video");
		header.addEventListener("click", (e) => {
			if (e.target.closest(".daiya-anisong-actions")) return;
			if (e.target instanceof HTMLVideoElement) return;
			toggleVideo(url, null);
		});
		return el;
	}
	var INITIAL_VISIBLE_SONGS = 5;
	function getDocumentHeight() {
		if (typeof document === "undefined") return 0;
		return Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
	}
	function followElementWhileCollapsing(anchor, collapsible, startScrollY, startDocHeight, startAnchorDocTop, listen, timeout, onCleanup, raf, onFinish) {
		if (typeof window === "undefined" || typeof window.scrollBy !== "function") {
			onFinish?.();
			return () => {};
		}
		const stepScroll = () => {
			const docShrink = Math.max(0, startDocHeight - getDocumentHeight());
			if (docShrink <= .5) return;
			const currentAnchorDocTop = anchor.getBoundingClientRect().top + window.scrollY;
			const anchorShift = Math.max(0, startAnchorDocTop - currentAnchorDocTop);
			const delta = Math.max(0, startScrollY - Math.min(docShrink, anchorShift)) - window.scrollY;
			if (Math.abs(delta) > .5) window.scrollBy(0, delta);
		};
		if (prefersReducedMotion()) {
			stepScroll();
			onFinish?.();
			return () => {};
		}
		let cancelRaf = () => {};
		let active = true;
		let unlistenWheel = () => {};
		let unlistenTouch = () => {};
		let cancelTimer = () => {};
		const scheduleFrame = (fn) => {
			if (raf) return raf(fn);
			const id = requestAnimationFrame(fn);
			return () => cancelAnimationFrame(id);
		};
		const stop = () => {
			if (!active) return;
			active = false;
			cancelRaf();
			cancelRaf = () => {};
			cancelTimer();
			cancelTimer = () => {};
			collapsible.removeEventListener("transitionend", onEnd);
			unlistenWheel();
			unlistenWheel = () => {};
			unlistenTouch();
			unlistenTouch = () => {};
			onFinish?.();
		};
		const onEnd = (e) => {
			if (e.target === collapsible && e.propertyName === "grid-template-rows") {
				stepScroll();
				stop();
			}
		};
		const tick = () => {
			if (!active || !anchor.isConnected || !collapsible.isConnected) {
				stop();
				return;
			}
			stepScroll();
			cancelRaf = scheduleFrame(tick);
		};
		cancelTimer = scheduleFallback(() => {
			stepScroll();
			stop();
		}, COLLAPSE_FALLBACK_MS, timeout);
		collapsible.addEventListener("transitionend", onEnd);
		if (listen) {
			unlistenWheel = listen(window, "wheel", stop, {
				passive: true,
				once: true
			});
			unlistenTouch = listen(window, "touchstart", stop, {
				passive: true,
				once: true
			});
		}
		onCleanup?.(stop);
		cancelRaf = scheduleFrame(tick);
		return stop;
	}
	function createSongGroup(title, songs, activePresets, groupType, listen, timeout, onCleanup, raf) {
		const g = document.createElement("div");
		g.className = "daiya-anisongs-group";
		const h = document.createElement("h2");
		h.textContent = title;
		g.appendChild(h);
		if (!songs.length) {
			const empty = document.createElement("div");
			empty.className = "daiya-anisongs-empty";
			empty.textContent = "No songs to show (つ﹏<)･ﾟ｡";
			g.appendChild(empty);
			return g;
		}
		const initial = songs.slice(0, INITIAL_VISIBLE_SONGS);
		const rest = songs.slice(INITIAL_VISIBLE_SONGS);
		initial.forEach((s) => g.appendChild(createSongCard(s, activePresets, groupType, timeout)));
		if (!rest.length) return g;
		const extraWrap = document.createElement("div");
		extraWrap.className = "daiya-anisong-collapsible daiya-anisongs-extra";
		const extraInner = document.createElement("div");
		extraInner.className = "daiya-anisong-collapsible-inner";
		rest.forEach((s) => extraInner.appendChild(createSongCard(s, activePresets, groupType, timeout)));
		extraWrap.appendChild(extraInner);
		g.appendChild(extraWrap);
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "daiya-anisongs-toggle";
		const showAllLabel = `Show all (${songs.length})`;
		btn.textContent = showAllLabel;
		btn.setAttribute("aria-expanded", "false");
		let expanded = false;
		let stopFollow = null;
		let cleanupRegistered = false;
		const stopCurrentFollow = () => {
			stopFollow?.();
			stopFollow = null;
		};
		btn.addEventListener("click", () => {
			stopCurrentFollow();
			const startScrollY = typeof window !== "undefined" ? window.scrollY : 0;
			const startDocHeight = getDocumentHeight();
			const startBtnDocTop = btn.getBoundingClientRect().top + startScrollY;
			expanded = !expanded;
			if (!expanded) extraWrap.querySelectorAll("video").forEach((v) => v.pause?.());
			extraWrap.classList.toggle("is-open", expanded);
			btn.textContent = expanded ? "Show less" : showAllLabel;
			btn.setAttribute("aria-expanded", String(expanded));
			if (!expanded) {
				if (!cleanupRegistered && onCleanup) {
					cleanupRegistered = true;
					onCleanup(stopCurrentFollow);
				}
				stopFollow = followElementWhileCollapsing(btn, extraWrap, startScrollY, startDocHeight, startBtnDocTop, listen, timeout, void 0, raf, () => {
					stopFollow = null;
				});
			}
		});
		g.appendChild(btn);
		return g;
	}
	function extractSongParams(song, groupType = "OP") {
		let title = (song.title || "").trim();
		if (!title) {
			const m = song.name.match(/"([^"]+)"/);
			title = m ? m[1].trim() : song.name.replace(/^\d+\.\s*/, "").trim();
		}
		let artist = "";
		if (Array.isArray(song.artists) && song.artists.length) artist = song.artists.filter(Boolean).join(" ");
		else if (typeof song.artist === "string") artist = song.artist.trim();
		else {
			const m = song.name.match(/ by ([^(]+)/i);
			if (m) artist = m[1].trim();
		}
		const anime = (song.animeName || "").trim() || document.querySelector(".header h1")?.textContent?.trim() || document.querySelector("meta[property=\"og:title\"]")?.getAttribute("content")?.trim() || "";
		const type = song.type === "ED" || groupType === "ED" ? "ED" : "OP";
		const number = Number.isFinite(song.sequence) && song.sequence >= 1 ? Math.floor(song.sequence) : 1;
		return {
			title,
			title_romaji: song.title_romaji || title,
			title_jp: song.title_jp || title,
			artist,
			artists: Array.isArray(song.artists) && song.artists.length ? song.artists.join(", ") : artist,
			anime,
			anime_romaji: song.animeRomaji || anime,
			anime_en: song.animeEn || anime,
			anime_jp: song.animeJp || anime,
			year: song.year,
			season: song.season,
			type,
			number,
			eps: song.eps
		};
	}
	defineModule({
		id: "aniSongs",
		key: "aniSongsEnabled",
		section: "AniList Enhancements",
		layer: "feature",
		requiresReload: false,
		legacy: [
			"aniSongsEnabled",
			"animeThemeSongsEnabled",
			"anisongsEnabled"
		],
		title: "Anime Opening & Ending Songs",
		help: "Show OP/ED theme songs on anime pages.",
		debug: {
			debug: false,
			label: "AniSongs"
		},
		options: [{
			key: "aniSongsProviders",
			type: "json",
			def: DEFAULT_ANISONGS_CONFIG,
			title: "Song Search Providers",
			help: "Configure search shortcuts (YouTube, Spotify, etc.) and active music services.",
			validate: validateAniSongsConfig,
			editor: openAniSongsModal
		}],
		migrate(m) {
			m.legacy.del("daiya_anisongs_cache_v8");
		},
		setup(ctx) {
			const API = "https://rs.animethemes.moe/graphql";
			const ROOT = ctx.getId("root");
			const TTL = 6048e5;
			const EMPTY_TTL = 432e5;
			ctx.ownUi(`#${ROOT}`);
			ctx.addStyle(`
      #${ROOT}{width:100%;margin-top:30px}
      #${ROOT} .daiya-anisongs-columns{display:flex;gap:30px;width:100%}
      #${ROOT} .daiya-anisongs-group{flex:1 1 0;min-width:0}
      #${ROOT} h2{margin-top:0}
      #${ROOT} .daiya-anisong-entry{background:rgb(var(--color-foreground));border-radius:4px;padding:8px 10px;font-size:1.3rem;margin-bottom:10px;color:rgb(var(--color-text))}
      #${ROOT} .daiya-anisong-header{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%}
      #${ROOT} .daiya-anisong-title{flex:1 1 auto;min-width:0;word-break:break-word}
      #${ROOT} .daiya-anisong-entry.has-video .daiya-anisong-title{cursor:pointer}
      #${ROOT} .daiya-anisong-entry.has-video .daiya-anisong-title:hover{color:rgb(var(--color-blue));transition:color .15s}
      #${ROOT} .daiya-anisong-actions{display:inline-flex;align-items:center;gap:6px;flex-shrink:0}
      #${ROOT} .daiya-anisong-link{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:4px;background:rgba(var(--color-text-lighter),.08);padding:3px;transition:all .15s;text-decoration:none}
      #${ROOT} .daiya-anisong-link:hover{background:rgba(var(--color-blue),.2);transform:translateY(-1px)}
      #${ROOT} .daiya-anisong-icon{width:16px;height:16px;object-fit:contain;display:block;border-radius:2px}
      #${ROOT} .daiya-anisong-collapsible{display:grid;grid-template-rows:0fr;transition:grid-template-rows .22s cubic-bezier(0.4,0,0.2,1),visibility 0s .22s;visibility:hidden;overflow:hidden;overflow-anchor:none}
      #${ROOT} .daiya-anisong-collapsible.is-open{grid-template-rows:1fr;transition:grid-template-rows .22s cubic-bezier(0.4,0,0.2,1),visibility 0s 0s;visibility:visible}
      #${ROOT} .daiya-anisong-collapsible-inner{min-height:0;overflow:hidden}
      #${ROOT} .daiya-anisong-video-pad{padding-top:10px}
      #${ROOT} .daiya-anisongs-versions .daiya-anisong-video-pad{padding:4px 0 6px}
      #${ROOT} video{display:block;width:100%;max-width:39em;aspect-ratio:16/9;background:#000;border-radius:4px;cursor:auto}
      #${ROOT} .daiya-anisongs-versions{display:flex;flex-direction:column;margin-top:8px;padding-top:6px;border-top:1px solid rgba(var(--color-text-lighter),.15)}
      #${ROOT} .daiya-anisong-version{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;font-size:1.2rem;color:rgb(var(--color-text-lighter));transition:color .15s,background .15s}
      #${ROOT} .daiya-anisongs-versions>.daiya-anisong-version~.daiya-anisong-version{margin-top:4px}
      #${ROOT} .daiya-anisong-version-tag{font-weight:700;color:rgb(var(--color-text));white-space:nowrap}
      #${ROOT} .daiya-anisong-version.has-video{cursor:pointer}
      #${ROOT} .daiya-anisong-version.has-video:hover{color:rgb(var(--color-blue));background:rgba(var(--color-blue),.08)}
      #${ROOT} .daiya-anisong-version.has-video:hover .daiya-anisong-version-tag{color:rgb(var(--color-blue))}
      #${ROOT} .daiya-anisong-version.is-active{color:rgb(var(--color-blue));background:rgba(var(--color-blue),.14)}
      #${ROOT} .daiya-anisong-version.is-active .daiya-anisong-version-tag{color:rgb(var(--color-blue))}
      #${ROOT} .daiya-anisongs-toggle{display:block;width:100%;padding:7px 10px;border:0;border-radius:4px;background:rgb(var(--color-foreground));color:rgb(var(--color-text-lighter));font:inherit;font-size:1.2rem;font-weight:600;cursor:pointer;text-align:center;transition:color .15s,background .15s}
      #${ROOT} .daiya-anisongs-toggle:hover{color:rgb(var(--color-blue));background:rgba(var(--color-blue),.1)}
      #${ROOT} .daiya-anisongs-empty{text-align:center;opacity:.7;padding:10px}
      @media (max-width:700px){#${ROOT} .daiya-anisongs-columns{flex-direction:column;gap:10px}}
      @media (prefers-reduced-motion:reduce){#${ROOT} .daiya-anisong-collapsible,#${ROOT} .daiya-anisong-entry.has-video .daiya-anisong-title,#${ROOT} .daiya-anisong-link,#${ROOT} .daiya-anisong-version,#${ROOT} .daiya-anisongs-toggle{transition:none!important}}`);
			const cacheStore = ctx.persistent("daiya_anisongs_cache_v8", (d) => {
				for (const id of Object.keys(d)) if (!(Number(d[id]?.expires) > Date.now())) delete d[id];
			});
			const cache = cacheStore.data;
			const atQuery = `query ($id: [Int!]) {
      filterAnimeByExternalSite(site: ANILIST, id: $id) {
        title { romaji native }
        themes {
          type
          sequence
          group { name }
          song {
            title { romaji native }
            staff {
              role
              relevance
              alias
              as
              artist {
                name { main }
              }
            }
            resources {
              nodes {
                site
                link
              }
            }
          }
          entries {
            episodes
            version
            notes
            videos {
              nodes {
                link
                source
                basename
              }
            }
          }
        }
      }
    }`;
			let disposed = false;
			const inFlight = new Map();
			const loadThemes = (id, signal) => {
				const key = String(id);
				const hit = cache[key];
				if (hit && hit.expires > Date.now()) {
					if (signal?.aborted) return Promise.reject(createAbortError(signal));
					return Promise.resolve(hit.data);
				}
				const alQuery = `query ($id: Int, $type: MediaType) {
        Media(id: $id, type: $type) {
          title { userPreferred english romaji native }
          seasonYear
          season
        }
      }`;
				let flight = inFlight.get(key);
				if (!flight) {
					flight = createSharedFlight({
						start: async (flightSignal) => {
							const [themesRes, alRes] = await Promise.allSettled([ctx.http.json(API, {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									"User-Agent": "AL-Additions"
								},
								data: JSON.stringify({
									query: atQuery,
									variables: { id: [Number(id)] }
								}),
								signal: flightSignal
							}), ctx.api.query(alQuery, {
								id: Number(id),
								type: "ANIME"
							}, { signal: flightSignal })]);
							if (flightSignal.aborted || disposed) throw createAbortError(flightSignal);
							if (themesRes.status === "rejected") throw themesRes.reason;
							if (alRes.status === "rejected" && isAbortError(alRes.reason)) throw alRes.reason;
							const result = themesRes.value;
							if (Array.isArray(result?.errors) && result.errors.length && !Array.isArray(result?.data?.filterAnimeByExternalSite)) throw new Error(String(result.errors[0]?.message || "AnimeThemes GraphQL error"));
							const alOk = alRes.status === "fulfilled";
							const alMedia = alOk ? alRes.value?.Media : null;
							const rawAnime = Array.isArray(result?.data?.filterAnimeByExternalSite) ? result.data.filterAnimeByExternalSite[0] : null;
							const animeName = str(alMedia?.title?.userPreferred) || str(rawAnime?.title?.romaji) || str(rawAnime?.name) || document.querySelector(".header h1")?.textContent?.trim() || "";
							const data = groupThemes(rawAnime, {
								animeName,
								animeRomaji: str(alMedia?.title?.romaji) || str(rawAnime?.title?.romaji) || str(rawAnime?.name) || animeName,
								animeEn: str(alMedia?.title?.english) || animeName,
								animeJp: str(alMedia?.title?.native) || str(rawAnime?.title?.native) || "",
								year: alMedia?.seasonYear || rawAnime?.year || "",
								season: alMedia?.season || rawAnime?.season || ""
							});
							if (!disposed && !flightSignal.aborted && alOk) {
								const empty = !data.OP.length && !data.ED.length;
								cache[key] = {
									expires: Date.now() + (empty ? EMPTY_TTL : TTL),
									data
								};
								cacheStore.save();
							}
							return data;
						},
						onEvict: (f) => {
							if (inFlight.get(key) === f) inFlight.delete(key);
						},
						onSettled: (f) => {
							if (inFlight.get(key) === f) inFlight.delete(key);
						}
					});
					inFlight.set(key, flight);
				}
				return flight.wait({
					signal,
					check: () => {
						if (disposed) throw createAbortError(signal);
					}
				});
			};
			function buildRoot(state, listen, timeout, onCleanup, raf) {
				const config = getValidAniSongsConfig(ctx.get("aniSongsProviders"));
				const presetMap = new Map();
				config.presets.forEach((p) => presetMap.set(p.id, p));
				const activePresets = config.active.map((id) => presetMap.get(id)).filter(Boolean);
				const root = document.createElement("section");
				root.id = ROOT;
				root.dataset.animeId = state.id;
				const cols = document.createElement("div");
				cols.className = "daiya-anisongs-columns";
				cols.append(createSongGroup("Openings", state.themes.OP, activePresets, "OP", listen, timeout, onCleanup, raf), createSongGroup("Endings", state.themes.ED, activePresets, "ED", listen, timeout, onCleanup, raf));
				root.appendChild(cols);
				return root;
			}
			let backoff = {
				id: null,
				until: 0
			};
			ctx.onRoute(/^\/anime\/(\d+)(?:\/|$)/, async (rc) => {
				const id = rc.match[1];
				if (backoff.id === id && Date.now() < backoff.until) return;
				document.getElementById(ROOT)?.remove();
				const mine = {
					id,
					themes: null,
					busy: true
				};
				try {
					const themes = await loadThemes(id, rc.signal);
					if (rc.signal.aborted) return;
					if (!themes.OP.length && !themes.ED.length) return;
					mine.themes = themes;
					const overview = await rc.waitForSelector(".overview", 1e4);
					if (rc.signal.aborted || !overview) return;
					let mountCleanups = [];
					rc.mount({
						id: "root",
						anchor: ".overview",
						position: "beforeend",
						ownUi: true,
						create: () => {
							for (const fn of mountCleanups.splice(0)) fn();
							document.getElementById(ROOT)?.remove();
							return buildRoot(mine, rc.listen, rc.timeout, (fn) => mountCleanups.push(fn), rc.raf);
						},
						onMount: () => () => {
							for (const fn of mountCleanups.splice(0)) fn();
						}
					});
				} catch (err) {
					if (rc.signal.aborted || disposed || isAbortError(err)) return;
					ctx.log.error("Anisongs sync error:", err);
					backoff = {
						id,
						until: Date.now() + 3e4
					};
				} finally {
					mine.busy = false;
				}
			});
			ctx.onCleanup(() => {
				disposed = true;
				for (const flight of inFlight.values()) flight.controller.abort();
				inFlight.clear();
				document.getElementById(ROOT)?.remove();
			});
		}
	});
	var ICONS = {
		download: "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><polyline points=\"7 10 12 15 17 10\"/><line x1=\"12\" y1=\"15\" x2=\"12\" y2=\"3\"/>",
		check: "<polyline points=\"20 6 9 17 4 12\"/>",
		resync: "<polyline points=\"1 4 1 10 7 10\"/><path d=\"M3.51 15a9 9 0 1 0 2.13-9.36L1 10\"/>",
		stop: "<rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\" fill=\"currentColor\"/>",
		list: "<line x1=\"8\" y1=\"6\" x2=\"21\" y2=\"6\"/><line x1=\"8\" y1=\"12\" x2=\"21\" y2=\"12\"/><line x1=\"8\" y1=\"18\" x2=\"21\" y2=\"18\"/><line x1=\"3\" y1=\"6\" x2=\"3.01\" y2=\"6\"/><line x1=\"3\" y1=\"12\" x2=\"3.01\" y2=\"12\"/><line x1=\"3\" y1=\"18\" x2=\"3.01\" y2=\"18\"/>",
		sliders: "<line x1=\"4\" y1=\"21\" x2=\"4\" y2=\"14\"/><line x1=\"4\" y1=\"10\" x2=\"4\" y2=\"3\"/><line x1=\"12\" y1=\"21\" x2=\"12\" y2=\"12\"/><line x1=\"12\" y1=\"8\" x2=\"12\" y2=\"3\"/><line x1=\"20\" y1=\"21\" x2=\"20\" y2=\"16\"/><line x1=\"20\" y1=\"12\" x2=\"20\" y2=\"3\"/><line x1=\"1\" y1=\"14\" x2=\"7\" y2=\"14\"/><line x1=\"9\" y1=\"8\" x2=\"15\" y2=\"8\"/><line x1=\"17\" y1=\"16\" x2=\"23\" y2=\"16\"/>",
		close: "<line x1=\"18\" y1=\"6\" x2=\"6\" y2=\"18\"/><line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"/>",
		edit: "<path d=\"M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z\"/>",
		external: "<path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\"/><polyline points=\"15 3 21 3 21 9\"/><line x1=\"10\" y1=\"14\" x2=\"21\" y2=\"3\"/>",
		chevron: "<polyline points=\"6 9 12 15 18 9\"/>"
	};
	var icon = (name, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
	function findExactText(text) {
		if (!document.body) return null;
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let t; t = walker.nextNode();) {
			if (t.nodeValue?.trim() !== text || !t.parentElement) continue;
			let el = t.parentElement;
			while (el.parentElement && el.parentElement !== document.body && el.parentElement.textContent?.trim() === text) el = el.parentElement;
			return el;
		}
		return null;
	}
	function safeDecodeURIComponent$1(raw) {
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}
	function sanitizeBannerSlug(raw) {
		const sanitized = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
		if (!sanitized || sanitized === "." || sanitized === "..") return "anilist";
		return sanitized;
	}
	defineModule({
		id: "banner",
		key: "bannerEnabled",
		section: "External Links, Downloads & Mappings",
		layer: "feature",
		requiresReload: false,
		legacy: [
			"bannerEnabled",
			"bannerDownloadEnabled",
			"bannerDownloaderEnabled"
		],
		title: "Anime/Manga Banner Downloader",
		help: "Add a button for downloading the AniList banner image.",
		options: [{
			key: "bannerProfiles",
			type: "toggle",
			def: false,
			title: "User Profile Banners",
			help: "Also show the download button on user profile banners (it is always shown on anime and manga pages)."
		}],
		setup(ctx) {
			ctx.addStyle(`
      .banner{position:relative}
      .ala-banner-dl{position:absolute;right:12px;bottom:12px;z-index:5;display:inline-flex;align-items:center;justify-content:center;height:34px;min-width:34px;padding:0 8px;border:0;border-radius:17px;background:transparent;color:rgba(255,255,255,.8);font-family:inherit;font-size:12px;font-weight:600;line-height:1;cursor:pointer;overflow:hidden;-webkit-tap-highlight-color:transparent;transition:background .15s,color .15s}
      .ala-banner-dl[hidden]{display:none}
      .ala-banner-ico{display:inline-flex;filter:drop-shadow(0 1px 3px rgba(0,0,0,.7))}
      .ala-banner-lbl{max-width:0;overflow:hidden;white-space:nowrap;transition:max-width .2s ease,margin-left .2s ease}
      .ala-banner-dl:hover,.ala-banner-dl:focus-visible{background:rgb(var(--color-blue));color:#fff}
      .ala-banner-dl:hover .ala-banner-ico,.ala-banner-dl:focus-visible .ala-banner-ico,.ala-banner-dl.is-done .ala-banner-ico{filter:none}
      .ala-banner-dl:focus-visible{outline:2px solid #fff;outline-offset:2px}
      .ala-banner-dl.is-done,.ala-banner-dl.is-done:hover{background:rgb(var(--color-green));color:#fff}
      .ala-banner-dl.is-done .ala-banner-lbl{max-width:130px;margin-left:7px}
      @media (hover:hover){.ala-banner-dl:hover .ala-banner-lbl,.ala-banner-dl:focus-visible .ala-banner-lbl{max-width:130px;margin-left:7px}}
      @media (pointer:coarse){.ala-banner-dl{right:8px;bottom:8px;height:40px;min-width:40px;border-radius:20px}}
      @media (prefers-reduced-motion:reduce){.ala-banner-lbl{transition:none}}`);
			const BANNER_SEL = ".banner";
			const bannerUrl = (banner) => (banner.style.backgroundImage || getComputedStyle(banner).backgroundImage).match(/url\((['"]?)(.*?)\1\)/)?.[2] || null;
			ctx.onRoute(/^\/(?:(anime|manga)\/(\d+)|user\/([^/?#]+))(?:\/|$)/, (rc) => {
				const mediaId = rc.match?.[2];
				const userSeg = rc.match?.[3];
				if (userSeg && !ctx.get("bannerProfiles")) return;
				const slug = sanitizeBannerSlug(mediaId || (userSeg ? safeDecodeURIComponent$1(userSeg) : "anilist"));
				let mountHandle = null;
				let currentBanner = null;
				let currentBannerUrl = null;
				function createButton() {
					const btn = document.createElement("button");
					btn.type = "button";
					btn.className = "ala-banner-dl";
					btn.title = "Download banner image";
					btn.setAttribute("aria-label", "Download banner image");
					btn.innerHTML = `<span class="ala-banner-ico">${icon("download", 18)}</span><span class="ala-banner-lbl">Download banner</span>`;
					const ico = btn.firstElementChild;
					const lbl = btn.lastElementChild;
					let cancelResetTimer = null;
					let downloading = false;
					btn.addEventListener("click", (e) => {
						e.preventDefault();
						e.stopPropagation();
						if (rc.signal.aborted || !btn.isConnected || downloading) return;
						const banner = btn.closest(BANNER_SEL) || document.querySelector(BANNER_SEL);
						const url = banner ? bannerUrl(banner) : null;
						if (!url) return;
						const ext = (url.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i)?.[1] || "jpg").toLowerCase();
						downloading = true;
						rc.http.download(url, `anilist-banner-${slug}.${ext}`).then((outcome) => {
							downloading = false;
							if (rc.signal.aborted || !btn.isConnected || !outcome) return;
							btn.classList.add("is-done");
							ico.innerHTML = icon("check", 18);
							lbl.textContent = outcome === "tab" ? "Opened" : "Saved";
							cancelResetTimer?.();
							cancelResetTimer = rc.timeout(() => {
								cancelResetTimer = null;
								if (rc.signal.aborted || !btn.isConnected) return;
								btn.classList.remove("is-done");
								ico.innerHTML = icon("download", 18);
								lbl.textContent = "Download banner";
							}, 1600);
						}).catch((err) => {
							downloading = false;
							if (rc.signal.aborted || isAbortError(err)) return;
							ctx.log.warn("Failed to download banner image:", err);
							ctx.toast.error("Failed to download banner image.");
						});
					});
					return btn;
				}
				const sync = () => {
					if (rc.signal.aborted) return;
					const banner = document.querySelector(BANNER_SEL);
					const url = banner ? bannerUrl(banner) : null;
					if (!banner || !url) {
						currentBanner = null;
						currentBannerUrl = null;
						if (mountHandle) {
							mountHandle.unmount();
							mountHandle = null;
						}
						return;
					}
					if (mountHandle && !mountHandle.el()?.isConnected) {
						mountHandle.unmount();
						mountHandle = null;
					}
					if (!mountHandle || currentBanner !== banner || currentBannerUrl !== url) {
						mountHandle?.unmount();
						currentBanner = banner;
						currentBannerUrl = url;
						mountHandle = rc.mount({
							id: "dl",
							anchor: () => document.querySelector(BANNER_SEL),
							position: "beforeend",
							ownUi: true,
							match: () => {
								const b = document.querySelector(BANNER_SEL);
								return !!(b && bannerUrl(b));
							},
							create: createButton
						});
					}
				};
				const scheduleSync = rc.debounce(sync, 50);
				sync();
				rc.timeout(sync, 300);
				rc.onBodyMutation(scheduleSync);
				rc.ready(() => {
					if (document.body) rc.observe(document.body, {
						attributes: true,
						attributeFilter: ["style", "class"],
						subtree: true
					}, (records) => {
						if (rc.signal.aborted) return;
						for (const r of records) {
							const target = r.target;
							if (target === currentBanner || target instanceof Element && target.classList.contains("banner")) {
								scheduleSync();
								return;
							}
						}
					});
				});
				rc.onCleanup(() => {
					mountHandle?.unmount();
					mountHandle = null;
					currentBanner = null;
					currentBannerUrl = null;
				});
			});
		}
	});
	var COMPARE_CSS = `
      .content.container.ala-compare-page-container {
        padding-left: 18px !important;
        padding-right: 18px !important;
        max-width: calc(100% - 36px) !important;
        width: 100% !important;
        box-sizing: border-box !important;
      }
      .ala-compare-wrap {
        display: flex;
        gap: 20px;
        align-items: flex-start;
        width: 100%;
        box-sizing: border-box;
        margin-top: 30px;
      }
      .ala-compare-sidebar {
        flex: 0 0 170px;
        width: 170px;
        box-sizing: border-box;
        position: sticky;
        top: 85px;
        z-index: 10;
      }
      .ala-compare-main {
        flex: 1 1 0%;
        min-width: 0;
      }
      .ala-compare-main .compare {
        margin-top: 0 !important;
      }
      .ala-compare-card {
        background: rgb(var(--color-foreground));
        border-radius: 6px;
        padding: 14px 16px;
        color: rgb(var(--color-text));
        font-size: 1.3rem;
        box-shadow: 0 2px 8px rgba(0,0,0,.15);
        box-sizing: border-box;
      }
      .ala-compare-card-title {
        font-size: 1.35rem;
        font-weight: 600;
        margin-bottom: 12px;
        color: rgb(var(--color-text));
        display: flex;
        align-items: center;
        justify-content: space-between;
        user-select: none;
      }
      .ala-compare-card-title::-webkit-details-marker {
        display: none;
      }
      .ala-compare-arrow-icon {
        display: none;
      }
      .ala-compare-active-badge {
        display: none;
        font-size: 1.15rem;
        font-weight: 400;
        color: rgb(var(--color-text-lighter));
        margin-left: auto;
        margin-right: 8px;
      }
      .ala-compare-status-list {
        display: flex;
        flex-direction: column;
        gap: 9px;
      }
      .ala-compare-status-item {
        display: flex;
        align-items: center;
        gap: 9px;
        cursor: pointer;
        user-select: none;
        transition: color .15s ease;
        font-size: 1.3rem;
      }
      .ala-compare-status-item:hover {
        color: rgb(var(--color-blue));
      }
      .ala-compare-cb {
        accent-color: rgb(var(--color-blue));
        width: 15px;
        height: 15px;
        margin: 0;
        cursor: pointer;
      }
      .ala-compare-cb-label {
        flex: 1 1 auto;
      }
      .ala-compare-count {
        font-size: 1.15rem;
        color: rgb(var(--color-text-lighter));
      }
      .ala-compare-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid rgba(var(--color-text-lighter), .15);
        font-size: 1.2rem;
      }
      .ala-compare-btn-link {
        background: transparent;
        border: 0;
        padding: 0;
        color: rgb(var(--color-text-lighter));
        font: inherit;
        cursor: pointer;
        transition: color .15s ease;
      }
      .ala-compare-btn-link:hover {
        color: rgb(var(--color-blue));
      }
      .ala-compare-dot {
        color: rgb(var(--color-text-lighter));
        opacity: .5;
      }
      .ala-compare-load-indicator {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid rgba(var(--color-text-lighter), .12);
        font-size: 1.15rem;
        color: rgb(var(--color-text-lighter));
        display: flex;
        align-items: center;
        gap: 7px;
      }
      .ala-compare-spinner {
        width: 12px;
        height: 12px;
        border: 2px solid rgba(var(--color-text-lighter), .25);
        border-top-color: rgb(var(--color-blue));
        border-radius: 50%;
        animation: ala-compare-spin .7s linear infinite;
        flex-shrink: 0;
        display: inline-block;
      }
      @keyframes ala-compare-spin {
        to { transform: rotate(360deg); }
      }
      .ala-compare-empty {
        padding: 40px 20px;
        text-align: center;
        color: rgb(var(--color-text-lighter));
        font-size: 1.4rem;
        background: rgb(var(--color-foreground));
        border-radius: 4px;
        margin-top: 12px;
      }
      .compare .entry {
        display: flex !important;
        align-items: stretch !important;
      }
      .compare .entry.ala-hidden {
        display: none !important;
      }
      .compare .entry > div {
        flex: 1 1 0% !important;
        min-width: 0 !important;
        box-sizing: border-box !important;
      }
      .compare .entry > div.title {
        flex: 3.5 3.5 0% !important;
        min-width: 0 !important;
      }
      .entry.header > div {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .entry.header > div.title {
        justify-content: flex-start;
      }
      @media (max-width: 760px) {
        .entry.header > div.status,
        .entry .status {
          display: none !important;
        }
      }
      .ala-header-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        max-width: 100%;
      }
      .entry.header > div.title .ala-header-wrap {
        justify-content: flex-start;
      }
      .ala-header-label {
        line-height: 1.25;
        text-align: center;
        word-break: break-word;
      }
      .entry.header > div.title .ala-header-label {
        text-align: left;
      }
      .ala-sortable-header {
        cursor: pointer;
        user-select: none;
        transition: background-color .15s ease;
        border-radius: 3px;
      }
      .ala-sortable-header:hover {
        background-color: var(--ala-header-hover-bg, rgba(255, 255, 255, 0.18)) !important;
      }
      .ala-sort-arrow {
        position: absolute;
        left: 100%;
        top: 50%;
        transform: translateY(-50%);
        margin-left: 4px;
        font-size: 11px;
        color: inherit;
        opacity: 0.85;
        user-select: none;
        pointer-events: none;
        white-space: nowrap;
      }

      @media (min-width: 851px) {
        .ala-compare-card-title {
          pointer-events: none;
        }
        .ala-compare-card > .ala-compare-content {
          display: block !important;
        }
      }

      @media (max-width: 850px) {
        .content.container.ala-compare-page-container {
          padding-left: 10px !important;
          padding-right: 10px !important;
          max-width: calc(100% - 20px) !important;
        }
        .ala-compare-wrap {
          flex-direction: column;
          gap: 16px;
          margin-top: 18px;
        }
        .ala-compare-sidebar {
          width: 100%;
          flex: none;
          position: static;
        }
        .ala-compare-card {
          padding: 0;
          overflow: hidden;
        }
        .ala-compare-card-title {
          padding: 12px 14px;
          margin-bottom: 0;
          cursor: pointer;
        }
        .ala-compare-active-badge {
          display: inline-block;
        }
        .ala-compare-arrow-icon {
          display: inline-block;
          font-size: 10px;
          transition: transform .2s ease;
          opacity: .7;
        }
        .ala-compare-card[open] .ala-compare-arrow-icon {
          transform: rotate(180deg);
        }
        .ala-compare-content {
          padding: 10px 14px 14px;
          border-top: 1px solid rgba(var(--color-text-lighter), .12);
        }
        .ala-compare-status-list {
          flex-direction: column;
          gap: 10px;
        }
      }
    `;
	var STATUSES = [
		"Completed",
		"Planning",
		"Current",
		"Paused",
		"Dropped"
	];
	function createCompareState() {
		return {
			activeSortCol: "otherScore",
			activeSortDir: "desc",
			activeStatuses: new Set(STATUSES),
			lastProcessedCount: -1,
			currentRoute: "",
			isLoadingAll: false,
			isCompareLoaded: false,
			loadFailed: false,
			isMutatingDOM: false,
			disposed: false,
			loadAbortState: null,
			headerCleanup: null,
			prefetchRelease: null
		};
	}
	function resetCompareFilters(state) {
		state.activeSortCol = "otherScore";
		state.activeSortDir = "desc";
		for (const s of STATUSES) state.activeStatuses.add(s);
	}
	var isComparePage = () => /\/(animelist|mangalist)\/compare/i.test(location.pathname);
	function normalizeStatus(raw) {
		const s = (raw || "").trim().toLowerCase();
		if (s.includes("plan")) return "Planning";
		if (s.includes("complete")) return "Completed";
		if (s.includes("current") || s.includes("watch") || s.includes("read") || s.includes("repeat")) return "Current";
		if (s.includes("pause") || s.includes("hold")) return "Paused";
		if (s.includes("drop")) return "Dropped";
		return raw ? raw.trim() : "Planning";
	}
	var readScore = (el) => {
		const attr = el?.getAttribute("score");
		const parsed = attr ? parseFloat(attr) : parseFloat(el?.textContent?.replace(/[^\d.]/g, "") || "0");
		return Number.isFinite(parsed) ? parsed : 0;
	};
	function getEntryData(el) {
		const cached = el._alaCompareData;
		if (cached) return cached;
		const title = (el.querySelector(".title a, .title")?.textContent || "").trim();
		const scores = el.querySelectorAll(".score");
		const yourScoreEl = el.querySelector(".score[label=\"Score\"]") || scores[0];
		const otherScoreEl = Array.from(scores).find((s) => s !== yourScoreEl) || scores[1];
		const statuses = el.querySelectorAll(".status");
		const yourStatusEl = el.querySelector(".status[label=\"Your Status\"]") || statuses[0];
		const otherStatusEl = Array.from(statuses).find((s) => s !== yourStatusEl) || statuses[1];
		const data = {
			el,
			title,
			yourScore: readScore(yourScoreEl),
			otherScore: readScore(otherScoreEl),
			yourStatus: normalizeStatus(yourStatusEl?.textContent || ""),
			otherStatus: normalizeStatus(otherStatusEl?.textContent || "")
		};
		el._alaCompareData = data;
		return data;
	}
	function compareEntries(a, b, col, dir) {
		if (col === "title") {
			const cmp = a.title.localeCompare(b.title, void 0, {
				numeric: true,
				sensitivity: "base"
			});
			return dir === "asc" ? cmp : -cmp;
		}
		const aVal = col === "yourScore" ? a.yourScore : a.otherScore;
		const bVal = col === "yourScore" ? b.yourScore : b.otherScore;
		if (aVal !== bVal) return dir === "asc" ? aVal - bVal : bVal - aVal;
		return a.title.localeCompare(b.title, void 0, {
			numeric: true,
			sensitivity: "base"
		});
	}
	function cleanHeaderText(raw) {
		return raw.replace(/[▲▼]/g, "").trim();
	}
	function disableNativeScrollers(listContainer) {
		(listContainer?.parentElement || listContainer || document).querySelectorAll(".scroller").forEach((el) => {
			try {
				const v = el.__vue__;
				if (v) {
					if (typeof v.check === "function") {
						window.removeEventListener("scroll", v.check);
						window.removeEventListener("resize", v.check);
						v._scrollContainer?.removeEventListener?.("scroll", v.check);
						v._scrollContainer?.removeEventListener?.("resize", v.check);
					}
					v.execute = () => {};
					v.handler = () => {};
					if (v.$parent) {
						v.$parent.complete = true;
						v.$parent.loading = false;
					}
					v.$destroy?.();
				}
			} catch {}
			el.remove();
		});
	}
	function updateHeaderHoverColor() {
		const testEl = document.createElement("div");
		testEl.style.color = "rgb(var(--color-blue))";
		document.body.appendChild(testEl);
		const computedColor = getComputedStyle(testEl).color;
		testEl.remove();
		const m = computedColor.match(/\d+/g);
		let isLight = false;
		if (m && m.length >= 3) {
			const r = parseInt(m[0], 10);
			const g = parseInt(m[1], 10);
			const b = parseInt(m[2], 10);
			isLight = (r * 299 + g * 587 + b * 114) / 1e3 > 155;
		}
		const hoverBg = isLight ? "rgba(0, 0, 0, 0.16)" : "rgba(255, 255, 255, 0.18)";
		document.documentElement.style.setProperty("--ala-header-hover-bg", hoverBg);
	}
	function renderHeaderContent(el, baseText, isActive, activeDir) {
		const clean = cleanHeaderText(baseText);
		let wrap = el.querySelector(".ala-header-wrap");
		if (!wrap) {
			wrap = document.createElement("div");
			wrap.className = "ala-header-wrap";
			el.innerHTML = "";
			el.appendChild(wrap);
		}
		let label = wrap.querySelector(".ala-header-label");
		if (!label) {
			label = document.createElement("span");
			label.className = "ala-header-label";
			wrap.appendChild(label);
		}
		label.textContent = clean;
		let arrow = wrap.querySelector(".ala-sort-arrow");
		if (isActive) {
			if (!arrow) {
				arrow = document.createElement("span");
				arrow.className = "ala-sort-arrow";
				wrap.appendChild(arrow);
			}
			arrow.textContent = activeDir === "asc" ? "▲" : "▼";
		} else arrow?.remove();
	}
	function updateSortArrows(titleEl, yourScoreEl, otherScoreEl, activeCol, activeDir) {
		updateHeaderHoverColor();
		const items = [
			[titleEl, "title"],
			[yourScoreEl, "yourScore"],
			[otherScoreEl, "otherScore"]
		];
		for (const [el, col] of items) {
			if (!el) continue;
			el.classList.add("ala-sortable-header");
			if (!el._alaBaseText) el._alaBaseText = cleanHeaderText(el.textContent || "");
			const baseText = el._alaBaseText;
			renderHeaderContent(el, baseText, col === activeCol, activeDir);
		}
	}
	function applyFilter(state, listContainer, entries) {
		let visibleCount = 0;
		for (const el of entries) {
			const d = getEntryData(el);
			const show = state.activeStatuses.has(d.yourStatus) && state.activeStatuses.has(d.otherStatus);
			el.classList.toggle("ala-hidden", !show);
			el.style.display = "";
			if (show) visibleCount++;
		}
		let emptyEl = listContainer.querySelector(".ala-compare-empty");
		if (visibleCount === 0 && entries.length > 0) {
			if (!emptyEl) {
				emptyEl = document.createElement("div");
				emptyEl.className = "ala-compare-empty";
				emptyEl.textContent = "No entries match the selected status filters.";
				listContainer.appendChild(emptyEl);
			}
			emptyEl.style.display = "";
		} else if (emptyEl) emptyEl.style.display = "none";
	}
	function applySort(state, listContainer, entries, col, dir) {
		if (entries.length > 0) listContainer.querySelector(".no-results")?.remove();
		entries.sort((a, b) => compareEntries(getEntryData(a), getEntryData(b), col, dir));
		const frag = document.createDocumentFragment();
		for (const el of entries) frag.appendChild(el);
		state.isMutatingDOM = true;
		try {
			listContainer.appendChild(frag);
			const emptyEl = listContainer.querySelector(".ala-compare-empty");
			if (emptyEl) listContainer.appendChild(emptyEl);
		} finally {
			state.isMutatingDOM = false;
		}
	}
	function updateStatusCounts(state, sidebar, entries) {
		const counts = {
			Completed: 0,
			Planning: 0,
			Current: 0,
			Paused: 0,
			Dropped: 0
		};
		for (const el of entries) {
			const d = getEntryData(el);
			const counted = new Set([d.yourStatus, d.otherStatus]);
			for (const s of counted) if (s in counts) counts[s]++;
		}
		sidebar.querySelectorAll(".ala-compare-count").forEach((span) => {
			const status = span.dataset.status;
			if (status && status in counts) span.textContent = String(counts[status]);
		});
		const badge = sidebar.querySelector(".ala-compare-active-badge");
		if (badge) badge.textContent = `${state.activeStatuses.size}/${STATUSES.length}`;
	}
	function setLoadIndicator(sidebar, text) {
		let indicator = sidebar.querySelector("#ala-compare-load-indicator");
		if (!text) {
			indicator?.remove();
			return;
		}
		if (!indicator) {
			indicator = document.createElement("div");
			indicator.id = "ala-compare-load-indicator";
			indicator.className = "ala-compare-load-indicator";
			indicator.innerHTML = `
      <span class="ala-compare-spinner"></span>
      <span class="ala-compare-load-text"></span>
    `;
			(sidebar.querySelector(".ala-compare-content") || sidebar.querySelector(".ala-compare-card"))?.appendChild(indicator);
		}
		indicator.style.display = "flex";
		const textEl = indicator.querySelector(".ala-compare-load-text");
		if (textEl) textEl.textContent = text;
	}
	function getActiveCompareContainer(fallback) {
		return document.getElementById("ala-compare-table") || fallback || document.querySelector(".ala-compare-main .compare") || null;
	}
	function triggerFilterUpdate(state, sidebar, fallback) {
		const badge = sidebar.querySelector(".ala-compare-active-badge");
		if (badge) badge.textContent = `${state.activeStatuses.size}/${STATUSES.length}`;
		const target = getActiveCompareContainer(fallback);
		if (!target) return;
		applyFilter(state, target, Array.from(target.querySelectorAll(".entry:not(.header)")));
	}
	function triggerSort(state, col, fallback) {
		if (state.activeSortCol === col) state.activeSortDir = state.activeSortDir === "asc" ? "desc" : "asc";
		else {
			state.activeSortCol = col;
			state.activeSortDir = col === "title" ? "asc" : "desc";
		}
		const target = getActiveCompareContainer(fallback);
		if (!target) return;
		const currentHeader = target.querySelector(".entry.header");
		if (currentHeader) {
			const titleH = currentHeader.querySelector(".title");
			const scores = currentHeader.querySelectorAll(".score");
			updateSortArrows(titleH, scores[0] || null, scores[1] || null, state.activeSortCol, state.activeSortDir);
		}
		applySort(state, target, Array.from(target.querySelectorAll(".entry:not(.header)")), state.activeSortCol, state.activeSortDir);
	}
	function cleanupCompareView(state) {
		if (state.prefetchRelease) {
			state.prefetchRelease();
			state.prefetchRelease = null;
		}
		if (state.loadAbortState) {
			state.loadAbortState.abort = true;
			state.loadAbortState = null;
		}
		state.isLoadingAll = false;
		state.isCompareLoaded = false;
		state.loadFailed = false;
		state.isMutatingDOM = false;
		if (state.headerCleanup) {
			state.headerCleanup();
			state.headerCleanup = null;
		}
		document.getElementById("ala-compare-table")?.remove();
		const wrap = document.getElementById("ala-compare-wrap");
		if (wrap) {
			const main = wrap.querySelector(".ala-compare-main");
			const compareRoot = main?.querySelector(".compare:not(#ala-compare-table)") || main?.firstElementChild;
			if (compareRoot) {
				if (compareRoot.dataset) delete compareRoot.dataset.alaCompareInit;
				if (compareRoot.style) compareRoot.style.display = "";
				if (wrap.parentElement) wrap.parentElement.insertBefore(compareRoot, wrap);
			}
			wrap.remove();
		} else {
			const compareRoot = document.querySelector(".compare:not(#ala-compare-table)");
			if (compareRoot) {
				delete compareRoot.dataset.alaCompareInit;
				compareRoot.style.display = "";
			}
		}
		document.querySelectorAll(".ala-compare-page-container").forEach((el) => {
			el.classList.remove("ala-compare-page-container");
		});
		document.querySelectorAll(".compare .entry.ala-hidden").forEach((el) => {
			el.classList.remove("ala-hidden");
		});
		const header = document.querySelector(".compare:not(#ala-compare-table) .entry.header, .entry.header");
		if (header) {
			delete header._alaHeaderBound;
			delete header.dataset.alaCompareInit;
			header.querySelectorAll(".ala-sortable-header").forEach((el) => {
				el.classList.remove("ala-sortable-header");
				const baseText = el._alaBaseText;
				if (baseText) el.textContent = cleanHeaderText(baseText);
				delete el._alaBaseText;
			});
			header.querySelectorAll(".status").forEach((el) => {
				const label = el.querySelector(".ala-header-label");
				if (label) el.textContent = label.textContent || "";
			});
		}
		state.lastProcessedCount = -1;
	}
	function renderSidebarCard(rc, state, sidebar, compareRoot) {
		if (sidebar.querySelector(".ala-compare-card")) return;
		sidebar.innerHTML = `
    <details class="ala-compare-card" ${window.innerWidth <= 850 ? "" : "open"}>
      <summary class="ala-compare-card-title">
        <span>Status Filter</span>
        <span class="ala-compare-active-badge">${state.activeStatuses.size}/${STATUSES.length}</span>
        <span class="ala-compare-arrow-icon">▼</span>
      </summary>
      <div class="ala-compare-content">
        <div class="ala-compare-status-list">
          ${STATUSES.map((s) => `
            <label class="ala-compare-status-item">
              <input type="checkbox" class="ala-compare-cb" data-status="${s}" ${state.activeStatuses.has(s) ? "checked" : ""}>
              <span class="ala-compare-cb-label">${s}</span>
              <span class="ala-compare-count" data-status="${s}">0</span>
            </label>`).join("")}
        </div>
        <div class="ala-compare-actions">
          <button type="button" class="ala-compare-btn-link" id="ala-compare-all">Select all</button>
          <span class="ala-compare-dot">·</span>
          <button type="button" class="ala-compare-btn-link" id="ala-compare-none">Clear all</button>
        </div>
      </div>
    </details>
  `;
		const details = sidebar.querySelector(".ala-compare-card");
		sidebar.querySelector(".ala-compare-card-title")?.addEventListener("click", (e) => {
			if (window.innerWidth > 850) {
				e.preventDefault();
				if (details) details.open = true;
			}
		});
		let isDesktop = window.innerWidth > 850;
		const syncDetailsOpen = () => {
			if (!details) return;
			const nowDesktop = window.innerWidth > 850;
			if (nowDesktop !== isDesktop) {
				details.open = nowDesktop;
				isDesktop = nowDesktop;
			}
		};
		rc.listen(window, "resize", syncDetailsOpen);
		sidebar.querySelectorAll(".ala-compare-cb").forEach((cb) => {
			cb.addEventListener("change", () => {
				const st = cb.dataset.status;
				if (cb.checked) state.activeStatuses.add(st);
				else state.activeStatuses.delete(st);
				triggerFilterUpdate(state, sidebar, compareRoot);
			});
		});
		sidebar.querySelector("#ala-compare-all")?.addEventListener("click", () => {
			for (const s of STATUSES) state.activeStatuses.add(s);
			sidebar.querySelectorAll(".ala-compare-cb").forEach((cb) => cb.checked = true);
			triggerFilterUpdate(state, sidebar, compareRoot);
		});
		sidebar.querySelector("#ala-compare-none")?.addEventListener("click", () => {
			state.activeStatuses.clear();
			sidebar.querySelectorAll(".ala-compare-cb").forEach((cb) => cb.checked = false);
			triggerFilterUpdate(state, sidebar, compareRoot);
		});
	}
	function findCompareHeaders(header) {
		const headerCells = header ? Array.from(header.children) : [];
		if (headerCells.length < 3) return {
			titleHeader: null,
			yourScoreHeader: null,
			otherScoreHeader: null
		};
		const titleHeader = header.querySelector(".title") || headerCells.find((el) => /title/i.test(el.textContent || "")) || headerCells[0];
		const yourScoreHeader = headerCells.find((el) => /your score/i.test(el.textContent || "")) || header.querySelector(".score:first-of-type") || headerCells[1];
		return {
			titleHeader,
			yourScoreHeader,
			otherScoreHeader: headerCells.find((el) => el !== yourScoreHeader && /score/i.test(el.textContent || "")) || header.querySelectorAll(".score")[1] || headerCells[2]
		};
	}
	function setupCompareView(rc, state, compareRoot, header, entries, onReadyToLoad) {
		if (header) header.querySelectorAll(".status").forEach((statusEl) => {
			if (!statusEl.querySelector(".ala-header-label")) {
				const text = statusEl.textContent?.trim() || "";
				const label = document.createElement("span");
				label.className = "ala-header-label";
				label.textContent = text;
				statusEl.textContent = "";
				statusEl.appendChild(label);
			}
		});
		const { titleHeader, yourScoreHeader, otherScoreHeader } = findCompareHeaders(header);
		const container = compareRoot.closest(".content.container") || compareRoot.parentElement;
		if (container) container.classList.add("ala-compare-page-container");
		let wrap = document.getElementById("ala-compare-wrap");
		let sidebar = document.getElementById("ala-compare-sidebar");
		if (!wrap || !wrap.contains(compareRoot)) {
			wrap?.remove();
			wrap = document.createElement("div");
			wrap.id = "ala-compare-wrap";
			wrap.className = "ala-compare-wrap";
			sidebar = document.createElement("aside");
			sidebar.id = "ala-compare-sidebar";
			sidebar.className = "ala-compare-sidebar";
			const main = document.createElement("div");
			main.className = "ala-compare-main";
			compareRoot.parentElement?.insertBefore(wrap, compareRoot);
			wrap.appendChild(sidebar);
			wrap.appendChild(main);
			main.appendChild(compareRoot);
		}
		if (sidebar) {
			renderSidebarCard(rc, state, sidebar, compareRoot);
			if (entries.length > 0) updateStatusCounts(state, sidebar, entries);
		}
		if (header && titleHeader && yourScoreHeader && otherScoreHeader && !header._alaHeaderBound) {
			state.headerCleanup?.();
			header._alaHeaderBound = true;
			const onTitleClick = () => triggerSort(state, "title", compareRoot);
			const onYourScoreClick = () => triggerSort(state, "yourScore", compareRoot);
			const onOtherScoreClick = () => triggerSort(state, "otherScore", compareRoot);
			titleHeader.addEventListener("click", onTitleClick);
			yourScoreHeader.addEventListener("click", onYourScoreClick);
			otherScoreHeader.addEventListener("click", onOtherScoreClick);
			state.headerCleanup = () => {
				titleHeader.removeEventListener("click", onTitleClick);
				yourScoreHeader.removeEventListener("click", onYourScoreClick);
				otherScoreHeader.removeEventListener("click", onOtherScoreClick);
				delete header._alaHeaderBound;
			};
		}
		if (header && titleHeader) {
			header.dataset.alaCompareInit = "true";
			updateSortArrows(titleHeader, yourScoreHeader, otherScoreHeader, state.activeSortCol, state.activeSortDir);
		}
		compareRoot.dataset.alaCompareInit = "true";
		entries.forEach((el) => {
			el.querySelectorAll(".score").forEach((scoreEl) => {
				const text = scoreEl.textContent?.trim();
				if (!text || text === "") scoreEl.textContent = "0";
			});
		});
		if (entries.length > 0) {
			applyFilter(state, compareRoot, entries);
			applySort(state, compareRoot, entries, state.activeSortCol, state.activeSortDir);
		}
		if (!state.isLoadingAll && !state.isCompareLoaded && !state.loadFailed && sidebar) onReadyToLoad(compareRoot, sidebar);
	}
	function getCompareVue() {
		const scrollerEl = document.querySelector(".scroller");
		if (scrollerEl && scrollerEl.__vue__?.$parent) return scrollerEl.__vue__.$parent;
		const compareEl = document.querySelector(".compare");
		if (compareEl && compareEl.__vue__) return compareEl.__vue__;
		return null;
	}
	function createCompareRpcBlocker(state) {
		return (q, vars) => !state.loadFailed && isComparePage() && (/\bcompareWithAuthList\b/i.test(q || "") || Boolean(vars?.compareWithAuthList));
	}
	function parseCompareRoute(pathname = location.pathname) {
		const m = pathname.match(/^\/user\/([^/]+)\/(animelist|mangalist)\/compare(?:\/|$)/i);
		if (!m) return null;
		let userName = m[1];
		try {
			userName = decodeURIComponent(userName);
		} catch {}
		const isManga = m[2].toLowerCase().startsWith("manga");
		return {
			userName,
			type: isManga ? "MANGA" : "ANIME"
		};
	}
	async function resolveCompareUsers(ctx, rc) {
		const route = parseCompareRoute();
		const type = route?.type || (location.pathname.toLowerCase().includes("mangalist") ? "MANGA" : "ANIME");
		const bridge = ctx.hooks.getCacheBridge();
		const userMap = bridge?.getUserMap();
		const idMap = bridge?.getIdMap();
		let otherName = route?.userName;
		let otherId;
		if (!otherName) {
			const queryUser = new URLSearchParams(location.search).get("user");
			if (queryUser) otherName = queryUser;
		}
		const vue = getCompareVue();
		if (vue) {
			if (!otherName) otherName = vue.user?.name || vue.userName || void 0;
			if (!otherId) otherId = Number(vue.user?.id || vue.userId) || void 0;
		}
		if (otherName && !otherId && userMap) otherId = userMap.get(otherName.toLowerCase());
		if (otherName && otherId) {
			userMap?.set(otherName.toLowerCase(), otherId);
			idMap?.set(otherId, otherName);
		}
		const snap = ctx.session.peek({ reconcile: true });
		let viewerId = snap.userId || void 0;
		let viewerName = snap.username || void 0;
		if (!viewerId || !viewerName) {
			const viewer = await rc.api.viewer(false, { signal: rc.signal });
			if (viewer) {
				viewerId = viewer.id;
				viewerName = viewer.name;
			}
		}
		if (!viewerId && viewerName && userMap) viewerId = userMap.get(viewerName.toLowerCase());
		return {
			viewerId,
			viewerName,
			otherId,
			otherName,
			type
		};
	}
	function buildCompareRow(otherEntry, myEntry, type, safeOtherName, scopeAttr) {
		const mediaId = otherEntry.mediaId;
		const title = otherEntry.media?.title?.userPreferred || otherEntry.media?.title?.romaji || otherEntry.media?.title?.english || myEntry.media?.title?.userPreferred || "Unknown";
		const yourScore = myEntry.score || 0;
		const otherScore = otherEntry.score || 0;
		const yourStatus = normalizeStatus(myEntry.status);
		const otherStatus = normalizeStatus(otherEntry.status);
		const row = document.createElement("div");
		row.className = "entry";
		if (scopeAttr) row.setAttribute(scopeAttr, "");
		const attrStr = scopeAttr ? ` ${scopeAttr}=""` : "";
		row.innerHTML = `
    <div class="title"${attrStr}>
      <a href="/${type.toLowerCase()}/${mediaId}/" class=""${attrStr}></a>
    </div>
    <div class="score" label="Score" score="${yourScore}"${attrStr}><span>${yourScore > 0 ? yourScore : "0"}</span></div>
    <div class="score" label="${safeOtherName}'s Score" score="${otherScore}"${attrStr}><span>${otherScore > 0 ? otherScore : "0"}</span></div>
    <div class="status" label="Your Status"${attrStr}><span>${yourStatus}</span></div>
    <div class="status" label="${safeOtherName}'s Status"${attrStr}><span>${otherStatus}</span></div>
  `;
		const link = row.querySelector(".title a");
		if (link) link.textContent = title;
		row._alaCompareData = {
			el: row,
			title,
			yourScore,
			otherScore,
			yourStatus,
			otherStatus
		};
		return row;
	}
	function mountCompareTable(state, compareRoot, type, safeOtherName, scopeAttr, matchedNodes) {
		const main = compareRoot.parentElement || document.querySelector(".ala-compare-main");
		if (!main) return null;
		let customTable = main.querySelector("#ala-compare-table");
		if (!customTable) {
			customTable = document.createElement("div");
			customTable.id = "ala-compare-table";
			customTable.className = "compare";
			if (scopeAttr) customTable.setAttribute(scopeAttr, "");
			main.appendChild(customTable);
		}
		let customHeader = customTable.querySelector(".entry.header");
		if (!customHeader) {
			customHeader = document.createElement("div");
			customHeader.className = "entry header";
			if (scopeAttr) customHeader.setAttribute(scopeAttr, "");
			const attrStr = scopeAttr ? ` ${scopeAttr}=""` : "";
			customHeader.innerHTML = `
      <div class="title ala-sortable-header"${attrStr}>
        <div class="ala-header-wrap"><span class="ala-header-label">Title</span></div>
      </div>
      <div class="score ala-sortable-header"${attrStr}>
        <div class="ala-header-wrap"><span class="ala-header-label">Your Score</span></div>
      </div>
      <div class="score ala-sortable-header"${attrStr}>
        <div class="ala-header-wrap"><span class="ala-header-label">${safeOtherName}'s Score</span></div>
      </div>
      <div class="status"${attrStr}>
        <span class="ala-header-label">Your Status</span>
      </div>
      <div class="status"${attrStr}>
        <span class="ala-header-label">${safeOtherName}'s Status</span>
      </div>
    `;
			customTable.appendChild(customHeader);
			const titleH = customHeader.querySelector(".title");
			const scores = customHeader.querySelectorAll(".score");
			titleH?.addEventListener("click", () => triggerSort(state, "title", compareRoot));
			scores[0]?.addEventListener("click", () => triggerSort(state, "yourScore", compareRoot));
			scores[1]?.addEventListener("click", () => triggerSort(state, "otherScore", compareRoot));
		}
		const titleH = customHeader.querySelector(".title");
		const scores = customHeader.querySelectorAll(".score");
		updateSortArrows(titleH, scores[0] || null, scores[1] || null, state.activeSortCol, state.activeSortDir);
		matchedNodes.sort((a, b) => compareEntries(getEntryData(a), getEntryData(b), state.activeSortCol, state.activeSortDir));
		state.isMutatingDOM = true;
		try {
			customTable.querySelectorAll(".entry:not(.header)").forEach((el) => el.remove());
			const frag = document.createDocumentFragment();
			for (const el of matchedNodes) frag.appendChild(el);
			customTable.appendChild(frag);
			if (matchedNodes.length === 0) {
				let empty = customTable.querySelector(".no-results");
				if (!empty) {
					empty = document.createElement("div");
					empty.className = "no-results";
					empty.textContent = `You don't have any ${type.toLowerCase()} in common ｡ﾟヽ(ﾟ´Д｀)ﾉﾟ｡`;
					customTable.appendChild(empty);
				}
				customHeader.style.display = "none";
			} else {
				customTable.querySelector(".no-results")?.remove();
				customHeader.style.display = "";
			}
			const emptyEl = customTable.querySelector(".ala-compare-empty");
			if (emptyEl) customTable.appendChild(emptyEl);
		} finally {
			state.isMutatingDOM = false;
		}
		return customTable;
	}
	async function loadAllEntriesViaMediaList(ctx, rc, state, compareRoot, sidebar) {
		if (state.isLoadingAll || state.isCompareLoaded || state.loadFailed || rc.signal.aborted) return;
		state.isLoadingAll = true;
		const abortState = { abort: false };
		state.loadAbortState = abortState;
		state.prefetchRelease?.();
		const releasePrefetch = ctx.hooks.setPrefetchPaused(true);
		state.prefetchRelease = releasePrefetch;
		rc.onCleanup(releasePrefetch);
		let cancelIndicatorTimer = rc.timeout(() => {
			cancelIndicatorTimer = null;
			if (!abortState.abort && !rc.signal.aborted && isComparePage()) setLoadIndicator(sidebar, "Loading full compare list...");
		}, 250);
		try {
			const { viewerId, viewerName, otherId, otherName, type } = await resolveCompareUsers(ctx, rc);
			if (abortState.abort || rc.signal.aborted || !isComparePage()) return;
			const viewerTarget = viewerId || viewerName;
			const otherTarget = otherId || otherName;
			if (!viewerTarget || !otherTarget) {
				ctx.log.debug("Missing viewer or other user for getMediaList, keeping fallback");
				if (state.loadAbortState === abortState && !abortState.abort && !rc.signal.aborted) state.loadFailed = true;
				return;
			}
			const [myListRes, otherListRes] = await Promise.all([rc.api.getMediaList(viewerTarget, type, {
				userId: viewerId,
				userName: viewerId ? void 0 : viewerName,
				signal: rc.signal
			}), rc.api.getMediaList(otherTarget, type, {
				userId: otherId,
				userName: otherId ? void 0 : otherName,
				signal: rc.signal
			})]);
			if (abortState.abort || rc.signal.aborted || !isComparePage()) return;
			const myMap = new Map();
			for (const entry of myListRes.allEntries) myMap.set(entry.mediaId, entry);
			const safeOtherName = esc(otherListRes.user?.name || otherName || "User");
			const scopeAttr = Array.from(compareRoot.attributes).map((a) => a.name).find((n) => /^data-v-[a-f0-9]+$/i.test(n));
			const seenMediaIds = new Set();
			const matchedNodes = [];
			for (const otherEntry of otherListRes.allEntries) {
				const mediaId = otherEntry.mediaId;
				if (seenMediaIds.has(mediaId)) continue;
				const myEntry = myMap.get(mediaId);
				if (!myEntry) continue;
				seenMediaIds.add(mediaId);
				matchedNodes.push(buildCompareRow(otherEntry, myEntry, type, safeOtherName, scopeAttr));
			}
			ctx.log.debug("Matched entries via MediaListCollection:", matchedNodes.length);
			const customTable = mountCompareTable(state, compareRoot, type, safeOtherName, scopeAttr, matchedNodes);
			if (!customTable) return;
			compareRoot.style.display = "none";
			disableNativeScrollers(compareRoot);
			state.lastProcessedCount = matchedNodes.length;
			state.isCompareLoaded = true;
			updateStatusCounts(state, sidebar, matchedNodes);
			applyFilter(state, customTable, matchedNodes);
		} catch (err) {
			if (state.loadAbortState === abortState && !abortState.abort && !rc.signal.aborted && !isAbortError(err)) {
				state.loadFailed = true;
				ctx.log.error("CompareView getMediaList error:", err);
			}
		} finally {
			if (cancelIndicatorTimer) {
				cancelIndicatorTimer();
				cancelIndicatorTimer = null;
			}
			if (state.loadAbortState === abortState && !abortState.abort) {
				state.isLoadingAll = false;
				state.loadAbortState = null;
				if (state.prefetchRelease) {
					state.prefetchRelease();
					state.prefetchRelease = null;
				}
				setLoadIndicator(sidebar, null);
			}
		}
	}
	defineModule({
		id: "compareView",
		key: "compareViewEnabled",
		section: "AniList Enhancements",
		layer: "preload",
		requiresReload: true,
		title: "Compare View Improvements",
		help: "Sort lists by title or scores, auto-load complete compare list, and filter by status with responsive mobile dropdown.",
		debug: {
			label: "Compare View",
			title: "Compare View Debug",
			help: "Log list comparison data loading, score diffs, sorting, and filtering passes."
		},
		setup(ctx) {
			ctx.addStyle(COMPARE_CSS);
			ctx.ownUi("#ala-compare-sidebar");
			const state = createCompareState();
			ctx.hooks.blockRpc(createCompareRpcBlocker(state));
			ctx.onRoute(() => isComparePage(), (rc) => {
				if (state.disposed) return;
				state.currentRoute = rc.pathname;
				resetCompareFilters(state);
				cleanupCompareView(state);
				const checkView = rc.debounce(() => {
					if (state.disposed || state.isMutatingDOM || !isComparePage()) return;
					if (state.isCompareLoaded) return;
					const compareRoot = document.querySelector(".compare:not(#ala-compare-table)");
					if (!compareRoot) return;
					const header = compareRoot.querySelector(".entry.header");
					const entries = Array.from(compareRoot.querySelectorAll(".entry:not(.header)"));
					if (!compareRoot.dataset.alaCompareInit || !state.isCompareLoaded && entries.length !== state.lastProcessedCount) {
						state.lastProcessedCount = entries.length;
						setupCompareView(rc, state, compareRoot, header, entries, (root, sidebar) => {
							loadAllEntriesViaMediaList(ctx, rc, state, root, sidebar);
						});
					}
				}, 60);
				rc.ready(checkView);
				rc.onBodyMutation(() => {
					if (!state.disposed && !state.isMutatingDOM) checkView();
				});
				return () => {
					state.currentRoute = "";
					cleanupCompareView(state);
				};
			});
			ctx.onCleanup(() => {
				state.disposed = true;
				state.currentRoute = "";
				cleanupCompareView(state);
			});
		}
	});
	var TARGETED_BATCH_SIZE = 10;
	var ACTIVITY_PAGE_QUERY = `
query (
  $userId: Int!,
  $page: Int!,
  $types: [ActivityType!],
  $mediaIds: [Int],
  $sort: [ActivitySort!]
) {
  Page(page: $page, perPage: 50) {
    pageInfo {
      hasNextPage
      currentPage
      lastPage
    }
    activities(
      userId: $userId,
      type_in: $types,
      mediaId_in: $mediaIds,
      sort: $sort
    ) {
      ... on ListActivity {
        id
        status
        progress
        createdAt
        media { id }
      }
    }
  }
}
`;
	var SAVE_ENTRY_MUTATION = `
mutation ($id: Int!, $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput) {
  SaveMediaListEntry(id: $id, startedAt: $startedAt, completedAt: $completedAt) {
    id
    startedAt { year month day }
    completedAt { year month day }
  }
}
`;
	function normalizeFuzzyDate(d) {
		return {
			year: d?.year ?? null,
			month: d?.month ?? null,
			day: d?.day ?? null
		};
	}
	function isDateEmpty(d) {
		return !d || !d.year && !d.month && !d.day;
	}
	function isDateComplete(d) {
		return Boolean(d && d.year && d.month && d.day);
	}
	function formatFuzzyDate(d) {
		if (!d || !d.year && !d.month && !d.day) return "—";
		return `${d.year ? String(d.year).padStart(4, "0") : "????"}-${d.month ? String(d.month).padStart(2, "0") : "??"}-${d.day ? String(d.day).padStart(2, "0") : "??"}`;
	}
	function fuzzyDateFromTimestamp(unixSeconds) {
		const dt = new Date(unixSeconds * 1e3);
		return {
			year: dt.getFullYear(),
			month: dt.getMonth() + 1,
			day: dt.getDate()
		};
	}
	function compareFuzzyDates(a, b) {
		const ay = a.year ?? 0;
		const by = b.year ?? 0;
		if (ay !== by) return ay - by;
		const am = a.month ?? 0;
		const bm = b.month ?? 0;
		if (am !== bm) return am - bm;
		return (a.day ?? 0) - (b.day ?? 0);
	}
	function compareFuzzyDatesCompatible(a, b) {
		if (a.year == null || b.year == null) return 0;
		if (a.year !== b.year) return a.year - b.year;
		if (a.month == null || b.month == null) return 0;
		if (a.month !== b.month) return a.month - b.month;
		if (a.day == null || b.day == null) return 0;
		return a.day - b.day;
	}
	function isFirstProgress(progress) {
		if (!progress) return false;
		return /^1(?:\s*-|$)/.test(progress.trim());
	}
	function entryNeedsStart(entry, fillPartialDates) {
		return fillPartialDates ? !isDateComplete(entry.startedAt) : isDateEmpty(entry.startedAt);
	}
	function entryNeedsFinish(entry, fillPartialDates) {
		return entry.status === "COMPLETED" && (fillPartialDates ? !isDateComplete(entry.completedAt) : isDateEmpty(entry.completedAt));
	}
	function describeMissingDates(entry, fillPartialDates) {
		const needS = entryNeedsStart(entry, fillPartialDates);
		const needF = entryNeedsFinish(entry, fillPartialDates);
		if (needS && needF) return "Start & Finish";
		if (needS) return "Start date";
		if (needF) return "Finish date";
		return "None";
	}
	function chunkIds(ids, size) {
		const chunks = [];
		for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
		return chunks;
	}
	function inferDatesFromActivities(entry, activities, fillPartialDates) {
		const needsStart = entryNeedsStart(entry, fillPartialDates);
		const needsFinish = entryNeedsFinish(entry, fillPartialDates);
		if (!needsStart && !needsFinish) return null;
		const sorted = [...activities].sort((a, b) => a.createdAt - b.createdAt);
		let earliestProgress = null;
		let earliestCompleted = null;
		let earliestRewatch = null;
		for (const act of sorted) {
			const st = act.status.trim().toLowerCase();
			if ((st === "watched episode" || st === "read chapter") && !earliestProgress) earliestProgress = act;
			else if ((st === "rewatched episode" || st === "reread chapter") && !earliestRewatch) earliestRewatch = act;
			else if (st === "completed" && !earliestCompleted) earliestCompleted = act;
		}
		if (earliestCompleted && entry.repeat > 0 && earliestRewatch && earliestRewatch.createdAt <= earliestCompleted.createdAt) earliestCompleted = null;
		let newCompletedAt = null;
		if (needsFinish && earliestCompleted) {
			const candidateFinish = fuzzyDateFromTimestamp(earliestCompleted.createdAt);
			if (isDateEmpty(entry.startedAt) || compareFuzzyDatesCompatible(entry.startedAt, candidateFinish) <= 0) newCompletedAt = candidateFinish;
		}
		let newStartedAt = null;
		let startSource = null;
		if (needsStart) {
			const startAct = earliestProgress ?? earliestCompleted;
			if (startAct) {
				const candidateStart = fuzzyDateFromTimestamp(startAct.createdAt);
				const effectiveFinish = newCompletedAt ?? entry.completedAt;
				if (isDateEmpty(effectiveFinish) || compareFuzzyDatesCompatible(candidateStart, effectiveFinish) <= 0) {
					newStartedAt = candidateStart;
					startSource = startAct.status.trim().toLowerCase() === "completed" ? "completed (no ep/ch log)" : startAct.progress ? `${startAct.status} ${startAct.progress}` : startAct.status;
				}
			}
		}
		if (!newStartedAt && !newCompletedAt) return null;
		return {
			entry,
			newStartedAt,
			newCompletedAt,
			startSource,
			selected: true
		};
	}
	function assumeStartFromFinish(entry, fillPartialDates) {
		if (!entryNeedsStart(entry, fillPartialDates)) return null;
		if (!(fillPartialDates ? isDateComplete(entry.completedAt) : !isDateEmpty(entry.completedAt))) return null;
		if (isDateComplete(entry.startedAt) && isDateComplete(entry.completedAt) && compareFuzzyDates(entry.startedAt, entry.completedAt) === 0) return null;
		return {
			entry,
			newStartedAt: { ...entry.completedAt },
			newCompletedAt: null,
			startSource: "assumed from finish date (no earlier log)",
			selected: false
		};
	}
	function buildScanSnapshot(candidates, activitiesByMedia, ruledOutReasons, noEarlierLogsIds, scanDone, fillPartialDates, selectionState) {
		const proposals = [];
		const unresolved = [];
		for (const [mid, entry] of candidates) {
			const acts = activitiesByMedia.get(mid);
			let proposal = acts && acts.length > 0 ? inferDatesFromActivities(entry, acts, fillPartialDates) : null;
			if (!proposal && (scanDone || noEarlierLogsIds.has(mid))) proposal = assumeStartFromFinish(entry, fillPartialDates);
			if (proposal) {
				const prevSelected = selectionState.get(mid);
				if (prevSelected !== void 0) proposal.selected = prevSelected;
				proposals.push(proposal);
			} else unresolved.push({
				entry,
				missingLabel: describeMissingDates(entry, fillPartialDates),
				ruledOutReason: ruledOutReasons.get(mid) ?? null
			});
		}
		return {
			proposals,
			unresolved
		};
	}
	function isAssumedProposal(p) {
		return Boolean(p.startSource?.startsWith("assumed"));
	}
	var buildDateBackfillModalCss = (sel) => `@keyframes alaDbfModalIn {from{opacity:0;transform:translateY(8px) scale(0.985);}to{opacity:1;transform:translateY(0) scale(1);}}
      @keyframes alaDbfIndeterminate {0%{transform:translateX(-100%);}100%{transform:translateX(350%);}}
      @keyframes alaDbfPulse {0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.4;transform:scale(0.85);}}
      ${sel} .ala-core-sheet {max-height:88vh;border:1px solid rgba(var(--color-text),0.1);font-size:1.3rem;animation:alaDbfModalIn 0.16s ease-out;}
      ${sel} .ala-core-head {padding:16px 22px;background:rgb(var(--color-background));border-bottom:1px solid rgba(var(--color-text),0.08);align-items:flex-start;}
      ${sel} .ala-dbf-progress-track {height:3px;width:100%;background:rgba(var(--color-text),0.07);overflow:hidden;position:relative;flex-shrink:0;}
      ${sel} .ala-dbf-progress-fill {height:100%;width:0%;background:rgb(var(--color-blue));transition:width 0.25s ease;}
      ${sel} .ala-dbf-progress-fill.indeterminate {width:30%;animation:alaDbfIndeterminate 1.35s infinite ease-in-out;}
      ${sel} .ala-dbf-progress-fill.applying {background:rgb(var(--color-green));}
      ${sel} .ala-core-body {padding:18px 22px;}
      ${sel} .ala-core-body::-webkit-scrollbar {width:8px;}
      ${sel} .ala-core-body::-webkit-scrollbar-thumb {background:rgba(var(--color-text),0.18);border-radius:4px;}
      ${sel} .ala-core-body::-webkit-scrollbar-thumb:hover {background:rgba(var(--color-text),0.3);}
      ${sel} .ala-dbf-config-bar {display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;}
      ${sel} .ala-dbf-config-chip {display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;font-size:1.15rem;background:rgba(var(--color-text),0.07);color:rgb(var(--color-text-lighter));}
      ${sel} .ala-dbf-config-chip strong {color:rgb(var(--color-text));font-weight:600;}
      ${sel} .ala-dbf-mode-grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;}
      ${sel} .ala-dbf-mode-card {display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:8px;width:100%;padding:16px 18px;border-radius:8px;background:rgb(var(--color-background));border:1px solid rgba(var(--color-text),0.1);color:rgb(var(--color-text));cursor:pointer;transition:border-color 0.15s,transform 0.12s,background 0.15s;}
      ${sel} .ala-dbf-mode-card:hover {border-color:rgb(var(--color-blue));background:rgba(var(--color-blue),0.06);transform:translateY(-1px);}
      ${sel} .ala-dbf-mode-card-head {display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;flex-wrap:wrap;}
      ${sel} .ala-dbf-mode-card-title {font-size:1.4rem;font-weight:700;color:rgb(var(--color-text));}
      ${sel} .ala-dbf-mode-badge {padding:2px 8px;border-radius:999px;font-size:1.05rem;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;background:rgba(var(--color-blue),0.16);color:rgb(var(--color-blue));}
      ${sel} .ala-dbf-mode-desc {font-size:1.2rem;line-height:1.45;color:rgb(var(--color-text-lighter));font-weight:400;}
      ${sel} .ala-dbf-stats {display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px;}
      ${sel} .ala-dbf-stat-card {padding:10px 14px;border-radius:7px;background:rgb(var(--color-background));border:1px solid rgba(var(--color-text),0.07);display:flex;flex-direction:column;gap:3px;min-width:0;}
      ${sel} .ala-dbf-stat-label {font-size:1.1rem;text-transform:uppercase;letter-spacing:0.04em;color:rgb(var(--color-text-lighter));font-weight:600;}
      ${sel} .ala-dbf-stat-val {font-size:1.65rem;font-weight:700;font-variant-numeric:tabular-nums;}
      ${sel} .ala-dbf-stat-val.green {color:rgb(var(--color-green));}
      ${sel} .ala-dbf-stat-val.blue {color:rgb(var(--color-blue));}
      ${sel} .ala-dbf-toolbar {display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;}
      ${sel} .ala-dbf-search {flex:1;min-width:180px;width:100%;padding:8px 12px;border-radius:6px;border:1px solid rgba(var(--color-text),0.14);background:rgb(var(--color-background));color:rgb(var(--color-text));font-size:1.25rem;outline:none;transition:border-color 0.15s;}
      ${sel} .ala-dbf-search:focus {border-color:rgb(var(--color-blue));}
      ${sel} .ala-dbf-section {margin-bottom:16px;border:1px solid rgba(var(--color-text),0.08);border-radius:8px;background:rgb(var(--color-background));overflow-x:hidden;}
      ${sel} .ala-dbf-section:last-child {margin-bottom:0;}
      ${sel} .ala-dbf-section-head {padding:10px 14px;background:rgba(var(--color-foreground),0.55);border-bottom:1px solid rgba(var(--color-text),0.08);display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-weight:700;font-size:1.3rem;}
      ${sel} .ala-dbf-section-head.collapsible {cursor:pointer;user-select:none;}
      ${sel} .ala-dbf-section-head.collapsible:hover {background:rgba(var(--color-text),0.05);}
      ${sel} .ala-dbf-table-wrap {width:100%;overflow-x:hidden;}
      ${sel} table {width:100%;table-layout:fixed;border-collapse:collapse;font-size:1.25rem;}
      ${sel} thead th {background:rgb(var(--color-background));color:rgb(var(--color-text-lighter));font-size:1.1rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;padding:9px 12px;border-bottom:1px solid rgba(var(--color-text),0.12);text-align:left;}
      ${sel} tbody td {padding:10px 12px;border-bottom:1px solid rgba(var(--color-text),0.06);vertical-align:middle;overflow-wrap:anywhere;word-break:break-word;}
      ${sel} tbody tr:last-child td {border-bottom:none;}
      ${sel} tbody tr {transition:background 0.12s,opacity 0.12s;}
      ${sel} tbody tr:hover {background:rgba(var(--color-text),0.035);}
      ${sel} tbody tr.is-selected {background:rgba(var(--color-blue),0.055);}
      ${sel} tbody tr.is-unselected {opacity:0.72;}
      ${sel} input[type="checkbox"] {width:16px;height:16px;accent-color:rgb(var(--color-blue));cursor:pointer;vertical-align:middle;}
      ${sel} .ala-dbf-media-link {color:rgb(var(--color-text));text-decoration:none;font-weight:600;transition:color 0.12s;}
      ${sel} .ala-dbf-media-link:hover {color:rgb(var(--color-blue));text-decoration:underline;}
      ${sel} .ala-dbf-type-badge {display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;font-size:1rem;font-weight:700;letter-spacing:0.03em;background:rgba(var(--color-blue),0.15);color:rgb(var(--color-blue));vertical-align:middle;}
      ${sel} .ala-dbf-type-badge.manga {background:rgba(var(--color-green),0.15);color:rgb(var(--color-green));}
      ${sel} .ala-dbf-date-diff {display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px;font-variant-numeric:tabular-nums;}
      ${sel} .ala-dbf-old-date {color:rgb(var(--color-text-lighter));}
      ${sel} .ala-dbf-arrow {color:rgb(var(--color-text-lighter));font-size:1.1rem;}
      ${sel} .ala-dbf-new-date {display:inline-block;padding:2px 7px;border-radius:4px;background:rgba(var(--color-green),0.15);color:rgb(var(--color-green));font-weight:700;}
      ${sel} .ala-dbf-new-date.assumed {background:rgba(235,168,52,0.16);color:rgb(235,168,52);}
      ${sel} .ala-dbf-source {margin-top:3px;font-size:1.1rem;color:rgb(var(--color-text-lighter));}
      ${sel} .ala-dbf-source.assumed {color:rgb(235,168,52);}
      ${sel} .ala-dbf-pill {display:inline-block;padding:2px 8px;border-radius:4px;font-size:1.1rem;font-weight:600;background:rgba(var(--color-text),0.1);color:rgb(var(--color-text));}
      ${sel} .ala-dbf-empty-note {padding:16px 14px;margin:0;color:rgb(var(--color-text-lighter));font-size:1.25rem;}
      ${sel} .ala-core-foot {padding:13px 22px;background:rgb(var(--color-background));border-top:1px solid rgba(var(--color-text),0.08);justify-content:space-between;gap:12px;flex-wrap:wrap;}
      ${sel} .ala-dbf-status {display:inline-flex;align-items:center;gap:8px;color:rgb(var(--color-text-lighter));font-size:1.2rem;min-width:0;}
      ${sel} .ala-dbf-dot {width:8px;height:8px;border-radius:50%;background:rgb(var(--color-text-lighter));flex-shrink:0;}
      ${sel} .ala-dbf-dot.active {background:rgb(var(--color-blue));animation:alaDbfPulse 1.1s infinite ease-in-out;}
      ${sel} .ala-dbf-dot.paused {background:rgb(235,168,52);}
      ${sel} .ala-dbf-dot.done {background:rgb(var(--color-green));}
      ${sel} .ala-dbf-actions {display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
      ${sel} .ala-dbf-actions[hidden] {display:none;}
      ${sel} button.ala-dbf-btn {padding:7px 14px;border:1px solid transparent;border-radius:6px;cursor:pointer;font-size:1.25rem;font-weight:600;background:rgb(var(--color-blue));color:#fff;transition:filter 0.14s,background 0.14s,opacity 0.14s;}
      ${sel} button.ala-dbf-btn:hover:not(:disabled) {filter:brightness(1.08);}
      ${sel} button.ala-dbf-btn.secondary {background:rgba(var(--color-text),0.1);color:rgb(var(--color-text));}
      ${sel} button.ala-dbf-btn.secondary:hover:not(:disabled) {background:rgba(var(--color-text),0.16);}
      ${sel} button.ala-dbf-btn.apply {background:rgb(var(--color-green));color:#fff;}
      ${sel} button.ala-dbf-btn.mini {padding:5px 10px;font-size:1.15rem;}
      ${sel} button:disabled {opacity:0.45;cursor:not-allowed;}
      @media (max-width:640px) {
        ${sel} {padding:10px;}
        ${sel} .ala-core-sheet {max-height:92vh;}
        ${sel} .ala-core-head {padding:12px 14px;}
        ${sel} .ala-core-body {padding:12px 14px;}
        ${sel} .ala-dbf-mode-grid {grid-template-columns:1fr;}
        ${sel} .ala-dbf-stats {grid-template-columns:repeat(2,minmax(0,1fr));}
        ${sel} .ala-dbf-search {font-size:16px;}
        ${sel} .ala-core-foot {padding:12px 14px;flex-direction:column;align-items:stretch;}
        ${sel} .ala-dbf-actions {display:flex;flex-direction:column;width:100%;}
        ${sel} .ala-dbf-actions[hidden] {display:none;}
        ${sel} .ala-core-foot button.ala-dbf-btn {width:100%;padding:10px 14px;text-align:center;}
        ${sel} table,${sel} tbody,${sel} tr,${sel} td {display:block;width:100%;}
        ${sel} thead {display:none;}
        ${sel} tbody tr {padding:10px 12px;border-bottom:1px solid rgba(var(--color-text),0.08);}
        ${sel} tbody tr:last-child {border-bottom:none;}
        ${sel} tbody td {padding:4px 0;border-bottom:none;}
        ${sel} tbody td.ala-dbf-check-cell {float:left;width:28px;padding-top:2px;}
        ${sel} tbody td.ala-dbf-title-cell {padding-left:28px;margin-bottom:4px;}
        ${sel} tbody td.ala-dbf-unresolved-title {margin-bottom:4px;}
        ${sel} tbody td[data-label] {display:flex;align-items:baseline;gap:8px;padding-left:28px;font-size:1.2rem;}
        ${sel} tbody td.ala-dbf-unresolved-meta[data-label] {padding-left:0;}
        ${sel} tbody td[data-label]::before {content:attr(data-label);flex-shrink:0;min-width:54px;font-size:1.1rem;font-weight:700;text-transform:uppercase;color:rgb(var(--color-text-lighter));}
      }`;
	defineModule({
		id: "dateBackfill",
		key: "dateBackfillEnabled",
		section: "AniList Enhancements",
		title: "Missing Date Backfill",
		help: "Query your AniList activity logs to restore missing start and completion dates on anime and manga entries.",
		requiresReload: false,
		options: [
			{
				key: "dateBackfillScope",
				type: "select",
				def: "ANIME",
				options: [
					["ANIME", "Anime only"],
					["MANGA", "Manga only"],
					["BOTH", "Anime & Manga"]
				],
				title: "Media Scope",
				help: "Which list(s) to check for missing dates."
			},
			{
				key: "dateBackfillOrder",
				type: "select",
				def: "ASC",
				options: [["ASC", "Oldest first (best for older entries)"], ["DESC", "Newest first (best for recent entries)"]],
				title: "Activity Scan Order",
				help: "Direction to read activity pages when searching for missing dates."
			},
			{
				key: "dateBackfillPartial",
				type: "toggle",
				def: false,
				title: "Also fix incomplete dates",
				help: "Overwrite dates missing a year, month, or day (instead of only completely blank dates)."
			},
			{
				key: "dateBackfillDelayMs",
				type: "number",
				def: 250,
				min: 0,
				max: 5e3,
				title: "Extra pacing delay (ms)",
				help: "Additional pause between paginated calls on top of the built-in AniList rate limiter."
			}
		],
		debug: {
			label: "Date Backfill",
			title: "Date Backfill Debug",
			help: "Log list scans, activity pagination, and entry updates."
		},
		setup(ctx) {
			async function resolveUserId(signal) {
				if (ctx.session.userId) return ctx.session.userId;
				if (!ctx.session.hasAuth()) return null;
				return (await ctx.api.viewer(false, { signal }))?.id ?? null;
			}
			function openModal() {
				let activeScanAbort = null;
				let scanStarting = false;
				let isApplying = false;
				const renderIdleScreenHtml = () => {
					const scopeSetting = ctx.get("dateBackfillScope");
					const orderSetting = ctx.get("dateBackfillOrder");
					const partialSetting = ctx.get("dateBackfillPartial");
					return `
          <div class="ala-dbf-config-bar">
            <span class="ala-dbf-config-chip">Scope: <strong>${scopeSetting === "BOTH" ? "Anime & Manga" : scopeSetting === "MANGA" ? "Manga only" : "Anime only"}</strong></span>
            <span class="ala-dbf-config-chip">Order: <strong>${orderSetting === "DESC" ? "Newest first" : "Oldest first"}</strong></span>
            <span class="ala-dbf-config-chip">Incomplete dates: <strong>${partialSetting ? "Include" : "Blank only"}</strong></span>
          </div>
          <div class="ala-dbf-mode-grid">
            <button type="button" class="ala-dbf-mode-card" data-act="scan-fast">
              <div class="ala-dbf-mode-card-head">
                <span class="ala-dbf-mode-card-title">Fast Scan</span>
                <span class="ala-dbf-mode-badge">Recommended</span>
              </div>
              <span class="ala-dbf-mode-desc">
                Queries activity history filtered directly to titles missing dates in batches of 10 (identical to Social → Recent Activity → Self).
              </span>
            </button>
            <button type="button" class="ala-dbf-mode-card" data-act="scan-full">
              <div class="ala-dbf-mode-card-head">
                <span class="ala-dbf-mode-card-title">Full Feed Scan</span>
              </div>
              <span class="ala-dbf-mode-desc">
                Walks your entire account activity feed chronologically from start to finish. Useful as a fallback if targeted queries miss anything.
              </span>
            </button>
          </div>
        `;
				};
				const modal = ctx.modal({
					id: "modal",
					title: "Missing Date Backfill",
					subtitle: "Recover missing start and completion dates from your AniList activity logs",
					maxWidth: "960px",
					style: buildDateBackfillModalCss,
					bodyHtml: renderIdleScreenHtml(),
					footerHtml: `
          <div class="ala-dbf-status">
            <span class="ala-dbf-dot" data-role="dot"></span>
            <span data-role="status">Ready to scan</span>
          </div>
          <div class="ala-dbf-actions" data-role="footer-actions" hidden>
            <button type="button" class="ala-dbf-btn secondary" data-act="primary-action">Pause</button>
            <button type="button" class="ala-dbf-btn apply" data-act="apply" disabled>Apply Selected (0)</button>
          </div>
        `
				});
				modal.onCleanup(() => {
					activeScanAbort?.abort();
					activeScanAbort = null;
				});
				const overlay = modal.backdrop;
				const bodyEl = modal.body;
				const statusEl = modal.footer.querySelector("[data-role=\"status\"]");
				const dotEl = modal.footer.querySelector("[data-role=\"dot\"]");
				const footerActionsEl = modal.footer.querySelector("[data-role=\"footer-actions\"]");
				const track = document.createElement("div");
				track.className = "ala-dbf-progress-track";
				track.innerHTML = "<div class=\"ala-dbf-progress-fill\" data-role=\"progress\"></div>";
				modal.sheet.insertBefore(track, bodyEl);
				const progressEl = track.querySelector("[data-role=\"progress\"]");
				const primaryActionBtn = overlay.querySelector("[data-act=\"primary-action\"]");
				const applyBtn = overlay.querySelector("[data-act=\"apply\"]");
				let scanState = "idle";
				let activeMode = "TARGETED";
				let pauseRequested = false;
				let resumeResolver = null;
				let wakeSleepFn = null;
				let filterQuery = "";
				let unresolvedCollapsed = false;
				let candidates = new Map();
				let activitiesByMedia = new Map();
				let seenActivityIds = new Set();
				let ruledOutReasons = new Map();
				let noEarlierLogsIds = new Set();
				let selectionState = new Map();
				let proposals = [];
				let unresolved = [];
				let appliedCount = 0;
				const modeLabel = (mode) => mode === "TARGETED" ? "Fast Scan" : "Full Feed Scan";
				const setProgress = (pct, variant = "scanning") => {
					progressEl.classList.remove("indeterminate", "applying");
					if (variant === "applying") progressEl.classList.add("applying");
					if (variant === "idle") progressEl.style.width = "0%";
					else if (pct === null) {
						progressEl.style.width = "";
						progressEl.classList.add("indeterminate");
					} else progressEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
				};
				const setStatusIndicator = (tone, text) => {
					dotEl.className = `ala-dbf-dot ${tone === "idle" ? "" : tone}`.trim();
					statusEl.textContent = text;
				};
				const sleepInterruptible = async (ms, signal) => {
					if (signal.aborted) throw createAbortError(signal);
					if (ms <= 0 || pauseRequested) return;
					const wakeAc = new AbortController();
					const { signal: combinedSignal, dispose } = composeAbortSignals(signal, wakeAc.signal);
					wakeSleepFn = () => {
						wakeAc.abort();
					};
					try {
						await sleep(ms, combinedSignal);
					} catch (err) {
						if (!signal.aborted && wakeAc.signal.aborted) return;
						throw err;
					} finally {
						wakeSleepFn = null;
						dispose();
					}
				};
				const waitIfPaused = (signal) => new Promise((resolve, reject) => {
					if (signal.aborted) {
						reject(createAbortError(signal));
						return;
					}
					if (!pauseRequested) {
						resolve();
						return;
					}
					setScanState("paused");
					setProgress(null, "idle");
					refreshSnapshotAndRender();
					setStatusIndicator("paused", `Paused (${modeLabel(activeMode)}) — ${proposals.length} found, ${unresolved.length} not yet found.`);
					const onAbort = () => {
						resumeResolver = null;
						reject(createAbortError(signal));
					};
					resumeResolver = () => {
						signal.removeEventListener("abort", onAbort);
						resumeResolver = null;
						pauseRequested = false;
						setScanState("scanning");
						resolve();
					};
					signal.addEventListener("abort", onAbort, { once: true });
				});
				const updateButtons = () => {
					const backBtn = bodyEl.querySelector("[data-act=\"back-idle\"]");
					const selectionBtns = bodyEl.querySelectorAll("[data-act=\"toggle-all\"], [data-act=\"select-confirmed\"]");
					const checkboxes = bodyEl.querySelectorAll("input[type=\"checkbox\"][data-media-id]");
					if (scanState === "idle") {
						footerActionsEl.hidden = true;
						return;
					}
					footerActionsEl.hidden = false;
					const selectedCount = proposals.filter((p) => p.selected).length;
					applyBtn.textContent = `Apply Selected (${selectedCount})`;
					if (scanState === "scanning") {
						primaryActionBtn.disabled = isApplying || pauseRequested;
						primaryActionBtn.textContent = pauseRequested ? "Pausing..." : "Pause";
						primaryActionBtn.className = "ala-dbf-btn secondary";
						applyBtn.disabled = true;
					} else if (scanState === "paused") {
						primaryActionBtn.disabled = isApplying;
						primaryActionBtn.textContent = "Resume Scan";
						primaryActionBtn.className = "ala-dbf-btn";
						applyBtn.disabled = isApplying || selectedCount === 0;
					} else {
						primaryActionBtn.disabled = isApplying;
						primaryActionBtn.textContent = activeMode === "TARGETED" ? "Full Feed Scan" : "Fast Scan";
						primaryActionBtn.className = "ala-dbf-btn";
						applyBtn.disabled = isApplying || selectedCount === 0;
					}
					if (backBtn) backBtn.disabled = isApplying || scanState === "scanning";
					for (const btn of selectionBtns) btn.disabled = isApplying;
					for (const cb of checkboxes) cb.disabled = isApplying;
				};
				const setScanState = (next) => {
					scanState = next;
					updateButtons();
				};
				const resetToIdleScreen = () => {
					if (isApplying) return;
					activeScanAbort?.abort();
					activeScanAbort = null;
					scanStarting = false;
					pauseRequested = false;
					resumeResolver = null;
					wakeSleepFn = null;
					candidates.clear();
					activitiesByMedia.clear();
					seenActivityIds.clear();
					ruledOutReasons.clear();
					noEarlierLogsIds.clear();
					selectionState.clear();
					proposals = [];
					unresolved = [];
					appliedCount = 0;
					filterQuery = "";
					unresolvedCollapsed = false;
					setScanState("idle");
					setProgress(0, "idle");
					setStatusIndicator("idle", "Ready to scan");
					bodyEl.innerHTML = renderIdleScreenHtml();
				};
				const ensureResultsScaffold = () => {
					let resultsContainer = bodyEl.querySelector("[data-role=\"results\"]");
					if (!resultsContainer) {
						bodyEl.innerHTML = `
            <div class="ala-dbf-toolbar">
              <button
                type="button"
                class="ala-dbf-btn secondary mini"
                data-act="back-idle"
                ${isApplying || scanState === "scanning" ? "disabled" : ""}
                title="Return to scan mode selection"
              >← Modes</button>
              <input
                type="search"
                class="ala-dbf-search"
                data-role="filter"
                placeholder="Filter entries by title..."
                value="${esc(filterQuery)}"
              />
            </div>
            <div data-role="results"></div>
          `;
						resultsContainer = bodyEl.querySelector("[data-role=\"results\"]");
					} else {
						const backBtn = bodyEl.querySelector("[data-act=\"back-idle\"]");
						if (backBtn) backBtn.disabled = isApplying || scanState === "scanning";
					}
					return resultsContainer;
				};
				const refreshSnapshotAndRender = () => {
					const fillPartial = ctx.get("dateBackfillPartial");
					const snap = buildScanSnapshot(candidates, activitiesByMedia, ruledOutReasons, noEarlierLogsIds, scanState === "done", fillPartial, selectionState);
					proposals = snap.proposals;
					unresolved = snap.unresolved;
					renderResults();
					updateButtons();
				};
				modal.listen(overlay, "click", (ev) => {
					const target = ev.target.closest("[data-act]");
					if (!target) return;
					const act = target.dataset.act;
					if (act === "scan-fast") runScan("TARGETED");
					else if (act === "scan-full") runScan("FEED");
					else if (act === "back-idle") {
						if (!isApplying && scanState !== "scanning" && !scanStarting) resetToIdleScreen();
					} else if (act === "primary-action") {
						if (isApplying) return;
						if (scanState === "scanning" && !pauseRequested) {
							pauseRequested = true;
							updateButtons();
							wakeSleepFn?.();
						} else if (scanState === "paused" && resumeResolver) resumeResolver();
						else if (scanState === "done") runScan(activeMode === "TARGETED" ? "FEED" : "TARGETED");
					} else if (act === "apply") runApply();
					else if (act === "toggle-all") {
						if (isApplying) return;
						const nextVal = !(proposals.length > 0 && proposals.every((p) => p.selected));
						for (const p of proposals) {
							p.selected = nextVal;
							selectionState.set(p.entry.mediaId, nextVal);
						}
						renderResults();
						updateButtons();
					} else if (act === "select-confirmed") {
						if (isApplying) return;
						for (const p of proposals) {
							const nextVal = !isAssumedProposal(p);
							p.selected = nextVal;
							selectionState.set(p.entry.mediaId, nextVal);
						}
						renderResults();
						updateButtons();
					} else if (act === "toggle-unresolved") {
						unresolvedCollapsed = !unresolvedCollapsed;
						renderResults();
					}
				});
				modal.listen(overlay, "input", (ev) => {
					const input = ev.target;
					if (input.dataset.role === "filter") {
						filterQuery = input.value;
						renderResults();
					}
				});
				modal.listen(overlay, "change", (ev) => {
					if (isApplying) return;
					const input = ev.target;
					if (input.type === "checkbox" && input.dataset.mediaId !== void 0) {
						const mediaId = Number(input.dataset.mediaId);
						selectionState.set(mediaId, input.checked);
						const found = proposals.find((p) => p.entry.mediaId === mediaId);
						if (found) {
							found.selected = input.checked;
							const row = input.closest("tr");
							if (row) {
								row.classList.toggle("is-selected", input.checked);
								row.classList.toggle("is-unselected", !input.checked);
							}
							updateButtons();
						}
					}
				});
				const formatRateLimitHint = () => {
					const resumeAt = ctx.api.resumeAt();
					if (resumeAt <= Date.now()) return "";
					return ` (rate-limit pause: ${Math.max(1, Math.ceil((resumeAt - Date.now()) / 1e3))}s)`;
				};
				async function runScan(mode) {
					if (isApplying || scanStarting || scanState === "scanning" || modal.signal.aborted) return;
					scanStarting = true;
					const modeButtons = Array.from(bodyEl.querySelectorAll("[data-act=\"scan-fast\"], [data-act=\"scan-full\"]"));
					const backBtn = bodyEl.querySelector("[data-act=\"back-idle\"]");
					for (const btn of modeButtons) btn.disabled = true;
					if (backBtn) backBtn.disabled = true;
					primaryActionBtn.disabled = true;
					activeScanAbort?.abort();
					const scanAbort = new AbortController();
					activeScanAbort = scanAbort;
					const signal = scanAbort.signal;
					const restorePreScanButtons = () => {
						for (const btn of modeButtons) btn.disabled = false;
						if (backBtn) backBtn.disabled = scanState === "scanning";
						updateButtons();
					};
					let userId = null;
					try {
						userId = await resolveUserId(modal.signal);
					} catch (err) {
						scanStarting = false;
						if (signal.aborted || modal.signal.aborted || isAbortError(err)) return;
						ctx.log.error("Failed to resolve AniList user:", err);
						if (activeScanAbort === scanAbort) activeScanAbort = null;
						restorePreScanButtons();
						ctx.toast.error("Date backfill scan failed.");
						return;
					}
					scanStarting = false;
					if (signal.aborted || modal.signal.aborted) {
						if (!modal.signal.aborted) {
							if (activeScanAbort === scanAbort) activeScanAbort = null;
							restorePreScanButtons();
						}
						return;
					}
					if (!userId) {
						if (activeScanAbort === scanAbort) activeScanAbort = null;
						restorePreScanButtons();
						ctx.toast.error("Please log in to AniList first.");
						return;
					}
					activeMode = mode;
					pauseRequested = false;
					resumeResolver = null;
					filterQuery = "";
					unresolvedCollapsed = false;
					candidates = new Map();
					activitiesByMedia = new Map();
					seenActivityIds = new Set();
					ruledOutReasons = new Map();
					noEarlierLogsIds = new Set();
					selectionState = new Map();
					proposals = [];
					unresolved = [];
					appliedCount = 0;
					setScanState("scanning");
					setProgress(null, "scanning");
					bodyEl.innerHTML = `<p class="ala-dbf-empty-note">Fetching your list entries...</p>`;
					const scope = ctx.get("dateBackfillScope");
					const order = ctx.get("dateBackfillOrder");
					const fillPartial = ctx.get("dateBackfillPartial");
					const delayMs = ctx.get("dateBackfillDelayMs");
					const mediaTypes = scope === "BOTH" ? ["ANIME", "MANGA"] : [scope];
					const sortDir = order === "DESC" ? "ID_DESC" : "ID";
					try {
						for (const type of mediaTypes) {
							setStatusIndicator("active", `Loading ${type.toLowerCase()} list...${formatRateLimitHint()}`);
							const listRes = await ctx.api.getMediaList(userId, type, { signal });
							if (signal.aborted) return;
							for (const raw of listRes.allEntries) {
								if (raw.status === "PLANNING") continue;
								const cand = {
									entryId: raw.id,
									mediaId: raw.mediaId,
									mediaType: type,
									title: raw.media?.title?.userPreferred || raw.media?.title?.romaji || raw.media?.title?.english || `Media #${raw.mediaId}`,
									status: raw.status,
									repeat: raw.repeat ?? 0,
									startedAt: normalizeFuzzyDate(raw.startedAt),
									completedAt: normalizeFuzzyDate(raw.completedAt)
								};
								if (entryNeedsStart(cand, fillPartial) || entryNeedsFinish(cand, fillPartial)) candidates.set(cand.mediaId, cand);
							}
						}
						if (candidates.size === 0) {
							setScanState("done");
							setProgress(100, "idle");
							setStatusIndicator("done", "Done — no entries with missing dates found.");
							bodyEl.innerHTML = `<p class="ala-dbf-empty-note">All checked list entries already have dates set!</p>`;
							return;
						}
						ctx.log.debug("Candidates missing dates:", candidates.size, "mode:", mode, "order:", sortDir);
						refreshSnapshotAndRender();
						const resolvedIds = new Set();
						const foundStart = new Set();
						const foundFinish = new Set();
						const confirmedFirstEp = new Set();
						const activityTypes = mediaTypes.map((t) => `${t}_LIST`);
						const ingestActivities = (activities, effectiveOrder) => {
							for (const act of activities) {
								if (!act.media || !act.id || !act.status || !act.createdAt) continue;
								if (seenActivityIds.has(act.id)) continue;
								seenActivityIds.add(act.id);
								const mid = act.media.id;
								const cand = candidates.get(mid);
								if (!cand || resolvedIds.has(mid)) continue;
								const st = act.status.trim().toLowerCase();
								if (effectiveOrder === "ASC") {
									if (!isDateEmpty(cand.completedAt) && compareFuzzyDatesCompatible(fuzzyDateFromTimestamp(act.createdAt), cand.completedAt) > 0) {
										resolvedIds.add(mid);
										noEarlierLogsIds.add(mid);
										if (!foundStart.has(mid) && !foundFinish.has(mid)) ruledOutReasons.set(mid, "Passed completion date without earlier log");
										continue;
									}
									if ((st === "rewatched episode" || st === "reread chapter") && !foundStart.has(mid) && !foundFinish.has(mid)) {
										resolvedIds.add(mid);
										noEarlierLogsIds.add(mid);
										ruledOutReasons.set(mid, "Only rewatch/reread logs exist");
										continue;
									}
								}
								const list = activitiesByMedia.get(mid) ?? [];
								list.push({
									id: act.id,
									status: act.status,
									progress: act.progress ?? null,
									createdAt: act.createdAt,
									mediaId: mid
								});
								activitiesByMedia.set(mid, list);
								if (st === "watched episode" || st === "read chapter") {
									foundStart.add(mid);
									if (isFirstProgress(act.progress ?? null)) confirmedFirstEp.add(mid);
								} else if (st === "completed") {
									foundStart.add(mid);
									foundFinish.add(mid);
								}
								if (effectiveOrder === "ASC") {
									const startDone = !entryNeedsStart(cand, fillPartial) || foundStart.has(mid);
									const finishDone = !entryNeedsFinish(cand, fillPartial) || foundFinish.has(mid);
									if (startDone && finishDone) resolvedIds.add(mid);
								} else {
									const startDone = !entryNeedsStart(cand, fillPartial) || confirmedFirstEp.has(mid);
									const finishDone = !entryNeedsFinish(cand, fillPartial) || foundFinish.has(mid) && cand.repeat === 0;
									if (startDone && finishDone) resolvedIds.add(mid);
								}
							}
						};
						if (mode === "TARGETED") {
							const batches = chunkIds(Array.from(candidates.keys()), TARGETED_BATCH_SIZE);
							for (let bIdx = 0; bIdx < batches.length; bIdx += 1) {
								if (signal.aborted) return;
								let activeIds = batches[bIdx].filter((id) => candidates.has(id) && !resolvedIds.has(id));
								let page = 1;
								let hasNextPage = true;
								while (activeIds.length > 0 && hasNextPage && !signal.aborted) {
									if (pauseRequested) {
										await waitIfPaused(signal);
										activeIds = activeIds.filter((id) => candidates.has(id) && !resolvedIds.has(id));
										if (activeIds.length === 0) break;
									}
									const singleCand = activeIds.length === 1 ? candidates.get(activeIds[0]) : null;
									const useFinishShortcut = order === "ASC" && page > 1 && singleCand != null && singleCand.repeat === 0 && (!entryNeedsStart(singleCand, fillPartial) || foundStart.has(singleCand.mediaId)) && entryNeedsFinish(singleCand, fillPartial) && !foundFinish.has(singleCand.mediaId);
									const querySort = useFinishShortcut ? "DESC" : order;
									const queryPage = useFinishShortcut ? 1 : page;
									setProgress(Math.round(bIdx / batches.length * 100), "scanning");
									setStatusIndicator("active", `Fast Scan batch ${bIdx + 1}/${batches.length} (page ${queryPage}) — ${proposals.length} found, ${candidates.size - resolvedIds.size} searching...${formatRateLimitHint()}`);
									const pageData = await ctx.api.query(ACTIVITY_PAGE_QUERY, {
										userId,
										page: queryPage,
										types: activityTypes,
										mediaIds: activeIds,
										sort: [querySort === "DESC" ? "ID_DESC" : "ID"]
									}, { signal });
									if (signal.aborted) return;
									ingestActivities(pageData.Page.activities, querySort);
									refreshSnapshotAndRender();
									if (useFinishShortcut) break;
									const nextActiveIds = activeIds.filter((id) => candidates.has(id) && !resolvedIds.has(id));
									hasNextPage = pageData.Page.pageInfo.hasNextPage;
									if (nextActiveIds.length === 0 || !hasNextPage) break;
									if (nextActiveIds.length < activeIds.length) {
										activeIds = nextActiveIds;
										page = 1;
									} else page += 1;
									if (pauseRequested) await waitIfPaused(signal);
									else {
										await sleepInterruptible(delayMs, signal);
										if (pauseRequested) await waitIfPaused(signal);
									}
								}
							}
						} else {
							let page = 1;
							let hasNextPage = true;
							while (hasNextPage && !signal.aborted) {
								if (pauseRequested) await waitIfPaused(signal);
								if (candidates.size === 0) break;
								const orderLabel = order === "DESC" ? "newest" : "oldest";
								setProgress(null, "scanning");
								setStatusIndicator("active", `Full Feed Scan (${orderLabel} page ${page}) — ${proposals.length} found, ${candidates.size - resolvedIds.size} searching...${formatRateLimitHint()}`);
								const pageData = await ctx.api.query(ACTIVITY_PAGE_QUERY, {
									userId,
									page,
									types: activityTypes,
									sort: [sortDir]
								}, { signal });
								if (signal.aborted) return;
								ingestActivities(pageData.Page.activities, order);
								refreshSnapshotAndRender();
								if (resolvedIds.size >= candidates.size) {
									ctx.log.debug("All candidates resolved; stopping early at page", page);
									break;
								}
								hasNextPage = pageData.Page.pageInfo.hasNextPage;
								page += 1;
								if (pauseRequested) await waitIfPaused(signal);
								else if (hasNextPage) {
									await sleepInterruptible(delayMs, signal);
									if (pauseRequested) await waitIfPaused(signal);
								}
							}
						}
						if (signal.aborted) return;
						setScanState("done");
						setProgress(100, "idle");
						refreshSnapshotAndRender();
						setStatusIndicator("done", `${modeLabel(mode)} complete: ${proposals.length} found, ${unresolved.length} without matching logs.`);
					} catch (err) {
						if (signal.aborted || modal.signal.aborted || isAbortError(err)) return;
						ctx.log.error("Scan failed:", err);
						setScanState("done");
						setProgress(0, "idle");
						setStatusIndicator("idle", `Error: ${err?.message ?? String(err)}`);
						ctx.toast.error("Date backfill scan failed.");
					}
				}
				function renderResults() {
					const resultsEl = ensureResultsScaffold();
					const prevScroll = bodyEl.scrollTop;
					const isSearching = scanState === "scanning" || scanState === "paused";
					const query = filterQuery.trim().toLowerCase();
					const filteredProposals = query ? proposals.filter((p) => p.entry.title.toLowerCase().includes(query)) : proposals;
					const filteredUnresolved = query ? unresolved.filter((u) => u.entry.title.toLowerCase().includes(query)) : unresolved;
					const hasAssumed = proposals.some((p) => isAssumedProposal(p));
					const selectedCount = proposals.filter((p) => p.selected).length;
					const statsHtml = `
          <div class="ala-dbf-stats">
            <div class="ala-dbf-stat-card">
              <span class="ala-dbf-stat-label">Found Entries</span>
              <span class="ala-dbf-stat-val green">${proposals.length} <span style="font-size:1.15rem;font-weight:500;color:rgb(var(--color-text-lighter));">(${selectedCount} selected)</span></span>
            </div>
            <div class="ala-dbf-stat-card">
              <span class="ala-dbf-stat-label">${isSearching ? "Not Yet Found" : "Not Found"}</span>
              <span class="ala-dbf-stat-val">${unresolved.length}</span>
            </div>
            <div class="ala-dbf-stat-card">
              <span class="ala-dbf-stat-label">Applied</span>
              <span class="ala-dbf-stat-val blue">${appliedCount}</span>
            </div>
            <div class="ala-dbf-stat-card">
              <span class="ala-dbf-stat-label">Scan Mode</span>
              <span class="ala-dbf-stat-val" style="font-size:1.35rem;">${modeLabel(activeMode)}</span>
            </div>
          </div>
        `;
					let foundSectionHtml = "";
					if (filteredProposals.length > 0) {
						const allSelected = proposals.every((p) => p.selected);
						const confirmedOnlyBtn = hasAssumed ? `<button type="button" class="ala-dbf-btn secondary mini" data-act="select-confirmed" title="Select only entries backed by activity logs" ${isApplying ? "disabled" : ""}>Confirmed Only</button>` : "";
						const rows = filteredProposals.map((p) => {
							const assumed = isAssumedProposal(p);
							const mediaUrl = `/${p.entry.mediaType.toLowerCase()}/${p.entry.mediaId}`;
							const typeClass = p.entry.mediaType === "MANGA" ? "ala-dbf-type-badge manga" : "ala-dbf-type-badge";
							const startCell = p.newStartedAt ? `<div>
                    <div class="ala-dbf-date-diff">
                      <span class="ala-dbf-old-date">${formatFuzzyDate(p.entry.startedAt)}</span>
                      <span class="ala-dbf-arrow">→</span>
                      <span class="ala-dbf-new-date ${assumed ? "assumed" : ""}">${formatFuzzyDate(p.newStartedAt)}</span>
                    </div>
                    <div class="ala-dbf-source ${assumed ? "assumed" : ""}">${esc(p.startSource ?? "")}</div>
                  </div>` : `<span class="ala-dbf-old-date">${formatFuzzyDate(p.entry.startedAt)}</span>`;
							const finishCell = p.newCompletedAt ? `<div class="ala-dbf-date-diff">
                    <span class="ala-dbf-old-date">${formatFuzzyDate(p.entry.completedAt)}</span>
                    <span class="ala-dbf-arrow">→</span>
                    <span class="ala-dbf-new-date">${formatFuzzyDate(p.newCompletedAt)}</span>
                  </div>` : `<span class="ala-dbf-old-date">${formatFuzzyDate(p.entry.completedAt)}</span>`;
							return `
                <tr class="${p.selected ? "is-selected" : "is-unselected"}">
                  <td class="ala-dbf-check-cell"><input type="checkbox" data-media-id="${p.entry.mediaId}" ${p.selected ? "checked" : ""} ${isApplying ? "disabled" : ""} /></td>
                  <td class="ala-dbf-title-cell">
                    <a class="ala-dbf-media-link" href="${mediaUrl}" target="_blank" rel="noopener noreferrer">${esc(p.entry.title)}</a>
                    <span class="${typeClass}">${p.entry.mediaType}</span>
                  </td>
                  <td data-label="Start">${startCell}</td>
                  <td data-label="Finish">${finishCell}</td>
                </tr>
              `;
						}).join("");
						foundSectionHtml = `
            <div class="ala-dbf-section">
              <div class="ala-dbf-section-head">
                <span>Found Entries (${filteredProposals.length}${query ? ` of ${proposals.length}` : ""})</span>
                <div class="ala-dbf-actions">
                  ${confirmedOnlyBtn}
                  <button type="button" class="ala-dbf-btn secondary mini" data-act="toggle-all" ${isApplying ? "disabled" : ""}>
                    ${allSelected ? "Unselect All" : "Select All"}
                  </button>
                </div>
              </div>
              <div class="ala-dbf-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style="width:38px;"></th>
                      <th>Title</th>
                      <th style="width:225px;">Start Date</th>
                      <th style="width:185px;">Finish Date</th>
                    </tr>
                  </thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>
            </div>
          `;
					} else foundSectionHtml = `
            <div class="ala-dbf-section">
              <div class="ala-dbf-section-head">
                <span>Found Entries (0)</span>
              </div>
              <p class="ala-dbf-empty-note">${query ? "No found entries match your title filter." : isSearching ? "No dates matched yet — still scanning activity pages..." : "No matching activity history was found for the remaining entries."}</p>
            </div>
          `;
					let unresolvedSectionHtml = "";
					if (filteredUnresolved.length > 0) {
						const unresolvedHeading = isSearching ? `Not Yet Found (${filteredUnresolved.length}${query ? ` of ${unresolved.length}` : ""})` : `No Matching Activity Found (${filteredUnresolved.length}${query ? ` of ${unresolved.length}` : ""})`;
						const uRows = filteredUnresolved.map((u) => {
							const mediaUrl = `/${u.entry.mediaType.toLowerCase()}/${u.entry.mediaId}`;
							const typeClass = u.entry.mediaType === "MANGA" ? "ala-dbf-type-badge manga" : "ala-dbf-type-badge";
							const statusNote = u.ruledOutReason ? esc(u.ruledOutReason) : isSearching ? "Still scanning..." : "No matching activity in history";
							return `
                <tr>
                  <td class="ala-dbf-unresolved-title">
                    <a class="ala-dbf-media-link" href="${mediaUrl}" target="_blank" rel="noopener noreferrer">${esc(u.entry.title)}</a>
                    <span class="${typeClass}">${u.entry.mediaType}</span>
                  </td>
                  <td class="ala-dbf-unresolved-meta" data-label="Status"><span class="ala-dbf-pill">${esc(u.entry.status)}</span></td>
                  <td class="ala-dbf-unresolved-meta" data-label="Missing">${esc(u.missingLabel)}</td>
                  <td class="ala-dbf-unresolved-meta" data-label="Scan" style="color:rgb(var(--color-text-lighter));font-size:1.15rem;">${statusNote}</td>
                </tr>
              `;
						}).join("");
						const tableBody = unresolvedCollapsed ? "" : `<div class="ala-dbf-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th style="width:120px;">List Status</th>
                      <th style="width:120px;">Missing</th>
                      <th style="width:210px;">Scan Status</th>
                    </tr>
                  </thead>
                  <tbody>${uRows}</tbody>
                </table>
              </div>`;
						unresolvedSectionHtml = `
            <div class="ala-dbf-section">
              <div class="ala-dbf-section-head collapsible" data-act="toggle-unresolved">
                <span>${unresolvedHeading}</span>
                <span style="font-size:1.15rem;font-weight:600;color:rgb(var(--color-text-lighter));">
                  ${unresolvedCollapsed ? "▸ Show" : "▾ Hide"}
                </span>
              </div>
              ${tableBody}
            </div>
          `;
					}
					resultsEl.innerHTML = statsHtml + foundSectionHtml + unresolvedSectionHtml;
					bodyEl.scrollTop = prevScroll;
				}
				async function runApply() {
					if (isApplying || modal.signal.aborted) return;
					const chosen = proposals.filter((p) => p.selected);
					if (chosen.length === 0) return;
					isApplying = true;
					const previousState = scanState;
					updateButtons();
					const delayMs = ctx.get("dateBackfillDelayMs");
					const signal = modal.signal;
					let saved = 0;
					try {
						for (const item of chosen) {
							if (signal.aborted) return;
							setProgress(Math.round(saved / chosen.length * 100), "applying");
							setStatusIndicator("active", `Updating ${saved + 1}/${chosen.length}: ${item.entry.title}...${formatRateLimitHint()}`);
							const vars = { id: item.entry.entryId };
							if (item.newStartedAt) vars.startedAt = item.newStartedAt;
							if (item.newCompletedAt) vars.completedAt = item.newCompletedAt;
							await ctx.api.query(SAVE_ENTRY_MUTATION, vars, { signal });
							if (signal.aborted) return;
							candidates.delete(item.entry.mediaId);
							activitiesByMedia.delete(item.entry.mediaId);
							noEarlierLogsIds.delete(item.entry.mediaId);
							selectionState.delete(item.entry.mediaId);
							saved += 1;
							appliedCount += 1;
							if (saved < chosen.length) {
								await sleepInterruptible(delayMs, signal);
								if (signal.aborted) return;
							}
						}
						if (signal.aborted) return;
						setProgress(100, "applying");
						refreshSnapshotAndRender();
						if (previousState === "paused") setStatusIndicator("paused", `Applied ${saved} updates (scan still paused — click Resume Scan to continue).`);
						else setStatusIndicator("done", `Done! Updated ${saved} entries.`);
						ctx.toast.success(`Updated dates on ${saved} AniList entries.`);
					} catch (err) {
						if (signal.aborted || isAbortError(err)) return;
						ctx.log.error("Update failed:", err);
						setProgress(0, "idle");
						refreshSnapshotAndRender();
						setStatusIndicator("idle", `Stopped after ${saved}/${chosen.length}: ${err?.message ?? String(err)}`);
						ctx.toast.error("Failed while saving updates.");
					} finally {
						isApplying = false;
						if (!signal.aborted) setScanState(previousState);
					}
				}
			}
			ctx.menuCommand("Backfill Missing Media Dates", () => openModal());
		}
	});
	var CFG = {
		lazyMedia: false,
		rowSkipping: false,
		coalesceObservers: false,
		observerBatchMs: 80,
		gqlTtl: 15e3,
		gqlStaleTtl: 3e5,
		gqlMaxBytes: 67108864,
		gqlMaxEntryBytes: 25165824,
		prefetch: true,
		earlyStart: false,
		prefetchMaxPerMin: 12,
		prefetchDwellMs: 200,
		learnWindowMs: 8e3,
		learnMaxReqs: 6
	};
	var GQL_ORIGIN = "https://graphql.anilist.co";
	var MEDIA_ORIGIN = "https://s4.anilist.co";
	var stats = {
		graphqlRequests: 0,
		cacheHits: 0,
		deduped: 0,
		staleServed: 0,
		prefetched: 0,
		earlyStarts: 0,
		observerBatches: 0,
		observerRecordsMerged: 0
	};
	var attempt = (fn) => {
		try {
			return fn();
		} catch {}
	};
	var idle = (win, fn, timeout = 1500) => "requestIdleCallback" in win ? win.requestIdleCallback(fn, { timeout }) : setTimeout(fn, 0);
	var win = typeof _unsafeWindow !== "undefined" ? _unsafeWindow : window;
	var doc = win.document;
	var coreHooks = null;
	function setCoreHooks(hooks) {
		coreHooks = hooks;
	}
	var coreSession = null;
	function setCoreSession(session) {
		coreSession = session;
	}
	var coreStorage = null;
	function setCoreStorage(storage) {
		coreStorage = storage;
	}
	var fastLoadLog = null;
	var fastLoadRpcLog = null;
	function setFastLoadLogs(log, rpc) {
		fastLoadLog = log;
		fastLoadRpcLog = rpc;
	}
	var navListeners = [];
	var onNav = (fn) => navListeners.push(fn);
	var userMap = new Map();
	var idToUserMap = new Map();
	var store = new Map();
	var inflight = new Map();
	var bytes = 0;
	var epoch = 0;
	var pausedUntil = 0;
	var freshFloor = 0;
	var lastAuth = "";
	function setBytes(val) {
		bytes = val;
	}
	function incEpoch() {
		epoch++;
	}
	function setPausedUntil(val) {
		pausedUntil = val;
	}
	function setFreshFloor(val) {
		freshFloor = val;
	}
	function setLastAuth(val) {
		lastAuth = val;
	}
	function clearLastAuth() {
		lastAuth = "";
	}
	var rpcCache = new Map();
	var rpcInflight = new Map();
	var rpcEpoch = 0;
	var rpcClearListeners = new Set();
	function onRpcClear(fn) {
		rpcClearListeners.add(fn);
	}
	var cacheClearListeners = new Set();
	function onCacheClear(fn) {
		cacheClearListeners.add(fn);
	}
	var clearAll = () => {
		epoch++;
		store.clear();
		inflight.clear();
		bytes = 0;
	};
	var clearRpc = () => {
		rpcEpoch++;
		freshFloor = Date.now();
		rpcCache.clear();
		rpcInflight.clear();
		for (const fn of rpcClearListeners) attempt(fn);
	};
	var clearGlobalCache = () => {
		clearAll();
		clearRpc();
		for (const fn of cacheClearListeners) attempt(fn);
	};
	function resetRuntimeState() {
		clearGlobalCache();
		userMap.clear();
		idToUserMap.clear();
		pausedUntil = 0;
		freshFloor = 0;
		lastAuth = "";
	}
	function rememberUser(name, id) {
		if (!name || !id || typeof id !== "number") return;
		const normName = String(name).trim().toLowerCase();
		if (!normName) return;
		userMap.set(normName, id);
		idToUserMap.set(id, normName);
		attempt(() => {
			const raw = coreStorage?.get("userMap", null);
			const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
			const stored = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
			if (stored[normName] !== id) {
				stored[normName] = id;
				const keys = Object.keys(stored);
				if (keys.length > 300) delete stored[keys[0]];
				coreStorage?.set("userMap", stored);
			}
		});
	}
	function initUserMap() {
		attempt(() => {
			const raw = coreStorage?.get("userMap", null);
			const stored = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (!stored || typeof stored !== "object") return;
			for (const [k, v] of Object.entries(stored)) if (typeof v === "number" && v > 0) {
				userMap.set(k.toLowerCase(), v);
				idToUserMap.set(v, k.toLowerCase());
			}
		});
	}
	function getViewerFromWindow() {
		const res = {
			id: 0,
			name: ""
		};
		attempt(() => {
			const nuxt = win.__NUXT__;
			const user = nuxt?.state?.auth?.user || nuxt?.state?.user;
			if (user) {
				if (typeof user.id === "number" && user.id > 0) res.id = user.id;
				if (typeof user.name === "string" && user.name) res.name = user.name;
			}
		});
		if (!res.id || !res.name) {
			const snap = coreSession?.peek();
			if (!res.id && snap?.userId) res.id = snap.userId;
			if (!res.name && snap?.username) res.name = snap.username;
		}
		if (!res.name && doc) {
			const m = (doc.querySelector("nav a[href^=\"/user/\"], .nav-wrap a[href^=\"/user/\"], .nav a[href^=\"/user/\"]")?.getAttribute("href"))?.match(/^\/user\/([^/?#]+)/);
			if (m) try {
				res.name = decodeURIComponent(m[1]);
			} catch {}
		}
		return res;
	}
	function getLocalUsername() {
		return getViewerFromWindow().name || null;
	}
	function registerGlobalBridges() {
		win.__ALFL_STATS__ = stats;
		win.__ALFL_CLEAR__ = clearGlobalCache;
		win.__ALFL_GQL_STORE__ = store;
		win.__ALFL_RPC_CACHE__ = rpcCache;
		win.__ALFL_RPC_INFLIGHT__ = rpcInflight;
		win.__ALFL_USER_MAP__ = userMap;
		win.__ALFL_ID_MAP__ = idToUserMap;
	}
	function unregisterGlobalBridges() {
		if (win.__ALFL_STATS__ === stats) delete win.__ALFL_STATS__;
		if (win.__ALFL_CLEAR__ === clearGlobalCache) delete win.__ALFL_CLEAR__;
		if (win.__ALFL_GQL_STORE__ === store) delete win.__ALFL_GQL_STORE__;
		if (win.__ALFL_RPC_CACHE__ === rpcCache) delete win.__ALFL_RPC_CACHE__;
		if (win.__ALFL_RPC_INFLIGHT__ === rpcInflight) delete win.__ALFL_RPC_INFLIGHT__;
		if (win.__ALFL_USER_MAP__ === userMap) delete win.__ALFL_USER_MAP__;
		if (win.__ALFL_ID_MAP__ === idToUserMap) delete win.__ALFL_ID_MAP__;
	}
	var patchedCreateFns = new WeakSet();
	function installLazyMedia() {
		const restores = [];
		const lazify = (el) => {
			if (!el || el.nodeType !== 1) return;
			switch (el.localName) {
				case "img":
					if (!el.hasAttribute("loading")) el.loading = "lazy";
					if (!el.hasAttribute("decoding")) el.decoding = "async";
					break;
				case "iframe":
					if (!el.hasAttribute("loading")) el.loading = "lazy";
					break;
				case "video": if (!el.hasAttribute("preload")) el.preload = "metadata";
			}
		};
		const seenTargets = new Set();
		const patchCreate = (target) => {
			if (!target || seenTargets.has(target)) return;
			seenTargets.add(target);
			const orig = target.createElement;
			if (typeof orig !== "function" || patchedCreateFns.has(orig)) return;
			const hadOwn = Object.prototype.hasOwnProperty.call(target, "createElement");
			const origDesc = hadOwn ? Object.getOwnPropertyDescriptor(target, "createElement") : void 0;
			const patched = function(tag, options) {
				const el = orig.call(this, tag, options);
				try {
					lazify(el);
				} catch {}
				return el;
			};
			patchedCreateFns.add(patched);
			let installed = false;
			try {
				target.createElement = patched;
				installed = target.createElement === patched;
			} catch {
				try {
					Object.defineProperty(target, "createElement", {
						value: patched,
						writable: true,
						configurable: true
					});
					installed = target.createElement === patched;
				} catch {}
			}
			if (installed) restores.push(() => {
				if (target.createElement !== patched) return;
				if (!hadOwn) try {
					delete target.createElement;
					return;
				} catch {}
				if (origDesc) try {
					Object.defineProperty(target, "createElement", origDesc);
					return;
				} catch {}
				try {
					target.createElement = orig;
				} catch {
					try {
						Object.defineProperty(target, "createElement", {
							value: orig,
							writable: true,
							configurable: true
						});
					} catch {}
				}
			});
		};
		patchCreate(win.Document?.prototype);
		patchCreate(win.HTMLDocument?.prototype);
		patchCreate(Document.prototype);
		patchCreate(doc);
		if (typeof document !== "undefined" && document !== doc) patchCreate(document);
		const MEDIA_TAG = /<(?:img|iframe|video)[\s>/]/i;
		const MEDIA_SEL = "img:not([loading]),iframe:not([loading]),video:not([preload])";
		const lazifyTree = (root) => {
			if (!root || typeof root.querySelectorAll !== "function") return;
			lazify(root);
			for (const el of root.querySelectorAll(MEDIA_SEL)) lazify(el);
		};
		const ElementProto = win.Element?.prototype || Element.prototype;
		attempt(() => {
			const desc = Object.getOwnPropertyDescriptor(ElementProto, "innerHTML");
			if (!desc || !desc.set || !desc.configurable) return;
			const patchedSet = function(value) {
				desc.set.call(this, value);
				if (typeof value === "string" && MEDIA_TAG.test(value)) attempt(() => lazifyTree(this instanceof win.HTMLTemplateElement ? this.content : this));
			};
			Object.defineProperty(ElementProto, "innerHTML", {
				...desc,
				set: patchedSet
			});
			restores.push(() => {
				if (Object.getOwnPropertyDescriptor(ElementProto, "innerHTML")?.set === patchedSet) Object.defineProperty(ElementProto, "innerHTML", desc);
			});
		});
		attempt(() => {
			const native = ElementProto.insertAdjacentHTML;
			if (typeof native !== "function") return;
			const patchedInsert = function(position, html) {
				const r = native.call(this, position, html);
				if (typeof html === "string" && MEDIA_TAG.test(html)) {
					const outer = /^(?:beforebegin|afterend)$/i.test(position);
					attempt(() => lazifyTree(outer ? this.parentNode : this));
				}
				return r;
			};
			ElementProto.insertAdjacentHTML = patchedInsert;
			restores.push(() => {
				if (ElementProto.insertAdjacentHTML === patchedInsert) ElementProto.insertAdjacentHTML = native;
			});
		});
		return () => {
			for (let i = restores.length - 1; i >= 0; i--) attempt(restores[i]);
		};
	}
	var ROW_GROUPS = [
		{
			selector: ".medialist .entry.row",
			h: 56
		},
		{
			selector: ".medialist .entry-card",
			h: 220
		},
		{
			selector: ".activity-entry",
			h: 160
		}
	];
	function injectCSS(text) {
		try {
			if ("adoptedStyleSheets" in doc && typeof win.CSSStyleSheet !== "undefined") {
				const sheet = new win.CSSStyleSheet();
				sheet.replaceSync(text);
				doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
				return () => {
					attempt(() => {
						doc.adoptedStyleSheets = (doc.adoptedStyleSheets || []).filter((s) => s !== sheet);
					});
				};
			}
		} catch {}
		const style = doc.createElement("style");
		style.textContent = text;
		(doc.head || doc.documentElement).appendChild(style);
		return () => {
			attempt(() => style.remove());
		};
	}
	function installRowSkipping(deps) {
		let disposed = false;
		const cssText = `@supports (content-visibility: auto) and (contain-intrinsic-height: auto 1px) { ${ROW_GROUPS.map(({ selector, h }, i) => `
        ${selector} {
            content-visibility: auto;
            contain-intrinsic-height: auto var(--alfast-h${i}, ${h}px);
            overflow-clip-margin: 16px;
        }
        ${selector}:hover,
        ${selector}:focus-within {
            content-visibility: visible;
        }`).join("\n")} }`;
		const removeStyle = deps?.addStyle ? deps.addStyle(cssText) : injectCSS(cssText);
		const addListener = deps?.listen ?? ((t, type, fn, opts) => {
			t.addEventListener(type, fn, opts);
			return () => t.removeEventListener(type, fn, opts);
		});
		const measuredFor = ROW_GROUPS.map(() => "");
		let timers = [];
		let resizeTimer = 0;
		function measure() {
			if (disposed) return;
			const path = win.location.pathname;
			const vh = win.innerHeight || doc.documentElement.clientHeight;
			ROW_GROUPS.forEach(({ selector }, i) => {
				if (measuredFor[i] === path) return;
				let nodes;
				try {
					nodes = doc.querySelectorAll(selector);
				} catch {
					return;
				}
				let total = 0;
				let count = 0;
				for (const el of nodes) {
					const r = el.getBoundingClientRect();
					if (r.top > vh) break;
					if (r.height > 0 && r.bottom > 0) {
						total += r.height;
						if (++count >= 6) break;
					}
				}
				if (!count) return;
				doc.documentElement.style.setProperty(`--alfast-h${i}`, `${Math.max(1, Math.round(total / count))}px`);
				measuredFor[i] = path;
			});
		}
		function schedule() {
			timers.forEach(clearTimeout);
			timers = [];
			if (disposed) return;
			timers = [
				500,
				1800,
				4500
			].map((ms) => setTimeout(() => idle(win, () => {
				if (!disposed && !doc.hidden) measure();
			}), ms));
		}
		onNav(schedule);
		const listenerCleanups = [];
		if (doc.readyState !== "loading") schedule();
		else listenerCleanups.push(addListener(doc, "DOMContentLoaded", schedule, { once: true }));
		listenerCleanups.push(addListener(win, "load", schedule, { once: true }));
		const onResize = () => {
			clearTimeout(resizeTimer);
			if (disposed) return;
			resizeTimer = setTimeout(() => {
				resizeTimer = 0;
				if (disposed) return;
				measuredFor.fill("");
				schedule();
			}, 200);
		};
		listenerCleanups.push(addListener(win, "resize", onResize, { passive: true }));
		listenerCleanups.push(addListener(win, "orientationchange", onResize, { passive: true }));
		return () => {
			disposed = true;
			timers.forEach(clearTimeout);
			timers = [];
			clearTimeout(resizeTimer);
			resizeTimer = 0;
			const navIdx = navListeners.indexOf(schedule);
			if (navIdx >= 0) navListeners.splice(navIdx, 1);
			for (const unsub of listenerCleanups) attempt(unsub);
			attempt(removeStyle);
			attempt(() => {
				for (let i = 0; i < ROW_GROUPS.length; i++) doc.documentElement?.style?.removeProperty(`--alfast-h${i}`);
			});
		};
	}
	function installObserverCoalescing() {
		const Native = win.MutationObserver;
		if (typeof Native !== "function") return () => {};
		let disposed = false;
		const states = new WeakMap();
		const activeTimers = new Set();
		const ignoresRecords = (fn) => {
			if (typeof fn !== "function" || fn.length !== 0) return false;
			try {
				const src = Function.prototype.toString.call(fn);
				if (/\barguments\b/.test(src)) return false;
				const params = /^[^(]*\(([^)]*)\)/.exec(src);
				return !params || params[1].trim() === "";
			} catch {
				return false;
			}
		};
		const isPageRoot = (t) => t === doc || t === doc.documentElement || t === doc.body;
		function schedule(st) {
			if (disposed || st.timer) return;
			const wait = Math.max(0, st.last + CFG.observerBatchMs - performance.now());
			const handle = setTimeout(() => {
				activeTimers.delete(handle);
				st.timer = 0;
				if (disposed || !st.queue.length) return;
				const records = st.queue.splice(0);
				stats.observerBatches++;
				stats.observerRecordsMerged += records.length;
				try {
					st.callback.call(st.self, records, st.self);
				} catch (e) {
					setTimeout(() => {
						throw e;
					});
				}
				st.last = performance.now();
			}, wait);
			st.timer = handle;
			activeTimers.add(handle);
		}
		class CoalescedMutationObserver extends Native {
			constructor(callback) {
				const st = {
					callback,
					eligible: ignoresRecords(callback),
					on: false,
					queue: [],
					timer: 0,
					last: -Infinity,
					self: null
				};
				super(typeof callback === "function" ? (records) => {
					if (disposed || !st.on) return callback.call(st.self, records, st.self);
					for (const r of records) st.queue.push(r);
					schedule(st);
				} : callback);
				st.self = this;
				states.set(this, st);
			}
			observe(target, options) {
				const st = states.get(this);
				if (st && !disposed && st.eligible && options && options.subtree && isPageRoot(target)) st.on = true;
				return super.observe(target, options);
			}
			disconnect() {
				const st = states.get(this);
				if (st) {
					if (st.timer) {
						clearTimeout(st.timer);
						activeTimers.delete(st.timer);
						st.timer = 0;
					}
					st.queue.length = 0;
					st.on = false;
				}
				return super.disconnect();
			}
			takeRecords() {
				const st = states.get(this);
				const pending = super.takeRecords();
				return st ? st.queue.splice(0).concat(pending) : pending;
			}
		}
		try {
			Object.defineProperty(win, "MutationObserver", {
				value: CoalescedMutationObserver,
				writable: true,
				configurable: true
			});
		} catch {
			win.MutationObserver = CoalescedMutationObserver;
		}
		return () => {
			disposed = true;
			for (const t of activeTimers) clearTimeout(t);
			activeTimers.clear();
			if (win.MutationObserver === CoalescedMutationObserver) try {
				Object.defineProperty(win, "MutationObserver", {
					value: Native,
					writable: true,
					configurable: true
				});
			} catch {
				win.MutationObserver = Native;
			}
		};
	}
	var UNFILTERED_MLC_KEYS = new Set([
		"type",
		"userId",
		"userName"
	]);
	var GQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
	var GQL_TOKEN_RE = /#[^\n\r]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|\.\.\.|[{}():@$\[\]]|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*/g;
	function decodeGqlString(tok) {
		if (tok.startsWith("\"\"\"") && tok.endsWith("\"\"\"") && tok.length >= 6) return tok.slice(3, -3);
		if (tok.startsWith("\"") && tok.endsWith("\"") && tok.length >= 2) try {
			const parsed = JSON.parse(tok);
			return typeof parsed === "string" ? parsed : null;
		} catch {
			return tok.slice(1, -1);
		}
		return null;
	}
	function stripGqlCommentsAndStrings(q) {
		if (typeof q !== "string") return "";
		return q.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\n\r]*/g, " ");
	}
	function scanGqlRoot(q) {
		const fields = new Set();
		const mlcArgs = new Map();
		let rootFieldCount = 0;
		let hasMutation = false;
		let mlcArgsOk = true;
		let hasRootFragment = false;
		let hasAliasedMlc = false;
		if (typeof q !== "string" || !q) return {
			fields,
			rootFieldCount,
			hasMutation,
			mlcArgsOk,
			mlcArgs,
			hasRootFragment,
			hasAliasedMlc
		};
		const rawTokens = q.match(GQL_TOKEN_RE);
		const tokens = rawTokens ? rawTokens.filter((t) => t[0] !== "#") : null;
		if (!tokens || tokens.length === 0) return {
			fields,
			rootFieldCount,
			hasMutation,
			mlcArgsOk,
			mlcArgs,
			hasRootFragment,
			hasAliasedMlc
		};
		let braceDepth = 0;
		let parenDepth = 0;
		let blockKind = "none";
		let nextHeader = null;
		let inMlcArgs = false;
		let mlcCount = 0;
		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			if (tok === "{") {
				if (braceDepth === 0 && parenDepth === 0) {
					blockKind = nextHeader === "other" ? "other" : "query";
					nextHeader = null;
				}
				braceDepth++;
				continue;
			}
			if (tok === "}") {
				if (braceDepth > 0) braceDepth--;
				if (braceDepth === 0) blockKind = "none";
				continue;
			}
			if (tok === "(") {
				if (blockKind === "query" && braceDepth === 1 && parenDepth === 0 && tokens[i - 1] === "MediaListCollection") inMlcArgs = true;
				parenDepth++;
				continue;
			}
			if (tok === ")") {
				if (parenDepth > 0) parenDepth--;
				if (parenDepth === 0) inMlcArgs = false;
				continue;
			}
			if (braceDepth === 0 && parenDepth === 0) {
				if (tok === "mutation") {
					hasMutation = true;
					nextHeader = "other";
				} else if (tok === "subscription" || tok === "fragment") nextHeader = "other";
				else if (tok === "query") nextHeader = "query";
				continue;
			}
			if (inMlcArgs && parenDepth === 1) {
				if (!GQL_IDENT_RE.test(tok) || tokens[i + 1] !== ":") {
					mlcArgsOk = false;
					continue;
				}
				if (!UNFILTERED_MLC_KEYS.has(tok) || mlcArgs.has(tok)) {
					mlcArgsOk = false;
					i += 1;
					continue;
				}
				const valIdx = i + 2;
				const valTok = tokens[valIdx];
				if (valTok === "$") {
					const varName = tokens[valIdx + 1];
					if (varName && GQL_IDENT_RE.test(varName)) {
						mlcArgs.set(tok, {
							kind: "var",
							name: varName
						});
						i = valIdx + 1;
					} else mlcArgsOk = false;
				} else if (tok === "type" && valTok && /^(?:ANIME|MANGA)$/.test(valTok)) {
					mlcArgs.set("type", {
						kind: "literal",
						value: valTok
					});
					i = valIdx;
				} else if (tok === "userId" && valTok && /^\d+$/.test(valTok)) {
					const num = Number(valTok);
					if (Number.isSafeInteger(num) && num > 0) {
						mlcArgs.set("userId", {
							kind: "literal",
							value: num
						});
						i = valIdx;
					} else mlcArgsOk = false;
				} else if (tok === "userName" && valTok && valTok[0] === "\"") {
					const str = decodeGqlString(valTok);
					if (typeof str === "string" && str.trim().length > 0) {
						mlcArgs.set("userName", {
							kind: "literal",
							value: str
						});
						i = valIdx;
					} else mlcArgsOk = false;
				} else mlcArgsOk = false;
				continue;
			}
			if (blockKind === "query" && braceDepth === 1 && parenDepth === 0) {
				if (tok === "...") {
					hasRootFragment = true;
					continue;
				}
				if (tok === "@") {
					if (fields.has("MediaListCollection")) mlcArgsOk = false;
					continue;
				}
				if (!GQL_IDENT_RE.test(tok)) continue;
				const prev = tokens[i - 1];
				const next = tokens[i + 1];
				if (prev === "..." || prev === "@" || next === ":") continue;
				if (tok === "MediaListCollection") {
					mlcCount++;
					if (prev === ":" || mlcCount > 1) hasAliasedMlc = true;
				}
				rootFieldCount++;
				fields.add(tok);
			}
		}
		return {
			fields,
			rootFieldCount,
			hasMutation,
			mlcArgsOk,
			mlcArgs,
			hasRootFragment,
			hasAliasedMlc
		};
	}
	function getTaxonomyKind(parsed) {
		const { fields } = scanGqlRoot(String(parsed?.query || ""));
		const hasGenre = fields.has("GenreCollection");
		const hasTag = fields.has("MediaTagCollection");
		if (hasGenre && hasTag && fields.size === 2) return "both";
		if (hasGenre && !hasTag && fields.size === 1) return "genres";
		if (!hasGenre && hasTag && fields.size === 1) return "tags";
		return null;
	}
	var isTaxonomyQuery = (parsed) => getTaxonomyKind(parsed) !== null;
	var isMediaListQuery = (parsed) => scanGqlRoot(String(parsed?.query || "")).fields.has("MediaListCollection");
	function resolveMediaListQuery(parsed) {
		const scan = scanGqlRoot(String(parsed?.query || ""));
		const rawVars = parsed?.variables && typeof parsed.variables === "object" && !Array.isArray(parsed.variables) ? parsed.variables : {};
		let hasInlineLiterals = false;
		for (const ref of scan.mlcArgs.values()) if (ref.kind === "literal") {
			hasInlineLiterals = true;
			break;
		}
		let canonical = scan.fields.size === 1 && scan.fields.has("MediaListCollection") && scan.rootFieldCount === 1 && !scan.hasMutation && !scan.hasRootFragment && !scan.hasAliasedMlc && scan.mlcArgsOk;
		if (!canonical) return {
			canonical: false,
			vars: normalizeVariables(rawVars),
			hasInlineLiterals
		};
		const boundVarNames = new Set();
		for (const ref of scan.mlcArgs.values()) if (ref.kind === "var") boundVarNames.add(ref.name);
		for (const k of Object.keys(rawVars)) {
			if (rawVars[k] === void 0 || rawVars[k] === null) continue;
			if (!boundVarNames.has(k) && !UNFILTERED_MLC_KEYS.has(k)) {
				canonical = false;
				break;
			}
		}
		const effectiveVars = {};
		if (canonical) {
			const typeArg = scan.mlcArgs.get("type");
			if (typeArg?.kind === "literal") {
				const lit = String(typeArg.value).toUpperCase();
				if (rawVars.type !== void 0 && rawVars.type !== null && String(rawVars.type).toUpperCase() !== lit) canonical = false;
				else effectiveVars.type = lit;
			} else if (typeArg?.kind === "var") {
				const v = rawVars[typeArg.name];
				if (v !== void 0 && v !== null) {
					if (typeof v !== "string" || !/^(?:ANIME|MANGA)$/i.test(v.trim())) canonical = false;
					else {
						const norm = v.trim().toUpperCase();
						if (typeArg.name !== "type" && rawVars.type !== void 0 && rawVars.type !== null && String(rawVars.type).toUpperCase() !== norm) canonical = false;
						else effectiveVars.type = norm;
					}
				}
			} else if (rawVars.type !== void 0 && rawVars.type !== null && String(rawVars.type).toUpperCase() !== "ANIME") canonical = false;
		}
		if (canonical) {
			const idArg = scan.mlcArgs.get("userId");
			if (idArg?.kind === "literal") {
				const lit = Number(idArg.value);
				if (rawVars.userId !== void 0 && rawVars.userId !== null && Number(rawVars.userId) !== lit) canonical = false;
				else effectiveVars.userId = lit;
			} else if (idArg?.kind === "var") {
				const v = rawVars[idArg.name];
				if (v !== void 0 && v !== null) {
					const num = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
					if (!Number.isSafeInteger(num) || num <= 0) canonical = false;
					else if (idArg.name !== "userId" && rawVars.userId !== void 0 && rawVars.userId !== null && Number(rawVars.userId) !== num) canonical = false;
					else effectiveVars.userId = num;
				}
			} else if (rawVars.userId !== void 0 && rawVars.userId !== null) canonical = false;
		}
		if (canonical) {
			const nameArg = scan.mlcArgs.get("userName");
			if (nameArg?.kind === "literal") {
				const lit = String(nameArg.value).trim();
				if (rawVars.userName !== void 0 && rawVars.userName !== null && String(rawVars.userName).trim().toLowerCase() !== lit.toLowerCase()) canonical = false;
				else effectiveVars.userName = lit;
			} else if (nameArg?.kind === "var") {
				const v = rawVars[nameArg.name];
				if (v !== void 0 && v !== null) {
					if (typeof v !== "string" || !v.trim()) canonical = false;
					else if (nameArg.name !== "userName" && rawVars.userName !== void 0 && rawVars.userName !== null && String(rawVars.userName).trim().toLowerCase() !== v.trim().toLowerCase()) canonical = false;
					else effectiveVars.userName = v.trim();
				}
			} else if (rawVars.userName !== void 0 && rawVars.userName !== null) canonical = false;
		}
		if (canonical && effectiveVars.userId && effectiveVars.userName) {
			const mappedId = userMap.get(String(effectiveVars.userName).toLowerCase());
			if (mappedId && mappedId !== effectiveVars.userId) canonical = false;
			else if (scan.mlcArgs.get("userId")?.kind === "literal" && scan.mlcArgs.get("userName")?.kind === "literal" && mappedId !== effectiveVars.userId) canonical = false;
		}
		return {
			canonical,
			vars: normalizeVariables(canonical ? effectiveVars : rawVars),
			hasInlineLiterals
		};
	}
	function isUnfilteredMediaListQuery(parsed) {
		return resolveMediaListQuery(parsed).canonical;
	}
	var isViewerQuery = (parsed) => scanGqlRoot(String(parsed?.query || "")).fields.has("Viewer");
	var isUserQuery = (parsed) => scanGqlRoot(String(parsed?.query || "")).fields.has("User") && !isVolatile(parsed);
	var isMutation = (parsed) => scanGqlRoot(String(parsed?.query || "")).hasMutation;
	var isVolatile = (parsed) => /\b(?:notifications|activities|Activity|Notification)\s*\(/.test(stripGqlCommentsAndStrings(String(parsed?.query || "")));
	var noStore = (d) => d.cache === "no-store" || d.cache === "reload" || !!d.headers.get("cache-control")?.toLowerCase().includes("no-store");
	function normalizeGqlQuery(q) {
		if (typeof q !== "string") return "";
		return q.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\n\r]*/g, (m) => m[0] === "#" ? "" : m).replace(/\s+/g, " ").replace(/\s*([{}():,])\s*/g, "$1").trim();
	}
	function hashString(input) {
		let h1 = 2166136261;
		let h2 = 2166136261;
		for (let i = 0; i < input.length; i++) {
			const c = input.charCodeAt(i);
			h1 ^= c;
			h1 = Math.imul(h1, 16777619);
			h2 ^= c + (i & 255);
			h2 = Math.imul(h2, 16777619);
		}
		return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
	}
	function hashGqlQuery(q) {
		return hashString(normalizeGqlQuery(q));
	}
	function stableStringify(obj) {
		if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
		if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
		return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
	}
	function normalizeVariables(vars) {
		if (!vars || typeof vars !== "object") return {};
		const copy = {};
		for (const k of Object.keys(vars)) if (vars[k] !== void 0 && vars[k] !== null) copy[k] = vars[k];
		if (copy.userName && !copy.userId) {
			const name = String(copy.userName).toLowerCase();
			const snap = coreSession?.peek();
			const mine = String(snap?.username || "").toLowerCase();
			const id = userMap.get(name) || (name === mine && snap?.userId ? Number(snap.userId) : 0);
			if (id) {
				copy.userId = id;
				delete copy.userName;
			}
		}
		if (copy.userId && copy.userName) delete copy.userName;
		return copy;
	}
	function parseBody(body) {
		try {
			const parsed = JSON.parse(body);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.query === "string" ? parsed : null;
		} catch {
			return null;
		}
	}
	function buildQueryCacheKey(prefix, endpoint, query, variables, authHeader) {
		const queryStr = typeof query === "string" ? query : String(query || "");
		const q = {
			query: queryStr,
			variables
		};
		if (isMediaListQuery(q)) {
			const { canonical, vars } = resolveMediaListQuery(q);
			const { type = "ANIME", userId, userName, ...rest } = vars;
			let resolvedId = userId;
			if (!resolvedId && userName) resolvedId = userMap.get(String(userName).toLowerCase());
			const who = resolvedId || (userName ? String(userName).toLowerCase() : getViewerFromWindow().id || "me");
			const suffix = canonical ? stableStringify(rest) : `${stableStringify(rest)}:${hashGqlQuery(queryStr)}`;
			return `${prefix}:MediaListCollection:${String(type).toUpperCase()}:${who}:${suffix}`;
		}
		const taxKind = getTaxonomyKind(q);
		if (taxKind) {
			const normVars = stableStringify(normalizeVariables(variables));
			return `${prefix}:Taxonomy:${taxKind}:${hashGqlQuery(queryStr)}:${normVars}`;
		}
		const auth = String(authHeader || "");
		if (isViewerQuery(q)) {
			const authId = auth ? hashString(auth) : "anon";
			const normVars = stableStringify(normalizeVariables(variables));
			return `${prefix}:Viewer:${authId}:${hashGqlQuery(queryStr)}:${normVars}`;
		}
		const normQuery = normalizeGqlQuery(queryStr);
		const normVars = stableStringify(normalizeVariables(variables));
		return `${String(endpoint ?? "")}\u0001${auth ? hashString(auth) : ""}\u0001${normQuery}\u0001${normVars}`;
	}
	function isRpcBlocked(query, variables) {
		const queryStr = typeof query === "string" ? query : query == null ? "" : String(query);
		if (coreHooks?.isRpcBlocked(queryStr, variables)) return true;
		const blocker = win.__ALFL_RPC_BLOCK__;
		if (typeof blocker === "function") try {
			return Boolean(blocker(queryStr, variables));
		} catch {
			return false;
		}
		return false;
	}
	var workerPending = new WeakMap();
	var watched = new WeakSet();
	var workerUrl = null;
	var workerOpts;
	var WorkerCtor = null;
	var workerDisposed = false;
	var activeYielded = null;
	var activePrefetchCleanups = new Set();
	var isWorkerInactive = (yielded) => workerDisposed || Boolean(yielded?.()) || Boolean(activeYielded?.());
	var RPC_MAX_ENTRIES = 32;
	var PREFETCH_COOLDOWN_MS = 6e4;
	var PREFETCH_KEYS_MAX = 200;
	var clone = (v) => {
		try {
			return (win.structuredClone || structuredClone)(v);
		} catch {
			return JSON.parse(JSON.stringify(v));
		}
	};
	var findWorkerUrl = () => workerUrl || performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\.worker\.js(?:\?|$)/.test(n)) || attempt(() => coreStorage?.get("workerUrl", null)) || null;
	var isRpcFetch = (d) => !!d && d.type === "RPC" && d.method === "fetch" && Array.isArray(d.params) && typeof d.params[1] === "string";
	var rpcKey = (params) => {
		const [endpoint, query, variables, headers] = params;
		return buildQueryCacheKey("rpc", endpoint, query, variables, String(headers?.Authorization ?? headers?.authorization ?? ""));
	};
	function hasMediaListNextChunk(res) {
		if (!res || typeof res !== "object") return false;
		return res.hasNextChunk === true || res.MediaListCollection?.hasNextChunk === true || res.data?.MediaListCollection?.hasNextChunk === true;
	}
	function extractUsersFromRpcResult(res) {
		if (!res || typeof res !== "object") return;
		attempt(() => {
			const scanUsers = (obj, depth = 0) => {
				if (!obj || typeof obj !== "object" || depth > 5) return;
				if (typeof obj.name === "string" && obj.avatar && obj.id && (typeof obj.id === "number" || /^\d+$/.test(String(obj.id)))) rememberUser(String(obj.name), Number(obj.id));
				for (const v of Object.values(obj)) if (v && typeof v === "object") scanUsers(v, depth + 1);
			};
			scanUsers(res);
			const viewer = res.Viewer || res.data?.Viewer;
			if (viewer && (viewer.id || viewer.name)) {
				if (viewer.id && viewer.name) rememberUser(String(viewer.name), Number(viewer.id));
				coreSession?.recordHint({
					userId: viewer.id ? Number(viewer.id) : void 0,
					username: viewer.name ? String(viewer.name) : void 0
				});
			}
			const user = res.User || res.data?.User || res.MediaListCollection?.user || res.data?.MediaListCollection?.user;
			if (user && user.id && user.name) rememberUser(String(user.name), Number(user.id));
		});
	}
	var onIn = function(ev) {
		if (isWorkerInactive()) return;
		const d = ev.data;
		if (!d || d.type !== "RPC") return;
		const id = String(d.id);
		const worker = ev.currentTarget || ev.target || this;
		const pMap = workerPending.get(worker);
		if (!pMap) return;
		const p = pMap.get(id);
		if (!p) return;
		pMap.delete(id);
		fastLoadRpcLog?.debug("IN", id, Object.keys(d));
		if (d.result) extractUsersFromRpcResult(d.result);
		if (p.mutation) {
			if (coreHooks?.hasGqlFetchSubscribers() && p.query) coreHooks.emitGqlFetch({
				phase: "response",
				url: p.url || "/graphql",
				query: p.query,
				variables: p.variables || {},
				operationName: p.operationName,
				status: d.error == null ? 200 : 500,
				ok: d.error == null,
				data: d.result?.data ?? d.result,
				errors: d.error != null ? [{ message: String(d.error) }] : Array.isArray(d.result?.errors) ? d.result.errors : void 0
			});
			return clearGlobalCache();
		}
		if (p.key && d.error == null && p.epoch === rpcEpoch) attempt(() => {
			const hasNextChunk = hasMediaListNextChunk(d.result);
			const unfilteredMlcMatch = p.key?.match(/^rpc:MediaListCollection:([A-Z]+):([^:]+):\{\}$/i);
			if (unfilteredMlcMatch && hasNextChunk) return;
			const cached = {
				time: Date.now(),
				msg: clone(d)
			};
			let moreKeys = [];
			const mlcUser = d.result?.MediaListCollection?.user || d.result?.data?.MediaListCollection?.user;
			const uid = mlcUser?.id ? Number(mlcUser.id) : void 0;
			const uname = mlcUser?.name ? String(mlcUser.name) : void 0;
			if (uid && uname) rememberUser(uname, uid);
			if (unfilteredMlcMatch && !hasNextChunk) {
				const type = unfilteredMlcMatch[1];
				const target = unfilteredMlcMatch[2];
				const isNumeric = /^\d+$/.test(target);
				const resolvedUserId = isNumeric ? Number(target) : uid || userMap.get(target.toLowerCase());
				moreKeys = getMediaListKeys(type, resolvedUserId, !isNumeric ? target : uname || (resolvedUserId ? idToUserMap.get(resolvedUserId) : void 0));
			}
			const keysToSet = [...new Set([
				p.key,
				...p.extraKeys || [],
				...moreKeys
			])];
			for (const k of keysToSet) {
				rpcCache.delete(k);
				rpcCache.set(k, cached);
			}
			while (rpcCache.size > RPC_MAX_ENTRIES) rpcCache.delete(rpcCache.keys().next().value);
		});
	};
	var getMediaListKeys = (type, userId, userName) => {
		const keys = new Set();
		const t = String(type).toUpperCase();
		if (userId) {
			keys.add(`rpc:MediaListCollection:${t}:${userId}:{}`);
			const mappedName = idToUserMap.get(userId);
			if (mappedName) keys.add(`rpc:MediaListCollection:${t}:${mappedName}:{}`);
		}
		if (userName) {
			const norm = String(userName).trim().toLowerCase();
			keys.add(`rpc:MediaListCollection:${t}:${norm}:{}`);
			const mappedId = userMap.get(norm);
			if (mappedId) keys.add(`rpc:MediaListCollection:${t}:${mappedId}:{}`);
		}
		return [...keys];
	};
	var prefetchedWorkerKeys = new Map();
	onRpcClear(() => prefetchedWorkerKeys.clear());
	function recordPrefetchedWorkerKeys(keys, now) {
		if (prefetchedWorkerKeys.size >= PREFETCH_KEYS_MAX) {
			for (const [k, t] of prefetchedWorkerKeys) if (now - t >= PREFETCH_COOLDOWN_MS) prefetchedWorkerKeys.delete(k);
			while (prefetchedWorkerKeys.size >= PREFETCH_KEYS_MAX) {
				const oldest = prefetchedWorkerKeys.keys().next().value;
				if (oldest === void 0) break;
				prefetchedWorkerKeys.delete(oldest);
			}
		}
		for (const k of keys) {
			prefetchedWorkerKeys.delete(k);
			prefetchedWorkerKeys.set(k, now);
		}
		while (prefetchedWorkerKeys.size > PREFETCH_KEYS_MAX) {
			const oldest = prefetchedWorkerKeys.keys().next().value;
			if (oldest === void 0) break;
			prefetchedWorkerKeys.delete(oldest);
		}
	}
	function prefetchWorkerList(type, userId, userName, yielded) {
		if (isWorkerInactive(yielded) || coreHooks?.isPrefetchSuppressed()) return;
		const url = findWorkerUrl();
		if (!url || !WorkerCtor) {
			fastLoadRpcLog?.debug("Prefetch skipped: worker script unknown");
			return;
		}
		if (!userId && userName) userId = userMap.get(userName.toLowerCase()) || 0;
		if (userId && !userName) userName = idToUserMap.get(userId) || void 0;
		const raw = attempt(() => coreStorage?.get("rpc:listTpl:v2", null));
		let tpl;
		if (raw) try {
			tpl = typeof raw === "string" ? JSON.parse(raw) : raw;
		} catch {}
		if (!tpl || typeof tpl.query !== "string" || !isUnfilteredMediaListQuery({
			query: tpl.query,
			variables: tpl.vars
		})) {
			fastLoadRpcLog?.debug("Prefetch skipped: no list template yet");
			return;
		}
		const vars = {
			...tpl.vars || {},
			type
		};
		if (userId) {
			vars.userId = userId;
			delete vars.userName;
		} else if (userName) {
			vars.userName = userName;
			delete vars.userId;
		}
		const authVal = lastAuth || coreHooks?.getAuthHeader() || "";
		const headers = { ...tpl.headers || {} };
		if (authVal) {
			headers.Authorization = authVal;
			headers.authorization = authVal;
		}
		const options = tpl.options ? {
			...tpl.options,
			...tpl.options.schemaArgs ? { schemaArgs: [type] } : {}
		} : tpl.options;
		const params = [
			tpl.endpoint,
			tpl.query,
			vars,
			headers,
			options
		];
		const key = rpcKey(params);
		const now = Date.now();
		const possibleKeys = getMediaListKeys(type, userId, userName);
		if (rpcInflight.has(key)) return;
		for (const k of possibleKeys) {
			const hit = rpcCache.get(k);
			if (hit && hit.time >= freshFloor && now - hit.time < 3e5) return;
			if (rpcInflight.has(k)) return;
		}
		if (now - (prefetchedWorkerKeys.get(key) || 0) < PREFETCH_COOLDOWN_MS) return;
		recordPrefetchedWorkerKeys([key, ...possibleKeys], now);
		let w;
		try {
			w = new WorkerCtor(url, workerOpts);
		} catch (err) {
			fastLoadRpcLog?.debug("Prefetch worker failed to start", err);
			return;
		}
		const id = `alfl_prefetch_${type}_${now}`;
		let resolver;
		let rejecter;
		const flightPromise = new Promise((resolve, reject) => {
			resolver = resolve;
			rejecter = reject;
		});
		flightPromise.catch(() => {});
		const flight = {
			promise: flightPromise,
			resolve: resolver,
			reject: rejecter
		};
		const allFlightKeys = [...new Set([key, ...possibleKeys])];
		rpcInflight.set(key, flight);
		for (const k of possibleKeys) if (!rpcInflight.has(k)) rpcInflight.set(k, flight);
		const clearOwnInflight = () => {
			for (const k of allFlightKeys) if (rpcInflight.get(k) === flight) rpcInflight.delete(k);
		};
		let finished = false;
		let timer;
		const finish = (reason = "finished") => {
			if (finished) return;
			finished = true;
			activePrefetchCleanups.delete(finish);
			if (timer !== void 0) clearTimeout(timer);
			clearOwnInflight();
			flight.reject(new Error(reason));
			attempt(() => w.terminate());
		};
		timer = setTimeout(() => {
			fastLoadRpcLog?.debug("Prefetch timed out", type);
			finish("finished");
		}, 3e4);
		activePrefetchCleanups.add(finish);
		const startEpoch = rpcEpoch;
		w.addEventListener("message", (ev) => {
			const d = ev.data;
			if (!d || d.type !== "RPC" || String(d.id) !== id) return;
			if (startEpoch !== rpcEpoch || isWorkerInactive(yielded)) {
				finish("stale");
				return;
			}
			if (finished) return;
			finished = true;
			activePrefetchCleanups.delete(finish);
			if (timer !== void 0) clearTimeout(timer);
			if (d.error == null) {
				if (!hasMediaListNextChunk(d.result)) {
					attempt(() => {
						extractUsersFromRpcResult(d.result);
						const mlcUser = d.result?.MediaListCollection?.user || d.result?.data?.MediaListCollection?.user;
						const extractedUserId = mlcUser?.id ? Number(mlcUser.id) : 0;
						const resolvedUserId = userId || extractedUserId || (userName ? userMap.get(userName.toLowerCase()) : 0) || 0;
						if (userName && resolvedUserId) rememberUser(userName, resolvedUserId);
						const resolvedUserName = userName || (resolvedUserId ? idToUserMap.get(resolvedUserId) : void 0);
						const cached = {
							time: Date.now(),
							msg: clone(d)
						};
						const allKeys = [...new Set([
							key,
							...possibleKeys,
							...getMediaListKeys(type, resolvedUserId, resolvedUserName)
						])];
						for (const k of allKeys) {
							rpcCache.delete(k);
							rpcCache.set(k, cached);
						}
						while (rpcCache.size > RPC_MAX_ENTRIES) rpcCache.delete(rpcCache.keys().next().value);
					});
					fastLoadRpcLog?.debug("Prefetch cached", type, Object.keys(d));
				}
				clearOwnInflight();
				flight.resolve(d);
			} else {
				fastLoadRpcLog?.debug("Prefetch failed", d.error);
				clearOwnInflight();
				flight.reject(d.error);
			}
			attempt(() => w.terminate());
		});
		w.addEventListener("error", (e) => {
			fastLoadRpcLog?.debug("Prefetch worker error", e?.message);
			if (!isWorkerInactive(yielded) && startEpoch === rpcEpoch) {
				attempt(() => {
					coreStorage?.del("workerUrl");
				});
				workerUrl = null;
			}
			finish("error");
		});
		fastLoadRpcLog?.debug("Prefetch dispatching", type, vars);
		try {
			w.postMessage({
				type: "RPC",
				id,
				method: "fetch",
				params
			});
		} catch {
			finish("post-error");
		}
	}
	function hookWorker(yielded) {
		workerDisposed = false;
		activeYielded = yielded;
		let hookDisposed = false;
		const isInactive = () => hookDisposed || workerDisposed || yielded();
		let pageWin = null;
		let origCtor = null;
		let ProxiedWorker = null;
		let hookedProto = null;
		let origPost = null;
		let wrappedPost = null;
		attempt(() => {
			pageWin = win;
			origCtor = pageWin.Worker;
			WorkerCtor = origCtor;
			if (origCtor && !origCtor.__alfl_ctor_hooked) try {
				ProxiedWorker = function(scriptURL, options) {
					const instance = Reflect.construct(origCtor, [scriptURL, options], new.target || ProxiedWorker);
					if (!isInactive()) {
						const urlStr = String(scriptURL || "");
						if (urlStr.includes("worker.js") && !urlStr.includes("cloudflare")) {
							attempt(() => {
								workerUrl = new URL(urlStr, win.location.href).href;
								coreStorage?.set("workerUrl", workerUrl);
							});
							workerOpts = options;
							fastLoadRpcLog?.debug("Page worker created:", urlStr);
						}
						if (!watched.has(instance)) {
							watched.add(instance);
							instance.addEventListener("message", onIn);
						}
					}
					return instance;
				};
				ProxiedWorker.prototype = origCtor.prototype;
				ProxiedWorker.__alfl_ctor_hooked = true;
				pageWin.Worker = ProxiedWorker;
			} catch {
				ProxiedWorker = null;
			}
			const W = pageWin.Worker;
			if (!W?.prototype || W.prototype.__alfl_hooked) return;
			hookedProto = W.prototype;
			hookedProto.__alfl_hooked = true;
			origPost = hookedProto.postMessage;
			wrappedPost = function(data, ...rest) {
				try {
					if (!isInactive() && isRpcFetch(data)) {
						const id = String(data.id || "");
						if (id.startsWith("alfl_prefetch_")) return origPost.apply(this, [data, ...rest]);
						if (isRpcBlocked(String(data.params[1]), data.params[2])) {
							fastLoadRpcLog?.debug("Blocked request:", JSON.stringify(data.params[2]).slice(0, 60));
							const targetId = data.params[2]?.id || data.params[2]?.userId;
							const pageId = data.params[4]?.page?.id || (targetId ? `listComparison-${targetId}` : "listComparison");
							const pageNum = data.params[2]?.page || 1;
							const dummyResult = {
								entities: { page: { [pageId]: {
									pageInfo: {
										total: 0,
										perPage: 30,
										currentPage: pageNum,
										lastPage: 1,
										hasNextPage: false
									},
									pageData: []
								} } },
								result: pageId,
								data: { Page: {
									pageInfo: {
										total: 0,
										perPage: 30,
										currentPage: pageNum,
										lastPage: 1,
										hasNextPage: false
									},
									mediaList: []
								} }
							};
							setTimeout(() => {
								if (isInactive()) return;
								try {
									this.dispatchEvent(new MessageEvent("message", { data: {
										type: "RPC",
										id: data.id,
										result: dummyResult
									} }));
								} catch {
									const ev = (win.document || document).createEvent("Event");
									ev.initEvent("message", false, false);
									ev.data = {
										type: "RPC",
										id: data.id,
										result: dummyResult
									};
									this.dispatchEvent(ev);
								}
							}, 0);
							return;
						}
						if (!watched.has(this)) {
							watched.add(this);
							this.addEventListener("message", onIn);
						}
						const h = data.params[3] || {};
						const a = h.Authorization ?? h.authorization;
						if (a && /^Bearer\s+/i.test(String(a)) && !coreHooks?.isSessionClearing()) {
							setLastAuth(String(a));
							coreHooks?.setAuthHeader(lastAuth);
						}
						const q = {
							query: data.params[1],
							variables: data.params[2]
						};
						const mlcInfo = resolveMediaListQuery(q);
						const unfilteredMediaList = mlcInfo.canonical;
						if (unfilteredMediaList && !mlcInfo.hasInlineLiterals) attempt(() => {
							const headers = { ...h };
							delete headers.Authorization;
							delete headers.authorization;
							const tplStr = JSON.stringify({
								endpoint: data.params[0],
								query: data.params[1],
								vars: data.params[2],
								headers,
								options: data.params[4]
							});
							coreStorage?.set("rpc:listTpl:v2", tplStr);
						});
						if (isMutation(q)) {
							clearGlobalCache();
							const queryStr = String(q.query || "");
							const varsObj = q.variables && typeof q.variables === "object" ? q.variables : {};
							const opMatch = queryStr.match(/^\s*(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/);
							const operationName = opMatch ? opMatch[1] : void 0;
							const url = String(data.params[0] || "/graphql");
							if (coreHooks?.hasGqlFetchSubscribers() && queryStr) coreHooks.emitGqlFetch({
								phase: "request",
								url,
								query: queryStr,
								variables: varsObj,
								operationName
							});
							let pMap = workerPending.get(this);
							if (!pMap) {
								pMap = new Map();
								workerPending.set(this, pMap);
							}
							pMap.set(id, {
								key: null,
								mutation: true,
								url,
								query: queryStr,
								variables: varsObj,
								operationName
							});
						} else if (!isVolatile(q)) {
							const key = rpcKey(data.params);
							const label = String(q.query).replace(/\s+/g, " ").slice(0, 50);
							let hit = null;
							let flying = null;
							let extraKeys;
							if (unfilteredMediaList) {
								let { type = "ANIME", userId, userName } = mlcInfo.vars;
								if (!userName && userId) userName = idToUserMap.get(userId);
								if (!userId && userName) userId = userMap.get(userName.toLowerCase());
								extraKeys = [...new Set([key, ...getMediaListKeys(type || "ANIME", userId, userName)])];
								for (const k of extraKeys) {
									if (!hit) {
										const h = rpcCache.get(k);
										if (h && h.time >= freshFloor && Date.now() - h.time < 3e5) hit = h;
									}
									if (!flying) {
										const f = rpcInflight.get(k);
										if (f) flying = f;
									}
								}
							} else {
								const rpcTtl = isMediaListQuery(q) || isViewerQuery(q) || isTaxonomyQuery(q) ? 3e5 : isUserQuery(q) ? 6e4 : 15e3;
								const h = rpcCache.get(key);
								if (h && h.time >= freshFloor && Date.now() - h.time < rpcTtl) hit = h;
								flying = rpcInflight.get(key);
							}
							if (hit) {
								stats.cacheHits++;
								fastLoadRpcLog?.debug("HIT", label, `${Math.round((Date.now() - hit.time) / 1e3)}s old`);
								const worker = this;
								const reply = {
									...clone(hit.msg),
									id: data.id
								};
								const MessageEventCtor = win.MessageEvent || MessageEvent;
								let dispatched = false;
								setTimeout(() => {
									if (dispatched) return;
									dispatched = true;
									if (isInactive()) {
										origPost.apply(worker, [data, ...rest]);
										return;
									}
									worker.dispatchEvent(new MessageEventCtor("message", { data: reply }));
								}, 0);
								return;
							}
							if (flying) {
								stats.deduped++;
								fastLoadRpcLog?.debug("Attached to in-flight prefetch:", label);
								const worker = this;
								const replyId = data.id;
								let dispatched = false;
								const forwardOriginal = () => {
									if (dispatched) return;
									dispatched = true;
									origPost.apply(worker, [data, ...rest]);
								};
								flying.promise.then((msg) => {
									if (dispatched) return;
									if (isInactive()) {
										forwardOriginal();
										return;
									}
									fastLoadRpcLog?.debug("In-flight prefetch delivered to page:", label);
									const reply = {
										...clone(msg),
										id: replyId
									};
									const MessageEventCtor = win.MessageEvent || MessageEvent;
									setTimeout(() => {
										if (dispatched) return;
										if (isInactive()) {
											forwardOriginal();
											return;
										}
										dispatched = true;
										worker.dispatchEvent(new MessageEventCtor("message", { data: reply }));
									}, 0);
								}, () => {
									forwardOriginal();
								});
								return;
							}
							fastLoadRpcLog?.debug("MISS", label, JSON.stringify(q.variables).slice(0, 80));
							let pMap = workerPending.get(this);
							if (!pMap) {
								pMap = new Map();
								workerPending.set(this, pMap);
							}
							pMap.set(id, {
								key,
								mutation: false,
								epoch: rpcEpoch,
								extraKeys
							});
						}
					}
				} catch {}
				return origPost.apply(this, [data, ...rest]);
			};
			hookedProto.postMessage = wrappedPost;
		});
		return () => {
			hookDisposed = true;
			workerDisposed = true;
			for (const cleanup of [...activePrefetchCleanups]) attempt(cleanup);
			activePrefetchCleanups.clear();
			prefetchedWorkerKeys.clear();
			if (activeYielded === yielded) activeYielded = null;
			if (ProxiedWorker) {
				if (pageWin && pageWin.Worker === ProxiedWorker) pageWin.Worker = origCtor;
				delete ProxiedWorker.__alfl_ctor_hooked;
			}
			if (hookedProto) {
				if (hookedProto.postMessage === wrappedPost) hookedProto.postMessage = origPost;
				if (hookedProto.__alfl_hooked) delete hookedProto.__alfl_hooked;
			}
			if (WorkerCtor === origCtor) WorkerCtor = null;
		};
	}
	var isGraphQL = (u) => {
		try {
			const raw = u && typeof u === "object" && typeof u.href === "string" ? u.href : u;
			const url = new URL(raw, win.location.href);
			return url.origin === "https://graphql.anilist.co" || url.origin === win.location.origin && url.pathname.replace(/\/$/, "") === "/graphql";
		} catch {
			return false;
		}
	};
	var SKIP_HEADERS = /^(?:content-encoding|content-length|transfer-encoding)$/i;
	var RATE_HEADERS = /^(?:retry-after|x-ratelimit-.+)$/i;
	function toResponse(snap, live) {
		const HeadersCtor = win.Headers || Headers;
		const ResponseCtor = win.Response || Response;
		const headers = new HeadersCtor(snap.headers);
		if (live) {
			for (const [k, v] of live.headers.entries()) if (RATE_HEADERS.test(k)) headers.set(k, v);
		}
		const status = snap.status || 200;
		return new ResponseCtor(status === 204 || status === 304 ? null : snap.buf, {
			status,
			statusText: snap.statusText || "OK",
			headers
		});
	}
	function abortable(promise, signal) {
		if (!signal) return promise;
		return new Promise((resolve, reject) => {
			const fail = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
			if (signal.aborted) return fail();
			signal.addEventListener("abort", fail, { once: true });
			const done = () => signal.removeEventListener("abort", fail);
			promise.then((v) => {
				done();
				resolve(v);
			}, (e) => {
				done();
				reject(e);
			});
		});
	}
	function evict() {
		const now = Date.now();
		let currentBytes = bytes;
		for (const [key, entry] of store) {
			if (now - entry.time <= CFG.gqlStaleTtl && currentBytes <= CFG.gqlMaxBytes) break;
			currentBytes -= entry.size;
			store.delete(key);
		}
		setBytes(currentBytes);
	}
	function put(key, snap) {
		const old = store.get(key);
		let currentBytes = bytes;
		if (old) {
			currentBytes -= old.size;
			store.delete(key);
		}
		const size = snap.buf.byteLength;
		if (size > CFG.gqlMaxEntryBytes) return;
		store.set(key, {
			time: Date.now(),
			size,
			snap
		});
		currentBytes += size;
		setBytes(currentBytes);
		evict();
	}
	var decoder = new TextDecoder();
	function hasGraphQLErrors(buf) {
		try {
			const json = JSON.parse(decoder.decode(buf));
			if (!json || typeof json !== "object") return true;
			return Array.isArray(json.errors) && json.errors.length > 0;
		} catch {
			return true;
		}
	}
	function makeKey(d, parsed) {
		const authHeader = String(d.headers?.get?.("authorization") || "");
		return buildQueryCacheKey("gql", d.url, parsed?.query || "", parsed?.variables, authHeader);
	}
	var TAXONOMY_TTL = 864e5;
	function getTaxonomyStorageKey(parsed) {
		const taxKind = getTaxonomyKind(parsed);
		if (!taxKind) return null;
		if (stableStringify(normalizeVariables(parsed?.variables)) !== "{}") return null;
		return `taxonomy:v2:${taxKind}:${hashGqlQuery(parsed?.query || "")}`;
	}
	function getQueryTtl(parsed) {
		if (isTaxonomyQuery(parsed)) return TAXONOMY_TTL;
		if (isMediaListQuery(parsed)) return 3e5;
		if (isViewerQuery(parsed)) return 3e5;
		return CFG.gqlTtl;
	}
	function loadStoredTaxonomy(storageKey) {
		try {
			const raw = coreStorage?.get(storageKey, null);
			if (!raw) return null;
			const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (parsed && typeof parsed.time === "number" && typeof parsed.text === "string") return parsed;
		} catch {}
		return null;
	}
	function persistStoredTaxonomy(storageKey, snap) {
		attempt(() => {
			const text = decoder.decode(snap.buf);
			coreStorage?.set(storageKey, {
				time: Date.now(),
				text,
				status: snap.status,
				statusText: snap.statusText,
				headers: snap.headers
			});
		});
	}
	var note429 = (res) => {
		if (res.status === 429) setPausedUntil(Date.now() + 6e4);
	};
	async function classify(input, init) {
		const isRequest = Boolean(input && typeof input === "object") && (typeof win.Request === "function" && input instanceof win.Request || typeof Request === "function" && input instanceof Request);
		const method = String(init?.method || (typeof input?.method === "string" ? input.method : "GET")).toUpperCase();
		if (method !== "POST") return null;
		const rawUrl = typeof input === "string" ? input : typeof input?.url === "string" ? input.url : typeof input?.href === "string" ? input.href : String(input);
		if (!isGraphQL(rawUrl)) return null;
		let resolvedUrl = rawUrl;
		try {
			resolvedUrl = new URL(rawUrl, win.location.href).href;
		} catch {}
		let body = null;
		if (typeof init?.body === "string") body = init.body;
		else if (isRequest && !input.bodyUsed && typeof input.clone === "function") try {
			body = await input.clone().text();
		} catch {}
		if (typeof body !== "string") return null;
		const parsed = parseBody(body);
		if (!parsed) return null;
		const HeadersCtor = win.Headers || Headers;
		const desc = {
			url: resolvedUrl,
			method,
			body,
			headers: new HeadersCtor(init?.headers ?? (isRequest ? input.headers : void 0)),
			credentials: init?.credentials ?? (isRequest ? input.credentials : void 0) ?? "same-origin",
			mode: init?.mode ?? (isRequest ? input.mode : void 0) ?? "cors",
			cache: init?.cache ?? (isRequest ? input.cache : void 0)
		};
		const authHeader = desc.headers.get("authorization");
		if (authHeader && /^Bearer\s+/i.test(authHeader) && !coreHooks?.isSessionClearing()) coreHooks?.setAuthHeader(authHeader);
		const mediaList = isMediaListQuery(parsed);
		const bypass = noStore(desc) || !mediaList && isVolatile(parsed);
		return {
			desc,
			parsed,
			mutation: isMutation(parsed),
			bypass
		};
	}
	function cachedFetch(nativeFetch, job, input, init, alflMode) {
		const { desc, parsed } = job;
		if (init?.signal?.aborted) return nativeFetch(input, init);
		if (!(alflMode === true || alflMode === "replay" || alflMode === "internal")) attempt(() => rememberQuery(desc, parsed));
		if (isRpcBlocked(parsed?.query, parsed?.variables)) {
			fastLoadLog?.debug("Blocked GQL fetch:", JSON.stringify(parsed?.variables));
			const dummy = { data: { Page: {
				pageInfo: {
					total: 0,
					perPage: 30,
					currentPage: parsed?.variables?.page || 1,
					lastPage: 1,
					hasNextPage: false
				},
				mediaList: []
			} } };
			const ResponseCtor = win.Response || Response;
			return Promise.resolve(new ResponseCtor(JSON.stringify(dummy), {
				status: 200,
				headers: { "content-type": "application/json" }
			}));
		}
		let key = "";
		let ttl = CFG.gqlTtl;
		try {
			key = makeKey(desc, parsed);
			ttl = getQueryTtl(parsed);
		} catch {
			return nativeFetch(input, init);
		}
		const now = Date.now();
		const cached = store.get(key);
		const taxStorageKey = getTaxonomyStorageKey(parsed);
		if (taxStorageKey) {
			const storedTax = loadStoredTaxonomy(taxStorageKey);
			if (storedTax && now - storedTax.time < TAXONOMY_TTL) {
				stats.cacheHits++;
				fastLoadLog?.debug("Cache HIT (24h storage):", getTaxonomyKind(parsed));
				const HeadersCtor = win.Headers || Headers;
				const ResponseCtor = win.Response || Response;
				return Promise.resolve(new ResponseCtor(storedTax.text, {
					status: storedTax.status || 200,
					statusText: storedTax.statusText || "OK",
					headers: new HeadersCtor(storedTax.headers)
				}));
			}
		}
		if (cached && cached.time >= freshFloor && now - cached.time < ttl) {
			stats.cacheHits++;
			fastLoadLog?.debug("Cache HIT (RAM):", isMediaListQuery(parsed) ? "MediaListCollection" : "GraphQL query", `${Math.round((now - cached.time) / 1e3)}s old`);
			return Promise.resolve(toResponse(cached.snap));
		}
		const flying = inflight.get(key);
		if (flying) {
			stats.deduped++;
			fastLoadLog?.debug("Attached to in-flight request:", isMediaListQuery(parsed) ? "MediaListCollection" : "GraphQL query");
			return abortable(flying.then((result) => {
				if (result) return toResponse(result.snap);
				if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
				if (Date.now() < pausedUntil) throw new Error("FastLoad paused due to rate limit");
				return nativeFetch(input, init);
			}, (err) => {
				if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
				if (Date.now() < pausedUntil) throw err;
				return nativeFetch(input, init);
			}), init?.signal);
		}
		const myEpoch = epoch;
		const stale = cached && now - cached.time < CFG.gqlStaleTtl ? cached.snap : null;
		const opName = parsed.operationName || (isMediaListQuery(parsed) ? "MediaListCollection" : "query");
		fastLoadLog?.debug(alflMode === "replay" ? "Cache MISS (prefetch fetch):" : "Cache MISS (network fetch):", opName, "key:", key);
		const original = trackedNativeFetch(nativeFetch, job, input, init);
		const snapshot = original.then(async (res) => {
			note429(res);
			if (res.bodyUsed || typeof res.clone !== "function") {
				fastLoadLog?.debug("Response not cacheable:", res.status, opName);
				return null;
			}
			const buf = await res.clone().arrayBuffer();
			const hasErrors = res.status === 200 ? hasGraphQLErrors(buf) : false;
			const cacheable = res.status === 200 && !hasErrors;
			if (!cacheable) fastLoadLog?.debug(res.status !== 200 ? "Response not cacheable:" : "Response had GraphQL errors:", res.status, opName);
			return {
				snap: {
					buf,
					status: res.status,
					statusText: res.statusText,
					headers: [...res.headers.entries()].filter(([k]) => !SKIP_HEADERS.test(k) && (!cacheable || !RATE_HEADERS.test(k)))
				},
				cacheable
			};
		});
		inflight.set(key, snapshot);
		snapshot.then((result) => {
			if (inflight.get(key) === snapshot) inflight.delete(key);
			if (!result || !result.cacheable) return;
			const { snap } = result;
			if (epoch === myEpoch) {
				put(key, snap);
				fastLoadLog?.debug("Cached in RAM:", opName, `${Math.round(snap.buf.byteLength / 1024)} KB`);
			}
			attempt(() => {
				if (isViewerQuery(parsed)) extractUsersFromRpcResult(JSON.parse(decoder.decode(snap.buf))?.data);
			});
			if (taxStorageKey && snap.status === 200) persistStoredTaxonomy(taxStorageKey, snap);
		}, () => {
			if (inflight.get(key) === snapshot) inflight.delete(key);
		});
		if (!stale) return original;
		return original.then((res) => {
			if (res.status === 429 || res.status >= 500) {
				stats.staleServed++;
				return toResponse(stale, res);
			}
			return res;
		}, (err) => {
			if (init?.signal?.aborted || err?.name === "AbortError") throw err;
			stats.staleServed++;
			return toResponse(stale);
		});
	}
	function trackedNativeFetch(nativeFetch, job, input, init) {
		const subscribeActive = coreHooks?.hasGqlFetchSubscribers();
		const { desc, parsed } = job;
		const query = String(parsed?.query || "");
		const variables = parsed?.variables && typeof parsed.variables === "object" ? parsed.variables : {};
		const operationName = typeof parsed?.operationName === "string" ? parsed.operationName : void 0;
		const url = String(desc?.url || "");
		if (subscribeActive && query) coreHooks.emitGqlFetch({
			phase: "request",
			url,
			query,
			variables,
			operationName
		});
		const p = nativeFetch(input, init);
		if (subscribeActive && query) p.then(async (res) => {
			let data = void 0;
			let errors = void 0;
			if (res && !res.bodyUsed && typeof res.clone === "function") try {
				const json = await res.clone().json();
				data = json?.data;
				errors = Array.isArray(json?.errors) ? json.errors : void 0;
			} catch {}
			coreHooks?.emitGqlFetch({
				phase: "response",
				url,
				query,
				variables,
				operationName,
				status: res.status,
				ok: res.ok,
				data,
				errors
			});
		}, () => {});
		return p;
	}
	function installGraphQLLayer(yielded) {
		const nativeFetch = win.fetch.bind(win);
		const wrappedFetch = async function fetch(input, init) {
			if (yielded()) return nativeFetch(input, init);
			let job = null;
			try {
				job = await classify(input, init);
			} catch {}
			if (!job) return nativeFetch(input, init);
			stats.graphqlRequests++;
			if (job.mutation) {
				clearGlobalCache();
				const p = trackedNativeFetch(nativeFetch, job, input, init);
				p.then((res) => {
					note429(res);
					clearGlobalCache();
				}, () => clearGlobalCache());
				return p;
			}
			if (job.bypass) {
				const p = trackedNativeFetch(nativeFetch, job, input, init);
				p.then(note429, () => {});
				return p;
			}
			return cachedFetch(nativeFetch, job, input, init, init?.__alfl);
		};
		win.fetch = wrappedFetch;
		return () => {
			if (win.fetch === wrappedFetch) win.fetch = nativeFetch;
		};
	}
	var sameId = (a, b) => a === b || typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
	var isIdKey = (key) => /^(?:id|name|userName|username|userId)$|Id$/.test(key);
	var STATIC_ROUTE = /^\/(?:home|search\/(?:anime|manga))\/?$/;
	function safeDecodeURIComponent(raw) {
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}
	function parseRoute(path, search = "") {
		const parts = path.split("/").filter(Boolean).map(safeDecodeURIComponent);
		if ([
			"anime",
			"manga",
			"character",
			"staff",
			"studio"
		].includes(parts[0]) && /^\d+$/.test(parts[1] || "")) return {
			shape: `${parts[0]}/${parts[3] || ""}`,
			id: Number(parts[1])
		};
		if (parts[0] === "user" && parts[1]) return {
			shape: `user/${parts[2] || ""}`,
			id: parts[1]
		};
		if (parts[0] === "animelist" || parts[0] === "mangalist") {
			const myName = getLocalUsername();
			if (myName) return {
				shape: `user/${parts[0]}`,
				id: myName
			};
		}
		if (STATIC_ROUTE.test(path)) return {
			shape: `static:${path.replace(/\/$/, "")}${search}`,
			id: null,
			static: true
		};
		return null;
	}
	var here = () => parseRoute(win.location.pathname, win.location.search);
	function hasPageId(value, id) {
		if (!value || typeof value !== "object") return false;
		const targetUserId = typeof id === "string" ? userMap.get(id.toLowerCase()) : void 0;
		return Object.keys(value).some((key) => {
			const x = value[key];
			if (x && typeof x === "object") return hasPageId(x, id);
			if (isIdKey(key)) {
				if (sameId(x, id)) return true;
				if (targetUserId != null && (key === "userId" || key === "id") && x === targetUserId) return true;
			}
			return false;
		});
	}
	function replacePageId(value, from, to) {
		if (!value || typeof value !== "object") return 0;
		const fromUserId = typeof from === "string" ? userMap.get(from.toLowerCase()) : void 0;
		const toUserId = typeof to === "string" ? userMap.get(to.toLowerCase()) : void 0;
		let count = 0;
		for (const key of Object.keys(value)) {
			const x = value[key];
			if (x && typeof x === "object") count += replacePageId(x, from, to);
			else if (isIdKey(key)) {
				if (sameId(x, from)) {
					value[key] = to;
					count++;
				} else if (fromUserId != null && toUserId != null && (key === "userId" || key === "id") && x === fromUserId) {
					value[key] = toUserId;
					count++;
				}
			}
		}
		return count;
	}
	var learned = new Map();
	var ROUTES_KEY = "routes:v4";
	var ROUTES_TTL = 2592e6;
	var routesDisposed = false;
	var routeTimers = null;
	var persistDebounced = null;
	var autoPrefetchCancel = null;
	var dwellCancel = null;
	var pendingAutoPrefetchCancels = new Set();
	function writeLearnedRoutes() {
		if (routesDisposed) return;
		attempt(() => {
			const out = {};
			for (const [shape, v] of [...learned].slice(-40)) out[shape] = {
				t: v.t,
				id: v.route.id,
				static: !!v.route.static,
				reqs: v.reqs
			};
			coreStorage?.set(ROUTES_KEY, out);
		});
	}
	function clearPendingAutoPrefetchTimers() {
		for (const cancel of pendingAutoPrefetchCancels) cancel();
		pendingAutoPrefetchCancels.clear();
	}
	function initRoutes(timers) {
		routesDisposed = false;
		if (timers) {
			persistDebounced?.cancel();
			routeTimers = timers;
			persistDebounced = timers.debounce(writeLearnedRoutes, 1e3);
		}
	}
	function cleanupRoutes(disposeTimers = false) {
		routesDisposed = true;
		persistDebounced?.cancel();
		autoPrefetchCancel?.();
		autoPrefetchCancel = null;
		dwellCancel?.();
		dwellCancel = null;
		clearPendingAutoPrefetchTimers();
		if (disposeTimers) {
			routeTimers = null;
			persistDebounced = null;
			learned.clear();
			prefetched.clear();
			stamps.length = 0;
			learning = {
				key: "",
				started: 0,
				route: null,
				reqs: []
			};
		}
	}
	var persistRoutes = () => {
		if (routesDisposed) return;
		persistDebounced?.();
	};
	function loadRoutes() {
		attempt(() => {
			const raw = coreStorage?.get(ROUTES_KEY, null);
			const data = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (data && typeof data === "object") {
				const now = Date.now();
				for (const [shape, v] of Object.entries(data)) {
					if (!v || !Array.isArray(v.reqs) || typeof v.t !== "number" || now - v.t > ROUTES_TTL) continue;
					const reqs = v.reqs.filter((r) => r && typeof r.body === "string" && typeof r.url === "string" && isGraphQL(r.url) && r.headers && typeof r.headers === "object");
					if (reqs.length) learned.set(shape, {
						route: {
							shape,
							id: v.id,
							static: !!v.static
						},
						reqs,
						t: v.t
					});
				}
			}
		});
	}
	var learning = {
		key: "",
		started: 0,
		route: null,
		reqs: []
	};
	function refreshLearning() {
		const key = win.location.pathname + (STATIC_ROUTE.test(win.location.pathname) ? win.location.search : "");
		if (learning.key === key) return;
		learning = {
			key,
			started: 0,
			route: here(),
			reqs: []
		};
	}
	function rememberQuery(desc, parsed) {
		refreshLearning();
		if (!(CFG.prefetch || CFG.earlyStart) || !learning.route) return;
		if (!learning.started) learning.started = Date.now();
		if (Date.now() - learning.started > CFG.learnWindowMs) return;
		if (learning.reqs.length >= CFG.learnMaxReqs) return;
		if (!learning.route.static && !hasPageId(parsed.variables, learning.route.id)) return;
		const headers = Object.fromEntries(desc.headers.entries());
		delete headers["content-length"];
		delete headers["host"];
		delete headers["connection"];
		delete headers["content-encoding"];
		const authValue = headers.authorization;
		delete headers.authorization;
		let auth = false;
		if (authValue !== void 0) auth = true;
		learning.reqs.push({
			url: desc.url,
			body: JSON.stringify(parsed),
			headers,
			auth,
			credentials: desc.credentials || "same-origin",
			mode: desc.mode || "cors"
		});
		learned.delete(learning.route.shape);
		learned.set(learning.route.shape, {
			route: learning.route,
			reqs: [...learning.reqs],
			t: Date.now()
		});
		if (learning.route.shape === "user/animelist") {
			const mangaReqs = learning.reqs.map((r) => ({
				...r,
				body: r.body.replace(/"type"\s*:\s*"ANIME"/g, "\"type\":\"MANGA\"")
			}));
			learned.set("user/mangalist", {
				route: {
					shape: "user/mangalist",
					id: learning.route.id,
					static: false
				},
				reqs: mangaReqs,
				t: Date.now()
			});
		} else if (learning.route.shape === "user/mangalist") {
			const animeReqs = learning.reqs.map((r) => ({
				...r,
				body: r.body.replace(/"type"\s*:\s*"MANGA"/g, "\"type\":\"ANIME\"")
			}));
			learned.set("user/animelist", {
				route: {
					shape: "user/animelist",
					id: learning.route.id,
					static: false
				},
				reqs: animeReqs,
				t: Date.now()
			});
		}
		persistRoutes();
	}
	function getReplayAuthToken() {
		if (lastAuth) return lastAuth.replace(/^Bearer\s+/i, "").trim();
		const storedHeader = coreHooks?.getAuthHeader();
		if (storedHeader) return storedHeader.replace(/^Bearer\s+/i, "").trim();
		return null;
	}
	var stamps = [];
	function replayRoute(known, route, yielded) {
		if (routesDisposed || yielded()) return 0;
		let sent = 0;
		for (const request of known.reqs) {
			let parsed;
			try {
				parsed = JSON.parse(request.body);
			} catch {
				continue;
			}
			if (isMutation(parsed) || isVolatile(parsed)) continue;
			if (!known.route.static && !sameId(known.route.id, route.id)) {
				if (!replacePageId(parsed.variables, known.route.id, route.id)) continue;
			}
			const body = JSON.stringify(parsed);
			const headers = { ...request.headers };
			if (request.auth) {
				const token = getReplayAuthToken();
				if (!token) continue;
				headers.authorization = `Bearer ${token}`;
			}
			stamps.push(Date.now());
			sent++;
			attempt(() => {
				fastLoadLog?.debug("Replay/Prefetch dispatching for:", route.shape, "vars:", parsed.variables);
				win.fetch(request.url, {
					method: "POST",
					headers,
					body,
					credentials: request.credentials || "same-origin",
					mode: request.mode || "cors",
					__alfl: "replay"
				}).catch(() => {});
			});
		}
		return sent;
	}
	var triggerEarlyStart = (yielded) => {
		attempt(() => {
			if (routesDisposed || navigator.connection?.saveData) return;
			const route = here();
			const known = route && learned.get(route.shape);
			if (known) stats.earlyStarts += replayRoute(known, route, yielded);
		});
	};
	var prefetched = new Map();
	onCacheClear(() => prefetched.clear());
	function prefetchFor(anchor, yielded) {
		if (routesDisposed || yielded() || coreHooks?.isPrefetchSuppressed()) return;
		const now = Date.now();
		if (doc.hidden || now < pausedUntil || navigator.connection?.saveData) return;
		let url;
		try {
			url = new URL(anchor.href, win.location.href);
		} catch {
			return;
		}
		if (url.origin !== win.location.origin) return;
		const listMatch = url.pathname.match(/^\/(?:user\/([^/]+)\/)?(animelist|mangalist)/i);
		if (listMatch) {
			const targetUser = (listMatch[1] ? safeDecodeURIComponent(listMatch[1]) : "") || getLocalUsername();
			const listType = listMatch[2].toLowerCase() === "mangalist" ? "MANGA" : "ANIME";
			const myId = coreSession?.peek().userId || 0;
			const userId = targetUser ? userMap.get(targetUser.toLowerCase()) || (targetUser.toLowerCase() === getLocalUsername()?.toLowerCase() ? myId : 0) : 0;
			if (userId || targetUser) prefetchWorkerList(listType, userId, targetUser || void 0, yielded);
			return;
		}
		const route = parseRoute(url.pathname, url.search);
		if (!route || route.static) return;
		const known = learned.get(route.shape);
		if (!known || known.route.static) return;
		if (typeof known.route.id !== typeof route.id) {
			if (typeof known.route.id === "number" && typeof route.id === "string") {
				if (userMap.get(route.id.toLowerCase()) !== known.route.id) return;
			} else if (typeof known.route.id === "string" && typeof route.id === "number") {
				if (userMap.get(known.route.id.toLowerCase()) !== route.id) return;
			} else return;
		}
		const current = here();
		if (current && current.shape === route.shape && sameId(current.id, route.id)) return;
		const key = `${route.shape}|${String(route.id).toLowerCase()}`;
		const cooldown = route.shape.includes("list") ? 6e4 : CFG.gqlTtl;
		if (now - (prefetched.get(key) || 0) < cooldown) return;
		while (stamps.length && now - stamps[0] > 6e4) stamps.shift();
		if (prefetched.size > 200) {
			for (const [k, t] of prefetched) if (now - t > cooldown) prefetched.delete(k);
			while (prefetched.size > 200) {
				const oldest = prefetched.keys().next().value;
				if (oldest === void 0) break;
				prefetched.delete(oldest);
			}
		}
		if (stamps.length + known.reqs.length > CFG.prefetchMaxPerMin) return;
		const sent = replayRoute(known, route, yielded);
		if (sent) {
			prefetched.set(key, now);
			stats.prefetched += sent;
			fastLoadLog?.debug("Prefetch sent for:", route.shape, route.id);
		}
	}
	function canRunAutoPrefetch(yielded) {
		if (routesDisposed || !CFG.prefetch || yielded() || coreHooks?.isPrefetchSuppressed()) return false;
		const now = Date.now();
		if (doc.hidden || now < pausedUntil || navigator.connection?.saveData) return false;
		if (win.location.pathname.toLowerCase().includes("/compare")) return false;
		return true;
	}
	function scheduleAutoPrefetch(yielded, delay = 600) {
		autoPrefetchCancel?.();
		autoPrefetchCancel = null;
		clearPendingAutoPrefetchTimers();
		if (routesDisposed || !routeTimers) return;
		autoPrefetchCancel = routeTimers.timeout(() => {
			autoPrefetchCancel = null;
			if (routesDisposed) return;
			attempt(() => autoPrefetchListsForCurrentRoute(yielded));
		}, delay);
	}
	function autoPrefetchListsForCurrentRoute(yielded) {
		clearPendingAutoPrefetchTimers();
		if (!canRunAutoPrefetch(yielded)) return;
		const path = win.location.pathname;
		const scheduledPath = path;
		const viewer = getViewerFromWindow();
		const myId = viewer.id;
		const myName = viewer.name || null;
		const userMatch = path.match(/^\/user\/([^/]+)(?:\/([^/]+))?/i);
		let isAnotherUserPage = false;
		let otherUser = "";
		let otherUserId = 0;
		let subRoute = "";
		if (userMatch) {
			const targetUser = safeDecodeURIComponent(userMatch[1]);
			subRoute = (userMatch[2] || "").toLowerCase();
			if (!(myName && targetUser.toLowerCase() === myName.toLowerCase() || myId > 0 && userMap.get(targetUser.toLowerCase()) === myId)) {
				isAnotherUserPage = true;
				otherUser = targetUser;
				otherUserId = userMap.get(targetUser.toLowerCase()) || 0;
			}
		}
		const scheduleWorkerPrefetch = (type, userId, userName, delay) => {
			if (routesDisposed || !routeTimers) return;
			let settled = false;
			let cancel = () => {};
			cancel = routeTimers.timeout(() => {
				settled = true;
				pendingAutoPrefetchCancels.delete(cancel);
				if (routesDisposed || win.location.pathname !== scheduledPath || !canRunAutoPrefetch(yielded)) return;
				attempt(() => prefetchWorkerList(type, userId, userName, yielded));
			}, delay);
			if (!settled) pendingAutoPrefetchCancels.add(cancel);
		};
		if (isAnotherUserPage) {
			fastLoadRpcLog?.debug("Auto-prefetching for target user:", otherUser, "subRoute:", subRoute);
			if (subRoute !== "animelist") scheduleWorkerPrefetch("ANIME", otherUserId, otherUser, 100);
			if (subRoute !== "mangalist") scheduleWorkerPrefetch("MANGA", otherUserId, otherUser, 300);
			if (myId || myName) {
				scheduleWorkerPrefetch("ANIME", myId, myName || void 0, 500);
				scheduleWorkerPrefetch("MANGA", myId, myName || void 0, 800);
			}
		} else if (myId || myName) {
			const isMyAnimePage = path.includes("/animelist") && (myName ? path.toLowerCase().includes(myName.toLowerCase()) : true);
			const isMyMangaPage = path.includes("/mangalist") && (myName ? path.toLowerCase().includes(myName.toLowerCase()) : true);
			if (!isMyAnimePage) scheduleWorkerPrefetch("ANIME", myId, myName || void 0, 100);
			if (!isMyMangaPage) scheduleWorkerPrefetch("MANGA", myId, myName || void 0, 300);
		}
	}
	function installPointerPrefetch(yielded, listen = (t, type, fn, opts) => t.addEventListener(type, fn, opts), timeout = routeTimers?.timeout) {
		const linkOf = (event) => event.target?.closest?.("a[href]") || null;
		const opts = {
			capture: true,
			passive: true
		};
		listen(doc, "pointerover", (event) => {
			if (routesDisposed) return;
			if (event.pointerType && event.pointerType !== "mouse") return;
			const anchor = linkOf(event);
			dwellCancel?.();
			dwellCancel = null;
			if (anchor && timeout) dwellCancel = timeout(() => {
				dwellCancel = null;
				if (!routesDisposed) prefetchFor(anchor, yielded);
			}, CFG.prefetchDwellMs);
		}, opts);
		listen(doc, "pointerout", () => {
			dwellCancel?.();
			dwellCancel = null;
		}, opts);
		listen(doc, "pointerdown", (event) => {
			if (routesDisposed) return;
			const anchor = linkOf(event);
			if (anchor) prefetchFor(anchor, yielded);
		}, opts);
	}
	var builtInRunning = false;
	var detectStandaloneFastLoad = () => !!(win.__ANILIST_FAST_LOAD__ || win.__ANILIST_FAST_LOAD_V4__) && !builtInRunning;
	defineModule({
		id: "fastLoad",
		key: "fastLoadEnabled",
		section: "AniList Enhancements",
		layer: "intercept",
		requiresReload: true,
		title: "AniList Fast Load",
		help: "Performance optimizer: lazy media, off-screen row skipping, observer coalescing, safe GraphQL cache/de-duplication with stale fallback, navigation prefetch and early request start.",
		debug: {
			label: "Fast Load",
			title: "Fast Load Debug",
			help: "Log GraphQL caching, prefetching, deduplication, and Web Worker RPC activity.",
			channels: { rpc: {
				label: "RPC",
				title: "Web Worker RPC",
				debug: true,
				help: "Log Web Worker RPC requests, cache hits/misses, and prefetches."
			} }
		},
		standalone: {
			name: "AniList Fast Load",
			probe: detectStandaloneFastLoad
		},
		migrate(m) {
			m.legacy.del("alfl:workerUrl");
			m.legacy.del("alfl:rpc:listTpl:v2");
			if (!m.storage.get("localStorageCleaned", false) && !detectStandaloneFastLoad()) {
				for (const k of [
					"alfl:taxonomy:v1",
					"alfl:routes:v1",
					"alfl:routes:v2",
					"alfl:routes:v3",
					"alfl:routes:v4",
					"alfl:userMap",
					"alfl:workerUrl",
					"alfl:rpc:listTpl:v2"
				]) m.legacy.delLocal(k);
				m.storage.set("localStorageCleaned", true);
			}
		},
		setup(ctx) {
			if (win.top !== win.self) return;
			if (win.__ANILIST_FAST_LOAD__ || win.__ANILIST_FAST_LOAD_V4__) {
				ctx.setStandalonePaused(true);
				ctx.log.warn("Built-in Fast Load skipped: the standalone AniList Fast Load script is already running. Uninstall it to use the built-in version.");
				return;
			}
			win.__ALA_FAST_LOAD__ = "0.4.3";
			builtInRunning = true;
			setCoreHooks(ctx.hooks);
			setCoreSession(ctx.session);
			setCoreStorage(ctx.storage);
			setFastLoadLogs(ctx.log, ctx.log.channel("rpc"));
			initRoutes({
				timeout: ctx.timeout,
				debounce: ctx.debounce
			});
			ctx.hooks.registerCacheBridge({
				getGqlStore: () => store,
				getRpcCache: () => rpcCache,
				getRpcInflight: () => rpcInflight,
				getUserMap: () => userMap,
				getIdMap: () => idToUserMap,
				clear: () => clearGlobalCache(),
				clearAuth: () => clearLastAuth()
			});
			let yieldedToStandalone = false;
			let uninstallFetch = null;
			let releaseFetchOwner = null;
			const yielded = () => {
				if (yieldedToStandalone) return true;
				if (win.__ANILIST_FAST_LOAD__ || win.__ANILIST_FAST_LOAD_V4__) {
					yieldedToStandalone = true;
					uninstallFetch?.();
					uninstallFetch = null;
					releaseFetchOwner?.();
					releaseFetchOwner = null;
					ctx.setStandalonePaused(true);
					ctx.log.warn("Built-in Fast Load paused: the standalone AniList Fast Load script is installed. Uninstall it to use the built-in version.");
				}
				return yieldedToStandalone;
			};
			attempt(() => {
				const parent = doc.head || doc.documentElement;
				for (const [href, cors] of [
					[GQL_ORIGIN, true],
					[MEDIA_ORIGIN, false],
					["https://fonts.googleapis.com", false],
					["https://fonts.gstatic.com", true]
				]) {
					if (parent.querySelector(`link[rel="preconnect"][href="${href}"]`)) continue;
					const link = doc.createElement("link");
					link.rel = "preconnect";
					link.href = href;
					if (cors) link.crossOrigin = "";
					parent.appendChild(link);
				}
			});
			navListeners.length = 0;
			ctx.onNav(() => navListeners.forEach(attempt));
			initUserMap();
			registerGlobalBridges();
			attempt(() => {
				const viewer = getViewerFromWindow();
				if (viewer.name && viewer.id) {
					rememberUser(viewer.name, viewer.id);
					ctx.session.recordHint({
						userId: viewer.id,
						username: viewer.name
					});
				} else if (viewer.name) ctx.session.recordHint({ username: viewer.name });
			});
			let hiddenAt = 0;
			ctx.listen(doc, "visibilitychange", () => {
				if (doc.hidden) {
					hiddenAt = Date.now();
					return;
				}
				if (hiddenAt && Date.now() - hiddenAt > 6e5) {
					incEpoch();
					setFreshFloor(Date.now());
				}
				inflight.clear();
			});
			if (CFG.gqlTtl > 0 && typeof win.fetch === "function") {
				uninstallFetch = installGraphQLLayer(yielded);
				releaseFetchOwner = ctx.hooks.markFetchOwner(true);
				ctx.onCleanup(() => {
					uninstallFetch?.();
					uninstallFetch = null;
					releaseFetchOwner?.();
					releaseFetchOwner = null;
				});
				const unhookWorker = attempt(() => hookWorker(yielded));
				if (unhookWorker) ctx.onCleanup(unhookWorker);
			}
			if (CFG.coalesceObservers) {
				const undoObservers = attempt(installObserverCoalescing);
				if (undoObservers) ctx.onCleanup(undoObservers);
			}
			if (CFG.lazyMedia) {
				const undoLazyMedia = attempt(installLazyMedia);
				if (undoLazyMedia) ctx.onCleanup(undoLazyMedia);
			}
			if (CFG.rowSkipping) {
				const undoRowSkipping = attempt(() => installRowSkipping({
					addStyle: ctx.addStyle,
					listen: ctx.listen
				}));
				if (undoRowSkipping) ctx.onCleanup(undoRowSkipping);
			}
			if (CFG.earlyStart) {
				loadRoutes();
				triggerEarlyStart(yielded);
				navListeners.push(() => triggerEarlyStart(yielded));
			} else if (CFG.prefetch) loadRoutes();
			if (CFG.prefetch) {
				navListeners.push(() => scheduleAutoPrefetch(yielded, 500));
				ctx.ready(() => scheduleAutoPrefetch(yielded, 1e3));
				installPointerPrefetch(yielded, ctx.listen, ctx.timeout);
			}
			ctx.onCleanup(() => {
				cleanupRoutes(true);
				navListeners.length = 0;
				resetRuntimeState();
				unregisterGlobalBridges();
				if (win.__ALA_FAST_LOAD__ === "0.4.3") delete win.__ALA_FAST_LOAD__;
				builtInRunning = false;
				setFastLoadLogs(null, null);
				setCoreStorage(null);
				setCoreSession(null);
				setCoreHooks(null);
			});
		}
	});
	defineModule({
		id: "keyframe",
		key: "keyframeEnabled",
		section: "External Links, Downloads & Mappings",
		layer: "feature",
		requiresReload: false,
		legacy: ["keyframeEnabled"],
		title: "Keyframe Staff List Links",
		help: "Add a button on staff and studio pages that opens the same person or studio on Keyframe Staff List.",
		setup(ctx) {
			const BASE = "https://keyframe-staff-list.com";
			const LABEL = "Keyframe Staff List";
			const SLOT = ".filters";
			const PATHS = {
				staff: "person",
				studio: "studio"
			};
			const copyScope = (from, to) => {
				for (const at of Array.from(from.attributes)) if (at.name.startsWith("data-v-")) to.setAttribute(at.name, at.value);
			};
			function skin(a, container) {
				if (!a || a.dataset.kfSkin) return;
				const ref = (container ?? a.parentElement)?.querySelector(".mini-select");
				if (!ref) return;
				a.classList.remove("ala-kf-plain");
				a.classList.add("mini-select");
				copyScope(ref, a);
				const refIcon = ref.querySelector("svg");
				const refLabel = ref.querySelector(".label");
				const iconEl = a.querySelector("svg");
				const labelEl = a.querySelector("span");
				if (iconEl) {
					iconEl.classList.add("icon");
					if (refIcon) copyScope(refIcon, iconEl);
				}
				if (labelEl) {
					labelEl.classList.add("label");
					if (refLabel) copyScope(refLabel, labelEl);
				}
				a.dataset.kfSkin = "1";
			}
			ctx.onRoute(/^\/(staff|studio)\/(\d+)(?:\/|$)/, (rc) => {
				const kind = rc.match[1];
				const id = rc.match[2];
				const link = rc.mount({
					id: "link",
					anchor: SLOT,
					position: "afterbegin",
					ownUi: true,
					style: (sel) => `
          ${sel}{flex:0 0 auto;margin-right:12px;text-decoration:none;color:inherit;cursor:pointer;white-space:nowrap}
          ${sel}.ala-kf-plain{display:inline-flex;align-items:center;gap:7px;min-height:30px;padding:0 12px;border-radius:4px;background:rgb(var(--color-foreground));font-size:1.2rem;font-weight:500;line-height:1;transition:background .15s,color .15s}
          ${sel}.ala-kf-plain:hover{background:rgb(var(--color-blue));color:#fff}
          ${sel} .icon{flex:0 0 auto}`,
					create: () => {
						const a = document.createElement("a");
						a.className = "ala-kf-plain";
						a.href = `${BASE}/${PATHS[kind]}/${id}`;
						a.target = "_blank";
						a.rel = "noopener noreferrer";
						a.title = `Open on ${LABEL}`;
						a.setAttribute("aria-label", `Open on ${LABEL}`);
						a.innerHTML = `${icon("external", 14)}<span>${LABEL}</span>`;
						a.addEventListener("click", (e) => e.stopPropagation());
						return a;
					},
					onMount: (a) => skin(a)
				});
				rc.onBodyMutation(() => skin(link.el()));
			});
		}
	});
	var RateLimiter = class {
		rate;
		min;
		max;
		burst;
		adaptive;
		jitter;
		persistKey;
		tokens;
		last;
		until;
		okStreak;
		queue;
		constructor({ rate, min = 1, max = rate, burst = 1, adaptive = false, jitter = false, persistKey = null }) {
			const safeMin = Number.isFinite(min) && min > 0 ? min : 1;
			const fallbackMax = Number.isFinite(rate) && rate > safeMin ? rate : safeMin;
			const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : fallbackMax;
			const safeBurst = Number.isFinite(burst) && burst >= 1 ? burst : 1;
			this.min = safeMin;
			this.max = safeMax;
			this.burst = safeBurst;
			this.adaptive = Boolean(adaptive);
			this.jitter = Boolean(jitter);
			this.persistKey = persistKey ?? null;
			this.rate = Number.isFinite(rate) ? Math.min(this.max, Math.max(this.min, rate)) : this.min;
			this.tokens = this.burst;
			this.last = Date.now();
			this.until = 0;
			this.okStreak = 0;
			this.queue = Promise.resolve();
		}
		readStoredUntil() {
			if (!this.persistKey) return 0;
			try {
				const raw = store$1.get(this.persistKey, 0);
				const stored = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
				return Number.isFinite(stored) && stored > 0 ? stored : 0;
			} catch {
				return 0;
			}
		}
		get resumeAt() {
			const stored = this.readStoredUntil();
			const at = Math.max(this.until, stored);
			return at > Date.now() ? at : 0;
		}
		setRate(n) {
			if (!Number.isFinite(n)) return;
			this.rate = Math.min(this.max, Math.max(this.min, n));
		}
		acquire(checkOrOpts) {
			const opts = typeof checkOrOpts === "function" ? { check: checkOrOpts } : checkOrOpts ?? {};
			if (opts.signal?.aborted) return Promise.reject(createAbortError(opts.signal));
			const run = this.queue.then(() => this._take(opts));
			this.queue = run.catch(() => {});
			return raceWithSignal(run, opts.signal);
		}
		async _take({ check, signal } = {}) {
			for (;;) {
				check?.();
				if (signal?.aborted) throw createAbortError(signal);
				const now = Date.now();
				const resume = this.resumeAt;
				if (resume) {
					this.tokens = 0;
					this.last = resume;
					await sleep(Math.min(1e3, Math.max(0, resume - now)), signal);
					continue;
				}
				const elapsed = Math.max(0, now - this.last);
				this.tokens = Math.min(this.burst, this.tokens + elapsed / 6e4 * this.rate);
				this.last = now;
				if (this.tokens >= 1) {
					this.tokens -= 1;
					return;
				}
				await sleep(Math.min(1e3, Math.max(15, (1 - this.tokens) / this.rate * 6e4)), signal);
			}
		}
		success() {
			if (this.adaptive && ++this.okStreak >= 25 && this.rate < this.max) {
				this.setRate(this.rate + Math.max(1, Math.round(this.rate * .1)));
				this.okStreak = 0;
			}
		}
		limit(ms) {
			this.okStreak = 0;
			this.tokens = 0;
			if (this.adaptive) this.setRate(Math.floor(this.rate / 2));
			if (!Number.isFinite(ms) || !(ms > 0)) return;
			const next = Date.now() + ms * (this.jitter ? .9 + Math.random() * .3 : 1);
			if (!Number.isFinite(next)) return;
			const stored = this.readStoredUntil();
			this.until = Math.max(this.until, stored, next);
			if (this.persistKey && this.until > stored) safe(() => store$1.set(this.persistKey, this.until), "persist cooldown");
		}
	};
	var muLimiter = new RateLimiter({
		rate: 30,
		min: 5,
		max: 60,
		burst: 3
	});
	var nuLimiter = new RateLimiter({
		rate: 30,
		min: 5,
		max: 60,
		burst: 3
	});
	function throwIfAborted$1(signal) {
		if (signal?.aborted) throw createAbortError(signal);
	}
	async function tryScraperOrAbort(fn, signal) {
		try {
			return await fn();
		} catch (err) {
			if (signal?.aborted || isAbortError(err)) throw signal?.aborted ? createAbortError(signal) : err;
			return null;
		}
	}
	var normTitle = (s) => String(s || "").toLowerCase().normalize("NFKC").replace(/[’‘'`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\b(the|a|an)\b/g, " ").replace(/\s+/g, " ").trim();
	function titleScore(a, b) {
		const x = normTitle(a);
		const y = normTitle(b);
		if (!x || !y) return 0;
		if (x === y) return 100;
		const wordsA = x.split(" ").filter(Boolean);
		const wordsB = y.split(" ").filter(Boolean);
		const setA = new Set(wordsA);
		const setB = new Set(wordsB);
		let common = 0;
		for (const w of setA) if (setB.has(w)) common++;
		const totalUnique = new Set([...wordsA, ...wordsB]).size;
		const wordScore = totalUnique > 0 ? common / totalUnique * 100 : 0;
		const strA = ` ${x} `;
		const strB = ` ${y} `;
		if (strA.includes(strB) || strB.includes(strA)) {
			const lenRatio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
			const subScore = Math.round(60 + lenRatio * 35);
			return Math.max(Math.round(wordScore), subScore);
		}
		return Math.round(wordScore);
	}
	function bestMatch(list, title, getTitle, min = 70) {
		let best = null;
		let bestScore = -1;
		for (const item of list) {
			const s = titleScore(title, getTitle(item));
			if (s > bestScore) {
				best = item;
				bestScore = s;
			}
		}
		return best && bestScore >= min ? best : null;
	}
	function parseLatest(value) {
		if (value == null) return null;
		const s = String(value).trim();
		if (!s || /^(n\/a|unknown|none)$/i.test(s)) return null;
		const normalized = s.replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");
		const nums = [...normalized.matchAll(/(?:^|[^\d])(?:v\d+[ ._-]*)?c?\s*(\d+(?:\.\d+)?)/gi)].map((m) => Number(m[1])).filter(Number.isFinite);
		if (nums.length) return Math.max(...nums);
		return Number(normalized.replace(/,/g, "").match(/\d+(?:\.\d+)?/)?.[0]) || null;
	}
	async function mangaUpdates(title, opts = {}) {
		const { http = gm, signal } = opts;
		throwIfAborted$1(signal);
		await muLimiter.acquire({ signal });
		throwIfAborted$1(signal);
		const search = await raceWithSignal(http.json("https://api.mangaupdates.com/v1/series/search", {
			method: "POST",
			anonymous: true,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json"
			},
			data: JSON.stringify({
				search: title,
				stype: "title",
				perpage: 8
			}),
			signal
		}), signal);
		throwIfAborted$1(signal);
		const best = bestMatch(Array.isArray(search?.results) ? search.results : [], title, (r) => r?.hit_title || r?.record?.title);
		if (!best) return null;
		const rec = best.record || {};
		let latest = parseLatest(rec.latest_chapter);
		const id = rec.series_id || rec.id || rec.seriesId || String(rec.url || "").match(/\/series\/(\d+)/)?.[1];
		if (latest == null && id) latest = await tryScraperOrAbort(async () => {
			await muLimiter.acquire({ signal });
			throwIfAborted$1(signal);
			const d = await raceWithSignal(http.json(`https://api.mangaupdates.com/v1/series/${encodeURIComponent(id)}`, {
				anonymous: true,
				headers: { Accept: "application/json" },
				signal
			}), signal);
			throwIfAborted$1(signal);
			return parseLatest(d?.latest_chapter ?? d?.record?.latest_chapter);
		}, signal);
		if (latest == null && rec.url) latest = await tryScraperOrAbort(async () => {
			await muLimiter.acquire({ signal });
			throwIfAborted$1(signal);
			const text = await raceWithSignal(http.text(rec.url, {
				anonymous: true,
				signal
			}), signal);
			throwIfAborted$1(signal);
			const m = text.match(/Latest\s+Chapter[\s\S]{0,500}?\b(?:c\s*)?(\d+(?:\.\d+)?)/i);
			return m ? Number(m[1]) : null;
		}, signal);
		return latest == null ? null : Math.floor(latest);
	}
	async function novelUpdates(title, opts = {}) {
		const { http = gm, signal } = opts;
		throwIfAborted$1(signal);
		await nuLimiter.acquire({ signal });
		throwIfAborted$1(signal);
		const html = await raceWithSignal(http.text(`https://www.novelupdates.com/?s=${encodeURIComponent(title)}&post_type=series`, {
			anonymous: true,
			signal
		}), signal);
		throwIfAborted$1(signal);
		const doc = new DOMParser().parseFromString(html, "text/html");
		const seen = new Set();
		const cands = [];
		for (const a of doc.querySelectorAll("a[href*=\"/series/\"]")) {
			let url;
			try {
				url = new URL(a.getAttribute("href") || "", "https://www.novelupdates.com/");
			} catch {
				continue;
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") continue;
			const href = url.href;
			const text = clean(a.textContent);
			if (text && !seen.has(href)) {
				seen.add(href);
				cands.push({
					href,
					text
				});
			}
		}
		const best = bestMatch(cands, title, (c) => c.text);
		if (!best) return null;
		await nuLimiter.acquire({ signal });
		throwIfAborted$1(signal);
		const pageHtml = await raceWithSignal(http.text(best.href, {
			anonymous: true,
			signal
		}), signal);
		throwIfAborted$1(signal);
		const body = new DOMParser().parseFromString(pageHtml, "text/html").body?.textContent || "";
		let latest = null;
		const at = body.search(/Latest\s+Release/i);
		if (at >= 0) {
			const hits = [...body.slice(at, at + 5e3).matchAll(/(?:^|\s)(?:v\d+[ ._-]*)?c\s*(\d+(?:\.\d+)?)/gi)].slice(0, 30).map((m) => Number(m[1])).filter(Number.isFinite);
			if (hits.length) latest = Math.max(...hits);
		}
		if (latest == null) {
			const m = body.slice(0, 12e3).match(/(?:Status in COO|Chapters)[\s\S]{0,500}?\b(\d+(?:\.\d+)?)\s+Chapters?/i);
			if (m) latest = Number(m[1]);
		}
		return latest != null && Number.isFinite(latest) ? Math.floor(latest) : null;
	}
	var LOOKUP_TTL = 18e5;
	var LOOKUP_MAX_ENTRIES = 1e3;
	var lookupCache = new Map();
	var lookupFlights = new Map();
	var transportIds = new WeakMap();
	var nextTransportId = 1;
	function getTransportId(http) {
		let id = transportIds.get(http);
		if (!id) {
			id = nextTransportId++;
			transportIds.set(http, id);
		}
		return id;
	}
	function setLookupCache(key, value) {
		const now = Date.now();
		if (lookupCache.size >= LOOKUP_MAX_ENTRIES) {
			for (const [k, v] of lookupCache) if (now - v.at >= LOOKUP_TTL) lookupCache.delete(k);
			while (lookupCache.size >= LOOKUP_MAX_ENTRIES) lookupCache.delete(lookupCache.keys().next().value);
		}
		lookupCache.delete(key);
		lookupCache.set(key, {
			at: now,
			value
		});
	}
	function lookupRelease(key, kind, title, opts = {}) {
		throwIfAborted$1(opts.signal);
		const now = Date.now();
		const cached = lookupCache.get(key);
		if (cached && now - cached.at < LOOKUP_TTL) return Promise.resolve(cached.value);
		if (cached) lookupCache.delete(key);
		const flightKey = `${getTransportId(opts.http ?? gm)}:${key}`;
		let flight = lookupFlights.get(flightKey);
		if (!flight || flight.controller.signal.aborted) {
			const run = kind === "NU" ? novelUpdates : mangaUpdates;
			flight = createSharedFlight({
				start: (sharedSignal) => run(title, {
					http: opts.http,
					signal: sharedSignal
				}).then((v) => {
					if (!sharedSignal.aborted) setLookupCache(key, v);
					return v;
				}),
				onEvict: (evicted) => {
					if (lookupFlights.get(flightKey) === evicted) lookupFlights.delete(flightKey);
				},
				onSettled: (doneFlight) => {
					if (lookupFlights.get(flightKey) === doneFlight) lookupFlights.delete(flightKey);
				},
				createAbortError
			});
			lookupFlights.set(flightKey, flight);
		}
		return flight.wait({ signal: opts.signal });
	}
	async function externalReleased(info, opts = {}) {
		throwIfAborted$1(opts.signal);
		const kind = info?.format === "NOVEL" ? "NU" : "MU";
		const titles = [...new Set([
			info?.title?.userPreferred,
			info?.title?.romaji,
			info?.title?.english
		].filter(Boolean))];
		for (const t of titles) {
			throwIfAborted$1(opts.signal);
			const keyTitle = normTitle(t) || clean(t).toLowerCase();
			if (!keyTitle) continue;
			try {
				const n = await lookupRelease(`${kind}:${keyTitle}`, kind, t, opts);
				if (n != null) return n;
			} catch (err) {
				if (opts.signal?.aborted || isAbortError(err)) throw opts.signal?.aborted ? createAbortError(opts.signal) : err;
			}
		}
		return null;
	}
	defineModule({
		id: "mediaInfo",
		key: "mediaInfoEnabled",
		section: "AniList Enhancements",
		layer: "feature",
		requiresReload: false,
		legacy: ["mediaInfoEnabled", "mediaListEditorEnabled"],
		title: "List Score & Progress Editor",
		help: "Show your score and episode/chapter progress controls on anime and manga pages.",
		debug: {
			label: "Media Info",
			title: "Media Info Debug",
			help: "Log media info sidebar updates, progress steppers, and save requests."
		},
		setup(ctx) {
			const ID = ctx.getId("panel");
			ctx.ownUi(`#${ID}`);
			ctx.addStyle(`
      #${ID}{box-sizing:border-box;width:100%;max-width:100%;margin:0 0 12px;padding:14px 15px 15px;border-radius:3px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));font-size:1.3rem;line-height:1.4;overflow:hidden}
      #${ID} *{box-sizing:border-box}
      #${ID} :focus-visible{outline:2px solid rgb(var(--color-blue));outline-offset:2px}
      #${ID} .ala-mi-fields{display:grid;grid-template-columns:minmax(54px,1fr) minmax(0,2fr);gap:10px}
      #${ID} .ala-mi-field{display:flex;flex-direction:column;gap:6px;min-width:0}
      #${ID} .ala-mi-label{color:rgb(var(--color-text-lighter));font-size:1.2rem}
      #${ID} .ala-mi-box{display:flex;align-items:stretch;height:38px;border-radius:3px;background:rgb(var(--color-background));box-shadow:inset 0 0 0 1px transparent;overflow:hidden;transition:box-shadow .15s}
      #${ID} .ala-mi-box:hover{box-shadow:inset 0 0 0 1px rgba(var(--color-blue),.4)}
      #${ID} .ala-mi-box:focus-within{box-shadow:inset 0 0 0 1px rgb(var(--color-blue))}
      #${ID} input{flex:1 1 auto;width:100%;min-width:0;height:100%;margin:0;padding:0 2px;border:0;outline:none;background:transparent;color:rgb(var(--color-text));font:inherit;font-size:1.45rem;text-align:center;-moz-appearance:textfield}
      #${ID} .ala-mi-progress-input[data-digits="4"],#${ID} .ala-mi-progress-input[data-digits="5"]{font-size:1.25rem}
      #${ID} input::placeholder{color:rgb(var(--color-text-lighter))}
      #${ID} input:focus::placeholder{color:transparent}
      #${ID} input::-webkit-outer-spin-button,#${ID} input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
      #${ID} .ala-mi-step{flex:0 0 26px;display:flex;align-items:center;justify-content:center;padding:0;border:0;background:transparent;color:rgb(var(--color-text-lighter));font:inherit;font-size:1.7rem;line-height:1;cursor:pointer;transition:color .15s}
      #${ID} .ala-mi-step:hover{color:rgb(var(--color-blue))}
      #${ID} .ala-mi-step:active{color:rgb(var(--color-text))}
      #${ID} .ala-mi-sub{min-height:16px;overflow:hidden;color:rgb(var(--color-text-lighter));font-size:1.15rem;white-space:nowrap;text-overflow:ellipsis}
      #${ID} .ala-mi-sub b{color:rgb(var(--color-text));font-weight:inherit}
      #${ID} .ala-mi-bar{position:relative;height:3px;margin:13px 0 14px;border-radius:2px;background:rgb(var(--color-background));overflow:hidden}
      #${ID} .ala-mi-bar[hidden]{display:none}
      #${ID} .ala-mi-aired,#${ID} .ala-mi-done{position:absolute;top:0;bottom:0;left:0;width:0;border-radius:2px;transition:width .2s ease}
      #${ID} .ala-mi-aired{background:rgba(var(--color-blue),.3)}
      #${ID} .ala-mi-done{background:rgb(var(--color-blue))}
      #${ID} .ala-mi-save{display:block;width:100%;height:36px;padding:0;border:0;border-radius:4px;background:rgb(var(--color-blue));color:rgb(var(--color-white,255,255,255));font:inherit;font-size:1.4rem;cursor:pointer;transition:filter .15s,opacity .15s,background .2s,color .2s}
      #${ID} .ala-mi-save:hover:not(:disabled){filter:brightness(1.1)}
      #${ID} .ala-mi-save:disabled{opacity:.45;cursor:default}
      #${ID} .ala-mi-save.is-saving,#${ID} .ala-mi-save.is-saving:disabled{opacity:.7;cursor:wait}
      #${ID} .ala-mi-save.is-saved,#${ID} .ala-mi-save.is-saved:disabled{background:rgb(var(--color-green,76,175,80));color:rgb(var(--color-white,255,255,255));opacity:1;cursor:default}
      @media (pointer:coarse){#${ID} .ala-mi-box{height:42px}#${ID} .ala-mi-step{flex:0 0 34px}#${ID} input{font-size:15px}#${ID} .ala-mi-save{height:40px}}
      @media (prefers-reduced-motion:reduce){#${ID} .ala-mi-aired,#${ID} .ala-mi-done,#${ID} .ala-mi-save{transition:none}}`);
			const maxOf = (info, type) => {
				const n = Math.floor(Number(type === "ANIME" ? info?.episodes : info?.chapters));
				return n > 0 ? n : null;
			};
			function airedEpisodes(info) {
				const next = Number(info?.nextAiringEpisode?.episode);
				if (Number.isFinite(next) && next > 0) return Math.max(0, Math.floor(next) - 1);
				if (info?.status === "NOT_YET_RELEASED") return 0;
				return info?.status === "FINISHED" ? maxOf(info, "ANIME") : null;
			}
			function findSpot() {
				const el = document.querySelector(".sidebar > .data");
				return el?.parentElement && el.parentElement !== document.body ? {
					parent: el.parentElement,
					before: el
				} : null;
			}
			const scoreStep = (f) => f === "POINT_10_DECIMAL" ? "0.1" : "1";
			const scoreMax = (f) => ({
				POINT_100: 100,
				POINT_5: 5,
				POINT_3: 3
			})[f || ""] || 10;
			const formatScore = (raw, f) => {
				const n = Number(raw);
				return !Number.isFinite(n) || n <= 0 ? "" : f === "POINT_10_DECIMAL" ? n.toFixed(1) : String(n);
			};
			const today = () => {
				const d = new Date();
				return {
					year: d.getFullYear(),
					month: d.getMonth() + 1,
					day: d.getDate()
				};
			};
			const scoreFormat = async (rc = currentRc) => (await tryOr(() => (rc?.api ?? ctx.api).viewer()))?.scoreFormat || null;
			let currentRoute = null;
			let currentRc = null;
			let disposed = false;
			let shown = null;
			let gen = 0;
			let rendering = false;
			let rerender = false;
			let saving = false;
			let routeAt = Date.now();
			let cancelSchedule = null;
			let retry = {
				key: null,
				at: 0,
				count: 0
			};
			const MAX_FAILURES = 3;
			const panel = () => document.getElementById(ID);
			const schedule = (ms = 300) => {
				cancelSchedule?.();
				const rc = currentRc;
				if (disposed || !rc || rc.signal.aborted) {
					cancelSchedule = null;
					return;
				}
				cancelSchedule = rc.timeout(() => {
					cancelSchedule = null;
					render();
				}, ms);
			};
			function renderConnect(key, reason = "none", rc = currentRc) {
				const spot = findSpot();
				if (!spot) return void schedule(800);
				const box = document.createElement("div");
				box.id = ID;
				box.dataset.mode = "connect";
				box.innerHTML = `<div style="margin-bottom:10px;color:rgb(var(--color-text-lighter))">${reason === "rejected" ? "Couldn't verify your AniList session. Log in to AniList to edit your score and progress." : "Log in to AniList to edit your score and progress here."}</div><a class="ala-mi-save" href="/login" style="display:inline-block;text-decoration:none;color:#fff;text-align:center;">Log in to AniList</a>`;
				panel()?.remove();
				spot.parent.insertBefore(box, spot.before);
				shown = key;
				if (reason === "none" && rc && !rc.signal.aborted) rc.timeout(() => {
					if (!rc.signal.aborted && panel()?.dataset.mode === "connect" && ctx.api.hasAuth()) render(true);
				}, 3e3);
			}
			function changeProgress(delta, input, limit) {
				const next = Number(input.value) + delta;
				if (!Number.isInteger(next) || next < 0 || delta > 0 && limit !== null && next > limit) return;
				input.value = String(next);
			}
			async function save(media, info, scoreInput, progressInput, fallbackFmt = null, rc = currentRc) {
				if (saving) return null;
				const fmt = await scoreFormat(rc) ?? fallbackFmt;
				const max = maxOf(info, media.type);
				const scoreText = scoreInput.value.trim();
				const score = scoreText === "" ? 0 : Number(scoreText);
				if (!Number.isFinite(score) || score < 0 || score > scoreMax(fmt)) {
					scoreInput.focus();
					return null;
				}
				const progressText = progressInput.value.trim();
				if (progressText === "") {
					progressInput.focus();
					return null;
				}
				let progress = Number(progressText);
				if (!Number.isInteger(progress) || progress < 0) {
					progressInput.focus();
					return null;
				}
				if (max !== null) progress = Math.min(progress, max);
				progressInput.value = String(progress);
				const prev = info.mediaListEntry || {};
				const prevProgress = Number.isFinite(Number(prev.progress)) ? Number(prev.progress) : 0;
				const finishNow = progress !== prevProgress && max !== null && progress >= max && prev.status !== "REPEATING" && (prev.status !== "COMPLETED" || !prev.completedAt?.year);
				const isStarting = (!prev.status || prev.status === "PLANNING") && progress > 0;
				const status = finishNow ? "COMPLETED" : isStarting ? "CURRENT" : void 0;
				saving = true;
				ctx.log.debug("Saving media progress/score:", {
					mediaId: media.id,
					score,
					progress,
					status
				});
				try {
					const entry = await ctx.api.media.save(media.id, media.type, {
						score,
						progress,
						status,
						completedAt: finishNow ? today() : void 0
					});
					if (!entry) throw new Error("AniList did not return the updated entry");
					info.mediaListEntry = entry;
					ctx.log.debug("Save successful:", entry);
					return entry;
				} catch (e) {
					ctx.log.warn("Media list save failed:", e);
					return false;
				} finally {
					saving = false;
				}
			}
			async function render(force = false) {
				const route = currentRoute;
				const rc = currentRc;
				if (disposed || !route || !rc || rc.signal.aborted) {
					shown = null;
					panel()?.remove();
					return;
				}
				const key = `${route.type}:${route.id}`;
				if (rendering) {
					if (force) rerender = true;
					return;
				}
				if (!force && shown === key && panel()) return;
				if (saving && !force) {
					rerender = true;
					schedule(200);
					return;
				}
				if (!force && retry.key === key && (retry.count >= MAX_FAILURES || Date.now() < retry.at)) return;
				if (!findSpot()) {
					if (Date.now() - routeAt < 15e3) schedule(800);
					return;
				}
				if (!ctx.api.hasAuth()) return renderConnect(key, "none", rc);
				const g = gen;
				const stale = () => disposed || g !== gen || rc.signal.aborted || currentRoute?.id !== route.id;
				cancelSchedule?.();
				cancelSchedule = null;
				rendering = true;
				ctx.log.debug("Rendering media info panel for:", key);
				try {
					let info = null;
					let fmt = null;
					try {
						info = await rc.api.media.get(route.id, route.type, { throwAuth: true });
						if (stale()) return;
						if (info) fmt = (await rc.api.viewer())?.scoreFormat || null;
					} catch (e) {
						if (stale()) return;
						if (e?.auth) return renderConnect(key, "rejected", rc);
						info = null;
					}
					if (stale()) return;
					if (!info || !fmt) {
						if (!ctx.api.hasAuth()) return renderConnect(key, "none", rc);
						retry = {
							key,
							at: Date.now() + 15e3,
							count: retry.key === key ? retry.count + 1 : 1
						};
						if (retry.count < MAX_FAILURES) schedule(15500);
						return;
					}
					const spot = findSpot();
					if (!spot) {
						schedule(800);
						return;
					}
					const entry = info.mediaListEntry || {
						score: 0,
						progress: 0
					};
					const max = maxOf(info, route.type);
					const anime = route.type === "ANIME";
					const progress = Number.isFinite(Number(entry.progress)) ? Number(entry.progress) : 0;
					const label = anime ? "Episode" : "Chapter";
					const word = anime ? "aired" : "released";
					const scoreTop = scoreMax(fmt);
					let released = anime ? airedEpisodes(info) : null;
					let lookupPending = !anime;
					const box = document.createElement("div");
					box.id = ID;
					box.innerHTML = `
          <div class="ala-mi-fields">
            <div class="ala-mi-field">
              <span class="ala-mi-label">Score</span>
              <div class="ala-mi-box"><input class="ala-mi-score-input" type="number" min="0" max="${scoreTop}" step="${scoreStep(fmt)}" value="${formatScore(entry.score, fmt)}" placeholder="—" inputmode="decimal" aria-label="Score"></div>
              <span class="ala-mi-sub">out of ${scoreTop}</span>
            </div>
            <div class="ala-mi-field">
              <span class="ala-mi-label">${label}</span>
              <div class="ala-mi-box">
                <button class="ala-mi-step ala-mi-minus" type="button" aria-label="Decrease">−</button>
                <input class="ala-mi-progress-input" type="number" min="0"${max !== null ? ` max="${max}"` : ""} step="1" value="${progress}" inputmode="numeric" aria-label="${label} progress">
                <button class="ala-mi-step ala-mi-plus" type="button" aria-label="Increase">+</button>
              </div>
              <span class="ala-mi-sub ala-mi-prog-sub"></span>
            </div>
          </div>
          <div class="ala-mi-bar"><div class="ala-mi-aired"></div><div class="ala-mi-done"></div></div>
          <button class="ala-mi-save" type="button" disabled>Save</button>`;
					const scoreInput = box.querySelector(".ala-mi-score-input");
					const progressInput = box.querySelector(".ala-mi-progress-input");
					const saveBtn = box.querySelector(".ala-mi-save");
					const sub = box.querySelector(".ala-mi-prog-sub");
					const bar = box.querySelector(".ala-mi-bar");
					const doneFill = box.querySelector(".ala-mi-done");
					const airedFill = box.querySelector(".ala-mi-aired");
					const limit = () => max !== null ? max : released;
					let startScore = scoreInput.value.trim();
					let startProgress = progressInput.value;
					let cancelSavedTimer = null;
					let cancelFailedTimer = null;
					function clearSavedState() {
						if (cancelSavedTimer) {
							cancelSavedTimer();
							cancelSavedTimer = null;
						}
						if (cancelFailedTimer) {
							cancelFailedTimer();
							cancelFailedTimer = null;
						}
						saveBtn.classList.remove("is-saved", "is-saving");
						if (saveBtn.textContent === "Saved" || saveBtn.textContent === "Saving..." || saveBtn.textContent === "Failed") saveBtn.textContent = "Save";
					}
					function paint() {
						const digits = String(progressInput.value || "").trim().length;
						progressInput.dataset.digits = digits >= 4 ? String(digits) : "";
						const typed = Number(progressInput.value);
						const watched = Number.isFinite(typed) && typed > 0 ? typed : 0;
						sub.innerHTML = `of <b>${max !== null ? max : "—"}</b>` + (released != null ? ` · <b>${released}</b> ${word}` : lookupPending ? " · …" : "");
						const total = limit();
						bar.hidden = !(total && total > 0);
						if (total && total > 0) {
							doneFill.style.width = Math.min(100, watched / total * 100) + "%";
							airedFill.style.width = released != null ? Math.min(100, released / total * 100) + "%" : "0%";
						}
						const isDirty = scoreInput.value.trim() !== startScore || progressInput.value !== startProgress;
						if (cancelSavedTimer && isDirty) clearSavedState();
						saveBtn.disabled = saving || Boolean(cancelSavedTimer) || !isDirty;
					}
					saveBtn.addEventListener("click", async () => {
						if (saving || saveBtn.disabled) return;
						clearSavedState();
						saveBtn.textContent = "Saving...";
						saveBtn.classList.add("is-saving");
						saveBtn.disabled = true;
						let res = null;
						try {
							res = await save(route, info, scoreInput, progressInput, fmt, rc);
						} finally {
							saveBtn.classList.remove("is-saving");
						}
						if (!box.isConnected) {
							if (!disposed && currentRoute && currentRc && !currentRc.signal.aborted && (rerender || !panel())) {
								rerender = false;
								safe(() => render(true), "media info refresh");
							}
							return;
						}
						if (res && res !== false) {
							scoreInput.value = formatScore(res.score, fmt);
							const nextProg = Number(res.progress);
							progressInput.value = Number.isFinite(nextProg) ? String(nextProg) : progressInput.value;
							startScore = scoreInput.value.trim();
							startProgress = progressInput.value;
							saveBtn.classList.add("is-saved");
							saveBtn.textContent = "Saved";
							saveBtn.disabled = true;
							cancelSavedTimer = rc.timeout(() => {
								cancelSavedTimer = null;
								if (rc.signal.aborted || !box.isConnected) return;
								saveBtn.classList.remove("is-saved");
								saveBtn.textContent = "Save";
								paint();
							}, 1800);
							paint();
						} else if (res === false) {
							saveBtn.textContent = "Failed";
							saveBtn.disabled = false;
							cancelFailedTimer = rc.timeout(() => {
								cancelFailedTimer = null;
								if (!rc.signal.aborted && box.isConnected && saveBtn.textContent === "Failed") {
									saveBtn.textContent = "Save";
									paint();
								}
							}, 2e3);
						} else {
							saveBtn.textContent = "Save";
							paint();
						}
					});
					for (const input of [scoreInput, progressInput]) {
						input.addEventListener("keydown", (e) => {
							if (e.key === "Enter") saveBtn.click();
						});
						input.addEventListener("input", paint);
						input.addEventListener("focus", () => {
							if (input.value) input.select();
							else if (input.placeholder) {
								input.dataset.placeholder = input.placeholder;
								input.placeholder = "";
							}
						});
						input.addEventListener("blur", () => {
							if (!input.value && input.dataset.placeholder) input.placeholder = input.dataset.placeholder;
						});
					}
					box.querySelector(".ala-mi-minus")?.addEventListener("click", () => {
						changeProgress(-1, progressInput, limit());
						paint();
					});
					box.querySelector(".ala-mi-plus")?.addEventListener("click", () => {
						changeProgress(1, progressInput, limit());
						paint();
					});
					panel()?.remove();
					spot.parent.insertBefore(box, spot.before);
					shown = key;
					paint();
					if (!anime) externalReleased(info, {
						http: ctx.http,
						signal: rc.signal
					}).then((n) => {
						if (stale() || !box.isConnected) return;
						released = n;
						lookupPending = false;
						paint();
					}, () => {
						if (stale() || !box.isConnected) return;
						lookupPending = false;
						paint();
					});
				} finally {
					rendering = false;
					if (rerender) {
						rerender = false;
						safe(() => render(true), "media info refresh");
					}
				}
			}
			ctx.onRoute(/^\/(anime|manga)\/(\d+)(?:\/|$)/, (rc) => {
				const kind = rc.match[1];
				const r = {
					kind,
					type: kind.toUpperCase(),
					id: Number(rc.match[2])
				};
				currentRoute = r;
				currentRc = rc;
				gen++;
				shown = null;
				rerender = false;
				routeAt = Date.now();
				retry = {
					key: null,
					at: 0,
					count: 0
				};
				panel()?.remove();
				schedule(document.readyState === "complete" ? 500 : 1200);
				rc.listen(window, "load", () => schedule(500), { once: true });
				rc.listen(window, "focus", () => {
					if (panel()?.dataset.mode === "connect" && ctx.api.hasAuth()) render(true);
				});
				rc.onBodyMutation(() => {
					if (currentRoute !== r || panel() || rendering || saving) return;
					if (retry.key === `${r.type}:${r.id}` && retry.count >= MAX_FAILURES) return;
					schedule(500);
				});
				return () => {
					cancelSchedule?.();
					cancelSchedule = null;
					if (currentRoute === r) {
						currentRoute = null;
						currentRc = null;
					}
					rerender = false;
					gen++;
					shown = null;
					panel()?.remove();
				};
			});
			ctx.onCleanup(() => {
				disposed = true;
				currentRoute = null;
				currentRc = null;
				rerender = false;
				gen++;
				cancelSchedule?.();
				cancelSchedule = null;
				panel()?.remove();
			});
		}
	});
	var anilistLog = createCoreLogger("anilist");
	var NAV_SELECTORS = {
		loginNav: "nav a[href=\"/login\"], .nav a[href=\"/login\"]",
		userNav: "nav a[href^=\"/user/\"], .nav-wrap a[href^=\"/user/\"], .nav a[href^=\"/user/\"]",
		loggedInNav: "nav a[href^=\"/user/\"], .nav-wrap a[href^=\"/user/\"], .user-wrap .avatar"
	};
	function isLoggedOutNav(doc = document) {
		return !!doc?.querySelector?.(NAV_SELECTORS.loginNav);
	}
	function hasLoggedInNav(doc = document) {
		return !!doc?.querySelector?.(NAV_SELECTORS.loggedInNav);
	}
	function navUserName(doc = document) {
		const href = doc?.querySelector?.(NAV_SELECTORS.userNav)?.getAttribute("href");
		const m = href && href.match(/^\/user\/([^/?#]+)/);
		if (!m) return "";
		try {
			return decodeURIComponent(m[1]);
		} catch {
			return m[1];
		}
	}
	function throwIfAborted(signal) {
		if (signal?.aborted) throw createAbortError(signal);
	}
	function stripCommentsAndStrings(q) {
		let out = "";
		let i = 0;
		const len = q.length;
		while (i < len) {
			const ch = q[i];
			if (ch === "#") {
				while (i < len && q[i] !== "\n" && q[i] !== "\r") i++;
				out += " ";
				continue;
			}
			if (ch === "\"") {
				if (q[i + 1] === "\"" && q[i + 2] === "\"") {
					i += 3;
					while (i < len) {
						if (q[i] === "\\" && q[i + 1] === "\"" && q[i + 2] === "\"" && q[i + 3] === "\"") {
							i += 4;
							continue;
						}
						if (q[i] === "\"" && q[i + 1] === "\"" && q[i + 2] === "\"") {
							i += 3;
							break;
						}
						i++;
					}
				} else {
					i++;
					while (i < len) {
						if (q[i] === "\\") {
							i += 2;
							continue;
						}
						if (q[i] === "\"") {
							i++;
							break;
						}
						i++;
					}
				}
				out += " \"\" ";
				continue;
			}
			out += ch;
			i++;
		}
		return out;
	}
	function parseRootSelection(q) {
		const stripped = stripCommentsAndStrings(q);
		const firstBrace = stripped.indexOf("{");
		if (firstBrace === -1) return null;
		const header = stripped.slice(0, firstBrace).trim();
		if (/\b(?:mutation|subscription|fragment)\b/i.test(header) || /@/.test(header)) return null;
		let braceDepth = 0;
		let rootCount = 0;
		let rootField = "";
		let rootArgs = "";
		const innerChars = [];
		let inRootFieldBody = false;
		const len = stripped.length;
		let i = firstBrace;
		while (i < len) {
			const ch = stripped[i];
			if (ch === "{") {
				braceDepth++;
				if (braceDepth === 2 && rootCount === 1 && !inRootFieldBody) inRootFieldBody = true;
				else if (inRootFieldBody) innerChars.push(ch);
				i++;
				continue;
			}
			if (ch === "}") {
				if (braceDepth === 2 && inRootFieldBody) inRootFieldBody = false;
				else if (inRootFieldBody) innerChars.push(ch);
				braceDepth--;
				i++;
				if (braceDepth === 0) {
					if (stripped.slice(i).trim()) return null;
					break;
				}
				continue;
			}
			if (inRootFieldBody) {
				innerChars.push(ch);
				i++;
				continue;
			}
			if (braceDepth === 1) {
				if (/\s|,/.test(ch)) {
					i++;
					continue;
				}
				if (ch === "." && stripped.slice(i, i + 3) === "...") return null;
				if (/[a-zA-Z_]/.test(ch)) {
					let end = i + 1;
					while (end < len && /[a-zA-Z0-9_]/.test(stripped[end])) end++;
					const ident = stripped.slice(i, end);
					let j = end;
					while (j < len && /\s/.test(stripped[j])) j++;
					if (stripped[j] === ":") return null;
					rootCount++;
					if (rootCount > 1) return null;
					rootField = ident;
					if (stripped[j] === "(") {
						let pd = 1;
						let k = j + 1;
						while (k < len && pd > 0) {
							if (stripped[k] === "(") pd++;
							else if (stripped[k] === ")") pd--;
							k++;
						}
						if (pd !== 0) return null;
						rootArgs = stripped.slice(j + 1, k - 1).trim();
						i = k;
						continue;
					}
					i = end;
					continue;
				}
				return null;
			}
			i++;
		}
		if (braceDepth !== 0 || rootCount !== 1 || !rootField) return null;
		const innerSelection = innerChars.join("");
		return {
			rootField,
			rootArgs,
			innerSelection
		};
	}
	function parseTopLevelArgs(args) {
		if (!args) return {};
		const result = {};
		let i = 0;
		const len = args.length;
		while (i < len) {
			while (i < len && /[\s,]/.test(args[i])) i++;
			if (i >= len) break;
			if (!/[a-zA-Z_]/.test(args[i])) return null;
			let nameEnd = i + 1;
			while (nameEnd < len && /[a-zA-Z0-9_]/.test(args[nameEnd])) nameEnd++;
			const key = args.slice(i, nameEnd);
			let j = nameEnd;
			while (j < len && /\s/.test(args[j])) j++;
			if (args[j] !== ":") return null;
			j++;
			while (j < len && /\s/.test(args[j])) j++;
			if (j >= len) return null;
			let valEnd = j;
			let depth = 0;
			while (valEnd < len) {
				const c = args[valEnd];
				if (c === "{" || c === "[" || c === "(") depth++;
				else if (c === "}" || c === "]" || c === ")") {
					if (depth === 0) return null;
					depth--;
					if (depth === 0) {
						valEnd++;
						break;
					}
				} else if (depth === 0 && /[\s,]/.test(c)) break;
				valEnd++;
			}
			if (depth !== 0) return null;
			result[key] = args.slice(j, valEnd).trim();
			i = valEnd;
		}
		return result;
	}
	var UNRESOLVABLE_ARG = Symbol("unresolvable");
	function parsePositiveId(raw) {
		if (typeof raw === "number") return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
		if (typeof raw === "string") {
			const trimmed = raw.trim();
			if (!/^\d+$/.test(trimmed)) return null;
			const n = Number(trimmed);
			return Number.isSafeInteger(n) && n > 0 ? n : null;
		}
		return null;
	}
	function extractSelectionPaths(inner) {
		const paths = new Set();
		const stack = [];
		const blockHasField = [];
		let lastIdent = "";
		const tokenRe = /[{}]|[a-zA-Z_][a-zA-Z0-9_]*/g;
		let m;
		while ((m = tokenRe.exec(inner)) !== null) {
			const tok = m[0];
			if (tok === "{") {
				if (!lastIdent) return null;
				stack.push(lastIdent);
				blockHasField.push(false);
				lastIdent = "";
			} else if (tok === "}") {
				if (stack.length === 0 || !blockHasField.pop()) return null;
				stack.pop();
				lastIdent = "";
			} else {
				if (blockHasField.length > 0) blockHasField[blockHasField.length - 1] = true;
				paths.add(stack.length > 0 ? `${stack.join(".")}.${tok}` : tok);
				lastIdent = tok;
			}
		}
		return stack.length === 0 && paths.size > 0 ? paths : null;
	}
	function parseEntityMeta(query, vars) {
		if (typeof query !== "string") return null;
		const parsed = parseRootSelection(query);
		if (!parsed) return null;
		if (/[:.@()]/.test(parsed.innerSelection)) return null;
		const requiredFields = extractSelectionPaths(parsed.innerSelection);
		if (!requiredFields) return null;
		const argMap = parseTopLevelArgs(parsed.rootArgs);
		if (!argMap) return null;
		const safeVars = vars && typeof vars === "object" ? vars : {};
		if (parsed.rootField === "MediaListCollection") {
			const allowedArgs = new Set([
				"userId",
				"userName",
				"type"
			]);
			for (const k of Object.keys(argMap)) if (!allowedArgs.has(k)) return null;
			const boundVars = new Set();
			const resolveArg = (argName) => {
				const raw = argMap[argName];
				if (!raw) return void 0;
				if (raw.startsWith("$")) {
					const varName = raw.slice(1);
					boundVars.add(varName);
					return safeVars[varName];
				}
				if (argName === "userId" && /^\d+$/.test(raw)) return Number(raw);
				if (argName === "type" && /^(?:ANIME|MANGA)$/i.test(raw)) return raw.toUpperCase();
				return UNRESOLVABLE_ARG;
			};
			const rawType = resolveArg("type");
			const rawUserId = resolveArg("userId");
			const rawUserName = resolveArg("userName");
			if (rawType === UNRESOLVABLE_ARG || rawUserId === UNRESOLVABLE_ARG || rawUserName === UNRESOLVABLE_ARG) return null;
			for (const k of Object.keys(safeVars)) if (!boundVars.has(k) && safeVars[k] !== void 0 && safeVars[k] !== null) return null;
			if (typeof rawType !== "string") return null;
			const type = rawType.trim().toUpperCase();
			if (type !== "ANIME" && type !== "MANGA") return null;
			if (rawUserId != null && (typeof rawUserId !== "number" || !Number.isSafeInteger(rawUserId) || rawUserId <= 0)) return null;
			if (rawUserName != null && (typeof rawUserName !== "string" || !rawUserName.trim())) return null;
			const normName = rawUserName ? rawUserName.trim().toLowerCase() : "";
			return {
				entityKey: `MediaListCollection:${type}:${rawUserId || normName || "me"}`,
				isSuperset: requiredFields.size > 12,
				requiredFields
			};
		}
		if (parsed.rootField === "Media") {
			const allowedArgs = new Set(["id", "type"]);
			for (const k of Object.keys(argMap)) if (!allowedArgs.has(k)) return null;
			const boundVars = new Set();
			let mediaId;
			if (argMap.id) {
				if (argMap.id.startsWith("$")) {
					const varName = argMap.id.slice(1);
					boundVars.add(varName);
					mediaId = safeVars[varName];
				} else if (/^\d+$/.test(argMap.id)) mediaId = Number(argMap.id);
			}
			if (typeof mediaId !== "number" || !Number.isSafeInteger(mediaId) || mediaId <= 0) return null;
			let resolvedType = "";
			if (argMap.type !== void 0) {
				let rawType;
				if (argMap.type.startsWith("$")) {
					const varName = argMap.type.slice(1);
					boundVars.add(varName);
					rawType = safeVars[varName];
				} else if (/^(?:ANIME|MANGA)$/i.test(argMap.type)) rawType = argMap.type.toUpperCase();
				else return null;
				if (rawType !== void 0 && rawType !== null) {
					if (typeof rawType !== "string") return null;
					const norm = rawType.trim().toUpperCase();
					if (norm !== "ANIME" && norm !== "MANGA") return null;
					resolvedType = norm;
				}
			}
			for (const k of Object.keys(safeVars)) if (!boundVars.has(k) && safeVars[k] !== void 0 && safeVars[k] !== null) return null;
			return {
				entityKey: `Media:${mediaId}:${resolvedType || "*"}`,
				isSuperset: requiredFields.size > 10,
				requiredFields
			};
		}
		if (parsed.rootField === "Viewer") {
			if (Object.keys(argMap).length > 0) return null;
			for (const k of Object.keys(safeVars)) if (safeVars[k] !== void 0 && safeVars[k] !== null) return null;
			return {
				entityKey: "Viewer",
				isSuperset: requiredFields.has("mediaListOptions.scoreFormat"),
				requiredFields
			};
		}
		return null;
	}
	function isSubsetOf(subset, superset) {
		for (const item of subset) if (!superset.has(item)) return false;
		return true;
	}
	var MEDIA_LIST_SINGLE_QUERY = `query ($userId: Int, $userName: String, $type: MediaType) {
      MediaListCollection(userId: $userId, userName: $userName, type: $type) {
        user { id name }
        lists {
          name
          isCustomList
          status
          entries {
            id
            mediaId
            status
            score
            progress
            progressVolumes
            repeat
            priority
            notes
            customLists
            startedAt { year month day }
            completedAt { year month day }
            media {
              id
              idMal
              format
              episodes
              chapters
              status
              title { userPreferred english romaji native }
            }
          }
        }
      }
    }`;
	var MEDIA_LIST_REQUIRED_FIELDS = extractSelectionPaths(parseRootSelection(MEDIA_LIST_SINGLE_QUERY)?.innerSelection ?? "") ?? new Set();
	var AniList = (() => {
		const limiter = new RateLimiter({
			rate: 25,
			max: 90,
			burst: 1,
			persistKey: "ala_anilist_api_resume_at"
		});
		const entityCache = new Map();
		const inflightExact = new Map();
		const inflightEntities = new Map();
		const ENTITY_TTL = 18e4;
		let cacheEpoch = 0;
		let viewerEpoch = 0;
		let unsubGql = null;
		const pageWin = () => typeof _unsafeWindow !== "undefined" ? _unsafeWindow : window;
		function safeBridge(fn) {
			try {
				return fn();
			} catch (e) {
				anilistLog.debug("Cache bridge error:", e);
				return;
			}
		}
		function maybeUnsubscribeMutationListener() {
			if (unsubGql && entityCache.size === 0 && inflightExact.size === 0 && inflightEntities.size === 0) {
				const unsub = unsubGql;
				unsubGql = null;
				try {
					unsub();
				} catch (_) {}
			}
		}
		function invalidateLocal(entityKeyPrefix) {
			cacheEpoch++;
			if (!entityKeyPrefix) {
				entityCache.clear();
				inflightEntities.clear();
				inflightExact.clear();
			} else {
				const normPrefix = entityKeyPrefix.replace(/:+$/, "");
				if (normPrefix) {
					const matchesPrefix = (k) => !!k && (k === normPrefix || k.startsWith(`${normPrefix}:`));
					for (const k of entityCache.keys()) if (matchesPrefix(k)) entityCache.delete(k);
					for (const k of inflightEntities.keys()) if (matchesPrefix(k)) inflightEntities.delete(k);
					for (const [k, entry] of inflightExact.entries()) if (matchesPrefix(entry.entityKey)) inflightExact.delete(k);
				}
			}
			maybeUnsubscribeMutationListener();
		}
		function ensureMutationListener() {
			if (unsubGql) return;
			try {
				unsubGql = CoreHooks.onGqlFetch((event) => {
					const rawQuery = typeof event?.query === "string" ? event.query : "";
					if (rawQuery && isGqlMutation(rawQuery)) invalidateLocal();
				});
			} catch (_) {
				unsubGql = null;
			}
		}
		function getCsrfToken() {
			const win = pageWin();
			if (typeof win.al_token === "string" && win.al_token) return win.al_token;
			try {
				const meta = win.document?.querySelector("meta[name=\"csrf-token\"]");
				if (meta?.content) return meta.content;
			} catch (_) {}
			try {
				const scripts = win.document?.querySelectorAll("head script") || [];
				for (const s of scripts) {
					const m = s.textContent?.match(/window\.al_token\s*=\s*['"]([^'"]+)['"]/);
					if (m && m[1]) return m[1];
				}
			} catch (_) {}
			return null;
		}
		const clearViewer = () => {
			viewerEpoch++;
			CoreHooks.setSessionClearing(true);
			try {
				for (const k of ANILIST_SESSION_KEYS) store$1.del(k);
				invalidate();
				CoreHooks.clearAuth();
			} finally {
				CoreHooks.setSessionClearing(false);
			}
		};
		function readPageDoc() {
			const win = pageWin();
			return {
				win,
				doc: win?.document || (typeof document !== "undefined" ? document : void 0)
			};
		}
		function peek(opts) {
			if (opts?.reconcile) syncFromPage();
			const { win, doc } = readPageDoc();
			if (doc && isLoggedOutNav(doc)) return {
				userId: null,
				username: null,
				scoreFormat: null
			};
			const storedId = parsePositiveId(store$1.get("al_user_id", null));
			const storedNameRaw = store$1.get("al_username", null);
			const storedName = typeof storedNameRaw === "string" && storedNameRaw ? storedNameRaw : null;
			const storedFmtRaw = store$1.get("al_score_format", null);
			const storedFmt = typeof storedFmtRaw === "string" && storedFmtRaw ? storedFmtRaw : null;
			const cachedViewer = entityCache.get("Viewer")?.data?.Viewer;
			const cachedViewerId = parsePositiveId(cachedViewer?.id);
			const nuxtUser = win?.__NUXT__?.state?.auth?.user || win?.__NUXT__?.state?.user;
			const nuxtId = parsePositiveId(nuxtUser?.id);
			const navName = doc ? navUserName(doc) || null : null;
			if (nuxtId !== null) {
				const storedMismatch = storedId !== null && storedId !== nuxtId || storedId === null && storedName !== null && typeof nuxtUser.name === "string" && storedName.toLowerCase() !== nuxtUser.name.toLowerCase();
				const cachedMatches = cachedViewerId !== null && cachedViewerId === nuxtId;
				return {
					userId: nuxtId,
					username: (nuxtUser.name ? String(nuxtUser.name) : null) || (cachedMatches && cachedViewer?.name ? String(cachedViewer.name) : null) || (!storedMismatch ? storedName : null) || navName || null,
					scoreFormat: (cachedMatches ? cachedViewer?.mediaListOptions?.scoreFormat || null : null) || (!storedMismatch ? storedFmt : null)
				};
			}
			if (navName) {
				const storedMatches = storedName === null || storedName.toLowerCase() === navName.toLowerCase();
				const cachedMatches = !!(cachedViewer?.name && String(cachedViewer.name).toLowerCase() === navName.toLowerCase());
				return {
					userId: (storedMatches ? storedId : null) || (cachedMatches ? cachedViewerId : null),
					username: storedMatches && storedName || navName,
					scoreFormat: (storedMatches ? storedFmt : null) || (cachedMatches ? cachedViewer?.mediaListOptions?.scoreFormat || null : null)
				};
			}
			return {
				userId: storedId || cachedViewerId,
				username: storedName || (cachedViewer?.name ? String(cachedViewer.name) : null),
				scoreFormat: storedFmt || cachedViewer?.mediaListOptions?.scoreFormat || null
			};
		}
		function syncFromPage() {
			const { win, doc } = readPageDoc();
			if (doc && isLoggedOutNav(doc)) {
				if (ANILIST_SESSION_KEYS.some((k) => store$1.get(k, void 0) !== void 0) || entityCache.has("Viewer")) clearViewer();
				return;
			}
			const nuxtUser = win?.__NUXT__?.state?.auth?.user || win?.__NUXT__?.state?.user;
			const nuxtId = parsePositiveId(nuxtUser?.id);
			if (nuxtId !== null) {
				const storedId = parsePositiveId(store$1.get("al_user_id", null));
				const cachedViewerId = parsePositiveId(entityCache.get("Viewer")?.data?.Viewer?.id);
				if (storedId !== null && storedId !== nuxtId || cachedViewerId !== null && cachedViewerId !== nuxtId) clearViewer();
				return;
			}
			const pageName = typeof nuxtUser?.name === "string" && nuxtUser.name.trim() || (doc ? navUserName(doc) : "");
			if (pageName) {
				const storedName = store$1.get("al_username", null);
				const cachedViewerName = entityCache.get("Viewer")?.data?.Viewer?.name;
				if (storedName && storedName.toLowerCase() !== pageName.toLowerCase() || typeof cachedViewerName === "string" && cachedViewerName && cachedViewerName.toLowerCase() !== pageName.toLowerCase()) clearViewer();
			}
		}
		function isViewerMismatchedWithPage(v) {
			const { win, doc } = readPageDoc();
			if (doc && isLoggedOutNav(doc)) return true;
			const nuxtUser = win?.__NUXT__?.state?.auth?.user || win?.__NUXT__?.state?.user;
			const nuxtId = parsePositiveId(nuxtUser?.id);
			const vId = parsePositiveId(v?.id);
			if (nuxtId !== null && vId !== null) {
				if (vId !== nuxtId) return true;
			}
			const pageName = (nuxtUser?.name ? String(nuxtUser.name).trim() : "") || (doc ? navUserName(doc) : "");
			if (pageName && v?.name) {
				if (String(v.name).trim().toLowerCase() !== pageName.toLowerCase()) return true;
			}
			return false;
		}
		function recordHint(hint) {
			if (!hint || CoreHooks.isSessionClearing()) return;
			const nextId = typeof hint.userId === "number" && Number.isFinite(hint.userId) && hint.userId > 0 ? Math.floor(hint.userId) : null;
			const nextName = typeof hint.username === "string" && hint.username.trim() ? hint.username.trim() : null;
			if (nextId === null && nextName === null) return;
			syncFromPage();
			if (CoreHooks.isSessionClearing()) return;
			if (isViewerMismatchedWithPage({
				id: nextId,
				name: nextName
			})) return;
			if (nextId !== null) {
				const storedId = Number(store$1.get("al_user_id", 0));
				if (storedId && storedId !== nextId) {
					store$1.del("al_username");
					store$1.del("al_score_format");
				}
				if (storedId !== nextId) store$1.set("al_user_id", nextId);
			}
			if (nextName !== null && store$1.get("al_username", null) !== nextName) store$1.set("al_username", nextName);
		}
		function isBrowserLoggedIn(opts) {
			if (opts?.reconcile !== false) syncFromPage();
			const { win, doc } = readPageDoc();
			if (doc && isLoggedOutNav(doc)) return false;
			if (parsePositiveId((win?.__NUXT__?.state?.auth?.user || win?.__NUXT__?.state?.user)?.id) !== null) return true;
			if (doc && hasLoggedInNav(doc)) return true;
			return Boolean(parsePositiveId(store$1.get("al_user_id", null)) !== null && store$1.get("al_username", null));
		}
		const header = (res, name) => {
			try {
				return res?.headers?.get?.(name) ?? null;
			} catch (_) {
				return null;
			}
		};
		function resetDelay(res) {
			const retry = Number(header(res, "Retry-After"));
			if (Number.isFinite(retry) && retry > 0) return Math.max(0, Math.min(retry * 1e3, 12e4));
			const reset = Number(header(res, "X-RateLimit-Reset"));
			if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.min((reset > 0xe8d4a51000 ? reset : reset * 1e3) - Date.now(), 12e4));
			return 0;
		}
		function handle(res) {
			const advertised = Number(header(res, "X-RateLimit-Limit"));
			if (advertised > 0) limiter.setRate(Math.floor(advertised * .85));
			if (res?.status === 429) return limiter.limit(resetDelay(res) || 6e4);
			const remaining = header(res, "X-RateLimit-Remaining");
			if (remaining != null && Number(remaining) <= 1) limiter.limit(resetDelay(res));
		}
		async function executeNetworkRequest(q, variables, retries, forceFresh = false, attempt = 0, signal) {
			throwIfAborted(signal);
			const safeRetries = Number.isFinite(retries) ? Math.max(0, Math.floor(retries)) : 3;
			const csrfToken = getCsrfToken();
			const win = pageWin();
			const fetchFn = (typeof win.fetch === "function" ? win.fetch : fetch).bind(win);
			const backoff = () => sleep(Math.min(3e4, 1500 * (attempt + 1)), signal);
			const endpoint = `${win.location?.origin || "https://anilist.co"}/graphql`;
			const headers = {
				"Content-Type": "application/json",
				Accept: "application/json",
				...forceFresh ? { "Cache-Control": "no-cache" } : {}
			};
			if (csrfToken) headers["X-CSRF-TOKEN"] = csrfToken;
			let res;
			try {
				await limiter.acquire({ signal });
				throwIfAborted(signal);
				res = await fetchFn(endpoint, {
					method: "POST",
					headers,
					cache: forceFresh ? "no-store" : void 0,
					credentials: "include",
					body: JSON.stringify({
						query: q,
						variables
					}),
					signal,
					__alfl: "internal"
				});
			} catch (e) {
				if (signal?.aborted || isAbortError(e)) throw signal?.aborted ? createAbortError(signal) : e;
				if (safeRetries > 0) {
					await backoff();
					return executeNetworkRequest(q, variables, safeRetries - 1, forceFresh, attempt + 1, signal);
				}
				throw new Error(`AniList network error: ${e?.message || e}`);
			}
			throwIfAborted(signal);
			handle(res);
			if (!res) throw new Error("AniList network error: empty response");
			if ((res.status === 429 || res.status >= 500) && safeRetries > 0) {
				if (res.status >= 500) await backoff();
				throwIfAborted(signal);
				return executeNetworkRequest(q, variables, safeRetries - 1, forceFresh, attempt + 1, signal);
			}
			let json = null;
			try {
				json = await res.json();
			} catch (e) {
				if (signal?.aborted || isAbortError(e)) throw signal?.aborted ? createAbortError(signal) : e;
			}
			throwIfAborted(signal);
			const message = json?.errors?.length ? json.errors.map((e) => e.message).join("; ") : "";
			if (res.status === 401 || /invalid token|unauthenticated|unauthorized/i.test(message)) {
				clearViewer();
				throw authError("AniList", "AniList session unauthenticated — please log in to AniList.");
			}
			if (message) throw new Error(message);
			if (!res.ok || !json) throw new Error(`AniList API HTTP ${res.status}`);
			return json.data;
		}
		async function query(q, variables = {}, optionsOrRetries) {
			const opts = typeof optionsOrRetries === "number" ? { retries: optionsOrRetries } : optionsOrRetries || {};
			throwIfAborted(opts.signal);
			const rawRetries = opts.retries ?? 3;
			const retries = Number.isFinite(rawRetries) ? Math.max(0, Math.floor(rawRetries)) : 3;
			if (isGqlMutation(q)) {
				invalidate();
				return executeNetworkRequest(q, variables, retries, false, 0, opts.signal).finally(() => {
					invalidate();
				});
			}
			ensureMutationListener();
			const meta = parseEntityMeta(q, variables);
			const now = Date.now();
			const exactKey = `${q}\u0001${JSON.stringify(variables)}`;
			if (!opts.forceFresh && meta) {
				const cached = entityCache.get(meta.entityKey);
				if (cached && now - cached.time < ENTITY_TTL && isSubsetOf(meta.requiredFields, cached.fields)) {
					anilistLog.debug("🎯 Cache HIT via Subset matching:", meta.entityKey);
					return cached.data;
				}
			}
			if (meta && !opts.forceFresh) {
				const flyingEntity = inflightEntities.get(meta.entityKey);
				if (flyingEntity && !flyingEntity.flight.controller.signal.aborted && isSubsetOf(meta.requiredFields, flyingEntity.fields)) {
					anilistLog.debug("🔗 Attached to in-flight Superset request:", meta.entityKey);
					return flyingEntity.flight.wait({ signal: opts.signal });
				}
			}
			const flyingExact = inflightExact.get(exactKey);
			if (flyingExact && !flyingExact.flight.controller.signal.aborted && !opts.forceFresh) return flyingExact.flight.wait({ signal: opts.signal });
			const reqEpoch = cacheEpoch;
			const cleanupFlightRefs = (targetFlight) => {
				if (inflightExact.get(exactKey)?.flight === targetFlight) inflightExact.delete(exactKey);
				if (meta && inflightEntities.get(meta.entityKey)?.flight === targetFlight) inflightEntities.delete(meta.entityKey);
				maybeUnsubscribeMutationListener();
			};
			const flight = createSharedFlight({
				start: (sharedSignal) => executeNetworkRequest(q, variables, retries, opts.forceFresh, 0, sharedSignal).then((data) => {
					if (meta && data && cacheEpoch === reqEpoch && data?.MediaListCollection?.hasNextChunk !== true) {
						const existing = entityCache.get(meta.entityKey);
						if (!(!opts.forceFresh && existing && Date.now() - existing.time < ENTITY_TTL && isSubsetOf(meta.requiredFields, existing.fields) && !isSubsetOf(existing.fields, meta.requiredFields))) entityCache.set(meta.entityKey, {
							time: Date.now(),
							data,
							isSuperset: meta.isSuperset,
							fields: meta.requiredFields
						});
					}
					return data;
				}),
				onEvict: cleanupFlightRefs,
				onSettled: cleanupFlightRefs
			});
			inflightExact.set(exactKey, {
				flight,
				entityKey: meta?.entityKey
			});
			if (meta) {
				const existing = inflightEntities.get(meta.entityKey);
				if (!existing || existing.flight.controller.signal.aborted || !existing.isSuperset && meta.isSuperset) inflightEntities.set(meta.entityKey, {
					flight,
					isSuperset: meta.isSuperset,
					fields: meta.requiredFields
				});
			}
			return flight.wait({ signal: opts.signal });
		}
		function formatMediaListResult(mlc) {
			const rawLists = Array.isArray(mlc?.lists) ? mlc.lists : [];
			const lists = [];
			const seenEntryIds = new Set();
			const allEntries = [];
			for (const list of rawLists) {
				if (!list || typeof list !== "object") continue;
				const validEntries = [];
				if (Array.isArray(list.entries)) for (const entry of list.entries) {
					if (!entry || typeof entry !== "object") continue;
					validEntries.push(entry);
					if (entry.id != null) {
						if (!seenEntryIds.has(entry.id)) {
							seenEntryIds.add(entry.id);
							allEntries.push(entry);
						}
					} else allEntries.push(entry);
				}
				lists.push({
					...list,
					entries: validEntries
				});
			}
			const mergedCollection = {
				user: mlc?.user,
				lists
			};
			return {
				collection: mergedCollection,
				lists,
				allEntries,
				user: mergedCollection.user
			};
		}
		function isValidFastLoadEntry(entry) {
			if (!entry || typeof entry !== "object") return false;
			if (typeof entry.mediaId !== "number" || !Number.isFinite(entry.mediaId) || entry.mediaId <= 0) return false;
			if (!entry.media || typeof entry.media !== "object" || typeof entry.media.id !== "number") return false;
			if (typeof entry.status !== "string" || !entry.status) return false;
			return true;
		}
		function isValidFastLoadMediaList(mlc) {
			if (!mlc || typeof mlc !== "object" || !Array.isArray(mlc.lists) || mlc.hasNextChunk === true) return false;
			for (const list of mlc.lists) {
				if (list === null) continue;
				if (typeof list !== "object" || !Array.isArray(list.entries)) return false;
				for (const entry of list.entries) {
					if (entry === null) continue;
					if (!isValidFastLoadEntry(entry)) return false;
				}
			}
			return true;
		}
		function parseRpcMediaList(payload) {
			if (!payload || typeof payload !== "object") return null;
			if (payload.hasNextChunk === true) return null;
			const mlc = payload.MediaListCollection || payload.data?.MediaListCollection;
			if (mlc && Array.isArray(mlc.lists)) {
				if (!isValidFastLoadMediaList(mlc)) return null;
				return formatMediaListResult(mlc);
			}
			const entities = payload.entities || payload;
			const entriesMap = entities?.listEntry || entities?.mediaListEntry;
			if (entriesMap && typeof entriesMap === "object") {
				const mediaMap = entities.media || entities.listEntryMedia || {};
				const allEntries = [];
				const normalizedById = new Map();
				for (const [entryKey, rawEntry] of Object.entries(entriesMap)) {
					if (!rawEntry || typeof rawEntry !== "object") continue;
					const mediaId = rawEntry.mediaId || (typeof rawEntry.media === "number" ? rawEntry.media : rawEntry.media?.id);
					if (!mediaId) continue;
					const mediaObj = typeof rawEntry.media === "object" && rawEntry.media !== null ? rawEntry.media : mediaMap[mediaId] || { id: mediaId };
					const normalized = {
						...rawEntry,
						mediaId,
						media: mediaObj
					};
					allEntries.push(normalized);
					normalizedById.set(entryKey, normalized);
					if (rawEntry.id != null) {
						const idKey = String(rawEntry.id);
						if (idKey !== entryKey) normalizedById.set(idKey, normalized);
					}
				}
				if (allEntries.length === 0) return null;
				const userObj = entities.user ? Object.values(entities.user)[0] : void 0;
				const lists = [];
				if (entities.listSection && typeof entities.listSection === "object") for (const sec of Object.values(entities.listSection)) {
					if (!sec) continue;
					lists.push({
						name: sec.name || "",
						isCustomList: !!sec.isCustomList,
						status: sec.status,
						entries: Array.isArray(sec.entries) ? sec.entries.map((id) => typeof id === "string" || typeof id === "number" ? normalizedById.get(String(id)) : void 0).filter((e) => Boolean(e)) : []
					});
				}
				const user = userObj && userObj.id ? {
					id: Number(userObj.id),
					name: String(userObj.name || "")
				} : void 0;
				return {
					collection: {
						lists,
						user
					},
					allEntries,
					lists,
					user
				};
			}
			return null;
		}
		function matchMediaListKey(key, prefix, type, resolvedId, resolvedName) {
			const head = `${prefix}:MediaListCollection:${type.toUpperCase()}:`;
			if (!key.startsWith(head)) return false;
			const rest = key.slice(head.length);
			const sep = rest.indexOf(":");
			if (sep <= 0) return false;
			const who = rest.slice(0, sep);
			if (rest.slice(sep + 1) !== "{}") return false;
			if (resolvedId && who === String(resolvedId)) return true;
			if (resolvedName && who.toLowerCase() === resolvedName.toLowerCase()) return true;
			return false;
		}
		function lookupUserId(userMap, name) {
			if (!userMap || !name) return void 0;
			return safeBridge(() => {
				const direct = userMap.get(name);
				if (direct) return direct;
				const lower = name.toLowerCase();
				for (const [k, v] of userMap.entries()) if (typeof k === "string" && k.toLowerCase() === lower) return v;
			});
		}
		function lookupUserName(idMap, id) {
			if (!idMap || !id) return void 0;
			return safeBridge(() => {
				const val = idMap.get(id);
				return typeof val === "string" ? val.trim().toLowerCase() || void 0 : void 0;
			});
		}
		function resolveMediaListTarget(target, options) {
			const optUserName = typeof options?.userName === "string" && options.userName.trim() ? options.userName.trim() : void 0;
			const optUserId = parsePositiveId(options?.userId);
			const hasExplicitOptId = optUserId !== null;
			const hasExplicitOptName = optUserName !== void 0;
			let inferredId;
			let inferredName;
			if (!hasExplicitOptId && !hasExplicitOptName) {
				if (typeof target === "number") inferredId = parsePositiveId(target) ?? void 0;
				else if (typeof target === "string") {
					const trimmed = target.trim();
					if (/^\d+$/.test(trimmed)) inferredId = parsePositiveId(Number(trimmed)) ?? void 0;
					else if (trimmed) inferredName = trimmed;
				}
			}
			return {
				userId: optUserId ?? inferredId,
				userName: optUserName ?? inferredName
			};
		}
		function tryGetCachedMediaList(type, userId, userName) {
			const win = pageWin();
			const t = type.toUpperCase();
			const id = userId;
			const name = userName ? userName.toLowerCase() : void 0;
			const bridge = safeBridge(() => CoreHooks.getCacheBridge()) ?? null;
			const userMap = safeBridge(() => bridge ? bridge.getUserMap() : win.__ALFL_USER_MAP__);
			const idMap = safeBridge(() => bridge ? bridge.getIdMap() : win.__ALFL_ID_MAP__);
			const resolvedId = id || lookupUserId(userMap, name);
			const resolvedName = name || lookupUserName(idMap, resolvedId);
			const entityKeys = [];
			if (resolvedId) entityKeys.push(`MediaListCollection:${t}:${resolvedId}`);
			if (resolvedName) entityKeys.push(`MediaListCollection:${t}:${resolvedName}`);
			for (const k of entityKeys) {
				const cached = entityCache.get(k);
				if (cached && Date.now() - cached.time < ENTITY_TTL && cached.data?.MediaListCollection && cached.data.MediaListCollection.hasNextChunk !== true && cached.fields && isSubsetOf(MEDIA_LIST_REQUIRED_FIELDS, cached.fields)) {
					anilistLog.debug("🎯 Cache HIT for MediaListCollection via entityCache:", k);
					return formatMediaListResult(cached.data.MediaListCollection);
				}
			}
			const gqlStore = safeBridge(() => bridge ? bridge.getGqlStore() : win.__ALFL_GQL_STORE__);
			if (gqlStore) {
				const tryDecodeGqlEntry = (k, cached, viaScan) => {
					if (!cached || Date.now() - cached.time >= 3e5 || !cached.snap?.buf) return null;
					try {
						const raw = new TextDecoder().decode(cached.snap.buf);
						const json = JSON.parse(raw);
						const mlc = json?.data?.MediaListCollection || json?.MediaListCollection;
						if (isValidFastLoadMediaList(mlc)) {
							anilistLog.debug(viaScan ? "🎯 Cache HIT for MediaListCollection via FastLoad GQL store (scan):" : "🎯 Cache HIT for MediaListCollection via FastLoad GQL store:", k);
							return formatMediaListResult(mlc);
						}
					} catch (_) {}
					return null;
				};
				const gqlKeys = [];
				if (resolvedId) gqlKeys.push(`gql:MediaListCollection:${t}:${resolvedId}:{}`);
				if (resolvedName) gqlKeys.push(`gql:MediaListCollection:${t}:${resolvedName}:{}`);
				for (const k of gqlKeys) {
					const result = tryDecodeGqlEntry(k, safeBridge(() => gqlStore.get(k)), false);
					if (result) return result;
				}
				const gqlScanHit = safeBridge(() => {
					for (const [k, cached] of gqlStore.entries()) {
						if (!matchMediaListKey(k, "gql", t, resolvedId, resolvedName)) continue;
						const result = tryDecodeGqlEntry(k, cached, true);
						if (result) return result;
					}
					return null;
				});
				if (gqlScanHit) return gqlScanHit;
			}
			const rpcCache = safeBridge(() => bridge ? bridge.getRpcCache() : win.__ALFL_RPC_CACHE__);
			if (rpcCache) {
				const tryParseRpcEntry = (k, cached, viaScan) => {
					if (!cached || Date.now() - cached.time >= 3e5 || !cached.msg) return null;
					try {
						const result = parseRpcMediaList(cached.msg.result ?? cached.msg);
						if (result && result.allEntries.length > 0) {
							anilistLog.debug(viaScan ? "🎯 Cache HIT for MediaListCollection via FastLoad RPC cache (scan):" : "🎯 Cache HIT for MediaListCollection via FastLoad RPC cache:", k);
							return result;
						}
					} catch (_) {}
					return null;
				};
				const rpcKeys = [];
				if (resolvedId) rpcKeys.push(`rpc:MediaListCollection:${t}:${resolvedId}:{}`);
				if (resolvedName) rpcKeys.push(`rpc:MediaListCollection:${t}:${resolvedName}:{}`);
				for (const k of rpcKeys) {
					const result = tryParseRpcEntry(k, safeBridge(() => rpcCache.get(k)), false);
					if (result) return result;
				}
				const rpcScanHit = safeBridge(() => {
					for (const [k, cached] of rpcCache.entries()) {
						if (!matchMediaListKey(k, "rpc", t, resolvedId, resolvedName)) continue;
						const result = tryParseRpcEntry(k, cached, true);
						if (result) return result;
					}
					return null;
				});
				if (rpcScanHit) return rpcScanHit;
			}
			return null;
		}
		async function getMediaList(target, type = "ANIME", options) {
			throwIfAborted(options?.signal);
			const { userId, userName } = resolveMediaListTarget(target, options);
			if (!userId && !userName) throw new Error("Invalid AniList user target for getMediaList");
			if (!options?.forceFresh) {
				const cached = tryGetCachedMediaList(type, userId, userName);
				if (cached) return cached;
			}
			const win = pageWin();
			const bridge = safeBridge(() => CoreHooks.getCacheBridge()) ?? null;
			const rpcInflight = safeBridge(() => bridge ? bridge.getRpcInflight() : win.__ALFL_RPC_INFLIGHT__);
			if (rpcInflight && !options?.forceFresh) {
				const t = type.toUpperCase();
				const userMap = safeBridge(() => bridge ? bridge.getUserMap() : win.__ALFL_USER_MAP__);
				const idMap = safeBridge(() => bridge ? bridge.getIdMap() : win.__ALFL_ID_MAP__);
				const normName = userName ? userName.toLowerCase() : void 0;
				const resolvedId = userId || lookupUserId(userMap, normName);
				const resolvedName = normName || lookupUserName(idMap, resolvedId);
				const rpcKeys = [];
				if (resolvedId) rpcKeys.push(`rpc:MediaListCollection:${t}:${resolvedId}:{}`);
				if (resolvedName) rpcKeys.push(`rpc:MediaListCollection:${t}:${resolvedName}:{}`);
				const checkInflight = async (k, flight) => {
					if (!flight?.promise) return null;
					throwIfAborted(options?.signal);
					let timer;
					try {
						anilistLog.debug("⏳ Awaiting in-flight FastLoad RPC prefetch:", k);
						const msg = await raceWithSignal(Promise.race([flight.promise, new Promise((_, reject) => {
							timer = setTimeout(() => reject(new Error("timeout")), 5e3);
						})]), options?.signal);
						throwIfAborted(options?.signal);
						const parsed = parseRpcMediaList(msg?.result ?? msg);
						if (parsed && parsed.allEntries.length > 0) {
							anilistLog.debug("🎯 Cache HIT from completed in-flight FastLoad RPC prefetch:", k);
							return parsed;
						}
					} catch (err) {
						if (options?.signal?.aborted) throw err;
					} finally {
						if (timer !== void 0) clearTimeout(timer);
					}
					return null;
				};
				const seenFlights = new Set();
				for (const k of rpcKeys) {
					const flight = safeBridge(() => rpcInflight.get(k));
					if (flight && !seenFlights.has(flight)) {
						seenFlights.add(flight);
						const res = await checkInflight(k, flight);
						if (res) return res;
					}
				}
				const matchingFlights = safeBridge(() => {
					const list = [];
					for (const [k, flight] of rpcInflight.entries()) if (matchMediaListKey(k, "rpc", t, resolvedId, resolvedName)) list.push([k, flight]);
					return list;
				}) || [];
				for (const [k, flight] of matchingFlights) {
					if (seenFlights.has(flight)) continue;
					seenFlights.add(flight);
					const res = await checkInflight(k, flight);
					if (res) return res;
				}
			}
			const mlc = (await query(MEDIA_LIST_SINGLE_QUERY, {
				userId: userId || void 0,
				userName: userId ? void 0 : userName || void 0,
				type
			}, {
				forceFresh: options?.forceFresh,
				signal: options?.signal
			}))?.MediaListCollection;
			if (!mlc || !Array.isArray(mlc.lists)) throw new Error("Unexpected MediaListCollection response shape");
			return formatMediaListResult(mlc);
		}
		async function viewer(forceFresh = false, opts) {
			throwIfAborted(opts?.signal);
			const doc = pageWin().document || document;
			syncFromPage();
			if (isLoggedOutNav(doc)) return null;
			if (!forceFresh) {
				const name = store$1.get("al_username", null);
				const fmt = store$1.get("al_score_format", null);
				const id = parsePositiveId(store$1.get("al_user_id", null));
				if (name && fmt && id) return {
					id,
					name,
					scoreFormat: fmt
				};
			}
			if (!hasAuth()) return null;
			const myEpoch = viewerEpoch;
			const VIEWER_QUERY = "query { Viewer { id name mediaListOptions { scoreFormat } } }";
			const fetchViewer = (fresh) => query(VIEWER_QUERY, {}, {
				forceFresh: fresh,
				signal: opts?.signal
			}).catch((e) => {
				if (e?.auth || isAbortError(e) || opts?.signal?.aborted) throw e;
				return null;
			});
			const checkPostAwaitViewer = (res) => {
				syncFromPage();
				const mismatched = isViewerMismatchedWithPage(res?.Viewer);
				if (viewerEpoch !== myEpoch || mismatched) {
					if (viewerEpoch === myEpoch && mismatched) clearViewer();
					return true;
				}
				return false;
			};
			let d = await fetchViewer(forceFresh);
			throwIfAborted(opts?.signal);
			if (checkPostAwaitViewer(d)) return null;
			if (d?.Viewer && !d.Viewer.mediaListOptions?.scoreFormat && !forceFresh) {
				invalidateLocal("Viewer");
				d = await fetchViewer(true);
				throwIfAborted(opts?.signal);
				if (checkPostAwaitViewer(d)) return null;
			}
			if (d?.Viewer) {
				const scoreFormat = d.Viewer.mediaListOptions?.scoreFormat;
				if (d.Viewer.id) store$1.set("al_user_id", d.Viewer.id);
				if (d.Viewer.name) store$1.set("al_username", d.Viewer.name);
				if (scoreFormat) store$1.set("al_score_format", scoreFormat);
				return {
					id: d.Viewer.id,
					name: d.Viewer.name,
					scoreFormat: scoreFormat || ""
				};
			}
			return null;
		}
		const invalidate = (entityKeyPrefix) => {
			invalidateLocal(entityKeyPrefix);
			safeBridge(() => {
				const bridge = CoreHooks.getCacheBridge();
				if (bridge) bridge.clear();
				else pageWin().__ALFL_CLEAR__?.();
			});
		};
		const invalidateMediaList = (target, type) => {
			const who = target ? String(target).trim().toLowerCase() : "";
			if (!who) return invalidate("MediaListCollection");
			const t = type ? type.toUpperCase() : "";
			if (t) {
				invalidate(`MediaListCollection:${t}:${who}`);
				return;
			}
			invalidate(`MediaListCollection:ANIME:${who}`);
			invalidate(`MediaListCollection:MANGA:${who}`);
		};
		const hasAuth = (opts) => isBrowserLoggedIn(opts);
		const resumeAt = () => limiter.resumeAt;
		return {
			query,
			getMediaList,
			viewer,
			clearViewer,
			invalidate,
			invalidateMediaList,
			hasAuth,
			resumeAt,
			session: {
				peek,
				get userId() {
					return peek().userId;
				},
				get username() {
					return peek().username;
				},
				get scoreFormat() {
					return peek().scoreFormat;
				},
				hasAuth,
				clear: clearViewer,
				syncFromPage,
				recordHint
			}
		};
	})();
	var MediaData = (() => {
		async function get(id, type, opts) {
			try {
				return (await AniList.query(`query($id:Int,$type:MediaType){ Media(id:$id,type:$type){
          id idMal format title { userPreferred english romaji native }
          episodes chapters status season seasonYear nextAiringEpisode { episode }
          mediaListEntry { score progress status completedAt { year month day } }
        } }`, {
					id: Number(id),
					type
				}, { signal: opts?.signal }))?.Media || null;
			} catch (e) {
				if (opts?.throwAuth && e?.auth) throw e;
				anilistLog.debug("MediaData fetch failed:", e?.message || e);
				return null;
			}
		}
		async function save(id, _type, c, opts) {
			const entry = (await AniList.query(`mutation($mediaId:Int!,$score:Float,$progress:Int,$status:MediaListStatus,$completedAt:FuzzyDateInput){
        SaveMediaListEntry(mediaId:$mediaId,score:$score,progress:$progress,status:$status,completedAt:$completedAt){
          score progress status completedAt { year month day }
        } }`, {
				mediaId: Number(id),
				score: c.score,
				progress: c.progress,
				status: c.status,
				completedAt: c.completedAt
			}, { signal: opts?.signal }))?.SaveMediaListEntry || null;
			AniList.invalidate(`Media:${id}`);
			AniList.invalidateMediaList();
			return entry;
		}
		return {
			get,
			save
		};
	})();
	var anilistApiClient = {
		...AniList,
		media: MediaData
	};
	var malLog$1 = createCoreLogger("mal");
	var OVERRIDES_SETTING_KEY = "syncManualOverrides";
	var MANUAL_OVERRIDES_ENABLED_KEY = "manualOverridesEnabled";
	function isManualOverridesEnabled() {
		return parseToggle(store$1.get(SETTING_PREFIX + MANUAL_OVERRIDES_ENABLED_KEY, false));
	}
	function normalizeOverrideEntry(key, val, defaultUpdatedAt) {
		const id = Number(key);
		if (!key || String(id) !== key || !Number.isSafeInteger(id) || id <= 0) return { error: `Invalid AniList media ID key "${key}". Keys must be positive integers.` };
		if (!val || typeof val !== "object" || Array.isArray(val)) return { error: `Invalid entry for media ID ${id}: expected an object.` };
		const o = val;
		if (typeof o.malId !== "number" || !Number.isSafeInteger(o.malId) || o.malId < 0) return { error: `Invalid malId for media ID ${id}: must be a non-negative integer (0 for AniList-only).` };
		let typeStr;
		if (o.type === void 0 || o.type === null || o.type === "") typeStr = "ANIME";
		else if (typeof o.type === "string") typeStr = o.type.trim().toUpperCase();
		else return { error: `Invalid type for media ID ${id}: must be "ANIME" or "MANGA".` };
		if (typeStr !== "ANIME" && typeStr !== "MANGA") return { error: `Invalid type for media ID ${id}: must be "ANIME" or "MANGA".` };
		const entry = {
			malId: o.malId === 0 ? 0 : o.malId,
			type: typeStr,
			title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : `Media #${id}`,
			updatedAt: typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) && o.updatedAt >= 0 ? o.updatedAt : defaultUpdatedAt
		};
		if (typeof o.cover === "string") {
			const cover = o.cover.trim();
			if (/^https?:\/\//i.test(cover)) entry.cover = cover;
		}
		return {
			id,
			entry
		};
	}
	function getManualOverrides() {
		let raw = store$1.get(SETTING_PREFIX + OVERRIDES_SETTING_KEY, {});
		if (typeof raw === "string") try {
			raw = JSON.parse(raw);
		} catch (_) {
			raw = {};
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const result = {};
		for (const [key, val] of Object.entries(raw)) {
			const normalized = normalizeOverrideEntry(key, val, 0);
			if ("entry" in normalized) result[String(normalized.id)] = normalized.entry;
		}
		return result;
	}
	function saveManualOverrides(overrides) {
		store$1.set(SETTING_PREFIX + OVERRIDES_SETTING_KEY, overrides);
	}
	function getOverride(mediaId) {
		if (!Number.isSafeInteger(mediaId) || mediaId <= 0 || !isManualOverridesEnabled()) return void 0;
		const all = getManualOverrides();
		return Object.prototype.hasOwnProperty.call(all, String(mediaId)) ? all[String(mediaId)] : void 0;
	}
	function setOverride(mediaId, data) {
		if (!Number.isSafeInteger(mediaId) || mediaId <= 0) return;
		if (!data || typeof data !== "object" || Array.isArray(data)) return;
		const now = Date.now();
		const normalized = normalizeOverrideEntry(String(mediaId), {
			...data,
			updatedAt: typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt) && data.updatedAt > 0 ? data.updatedAt : now
		}, now);
		if (!("entry" in normalized)) return;
		const all = { ...getManualOverrides() };
		all[String(normalized.id)] = normalized.entry;
		saveManualOverrides(all);
	}
	function removeOverride(mediaId) {
		if (!Number.isSafeInteger(mediaId) || mediaId <= 0) return;
		const all = { ...getManualOverrides() };
		delete all[String(mediaId)];
		saveManualOverrides(all);
	}
	function isIgnored(mediaId) {
		const o = getOverride(mediaId);
		return !!o && o.malId === 0;
	}
	function getEffectiveMalId(mediaId, defaultMalId) {
		const o = getOverride(mediaId);
		if (o) return o.malId > 0 ? o.malId : null;
		return defaultMalId && defaultMalId > 0 ? defaultMalId : null;
	}
	function validateOverrides(raw) {
		let data = raw;
		if (typeof data === "string") {
			const trimmed = data.trim();
			if (!trimmed) return {
				valid: true,
				overrides: {}
			};
			try {
				data = JSON.parse(trimmed);
			} catch (e) {
				return {
					valid: false,
					error: `Invalid JSON syntax: ${e.message}`
				};
			}
		}
		if (!data || typeof data !== "object" || Array.isArray(data)) return {
			valid: false,
			error: "Overrides must be a JSON object mapping AniList media IDs to override records."
		};
		const now = Date.now();
		const result = {};
		for (const [key, val] of Object.entries(data)) {
			const normalized = normalizeOverrideEntry(key, val, now);
			if ("error" in normalized) return {
				valid: false,
				error: normalized.error
			};
			result[String(normalized.id)] = normalized.entry;
		}
		return {
			valid: true,
			overrides: result
		};
	}
	function importOverrides(raw, mode = "replace") {
		const check = validateOverrides(raw);
		if (!check.valid || !check.overrides) return {
			success: false,
			error: check.error || "Validation failed"
		};
		saveManualOverrides(mode === "merge" ? {
			...getManualOverrides(),
			...check.overrides
		} : check.overrides);
		return {
			success: true,
			count: Object.keys(check.overrides).length
		};
	}
	var STALE_MS = 864e5;
	var refreshing = false;
	async function refreshStaleOverrides(opts) {
		const signal = opts?.signal;
		if (refreshing || signal?.aborted) return;
		const initial = getManualOverrides();
		const keys = Object.keys(initial);
		if (!keys.length) return;
		const staleIds = keys.map(Number).filter((id) => id > 0 && (!initial[String(id)]?.updatedAt || Date.now() - initial[String(id)].updatedAt > STALE_MS)).sort((a, b) => (initial[String(a)]?.updatedAt || 0) - (initial[String(b)]?.updatedAt || 0));
		if (!staleIds.length) return;
		refreshing = true;
		try {
			for (let i = 0; i < staleIds.length; i += 50) {
				if (signal?.aborted) break;
				const batch = staleIds.slice(i, i + 50);
				const q = `query ($ids: [Int]) {
        Page(page: 1, perPage: 50) {
          media(id_in: $ids) {
            id
            type
            title { userPreferred english romaji }
            coverImage { medium }
          }
        }
      }`;
				try {
					const res = await AniList.query(q, { ids: batch }, { signal });
					if (signal?.aborted) break;
					const list = Array.isArray(res?.Page?.media) ? res.Page.media : [];
					const current = getManualOverrides();
					let changed = false;
					for (const m of list) {
						if (!m || m.id == null) continue;
						const idStr = String(m.id);
						if (Object.prototype.hasOwnProperty.call(current, idStr)) {
							const existing = current[idStr];
							const t = m.title?.userPreferred || m.title?.english || m.title?.romaji || existing.title;
							const cover = m.coverImage?.medium || existing.cover;
							const type = m.type === "MANGA" || m.type === "ANIME" ? m.type : existing.type;
							const nextEntry = {
								...existing,
								title: t,
								type,
								updatedAt: Date.now()
							};
							if (cover) nextEntry.cover = cover;
							else delete nextEntry.cover;
							current[idStr] = nextEntry;
							changed = true;
						}
					}
					if (changed && !signal?.aborted) saveManualOverrides(current);
				} catch (e) {
					if (signal?.aborted || isAbortError(e)) break;
					malLog$1.warn("Failed to refresh stale overrides batch:", e);
					break;
				}
			}
		} finally {
			refreshing = false;
		}
	}
	function buildNyaaUrl(title, providers = []) {
		return `https://nyaa.si/?f=0&c=1_2&s=seeders&o=desc&q=${title.normalize("NFC").trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(encodeURIComponent).join("+")}#:~:text=${providers.map(encodeURIComponent).join("&text=")}`;
	}
	defineModule({
		id: "nyaa",
		key: "nyaaEnabled",
		section: "External Links, Downloads & Mappings",
		layer: "feature",
		requiresReload: false,
		legacy: [
			"nyaaEnabled",
			"malNyaaLinksEnabled",
			"malNyaaEnabled"
		],
		title: "MyAnimeList & Nyaa Links",
		help: "Show a MyAnimeList link, with Nyaa search available by Ctrl/Cmd-click on desktop or long-press on mobile.",
		options: [{
			key: "nyaaProviders",
			type: "list",
			def: ["SubsPlease", "ToonsHub"],
			legacy: ["nyaaProviders", "nyaaSearchGroups"],
			title: "Nyaa Search Providers",
			help: "Comma-separated provider names to include in Nyaa searches. Defaults to SubsPlease and ToonsHub."
		}],
		setup(ctx) {
			const ICON = icon("external", 17);
			const LINK_ID = ctx.getId("find-on-nyaa");
			const EDIT_ID = ctx.getId("edit-mal-id");
			const H1_SEL = ".page-content .header .content > h1";
			const nyaaUrl = (title) => buildNyaaUrl(title, ctx.get("nyaaProviders") || []);
			let activeLink = null;
			let activeRoute = null;
			ctx.events.on("manualOverrides:changed", (changedId) => {
				const linkEl = activeLink?.el();
				if (!linkEl || !activeRoute) return;
				if (changedId && Number(changedId) !== activeRoute.id) return;
				linkEl.title = isIgnored(activeRoute.id) ? "Marked as AniList-Only (searches Nyaa)" : "Open on MAL (Ctrl/Cmd+click or long-press: search Nyaa)";
			});
			ctx.onRoute(/^\/(anime|manga)\/(\d+)(?:\/|$)/, (rc) => {
				const kind = rc.match[1];
				const route = {
					kind,
					type: kind.toUpperCase(),
					id: Number(rc.match[2])
				};
				activeRoute = route;
				const pendingPopups = new Set();
				rc.api.media.get(route.id, route.type).catch(() => null);
				let cancelTouchTimer = null;
				let cancelResetTimer = null;
				const clearTouchTimers = () => {
					cancelTouchTimer?.();
					cancelTouchTimer = null;
					cancelResetTimer?.();
					cancelResetTimer = null;
				};
				const link = rc.mount({
					id: LINK_ID,
					anchor: H1_SEL,
					position: "beforeend",
					ownUi: true,
					style: (sel) => `${sel},#${EDIT_ID}{display:inline-flex;align-items:center;vertical-align:middle;color:rgb(var(--color-text-lighter));opacity:.75;transition:opacity .15s,transform .15s,color .15s}${sel}{margin-left:10px}#${EDIT_ID}{margin-left:6px;cursor:pointer}${sel}:hover,#${EDIT_ID}:hover{opacity:1;color:rgb(var(--color-blue));transform:scale(1.1)}`,
					create: () => {
						clearTouchTimers();
						const a = document.createElement("a");
						a.href = "#";
						a.title = isIgnored(route.id) ? "Marked as AniList-Only (searches Nyaa)" : "Open on MAL (Ctrl/Cmd+click or long-press: search Nyaa)";
						a.setAttribute("aria-label", "Open on MAL; long-press to search Nyaa");
						a.innerHTML = ICON;
						const titleText = () => {
							const h1 = a.parentElement;
							if (!h1) return "";
							return [...h1.childNodes].filter((n) => n !== a && n?.id !== EDIT_ID).map((n) => n.textContent).join("").trim();
						};
						const searchNyaa = () => openTab(nyaaUrl(titleText()));
						let longPressed = false;
						let sx = 0;
						let sy = 0;
						const cancel = () => {
							cancelTouchTimer?.();
							cancelTouchTimer = null;
						};
						a.addEventListener("touchstart", (e) => {
							if (e.touches.length !== 1) return;
							sx = e.touches[0].clientX;
							sy = e.touches[0].clientY;
							longPressed = false;
							cancel();
							cancelTouchTimer = rc.timeout(() => {
								cancelTouchTimer = null;
								longPressed = true;
								searchNyaa();
								cancelResetTimer?.();
								cancelResetTimer = rc.timeout(() => {
									longPressed = false;
									cancelResetTimer = null;
								}, 800);
							}, 550);
						}, { passive: true });
						a.addEventListener("touchmove", (e) => {
							if (!cancelTouchTimer || !e.touches.length) return;
							if (Math.abs(e.touches[0].clientX - sx) > 12 || Math.abs(e.touches[0].clientY - sy) > 12) cancel();
						}, { passive: true });
						a.addEventListener("touchend", cancel, { passive: true });
						a.addEventListener("touchcancel", cancel, { passive: true });
						a.addEventListener("contextmenu", (e) => {
							if (longPressed) e.preventDefault();
						});
						a.addEventListener("click", (e) => {
							e.preventDefault();
							if (longPressed) {
								longPressed = false;
								e.stopPropagation();
								return;
							}
							if (rc.signal.aborted) return;
							const title = titleText();
							const nyaa = nyaaUrl(title);
							if (e.ctrlKey || e.metaKey || isIgnored(route.id)) {
								openTab(nyaa);
								return;
							}
							const w = window.open("about:blank", "_blank");
							if (w) {
								w.opener = null;
								pendingPopups.add(w);
							}
							(async () => {
								let media = null;
								try {
									media = await rc.api.media.get(route.id, route.type);
								} catch {
									media = null;
								}
								if (rc.signal.aborted) {
									if (w && pendingPopups.delete(w) && !w.closed) w.close?.();
									return;
								}
								if (w?.closed) {
									pendingPopups.delete(w);
									return;
								}
								const effectiveMalId = getEffectiveMalId(route.id, media?.idMal);
								const target = effectiveMalId ? `https://myanimelist.net/${route.kind}/${effectiveMalId}` : `https://myanimelist.net/search/all?q=${encodeURIComponent(title)}&cat=all`;
								if (w) {
									pendingPopups.delete(w);
									w.location.href = target;
								} else openTab(target);
							})();
						});
						return a;
					}
				});
				activeLink = link;
				let currentQuickEdit = null;
				const editMount = rc.mount({
					id: EDIT_ID,
					anchor: () => link.el()?.parentElement || document.querySelector(H1_SEL),
					position: "beforeend",
					ownUi: true,
					match: () => currentQuickEdit !== null,
					create: () => {
						const editBtn = document.createElement("a");
						editBtn.href = "#";
						editBtn.title = "Set or edit MyAnimeList mapping";
						editBtn.setAttribute("aria-label", "Set or edit MyAnimeList mapping");
						editBtn.innerHTML = icon("edit", 16);
						editBtn.addEventListener("click", (e) => {
							e.preventDefault();
							e.stopPropagation();
							currentQuickEdit?.(route.id, route.type);
						});
						return editBtn;
					}
				});
				const stopQuickEditWatch = ctx.services.onAvailable("manualOverrides:quickEdit", (quickEditFn) => {
					if (rc.signal.aborted) return;
					currentQuickEdit = quickEditFn;
					editMount.refresh();
					return () => {
						if (currentQuickEdit === quickEditFn) {
							currentQuickEdit = null;
							editMount.refresh();
						}
					};
				});
				rc.onCleanup(() => {
					for (const w of pendingPopups) if (!w.closed) w.close?.();
					pendingPopups.clear();
					clearTouchTimers();
					stopQuickEditWatch();
					currentQuickEdit = null;
					if (activeLink === link) activeLink = null;
					if (activeRoute === route) activeRoute = null;
				});
			});
			ctx.onCleanup(() => {
				activeLink = null;
				activeRoute = null;
			});
		}
	});
	defineModule({
		id: "removeTitle",
		key: "linkShortenerEnabled",
		section: "AniList Enhancements",
		layer: "preload",
		requiresReload: true,
		legacy: [
			"linkShortenerEnabled",
			"shortAniListUrlsEnabled",
			"shortAniListUrls"
		],
		title: "Short AniList URLs",
		help: "Remove the title slug from AniList anime, manga, staff, and character URLs.",
		setup(ctx) {
			const SLUG_HREF = /^(?:https:\/\/anilist\.co)?\/(?:manga|anime|staff|character)\/\d{1,10}\/./;
			const strip = (s) => s.replace(/^((?:https:\/\/anilist\.co)?\/(?:manga|anime|staff|character)\/\d{1,10}\/)[^/?#]+\/?(?=[?#]|$)/, "$1");
			function fixLocation() {
				if (!/anilist\.co\/(manga|anime|staff|character)\//.test(location.href) || !/\/\d{1,10}\/./.test(location.href)) return;
				const cur = location.pathname + location.search + location.hash;
				const next = strip(cur.replace(/^https:\/\/anilist\.co/, ""));
				if (cur !== next) ctx.silently(() => history.replaceState(history.state, "", next));
			}
			function fixLinks(nodes) {
				for (const node of Array.from(nodes)) {
					if (node.nodeType !== 1) continue;
					const el = node;
					const links = el.matches("a[href]") ? [el] : el.querySelectorAll("a[href]");
					for (const a of links) {
						const href = a.getAttribute("href");
						if (href && SLUG_HREF.test(href)) {
							const next = strip(href);
							if (next !== href) a.setAttribute("href", next);
						}
					}
				}
			}
			fixLocation();
			ctx.onNav(fixLocation);
			ctx.onBodyMutation((muts) => {
				for (const m of muts) if (m.addedNodes.length) fixLinks(m.addedNodes);
			});
			ctx.ready(() => fixLinks([document.body]));
		}
	});
	var strictTitle = (s) => String(s || "").toLowerCase().normalize("NFKC").replace(/[’‘'`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
	var malLog = createCoreLogger("mal");
	var MAL_AUTH_URL = "https://myanimelist.net/v1/oauth2/authorize";
	var MAL_TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";
	var MAL_API = "https://api.myanimelist.net/v2";
	var MAL_REDIRECT = "https://myanimelist.net/";
	var MAL_CLIENT_ID = "f8197fe8cb24188073de4c0227307edf";
	var MAL_SECRET_KEYS = [
		"mal_code_verifier",
		"mal_token",
		"mal_refresh_token",
		"mal_expires_at"
	];
	var hooks = {};
	var logLines = [];
	var lastNotice = "";
	var uiSink = null;
	function setMalUiSink(sink) {
		uiSink = sink;
		return () => {
			if (uiSink === sink) uiSink = null;
		};
	}
	function log(msg, level = "info") {
		const line = `${new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit"
		})}  ${level === "error" ? "ERROR" : level === "warn" ? "WARN " : level === "success" ? "OK   " : "INFO "} ${String(msg)}`;
		logLines.unshift(line);
		logLines = logLines.slice(0, 60);
		if (level === "error") malLog.error(msg);
		else if (level === "warn") malLog.warn(msg);
		else malLog.debug(msg);
		lastNotice = String(msg);
		try {
			uiSink?.onLog?.({
				line,
				message: lastNotice,
				level
			});
		} catch (e) {
			malLog.error("uiSink.onLog failed:", e);
		}
	}
	function toast(msg, isError, closeTab) {
		log(msg, isError ? "error" : "info");
		try {
			if (uiSink?.onToast) {
				uiSink.onToast(msg, isError, closeTab);
				return;
			}
		} catch (e) {
			malLog.error("uiSink.onToast failed:", e);
		}
		showToast(msg, {
			type: isError ? "error" : "success",
			closeTab
		});
	}
	var clearMalAuth = () => {
		[
			"mal_token",
			"mal_refresh_token",
			"mal_expires_at"
		].forEach((k) => store$1.del(k));
	};
	async function malTokenRequest(params) {
		const body = new URLSearchParams({
			client_id: MAL_CLIENT_ID,
			...params
		});
		const res = await gm.request(MAL_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			data: body.toString()
		});
		let json = {};
		try {
			json = JSON.parse(res.responseText);
		} catch (_) {}
		if (typeof json.access_token !== "string" || !json.access_token) {
			if (params.grant_type === "refresh_token" && [
				400,
				401,
				403
			].includes(res.status)) {
				clearMalAuth();
				throw authError("MAL", "MAL session expired — reconnect MAL.");
			}
			throw new Error(json.hint || json.message || json.error || res.responseText || `HTTP ${res.status}`);
		}
		store$1.set("mal_token", json.access_token);
		if (typeof json.refresh_token === "string" && json.refresh_token) store$1.set("mal_refresh_token", json.refresh_token);
		const expiresIn = Number(json.expires_in);
		store$1.set("mal_expires_at", Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1e3);
		return json.access_token;
	}
	async function exchangeMalCode(code) {
		const token = await malTokenRequest({
			code,
			code_verifier: store$1.get("mal_code_verifier", ""),
			grant_type: "authorization_code",
			redirect_uri: MAL_REDIRECT
		});
		store$1.del("mal_code_verifier");
		return token;
	}
	var malRefresh = null;
	function isStoredTokenValid(token, expiresAt, failedToken) {
		return typeof token === "string" && token.length > 0 && typeof expiresAt === "number" && Number.isFinite(expiresAt) && token !== failedToken && Date.now() < expiresAt - 6e4;
	}
	async function malEnsureToken(failedToken) {
		if (malRefresh) return malRefresh;
		const current = store$1.get("mal_token", null);
		if (isStoredTokenValid(current, store$1.get("mal_expires_at", 0), failedToken)) return current;
		malRefresh = (async () => {
			const latest = store$1.get("mal_token", null);
			if (isStoredTokenValid(latest, store$1.get("mal_expires_at", 0), failedToken)) return latest;
			const refresh = store$1.get("mal_refresh_token", null);
			if (typeof refresh !== "string" || !refresh) throw authError("MAL", "No MAL refresh token stored — reconnect MAL.");
			return malTokenRequest({
				grant_type: "refresh_token",
				refresh_token: refresh
			});
		})().finally(() => {
			malRefresh = null;
		});
		return malRefresh;
	}
	function malConnect() {
		const verifier = randomString(96);
		store$1.set("mal_code_verifier", verifier);
		openTab(`${MAL_AUTH_URL}?response_type=code&client_id=${encodeURIComponent(MAL_CLIENT_ID)}&code_challenge=${encodeURIComponent(verifier)}&code_challenge_method=plain&redirect_uri=${encodeURIComponent(MAL_REDIRECT)}`);
		log("Opened MAL authorization in a new tab. Finish connecting there, then return to your list.");
	}
	function captureCredentials() {
		if (location.hostname === "myanimelist.net") {
			const code = new URLSearchParams(location.search).get("code");
			if (!code || !store$1.get("mal_code_verifier")) return;
			exchangeMalCode(code).then(() => {
				const url = new URL(location.href);
				url.searchParams.delete("code");
				url.searchParams.delete("state");
				history.replaceState(null, "", url.pathname + url.search);
				toast("MAL connected! You can close this tab.", false, true);
			}).catch((e) => toast("MAL connection failed: " + e.message, true));
		}
	}
	var isMalConnected = () => !!store$1.get("mal_token", null);
	registerAccountProvider({
		id: "mal",
		name: "MyAnimeList",
		secretKeys: MAL_SECRET_KEYS,
		isConnected: () => isMalConnected(),
		connect: () => malConnect(),
		disconnect: () => clearMalAuth(),
		onAuthCallback: () => captureCredentials()
	});
	var malLimiter = new RateLimiter({
		rate: 60,
		min: 12,
		max: 180,
		burst: 4,
		adaptive: true,
		jitter: true,
		persistKey: "ala_mal_api_resume_at"
	});
	var BREAKER_THRESHOLD = 8;
	var BREAKER_COOLDOWN_MS = 9e4;
	function createMalAbortError(signal) {
		const reason = signal?.reason;
		const base = reason instanceof Error ? reason : createAbortError(signal);
		const tagged = base;
		if (!tagged.cancelled) try {
			tagged.cancelled = true;
		} catch {
			return Object.assign(new Error(base.message), {
				name: base.name,
				cancelled: true
			});
		}
		return tagged;
	}
	function rethrowMalAbort(err, signal) {
		if (signal?.aborted) throw createMalAbortError(signal);
		if (isAbortError(err)) {
			const tagged = err;
			if (!tagged.cancelled) try {
				tagged.cancelled = true;
			} catch {
				throw Object.assign(new Error(tagged.message), {
					name: tagged.name,
					cancelled: true
				});
			}
			throw tagged;
		}
		throw err;
	}
	function sleepMal(ms, signal) {
		return sleep(ms, signal).catch((err) => rethrowMalAbort(err, signal));
	}
	function normalizeMalCallOptions(cancelOrOpts) {
		const opts = typeof cancelOrOpts === "function" ? { checkCancel: cancelOrOpts } : cancelOrOpts;
		const hasExplicit = Boolean(opts?.checkCancel || opts?.signal);
		const checkFn = opts?.checkCancel ?? (hasExplicit ? void 0 : () => hooks.checkCancel?.());
		const signal = opts?.signal;
		const check = () => {
			checkFn?.();
			if (signal?.aborted) throw createMalAbortError(signal);
		};
		return {
			checkFn,
			signal,
			check
		};
	}
	var breaker = (() => {
		let fails = 0;
		let until = 0;
		let trips = 0;
		return {
			ok() {
				fails = 0;
			},
			fail() {
				if (++fails >= BREAKER_THRESHOLD && Date.now() >= until) {
					fails = 0;
					trips++;
					until = Date.now() + BREAKER_COOLDOWN_MS;
					log(`⚠ ${BREAKER_THRESHOLD} consecutive MAL failures — pausing writes for ${BREAKER_COOLDOWN_MS / 1e3}s.`);
				}
			},
			async wait(cancelOrOpts) {
				const { check, signal } = normalizeMalCallOptions(cancelOrOpts);
				while (Date.now() < until) {
					check();
					await sleepMal(Math.min(1e3, until - Date.now()), signal);
				}
				check();
			},
			get trips() {
				return trips;
			},
			reset() {
				fails = 0;
				until = 0;
				trips = 0;
			}
		};
	})();
	var MalError = class extends Error {
		status;
		html;
		constructor(what, res) {
			super(`${what} ${res.status}: ${String(res.responseText || "request failed").slice(0, 200)}`);
			this.status = res.status;
			this.html = /^\s*</.test(res.responseText || "");
		}
	};
	function parseRetryAfterMs(headers, fallback) {
		const m = String(headers || "").match(/retry-after:\s*([^\r\n]+)/i);
		if (!m) return fallback;
		const raw = m[1].trim();
		if (!raw) return fallback;
		const secs = Number(raw);
		if (Number.isFinite(secs)) return Math.max(1e3, Math.min(secs * 1e3, 12e4));
		const date = Date.parse(raw);
		return Number.isFinite(date) ? Math.max(1e3, Math.min(date - Date.now(), 12e4)) : fallback;
	}
	var looksLimited = (res) => res.status === 429 || res.status === 403 && /^\s*</.test(res.responseText || "");
	var backoff = (attempt) => Math.min(3e4, 1e3 * 2 ** attempt) * (.8 + Math.random() * .4);
	async function malRequestWithToken({ method = "GET", url, data, headers = {}, timeout = 3e4 }, cancelOrOpts, failedToken, onTokenResolved) {
		const { check, signal } = normalizeMalCallOptions(cancelOrOpts);
		await malLimiter.acquire({
			check,
			signal
		}).catch((err) => rethrowMalAbort(err, signal));
		check();
		const token = await raceWithSignal(malEnsureToken(failedToken), signal, createMalAbortError);
		check();
		onTokenResolved?.();
		malLog.debug(`MAL ${method} ${url}`, data ? { data } : "");
		const res = await raceWithSignal(gm.request(url, {
			method,
			data,
			timeout,
			headers: {
				Authorization: `Bearer ${token}`,
				...headers
			}
		}), signal, createMalAbortError);
		check();
		malLog.debug(`MAL ${method} response: ${res.status} for ${url}`);
		if (looksLimited(res)) malLimiter.limit(parseRetryAfterMs(res.responseHeaders, res.status === 429 ? 5e3 : 6e4));
		else if (res.status >= 500) malLimiter.limit(2e3);
		else if (res.status >= 200 && res.status < 300) malLimiter.success();
		return {
			res,
			token
		};
	}
	async function malCall(opts, retriesOrCallOpts = 4, cancelOrOpts) {
		const retries = typeof retriesOrCallOpts === "number" ? retriesOrCallOpts : 4;
		const { check, signal } = normalizeMalCallOptions(typeof retriesOrCallOpts === "object" && retriesOrCallOpts !== null ? retriesOrCallOpts : cancelOrOpts);
		const forwardOpts = {
			checkCancel: check,
			signal
		};
		let refreshed = false;
		let failedToken;
		let attempt = 0;
		while (true) {
			check();
			let res;
			let usedToken = "";
			try {
				const out = await malRequestWithToken(opts, forwardOpts, failedToken, () => {
					failedToken = void 0;
				});
				res = out.res;
				usedToken = out.token;
			} catch (e) {
				if (e?.auth || e?.cancelled || isAbortError(e) || signal?.aborted || attempt >= retries) throw e;
				await sleepMal(backoff(attempt), signal);
				check();
				attempt++;
				continue;
			}
			if (res.status === 401) {
				if (refreshed) {
					clearMalAuth();
					throw authError("MAL", "MAL rejected the access token — reconnect MAL.");
				}
				refreshed = true;
				failedToken = usedToken;
				continue;
			}
			if (!looksLimited(res) && res.status < 500) return res;
			if (attempt >= retries) return res;
			if (!looksLimited(res)) {
				check();
				await sleepMal(backoff(attempt), signal);
				check();
			}
			attempt++;
		}
	}
	var parseJson = (res, what) => {
		try {
			return JSON.parse(res.responseText || "{}");
		} catch (_) {
			throw new Error(`MAL returned invalid JSON for ${what}.`);
		}
	};
	async function malUpdateEntry(type, malId, patch, opts) {
		const body = new URLSearchParams();
		for (const [k, v] of Object.entries(patch)) if (v !== void 0 && v !== null) body.append(k, String(v));
		const res = await malCall({
			method: "PUT",
			url: `${MAL_API}/${type === "ANIME" ? "anime" : "manga"}/${malId}/my_list_status`,
			data: body.toString(),
			headers: { "Content-Type": "application/x-www-form-urlencoded" }
		}, opts);
		if (res.status < 200 || res.status >= 300) throw new MalError("MAL", res);
		return res;
	}
	async function malDeleteEntry(type, malId, opts) {
		const res = await malCall({
			method: "DELETE",
			url: `${MAL_API}/${type === "ANIME" ? "anime" : "manga"}/${malId}/my_list_status`
		}, opts);
		if (res.status === 404) return res;
		if (res.status < 200 || res.status >= 300) throw new MalError("MAL delete", res);
		return res;
	}
	async function malWhoAmI(opts) {
		const res = await malCall({ url: `${MAL_API}/users/@me` }, opts);
		if (res.status < 200 || res.status >= 300) throw new MalError("MAL profile", res);
		return parseJson(res, "the profile");
	}
	async function malFetchList(type, opts) {
		const MAL_LIST_PAGE_SIZE = 1e3;
		const MAL_LIST_MAX = 1e5;
		const { check } = normalizeMalCallOptions(opts);
		const anime = type === "ANIME";
		const fields = anime ? "num_episodes,list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched,start_date,finish_date,comments}" : "num_chapters,num_volumes,list_status{status,score,num_chapters_read,num_volumes_read,is_rereading,num_times_reread,start_date,finish_date,comments}";
		const entries = {};
		let total = 0;
		for (let offset = 0; offset <= MAL_LIST_MAX;) {
			check();
			const res = await malCall({
				url: `${MAL_API}/users/@me/${anime ? "animelist" : "mangalist"}?fields=${encodeURIComponent(fields)}&limit=${MAL_LIST_PAGE_SIZE}&offset=${offset}&nsfw=true`,
				timeout: 6e4
			}, 6, opts);
			check();
			if (res.status < 200 || res.status >= 300) throw new MalError("MAL list", res);
			const json = parseJson(res, "the list");
			const nodes = Array.isArray(json.data) ? json.data : [];
			for (const row of nodes) {
				const id = Number(row?.node?.id);
				if (!(id > 0) || !row.list_status) continue;
				const node = row.node;
				if (!entries[id]) total++;
				entries[id] = {
					...row.list_status,
					__malTitle: node.title || "",
					__total: Number(anime ? node.num_episodes : node.num_chapters) || 0,
					__totalVolumes: anime ? 0 : Number(node.num_volumes) || 0
				};
			}
			if (total > MAL_LIST_MAX) throw new Error(`MAL list exceeded the ${MAL_LIST_MAX.toLocaleString()}-entry safety limit.`);
			if (!nodes.length || !json.paging?.next) break;
			offset += nodes.length;
		}
		return entries;
	}
	var SEARCH_CACHE_MAX = 1e3;
	var searchCache = new Map();
	var searchFlights = new Map();
	async function fetchSearchCandidates(type, q, opts) {
		const params = new URLSearchParams({
			q: q.slice(0, 64),
			limit: "10",
			nsfw: "true",
			fields: "alternative_titles,start_date"
		});
		const res = await malCall({ url: `${MAL_API}/${type === "ANIME" ? "anime" : "manga"}?${params}` }, 2, opts);
		if (res.status === 400) return [];
		if (res.status < 200 || res.status >= 300) throw new MalError("MAL search", res);
		const json = parseJson(res, "a search");
		return (Array.isArray(json.data) ? json.data : []).map((r) => {
			const n = r?.node || {};
			const alt = n.alternative_titles || {};
			return {
				id: Number(n.id) || 0,
				titles: [
					n.title,
					alt.en,
					alt.ja,
					...alt.synonyms || []
				].map(strictTitle).filter(Boolean),
				year: Number(String(n.start_date || "").slice(0, 4)) || 0
			};
		});
	}
	async function searchCandidates(key, type, q, opts) {
		const { check, signal } = normalizeMalCallOptions(opts);
		check();
		const k = String(key);
		if (searchCache.has(k)) return searchCache.get(k);
		let flight = searchFlights.get(k);
		if (!flight || flight.controller.signal.aborted) {
			flight = createSharedFlight({
				start: (controllerSignal) => {
					return fetchSearchCandidates(type, q, {
						checkCancel: () => {
							if (controllerSignal.aborted) throw createMalAbortError(controllerSignal);
						},
						signal: controllerSignal
					}).then((cands) => {
						if (!controllerSignal.aborted) {
							if (searchCache.size >= SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
							searchCache.set(k, cands);
						}
						return cands;
					});
				},
				onEvict: (evicted) => {
					if (searchFlights.get(k) === evicted) searchFlights.delete(k);
				},
				onSettled: (doneFlight) => {
					if (searchFlights.get(k) === doneFlight) searchFlights.delete(k);
				},
				createAbortError: createMalAbortError
			});
			searchFlights.set(k, flight);
		}
		return flight.wait({
			signal,
			check
		});
	}
	async function searchMalId(type, entry, opts) {
		const { check } = normalizeMalCallOptions(opts);
		check();
		for (const q of entry.queryTitles.filter((s) => s.length >= 3).slice(0, 2)) {
			check();
			const cands = await searchCandidates(`${type}:${q}`, type, q, opts);
			check();
			const ok = cands.filter((c) => c.id && c.titles.some((t) => entry.titles.includes(t)) && (!c.year || !entry.startYear || Math.abs(c.year - entry.startYear) <= 1));
			if (ok.length === 1) return ok[0].id;
			if (ok.length > 1) {
				const exact = ok.filter((c) => c.year && c.year === entry.startYear);
				return exact.length === 1 ? exact[0].id : 0;
			}
		}
		return 0;
	}
	var TYPES = MEDIA_TYPES;
	var typeLabel = (t) => t === "ANIME" ? "Anime" : "Manga";
	var fallbackMemory = new Map();
	var fallbackStorage = {
		get: (key, def) => fallbackMemory.has(key) ? fallbackMemory.get(key) : def,
		set: (key, val) => {
			fallbackMemory.set(key, val);
		},
		del: (key) => {
			fallbackMemory.delete(key);
		},
		clear: () => {
			fallbackMemory.clear();
		},
		watch: () => () => {}
	};
	var activeStorage = null;
	function setSyncStorage(storage) {
		activeStorage = storage;
	}
	var scoped = () => activeStorage ?? fallbackStorage;
	var syncStore = {
		get: (k, d) => scoped().get(k, d),
		set: (k, v) => scoped().set(k, v),
		del: (k) => scoped().del(k),
		jsonGet: (k, d) => {
			const raw = scoped().get(k, null);
			if (raw == null) return d;
			if (typeof raw === "string") try {
				return JSON.parse(raw);
			} catch {
				return d;
			}
			return raw;
		},
		jsonSet: (k, v) => scoped().set(k, v),
		clearKnown: () => {
			scoped().clear();
		}
	};
	var syncLog = null;
	function setSyncLog(log) {
		syncLog = log;
	}
	var syncApi = null;
	function setSyncApi(api) {
		syncApi = api;
	}
	var defaultSyncGet = (key) => {
		if (key === "syncScoreRounding") return "round";
		if (key === "syncMode") return "update";
		if (key === "syncIntervalAnime" || key === "syncIntervalManga") return 6;
		if (key === "syncEnabled") return true;
		return false;
	};
	var syncGet = defaultSyncGet;
	function setSyncGet(getter) {
		syncGet = getter ?? defaultSyncGet;
	}
	var SETTLED_TTL_MS = 3888e6;
	var LOCK_STALE_MS = 45e3;
	var LOCK_HEARTBEAT_MS = 1e4;
	var TAB_ID = randomString(10);
	var LOCK_KEY = "lock_heartbeat";
	var progress = {
		phase: "idle",
		done: 0,
		total: 0,
		changed: 0
	};
	var syncStatus = {
		syncing: false,
		cancelled: false,
		autoSyncRetryAfter: 0
	};
	var progressListeners = new Set();
	var stateListeners = new Set();
	var onProgressChange = (cb) => {
		progressListeners.add(cb);
		return () => {
			progressListeners.delete(cb);
		};
	};
	var onStateChange = (cb) => {
		stateListeners.add(cb);
		return () => {
			stateListeners.delete(cb);
		};
	};
	var notifyProgress = (force = false) => {
		for (const cb of [...progressListeners]) cb(force);
	};
	var notifyState = () => {
		for (const cb of [...stateListeners]) cb();
	};
	var markDone = (n = 1) => {
		progress.done += n;
		notifyProgress();
	};
	var checkCancel = () => {
		if (syncStatus.cancelled) {
			const e = new Error("Sync stopped.");
			e.cancelled = true;
			throw e;
		}
	};
	var pruneIds = (d) => {
		for (const k of Object.keys(d)) {
			const r = d[k];
			if (!r || typeof r !== "object" || !(r.m > 0) && !(Date.now() - r.t < 6048e5)) delete d[k];
		}
	};
	var pruneSettled = (d) => {
		for (const k of Object.keys(d)) {
			const r = d[k];
			if (!Array.isArray(r) || !(Date.now() - r[2] < SETTLED_TTL_MS)) delete d[k];
		}
	};
	var makeEmptyStore = () => ({
		data: {},
		save: () => {}
	});
	var stores = {
		ANIME: {
			ids: makeEmptyStore(),
			settled: makeEmptyStore()
		},
		MANGA: {
			ids: makeEmptyStore(),
			settled: makeEmptyStore()
		}
	};
	var syncStoresInitialized = false;
	function initSyncStores(createPersistent) {
		for (const t of TYPES) {
			stores[t].ids = createPersistent(`idmap_${t}`, pruneIds);
			stores[t].settled = createPersistent(`settled_${t}`, pruneSettled);
		}
		syncStoresInitialized = true;
	}
	function resetSyncStores() {
		syncStoresInitialized = false;
		for (const t of TYPES) {
			stores[t].ids = makeEmptyStore();
			stores[t].settled = makeEmptyStore();
		}
	}
	var clearCache = (c, persist = true) => {
		for (const k of Object.keys(c.data)) delete c.data[k];
		if (persist) c.save();
		else c.cancel?.();
	};
	var PENDING_DELETES_KEY = "pending_deletes";
	function getPendingDeletes() {
		return syncStore.jsonGet(PENDING_DELETES_KEY, []);
	}
	function addPendingDelete(del) {
		const list = getPendingDeletes().filter((p) => !(p.mediaId === del.mediaId && p.type === del.type));
		list.push(del);
		syncStore.jsonSet(PENDING_DELETES_KEY, list);
	}
	function removePendingDelete(mediaId, type) {
		const list = getPendingDeletes().filter((p) => !(p.mediaId === mediaId && p.type === type));
		syncStore.jsonSet(PENDING_DELETES_KEY, list);
	}
	function resetAccountState() {
		for (const t of TYPES) {
			for (const k of [
				"last_sync",
				"last_run",
				"last_compare"
			]) syncStore.del(`${k}_${t}`);
			clearCache(stores[t].settled);
		}
		syncStore.del("sync_retry_at");
		syncStore.del(PENDING_DELETES_KEY);
	}
	var heartbeat = null;
	var syncEpoch = 0;
	var lockRunToken = 0;
	function bumpSyncEpoch() {
		return ++syncEpoch;
	}
	async function acquireLock(expectedEpoch = syncEpoch) {
		if (expectedEpoch !== syncEpoch) return false;
		const lock = syncStore.jsonGet(LOCK_KEY, null);
		if (lock && lock.tab !== TAB_ID && Number.isFinite(lock.at) && Date.now() - lock.at < LOCK_STALE_MS) return false;
		const token = ++lockRunToken;
		const beat = () => {
			if (expectedEpoch !== syncEpoch || token !== lockRunToken) {
				if (heartbeat) {
					clearInterval(heartbeat);
					heartbeat = null;
				}
				return;
			}
			syncStore.jsonSet(LOCK_KEY, {
				at: Date.now(),
				tab: TAB_ID
			});
		};
		beat();
		await sleep(250);
		if (expectedEpoch !== syncEpoch || token !== lockRunToken) return false;
		if (syncStore.jsonGet(LOCK_KEY, null)?.tab !== TAB_ID) return false;
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = setInterval(beat, LOCK_HEARTBEAT_MS);
		return true;
	}
	function releaseLock(expectedEpoch) {
		if (expectedEpoch !== void 0 && expectedEpoch !== syncEpoch) return;
		lockRunToken++;
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = null;
		if (syncStore.jsonGet(LOCK_KEY, null)?.tab === TAB_ID) syncStore.del(LOCK_KEY);
	}
	var STATUS_MAP = {
		ANIME: {
			CURRENT: "watching",
			COMPLETED: "completed",
			PAUSED: "on_hold",
			DROPPED: "dropped",
			PLANNING: "plan_to_watch",
			REPEATING: "watching"
		},
		MANGA: {
			CURRENT: "reading",
			COMPLETED: "completed",
			PAUSED: "on_hold",
			DROPPED: "dropped",
			PLANNING: "plan_to_read",
			REPEATING: "reading"
		}
	};
	var PROGRESS_KEYS = [
		"num_watched_episodes",
		"num_chapters_read",
		"num_volumes_read"
	];
	function convertScore(score100, mode = syncGet("syncScoreRounding") || "round") {
		if (!score100 || score100 <= 0) return 0;
		return Math.max(1, Math.min(10, (mode === "ceil" ? Math.ceil : mode === "floor" ? Math.floor : Math.round)(Number(score100) / 10)));
	}
	var fuzzyToMalDate = (f) => f && f.year && f.month && f.day ? `${f.year}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}` : null;
	var count = (v) => Math.max(0, Math.floor(Number(v) || 0));
	var normText = (s) => String(s || "").replace(/\r\n?/g, "\n").trim();
	function buildPayload(type, e) {
		const status = STATUS_MAP[type][e.status];
		if (!status) return null;
		const anime = type === "ANIME";
		const p = { status };
		const score = convertScore(e.score);
		if (score > 0) p.score = score;
		p[anime ? "is_rewatching" : "is_rereading"] = e.status === "REPEATING" ? "true" : "false";
		if (anime) p.num_watched_episodes = count(e.progress);
		else {
			p.num_chapters_read = count(e.progress);
			if (count(e.progressVolumes) > 0) p.num_volumes_read = count(e.progressVolumes);
		}
		const start = fuzzyToMalDate(e.startedAt);
		const finish = fuzzyToMalDate(e.completedAt);
		if (start) p.start_date = start;
		if (finish) p.finish_date = finish;
		if (count(e.repeat) > 0) p[anime ? "num_times_rewatched" : "num_times_reread"] = count(e.repeat);
		const notes = normText(e.notes);
		if (notes) p.comments = notes.slice(0, 2e3);
		return p;
	}
	var malKey = (k) => k === "num_watched_episodes" ? "num_episodes_watched" : k;
	var normDate = (v) => v ? String(v).slice(0, 10) : null;
	var truthy = (v) => v === true || v === 1 || String(v).toLowerCase() === "true";
	var NUMERIC = [
		"score",
		"num_watched_episodes",
		"num_chapters_read",
		"num_volumes_read",
		"num_times_rewatched",
		"num_times_reread"
	];
	function fieldEquals(key, desired, actual) {
		if (key === "is_rewatching" || key === "is_rereading") return truthy(actual) === truthy(desired);
		if (key === "start_date" || key === "finish_date") return normDate(actual) === normDate(desired);
		if (key === "comments") return normText(actual) === normText(desired);
		if (NUMERIC.includes(key)) return Number(actual || 0) === Number(desired || 0);
		return String(actual ?? "") === String(desired ?? "");
	}
	function reconcile(type, entry, mal) {
		const desired = buildPayload(type, entry);
		if (!desired) return null;
		const anime = type === "ANIME";
		const pKey = anime ? "num_watched_episodes" : "num_chapters_read";
		const rKey = anime ? "num_times_rewatched" : "num_times_reread";
		const m = mal || {};
		const rewatches = Math.max(Number(desired[rKey]) || 0, Number(m[rKey]) || 0);
		if (rewatches > 0) desired[rKey] = rewatches;
		if (entry.status === "COMPLETED") {
			const completedCount = (key, total) => Number(total) > 0 ? Number(total) : Math.max(Number(desired[key]) || 0, Number(m[malKey(key)]) || 0);
			desired[pKey] = completedCount(pKey, m.__total);
			if (!anime) {
				const vols = completedCount("num_volumes_read", m.__totalVolumes);
				if (vols > 0) desired.num_volumes_read = vols;
				else delete desired.num_volumes_read;
			}
			if (!(desired[pKey] > 0)) delete desired[pKey];
		}
		if (!mal) return desired;
		const statusEq = fieldEquals("status", desired.status, m.status) || entry.status === "REPEATING" && truthy(m[anime ? "is_rewatching" : "is_rereading"]);
		const patch = {};
		for (const [k, v] of Object.entries(desired)) {
			if (k === "status") {
				if (!statusEq) patch.status = v;
				continue;
			}
			if (!statusEq && PROGRESS_KEYS.includes(k) || !fieldEquals(k, v, m[malKey(k)])) patch[k] = v;
		}
		return patch;
	}
	function fallbackPatch(type, patch, mal, tried) {
		if (!tried.has("cap")) {
			tried.add("cap");
			const caps = type === "ANIME" ? { num_watched_episodes: mal?.__total } : {
				num_chapters_read: mal?.__total,
				num_volumes_read: mal?.__totalVolumes
			};
			const out = { ...patch };
			let changed = false;
			for (const [k, cap] of Object.entries(caps)) if (cap > 0 && Number(out[k]) > cap) {
				out[k] = cap;
				changed = true;
			}
			if (changed) return out;
		}
		if (!tried.has("dates")) {
			tried.add("dates");
			if ("start_date" in patch || "finish_date" in patch) {
				const out = { ...patch };
				delete out.start_date;
				delete out.finish_date;
				if (Object.keys(out).length) return out;
			}
		}
		return null;
	}
	var STATUS_LABEL = {
		watching: "Watching",
		reading: "Reading",
		completed: "Completed",
		on_hold: "On hold",
		dropped: "Dropped",
		plan_to_watch: "Plan to watch",
		plan_to_read: "Plan to read"
	};
	function describePatch(type, patch) {
		const parts = [];
		if ("status" in patch) parts.push(`status: ${STATUS_LABEL[patch.status] || patch.status}`);
		if ("score" in patch) parts.push(`score: ${patch.score}/10`);
		const progressKey = type === "ANIME" ? "num_watched_episodes" : "num_chapters_read";
		if (progressKey in patch) parts.push(`${type === "ANIME" ? "episodes" : "chapters"}: ${patch[progressKey]}`);
		if (type === "MANGA" && "num_volumes_read" in patch) parts.push(`volumes: ${patch.num_volumes_read}`);
		if ("num_times_rewatched" in patch) parts.push(`rewatches: ${patch.num_times_rewatched}`);
		if ("num_times_reread" in patch) parts.push(`rereads: ${patch.num_times_reread}`);
		if ("start_date" in patch) parts.push(`start date: ${patch.start_date}`);
		if ("finish_date" in patch) parts.push(`finish date: ${patch.finish_date}`);
		if ("comments" in patch) parts.push("notes");
		return parts.join("; ") || "MAL-normalised fields";
	}
	function buildTitleIndex(mal) {
		const idx = new Map();
		for (const [id, st] of Object.entries(mal)) {
			const t = strictTitle(st?.__malTitle);
			if (!t) continue;
			idx.set(t, idx.has(t) && idx.get(t) !== Number(id) ? -1 : Number(id));
		}
		return idx;
	}
	function localMatch(entry, idx) {
		let match = null;
		for (const t of entry.titles) {
			const id = idx.get(t);
			if (id == null) continue;
			if (id === -1 || match && match !== id) return null;
			match = id;
		}
		return match;
	}
	function cachedId(type, entry) {
		const override = getOverride(entry.mediaId);
		if (override) return override.malId;
		const c = stores[type].ids.data[entry.mediaId];
		const fresh = !!c && Date.now() - c.t < 6048e5;
		if (entry.idMal) return fresh && c.bad === entry.idMal ? 0 : entry.idMal;
		if (c && c.m > 0) return c.m;
		return fresh ? 0 : void 0;
	}
	function rememberId(type, mediaId, malId, bad) {
		if (!mediaId) return;
		const rec = {
			m: malId || 0,
			t: Date.now()
		};
		if (bad) rec.bad = bad;
		stores[type].ids.data[mediaId] = rec;
		stores[type].ids.save();
	}
	function checkTargetCancel(opts) {
		if (opts?.checkCancel) opts.checkCancel();
		else checkCancel();
		if (opts?.signal?.aborted) {
			const e = new Error("Sync stopped.");
			e.cancelled = true;
			throw e;
		}
	}
	async function runPool(items, worker, concurrency, opts) {
		const poolOpts = opts && typeof opts.aborted === "boolean" ? { signal: opts } : opts;
		let i = 0;
		let failure = null;
		const lane = async () => {
			while (!failure && i < items.length) {
				if (poolOpts?.checkCancel || poolOpts?.signal) try {
					checkTargetCancel(poolOpts);
				} catch (e) {
					failure = failure || e;
					break;
				}
				const n = i++;
				if (n >= items.length) break;
				try {
					await worker(items[n], n);
				} catch (e) {
					failure = failure || e;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, items.length) || 1 }, lane));
		if (failure) throw failure;
	}
	async function resolveTargets(type, entries, mal, c, opts) {
		const rawOpts = opts && typeof opts.aborted === "boolean" ? { signal: opts } : opts;
		const malOpts = {
			checkCancel: () => checkTargetCancel(rawOpts),
			signal: rawOpts?.signal
		};
		const idx = buildTitleIndex(mal);
		const targets = [];
		const pending = [];
		const unmatched = [];
		for (const entry of entries) {
			if (!entry.mediaId || !STATUS_MAP[type][entry.status]) {
				c.skipped++;
				markDone();
				continue;
			}
			const override = getOverride(entry.mediaId);
			if (override) {
				if (override.malId === 0) {
					c.skipped++;
					markDone();
					continue;
				}
				if (override.malId > 0) {
					targets.push({
						entry,
						malId: override.malId,
						explicit: true
					});
					continue;
				}
			}
			const id = cachedId(type, entry);
			if (id !== void 0 && id > 0) {
				targets.push({
					entry,
					malId: id,
					explicit: id === entry.idMal
				});
				continue;
			}
			if (id === 0) {
				c.unmatched++;
				markDone();
				continue;
			}
			const local = localMatch(entry, idx);
			if (local && local > 0) {
				rememberId(type, entry.mediaId, local);
				targets.push({
					entry,
					malId: local,
					explicit: false
				});
				continue;
			}
			pending.push(entry);
		}
		await runPool(pending, async (entry) => {
			let id = 0;
			try {
				id = await searchMalId(type, entry, malOpts);
			} catch (e) {
				if (e?.auth || e?.cancelled || e?.abort || isAbortError(e)) throw e;
				c.transient++;
				markDone();
				log(`${typeLabel(type)}: could not look up "${entry.title.slice(0, 45)}" on MAL: ${e.message}. Will retry on a later sync.`, "warn");
				return;
			}
			rememberId(type, entry.mediaId, id);
			if (id > 0) targets.push({
				entry,
				malId: id,
				explicit: false
			});
			else {
				c.unmatched++;
				unmatched.push(entry.title);
				markDone();
			}
		}, 3, malOpts);
		if (unmatched.length) log(`${typeLabel(type)}: no confident MAL match for ${unmatched.length} title(s). Skipped: ${unmatched.slice(0, 5).map((t) => `"${t.slice(0, 30)}"`).join(", ")}${unmatched.length > 5 ? `, plus ${unmatched.length - 5} more` : ""}. Use Full Resync after adding/fixing MAL entries.`, "warn");
		return targets;
	}
	function dedupeTargets(type, targets, c) {
		const best = new Map();
		for (const t of targets) {
			const cur = best.get(t.malId);
			if (!cur) {
				best.set(t.malId, t);
				continue;
			}
			const better = Number(t.explicit) - Number(cur.explicit) || t.entry.updatedAt - cur.entry.updatedAt;
			const loser = better > 0 ? cur : t;
			if (better > 0) best.set(t.malId, t);
			c.conflicts++;
			markDone();
			log(`${typeLabel(type)}: "${loser.entry.title.slice(0, 40)}" and another AniList entry resolve to MAL ID ${loser.malId}; only one can be synced, so the preferred entry wins.`, "warn");
		}
		return [...best.values()].sort((a, b) => b.entry.updatedAt - a.entry.updatedAt);
	}
	var syncConfirm = null;
	function setSyncConfirm(confirm) {
		syncConfirm = confirm;
	}
	var makeMalOpts = (signal) => ({
		checkCancel: () => checkSyncCancel(signal),
		signal
	});
	var FULL_COMPARE_MS = 6048e5;
	var BREAKER_MAX_TRIPS = 3;
	var RETRY_AFTER_FAILURE_MS = 6e5;
	var LIST_PATH_RE = /^\/user\/[^/]+\/(anime|manga)list\/?$/i;
	var onAniList = () => location.hostname === "anilist.co";
	var ENTRY_FIELDS = "status score(format: POINT_100) progress progressVolumes repeat notes updatedAt startedAt { year month day } completedAt { year month day }";
	var MEDIA_FIELDS = "id idMal startDate { year } synonyms title { userPreferred english romaji native }";
	var toEntry = (row, media) => {
		const t = media?.title || {};
		return {
			...row,
			mediaId: Number(media?.id) || 0,
			idMal: Number(media?.idMal) || 0,
			title: t.userPreferred || t.romaji || t.english || String(media?.id || ""),
			queryTitles: [...new Set([
				t.userPreferred,
				t.romaji,
				t.english
			].map((s) => String(s || "").trim()).filter(Boolean))],
			titles: [...new Set([
				t.userPreferred,
				t.english,
				t.romaji,
				t.native,
				...media?.synonyms || []
			].map(strictTitle).filter(Boolean))],
			startYear: Number(media?.startDate?.year) || 0,
			updatedAt: Number(row.updatedAt) || 0
		};
	};
	async function alFetchIncremental(userId, type, since, signal) {
		const q = `query ($userId: Int, $type: MediaType, $page: Int) { Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage } mediaList(userId: $userId, type: $type, sort: UPDATED_TIME_DESC) { ${ENTRY_FIELDS} media { ${MEDIA_FIELDS} } } } }`;
		const out = [];
		for (let page = 1; page <= 400; page++) {
			checkSyncCancel(signal);
			const p = (await syncApi?.query(q, {
				userId,
				type,
				page
			}, {
				forceFresh: true,
				signal
			}))?.Page;
			checkSyncCancel(signal);
			let stop = false;
			for (const row of p?.mediaList || []) {
				if ((Number(row.updatedAt) || 0) < since) {
					stop = true;
					break;
				}
				out.push(toEntry(row, row.media));
			}
			if (stop || !p?.pageInfo?.hasNextPage) break;
		}
		return out;
	}
	async function alFetchAll(userId, type, api = syncApi, signal) {
		if (!api) throw new Error("AniList API client is unavailable.");
		const q = `query ($userId: Int, $type: MediaType, $chunk: Int, $perChunk: Int) {
    MediaListCollection(userId: $userId, type: $type, chunk: $chunk, perChunk: $perChunk) { hasNextChunk lists { entries { ${ENTRY_FIELDS} media { ${MEDIA_FIELDS} } } } } }`;
		const out = [];
		const seen = new Set();
		for (let chunk = 1; chunk <= 100; chunk++) {
			checkSyncCancel(signal);
			const res = await api.query(q, {
				userId,
				type,
				chunk,
				perChunk: 500
			}, {
				forceFresh: true,
				signal
			});
			checkSyncCancel(signal);
			const c = res?.MediaListCollection;
			if (!c || !Array.isArray(c.lists)) throw new Error("AniList returned an invalid MediaListCollection response.");
			for (const list of c.lists) for (const row of list.entries || []) {
				const e = toEntry(row, row.media);
				if (!e.mediaId || seen.has(e.mediaId)) continue;
				seen.add(e.mediaId);
				out.push(e);
			}
			if (!c.hasNextChunk) return out;
		}
		throw new Error("AniList collection exceeded the 100-chunk safety limit.");
	}
	function checkSyncCancel(signal) {
		checkCancel();
		if (signal?.aborted) {
			const e = new Error("Sync stopped.");
			e.cancelled = true;
			throw e;
		}
	}
	var isTransient = (e) => !(e && (e.status === 400 || e.status === 404 || e.status === 403 && !e.html));
	async function pushJob(type, { entry, malId, patch }, mal, c, signal) {
		const settled = stores[type].settled;
		const malOpts = makeMalOpts(signal);
		try {
			await breaker.wait(malOpts);
			checkSyncCancel(signal);
			if (breaker.trips >= BREAKER_MAX_TRIPS) {
				const e = new Error("MAL keeps failing — stopping this run; it will retry automatically.");
				e.abort = true;
				throw e;
			}
			let sent = patch;
			let res;
			const tried = new Set();
			for (;;) try {
				res = await malUpdateEntry(type, malId, sent, malOpts);
				break;
			} catch (e) {
				const alt = e.status === 400 ? fallbackPatch(type, sent, mal[malId], tried) : null;
				if (!alt) throw e;
				const removedDates = ["start_date", "finish_date"].some((k) => k in sent && !(k in alt));
				const cappedKeys = Object.keys(alt).filter((k) => PROGRESS_KEYS.includes(k) && Number(alt[k]) < Number(sent[k]));
				const recovery = cappedKeys.length ? `retrying with ${cappedKeys.map((k) => `${k.replace("num_watched_episodes", "episode count").replace("num_chapters_read", "chapter count").replace("num_volumes_read", "volume count")} capped to ${alt[k]} (MAL's listed total)`).join(", ")}` : removedDates ? "retrying without the optional start/finish dates" : "retrying with a reduced update";
				log(`${typeLabel(type)}: MAL rejected the update for "${entry.title.slice(0, 45)}" (HTTP 400); ${recovery}.`, "warn");
				sent = alt;
			}
			let stored = null;
			try {
				stored = JSON.parse(res.responseText);
			} catch (_) {}
			const base = mal[malId] || {
				__total: 0,
				__totalVolumes: 0,
				__malTitle: ""
			};
			const applied = Object.fromEntries(Object.entries(sent).map(([k, v]) => [malKey(k), v]));
			const echoed = stored && typeof stored === "object" ? stored : {};
			mal[malId] = {
				...base,
				...applied,
				...echoed
			};
			const residual = stored ? reconcile(type, entry, mal[malId]) : {};
			if (residual && Object.keys(residual).length) {
				settled.data[malId] = [
					entry.updatedAt,
					JSON.stringify(residual),
					Date.now()
				];
				log(`${typeLabel(type)}: MAL saved "${entry.title.slice(0, 55)}" but did not retain ${describePatch(type, residual)}. It may be normalising or rejecting that value; unchanged values are suppressed to avoid a write loop. Full Resync clears this suppression.`, "warn");
			} else delete settled.data[malId];
			settled.save();
			c.pushed++;
			log(`${typeLabel(type)}: updated "${entry.title.slice(0, 55)}" — ${describePatch(type, sent)}.`, "success");
			breaker.ok();
		} catch (e) {
			if (e.cancelled || e.auth || e.abort) throw e;
			if (isTransient(e)) {
				c.transient++;
				breaker.fail();
				log(`${typeLabel(type)}: "${entry.title.slice(0, 45)}" — temporary MAL error: ${e.message}. Will retry on the next sync.`, "warn");
			} else {
				c.permanent++;
				log(`${typeLabel(type)}: "${entry.title.slice(0, 45)}" — MAL rejected this update (${e.message}). It will be skipped until the AniList entry changes or Full Resync is run.`, "warn");
				settled.data[malId] = [
					entry.updatedAt,
					"dead",
					Date.now()
				];
				settled.save();
				if (e.status === 404) rememberId(type, entry.mediaId, 0, malId);
			}
		} finally {
			markDone();
		}
	}
	function planJobs(type, targets, mal, c, signal) {
		const settled = stores[type].settled.data;
		const jobs = [];
		for (const t of targets) {
			checkSyncCancel(signal);
			const patch = reconcile(type, t.entry, mal[t.malId]);
			if (!patch) {
				c.skipped++;
				markDone();
				continue;
			}
			if (!Object.keys(patch).length) {
				c.unchanged++;
				markDone();
				continue;
			}
			const s = settled[t.malId];
			if (s && s[0] === t.entry.updatedAt && (s[1] === "dead" || s[1] === JSON.stringify(patch))) {
				c.settled++;
				markDone();
				continue;
			}
			progress.changed++;
			jobs.push({
				...t,
				patch
			});
		}
		return jobs;
	}
	async function syncType(type, userId, full, signal) {
		const label = typeLabel(type);
		const c = {
			pushed: 0,
			deleted: 0,
			unchanged: 0,
			settled: 0,
			skipped: 0,
			unmatched: 0,
			conflicts: 0,
			transient: 0,
			permanent: 0
		};
		const lastSync = Number(syncStore.get(`last_sync_${type}`, 0)) || 0;
		const fullPass = full || !lastSync || Date.now() - Number(syncStore.get(`last_compare_${type}`, 0)) > FULL_COMPARE_MS;
		const isExact = syncGet("syncMode") === "exact";
		const malOpts = makeMalOpts(signal);
		log(`${label}: starting ${fullPass ? "full library comparison" : "incremental sync"} — fetching AniList entries and your current MAL list.`);
		syncLog?.debug(`${label}: starting sync pass:`, {
			fullPass,
			lastSync,
			isExact
		});
		const [entries, mal] = await Promise.all([fullPass ? alFetchAll(userId, type, syncApi, signal) : alFetchIncremental(userId, type, lastSync, signal), malFetchList(type, malOpts)]);
		checkSyncCancel(signal);
		const newest = entries.reduce((m, e) => Math.max(m, e.updatedAt), 0);
		log(`${label}: found ${entries.length} AniList entr${entries.length === 1 ? "y" : "ies"} to check and ${Object.keys(mal).length} entr${Object.keys(mal).length === 1 ? "y" : "ies"} on MAL.`);
		syncLog?.debug(`${label}: AniList entries=${entries.length}, MAL entries=${Object.keys(mal).length}`);
		progress.total += entries.length;
		progress.phase = "pushing";
		notifyProgress(true);
		if (isExact) {
			const pending = getPendingDeletes().filter((p) => p.type === type);
			for (const p of pending) {
				checkSyncCancel(signal);
				if (entries.some((e) => e.mediaId === p.mediaId)) {
					removePendingDelete(p.mediaId, type);
					log(`${label}: deletion cancelled for "${p.title}" — entry is present on AniList.`);
					continue;
				}
				if (!fullPass) {
					if (!syncApi) {
						c.transient++;
						log(`${label}: skipping pending deletion for "${p.title}" — AniList client unavailable.`, "warn");
						continue;
					}
					let stillOnAniList = null;
					try {
						const res = await syncApi.query("query ($id: Int, $type: MediaType) { Media(id: $id, type: $type) { id mediaListEntry { id } } }", {
							id: p.mediaId,
							type
						}, {
							forceFresh: true,
							signal
						});
						checkSyncCancel(signal);
						if (res?.Media) stillOnAniList = !!res.Media.mediaListEntry;
					} catch (e) {
						if (e?.auth || e?.cancelled || e?.abort || isAbortError(e)) throw e;
						c.transient++;
						log(`${label}: could not verify AniList absence for "${p.title}": ${e?.message || e}. Keeping queued.`, "warn");
						continue;
					}
					if (stillOnAniList === true) {
						removePendingDelete(p.mediaId, type);
						log(`${label}: deletion cancelled for "${p.title}" — entry is present on AniList.`);
						continue;
					}
					if (stillOnAniList === null) {
						c.transient++;
						log(`${label}: could not verify AniList absence for "${p.title}"; keeping pending deletion queued.`, "warn");
						continue;
					}
				}
				let malId = p.malId || cachedId(type, { mediaId: p.mediaId }) || stores[type].ids.data[p.mediaId]?.m;
				if (!malId && mal) {
					for (const [id, st] of Object.entries(mal)) if (st.__malTitle && p.title && strictTitle(st.__malTitle) === strictTitle(p.title)) {
						malId = Number(id);
						break;
					}
				}
				let shouldRemovePending = false;
				if (malId) try {
					await breaker.wait(malOpts);
					checkSyncCancel(signal);
					await malDeleteEntry(type, Number(malId), malOpts);
					if (mal[malId]) delete mal[malId];
					c.deleted++;
					shouldRemovePending = true;
					log(`${label}: deleted "${p.title}" from MAL (Exact Match).`, "success");
				} catch (e) {
					if (e?.cancelled || e?.auth || e?.abort) throw e;
					if (e?.status === 404) {
						if (mal[malId]) delete mal[malId];
						shouldRemovePending = true;
					} else if (isTransient(e)) {
						c.transient++;
						breaker.fail();
						log(`${label}: failed to delete "${p.title}" from MAL (will retry): ${e?.message || e}`, "warn");
					} else {
						c.permanent++;
						shouldRemovePending = true;
						log(`${label}: failed to delete "${p.title}" from MAL: ${e?.message || e}`, "warn");
					}
				}
				else {
					shouldRemovePending = true;
					log(`${label}: could not find MAL ID for deleted title "${p.title}".`, "warn");
				}
				if (shouldRemovePending) removePendingDelete(p.mediaId, type);
			}
		}
		checkSyncCancel(signal);
		const targets = dedupeTargets(type, await resolveTargets(type, entries, mal, c, malOpts), c);
		checkSyncCancel(signal);
		await runPool(planJobs(type, targets, mal, c, signal), (job) => {
			checkSyncCancel(signal);
			return pushJob(type, job, mal, c, signal);
		}, Math.max(2, Math.min(8, Math.round(malLimiter.rate / 20))), malOpts);
		checkSyncCancel(signal);
		if (isExact && fullPass) {
			if (c.transient > 0 || c.conflicts > 0 || c.unmatched > 0) log(`${label}: Exact Match orphan auto-delete was skipped because ${[
				c.transient > 0 ? `${c.transient} lookup/update failure(s)` : "",
				c.conflicts > 0 ? `${c.conflicts} ID conflict(s)` : "",
				c.unmatched > 0 ? `${c.unmatched} unmatched entr${c.unmatched === 1 ? "y" : "ies"}` : ""
			].filter(Boolean).join(", ")} occurred during sync.`, "warn");
			else {
				const protectedMalIds = new Set(targets.map((t) => t.malId));
				for (const entry of entries) {
					if (!entry.mediaId) continue;
					const ov = getOverride(entry.mediaId);
					if (ov && ov.malId === 0) {
						if (entry.idMal > 0) protectedMalIds.add(entry.idMal);
						const cached = Number(stores[type].ids.data[entry.mediaId]?.m) || 0;
						if (cached > 0) protectedMalIds.add(cached);
					}
				}
				const orphanedMalIds = Object.keys(mal).map(Number).filter((id) => id > 0 && !protectedMalIds.has(id));
				const MAX_AUTO_DELETE_LIMIT = 10;
				if (orphanedMalIds.length > MAX_AUTO_DELETE_LIMIT) log(`${label}: Exact Match found ${orphanedMalIds.length} MAL entries not present on AniList, exceeding the safety limit of ${MAX_AUTO_DELETE_LIMIT}. Auto-delete was skipped to protect your MAL list from potential API data loss.`, "warn");
				else if (orphanedMalIds.length > 0) for (const orphanId of orphanedMalIds) {
					checkSyncCancel(signal);
					const orphanTitle = mal[orphanId]?.__malTitle || `MAL ID ${orphanId}`;
					try {
						await breaker.wait(malOpts);
						checkSyncCancel(signal);
						await malDeleteEntry(type, orphanId, malOpts);
						delete mal[orphanId];
						c.deleted++;
						log(`${label}: deleted "${orphanTitle}" from MAL (not on AniList).`, "success");
					} catch (e) {
						if (e?.cancelled || e?.auth || e?.abort) throw e;
						if (e?.status === 404) delete mal[orphanId];
						else if (isTransient(e)) {
							c.transient++;
							breaker.fail();
							log(`${label}: failed to delete "${orphanTitle}" from MAL: ${e?.message || e}`, "warn");
						} else {
							c.permanent++;
							log(`${label}: failed to delete "${orphanTitle}" from MAL: ${e?.message || e}`, "warn");
						}
					}
				}
			}
		}
		checkSyncCancel(signal);
		const ok = c.transient === 0;
		if (ok) {
			if (fullPass) {
				syncStore.set(`last_compare_${type}`, Date.now());
				syncStore.set(`last_sync_${type}`, Math.max(1, newest));
			} else if (newest) syncStore.set(`last_sync_${type}`, Math.max(newest, lastSync));
			syncStore.set(`last_run_${type}`, Math.floor(Date.now() / 1e3));
		}
		log(`${label}: finished — ${[
			`${c.pushed} updated`,
			c.deleted ? `${c.deleted} deleted` : null,
			`${c.unchanged + c.settled} already in sync`,
			c.unmatched && `${c.unmatched} unmatched`,
			c.skipped && `${c.skipped} skipped`,
			c.conflicts && `${c.conflicts} conflicts`,
			c.permanent && `${c.permanent} rejected`,
			c.transient && `${c.transient} failed (will retry)`
		].filter(Boolean).join(", ")}${c.transient ? "; this type will be retried" : ""}.`, c.transient || c.permanent || c.unmatched || c.conflicts ? "warn" : "success");
		return { ok };
	}
	var currentListType = () => {
		const m = location.pathname.match(LIST_PATH_RE);
		return m ? m[1].toUpperCase() : null;
	};
	async function confirmDecimalScores(signal) {
		if (signal?.aborted) return false;
		const v = await tryOr(() => syncApi?.viewer(false, { signal }) ?? Promise.resolve(null));
		if (signal?.aborted) return false;
		if (v?.scoreFormat !== "POINT_10_DECIMAL") return true;
		if (!syncConfirm) return false;
		const mode = syncGet("syncScoreRounding");
		const labels = {
			ceil: "Ceil (always up)",
			round: "Round (.1–.4 down, .5–.9 up)",
			floor: "Floor (always down)"
		};
		const examples = {
			ceil: "7.4 → 8 and 7.5 → 8",
			round: "7.4 → 7 and 7.5 → 8",
			floor: "7.4 → 7 and 7.5 → 7"
		};
		openConfirmCount++;
		try {
			return await syncConfirm({
				id: "decimal-scores-confirm",
				title: "Decimal Scores Detected",
				message: `Decimal scores detected on AniList.\n\nMAL uses whole-number scores, so your decimal scores will be converted using: ${labels[mode]}.\n${examples[mode]}.\n\nThis will affect the scores written to MAL during this first sync.\n\nContinue with the first sync?`,
				confirmText: "Continue",
				cancelText: "Cancel",
				signal
			});
		} finally {
			openConfirmCount = Math.max(0, openConfirmCount - 1);
		}
	}
	function handleAuthFailure(e) {
		if (e.auth === "AniList") syncApi?.clearViewer();
		else clearMalAuth();
		log(`⚠ ${e.message}`);
	}
	var activeRunSeq = 0;
	var startingSync = false;
	var openConfirmCount = 0;
	async function runSync(types = [...TYPES], opts = {}) {
		syncLog?.debug("runSync initiated for types:", types, "options:", opts);
		const signal = opts.signal;
		if (signal?.aborted) return;
		if (syncStatus.syncing) return log("Sync already running.");
		if (!onAniList()) return log("Open AniList to run a sync — it needs your AniList login.", "warn");
		if (!syncApi?.hasAuth()) return log("Log in to AniList first.");
		if (!isMalConnected()) return log("Connect MyAnimeList first.");
		if (navigator.onLine === false) return log("You appear to be offline; sync skipped.");
		const myEpoch = syncEpoch;
		const myRunId = ++activeRunSeq;
		syncStatus.syncing = true;
		syncStatus.cancelled = false;
		if (!await acquireLock(myEpoch)) {
			if (myEpoch === syncEpoch && myRunId === activeRunSeq) {
				syncStatus.syncing = false;
				notifyState();
			}
			return log("Another tab is already syncing, skipped.");
		}
		if (myEpoch !== syncEpoch || myRunId !== activeRunSeq || signal?.aborted) {
			releaseLock(myEpoch);
			return;
		}
		breaker.reset();
		syncStore.set("sync_onboarded", true);
		Object.assign(progress, {
			phase: "fetching",
			done: 0,
			total: 0,
			changed: 0
		});
		notifyState();
		const startedAt = Date.now();
		let allOk = false;
		const runAc = new AbortController();
		const onCallerAbort = () => runAc.abort();
		if (signal) {
			if (signal.aborted) runAc.abort();
			else signal.addEventListener("abort", onCallerAbort, { once: true });
		}
		try {
			const viewer = await syncApi?.viewer(false, { signal });
			if (myEpoch !== syncEpoch || signal?.aborted) return;
			if (!viewer) throw authError("AniList", "AniList is not logged in.");
			const me = await malWhoAmI(makeMalOpts(signal));
			if (myEpoch !== syncEpoch || signal?.aborted) return;
			const account = `${viewer.id}:${me.id}`;
			const prev = syncStore.get("sync_account", null);
			if (prev && prev !== account) {
				log("Connected account changed. Resetting sync watermarks and per-account suppression state.", "warn");
				resetAccountState();
			}
			syncStore.set("sync_account", account);
			if (opts.full) for (const t of types) clearCache(stores[t].settled);
			const results = await Promise.allSettled(types.map((t) => syncType(t, viewer.id, !!opts.full, runAc.signal).catch((err) => {
				if (err?.auth || err?.abort || err?.cancelled) runAc.abort();
				throw err;
			})));
			if (myEpoch !== syncEpoch || signal?.aborted) return;
			const fatal = results.find((r) => r.status === "rejected" && (r.reason?.auth || r.reason?.abort));
			for (const r of results) {
				if (r.status !== "rejected") continue;
				const e = r.reason || {};
				if (e.cancelled || isAbortError(e)) {
					if (!fatal) log("Sync stopped after the current request finished.", "warn");
				} else if (!e.auth && !e.abort) log(`Sync could not finish: ${e.message || e}`, "error");
			}
			if (fatal) {
				if (fatal.reason.auth) handleAuthFailure(fatal.reason);
				else log(`Sync stopped: ${fatal.reason.message}`, "error");
			}
			allOk = results.every((r) => r.status === "fulfilled" && r.value.ok);
			if (allOk) {
				syncStore.del("sync_retry_at");
				log(`Synced in ${((Date.now() - startedAt) / 1e3).toFixed(1)}s`);
			} else if (!syncStatus.cancelled) syncStore.set("sync_retry_at", Date.now() + RETRY_AFTER_FAILURE_MS);
		} catch (e) {
			if (myEpoch !== syncEpoch || signal?.aborted) return;
			if (e.auth) handleAuthFailure(e);
			else log("Sync could not finish: " + (e.message || e), "error");
			if (!e.auth && !syncStatus.cancelled) syncStore.set("sync_retry_at", Date.now() + RETRY_AFTER_FAILURE_MS);
		} finally {
			if (signal) signal.removeEventListener("abort", onCallerAbort);
			if (myEpoch === syncEpoch && myRunId === activeRunSeq) {
				for (const t of types) {
					stores[t].ids.save();
					stores[t].settled.save();
				}
				releaseLock(myEpoch);
				syncStatus.syncing = false;
				syncStatus.cancelled = false;
				progress.phase = "idle";
				notifyState();
			}
		}
	}
	async function startManualSync(signal) {
		if (syncStatus.syncing || startingSync || signal?.aborted) return;
		startingSync = true;
		const myEpoch = syncEpoch;
		try {
			const pageType = currentListType();
			const types = pageType ? [pageType] : [...TYPES];
			if (types.some((t) => !syncStore.get(`last_sync_${t}`, 0)) && !await confirmDecimalScores(signal)) return log("First sync cancelled.");
			if (myEpoch !== syncEpoch || signal?.aborted) return;
			runSync(types, { signal });
		} finally {
			startingSync = false;
		}
	}
	async function fullResync(signal) {
		if (syncStatus.syncing || startingSync || signal?.aborted) return;
		startingSync = true;
		const myEpoch = syncEpoch;
		try {
			if (!syncStore.get("sync_onboarded", false) && !await confirmDecimalScores(signal)) return log("Full resync cancelled.");
			if (myEpoch !== syncEpoch || signal?.aborted) return;
			for (const t of TYPES) clearCache(stores[t].ids);
			log("Full Resync started: checking the entire AniList library and clearing cached match/suppression decisions.");
			runSync([...TYPES], {
				full: true,
				signal
			});
		} finally {
			startingSync = false;
		}
	}
	function maybeAutoSync(signal) {
		if (signal?.aborted || !onAniList() || !syncGet("syncEnabled") || syncStatus.syncing || startingSync || openConfirmCount > 0 || Date.now() < syncStatus.autoSyncRetryAfter || navigator.onLine === false) return;
		if (!syncApi?.hasAuth() || !isMalConnected()) return;
		const retryAt = Number(syncStore.get("sync_retry_at", 0)) || 0;
		if (retryAt > 0 && Date.now() < retryAt) return;
		const dueTypes = [];
		for (const t of TYPES) {
			const isAnime = t === "ANIME";
			if (!syncGet(isAnime ? "syncAutoAnime" : "syncAutoManga")) continue;
			const hours = Math.max(1, Number(syncGet(isAnime ? "syncIntervalAnime" : "syncIntervalManga")) || 6);
			const last = Number(syncStore.get(`last_run_${t}`, 0)) || 0;
			if (retryAt > 0 ? !last || Date.now() - last * 1e3 >= RETRY_AFTER_FAILURE_MS : !last || Date.now() - last * 1e3 >= hours * 36e5) dueTypes.push(t);
		}
		if (dueTypes.length > 0) {
			const labels = dueTypes.map(typeLabel).join(" & ");
			log(retryAt > 0 ? `Auto-sync (${labels}): retrying after an earlier failure…` : `Auto-sync (${labels}): interval reached or initial sync…`);
			syncStatus.autoSyncRetryAfter = Date.now() + 3e5;
			runSync(dueTypes, { signal });
		} else if (retryAt > 0 && Date.now() >= retryAt) syncStore.del("sync_retry_at");
	}
	var panelCtx = null;
	var activeMount = null;
	var routeOwner = null;
	var pendingConfirm = false;
	var buildPanelCss = (sel) => `
  ${sel}{box-sizing:border-box;width:100%;margin-top:12px;padding:12px;border-radius:4px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));font-size:13px;line-height:1.45}
  ${sel} *{box-sizing:border-box}
  ${sel} :focus-visible{outline:2px solid rgb(var(--color-blue));outline-offset:2px}
  .almal-head{display:flex;justify-content:center;margin-bottom:12px}
  .almal-flow{display:flex;align-items:center;gap:8px;min-width:0}
  .almal-arrow{flex:0 0 auto;color:rgb(var(--color-text-lighter));transition:color .2s,opacity .2s}
  .almal-flow--idle .almal-arrow{opacity:.4}
  .almal-flow--busy .almal-arrow{color:rgb(var(--color-blue))}
  .almal-flow--busy .almal-arrow-line{stroke-dasharray:4 5;animation:almal-flow .6s linear infinite}
  @keyframes almal-flow{to{stroke-dashoffset:-9}}
  .almal-chip{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:24px;padding:0 7px;border-radius:5px;color:#fff;font-size:11px;font-weight:800;letter-spacing:.02em;transition:opacity .2s}
  .almal-chip--lg{min-width:40px;height:28px;font-size:12px}
  .almal-chip.is-off{opacity:.4}
  .almal-chip--al{background:#3db4f2}
  .almal-chip--mal{background:#2e51a2}
  .almal-chip--logo{min-width:0;padding:0;background:none}
  .almal-logo{display:block;width:24px;height:24px;border-radius:6px;object-fit:contain}
  .almal-chip--lg .almal-logo{width:30px;height:30px}

  .almal-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:0 14px;border:0;border-radius:4px;background:rgba(var(--color-text),.07);color:rgb(var(--color-text));font:inherit;font-size:13px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:filter .15s,background .15s}
  .almal-btn:hover:not(:disabled){filter:brightness(1.12)}
  .almal-btn:disabled{opacity:.55;cursor:default}
  .almal-btn--primary{background:rgb(var(--color-blue));color:#fff}
  .almal-btn--primary:disabled{opacity:.75}
  .almal-btn--grow{flex:1 1 0;min-width:0;gap:5px;padding:0 8px;white-space:nowrap;overflow:hidden}
  .almal-btn--grow span{min-width:0;overflow:hidden;text-overflow:ellipsis}
  .almal-btn--icon{flex:0 0 34px;width:34px;min-width:34px;padding:0;color:rgb(var(--color-text-lighter))}
  .almal-btn--icon.is-on{background:rgba(var(--color-blue),.18);color:rgb(var(--color-blue))}
  .almal-btn--danger{color:rgb(var(--color-red,224,85,85))}
  .almal-btn--sm{min-height:32px;padding:0 12px;font-size:12px}
  .almal-btn--block{width:100%}
  .almal-actions{display:flex;gap:6px;width:100%;min-width:0}

  .almal-intro{margin:0 0 10px;color:rgb(var(--color-text-lighter));font-size:12px}
  .almal-conn{display:grid;gap:8px}
  .almal-conn-item{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding:10px;border-radius:4px;background:rgb(var(--color-background))}
  .almal-conn-row{display:flex;align-items:center;gap:10px}
  .almal-conn-name{display:flex;flex-direction:column;flex:1;min-width:0;font-weight:600}
  .almal-ok{display:inline-flex;align-items:center;gap:4px;color:rgb(var(--color-green));font-size:11px;font-weight:600}
  .almal-manual{display:flex;gap:6px}
  .almal-manual input{flex:1;min-width:0;height:34px;padding:0 10px;border:1px solid rgba(var(--color-text-lighter),.22);border-radius:4px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));font:inherit;font-size:12px}
  .almal-manual input:focus{outline:none;border-color:rgb(var(--color-blue))}
  .almal-hint{margin-top:10px;color:rgb(var(--color-text-lighter));font-size:12px}
  .almal-hint:empty{display:none}
  .almal-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;margin-top:8px}
  .almal-link{padding:4px 0;border:0;background:none;color:rgb(var(--color-text-lighter));font:inherit;font-size:12px;cursor:pointer}
  .almal-link:hover{color:rgb(var(--color-blue))}

  .almal-progress{height:4px;margin:12px 0 6px;border-radius:2px;background:rgba(var(--color-text),.09);overflow:hidden}
  #almal-progress-fill{height:100%;width:0%;border-radius:2px;background:rgb(var(--color-blue));transition:width .25s ease}
  #almal-progress-fill.indeterminate{width:40%!important;animation:almal-indeterminate 1.1s ease-in-out infinite}
  @keyframes almal-indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
  #almal-progress-text{color:rgb(var(--color-text-lighter));font-size:12px}
  .almal-meta{display:grid;gap:3px;margin-top:10px;color:rgb(var(--color-text-lighter));font-size:12px;text-align:center}
  .almal-meta-row{white-space:nowrap}
  .almal-meta-row time{color:rgb(var(--color-text))}

  #almal-api-limit-warning{margin-top:10px;padding:8px 10px;border-radius:4px;border-left:3px solid rgb(var(--color-red,224,85,85));background:rgba(var(--color-red,224,85,85),.1);font-size:12px;line-height:1.45}
  #almal-log{max-height:220px;margin-top:10px;padding:8px 10px;border-radius:4px;background:rgb(var(--color-background));color:rgb(var(--color-text-lighter));font:11px/1.55 SFMono-Regular,Consolas,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;overflow-y:auto}

  @media (pointer:coarse){
    .almal-btn{min-height:44px}
    .almal-btn--icon{flex-basis:44px;width:44px;min-width:44px}
    .almal-btn--sm{min-height:40px}
    .almal-manual input{height:40px;font-size:16px}
    .almal-link{padding:8px 0}
  }
  @media (prefers-reduced-motion:reduce){.almal-arrow-line,#almal-progress-fill.indeterminate{animation:none}}`;
	var ui = {
		manual: false,
		showLogs: false
	};
	var progressTimer = null;
	function updateProgressUI(force = false, targetEl) {
		if (!panelCtx || panelCtx.signal.aborted) return;
		if (!force) {
			if (!progressTimer) progressTimer = panelCtx.timeout(() => {
				progressTimer = null;
				updateProgressUI(true);
			}, 120);
			return;
		}
		const panelEl = targetEl ?? activeMount?.el() ?? null;
		renderRateLimitWarning(panelEl);
		const fill = panelEl?.querySelector("#almal-progress-fill") ?? null;
		const text = panelEl?.querySelector("#almal-progress-text") ?? null;
		if (!fill || !text) return;
		if (progress.phase === "fetching") {
			fill.style.width = "100%";
			fill.classList.add("indeterminate");
			text.textContent = "Checking AniList and MAL for changes…";
		} else if (progress.phase === "pushing") {
			fill.classList.remove("indeterminate");
			fill.style.width = (progress.total ? Math.round(progress.done / progress.total * 100) : 100) + "%";
			text.textContent = `Updating MAL: ${progress.done} / ${progress.total} checked (${progress.changed} changes)`;
		}
	}
	function renderRateLimitWarning(panelEl) {
		if (!panelEl || !panelEl.isConnected || panelCtx?.signal.aborted) return;
		const now = Date.now();
		const limited = [["AniList", panelCtx?.api.resumeAt() ?? 0], ["MAL", malLimiter.resumeAt]].filter(([, at]) => Number(at) > now);
		let warn = panelEl.querySelector("#almal-api-limit-warning");
		if (!limited.length) {
			panelEl._limitCancel?.();
			panelEl._limitCancel = null;
			warn?.remove();
			return;
		}
		if (!warn) {
			warn = document.createElement("div");
			warn.id = "almal-api-limit-warning";
			const logBox = panelEl.querySelector("#almal-log");
			if (logBox) logBox.before(warn);
			else panelEl.appendChild(warn);
		}
		warn.innerHTML = limited.map(([name, at]) => `<b>${name} API limit reached.</b> Requests resume in <b>${Math.ceil((Number(at) - now) / 1e3)}s</b>.`).join("<br>");
		panelEl._limitCancel?.();
		panelEl._limitCancel = panelCtx?.timeout(() => {
			panelEl._limitCancel = null;
			renderRateLimitWarning(panelEl);
		}, 1e3) ?? null;
	}
	var LOGOS = {
		al: {
			src: "https://anilist.co/img/icons/android-chrome-512x512.png",
			alt: "https://anilist.co/img/icons/favicon-32x32.png"
		},
		mal: {
			src: "https://cdn.myanimelist.net/img/sp/icon/apple-touch-icon-256.png",
			alt: "https://myanimelist.net/images/favicon.ico"
		}
	};
	var chip = (svc, large, off) => `<span class="almal-chip almal-chip--${svc} almal-chip--logo${large ? " almal-chip--lg" : ""}${off ? " is-off" : ""}" aria-hidden="true"><img class="almal-logo" src="${LOGOS[svc].src}" alt="" decoding="async" data-alt="${LOGOS[svc].alt}" data-fallback="${svc === "al" ? "AL" : "MAL"}"></span>`;
	var ARROW = "<svg class=\"almal-arrow\" viewBox=\"0 0 40 16\" width=\"40\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><line class=\"almal-arrow-line\" x1=\"2\" y1=\"8\" x2=\"34\" y2=\"8\"/><polyline points=\"30 3 36 8 30 13\"/></svg>";
	function ago(sec) {
		if (!sec) return "never";
		const s = Math.max(0, Math.floor(Date.now() / 1e3 - sec));
		if (s < 45) return "just now";
		if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
		if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
		return `${Math.floor(s / 86400)} d ago`;
	}
	var timeEl = (sec) => `<time data-ts="${sec || 0}" title="${sec ? esc(new Date(sec * 1e3).toLocaleString()) : ""}">${ago(sec)}</time>`;
	var refreshTimes = () => activeMount?.el()?.querySelectorAll("time[data-ts]").forEach((el) => {
		el.textContent = ago(Number(el.dataset.ts));
	});
	function connItem(connected) {
		const manual = ui.manual && !connected ? `<div class="almal-manual"><input id="almal-mal-manual" type="text" placeholder="Paste code" aria-label="MyAnimeList authorization code" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="almal-btn almal-btn--sm" data-act="mal-manual-save">Save</button></div>` : "";
		const status = connected ? `<span class="almal-ok">${icon("check", 12)}Connected</span>` : "";
		const connect = connected ? "" : `<button class="almal-btn almal-btn--primary almal-btn--sm almal-btn--block" data-act="mal-connect">Connect MyAnimeList</button>`;
		return `<div class="almal-conn-item"><div class="almal-conn-row">${chip("mal", true)}<span class="almal-conn-name"><span>MyAnimeList</span>${status}</span></div>${connect}${manual}</div>`;
	}
	function renderPanelTo(panelEl) {
		if (!panelCtx || panelCtx.signal.aborted) return;
		const alOk = panelCtx.api.hasAuth();
		const malOk = panelCtx.accounts.isConnected("mal");
		const ready = alOk && malOk;
		const tone = syncStatus.syncing ? "busy" : ready ? "ok" : "idle";
		let html = `<div class="almal-head"><div class="almal-flow almal-flow--${tone}" role="img" aria-label="${{
			busy: "Syncing from AniList to MyAnimeList",
			ok: "AniList to MyAnimeList sync",
			idle: !alOk ? "Log in to AniList to sync" : "Connect MyAnimeList to sync"
		}[tone]}">${chip("al", false, !alOk)}${ARROW}${chip("mal", false, !malOk)}</div></div>`;
		if (ready) {
			const t = currentListType();
			const rows = (t ? [[t, "Last sync"]] : [["ANIME", "Anime sync"], ["MANGA", "Manga sync"]]).map(([type, label]) => `<div class="almal-meta-row">${label}: ${timeEl(syncStore.get("last_run_" + type, 0))}</div>`).join("");
			html += `<div class="almal-actions">
        ${syncStatus.syncing ? `<button class="almal-btn almal-btn--icon almal-btn--danger" data-act="stop" ${syncStatus.cancelled ? "disabled" : ""} aria-label="${syncStatus.cancelled ? "Stopping" : "Stop sync"}" title="${syncStatus.cancelled ? "Stopping…" : "Stop sync"}">${icon("stop", 16)}</button>` : `<button class="almal-btn almal-btn--icon" data-act="resync" ${pendingConfirm ? "disabled" : ""} aria-label="Full resync" title="Full resync">${icon("resync", 16)}</button>`}
        <button class="almal-btn almal-btn--primary almal-btn--grow" data-act="sync" ${syncStatus.syncing || pendingConfirm ? "disabled" : ""}><span>${syncStatus.syncing ? "Syncing…" : "Sync"}</span></button>
        <button class="almal-btn almal-btn--icon${ui.showLogs ? " is-on" : ""}" data-act="logs" aria-label="Show logs" aria-pressed="${ui.showLogs}" title="Logs">${icon("list", 16)}</button>
      </div>`;
			if (syncStatus.syncing) html += "<div class=\"almal-progress\" role=\"progressbar\" aria-label=\"Sync progress\"><div id=\"almal-progress-fill\"></div></div><div id=\"almal-progress-text\">Starting…</div>";
			html += `<div class="almal-meta">${rows}</div>`;
		} else if (!alOk) html += `<p class="almal-intro">Log in to AniList to sync your list to MyAnimeList.</p>
      <div class="almal-conn">
        <a class="almal-btn almal-btn--primary almal-btn--sm almal-btn--block" href="/login" target="_blank" style="text-decoration:none;color:#fff;text-align:center;">Log in to AniList</a>
      </div>
      <div id="almal-hint" class="almal-hint" role="status">${esc(lastNotice)}</div>
      <div class="almal-foot">
        <button class="almal-link" data-act="logs" aria-expanded="${ui.showLogs}">${ui.showLogs ? "Hide logs" : "Logs"}</button>
      </div>`;
		else html += `<p class="almal-intro">Connect your MyAnimeList account to copy your AniList list to MyAnimeList.</p>
      <div class="almal-conn">${connItem(malOk)}</div>
      <div id="almal-hint" class="almal-hint" role="status">${esc(lastNotice)}</div>
      <div class="almal-foot">
        <button class="almal-link" data-act="manual-toggle" aria-expanded="${ui.manual}">${ui.manual ? "Hide manual entry" : "Trouble connecting?"}</button>
        <button class="almal-link" data-act="logs" aria-expanded="${ui.showLogs}">${ui.showLogs ? "Hide logs" : "Logs"}</button>
      </div>`;
		if (ui.showLogs) html += "<div id=\"almal-log\"></div>";
		panelEl.innerHTML = html;
		panelEl.querySelectorAll("img.almal-logo").forEach((img) => img.addEventListener("error", () => {
			if (img.dataset.alt) {
				const next = img.dataset.alt;
				img.dataset.alt = "";
				img.src = next;
				return;
			}
			const c = img.parentElement;
			if (!c) return;
			c.classList.remove("almal-chip--logo");
			c.textContent = img.dataset.fallback || "";
		}));
		const logBox = panelEl.querySelector("#almal-log");
		if (logBox) logBox.textContent = logLines.join("\n") || "No activity yet.";
		if (syncStatus.syncing) updateProgressUI(true, panelEl);
		renderRateLimitWarning(panelEl);
	}
	function renderPanel() {
		const panelEl = activeMount?.el() ?? null;
		if (panelEl) renderPanelTo(panelEl);
	}
	var tryAutoSync = (signal) => {
		if (!pendingConfirm) maybeAutoSync(signal);
	};
	var ACTIONS = {
		"mal-connect": () => panelCtx?.accounts.connect("mal"),
		"manual-toggle": () => {
			ui.manual = !ui.manual;
			renderPanel();
		},
		"mal-manual-save": async () => {
			const code = document.getElementById("almal-mal-manual")?.value.trim();
			if (!code) return;
			const ctxRef = panelCtx;
			const btn = activeMount?.el()?.querySelector("[data-act=\"mal-manual-save\"]");
			if (btn?.disabled) return;
			if (btn) btn.disabled = true;
			try {
				await exchangeMalCode(code);
				log("MAL connected (manual).");
				if (panelCtx !== ctxRef || ctxRef?.signal.aborted) return;
				renderPanel();
				tryAutoSync(ctxRef?.signal);
			} catch (e) {
				log("MAL token exchange failed: " + (e?.message || e), "error");
			} finally {
				if (panelCtx === ctxRef && !ctxRef?.signal.aborted && btn?.isConnected) btn.disabled = false;
			}
		},
		sync: async () => {
			const ctxRef = panelCtx;
			if (!ctxRef || ctxRef.signal.aborted || pendingConfirm) return;
			pendingConfirm = true;
			const panelEl = activeMount?.el();
			const syncBtn = panelEl?.querySelector("[data-act=\"sync\"]");
			const resyncBtn = panelEl?.querySelector("[data-act=\"resync\"]");
			if (syncBtn) syncBtn.disabled = true;
			if (resyncBtn) resyncBtn.disabled = true;
			try {
				await startManualSync(ctxRef.signal);
			} finally {
				if (panelCtx === ctxRef) {
					pendingConfirm = false;
					if (!ctxRef.signal.aborted && !syncStatus.syncing) {
						const curPanel = activeMount?.el();
						const curSync = curPanel?.querySelector("[data-act=\"sync\"]");
						const curResync = curPanel?.querySelector("[data-act=\"resync\"]");
						if (curSync) curSync.disabled = false;
						if (curResync) curResync.disabled = false;
					}
				}
			}
		},
		stop: () => {
			if (syncStatus.syncing && !syncStatus.cancelled) {
				syncStatus.cancelled = true;
				log("Stop requested. Waiting for the current API requests to finish…", "warn");
				renderPanel();
			}
		},
		resync: async () => {
			const ctxRef = panelCtx;
			if (!ctxRef || ctxRef.signal.aborted || pendingConfirm) return;
			pendingConfirm = true;
			const panelEl = activeMount?.el();
			const resyncBtn = panelEl?.querySelector("[data-act=\"resync\"]");
			const syncBtn = panelEl?.querySelector("[data-act=\"sync\"]");
			if (resyncBtn) resyncBtn.disabled = true;
			if (syncBtn) syncBtn.disabled = true;
			try {
				const confirmed = await ctxRef.confirm({
					id: "full-resync-confirm",
					title: "Full Resync",
					message: "This will re-check your entire AniList library against MAL. Continue?",
					confirmText: "Continue",
					cancelText: "Cancel"
				});
				if (panelCtx !== ctxRef || ctxRef.signal.aborted || !confirmed) return;
				await fullResync(ctxRef.signal);
			} finally {
				if (panelCtx === ctxRef) {
					pendingConfirm = false;
					if (!ctxRef.signal.aborted && !syncStatus.syncing) {
						const curPanel = activeMount?.el();
						const curResync = curPanel?.querySelector("[data-act=\"resync\"]");
						const curSync = curPanel?.querySelector("[data-act=\"sync\"]");
						if (curResync) curResync.disabled = false;
						if (curSync) curSync.disabled = false;
					}
				}
			}
		},
		logs: () => {
			ui.showLogs = !ui.showLogs;
			renderPanel();
		}
	};
	var selfLookup = false;
	function decodeOwner(raw) {
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}
	function findPanelAnchor() {
		const shuffle = document.querySelector("[title*=\"Random List Entry\" i], [aria-label*=\"Random List Entry\" i]");
		if (shuffle) return shuffle.parentElement || shuffle;
		if (!document.body) return null;
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let t; t = walker.nextNode();) {
			const el = t.parentElement;
			if (t.nodeValue?.trim() === "Sort" && el?.matches("div, section, aside") && el.parentElement) return el.parentElement;
		}
		return null;
	}
	function isOwnList() {
		let owner = routeOwner || "";
		if (!owner) {
			const m = location.pathname.match(/^\/user\/([^/]+)\/(?:anime|manga)list\/?$/i);
			if (!m) return false;
			owner = decodeOwner(m[1]);
		}
		const me = panelCtx?.session.username || "";
		if (!me && panelCtx?.api.hasAuth() && !selfLookup) {
			selfLookup = true;
			const ctxRef = panelCtx;
			tryOr(() => ctxRef.api.viewer()).then((v) => {
				if (panelCtx !== ctxRef || ctxRef.signal.aborted) return;
				if (v) activeMount?.refresh();
			}).finally(() => {
				if (panelCtx === ctxRef) selfLookup = false;
			});
		}
		return !!me && me.toLowerCase() === owner.toLowerCase();
	}
	var onListRoute = () => !!panelCtx && !panelCtx.signal.aborted && !!panelCtx.get("syncEnabled") && LIST_PATH_RE.test(location.pathname) && isOwnList();
	function createPanelEl() {
		const panelEl = document.createElement("div");
		panelEl.addEventListener("click", (e) => {
			const a = e.target?.closest("[data-act]");
			if (a && a.dataset.act && ACTIONS[a.dataset.act]) ACTIONS[a.dataset.act]();
		});
		panelEl.addEventListener("keydown", (e) => {
			const target = e.target;
			if (e.key === "Enter" && target?.id === "almal-mal-manual") ACTIONS["mal-manual-save"]();
		});
		return panelEl;
	}
	function initSyncPanel(ctx) {
		panelCtx = ctx;
		pendingConfirm = false;
		setSyncConfirm((opts) => ctx.confirm(opts));
		ctx.onCleanup(setMalUiSink({
			onLog: () => {
				const panelEl = activeMount?.el() ?? null;
				const hint = panelEl?.querySelector("#almal-hint");
				if (hint) hint.textContent = lastNotice;
				const logBox = panelEl?.querySelector("#almal-log");
				if (logBox) logBox.textContent = logLines.join("\n") || "No activity yet.";
			},
			onToast: (msg, isError, closeTab) => {
				ctx.toast.show(msg, {
					type: isError ? "error" : "success",
					closeTab
				});
			}
		}));
		ctx.onCleanup(onProgressChange((force) => updateProgressUI(force)));
		ctx.onCleanup(onStateChange(renderPanel));
		ctx.interval(() => tryAutoSync(ctx.signal), 6e4);
		ctx.ready(() => tryAutoSync(ctx.signal));
		ctx.onRoute(/^\/user\/([^/]+)\/(?:anime|manga)list\/?$/i, (rc) => {
			routeOwner = decodeOwner(rc.match[1]);
			activeMount = rc.mount({
				id: "panel",
				anchor: findPanelAnchor,
				position: "afterend",
				match: onListRoute,
				ownUi: true,
				style: buildPanelCss,
				create: createPanelEl,
				onMount: (el) => {
					renderPanelTo(el);
					return () => {
						el._limitCancel?.();
						el._limitCancel = null;
					};
				}
			});
			rc.onCleanup(ctx.accounts.watch("mal", () => renderPanel()));
			let lastAl = null;
			let lastMal = null;
			rc.interval(() => {
				const al = ctx.api.hasAuth();
				const mal = ctx.accounts.isConnected("mal");
				if (al !== lastAl || mal !== lastMal) {
					lastAl = al;
					lastMal = mal;
					renderPanel();
				}
				refreshTimes();
				activeMount?.refresh();
				tryAutoSync(ctx.signal);
			}, 2e3);
			return () => {
				progressTimer?.();
				progressTimer = null;
				routeOwner = null;
				activeMount = null;
			};
		});
		ctx.onCleanup(() => {
			progressTimer?.();
			progressTimer = null;
			routeOwner = null;
			activeMount = null;
			selfLookup = false;
			pendingConfirm = false;
			if (panelCtx === ctx) {
				setSyncConfirm(null);
				panelCtx = null;
			}
		});
	}
	var buildOverridesCss = (sel, fullHeight) => `
  ${fullHeight ? `${sel} .ala-core-sheet{height:100%}` : ""}
  ${sel} .ala-ov-tabs{display:flex;gap:6px;margin-bottom:16px;border-bottom:1px solid rgba(var(--color-text-lighter),.14);padding-bottom:10px}
  ${sel} .ala-ov-tab{padding:6px 14px;border:0;border-radius:4px;background:transparent;color:rgb(var(--color-text-lighter));font:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s}
  ${sel} .ala-ov-tab:hover{color:rgb(var(--color-text));background:rgba(var(--color-text-lighter),.1)}
  ${sel} .ala-ov-tab.is-active{color:#fff;background:rgb(var(--color-blue))}

  ${sel} .ala-ov-form-box{padding:14px;border-radius:6px;background:rgb(var(--color-background));margin-bottom:18px}
  ${sel} .ala-ov-form-title{margin:0 0 10px;font-size:13px;font-weight:600;color:rgb(var(--color-blue))}
  ${sel} .ala-ov-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
  ${sel} .ala-ov-field label{font-size:12px;color:rgb(var(--color-text-lighter))}
  ${sel} .ala-ov-input{width:100%;height:36px;padding:0 10px;border:1px solid rgba(var(--color-text-lighter),.22);border-radius:4px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));font:inherit;font-size:13px}
  ${sel} .ala-ov-input:focus{outline:none;border-color:rgb(var(--color-blue))}

  ${sel} .ala-ov-textarea{width:100%;height:320px;padding:10px;border:1px solid rgba(var(--color-text-lighter),.22);border-radius:4px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));font-family:monospace,Consolas,Courier,monospace;font-size:12px;line-height:1.4;resize:vertical;tab-size:2}
  ${sel} .ala-ov-textarea:focus{outline:none;border-color:rgb(var(--color-blue))}

  ${sel} .ala-ov-status{padding:8px 12px;border-radius:4px;font-size:12px;margin-top:10px;display:none}
  ${sel} .ala-ov-status--success{background:rgba(var(--color-green,70,211,105),.15);color:rgb(var(--color-green,70,211,105));border:1px solid rgba(var(--color-green,70,211,105),.3)}
  ${sel} .ala-ov-status--error{background:rgba(var(--color-red,235,87,87),.15);color:rgb(var(--color-red,235,87,87));border:1px solid rgba(var(--color-red,235,87,87),.3)}

  ${sel} .ala-ov-preview{display:flex;gap:12px;align-items:center;padding:10px;margin:8px 0 12px;border-radius:6px;background:rgba(var(--color-text-lighter),.06);min-height:56px}
  ${sel} .ala-ov-preview-cover{width:40px;height:54px;border-radius:3px;object-fit:cover;background:rgba(var(--color-text-lighter),.2)}
  ${sel} .ala-ov-preview-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
  ${sel} .ala-ov-preview-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  ${sel} .ala-ov-preview-meta{display:flex;gap:6px;align-items:center;font-size:11px;color:rgb(var(--color-text-lighter))}
  ${sel} .ala-ov-badge{padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;text-transform:uppercase;background:rgba(var(--color-blue),.15);color:rgb(var(--color-blue))}
  ${sel} .ala-ov-badge--manga{background:rgba(235,108,133,.15);color:#eb6c85}
  ${sel} .ala-ov-badge--ignored{background:rgba(var(--color-text-lighter),.2);color:rgb(var(--color-text-lighter))}

  ${sel} .ala-ov-form-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}

  ${sel} .ala-ov-controls{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
  ${sel} .ala-ov-search-input{flex:1 1 180px;height:32px;font-size:12px;padding:0 8px}
  ${sel} .ala-ov-filter-groups{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  ${sel} .ala-ov-filter-group{display:flex;gap:4px;align-items:center}
  ${sel} .ala-ov-filter-label{font-size:11px;color:rgb(var(--color-text-lighter));margin-right:2px}

  ${sel} .ala-ov-chip{padding:3px 8px;border:1px solid rgba(var(--color-text-lighter),.2);border-radius:12px;background:transparent;color:rgb(var(--color-text-lighter));font-size:11px;cursor:pointer;transition:all .15s}
  ${sel} .ala-ov-chip.is-active{background:rgba(var(--color-blue),.2);border-color:rgb(var(--color-blue));color:rgb(var(--color-blue));font-weight:600}

  ${sel} .ala-ov-list{display:grid;gap:8px;min-width:0;}
  ${sel} .ala-ov-item{display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:6px;background:rgb(var(--color-background));transition:background .15s;min-width:0;max-width:100%;}
  ${sel} .ala-ov-item:hover{background:rgba(var(--color-text-lighter),.08)}
  ${sel} .ala-ov-item-cover{width:36px;height:48px;border-radius:3px;object-fit:cover;background:rgba(var(--color-text-lighter),.2);flex-shrink:0}
  ${sel} .ala-ov-item-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
  ${sel} .ala-ov-item-title{display:block;width:100%;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:inherit;text-decoration:none}
  ${sel} .ala-ov-item-title:hover{color:rgb(var(--color-blue))}
  ${sel} .ala-ov-item-meta{display:flex;gap:8px;align-items:center;font-size:11px;color:rgb(var(--color-text-lighter));flex-wrap:wrap}
  ${sel} .ala-ov-item-meta a{color:rgb(var(--color-blue));text-decoration:none}
  ${sel} .ala-ov-item-meta a:hover{text-decoration:underline}
  ${sel} .ala-ov-item-actions{display:flex;gap:6px;align-items:center;flex-shrink:0}

  ${sel} .ala-ov-empty{padding:24px 10px;text-align:center;color:rgb(var(--color-text-lighter));font-size:13px}

  ${sel} .ala-ov-audit-section{margin-bottom:20px}
  ${sel} .ala-ov-audit-title{font-size:13px;font-weight:600;color:rgb(var(--color-blue));margin:0 0 8px}

  @media (max-width:700px){
    ${sel}{align-items:flex-end;padding:0}
    ${sel} .ala-core-sheet{width:100%;${fullHeight ? "height:92vh;height:92dvh;" : ""}max-height:92vh;max-height:92dvh;border-radius:14px 14px 0 0}
    ${sel} .ala-core-head{padding:14px 16px}
    ${sel} .ala-core-body{padding:12px 16px}
    ${sel} .ala-core-foot{padding:10px 16px calc(10px + env(safe-area-inset-bottom, 0px))}
    ${sel} .ala-core-foot .ala-btn{width:100%;min-height:42px;justify-content:center}

    ${sel} .ala-ov-form-actions{flex-direction:column;gap:8px;width:100%}
    ${sel} .ala-ov-form-actions .ala-btn{width:100%;min-height:42px;margin-left:0!important;justify-content:center;text-align:center}

    ${sel} .ala-ov-controls{flex-direction:column;align-items:stretch;gap:8px}
    ${sel} .ala-ov-search-input{width:100%;flex:none;height:36px;font-size:14px}
    ${sel} .ala-ov-filter-groups{width:100%;flex-direction:column;align-items:flex-start;gap:6px}
    ${sel} .ala-ov-filter-group{width:100%;flex-wrap:wrap}

    ${sel} .ala-ov-item{flex-wrap:wrap;align-items:flex-start;gap:8px 10px;padding:10px}
    ${sel} .ala-ov-item-cover{width:36px;height:48px}
    ${sel} .ala-ov-item-info{flex:1 1 calc(100% - 48px);min-width:0}
    ${sel} .ala-ov-item-actions{width:100%;display:flex;gap:8px;margin-top:4px;padding-top:6px;border-top:1px solid rgba(var(--color-text-lighter),.1)}
    ${sel} .ala-ov-item-actions .ala-btn{flex:1 1 0;min-height:36px;justify-content:center;text-align:center;font-size:13px}
    ${sel} .ala-ov-item-actions .ala-icon-btn{flex:0 0 36px;height:36px}
  }
  `;
	function extractAlId(raw) {
		const str = String(raw || "").trim();
		const match = str.match(/(?:anime|manga)\/(\d+)/i) || str.match(/^(\d+)$/);
		return match ? Number(match[1]) : 0;
	}
	function extractMalId(raw) {
		const str = String(raw || "").trim();
		const match = str.match(/myanimelist\.net\/(?:anime|manga)\/(\d+)/i) || str.match(/^(\d+)$/);
		return match ? Number(match[1]) : 0;
	}
	function matchesSearch(text, id, extraId, query) {
		if (!query) return true;
		const q = query.trim().toLowerCase();
		if (!q) return true;
		if (String(id).includes(q)) return true;
		if (extraId != null && String(extraId).includes(q)) return true;
		const t = (text || "").toLowerCase();
		if (t.includes(q)) return true;
		let qIdx = 0;
		for (let i = 0; i < t.length && qIdx < q.length; i++) if (t[i] === q[qIdx]) qIdx++;
		return qIdx === q.length;
	}
	var safeCoverUrl = (url) => {
		const trimmed = String(url || "").trim();
		return /^https?:\/\//i.test(trimmed) ? trimmed : "";
	};
	var unmatchedMetaCache = new Map();
	async function batchFetchUnmatchedMeta(ids, log, api = syncApi, signal) {
		const needed = ids.filter((id) => id > 0 && !unmatchedMetaCache.has(id));
		if (!needed.length || signal?.aborted) return;
		for (let i = 0; i < needed.length; i += 50) {
			if (signal?.aborted) break;
			const batch = needed.slice(i, i + 50);
			const q = `query ($ids: [Int]) {
      Page(page: 1, perPage: 50) {
        media(id_in: $ids) {
          id
          title { userPreferred english romaji }
          coverImage { medium }
        }
      }
    }`;
			try {
				const res = await api?.query(q, { ids: batch }, { signal });
				if (signal?.aborted) break;
				const list = res?.Page?.media || [];
				for (const m of list) {
					const t = m.title?.userPreferred || m.title?.english || m.title?.romaji || `Media #${m.id}`;
					unmatchedMetaCache.set(m.id, {
						title: t,
						cover: m.coverImage?.medium
					});
				}
			} catch (e) {
				if (signal?.aborted || isAbortError(e)) break;
				log?.warn("Failed to batch fetch unmatched metadata:", e);
				break;
			}
		}
	}
	async function openQuickOverrideModal(mediaId, mediaType = "ANIME", ctx, onUpdated) {
		if (ctx.signal?.aborted) return;
		const api = ctx.api ?? syncApi;
		const existingOverride = getManualOverrides()[String(mediaId)];
		const { backdrop, close, signal, listen, onCleanup } = ctx.modal({
			id: "quick-override",
			title: "Set MAL Mapping",
			maxWidth: "480px",
			style: (sel) => buildOverridesCss(sel, false),
			bodyHtml: `
      <div id="ala-qo-preview" class="ala-ov-preview">
        <span style="font-size:12px;color:rgb(var(--color-text-lighter))">Loading entry details...</span>
      </div>

      <div class="ala-ov-field">
        <label for="ala-qo-mal-input">Custom MyAnimeList ID or URL</label>
        <input type="text" id="ala-qo-mal-input" class="ala-ov-input" placeholder="e.g. 16498 or https://myanimelist.net/anime/16498" autocomplete="off">
      </div>

      <div class="ala-ov-form-actions">
        <button type="button" class="ala-btn ala-btn--primary" id="ala-qo-btn-save">Save Override</button>
        <button type="button" class="ala-btn" id="ala-qo-btn-ignore" title="Prevent this entry from ever syncing to MAL without warnings">Mark as AniList-Only</button>
        ${existingOverride ? `<button type="button" class="ala-btn ala-btn--danger" id="ala-qo-btn-remove" style="margin-left:auto">Reset to Default</button>` : ""}
      </div>
    `,
			footerHtml: `<button class="ala-btn ala-qo-close" type="button" data-ala-close>Cancel</button>`
		});
		const isClosed = () => signal.aborted || !!ctx.signal?.aborted || !backdrop.isConnected;
		if (isClosed()) return;
		const composedQuick = composeAbortSignals(signal, ctx.signal);
		const quickSignal = composedQuick.signal;
		onCleanup(composedQuick.dispose);
		const previewBox = backdrop.querySelector("#ala-qo-preview");
		const malInput = backdrop.querySelector("#ala-qo-mal-input");
		const saveBtn = backdrop.querySelector("#ala-qo-btn-save");
		const ignoreBtn = backdrop.querySelector("#ala-qo-btn-ignore");
		const removeBtn = backdrop.querySelector("#ala-qo-btn-remove");
		if (existingOverride && existingOverride.malId > 0) malInput.value = String(existingOverride.malId);
		let loadedTitle = existingOverride?.title || `Media #${mediaId}`;
		let loadedCover = safeCoverUrl(existingOverride?.cover) || void 0;
		let loadedType = existingOverride?.type || mediaType;
		let detectedMalId;
		const q = `query ($id: Int) {
    Media(id: $id) {
      id
      idMal
      type
      title { userPreferred english romaji }
      coverImage { medium }
    }
  }`;
		try {
			const res = await api?.query(q, { id: mediaId }, { signal: quickSignal });
			if (isClosed()) return;
			const m = res?.Media;
			if (m) {
				loadedTitle = m.title?.userPreferred || m.title?.english || m.title?.romaji || loadedTitle;
				loadedCover = safeCoverUrl(m.coverImage?.medium) || loadedCover;
				loadedType = m.type === "MANGA" ? "MANGA" : "ANIME";
				detectedMalId = Number(m.idMal) || void 0;
			}
		} catch (_) {
			if (isClosed()) return;
		}
		if (isClosed()) return;
		const isIgnored = existingOverride && existingOverride.malId === 0;
		const isCustom = existingOverride && existingOverride.malId > 0;
		const safeLoadedCover = safeCoverUrl(loadedCover);
		previewBox.innerHTML = `
    ${safeLoadedCover ? `<img class="ala-ov-preview-cover" src="${esc(safeLoadedCover)}" alt="">` : `<div class="ala-ov-preview-cover"></div>`}
    <div class="ala-ov-preview-info">
      <div class="ala-ov-preview-title">${esc(loadedTitle)}</div>
      <div class="ala-ov-preview-meta">
        <span class="ala-ov-badge ${loadedType === "MANGA" ? "ala-ov-badge--manga" : ""}">${esc(loadedType)}</span>
        ${isIgnored ? `<span class="ala-ov-badge ala-ov-badge--ignored">Currently: AniList-Only</span>` : isCustom ? `<span>Overridden to MAL ID: <b>${esc(existingOverride.malId)}</b></span>` : detectedMalId ? `<span>Detected MAL ID: <b>${esc(detectedMalId)}</b></span>` : `<span>No MAL ID on AniList</span>`}
      </div>
    </div>
  `;
		if (detectedMalId && !malInput.value) malInput.placeholder = `${detectedMalId} (AniList default)`;
		const showAlert = (message, title = "Notice", id) => {
			if (isClosed()) return Promise.resolve();
			return ctx.alert({
				id,
				title,
				message,
				signal: quickSignal
			});
		};
		listen(saveBtn, "click", async () => {
			if (saveBtn.disabled || isClosed()) return;
			let malId = extractMalId(malInput.value);
			if (!malId && detectedMalId) malId = detectedMalId;
			if (!malId) {
				saveBtn.disabled = true;
				try {
					await showAlert("Please enter a valid MyAnimeList ID or URL.", "Invalid MAL ID", "qo-invalid-mal");
				} finally {
					if (!isClosed()) saveBtn.disabled = false;
				}
				return;
			}
			setOverride(mediaId, {
				malId,
				type: loadedType,
				title: loadedTitle,
				cover: loadedCover
			});
			onUpdated?.();
			close();
		});
		listen(ignoreBtn, "click", () => {
			setOverride(mediaId, {
				malId: 0,
				type: loadedType,
				title: loadedTitle,
				cover: loadedCover
			});
			onUpdated?.();
			close();
		});
		if (removeBtn) listen(removeBtn, "click", () => {
			removeOverride(mediaId);
			onUpdated?.();
			close();
		});
	}
	function openOverridesModal(ec) {
		if (ec.signal?.aborted) return;
		const api = ec.api ?? syncApi;
		const staging = typeof ec?.onApply === "function";
		const initCheck = staging ? validateOverrides(ec.value) : null;
		let draftOverrides = staging ? JSON.parse(JSON.stringify(initCheck?.valid && initCheck.overrides ? initCheck.overrides : {})) : {};
		let cancelLookup = null;
		let cancelSearch = null;
		let cancelUnmatchedSearch = null;
		let cancelOrphansSearch = null;
		let cancelCopyTimer = null;
		const readOverrides = () => staging ? draftOverrides : getManualOverrides();
		const writeOverrides = (next) => {
			if (staging) draftOverrides = next;
			else saveManualOverrides(next);
		};
		const patchOverride = (id, data) => {
			if (!id) return;
			if (staging) draftOverrides = {
				...draftOverrides,
				[String(id)]: {
					...data,
					updatedAt: data.updatedAt || Date.now()
				}
			};
			else setOverride(id, data);
		};
		const deleteOverride = (id) => {
			if (!id) return;
			if (staging) {
				const copy = { ...draftOverrides };
				delete copy[String(id)];
				draftOverrides = copy;
			} else removeOverride(id);
		};
		const importDraftOverrides = (raw, mode = "replace") => {
			if (!staging) return importOverrides(raw, mode);
			const check = validateOverrides(raw);
			if (!check.valid || !check.overrides) return {
				success: false,
				error: check.error || "Validation failed"
			};
			draftOverrides = mode === "merge" ? {
				...draftOverrides,
				...check.overrides
			} : check.overrides;
			return {
				success: true,
				count: Object.keys(check.overrides).length
			};
		};
		let appliedInStaging = false;
		const { backdrop, signal, listen, timeout, onCleanup } = ec.modal({
			id: "overrides",
			title: "Manual Mappings & Sync Audit",
			maxWidth: "680px",
			style: (sel) => buildOverridesCss(sel, true),
			bodyHtml: `
      <div class="ala-ov-tabs">
        <button class="ala-ov-tab is-active" data-tab="overrides" type="button">Overrides & Ignored</button>
        <button class="ala-ov-tab" data-tab="audit" type="button">Sync Audit</button>
        <button class="ala-ov-tab" data-tab="json" type="button">Import / Export</button>
      </div>

      <div id="ala-ov-view-overrides">
        <div class="ala-ov-form-box">
          <h3 class="ala-ov-form-title" id="ala-ov-form-heading">Add or Edit Override</h3>
          <div class="ala-ov-field">
            <label for="ala-ov-al-input">AniList Media ID or URL</label>
            <input type="text" id="ala-ov-al-input" class="ala-ov-input" placeholder="e.g. 16498 or https://anilist.co/anime/16498" autocomplete="off">
          </div>

          <div id="ala-ov-preview" class="ala-ov-preview" style="display:none"></div>

          <div class="ala-ov-field">
            <label for="ala-ov-mal-input">Custom MyAnimeList ID or URL</label>
            <input type="text" id="ala-ov-mal-input" class="ala-ov-input" placeholder="e.g. 16498 or https://myanimelist.net/anime/16498" autocomplete="off">
          </div>

          <div class="ala-ov-form-actions">
            <button type="button" class="ala-btn ala-btn--primary" id="ala-ov-btn-save">Save Override</button>
            <button type="button" class="ala-btn" id="ala-ov-btn-ignore" title="Prevent this entry from ever syncing to MAL without warnings">Mark as AniList-Only (Ignore)</button>
            <button type="button" class="ala-btn" id="ala-ov-btn-clear" style="margin-left:auto">Clear</button>
          </div>
        </div>

        <div class="ala-ov-controls">
          <input type="text" id="ala-ov-search" class="ala-ov-input ala-ov-search-input" placeholder="Search overrides by title or ID..." autocomplete="off">
          <div class="ala-ov-filter-groups">
            <div class="ala-ov-filter-group">
              <span class="ala-ov-filter-label">Status:</span>
              <button class="ala-ov-chip is-active" data-status-filter="all" type="button">All</button>
              <button class="ala-ov-chip" data-status-filter="overrides" type="button">Overrides</button>
              <button class="ala-ov-chip" data-status-filter="ignored" type="button">AniList-Only</button>
            </div>
            <div class="ala-ov-filter-group">
              <span class="ala-ov-filter-label">Type:</span>
              <button class="ala-ov-chip is-active" data-type-filter="all" type="button">All</button>
              <button class="ala-ov-chip" data-type-filter="anime" type="button">Anime</button>
              <button class="ala-ov-chip" data-type-filter="manga" type="button">Manga</button>
            </div>
          </div>
        </div>

        <div style="font-size:12px;font-weight:600;color:rgb(var(--color-text-lighter));margin:0 0 8px" id="ala-ov-count">Configured Entries</div>
        <div id="ala-ov-list" class="ala-ov-list"></div>
      </div>

      <div id="ala-ov-view-audit" style="display:none">
        <div class="ala-ov-audit-section">
          <h3 class="ala-ov-audit-title">Unmatched AniList Entries</h3>
          <p style="font-size:12px;color:rgb(var(--color-text-lighter));margin:0 0 10px">These entries could not be automatically matched to a MAL ID during sync.</p>
          <div class="ala-ov-controls" id="ala-ov-unmatched-controls" style="display:none">
            <input type="text" id="ala-ov-unmatched-search" class="ala-ov-input ala-ov-search-input" placeholder="Search unmatched by title or ID..." autocomplete="off">
            <div class="ala-ov-filter-group">
              <span class="ala-ov-filter-label">Type:</span>
              <button class="ala-ov-chip is-active" data-unmatched-type="all" type="button">All</button>
              <button class="ala-ov-chip" data-unmatched-type="anime" type="button">Anime</button>
              <button class="ala-ov-chip" data-unmatched-type="manga" type="button">Manga</button>
            </div>
          </div>
          <div id="ala-ov-audit-unmatched" class="ala-ov-list"></div>
        </div>

        <div class="ala-ov-audit-section" style="margin-top:24px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <h3 class="ala-ov-audit-title" style="margin:0">Orphaned MyAnimeList Entries</h3>
            <button type="button" class="ala-btn ala-btn--sm" id="ala-ov-btn-scan-orphans">Scan MAL</button>
          </div>
          <p style="font-size:12px;color:rgb(var(--color-text-lighter));margin:0 0 10px">Entries that exist on your MyAnimeList account but are absent from your AniList library.</p>
          <div class="ala-ov-controls" id="ala-ov-orphans-controls" style="display:none">
            <input type="text" id="ala-ov-orphans-search" class="ala-ov-input ala-ov-search-input" placeholder="Search orphans by title or ID..." autocomplete="off">
            <div class="ala-ov-filter-group">
              <span class="ala-ov-filter-label">Type:</span>
              <button class="ala-ov-chip is-active" data-orphans-type="all" type="button">All</button>
              <button class="ala-ov-chip" data-orphans-type="anime" type="button">Anime</button>
              <button class="ala-ov-chip" data-orphans-type="manga" type="button">Manga</button>
            </div>
          </div>
          <div id="ala-ov-audit-orphans" class="ala-ov-list"></div>
        </div>
      </div>

      <div id="ala-ov-view-json" style="display:none">
        <div class="ala-ov-form-box">
          <h3 class="ala-ov-form-title">Raw JSON Overrides</h3>
          <p style="font-size:12px;color:rgb(var(--color-text-lighter));margin:0 0 10px">
            View, copy, or batch edit your manual AniList-to-MAL mappings and ignored entries in JSON format.
          </p>
          <div class="ala-ov-field">
            <label for="ala-ov-json-textarea">Configuration JSON</label>
            <textarea id="ala-ov-json-textarea" class="ala-ov-textarea" spellcheck="false" placeholder="{}"></textarea>
          </div>
          <div id="ala-ov-json-status" class="ala-ov-status"></div>
          <div class="ala-ov-form-actions">
            <button type="button" class="ala-btn ala-btn--primary" id="ala-ov-btn-json-save">Save & Replace</button>
            <button type="button" class="ala-btn" id="ala-ov-btn-json-merge" title="Merge imported entries into current overrides">Merge with Current</button>
            <button type="button" class="ala-btn" id="ala-ov-btn-json-copy">Copy to Clipboard</button>
            <button type="button" class="ala-btn" id="ala-ov-btn-json-reset" style="margin-left:auto">Reset</button>
          </div>
        </div>
      </div>
    `,
			footerHtml: `<button class="ala-btn ala-btn--primary" id="ala-ov-btn-done" type="button" data-ala-close>Done</button>`
		});
		const isClosed = () => signal.aborted || !!ec.signal?.aborted || !backdrop.isConnected;
		if (isClosed()) return;
		const composedMal = composeAbortSignals(signal, ec.signal);
		const malSignal = composedMal.signal;
		onCleanup(composedMal.dispose);
		const showAlert = (message, title = "Notice", id) => {
			if (isClosed()) return Promise.resolve();
			return ec.alert({
				id,
				title,
				message,
				signal: malSignal
			});
		};
		const showConfirm = (opts) => {
			if (isClosed()) return Promise.resolve(false);
			return ec.confirm({
				...opts,
				signal: opts.signal ?? malSignal
			});
		};
		if (!staging) refreshStaleOverrides({ signal: malSignal }).then(() => {
			if (!isClosed()) renderList();
		});
		const doneBtn = backdrop.querySelector("#ala-ov-btn-done");
		if (doneBtn) listen(doneBtn, "click", () => {
			if (staging) {
				appliedInStaging = true;
				ec.onApply(draftOverrides);
			}
		});
		const tabs = backdrop.querySelectorAll(".ala-ov-tab");
		const viewOverrides = backdrop.querySelector("#ala-ov-view-overrides");
		const viewAudit = backdrop.querySelector("#ala-ov-view-audit");
		const viewJson = backdrop.querySelector("#ala-ov-view-json");
		tabs.forEach((t) => {
			listen(t, "click", () => {
				tabs.forEach((o) => o.classList.toggle("is-active", o === t));
				const target = t.dataset.tab;
				viewOverrides.style.display = target === "overrides" ? "block" : "none";
				viewAudit.style.display = target === "audit" ? "block" : "none";
				viewJson.style.display = target === "json" ? "block" : "none";
				if (target === "audit") renderAudit();
				else if (target === "overrides") renderList();
				else if (target === "json") renderJsonView();
			});
		});
		let activePreview = null;
		let statusFilter = "all";
		let typeFilter = "all";
		let searchQuery = "";
		const alInput = backdrop.querySelector("#ala-ov-al-input");
		const malInput = backdrop.querySelector("#ala-ov-mal-input");
		const previewBox = backdrop.querySelector("#ala-ov-preview");
		const listContainer = backdrop.querySelector("#ala-ov-list");
		const countLabel = backdrop.querySelector("#ala-ov-count");
		const searchInput = backdrop.querySelector("#ala-ov-search");
		const updatePreviewUI = (loading = false) => {
			if (loading) {
				previewBox.style.display = "flex";
				previewBox.innerHTML = `<span style="font-size:12px;color:rgb(var(--color-text-lighter))">Looking up AniList entry...</span>`;
				return;
			}
			if (!activePreview) {
				previewBox.style.display = "none";
				previewBox.innerHTML = "";
				malInput.placeholder = "e.g. 16498 or https://myanimelist.net/anime/16498";
				return;
			}
			const { type, title, cover, detectedMalId } = activePreview;
			const safeCover = safeCoverUrl(cover);
			previewBox.style.display = "flex";
			previewBox.innerHTML = `
      ${safeCover ? `<img class="ala-ov-preview-cover" src="${esc(safeCover)}" alt="">` : `<div class="ala-ov-preview-cover"></div>`}
      <div class="ala-ov-preview-info">
        <div class="ala-ov-preview-title">${esc(title)}</div>
        <div class="ala-ov-preview-meta">
          <span class="ala-ov-badge ${type === "MANGA" ? "ala-ov-badge--manga" : ""}">${esc(type)}</span>
          ${detectedMalId ? `<span>Detected MAL ID: <b>${esc(detectedMalId)}</b></span>` : `<span>No MAL ID on AniList</span>`}
        </div>
      </div>
    `;
			if (detectedMalId && !malInput.value) malInput.placeholder = `${detectedMalId} (AniList default)`;
		};
		let lookupSeq = 0;
		const doLookup = async (id) => {
			const seq = ++lookupSeq;
			if (!id) {
				activePreview = null;
				updatePreviewUI();
				return;
			}
			const existing = readOverrides()[String(id)];
			if (existing) {
				activePreview = {
					mediaId: id,
					type: existing.type,
					title: existing.title,
					cover: existing.cover,
					detectedMalId: existing.malId > 0 ? existing.malId : void 0
				};
				if (existing.malId > 0 && !malInput.value) malInput.value = String(existing.malId);
				updatePreviewUI();
			} else updatePreviewUI(true);
			const q = `query ($id: Int) {
      Media(id: $id) {
        id
        idMal
        type
        title { userPreferred english romaji }
        coverImage { medium }
      }
    }`;
			try {
				const res = await api?.query(q, { id }, { signal: malSignal });
				if (seq !== lookupSeq || isClosed() || extractAlId(alInput.value) !== id) return;
				const m = res?.Media;
				if (!m) {
					if (!existing) {
						activePreview = null;
						updatePreviewUI();
					}
					return;
				}
				const t = m.title?.userPreferred || m.title?.english || m.title?.romaji || `Media #${m.id}`;
				activePreview = {
					mediaId: m.id,
					type: m.type === "MANGA" ? "MANGA" : "ANIME",
					title: t,
					cover: safeCoverUrl(m.coverImage?.medium) || safeCoverUrl(existing?.cover) || void 0,
					detectedMalId: Number(m.idMal) || void 0
				};
				updatePreviewUI();
				if (existing && existing.malId > 0 && !malInput.value) malInput.value = String(existing.malId);
			} catch (err) {
				if (seq !== lookupSeq || isClosed() || malSignal.aborted || isAbortError(err)) return;
				if (!existing && extractAlId(alInput.value) === id) {
					activePreview = null;
					updatePreviewUI();
				}
			}
		};
		listen(alInput, "input", () => {
			cancelLookup?.();
			cancelLookup = timeout(() => {
				cancelLookup = null;
				const id = extractAlId(alInput.value);
				doLookup(id);
			}, 300);
		});
		const saveBtn = backdrop.querySelector("#ala-ov-btn-save");
		const ignoreBtn = backdrop.querySelector("#ala-ov-btn-ignore");
		const clearBtn = backdrop.querySelector("#ala-ov-btn-clear");
		const clearForm = () => {
			lookupSeq++;
			cancelLookup?.();
			cancelLookup = null;
			alInput.value = "";
			malInput.value = "";
			activePreview = null;
			updatePreviewUI();
		};
		listen(clearBtn, "click", clearForm);
		const fetchMissingMeta = (id) => {
			api?.query(`query ($id: Int) { Media(id: $id) { id type title { userPreferred english romaji } coverImage { medium } } }`, { id }, { signal: staging ? ec.signal : malSignal }).then((res) => {
				const m = res?.Media;
				if (!m) return;
				if (ec.signal?.aborted) return;
				if (signal.aborted && (!staging || !appliedInStaging)) return;
				const current = { ...readOverrides() };
				if (!current[String(id)]) return;
				const t = m.title?.userPreferred || m.title?.english || m.title?.romaji || current[String(id)].title;
				const safeCover = safeCoverUrl(m.coverImage?.medium || current[String(id)].cover);
				const updatedEntry = {
					...current[String(id)],
					title: t,
					type: m.type === "MANGA" ? "MANGA" : "ANIME",
					updatedAt: Date.now()
				};
				if (safeCover) updatedEntry.cover = safeCover;
				else delete updatedEntry.cover;
				current[String(id)] = updatedEntry;
				writeOverrides(current);
				if (staging && appliedInStaging) ec.onApply(current);
				if (!isClosed()) renderList();
			}).catch(() => {});
		};
		listen(saveBtn, "click", async () => {
			if (saveBtn.disabled || isClosed()) return;
			const id = activePreview?.mediaId || extractAlId(alInput.value);
			if (!id) {
				saveBtn.disabled = true;
				try {
					await showAlert("Please enter a valid AniList ID or URL.", "Invalid AniList ID", "ov-invalid-al");
				} finally {
					if (!isClosed()) saveBtn.disabled = false;
				}
				return;
			}
			let malId = extractMalId(malInput.value);
			if (!malId && activePreview?.detectedMalId) malId = activePreview.detectedMalId;
			if (!malId) {
				saveBtn.disabled = true;
				try {
					await showAlert("Please enter a valid MyAnimeList ID or URL.", "Invalid MAL ID", "ov-invalid-mal");
				} finally {
					if (!isClosed()) saveBtn.disabled = false;
				}
				return;
			}
			const existing = readOverrides()[String(id)];
			const title = activePreview?.title || existing?.title || `Media #${id}`;
			const cover = safeCoverUrl(activePreview?.cover || existing?.cover) || void 0;
			const type = activePreview?.type || existing?.type || "ANIME";
			patchOverride(id, {
				malId,
				type,
				title,
				cover
			});
			clearForm();
			renderList();
			if (title === `Media #${id}`) fetchMissingMeta(id);
		});
		listen(ignoreBtn, "click", async () => {
			if (ignoreBtn.disabled || isClosed()) return;
			const id = activePreview?.mediaId || extractAlId(alInput.value);
			if (!id) {
				ignoreBtn.disabled = true;
				try {
					await showAlert("Please enter a valid AniList ID or URL.", "Invalid AniList ID", "ov-invalid-al");
				} finally {
					if (!isClosed()) ignoreBtn.disabled = false;
				}
				return;
			}
			const existing = readOverrides()[String(id)];
			const title = activePreview?.title || existing?.title || `Media #${id}`;
			const cover = safeCoverUrl(activePreview?.cover || existing?.cover) || void 0;
			const type = activePreview?.type || existing?.type || "ANIME";
			patchOverride(id, {
				malId: 0,
				type,
				title,
				cover
			});
			clearForm();
			renderList();
			if (title === `Media #${id}`) fetchMissingMeta(id);
		});
		backdrop.querySelectorAll("[data-status-filter]").forEach((c) => {
			listen(c, "click", () => {
				backdrop.querySelectorAll("[data-status-filter]").forEach((o) => o.classList.toggle("is-active", o === c));
				statusFilter = c.dataset.statusFilter || "all";
				renderList();
			});
		});
		backdrop.querySelectorAll("[data-type-filter]").forEach((c) => {
			listen(c, "click", () => {
				backdrop.querySelectorAll("[data-type-filter]").forEach((o) => o.classList.toggle("is-active", o === c));
				typeFilter = c.dataset.typeFilter || "all";
				renderList();
			});
		});
		if (searchInput) listen(searchInput, "input", () => {
			cancelSearch?.();
			cancelSearch = timeout(() => {
				cancelSearch = null;
				searchQuery = searchInput.value.trim();
				renderList();
			}, 150);
		});
		function renderList() {
			const all = readOverrides();
			const entries = Object.entries(all).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
			const filtered = entries.filter(([idStr, o]) => {
				if (statusFilter === "overrides" && o.malId === 0) return false;
				if (statusFilter === "ignored" && o.malId > 0) return false;
				if (typeFilter !== "all" && o.type.toLowerCase() !== typeFilter.toLowerCase()) return false;
				if (searchQuery && !matchesSearch(o.title, idStr, o.malId > 0 ? o.malId : void 0, searchQuery)) return false;
				return true;
			});
			countLabel.textContent = `Configured Entries (${entries.length}${filtered.length !== entries.length ? ` — showing ${filtered.length}` : ""})`;
			if (!filtered.length) {
				listContainer.innerHTML = `<div class="ala-ov-empty">No entries found matching this filter.</div>`;
				return;
			}
			listContainer.innerHTML = filtered.map(([idStr, o]) => {
				const id = Number(idStr);
				const isIgnoredEntry = o.malId === 0;
				const alUrl = `https://anilist.co/${o.type.toLowerCase()}/${id}`;
				const malUrl = o.malId > 0 ? `https://myanimelist.net/${o.type.toLowerCase()}/${o.malId}` : "#";
				const safeCover = safeCoverUrl(o.cover);
				return `
        <div class="ala-ov-item" data-id="${esc(id)}">
          ${safeCover ? `<img class="ala-ov-item-cover" src="${esc(safeCover)}" alt="">` : `<div class="ala-ov-item-cover"></div>`}
          <div class="ala-ov-item-info">
            <a class="ala-ov-item-title" href="${esc(alUrl)}" target="_blank" rel="noopener" title="${esc(o.title)}">${esc(o.title)}</a>
            <div class="ala-ov-item-meta">
              <span class="ala-ov-badge ${o.type === "MANGA" ? "ala-ov-badge--manga" : ""}">${esc(o.type)}</span>
              <span>AniList ID: <b>${esc(id)}</b></span>
              ${isIgnoredEntry ? `<span class="ala-ov-badge ala-ov-badge--ignored">AniList-Only (Ignored)</span>` : `<span>MAL ID: <a href="${esc(malUrl)}" target="_blank" rel="noopener"><b>${esc(o.malId)}</b></a></span>`}
            </div>
          </div>
          <div class="ala-ov-item-actions">
            <button type="button" class="ala-btn ala-btn--sm ala-ov-btn-edit" data-id="${esc(id)}">Edit</button>
            <button type="button" class="ala-icon-btn ala-ov-btn-del" data-id="${esc(id)}" title="Remove override">✕</button>
          </div>
        </div>
      `;
			}).join("");
			listContainer.querySelectorAll(".ala-ov-btn-del").forEach((btn) => {
				btn.addEventListener("click", () => {
					const id = Number(btn.dataset.id);
					if (id) {
						deleteOverride(id);
						if (activePreview?.mediaId === id) clearForm();
						renderList();
					}
				});
			});
			listContainer.querySelectorAll(".ala-ov-btn-edit").forEach((btn) => {
				btn.addEventListener("click", () => {
					const id = Number(btn.dataset.id);
					if (id) {
						cancelLookup?.();
						cancelLookup = null;
						malInput.value = "";
						alInput.value = String(id);
						doLookup(id);
						viewOverrides.scrollTop = 0;
					}
				});
			});
		}
		let unmatchedTypeFilter = "all";
		let unmatchedSearchQuery = "";
		let orphansTypeFilter = "all";
		let orphansSearchQuery = "";
		const unmatchedControls = backdrop.querySelector("#ala-ov-unmatched-controls");
		const unmatchedSearchInput = backdrop.querySelector("#ala-ov-unmatched-search");
		backdrop.querySelectorAll("[data-unmatched-type]").forEach((c) => {
			listen(c, "click", () => {
				backdrop.querySelectorAll("[data-unmatched-type]").forEach((o) => o.classList.toggle("is-active", o === c));
				unmatchedTypeFilter = c.dataset.unmatchedType || "all";
				renderUnmatchedList();
			});
		});
		if (unmatchedSearchInput) listen(unmatchedSearchInput, "input", () => {
			cancelUnmatchedSearch?.();
			cancelUnmatchedSearch = timeout(() => {
				cancelUnmatchedSearch = null;
				unmatchedSearchQuery = unmatchedSearchInput.value.trim();
				renderUnmatchedList();
			}, 150);
		});
		function getRawUnmatched() {
			if (!syncStoresInitialized) return [];
			const configured = readOverrides();
			const unmatched = [];
			for (const t of ["ANIME", "MANGA"]) {
				const data = stores[t].ids.data || {};
				for (const [idStr, rec] of Object.entries(data)) {
					const id = Number(idStr);
					if (id > 0 && rec && rec.m === 0 && !configured[String(id)]) unmatched.push({
						mediaId: id,
						type: t
					});
				}
			}
			return unmatched;
		}
		function renderUnmatchedList() {
			const unmatchedBox = backdrop.querySelector("#ala-ov-audit-unmatched");
			if (!syncStoresInitialized) {
				unmatchedControls.style.display = "none";
				unmatchedBox.innerHTML = `<div class="ala-ov-empty">Enable <b>AniList → MyAnimeList Sync</b> and run a sync to view unmatched entries here.</div>`;
				return;
			}
			const raw = getRawUnmatched();
			if (!raw.length) {
				unmatchedControls.style.display = "none";
				unmatchedBox.innerHTML = `<div class="ala-ov-empty">No unmatched entries found. All synced titles have MAL IDs or were resolved!</div>`;
				return;
			}
			unmatchedControls.style.display = "flex";
			const filtered = raw.filter(({ mediaId, type }) => {
				if (unmatchedTypeFilter !== "all" && type.toLowerCase() !== unmatchedTypeFilter.toLowerCase()) return false;
				const title = unmatchedMetaCache.get(mediaId)?.title || `Media #${mediaId}`;
				if (unmatchedSearchQuery && !matchesSearch(title, mediaId, void 0, unmatchedSearchQuery)) return false;
				return true;
			});
			if (!filtered.length) {
				unmatchedBox.innerHTML = `<div class="ala-ov-empty">No unmatched entries match this filter.</div>`;
				return;
			}
			unmatchedBox.innerHTML = filtered.map(({ mediaId, type }) => {
				const meta = unmatchedMetaCache.get(mediaId);
				const title = meta?.title || `Media #${mediaId}`;
				const cover = safeCoverUrl(meta?.cover);
				return `
        <div class="ala-ov-item" data-id="${esc(mediaId)}">
          ${cover ? `<img class="ala-ov-item-cover" src="${esc(cover)}" alt="">` : `<div class="ala-ov-item-cover"></div>`}
          <div class="ala-ov-item-info">
            <a class="ala-ov-item-title" href="https://anilist.co/${esc(type.toLowerCase())}/${esc(mediaId)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(title)}</a>
            <div class="ala-ov-item-meta">
              <span class="ala-ov-badge ${type === "MANGA" ? "ala-ov-badge--manga" : ""}">${esc(type)}</span>
              <span>AniList ID: <b>${esc(mediaId)}</b></span>
            </div>
          </div>
          <div class="ala-ov-item-actions">
            <button type="button" class="ala-btn ala-btn--sm ala-ov-audit-set" data-id="${esc(mediaId)}">Set MAL ID</button>
            <button type="button" class="ala-btn ala-btn--sm ala-ov-audit-ignore" data-id="${esc(mediaId)}" data-type="${esc(type)}">Ignore</button>
          </div>
        </div>
      `;
			}).join("");
			unmatchedBox.querySelectorAll(".ala-ov-audit-set").forEach((btn) => {
				btn.addEventListener("click", () => {
					const id = Number(btn.dataset.id);
					cancelLookup?.();
					cancelLookup = null;
					tabs[0].click();
					malInput.value = "";
					alInput.value = String(id);
					doLookup(id);
				});
			});
			unmatchedBox.querySelectorAll(".ala-ov-audit-ignore").forEach((btn) => {
				btn.addEventListener("click", () => {
					const id = Number(btn.dataset.id);
					const type = btn.dataset.type || "ANIME";
					const meta = unmatchedMetaCache.get(id);
					patchOverride(id, {
						malId: 0,
						type,
						title: meta?.title || `Media #${id}`,
						cover: safeCoverUrl(meta?.cover) || void 0
					});
					renderUnmatchedList();
					renderList();
				});
			});
		}
		function renderAudit() {
			renderUnmatchedList();
			if (syncStoresInitialized) {
				const missingMetaIds = getRawUnmatched().map((r) => r.mediaId).filter((id) => !unmatchedMetaCache.has(id));
				if (missingMetaIds.length > 0) batchFetchUnmatchedMeta(missingMetaIds, ec.log, api, malSignal).then(() => {
					if (!isClosed()) renderUnmatchedList();
				});
			}
			renderOrphansList();
		}
		let scannedOrphans = null;
		let orphanScanErrors = [];
		const deletingOrphans = new Set();
		const orphansControls = backdrop.querySelector("#ala-ov-orphans-controls");
		const orphansSearchInput = backdrop.querySelector("#ala-ov-orphans-search");
		backdrop.querySelectorAll("[data-orphans-type]").forEach((c) => {
			listen(c, "click", () => {
				backdrop.querySelectorAll("[data-orphans-type]").forEach((o) => o.classList.toggle("is-active", o === c));
				orphansTypeFilter = c.dataset.orphansType || "all";
				renderOrphansList();
			});
		});
		if (orphansSearchInput) listen(orphansSearchInput, "input", () => {
			cancelOrphansSearch?.();
			cancelOrphansSearch = timeout(() => {
				cancelOrphansSearch = null;
				orphansSearchQuery = orphansSearchInput.value.trim();
				renderOrphansList();
			}, 150);
		});
		function renderOrphansList() {
			const orphansBox = backdrop.querySelector("#ala-ov-audit-orphans");
			if (!orphansBox) return;
			const errorBanner = orphanScanErrors.length ? `<div class="ala-ov-status ala-ov-status--error" style="display:block;margin-top:0;margin-bottom:10px">${orphanScanErrors.map(esc).join("<br>")}</div>` : "";
			if (scannedOrphans === null) {
				orphansControls.style.display = "none";
				orphansBox.innerHTML = `${errorBanner}<div class="ala-ov-empty">Click "Scan MAL" to find entries present on MyAnimeList that are missing from your AniList library.</div>`;
				return;
			}
			if (!scannedOrphans.length) {
				orphansControls.style.display = "none";
				orphansBox.innerHTML = orphanScanErrors.length ? errorBanner : `<div class="ala-ov-empty">No orphaned entries found. Your MyAnimeList list matches your AniList library!</div>`;
				return;
			}
			orphansControls.style.display = "flex";
			const filtered = scannedOrphans.filter((item) => {
				if (orphansTypeFilter !== "all" && item.type.toLowerCase() !== orphansTypeFilter.toLowerCase()) return false;
				if (orphansSearchQuery && !matchesSearch(item.title, item.malId, void 0, orphansSearchQuery)) return false;
				return true;
			});
			if (!filtered.length) {
				orphansBox.innerHTML = `${errorBanner}<div class="ala-ov-empty">No orphaned entries match this filter.</div>`;
				return;
			}
			orphansBox.innerHTML = errorBanner + filtered.map((item) => {
				const delKey = `${item.type}:${item.malId}`;
				const isDeleting = deletingOrphans.has(delKey);
				return `
        <div class="ala-ov-item" data-mal-id="${esc(item.malId)}">
          <div class="ala-ov-item-info">
            <a class="ala-ov-item-title" href="https://myanimelist.net/${esc(item.type.toLowerCase())}/${esc(item.malId)}" target="_blank" rel="noopener" title="${esc(item.title)}">${esc(item.title)}</a>
            <div class="ala-ov-item-meta">
              <span class="ala-ov-badge ${item.type === "MANGA" ? "ala-ov-badge--manga" : ""}">${esc(item.type)}</span>
              <span>MAL ID: <b>${esc(item.malId)}</b></span>
            </div>
          </div>
          <div class="ala-ov-item-actions">
            <button type="button" class="ala-btn ala-btn--sm ala-btn--danger ala-ov-btn-del-mal" data-mal-id="${esc(item.malId)}" data-type="${esc(item.type)}"${isDeleting ? " disabled" : ""}>${isDeleting ? "Deleting..." : "Delete from MAL"}</button>
            <button type="button" class="ala-btn ala-btn--sm ala-ov-btn-keep-mal" data-mal-id="${esc(item.malId)}" data-type="${esc(item.type)}">Keep on MAL</button>
          </div>
        </div>
      `;
			}).join("");
			orphansBox.querySelectorAll(".ala-ov-btn-del-mal").forEach((btn) => {
				btn.addEventListener("click", async () => {
					const id = Number(btn.dataset.malId);
					const type = btn.dataset.type || "ANIME";
					const delKey = `${type}:${id}`;
					if (!id || btn.disabled || deletingOrphans.has(delKey) || isClosed()) return;
					deletingOrphans.add(delKey);
					btn.disabled = true;
					try {
						const confirmed = await showConfirm({
							id: "ov-del-mal-confirm",
							title: "Delete from MyAnimeList",
							message: `Delete MAL ID ${id} from your MyAnimeList account? This cannot be undone.`,
							confirmText: "Delete",
							danger: true
						});
						if (isClosed() || !confirmed) return;
						btn.textContent = "Deleting...";
						await malDeleteEntry(type, id, { signal: malSignal });
						if (isClosed()) return;
						scannedOrphans = scannedOrphans?.filter((o) => !(o.malId === id && o.type === type)) || [];
					} catch (err) {
						if (isClosed() || malSignal.aborted || isAbortError(err)) return;
						await showAlert(`Failed to delete from MAL: ${err?.message || err}`, "Delete Failed", "ov-del-mal-error");
					} finally {
						deletingOrphans.delete(delKey);
						if (!isClosed()) {
							if (btn.isConnected) {
								btn.disabled = false;
								btn.textContent = "Delete from MAL";
							} else renderOrphansList();
						}
					}
				});
			});
			orphansBox.querySelectorAll(".ala-ov-btn-keep-mal").forEach((btn) => {
				btn.addEventListener("click", () => {
					const id = Number(btn.dataset.malId);
					const type = btn.dataset.type || "ANIME";
					scannedOrphans = scannedOrphans?.filter((o) => !(o.malId === id && o.type === type)) || [];
					renderOrphansList();
				});
			});
		}
		const scanOrphansBtn = backdrop.querySelector("#ala-ov-btn-scan-orphans");
		if (scanOrphansBtn) listen(scanOrphansBtn, "click", async () => {
			if (scanOrphansBtn.disabled || isClosed()) return;
			const orphansBox = backdrop.querySelector("#ala-ov-audit-orphans");
			scanOrphansBtn.disabled = true;
			scanOrphansBtn.textContent = "Scanning...";
			orphanScanErrors = [];
			orphansBox.innerHTML = `<div class="ala-ov-empty">Scanning your AniList and MyAnimeList libraries...</div>`;
			try {
				const viewer = await api?.viewer(false, { signal: malSignal });
				if (isClosed()) return;
				if (!viewer) {
					orphansBox.innerHTML = `<div class="ala-ov-empty" style="color:rgb(var(--color-red,224,85,85))">AniList user not found. Please log in to AniList first.</div>`;
					return;
				}
				const overrides = readOverrides();
				const knownMalIdsByType = {
					ANIME: new Set(),
					MANGA: new Set()
				};
				const succeededTypes = new Set();
				for (const t of ["ANIME", "MANGA"]) try {
					const alEntries = await alFetchAll(viewer.id, t, api, malSignal);
					if (isClosed()) return;
					succeededTypes.add(t);
					const known = knownMalIdsByType[t];
					for (const e of alEntries) {
						const ov = overrides[String(e.mediaId)];
						if (ov) {
							if (ov.malId > 0) known.add(ov.malId);
							else if (ov.malId === 0) {
								if (e.idMal > 0) known.add(e.idMal);
								const cached = syncStoresInitialized ? Number(stores[t].ids.data[e.mediaId]?.m) || 0 : 0;
								if (cached > 0) known.add(cached);
							}
						} else {
							const cached = syncStoresInitialized ? Number(stores[t].ids.data[e.mediaId]?.m) || 0 : 0;
							if (cached > 0) known.add(cached);
							else if (e.idMal > 0) known.add(e.idMal);
						}
					}
				} catch (e) {
					if (isClosed() || malSignal.aborted || isAbortError(e)) return;
					ec?.log?.warn(`Audit scan: failed to fetch AniList ${t}:`, e);
					orphanScanErrors.push(`Failed to fetch AniList ${t.toLowerCase()} list: ${e?.message || e}`);
				}
				const foundOrphans = [];
				for (const t of ["ANIME", "MANGA"]) {
					if (!succeededTypes.has(t)) continue;
					try {
						const malList = await malFetchList(t, { signal: malSignal });
						if (isClosed()) return;
						const known = knownMalIdsByType[t];
						for (const [idStr, data] of Object.entries(malList)) {
							const malId = Number(idStr);
							if (malId > 0 && !known.has(malId)) foundOrphans.push({
								malId,
								type: t,
								title: data.__malTitle || `MAL #${malId}`
							});
						}
					} catch (e) {
						if (isClosed() || malSignal.aborted || isAbortError(e)) return;
						ec?.log?.warn(`Audit scan: failed to fetch MAL ${t}:`, e);
						orphanScanErrors.push(`Failed to fetch MAL ${t.toLowerCase()} list: ${e?.message || e}`);
					}
				}
				scannedOrphans = foundOrphans;
				renderOrphansList();
			} catch (err) {
				if (isClosed() || malSignal.aborted || isAbortError(err)) return;
				orphansBox.innerHTML = `<div class="ala-ov-empty" style="color:rgb(var(--color-red,224,85,85))">Scan error: ${esc(err?.message || err)}</div>`;
			} finally {
				if (!isClosed()) {
					scanOrphansBtn.disabled = false;
					scanOrphansBtn.textContent = "Scan MAL";
				}
			}
		});
		const jsonTextarea = backdrop.querySelector("#ala-ov-json-textarea");
		const jsonStatus = backdrop.querySelector("#ala-ov-json-status");
		const jsonSaveBtn = backdrop.querySelector("#ala-ov-btn-json-save");
		const jsonMergeBtn = backdrop.querySelector("#ala-ov-btn-json-merge");
		const jsonCopyBtn = backdrop.querySelector("#ala-ov-btn-json-copy");
		const jsonResetBtn = backdrop.querySelector("#ala-ov-btn-json-reset");
		function renderJsonView() {
			const current = readOverrides();
			jsonTextarea.value = JSON.stringify(current, null, 2);
			jsonStatus.style.display = "none";
		}
		if (jsonCopyBtn) listen(jsonCopyBtn, "click", async () => {
			try {
				await navigator.clipboard.writeText(jsonTextarea.value);
				if (isClosed()) return;
				const prev = jsonCopyBtn.textContent;
				jsonCopyBtn.textContent = "Copied!";
				cancelCopyTimer?.();
				cancelCopyTimer = timeout(() => {
					cancelCopyTimer = null;
					if (!isClosed()) jsonCopyBtn.textContent = prev;
				}, 1500);
			} catch (_) {
				if (isClosed()) return;
				jsonTextarea.select();
				document.execCommand("copy");
				const prev = jsonCopyBtn.textContent;
				jsonCopyBtn.textContent = "Copied!";
				cancelCopyTimer?.();
				cancelCopyTimer = timeout(() => {
					cancelCopyTimer = null;
					if (!isClosed()) jsonCopyBtn.textContent = prev;
				}, 1500);
			}
		});
		if (jsonResetBtn) listen(jsonResetBtn, "click", renderJsonView);
		if (jsonSaveBtn) listen(jsonSaveBtn, "click", () => {
			const res = importDraftOverrides(jsonTextarea.value, "replace");
			if (!res.success) {
				jsonStatus.className = "ala-ov-status ala-ov-status--error";
				jsonStatus.textContent = res.error || "Failed to parse JSON";
				jsonStatus.style.display = "block";
				return;
			}
			jsonStatus.className = "ala-ov-status ala-ov-status--success";
			jsonStatus.textContent = `Successfully saved ${res.count ?? 0} overrides!`;
			jsonStatus.style.display = "block";
			renderList();
		});
		if (jsonMergeBtn) listen(jsonMergeBtn, "click", () => {
			const res = importDraftOverrides(jsonTextarea.value, "merge");
			if (!res.success) {
				jsonStatus.className = "ala-ov-status ala-ov-status--error";
				jsonStatus.textContent = res.error || "Failed to parse JSON";
				jsonStatus.style.display = "block";
				return;
			}
			const current = readOverrides();
			jsonStatus.className = "ala-ov-status ala-ov-status--success";
			jsonStatus.textContent = `Successfully merged ${res.count ?? 0} overrides! (Total: ${Object.keys(current).length})`;
			jsonStatus.style.display = "block";
			jsonTextarea.value = JSON.stringify(current, null, 2);
			renderList();
		});
		renderList();
	}
	var activeCandidate = null;
	var activeRouteMedia = null;
	function isDialogVisible(el) {
		let cur = el;
		while (cur && cur !== document.documentElement) {
			if (cur instanceof HTMLElement) {
				if (cur.hidden) return false;
				if (cur.style.display === "none" || cur.style.visibility === "hidden") return false;
				if (typeof getComputedStyle === "function") {
					const cs = getComputedStyle(cur);
					if (cs.display === "none" || cs.visibility === "hidden") return false;
				}
			}
			cur = cur.parentElement;
		}
		return true;
	}
	function findVisibleDialogBody(root) {
		const ownWrapper = root.closest(".el-dialog, .el-dialog__wrapper");
		if (ownWrapper) {
			const body = ownWrapper.querySelector(".el-dialog__body") || (ownWrapper.matches(".el-dialog__body") ? ownWrapper : null);
			return body && isDialogVisible(body) ? body : null;
		}
		for (const wrapper of Array.from(document.querySelectorAll(".el-dialog__wrapper"))) {
			if (!isDialogVisible(wrapper)) continue;
			const body = wrapper.querySelector(".el-dialog__body");
			if (body && isDialogVisible(body)) return body;
		}
		for (const body of Array.from(document.querySelectorAll(".el-dialog__body"))) if (isDialogVisible(body)) return body;
		return null;
	}
	function extractDialogMedia(root = document.body) {
		const dialog = findVisibleDialogBody(root);
		if (!dialog) return null;
		const title = dialog.querySelector(".title, .header .title")?.textContent?.trim() || "";
		let type = "ANIME";
		if (dialog.querySelector(".input-wrap.manga, .form.manga, .manga")) type = "MANGA";
		else if (dialog.querySelector(".input-wrap.anime, .form.anime, .anime")) type = "ANIME";
		let mediaId = 0;
		const vue = dialog.__vue__ || dialog.parentElement?.__vue__;
		if (vue?.mediaId) mediaId = Number(vue.mediaId);
		else if (vue?.media?.id) mediaId = Number(vue.media.id);
		if (!mediaId) {
			const el = dialog.querySelector(".header[data-src], .header[style*=\"media/\"], .cover img, img[src*=\"/media/\"]");
			const m = (el?.getAttribute("src") || el?.getAttribute("data-src") || el?.style.backgroundImage || "").match(/\/media\/(anime|manga)\/[^\/]+\/(?:bx)?(\d+)/i);
			if (m) {
				type = m[1].toUpperCase();
				mediaId = Number(m[2]);
			}
		}
		if (!mediaId && title) {
			const dialogRoot = dialog.closest(".el-dialog, .el-dialog__wrapper") || dialog;
			const link = Array.from(dialogRoot.querySelectorAll("a[href*=\"/anime/\"], a[href*=\"/manga/\"]")).find((a) => a.textContent?.trim() === title);
			if (link) {
				const m = link.getAttribute("href")?.match(/^\/(anime|manga)\/(\d+)/);
				if (m) {
					type = m[1].toUpperCase();
					mediaId = Number(m[2]);
				}
			}
		}
		if (!mediaId && activeRouteMedia) {
			mediaId = activeRouteMedia.id;
			type = activeRouteMedia.type;
		}
		if (!mediaId) return null;
		const override = getOverride(mediaId);
		if (override && override.malId === 0) return null;
		const malId = override?.malId || stores[type].ids.data[mediaId]?.m || void 0;
		return {
			mediaId,
			type,
			title: title || `Media #${mediaId}`,
			malId
		};
	}
	function initDeletionInterceptor(ctx) {
		if (typeof window === "undefined" || location.hostname !== "anilist.co") return;
		ctx.onRoute(/^\/(anime|manga)\/(\d+)(?:\/|$)/, (rc) => {
			activeRouteMedia = {
				id: Number(rc.match[2]),
				type: rc.match[1].toUpperCase()
			};
			return () => {
				activeRouteMedia = null;
			};
		});
		ctx.hooks.onGqlFetch((ev) => {
			const queryStr = ev.query || ev.operationName || "";
			if (!queryStr) return;
			if (queryStr.includes("DeleteMediaListEntry")) {
				if (ev.phase === "request") {
					ctx.log.debug("DeleteMediaListEntry request intercepted for variables:", ev.variables);
					if (ctx.get("syncMode") === "exact" && !activeCandidate) {
						const candidate = extractDialogMedia(document.body);
						if (candidate) activeCandidate = candidate;
					}
					return;
				}
				if (ev.phase === "response") {
					if (!(ev.ok === true && !ev.errors?.length && ev.data?.DeleteMediaListEntry?.deleted === true)) {
						ctx.log.debug("DeleteMediaListEntry response not confirmed, clearing candidate:", ev.status, ev.data);
						activeCandidate = null;
						return;
					}
					if (ctx.get("syncMode") === "exact") {
						const candidate = activeCandidate || extractDialogMedia(document.body);
						if (candidate) {
							addPendingDelete({
								mediaId: candidate.mediaId,
								malId: candidate.malId,
								type: candidate.type,
								title: candidate.title,
								deletedAt: Date.now()
							});
							ctx.log.debug("Queued pending deletion for exact match:", candidate);
							activeCandidate = null;
							log(`${typeLabel(candidate.type)}: queued "${candidate.title}" for deletion on MAL (Exact Match).`, "info");
						}
					} else activeCandidate = null;
					return;
				}
				return;
			}
			if (ev.phase === "response" && queryStr.includes("SaveMediaListEntry") && ev.variables?.mediaId && ev.ok === true && !ev.errors?.length && Boolean(ev.data?.SaveMediaListEntry)) {
				const mediaId = Number(ev.variables.mediaId);
				ctx.log.debug("SaveMediaListEntry intercepted, un-queuing any pending deletion for mediaId:", mediaId);
				removePendingDelete(mediaId, "ANIME");
				removePendingDelete(mediaId, "MANGA");
			}
		});
		ctx.listen(document, "keydown", (e) => {
			if (e.key === "Escape") activeCandidate = null;
		}, true);
		ctx.listen(document, "click", (e) => {
			if (ctx.get("syncMode") !== "exact") return;
			const target = e.target;
			if (!target) return;
			if (target.classList.contains("el-message-box__wrapper") || target.classList.contains("el-dialog__wrapper") || target.closest(".el-message-box__headerbtn, .el-dialog__headerbtn, .el-message-box__close, .el-dialog__close")) {
				activeCandidate = null;
				return;
			}
			const btnText = ((target.closest(".delete-btn, .delete, button, [role=\"button\"]") || target).textContent || "").trim().toLowerCase();
			if (target.classList.contains("delete-btn") || target.classList.contains("delete") || btnText === "delete" || btnText.includes("delete list entry")) {
				const candidate = extractDialogMedia(target);
				if (candidate) activeCandidate = candidate;
				return;
			}
			const inWarningBox = !!target.closest(".el-message-box, .el-message-box__wrapper");
			if ((btnText === "ok" || target.classList.contains("el-button--primary") || !!target.closest(".el-message-box__btns .el-button--primary")) && inWarningBox) {
				if (!activeCandidate) {
					const candidate = extractDialogMedia(document.body);
					if (candidate) activeCandidate = candidate;
				}
				return;
			}
			if (btnText === "cancel" && inWarningBox) {
				activeCandidate = null;
				return;
			}
			if (btnText === "save" || target.classList.contains("save-btn")) {
				const candidate = extractDialogMedia(target);
				if (candidate) removePendingDelete(candidate.mediaId, candidate.type);
			}
		}, true);
		ctx.onCleanup(() => {
			activeCandidate = null;
			activeRouteMedia = null;
		});
	}
	defineModule({
		id: "sync",
		key: "syncEnabled",
		section: "Sync",
		hosts: ["anilist.co", "myanimelist.net"],
		layer: "service",
		requiresReload: false,
		accounts: ["mal"],
		legacy: ["syncEnabled", "syncOn"],
		title: "AniList → MyAnimeList Sync",
		help: "Enable sync and show the list page sync panel",
		debug: {
			label: "Sync",
			title: "Sync Debug",
			help: "Log MAL synchronization steps, queue processing, rate limits, and deletions."
		},
		options: [
			{
				key: "syncAutoAnime",
				type: "toggle",
				def: false,
				legacy: ["syncAutoAnime"],
				title: "Auto-Sync Anime",
				help: "Automatically sync your anime list to MyAnimeList in the background."
			},
			{
				key: "syncIntervalAnime",
				type: "number",
				childOf: "syncAutoAnime",
				def: 6,
				min: 1,
				max: 720,
				legacy: [
					"syncIntervalAnime",
					"syncIntervalHours",
					"autoSyncIntervalHours",
					"autoSyncInterval"
				],
				title: "Auto-Sync Anime Interval",
				help: "How often to automatically sync your anime list (in hours, minimum 1)."
			},
			{
				key: "syncAutoManga",
				type: "toggle",
				def: false,
				legacy: ["syncAutoManga"],
				title: "Auto-Sync Manga",
				help: "Automatically sync your manga list to MyAnimeList in the background."
			},
			{
				key: "syncIntervalManga",
				type: "number",
				childOf: "syncAutoManga",
				def: 6,
				min: 1,
				max: 720,
				legacy: [
					"syncIntervalManga",
					"syncIntervalMangaHours",
					"autoSyncIntervalMangaHours",
					"syncIntervalHours"
				],
				title: "Auto-Sync Manga Interval",
				help: "How often to automatically sync your manga list (in hours, minimum 1)."
			},
			{
				key: "syncScoreRounding",
				type: "select",
				def: "round",
				options: [
					["ceil", "Ceil"],
					["round", "Round"],
					["floor", "Floor"]
				],
				legacy: ["syncScoreRounding", "scoreConversionMethod"],
				title: "Decimal Score Conversion",
				help: "MyAnimeList only accepts whole-number scores. <b>Ceil</b> always rounds up (7.4 → 8), <b>Round</b> rounds normally (7.4 → 7, 7.5 → 8), and <b>Floor</b> always rounds down (7.9 → 7)."
			},
			{
				key: "syncMode",
				type: "select",
				def: "update",
				options: [["update", "Update Only"], ["exact", "Exact Match (Mirror)"]],
				legacy: ["syncMode"],
				title: "Sync Mode",
				help: "<b>Update Only</b> (default) only adds and updates entries on MyAnimeList, keeping existing MAL entries intact if deleted on AniList. <b>Exact Match (Mirror)</b> automatically deletes entries from MyAnimeList when removed from AniList."
			}
		],
		migrate(m) {
			if ((m.storage.get("schema", 0) || 0) < 3) safe(() => {
				if ((m.legacy.get("sync_schema", 0) || 0) < 2) {
					for (const k of [
						"mal_mirror_ANIME",
						"mal_mirror_MANGA",
						"retry_queue_ANIME",
						"retry_queue_MANGA",
						"force_mirror_refresh",
						"mal_idmap_ANIME",
						"mal_idmap_MANGA",
						"last_full_sync"
					]) m.legacy.del(k);
					for (const t of TYPES) if (!m.legacy.get(`last_run_${t}`, 0) && m.legacy.get(`last_sync_${t}`, 0)) m.legacy.set(`last_run_${t}`, m.legacy.get(`last_sync_${t}`, 0));
				}
				const pairs = [
					["sync_onboarded", "sync_onboarded"],
					["sync_retry_at", "sync_retry_at"],
					["sync_account", "sync_account"],
					["sync_pending_deletes", "pending_deletes"],
					...TYPES.flatMap((t) => [
						[`last_sync_${t}`, `last_sync_${t}`],
						[`last_run_${t}`, `last_run_${t}`],
						[`last_compare_${t}`, `last_compare_${t}`],
						[`sync_idmap_${t}`, `idmap_${t}`],
						[`sync_settled_${t}`, `settled_${t}`]
					])
				];
				for (const [oldKey, newKey] of pairs) {
					const val = m.legacy.get(oldKey, void 0);
					if (val !== void 0) {
						if (m.storage.get(newKey, void 0) === void 0) m.storage.set(newKey, val);
						m.legacy.del(oldKey);
					}
				}
				m.storage.set("schema", 3);
				m.legacy.del("sync_schema");
				m.legacy.del("sync_lock_heartbeat");
			}, "sync schema upgrade");
		},
		setup(ctx) {
			bumpSyncEpoch();
			setSyncLog(ctx.log);
			setSyncGet(ctx.get);
			setSyncStorage(ctx.storage);
			setSyncApi(ctx.api);
			initSyncStores(ctx.persistent);
			initDeletionInterceptor(ctx);
			ctx.menuCommand("🗑️ AL→MAL Sync: Reset all data", () => {
				for (const t of TYPES) {
					clearCache(stores[t].ids, false);
					clearCache(stores[t].settled, false);
				}
				ctx.api.clearViewer();
				ctx.accounts.clearSecrets("mal");
				ctx.storage.clear();
				log("All stored data cleared.");
				renderPanel();
			});
			ctx.menuCommand("🟦 AL→MAL Sync: Disconnect MAL", () => {
				ctx.accounts.disconnect("mal");
				log("MAL disconnected.");
				renderPanel();
			});
			if (location.hostname === "anilist.co") initSyncPanel(ctx);
			ctx.onCleanup(() => {
				bumpSyncEpoch();
				if (syncStatus.syncing) {
					syncStatus.cancelled = true;
					syncStatus.syncing = false;
					progress.phase = "idle";
					notifyState();
				}
				releaseLock();
				resetSyncStores();
				setSyncLog(null);
				setSyncGet(null);
				setSyncStorage(null);
				setSyncApi(null);
			});
		}
	});
	defineModule({
		id: "manualOverrides",
		key: MANUAL_OVERRIDES_ENABLED_KEY,
		section: "External Links, Downloads & Mappings",
		layer: "service",
		requiresReload: false,
		legacy: [MANUAL_OVERRIDES_ENABLED_KEY],
		title: "Manual Mappings & Sync Audit",
		help: "Manage custom MyAnimeList ID overrides, entries ignored from sync, and review database discrepancies.",
		options: [{
			key: OVERRIDES_SETTING_KEY,
			type: "json",
			def: {},
			legacy: [OVERRIDES_SETTING_KEY],
			title: "Manual Overrides & Audit",
			help: "Configure custom AniList → MyAnimeList ID mappings, ignore titles, and audit unmatched or orphaned entries.",
			autoEnableParentWhenNonEmpty: true,
			validate: validateOverrides,
			editor: openOverridesModal
		}],
		migrate(m) {
			if (!m.settings.has("manualOverridesEnabled") && Object.keys(getManualOverrides()).length > 0) m.settings.set(MANUAL_OVERRIDES_ENABLED_KEY, true);
		},
		setup(ctx) {
			ctx.services.provide("quickEdit", (mediaId, mediaType = "ANIME") => openQuickOverrideModal(mediaId, mediaType, ctx, () => ctx.events.emit("manualOverrides:changed", mediaId)));
		}
	});
	defineModule({
		id: "tagPercent",
		key: "tagFilterEnabled",
		section: "AniList Enhancements",
		layer: "intercept",
		requiresReload: true,
		legacy: ["tagFilterEnabled", "browseTagRankFilterEnabled"],
		title: "Browse Tag Rank Filter",
		help: "Automatically apply a minimum tag-rank percentage when you search with a tag or genre.",
		options: [{
			key: "tagPercentage",
			type: "number",
			def: 50,
			min: 1,
			max: 100,
			legacy: ["tagPercentage", "minimumTagRankPercentage"],
			title: "Minimum Tag Rank",
			help: "The minimum percentage a selected tag must meet. For example, 50 means the tag must be present on at least half of the relevant titles."
		}],
		setup(ctx) {
			const PARAM = "minimumTagRank";
			const VALUE = String(ctx.get("tagPercentage"));
			const isTarget = () => /^\/search\/(anime|manga)\/?$/.test(location.pathname);
			const hasSelection = (url) => [...url.searchParams].some(([k, v]) => k !== PARAM && !/^exclude/i.test(k) && /genre|tag/i.test(k) && v.trim() !== "");
			let fixing = false;
			let appliedForFilter = false;
			let lastPathname = "";
			function apply(initial) {
				if (fixing) return;
				if (!isTarget()) {
					appliedForFilter = false;
					lastPathname = "";
					return;
				}
				if (location.pathname !== lastPathname) {
					appliedForFilter = false;
					lastPathname = location.pathname;
				}
				const u = new URL(location.href);
				if (!hasSelection(u)) {
					appliedForFilter = false;
					return;
				}
				if (appliedForFilter || u.searchParams.has(PARAM)) {
					appliedForFilter = true;
					return;
				}
				u.searchParams.set(PARAM, VALUE);
				appliedForFilter = true;
				fixing = true;
				try {
					ctx.silently(() => {
						history.replaceState(history.state, document.title, u.toString());
						if (!initial) window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
					});
				} finally {
					fixing = false;
				}
			}
			apply(true);
			ctx.onNav(() => apply(false));
		}
	});
	var PROBE_ATTR = "data-ala-probe";
	var DEFAULT_TIERS = [
		{
			min: 95,
			max: 100,
			label: "S+",
			color: "#FFD700",
			textColor: "#000000"
		},
		{
			min: 85,
			max: 94.9,
			label: "S",
			color: "#ff7f00",
			textColor: "#FFFFFF"
		},
		{
			min: 75,
			max: 84.9,
			label: "A",
			color: "#aa00ff",
			textColor: "#FFFFFF"
		},
		{
			min: 65,
			max: 74.9,
			label: "B",
			color: "#007fff",
			textColor: "#FFFFFF"
		},
		{
			min: 55,
			max: 64.9,
			label: "C",
			color: "#00aa00",
			textColor: "#FFFFFF"
		},
		{
			min: 41,
			max: 54.9,
			label: "D",
			color: "#aaaaaa",
			textColor: "#FFFFFF"
		},
		{
			min: 0,
			max: 40.9,
			label: "F",
			color: "#666666",
			textColor: "#FFFFFF"
		}
	];
	function getTier(rating, tiers) {
		if (rating <= 0 || !Number.isFinite(rating)) return null;
		for (const tier of tiers) if (rating >= tier.min && rating <= tier.max) return tier;
		for (const tier of tiers) if (rating >= tier.min - .05 && rating <= tier.max + .05) return tier;
		return null;
	}
	var NAMED_COLOR_HEX = {
		black: "#000000",
		white: "#ffffff",
		gray: "#808080",
		grey: "#808080",
		silver: "#c0c0c0",
		red: "#ff0000",
		maroon: "#800000",
		yellow: "#ffff00",
		olive: "#808000",
		lime: "#00ff00",
		green: "#008000",
		aqua: "#00ffff",
		cyan: "#00ffff",
		teal: "#008080",
		blue: "#0000ff",
		navy: "#000080",
		fuchsia: "#ff00ff",
		magenta: "#ff00ff",
		purple: "#800080",
		orange: "#ffa500",
		gold: "#ffd700",
		pink: "#ffc0cb",
		brown: "#a52a2a",
		transparent: null
	};
	function isValidColor(color) {
		if (typeof color !== "string") return false;
		const s = color.trim();
		if (!s) return false;
		if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return true;
		if (/^(rgb|hsl)a?\(\s*[\d.%\s,/+-]+\s*\)$/i.test(s)) return true;
		if (Object.prototype.hasOwnProperty.call(NAMED_COLOR_HEX, s.toLowerCase())) return true;
		if (typeof CSS !== "undefined" && typeof CSS.supports === "function") try {
			if (CSS.supports("color", s)) return true;
		} catch (_) {}
		if (typeof Option !== "undefined") try {
			const opt = new Option();
			opt.style.color = s;
			return !!opt.style.color;
		} catch (_) {}
		return false;
	}
	function byteToHex(n) {
		return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
	}
	function parseRgbChannel(raw) {
		const s = raw.trim();
		if (!s) return null;
		if (s.endsWith("%")) {
			const pct = parseFloat(s.slice(0, -1));
			return Number.isFinite(pct) ? pct / 100 * 255 : null;
		}
		const num = Number(s);
		return Number.isFinite(num) ? num : null;
	}
	function hslToRgb(h, sPct, lPct) {
		const hue = (h % 360 + 360) % 360 / 360;
		const s = Math.max(0, Math.min(100, sPct)) / 100;
		const l = Math.max(0, Math.min(100, lPct)) / 100;
		if (s === 0) {
			const v = l * 255;
			return [
				v,
				v,
				v
			];
		}
		const q = l < .5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		const hue2rgb = (t) => {
			let x = t;
			if (x < 0) x += 1;
			if (x > 1) x -= 1;
			if (x < 1 / 6) return p + (q - p) * 6 * x;
			if (x < 1 / 2) return q;
			if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
			return p;
		};
		return [
			hue2rgb(hue + 1 / 3) * 255,
			hue2rgb(hue) * 255,
			hue2rgb(hue - 1 / 3) * 255
		];
	}
	function cssColorToHex(color) {
		const s = (color || "").trim();
		if (!s) return null;
		const m3 = s.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])[0-9a-fA-F]?$/);
		if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase();
		if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) return s.slice(0, 7).toLowerCase();
		const lower = s.toLowerCase();
		if (Object.prototype.hasOwnProperty.call(NAMED_COLOR_HEX, lower)) return NAMED_COLOR_HEX[lower];
		const rgbMatch = s.match(/^rgba?\(\s*([^)]+)\s*\)$/i);
		if (rgbMatch) {
			const body = rgbMatch[1].split("/")[0].trim();
			const parts = body.includes(",") ? body.split(",") : body.split(/\s+/);
			if (parts.length >= 3) {
				const r = parseRgbChannel(parts[0]);
				const g = parseRgbChannel(parts[1]);
				const b = parseRgbChannel(parts[2]);
				if (r !== null && g !== null && b !== null) return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
			}
		}
		const hslMatch = s.match(/^hsla?\(\s*([^)]+)\s*\)$/i);
		if (hslMatch) {
			const body = hslMatch[1].split("/")[0].trim();
			const parts = body.includes(",") ? body.split(",") : body.split(/\s+/);
			if (parts.length >= 3) {
				const h = parseFloat(parts[0]);
				const sat = parseFloat(parts[1]);
				const light = parseFloat(parts[2]);
				if (Number.isFinite(h) && Number.isFinite(sat) && Number.isFinite(light)) {
					const [r, g, b] = hslToRgb(h, sat, light);
					return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
				}
			}
		}
		return null;
	}
	function normalizeHexColor(color) {
		const s = (color || "").trim();
		const m3 = s.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
		if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase();
		if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
		return s;
	}
	function validateTiers(input) {
		if (!Array.isArray(input)) return {
			valid: false,
			error: "Tiers configuration must be an array."
		};
		if (input.length === 0) return {
			valid: false,
			error: "At least one tier must be defined."
		};
		const validated = [];
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const idx = i + 1;
			if (!item || typeof item !== "object") return {
				valid: false,
				error: `Tier #${idx} is invalid (must be an object).`
			};
			const label = typeof item.label === "string" ? item.label.trim() : "";
			if (!label) return {
				valid: false,
				error: `Tier #${idx} must have a non-empty label.`
			};
			if (label.length > 20) return {
				valid: false,
				error: `Tier "${label}" label is too long (maximum 20 characters).`
			};
			const min = typeof item.min === "number" ? item.min : parseFloat(item.min);
			if (!Number.isFinite(min)) return {
				valid: false,
				error: `Tier "${label}" has an invalid min score (must be a number).`
			};
			if (min < 0 || min > 100) return {
				valid: false,
				error: `Tier "${label}" min score (${min}) must be between 0 and 100.`
			};
			const max = typeof item.max === "number" ? item.max : parseFloat(item.max);
			if (!Number.isFinite(max)) return {
				valid: false,
				error: `Tier "${label}" has an invalid max score (must be a number).`
			};
			if (max < 0 || max > 100) return {
				valid: false,
				error: `Tier "${label}" max score (${max}) must be between 0 and 100.`
			};
			if (min > max) return {
				valid: false,
				error: `Tier "${label}" min score (${min}) cannot be greater than max score (${max}).`
			};
			const color = typeof item.color === "string" ? item.color.trim() : "";
			if (!isValidColor(color)) return {
				valid: false,
				error: `Tier "${label}" has an invalid badge color: "${item.color}". Must be a valid hex or CSS color.`
			};
			const textColor = typeof item.textColor === "string" ? item.textColor.trim() : "";
			if (!isValidColor(textColor)) return {
				valid: false,
				error: `Tier "${label}" has an invalid text color: "${item.textColor}". Must be a valid hex or CSS color.`
			};
			validated.push({
				label,
				min: Math.round(min * 100) / 100,
				max: Math.round(max * 100) / 100,
				color: normalizeHexColor(color),
				textColor: normalizeHexColor(textColor)
			});
		}
		return {
			valid: true,
			tiers: validated
		};
	}
	var buildTierModalCss = (sel) => `
  ${sel} .ala-tier-desc{font-size:13px;color:rgb(var(--color-text-lighter));margin:0 0 14px;line-height:1.4}
  ${sel} .ala-tier-table-wrap{overflow-x:auto;max-height:48vh;overflow-y:auto;border:1px solid rgba(var(--color-text-lighter),.15);border-radius:8px;padding:4px}
  ${sel} .ala-tier-table{width:100%;border-collapse:collapse;font-size:13px}
  ${sel} .ala-tier-table th{text-align:left;padding:8px 6px;color:rgb(var(--color-text-lighter));font-weight:600;border-bottom:1px solid rgba(var(--color-text-lighter),.15)}
  ${sel} .ala-tier-table td{padding:6px;vertical-align:middle;border-bottom:1px solid rgba(var(--color-text-lighter),.08)}
  ${sel} .ala-tier-table input[type=text],${sel} .ala-tier-table input[type=number]{height:34px;padding:0 8px;border-radius:6px;border:1px solid rgba(var(--color-text-lighter),.2);background:rgb(var(--color-background));color:rgb(var(--color-text));font:inherit;font-size:13px;box-sizing:border-box}
  ${sel} .ala-tier-table input[type=color]{width:36px;height:34px;padding:1px;border-radius:6px;border:1px solid rgba(var(--color-text-lighter),.2);background:transparent;cursor:pointer}
  ${sel} .ala-tier-del-btn{padding:0 8px;height:32px;min-width:32px;display:inline-flex;align-items:center;justify-content:center}
  ${sel} .ala-tier-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  ${sel} .ala-tier-json-area{width:100%;height:100px;font-family:monospace;font-size:12px;border-radius:6px;border:1px solid rgba(var(--color-text-lighter),.2);background:rgb(var(--color-background));color:rgb(var(--color-text));padding:8px;box-sizing:border-box;resize:vertical}
  ${sel} .ala-tier-status{margin-left:auto;font-size:13px;color:rgb(var(--color-green,76,175,80))}
  ${sel} .ala-tier-status.is-error{color:rgb(var(--color-red,224,85,85))}
  ${sel} .ala-core-foot{justify-content:flex-start}
  @media (max-width:720px){
    ${sel}{align-items:flex-end;padding:0}
    ${sel} .ala-core-sheet{width:100%;max-height:92vh;max-height:92dvh;border-radius:14px 14px 0 0}
    ${sel} .ala-tier-table-wrap{max-height:45vh}
    ${sel} .ala-tier-table th,${sel} .ala-tier-table td{padding:4px}
  }
`;
	function openTierEditor(ctx) {
		const checkInit = validateTiers(ctx.value);
		const tiers = checkInit.valid && checkInit.tiers ? checkInit.tiers : JSON.parse(JSON.stringify(DEFAULT_TIERS));
		const modal = ctx.modal({
			id: "tier-editor",
			title: "Customize Tier Labels",
			maxWidth: "640px",
			bodyHtml: `
      <p class="ala-tier-desc">Configure tier badges, score thresholds (0–100 scale), and colors. Tiers match in order from top to bottom.</p>
      <div class="ala-tier-table-wrap">
        <table class="ala-tier-table">
          <thead>
            <tr>
              <th style="width:75px">Label</th>
              <th style="width:70px">Min</th>
              <th style="width:70px">Max</th>
              <th style="width:48px">Badge</th>
              <th style="width:48px">Text</th>
              <th style="width:75px">Preview</th>
              <th style="width:36px"></th>
            </tr>
          </thead>
          <tbody id="ala-tier-tbody"></tbody>
        </table>
      </div>
      <div class="ala-tier-actions">
        <button type="button" class="ala-btn" id="ala-tier-btn-add">+ Add Tier</button>
        <button type="button" class="ala-btn" id="ala-tier-btn-reset">Reset Defaults</button>
        <button type="button" class="ala-btn" id="ala-tier-btn-toggle-json">Import / Export JSON</button>
      </div>
      <div id="ala-tier-json-wrap" style="display:none;margin-top:12px">
        <textarea id="ala-tier-json-area" class="ala-tier-json-area" rows="6" spellcheck="false"></textarea>
        <div style="display:flex;gap:8px;margin-top:6px">
          <button type="button" class="ala-btn" id="ala-tier-btn-apply-json">Apply JSON</button>
        </div>
      </div>
    `,
			footerHtml: `
      <button class="ala-btn ala-btn--primary" id="ala-tier-btn-save" type="button">Apply Tiers</button>
      <button class="ala-btn" id="ala-tier-btn-cancel" type="button" data-ala-close>Cancel</button>
      <span class="ala-tier-status" id="ala-tier-status" role="status"></span>
    `,
			style: buildTierModalCss
		});
		const { backdrop, close } = modal;
		const tbody = backdrop.querySelector("#ala-tier-tbody");
		const status = backdrop.querySelector("#ala-tier-status");
		const onClick = (selector, fn) => {
			const el = backdrop.querySelector(selector);
			if (el) modal.listen(el, "click", fn);
		};
		const setModalStatus = (msg, isError = false) => {
			status.textContent = msg;
			status.className = `ala-tier-status ${isError ? "is-error" : ""}`;
		};
		const getColorInputValue = (input, fallback) => {
			if (!input) return fallback;
			const rawColor = input.dataset.rawColor;
			const pickerHex = input.dataset.pickerHex;
			if (rawColor !== void 0 && pickerHex !== void 0 && input.value.toLowerCase() === pickerHex.toLowerCase()) return rawColor;
			return input.value || fallback;
		};
		const createRowHtml = (t, idx) => {
			const rawBadgeColor = typeof t.color === "string" ? t.color.trim() : "";
			const rawTextColor = typeof t.textColor === "string" ? t.textColor.trim() : "";
			const pickerBadgeColor = cssColorToHex(rawBadgeColor) || "#000000";
			const pickerTextColor = cssColorToHex(rawTextColor) || "#ffffff";
			const previewBadgeColor = rawBadgeColor || pickerBadgeColor;
			const previewTextColor = rawTextColor || pickerTextColor;
			const minVal = Number.isFinite(t.min) ? String(t.min) : "";
			const maxVal = Number.isFinite(t.max) ? String(t.max) : "";
			return `
    <tr data-idx="${idx}">
      <td><input type="text" class="ala-t-label" value="${esc(t.label)}" maxlength="20" placeholder="Label" style="width:100%"></td>
      <td><input type="number" class="ala-t-min" min="0" max="100" step="0.1" value="${esc(minVal)}" style="width:100%"></td>
      <td><input type="number" class="ala-t-max" min="0" max="100" step="0.1" value="${esc(maxVal)}" style="width:100%"></td>
      <td><input type="color" class="ala-t-color" value="${esc(pickerBadgeColor)}" data-raw-color="${esc(rawBadgeColor)}" data-picker-hex="${esc(pickerBadgeColor)}" title="Badge Background Color"></td>
      <td><input type="color" class="ala-t-text-color" value="${esc(pickerTextColor)}" data-raw-color="${esc(rawTextColor)}" data-picker-hex="${esc(pickerTextColor)}" title="Badge Text Color"></td>
      <td><span class="ala-tier-badge ala-tier-badge--list ala-t-preview" style="background-color:${esc(previewBadgeColor)};color:${esc(previewTextColor)}">${esc(t.label)}</span></td>
      <td><button type="button" class="ala-icon-btn ala-tier-del-btn" title="Delete Tier">✕</button></td>
    </tr>
  `;
		};
		const renderTable = (list) => {
			tbody.innerHTML = list.map((t, i) => createRowHtml(t, i)).join("");
		};
		const getRowsData = () => {
			const rows = tbody.querySelectorAll("tr");
			const result = [];
			rows.forEach((tr) => {
				const label = (tr.querySelector(".ala-t-label")?.value ?? "").trim();
				const minRaw = (tr.querySelector(".ala-t-min")?.value ?? "").trim();
				const maxRaw = (tr.querySelector(".ala-t-max")?.value ?? "").trim();
				const min = minRaw === "" ? NaN : Number(minRaw);
				const max = maxRaw === "" ? NaN : Number(maxRaw);
				const color = getColorInputValue(tr.querySelector(".ala-t-color"), "#000000");
				const textColor = getColorInputValue(tr.querySelector(".ala-t-text-color"), "#ffffff");
				result.push({
					label,
					min,
					max,
					color,
					textColor
				});
			});
			return result;
		};
		const updatePreview = (tr) => {
			const label = tr.querySelector(".ala-t-label")?.value || "";
			const color = getColorInputValue(tr.querySelector(".ala-t-color"), "#000000");
			const textColor = getColorInputValue(tr.querySelector(".ala-t-text-color"), "#ffffff");
			const preview = tr.querySelector(".ala-t-preview");
			if (preview) {
				preview.textContent = label;
				preview.style.backgroundColor = color;
				preview.style.color = textColor;
			}
		};
		const handleRowColorOrInput = (target) => {
			if (target instanceof HTMLInputElement && target.matches(".ala-t-color, .ala-t-text-color")) {
				delete target.dataset.rawColor;
				delete target.dataset.pickerHex;
			}
			const tr = target.closest("tr");
			if (tr) updatePreview(tr);
		};
		modal.listen(tbody, "input", (e) => {
			handleRowColorOrInput(e.target);
		});
		modal.listen(tbody, "change", (e) => {
			handleRowColorOrInput(e.target);
		});
		modal.listen(tbody, "click", (e) => {
			const btn = e.target.closest(".ala-tier-del-btn");
			if (btn) {
				const tr = btn.closest("tr");
				if (tr) {
					tr.remove();
					setModalStatus("Tier removed.");
				}
			}
		});
		onClick("#ala-tier-btn-add", () => {
			const current = getRowsData();
			current.push({
				min: 0,
				max: 0,
				label: "New",
				color: "#3db4f2",
				textColor: "#ffffff"
			});
			renderTable(current);
			setModalStatus("Added new tier.");
		});
		onClick("#ala-tier-btn-reset", () => {
			renderTable(JSON.parse(JSON.stringify(DEFAULT_TIERS)));
			setModalStatus("Reset to default tiers.");
		});
		const jsonWrap = backdrop.querySelector("#ala-tier-json-wrap");
		const jsonArea = backdrop.querySelector("#ala-tier-json-area");
		onClick("#ala-tier-btn-toggle-json", () => {
			if (jsonWrap.style.display === "none") {
				jsonArea.value = JSON.stringify(getRowsData(), null, 2);
				jsonWrap.style.display = "block";
			} else jsonWrap.style.display = "none";
		});
		onClick("#ala-tier-btn-apply-json", () => {
			try {
				const check = validateTiers(JSON.parse(jsonArea.value));
				if (!check.valid || !check.tiers) {
					setModalStatus(check.error || "Invalid tier JSON.", true);
					return;
				}
				renderTable(check.tiers);
				jsonWrap.style.display = "none";
				setModalStatus("JSON applied successfully.");
			} catch (e) {
				setModalStatus("Invalid JSON syntax: " + (e.message || e), true);
			}
		});
		onClick("#ala-tier-btn-save", () => {
			const check = validateTiers(getRowsData());
			if (!check.valid || !check.tiers) {
				setModalStatus(check.error || "Invalid tier configuration.", true);
				return;
			}
			ctx.onApply(check.tiers);
			close();
		});
		renderTable(tiers);
	}
	function getValidTiers(raw) {
		if (raw === void 0) return DEFAULT_TIERS;
		const check = validateTiers(raw);
		return check.valid && check.tiers ? check.tiers : DEFAULT_TIERS;
	}
	function migrateLegacyTierLabels(m) {
		try {
			const legacy = m.legacy.getLocal("anilistTierLabelsSettings");
			if (legacy) {
				const parsed = JSON.parse(legacy);
				if (Array.isArray(parsed.tiers) && parsed.tiers.length && !m.settings.has("tierLabels")) {
					const check = validateTiers(parsed.tiers);
					if (check.valid && check.tiers) m.settings.set("tierLabels", check.tiers);
				}
				if (typeof parsed.enableRatingTextColor === "boolean" && !m.settings.has("tierLabelsColorScore")) m.settings.set("tierLabelsColorScore", parsed.enableRatingTextColor);
			}
		} catch (_) {}
		try {
			const legacySeen = m.legacy.get("ala_standalone_seen_tierLabels", null);
			if (legacySeen !== null) {
				if (m.storage.get("standalone_seen", null) === null) m.storage.set("standalone_seen", !!legacySeen);
				m.legacy.del("ala_standalone_seen_tierLabels");
			}
		} catch (_) {}
	}
	var probeCache = null;
	function probeTierLabels(timeoutMs = 600) {
		if (probeCache && Date.now() - probeCache.at < 3e4) return probeCache.result;
		const result = (async () => {
			if (!document.body) return false;
			const probe = document.createElement("div");
			probe.className = "score";
			probe.hidden = true;
			probe.setAttribute("score", "9");
			probe.setAttribute(PROBE_ATTR, "1");
			probe.textContent = "9";
			document.body.appendChild(probe);
			try {
				const end = Date.now() + timeoutMs;
				while (Date.now() < end) {
					await sleep(50);
					if (probe.hasAttribute("data-tier-modified")) return true;
				}
				return false;
			} finally {
				probe.remove();
			}
		})();
		probeCache = {
			at: Date.now(),
			result
		};
		return result;
	}
	defineModule({
		id: "tierLabels",
		key: "tierLabelsEnabled",
		section: "AniList Enhancements",
		layer: "feature",
		requiresReload: true,
		legacy: ["tierLabelsEnabled"],
		title: "AniList Tier Labels",
		help: "Adds customizable tier badges (S+, S, A, etc.) next to ratings across list, card, browse, and compare views.",
		debug: {
			label: "Tier Labels",
			title: "Tier Labels Debug",
			help: "Log scoring system detection, tier matching, and badge rendering."
		},
		standalone: {
			name: "AniList Tier Labels",
			probe: () => probeTierLabels()
		},
		options: [
			{
				key: "tierLabelsColorScore",
				type: "toggle",
				def: true,
				title: "Color score value",
				help: "Color the score number text to match its tier badge."
			},
			{
				key: "tierLabelsAverageScore",
				type: "toggle",
				def: false,
				title: "Show on Weighted Score",
				help: "Display tier badge next to the Weighted Score on media pages."
			},
			{
				key: "tierLabels",
				type: "json",
				def: DEFAULT_TIERS,
				title: "Tier Ranges & Colors",
				help: "Customize score ranges, badge labels, and colors.",
				validate: validateTiers,
				editor: openTierEditor
			}
		],
		migrate: migrateLegacyTierLabels,
		setup(ctx) {
			ctx.addStyle(`
      .ala-tier-badge {
        display: inline-block;
        font-weight: 700;
        border-radius: 4px;
        vertical-align: middle;
        white-space: nowrap;
        line-height: 1.2;
        box-sizing: border-box;
      }
      .ala-tier-badge--list {
        font-size: 11px;
        padding: 2px 5px;
        margin-left: 5px;
      }
      .ala-tier-badge--block {
        font-size: 10px;
        padding: 1px 4px;
        margin-left: 4px;
      }
      .ala-tier-container {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .ala-tier-container--block {
        background-color: rgba(0, 0, 0, 0.55);
        padding: 2px 6px;
        border-radius: 4px;
        overflow: hidden;
      }
      `);
			function createBadge(tier, isBlockView = false) {
				const badge = document.createElement("span");
				badge.className = `ala-tier-badge ${isBlockView ? "ala-tier-badge--block" : "ala-tier-badge--list"}`;
				badge.textContent = tier.label;
				badge.style.backgroundColor = tier.color;
				badge.style.color = tier.textColor;
				return badge;
			}
			function getScoreSystem(viewerScoreFormat) {
				const container = document.querySelector(".content.container, .medialist");
				if (container) {
					if (container.querySelector(".medialist.table.POINT_100, .medialist.POINT_100")) return "POINT_100";
					if (container.querySelector(".medialist.table.POINT_10_DECIMAL, .medialist.POINT_10_DECIMAL")) return "POINT_10_DECIMAL";
					if (container.querySelector(".medialist.table.POINT_10, .medialist.POINT_10")) return "POINT_10";
					if (container.querySelector(".medialist.table.POINT_5, .medialist.POINT_5")) return "POINT_5";
					if (container.querySelector(".medialist.table.POINT_3, .medialist.POINT_3")) return "POINT_3";
				}
				if (viewerScoreFormat) return viewerScoreFormat;
				return "UNKNOWN";
			}
			function getCompareColumnFormat(el, viewerScoreFormat) {
				const compareRoot = el.closest(".compare");
				if (!compareRoot) return "UNKNOWN";
				const label = el.getAttribute("label") || "";
				const entry = el.closest(".entry");
				const entryScores = entry ? Array.from(entry.querySelectorAll(".score")) : [];
				const hasScoreLabel = entryScores.some((s) => s.getAttribute("label") === "Score");
				const isAuthUser = label === "Score" || !hasScoreLabel && (label ? entryScores.length >= 2 && entryScores[0] === el : entryScores[0] === el);
				const sideKey = isAuthUser ? "auth" : "target";
				if (!compareRoot._colFormats) compareRoot._colFormats = {};
				if (compareRoot._colFormats[sideKey]) return compareRoot._colFormats[sideKey];
				if (isAuthUser && viewerScoreFormat) {
					compareRoot._colFormats[sideKey] = viewerScoreFormat;
					return viewerScoreFormat;
				}
				const entries = compareRoot.querySelectorAll(".entry");
				let cells = [];
				if (entries.length > 0) for (const row of entries) {
					const rowScores = Array.from(row.querySelectorAll(".score"));
					if (rowScores.length === 0) continue;
					const labeledAuth = rowScores.find((s) => s.getAttribute("label") === "Score");
					if (isAuthUser) {
						const cell = labeledAuth || (rowScores[0].hasAttribute("label") ? null : rowScores[0]);
						if (cell) cells.push(cell);
					} else {
						const cell = labeledAuth ? rowScores.find((s) => s !== labeledAuth) : rowScores[1] || (rowScores[0].getAttribute("label") ? rowScores[0] : null);
						if (cell) cells.push(cell);
					}
				}
				else {
					const fallbackSelector = isAuthUser ? ".score[label=\"Score\"]" : ".score:not([label=\"Score\"])";
					cells = Array.from(compareRoot.querySelectorAll(fallbackSelector));
				}
				let maxScore = 0;
				let hasDecimal = false;
				let hasStarIcon = false;
				let hasSmileyIcon = false;
				for (const cell of cells) {
					const icons = cell.querySelectorAll("svg, .icon, [data-icon]");
					if (icons.length > 0) {
						let cellIsSmiley = false;
						const cellClass = (cell.getAttribute("class") || "").toLowerCase();
						if (/(?:point_3|smiley)/.test(cellClass)) cellIsSmiley = true;
						else for (const icon of icons) {
							const sig = [
								icon.getAttribute("data-icon") || "",
								icon.getAttribute("class") || "",
								icon.getAttribute("aria-label") || "",
								icon.getAttribute("title") || ""
							].join(" ").toLowerCase();
							if (/(?:smile|smiley|meh|frown)/.test(sig)) {
								cellIsSmiley = true;
								break;
							}
						}
						if (cellIsSmiley) hasSmileyIcon = true;
						else hasStarIcon = true;
					}
					const s = cell.getAttribute("score") || (cell.textContent || "").replace("%", "").trim();
					const num = parseFloat(s);
					if (!isNaN(num) && num > 0) {
						if (num > maxScore) maxScore = num;
						if (s.includes(".")) hasDecimal = true;
					}
				}
				let detected = "UNKNOWN";
				if (maxScore > 10) detected = "POINT_100";
				else if (hasDecimal) detected = "POINT_10_DECIMAL";
				else if (hasStarIcon) detected = "POINT_5";
				else if (hasSmileyIcon && maxScore <= 3) detected = "POINT_3";
				else if (hasSmileyIcon) detected = "POINT_5";
				else if (maxScore > 5) detected = "POINT_10";
				else if (maxScore > 0) detected = "POINT_10";
				compareRoot._colFormats[sideKey] = detected;
				ctx.log.debug(`Detected score system for ${isAuthUser ? "viewer" : "other"}:`, detected, {
					maxScore,
					hasDecimal,
					hasStarIcon,
					hasSmileyIcon
				});
				return detected;
			}
			function normalizeScore(score, scoreSystem, isPercentage = false) {
				if (isNaN(score) || score <= 0) return null;
				if (isPercentage) return score;
				switch (scoreSystem) {
					case "POINT_100": return score;
					case "POINT_10_DECIMAL":
					case "POINT_10": return score * 10;
					case "POINT_5": return score * 20;
					case "POINT_3": return score === 3 ? 100 : score === 2 ? 60 : 20;
					default: return score > 10 ? score : score * 10;
				}
			}
			function clearProcessedCell(el, fallbackText = "") {
				const container = el.querySelector(".ala-tier-container");
				if (container) {
					if (fallbackText) container.replaceWith(document.createTextNode(fallbackText));
					else container.remove();
				}
				delete el.dataset.tierModified;
				delete el.dataset.tierSource;
			}
			function processScoreElement(el, tiers, colorScore, viewerScoreFormat, isPercentage = false, isBlockView = false) {
				if (el.hasAttribute("data-ala-probe")) return;
				if (el.dataset.tierModified) {
					const attrNow = el.getAttribute("score");
					const changed = attrNow !== null && attrNow !== el.dataset.tierSource;
					if (el.querySelector(".ala-tier-container") && !changed) return;
					delete el.dataset.tierModified;
				}
				const attr = el.getAttribute("score");
				const rawText = (attr !== null ? attr : el.textContent || "").replace("%", "").trim();
				if (!rawText || rawText === "-" || rawText === "0") {
					clearProcessedCell(el, rawText);
					return;
				}
				const num = parseFloat(rawText);
				if (isNaN(num) || num <= 0) {
					clearProcessedCell(el, rawText);
					return;
				}
				const normalizedRating = normalizeScore(num, el.closest(".compare") ? getCompareColumnFormat(el, viewerScoreFormat) : getScoreSystem(viewerScoreFormat), isPercentage);
				if (normalizedRating === null) {
					clearProcessedCell(el, rawText);
					return;
				}
				const tier = getTier(normalizedRating, tiers);
				if (!tier) {
					clearProcessedCell(el, rawText);
					return;
				}
				ctx.log.debug("Applied tier badge:", tier.label, "to raw score:", rawText, "normalized:", normalizedRating);
				el.dataset.tierModified = "true";
				el.dataset.tierSource = attr ?? "";
				const container = document.createElement("div");
				container.className = `ala-tier-container ${isBlockView ? "ala-tier-container--block" : ""}`;
				const scoreSpan = document.createElement("span");
				scoreSpan.className = "ala-tier-score-text";
				if (colorScore) scoreSpan.style.color = tier.color;
				const icon = el.querySelector("svg, .icon");
				if (icon) {
					scoreSpan.appendChild(icon.cloneNode(true));
					scoreSpan.appendChild(document.createTextNode(" " + rawText));
				} else scoreSpan.textContent = isPercentage ? `${rawText}%` : rawText;
				container.appendChild(scoreSpan);
				container.appendChild(createBadge(tier, isBlockView));
				el.textContent = "";
				el.appendChild(container);
			}
			function processTop100Elements(tiers, colorScore) {
				document.querySelectorAll(".row.score").forEach((row) => {
					const percentageEl = row.querySelector(".percentage");
					if (!percentageEl || percentageEl.classList.contains("popularity")) return;
					if (percentageEl.dataset.tierModified) {
						if (percentageEl.querySelector(".ala-tier-container")) return;
						delete percentageEl.dataset.tierModified;
					}
					const textNode = Array.from(percentageEl.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent || "").trim() !== "");
					if (!textNode) return;
					const ratingText = (textNode.textContent || "").trim().replace("%", "");
					const numericRating = parseFloat(ratingText);
					if (isNaN(numericRating) || numericRating <= 0) return;
					const tier = getTier(numericRating, tiers);
					if (!tier) return;
					percentageEl.dataset.tierModified = "true";
					textNode.remove();
					const ratingWrapper = document.createElement("div");
					ratingWrapper.className = "ala-tier-container";
					ratingWrapper.style.display = "inline-flex";
					ratingWrapper.style.alignItems = "center";
					ratingWrapper.style.gap = "6px";
					const textSpan = document.createElement("span");
					textSpan.className = "ala-tier-score-text";
					textSpan.textContent = numericRating + "%";
					if (colorScore) textSpan.style.color = tier.color;
					ratingWrapper.appendChild(textSpan);
					ratingWrapper.appendChild(createBadge(tier));
					const popularityEl = percentageEl.querySelector(".sub-row.popularity");
					if (popularityEl) percentageEl.insertBefore(ratingWrapper, popularityEl);
					else percentageEl.appendChild(ratingWrapper);
				});
			}
			function applyTierLabels() {
				const tiers = getValidTiers(ctx.get("tierLabels"));
				const colorScore = !!ctx.get("tierLabelsColorScore");
				const showAverage = !!ctx.get("tierLabelsAverageScore");
				const viewerScoreFormat = ctx.session.scoreFormat;
				document.querySelectorAll(".score:not(.media-card .score):not(.entry-card .score)").forEach((el) => {
					processScoreElement(el, tiers, colorScore, viewerScoreFormat, false, false);
				});
				document.querySelectorAll(".entry-card .score").forEach((el) => {
					processScoreElement(el, tiers, colorScore, viewerScoreFormat, false, true);
				});
				if (showAverage) document.querySelectorAll(".data-set").forEach((dataSet) => {
					const label = dataSet.querySelector(".type");
					const value = dataSet.querySelector(".value");
					if (label && value && (label.textContent || "").includes("Weighted Score")) processScoreElement(value, tiers, colorScore, viewerScoreFormat, true, false);
				});
				processTop100Elements(tiers, colorScore);
			}
			function cleanupTierDom() {
				document.querySelectorAll(".ala-tier-container").forEach((container) => {
					const parent = container.parentElement;
					if (!parent) {
						container.remove();
						return;
					}
					const scoreSpan = container.querySelector(".ala-tier-score-text");
					if (scoreSpan) while (scoreSpan.firstChild) parent.insertBefore(scoreSpan.firstChild, container);
					container.remove();
				});
				document.querySelectorAll("[data-tier-modified]").forEach((el) => {
					delete el.dataset.tierModified;
					delete el.dataset.tierSource;
				});
				document.querySelectorAll(".compare").forEach((c) => {
					delete c._colFormats;
				});
			}
			const HINT_KEY = "standalone_seen";
			let paused = !!ctx.storage.get(HINT_KEY, false);
			let disposed = false;
			let cancelScanTimer = null;
			const cancelPendingScan = () => {
				if (cancelScanTimer) {
					cancelScanTimer();
					cancelScanTimer = null;
				}
			};
			const runScan = () => {
				if (!paused && !disposed) applyTierLabels();
			};
			ctx.onCleanup(() => {
				disposed = true;
				cancelPendingScan();
				cleanupTierDom();
				probeCache = null;
			});
			ctx.ready(() => {
				runScan();
				const unsubNav = ctx.onNav(() => {
					document.querySelectorAll(".compare").forEach((c) => {
						delete c._colFormats;
					});
					runScan();
				});
				const unsubBody = ctx.onBodyMutation(() => {
					if (paused || disposed || cancelScanTimer) return;
					cancelScanTimer = ctx.timeout(() => {
						cancelScanTimer = null;
						runScan();
					}, 100);
				});
				probeTierLabels().then((found) => {
					if (disposed) return;
					ctx.storage.set(HINT_KEY, found);
					const wasPaused = paused;
					paused = found;
					if (found) {
						cancelPendingScan();
						unsubNav();
						unsubBody();
						cleanupTierDom();
						if (!wasPaused) ctx.log.warn("Built-in Tier Labels paused: the standalone AniList Tier Labels script is installed. Uninstall it to use the built-in version.");
						ctx.setStandalonePaused(true);
					} else {
						ctx.setStandalonePaused(false);
						if (wasPaused) runScan();
					}
				});
			});
		}
	});
	var hasOwn$1 = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
	var DEV_MODE_DEF = {
		id: "devMode",
		key: "devModeEnabled",
		debugKey: "debug",
		section: "Advanced",
		title: "Developer Mode",
		help: "Enable developer diagnostics and verbose module logging in the browser console.",
		coreDebug: CORE_DEBUG_MASTER,
		coreChannels: CORE_DEBUG_CHANNELS
	};
	function getDefaultDebugSettings() {
		const out = { [CORE_DEBUG_SCOPE]: {
			enabled: false,
			channels: Object.fromEntries(Object.values(CORE_DEBUG_CHANNELS).map((ch) => [ch.id, true]))
		} };
		const debugModules = features.filter((f) => Boolean(f.debug && f.debug.debug !== false && f.id !== "core")).sort((a, b) => a.id.localeCompare(b.id));
		for (const f of debugModules) {
			const debuggable = getDebuggableChannels(f.debug);
			out[f.id] = debuggable.length ? {
				enabled: false,
				channels: Object.fromEntries([["general", true], ...debuggable.map(([chId]) => [chId, true])])
			} : { enabled: false };
		}
		return out;
	}
	function normalizeDebugSettings(raw) {
		const defaults = getDefaultDebugSettings();
		const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
		const out = {};
		for (const [scope, defEntry] of Object.entries(defaults)) {
			const src = hasOwn$1(input, scope) ? input[scope] : void 0;
			const enabled = src && typeof src === "object" ? parseToggle(src.enabled) : false;
			if (defEntry.channels) {
				const srcChannels = src && typeof src === "object" && src.channels && typeof src.channels === "object" ? src.channels : {};
				const channels = {};
				for (const [chId, defVal] of Object.entries(defEntry.channels)) channels[chId] = hasOwn$1(srcChannels, chId) ? parseToggle(srcChannels[chId]) : defVal;
				out[scope] = {
					enabled,
					channels
				};
			} else out[scope] = { enabled };
		}
		for (const [scope, src] of Object.entries(input)) {
			if (hasOwn$1(out, scope)) continue;
			if (scope === "__proto__" || scope === "constructor" || scope === "prototype") continue;
			if (!src || typeof src !== "object" || Array.isArray(src)) continue;
			const entry = { enabled: parseToggle(src.enabled) };
			if (src.channels && typeof src.channels === "object" && !Array.isArray(src.channels)) {
				const channels = {};
				for (const [chId, chVal] of Object.entries(src.channels)) {
					if (chId === "__proto__" || chId === "constructor" || chId === "prototype") continue;
					channels[chId] = parseToggle(chVal);
				}
				if (Object.keys(channels).length > 0) entry.channels = channels;
			}
			out[scope] = entry;
		}
		return out;
	}
	Settings.registerCoreSetting({
		key: DEV_MODE_DEF.key,
		type: "toggle",
		def: false,
		title: DEV_MODE_DEF.title,
		help: DEV_MODE_DEF.help
	});
	var debugRow = Settings.registerCoreSetting({
		key: DEV_MODE_DEF.debugKey,
		type: "json",
		def: {},
		title: "Debug Channels",
		help: "Per-subsystem and per-module debug channel configuration.",
		validate: (val) => ({
			valid: true,
			value: normalizeDebugSettings(val)
		})
	});
	Object.defineProperty(debugRow, "def", {
		get: () => getDefaultDebugSettings(),
		enumerable: true,
		configurable: true
	});
	var CREDITS = [
		{
			name: "Daiya",
			url: "https://github.com/Daiya404",
			note: "Combining, fixing and maintaining this script, and the standalone script check for Fast Load and Tier Labels. Everything not credited below, such as the Keyframe Staff List button, the List Score & Progress Editor, and AniList Fast Load, is original work.",
			works: [["AL-Additions on GitHub", "https://github.com/Daiya404/AL-Additions"], ["AniList Fast Load on GitHub", "https://github.com/Daiya404/AL-Fast-Load"]]
		},
		{
			name: "MatiX221",
			url: "https://github.com/MatiX221",
			note: "The API limit fix idea, modularising the script, general bug fixes, AniList Fast Load and Tier Labels integration and improvements, Compare View improvements, manual sync mappings, and the backup and restore feature.",
			works: [["MatiX221/AL-Additions", "https://github.com/MatiX221/AL-Additions"]]
		},
		{
			name: "Plennhar",
			url: "https://greasyfork.org/en/users/1323916-plennhar",
			note: "Browse Tag Rank Filter and Airing Progress Indicator.",
			works: [["AniList Browse: set default minimum tag percentage to 50", "https://greasyfork.org/en/scripts/559539-anilist-browse-set-default-minimum-tag-percentage-to-50"], ["AniList: color airing dots on anime lists orange if the user is behind on episodes", "https://greasyfork.org/en/scripts/563899-anilist-color-airing-dots-on-anime-lists-orange-if-the-user-is-behind-on-episodes"]]
		},
		{
			name: "Morimasa",
			url: "https://greasyfork.org/en/users/61126-morimasa",
			note: "Anime OP/ED songs.",
			works: [["Anisongs", "https://greasyfork.org/en/scripts/374785-anisongs"]]
		},
		{
			name: "Samu",
			url: "https://greasyfork.org/en/users/17840-samu",
			note: "Nyaa search link.",
			works: [["Find on Nyaa", "https://greasyfork.org/en/scripts/379776-find-on-nyaa"]]
		},
		{
			name: "trevor229",
			url: "https://greasyfork.org/en/users/158806-trevor229",
			note: "Banner Downloader.",
			works: [["AniList Banner Downloader", "https://greasyfork.org/en/scripts/370470-anilist-banner-downloader"]]
		},
		{
			name: "meatloaf1",
			url: "https://greasyfork.org/en/users/1630083-meatloaf1",
			note: "Short AniList URLs.",
			works: [["Remove AniList titles from URL", "https://greasyfork.org/en/scripts/589540-remove-anilist-titles-from-url"]]
		},
		{
			name: "MALSync",
			url: "https://github.com/MALSync",
			note: "Inspiration for the MyAnimeList sync, and for the episode/chapter and score embedding.",
			works: [["MALSync on GitHub", "https://github.com/MALSync/MALSync"]]
		},
		{
			name: "ercarp",
			url: "https://greasyfork.org/en/users/1434372-ercarp",
			note: "AniList Tier Labels.",
			works: [["AniList Tier Labels", "https://greasyfork.org/en/scripts/526694-anilist-tier-labels"]]
		},
		{
			name: "Claude & ChatGPT",
			note: "AI assistance throughout the consolidation and fixes."
		}
	];
	var creditLink = (url, text, cls = "") => `<a${cls ? ` class="${cls}"` : ""} href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
	var creditsHtml = () => CREDITS.map((c) => `<div class="ala-credit"><b>${c.url ? creditLink(c.url, c.name) : esc(c.name)}</b> — ${esc(c.note)}${c.works ? `<ul>${c.works.map(([label, url]) => `<li>${creditLink(url, label)}</li>`).join("")}</ul>` : ""}</div>`).join("");
	var MODAL_CSS = `
  #ala-pwd-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(5, 12, 20, 0.75);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 100005;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    box-sizing: border-box;
  }
  .ala-pwd-sheet {
    width: 100%;
    max-width: 420px;
    background: rgb(var(--color-foreground, 31, 38, 49));
    color: rgb(var(--color-text, 240, 243, 246));
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: alaModalPop 0.15s ease-out;
  }
  #ala-pwd-backdrop .ala-sheet {
    box-sizing: border-box;
    max-height: 92vh;
    font-size: 14px;
    line-height: 1.4;
  }
  #ala-pwd-backdrop .ala-sheet * {
    box-sizing: border-box;
  }
  #ala-pwd-backdrop .ala-sheet :focus-visible {
    outline: 2px solid rgb(var(--color-blue, 61, 180, 242));
    outline-offset: 2px;
  }
  #ala-pwd-backdrop .ala-sheet-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 20px 10px;
  }
  #ala-pwd-backdrop .ala-sheet-head h2 {
    margin: 0;
    font-family: inherit;
    font-size: 19px;
    font-weight: 600;
    line-height: 1.3;
  }
  #ala-pwd-backdrop .ala-sheet-body {
    flex: 1 1 auto;
    min-height: 0;
    padding: 0 20px 8px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  #ala-pwd-backdrop .ala-sheet-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding: 12px 20px;
    border-top: 1px solid rgba(var(--color-text-lighter, 146, 154, 166), 0.14);
  }
  #ala-pwd-backdrop .ala-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 38px;
    padding: 0 18px;
    border: 1px solid rgba(var(--color-text-lighter, 146, 154, 166), 0.25);
    border-radius: 4px;
    background: transparent;
    color: rgb(var(--color-text, 240, 243, 246));
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  #ala-pwd-backdrop .ala-btn--primary {
    border-color: transparent;
    background: rgb(var(--color-blue, 61, 180, 242));
    color: #fff;
    font-weight: 600;
  }
  #ala-pwd-backdrop .ala-btn:hover {
    filter: brightness(1.1);
  }
  #ala-pwd-backdrop .ala-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: rgb(var(--color-text-lighter, 146, 154, 166));
    cursor: pointer;
  }
  #ala-pwd-backdrop .ala-icon-btn:hover {
    background: rgba(var(--color-text-lighter, 146, 154, 166), 0.14);
    color: rgb(var(--color-text, 240, 243, 246));
  }
  @keyframes alaModalPop {
    from { opacity: 0; transform: scale(0.96) translateY(-4px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }
  .ala-pwd-desc {
    margin: 0 0 16px;
    font-size: 13px;
    color: rgb(var(--color-text-lighter, 146, 154, 166));
    line-height: 1.45;
  }
  .ala-pwd-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ala-pwd-label {
    font-size: 12px;
    font-weight: 600;
    color: rgb(var(--color-text-lighter, 146, 154, 166));
  }
  .ala-pwd-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
  }
  .ala-pwd-field {
    width: 100%;
    height: 40px;
    padding: 0 38px 0 12px;
    border-radius: 6px;
    border: 1px solid rgba(var(--color-text-lighter, 146, 154, 166), 0.25);
    background: rgb(var(--color-background, 15, 23, 42));
    color: rgb(var(--color-text, 240, 243, 246));
    font: inherit;
    font-size: 14px;
    box-sizing: border-box;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .ala-pwd-field:focus {
    outline: none;
    border-color: rgb(var(--color-blue, 61, 180, 242));
    box-shadow: 0 0 0 2px rgba(var(--color-blue, 61, 180, 242), 0.25);
  }
  .ala-pwd-toggle {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: rgb(var(--color-text-lighter, 146, 154, 166));
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }
  .ala-pwd-toggle:hover {
    color: rgb(var(--color-text, 240, 243, 246));
    background: rgba(var(--color-text-lighter, 146, 154, 166), 0.12);
  }
  .ala-pwd-error {
    margin-top: 12px;
    padding: 8px 12px;
    border-radius: 6px;
    background: rgba(var(--color-red, 224, 85, 85), 0.12);
    border: 1px solid rgba(var(--color-red, 224, 85, 85), 0.3);
    color: rgb(var(--color-red, 224, 85, 85));
    font-size: 12px;
    font-weight: 500;
  }
`;
	var EYE_OPEN = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
	var EYE_OFF = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
	var activeCancel = null;
	function closePasswordModal() {
		activeCancel?.();
	}
	function promptPasswordModal(options) {
		return new Promise((resolve) => {
			activeCancel?.();
			if (!document.body) {
				resolve(null);
				return;
			}
			const disposeStyle = addStyle("ala-pwd-modal-style", MODAL_CSS);
			const disposeOwn = Core.registerOwnUi("#ala-pwd-backdrop");
			const existing = document.getElementById("ala-pwd-backdrop");
			if (existing) existing.remove();
			const backdrop = document.createElement("div");
			backdrop.id = "ala-pwd-backdrop";
			backdrop.innerHTML = `
      <div class="ala-sheet ala-pwd-sheet" role="dialog" aria-modal="true" aria-labelledby="ala-pwd-title">
        <header class="ala-sheet-head">
          <h2 id="ala-pwd-title">${esc(options.title)}</h2>
          <button class="ala-icon-btn ala-pwd-btn-close" type="button" aria-label="Close">✕</button>
        </header>
        <div class="ala-sheet-body">
          ${options.description ? `<p class="ala-pwd-desc">${esc(options.description)}</p>` : ""}
          <div class="ala-pwd-group">
            <label for="ala-pwd-input-main" class="ala-pwd-label">Password</label>
            <div class="ala-pwd-input-wrap">
              <input
                id="ala-pwd-input-main"
                class="ala-pwd-field"
                type="password"
                placeholder="${esc(options.placeholder || "Enter password")}"
                autocomplete="${options.confirm ? "new-password" : "current-password"}"
              />
              <button type="button" class="ala-pwd-toggle" title="Show / Hide password" aria-label="Toggle password visibility">
                ${EYE_OPEN}
              </button>
            </div>
          </div>
          ${options.confirm ? `
            <div class="ala-pwd-group" style="margin-top:12px">
              <label for="ala-pwd-input-confirm" class="ala-pwd-label">Confirm Password</label>
              <div class="ala-pwd-input-wrap">
                <input
                  id="ala-pwd-input-confirm"
                  class="ala-pwd-field"
                  type="password"
                  placeholder="Re-enter password"
                  autocomplete="new-password"
                />
              </div>
            </div>
          ` : ""}
          <div class="ala-pwd-error" id="ala-pwd-err" style="display:none"></div>
        </div>
        <footer class="ala-sheet-foot">
          <button class="ala-btn ala-btn--primary" id="ala-pwd-btn-submit" type="button">
            ${esc(options.submitText || "Submit")}
          </button>
          <button class="ala-btn" id="ala-pwd-btn-cancel" type="button">
            ${esc(options.cancelText || "Cancel")}
          </button>
        </footer>
      </div>
    `;
			document.body.appendChild(backdrop);
			const input = backdrop.querySelector("#ala-pwd-input-main");
			const confirmInput = backdrop.querySelector("#ala-pwd-input-confirm");
			const toggleBtn = backdrop.querySelector(".ala-pwd-toggle");
			const errBox = backdrop.querySelector("#ala-pwd-err");
			const submitBtn = backdrop.querySelector("#ala-pwd-btn-submit");
			const cancelBtn = backdrop.querySelector("#ala-pwd-btn-cancel");
			const closeBtn = backdrop.querySelector(".ala-pwd-btn-close");
			let isVisible = false;
			let settled = false;
			let focusTimer = null;
			let overlay = null;
			const onKeyDown = (e) => {
				if (e.key === "Escape") {
					if (!overlay?.isTop()) return;
					e.preventDefault();
					e.stopImmediatePropagation();
					cancel();
				} else if (e.key === "Enter") {
					if (!overlay?.isTop()) return;
					const target = e.target;
					if (target instanceof Element) {
						if (backdrop.contains(target)) {
							if (target.closest("button, a, [role=\"button\"]")) return;
						} else if (target !== document.body && target !== document.documentElement) {
							e.preventDefault();
							e.stopPropagation();
							return;
						}
					}
					e.preventDefault();
					e.stopPropagation();
					submit();
				}
			};
			const cleanup = () => {
				if (settled) return;
				settled = true;
				if (focusTimer !== null) {
					clearTimeout(focusTimer);
					focusTimer = null;
				}
				document.removeEventListener("keydown", onKeyDown, true);
				overlay?.dispose();
				overlay = null;
				if (activeCancel === cancel) activeCancel = null;
				backdrop.remove();
				disposeOwn();
				disposeStyle();
			};
			const cancel = () => {
				if (settled) return;
				cleanup();
				resolve(null);
			};
			const submit = () => {
				if (settled) return;
				const val = input.value;
				if (!options.allowEmpty && !val.trim()) {
					errBox.textContent = "Password cannot be empty.";
					errBox.style.display = "block";
					input.focus();
					return;
				}
				if (val.length > 0 && !val.trim()) {
					errBox.textContent = "Password cannot contain only whitespace.";
					errBox.style.display = "block";
					input.focus();
					return;
				}
				if (options.confirm && confirmInput) {
					if (val !== confirmInput.value) {
						errBox.textContent = "Passwords do not match.";
						errBox.style.display = "block";
						confirmInput.focus();
						return;
					}
				}
				cleanup();
				resolve(val);
			};
			activeCancel = cancel;
			overlay = registerModalOverlay(cancel);
			toggleBtn.addEventListener("click", () => {
				isVisible = !isVisible;
				const type = isVisible ? "text" : "password";
				input.type = type;
				if (confirmInput) confirmInput.type = type;
				toggleBtn.innerHTML = isVisible ? EYE_OFF : EYE_OPEN;
				toggleBtn.title = isVisible ? "Hide password" : "Show password";
			});
			submitBtn.addEventListener("click", submit);
			cancelBtn.addEventListener("click", cancel);
			closeBtn.addEventListener("click", cancel);
			backdrop.addEventListener("click", (e) => {
				if (e.target === backdrop) cancel();
			});
			document.addEventListener("keydown", onKeyDown, true);
			focusTimer = setTimeout(() => {
				focusTimer = null;
				input.focus();
			}, 50);
		});
	}
	var settingsLog$1 = createCoreLogger("settings");
	var BACKUP_FILENAME = "al-additions.settings";
	var MAGIC_PLAIN = new Uint8Array([
		65,
		76,
		65,
		83
	]);
	var MAGIC_ENCRYPTED = new Uint8Array([
		65,
		76,
		65,
		69
	]);
	var PBKDF2_ITERATIONS = 1e5;
	var hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
	function isPlainObject(value) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const proto = Object.getPrototypeOf(value);
		return proto === Object.prototype || proto === null;
	}
	function validateBackupPayloadEnvelope(payload) {
		if (!isPlainObject(payload)) throw new Error("Invalid backup file: root must be an object.");
		if (typeof payload.version === "number" && payload.version !== 1) throw new Error(`Unsupported backup version: ${payload.version}. This version of AL Additions only supports version 1.`);
	}
	function extractBackupPayloadData(payload) {
		validateBackupPayloadEnvelope(payload);
		if (hasOwn(payload, "version") || hasOwn(payload, "data")) {
			if (!isPlainObject(payload.data)) throw new Error("Backup data is invalid or empty.");
			return payload.data;
		}
		return payload;
	}
	function isValidSecretValue(key, value) {
		if (key.endsWith("_at")) return typeof value === "number" && Number.isFinite(value) && value >= 0;
		return typeof value === "string" && value.trim().length > 0;
	}
	function collectBackupData(includeSecrets, overrides) {
		const data = {};
		for (const r of Object.values(ROWS)) {
			const rawVal = overrides && hasOwn(overrides, r.key) ? overrides[r.key] : store$1.get(SETTING_PREFIX + r.key, r.def);
			data[r.key] = rawVal;
		}
		if (includeSecrets) for (const key of getAccountSecretKeys()) {
			const val = store$1.get(key, void 0);
			if (val !== void 0 && val !== null) data[key] = val;
		}
		return data;
	}
	function matchesMagic(bytes, magic) {
		if (bytes.length < magic.length) return false;
		for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
		return true;
	}
	function base64ToUint8(b64) {
		const binary = atob(b64.replace(/\s+/g, ""));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}
	async function deriveAesKey(password, salt) {
		const enc = new TextEncoder();
		const baseKey = await window.crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
		return window.crypto.subtle.deriveKey({
			name: "PBKDF2",
			salt,
			iterations: PBKDF2_ITERATIONS,
			hash: "SHA-256"
		}, baseKey, {
			name: "AES-GCM",
			length: 256
		}, false, ["encrypt", "decrypt"]);
	}
	async function decryptData(cryptoData, password) {
		const salt = base64ToUint8(cryptoData.salt);
		const iv = base64ToUint8(cryptoData.iv);
		const ciphertext = base64ToUint8(cryptoData.ciphertext);
		const key = await deriveAesKey(password, salt);
		const decryptedBuffer = await window.crypto.subtle.decrypt({
			name: "AES-GCM",
			iv
		}, key, ciphertext);
		return new TextDecoder().decode(decryptedBuffer);
	}
	async function compressDeflateRaw(data) {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
		const buffer = await new Response(stream).arrayBuffer();
		return new Uint8Array(buffer);
	}
	async function decompressDeflateRaw(data) {
		const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
		return await new Response(stream).text();
	}
	async function decompressGzip(data) {
		const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
		return await new Response(stream).text();
	}
	async function createBackup(includeSecrets, password, overrides) {
		if (includeSecrets && !(password && password.trim().length > 0)) throw new Error("A password is required to export credentials.");
		if (typeof password === "string" && password.length > 0 && !password.trim()) throw new Error("Password cannot contain only whitespace.");
		const data = collectBackupData(includeSecrets, overrides);
		const plainPayload = {
			version: 1,
			exportedAt: Date.now(),
			data
		};
		const jsonBytes = new TextEncoder().encode(JSON.stringify(plainPayload));
		const compressedBytes = await compressDeflateRaw(jsonBytes);
		if (password && password.trim().length > 0) {
			const salt = window.crypto.getRandomValues(new Uint8Array(16));
			const iv = window.crypto.getRandomValues(new Uint8Array(12));
			const key = await deriveAesKey(password, salt);
			const ciphertextBuffer = await window.crypto.subtle.encrypt({
				name: "AES-GCM",
				iv
			}, key, compressedBytes);
			const ciphertext = new Uint8Array(ciphertextBuffer);
			const out = new Uint8Array(33 + ciphertext.length);
			out.set(MAGIC_ENCRYPTED, 0);
			out[4] = 1;
			out.set(salt, 5);
			out.set(iv, 21);
			out.set(ciphertext, 33);
			settingsLog$1.debug(`Created encrypted backup (${out.length} bytes, compressed from ${jsonBytes.length} bytes)`);
			return out;
		} else {
			const out = new Uint8Array(5 + compressedBytes.length);
			out.set(MAGIC_PLAIN, 0);
			out[4] = 1;
			out.set(compressedBytes, 5);
			settingsLog$1.debug(`Created plain backup (${out.length} bytes, compressed from ${jsonBytes.length} bytes)`);
			return out;
		}
	}
	function createRawBackup(overrides) {
		const data = collectBackupData(true, overrides);
		return JSON.stringify({
			version: 1,
			exportedAt: Date.now(),
			data
		}, null, 2);
	}
	function downloadBackupFile(bytes, filename = BACKUP_FILENAME) {
		const blob = new Blob([bytes], { type: "application/octet-stream" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1e3);
	}
	function applyVersion1Settings(data) {
		if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Backup data is invalid or empty.");
		let applied = 0;
		let secretsApplied = 0;
		CoreHooks.setSessionClearing(true);
		try {
			for (const k of ANILIST_SESSION_KEYS) store$1.del(k);
			const secretKeys = new Set(getAccountSecretKeys());
			for (const [key, rawValue] of Object.entries(data)) {
				if (ANILIST_SESSION_KEYS.includes(key)) continue;
				if (secretKeys.has(key)) {
					if (isValidSecretValue(key, rawValue)) {
						store$1.set(key, rawValue);
						secretsApplied++;
					}
					continue;
				}
				const settingKey = key.startsWith("ala_setting_") ? key.slice(SETTING_PREFIX.length) : key;
				const r = hasOwn(ROWS, settingKey) ? ROWS[settingKey] : void 0;
				if (r) {
					const normalized = TYPES$1[r.type].normalize(rawValue, r);
					store$1.set(SETTING_PREFIX + settingKey, normalized);
					applied++;
				}
			}
			const hasExplicitOverridesFlag = hasOwn(data, "manualOverridesEnabled") || hasOwn(data, `ala_setting_manualOverridesEnabled`);
			const rawOverrides = (hasOwn(data, "syncManualOverrides") ? data.syncManualOverrides : void 0) ?? (hasOwn(data, `ala_setting_syncManualOverrides`) ? data[`ala_setting_syncManualOverrides`] : void 0);
			if (!hasExplicitOverridesFlag && rawOverrides !== void 0 && hasOwn(ROWS, "syncManualOverrides") && hasOwn(ROWS, "manualOverridesEnabled")) {
				const overridesRow = ROWS.syncManualOverrides;
				const normalizedOverrides = TYPES$1[overridesRow.type].normalize(rawOverrides, overridesRow);
				if (normalizedOverrides && typeof normalizedOverrides === "object" && !Array.isArray(normalizedOverrides) && Object.keys(normalizedOverrides).length > 0) {
					store$1.set(`${SETTING_PREFIX}manualOverridesEnabled`, true);
					applied++;
				}
			}
		} finally {
			CoreHooks.setSessionClearing(false);
		}
		if (applied === 0 && secretsApplied === 0) throw new Error("No recognized settings found in the backup file.");
		return {
			applied,
			secretsApplied
		};
	}
	async function handleLegacyJsonBackup(jsonText, promptPassword) {
		let payload;
		try {
			payload = JSON.parse(jsonText);
		} catch {
			throw new Error("Invalid backup file: corrupted JSON content.");
		}
		validateBackupPayloadEnvelope(payload);
		if (payload.encrypted === true) {
			if (!payload.crypto || typeof payload.crypto !== "object" || !payload.crypto.salt || !payload.crypto.iv || !payload.crypto.ciphertext) throw new Error("Encrypted backup is missing cryptographic data.");
			const password = await promptPassword("Enter password to decrypt your settings backup:");
			if (password === null) return {
				applied: 0,
				secretsApplied: 0,
				cancelled: true
			};
			if (!password) throw new Error("Password cannot be empty.");
			let decryptedText;
			try {
				decryptedText = await decryptData(payload.crypto, password);
			} catch {
				throw new Error("Incorrect password or corrupted backup file.");
			}
			let data;
			try {
				data = JSON.parse(decryptedText);
			} catch {
				throw new Error("Decrypted content is not valid JSON.");
			}
			return applyVersion1Settings(data);
		}
		return applyVersion1Settings(extractBackupPayloadData(payload));
	}
	async function importBackup(fileInput, customPromptPassword) {
		let bytes;
		if (typeof fileInput === "string") bytes = new TextEncoder().encode(fileInput);
		else bytes = fileInput;
		if (!bytes || bytes.length === 0) throw new Error("Backup file is empty.");
		const promptPassword = customPromptPassword || ((hint) => promptPasswordModal({
			title: "Decrypt Settings Backup",
			description: hint || "Enter your password to decrypt your settings backup:",
			submitText: "Decrypt & Restore",
			allowEmpty: false,
			confirm: false,
			placeholder: "Enter backup password"
		}));
		if (matchesMagic(bytes, MAGIC_ENCRYPTED)) {
			if (bytes.length < 49) throw new Error("Invalid encrypted backup file: file is truncated.");
			const version = bytes[4];
			if (version !== 1) throw new Error(`Unsupported backup version: ${version}. This version of AL Additions only supports version 1.`);
			const password = await promptPassword("Enter password to decrypt your settings backup:");
			if (password === null) return {
				applied: 0,
				secretsApplied: 0,
				cancelled: true
			};
			if (!password) throw new Error("Password cannot be empty.");
			const salt = bytes.subarray(5, 21);
			const iv = bytes.subarray(21, 33);
			const ciphertext = bytes.subarray(33);
			const key = await deriveAesKey(password, salt);
			let decryptedBuffer;
			try {
				decryptedBuffer = await window.crypto.subtle.decrypt({
					name: "AES-GCM",
					iv
				}, key, ciphertext);
			} catch {
				throw new Error("Incorrect password or corrupted backup file.");
			}
			let jsonText;
			try {
				jsonText = await decompressDeflateRaw(new Uint8Array(decryptedBuffer));
			} catch {
				throw new Error("Corrupted decrypted data: failed to decompress.");
			}
			let payload;
			try {
				payload = JSON.parse(jsonText);
			} catch {
				throw new Error("Decrypted content is not valid JSON.");
			}
			settingsLog$1.debug("Imported encrypted binary backup successfully.");
			return applyVersion1Settings(extractBackupPayloadData(payload));
		}
		if (matchesMagic(bytes, MAGIC_PLAIN)) {
			if (bytes.length < 5) throw new Error("Invalid backup file: file is truncated.");
			const version = bytes[4];
			if (version !== 1) throw new Error(`Unsupported backup version: ${version}. This version of AL Additions only supports version 1.`);
			let jsonText;
			try {
				jsonText = await decompressDeflateRaw(bytes.subarray(5));
			} catch {
				throw new Error("Corrupted backup file: failed to decompress.");
			}
			let payload;
			try {
				payload = JSON.parse(jsonText);
			} catch {
				throw new Error("Corrupted backup file: invalid JSON content.");
			}
			settingsLog$1.debug("Imported plain binary backup successfully.");
			return applyVersion1Settings(extractBackupPayloadData(payload));
		}
		if (bytes.length >= 2 && bytes[0] === 31 && bytes[1] === 139) {
			let jsonText;
			try {
				jsonText = await decompressGzip(bytes);
			} catch {
				throw new Error("Corrupted or invalid GZIP backup file.");
			}
			settingsLog$1.debug("Imported legacy GZIP backup.");
			return handleLegacyJsonBackup(jsonText, promptPassword);
		}
		let jsonText;
		try {
			jsonText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new Error("Failed to decode backup file as UTF-8 text.");
		}
		settingsLog$1.debug("Imported legacy JSON/text backup.");
		return handleLegacyJsonBackup(jsonText, promptPassword);
	}
	async function readFileAsBytes(file) {
		if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(new Uint8Array(reader.result));
			reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
			reader.readAsArrayBuffer(file);
		});
	}
	var settingsLog = createCoreLogger("settings");
	var getRow = (key) => key && Object.prototype.hasOwnProperty.call(ROWS, key) ? ROWS[key] : void 0;
	var isNonEmptyValue = (val) => {
		if (Array.isArray(val)) return val.length > 0;
		if (!val || typeof val !== "object") return false;
		const proto = Object.getPrototypeOf(val);
		if (proto !== Object.prototype && proto !== null) return false;
		return Object.keys(val).length > 0;
	};
	var PINNED_FIRST = ["Sync", "General"];
	var PINNED_LAST = ["Advanced"];
	var NOOP_HOST = {
		reload: () => {},
		getStatus: () => ({ active: false }),
		resolveStagedStates: (stagedEnabled) => {
			const out = {};
			for (const [id, on] of Object.entries(stagedEnabled)) out[id] = {
				active: !!on,
				reason: on ? void 0 : "disabled"
			};
			return out;
		},
		onStatusChange: () => () => {},
		probeStandalone: async () => false
	};
	var CSS$1 = `
  .ala-settings-nav-section{margin-top:26px}
  .ala-settings-nav-heading{color:rgb(var(--color-text-lighter));margin-bottom:12px}
  .ala-settings-nav-link{display:block;padding:9px 12px;border-radius:3px;color:rgb(var(--color-text));text-decoration:none;cursor:pointer}
  .ala-settings-nav-link:hover,.ala-settings-nav-link.is-active{background:rgb(var(--color-foreground))}
  #ala-settings-mobile-launcher{display:none}

  #ala-settings-backdrop{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:rgba(5,12,20,.72);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
  #ala-settings-panel{box-sizing:border-box;display:flex;flex-direction:column;width:min(680px,100%);height:100%;max-height:100%;border-radius:8px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));font-size:14px;line-height:1.4;box-shadow:0 18px 60px rgba(0,0,0,.45);overflow:hidden;outline:none;transform:translateZ(0)}
  #ala-settings-panel *{box-sizing:border-box}
  #ala-settings-panel :focus-visible{outline:2px solid rgb(var(--color-blue));outline-offset:2px}
  #ala-settings-panel h2,#ala-settings-panel h3{margin:0;font-family:inherit}

  .ala-sheet-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 20px 10px}
  .ala-sheet-head h2{font-size:19px;font-weight:600;line-height:1.3}
  .ala-sheet-body{flex:1 1 auto;min-height:0;padding:0 20px 8px;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;scrollbar-gutter:stable}
  .ala-sheet-foot{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 20px;border-top:1px solid rgba(var(--color-text-lighter),.14)}
  .ala-status{flex:1 1 160px;color:rgb(var(--color-text-lighter));font-size:12px;transition:color .15s}
  .ala-status.is-error{color:rgb(var(--color-red,224,85,85));font-weight:600}

  #ala-settings-panel .ala-section-title{margin:18px 2px 8px;color:rgb(var(--color-blue));font-size:13px;font-weight:600}
  .ala-section{border-radius:6px;background:rgb(var(--color-background));overflow:hidden}
  .ala-section-dropdown{margin-top:14px;border-radius:6px;background:rgb(var(--color-background));overflow:hidden;contain:paint}
  .ala-section-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;min-height:48px;cursor:pointer;user-select:none;list-style:none;transition:background .15s}
  .ala-section-summary::-webkit-details-marker{display:none}
  .ala-section-summary:hover{background:rgba(var(--color-text-lighter),.06)}
  .ala-section-summary:focus-visible{outline:2px solid rgb(var(--color-blue));outline-offset:-2px}
  .ala-section-summary .ala-section-title{margin:0!important;color:rgb(var(--color-blue));font-size:13px;font-weight:600}
  .ala-chevron{display:inline-flex;align-items:center;justify-content:center;color:rgb(var(--color-text-lighter));transition:transform .22s cubic-bezier(0.4,0,0.2,1);will-change:transform}
  .ala-section-dropdown.is-expanded .ala-chevron{transform:rotate(180deg)}
  .ala-section-collapsible .ala-collapsible-inner{border-top:1px solid rgba(var(--color-text-lighter),.12)}

  .ala-collapsible{display:grid;grid-template-rows:0fr;transition:grid-template-rows .22s cubic-bezier(0.4,0,0.2,1),visibility 0s .22s;visibility:hidden;overflow:hidden}
  .ala-collapsible.is-open{grid-template-rows:1fr;transition:grid-template-rows .22s cubic-bezier(0.4,0,0.2,1),visibility 0s 0s;visibility:visible}
  .ala-collapsible-inner{min-height:0;overflow:hidden}

  .ala-feature+.ala-feature{border-top:1px solid rgba(var(--color-text-lighter),.12)}
  .ala-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:56px;padding:12px 14px;cursor:pointer}
  .ala-text{display:flex;flex-direction:column;gap:3px;min-width:0}
  .ala-title{display:flex;align-items:center;gap:8px;font-size:14px;color:rgb(var(--color-text))}
  .ala-help{color:rgb(var(--color-text-lighter));font-size:12px;line-height:1.4}
  .ala-options-collapsible{margin:0;padding:0}
  .ala-options{margin:0 14px 12px 20px;padding-left:12px;border-left:2px solid rgba(var(--color-blue),.4)}
  .ala-options .ala-row{min-height:48px;padding:8px 0;cursor:default}
  .ala-options .ala-row:has(.ala-switch){cursor:pointer}
  .ala-child-option{margin-left:8px}
  .ala-child-option .ala-collapsible-inner{border-left:2px solid rgba(var(--color-blue),.25);padding-left:10px}
  .ala-child-option .ala-row{min-height:44px;padding:6px 0}
  .ala-note{margin:0 14px 12px;padding:8px 10px;border-radius:4px;font-size:12px;line-height:1.45;color:rgb(var(--color-text))}
  .ala-standalone-note{border-left:3px solid rgb(var(--color-orange,255,152,0));background:rgba(var(--color-orange,255,152,0),.12)}
  .ala-dep-note{border-left:3px solid rgba(var(--color-text-lighter),.6);background:rgba(var(--color-text-lighter),.1)}
  .ala-host-note{border-left:3px solid rgb(var(--color-blue));background:rgba(var(--color-blue),.1)}
  .ala-error-note{border-left:3px solid rgb(var(--color-red,224,85,85));background:rgba(var(--color-red,224,85,85),.12)}
  .ala-badge{display:inline-flex;align-items:center;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
  .ala-badge--error{background:rgba(var(--color-red,224,85,85),.18);color:rgb(var(--color-red,224,85,85))}

  #ala-settings-panel input[type=number],#ala-settings-panel input[type=text],#ala-settings-panel select{width:170px;height:36px;padding:0 10px;border:1px solid rgba(var(--color-text-lighter),.22);border-radius:4px;background:rgb(var(--color-foreground));color:rgb(var(--color-text));font:inherit;font-size:13px}
  #ala-settings-panel input:disabled,#ala-settings-panel select:disabled{cursor:not-allowed}

  .ala-switch{position:relative;flex:0 0 auto;width:44px;height:26px}
  .ala-switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
  .ala-slider{position:absolute;inset:0;border-radius:999px;background:rgba(var(--color-text-lighter),.3);transition:background .15s;pointer-events:none}
  .ala-slider:before{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .15s}
  .ala-switch input:checked+.ala-slider{background:rgb(var(--color-blue))}
  .ala-switch input:checked+.ala-slider:before{transform:translateX(18px)}
  .ala-switch input:disabled{cursor:not-allowed}
  .ala-switch input:disabled+.ala-slider{opacity:.5}
  .ala-switch input:focus-visible+.ala-slider{outline:2px solid rgb(var(--color-blue));outline-offset:2px}

  .ala-btn{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 18px;border:1px solid rgba(var(--color-text-lighter),.25);border-radius:4px;background:transparent;color:rgb(var(--color-text));font:inherit;font-size:13px;cursor:pointer}
  .ala-btn--primary{border-color:transparent;background:rgb(var(--color-blue));color:#fff;font-weight:600}
  .ala-btn--danger{border-color:rgba(var(--color-red,224,85,85),.35);color:rgb(var(--color-red,224,85,85))}
  .ala-btn--danger:hover{border-color:transparent;background:rgb(var(--color-red,224,85,85));color:#fff}
  .ala-btn:hover{filter:brightness(1.1)}
  .ala-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:36px;height:36px;border:0;border-radius:50%;background:transparent;color:rgb(var(--color-text-lighter));cursor:pointer}
  .ala-icon-btn:hover{background:rgba(var(--color-text-lighter),.14);color:rgb(var(--color-text))}
  .ala-account-row{cursor:default}
  .ala-account-row .ala-btn{flex:0 0 auto;min-width:145px}
  .ala-credits-content{padding:12px 14px;color:rgb(var(--color-text-lighter));font-size:12px}
  .ala-credit{margin-top:10px}
  .ala-credit:first-child{margin-top:0}
  .ala-credit ul{margin:3px 0 0;padding-left:18px;list-style:disc}
  .ala-credit a{color:rgb(var(--color-blue));text-decoration:none}
  .ala-credit a:hover{text-decoration:underline}

  @media (max-width:700px){
    .ala-settings-nav-section{display:none!important}
    #ala-settings-backdrop{align-items:flex-end;padding:0}
    #ala-settings-panel{width:100%;height:92vh;height:92dvh;max-height:92vh;max-height:92dvh;border-radius:14px 14px 0 0}
    .ala-sheet-head{padding:16px 16px 8px}
    .ala-sheet-body{padding:0 16px 8px}
    .ala-sheet-foot{padding:12px 16px calc(12px + env(safe-area-inset-bottom))}
    .ala-sheet-foot .ala-btn{flex:1 1 40%;min-height:44px}
    .ala-status{flex-basis:100%;order:3}
    .ala-row{min-height:60px}
    .ala-options .ala-row{flex-direction:column;align-items:stretch;gap:8px}
    .ala-options .ala-row:has(.ala-switch){flex-direction:row;align-items:center;justify-content:space-between}
    .ala-account-row{flex-direction:column;align-items:stretch;gap:10px}
    .ala-account-row .ala-btn{width:100%;min-height:42px}
    #ala-settings-panel input[type=number],#ala-settings-panel input[type=text],#ala-settings-panel select{width:100%;height:44px;font-size:16px}
    #ala-settings-mobile-launcher{display:inline-flex;align-items:center;gap:8px;position:fixed;left:16px;bottom:calc(18px + env(safe-area-inset-bottom));z-index:99998;min-height:46px;padding:0 18px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgb(var(--color-blue));color:#fff;font:inherit;font-size:14px;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.35);cursor:pointer}
    #ala-settings-mobile-launcher:active{transform:translateY(1px)}
  }
  @media (prefers-reduced-motion:reduce){.ala-slider,.ala-slider:before,.ala-collapsible,.ala-chevron{transition:none!important}}`;
	var onSettingsPage = () => /^\/settings(\/|$)/.test(location.pathname);
	var rowText = (title, help) => `<span class="ala-text"><span class="ala-title">${title}</span><span class="ala-help">${help}</span></span>`;
	var optionRowHtml = (r) => {
		const tag = r.type === "json" ? "div" : "label";
		return `<${tag} class="ala-row">${rowText(r.title, r.help)}${TYPES$1[r.type].html(r, Settings.get(r.key))}</${tag}>`;
	};
	var optionHtml = (r) => {
		const rowHtml = optionRowHtml(r);
		if (r.childOf) return `<div class="ala-collapsible ala-child-option ${!!Settings.get(r.childOf) ? "is-open" : ""}" data-child-for="${r.childOf}">
      <div class="ala-collapsible-inner">
        ${rowHtml}
      </div>
    </div>`;
		return rowHtml;
	};
	var debugToggleRowHtml = (title, help, scope, checked, channel) => {
		const chAttr = channel ? ` data-debug-channel="${esc(channel)}"` : "";
		return `<label class="ala-row">${rowText(title, help)}<span class="ala-switch"><input type="checkbox" data-debug-scope="${esc(scope)}"${chAttr} ${checked ? "checked" : ""}><span class="ala-slider"></span></span></label>`;
	};
	var debugGroupHtml = (scope, masterTitle, masterHelp, masterOn, childHtmls) => {
		const masterHtml = debugToggleRowHtml(masterTitle, masterHelp, scope, masterOn);
		if (!childHtmls.length) return masterHtml;
		return `${masterHtml}
    <div class="ala-collapsible ala-child-option ${masterOn ? "is-open" : ""}" data-debug-children="${esc(scope)}">
      <div class="ala-collapsible-inner">
        ${childHtmls.join("")}
      </div>
    </div>`;
	};
	var featureHtml = (f) => {
		if (f.toggle.type === "json") return `<div class="ala-feature" data-feature="${esc(f.id)}">
      <div class="ala-row ala-row--main">${rowText(f.title, f.help)}${TYPES$1.json.html(f.toggle, Settings.get(f.toggle.key))}</div>
    </div>`;
		const isFeatureOn = !!Settings.get(f.toggle.key);
		return `<div class="ala-feature ${isFeatureOn ? "" : "is-off"}" data-feature="${esc(f.id)}">
    <label class="ala-row ala-row--main">${rowText(f.title, f.help)}${TYPES$1.toggle.html(f.toggle, isFeatureOn)}</label>
    ${f.options.length ? `
      <div class="ala-collapsible ala-options-collapsible ${isFeatureOn ? "is-open" : ""}">
        <div class="ala-collapsible-inner">
          <div class="ala-options">${f.options.map(optionHtml).join("")}</div>
        </div>
      </div>` : ""}
  </div>`;
	};
	function accountsHtml() {
		const providers = listAccountProviders();
		if (!providers.length) return "";
		return `<h3 class="ala-section-title">Connected Accounts</h3>
  <div class="ala-section">${providers.map((p, idx) => {
			const connected = p.isConnected();
			const border = idx > 0 ? " style=\"border-top:1px solid rgba(var(--color-text-lighter),.12)\"" : "";
			const connectLabel = p.id === "mal" ? "Connect to MAL" : `Connect to ${esc(p.name)}`;
			return `<div class="ala-row ala-account-row" data-account-id="${esc(p.id)}"${border}>
        <span class="ala-text">
          <span class="ala-title">${esc(p.name)}</span>
          <span class="ala-help" id="ala-status-${esc(p.id)}">${connected ? "Connected" : "Not connected"}</span>
        </span>
        <button type="button" class="ala-btn ${connected ? "ala-btn--danger" : "ala-btn--primary"}" data-account-btn="${esc(p.id)}">
          ${connected ? "Disconnect" : connectLabel}
        </button>
      </div>`;
		}).join("")}</div>`;
	}
	function backupRestoreHtml() {
		const isDev = !!Settings.get(DEV_MODE_DEF.key);
		return `<details class="ala-section-dropdown" data-section="backup">
    <summary class="ala-section-summary" aria-expanded="false">
      <span class="ala-section-title">Backup &amp; Restore</span>
      <span class="ala-chevron">${icon("chevron", 14)}</span>
    </summary>
    <div class="ala-collapsible ala-section-collapsible">
      <div class="ala-collapsible-inner">
        <div class="ala-section">
          <div class="ala-row ala-account-row">
            <span class="ala-text">
              <span class="ala-title">Export Settings</span>
              <span class="ala-help">Download all settings as a backup file. Excludes account credentials.</span>
            </span>
            <button type="button" class="ala-btn" id="ala-btn-export">Export</button>
          </div>
          <div class="ala-row ala-account-row" style="border-top:1px solid rgba(var(--color-text-lighter),.12)">
            <span class="ala-text">
              <span class="ala-title">Export with Credentials</span>
              <span class="ala-help">Include connected account tokens. A password is required.</span>
            </span>
            <button type="button" class="ala-btn ala-btn--danger" id="ala-btn-export-secrets">Export with Secrets</button>
          </div>
          <div class="ala-row ala-account-row" id="ala-row-export-raw" style="border-top:1px solid rgba(var(--color-text-lighter),.12);${isDev ? "" : "display:none;"}">
            <span class="ala-text">
              <span class="ala-title">Export Raw JSON</span>
              <span class="ala-help">Export unminified raw JSON including all settings and credentials without encryption (for testing/verification).</span>
            </span>
            <button type="button" class="ala-btn ala-btn--danger" id="ala-btn-export-raw">Export Raw JSON</button>
          </div>
          <div class="ala-row ala-account-row" style="border-top:1px solid rgba(var(--color-text-lighter),.12)">
            <span class="ala-text">
              <span class="ala-title">Import Settings</span>
              <span class="ala-help">Restore settings from an <code>al-additions.settings</code> file. Existing values not in the backup are kept.</span>
            </span>
            <button type="button" class="ala-btn ala-btn--primary" id="ala-btn-import">Import File</button>
            <input type="file" id="ala-import-file" accept=".settings,.json,text/*" style="display:none">
          </div>
        </div>
      </div>
    </div>
  </details>`;
	}
	function devModeCardHtml() {
		const devRow = getRow(DEV_MODE_DEF.key);
		if (!devRow) return "";
		const isDevOn = !!Settings.get(DEV_MODE_DEF.key);
		const debugState = Settings.get(DEV_MODE_DEF.debugKey);
		const coreScope = DEV_MODE_DEF.coreDebug.scope;
		const coreEntry = debugState[coreScope];
		const coreChildHtmls = Object.values(DEV_MODE_DEF.coreChannels).map((ch) => debugToggleRowHtml(ch.title, ch.help, coreScope, coreEntry?.channels?.[ch.id] !== false, ch.id));
		const debugRowsHtml = [debugGroupHtml(coreScope, DEV_MODE_DEF.coreDebug.title, DEV_MODE_DEF.coreDebug.help, !!coreEntry?.enabled, coreChildHtmls), ...features.filter((f) => Boolean(f.debug && f.debug.debug !== false)).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)).map((f) => {
			const debuggable = getDebuggableChannels(f.debug);
			const modEntry = debugState[f.id];
			const childHtmls = debuggable.length ? [debugToggleRowHtml("General", `Log general ${f.title} debug events.`, f.id, modEntry?.channels?.general !== false, "general"), ...debuggable.map(([chId, ch]) => debugToggleRowHtml(ch.title || ch.label, ch.help || `Log ${ch.label} debug events for ${f.title}.`, f.id, modEntry?.channels?.[chId] !== false, chId))] : [];
			return `<div class="ala-collapsible ${!!Settings.get(f.toggle.key) ? "is-open" : ""}" data-debug-for="${esc(f.toggle.key)}">
        <div class="ala-collapsible-inner">
          ${debugGroupHtml(f.id, f.debug.title, f.debug.help, !!modEntry?.enabled, childHtmls)}
        </div>
      </div>`;
		})].join("");
		return `<div class="ala-feature ${isDevOn ? "" : "is-off"}" data-feature="${esc(DEV_MODE_DEF.id)}">
    <input type="hidden" data-key="${esc(DEV_MODE_DEF.debugKey)}" value="${esc(JSON.stringify(debugState))}">
    <label class="ala-row ala-row--main">${rowText(DEV_MODE_DEF.title, DEV_MODE_DEF.help)}${TYPES$1.toggle.html(devRow, isDevOn)}</label>
    <div class="ala-collapsible ala-options-collapsible ${isDevOn ? "is-open" : ""}">
      <div class="ala-collapsible-inner">
        <div class="ala-options">${debugRowsHtml}</div>
      </div>
    </div>
  </div>`;
	}
	function sectionsHtml() {
		const all = [...new Set([...features.map((f) => f.section), "Advanced"])];
		const pinned = new Set([...PINNED_FIRST, ...PINNED_LAST]);
		return [
			...PINNED_FIRST.filter((s) => all.includes(s)),
			...all.filter((s) => !pinned.has(s)).sort((a, b) => a.localeCompare(b)),
			...PINNED_LAST.filter((s) => all.includes(s))
		].map((name) => {
			const cardsHtml = [...features.filter((f) => f.section === name).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)).map(featureHtml), ...name === "Advanced" ? [devModeCardHtml()] : []].join("");
			return cardsHtml ? `<details class="ala-section-dropdown" data-section="${esc(name)}">
            <summary class="ala-section-summary" aria-expanded="false">
              <span class="ala-section-title">${esc(name)}</span>
              <span class="ala-chevron">${icon("chevron", 14)}</span>
            </summary>
            <div class="ala-collapsible ala-section-collapsible">
              <div class="ala-collapsible-inner">
                <div class="ala-section">${cardsHtml}</div>
              </div>
            </div>
          </details>` : "";
		}).filter(Boolean).join("");
	}
	function creditsDropdownHtml() {
		return `<details class="ala-section-dropdown ala-credits-dropdown" data-section="credits">
    <summary class="ala-section-summary" aria-expanded="false">
      <span class="ala-section-title">Credits</span>
      <span class="ala-chevron">${icon("chevron", 14)}</span>
    </summary>
    <div class="ala-collapsible ala-section-collapsible">
      <div class="ala-collapsible-inner">
        <div class="ala-credits-content">${creditsHtml()}</div>
      </div>
    </div>
  </details>`;
	}
	function hasCollapsibleTransition(el) {
		if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
		const raw = getComputedStyle(el).transitionDuration;
		if (!raw) return false;
		return raw.split(",").some((part) => {
			const trimmed = part.trim();
			if (!trimmed) return false;
			const num = parseFloat(trimmed);
			return Number.isFinite(num) && num > 0;
		});
	}
	function initDropdownAnimations(panel) {
		const cleanups = [];
		panel.querySelectorAll("details.ala-section-dropdown").forEach((details) => {
			const summary = details.querySelector(":scope > summary");
			const collapsible = details.querySelector(":scope > .ala-collapsible");
			if (!summary || !collapsible) return;
			let collapseCleanup = null;
			const cancelPendingCollapse = () => {
				collapseCleanup?.();
				collapseCleanup = null;
			};
			cleanups.push(cancelPendingCollapse);
			const expandedInitially = details.classList.contains("is-expanded") || details.open;
			details.open = expandedInitially;
			details.classList.toggle("is-expanded", expandedInitially);
			collapsible.classList.toggle("is-open", expandedInitially);
			summary.setAttribute("aria-expanded", String(expandedInitially));
			summary.addEventListener("click", (e) => {
				e.preventDefault();
				const willExpand = !details.classList.contains("is-expanded");
				cancelPendingCollapse();
				if (willExpand) {
					details.open = true;
					collapsible.offsetHeight;
					details.classList.add("is-expanded");
					collapsible.classList.add("is-open");
					summary.setAttribute("aria-expanded", "true");
					return;
				}
				details.classList.remove("is-expanded");
				collapsible.classList.remove("is-open");
				summary.setAttribute("aria-expanded", "false");
				if (!hasCollapsibleTransition(collapsible)) {
					details.open = false;
					return;
				}
				const finishCollapse = () => {
					cancelPendingCollapse();
					if (!details.classList.contains("is-expanded")) details.open = false;
				};
				const onTransitionEnd = (ev) => {
					if (ev.target !== collapsible) return;
					if (ev.propertyName && ev.propertyName !== "grid-template-rows") return;
					finishCollapse();
				};
				const fallbackTimer = setTimeout(finishCollapse, 300);
				collapsible.addEventListener("transitionend", onTransitionEnd);
				collapseCleanup = () => {
					collapsible.removeEventListener("transitionend", onTransitionEnd);
					clearTimeout(fallbackTimer);
				};
			});
		});
		return () => {
			for (const fn of cleanups) fn();
		};
	}
	var scrollLockRelease = null;
	function standaloneNoteHtml(f) {
		const name = f.standalone?.name || f.title;
		const extra = f.standalone?.note ? ` ${esc(f.standalone.note)}` : "";
		return `<b>Standalone ${esc(name)} detected.</b> This feature is now built into AL Additions, so you no longer need the separate script. The built-in version is switched off while the standalone script is installed. Your setting is kept and applies again once you uninstall it.${extra}`;
	}
	function closePanel() {
		const b = document.getElementById("ala-settings-backdrop");
		if (!b) return;
		const onKey = b._onKey;
		const onFocus = b._onFocus;
		const onCleanup = b._onCleanup;
		b._onKey = void 0;
		b._onFocus = void 0;
		b._onCleanup = void 0;
		if (onKey) document.removeEventListener("keydown", onKey);
		if (onFocus) window.removeEventListener("focus", onFocus);
		try {
			onCleanup?.();
		} finally {
			b.remove();
			document.querySelectorAll("#ala-settings-nav-section .ala-settings-nav-link.is-active").forEach((el) => el.classList.remove("is-active"));
			scrollLockRelease?.();
			scrollLockRelease = null;
		}
	}
	function showPanel(host = NOOP_HOST) {
		if (!document.body) return;
		if (document.getElementById("ala-settings-backdrop")) return;
		const backdrop = document.createElement("div");
		backdrop.id = "ala-settings-backdrop";
		backdrop.innerHTML = `<div id="ala-settings-panel" role="dialog" aria-modal="true" aria-labelledby="ala-settings-title" tabindex="-1">
    <header class="ala-sheet-head">
      <div><h2 id="ala-settings-title">AL Additions</h2><div class="ala-help">Live modules apply on Save; others require a page reload.</div></div>
      <button class="ala-icon-btn ala-close" type="button" aria-label="Close settings">${icon("close", 20)}</button>
    </header>
    <div class="ala-sheet-body">
      ${accountsHtml()}
      ${sectionsHtml()}
      ${backupRestoreHtml()}
      ${creditsDropdownHtml()}
    </div>
    <footer class="ala-sheet-foot">
      <button class="ala-btn ala-btn--primary ala-save" type="button">Save</button>
      <button class="ala-btn ala-reset" type="button">Reset to defaults</button>
      <span class="ala-status" role="status"></span>
    </footer>
  </div>`;
		const panel = backdrop.firstElementChild;
		const statusEl = panel.querySelector(".ala-status");
		const saveBtn = panel.querySelector(".ala-save");
		const setStatus = (msg, isError = false) => {
			statusEl.textContent = msg;
			statusEl.classList.toggle("is-error", isError);
		};
		const controls = () => Array.from(panel.querySelectorAll("[data-key]"));
		const featureById = new Map(features.map((f) => [f.id, f]));
		const standaloneDetected = new Map();
		for (const f of features) if (host.getStatus(f.id).reason === "standalone-paused") standaloneDetected.set(f.id, true);
		const isFeatureStandalonePaused = (id) => standaloneDetected.has(id) ? !!standaloneDetected.get(id) : host.getStatus(id).reason === "standalone-paused";
		const findFeatureMainToggle = (id) => {
			return panel.querySelector(`.ala-feature[data-feature="${id}"]`)?.querySelector(".ala-row--main input[type=\"checkbox\"][data-key]") || null;
		};
		const resolveEffectiveStatuses = (enabledMap) => {
			const statuses = { ...host.resolveStagedStates(enabledMap) };
			for (const f of features) {
				if (!enabledMap[f.id]) continue;
				const live = host.getStatus(f.id);
				if (live.reason === "error" && statuses[f.id]?.active) statuses[f.id] = {
					active: false,
					reason: "error",
					error: live.error
				};
			}
			let propagated = true;
			while (propagated) {
				propagated = false;
				for (const f of features) {
					if (!statuses[f.id]?.active || !f.dependsOn?.length) continue;
					const missingDeps = f.dependsOn.filter((depId) => !statuses[depId]?.active);
					if (missingDeps.length > 0) {
						statuses[f.id] = {
							active: false,
							reason: "dep-unavailable",
							missingDeps
						};
						propagated = true;
					}
				}
			}
			return statuses;
		};
		const snapshotInitial = () => {
			const vals = {};
			const enabledMap = {};
			for (const r of Object.values(ROWS)) vals[r.key] = JSON.stringify(Settings.get(r.key));
			for (const f of features) enabledMap[f.id] = !!Settings.get(f.toggle.key) && !isFeatureStandalonePaused(f.id);
			return {
				vals,
				statuses: resolveEffectiveStatuses(enabledMap)
			};
		};
		let baseline = snapshotInitial();
		const refreshBaselineStatuses = () => {
			const enabledMap = {};
			for (const f of features) {
				let baseEnabled = false;
				const raw = baseline.vals[f.toggle.key];
				if (raw !== void 0) try {
					baseEnabled = !!JSON.parse(raw);
				} catch {
					baseEnabled = !!Settings.get(f.toggle.key);
				}
				else baseEnabled = !!Settings.get(f.toggle.key);
				enabledMap[f.id] = baseEnabled && !isFeatureStandalonePaused(f.id);
			}
			baseline = {
				vals: baseline.vals,
				statuses: resolveEffectiveStatuses(enabledMap)
			};
		};
		const readStagedEnabled = () => {
			const staged = {};
			for (const f of features) {
				const toggle = findFeatureMainToggle(f.id);
				if (isFeatureStandalonePaused(f.id)) staged[f.id] = false;
				else staged[f.id] = toggle ? toggle.checked : !!Settings.get(f.toggle.key);
			}
			return staged;
		};
		const reconcileStandaloneLocks = () => {
			for (const f of features) {
				const mainToggle = findFeatureMainToggle(f.id);
				if (!mainToggle) continue;
				if (isFeatureStandalonePaused(f.id)) {
					mainToggle.dataset.standaloneLocked = "1";
					mainToggle.checked = false;
					mainToggle.disabled = true;
				} else if (mainToggle.dataset.standaloneLocked) {
					delete mainToggle.dataset.standaloneLocked;
					mainToggle.checked = !!Settings.get(f.toggle.key);
					mainToggle.disabled = false;
				}
			}
		};
		const computeSavePlan = () => {
			const changed = [];
			const changedKeys = new Set();
			controls().forEach((el) => {
				const r = getRow(el.dataset.key);
				if (!r) return;
				if (el.dataset.standaloneLocked) return;
				const val = TYPES$1[r.type].normalize(TYPES$1[r.type].read(el), r);
				if (JSON.stringify(val) !== baseline.vals[r.key]) {
					changed.push({
						key: r.key,
						value: val
					});
					changedKeys.add(r.key);
				}
			});
			const stagedStatuses = resolveEffectiveStatuses(readStagedEnabled());
			const hotReloadIds = [];
			const affectedActiveIds = [];
			let needsPageReload = false;
			for (const f of features) {
				const wasActive = !!baseline.statuses[f.id]?.active;
				const isNowActive = !!stagedStatuses[f.id]?.active;
				const optionChanged = f.options.some((o) => changedKeys.has(o.key));
				if (wasActive !== isNowActive || (wasActive || isNowActive) && optionChanged) {
					if (wasActive || isNowActive) affectedActiveIds.push(f.id);
					if (f.requiresReload) needsPageReload = true;
					else hotReloadIds.push(f.id);
				}
			}
			if (!needsPageReload && affectedActiveIds.length > 0) {
				const dependentsOf = new Map();
				for (const f of features) for (const depId of f.dependsOn || []) {
					const list = dependentsOf.get(depId);
					if (list) list.push(f);
					else dependentsOf.set(depId, [f]);
				}
				const visited = new Set(affectedActiveIds);
				const queue = [...affectedActiveIds];
				while (queue.length > 0 && !needsPageReload) {
					const id = queue.shift();
					for (const depFeature of dependentsOf.get(id) || []) {
						if (visited.has(depFeature.id)) continue;
						const depWasActive = !!baseline.statuses[depFeature.id]?.active;
						const depIsNowActive = !!stagedStatuses[depFeature.id]?.active;
						if (!depWasActive && !depIsNowActive) continue;
						visited.add(depFeature.id);
						if (depFeature.requiresReload) {
							needsPageReload = true;
							break;
						}
						queue.push(depFeature.id);
					}
				}
			}
			return {
				changed,
				hotReloadIds,
				needsPageReload,
				stagedStatuses
			};
		};
		const upsertNote = (card, className, html) => {
			const existing = card.querySelector(`:scope > .${className}`);
			if (!html) {
				existing?.remove();
				return;
			}
			const note = existing || document.createElement("div");
			note.className = `ala-note ${className}`;
			note.setAttribute("role", "note");
			note.innerHTML = html;
			if (!existing) card.querySelector(".ala-row--main")?.insertAdjacentElement("afterend", note);
		};
		const syncFeatureCard = (card, stagedStatuses) => {
			const id = card.dataset.feature || "";
			const f = featureById.get(id);
			const mainToggle = card.querySelector(".ala-row--main input[type=\"checkbox\"][data-key]");
			if (!f) {
				const on = !mainToggle || mainToggle.checked;
				card.classList.toggle("is-off", !on);
				const optionsCollapsible = card.querySelector(":scope > .ala-options-collapsible");
				if (optionsCollapsible) optionsCollapsible.classList.toggle("is-open", on);
				card.querySelectorAll(".ala-options [data-key]").forEach((el) => {
					if (el.closest(".ala-child-option, [data-debug-for]")) return;
					el.disabled = !on;
				});
				return on;
			}
			const staged = stagedStatuses[f.id] || { active: !!mainToggle?.checked };
			const live = host.getStatus(f.id);
			const isStandalonePaused = isFeatureStandalonePaused(f.id);
			upsertNote(card, "ala-standalone-note", isStandalonePaused ? standaloneNoteHtml(f) : null);
			const depLocked = !isStandalonePaused && (staged.reason === "dep-off" || staged.reason === "dep-unavailable" || staged.reason === "cycle");
			if (mainToggle && !isStandalonePaused) {
				if (depLocked) {
					mainToggle.dataset.depLocked = "1";
					mainToggle.disabled = true;
				} else {
					delete mainToggle.dataset.depLocked;
					mainToggle.disabled = false;
				}
			}
			let depMsg = null;
			if (depLocked) {
				if (staged.reason === "dep-off") depMsg = `Requires ${(staged.disabledDeps || f.dependsOn || []).map((depId) => esc(featureById.get(depId)?.title || depId)).join(", ")} to be enabled.`;
				else if (staged.reason === "dep-unavailable") depMsg = `Requires unavailable module(s): ${(staged.missingDeps || []).map(esc).join(", ")}.`;
				else depMsg = "Disabled due to a circular module dependency.";
			}
			upsertNote(card, "ala-dep-note", depMsg);
			const hostMismatch = (staged.reason === "host-mismatch" || live.reason === "host-mismatch") && !!f.hosts?.length;
			upsertNote(card, "ala-host-note", hostMismatch ? `Only active on: ${f.hosts.map(esc).join(", ")}` : null);
			const titleEl = card.querySelector(".ala-row--main .ala-title");
			titleEl?.querySelector(".ala-badge--error")?.remove();
			if (live.reason === "error") {
				if (titleEl) {
					const badge = document.createElement("span");
					badge.className = "ala-badge ala-badge--error";
					badge.textContent = "Error";
					titleEl.appendChild(badge);
				}
				upsertNote(card, "ala-error-note", `Failed to load: ${esc(live.error || "Unknown error")}`);
			} else upsertNote(card, "ala-error-note", null);
			const effectiveOn = !isStandalonePaused && !depLocked && (!mainToggle || mainToggle.checked);
			card.classList.toggle("is-off", !effectiveOn);
			const optionsCollapsible = card.querySelector(":scope > .ala-options-collapsible");
			if (optionsCollapsible) optionsCollapsible.classList.toggle("is-open", effectiveOn);
			card.querySelectorAll(".ala-child-option").forEach((childWrap) => {
				if (childWrap.closest("[data-debug-for]") || childWrap.dataset.debugChildren) return;
				const parentKey = childWrap.dataset.childFor;
				const parentInput = parentKey ? card.querySelector(`[data-key="${parentKey}"]`) : null;
				const childOpen = effectiveOn && !!parentInput?.checked;
				childWrap.classList.toggle("is-open", childOpen);
				childWrap.querySelectorAll("[data-key]").forEach((el) => {
					el.disabled = !childOpen;
				});
			});
			card.querySelectorAll(".ala-options [data-key]").forEach((el) => {
				if (el.closest(".ala-child-option, [data-debug-for]")) return;
				el.disabled = !effectiveOn;
			});
			return effectiveOn;
		};
		const syncDebugHiddenFromCheckboxes = () => {
			const hidden = panel.querySelector(`input[data-key="${DEV_MODE_DEF.debugKey}"]`);
			if (!hidden) return;
			const next = {};
			panel.querySelectorAll("input[data-debug-scope]").forEach((cb) => {
				const scope = cb.dataset.debugScope;
				const ch = cb.dataset.debugChannel;
				if (!next[scope]) next[scope] = { enabled: false };
				if (ch) {
					if (!next[scope].channels) next[scope].channels = {};
					next[scope].channels[ch] = cb.checked;
				} else next[scope].enabled = cb.checked;
			});
			const row = getRow(DEV_MODE_DEF.debugKey);
			TYPES$1.json.write(hidden, row ? TYPES$1.json.normalize(next, row) : next);
		};
		const syncDebugCheckboxesFromHidden = () => {
			const hidden = panel.querySelector(`input[data-key="${DEV_MODE_DEF.debugKey}"]`);
			if (!hidden) return;
			const row = getRow(DEV_MODE_DEF.debugKey);
			const state = (row ? TYPES$1.json.normalize(TYPES$1.json.read(hidden), row) : TYPES$1.json.read(hidden)) || {};
			panel.querySelectorAll("input[data-debug-scope]").forEach((cb) => {
				const scope = cb.dataset.debugScope;
				const ch = cb.dataset.debugChannel;
				const entry = state[scope];
				cb.checked = ch ? entry?.channels?.[ch] !== false : !!entry?.enabled;
			});
		};
		const syncAll = () => {
			reconcileStandaloneLocks();
			const plan = computeSavePlan();
			const activeMap = new Map();
			panel.querySelectorAll(".ala-feature").forEach((card) => {
				const effectiveOn = syncFeatureCard(card, plan.stagedStatuses);
				const toggleKey = card.querySelector(".ala-row--main input[type=\"checkbox\"][data-key]")?.dataset.key;
				if (toggleKey) activeMap.set(toggleKey, effectiveOn);
			});
			const devToggle = panel.querySelector(`input[data-key="${DEV_MODE_DEF.key}"]`);
			const isDevOn = devToggle ? devToggle.checked : !!Settings.get(DEV_MODE_DEF.key);
			const coreScope = DEV_MODE_DEF.coreDebug.scope;
			const coreMaster = panel.querySelector(`input[data-debug-scope="${coreScope}"]:not([data-debug-channel])`);
			if (coreMaster) coreMaster.disabled = !isDevOn;
			const coreChildWrap = panel.querySelector(`.ala-child-option[data-debug-children="${coreScope}"]`);
			if (coreChildWrap) {
				const coreOpen = isDevOn && !!coreMaster?.checked;
				coreChildWrap.classList.toggle("is-open", coreOpen);
				coreChildWrap.querySelectorAll("input[data-debug-channel]").forEach((el) => {
					el.disabled = !coreOpen;
				});
			}
			panel.querySelectorAll("[data-debug-for]").forEach((wrap) => {
				const modKey = wrap.dataset.debugFor;
				const modOn = activeMap.get(modKey) ?? !!Settings.get(modKey);
				wrap.classList.toggle("is-open", modOn);
				const modMaster = wrap.querySelector("input[data-debug-scope]:not([data-debug-channel])");
				if (modMaster) modMaster.disabled = !(isDevOn && modOn);
				const childWrap = wrap.querySelector(".ala-child-option[data-debug-children]");
				if (childWrap) {
					const childOpen = modOn && !!modMaster?.checked;
					const childEnabled = isDevOn && childOpen;
					childWrap.classList.toggle("is-open", childOpen);
					childWrap.querySelectorAll("input[data-debug-channel]").forEach((el) => {
						el.disabled = !childEnabled;
					});
				}
			});
			const devRow = panel.querySelector("#ala-row-export-raw");
			if (devRow) devRow.style.display = isDevOn ? "" : "none";
			if (saveBtn) saveBtn.textContent = plan.needsPageReload ? "Save and reload" : "Save";
			return plan;
		};
		syncAll();
		const cleanupDropdowns = initDropdownAnimations(panel);
		const panelAc = new AbortController();
		const panelScope = createContextScope({
			prefix: "settings",
			signal: panelAc.signal,
			isClosed: () => !panel.isConnected || panelAc.signal.aborted,
			styleKind: "style",
			onError: (err) => settingsLog.error("Settings panel cleanup failed:", err)
		});
		const editorOverlays = new Set();
		const editorOverlayFlushers = new Set();
		const editorStyleDisposers = new Set();
		const activeEditorSessions = new Map();
		let reloadTimer = null;
		const clearReloadTimer = () => {
			if (reloadTimer !== null) {
				clearTimeout(reloadTimer);
				reloadTimer = null;
			}
		};
		const scheduleReload = (ms) => {
			clearReloadTimer();
			reloadTimer = setTimeout(() => {
				reloadTimer = null;
				if (panel.isConnected) location.reload();
			}, ms);
		};
		const unsubStatus = host.onStatusChange((id, status) => {
			if (!panel.isConnected) return;
			const prev = !!standaloneDetected.get(id);
			let next = prev;
			if (status.reason === "standalone-paused") {
				next = true;
				standaloneDetected.set(id, true);
			} else if (standaloneDetected.has(id)) {
				next = false;
				standaloneDetected.set(id, false);
			}
			if (next !== prev) refreshBaselineStatuses();
			syncAll();
		});
		for (const f of features) {
			if (!f.standalone) continue;
			host.probeStandalone(f.id).then((found) => {
				if (!panel.isConnected) return;
				const prev = !!standaloneDetected.get(f.id);
				const next = !!found;
				standaloneDetected.set(f.id, next);
				if (next !== prev) refreshBaselineStatuses();
				syncAll();
			}).catch(() => {});
		}
		panel.addEventListener("change", (e) => {
			const target = e.target;
			if (target?.id === "ala-import-file") return;
			if (target?.hasAttribute("data-debug-scope")) syncDebugHiddenFromCheckboxes();
			syncAll();
		});
		panel.querySelectorAll(".ala-btn--edit-json").forEach((btn) => {
			const key = btn.id.replace(/^ala-btn-edit-/, "");
			const r = getRow(key);
			if (!r?.editor) return;
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				const inputEl = panel.querySelector(`input[data-key="${key}"]`);
				if (!inputEl) return;
				activeEditorSessions.get(key)?.();
				const beforeBodyChildren = new Set(Array.from(document.body.children));
				const editorAc = new AbortController();
				let sessionDisposed = false;
				let activeSessionModals = 0;
				let editorPending = false;
				const recordMutationOverlays = (records) => {
					for (const rec of records) for (const node of Array.from(rec.addedNodes)) if (node instanceof HTMLElement && node !== backdrop && node.id !== "ala-toast" && !beforeBodyChildren.has(node)) editorOverlays.add(node);
				};
				const overlayObserver = typeof MutationObserver === "function" ? new MutationObserver((records) => {
					if (!panel.isConnected || sessionDisposed) return;
					recordMutationOverlays(records);
				}) : null;
				const flushOverlayObserver = () => {
					if (!overlayObserver) return;
					recordMutationOverlays(overlayObserver.takeRecords());
				};
				if (overlayObserver) {
					overlayObserver.observe(document.body, { childList: true });
					editorOverlayFlushers.add(flushOverlayObserver);
				}
				let editorScope;
				const disposeSession = () => {
					if (sessionDisposed) return;
					sessionDisposed = true;
					if (activeEditorSessions.get(key) === disposeSession) activeEditorSessions.delete(key);
					editorStyleDisposers.delete(disposeSession);
					editorOverlayFlushers.delete(flushOverlayObserver);
					if (overlayObserver) {
						flushOverlayObserver();
						overlayObserver.disconnect();
					}
					editorAc.abort();
					editorScope.dispose();
				};
				activeEditorSessions.set(key, disposeSession);
				editorStyleDisposers.add(disposeSession);
				editorScope = createContextScope({
					prefix: `editor-${key}`,
					signal: editorAc.signal,
					isClosed: () => sessionDisposed,
					styleKind: "style",
					onError: (err) => settingsLog.error("JSON editor cleanup failed:", err),
					onModalStart: () => {
						activeSessionModals++;
					},
					onModalAbort: () => {
						activeSessionModals = Math.max(0, activeSessionModals - 1);
					},
					onModalClose: () => {
						activeSessionModals = Math.max(0, activeSessionModals - 1);
						if (activeSessionModals === 0 && !editorPending) disposeSession();
					}
				});
				let editorResult;
				try {
					editorResult = r.editor({
						value: TYPES$1.json.read(inputEl),
						onApply: (nextValue) => {
							if (sessionDisposed || !panel.isConnected) return;
							const normalized = TYPES$1.json.normalize(nextValue, r);
							TYPES$1.json.write(inputEl, normalized);
							if (Boolean(r.autoEnableParentWhenNonEmpty) && isNonEmptyValue(normalized)) {
								const mainToggle = inputEl.closest(".ala-feature")?.querySelector(".ala-row--main input[type=\"checkbox\"][data-key]");
								if (mainToggle && !mainToggle.checked && !mainToggle.disabled) mainToggle.checked = true;
							}
							const plan = syncAll();
							setStatus(`Updated. Press "${plan.needsPageReload ? "Save and reload" : "Save"}" to apply.`);
						},
						signal: editorAc.signal,
						getId: editorScope.getId,
						addStyle: editorScope.addStyle,
						listen: editorScope.listen,
						timeout: editorScope.timeout,
						observe: editorScope.observe,
						modal: editorScope.modal,
						confirm: editorScope.confirm,
						alert: editorScope.alert,
						toast: {
							show: (msg, opts) => {
								if (!sessionDisposed && panel.isConnected) showToast(msg, opts);
							},
							success: (msg, opts) => {
								if (!sessionDisposed && panel.isConnected) toastSuccess(msg, opts);
							},
							error: (msg, opts) => {
								if (!sessionDisposed && panel.isConnected) toastError(msg, opts);
							}
						},
						onCleanup: editorScope.onCleanup,
						api: host.api ? scopeAniListClient(() => host.api, editorAc.signal, () => sessionDisposed) : void 0,
						log: settingsLog
					});
				} catch (err) {
					if (activeSessionModals === 0) disposeSession();
					throw err;
				} finally {
					flushOverlayObserver();
					for (const child of Array.from(document.body.children)) if (!beforeBodyChildren.has(child) && child instanceof HTMLElement && child !== backdrop && child.id !== "ala-toast") editorOverlays.add(child);
				}
				if (editorResult && (typeof editorResult === "object" || typeof editorResult === "function") && typeof editorResult.then === "function") {
					editorPending = true;
					Promise.resolve(editorResult).then(() => {
						editorPending = false;
						if (activeSessionModals === 0) disposeSession();
					}, (err) => {
						editorPending = false;
						if (activeSessionModals === 0) disposeSession();
						settingsLog.error("JSON editor failed:", err);
					});
				}
			});
		});
		saveBtn?.addEventListener("click", () => {
			const plan = computeSavePlan();
			for (const { key, value } of plan.changed) Settings.set(key, value);
			if (plan.needsPageReload) {
				baseline = snapshotInitial();
				syncAll();
				saveBtn.disabled = true;
				setStatus("Saved. Reloading…");
				scheduleReload(350);
				return;
			}
			clearReloadTimer();
			baseline = snapshotInitial();
			if (plan.hotReloadIds.length > 0) host.reload(plan.hotReloadIds);
			syncAll();
			setStatus(plan.hotReloadIds.length > 0 ? "Saved and applied." : "Saved.");
		});
		panel.querySelector(".ala-reset")?.addEventListener("click", () => {
			controls().forEach((el) => {
				const r = getRow(el.dataset.key);
				if (!r) return;
				if (el.dataset.standaloneLocked) return;
				TYPES$1[r.type].write(el, r.def);
			});
			syncDebugCheckboxesFromHidden();
			const plan = syncAll();
			setStatus(`Defaults restored. Press "${plan.needsPageReload ? "Save and reload" : "Save"}" to apply them.`);
		});
		panel.querySelector(".ala-close")?.addEventListener("click", closePanel);
		backdrop.addEventListener("click", (e) => {
			if (e.target === backdrop) closePanel();
		});
		backdrop._onKey = (e) => {
			if (e.key === "Escape") {
				if (e.defaultPrevented || hasActiveModal()) return;
				closePanel();
			}
		};
		document.addEventListener("keydown", backdrop._onKey);
		const providers = listAccountProviders();
		const updateAccountUI = () => {
			for (const p of providers) {
				const btn = panel.querySelector(`[data-account-btn="${p.id}"]`);
				const st = panel.querySelector(`#ala-status-${p.id}`);
				if (!btn || !st) continue;
				const connected = p.isConnected();
				const connectLabel = p.id === "mal" ? "Connect to MAL" : `Connect to ${p.name}`;
				btn.textContent = connected ? "Disconnect" : connectLabel;
				btn.className = `ala-btn ${connected ? "ala-btn--danger" : "ala-btn--primary"}`;
				st.textContent = connected ? "Connected" : "Not connected";
			}
		};
		for (const p of providers) {
			const btn = panel.querySelector(`[data-account-btn="${p.id}"]`);
			btn?.addEventListener("click", async () => {
				if (p.isConnected()) {
					if (btn.disabled) return;
					btn.disabled = true;
					try {
						const confirmed = await openConfirmModal({
							title: "Disconnect Account",
							message: `Disconnect ${p.name}?`,
							confirmText: "Disconnect",
							danger: true
						}, panelScope.modal);
						if (!panel.isConnected || !confirmed) return;
						p.disconnect();
						updateAccountUI();
						setStatus(`${p.name} disconnected.`);
					} finally {
						if (panel.isConnected) btn.disabled = false;
					}
				} else {
					p.connect();
					setStatus(`Opened ${p.name} authorization tab…`);
				}
			});
		}
		const getPanelOverrides = () => {
			const overrides = {};
			controls().forEach((el) => {
				const r = getRow(el.dataset.key);
				if (!r) return;
				overrides[r.key] = el.dataset.standaloneLocked ? Settings.get(r.key) : TYPES$1[r.type].normalize(TYPES$1[r.type].read(el), r);
			});
			return overrides;
		};
		const exportBtn = panel.querySelector("#ala-btn-export");
		exportBtn?.addEventListener("click", async () => {
			if (exportBtn.disabled) return;
			exportBtn.disabled = true;
			try {
				const pwd = await promptPasswordModal({
					title: "Export Settings",
					description: "Optional: Set a password to encrypt your backup file. Leave blank for an unencrypted backup.",
					submitText: "Export",
					allowEmpty: true,
					confirm: true,
					placeholder: "Optional encryption password"
				});
				if (!panel.isConnected || pwd === null) return;
				try {
					setStatus("Generating backup…");
					const envelope = await createBackup(false, pwd, getPanelOverrides());
					if (!panel.isConnected) return;
					downloadBackupFile(envelope);
					setStatus("Settings exported successfully.");
				} catch (e) {
					if (!panel.isConnected) return;
					setStatus("Export failed: " + (e.message || e), true);
				}
			} finally {
				if (panel.isConnected) exportBtn.disabled = false;
			}
		});
		const exportSecretsBtn = panel.querySelector("#ala-btn-export-secrets");
		exportSecretsBtn?.addEventListener("click", async () => {
			if (exportSecretsBtn.disabled) return;
			exportSecretsBtn.disabled = true;
			try {
				const confirmed = await openConfirmModal({
					title: "Export Credentials",
					message: "⚠️ Warning: This export includes your connected account credentials.\n\nAnyone with access to this file will have full access to your connected accounts.\n\nDo you want to continue?",
					confirmText: "Continue",
					danger: true
				}, panelScope.modal);
				if (!panel.isConnected || !confirmed) return;
				const pwd = await promptPasswordModal({
					title: "Export Credentials (Encrypted)",
					description: "A password is required to encrypt your credentials and protect your accounts.",
					submitText: "Encrypt & Export",
					allowEmpty: false,
					confirm: true,
					placeholder: "Choose an encryption password"
				});
				if (!panel.isConnected || pwd === null) return;
				if (!pwd.trim()) {
					setStatus("A password is required to export credentials.", true);
					return;
				}
				try {
					setStatus("Generating backup…");
					const envelope = await createBackup(true, pwd, getPanelOverrides());
					if (!panel.isConnected) return;
					downloadBackupFile(envelope);
					setStatus("Settings and credentials exported successfully.");
				} catch (e) {
					if (!panel.isConnected) return;
					setStatus("Export failed: " + (e.message || e), true);
				}
			} finally {
				if (panel.isConnected) exportSecretsBtn.disabled = false;
			}
		});
		panel.querySelector("#ala-btn-export-raw")?.addEventListener("click", () => {
			try {
				setStatus("Generating raw backup…");
				const rawJson = createRawBackup(getPanelOverrides());
				downloadBackupFile(new TextEncoder().encode(rawJson));
				setStatus("Raw JSON settings exported successfully.");
			} catch (e) {
				setStatus("Export failed: " + (e.message || e), true);
			}
		});
		const importBtn = panel.querySelector("#ala-btn-import");
		const fileInput = panel.querySelector("#ala-import-file");
		importBtn?.addEventListener("click", () => {
			if (importBtn.disabled) return;
			fileInput?.click();
		});
		let importInFlight = false;
		fileInput?.addEventListener("change", async () => {
			if (importInFlight) return;
			const file = fileInput.files?.[0];
			if (!file) return;
			importInFlight = true;
			if (importBtn) importBtn.disabled = true;
			fileInput.disabled = true;
			try {
				setStatus("Reading backup file…");
				const bytes = await readFileAsBytes(file);
				if (!panel.isConnected) return;
				const result = await importBackup(bytes);
				if (!panel.isConnected) return;
				if (result.cancelled) {
					setStatus("Import cancelled.");
					return;
				}
				const parts = [];
				if (result.applied > 0) parts.push(`${result.applied} settings`);
				if (result.secretsApplied > 0) parts.push(`${result.secretsApplied} account credentials`);
				setStatus(`Imported ${parts.join(" and ")}. Reloading…`);
				scheduleReload(600);
			} catch (e) {
				if (!panel.isConnected) return;
				setStatus("Import failed: " + (e.message || e), true);
			} finally {
				importInFlight = false;
				fileInput.value = "";
				if (panel.isConnected) {
					if (importBtn) importBtn.disabled = false;
					fileInput.disabled = false;
				}
			}
		});
		const onFocus = () => {
			updateAccountUI();
		};
		backdrop._onFocus = onFocus;
		window.addEventListener("focus", onFocus);
		backdrop._onCleanup = () => {
			unsubStatus();
			clearReloadTimer();
			cleanupDropdowns();
			panelAc.abort();
			panelScope.dispose();
			try {
				closePasswordModal();
			} catch {}
			for (const flush of [...editorOverlayFlushers]) try {
				flush();
			} catch {}
			editorOverlayFlushers.clear();
			for (const dispose of [...editorStyleDisposers]) try {
				dispose();
			} catch {}
			editorStyleDisposers.clear();
			activeEditorSessions.clear();
			for (const el of editorOverlays) try {
				if (el.isConnected) el.querySelector("[aria-label=\"Close\"]")?.click();
				if (el.isConnected) el.dispatchEvent(new KeyboardEvent("keydown", {
					key: "Escape",
					bubbles: true,
					cancelable: true
				}));
				if (el.isConnected) el.remove();
			} catch {}
			editorOverlays.clear();
		};
		scrollLockRelease?.();
		scrollLockRelease = acquireScrollLock();
		document.body.appendChild(backdrop);
		panel.focus();
	}
	function ensureLauncher(host = NOOP_HOST) {
		if (!document.body) return;
		if (document.getElementById("ala-settings-mobile-launcher")) return;
		const b = document.createElement("button");
		b.id = "ala-settings-mobile-launcher";
		b.type = "button";
		b.innerHTML = `${icon("sliders", 18)}<span>AL Additions</span>`;
		b.setAttribute("aria-label", "Open AL Additions settings");
		b.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			showPanel(host);
		});
		document.body.appendChild(b);
	}
	function installSidebar(host = NOOP_HOST) {
		if (!document.body) return;
		if (document.getElementById("ala-settings-nav-section")) return;
		if (!findExactText("Profile")) return;
		const dev = findExactText("Developer");
		if (!dev) return;
		let nav = dev.parentElement;
		while (nav && nav !== document.body && nav.children.length <= 1) nav = nav.parentElement;
		if (!nav || nav === document.body || !nav.parentElement) return;
		const section = document.createElement("div");
		section.id = "ala-settings-nav-section";
		section.className = "ala-settings-nav-section";
		section.innerHTML = "<div class=\"ala-settings-nav-heading\">AL Additions</div><a href=\"#\" class=\"ala-settings-nav-link\">Settings</a>";
		section.querySelector("a")?.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			e.currentTarget.classList.add("is-active");
			showPanel(host);
		});
		nav.parentElement.insertBefore(section, nav.nextSibling);
	}
	function initSettingsPage(host = NOOP_HOST) {
		let disposed = false;
		const disposeStyle = addStyle("ala-settings-style", CSS$1);
		const attempt = debounce(() => {
			if (disposed || !onSettingsPage()) return;
			installSidebar(host);
			ensureLauncher(host);
		}, 100);
		const unsubReady = Core.ready(() => {
			if (!disposed) attempt();
		});
		const unsubBody = Core.onBodyMutation(() => {
			if (!disposed && onSettingsPage() && !(document.getElementById("ala-settings-nav-section") && document.getElementById("ala-settings-mobile-launcher"))) attempt();
		});
		const unsubNav = Core.onNavigate(() => {
			if (disposed) return;
			if (onSettingsPage()) {
				attempt();
				return;
			}
			closePanel();
			document.getElementById("ala-settings-nav-section")?.remove();
			document.getElementById("ala-settings-mobile-launcher")?.remove();
		});
		return () => {
			if (disposed) return;
			disposed = true;
			attempt.cancel();
			unsubReady();
			unsubBody();
			unsubNav();
			closePanel();
			document.getElementById("ala-settings-nav-section")?.remove();
			document.getElementById("ala-settings-mobile-launcher")?.remove();
			disposeStyle();
		};
	}
	configureCoreServices({
		api: anilistApiClient,
		session: AniList.session
	});
	registerShellModule("settings", () => initSettingsPage(createModuleHost()));
	runMigrations();
	runAccountAuthCallbacks();
	startModules(true);
	Core.ready(() => startModules(false));
})();
