import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

function extractHost(item) {
    if (!item) return '';
    const trimmed = String(item).trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed);
            return String(parsed.host || '').trim();
        } catch (e) {
            return trimmed;
        }
    }
    return trimmed;
}

function isWorkHours(settings) {
    const now = new Date();
    const workDaysOnly = settings.get_boolean('work-days-only');
    if (workDaysOnly) {
        let scheduleType = 'sun-fri';
        try {
            scheduleType = settings.get_string('work-days-type') || 'sun-fri';
        } catch (e) {
            scheduleType = 'sun-fri';
        }
        const day = now.getDay(); // 0 is Sunday, 1 is Monday, ..., 6 is Saturday
        let isWorkDay = true;
        switch (scheduleType) {
            case 'sun-fri':
                // Sunday (0) to Friday (5), Saturday (6) off
                isWorkDay = (day !== 6);
                break;
            case 'mon-fri':
                // Monday (1) to Friday (5), Saturday (6) & Sunday (0) off
                isWorkDay = (day >= 1 && day <= 5);
                break;
            case 'sun-thu':
                // Sunday (0) to Thursday (4), Friday (5) & Saturday (6) off
                isWorkDay = (day >= 0 && day <= 4);
                break;
            case 'mon-sat':
                // Monday (1) to Saturday (6), Sunday (0) off
                isWorkDay = (day >= 1 && day <= 6);
                break;
            case 'all':
            default:
                isWorkDay = true;
                break;
        }
        if (!isWorkDay) {
            return false;
        }
    }
    const start = settings.get_int('work-hours-start');
    const end = settings.get_int('work-hours-end');
    const hour = now.getHours();

    if (start === end) {
        return true;
    }
    if (start < end) {
        return hour >= start && hour < end;
    } else {
        // Overnight wrap-around
        return hour >= start || hour < end;
    }
}

const ServerIndicator = GObject.registerClass(
class ServerIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Servers Alive Monitor'));

        this._extension = extension;
        this._settings = extension.getSettings();
        this._timeoutId = null;
        this._cancellables = [];
        this._serverStatuses = new Map(); // server host -> { alive: boolean|null, latency: string, offHours?: boolean }

        // Auto-clean any legacy JSON strings in servers-list
        try {
            const rawServers = this._settings.get_strv('servers-list');
            let needsMigration = false;
            const cleanServers = [];
            const workHoursServers = new Set(this._settings.get_strv('work-hours-servers'));

            for (const item of rawServers) {
                const trimmed = String(item).trim();
                if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    needsMigration = true;
                    try {
                        const parsed = JSON.parse(trimmed);
                        const h = String(parsed.host || '').trim();
                        if (h) {
                            cleanServers.push(h);
                            if (parsed.workHoursOnly) {
                                workHoursServers.add(h);
                            }
                        }
                    } catch (e) {
                        cleanServers.push(trimmed);
                    }
                } else if (trimmed) {
                    cleanServers.push(trimmed);
                }
            }

            if (needsMigration) {
                this._settings.set_strv('servers-list', cleanServers);
                this._settings.set_strv('work-hours-servers', Array.from(workHoursServers));
            }
        } catch (err) {
            console.error('Migration error in ServersAliveExtension:', err);
        }

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkMonitorChangedId = this._networkMonitor.connect('network-changed', (monitor, available) => {
            if (available) {
                this._restartCheckTimer();
                this._checkAllServers();
            } else {
                this._cancelPendingChecks();
                this._updatePanelIcon(null);
                this._refreshMenuServerList();
            }
        });

        // Main panel icon
        this._icon = new St.Icon({
            icon_name: 'network-server-symbolic',
            style_class: 'system-status-icon servers-alive-icon-checking',
        });
        this.add_child(this._icon);

        this._buildMenu();

        // Listen for settings changes
        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (
                key === 'servers-list' ||
                key === 'work-hours-servers' ||
                key === 'check-interval' ||
                key === 'ping-timeout' ||
                key === 'work-hours-start' ||
                key === 'work-hours-end' ||
                key === 'work-days-only' ||
                key === 'work-days-type'
            ) {
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
        if (this._isDestroyed || !this._serversSection) return;
        this._serversSection.removeAll();
        const rawServers = this._settings.get_strv('servers-list');
        const servers = rawServers.map(extractHost).filter(s => s.length > 0);
        const workHoursSet = new Set(this._settings.get_strv('work-hours-servers'));

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
        // 4. Off Hours servers (rank 3)
        const sortedServers = [...servers].sort((a, b) => {
            const statusA = this._serverStatuses.get(a);
            const statusB = this._serverStatuses.get(b);

            const getRank = status => {
                if (status && status.offHours) return 3; // Off Hours
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

        sortedServers.forEach(serverHost => {
            const status = this._serverStatuses.get(serverHost);
            const isWorkHoursOnly = workHoursSet.has(serverHost);
            const labelText = isWorkHoursOnly ? `${serverHost} (Office)` : serverHost;
            const item = new PopupMenu.PopupMenuItem(labelText, {
                reactive: false,
                can_focus: false,
            });

            const statusLabel = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
            });

            if (!this._networkMonitor.network_available) {
                statusLabel.text = _('Waiting for network...');
                statusLabel.style_class = 'server-status-badge-checking';
            } else if (status && status.offHours) {
                statusLabel.text = _('⏸ Off Hours');
                statusLabel.style_class = 'server-status-badge-off-hours';
            } else if (!status || status.alive === null) {
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
            if (this._networkMonitor.network_available) {
                this._checkAllServers();
            }
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
        if (this._isDestroyed) return;
        const rawServers = this._settings.get_strv('servers-list');
        const servers = rawServers.map(extractHost).filter(s => s.length > 0);
        const workHoursSet = new Set(this._settings.get_strv('work-hours-servers'));
        const timeout = Math.max(1, this._settings.get_int('ping-timeout'));
        const inWorkHours = isWorkHours(this._settings);

        // Clean up statuses of removed servers
        const serverHostSet = new Set(servers);
        for (const key of this._serverStatuses.keys()) {
            if (!serverHostSet.has(key)) {
                this._serverStatuses.delete(key);
            }
        }

        if (servers.length === 0) {
            this._updatePanelIcon(true);
            this._refreshMenuServerList();
            return;
        }

        // If network is not available yet (e.g. right after boot/login), do not ping or report failure
        if (!this._networkMonitor.network_available) {
            this._cancelPendingChecks();
            this._updatePanelIcon(null);
            this._refreshMenuServerList();
            return;
        }

        this._cancelPendingChecks();

        const pingPromises = servers.map(async serverHost => {
            if (this._isDestroyed) return {alive: null, latency: '', latencyMs: Infinity};
            const isWorkHoursOnly = workHoursSet.has(serverHost);
            if (isWorkHoursOnly && !inWorkHours) {
                const offHoursResult = {
                    alive: null,
                    offHours: true,
                    latency: _('Off Hours'),
                    latencyMs: Infinity,
                };
                this._serverStatuses.set(serverHost, offHoursResult);
                return offHoursResult;
            }

            const result = await this._pingServer(serverHost, timeout);
            if (this._isDestroyed || !this._networkMonitor.network_available) {
                return {alive: null, latency: 'Waiting for network...', latencyMs: Infinity};
            }
            this._serverStatuses.set(serverHost, result);
            return result;
        });

        const results = await Promise.all(pingPromises);

        if (this._isDestroyed) return;

        if (!this._networkMonitor.network_available) {
            this._updatePanelIcon(null);
            this._refreshMenuServerList();
            return;
        }

        const activeResults = results.filter(r => !r.offHours);

        if (activeResults.length === 0) {
            this._updatePanelIcon('off-hours');
        } else {
            const allAlive = activeResults.every(r => r.alive);
            this._updatePanelIcon(allAlive);
        }
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

    _updatePanelIcon(status) {
        if (this._isDestroyed || !this._icon) return;
        this._icon.remove_style_class_name('servers-alive-icon-checking');
        this._icon.remove_style_class_name('servers-alive-icon-ok');
        this._icon.remove_style_class_name('servers-alive-icon-error');
        this._icon.remove_style_class_name('servers-alive-icon-off-hours');

        if (status === true) {
            this._icon.add_style_class_name('servers-alive-icon-ok');
        } else if (status === false) {
            this._icon.add_style_class_name('servers-alive-icon-error');
        } else if (status === 'off-hours') {
            this._icon.add_style_class_name('servers-alive-icon-off-hours');
        } else {
            this._icon.add_style_class_name('servers-alive-icon-checking');
        }
    }

    destroy() {
        this._isDestroyed = true;
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._networkMonitorChangedId) {
            this._networkMonitor.disconnect(this._networkMonitorChangedId);
            this._networkMonitorChangedId = null;
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
