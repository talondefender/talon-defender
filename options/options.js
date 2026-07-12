import { t } from "../shared/i18n.js";
import { readEntitlement } from "../js/entitlement.js";
import {
  SUBSCRIBE_URL,
  SUPPORT_URL,
  RECOVER_LICENSE_URL,
  PRIVACY_URL,
  MANAGE_SUBSCRIPTION_URL,
  WHATS_NEW_URL,
  TERMS_URL
} from "../shared/links.js";
import { readSourceCodeInfo } from "../shared/source-code.js";
import {
  createRulesetToggleDelta,
  createSerializedActionQueue,
  formatRulesetApplyError,
  getRulesetToggleState,
  normalizeEnabledRulesets,
} from "./ruleset-toggle-state.js";

const MODE_NONE = 0;
const OPTIONS_BROADCAST_CHANNEL = "uBOL";

const allowlistForm = document.getElementById("allowlistForm");
const allowlistInput = document.getElementById("allowlistInput");
const allowlistAddButton = document.getElementById("allowlistAdd");
const allowlistListEl = document.getElementById("allowlistList");
const allowlistEmptyEl = document.getElementById("allowlistEmpty");

const subscriptionStatusEl = document.getElementById("subscriptionStatus");
const subscriptionSubstatusEl = document.getElementById("subscriptionSubstatus");
const licenseLockedEl = document.getElementById("licenseLocked");
const licenseKeyLockedEl = document.getElementById("licenseKeyLocked");
const licenseRevealButton = document.getElementById("licenseRevealButton");
const licenseFormEl = document.getElementById("licenseForm");
const licenseKeyEl = document.getElementById("licenseKey");
const licenseActivateButton = document.getElementById("licenseActivate");
const licenseStatusEl = document.getElementById("licenseStatus");
const useThisDeviceButton = document.getElementById("useThisDeviceButton");
const subscribeNowButton = document.getElementById("subscribeNow");
const showLicenseEntryButton = document.getElementById("showLicenseEntry");
const recoverLicenseLink = document.getElementById("recoverLicenseLink");
const licenseKeyHintEl = document.querySelector(".subscription-key-hint");
const footerSupportLink = document.getElementById("footerSupport");
const footerManageLink = document.getElementById("footerManage");
const footerWhatsNewLink = document.getElementById("footerWhatsNew");
const footerPrivacyLink = document.getElementById("footerPrivacy");
const footerTermsLink = document.getElementById("footerTerms");
const footerSourceCodeLink = document.getElementById("footerSourceCode");
const footerAttributionsLink = document.getElementById("footerAttributions");
const footerRemoveLicenseLink = document.getElementById("footerRemoveLicense");
const ATTRIBUTIONS_URL =
  typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("options/attributions.html")
    : "options/attributions.html";
const LICENSE_RUNTIME_MESSAGE_TIMEOUT_MS = 12000;

const EXTRA_PROTECTION_RULESETS = [
  // The overlay-annoyance pack is owned exclusively by the Pop-ups control below.
  "annoyances-ai",
  "annoyances-cookies",
  "annoyances-social",
  "annoyances-widgets",
  "annoyances-others",
  "annoyances-notifications"
];

const FILTER_TOGGLES = [
  {
    checkbox: document.getElementById("filterEasyList"),
    statusEl: document.getElementById("filterEasyListStatus"),
    rulesets: ["ublock-filters", "easylist"],
    labelKey: "optionsFilterEasyListLabel"
  },
  {
    checkbox: document.getElementById("filterEasyPrivacy"),
    statusEl: document.getElementById("filterEasyPrivacyStatus"),
    rulesets: ["easyprivacy"],
    labelKey: "optionsFilterEasyPrivacyLabel"
  },
  {
    checkbox: document.getElementById("filterFanboyAnnoyance"),
    statusEl: document.getElementById("filterFanboyAnnoyanceStatus"),
    rulesets: ["annoyances-overlays"],
    labelKey: "optionsFilterAnnoyancesLabel"
  },
  {
    checkbox: document.getElementById("filterExtraProtection"),
    statusEl: document.getElementById("filterExtraProtectionStatus"),
    rulesets: EXTRA_PROTECTION_RULESETS,
    labelKey: "optionsFilterExtraProtectionLabel"
  },
  {
    checkbox: document.getElementById("filterSecurity"),
    statusEl: document.getElementById("filterSecurityStatus"),
    rulesets: ["ublock-badware", "urlhaus-full"],
    labelKey: "optionsFilterSecurityLabel"
  }
];

let enabledRulesets = new Set();
let entitlementStatus = null;
let paywalled = false;
let licenseEntryVisible = false;
let licenseKeyRevealed = false;
let storedLicenseKey = "";
let runtimeStateChannel = null;
let rulesetsLoaded = false;
let entitlementLoaded = false;
let pendingRulesetMutations = 0;
let pendingAllowlistMutations = 0;
let rulesetConfigRevision = null;
const rulesetMutationQueue = createSerializedActionQueue();
const allowlistMutationQueue = createSerializedActionQueue();

init().catch((error) => console.error("Options init failed", error));

async function sendRuntimeMessageWithTimeout(message, {
  timeoutMs = LICENSE_RUNTIME_MESSAGE_TIMEOUT_MS
} = {}) {
  let timeoutId = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => chrome.runtime.sendMessage(message)),
      new Promise((_, reject) => {
        timeoutId = self.setTimeout(() => {
          reject(new Error(`runtime message timeout: ${message?.what || "unknown"}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      self.clearTimeout(timeoutId);
    }
  }
}

function maskLicenseKey(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  const parts = raw.split("-").filter(Boolean);
  if (parts.length >= 3) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    const middle = parts.slice(1, -1).map(() => "XXXX");
    return [first, ...middle, last].join("-");
  }
  if (raw.length <= 8) return raw;
  return `${raw.slice(0, 4)}-XXXX-${raw.slice(-4)}`;
}

function updateLockedKeyDisplay() {
  if (!licenseKeyLockedEl || !licenseRevealButton) {
    return;
  }
  if (!storedLicenseKey) {
    licenseKeyLockedEl.value = "";
    licenseRevealButton.hidden = true;
    return;
  }
  licenseKeyLockedEl.value = licenseKeyRevealed
    ? storedLicenseKey
    : maskLicenseKey(storedLicenseKey);
  licenseRevealButton.hidden = false;
  licenseRevealButton.textContent = licenseKeyRevealed
    ? t("licenseHideButton")
    : t("licenseRevealButton");
}

async function init() {
  setDocumentLanguage();
  wireLicense();
  wireSubscriptionLinks();
  wireFooterLinks();
  wireRuntimeStateUpdates();
  wireCoreFilters();
  wireAllowlist();
  const rulesetsPromise = refreshRulesets();
  const allowlistPromise = refreshAllowlist();
  await refreshEntitlement();
  entitlementLoaded = true;
  setPaywalledUI(paywalled);
  renderCoreFilterStatus();
  await Promise.allSettled([rulesetsPromise, allowlistPromise]);
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

function renderEntitlementStatus(status) {
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
  const errCode = typeof status?.lastErrorCode === "string" ? status.lastErrorCode.trim() : "";
  const errText = errMessage || errCode;
  subscriptionStatusEl.textContent = errText
    ? t("subscriptionExpiredWithError", [errText])
    : t("subscriptionExpired");
}

async function refreshEntitlement(nextStatus = null) {
  if (nextStatus && typeof nextStatus === "object") {
    entitlementStatus = nextStatus;
  } else {
    try {
      entitlementStatus = await chrome.runtime.sendMessage({ what: "getEntitlementStatus" });
    } catch (_error) {
      entitlementStatus = { status: "expired" };
    }
  }
  paywalled = entitlementStatus?.status === "expired";
  renderEntitlementStatus(entitlementStatus);
  const isPaid = entitlementStatus?.status === "paid";
  const canReplaceDevice = !isPaid &&
    entitlementStatus?.licenseKeyPresent &&
    entitlementStatus?.lastErrorCode === "MAX_DEVICES" &&
    entitlementStatus?.lastErrorAction === "USE_THIS_DEVICE";
  if (licenseLockedEl && licenseKeyLockedEl) {
    if (isPaid) {
      const stored = await readEntitlement();
      storedLicenseKey = typeof stored?.licenseKey === "string" ? stored.licenseKey.trim() : "";
      licenseKeyRevealed = false;
      updateLockedKeyDisplay();
      licenseLockedEl.hidden = storedLicenseKey === "";
    } else {
      licenseLockedEl.hidden = true;
      storedLicenseKey = "";
      licenseKeyRevealed = false;
      updateLockedKeyDisplay();
    }
  }
  if (subscribeNowButton) {
    subscribeNowButton.style.display = isPaid ? "none" : "";
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
  if (isPaid) {
    licenseEntryVisible = false;
  }
  setLicenseEntryVisible(licenseEntryVisible && !isPaid);
}

function setPaywalledUI(isPaywalled) {
  const controls = document.querySelectorAll("input,textarea,select,button");
  controls.forEach((el) => {
    el.disabled = Boolean(isPaywalled);
  });
  if (licenseKeyEl) {
    licenseKeyEl.disabled = false;
  }
  if (licenseActivateButton) {
    licenseActivateButton.disabled = false;
  }
  if (subscribeNowButton) {
    subscribeNowButton.disabled = false;
  }
  if (showLicenseEntryButton) {
    showLicenseEntryButton.disabled = false;
  }
  if (recoverLicenseLink) {
    recoverLicenseLink.disabled = false;
  }
  if (useThisDeviceButton) {
    useThisDeviceButton.disabled = false;
  }
  renderAllowlistMutationState();
}

function setLicenseEntryVisible(visible, { focus = false } = {}) {
  if (licenseFormEl) {
    licenseFormEl.hidden = !visible;
  }
  if (licenseKeyHintEl) {
    licenseKeyHintEl.hidden = !visible;
  }
  if (licenseStatusEl) {
    licenseStatusEl.hidden = !visible;
  }
  if (visible && focus && licenseKeyEl) {
    licenseKeyEl.focus();
    licenseKeyEl.select();
  }
}

function wireLicense() {
  if (!licenseFormEl) {
    return;
  }
  bindLicenseKeyFormatter(licenseKeyEl);
  licenseFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    await activateLicense();
  });
  if (useThisDeviceButton) {
    useThisDeviceButton.addEventListener("click", async () => {
      useThisDeviceButton.disabled = true;
      if (licenseStatusEl) {
        licenseStatusEl.textContent = t("licenseStatusUsingThisDevice");
        licenseStatusEl.hidden = false;
      }
      let nextStatus = null;
      let replaceError = null;
      try {
        nextStatus = await sendRuntimeMessageWithTimeout({ what: "replaceDevice" });
        if (nextStatus?.error) {
          throw new Error(String(nextStatus.error));
        }
      } catch (error) {
        replaceError = error;
      }
      useThisDeviceButton.disabled = false;
      await refreshEntitlement(nextStatus);
      setPaywalledUI(paywalled);
      if (replaceError && entitlementStatus?.status !== "paid") {
        console.error("Device replace failed", replaceError);
      }
    });
  }
}

function wireSubscriptionLinks() {
  if (subscribeNowButton) {
    subscribeNowButton.addEventListener("click", () => {
      chrome.runtime.sendMessage({ what: "gotoURL", url: SUBSCRIBE_URL, type: "tab" });
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
      chrome.runtime.sendMessage({ what: "gotoURL", url: RECOVER_LICENSE_URL, type: "tab" });
    });
  }
  if (licenseRevealButton) {
    licenseRevealButton.addEventListener("click", () => {
      licenseKeyRevealed = !licenseKeyRevealed;
      updateLockedKeyDisplay();
    });
  }
}

function wireFooterLink(element, url) {
  if (!element) {
    return;
  }
  element.setAttribute("href", url);
  element.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.sendMessage({ what: "gotoURL", url, type: "tab" });
  });
}

function wireFooterLinks() {
  wireFooterLink(footerSupportLink, SUPPORT_URL);
  wireFooterLink(footerManageLink, MANAGE_SUBSCRIPTION_URL);
  wireFooterLink(footerWhatsNewLink, WHATS_NEW_URL);
  wireFooterLink(footerPrivacyLink, PRIVACY_URL);
  wireFooterLink(footerTermsLink, TERMS_URL);
  wireFooterLink(footerAttributionsLink, ATTRIBUTIONS_URL);
  wireSourceCodeLink();
  wireFooterRemoveLicense();
}

async function wireSourceCodeLink() {
  if (!footerSourceCodeLink) {
    return;
  }
  const info = await readSourceCodeInfo();
  const url = typeof info?.sourceCodeUrl === "string" ? info.sourceCodeUrl : "";
  if (!url) {
    return;
  }
  const version = typeof info?.version === "string" ? info.version.trim() : "";
  footerSourceCodeLink.textContent = version
    ? `Source code for this version (v${version})`
    : "Source code for this version";
  wireFooterLink(footerSourceCodeLink, url);
}

function wireFooterRemoveLicense() {
  if (!footerRemoveLicenseLink) {
    return;
  }
  footerRemoveLicenseLink.setAttribute("href", "#");
  footerRemoveLicenseLink.addEventListener("click", async (event) => {
    event.preventDefault();
    const confirmed = window.confirm(t("footerRemoveLicenseConfirm"));
    if (!confirmed) {
      return;
    }
    let nextStatus = null;
    let clearError = null;
    try {
      nextStatus = await sendRuntimeMessageWithTimeout({ what: "clearLicenseKey" });
      if (nextStatus?.error) {
        throw new Error(String(nextStatus.error));
      }
    } catch (error) {
      clearError = error;
    }
    if (licenseKeyEl) {
      licenseKeyEl.value = "";
    }
    await refreshEntitlement(nextStatus);
    setPaywalledUI(paywalled);
    if (licenseStatusEl) {
      licenseStatusEl.textContent = t("licenseStatusRemoved");
    }
    if (clearError) {
      console.error("Failed to clear license", clearError);
    }
  });
}

async function activateLicense() {
  setLicenseEntryVisible(true);
  const key = canonicalizeLicenseKeyInput(licenseKeyEl?.value || "");
  if (!key) {
    if (licenseStatusEl) {
      licenseStatusEl.textContent = t("licenseStatusEnterKey");
    }
    return;
  }

  if (licenseStatusEl) {
    licenseStatusEl.textContent = t("licenseStatusActivating");
  }

  let nextStatus = null;
  let activationError = null;
  try {
    nextStatus = await sendRuntimeMessageWithTimeout({ what: "setLicenseKey", licenseKey: key });
    if (nextStatus?.error) {
      throw new Error(String(nextStatus.error));
    }
  } catch (error) {
    activationError = error;
  }

  await refreshEntitlement(nextStatus);
  setPaywalledUI(paywalled);
  const isPaid = entitlementStatus?.status === "paid";
  if (isPaid) {
    if (licenseStatusEl) {
      licenseStatusEl.textContent = t("licenseStatusActivated");
    }
    // Reload to re-enable the full settings surface cleanly.
    self.location.reload();
    return;
  }

  if (licenseStatusEl) {
    if (entitlementStatus?.lastErrorCode === "MAX_DEVICES") {
      licenseStatusEl.textContent = t("licenseStatusUseThisDevice");
      if (useThisDeviceButton) {
        useThisDeviceButton.hidden = false;
      }
    } else if (entitlementStatus?.licenseKeyPresent) {
      licenseStatusEl.textContent = t("licenseStatusVerifyLater");
    } else {
      licenseStatusEl.textContent = activationError
        ? t("licenseStatusActivationFailed")
        : t("licenseStatusActivationRequired");
    }
  }
  if (activationError) {
    console.error("Activation failed", activationError);
  }
}

function wireCoreFilters() {
  FILTER_TOGGLES.forEach((entry) => {
    if (!entry.checkbox) return;
    entry.checkbox.addEventListener("change", async (event) => {
      const enabled = Boolean(event.target.checked);
      pendingRulesetMutations += 1;
      renderCoreFilterStatus();
      try {
        await rulesetMutationQueue.enqueue(() =>
          setRulesetsEnabled(entry.rulesets, enabled)
        );
      } catch (error) {
        console.error(`Failed to toggle ${t(entry.labelKey)}`, error);
        await refreshRulesets();
      } finally {
        pendingRulesetMutations -= 1;
        renderCoreFilterStatus();
      }
    });
  });
}

function wireRuntimeStateUpdates() {
  if (runtimeStateChannel !== null) {
    return;
  }
  try {
    runtimeStateChannel = new BroadcastChannel(OPTIONS_BROADCAST_CHANNEL);
    runtimeStateChannel.onmessage = (event) => {
      const message = event?.data;
      if (!(message instanceof Object)) {
        return;
      }
      if (Array.isArray(message.enabledRulesets)) {
        rulesetsLoaded = true;
        enabledRulesets = new Set(normalizeEnabledRulesets(message.enabledRulesets));
        const nextRevision = normalizeConfigRevision(message.configRevision);
        if (nextRevision !== null) {
          rulesetConfigRevision = nextRevision;
        }
        renderCoreFilterStatus();
      }
    };
  } catch (error) {
    console.warn("Options runtime state channel unavailable", error);
  }
}

function wireAllowlist() {
  if (allowlistForm) {
    allowlistForm.addEventListener("submit", handleAllowlistSubmit);
  }
  if (allowlistListEl) {
    allowlistListEl.addEventListener("click", async (event) => {
      const button = event.target.closest(".allowlist-remove");
      if (!button) return;
      const hostname = button.getAttribute("data-hostname");
      if (!hostname) return;
      await handleAllowlistRemove(hostname, button);
    });
  }
}

async function refreshRulesets() {
  rulesetsLoaded = false;
  renderCoreFilterStatus();
  try {
    let enabled = null;
    const snapshot = await sendRuntimeMessageWithTimeout(
      { what: "getOptionsPageData" },
      { timeoutMs: 4000 }
    ).catch(() => null);
    if (Array.isArray(snapshot?.enabledRulesets)) {
      enabled = snapshot.enabledRulesets;
      rulesetConfigRevision = normalizeConfigRevision(snapshot.configRevision);
    }
    if (Array.isArray(enabled) === false) {
      enabled = await sendRuntimeMessageWithTimeout(
        { what: "getEnabledRulesets" },
        { timeoutMs: 4000 }
      );
      rulesetConfigRevision = null;
    }
    enabledRulesets = new Set(normalizeEnabledRulesets(enabled));
  } catch (error) {
    console.error("Failed to load ruleset state", error);
    enabledRulesets = new Set();
    rulesetConfigRevision = null;
  } finally {
    rulesetsLoaded = true;
  }
  renderCoreFilterStatus();
}

function getToggleActivityState(entry) {
  return getRulesetToggleState(Array.from(enabledRulesets), entry.rulesets);
}

function renderCoreFilterStatus() {
  FILTER_TOGGLES.forEach((entry) => {
    if (!entry.checkbox) return;
    if (rulesetsLoaded === false) {
      entry.checkbox.checked = false;
      entry.checkbox.indeterminate = true;
      entry.checkbox.disabled = true;
      if (entry.statusEl) {
        entry.statusEl.textContent = t("uiLoading");
        entry.statusEl.className = "toggle-status muted";
      }
      return;
    }
    const { allEnabled, partial } = getToggleActivityState(entry);
    entry.checkbox.checked = allEnabled;
    entry.checkbox.indeterminate = partial;
    entry.checkbox.disabled =
      entitlementLoaded === false ||
      paywalled ||
      pendingRulesetMutations !== 0;
    if (entry.statusEl) {
      const stateText = partial
        ? t("uiPartial")
        : allEnabled
          ? t("uiActive")
          : t("uiDisabled");
      const stateClass = partial
        ? "warn"
        : allEnabled
          ? "ok"
          : "muted";
      entry.statusEl.textContent = stateText;
      entry.statusEl.className = `toggle-status ${stateClass}`;
    }
  });
}

async function setRulesetsEnabled(ids, enabled) {
  const delta = createRulesetToggleDelta(ids, enabled);
  let result = await applyRulesetDelta(delta);
  if (result?.error === "stale_ruleset_revision") {
    updateRulesetStateFromResponse(result);
    result = await applyRulesetDelta(delta);
  }
  updateRulesetStateFromResponse(result);
  if (result?.error) {
    throw new Error(formatRulesetApplyError(result));
  }
  if (Array.isArray(result?.enabledRulesets)) {
    renderCoreFilterStatus();
    return;
  }
  await refreshRulesets();
}

function normalizeConfigRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function updateRulesetStateFromResponse(result) {
  if (Array.isArray(result?.enabledRulesets)) {
    enabledRulesets = new Set(normalizeEnabledRulesets(result.enabledRulesets));
  }
  const revision = normalizeConfigRevision(result?.configRevision);
  if (revision !== null) {
    rulesetConfigRevision = revision;
  }
}

async function applyRulesetDelta(delta) {
  const request = {
    what: "applyRulesets",
    enableRulesetIds: delta.enableRulesets,
    disableRulesetIds: delta.disableRulesets,
  };
  if (rulesetConfigRevision !== null) {
    request.expectedRevision = rulesetConfigRevision;
  }
  return sendRuntimeMessageWithTimeout(request, { timeoutMs: 4000 });
}

async function refreshAllowlist() {
  if (!allowlistListEl || !allowlistEmptyEl) {
    return;
  }

  try {
    const details = await chrome.runtime.sendMessage({ what: "getFilteringModeDetails" });
    const noneHosts = Array.isArray(details?.none) ? details.none : [];
    const entries = noneHosts.filter((hn) => hn && hn !== "all-urls").sort();
    renderAllowlist(entries);
  } catch (error) {
    console.error("Failed to load allowlist", error);
    renderAllowlist([]);
  }
}

function renderAllowlist(entries = []) {
  if (!allowlistListEl || !allowlistEmptyEl) {
    return;
  }
  allowlistListEl.innerHTML = "";
  if (!entries.length) {
    allowlistEmptyEl.hidden = false;
    renderAllowlistMutationState();
    return;
  }
  allowlistEmptyEl.hidden = true;
  entries.forEach((hostname) => {
    const item = document.createElement("li");
    item.className = "allowlist-item";

    const hostLine = document.createElement("div");
    hostLine.className = "allowlist-host";
    hostLine.textContent = hostname;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "secondary-button small allowlist-remove";
    removeButton.textContent = t("uiRemove");
    removeButton.setAttribute("data-hostname", hostname);

    item.appendChild(hostLine);
    item.appendChild(removeButton);
    allowlistListEl.appendChild(item);
  });
  renderAllowlistMutationState();
}

function renderAllowlistMutationState() {
  const disabled = paywalled || pendingAllowlistMutations !== 0;
  if (allowlistInput) {
    allowlistInput.disabled = disabled;
  }
  if (allowlistAddButton) {
    allowlistAddButton.disabled = disabled;
  }
  if (allowlistListEl) {
    allowlistListEl.querySelectorAll(".allowlist-remove").forEach((button) => {
      button.disabled = disabled;
    });
  }
}

async function runAllowlistMutation(action) {
  pendingAllowlistMutations += 1;
  renderAllowlistMutationState();
  try {
    return await allowlistMutationQueue.enqueue(action);
  } finally {
    pendingAllowlistMutations -= 1;
    renderAllowlistMutationState();
  }
}

async function handleAllowlistSubmit(event) {
  event.preventDefault();
  if (!allowlistInput) {
    return;
  }
  const hostname = normalizeHostname(allowlistInput.value);
  if (!hostname) {
    return;
  }
  await runAllowlistMutation(async () => {
    try {
      await chrome.runtime.sendMessage({
        what: "setFilteringMode",
        hostname,
        level: MODE_NONE
      });
      allowlistInput.value = "";
      await refreshAllowlist();
    } catch (error) {
      console.error("Failed to add allowlisted site", error);
    }
  });
}

async function handleAllowlistRemove(hostname, button) {
  if (!hostname) {
    return;
  }
  await runAllowlistMutation(async () => {
    if (button) {
      button.textContent = t("uiRemoving");
    }
    try {
      const defaultMode = await chrome.runtime.sendMessage({ what: "getDefaultFilteringMode" });
      await chrome.runtime.sendMessage({
        what: "setFilteringMode",
        hostname,
        level: Number(defaultMode)
      });
      await refreshAllowlist();
    } catch (error) {
      console.error("Failed to remove allowlisted site", error);
    } finally {
      if (button) {
        button.textContent = t("uiRemove");
      }
    }
  });
}

function normalizeHostname(value) {
  if (!value) {
    return null;
  }
  let candidate = value.trim();
  if (!candidate) {
    return null;
  }
  if (!candidate.includes("://")) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    let hostname = url.hostname.toLowerCase();
    hostname = hostname.replace(/\.+$/, "");
    if (hostname.startsWith("www.")) {
      hostname = hostname.slice(4);
    }
    return hostname || null;
  } catch (_error) {
    return null;
  }
}
