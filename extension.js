import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const ServerIndicator = GObject.registerClass(
class ServerIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Servers Alive Monitor'));

        this._extension = extension;
        this._settings = extension.getSettings();
        this._timeoutId = null;
        this._cancellables = [];
        this._serverStatuses = new Map(); // server -> { alive: boolean|null, latency: string }

        // Main panel icon
        this._icon = new St.Icon({
            icon_name: 'network-server-symbolic',
            style_class: 'system-status-icon servers-alive-icon-checking',
        });
        this.add_child(this._icon);

        this._buildMenu();

        // Listen for settings changes
        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'servers-list' || key === 'check-interval' || key === 'ping-timeout') {
                this._restartCheckTimer();
                this._checkAllServers();
            }
        });

        this._startCheckTimer();
        this._checkAllServers();
    }

    _buildMenu() {
        this.menu.removeAll();

        // Header info
        const headerItem = new PopupMenu.PopupMenuItem(_('Monitored Servers'), {
            reactive: false,
            can_focus: false,
        });
        headerItem.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(headerItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Container section for dynamic server items
        this._serversSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._serversSection);

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._refreshMenuServerList();
            }
        });

        this._refreshMenuServerList();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // "Check Now" button
        const checkNowItem = new PopupMenu.PopupMenuItem(_('Check Now'));
        checkNowItem.connect('activate', () => {
            this._checkAllServers();
        });
        this.menu.addMenuItem(checkNowItem);

        // "Settings" button
        const settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
        settingsItem.connect('activate', () => {
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    _refreshMenuServerList() {
        this._serversSection.removeAll();
        const servers = this._settings.get_strv('servers-list');

        if (servers.length === 0) {
            const noServerItem = new PopupMenu.PopupMenuItem(_('No servers configured'), {
                reactive: false,
                can_focus: false,
            });
            this._serversSection.addMenuItem(noServerItem);
            return;
        }

        // Sort order:
        // 1. Down/Error servers first (rank 0)
        // 2. Checking/Pending servers (rank 1)
        // 3. OK servers sorted by Latency/Response time ascending (rank 2)
        const sortedServers = [...servers].sort((a, b) => {
            const statusA = this._serverStatuses.get(a);
            const statusB = this._serverStatuses.get(b);

            const getRank = status => {
                if (status && status.alive === false) return 0; // Down/Error
                if (!status || status.alive === null) return 1; // Checking/Unknown
                return 2; // OK
            };

            const rankA = getRank(statusA);
            const rankB = getRank(statusB);

            if (rankA !== rankB) {
                return rankA - rankB;
            }

            // If both are OK (rank 2), order by latency ascending (fastest first)
            if (rankA === 2) {
                const latA = (typeof statusA?.latencyMs === 'number' && !isNaN(statusA.latencyMs)) ? statusA.latencyMs : Infinity;
                const latB = (typeof statusB?.latencyMs === 'number' && !isNaN(statusB.latencyMs)) ? statusB.latencyMs : Infinity;
                if (latA !== latB) {
                    return latA - latB;
                }
            }

            // Fallback tie-breaker: alphabetical order
            return a.localeCompare(b);
        });

        sortedServers.forEach(server => {
            const status = this._serverStatuses.get(server);
            const item = new PopupMenu.PopupMenuItem(server, {
                reactive: false,
                can_focus: false,
            });

            const statusLabel = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
            });

            if (!status || status.alive === null) {
                statusLabel.text = _('Checking...');
                statusLabel.style_class = 'server-status-badge-checking';
            } else if (status.alive) {
                statusLabel.text = `✔ OK (${status.latency})`;
                statusLabel.style_class = 'server-status-badge-ok';
            } else {
                statusLabel.text = _('✖ DOWN');
                statusLabel.style_class = 'server-status-badge-error';
            }

            item.add_child(statusLabel);
            this._serversSection.addMenuItem(item);
        });
    }

    _startCheckTimer() {
        const interval = Math.max(5, this._settings.get_int('check-interval'));
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._checkAllServers();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _restartCheckTimer() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._startCheckTimer();
    }

    _cancelPendingChecks() {
        for (const cancellable of this._cancellables) {
            cancellable.cancel();
        }
        this._cancellables = [];
    }

    async _checkAllServers() {
        const servers = this._settings.get_strv('servers-list');
        const timeout = Math.max(1, this._settings.get_int('ping-timeout'));

        // Clean up statuses of removed servers
        const serverSet = new Set(servers);
        for (const key of this._serverStatuses.keys()) {
            if (!serverSet.has(key)) {
                this._serverStatuses.delete(key);
            }
        }

        if (servers.length === 0) {
            this._updatePanelIcon(true);
            this._refreshMenuServerList();
            return;
        }

        this._cancelPendingChecks();

        const pingPromises = servers.map(async server => {
            const result = await this._pingServer(server, timeout);
            this._serverStatuses.set(server, result);
            this._refreshMenuServerList();
            return result;
        });

        const results = await Promise.all(pingPromises);
        const allAlive = results.every(r => r.alive);

        this._updatePanelIcon(allAlive);
        this._refreshMenuServerList();
    }

    _pingServer(host, timeoutSec) {
        return new Promise(resolve => {
            const cancellable = new Gio.Cancellable();
            this._cancellables.push(cancellable);

            // Run ping -c 1 -W <timeout> <host>
            const proc = new Gio.Subprocess({
                argv: ['ping', '-c', '1', `-W`, `${timeoutSec}`, host],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });

            try {
                proc.init(cancellable);
            } catch (e) {
                resolve({alive: false, latency: 'ERR', latencyMs: Infinity});
                return;
            }

            proc.communicate_utf8_async(null, cancellable, (proc, res) => {
                try {
                    const [ok, stdout, stderr] = proc.communicate_utf8_finish(res);
                    const exitCode = proc.get_exit_status();
                    if (exitCode === 0) {
                        let latency = 'OK';
                        let latencyMs = 0;
                        const matchTime = stdout ? stdout.match(/time=([0-9.]+)\s*ms/i) : null;
                        const matchRtt = stdout ? stdout.match(/rtt min\/avg\/max\/mdev = [0-9.]+\/([0-9.]+)/i) : null;

                        if (matchTime && matchTime[1]) {
                            latencyMs = parseFloat(matchTime[1]);
                            latency = `${latencyMs} ms`;
                        } else if (matchRtt && matchRtt[1]) {
                            latencyMs = parseFloat(matchRtt[1]);
                            latency = `${latencyMs} ms`;
                        }

                        resolve({alive: true, latency, latencyMs});
                    } else {
                        resolve({alive: false, latency: 'Timeout/Error', latencyMs: Infinity});
                    }
                } catch (err) {
                    resolve({alive: false, latency: 'Error', latencyMs: Infinity});
                }
            });
        });
    }

    _updatePanelIcon(allAlive) {
        this._icon.remove_style_class_name('servers-alive-icon-checking');
        this._icon.remove_style_class_name('servers-alive-icon-ok');
        this._icon.remove_style_class_name('servers-alive-icon-error');

        if (allAlive) {
            this._icon.add_style_class_name('servers-alive-icon-ok');
        } else {
            this._icon.add_style_class_name('servers-alive-icon-error');
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._cancelPendingChecks();
        super.destroy();
    }
});

export default class ServersAliveExtension extends Extension {
    enable() {
        this._indicator = new ServerIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
