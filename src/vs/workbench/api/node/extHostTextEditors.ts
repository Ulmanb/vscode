/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import URI from 'vs/base/common/uri';
import { equals as arrayEquals } from 'vs/base/common/arrays';
import Event, { Emitter } from 'vs/base/common/event';
import { TPromise } from 'vs/base/common/winjs.base';
import { IThreadService } from 'vs/workbench/services/thread/common/threadService';
import { ExtHostDocuments } from 'vs/workbench/api/node/extHostDocuments';
import { TextEditorSelectionChangeKind } from './extHostTypes';
import { IResolvedTextEditorConfiguration, ISelectionChangeEvent } from 'vs/workbench/api/node/mainThreadEditorsTracker';
import * as TypeConverters from './extHostTypeConverters';
import { ExtHostTextEditor, TextEditorDecorationType } from './extHostTextEditor';
import { MainContext, MainThreadEditorsShape, ExtHostEditorsShape, ITextEditorAddData, ITextEditorPositionData } from './extHost.protocol';
import * as vscode from 'vscode';

export class ExtHostEditors extends ExtHostEditorsShape {

	public onDidChangeTextEditorSelection: Event<vscode.TextEditorSelectionChangeEvent>;
	private _onDidChangeTextEditorSelection: Emitter<vscode.TextEditorSelectionChangeEvent>;

	public onDidChangeTextEditorOptions: Event<vscode.TextEditorOptionsChangeEvent>;
	private _onDidChangeTextEditorOptions: Emitter<vscode.TextEditorOptionsChangeEvent>;

	public onDidChangeTextEditorViewColumn: Event<vscode.TextEditorViewColumnChangeEvent>;
	private _onDidChangeTextEditorViewColumn: Emitter<vscode.TextEditorViewColumnChangeEvent>;

	private _editors: Map<string, ExtHostTextEditor>;
	private _proxy: MainThreadEditorsShape;
	private _onDidChangeActiveTextEditor: Emitter<vscode.TextEditor>;
	private _onDidChangeVisibleTextEditors: Emitter<vscode.TextEditor[]>;
	private _extHostDocuments: ExtHostDocuments;
	private _activeEditorId: string;
	private _visibleEditorIds: string[];

	constructor(
		threadService: IThreadService,
		extHostDocuments: ExtHostDocuments
	) {
		super();
		this._onDidChangeTextEditorSelection = new Emitter<vscode.TextEditorSelectionChangeEvent>();
		this.onDidChangeTextEditorSelection = this._onDidChangeTextEditorSelection.event;

		this._onDidChangeTextEditorOptions = new Emitter<vscode.TextEditorOptionsChangeEvent>();
		this.onDidChangeTextEditorOptions = this._onDidChangeTextEditorOptions.event;

		this._onDidChangeTextEditorViewColumn = new Emitter<vscode.TextEditorViewColumnChangeEvent>();
		this.onDidChangeTextEditorViewColumn = this._onDidChangeTextEditorViewColumn.event;

		this._extHostDocuments = extHostDocuments;
		this._proxy = threadService.get(MainContext.MainThreadEditors);
		this._onDidChangeActiveTextEditor = new Emitter<vscode.TextEditor>();
		this._onDidChangeVisibleTextEditors = new Emitter<vscode.TextEditor[]>();
		this._editors = new Map<string, ExtHostTextEditor>();

		this._visibleEditorIds = [];
	}

	getActiveTextEditor(): vscode.TextEditor {
		return this._editors.get(this._activeEditorId);
	}

	getVisibleTextEditors(): vscode.TextEditor[] {
		return this._visibleEditorIds.map(id => this._editors.get(id));
	}

	get onDidChangeActiveTextEditor(): Event<vscode.TextEditor> {
		return this._onDidChangeActiveTextEditor && this._onDidChangeActiveTextEditor.event;
	}

	get onDidChangeVisibleTextEditors(): Event<vscode.TextEditor[]> {
		return this._onDidChangeVisibleTextEditors && this._onDidChangeVisibleTextEditors.event;
	}

	showTextDocument(document: vscode.TextDocument, column: vscode.ViewColumn, preserveFocus: boolean): TPromise<vscode.TextEditor> {
		return this._proxy.$tryShowTextDocument(<URI>document.uri, TypeConverters.fromViewColumn(column), preserveFocus).then(id => {
			let editor = this._editors.get(id);
			if (editor) {
				return editor;
			} else {
				throw new Error(`Failed to show text document ${document.uri.toString()}, should show in editor #${id}`);
			}
		});
	}

	createTextEditorDecorationType(options: vscode.DecorationRenderOptions): vscode.TextEditorDecorationType {
		return new TextEditorDecorationType(this._proxy, options);
	}

	// --- called from main thread

	$acceptTextEditorAdd(data: ITextEditorAddData): void {
		let document = this._extHostDocuments.getDocumentData(data.document);
		let newEditor = new ExtHostTextEditor(this._proxy, data.id, document, data.selections.map(TypeConverters.toSelection), data.options, TypeConverters.toViewColumn(data.editorPosition));
		this._editors.set(data.id, newEditor);
	}

	$acceptOptionsChanged(id: string, opts: IResolvedTextEditorConfiguration): void {
		let editor = this._editors.get(id);
		editor._acceptOptions(opts);
		this._onDidChangeTextEditorOptions.fire({
			textEditor: editor,
			options: opts
		});
	}

	$acceptSelectionsChanged(id: string, event: ISelectionChangeEvent): void {
		const kind = TextEditorSelectionChangeKind.fromValue(event.source);
		const selections = event.selections.map(TypeConverters.toSelection);
		const textEditor = this._editors.get(id);
		textEditor._acceptSelections(selections);
		this._onDidChangeTextEditorSelection.fire({
			textEditor,
			selections,
			kind
		});
	}

	$acceptActiveEditorAndVisibleEditors(id: string, visibleIds: string[]): void {
		let visibleChanged = false;
		let activeChanged = false;

		if (!arrayEquals(this._visibleEditorIds, visibleIds)) {
			this._visibleEditorIds = visibleIds;
			visibleChanged = true;
		}

		if (this._activeEditorId !== id) {
			this._activeEditorId = id;
			activeChanged = true;
		}

		if (visibleChanged) {
			this._onDidChangeVisibleTextEditors.fire(this.getVisibleTextEditors());
		}
		if (activeChanged) {
			this._onDidChangeActiveTextEditor.fire(this.getActiveTextEditor());
		}
	}

	$acceptEditorPositionData(data: ITextEditorPositionData): void {
		for (let id in data) {
			let textEditor = this._editors.get(id);
			let viewColumn = TypeConverters.toViewColumn(data[id]);
			if (textEditor.viewColumn !== viewColumn) {
				textEditor._acceptViewColumn(viewColumn);
				this._onDidChangeTextEditorViewColumn.fire({ textEditor, viewColumn });
			}
		}
	}

	$acceptTextEditorRemove(id: string): void {
		// make sure the removed editor is not visible
		let newVisibleEditors = this._visibleEditorIds.filter(visibleEditorId => visibleEditorId !== id);

		if (this._activeEditorId === id) {
			// removing the current active editor
			this.$acceptActiveEditorAndVisibleEditors(undefined, newVisibleEditors);
		} else {
			this.$acceptActiveEditorAndVisibleEditors(this._activeEditorId, newVisibleEditors);
		}

		let editor = this._editors.get(id);
		editor.dispose();
		this._editors.delete(id);
	}
}
