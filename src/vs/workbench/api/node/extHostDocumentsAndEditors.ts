/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

// import { onUnexpectedError } from 'vs/base/common/errors';
// import { regExpLeadsToEndlessLoop } from 'vs/base/common/strings';
// import * as editorCommon from 'vs/editor/common/editorCommon';
// import { RawText } from 'vs/editor/common/model/textModel';
// import { MirrorModel2 } from 'vs/editor/common/model/mirrorModel2';
// import { IThreadService } from 'vs/workbench/services/thread/common/threadService';
// import Event, { Emitter } from 'vs/base/common/event';
// import URI from 'vs/base/common/uri';
// import { IDisposable } from 'vs/base/common/lifecycle';
// import { Range, Position, Disposable } from 'vs/workbench/api/node/extHostTypes';
// import * as TypeConverters from './extHostTypeConverters';
// import { TPromise } from 'vs/base/common/winjs.base';

// import { asWinJsPromise } from 'vs/base/common/async';
// import { getWordAtText, ensureValidWordDefinition } from 'vs/editor/common/model/wordHelper';
import { ExtHostDocumentsAndEditorsShape, IDocumentsAndEditorsDelta } from './extHost.protocol';


export class ExtHostDocumentsAndEditors extends ExtHostDocumentsAndEditorsShape {

	// private readonly _documents = new Map<string, any>();
	// private readonly _editors = new Map<string, any>();

	$acceptDocumentsAndEditorsDelta(delta: IDocumentsAndEditorsDelta): void {
		//
	}
}
