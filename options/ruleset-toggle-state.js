const normalizeRulesetId = value => {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed === "" ? "" : trimmed;
};

const FILTERING_MODE_KEYS = ["none", "basic", "optimal", "complete"];

export function createSerializedActionQueue() {
  let tail = Promise.resolve();
  let pendingCount = 0;

  return {
    enqueue(action) {
      if (typeof action !== "function") {
        return Promise.reject(new TypeError("A queued action must be a function"));
      }
      pendingCount += 1;
      const result = tail.then(() => action());
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result.finally(() => {
        pendingCount -= 1;
      });
    },
    get pendingCount() {
      return pendingCount;
    },
  };
}

export function normalizeEnabledRulesets(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const id = normalizeRulesetId(value);
    if (id === "" || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function getRulesetToggleState(enabledRulesets, toggleRulesets) {
  const enabledSet = new Set(normalizeEnabledRulesets(enabledRulesets));
  const toggleIds = normalizeEnabledRulesets(toggleRulesets);
  const enabledCount = toggleIds.reduce((count, id) =>
    count + (enabledSet.has(id) ? 1 : 0), 0);
  const allEnabled = toggleIds.length !== 0 && enabledCount === toggleIds.length;
  const anyEnabled = enabledCount !== 0;
  return {
    enabledCount,
    allEnabled,
    anyEnabled,
    partial: anyEnabled && allEnabled === false,
  };
}

export function applyRulesetToggleChange(currentEnabledRulesets, toggleRulesets, enabled) {
  return applyRulesetToggleDelta(
    currentEnabledRulesets,
    createRulesetToggleDelta(toggleRulesets, enabled)
  );
}

export function createRulesetToggleDelta(toggleRulesets, enabled) {
  const ids = normalizeEnabledRulesets(toggleRulesets);
  return {
    enableRulesets: enabled ? ids : [],
    disableRulesets: enabled ? [] : ids,
  };
}

export function applyRulesetToggleDelta(currentEnabledRulesets, delta) {
  const next = new Set(normalizeEnabledRulesets(currentEnabledRulesets));
  for (const id of normalizeEnabledRulesets(delta?.disableRulesets)) {
    next.delete(id);
  }
  for (const id of normalizeEnabledRulesets(delta?.enableRulesets)) {
    next.add(id);
  }
  return Array.from(next);
}

export function normalizeFilteringModes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const normalized = {};
  const allHostnames = new Set();
  for (const key of FILTERING_MODE_KEYS) {
    if (!Array.isArray(value[key])) {
      return null;
    }
    const entries = [];
    const seen = new Set();
    for (const item of value[key]) {
      if (typeof item !== "string") {
        return null;
      }
      const hostname = item.trim();
      if (hostname === "" || seen.has(hostname)) {
        continue;
      }
      if (allHostnames.has(hostname)) {
        return null;
      }
      seen.add(hostname);
      allHostnames.add(hostname);
      entries.push(hostname);
    }
    normalized[key] = entries;
  }
  return normalized;
}

export function filteringModesEqual(left, right) {
  const a = normalizeFilteringModes(left);
  const b = normalizeFilteringModes(right);
  if (a === null || b === null) {
    return false;
  }
  return FILTERING_MODE_KEYS.every((key) => {
    if (a[key].length !== b[key].length) {
      return false;
    }
    const rightSet = new Set(b[key]);
    return a[key].every(item => rightSet.has(item));
  });
}

export function normalizeFilteringModeState(value) {
  const modes = normalizeFilteringModes(value);
  const configRevision = Number(value?.configRevision);
  if (modes === null || !Number.isSafeInteger(configRevision) || configRevision < 0) {
    return null;
  }
  return { modes, configRevision };
}

export async function applyFilteringModeMutationWithRetry({
  initialState,
  buildModes,
  apply,
  onStale = () => {},
  maxStaleRetries = 1,
}) {
  if (typeof buildModes !== "function" || typeof apply !== "function") {
    throw new TypeError("Filtering mode mutation callbacks are required");
  }
  let state = normalizeFilteringModeState(initialState);
  if (state === null) {
    throw new TypeError("Initial filtering mode state is invalid");
  }
  const retryLimit = Number.isSafeInteger(maxStaleRetries) && maxStaleRetries >= 0
    ? maxStaleRetries
    : 0;

  for (let attempt = 0; ; attempt += 1) {
    const desiredModes = normalizeFilteringModes(buildModes(state.modes, attempt));
    if (desiredModes === null) {
      throw new TypeError("Desired filtering mode state is invalid");
    }
    const response = await apply({
      modes: desiredModes,
      expectedRevision: state.configRevision,
    });
    const responseState = normalizeFilteringModeState(response);
    if (response?.error === "stale_filtering_mode_revision") {
      if (responseState !== null && attempt < retryLimit) {
        await onStale(responseState, attempt + 1);
        state = responseState;
        continue;
      }
      return {
        ok: false,
        error: "stale_filtering_mode_revision",
        state: responseState,
        attempts: attempt + 1,
      };
    }
    if (response?.error) {
      return {
        ok: false,
        error: String(response.error),
        state: responseState,
        attempts: attempt + 1,
      };
    }
    if (responseState === null ||
        filteringModesEqual(responseState.modes, desiredModes) === false) {
      return {
        ok: false,
        error: "unverified_filtering_mode_update",
        state: responseState,
        attempts: attempt + 1,
      };
    }
    return {
      ok: true,
      state: responseState,
      desiredModes,
      attempts: attempt + 1,
    };
  }
}

export function mergeFilteringModeChanges(savedModes, pausedBaseline, currentModes) {
  const saved = normalizeFilteringModes(savedModes);
  const baseline = normalizeFilteringModes(pausedBaseline);
  const current = normalizeFilteringModes(currentModes);
  if (saved === null || baseline === null || current === null) {
    return null;
  }

  const levelByHostname = modes => {
    const out = new Map();
    for (const key of FILTERING_MODE_KEYS) {
      for (const hostname of modes[key]) {
        out.set(hostname, key);
      }
    }
    return out;
  };

  const baselineLevels = levelByHostname(baseline);
  const currentLevels = levelByHostname(current);
  const changedHostnames = new Set([
    ...baselineLevels.keys(),
    ...currentLevels.keys(),
  ]);

  for (const hostname of changedHostnames) {
    if (baselineLevels.get(hostname) === currentLevels.get(hostname)) {
      continue;
    }
    for (const key of FILTERING_MODE_KEYS) {
      saved[key] = saved[key].filter(item => item !== hostname);
    }
    const currentLevel = currentLevels.get(hostname);
    if (currentLevel !== undefined) {
      saved[currentLevel].push(hostname);
    }
  }

  return saved;
}

export function formatRulesetApplyError(result) {
  const quota = result?.staticRuleQuota instanceof Object ? result.staticRuleQuota : null;
  if (result?.error === "static_ruleset_quota_exceeded" && quota !== null) {
    return `Chrome rule limit: needs ${quota.requiredStaticRuleCount || 0}, available ${quota.projectedAvailableStaticRuleCount || quota.availableStaticRuleCount || 0}`;
  }
  if (result?.error === "static_ruleset_count_limit" && quota !== null) {
    return `Chrome ruleset limit: ${quota.enabledAfterCount || 0}/${quota.maxEnabledStaticRulesets || 0}`;
  }
  return String(result?.error || "ruleset_error");
}
