/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { onUnexpectedError } from 'vs/base/common/errors';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { RawText } from 'vs/editor/common/model/textModel';
import { IThreadService } from 'vs/workbench/services/thread/common/threadService';
import Event, { Emitter } from 'vs/base/common/event';
import URI from 'vs/base/common/uri';
import { IDisposable } from 'vs/base/common/lifecycle';
import { Disposable } from 'vs/workbench/api/node/extHostTypes';
import * as TypeConverters from './extHostTypeConverters';
import { TPromise } from 'vs/base/common/winjs.base';
import * as vscode from 'vscode';
import { asWinJsPromise } from 'vs/base/common/async';
import { MainContext, MainThreadDocumentsShape, ExtHostDocumentsShape, IModelAddedData } from './extHost.protocol';
import { ExtHostDocumentData, setWordDefinitionFor } from './extHostDocumentData';

export class ExtHostDocuments extends ExtHostDocumentsShape {

	private static _handlePool: number = 0;

	private _onDidAddDocumentEventEmitter: Emitter<vscode.TextDocument>;
	public onDidAddDocument: Event<vscode.TextDocument>;

	private _onDidRemoveDocumentEventEmitter: Emitter<vscode.TextDocument>;
	public onDidRemoveDocument: Event<vscode.TextDocument>;

	private _onDidChangeDocumentEventEmitter: Emitter<vscode.TextDocumentChangeEvent>;
	public onDidChangeDocument: Event<vscode.TextDocumentChangeEvent>;

	private _onDidSaveDocumentEventEmitter: Emitter<vscode.TextDocument>;
	public onDidSaveDocument: Event<vscode.TextDocument>;

	private _documentData = new Map<string, ExtHostDocumentData>();
	private _documentLoader = new Map<string, TPromise<ExtHostDocumentData>>();
	private _documentContentProviders = new Map<number, vscode.TextDocumentContentProvider>();

	private _proxy: MainThreadDocumentsShape;

	constructor(threadService: IThreadService) {
		super();
		this._proxy = threadService.get(MainContext.MainThreadDocuments);

		this._onDidAddDocumentEventEmitter = new Emitter<vscode.TextDocument>();
		this.onDidAddDocument = this._onDidAddDocumentEventEmitter.event;

		this._onDidRemoveDocumentEventEmitter = new Emitter<vscode.TextDocument>();
		this.onDidRemoveDocument = this._onDidRemoveDocumentEventEmitter.event;

		this._onDidChangeDocumentEventEmitter = new Emitter<vscode.TextDocumentChangeEvent>();
		this.onDidChangeDocument = this._onDidChangeDocumentEventEmitter.event;

		this._onDidSaveDocumentEventEmitter = new Emitter<vscode.TextDocument>();
		this.onDidSaveDocument = this._onDidSaveDocumentEventEmitter.event;
	}

	public getAllDocumentData(): ExtHostDocumentData[] {
		const result: ExtHostDocumentData[] = [];
		this._documentData.forEach(data => result.push(data));
		return result;
	}

	public getDocumentData(resource: vscode.Uri): ExtHostDocumentData {
		if (!resource) {
			return undefined;
		}
		const data = this._documentData.get(resource.toString());
		if (data) {
			return data;
		}
		return undefined;
	}

	public ensureDocumentData(uri: URI): TPromise<ExtHostDocumentData> {

		let cached = this._documentData.get(uri.toString());
		if (cached) {
			return TPromise.as(cached);
		}

		let promise = this._documentLoader.get(uri.toString());
		if (!promise) {
			promise = this._proxy.$tryOpenDocument(uri).then(() => {
				this._documentLoader.delete(uri.toString());
				return this._documentData.get(uri.toString());
			}, err => {
				this._documentLoader.delete(uri.toString());
				return TPromise.wrapError(err);
			});
			this._documentLoader.set(uri.toString(), promise);
		}

		return promise;
	}

	public createDocumentData(options?: { language: string; }): TPromise<URI> {
		return this._proxy.$tryCreateDocument(options);
	}

	public registerTextDocumentContentProvider(scheme: string, provider: vscode.TextDocumentContentProvider): vscode.Disposable {
		if (scheme === 'file' || scheme === 'untitled') {
			throw new Error(`scheme '${scheme}' already registered`);
		}

		const handle = ExtHostDocuments._handlePool++;

		this._documentContentProviders.set(handle, provider);
		this._proxy.$registerTextContentProvider(handle, scheme);

		let subscription: IDisposable;
		if (typeof provider.onDidChange === 'function') {
			subscription = provider.onDidChange(uri => {
				if (this._documentData.has(uri.toString())) {
					this.$provideTextDocumentContent(handle, <URI>uri).then(value => {

						const document = this._documentData.get(uri.toString());
						if (!document) {
							// disposed in the meantime
							return;
						}

						// create lines and compare
						const raw = RawText.fromString(value, {
							defaultEOL: editorCommon.DefaultEndOfLine.CRLF,
							tabSize: 0,
							detectIndentation: false,
							insertSpaces: false,
							trimAutoWhitespace: false
						});

						// broadcast event when content changed
						if (!document.equalLines(raw)) {
							return this._proxy.$onVirtualDocumentChange(<URI>uri, raw);
						}

					}, onUnexpectedError);
				}
			});
		}
		return new Disposable(() => {
			if (this._documentContentProviders.delete(handle)) {
				this._proxy.$unregisterTextContentProvider(handle);
			}
			if (subscription) {
				subscription.dispose();
				subscription = undefined;
			}
		});
	}

	$provideTextDocumentContent(handle: number, uri: URI): TPromise<string> {
		const provider = this._documentContentProviders.get(handle);
		if (!provider) {
			return TPromise.wrapError<string>(`unsupported uri-scheme: ${uri.scheme}`);
		}
		return asWinJsPromise(token => provider.provideTextDocumentContent(uri, token));
	}

	public $acceptModelAdd(initData: IModelAddedData): void {
		let data = new ExtHostDocumentData(this._proxy, initData.url, initData.value.lines, initData.value.EOL, initData.modeId, initData.versionId, initData.isDirty);
		let key = data.document.uri.toString();
		if (this._documentData.has(key)) {
			throw new Error('Document `' + key + '` already exists.');
		}
		this._documentData.set(key, data);
		this._onDidAddDocumentEventEmitter.fire(data.document);
	}

	public $acceptModelModeChanged(strURL: string, oldModeId: string, newModeId: string): void {
		let data = this._documentData.get(strURL);

		// Treat a mode change as a remove + add

		this._onDidRemoveDocumentEventEmitter.fire(data.document);
		data._acceptLanguageId(newModeId);
		this._onDidAddDocumentEventEmitter.fire(data.document);
	}

	public $acceptModelSaved(strURL: string): void {
		let data = this._documentData.get(strURL);
		data._acceptIsDirty(false);
		this._onDidSaveDocumentEventEmitter.fire(data.document);
	}

	public $acceptModelDirty(strURL: string): void {
		let document = this._documentData.get(strURL);
		document._acceptIsDirty(true);
	}

	public $acceptModelReverted(strURL: string): void {
		let document = this._documentData.get(strURL);
		document._acceptIsDirty(false);
	}

	public $acceptModelRemoved(strURL: string): void {
		if (!this._documentData.has(strURL)) {
			throw new Error('Document `' + strURL + '` does not exist.');
		}
		let data = this._documentData.get(strURL);
		this._documentData.delete(strURL);
		this._onDidRemoveDocumentEventEmitter.fire(data.document);
		data.dispose();
	}

	public $acceptModelChanged(strURL: string, events: editorCommon.IModelContentChangedEvent2[], isDirty: boolean): void {
		let data = this._documentData.get(strURL);
		data._acceptIsDirty(isDirty);
		data.onEvents(events);
		this._onDidChangeDocumentEventEmitter.fire({
			document: data.document,
			contentChanges: events.map((e) => {
				return {
					range: TypeConverters.toRange(e.range),
					rangeLength: e.rangeLength,
					text: e.text
				};
			})
		});
	}

	setWordDefinitionFor(modeId: string, wordDefinition: RegExp): void {
		setWordDefinitionFor(modeId, wordDefinition);
	}
}
