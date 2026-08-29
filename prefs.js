import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ServersAlivePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'network-server-symbolic',
        });
        window.add(page);

        // Server list group
        const serversGroup = new Adw.PreferencesGroup({
            title: _('Monitored Servers'),
            description: _('Add or remove server hostnames or IP addresses to monitor.'),
        });
        page.add(serversGroup);

        // Add server entry row
        const addRow = new Adw.EntryRow({
            title: _('Add Server / Hostname / IP'),
            show_apply_button: true,
        });

        serversGroup.add(addRow);

        const listGroup = new Adw.PreferencesGroup({
            title: _('Current Servers'),
        });
        page.add(listGroup);

        const rebuildServerRows = () => {
            const children = [];
            // In GTK4 / Libadwaita PreferencesGroup
            // We clear and rebuild the rows in listGroup
            // Note: Adw.PreferencesGroup doesn't have remove_all in all versions, we keep track of added rows
            if (listGroup._rows) {
                for (const r of listGroup._rows) {
                    listGroup.remove(r);
                }
            }
            listGroup._rows = [];

            const servers = settings.get_strv('servers-list');
            if (servers.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: _('No servers added yet'),
                });
                listGroup.add(emptyRow);
                listGroup._rows.push(emptyRow);
                return;
            }

            servers.forEach((server, index) => {
                const row = new Adw.ActionRow({
                    title: server,
                });

                const deleteButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    has_frame: false,
                    tooltip_text: _('Remove server'),
                });

                deleteButton.connect('clicked', () => {
                    const current = settings.get_strv('servers-list');
                    current.splice(index, 1);
                    settings.set_strv('servers-list', current);
                    rebuildServerRows();
                });

                row.add_suffix(deleteButton);
                listGroup.add(row);
                listGroup._rows.push(row);
            });
        };

        addRow.connect('apply', (entry) => {
            const text = entry.text.trim();
            if (text.length > 0) {
                const current = settings.get_strv('servers-list');
                if (!current.includes(text)) {
                    current.push(text);
                    settings.set_strv('servers-list', current);
                    rebuildServerRows();
                }
                entry.text = '';
            }
        });

        rebuildServerRows();

        // Timing / Configuration group
        const timingGroup = new Adw.PreferencesGroup({
            title: _('Check Settings'),
        });
        page.add(timingGroup);

        // Check interval
        const intervalRow = new Adw.SpinRow({
            title: _('Check Interval (seconds)'),
            subtitle: _('How often to ping servers'),
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 3600,
                step_increment: 5,
                page_increment: 30,
                value: settings.get_int('check-interval'),
            }),
        });
        settings.bind('check-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        timingGroup.add(intervalRow);

        // Ping timeout
        const timeoutRow = new Adw.SpinRow({
            title: _('Ping Timeout (seconds)'),
            subtitle: _('Max duration waiting for response per server'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 10,
                step_increment: 1,
                page_increment: 2,
                value: settings.get_int('ping-timeout'),
            }),
        });
        settings.bind('ping-timeout', timeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        timingGroup.add(timeoutRow);
    }
}
