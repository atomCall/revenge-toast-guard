// src/index.ts
import { getModules } from "@revenge-mod/modules/finders";
import { withProps } from "@revenge-mod/modules/finders/filters";
import { before, instead } from "@revenge-mod/patcher";

// src/config.ts
var DEFAULT_SETTINGS = {
  sanitizeContainer: true,
  sanitizeDispatcher: true,
  logDiagnostics: true
};

// src/settings.tsx
import Page from "@revenge-mod/components/Page";
import TableRowAssetIcon from "@revenge-mod/components/TableRowAssetIcon";
import { Design } from "@revenge-mod/discord/design";
import { jsx, jsxs } from "react/jsx-runtime";
var { TableRowGroup, TableSwitchRow } = Design;
function SettingsComponent({ api: { jsonStorage: storage } }) {
  const settings = storage.use() ?? DEFAULT_SETTINGS;
  return /* @__PURE__ */ jsxs(Page, {
    children: [
      /* @__PURE__ */ jsxs(TableRowGroup, {
        title: "Protection",
        children: [
          /* @__PURE__ */ jsx(TableSwitchRow, {
            label: "Guard the toast container",
            subLabel: "Drops malformed toasts instead of crashing the screen that renders them.",
            icon: /* @__PURE__ */ jsx(TableRowAssetIcon, {
              name: "EyeSlashIcon"
            }),
            value: settings.sanitizeContainer,
            onValueChange: (value) => storage.set({ sanitizeContainer: value })
          }),
          /* @__PURE__ */ jsx(TableSwitchRow, {
            label: "Fix toasts at the source",
            subLabel: "Gives a missing position to toasts before Discord enqueues them.",
            icon: /* @__PURE__ */ jsx(TableRowAssetIcon, {
              name: "DenyIcon"
            }),
            value: settings.sanitizeDispatcher,
            onValueChange: (value) => storage.set({ sanitizeDispatcher: value })
          })
        ]
      }),
      /* @__PURE__ */ jsx(TableRowGroup, {
        title: "Diagnostics",
        children: /* @__PURE__ */ jsx(TableSwitchRow, {
          label: "Log dropped toasts",
          subLabel: "Writes what was fixed or dropped to the React Native log.",
          icon: /* @__PURE__ */ jsx(TableRowAssetIcon, {
            name: "ArrowAngleLeftUpIcon"
          }),
          value: settings.logDiagnostics,
          onValueChange: (value) => storage.set({ logDiagnostics: value })
        })
      })
    ]
  });
}

// src/toastGuard.ts
var DEFAULT_POSITION = "bottom";
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
function sanitizeToast(entry, options = {}) {
  if (!isObject(entry))
    return { ok: false, reason: "not-an-object" };
  if (!hasUsableId(entry))
    return { ok: false, reason: "missing-id" };
  if (hasUsablePosition(entry.position))
    return { ok: true, toast: entry };
  return {
    ok: true,
    toast: { ...entry, position: options.defaultPosition ?? DEFAULT_POSITION }
  };
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
function sanitizeToasts(list, options = {}) {
  if (!Array.isArray(list)) {
    options.onInvalid?.("not-an-array", list);
    return [];
  }
  const defaultPosition = options.defaultPosition ?? inferDefaultPosition(list);
  const byId = new Map;
  for (const entry of list) {
    const result = sanitizeToast(entry, { defaultPosition });
    if (!result.ok) {
      options.onInvalid?.(result.reason, entry);
      continue;
    }
    if (byId.has(result.toast.id)) {
      options.onInvalid?.("duplicate-id", entry);
      byId.delete(result.toast.id);
    }
    byId.set(result.toast.id, result.toast);
  }
  return [...byId.values()];
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
function normalizeToastState(state, options = {}) {
  if (Array.isArray(state))
    return state;
  if (!isObject(state))
    return createSafeToastState();
  return {
    ...state,
    toasts: sanitizeToasts(state.toasts, options),
    handlers: normalizeHandlers(state.handlers)
  };
}
function guardToastState(invoke, options = {}) {
  try {
    return normalizeToastState(invoke(), options);
  } catch (error) {
    try {
      options.onError?.(error);
    } catch {}
    return options.fallback ?? createSafeToastState();
  }
}

// src/index.ts
var MAX_DIAGNOSTICS = 20;
var HOOK_KEYS = ["useToastContainer"];
var COMPONENT_KEYS = ["ToastContainer"];
var DISPATCH_KEYS = ["showToast", "addToast", "pushToast", "enqueueToast", "createToast"];
var isCallableComponent = (value) => typeof value === "function" && !/^class\s/.test(Function.prototype.toString.call(value));
var src_default = plugin({
  jsonStorage: {
    load: true,
    default: DEFAULT_SETTINGS
  },
  start({ cleanup, jsonStorage: storage }) {
    const settings = () => ({ ...DEFAULT_SETTINGS, ...storage.cache });
    let diagnostics = 0;
    let dispatchersPatched = 0;
    let lastGood;
    let hookPatched = false;
    let componentPatched = false;
    function diagnose(label, detail) {
      if (!settings().logDiagnostics || diagnostics >= MAX_DIAGNOSTICS)
        return;
      diagnostics++;
      console.warn(`[ToastGuard] ${label}`, detail);
    }
    function guardOptions() {
      return {
        onInvalid: (reason, entry) => diagnose(`dropped toast (${reason})`, entry),
        onError: (error) => diagnose("toast container crashed, using safe state", error)
      };
    }
    function patchHook(module) {
      if (typeof module.useToastContainer !== "function")
        return false;
      hookPatched = true;
      cleanup(instead(module, "useToastContainer", function(args, orig) {
        if (!settings().sanitizeContainer)
          return Reflect.apply(orig, this, args);
        const state = guardToastState(() => Reflect.apply(orig, this, args), {
          ...guardOptions(),
          fallback: lastGood
        });
        lastGood = state;
        return state;
      }));
      return true;
    }
    function patchComponent(module) {
      if (!isCallableComponent(module.ToastContainer))
        return false;
      componentPatched = true;
      cleanup(instead(module, "ToastContainer", function(args, orig) {
        if (!settings().sanitizeContainer)
          return Reflect.apply(orig, this, args);
        try {
          return Reflect.apply(orig, this, args);
        } catch (error) {
          diagnose("toast container component threw, rendering nothing", error);
          return null;
        }
      }));
      return true;
    }
    function patchDispatcher(module, key) {
      if (typeof module[key] !== "function")
        return;
      dispatchersPatched++;
      cleanup(before(module, key, ([payload, options]) => {
        if (!settings().sanitizeDispatcher)
          return;
        try {
          for (const candidate of [payload, options]) {
            if (ensurePosition(candidate)) {
              diagnose("filled a missing toast position", candidate);
            }
          }
        } catch (error) {
          diagnose(`could not complete the ${key} payload`, error);
        }
      }));
    }
    cleanup(getModules(withProps(...HOOK_KEYS), (module) => {
      if (hookPatched)
        return;
      try {
        patchHook(module);
      } catch (error) {
        diagnose("could not patch useToastContainer", error);
      }
    }));
    cleanup(getModules(withProps(...COMPONENT_KEYS), (module) => {
      if (hookPatched || componentPatched)
        return;
      try {
        patchComponent(module);
      } catch (error) {
        diagnose("could not patch ToastContainer", error);
      }
    }));
    for (const key of DISPATCH_KEYS) {
      cleanup(getModules(withProps(key), (module) => {
        try {
          patchDispatcher(module, key);
        } catch (error) {
          diagnose(`could not patch ${key}`, error);
        }
      }));
    }
    if (settings().logDiagnostics) {
      console.log(`[ToastGuard] active (hook: ${hookPatched}, component: ${componentPatched}, dispatchers: ${dispatchersPatched})`);
    }
    if (!hookPatched && !componentPatched) {
      console.warn("[ToastGuard] could not find the toast container in this Discord build; nothing was patched");
    }
  },
  stop({ plugin: plugin2 }) {
    plugin2.requireReload();
  },
  SettingsComponent
});
export {
  src_default as default
};
