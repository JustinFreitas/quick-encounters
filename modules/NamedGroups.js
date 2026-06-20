import {QuickEncounter, QE} from './QuickEncounter.js';

/*
NamedGroups.js  (Stage B / v14.1.0)

Reusable named token groupings ("The Party", "Town Guard", ...) that can be
dropped into ANY scene without a Map Note and (by default) without starting
combat.

Storage: a single world-scoped setting `namedGroups` holding an array of:
    { id, groupName, extractedActors:[...], runAsGrouping:true, createdAt }

`extractedActors` is the exact shape used everywhere else in the module
(numActors, actorID, dataPackName, name, addToCombatTracker). We deliberately
do NOT persist savedTokensData: a named group is meant to be portable across
scenes, so tokens regenerate from each actor's prototype at drop time rather
than pinning scene-specific coordinates.

Placement reuses the existing run() path: a transient QuickEncounter is built
from the stored data and run with { isInstantEncounter:true, qeAnchor, runAsGrouping }.
*/

export const NAMED_GROUPS_SETTING = "namedGroups";

//Drag data `type` used when dragging a group row from the picker onto the canvas (B2).
export const NAMED_GROUP_DRAG_TYPE = "quick-encounters.namedGroup";

export class NamedGroups {

    static registerSetting() {
        game.settings.register(QE.MODULE_NAME, NAMED_GROUPS_SETTING, {
            scope: "world",
            config: false,          //managed through our own picker UI, not the Settings menu
            type: Array,
            default: []
        });
    }

    //B2: register the canvas-drop hook so a group dragged from the picker is placed at the exact
    //drop point. Foundry's canvas #onDrop parses our drag data, converts the cursor to scene
    //coordinates (data.x/data.y), then calls this hook; returning false suppresses default handling.
    static registerHooks() {
        Hooks.on("dropCanvasData", (canvas, data) => {
            if (data?.type !== NAMED_GROUP_DRAG_TYPE) {return;}      //not ours - let Foundry handle it
            if (!game.user?.isGM || !data.id) {return false;}
            //data.x/data.y are already in scene coordinates at the cursor
            NamedGroups.placeGroup(data.id, {anchor: {x: Math.round(data.x), y: Math.round(data.y)}});
            return false;   //we handled it
        });
    }

    /* -------------------------------------------- */
    /*  CRUD                                                                                          */
    /* -------------------------------------------- */

    static getGroups() {
        //Always return a fresh array so callers can't mutate the stored reference
        const groups = game.settings.get(QE.MODULE_NAME, NAMED_GROUPS_SETTING) ?? [];
        return Array.isArray(groups) ? foundry.utils.duplicate(groups) : [];
    }

    static getGroup(id) {
        return NamedGroups.getGroups().find(g => g.id === id) ?? null;
    }

    static async #writeGroups(groups) {
        return game.settings.set(QE.MODULE_NAME, NAMED_GROUPS_SETTING, groups);
    }

    //Snapshot a QuickEncounter's actors into a new (or renamed/overwritten) named group.
    //Returns the saved group, or null if there's nothing worth saving.
    static async saveGroupFromQE(groupName, quickEncounter) {
        const name = (groupName ?? "").trim();
        if (!name) {
            ui.notifications.warn(game.i18n.localize("QE.NamedGroups.NameRequired.WARN"));
            return null;
        }
        const extractedActors = (quickEncounter?.extractedActors ?? [])
            //Only actors carry into a portable group (tiles/rolltables are scene/table-bound)
            .filter(ea => ea?.actorID)
            .map(ea => ({
                numActors: ea.numActors,
                actorID: ea.actorID,
                dataPackName: ea.dataPackName ?? null,
                name: ea.name,
                addToCombatTracker: ea.addToCombatTracker ?? true
            }));
        if (!extractedActors.length) {
            ui.notifications.warn(game.i18n.localize("QE.NamedGroups.NoActors.WARN"));
            return null;
        }

        const groups = NamedGroups.getGroups();
        //Overwrite by (case-insensitive) name if it already exists, else append
        const existingIndex = groups.findIndex(g => g.groupName.toLowerCase() === name.toLowerCase());
        const group = {
            id: existingIndex >= 0 ? groups[existingIndex].id : foundry.utils.randomID(),
            groupName: name,
            extractedActors,
            runAsGrouping: true,
            createdAt: existingIndex >= 0 ? groups[existingIndex].createdAt : Date.now()
        };
        if (existingIndex >= 0) {groups[existingIndex] = group;} else {groups.push(group);}

        await NamedGroups.#writeGroups(groups);
        ui.notifications.info(game.i18n.format("QE.NamedGroups.Saved.INFO", {groupName: name}));
        return group;
    }

    static async deleteGroup(id) {
        const groups = NamedGroups.getGroups().filter(g => g.id !== id);
        await NamedGroups.#writeGroups(groups);
    }

    /* -------------------------------------------- */
    /*  Placement                                                                                     */
    /* -------------------------------------------- */

    //Build a transient (note-less) QuickEncounter from a stored group and drop it on the
    //current scene at `anchor` (defaults to the centre of the viewport). Reuses the existing
    //instant-encounter + grouping run() path, so no new placement/combat code is needed.
    static async placeGroup(id, {anchor = null, event = null} = {}) {
        const group = NamedGroups.getGroup(id);
        if (!group) {
            ui.notifications.warn(game.i18n.localize("QE.NamedGroups.NotFound.WARN"));
            return;
        }
        if (!canvas?.scene) {
            ui.notifications.warn(game.i18n.localize("QE.NamedGroups.NoScene.WARN"));
            return;
        }

        const qeAnchor = anchor ?? NamedGroups.#viewCenter();

        const quickEncounter = new QuickEncounter();
        //Deep-copy so the run (which mutates extractedActors with generated tokens) can't
        //corrupt the stored definition.
        quickEncounter.extractedActors = foundry.utils.duplicate(group.extractedActors);
        //journalEntry is required by run(); a transient placeholder is enough because the
        //instant-encounter path never reads back from a Map Note.
        quickEncounter.journalEntry = {clickedNote: null};

        await quickEncounter.run(event, {
            isInstantEncounter: true,
            qeAnchor,
            runAsGrouping: group.runAsGrouping ?? true,
            forceVisible: true
        });
    }

    /* -------------------------------------------- */
    /*  Picker UI                                                                                     */
    /* -------------------------------------------- */

    //Open a dialog listing saved groups, each with Place / Delete. GM-only.
    static async openPicker() {
        if (!game.user?.isGM) {return;}
        const DialogV2 = foundry.applications?.api?.DialogV2;
        if (!DialogV2) {
            ui.notifications.error("Quick Encounters: DialogV2 unavailable (requires Foundry v13+).");
            return;
        }

        const groups = NamedGroups.getGroups()
            .sort((a, b) => a.groupName.localeCompare(b.groupName));

        const content = await foundry.applications.handlebars.renderTemplate(
            "modules/quick-encounters/templates/named-groups-picker.html",
            {
                groups: groups.map(g => ({
                    id: g.id,
                    groupName: g.groupName,
                    count: g.extractedActors?.length ?? 0
                })),
                hasGroups: groups.length > 0
            }
        );

        //Use DialogV2.wait() (not new DialogV2().render()) because only wait() wires up the
        //`render` option, which is where we attach the per-row Place/Delete listeners.
        await DialogV2.wait({
            window: {title: game.i18n.localize("QE.NamedGroups.Picker.TITLE")},
            content,
            buttons: [{action: "close", label: game.i18n.localize("QE.NamedGroups.Picker.CLOSE"), default: true}],
            rejectClose: false,
            render: (event, dlg) => {
                const root = dlg.element;
                //B2: make each row draggable onto the canvas (drop handled by the dropCanvasData hook)
                root.querySelectorAll('[data-qe-draggable="group"]').forEach(row => {
                    row.addEventListener("dragstart", (ev) => {
                        const id = ev.currentTarget.dataset.groupId;
                        ev.dataTransfer.setData("text/plain", JSON.stringify({type: NAMED_GROUP_DRAG_TYPE, id}));
                        ev.dataTransfer.effectAllowed = "copy";
                    });
                });
                root.querySelectorAll('[data-qe-action="place"]').forEach(btn => {
                    btn.addEventListener("click", async (ev) => {
                        ev.preventDefault();
                        const id = ev.currentTarget.dataset.groupId;
                        await NamedGroups.placeGroup(id, {event: ev});
                        dlg.close();
                    });
                });
                root.querySelectorAll('[data-qe-action="delete"]').forEach(btn => {
                    btn.addEventListener("click", async (ev) => {
                        ev.preventDefault();
                        const id = ev.currentTarget.dataset.groupId;
                        const group = NamedGroups.getGroup(id);
                        const confirmed = await DialogV2.confirm({
                            window: {title: game.i18n.localize("QE.NamedGroups.Picker.TITLE")},
                            content: `<p>${game.i18n.format("QE.NamedGroups.ConfirmDelete.PROMPT", {groupName: group?.groupName ?? ""})}</p>`
                        });
                        if (confirmed) {
                            await NamedGroups.deleteGroup(id);
                            dlg.close();
                            NamedGroups.openPicker();    //reopen with the updated list
                        }
                    });
                });
            }
        });
    }

    static #viewCenter() {
        //Centre of the current canvas viewport in scene coordinates
        const dim = canvas?.dimensions;
        const t = canvas?.stage?.position;
        const scale = canvas?.stage?.scale?.x || 1;
        if (t && dim) {
            return {
                x: Math.round((window.innerWidth / 2 - t.x) / scale),
                y: Math.round((window.innerHeight / 2 - t.y) / scale)
            };
        }
        //Fallback: centre of the scene
        return {x: Math.round((dim?.width ?? 0) / 2), y: Math.round((dim?.height ?? 0) / 2)};
    }
}
