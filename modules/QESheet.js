import {QuickEncounter, dieRollReg, QE} from './QuickEncounter.js';
import {NamedGroups} from './NamedGroups.js';

/*
Reused as EncounterCompanionSheet
15-Oct-2020     Re-created
...(history trimmed; see git log)...
17-Jun-2024     12.1.0b: In v12, convert mergeObject to foundry.util.mergeObject
14-Jun-2026     14.0.7: Migrated to ApplicationV2 (HandlebarsApplicationMixin) for Foundry v14. The popup
                wraps a plain QuickEncounter object (not a Document), so it extends ApplicationV2 directly.
                v10-v13 FormApplication support for this companion popup is dropped (v14-only).
*/

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class QESheet extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(quickEncounter, options = {}) {
        super(options);             //ApplicationV2 takes only options; custom keys (title, qeJournalEntry, isFromCompendium) are preserved on this.options
        this.object = quickEncounter;
        if (!game.user.isGM || !quickEncounter) {return;}
        game.users.apps.push(this);
    }

    /** @override - the title (Journal Entry/Page name) is passed in via options */
    get title() {
        return this.options?.title ?? game.i18n.localize("QE.QuickEncounterDialog.Run.BUTTON");
    }

    //Reuse the same instance for re-renders (the journal handler caches us and calls update())
    update(quickEncounter) {
        if (quickEncounter) this.object = quickEncounter;
    }

    static DEFAULT_OPTIONS = {
        //{id} is auto-uniquified per instance so multiple QE journals can each have their own popup
        id: "quick-encounters-qesheet-{id}",
        tag: "form",
        classes: ["quick-encounters", "qe-sheet"],
        window: {
            title: "QE.QuickEncounterDialog.Run.BUTTON"
        },
        position: {
            width: 530,
            height: "auto"
        },
        form: {
            handler: QESheet.#onSubmitForm,
            submitOnChange: false,
            closeOnSubmit: false
        },
        actions: {
            addToCombatTracker: QESheet.#onRun,
            runAsGrouping: QESheet.#onRunAsGrouping,
            saveNamedGroup: QESheet.#onSaveNamedGroup,
            addTokensTiles: QESheet.#onAddTokensTiles,
            removeActor: QESheet.#onRemoveActor,
            removeTile: QESheet.#onRemoveTile,
            removeRollTable: QESheet.#onRemoveRollTable
        }
    };

    static PARTS = {
        body: { template: "modules/quick-encounters/templates/qe-sheet.html" }
    };

    /** @override - replaces getData() */
    async _prepareContext(options) {
        //v0.6.10: Because the qeDialog is not (now) being re-created each time, recompute combatants here
        await this.computeCombatantsForDisplay();
        return {
            combatants: this.combatants,
            tilesData: this.object?.savedTilesData,
            rollTables: this.object?.rollTables,
            totalXPLine: this.totalXPLine,
            isFromCompendium: this.object?.isFromCompendium,
            //0.9.3 Setting to show this checkbox (checked by default)
            showAddToCombatTrackerCheckbox: game.settings.get(QE.MODULE_NAME, "showAddToCombatTrackerCheckbox")
        };
    }

    /* -------------------------------------------- */
    /*  Action handlers (data-action; this = instance)                                              */
    /* -------------------------------------------- */

    //"Run Quick Encounter": save any edits first, then run (place tokens + add to Combat Tracker)
    static async #onRun(event, target) {
        if (this.object?.isFromCompendium) {return;}
        await this.submit();
        await this.object?.run(event);
    }

    //"Run as Grouping": place the tokens without starting combat (friendly party / allied NPCs / mixed).
    //Token dispositions are untouched; this just skips Combat creation and initiative.
    static async #onRunAsGrouping(event, target) {
        if (this.object?.isFromCompendium) {return;}
        await this.submit();
        await this.object?.run(event, {runAsGrouping: true});
    }

    //"Save as Named Group": snapshot this encounter's actors into a reusable, scene-independent
    //named group (Stage B). Prompts for a name; overwrites an existing group of the same name.
    static async #onSaveNamedGroup(event, target) {
        if (this.object?.isFromCompendium) {return;}
        await this.submit();    //fold in any pending edits to counts/checkboxes first
        const DialogV2 = foundry.applications?.api?.DialogV2;
        const suggested = this.options?.title ?? "";
        const groupName = await DialogV2.prompt({
            window: {title: game.i18n.localize("QE.NamedGroups.Save.TITLE")},
            content: `<p>${game.i18n.localize("QE.NamedGroups.Save.PROMPT")}</p>`
                + `<input type="text" name="groupName" value="${foundry.utils.escapeHTML?.(suggested) ?? ""}" autofocus>`,
            ok: {
                label: game.i18n.localize("QE.NamedGroups.Save.OK"),
                callback: (ev, button) => button.form.elements.groupName.value
            }
        });
        if (groupName == null) {return;}    //cancelled
        await NamedGroups.saveGroupFromQE(groupName, this.object);
    }

    //"Add tokens/tiles": save edits then add the selected canvas tokens/tiles to this QE
    static async #onAddTokensTiles(event, target) {
        await this.submit();
        await QuickEncounter.runAddOrCreate(event, this.object);
    }

    static #onRemoveActor(event, target) {
        return this._removeActorRow(target);
    }
    static #onRemoveTile(event, target) {
        return this._removeTileRow(target);
    }
    static #onRemoveRollTable(event, target) {
        return this._removeRollTableRow(target);
    }

    /* -------------------------------------------- */
    /*  Row removal helpers                                                                          */
    /* -------------------------------------------- */

    _removeActorRow(target) {
        const rowNum = Number(target?.dataset?.row);
        if (Number.isInteger(rowNum) && (rowNum >= 0) && (rowNum < this.combatants.length)) {
            this.combatants.splice(rowNum, 1);
        }
        return this._onChange();
    }
    _removeTileRow(target) {
        const rowNum = Number(target?.dataset?.row);
        if (Number.isInteger(rowNum) && (rowNum >= 0) && (rowNum < (this.object?.savedTilesData?.length ?? 0))) {
            this.object.savedTilesData.splice(rowNum, 1);
        }
        return this._onChange();
    }
    _removeRollTableRow(target) {
        const rowNum = Number(target?.dataset?.row);
        if (Number.isInteger(rowNum) && (rowNum >= 0) && (rowNum < (this.object?.rollTables?.length ?? 0))) {
            this.object.rollTables.splice(rowNum, 1);
        }
        return this._onChange();
    }

    /* -------------------------------------------- */
    /*  Data prep (version-agnostic)                                                                */
    /* -------------------------------------------- */

    async computeCombatantsForDisplay() {
        //This version of the Quick Encounter is what is extracted from in the Journal Entry
        //1.2.3c: Change to await call because of effects of Roll() now having to be called async
        await this.object.generateTemplateExtractedActorTokenData();     //this is just sparse array with the correct numbers
        this.object.combineTokenData();

        let combatants = [];
        if (this.object.extractedActors) {
            for (const [i,eActor] of this.object.extractedActors.entries()) {
                const combatant = {
                    rowNum : i,
                    numActors : eActor.numActors,
                    actorName: eActor.name,             //default
                    actorId: eActor.actorID,
                    //0.9.3d Add addToCombatTracker to structure (defaults to true and may not be shown)
                    addToCombatTracker: eActor.addToCombatTracker ?? true,
                    dataPackName : eActor.dataPackName, //non-null if a Compendium entry
                    tokens: eActor.combinedTokensData,
                    numType : typeof eActor.numActors
                }

                if (eActor.dataPackName) {
                    //Compendium: for display just use the index (can only get name, id, index)
                    const pack = game.packs.get(eActor.dataPackName);
                    //0.8.0a: Block on getting the name and image information, fortunately from the index
                    const index = await pack.getIndex();
                    //1.1.0e: In Foundry v10 may need to strip off prepended Compendium name
                    const strippedActorId = (combatant.actorId).split(".").pop();
                    const entry = index.find(e => e._id === strippedActorId);
                    combatant.img = entry?.img || CONST.DEFAULT_TOKEN;
                    combatant.actorName = entry?.name;
                } else {      //regular actor
                    const actor = game.actors.get(eActor.actorID);
                    //0.4.1: 5e specific: find XP for this number of this actor
                    const xp = QuickEncounter.getActorXP(actor);
                    const xpString = xp ? `(${xp}XP each)`: "";
                    combatant.img = actor?.img;
                    combatant.actorName = actor?.name;
                    combatant.xp = xpString;
                }

                combatants.push(combatant);
            }
        }

        this.combatants = combatants;
        this.totalXPLine = this.object.renderTotalXPLine();
    }

    /* -------------------------------------------- */
    /*  Form submission                                                                             */
    /* -------------------------------------------- */

    /** @override - the form handler (replaces _updateObject) */
    static async #onSubmitForm(event, form, formData) {
        //ApplicationV2 gives a FormDataExtended; flatten back to the "rowNum.fieldName" keys the logic expects
        const flat = foundry.utils.flattenObject(foundry.utils.expandObject(formData.object));
        return this._applyFormData(flat);
    }

    //formData keyed "rowNum.fieldName" (numActors / numRollTableActors / addToCombatTracker)
    async _applyFormData(formData) {
        const checkIntReg = /^[0-9]*$/;
        let wasChanged = false;
        //0.9.3: Changed format of formData names to rowNum.fieldName
        for (let [rowFieldName, fieldValue] of Object.entries(formData)) {
            let fieldWasChanged = false;
            const elements = rowFieldName.split(".");
            if ((elements.length ?? 0) < 2) {continue;}   //ignore if the split doesn't work
            const rowNum = elements[0];
            const fieldName = elements[1];
            if (fieldName === "numRollTableActors") {//1.1.1 only used for RollTables
                const numActors = fieldValue.trim();   //trim off whitespace
                fieldWasChanged = (this.object?.rollTables[rowNum].numActors !== numActors);
                if (fieldWasChanged) {
                    //Validate that the change is ok
                    //Option 1: You cleared the field or spaced it out
                    if ((numActors === null) || (numActors === "")) {
                        this.object.rollTables[rowNum].numActors = 0;
                    } else if (Roll.validate(numActors)) {
                        //Option 2: This is a dice roll (not guaranteed because it could just contain a dieRoll)
                        this.object.rollTables[rowNum].numActors = numActors;
                    } else if (checkIntReg.test(numActors)) {
                        const multiplier = parseInt(numActors,10);
                        if (!Number.isNaN(multiplier)) {
                            this.object.rollTables[rowNum].numActors = multiplier;
                        }
                    } else {
                        //otherwise leave unchanged - should pop up a dialog or highlight the field in red
                        const warning = game.i18n.localize("QE.QuickEncounterDialog.InvalidNumActors.WARNING") + " " + numActors;
                        ui.notifications.warn(warning);
                    }
                }
            } else if (rowNum >= this.combatants.length) {
                //New combatant - not possible in the dialog yet, but will be with drag-and-drop
                fieldWasChanged = true;
            } else if (fieldName === "numActors") {//1.1.1 only used for Extracted Actors
                const numActors = fieldValue.trim();   //trim off whitespace
                fieldWasChanged = (this.combatants[rowNum].numActors !== numActors);
                if (fieldWasChanged) {
                    //Validate that the change is ok
                    //Option 1: You cleared the field or spaced it out
                    if ((numActors === null) || (numActors === "")) {
                        this.combatants[rowNum].numActors = 0;
                    } else if (Roll.validate(numActors)) {
                        //Option 2: This is a dice roll (not guaranteed because it could just contain a dieRoll)
                        this.combatants[rowNum].numActors = numActors;
                    } else if (checkIntReg.test(numActors)) {
                        const multiplier = parseInt(numActors,10);
                        if (!Number.isNaN(multiplier)) {
                             this.combatants[rowNum].numActors = multiplier;
                        }
                    } else {
                        //otherwise leave unchanged - should pop up a dialog or highlight the field in red
                        const warning = game.i18n.localize("QE.QuickEncounterDialog.InvalidNumActors.WARNING") + " " + numActors;
                        ui.notifications.warn(warning);
                    }
                }
            } else if (fieldName === "addToCombatTracker") {
                fieldWasChanged = (this.combatants[rowNum].addToCombatTracker !== fieldValue);
                this.combatants[rowNum].addToCombatTracker = fieldValue;
            }
            wasChanged = wasChanged || fieldWasChanged;
        }//end for over all formData entries

        //If wasChanged, then update the info into the Quick Encounter
        if (wasChanged) {
            this._onChange();
        }
//TODO: Capture tokens removed
    }

    //0.7.0 Split off changed check so that we can call it from clicking the - on an Actor or Tile
    async _onChange() {
        //Reconstitute extractedActors and update it, removing those with numActors=0
        //Accept any non-numeric; blank has been replaced with 0
        const extractedActors = this.combatants.filter(c => (typeof c.numActors !== "number") || (c.numActors > 0)).map(c => {
            return {
                numActors : c.numActors,
                dataPackName : c.dataPackName, //if non-null then this is a Compendium reference
                actorID : c.actorId,           //If Compendium sometimes this is the reference
                name : c.actorName,
                addToCombatTracker : c.addToCombatTracker,  //remembered checked/cleared setting
                savedTokensData : c.tokens.filter(td => td.isSavedToken)
            }
        });
        //0.6.1o: The saved tokens for a removed ExtractedActor will now be discarded also

        //If we removed all the Actors and (0.7.0) all the Tiles and (1.1.1) all the RollTables, remove the whole QE
        if (extractedActors.length || this.object?.savedTilesData?.length || this.object?.rollTables?.length) {
            this.object?.update({extractedActors : extractedActors});
            //Re-render so the displayed rows reflect the change
            this.render();
        } else {
            //1.0.4j: Pass qeJournalEntry so we don't have to look it up via ID
            this.object?.remove(this.options.qeJournalEntry);
            //And close this sheet
            this.close();
        }
    }

}//end class QESheet
