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

        servers.forEach(server => {
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

        if (servers.length === 0) {
            this._updatePanelIcon(true);
            this._refreshMenuServerList();
            return;
        }

        this._cancelPendingChecks();

        const pingPromises = servers.map(server => this._pingServer(server, timeout));
        const results = await Promise.all(pingPromises);

        let allAlive = true;
        servers.forEach((server, i) => {
            const result = results[i];
            this._serverStatuses.set(server, result);
            if (!result.alive) {
                allAlive = false;
            }
        });

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
                resolve({alive: false, latency: 'ERR'});
                return;
            }

            proc.communicate_utf8_async(null, cancellable, (proc, res) => {
                try {
                    const [ok, stdout, stderr] = proc.communicate_utf8_finish(res);
                    const exitCode = proc.get_exit_status();
                    if (exitCode === 0) {
                        // Extract time (e.g. time=12.3 ms or time=0.4 ms)
                        let latency = 'OK';
                        const match = stdout ? stdout.match(/time=([0-9.]+)\s*ms/) : null;
                        if (match && match[1]) {
                            latency = `${match[1]} ms`;
                        }
                        resolve({alive: true, latency});
                    } else {
                        resolve({alive: false, latency: 'Timeout/Error'});
                    }
                } catch (err) {
                    resolve({alive: false, latency: 'Error'});
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
