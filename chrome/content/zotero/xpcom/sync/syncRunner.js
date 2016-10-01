/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2009 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

"use strict";

if (!Zotero.Sync) {
	Zotero.Sync = {};
}

// Initialized as Zotero.Sync.Runner in zotero.js
Zotero.Sync.Runner_Module = function (options = {}) {
	const stopOnError = false;
	
	Zotero.defineProperty(this, 'enabled', {
		get: () => {
			return _apiKey || Zotero.Sync.Data.Local.hasCredentials();
		}
	});
	Zotero.defineProperty(this, 'syncInProgress', { get: () => _syncInProgress });
	Zotero.defineProperty(this, 'lastSyncStatus', { get: () => _lastSyncStatus });
	
	this.baseURL = options.baseURL || ZOTERO_CONFIG.API_URL;
	this.apiVersion = options.apiVersion || ZOTERO_CONFIG.API_VERSION;
	
	// Allows tests to set apiKey in options or as property, overriding login manager
	var _apiKey = options.apiKey;
	Zotero.defineProperty(this, 'apiKey', { set: val => _apiKey = val });
	
	Components.utils.import("resource://zotero/concurrentCaller.js");
	this.caller = new ConcurrentCaller(4);
	this.caller.setLogger(msg => Zotero.debug(msg));
	this.caller.stopOnError = stopOnError;
	
	var _enabled = false;
	var _autoSyncTimer;
	var _firstInSession = true;
	var _syncInProgress = false;
	var _manualSyncRequired = false; // TODO: make public?
	
	var _syncEngines = [];
	var _storageEngines = [];
	var _storageControllers = {};
	
	var _lastSyncStatus;
	var _currentSyncStatusLabel;
	var _currentLastSyncLabel;
	var _errors = [];
	
	this.getAPIClient = function (options = {}) {
		return new Zotero.Sync.APIClient({
			baseURL: this.baseURL,
			apiVersion: this.apiVersion,
			apiKey: options.apiKey,
			caller: this.caller
		});
	}
	
	
	/**
	 * Begin a sync session
	 *
	 * @param {Object}    [options]
	 * @param {Boolean}   [options.background=false]  Whether this is a background request, which
	 *                                                prevents some alerts from being shown
	 * @param {Integer[]} [options.libraries]         IDs of libraries to sync; skipped libraries must
	 *     be removed if unwanted
	 * @param {Function}  [options.onError]           Function to pass errors to instead of
	 *                                                handling internally (used for testing)
	 */
	this.sync = Zotero.Promise.coroutine(function* (options = {}) {
		// Clear message list
		_errors = [];
		
		// Shouldn't be possible
		if (_syncInProgress) {
			let msg = Zotero.getString('sync.error.syncInProgress');
			let e = new Zotero.Error(msg, 0, { dialogButtonText: null, frontWindowOnly: true });
			this.updateIcons(e);
			return false;
		}
		_syncInProgress = true;
		
		// Purge deleted objects so they don't cause sync errors (e.g., long tags)
		yield Zotero.purgeDataObjects(true);
		
		try {
			let apiKey = yield _getAPIKey();
			if (!apiKey) {
				throw new Zotero.Error("API key not set", Zotero.Error.ERROR_API_KEY_NOT_SET);
			}
			
			if (_firstInSession) {
				options.firstInSession = true;
				_firstInSession = false;
			}
			
			this.updateIcons('animate');
			
			let client = this.getAPIClient({ apiKey });
			let keyInfo = yield this.checkAccess(client, options);
			
			let emptyLibraryContinue = yield this.checkEmptyLibrary(keyInfo);
			if (!emptyLibraryContinue) {
				yield this.end(options);
				Zotero.debug("Syncing cancelled because user library is empty");
				return false;
			}
			
			let wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
				.getService(Components.interfaces.nsIWindowMediator);
			let lastWin = wm.getMostRecentWindow("navigator:browser");
			if (!(yield Zotero.Sync.Data.Local.checkUser(lastWin, keyInfo.userID, keyInfo.username))) {
				yield this.end(options);
				Zotero.debug("User cancelled sync on username mismatch");
				return false;
			}
			
			let engineOptions = {
				apiClient: client,
				caller: this.caller,
				setStatus: this.setSyncStatus.bind(this),
				stopOnError,
				onError: function (e) {
					if (options.onError) {
						options.onError(e);
					}
					else {
						this.addError(e);
					}
				}.bind(this),
				background: !!options.background,
				firstInSession: _firstInSession
			};
			
			var librariesToSync = options.libraries = yield this.checkLibraries(
				client,
				options,
				keyInfo,
				options.libraries ? Array.from(options.libraries) : []
			);
			
			// If items not yet loaded for libraries we need, load them now
			for (let libraryID of librariesToSync) {
				let library = Zotero.Libraries.get(libraryID);
				if (!library.getDataLoaded('item')) {
					yield library.waitForDataLoad('item');
				}
			}
			
			// Sync data and files, and then repeat if necessary
			let attempt = 1;
			let successfulLibraries = new Set(librariesToSync);
			while (librariesToSync.length) {
				if (attempt > 3) {
					// TODO: Back off and/or nicer error
					throw new Error("Too many sync attempts -- stopping");
				}
				let nextLibraries = yield _doDataSync(librariesToSync, engineOptions);
				// Remove failed libraries from the successful set
				Zotero.Utilities.arrayDiff(librariesToSync, nextLibraries).forEach(libraryID => {
					successfulLibraries.delete(libraryID);
				});
				
				// Run file sync on all libraries that passed the last data sync
				librariesToSync = yield _doFileSync(nextLibraries, engineOptions);
				if (librariesToSync.length) {
					attempt++;
					continue;
				}
				
				// Run full-text sync on all libraries that haven't failed a data sync
				librariesToSync = yield _doFullTextSync([...successfulLibraries], engineOptions);
				if (librariesToSync.length) {
					attempt++;
					continue;
				}
				break;
			}
		}
		catch (e) {
			if (e instanceof Zotero.HTTP.BrowserOfflineException) {
				let msg = Zotero.getString('general.browserIsOffline', Zotero.appName);
				e = new Zotero.Error(msg, 0, { dialogButtonText: null })
				Zotero.logError(e);
				_errors = [];
			}
			
			if (e instanceof Zotero.Sync.UserCancelledException) {
				Zotero.debug("Sync was cancelled");
			}
			else if (options.onError) {
				options.onError(e);
			}
			else {
				this.addError(e);
			}
		}
		finally {
			yield this.end(options);
			
			if (options.restartSync) {
				delete options.restartSync;
				Zotero.debug("Restarting sync");
				yield this.sync(options);
				return;
			}
			
			Zotero.debug("Done syncing");
			Zotero.Notifier.trigger('finish', 'sync', librariesToSync || []);
		}
	});
	
	
	/**
	 * Check key for current user info and return access info
	 */
	this.checkAccess = Zotero.Promise.coroutine(function* (client, options={}) {
		var json = yield client.getKeyInfo(options);
		Zotero.debug(json);
		if (!json) {
			throw new Zotero.Error("API key not set", Zotero.Error.ERROR_API_KEY_NOT_SET);
		}
		
		// Sanity check
		if (!json.userID) throw new Error("userID not found in key response");
		if (!json.username) throw new Error("username not found in key response");
		if (!json.access) throw new Error("'access' not found in key response");
		
		return json;
	});


	// Prompt if library empty and there is no userID stored
	this.checkEmptyLibrary = Zotero.Promise.coroutine(function* (keyInfo) {
		let library = Zotero.Libraries.userLibrary;
		let feeds = Zotero.Feeds.getAll();
		let userID = Zotero.Users.getCurrentUserID();

		if (!userID) {
			let hasItems = yield library.hasItems();
			if (!hasItems && feeds.length <= 0 && !Zotero.resetDataDir) {
				let ps = Services.prompt;
				let index = ps.confirmEx(
					null,
					Zotero.getString('general.warning'),
					Zotero.getString('account.warning.emptyLibrary', [keyInfo.username, Zotero.clientName]) + "\n\n"
						+ Zotero.getString('account.warning.existingDataElsewhere', Zotero.clientName),
					(ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING) 
						+ (ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL)
						+ (ps.BUTTON_POS_2 * ps.BUTTON_TITLE_IS_STRING),
					Zotero.getString('sync.sync'),
					null, 
					Zotero.getString('dataDir.changeDataDirectory'), 
					null, {}
				);
				if (index == 1) {
					return false;
				}
				else if (index == 2) {
					var win = Services.wm.getMostRecentWindow("navigator:browser");
					win.openDialog("chrome://zotero/content/preferences/preferences.xul", null, null, {
						pane: 'zotero-prefpane-advanced',
						tabIndex: 1
					});
					return false;
				}
			}
		}
		return true;
	});
	
	
	/**
	 * @return {Promise<Integer[]> - IDs of libraries to sync
	 */
	this.checkLibraries = Zotero.Promise.coroutine(function* (client, options, keyInfo, libraries = []) {
		var access = keyInfo.access;
		
		var syncAllLibraries = !libraries || !libraries.length;
		
		// TODO: Ability to remove or disable editing of user library?
		
		if (syncAllLibraries) {
			if (access.user && access.user.library) {
				libraries = [Zotero.Libraries.userLibraryID, Zotero.Libraries.publicationsLibraryID];
				// If syncing all libraries, remove skipped libraries
				libraries = Zotero.Utilities.arrayDiff(
					libraries, Zotero.Sync.Data.Local.getSkippedLibraries()
				);
			}
		}
		else {
			// Check access to specified libraries
			for (let libraryID of libraries) {
				let type = Zotero.Libraries.get(libraryID).libraryType;
				if (type == 'user' || type == 'publications') {
					if (!access.user || !access.user.library) {
						// TODO: Alert
						throw new Error("Key does not have access to library " + libraryID);
					}
				}
			}
		}
		
		//
		// Check group access
		//
		let remotelyMissingGroups = [];
		let groupsToDownload = [];
		
		if (!Zotero.Utilities.isEmpty(access.groups)) {
			// TEMP: Require all-group access for now
			if (access.groups.all) {
				
			}
			else {
				throw new Error("Full group access is currently required");
			}
			
			let remoteGroupVersions = yield client.getGroupVersions(keyInfo.userID);
			let remoteGroupIDs = Object.keys(remoteGroupVersions).map(id => parseInt(id));
			let skippedGroups = Zotero.Sync.Data.Local.getSkippedGroups();
			
			// Remove skipped groups
			if (syncAllLibraries) {
				let newGroups = Zotero.Utilities.arrayDiff(remoteGroupIDs, skippedGroups);
				Zotero.Utilities.arrayDiff(remoteGroupIDs, newGroups)
					.forEach(id => { delete remoteGroupVersions[id] });
				remoteGroupIDs = newGroups;
			}
			
			for (let id in remoteGroupVersions) {
				id = parseInt(id);
				let group = Zotero.Groups.get(id);
				
				if (syncAllLibraries) {
					// If syncing all libraries, mark any that don't exist or are outdated
					// locally for update. Group is added to the library list after downloading
					if (!group || group.version < remoteGroupVersions[id]) {
						groupsToDownload.push(id);
					}
					// If not outdated, just add to library list
					else {
						libraries.push(group.libraryID);
					}
				}
				else {
					// If specific libraries were provided, ignore remote groups that don't
					// exist locally or aren't in the given list
					if (!group || libraries.indexOf(group.libraryID) == -1) {
						continue;
					}
					// If group metadata is outdated, mark for update
					if (group.version < remoteGroupVersions[id]) {
						groupsToDownload.push(id);
					}
				}
			}
			
			// Get local groups (all if syncing all libraries or just selected ones) that don't
			// exist remotely
			// TODO: Use explicit removals?
			let localGroups;
			if (syncAllLibraries) {
				localGroups = Zotero.Groups.getAll()
					.map(g => g.id)
					// Don't include skipped groups
					.filter(id => skippedGroups.indexOf(id) == -1);
			}
			else {
				localGroups = libraries
					.filter(id => Zotero.Libraries.get(id).libraryType == 'group')
					.map(id => Zotero.Groups.getGroupIDFromLibraryID(id))
			}
			remotelyMissingGroups = Zotero.Utilities.arrayDiff(localGroups, remoteGroupIDs)
				.map(id => Zotero.Groups.get(id));
		}
		// No group access
		else {
			remotelyMissingGroups = Zotero.Groups.getAll();
		}
		
		if (remotelyMissingGroups.length) {
			// TODO: What about explicit deletions?
			
			let removedGroups = [];
			
			let ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
				.getService(Components.interfaces.nsIPromptService);
			let buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
				+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_IS_STRING)
				+ (ps.BUTTON_POS_2) * (ps.BUTTON_TITLE_IS_STRING)
				+ ps.BUTTON_DELAY_ENABLE;
			
			// Prompt for each group
			//
			// TODO: Localize
			for (let group of remotelyMissingGroups) {
				let msg;
				// If all-groups access but group is missing, user left it
				if (access.groups && access.groups.all) {
					msg = "You are no longer a member of the group \u2018" + group.name + "\u2019.";
				}
				// If not all-groups access, key might just not have access
				else {
					msg = "You no longer have access to the group \u2018" + group.name + "\u2019.";
				}
				
				msg += "\n\n" + "Would you like to remove it from this computer or keep it "
					+ "as a read-only library?";
				
				let index = ps.confirmEx(
					null,
					"Group Not Found",
					msg,
					buttonFlags,
					"Remove Group",
					// TODO: Any way to have Esc trigger extra1 instead so it doesn't
					// have to be in this order?
					"Cancel Sync",
					"Keep Group",
					null, {}
				);
				
				if (index == 0) {
					removedGroups.push(group);
				}
				else if (index == 1) {
					Zotero.debug("Cancelling sync");
					return [];
				}
				else if (index == 2) {
					// TODO: Mark groups to be ignored
				}
			}
			
			let removedLibraryIDs = [];
			for (let group of removedGroups) {
				removedLibraryIDs.push(group.libraryID);
				yield Zotero.DB.executeTransaction(function* () {
					return group.erase();
				});
			}
			libraries = Zotero.Utilities.arrayDiff(libraries, removedLibraryIDs);
		}
		
		// Update metadata and permissions on missing or outdated groups
		for (let groupID of groupsToDownload) {
			let info = yield client.getGroup(groupID);
			if (!info) {
				throw new Error("Group " + groupID + " not found");
			}
			let group = Zotero.Groups.get(groupID);
			if (group) {
				// Check if the user's permissions for the group have changed, and prompt to reset
				// data if so
				let { editable, filesEditable } = Zotero.Groups.getPermissionsFromJSON(
					info.data, keyInfo.userID
				);
				let keepGoing = yield Zotero.Sync.Data.Local.checkLibraryForAccess(
					null, group.libraryID, editable, filesEditable
				);
				// User chose to skip library
				if (!keepGoing) {
					Zotero.debug("Skipping sync of group " + group.id);
					continue;
				}
			}
			else {
				group = new Zotero.Group;
				group.id = groupID;
			}
			group.version = info.version;
			group.fromJSON(info.data, Zotero.Users.getCurrentUserID());
			yield group.saveTx();
			
			// Add group to library list
			libraries.push(group.libraryID);
		}
		
		return [...new Set(libraries)];
	});
	
	
	/**
	 * Run sync engine for passed libraries
	 *
	 * @param {Integer[]} libraries
	 * @param {Object} options
	 * @param {Boolean} skipUpdateLastSyncTime
	 * @return {Integer[]} - Array of libraryIDs that completed successfully
	 */
	var _doDataSync = Zotero.Promise.coroutine(function* (libraries, options, skipUpdateLastSyncTime) {
		var successfulLibraries = [];
		for (let libraryID of libraries) {
			try {
				let opts = {};
				Object.assign(opts, options);
				opts.libraryID = libraryID;
				
				let engine = new Zotero.Sync.Data.Engine(opts);
				yield engine.start();
				successfulLibraries.push(libraryID);
			}
			catch (e) {
				if (e instanceof Zotero.Sync.UserCancelledException) {
					if (e.advanceToNextLibrary) {
						Zotero.debug("Sync cancelled for library " + libraryID + " -- "
							+ "advancing to next library");
						continue;
					}
					throw e;
				}
				
				Zotero.debug("Sync failed for library " + libraryID);
				Zotero.logError(e);
				this.checkError(e);
				options.onError(e);
				if (stopOnError || e.fatal) {
					Zotero.debug("Stopping on error", 1);
					options.caller.stop();
					break;
				}
			}
		}
		// Update last-sync time if any libraries synced
		// TEMP: Do we want to show updated time if some libraries haven't synced?
		if (!libraries.length || successfulLibraries.length) {
			yield Zotero.Sync.Data.Local.updateLastSyncTime();
		}
		return successfulLibraries;
	}.bind(this));
	
	
	/**
	 * @return {Integer[]} - Array of libraries that need data syncing again
	 */
	var _doFileSync = Zotero.Promise.coroutine(function* (libraries, options) {
		Zotero.debug("Starting file syncing");
		this.setSyncStatus(Zotero.getString('sync.status.syncingFiles'));
		var resyncLibraries = []
		for (let libraryID of libraries) {
			try {
				let opts = {};
				Object.assign(opts, options);
				opts.libraryID = libraryID;
				
				let mode = Zotero.Sync.Storage.Local.getModeForLibrary(libraryID);
				opts.controller = this.getStorageController(mode, opts);
				
				let tries = 3;
				while (true) {
					if (tries == 0) {
						throw new Error("Too many file sync attempts for library " + libraryID);
					}
					tries--;
					let engine = new Zotero.Sync.Storage.Engine(opts);
					let results = yield engine.start();
					if (results.syncRequired) {
						resyncLibraries.push(libraryID);
					}
					else if (results.fileSyncRequired) {
						Zotero.debug("Another file sync required -- restarting");
						continue;
					}
					break;
				}
			}
			catch (e) {
				Zotero.debug("File sync failed for library " + libraryID);
				Zotero.logError(e);
				this.checkError(e);
				options.onError(e);
				if (stopOnError || e.fatal) {
					options.caller.stop();
					break;
				}
			}
		}
		Zotero.debug("Done with file syncing");
		if (resyncLibraries.length) {
			Zotero.debug("Libraries to resync: " + resyncLibraries.join(", "));
		}
		return resyncLibraries;
	}.bind(this));
	
	
	/**
	 * @return {Integer[]} - Array of libraries that need data syncing again
	 */
	var _doFullTextSync = Zotero.Promise.coroutine(function* (libraries, options) {
		if (!Zotero.Prefs.get("sync.fulltext.enabled")) return [];
		
		Zotero.debug("Starting full-text syncing");
		this.setSyncStatus(Zotero.getString('sync.status.syncingFullText'));
		var resyncLibraries = [];
		for (let libraryID of libraries) {
			try {
				let opts = {};
				Object.assign(opts, options);
				opts.libraryID = libraryID;
				
				let engine = new Zotero.Sync.Data.FullTextEngine(opts);
				yield engine.start();
			}
			catch (e) {
				if (e instanceof Zotero.HTTP.UnexpectedStatusException && e.status == 412) {
					resyncLibraries.push(libraryID);
					continue;
				}
				Zotero.debug("Full-text sync failed for library " + libraryID);
				Zotero.logError(e);
				this.checkError(e);
				options.onError(e);
				if (stopOnError || e.fatal) {
					options.caller.stop();
					break;
				}
			}
		}
		Zotero.debug("Done with full-text syncing");
		if (resyncLibraries.length) {
			Zotero.debug("Libraries to resync: " + resyncLibraries.join(", "));
		}
		return resyncLibraries;
	}.bind(this));
	
	
	/**
	 * Get a storage controller for a given mode ('zfs', 'webdav'),
	 * caching it if necessary
	 */
	this.getStorageController = function (mode, options) {
		if (_storageControllers[mode]) {
			return _storageControllers[mode];
		}
		var modeClass = Zotero.Sync.Storage.Utilities.getClassForMode(mode);
		return _storageControllers[mode] = new modeClass(options);
	},
	
	
	// TODO: Call on API key change
	this.resetStorageController = function (mode) {
		delete _storageControllers[mode];
	},
	
	
	/**
	 * Download a single file on demand (not within a sync process)
	 */
	this.downloadFile = Zotero.Promise.coroutine(function* (item, requestCallbacks) {
		if (Zotero.HTTP.browserIsOffline()) {
			Zotero.debug("Browser is offline", 2);
			return false;
		}
		
		var apiKey = yield _getAPIKey();
		if (!apiKey) {
			Zotero.debug("API key not set -- skipping download");
			return false;
		}
		
		// TEMP
		var options = {};
		
		var itemID = item.id;
		var modeClass = Zotero.Sync.Storage.Local.getClassForLibrary(item.libraryID);
		var controller = new modeClass({
			apiClient: this.getAPIClient({apiKey })
		});
		
		// TODO: verify WebDAV on-demand?
		if (!controller.verified) {
			Zotero.debug("File syncing is not active for item's library -- skipping download");
			return false;
		}
		
		if (!item.isImportedAttachment()) {
			throw new Error("Not an imported attachment");
		}
		
		if (yield item.getFilePathAsync()) {
			Zotero.debug("File already exists -- replacing");
		}
		
		// TODO: start sync icon?
		// TODO: create queue for cancelling
		
		if (!requestCallbacks) {
			requestCallbacks = {};
		}
		var onStart = function (request) {
			return controller.downloadFile(request);
		};
		var request = new Zotero.Sync.Storage.Request({
			type: 'download',
			libraryID: item.libraryID,
			name: item.libraryKey,
			onStart: requestCallbacks.onStart
				? [onStart, requestCallbacks.onStart]
				: [onStart]
		});
		return request.start();
	});
	
	
	this.stop = function () {
		_syncEngines.forEach(engine => engine.stop());
		_storageEngines.forEach(engine => engine.stop());
	}
	
	
	this.end = Zotero.Promise.coroutine(function* (options) {
		yield this.checkErrors(_errors, options);
		if (!options.restartSync) {
			this.updateIcons(_errors);
		}
		_errors = [];
		_syncInProgress = false;
	});
	
	
	/**
	 * @param {Integer} timeout - Timeout in seconds
	 * @param {Boolean} [recurring=false]
	 * @param {Object} [options] - Sync options
	 */
	this.setSyncTimeout = function (timeout, recurring, options = {}) {
		if (!Zotero.Prefs.get('sync.autoSync') || !this.enabled) {
			return;
		}
		
		if (!timeout) {
			throw new Error("Timeout not provided");
		}
		
		if (_autoSyncTimer) {
			Zotero.debug("Cancelling auto-sync timer");
			_autoSyncTimer.cancel();
		}
		else {
			_autoSyncTimer = Components.classes["@mozilla.org/timer;1"].
				createInstance(Components.interfaces.nsITimer);
		}
		
		var mergedOpts = {
			background: true
		};
		Object.assign(mergedOpts, options);
		
		// Implements nsITimerCallback
		var callback = {
			notify: function (timer) {
				if (!_getAPIKey()) {
					return;
				}
				
				if (Zotero.locked) {
					Zotero.debug('Zotero is locked -- skipping auto-sync', 4);
					return;
				}
				
				if (_syncInProgress) {
					Zotero.debug('Sync already in progress -- skipping auto-sync', 4);
					return;
				}
				
				if (_manualSyncRequired) {
					Zotero.debug('Manual sync required -- skipping auto-sync', 4);
					return;
				}
				
				this.sync(mergedOpts);
			}.bind(this)
		}
		
		if (recurring) {
			Zotero.debug('Setting auto-sync interval to ' + timeout + ' seconds');
			_autoSyncTimer.initWithCallback(
				callback, timeout * 1000, Components.interfaces.nsITimer.TYPE_REPEATING_SLACK
			);
		}
		else {
			if (_syncInProgress) {
				Zotero.debug('Sync in progress -- not setting auto-sync timeout', 4);
				return;
			}
			
			Zotero.debug('Setting auto-sync timeout to ' + timeout + ' seconds');
			_autoSyncTimer.initWithCallback(
				callback, timeout * 1000, Components.interfaces.nsITimer.TYPE_ONE_SHOT
			);
		}
	}
	
	
	this.clearSyncTimeout = function () {
		if (_autoSyncTimer) {
			_autoSyncTimer.cancel();
		}
	}
	
	
	/**
	 * Trigger updating of the main sync icon, the sync error icon, and
	 * library-specific sync error icons across all windows
	 */
	this.addError = function (e, libraryID) {
		if (e.added) return;
		e.added = true;
		if (libraryID) {
			e.libraryID = libraryID;
		}
		Zotero.logError(e);
		_errors.push(this.parseError(e));
	}
	
	
	this.getErrorsByLibrary = function (libraryID) {
		return _errors.filter(e => e.libraryID === libraryID);
	}
	
	
	/**
	 * Get most severe error type from an array of parsed errors
	 */
	this.getPrimaryErrorType = function (errors) {
		// Set highest priority error as the primary (sync error icon)
		var errorTypes = {
			info: 1,
			warning: 2,
			error: 3,
			upgrade: 4,
			
			// Skip these
			animate: -1
		};
		var state = false;
		for (let i = 0; i < errors.length; i++) {
			let e = errors[i];
			
			let errorType = e.errorType;
				
			if (e.fatal) {
				return 'error';
			}
			
			if (!errorType || errorTypes[errorType] < 0) {
				continue;
			}
			if (!state || errorTypes[errorType] > errorTypes[state]) {
				state = errorType;
			}
		}
		return state;
	}
	
	
	this.checkErrors = Zotero.Promise.coroutine(function* (errors, options = {}) {
		for (let e of errors) {
			let handled = yield this.checkError(e, options);
			if (handled) {
				break;
			}
		}
	});
	
	
	this.checkError = Zotero.Promise.coroutine(function* (e, options = {}) {
		if (e.name && e.name == 'Zotero Error') {
			switch (e.error) {
				case Zotero.Error.ERROR_API_KEY_NOT_SET:
				case Zotero.Error.ERROR_API_KEY_INVALID:
					// TODO: the setTimeout() call below should just simulate a click on the sync error icon
					// instead of creating its own dialog, but updateIcons() doesn't yet provide full control
					// over dialog title and primary button text/action, which is why this version of the
					// dialog is a bit uglier than the manual click version
					// TODO: localize (=>done) and combine with below (=>?)
					var msg = Zotero.getString('sync.error.invalidLogin.text');
					e.message = msg;
					e.dialogButtonText = Zotero.getString('sync.openSyncPreferences');
					e.dialogButtonCallback = function () {
						var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
								.getService(Components.interfaces.nsIWindowMediator);
						var win = wm.getMostRecentWindow("navigator:browser");
						win.ZoteroPane.openPreferences("zotero-prefpane-sync");
					};
					
					// Manual click
					if (!options.background) {
						setTimeout(function () {
							var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
										.getService(Components.interfaces.nsIWindowMediator);
							var win = wm.getMostRecentWindow("navigator:browser");
							
							var ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
										.getService(Components.interfaces.nsIPromptService);
							var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
												+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_CANCEL);
							if (e.error == Zotero.Error.ERROR_API_KEY_NOT_SET) {
								var title = Zotero.getString('sync.error.usernameNotSet');
								var msg = Zotero.getString('sync.error.usernameNotSet.text');
							}
							else {
								var title = Zotero.getString('sync.error.invalidLogin');
								var msg = Zotero.getString('sync.error.invalidLogin.text');
							}
							var index = ps.confirmEx(
								win,
								title,
								msg,
								buttonFlags,
								Zotero.getString('sync.openSyncPreferences'),
								null, null, null, {}
							);
							
							if (index == 0) {
								win.ZoteroPane.openPreferences("zotero-prefpane-sync");
								return;
							}
						}, 1);
					}
					break;
			}
		}
		else if (e.name && e.name == 'ZoteroObjectUploadError') {
			// Tag too long
			if (e.code == 413 && e.data && e.data.tag !== undefined) {
				// Show long tag fixer and handle result
				e.dialogButtonText = Zotero.getString('general.fix');
				e.dialogButtonCallback = Zotero.Promise.coroutine(function* () {
					var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
					   .getService(Components.interfaces.nsIWindowMediator);
					var lastWin = wm.getMostRecentWindow("navigator:browser");
					
					// Open long tag fixer for every long tag in every editable library we're syncing
					var editableLibraries = options.libraries
						.filter(x => Zotero.Libraries.get(x).editable);
					for (let libraryID of editableLibraries) {
						let oldTagIDs = yield Zotero.Tags.getLongTagsInLibrary(libraryID);
						for (let oldTagID of oldTagIDs) {
							let oldTag = Zotero.Tags.getName(oldTagID);
							let dataOut = { result: null };
							lastWin.openDialog(
								'chrome://zotero/content/longTagFixer.xul',
								'',
								'chrome,modal,centerscreen',
								oldTag,
								dataOut
							);
							// If dialog was cancelled, stop
							if (!dataOut.result) {
								return;
							}
							switch (dataOut.result.op) {
							case 'split':
								for (let libraryID of editableLibraries) {
									let itemIDs = yield Zotero.Tags.getTagItems(libraryID, oldTagID);
									yield Zotero.DB.executeTransaction(function* () {
										for (let itemID of itemIDs) {
											let item = yield Zotero.Items.getAsync(itemID);
											for (let tag of dataOut.result.tags) {
												item.addTag(tag);
											}
											item.removeTag(oldTag);
											yield item.save();
										}
										yield Zotero.Tags.purge(oldTagID);
									});
								}
								break;
							
							case 'edit':
								for (let libraryID of editableLibraries) {
									let itemIDs = yield Zotero.Tags.getTagItems(libraryID, oldTagID);
									yield Zotero.DB.executeTransaction(function* () {
										for (let itemID of itemIDs) {
											let item = yield Zotero.Items.getAsync(itemID);
											item.replaceTag(oldTag, dataOut.result.tag);
											yield item.save();
										}
									});
								}
								break;
							
							case 'delete':
								for (let libraryID of editableLibraries) {
									yield Zotero.Tags.removeFromLibrary(libraryID, oldTagID);
								}
								break;
							}
						}
					}
					
					options.restartSync = true;
				});
				// If not a background sync, show fixer dialog immediately
				if (!options.background) {
					yield e.dialogButtonCallback();
				}
			}
		}
	});
	
	
	/**
	 * Set the sync icon and sync error icon across all windows
	 *
	 * @param {Error|Error[]|'animate'} errors - An error, an array of errors, or 'animate' to
	 *                                           spin the icon. An empty array will reset the
	 *                                           icons.
	 */
	this.updateIcons = function (errors) {
		if (typeof errors == 'string') {
			var state = errors;
			errors = [];
		}
		else {
			if (!Array.isArray(errors)) {
				errors = [errors];
			}
			var state = this.getPrimaryErrorType(errors);
		}
		
		// Refresh source list
		//yield Zotero.Notifier.trigger('redraw', 'collection', []);
		
		if (errors.length == 1 && errors[0].frontWindowOnly) {
			// Fake an nsISimpleEnumerator with just the topmost window
			var enumerator = {
				_returned: false,
				hasMoreElements: function () {
					return !this._returned;
				},
				getNext: function () {
					if (this._returned) {
						throw ("No more windows to return in Zotero.Sync.Runner.updateIcons()");
					}
					this._returned = true;
					var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
								.getService(Components.interfaces.nsIWindowMediator);
					return wm.getMostRecentWindow("navigator:browser");
				}
			};
		}
		// Update all windows
		else {
			var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
						.getService(Components.interfaces.nsIWindowMediator);
			var enumerator = wm.getEnumerator('navigator:browser');
		}
		
		while (enumerator.hasMoreElements()) {
			var win = enumerator.getNext();
			if (!win.ZoteroPane) continue;
			var doc = win.ZoteroPane.document;
			
			// Update sync error icon
			var icon = doc.getElementById('zotero-tb-sync-error');
			this.updateErrorIcon(icon, state, errors);
			
			// Update sync icon
			var syncIcon = doc.getElementById('zotero-tb-sync');
			if (state == 'animate') {
				syncIcon.setAttribute('status', state);
				// Disable button while spinning
				syncIcon.disabled = true;
			}
			else {
				syncIcon.removeAttribute('status');
				syncIcon.disabled = false;
			}
		}
		
		// Clear status
		this.setSyncStatus();
	}
	
	
	/**
	 * Set the sync icon tooltip message
	 */
	this.setSyncStatus = function (msg) {
		_lastSyncStatus = msg;
		
		// If a label is registered, update it
		if (_currentSyncStatusLabel) {
			_updateSyncStatusLabel();
		}
	}
	
	
	this.parseError = function (e) {
		if (!e) {
			return { parsed: true };
		}
		
		// Already parsed
		if (e.parsed) {
			return e;
		}
		
		e.parsed = true;
		e.errorType = e.errorType ? e.errorType : 'error';
		
		return e;
	}
	
	
	/**
	 * Set the state of the sync error icon and add an onclick to populate
	 * the error panel
	 */
	this.updateErrorIcon = function (icon, state, errors) {
		if (!errors || !errors.length) {
			icon.hidden = true;
			icon.onclick = null;
			return;
		}
		
		icon.hidden = false;
		icon.setAttribute('state', state);
		var self = this;
		icon.onclick = function () {
			var panel = self.updateErrorPanel(this.ownerDocument, errors);
			panel.openPopup(this, "after_end", 16, 0, false, false);
		};
	}
	
	
	this.updateErrorPanel = function (doc, errors) {
		var panel = doc.getElementById('zotero-sync-error-panel');
		
		// Clear existing panel content
		while (panel.hasChildNodes()) {
			panel.removeChild(panel.firstChild);
		}
		
		for (let e of errors) {
			var box = doc.createElement('vbox');
			var label = doc.createElement('label');
			if (e.libraryID !== undefined) {
				label.className = "zotero-sync-error-panel-library-name";
				if (e.libraryID == 0) {
					var libraryName = Zotero.getString('pane.collections.library');
				}
				else {
					let group = Zotero.Groups.getByLibraryID(e.libraryID);
					var libraryName = group.name;
				}
				label.setAttribute('value', libraryName);
			}
			var content = doc.createElement('hbox');
			var buttons = doc.createElement('hbox');
			buttons.pack = 'end';
			box.appendChild(label);
			box.appendChild(content);
			box.appendChild(buttons);
			
			// Show our own error mesages directly
			if (e instanceof Zotero.Error) {
				var msg = e.message;
			}
			// For unexpected ones, just show a generic message
			else {
				// TODO: improve and localize
				var msg = "An error occurred during syncing:\n\n" + e.message;
			}
			
			var desc = doc.createElement('description');
			desc.textContent = msg;
			// Make the text selectable
			desc.setAttribute('style', '-moz-user-select: text; cursor: text');
			content.appendChild(desc);
			
			/*// If not an error and there's no explicit button text, don't show
			// button to report errors
			if (e.errorType != 'error' && e.dialogButtonText === undefined) {
				e.dialogButtonText = null;
			}*/
			
			if (e.dialogButtonText !== null) {
				if (e.dialogButtonText === undefined) {
					var buttonText = Zotero.getString('errorReport.reportError');
					var buttonCallback = function () {
						doc.defaultView.ZoteroPane.reportErrors();
					};
				}
				else {
					var buttonText = e.dialogButtonText;
					var buttonCallback = e.dialogButtonCallback;
				}
				
				var button = doc.createElement('button');
				button.setAttribute('label', buttonText);
				button.onclick = function () {
					buttonCallback();
					panel.hidePopup();
				};
				buttons.appendChild(button);
			}
			
			panel.appendChild(box)
			break;
		}
		
		return panel;
	}
	
	
	/**
	 * Register labels in sync icon tooltip to receive updates
	 *
	 * If no label passed, unregister current label
	 *
	 * @param {Tooltip} [tooltip]
	 */
	this.registerSyncStatus = function (tooltip) {
		if (tooltip) {
			_currentSyncStatusLabel = tooltip.firstChild.nextSibling;
			_currentLastSyncLabel = tooltip.firstChild.nextSibling.nextSibling;
		}
		else {
			_currentSyncStatusLabel = null;
			_currentLastSyncLabel = null;
		}
		if (_currentSyncStatusLabel) {
			_updateSyncStatusLabel();
		}
	}


	this.createAPIKeyFromCredentials = Zotero.Promise.coroutine(function* (username, password) {
		var client = this.getAPIClient();
		var json = yield client.createAPIKeyFromCredentials(username, password);
		if (!json) {
			return false;
		}

		// Sanity check
		if (!json.userID) throw new Error("userID not found in key response");
		if (!json.username) throw new Error("username not found in key response");
		if (!json.access) throw new Error("'access' not found in key response");

		Zotero.Sync.Data.Local.setAPIKey(json.key);

		return json;
	})


	this.deleteAPIKey = Zotero.Promise.coroutine(function* (){
		var apiKey = yield Zotero.Sync.Data.Local.getAPIKey();
		var client = this.getAPIClient({apiKey});
		Zotero.Sync.Data.Local.setAPIKey();
		yield client.deleteAPIKey();
	})

	
	function _updateSyncStatusLabel() {
		if (_lastSyncStatus) {
			_currentSyncStatusLabel.value = _lastSyncStatus;
			_currentSyncStatusLabel.hidden = false;
		}
		else {
			_currentSyncStatusLabel.hidden = true;
		}
		
		// Always update last sync time
		var lastSyncTime = Zotero.Sync.Data.Local.getLastSyncTime();
		if (!lastSyncTime) {
			try {
				lastSyncTime = Zotero.Sync.Data.Local.getLastClassicSyncTime();
			}
			catch (e) {
				Zotero.debug(e, 2);
				Components.utils.reportError(e);
				_currentLastSyncLabel.hidden = true;
				return;
			}
		}
		if (lastSyncTime) {
			var msg = Zotero.Date.toRelativeDate(lastSyncTime);
		}
		// Don't show "Not yet synced" if a sync is in progress
		else if (_syncInProgress) {
			_currentLastSyncLabel.hidden = true;
			return;
		}
		else {
			var msg = Zotero.getString('sync.status.notYetSynced');
		}
		
		_currentLastSyncLabel.value = Zotero.getString('sync.status.lastSync') + " " + msg;
		_currentLastSyncLabel.hidden = false;
	}
	
	
	var _getAPIKey = Zotero.Promise.method(function () {
		// Set as .apiKey on Runner in tests or set in login manager
		return _apiKey || Zotero.Sync.Data.Local.getAPIKey()
	})
}
