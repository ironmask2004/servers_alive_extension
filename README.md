# Servers Alive GNOME Shell Extension

A modern GNOME Shell extension (compatible with GNOME 45+) that monitors a list of servers via ICMP `ping`:
- **Green Icon**: All configured servers are alive and responding.
- **Red Icon**: One or more servers are down / unreachable.
- **Drop-down Menu**: Shows live status and ping latency for each individual server, a "Check Now" button, and quick access to Settings.
- **Preferences (Settings)**: Add/remove servers, configure check interval (seconds) and ping timeout.

## Installation

1. Compile schemas:
   ```bash
   glib-compile-schemas schemas/
   ```

2. Copy files to your GNOME extensions directory:
   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions/servers-alive@custom.extension
   cp -r metadata.json extension.js prefs.js stylesheet.css schemas ~/.local/share/gnome-shell/extensions/servers-alive@custom.extension/
   ```

3. Enable the extension:
   ```bash
   gnome-extensions enable servers-alive@custom.extension
   ```
   *(On Wayland, log out and log back in if newly installed, or restart GNOME Shell with `Alt+F2` -> `r` on X11).*
