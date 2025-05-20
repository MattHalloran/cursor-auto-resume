# CursorAutoHelper

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)  
![Version](https://img.shields.io/badge/Version-5.2-green.svg)

An in-page helper for Cursor IDE that automates three common disruptions—rate-limit resume, connection retries, and idle cycling—so you can focus on coding uninterrupted.

## What It Does

- **Auto-click Resume**  
  Detects the “resume the conversation” link after the 25-tool-call limit and clicks it on your behalf (3 s cooldown).

- **Auto-retry on Connection Failure**  
  Watches for “Connection failed.” banners or retry icons, clicks “Try again” (or the retry icon), and uses exponential back-off (1 s → … → 5 min) between attempts.

- **Idle Detection & Tab-Cycling**  
  1. After 10 s of no user activity, shows “No activity – waiting 60 s before cycling tabs.”  
  2. At 30 s before cycling, warns “Cycling tabs in XX s” and briefly outlines the tab list.  
  3. After sufficient idle time, cycles through selecting each chat tab. This allows the auto-resume and auto-retry to be applied to all chats

- **Element Preview Before Click**  
  Any automatic click is preceded by a 1 s preview outline (magenta border) so you can see what’s being activated.

- **Public API**  
  ```ts
  window.CursorAutoHelper.start(silent?: boolean)
  window.CursorAutoHelper.stop(silent?: boolean)
  window.CursorAutoHelper.showToast(message: string, durationMs?: number)
  window.CursorAutoHelper.setDebug(on: boolean)
  window.CursorAutoHelper.clearAllIntervals()
