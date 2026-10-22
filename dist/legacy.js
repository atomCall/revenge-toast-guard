(() => {
	// Revenge legacy plugin bundle — evaluated as `vendetta => { return <this file> }`.
	const module = { exports: {} };
	const exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/legacy/index.ts
var exports_legacy = {};
__export(exports_legacy, {
  default: () => ToastGuard
});
module.exports = __toCommonJS(exports_legacy);

// src/config.ts
var DEFAULT_SETTINGS = {
  sanitizeContainer: true,
  sanitizeDispatcher: true,
  logDiagnostics: true
};

// src/toastGuard.ts
var DEFAULT_POSITION = "bottom";
var placeholders = new Map;
var isFunction = (value) => typeof value === "function";
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var hasUsableId = (entry) => typeof entry.id === "string" && entry.id.length > 0 || typeof entry.id === "number" && Number.isFinite(entry.id);
var hasUsablePosition = (value) => value != null && value !== "";
var PAYLOAD_KEYS = ["content", "message", "title", "type", "position"];
var isToastPayload = (value) => isObject(value) && PAYLOAD_KEYS.some((key) => (key in value));
function ensurePosition(target, defaultPosition = DEFAULT_POSITION) {
  if (!isToastPayload(target))
    return false;
  if (hasUsablePosition(target.position))
    return false;
  try {
    target.position = defaultPosition;
    return true;
  } catch {
    return false;
  }
}
function repairToast(entry, index = 0, options = {}) {
  const defaultPosition = options.defaultPosition ?? DEFAULT_POSITION;
  if (!isObject(entry)) {
    options.onInvalid?.("not-an-object", entry, index);
    return placeholderFor(index, defaultPosition);
  }
  if (hasUsablePosition(entry.position))
    return entry;
  options.onInvalid?.("missing-position", entry, index);
  try {
    return { ...entry, position: defaultPosition };
  } catch {
    return placeholderFor(index, defaultPosition);
  }
}
function inferDefaultPosition(list) {
  if (!Array.isArray(list))
    return DEFAULT_POSITION;
  for (const entry of list) {
    if (!isObject(entry))
      continue;
    if (hasUsablePosition(entry.position))
      return entry.position;
  }
  return DEFAULT_POSITION;
}
function placeholderFor(index, position) {
  const cached = placeholders.get(index);
  if (cached && cached.position === position)
    return cached;
  const placeholder = {
    id: `toast-guard-placeholder-${index}`,
    position,
    content: null
  };
  placeholders.set(index, placeholder);
  return placeholder;
}
function repairToasts(list, options = {}) {
  if (!Array.isArray(list)) {
    options.onInvalid?.("not-an-array", list, -1);
    return [];
  }
  if (list.length === 0)
    return list;
  const defaultPosition = options.defaultPosition ?? inferDefaultPosition(list);
  const seen = new Set;
  let repaired;
  for (let index = 0;index < list.length; index++) {
    const entry = list[index];
    const next = repairToast(entry, index, { ...options, defaultPosition });
    if (isObject(entry) && hasUsableId(entry)) {
      if (seen.has(entry.id)) {
        options.onInvalid?.("duplicate-id", entry, index);
      }
      seen.add(entry.id);
    }
    if (next === entry)
      continue;
    if (!repaired)
      repaired = list.slice();
    repaired[index] = next;
  }
  return repaired ?? list;
}
function normalizeHandlers(handlers) {
  if (!isObject(handlers))
    return createSafeHandlers();
  const source = handlers;
  const complete = isFunction(source.updateHeight) && isFunction(source.startPause) && isFunction(source.endPause) && isFunction(source.calculateOffset);
  if (complete)
    return handlers;
  return {
    updateHeight: isFunction(source.updateHeight) ? source.updateHeight : () => {
      return;
    },
    startPause: isFunction(source.startPause) ? source.startPause : () => {
      return;
    },
    endPause: isFunction(source.endPause) ? source.endPause : () => {
      return;
    },
    calculateOffset: isFunction(source.calculateOffset) ? source.calculateOffset : () => 0
  };
}
function createSafeHandlers() {
  return {
    updateHeight: () => {
      return;
    },
    startPause: () => {
      return;
    },
    endPause: () => {
      return;
    },
    calculateOffset: () => 0
  };
}
function createSafeToastState() {
  return { toasts: [], handlers: createSafeHandlers() };
}
function repairToastState(state, options = {}) {
  if (Array.isArray(state))
    return state;
  if (!isObject(state))
    return createSafeToastState();
  const toasts = repairToasts(state.toasts, options);
  const handlers = normalizeHandlers(state.handlers);
  if (toasts === state.toasts && handlers === state.handlers)
    return state;
  return { ...state, toasts, handlers };
}
function guardToastState(invoke, options = {}) {
  return repairToastState(invoke(), options);
}

// src/legacy/settings.ts
function createSettings(api, storage) {
  const read = (key) => storage[key] ?? DEFAULT_SETTINGS[key];
  const write = (key) => (value) => {
    storage[key] = value;
  };
  return function ToastGuardSettings() {
    const React = api.metro.common.React;
    const { Forms } = api.ui.components;
    api.storage.useProxy(storage);
    const row = (key, label, subLabel) => React.createElement(Forms.FormRow, {
      key,
      label,
      subLabel,
      trailing: React.createElement(Forms.FormSwitch, {
        value: read(key),
        onValueChange: write(key)
      })
    });
    return React.createElement(Forms.FormSection, { title: "Toast Guard" }, row("sanitizeContainer", "Guard the toast container", "Repairs malformed toasts in place instead of crashing the screen that renders them."), row("sanitizeDispatcher", "Fix toasts at the source", "Gives a missing position to toasts before Discord enqueues them."), row("logDiagnostics", "Log repaired toasts", "Writes what was repaired or replaced to the React Native log."));
  };
}

// src/legacy/index.ts
var MAX_DIAGNOSTICS = 20;
var RETRY_INTERVAL = 1000;
var MAX_SCANS = 15;
var HOOK_KEYS = ["useToastContainer"];
var DISPATCH_KEYS = ["showToast", "addToast", "pushToast", "enqueueToast", "createToast"];
function ToastGuard() {
  const api = typeof vendetta === "undefined" ? globalThis.vendetta : vendetta;
  const storage = api.plugin?.storage ?? {};
  const settings = () => ({ ...DEFAULT_SETTINGS, ...storage });
  let diagnostics = 0;
  let dispatchersPatched = 0;
  let hookPatched = false;
  let scans = 0;
  let timer;
  let finished = false;
  const unpatch = [];
  const patchedDispatchers = new WeakMap;
  function diagnose(label, detail) {
    if (!settings().logDiagnostics || diagnostics >= MAX_DIAGNOSTICS)
      return;
    diagnostics++;
    console.warn(`[ToastGuard] ${label}`, detail);
  }
  function repairOptions() {
    return {
      onInvalid: (reason, entry, index) => diagnose(`repaired toast (${reason}) at ${index}`, entry)
    };
  }
  function patchHook(module2) {
    if (typeof module2.useToastContainer !== "function")
      return false;
    hookPatched = true;
    unpatch.push(api.patcher.instead("useToastContainer", module2, function(args, original) {
      if (!settings().sanitizeContainer)
        return Reflect.apply(original, this, args);
      return guardToastState(() => Reflect.apply(original, this, args), repairOptions());
    }));
    return true;
  }
  function patchDispatcher(module2, key) {
    if (typeof module2[key] !== "function")
      return;
    const keys = patchedDispatchers.get(module2) ?? new Set;
    if (keys.has(key))
      return;
    keys.add(key);
    patchedDispatchers.set(module2, keys);
    dispatchersPatched++;
    unpatch.push(api.patcher.before(key, module2, function(args) {
      if (!settings().sanitizeDispatcher)
        return;
      try {
        for (const candidate of [args?.[0], args?.[1]]) {
          if (ensurePosition(candidate)) {
            diagnose("filled a missing toast position", candidate);
          }
        }
      } catch (error) {
        diagnose(`could not complete the ${key} payload`, error);
      }
    }));
  }
  function findOne(key) {
    try {
      return api.metro.findByProps(key) ?? undefined;
    } catch (error) {
      diagnose(`could not search modules for ${key}`, error);
      return;
    }
  }
  function findAll(key) {
    try {
      return api.metro.findByPropsAll(key) ?? [];
    } catch (error) {
      diagnose(`could not search modules for ${key}`, error);
      return [];
    }
  }
  function report() {
    if (finished)
      return;
    finished = true;
    if (settings().logDiagnostics) {
      console.log(`[ToastGuard] active (hook: ${hookPatched}, dispatchers: ${dispatchersPatched})`);
    }
    if (!hookPatched) {
      console.warn("[ToastGuard] could not find the toast container in this Discord build; nothing was patched");
    }
  }
  function scan() {
    timer = undefined;
    scans++;
    if (!hookPatched) {
      const module2 = findOne(HOOK_KEYS[0]);
      if (module2) {
        try {
          patchHook(module2);
        } catch (error) {
          diagnose("could not patch useToastContainer", error);
        }
      }
    }
    if (dispatchersPatched === 0) {
      for (const key of DISPATCH_KEYS) {
        for (const module2 of findAll(key)) {
          try {
            patchDispatcher(module2, key);
          } catch (error) {
            diagnose(`could not patch ${key}`, error);
          }
        }
      }
    }
    if (hookPatched && dispatchersPatched > 0 || scans >= MAX_SCANS) {
      report();
      return;
    }
    timer = setTimeout(scan, RETRY_INTERVAL);
    timer?.unref?.();
  }
  function teardown() {
    if (timer !== undefined)
      clearTimeout(timer);
    timer = undefined;
    for (const undo of unpatch.splice(0)) {
      try {
        undo();
      } catch (error) {
        console.warn("[ToastGuard] could not restore a patch", error);
      }
    }
  }
  return {
    onLoad() {
      scan();
    },
    onUnload() {
      teardown();
    },
    settings: createSettings(api, storage)
  };
}
	return module.exports.default ?? module.exports;
})()
