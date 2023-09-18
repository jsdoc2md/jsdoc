/*
  Copyright 2023 the JSDoc Authors.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/
import { dirname, join } from 'node:path';

import commonPathPrefix from 'common-path-prefix';
import _ from 'lodash';

function addToSet(targetMap, key, value) {
  if (!targetMap.has(key)) {
    targetMap.set(key, new Set());
  }

  targetMap.get(key).add(value);
}

function diffArrays(value, previousValue = []) {
  return {
    added: _.difference(value, previousValue),
    removed: _.difference(previousValue, value),
  };
}

function getSourcePath({ meta }) {
  return meta.path ? join(meta.path, meta.filename) : meta.filename;
}

function removeFromSet(targetMap, key, value) {
  const set = targetMap.get(key);

  if (set) {
    set.delete(value);
    // If the set is now empty, delete it from the map.
    if (set.size === 0) {
      targetMap.delete(key);
    }
  }
}

export class DocletStore {
  #commonPathPrefix;
  #docletChangedHandler;
  #eventBus;
  #newDocletHandler;
  #sourcePaths;

  static #propertiesWithMaps = ['kind', 'longname', 'memberof'];
  static #propertyToMapName = new Map(
    DocletStore.#propertiesWithMaps.map((prop) => {
      return [prop, 'docletsBy' + _.capitalize(prop)];
    })
  );

  static #propertiesWithSets = ['augments', 'borrowed', 'implements', 'mixes'];
  static #propertyToSetName = new Map(
    DocletStore.#propertiesWithSets.map((prop) => {
      return [prop, 'docletsWith' + _.capitalize(prop)];
    })
  );

  constructor(dependencies) {
    this.#commonPathPrefix = null;
    this.#eventBus = dependencies.get('eventBus');
    this.#sourcePaths = new Map();

    /** Doclets that are used to generate output. */
    this.doclets = new Set();
    /** @type Map<string, Set<Doclet>> */
    this.docletsByKind = new Map();
    /** @type Map<string, Set<Doclet>> */
    this.docletsByLongname = new Map();
    /** @type Map<string, Set<Doclet>> */
    this.docletsByMemberof = new Map();
    /** @type Map<string, Set<Doclet>> */
    this.docletsByNodeId = new Map();
    this.docletsWithAugments = new Set();
    this.docletsWithBorrowed = new Set();
    this.docletsWithImplements = new Set();
    this.docletsWithMixes = new Set();
    this.globals = new Set();
    /** @type Map<string, Set<Doclet>> */
    this.listenersByListensTo = new Map();

    /** Doclets that aren't used to generate output. */
    this.unusedDoclets = new Set();

    this.#docletChangedHandler = (e) => this.#handleDocletChanged(e, {});
    this.#newDocletHandler = (e) => this.#handleDocletChanged(e, { newDoclet: true });
    this.#eventBus.on('docletChanged', this.#docletChangedHandler);
    this.#eventBus.on('newDoclet', this.#newDocletHandler);
  }

  #handleDocletChanged({ doclet, property, oldValue, newValue }, opts) {
    const isVisible = doclet.isVisible();
    const newDoclet = opts.newDoclet ?? false;
    const wasVisible = newDoclet ? false : this.doclets.has(doclet);
    const visibilityChanged = (() => {
      return newDoclet || (!wasVisible && isVisible) || (wasVisible && !isVisible);
    })();
    const docletInfo = {
      isGlobal: doclet.isGlobal(),
      isVisible,
      newDoclet,
      newValue,
      oldValue,
      setFnName: isVisible ? 'add' : 'delete',
      visibilityChanged,
      wasVisible,
    };

    if (newDoclet) {
      this.#trackDocletByNodeId(doclet);
    }

    if (visibilityChanged) {
      this.#toggleVisibility(doclet, docletInfo);
    }

    // In the following cases, there's nothing more to do:
    //
    // + The doclet isn't visible, and we're seeing it for the first time.
    // + The doclet isn't visible, and its visibility didn't change.
    if (!isVisible && (newDoclet || !visibilityChanged)) {
      return;
    }

    // Update all watchable properties.
    this.#updateWatchableProperties(doclet, property, docletInfo);

    // Update list of source paths for visible doclets.
    if (visibilityChanged) {
      this.#updateSourcePaths(doclet, docletInfo);
    }
  }

  #toggleGlobal(doclet, { isGlobal, isVisible }) {
    if (isGlobal && isVisible) {
      this.globals.add(doclet);
    } else {
      this.globals.delete(doclet);
    }
  }

  #toggleVisibility(doclet, { isVisible, setFnName }) {
    this.doclets[setFnName](doclet);
    this.unusedDoclets[isVisible ? 'delete' : 'add'](doclet);
  }

  #trackDocletByNodeId(doclet) {
    const nodeId = doclet.meta?.code?.node?.nodeId;

    if (nodeId) {
      addToSet(this.docletsByNodeId, nodeId, doclet);
    }
  }

  #updateMapProperty(prop, oldKey, newKey, doclet, { isVisible, newDoclet, wasVisible }) {
    const map = this[DocletStore.#propertyToMapName.get(prop)];

    // For `newDoclet` events, there's no "new key"; just use the one from the doclet.
    if (newDoclet) {
      newKey = doclet[prop];
    }

    if (wasVisible && oldKey) {
      removeFromSet(map, oldKey, doclet);
    }
    if (isVisible && newKey) {
      addToSet(map, newKey, doclet);
    }
  }

  #updateSetProperty(prop, value, setFnName) {
    const set = this[DocletStore.#propertyToSetName.get(prop)];

    if (Object.hasOwn(value, prop) && value[prop]?.length) {
      set[setFnName](value);
    } else {
      set.delete(value);
    }
  }

  #updateSourcePaths(doclet, { isVisible }) {
    const sourcePath = getSourcePath(doclet);

    if (!sourcePath || !isVisible) {
      this.#sourcePaths.delete(doclet);
    } else if (sourcePath) {
      this.#sourcePaths.set(doclet, sourcePath);
    }

    // Invalidate the cached common prefix for source paths.
    this.#commonPathPrefix = null;
  }

  #updateWatchableProperties(doclet, property, docletInfo) {
    const {
      isGlobal,
      isVisible,
      newDoclet,
      newValue,
      oldValue,
      setFnName,
      visibilityChanged,
      wasVisible,
    } = docletInfo;

    // `access` only affects visibility, which is handled above, so we ignore it here.
    if (visibilityChanged || property === 'augments') {
      this.#updateSetProperty('augments', doclet, setFnName);
    }
    if (visibilityChanged || property === 'borrowed') {
      this.#updateSetProperty('borrowed', doclet, setFnName);
    }
    // `ignore` only affects visibility, which is handled above, so we ignore it here.
    if (visibilityChanged || property === 'implements') {
      this.#updateSetProperty('implements', doclet, setFnName);
    }
    if (visibilityChanged || property === 'kind') {
      this.#toggleGlobal(doclet, { isGlobal, isVisible });
      this.#updateMapProperty('kind', oldValue, newValue, doclet, docletInfo);
    }
    if (visibilityChanged || property === 'listens') {
      let added;
      let diff;
      let removed;

      if (newDoclet) {
        added = doclet.listens;
        removed = [];
      } else {
        diff = diffArrays(newValue, oldValue);
        added = diff.added;
        removed = diff.removed;
      }

      if (added && isVisible) {
        added.forEach((listensTo) => addToSet(this.listenersByListensTo, listensTo, doclet));
      }
      if (removed && wasVisible) {
        removed.forEach((listensTo) => removeFromSet(this.listenersByListensTo, listensTo, doclet));
      }
    }
    if (visibilityChanged || property === 'longname') {
      this.#updateMapProperty('longname', oldValue, newValue, doclet, docletInfo);
    }
    if (visibilityChanged || property === 'memberof') {
      this.#updateMapProperty('memberof', oldValue, newValue, doclet, docletInfo);
    }
    if (visibilityChanged || property === 'mixes') {
      this.#updateSetProperty('mixes', doclet, setFnName);
    }
    if (visibilityChanged || property === 'scope') {
      this.#toggleGlobal(doclet, { isGlobal, isVisible });
    }
    // `undocumented` only affects visibility, which is handled above, so we ignore it here.
  }

  _removeListeners() {
    this.#eventBus.removeListener('docletChanged', this.#docletChangedHandler);
    this.#eventBus.removeListener('newDoclet', this.#newDocletHandler);
  }

  get commonPathPrefix() {
    let commonPrefix = '';
    const sourcePaths = this.sourcePaths;

    if (this.#commonPathPrefix !== null) {
      return this.#commonPathPrefix;
    }

    if (sourcePaths.length === 1) {
      // If there's only one filepath, then the common prefix is just its dirname.
      commonPrefix = dirname(sourcePaths[0]);
    } else if (sourcePaths.length > 1) {
      // Remove the trailing slash if present.
      commonPrefix = commonPathPrefix(sourcePaths).replace(/[\\/]$/, '');
    }

    this.#commonPathPrefix = commonPrefix;

    return commonPrefix;
  }

  get longnames() {
    return Array.from(this.docletsByLongname.keys());
  }

  get sourcePaths() {
    return Array.from(this.#sourcePaths.values());
  }
}
