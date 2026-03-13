import { t, pluralSuffix } from "../shared/i18n.js";
import { SUBSCRIBE_URL, TRIAL_EXPIRED_URL, SUPPORT_URL, PRIVACY_URL, RECOVER_LICENSE_URL } from "../shared/links.js";

const MODE_NONE = 0;
const MODE_BASIC = 1;
const MODE_OPTIMAL = 2;
const MODE_COMPLETE = 3;

const toggleButton = document.getElementById("toggleProtection");
const statusLabel = document.getElementById("statusLabel");
const headerEl = document.querySelector(".header");
const safetyStatusEl = document.getElementById("safetyStatus");
const metricLabelEls = Array.from(document.querySelectorAll(".metric-label"));
const statsCardEl = document.querySelector(".stats-card.shield-style");
const openSettingsButton = document.getElementById("openSettings");
const privacyLinkButton = document.getElementById("privacyLink");
const filterPackSummaryEl = document.getElementById("filterPacksSummary");
const filterPackListEl = document.getElementById("filterPackList");
const dynamicHostLabelEl = document.getElementById("dynamicHostLabel");
const dynamicStatusEl = document.getElementById("dynamicStatus");
const blockDomainButton = document.getElementById("blockDomain");
const allowDomainButton = document.getElementById("allowDomain");

const subscriptionCardEl = document.getElementById("subscriptionCard");
const subscriptionStatusEl = document.getElementById("subscriptionStatus");
const subscriptionSubstatusEl = document.getElementById("subscriptionSubstatus");
const licenseFormEl = document.getElementById("licenseForm");
const licenseKeyEl = document.getElementById("licenseKey");
const licenseStatusEl = document.getElementById("licenseStatus");
const useThisDeviceButton = document.getElementById("useThisDeviceButton");
const subscribeNowButton = document.getElementById("subscribeNow");
const showLicenseEntryButton = document.getElementById("showLicenseEntry");
const recoverLicenseLink = document.getElementById("recoverLicenseLink");
const supportLinkButton = document.getElementById("supportLink");

const popupRootEl = document.querySelector(".popup");

// Trial/expired overlay elements
const expiredOverlayEl = document.getElementById("expiredOverlay");
const expiredOverlayBadgeEl = document.getElementById("expiredOverlayBadge");
const expiredOverlayTitleEl = document.getElementById("expiredOverlayTitle");
const expiredOverlayBullet1El = document.getElementById("expiredOverlayBullet1");
const expiredOverlayBullet2El = document.getElementById("expiredOverlayBullet2");
const expiredOverlayBullet3El = document.getElementById("expiredOverlayBullet3");
const expiredOverlayMetaEl = document.getElementById("expiredOverlayMeta");
const expiredOverlayStep2El = document.getElementById("expiredOverlayStep2");
const expiredOverlayFormEl = document.getElementById("expiredOverlayForm");
const expiredLicenseKeyEl = document.getElementById("expiredLicenseKey");
const expiredOverlayStatusEl = document.getElementById("expiredOverlayStatus");
const expiredUseThisDeviceButtonEl = document.getElementById("expiredUseThisDeviceButton");
const expiredSubscribeNowButtonEl = document.getElementById("expiredSubscribeNow");
const expiredShowKeyEntryButtonEl = document.getElementById("expiredShowKeyEntryButton");
const expiredRecoverLicenseButtonEl = document.getElementById("expiredRecoverLicense");
const expiredSupportLinkEl = document.getElementById("expiredSupportLink");

let currentHost = null;
let currentTabId = null;
let defaultFilteringMode = MODE_OPTIMAL;
let currentEnabledState = true;
let entitlementStatus = null;
let paywalled = false;
let licenseEntryVisible = false;
let expiredKeyEntryVisible = false;

const GLOBAL_PAUSE_SNAPSHOT_KEY = "globalPauseFilteringModesSnapshot";
const ENTITLEMENT_LOCAL_STORAGE_KEY = "talonEntitlement";
const FILTERING_MODE_STORAGE_KEY = "filteringModeDetails";
const PAUSED_FILTERING_MODES = {
  none: ["all-urls"],
  basic: [],
  optimal: [],
  complete: []
};
const TRIAL_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const HARD_DENY_ERROR_CODES = new Set([
  "INVALID_KEY",
  "EXPIRED",
  "REVOKED",
  "MAX_DEVICES",
  "TRIAL_ENDED"
]);

init().catch((error) => {
  console.error("Popup init failed", error);
  // Fallback: never leave the popup blank if init fails unexpectedly.
  if (popupRootEl) {
    popupRootEl.hidden = false;
  }
  if (expiredOverlayEl) {
    expiredOverlayEl.hidden = true;
  }
});

async function init() {
  setDocumentLanguage();
  localizeHtml();
  wireEvents();
  maybeOpenFirstPopupWelcome();
  showInitialPopupShell();

  try {
    await hydrateFromLocalCache();
    await refreshEntitlement();
    await resolveActiveHost();
    if (!paywalled) {
      await Promise.all([refreshFilteringState(), refreshFilterCatalog()]);
    }
  } finally {
    setToggleLoading(false);
  }
}

function setDocumentLanguage() {
  try {
    const locale = chrome?.i18n?.getMessage?.("@@ui_locale");
    if (locale) {
      document.documentElement.lang = locale === "ja" ? "ja-JP" : locale;
    }
  } catch (_error) {
    // ignore
  }
}

function maybeOpenFirstPopupWelcome() {
  try {
    chrome.runtime.sendMessage({ what: "maybeOpenFirstPopupWelcome" }, () => {
      // Accessing lastError prevents noisy console logs when popup closes quickly.
      void chrome.runtime?.lastError;
    });
  } catch (_error) {
    // ignore
  }
}

function localizeHtml() {
  const elements = document.querySelectorAll("[data-i18n]");
  for (const element of elements) {
    const key = element.getAttribute("data-i18n");
    const msg = t(key);
    if (msg && msg !== key) {
      if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        element.placeholder = msg;
      } else {
        element.textContent = msg; // Only set if we actually found a translation
      }
    }
  }

  const ariaLabelElements = document.querySelectorAll("[data-i18n-aria-label]");
  for (const element of ariaLabelElements) {
    const key = element.getAttribute("data-i18n-aria-label");
    const msg = t(key);
    if (msg && msg !== key) {
      element.setAttribute("aria-label", msg);
    }
  }
}

function showInitialPopupShell() {
  if (popupRootEl) {
    popupRootEl.hidden = false;
  }
  if (expiredOverlayEl) {
    expiredOverlayEl.hidden = true;
  }
  setToggleLoading(true);
  if (statusLabel) {
    statusLabel.textContent = t("subscriptionStatusLoading");
    statusLabel.className = "status-text";
  }
  if (statsCardEl) {
    statsCardEl.classList.add("paused");
  }
  if (safetyStatusEl) {
    safetyStatusEl.textContent = t("uiLoading");
  }
  for (const label of metricLabelEls) {
    label.textContent = t("uiLoading");
  }
}

const toFiniteNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const normalizeErrorCode = (value) => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toUpperCase();
};

function deriveDefaultFilteringModeFromCache(details) {
  if (!details || typeof details !== "object") {
    return null;
  }
  const none = Array.isArray(details.none) ? details.none : [];
  const basic = Array.isArray(details.basic) ? details.basic : [];
  const optimal = Array.isArray(details.optimal) ? details.optimal : [];
  const complete = Array.isArray(details.complete) ? details.complete : [];

  if (none.includes("all-urls")) {
    return MODE_NONE;
  }
  if (basic.includes("all-urls")) {
    return MODE_BASIC;
  }
  if (optimal.includes("all-urls")) {
    return MODE_OPTIMAL;
  }
  if (complete.includes("all-urls")) {
    return MODE_COMPLETE;
  }
  return MODE_BASIC;
}

function deriveStatusFromStoredEntitlement(stored) {
  if (!stored || typeof stored !== "object") {
    return null;
  }

  const now = Date.now();
  const trialStartMs = toFiniteNumber(stored.trialStartMs);
  const trialEndOverrideMs = toFiniteNumber(stored.trialEndMs);
  const trialEndMs = trialEndOverrideMs > 0
    ? trialEndOverrideMs
    : (trialStartMs > 0 ? (trialStartMs + TRIAL_PERIOD_MS) : 0);
  const entitledUntilMs = toFiniteNumber(stored.entitledUntilMs);
  const graceUntilMs = toFiniteNumber(stored.graceUntilMs);

  const lastErrorCode = normalizeErrorCode(stored.lastErrorCode);
  const hardDeny = HARD_DENY_ERROR_CODES.has(lastErrorCode);
  const paidActive = hardDeny === false && (
    entitledUntilMs > now ||
    (entitledUntilMs > 0 && graceUntilMs > now)
  );
  const trialActive = trialEndMs > now;

  let status = "expired";
  if (paidActive) {
    status = "paid";
  } else if (trialActive) {
    status = "trial";
  }

  return {
    status,
    now,
    trialStartMs,
    trialEndMs,
    entitledUntilMs,
    graceUntilMs,
    licenseKeyPresent: typeof stored.licenseKey === "string" && stored.licenseKey.trim() !== "",
    lastError: typeof stored.lastError === "string" ? stored.lastError : "",
    lastErrorCode,
    lastErrorMessage: typeof stored.lastErrorMessage === "string" ? stored.lastErrorMessage : "",
    lastErrorAction: typeof stored.lastErrorAction === "string" ? stored.lastErrorAction : ""
  };
}

async function hydrateFromLocalCache() {
  let cachedEntitlement = null;
  let cachedDefaultMode = null;
  try {
    const cached = await chrome.storage.local.get([
      ENTITLEMENT_LOCAL_STORAGE_KEY,
      FILTERING_MODE_STORAGE_KEY
    ]);
    cachedEntitlement = deriveStatusFromStoredEntitlement(cached?.[ENTITLEMENT_LOCAL_STORAGE_KEY]);
    cachedDefaultMode = deriveDefaultFilteringModeFromCache(cached?.[FILTERING_MODE_STORAGE_KEY]);
  } catch (_error) {
    return;
  }

  if (cachedDefaultMode !== null) {
    defaultFilteringMode = cachedDefaultMode;
    currentEnabledState = cachedDefaultMode !== MODE_NONE;
    renderToggle(currentEnabledState);
  }
  if (cachedEntitlement) {
    applyEntitlementStatus(cachedEntitlement);
  }
}

function isValidFilteringModesSnapshot(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return ["none", "basic", "optimal", "complete"].every((key) => {
    const entries = value[key];
    return Array.isArray(entries) && entries.every((item) => typeof item === "string");
  });
}

async function readGlobalPauseSnapshot() {
  try {
    const stored = await chrome.storage.local.get(GLOBAL_PAUSE_SNAPSHOT_KEY);
    const snapshot = stored?.[GLOBAL_PAUSE_SNAPSHOT_KEY];
    if (isValidFilteringModesSnapshot(snapshot)) {
      return snapshot;
    }
  } catch (_error) {
    // ignore
  }
  return null;
}

async function writeGlobalPauseSnapshot(snapshot) {
  try {
    await chrome.storage.local.set({
      [GLOBAL_PAUSE_SNAPSHOT_KEY]: snapshot
    });
  } catch (_error) {
    // ignore
  }
}

async function clearGlobalPauseSnapshot() {
  try {
    await chrome.storage.local.remove(GLOBAL_PAUSE_SNAPSHOT_KEY);
  } catch (_error) {
    // ignore
  }
}

function normalizeExternalUrl(url) {
  if (typeof url !== "string") {
    return "";
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function openUrlInTab(url) {
  const target = normalizeExternalUrl(url);
  if (!target) {
    return;
  }

  const fallbackOpen = () => {
    // Last resort: try a regular window open from popup context.
    try {
      const opened = window.open(target, "_blank", "noopener");
      if (!opened) {
        window.location.href = target;
      }
    } catch (_error) {
      // ignore
    }
  };

  const viaRuntimeMessage = () => {
    try {
      chrome.runtime.sendMessage({ what: "gotoURL", url: target, type: "tab" }, () => {
        if (chrome.runtime?.lastError) {
          fallbackOpen();
        } else {
          try { window.close(); } catch (_error) { /* ignore */ }
        }
      });
      return true;
    } catch (_error) {
      return false;
    }
  };

  // Primary path: open tab directly from the user click gesture.
  try {
    if (chrome?.tabs?.create) {
      chrome.tabs.create({ active: true, url: target }, () => {
        if (chrome.runtime?.lastError) {
          if (!viaRuntimeMessage()) {
            fallbackOpen();
          }
          return;
        }
        try { window.close(); } catch (_error) { /* ignore */ }
      });
      return;
    }
  } catch (_error) {
    // Continue to fallbacks below.
  }

  if (!viaRuntimeMessage()) {
    fallbackOpen();
  }
}

function wireEvents() {
  bindLicenseKeyFormatter(licenseKeyEl);
  bindLicenseKeyFormatter(expiredLicenseKeyEl);

  if (toggleButton) {
    toggleButton.addEventListener("click", async () => {
      if (paywalled) {
        focusLicenseEntry();
        return;
      }
      setToggleLoading(true);
      try {
        await setSiteEnabled(!currentEnabledState);
      } finally {
        setToggleLoading(false);
      }
    });
  }

  if (openSettingsButton) {
    openSettingsButton.addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });
  }

  if (privacyLinkButton) {
    privacyLinkButton.addEventListener("click", () => {
      openUrlInTab(PRIVACY_URL);
    });
  }

  if (blockDomainButton) {
    blockDomainButton.addEventListener("click", () => {
      if (paywalled) {
        focusLicenseEntry();
        return;
      }
      setSiteMode(MODE_COMPLETE);
    });
  }

  if (allowDomainButton) {
    allowDomainButton.addEventListener("click", () => {
      if (paywalled) {
        focusLicenseEntry();
        return;
      }
      setSiteMode(MODE_NONE);
    });
  }

  if (licenseFormEl) {
    licenseFormEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      await activateLicense();
    });
  }

  if (subscribeNowButton) {
    subscribeNowButton.addEventListener("click", () => {
      openUrlInTab(SUBSCRIBE_URL);
    });
  }

  if (showLicenseEntryButton) {
    showLicenseEntryButton.addEventListener("click", () => {
      licenseEntryVisible = true;
      setLicenseEntryVisible(true, { focus: true });
      showLicenseEntryButton.hidden = true;
    });
  }

  if (recoverLicenseLink) {
    recoverLicenseLink.addEventListener("click", () => {
      openUrlInTab(RECOVER_LICENSE_URL);
    });
  }
  if (useThisDeviceButton) {
    useThisDeviceButton.addEventListener("click", async () => {
      useThisDeviceButton.disabled = true;
      if (licenseStatusEl) {
        licenseStatusEl.textContent = t("licenseStatusUsingThisDevice");
        licenseStatusEl.className = "status-note";
        licenseStatusEl.hidden = false;
      }
      try {
        await chrome.runtime.sendMessage({ what: "replaceDevice" });
      } catch (error) {
        console.error("Device replace failed", error);
      }
      useThisDeviceButton.disabled = false;
      await refreshEntitlement();
    });
  }

  if (supportLinkButton) {
    supportLinkButton.addEventListener("click", () => {
      openUrlInTab(SUPPORT_URL);
    });
  }

  if (expiredOverlayFormEl) {
    expiredOverlayFormEl.addEventListener("submit", async (event) => {
      event.preventDefault();
      const key = canonicalizeLicenseKeyInput(expiredLicenseKeyEl?.value || "");
      await activateLicenseKey(key, { statusEl: expiredOverlayStatusEl });
    });
  }

  if (expiredSubscribeNowButtonEl) {
    expiredSubscribeNowButtonEl.addEventListener("click", () => {
      openUrlInTab(TRIAL_EXPIRED_URL);
    });
  }

  if (expiredShowKeyEntryButtonEl) {
    expiredShowKeyEntryButtonEl.addEventListener("click", () => {
      setExpiredKeyEntryVisible(true, { focus: true });
    });
  }

  if (expiredRecoverLicenseButtonEl) {
    expiredRecoverLicenseButtonEl.addEventListener("click", () => {
      openUrlInTab(RECOVER_LICENSE_URL);
    });
  }

  if (expiredSupportLinkEl) {
    expiredSupportLinkEl.addEventListener("click", () => {
      openUrlInTab(SUPPORT_URL);
    });
  }

  if (expiredUseThisDeviceButtonEl) {
    expiredUseThisDeviceButtonEl.addEventListener("click", async () => {
      expiredUseThisDeviceButtonEl.disabled = true;
      if (expiredOverlayStatusEl) {
        expiredOverlayStatusEl.textContent = t("licenseStatusUsingThisDevice");
        expiredOverlayStatusEl.className = "status-note";
        expiredOverlayStatusEl.hidden = false;
      }
      try {
        await chrome.runtime.sendMessage({ what: "replaceDevice" });
      } catch (error) {
        console.error("Device replace failed", error);
      }
      expiredUseThisDeviceButtonEl.disabled = false;
      await refreshEntitlement();
    });
  }
}

async function resolveActiveHost() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = tabs && tabs[0];
    currentTabId = active?.id ?? null;
    if (active?.url) {
      const url = new URL(active.url);
      currentHost = url.hostname;
    }
  } catch (_error) {
    currentHost = null;
    currentTabId = null;
  }

  if (dynamicHostLabelEl) {
    dynamicHostLabelEl.textContent = currentHost || t("popupNoActiveTab");
  }
}

function formatRemaining(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const formatUnit = (value, unit, unitDisplay = "long") => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "unit",
        unit,
        unitDisplay,
        maximumFractionDigits: 0
      }).format(value);
    } catch {
      if (unit === "day") {
        return `${value} day${value === 1 ? "" : "s"}`;
      }
      if (unit === "hour") {
        return unitDisplay === "short" ? `${value}h` : `${value} hour${value === 1 ? "" : "s"}`;
      }
      if (unit === "minute") {
        return unitDisplay === "short" ? `${value}m` : `${value} minute${value === 1 ? "" : "s"}`;
      }
      return String(value);
    }
  };
  if (days >= 2) {
    return formatUnit(days, "day", "long");
  }
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days === 1) {
    const oneDay = formatUnit(1, "day", "long");
    return hours ? `${oneDay} ${formatUnit(hours, "hour", "short")}` : oneDay;
  }
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 1) {
    const hoursPart = formatUnit(hours, "hour", "short");
    return minutes ? `${hoursPart} ${formatUnit(minutes, "minute", "short")}` : hoursPart;
  }
  return formatUnit(minutes, "minute", "short");
}

function canonicalizeLicenseKeyInput(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  // Preserve signed offline keys (dot-separated payload/signature) as entered.
  if (/^aab1\./i.test(raw)) {
    return raw;
  }

  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) {
    return "";
  }

  const truncated = cleaned.slice(0, 18);
  return formatByGroups(truncated, [2, 4, 4, 4, 4]);
}

function bindLicenseKeyFormatter(inputEl) {
  if (!inputEl) {
    return;
  }
  inputEl.addEventListener("input", () => {
    const next = canonicalizeLicenseKeyInput(inputEl.value);
    if (next !== inputEl.value) {
      inputEl.value = next;
    }
  });
}

function formatByGroups(value, groups) {
  if (!value) {
    return "";
  }
  let offset = 0;
  const parts = [];
  for (const size of groups) {
    if (offset >= value.length) {
      break;
    }
    parts.push(value.slice(offset, offset + size));
    offset += size;
  }
  if (offset < value.length) {
    parts.push(value.slice(offset));
  }
  return parts.filter(Boolean).join("-");
}

function setPaywalledUI(isPaywalled) {
  if (popupRootEl) {
    popupRootEl.hidden = Boolean(isPaywalled);
  }
}

function focusLicenseEntry() {
  if (paywalled && expiredOverlayEl && !expiredOverlayEl.hidden) {
    if (expiredUseThisDeviceButtonEl && !expiredUseThisDeviceButtonEl.hidden) {
      expiredUseThisDeviceButtonEl.focus();
      return;
    }
    setExpiredKeyEntryVisible(true, { focus: true });
    return;
  }
  if (subscriptionCardEl) {
    subscriptionCardEl.hidden = false;
  }
  licenseEntryVisible = true;
  setLicenseEntryVisible(true, { focus: true });
  if (showLicenseEntryButton) {
    showLicenseEntryButton.hidden = true;
  }
  if (licenseKeyEl) {
    licenseKeyEl.focus();
    licenseKeyEl.select();
  } else if (openSettingsButton) {
    openSettingsButton.focus();
  }
}

function setLicenseEntryVisible(visible, { focus = false } = {}) {
  if (licenseFormEl) {
    licenseFormEl.hidden = !visible;
  }
  if (licenseStatusEl) {
    licenseStatusEl.hidden = !visible;
  }
  if (visible && focus && licenseKeyEl) {
    licenseKeyEl.focus();
    licenseKeyEl.select();
  }
}

function setExpiredKeyEntryVisible(visible, { focus = false } = {}) {
  const showEntry = Boolean(visible);
  expiredKeyEntryVisible = showEntry;
  if (expiredOverlayFormEl) {
    expiredOverlayFormEl.hidden = !showEntry;
  }
  if (expiredShowKeyEntryButtonEl) {
    expiredShowKeyEntryButtonEl.hidden = showEntry;
  }
  if (expiredOverlayStep2El) {
    expiredOverlayStep2El.classList.toggle("expanded", showEntry);
  }
  if (showEntry && focus && expiredLicenseKeyEl) {
    try {
      expiredLicenseKeyEl.focus();
      expiredLicenseKeyEl.select();
    } catch {
      // ignore
    }
  }
}

function renderEntitlementStatus(status) {
  if (subscriptionCardEl) {
    subscriptionCardEl.hidden = false;
  }
  if (!subscriptionStatusEl) {
    return;
  }
  if (subscriptionSubstatusEl) {
    subscriptionSubstatusEl.hidden = true;
  }

  const now = Date.now();
  const state = status?.status || "expired";
  if (state === "paid") {
    const until = Number(status?.entitledUntilMs) || 0;
    subscriptionStatusEl.textContent = until
      ? t("subscriptionPaidUntil", [new Date(until).toLocaleDateString()])
      : t("subscriptionPaid");
    if (subscriptionSubstatusEl) {
      subscriptionSubstatusEl.textContent = t("subscriptionPaidManageNote");
      subscriptionSubstatusEl.hidden = false;
    }
    return;
  }

  if (state === "trial") {
    const trialEnd = Number(status?.trialEndMs) || 0;
    const remaining = trialEnd ? formatRemaining(trialEnd - now) : t("uiSoon");
    subscriptionStatusEl.textContent = t("subscriptionTrial", [remaining]);
    if (subscriptionSubstatusEl) {
      subscriptionSubstatusEl.textContent = t("subscriptionTrialAfterNote");
      subscriptionSubstatusEl.hidden = false;
    }
    return;
  }

  const errMessage = typeof status?.lastErrorMessage === "string" ? status.lastErrorMessage.trim() : "";
  const errFallback = typeof status?.lastError === "string" ? status.lastError.trim() : "";
  const errCode = typeof status?.lastErrorCode === "string" ? status.lastErrorCode.trim() : "";
  const errText = errMessage || errFallback || errCode;

  if (state === "error") {
    subscriptionStatusEl.textContent = t("licenseStatusVerifyLater");
    subscriptionStatusEl.className = "status-note muted";
    return;
  }

  subscriptionStatusEl.textContent = errText
    ? t("subscriptionExpiredWithError", [errText])
    : t("subscriptionExpired");
}

function renderExpiredOverlay(status, { canReplaceDevice = false } = {}) {
  if (!expiredOverlayEl) {
    return;
  }

  const visible = status?.status === "expired";
  expiredOverlayEl.hidden = !visible;

  if (!visible) {
    setExpiredKeyEntryVisible(false);
    if (expiredOverlayStep2El) {
      expiredOverlayStep2El.hidden = false;
    }
    if (expiredOverlayStatusEl) {
      expiredOverlayStatusEl.hidden = true;
      expiredOverlayStatusEl.textContent = "";
    }
    return;
  }

  if (expiredOverlayStatusEl) {
    expiredOverlayStatusEl.hidden = true;
    expiredOverlayStatusEl.textContent = "";
  }

  const lastErrorCode = typeof status?.lastErrorCode === "string" ? status.lastErrorCode.trim() : "";
  const lastErrorAction = typeof status?.lastErrorAction === "string" ? status.lastErrorAction.trim() : "";

  const showUseThisDevice = Boolean(canReplaceDevice) &&
    lastErrorCode === "MAX_DEVICES" &&
    lastErrorAction === "USE_THIS_DEVICE";

  if (expiredOverlayBadgeEl) {
    expiredOverlayBadgeEl.textContent = showUseThisDevice ? t("expiredOverlayBadgeMaxDevices") : t("expiredOverlayBadge");
  }

  if (expiredOverlayTitleEl) {
    expiredOverlayTitleEl.textContent = showUseThisDevice ? t("expiredOverlayTitleMaxDevices") : t("expiredOverlayTitle");
  }

  if (showUseThisDevice) {
    if (expiredOverlayBullet1El) { expiredOverlayBullet1El.textContent = t("expiredOverlayBulletMax1"); }
    if (expiredOverlayBullet2El) { expiredOverlayBullet2El.textContent = t("expiredOverlayBulletMax2"); }
    if (expiredOverlayBullet3El) { expiredOverlayBullet3El.textContent = t("expiredOverlayBulletMax3"); }
  } else {
    if (expiredOverlayBullet1El) { expiredOverlayBullet1El.textContent = t("expiredOverlayBullet1"); }
    if (expiredOverlayBullet2El) { expiredOverlayBullet2El.textContent = t("expiredOverlayBullet2"); }
    if (expiredOverlayBullet3El) { expiredOverlayBullet3El.textContent = t("expiredOverlayBullet3"); }
  }

  if (expiredOverlayMetaEl) {
    expiredOverlayMetaEl.hidden = true;
    expiredOverlayMetaEl.textContent = "";
  }

  if (expiredUseThisDeviceButtonEl) {
    expiredUseThisDeviceButtonEl.hidden = !showUseThisDevice;
  }
  if (expiredSubscribeNowButtonEl) {
    expiredSubscribeNowButtonEl.hidden = showUseThisDevice;
  }
  if (expiredOverlayStep2El) {
    expiredOverlayStep2El.hidden = showUseThisDevice;
  }
  if (showUseThisDevice) {
    setExpiredKeyEntryVisible(false);
    setTimeout(() => {
      try {
        expiredUseThisDeviceButtonEl.focus();
      } catch {
        // ignore
      }
    }, 0);
  } else {
    // Keep activation collapsed by default, but preserve the user's expanded state.
    setExpiredKeyEntryVisible(expiredKeyEntryVisible);
  }
}

function applyEntitlementStatus(status) {
  entitlementStatus = status || { status: "error", lastError: "Unknown" };
  paywalled = entitlementStatus?.status === "expired";
  const isPaid = entitlementStatus?.status === "paid";
  const canReplaceDevice = !isPaid &&
    entitlementStatus?.licenseKeyPresent &&
    entitlementStatus?.lastErrorCode === "MAX_DEVICES" &&
    entitlementStatus?.lastErrorAction === "USE_THIS_DEVICE";

  renderEntitlementStatus(entitlementStatus);
  setPaywalledUI(paywalled);
  renderExpiredOverlay(entitlementStatus, { canReplaceDevice });

  if (subscribeNowButton) {
    subscribeNowButton.style.display = isPaid ? "none" : "";
  }
  const ctaNote = document.querySelector(".subscription-cta-note");
  if (ctaNote) {
    ctaNote.style.display = isPaid ? "none" : "";
  }
  if (showLicenseEntryButton) {
    showLicenseEntryButton.hidden = isPaid || licenseEntryVisible;
  }
  if (recoverLicenseLink) {
    recoverLicenseLink.hidden = isPaid;
  }
  if (useThisDeviceButton) {
    useThisDeviceButton.hidden = !canReplaceDevice;
  }
  if (expiredUseThisDeviceButtonEl) {
    expiredUseThisDeviceButtonEl.hidden = !canReplaceDevice;
  }

  if (isPaid) {
    licenseEntryVisible = false;
  }
  setLicenseEntryVisible(licenseEntryVisible && !isPaid);

  if (paywalled) {
    currentEnabledState = false;
    renderToggle(false);
  }
}

async function refreshEntitlement() {
  let nextStatus;
  try {
    nextStatus = await chrome.runtime.sendMessage({ what: "getEntitlementStatus" });
  } catch (error) {
    console.warn("Entitlement check failed", error);
    // distinguishes network error from explicit expiry
    nextStatus = { status: "error", lastError: "Network Error" };
  }
  applyEntitlementStatus(nextStatus);
}

async function activateLicense() {
  setLicenseEntryVisible(true);
  const key = canonicalizeLicenseKeyInput(licenseKeyEl?.value || "");
  await activateLicenseKey(key, { statusEl: licenseStatusEl });
}

async function activateLicenseKey(key, { statusEl } = {}) {
  const normalized = canonicalizeLicenseKeyInput(key);
  if (!normalized) {
    if (statusEl) {
      statusEl.textContent = t("licenseStatusEnterKey");
      statusEl.className = "status-note";
      statusEl.hidden = false;
    }
    return;
  }

  if (statusEl) {
    statusEl.textContent = t("licenseStatusActivating");
    statusEl.className = "status-note";
    statusEl.hidden = false;
  }

  try {
    await chrome.runtime.sendMessage({ what: "setLicenseKey", licenseKey: normalized });
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = t("licenseStatusActivationFailed");
      statusEl.className = "status-note";
      statusEl.hidden = false;
    }
    console.error("License activation failed", error);
  }

  await refreshEntitlement();
  if (entitlementStatus?.status === "paid") {
    await Promise.all([refreshFilteringState(), refreshFilterCatalog()]);
    if (statusEl && statusEl.hidden === false) {
      statusEl.textContent = t("licenseStatusActivated");
      statusEl.className = "status-note";
    }
    if (currentTabId) {
      try {
        await chrome.tabs.reload(currentTabId);
      } catch (_error) {
        // ignore
      }
    }
    return;
  }

  if (!statusEl) {
    return;
  }

  if (entitlementStatus?.lastErrorCode === "MAX_DEVICES") {
    statusEl.textContent = t("licenseStatusUseThisDevice");
    statusEl.className = "status-note";
    statusEl.hidden = false;
    return;
  }

  statusEl.textContent =
    entitlementStatus?.licenseKeyPresent
      ? t("licenseStatusVerifyLater")
      : t("licenseStatusActivationRequired");
  statusEl.className = "status-note muted";
  statusEl.hidden = false;
}

async function refreshFilteringState() {
  try {
    const defaultMode = await chrome.runtime.sendMessage({ what: "getDefaultFilteringMode" });
    defaultFilteringMode = Number(defaultMode);
    if (!Number.isFinite(defaultFilteringMode)) {
      defaultFilteringMode = MODE_OPTIMAL;
    }
    currentEnabledState = defaultFilteringMode !== MODE_NONE;
  } catch (_error) {
    defaultFilteringMode = MODE_OPTIMAL;
    currentEnabledState = true;
  }
  renderToggle(currentEnabledState);
}

async function setSiteEnabled(enabled) {
  if (enabled) {
    const snapshot = await readGlobalPauseSnapshot();
    if (snapshot) {
      await chrome.runtime.sendMessage({ what: "setFilteringModeDetails", modes: snapshot });
      await clearGlobalPauseSnapshot();
    } else {
      const fallbackLevel = defaultFilteringMode === MODE_NONE ? MODE_OPTIMAL : defaultFilteringMode;
      await chrome.runtime.sendMessage({ what: "setDefaultFilteringMode", level: fallbackLevel });
    }
  } else {
    const currentModes = await chrome.runtime.sendMessage({ what: "getFilteringModeDetails" });
    if (isValidFilteringModesSnapshot(currentModes)) {
      await writeGlobalPauseSnapshot(currentModes);
    }
    await chrome.runtime.sendMessage({ what: "setFilteringModeDetails", modes: PAUSED_FILTERING_MODES });
  }
  await refreshFilteringState();
  if (currentTabId) {
    try {
      await chrome.tabs.reload(currentTabId);
    } catch (_error) {
      // ignore
    }
  }
}

async function setSiteMode(level) {
  if (!currentHost) {
    return;
  }
  try {
    await chrome.runtime.sendMessage({
      what: "setFilteringMode",
      hostname: currentHost,
      level
    });
  } catch (error) {
    console.error("Failed to set filtering mode", error);
  }
  await refreshFilteringState();
  if (dynamicStatusEl) {
    if (level === MODE_NONE) {
      dynamicStatusEl.textContent = t("popupFilteringDisabledSite");
    } else if (level === MODE_COMPLETE) {
      dynamicStatusEl.textContent = t("popupFilteringCompleteSite");
    } else {
      dynamicStatusEl.textContent = t("popupFilteringEnabledSite");
    }
  }
  if (currentTabId) {
    try {
      await chrome.tabs.reload(currentTabId);
    } catch (_error) {
      // ignore
    }
  }
}


// Removed refreshFilterCatalog logic (Header Tuck Option)
async function refreshFilterCatalog() {
  // No-op
  return Promise.resolve();
}



function renderToggle(enabled) {
  if (!toggleButton) {
    return;
  }
  if (paywalled) {
    toggleButton.disabled = false;
    toggleButton.classList.add("off");
    toggleButton.setAttribute("aria-checked", "false");
    toggleButton.setAttribute("data-i18n-aria-label", "popupToggleActivateSubscription");
    toggleButton.setAttribute("aria-label", t("popupToggleActivateSubscription"));
    updateStatusSummary();
    return;
  }
  toggleButton.classList.toggle("off", !enabled);
  const toggleLabelKey = enabled ? "popupToggleDisableProtection" : "popupToggleEnableProtection";
  toggleButton.setAttribute("data-i18n-aria-label", toggleLabelKey);
  toggleButton.setAttribute("aria-label", t(toggleLabelKey));
  updateStatusSummary();
}

function setToggleLoading(isLoading) {
  if (!toggleButton) {
    return;
  }
  toggleButton.disabled = isLoading;
  toggleButton.classList.toggle("loading", isLoading);
}

function renderFilterCatalog(summary) {
  if (!filterPackSummaryEl || !filterPackListEl) {
    return;
  }

  filterPackListEl.innerHTML = "";

  if (!summary) {
    filterPackSummaryEl.textContent = t("filterPacksSummaryUnavailable");
    appendEmptyFilterItem(t("filterPacksSummarySettingsHint"));
    return;
  }

  const total = Number(summary.total) || 0;
  const enabled = Number(summary.enabled) || 0;

  if (total === 0) {
    filterPackSummaryEl.textContent = t("filterPacksSummaryComingSoon");
    appendEmptyFilterItem(t("filterPacksSummaryEmptyHint"));
    return;
  }

  filterPackSummaryEl.textContent = t("filterPacksSummaryActive", [
    String(enabled),
    String(total),
    pluralSuffix(total)
  ]);

  const packs = Array.isArray(summary.packs) ? summary.packs : [];
  const active = packs.filter((pack) => pack.enabled);

  if (!active.length) {
    appendEmptyFilterItem(t("filterPacksSummaryNone"));
    return;
  }

  const visiblePacks = active.slice(0, 3);
  visiblePacks.forEach((pack) => {
    const item = document.createElement("li");
    item.className = "filter-list-item";

    const title = document.createElement("div");
    title.className = "filter-list-title";
    title.textContent = pack.title || pack.id;

    const meta = document.createElement("div");
    meta.className = "filter-list-meta";
    const parts = [];
    if (pack.category) {
      parts.push(capitalize(pack.category));
    }
    const enabledLabel = t("filterPacksSummaryEnabledLabel");
    meta.textContent = parts.length ? parts.join(" - ") : enabledLabel;

    item.appendChild(title);
    item.appendChild(meta);
    filterPackListEl.appendChild(item);
  });

  if (active.length > visiblePacks.length) {
    const remainder = active.length - visiblePacks.length;
    const moreItem = document.createElement("li");
    moreItem.className = "filter-list-meta";
    moreItem.textContent = t("filterPacksSummaryMore", [String(remainder)]);
    filterPackListEl.appendChild(moreItem);
  }
}

function updateStatusSummary() {
  if (!statusLabel) {
    return;
  }

  if (paywalled) {
    statusLabel.textContent = t("popupStatusTrialEndedActivate");
    statusLabel.className = "status-text paused";
    if (headerEl) headerEl.classList.add("paused");
    updateProtectionSummary(false);
    return;
  }

  // Update text
  const message = currentEnabledState ? t("popupStatusProtectionActive") : t("popupStatusProtectionPaused");
  statusLabel.textContent = message;
  statusLabel.className = currentEnabledState ? "status-text active" : "status-text paused";
  statusLabel.style.color = ""; // Remove inline style if any

  // Update Header Class
  if (headerEl) {
    headerEl.classList.toggle("paused", !currentEnabledState);
  }

  // Update Switch State
  if (toggleButton) {
    toggleButton.classList.toggle("off", !currentEnabledState);
    toggleButton.setAttribute("aria-checked", String(currentEnabledState));
    toggleButton.textContent = "";
    const track = document.createElement("span");
    track.className = "switch-track";
    const knob = document.createElement("span");
    knob.className = "switch-knob";
    track.appendChild(knob);
    toggleButton.appendChild(track);
  }

  updateProtectionSummary(currentEnabledState);
}

function updateProtectionSummary(enabled) {
  if (statsCardEl) {
    statsCardEl.classList.toggle("paused", !enabled);
  }

  if (safetyStatusEl) {
    safetyStatusEl.textContent = enabled
      ? t("popupSafetyMessage")
      : t("popupStatusProtectionPaused");
  }

  if (metricLabelEls.length >= 3) {
    const messageKeys = enabled
      ? ["popupStatsAds", "popupStatsTrackers", "popupStatsScripts"]
      : ["expiredOverlayBullet1", "expiredOverlayBullet2", "expiredOverlayBullet3"];

    messageKeys.forEach((key, index) => {
      const message = t(key);
      if (metricLabelEls[index] && message && message !== key) {
        metricLabelEls[index].textContent = message;
      }
    });
  }
}

function appendEmptyFilterItem(text) {
  if (!filterPackListEl) {
    return;
  }
  const emptyItem = document.createElement("li");
  emptyItem.className = "filter-list-empty";
  emptyItem.textContent = text;
  filterPackListEl.appendChild(emptyItem);
}

function capitalize(value) {
  if (!value) {
    return "";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}
