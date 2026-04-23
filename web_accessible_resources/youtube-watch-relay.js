(() => {
  function normalizeYouTubeWatchUrl(value) {
    if (typeof value !== 'string' || value === '') { return ''; }
    let url;
    try {
      url = new URL(value);
    } catch {
      return '';
    }
    if (url.origin !== 'https://www.youtube.com') { return ''; }
    if (url.pathname !== '/watch') { return ''; }
    if ((url.searchParams.get('v') || '').trim() === '') { return ''; }
    const normalized = new URL('https://www.youtube.com/watch');
    for (const [key, entryValue] of Array.from(url.searchParams.entries()).sort((a, b) => {
      return a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]);
    })) {
      normalized.searchParams.append(String(key), String(entryValue));
    }
    normalized.hash = '';
    return normalized.toString();
  }

  function resolveTargetUrl() {
    const params = new URLSearchParams(self.location.search);
    return normalizeYouTubeWatchUrl(params.get('target') || '');
  }

  const targetUrl = resolveTargetUrl();
  if (targetUrl === '') {
    self.document.title = 'Talon YouTube Relay Error';
    self.document.body.textContent = 'Invalid YouTube relay target.';
    return;
  }

  self.location.replace(targetUrl);
})();
