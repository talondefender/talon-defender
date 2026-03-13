const DEFAULT_REPOSITORY_URL = "https://github.com/talondefender/talon-defender";

const normalizeRepositoryUrl = (value) => {
  if (typeof value !== "string") {
    return DEFAULT_REPOSITORY_URL;
  }
  let out = value.trim();
  if (out === "") {
    return DEFAULT_REPOSITORY_URL;
  }
  out = out.replace(/^git\+/, "");
  out = out.replace(/\.git$/i, "");
  return out;
};

const getManifestVersion = () => {
  try {
    const version = chrome?.runtime?.getManifest?.()?.version;
    return typeof version === "string" ? version.trim() : "";
  } catch {
    return "";
  }
};

const fallbackInfo = () => {
  const version = getManifestVersion();
  const sourceRef = version ? `v${version}` : "";
  const repositoryUrl = DEFAULT_REPOSITORY_URL;
  const sourceCodeUrl = sourceRef
    ? `${repositoryUrl}/tree/${sourceRef}`
    : repositoryUrl;
  const sourceTarballUrl = sourceRef
    ? `${repositoryUrl}/archive/refs/tags/${sourceRef}.tar.gz`
    : "";

  return {
    version,
    sourceRef,
    repositoryUrl,
    sourceCodeUrl,
    sourceTarballUrl,
  };
};

const isHttpsUrl = (value) => {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const mergeWithFallback = (candidate) => {
  const fallback = fallbackInfo();
  if (candidate instanceof Object === false) {
    return fallback;
  }

  const version = typeof candidate.version === "string" && candidate.version.trim() !== ""
    ? candidate.version.trim()
    : fallback.version;
  const sourceRef = typeof candidate.sourceRef === "string" && candidate.sourceRef.trim() !== ""
    ? candidate.sourceRef.trim()
    : (version ? `v${version}` : fallback.sourceRef);
  const repositoryUrl = isHttpsUrl(candidate.repositoryUrl)
    ? normalizeRepositoryUrl(candidate.repositoryUrl)
    : fallback.repositoryUrl;
  const sourceCodeUrl = isHttpsUrl(candidate.sourceCodeUrl)
    ? candidate.sourceCodeUrl
    : (sourceRef ? `${repositoryUrl}/tree/${sourceRef}` : fallback.sourceCodeUrl);
  const sourceTarballUrl = isHttpsUrl(candidate.sourceTarballUrl)
    ? candidate.sourceTarballUrl
    : (sourceRef ? `${repositoryUrl}/archive/refs/tags/${sourceRef}.tar.gz` : fallback.sourceTarballUrl);

  return {
    version,
    sourceRef,
    repositoryUrl,
    sourceCodeUrl,
    sourceTarballUrl,
  };
};

export async function readSourceCodeInfo() {
  const fallback = fallbackInfo();

  try {
    const url = chrome?.runtime?.getURL?.("source-code.json");
    if (typeof url !== "string" || url === "") {
      return fallback;
    }
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return fallback;
    }
    const payload = await response.json();
    return mergeWithFallback(payload);
  } catch {
    return fallback;
  }
}
