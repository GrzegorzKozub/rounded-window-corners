// imports.gi
import GObject from 'gi://GObject';

// Local Modules
import {AppRow} from '../../preferences/widgets/app_row.js';
import {connections} from '../../utils/connections.js';
import {TIPS_EMPTY, show_err_msg} from '../../utils/prefs.js';
import {settings} from '../../utils/settings.js';

// types
import type {AppRowHandler} from '../widgets/app_row.js';

import Gtk from 'gi://Gtk';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {uri} from '../../utils/io.js';

// --------------------------------------------------------------- [end imports]

/** Black list Preferences Page */
export const BlackList = GObject.registerClass(
    {
        Template: uri(import.meta.url, 'blacklist.ui'),
        GTypeName: 'RoundedWindowCornersPrefsBlacklist',
        InternalChildren: ['black_list_group', 'add_row_btn'],
    },
    class extends Gtk.Box {
        private declare _black_list_group: Gtk.ListBox;
        private declare _add_row_btn: Gtk.Button;

        /** Store value of settings */
        private declare black_list: string[];

        _init() {
            super._init();
            this.black_list = settings().black_list;

            // Read blacklist from settings, and add it to this._black_list
            for (const name of this.black_list) {
                this.on_add_row(name);
            }

            connections.get().connect(this._add_row_btn, 'clicked', () => {
                if (this.black_list.includes('')) {
                    return;
                }

                this.on_add_row();
                this.black_list.push('');
                settings().black_list = this.black_list;
            });

            connections
                .get()
                .connect(
                    this._black_list_group,
                    'row-activated',
                    (_me: Gtk.ListBox, row: Gtk.ListBoxRow) => {
                        if (row instanceof AppRow) {
                            row.on_expanded_changed();
                        }
                    },
                );
        }

        private show_err_msg(item: string) {
            const title = `${item}: ${_(
                "Can't add to list, because it has exists",
            )}`;
            show_err_msg(title);
        }

        // --------------------------------------------------- [signal handlers]

        private on_delete_row(row: Gtk.ListBoxRow, title: string) {
            this.black_list.splice(this.black_list.indexOf(title), 1);
            settings().black_list = this.black_list;
            this._black_list_group.remove(row);
        }

        /** Add a row to black list */
        private on_add_row(title = '') {
            const handlers: AppRowHandler = {
                on_delete: (row, title) => this.on_delete_row(row, title),
                on_title_changed: (old_title, new_title) =>
                    this.on_title_changed(old_title, new_title),
            };

            const row = new AppRow(handlers);
            row.title = title;

            if (!title) {
                row.description = TIPS_EMPTY();
            }

            this._black_list_group.append(row);
        }

        /** Called when title of item need to changed  */
        on_title_changed(old_title: string, new_title: string): boolean {
            if (this.black_list.includes(new_title)) {
                this.show_err_msg(new_title);
                return false;
            }

            const old_idx = this.black_list.indexOf(old_title);
            this.black_list.splice(old_idx, 1, new_title);

            settings().black_list = this.black_list;

            return true;
        }
    },
);
