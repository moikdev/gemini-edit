# Project instructions

- Keep both extensions and all repository scripts free of third-party runtime and development dependencies. Use JavaScript, platform APIs, and Node built-ins.
- After an extension update, run the relevant checks, build its package, and install or reload the updated local extension for the user. The user explicitly prefers this over being given manual reinstall instructions.
- For Chrome, identify the currently loaded unpacked folder in the extension manager, back it up, update it in place, and reload it. Preserve the extension ID and saved pairing. Verify the displayed version and that the panel reconnects.
- For VS Code changes, install the resulting VSIX using the local `code` CLI and verify the installed version. Avoid reinstalling unchanged components.
- Report installation as complete only after verification. If an OS or application restriction prevents it, explain the specific blocker.
