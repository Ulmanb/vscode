/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { IModelService } from 'vs/editor/common/services/modelService';
import { IModel, ICommonCodeEditor } from 'vs/editor/common/editorCommon';
import { compare } from 'vs/base/common/strings';
import { delta } from 'vs/base/common/arrays';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { ICodeEditorService } from 'vs/editor/common/services/codeEditorService';
import Event, { Emitter } from 'vs/base/common/event';

namespace cmp {
	export function compareModels(a: IModel, b: IModel): number {
		return compare(a.uri.toString(), b.uri.toString());
	}
	export function compareEditors(a: ApiEditor, b: ApiEditor): number {
		let ret = compare(a.editor.getId(), b.editor.getId());
		if (ret === 0) {
			ret = compare(a.document.uri.toString(), b.document.uri.toString());
		}
		return ret;
	}
}

export class ApiEditor {

	constructor(
		readonly editor: ICommonCodeEditor,
		readonly document: IModel,
	) { }

	toString(): string {
		return `editor=${this.editor.getId()}, doc=${this.document.uri.toString(true)}`;
	}
}

export class DocumentAndEditorStateDelta {

	readonly isEmpty: boolean;

	constructor(
		readonly removedDocuments: IModel[],
		readonly addedDocuments: IModel[],
		readonly removedEditors: ApiEditor[],
		readonly addedEditors: ApiEditor[],
	) {
		this.isEmpty = this.removedDocuments.length === 0
			&& this.addedDocuments.length === 0
			&& this.removedEditors.length === 0
			&& this.addedEditors.length === 0;
	}

	toString(): string {
		let ret = 'DocumentAndEditorStateDelta\n';
		ret += `\tRemoved Documents: [${this.removedDocuments.map(d => d.uri.toString(true)).join(', ')}]\n`;
		ret += `\tAdded Documents: [${this.addedDocuments.map(d => d.uri.toString(true)).join(', ')}]\n`;
		ret += `\tRemoved Editors: [${this.removedEditors.map(d => d.toString()).join(', ')}]\n`;
		ret += `\tAdded Editors: [${this.addedEditors.map(d => d.toString()).join(', ')}]\n`;
		return ret;
	}
}

class DocumentAndEditorState {

	static compute(before: DocumentAndEditorState, after: DocumentAndEditorState): DocumentAndEditorStateDelta {
		if (!before) {
			return new DocumentAndEditorStateDelta([], after.documents, [], after.editors);
		}
		const documentDelta = delta(before.documents, after.documents, cmp.compareModels);
		const editorDelta = delta(before.editors, after.editors, cmp.compareEditors);
		return new DocumentAndEditorStateDelta(documentDelta.removed, documentDelta.added, editorDelta.removed, editorDelta.added);
	}

	constructor(
		readonly documents: IModel[],
		readonly editors: ApiEditor[]
	) {
		this.documents = documents.sort(cmp.compareModels);
		this.editors = editors.sort(cmp.compareEditors);
	}
}

export class MainThreadDocumentAndEditorState {

	private _toDispose: IDisposable[] = [];
	private _toDisposeOnEditorRemove = new Map<string, IDisposable>();
	private _onDidChangeState = new Emitter<DocumentAndEditorStateDelta>();
	private _currentState: DocumentAndEditorState;

	readonly onDidChangeState: Event<DocumentAndEditorStateDelta> = this._onDidChangeState.event;

	constructor(
		@IModelService private _modelService: IModelService,
		@ICodeEditorService private _codeEditorService: ICodeEditorService
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
		const sub = e.onDidChangeModel(() => this._updateState());
		this._toDisposeOnEditorRemove.set(e.getId(), sub);
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
		const editors: ApiEditor[] = [];
		for (const editor of this._codeEditorService.listCodeEditors()) {
			const model = editor.getModel();
			if (model && !model.isTooLargeForHavingARichMode()) {
				editors.push(new ApiEditor(editor, model));
			}
		}

		// compute new state and compare against old
		const newState = new DocumentAndEditorState(models, editors);
		const delta = DocumentAndEditorState.compute(this._currentState, newState);
		if (!delta.isEmpty) {
			this._currentState = newState;
			this._onDidChangeState.fire(delta);
		}
	}
}
