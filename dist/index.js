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
            subLabel: "Repairs malformed toasts in place instead of crashing the screen that renders them.",
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
          label: "Log repaired toasts",
          subLabel: "Writes what was repaired or replaced to the React Native log.",
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

// src/index.ts
var MAX_DIAGNOSTICS = 20;
var HOOK_KEYS = ["useToastContainer"];
var DISPATCH_KEYS = ["showToast", "addToast", "pushToast", "enqueueToast", "createToast"];
var src_default = plugin({
  jsonStorage: {
    load: true,
    default: DEFAULT_SETTINGS
  },
  start({ cleanup, jsonStorage: storage }) {
    const settings = () => ({ ...DEFAULT_SETTINGS, ...storage.cache });
    let diagnostics = 0;
    let dispatchersPatched = 0;
    let hookPatched = false;
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
    function patchHook(module) {
      if (typeof module.useToastContainer !== "function")
        return false;
      hookPatched = true;
      cleanup(instead(module, "useToastContainer", function(args, orig) {
        if (!settings().sanitizeContainer)
          return Reflect.apply(orig, this, args);
        return guardToastState(() => Reflect.apply(orig, this, args), repairOptions());
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
      console.log(`[ToastGuard] active (hook: ${hookPatched}, dispatchers: ${dispatchersPatched})`);
    }
    if (!hookPatched) {
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
