'use strict';
// Renders build/icon.png (1024x1024) from an inline SVG with headless Chromium.
const { chromium } = require('playwright');
const path = require('path');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#efe7d6" stroke="#c6b797" stroke-width="10"/>
  <clipPath id="c"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
  <rect x="100" y="790" width="824" height="16" fill="#8d2a2a" clip-path="url(#c)"/>
  <rect x="210" y="290" width="604" height="400" rx="34" fill="#f5eee0" stroke="#29261f" stroke-width="22"/>
  <rect x="270" y="322" width="484" height="76" rx="10" fill="#ebe2cf" stroke="#c6b797" stroke-width="8"/>
  <circle cx="380" cy="510" r="82" fill="#efe7d6" stroke="#2c8a79" stroke-width="26"/>
  <circle cx="644" cy="510" r="82" fill="#efe7d6" stroke="#2c8a79" stroke-width="26"/>
  <circle cx="380" cy="510" r="24" fill="#8d2a2a"/>
  <circle cx="644" cy="510" r="24" fill="#8d2a2a"/>
  <path d="M462 510 H562" stroke="#29261f" stroke-width="14"/>
  <path d="M520 490 L562 510 L520 530" fill="none" stroke="#29261f" stroke-width="14" stroke-linejoin="round"/>
  <path d="M330 690 L370 610 H654 L694 690" fill="none" stroke="#29261f" stroke-width="18" stroke-linejoin="round"/>
  ${Array.from({ length: 20 }, (_, i) => `<rect x="${284 + i * 23}" y="${352 - Math.round(Math.abs(Math.sin(i * 0.9)) * 16)}" width="12" height="${16 + Math.round(Math.abs(Math.sin(i * 0.9)) * 32)}" fill="${i < 13 ? '#2c8a79' : '#bdb4a2'}"/>`).join('')}
</svg>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.screenshot({ path: path.join(__dirname, '..', 'build', 'icon.png'), omitBackground: true });
  await browser.close();
})();
