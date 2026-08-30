import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

export default class ServersAlivePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Migrate any legacy JSON objects in servers-list to plain hostnames and work-hours-servers
        try {
            const rawServers = settings.get_strv('servers-list');
            let needsMigration = false;
            const cleanServers = [];
            const workHoursServers = new Set(settings.get_strv('work-hours-servers'));

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
                settings.set_strv('servers-list', cleanServers);
                settings.set_strv('work-hours-servers', Array.from(workHoursServers));
            }
        } catch (err) {
            console.error('Migration error in ServersAlivePreferences:', err);
        }

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

        // Toggle for office hours on new server
        const addWorkHoursRow = new Adw.SwitchRow({
            title: _('Office Hours Only'),
            subtitle: _('Check new server only during working hours'),
            active: false,
        });
        serversGroup.add(addWorkHoursRow);

        const listGroup = new Adw.PreferencesGroup({
            title: _('Current Servers'),
        });
        page.add(listGroup);

        const rebuildServerRows = () => {
            if (listGroup._rows) {
                for (const r of listGroup._rows) {
                    listGroup.remove(r);
                }
            }
            listGroup._rows = [];

            const rawServers = settings.get_strv('servers-list');
            const servers = rawServers.map(extractHost).filter(s => s.length > 0);
            const workHoursSet = new Set(settings.get_strv('work-hours-servers'));

            if (servers.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: _('No servers added yet'),
                });
                listGroup.add(emptyRow);
                listGroup._rows.push(emptyRow);
                return;
            }

            servers.forEach((serverHost, index) => {
                const isWorkHoursOnly = workHoursSet.has(serverHost);

                const row = new Adw.ActionRow({
                    title: serverHost,
                    subtitle: isWorkHoursOnly
                        ? _('Checked during office hours only')
                        : _('Checked 24/7 (Always)'),
                });

                const suffixBox = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 12,
                    valign: Gtk.Align.CENTER,
                });

                const checkBtn = new Gtk.CheckButton({
                    label: _('Office hours only'),
                    active: isWorkHoursOnly,
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Toggle checking only during office hours'),
                });

                checkBtn.connect('toggled', (btn) => {
                    const currentWorkHours = new Set(settings.get_strv('work-hours-servers'));
                    if (btn.get_active()) {
                        currentWorkHours.add(serverHost);
                    } else {
                        currentWorkHours.delete(serverHost);
                    }
                    settings.set_strv('work-hours-servers', Array.from(currentWorkHours));
                    row.subtitle = btn.get_active()
                        ? _('Checked during office hours only')
                        : _('Checked 24/7 (Always)');
                });

                const deleteButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    has_frame: false,
                    tooltip_text: _('Remove server'),
                });

                deleteButton.connect('clicked', () => {
                    const currentServers = settings.get_strv('servers-list').map(extractHost);
                    currentServers.splice(index, 1);
                    settings.set_strv('servers-list', currentServers);

                    const currentWorkHours = new Set(settings.get_strv('work-hours-servers'));
                    currentWorkHours.delete(serverHost);
                    settings.set_strv('work-hours-servers', Array.from(currentWorkHours));

                    rebuildServerRows();
                });

                suffixBox.append(checkBtn);
                suffixBox.append(deleteButton);

                row.add_suffix(suffixBox);
                listGroup.add(row);
                listGroup._rows.push(row);
            });
        };

        addRow.connect('apply', (entry) => {
            const text = entry.text.trim();
            if (text.length > 0) {
                const currentServers = settings.get_strv('servers-list').map(extractHost);
                if (!currentServers.includes(text)) {
                    currentServers.push(text);
                    settings.set_strv('servers-list', currentServers);

                    if (addWorkHoursRow.get_active()) {
                        const currentWorkHours = new Set(settings.get_strv('work-hours-servers'));
                        currentWorkHours.add(text);
                        settings.set_strv('work-hours-servers', Array.from(currentWorkHours));
                    }
                    rebuildServerRows();
                }
                entry.text = '';
                addWorkHoursRow.set_active(false);
            }
        });

        rebuildServerRows();

        // Office / Working Hours Settings group
        const workHoursGroup = new Adw.PreferencesGroup({
            title: _('Office / Working Hours'),
            description: _('Configure working hours for servers marked "Office hours only".'),
        });
        page.add(workHoursGroup);

        // Work days only toggle
        const workDaysRow = new Adw.SwitchRow({
            title: _('Work Days Only'),
            subtitle: _('Limit office hours checks to configured working days'),
        });
        settings.bind('work-days-only', workDaysRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        workHoursGroup.add(workDaysRow);

        // Schedule type selection
        const scheduleKeys = ['sun-fri', 'mon-fri', 'sun-thu', 'mon-sat', 'all'];
        const scheduleLabels = [
            _('Sunday – Friday (Off: Saturday)'),
            _('Monday – Friday (Off: Sat, Sun)'),
            _('Sunday – Thursday (Off: Fri, Sat)'),
            _('Monday – Saturday (Off: Sunday)'),
            _('Every Day (Mon – Sun)'),
        ];

        const model = new Gtk.StringList();
        scheduleLabels.forEach(label => model.append(label));

        let currentSchedule = 'sun-fri';
        try {
            currentSchedule = settings.get_string('work-days-type') || 'sun-fri';
        } catch (e) {
            currentSchedule = 'sun-fri';
        }

        let initialIndex = scheduleKeys.indexOf(currentSchedule);
        if (initialIndex === -1) {
            initialIndex = 0;
        }

        const scheduleRow = new Adw.ComboRow({
            title: _('Working Days Schedule'),
            subtitle: _('Select which days of the week are work days'),
            model: model,
            selected: initialIndex,
        });

        scheduleRow.connect('notify::selected', () => {
            const selectedIdx = scheduleRow.selected;
            if (selectedIdx >= 0 && selectedIdx < scheduleKeys.length) {
                settings.set_string('work-days-type', scheduleKeys[selectedIdx]);
            }
        });

        settings.bind('work-days-only', scheduleRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        workHoursGroup.add(scheduleRow);

        // Work hours start (0-23)
        const startHourRow = new Adw.SpinRow({
            title: _('Start Hour'),
            subtitle: _('Office start time (0-23, 24-hour format)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 23,
                step_increment: 1,
                page_increment: 1,
                value: settings.get_int('work-hours-start'),
            }),
        });
        settings.bind('work-hours-start', startHourRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        workHoursGroup.add(startHourRow);

        // Work hours end (0-23)
        const endHourRow = new Adw.SpinRow({
            title: _('End Hour'),
            subtitle: _('Office end time (0-23, 24-hour format)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 23,
                step_increment: 1,
                page_increment: 1,
                value: settings.get_int('work-hours-end'),
            }),
        });
        settings.bind('work-hours-end', endHourRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        workHoursGroup.add(endHourRow);

        // Timing / Ping configuration group
        const timingGroup = new Adw.PreferencesGroup({
            title: _('Ping Settings'),
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
