/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { IModelService } from 'vs/editor/common/services/modelService';
import { IModel, ICommonCodeEditor, isCommonCodeEditor, isCommonDiffEditor } from 'vs/editor/common/editorCommon';
import { compare } from 'vs/base/common/strings';
import { delta } from 'vs/base/common/arrays';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { ICodeEditorService } from 'vs/editor/common/services/codeEditorService';
import Event, { Emitter, any } from 'vs/base/common/event';
import { ExtHostDocumentsAndEditors, IModelAddedData, ITextEditorAddData } from './extHost.protocol';
import { MainThreadTextEditor, IFocusTracker } from 'vs/workbench/api/node/mainThreadEditorsTracker';
import { IThreadService } from 'vs/workbench/services/thread/common/threadService';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { Position as EditorPosition } from 'vs/platform/editor/common/editor';

namespace cmp {
	export function compareModels(a: IModel, b: IModel): number {
		return compare(a.uri.toString(), b.uri.toString());
	}
	export function compareEditors(a: EditorAndModel, b: EditorAndModel): number {
		let ret = compare(a.editor.getId(), b.editor.getId());
		if (ret === 0) {
			ret = compare(a.document.uri.toString(), b.document.uri.toString());
		}
		return ret;
	}
}

class EditorAndModel {

	readonly id: string;

	constructor(
		readonly editor: ICommonCodeEditor,
		readonly document: IModel,
	) {
		this.id = `${editor.getId()},${document.uri.toString()}`;
	}
}

class DocumentAndEditorStateDelta {

	readonly isEmpty: boolean;

	constructor(
		readonly removedDocuments: IModel[],
		readonly addedDocuments: IModel[],
		readonly removedEditors: EditorAndModel[],
		readonly addedEditors: EditorAndModel[],
		readonly oldActiveEditor: string,
		readonly newActiveEditor: string,
	) {
		this.isEmpty = this.removedDocuments.length === 0
			&& this.addedDocuments.length === 0
			&& this.removedEditors.length === 0
			&& this.addedEditors.length === 0
			&& oldActiveEditor === newActiveEditor;
	}

	toString(): string {
		let ret = 'DocumentAndEditorStateDelta\n';
		ret += `\tRemoved Documents: [${this.removedDocuments.map(d => d.uri.toString(true)).join(', ')}]\n`;
		ret += `\tAdded Documents: [${this.addedDocuments.map(d => d.uri.toString(true)).join(', ')}]\n`;
		ret += `\tRemoved Editors: [${this.removedEditors.map(e => e.id).join(', ')}]\n`;
		ret += `\tAdded Editors: [${this.addedEditors.map(e => e.id).join(', ')}]\n`;
		ret += `\tNew Active Editor: ${this.newActiveEditor}\n`;
		return ret;
	}
}

class DocumentAndEditorState {

	static compute(before: DocumentAndEditorState, after: DocumentAndEditorState): DocumentAndEditorStateDelta {
		if (!before) {
			return new DocumentAndEditorStateDelta([], after.documents, [], after.editors, undefined, after.activeEditor);
		}
		const documentDelta = delta(before.documents, after.documents, cmp.compareModels);
		const editorDelta = delta(before.editors, after.editors, cmp.compareEditors);
		const oldActiveEditor = before.activeEditor !== after.activeEditor ? before.activeEditor : undefined;
		const newActiveEditor = before.activeEditor !== after.activeEditor ? after.activeEditor : undefined;

		return new DocumentAndEditorStateDelta(
			documentDelta.removed, documentDelta.added,
			editorDelta.removed, editorDelta.added,
			oldActiveEditor, newActiveEditor
		);
	}

	constructor(
		readonly documents: IModel[],
		readonly editors: EditorAndModel[],
		readonly activeEditor: string,
	) {
		this.documents = documents.sort(cmp.compareModels);
		this.editors = editors.sort(cmp.compareEditors);
	}
}

class MainThreadDocumentAndEditorState {

	private _toDispose: IDisposable[] = [];
	private _toDisposeOnEditorRemove = new Map<string, IDisposable>();
	private _onDidChangeState = new Emitter<DocumentAndEditorStateDelta>();
	private _currentState: DocumentAndEditorState;

	readonly onDidChangeState: Event<DocumentAndEditorStateDelta> = this._onDidChangeState.event;

	constructor(
		@IModelService private _modelService: IModelService,
		@ICodeEditorService private _codeEditorService: ICodeEditorService,
		@IWorkbenchEditorService private _workbenchEditorService: IWorkbenchEditorService
	) {
		this._modelService.onModelAdded(this._updateState, this, this._toDispose);
		this._modelService.onModelRemoved(this._updateState, this, this._toDispose);
		this._codeEditorService.onCodeEditorAdd(this._onDidAddEditor, this, this._toDispose);
		this._codeEditorService.onCodeEditorRemove(this._onDidRemoveEditor, this, this._toDispose);
	}

	dispose(): void {
		this._toDispose = dispose(this._toDispose);
	}

	private _onDidAddEditor(e: ICommonCodeEditor): void {
		const listener = any<any>(
			e.onDidChangeModel,
			e.onDidFocusEditor,
			e.onDidBlurEditor
		)(this._updateState, this);
		this._toDisposeOnEditorRemove.set(e.getId(), listener);
		this._updateState();
	}

	private _onDidRemoveEditor(e: ICommonCodeEditor): void {
		const sub = this._toDisposeOnEditorRemove.get(e.getId());
		if (sub) {
			this._toDisposeOnEditorRemove.delete(e.getId());
			sub.dispose();
			this._updateState();
		}
	}

	private _updateState(): void {

		// models: ignore too large models
		const models = this._modelService.getModels();
		for (let i = 0; i < models.length; i++) {
			if (models[i].isTooLargeForHavingARichMode()) {
				models.splice(i, 1);
				i--;
			}
		}

		// editor: only take those that have a not too large model
		const editors: EditorAndModel[] = [];
		let activeEditor: string = null;

		for (const editor of this._codeEditorService.listCodeEditors()) {
			const model = editor.getModel();
			if (model && !model.isTooLargeForHavingARichMode()) {
				const apiEditor = new EditorAndModel(editor, model);
				editors.push(apiEditor);
				if (editor.isFocused()) {
					activeEditor = apiEditor.id;
				}
			}
		}

		// active editor: if none of the previous editors had focus we try
		// to match the action workbench editor with one of editor we have
		// just computed
		if (!activeEditor) {
			const workbenchEditor = this._workbenchEditorService.getActiveEditor();
			if (workbenchEditor) {
				const workbenchEditorControl = workbenchEditor.getControl();
				let candidate: ICommonCodeEditor;
				if (isCommonCodeEditor(workbenchEditorControl)) {
					candidate = workbenchEditorControl;
				} else if (isCommonDiffEditor(workbenchEditorControl)) {
					candidate = workbenchEditorControl.getModifiedEditor();
				}
				if (candidate) {
					for (const { editor, id } of editors) {
						if (candidate === editor) {
							activeEditor = id;
							break;
						}
					}
				}
			}
		}

		// compute new state and compare against old
		const newState = new DocumentAndEditorState(models, editors, activeEditor);
		const delta = DocumentAndEditorState.compute(this._currentState, newState);
		if (!delta.isEmpty) {
			this._currentState = newState;
			this._onDidChangeState.fire(delta);
		}
	}
}

export class MainThreadDocumentsAndEditors {

	private _focusTracker: IFocusTracker;
	private _proxy: ExtHostDocumentsAndEditors;
	private _state: MainThreadDocumentAndEditorState;
	private _editors = <{ [id: string]: MainThreadTextEditor }>Object.create(null);

	private _onTextEditorAdd = new Emitter<MainThreadTextEditor[]>();
	private _onTextEditorRemove = new Emitter<string[]>();
	private _onDocumentAdd = new Emitter<IModel[]>();
	private _onDocumentRemove = new Emitter<string[]>();

	readonly onTextEditorAdd: Event<MainThreadTextEditor[]> = this._onTextEditorAdd.event;
	readonly onTextEditorRemove: Event<string[]> = this._onTextEditorRemove.event;
	readonly onDocumentAdd: Event<IModel[]> = this._onDocumentAdd.event;
	readonly onDocumentRemove: Event<string[]> = this._onDocumentRemove.event;

	constructor(
		@IModelService private _modelService: IModelService,
		@ITextFileService private _textFileService: ITextFileService,
		@IWorkbenchEditorService private _workbenchEditorService: IWorkbenchEditorService,
		@IThreadService threadService: IThreadService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
	) {
		this._focusTracker = { onGainedFocus() { }, onLostFocus() { } };
		// this._proxy = threadService.get<ExtHostDocumentsAndEditors>(null);
		this._proxy = new class extends ExtHostDocumentsAndEditors {
			$acceptDocumentsAndEditorsDelta(data) {

			}
		};
		this._state = new MainThreadDocumentAndEditorState(_modelService, codeEditorService, _workbenchEditorService);
		this._state.onDidChangeState(this._onDelta, this);
	}

	private _onDelta(delta: DocumentAndEditorStateDelta): void {

		let removedDocuments: string[];
		let addedEditors: MainThreadTextEditor[] = [];
		let removedEditors: string[] = [];

		// removed models
		removedDocuments = delta.removedDocuments.map(m => m.uri.toString());

		// added editors
		for (const apiEditor of delta.addedEditors) {
			const mainThreadEditor = new MainThreadTextEditor(apiEditor.id, apiEditor.document,
				apiEditor.editor, this._focusTracker, this._modelService);

			this._editors[apiEditor.id] = mainThreadEditor;
			addedEditors.push(mainThreadEditor);
		}

		// removed editors
		for (const { id } of delta.removedEditors) {
			const mainThreadEditor = this._editors[id];
			if (mainThreadEditor) {
				mainThreadEditor.dispose();
				delete this._editors[id];
				removedEditors.push(id);
			}
		}

		this._proxy.$acceptDocumentsAndEditorsDelta({
			newActiveEditor: delta.newActiveEditor,
			removedDocuments,
			removedEditors,
			addedDocuments: delta.addedDocuments.map(m => this._toModelAddData(m)),
			addedEditors: addedEditors.map(e => this._toTextEditorAddData(e))
		});

		// fire individual events
		this._onTextEditorRemove.fire(removedEditors);
		this._onTextEditorAdd.fire(addedEditors);
		this._onDocumentRemove.fire(removedDocuments);
		this._onDocumentAdd.fire(delta.addedDocuments);
	}

	private _toModelAddData(model: IModel): IModelAddedData {
		return {
			url: model.uri,
			versionId: model.getVersionId(),
			value: model.toRawText(),
			modeId: model.getLanguageIdentifier().language,
			isDirty: this._textFileService.isDirty(model.uri)
		};
	}

	private _toTextEditorAddData(textEditor: MainThreadTextEditor): ITextEditorAddData {
		return {
			id: textEditor.getId(),
			document: textEditor.getModel().uri,
			options: textEditor.getConfiguration(),
			selections: textEditor.getSelections(),
			editorPosition: this._findEditorPosition(textEditor)
		};
	}

	private _findEditorPosition(editor: MainThreadTextEditor): EditorPosition {
		for (let workbenchEditor of this._workbenchEditorService.getVisibleEditors()) {
			if (editor.matches(workbenchEditor)) {
				return workbenchEditor.position;
			}
		}
		return undefined;
	}
}
