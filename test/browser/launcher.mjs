import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

export async function launchBrowser() {
  let executablePath = process.env.NEEDLE_BROWSER_EXECUTABLE || chromium.executablePath();
  // Reuse an installed Chromium when this Playwright version's download is absent.
  if (!existsSync(executablePath) && !process.env.NEEDLE_BROWSER_EXECUTABLE) {
    const match = executablePath.match(/^(.*)[/\\]chromium-\d+([/\\].*)$/);
    if (match) {
      const revisions = (await readdir(match[1]).catch(() => []))
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
      const installed = revisions
        .map((revision) => join(match[1], revision) + match[2])
        .find(existsSync);
      if (installed) executablePath = installed;
    }
  }
  return chromium.launch({ headless: true, executablePath });
}
