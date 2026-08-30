# Servers Alive GNOME Shell Extension

A lightweight, modern GNOME Shell extension (compatible with GNOME 45+) that continuously monitors server availability via ICMP `ping` and provides real-time status directly in the GNOME top panel.

---

## ✨ Features

- **Panel Status Icon**:
  - 🟢 **Green**: All active monitored servers are reachable and healthy.
  - 🔴 **Red**: One or more active servers are unreachable / down.
  - 🟡 **Yellow**: Checking server statuses or waiting for network connectivity.
  - ⚪ **Grey**: All monitored servers are currently outside office hours.

- **Interactive Dropdown Menu**:
  - **Live Server List**: Shows response times / ping latency (in milliseconds) for each server.
  - **Smart Priority Sorting**: Down/error servers appear first at the top, followed by checking servers, active OK servers (sorted by latency ascending), and off-hours servers.
  - **Office Hours Tagging**: Servers configured for office hours are clearly labeled (`(Office)`).
  - **Check Now**: Manually trigger an immediate ping check for all servers without waiting for the timer.
  - **Settings Shortcut**: Quick one-click button to open the extension preferences.

- **Office / Working Hours Scheduling**:
  - Configure specific servers to only be monitored during working hours (prevents false down-alerts for office-only infrastructure).
  - Customizable **Start Hour** and **End Hour** (24-hour format).
  - Customizable **Working Days Schedule** options:
    - **Sunday – Friday** (Off: Saturday) *(Default)*
    - **Monday – Friday** (Off: Saturday, Sunday)
    - **Sunday – Thursday** (Off: Friday, Saturday)
    - **Monday – Saturday** (Off: Sunday)
    - **Every Day** (Monday – Sunday)

- **Configurable Ping & Timing Settings**:
  - Custom check intervals (default: 30 seconds).
  - Custom ping timeouts (default: 2 seconds).

---

## 🚀 Installation

### 1. Compile GSettings Schemas
```bash
glib-compile-schemas schemas/
```

### 2. Install Extension Files
Clone or copy the directory to your local GNOME Shell extensions folder:
```bash
mkdir -p ~/.local/share/gnome-shell/extensions/servers-alive@custom.extension
cp -r metadata.json extension.js prefs.js stylesheet.css schemas ~/.local/share/gnome-shell/extensions/servers-alive@custom.extension/
```

### 3. Enable the Extension
```bash
gnome-extensions enable servers-alive@custom.extension
```

> **Note**: On Wayland, log out and log back in to reload GNOME Shell. On X11, you can restart GNOME Shell by pressing `Alt + F2`, typing `r`, and pressing `Enter`.

---

## ⚙️ Configuration

Open the preferences window via GNOME Extensions app (`gnome-extensions-app`) or by selecting **Settings** from the panel dropdown menu.

- **Monitored Servers**:
  - Enter a hostname or IP address (e.g. `8.8.8.8` or `server.example.com`).
  - Toggle **Office Hours Only** before or after adding a server.
- **Office / Working Hours**:
  - Toggle **Work Days Only** on or off.
  - Select your desired **Working Days Schedule** preset.
  - Set **Start Hour** and **End Hour** in 24h format.
- **Ping Settings**:
  - Adjust the **Check Interval** and **Ping Timeout**.
