"""
screenshot.py — Playwright-based website screenshots for Discord embeds.

Usage:
    from bot.screenshot import capture
    file = await capture('dashboard')   # returns discord.File or None
"""
import io
import asyncio
import logging

import discord

import bot.config as config

log = logging.getLogger(__name__)

# Section → URL hash mapping (matches app.js nav targets)
_SECTIONS = {
    'dashboard':  '',
    'standings':  '#standings',
    'schedule':   '#schedule',
    'draft':      '#draft',
    'teams':      '#teams',
    'trades':     '#trades',
}

# Selector to wait for before snapping (proves the section rendered)
_WAIT_FOR = {
    'dashboard':  '.dashboard-grid',
    'standings':  '.standings-table, .conf-block',
    'schedule':   '.schedule-week',
    'draft':      '.draft-board',
    'teams':      '.team-card',
    'trades':     '.trade-card, .empty-state',
}


async def capture(section: str = 'dashboard', width: int = 1280, height: int = 720) -> discord.File | None:
    """
    Screenshot the given app section and return a discord.File.
    Returns None if Playwright is unavailable or the server is unreachable.
    """
    try:
        from playwright.async_api import async_playwright, TimeoutError as PWTimeout
    except ImportError:
        log.warning('Playwright not installed — skipping screenshot. Run: pip install playwright && playwright install chromium')
        return None

    hash_  = _SECTIONS.get(section, '')
    url    = f'{config.APP_URL}/{hash_}'
    wait   = _WAIT_FOR.get(section)

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True)
            page    = await browser.new_page(viewport={'width': width, 'height': height})

            # Navigate and wait for network idle so fonts/CSS load
            await page.goto(url, wait_until='networkidle', timeout=15_000)

            # If the app uses hash-based routing, click the right nav button
            if hash_:
                # Try clicking the nav link that matches the section
                nav_sel = f'[data-section="{section}"], [onclick*="{section}"], nav button'
                try:
                    await page.click(f'[data-section="{section}"]', timeout=3_000)
                except Exception:
                    pass  # hash may have been enough

            # Wait for the section content
            if wait:
                try:
                    await page.wait_for_selector(wait, timeout=8_000)
                except PWTimeout:
                    pass  # take screenshot anyway

            # Small pause for any CSS transitions
            await asyncio.sleep(0.4)

            png_bytes = await page.screenshot(full_page=False)
            await browser.close()

        buf = io.BytesIO(png_bytes)
        buf.seek(0)
        return discord.File(buf, filename=f'{section}.png')

    except Exception as exc:
        log.warning('Screenshot failed for %s: %s', section, exc)
        return None
