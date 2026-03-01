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

const MODE_NONE = 0;

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

const CORE_RULESETS = [
  {
    checkbox: document.getElementById("filterEasyList"),
    statusEl: document.getElementById("filterEasyListStatus"),
    rulesets: ["ublock-filters", "easylist"],
    label: "Ads"
  },
  {
    checkbox: document.getElementById("filterEasyPrivacy"),
    statusEl: document.getElementById("filterEasyPrivacyStatus"),
    rulesets: ["easyprivacy"],
    label: "Privacy"
  },
  {
    checkbox: document.getElementById("filterFanboyAnnoyance"),
    statusEl: document.getElementById("filterFanboyAnnoyanceStatus"),
    rulesets: ["annoyances-overlays"],
    label: "Pop-ups"
  },
  {
    checkbox: document.getElementById("filterSecurity"),
    statusEl: document.getElementById("filterSecurityStatus"),
    rulesets: ["ublock-badware", "urlhaus-full"],
    label: "Security"
  }
];

let enabledRulesets = new Set();
let entitlementStatus = null;
let paywalled = false;
let licenseEntryVisible = false;
let licenseKeyRevealed = false;
let storedLicenseKey = "";

init().catch((error) => console.error("Options init failed", error));

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
  await refreshEntitlement();
  setPaywalledUI(paywalled);
  if (paywalled) {
    return;
  }
  wireCoreFilters();
  wireAllowlist();
  await refreshRulesets();
  await refreshAllowlist();
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

async function refreshEntitlement() {
  try {
    entitlementStatus = await chrome.runtime.sendMessage({ what: "getEntitlementStatus" });
  } catch (_error) {
    entitlementStatus = { status: "expired" };
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
      try {
        await chrome.runtime.sendMessage({ what: "replaceDevice" });
      } catch (error) {
        console.error("Device replace failed", error);
      }
      useThisDeviceButton.disabled = false;
      await refreshEntitlement();
      setPaywalledUI(paywalled);
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
    try {
      await chrome.runtime.sendMessage({ what: "clearLicenseKey" });
    } catch (error) {
      console.error("Failed to clear license", error);
    }
    if (licenseKeyEl) {
      licenseKeyEl.value = "";
    }
    await refreshEntitlement();
    setPaywalledUI(paywalled);
    if (licenseStatusEl) {
      licenseStatusEl.textContent = t("licenseStatusRemoved");
    }
  });
}

async function activateLicense() {
  setLicenseEntryVisible(true);
  const key = (licenseKeyEl?.value || "").trim();
  if (!key) {
    if (licenseStatusEl) {
      licenseStatusEl.textContent = t("licenseStatusEnterKey");
    }
    return;
  }

  if (licenseStatusEl) {
    licenseStatusEl.textContent = t("licenseStatusActivating");
  }

  try {
    await chrome.runtime.sendMessage({ what: "setLicenseKey", licenseKey: key });
  } catch (error) {
    console.error("Activation failed", error);
    if (licenseStatusEl) {
      licenseStatusEl.textContent = t("licenseStatusActivationFailed");
    }
    return;
  }

  await refreshEntitlement();
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
    } else {
      licenseStatusEl.textContent =
        entitlementStatus?.licenseKeyPresent
          ? t("licenseStatusVerifyLater")
          : t("licenseStatusActivationRequired");
    }
  }
}

function wireCoreFilters() {
  CORE_RULESETS.forEach((entry) => {
    if (!entry.checkbox) return;
    entry.checkbox.addEventListener("change", async (event) => {
      const enabled = Boolean(event.target.checked);
      entry.checkbox.disabled = true;
      try {
        await setRulesetsEnabled(entry.rulesets, enabled);
        await refreshRulesets();
      } catch (error) {
        console.error(`Failed to toggle ${entry.label}`, error);
        entry.checkbox.checked = !enabled;
      } finally {
        entry.checkbox.disabled = false;
      }
    });
  });
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
  try {
    const enabled = await chrome.runtime.sendMessage({ what: "getEnabledRulesets" });
    enabledRulesets = new Set(enabled || []);
  } catch (error) {
    console.error("Failed to load ruleset state", error);
    enabledRulesets = new Set();
  }
  renderCoreFilterStatus();
}

function renderCoreFilterStatus() {
  CORE_RULESETS.forEach((entry) => {
    if (!entry.checkbox) return;
    const active = entry.rulesets.every((id) => enabledRulesets.has(id));
    entry.checkbox.checked = active;
    if (entry.statusEl) {
      entry.statusEl.textContent = active ? t("uiActive") : t("uiDisabled");
      entry.statusEl.className = `toggle-status ${active ? "ok" : "muted"}`;
    }
  });
}

async function setRulesetsEnabled(ids, enabled) {
  const current = await chrome.runtime.sendMessage({ what: "getEnabledRulesets" });
  const next = new Set(current || []);
  ids.forEach((id) => {
    if (enabled) next.add(id);
    else next.delete(id);
  });
  await chrome.runtime.sendMessage({
    what: "applyRulesets",
    enabledRulesets: Array.from(next)
  });
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
  if (allowlistAddButton) {
    allowlistAddButton.disabled = true;
  }
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
  } finally {
    if (allowlistAddButton) {
      allowlistAddButton.disabled = false;
    }
  }
}

async function handleAllowlistRemove(hostname, button) {
  if (!hostname) {
    return;
  }
  if (button) {
    button.disabled = true;
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
      button.disabled = false;
      button.textContent = t("uiRemove");
    }
  }
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
