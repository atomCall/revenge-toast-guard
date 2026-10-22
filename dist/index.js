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

// src/diagnostics.ts
var MAX_DEPTH = 2;
var MAX_ENTRIES = 3;
var MAX_KEYS = 24;
var MAX_LENGTH = 400;
var MAX_STRING = 32;
var isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var clamp = (text) => text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text;
function describeString(value) {
  const oneLine = value.replace(/\s+/g, " ");
  return oneLine.length > MAX_STRING ? `"${oneLine.slice(0, MAX_STRING)}…"` : `"${oneLine}"`;
}
function describeArray(value, depth, seen) {
  const parts = [];
  for (let index = 0;index < value.length && parts.length < MAX_ENTRIES; index++) {
    parts.push(index in value ? describeValue(value[index], depth + 1, seen) : "<hole>");
  }
  if (value.length > MAX_ENTRIES)
    parts.push("…");
  return `array(${value.length})[${parts.join(",")}]`;
}
function describeObject(value, depth, seen) {
  if (seen.has(value))
    return "<cycle>";
  if (depth > MAX_DEPTH)
    return "{…}";
  seen.add(value);
  const parts = [];
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_KEYS)) {
    parts.push(`${key}:${describeValue(value[key], depth + 1, seen)}`);
  }
  if (keys.length > MAX_KEYS)
    parts.push(`…+${keys.length - MAX_KEYS}`);
  seen.delete(value);
  return `{${parts.join(",")}}`;
}
function describeValue(value, depth = 0, seen = new Set) {
  if (value === undefined)
    return "undefined";
  if (value === null)
    return "null";
  const kind = typeof value;
  if (kind === "string")
    return describeString(value);
  if (kind === "number" || kind === "boolean" || kind === "bigint")
    return String(value);
  if (kind === "function") {
    const name = value.name;
    return name ? `fn:${name}` : "fn";
  }
  if (kind === "symbol")
    return "symbol";
  if (Array.isArray(value))
    return describeArray(value, depth, seen);
  if (depth > MAX_DEPTH)
    return "{…}";
  return describeObject(value, depth, seen);
}
function describeModule(module) {
  if (!isPlainObject(module) && typeof module !== "object")
    return describeValue(module);
  if (module === null)
    return "null";
  const keys = Object.keys(module);
  const parts = keys.slice(0, MAX_KEYS).map((key) => `${key}:${describeValue(module[key], MAX_DEPTH - 1)}`);
  if (keys.length > MAX_KEYS)
    parts.push(`…+${keys.length - MAX_KEYS}`);
  return clamp(`{${parts.join(",")}}`);
}
function findComponentExports(module, name) {
  if (!isPlainObject(module))
    return [];
  return Object.keys(module).filter((key) => {
    const value = module[key];
    return typeof value === "function" && value.name === name;
  });
}
function createInspector(log, maxShapes = 10) {
  const seen = new Set;
  let last = "unknown";
  let shapes = 0;
  return {
    get last() {
      return last;
    },
    get shapes() {
      return shapes;
    },
    observe(state, render) {
      if (shapes >= maxShapes)
        return;
      let description;
      try {
        description = describeValue(state);
      } catch {
        return;
      }
      last = description;
      if (seen.has(description))
        return;
      seen.add(description);
      shapes++;
      log(`hook result #${shapes} (render ${render}): ${description}`);
    }
  };
}

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
var MAX_INSPECTION = 12;
var COMPONENT_NAME = "ToastContainer";
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
    let inspected = 0;
    let renders = 0;
    let dispatchersPatched = 0;
    let hookPatched = false;
    function diagnose(label, detail) {
      if (!settings().logDiagnostics || diagnostics >= MAX_DIAGNOSTICS)
        return;
      diagnostics++;
      console.warn(`[ToastGuard] ${label}`, detail);
    }
    function inspect(line) {
      if (!settings().logDiagnostics || inspected >= MAX_INSPECTION)
        return;
      inspected++;
      console.warn(`[ToastGuard] ${line}`);
    }
    const inspector = createInspector(inspect);
    function describeError(error) {
      if (error instanceof Error)
        return `${error.name}: ${error.message}`;
      return String(error);
    }
    function repairOptions() {
      return {
        onInvalid: (reason, entry, index) => diagnose(`repaired toast (${reason}) at ${index}`, entry)
      };
    }
    function patchComponent(module, key) {
      const component = module[key];
      if (typeof component !== "function")
        return;
      if (component.prototype?.isReactComponent)
        return;
      cleanup(instead(module, key, function(args, orig) {
        try {
          return Reflect.apply(orig, this, args);
        } catch (error) {
          try {
            inspect(`${COMPONENT_NAME} threw on render ${renders} with props ${describeValue(args?.[0])}; last hook result: ${inspector.last}`);
          } catch {}
          throw error;
        }
      }));
      inspect(`instrumented ${key} as ${COMPONENT_NAME}`);
    }
    function patchHook(module) {
      if (typeof module.useToastContainer !== "function")
        return false;
      hookPatched = true;
      inspect(`hook module exports: ${describeModule(module)}`);
      for (const key of findComponentExports(module, COMPONENT_NAME))
        patchComponent(module, key);
      cleanup(instead(module, "useToastContainer", function(args, orig) {
        if (!settings().sanitizeContainer)
          return Reflect.apply(orig, this, args);
        renders++;
        let raw;
        const state = guardToastState(() => {
          try {
            raw = Reflect.apply(orig, this, args);
            return raw;
          } catch (error) {
            inspect(`useToastContainer threw on render ${renders}: ${describeError(error)}`);
            throw error;
          }
        }, repairOptions());
        inspector.observe(raw, renders);
        return state;
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
