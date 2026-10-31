# Gemini Edit

A small VS Code + Chrome extension that brings selected-code editing to the **Gemini website**. Use your normal signed-in Gemini account. No API key, agent harness, third-party npm packages, build step, or separate server process.

Select code → **Cmd+K / Ctrl+K** → describe a change and press **Enter** → the prompt is inserted and sent in Gemini → choose its replacement code → review and accept the diff in VS Code.

You can also ask directly in Gemini. The Chrome panel detects its latest code reply without requiring a VS Code prompt.

## Install

Requires desktop VS Code 1.85+, Chrome 116+, and a Gemini account. Start with a local workspace. Node 20+ is needed only for repository scripts and packaging; VS Code supplies the extension runtime.

Download the VS Code `.vsix` and Chrome `.zip` from the [latest GitHub release](https://github.com/moikdev/gemini-edit/releases/latest), or build them from source below.

### 1. VS Code

Build the installable extensions:

```sh
npm run package
```

No `npm install` is needed. In VS Code, run **Extensions: Install from VSIX…** and choose `dist/gemini-edit-0.1.3.vsix`, then reload if prompted.

For development, open this repository in VS Code and press **F5**, using the **Run Gemini Edit** launch configuration. Open a source file in the Extension Development Host window.

### 2. Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this repository’s `extensions/chrome` folder. Alternatively, unzip `dist/gemini-edit-chrome-0.1.3.zip` and select the extracted folder.
3. Pin Gemini Edit to the toolbar, then click it to open the side panel.
4. In VS Code, run **Gemini Edit: Copy Chrome Pairing Code** from the Command Palette.
5. Paste the code in the Chrome side panel and click **Connect to VS Code**. Keep this code private; it authenticates access to captured context and proposal submission.
6. Click **Open Gemini**, sign in normally, and choose that tab in the side panel. If Chrome asks for local network access, allow it so the extension can reach VS Code on your computer.

Keep the side panel open during an edit. Its connection runs in the visible panel, so it does not depend on Chrome keeping a background service worker alive.

### Refresh recovery (Chrome 0.1.1)

If you loaded `extensions/chrome` directly, click **Reload** on Gemini Edit’s card at `chrome://extensions` to pick up updates, then reopen its side panel and refresh Gemini. If you installed from a ZIP, replace the files in the original unpacked folder with the latest ZIP’s contents, then click **Reload**. Reusing the folder preserves the extension ID and saved pairing. The refresh-only 0.1.1 update did not require a VS Code upgrade; the browser-import feature in 0.1.2 requires updating both components.

Page messages now have a four-second timeout. A transient tab lookup failure no longer stops the local connection, missing page adapters are reattached after load, and a refreshing tab stays selected even if Chrome temporarily omits it from its tab query. Reloading also clears cached replacement code; replies arriving from the previous document are ignored.

A sent request reconnects from its marker in the restored chat history. Refreshing can erase an **unsent** website draft: click **Restore prompt** to put it back, then send it explicitly. The extension does not automatically resend after a refresh or retry an interrupted Send action. If the request was already sent, let its original chat history finish loading instead of restoring another copy.

## Use

1. Highlight one code selection in VS Code. With no selection, the edit inserts at the captured cursor.
2. Press **Cmd+K** on macOS or **Ctrl+K** elsewhere, type an instruction, and press **Enter**.
3. With the Chrome side panel open, Enter inserts the prompt into the selected Gemini tab and triggers Gemini’s **Send** button. If Gemini is already generating, the request waits until it finishes. Another draft is never overwritten or submitted.
4. **Insert prompt** remains a draft-only action. Use **Send in Gemini** or the website’s Send button when you deliberately want to submit a manually inserted draft.
5. Continue with follow-up questions in the same chat if needed. Wait for Gemini to finish.
6. Select the desired code block in the side panel and click **Review diff in VS Code**.
7. Review the diff. Use its check / close toolbar buttons, the **Accept / Reject** notification, or the **Gemini Edit: Accept Edit / Reject Edit** commands. Accept is undoable and does not save automatically.

**Prompts typed in Gemini:** Keep chatting in the website before or after accepting an edit. The panel keeps watching for the latest completed code response. After you accept, the next import replaces the updated range from the last accepted edit, including when its length changed. Each follow-up gets its own immutable diff and Undo step. Already-imported replies are not offered repeatedly. Finish or reject an open diff before importing a further follow-up.

**One Send per request:** VS Code records a Send claim before Chrome clicks the button. Polling, reopening the panel, and page refreshes do not repeat that click. If the connection drops after a click may have happened, the request is marked uncertain: check the Gemini conversation before making a new request. A known pre-click failure (such as a disabled Send button or changed draft) permits another explicit Send action. Pressing Enter requests sending; merely reopening a previously inserted draft does not.

**Chats started entirely in Gemini:** Code appears in the panel even without a VS Code request marker. Click **Review diff in VS Code**, then choose a file, selection, or cursor in VS Code’s target picker. This stages a diff; it does not apply code automatically. You can also capture a selection / cursor in advance with **Gemini Edit: Use Selection / Cursor for Next Gemini Import**. After accepting, later prompts in the same chat continue against that chosen target. To switch files or recover after manually editing the target, click **Choose a different target in VS Code** in the Chrome panel.

**Context:** 20 surrounding lines are included by default. Run **Gemini Edit: Add Selection / File to Context** to attach a selection, or the entire focused file when no text is selected. One attachment per file, up to five files. Attachments are snapshots and stay attached for later requests until replaced or cleared using **Gemini Edit: Clear Attached Context**. Context is read-only: only the captured target can be edited.

**Requests:** Click Gemini in the VS Code status bar or run **Gemini Edit: Show Requests** to inspect, re-open a diff, or cancel a waiting request. One Gemini conversation can handle a sequence of edits; avoid sending another captured request until you finish the current edit. Request markers keep responses and follow-ups associated with their original edit target.

**Shortcuts:** Cmd/Ctrl+K is editor-only. It takes priority over some VS Code K-prefixed chords. Change the binding in Keyboard Shortcuts by searching for `geminiEdit.edit` if you use those chords. The Command Palette and editor context menu also work.

## What it does

- Plain JavaScript in both extensions; plain HTML/CSS for the Chrome side panel.
- VS Code’s built-in editor APIs capture selections, display immutable before/after snapshots, and apply accepted edits.
- A Node `http` server runs **inside the VS Code extension**, bound to `127.0.0.1` only. No Express, WebSocket package, daemon, or globally installed CLI.
- The Chrome side panel uses `fetch` to poll the authenticated local bridge. A Manifest V3 content script fills Gemini’s visible composer and reads code blocks from its rendered responses.
- Model access uses the website’s normal UI. No API key, cookie extraction, private Gemini endpoints, hidden requests to its backend, or terminal execution.
- All npm scripts, including ZIP / VSIX packaging and tests, use Node built-ins. VS Code provides `require('vscode')`; it is not an npm dependency.

## Edit boundaries

Chrome can stage a replacement, but the bridge exposes **no endpoint that applies edits or accesses arbitrary files**. Every target is captured in VS Code. A document change after capture invalidates its pending request or proposal. A response for an old delivery, a different request, or a different tab is rejected. Code is displayed as text and never evaluated by the extension.

The bridge checks its Host header, extension origins, and a random bearer token. The token is stored in VS Code SecretStorage and locally in the Chrome extension’s storage, never in the Gemini page. Code context is sent to Gemini when you press Enter in the VS Code prompt or submit its draft manually; Gemini account data settings apply. There is no project telemetry or additional remote backend.

## Limits and troubleshooting

- **Experimental Gemini adapter:** Gemini does not provide this extension a stable DOM contract. Composer / Send / response selectors are isolated in `extensions/chrome/gemini-adapter.js`. They have fixture coverage, but the current signed-in Gemini UI must still be tried manually. Localized Send / Stop button labels may need an adapter update; the website’s own Send button always remains available.
- **No response found:** Choose the correct Gemini tab and wait for its latest answer to finish. The panel follows prompts typed directly in Gemini, including after an accepted edit. A request marker is needed only to automatically reuse the original VS Code target; chats without one can choose a target when importing.
- **No code blocks:** Ask Gemini for the complete replacement in one fenced code block. The extension deliberately does not guess which prose or partial snippet should overwrite your selection.
- **Document changed:** Capture a fresh request with Cmd/Ctrl+K, or choose a new target from the Chrome panel. The extension refuses to reuse a stale target, including after Undo or manual edits elsewhere in the file.
- **Existing Gemini draft:** Send or clear it, then click **Insert prompt**. An automatically attempted insertion is not retried endlessly.
- **Multiple Gemini tabs:** Choose one explicitly. A delivered response stays tied to its delivery tab even if you later change the tab selector.
- **Disconnected:** Keep the VS Code window and Chrome side panel open. Each VS Code window has its own bridge; copy its pairing code to switch workspaces. Preferred port is 17373, with the next nine ports tried if needed. If its port changes after restart, pair again.
- **Size limits:** 256 KiB per combined prompt or replacement, 64 KiB per context attachment, 2 MiB active-file snapshot, 10 active requests, and 20 retained request snapshots. Requests and proposals live in memory and reset when the VS Code extension restarts.
- **Scope:** Text edits to one captured selection or cursor. Multi-file patches, creating files, shell commands, image responses, project indexing, remote-browser setups, and autonomous task loops are outside this first version.

## Development and validation

```sh
npm run check          # JavaScript syntax, JSON manifests, zero-dependency rule
npm test               # Real local HTTP bridge, edit model, protocol, ZIP integrity
npm run test:browser   # Gemini DOM fixture in installed headless Chrome
npm run test:vscode    # Isolated VS Code Extension Development Host smoke test
npm run package        # Reproducible VSIX + Chrome ZIP using Node only
```

Set `CHROME_PATH` if Chrome is installed in a different location. Set `VSCODE_PATH` if the VS Code `code` CLI is not on PATH. The browser test uses a temporary Chrome profile; the VS Code test uses isolated user / extension directories and temporary source files. No account, network model call, npm download, or paid service is needed by tests.

The browser tests exercise a Gemini-shaped fixture, not Google’s live signed-in application. They include Enter-triggered sending, busy-page queuing, delayed Send-button readiness, draft preservation, and duplicate prevention after reloads or lost acknowledgements. The VS Code smoke test exercises capture → authenticated delivery → immutable diff → accept → undo, rejection, stale-document refusal, attached context, insertion at the cursor, browser-only imports, and follow-ups that replace the updated accepted range.

This is an unofficial project and is not affiliated with Google. The MIT license covers this code; it does not grant permission to use third-party services beyond their own terms.
