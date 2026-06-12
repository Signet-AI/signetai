// src/index.ts
import {
  existsSync as existsSync2,
  lstatSync as lstatSync2,
  mkdirSync,
  readFileSync as readFileSync2,
  readdirSync,
  readlinkSync,
  rmSync,
  unlinkSync as unlinkSync3,
  writeFileSync as writeFileSync2
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join as join4, relative, resolve as resolve2, sep } from "node:path";

// ../../../libs/connector-base/dist/index.js
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync as unlinkSync2, writeFileSync } from "node:fs";
import { dirname as dirname2, join as join3, resolve } from "node:path";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire as createRequire2 } from "node:module";
import { homedir as homedir3, platform as platform2 } from "node:os";
import { basename, dirname as dirname3, resolve as resolve3 } from "node:path";
import { homedir as homedir7 } from "node:os";
import { existsSync as existsSync12, lstatSync, mkdirSync as mkdirSync8, readdirSync as readdirSync6, symlinkSync, unlinkSync } from "node:fs";
import { join as join12 } from "node:path";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);
var require_identity = __commonJS((exports) => {
  var ALIAS = Symbol.for("yaml.alias");
  var DOC = Symbol.for("yaml.document");
  var MAP = Symbol.for("yaml.map");
  var PAIR = Symbol.for("yaml.pair");
  var SCALAR = Symbol.for("yaml.scalar");
  var SEQ = Symbol.for("yaml.seq");
  var NODE_TYPE = Symbol.for("yaml.node.type");
  var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
  var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
  var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
  var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
  var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
  var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
  function isCollection(node) {
    if (node && typeof node === "object")
      switch (node[NODE_TYPE]) {
        case MAP:
        case SEQ:
          return true;
      }
    return false;
  }
  function isNode(node) {
    if (node && typeof node === "object")
      switch (node[NODE_TYPE]) {
        case ALIAS:
        case MAP:
        case SCALAR:
        case SEQ:
          return true;
      }
    return false;
  }
  var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
  exports.ALIAS = ALIAS;
  exports.DOC = DOC;
  exports.MAP = MAP;
  exports.NODE_TYPE = NODE_TYPE;
  exports.PAIR = PAIR;
  exports.SCALAR = SCALAR;
  exports.SEQ = SEQ;
  exports.hasAnchor = hasAnchor;
  exports.isAlias = isAlias;
  exports.isCollection = isCollection;
  exports.isDocument = isDocument;
  exports.isMap = isMap;
  exports.isNode = isNode;
  exports.isPair = isPair;
  exports.isScalar = isScalar;
  exports.isSeq = isSeq;
});
var require_visit = __commonJS((exports) => {
  var identity = require_identity();
  var BREAK = Symbol("break visit");
  var SKIP = Symbol("skip children");
  var REMOVE = Symbol("remove node");
  function visit(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE)
        node.contents = null;
    } else
      visit_(null, node, visitor_, Object.freeze([]));
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  function visit_(key, node, visitor, path) {
    const ctrl = callVisitor(key, node, visitor, path);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path, ctrl);
      return visit_(key, ctrl, visitor, path);
    }
    if (typeof ctrl !== "symbol") {
      if (identity.isCollection(node)) {
        path = Object.freeze(path.concat(node));
        for (let i = 0;i < node.items.length; ++i) {
          const ci = visit_(i, node.items[i], visitor, path);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path = Object.freeze(path.concat(node));
        const ck = visit_("key", node.key, visitor, path);
        if (ck === BREAK)
          return BREAK;
        else if (ck === REMOVE)
          node.key = null;
        const cv = visit_("value", node.value, visitor, path);
        if (cv === BREAK)
          return BREAK;
        else if (cv === REMOVE)
          node.value = null;
      }
    }
    return ctrl;
  }
  async function visitAsync(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE)
        node.contents = null;
    } else
      await visitAsync_(null, node, visitor_, Object.freeze([]));
  }
  visitAsync.BREAK = BREAK;
  visitAsync.SKIP = SKIP;
  visitAsync.REMOVE = REMOVE;
  async function visitAsync_(key, node, visitor, path) {
    const ctrl = await callVisitor(key, node, visitor, path);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path, ctrl);
      return visitAsync_(key, ctrl, visitor, path);
    }
    if (typeof ctrl !== "symbol") {
      if (identity.isCollection(node)) {
        path = Object.freeze(path.concat(node));
        for (let i = 0;i < node.items.length; ++i) {
          const ci = await visitAsync_(i, node.items[i], visitor, path);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path = Object.freeze(path.concat(node));
        const ck = await visitAsync_("key", node.key, visitor, path);
        if (ck === BREAK)
          return BREAK;
        else if (ck === REMOVE)
          node.key = null;
        const cv = await visitAsync_("value", node.value, visitor, path);
        if (cv === BREAK)
          return BREAK;
        else if (cv === REMOVE)
          node.value = null;
      }
    }
    return ctrl;
  }
  function initVisitor(visitor) {
    if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
      return Object.assign({
        Alias: visitor.Node,
        Map: visitor.Node,
        Scalar: visitor.Node,
        Seq: visitor.Node
      }, visitor.Value && {
        Map: visitor.Value,
        Scalar: visitor.Value,
        Seq: visitor.Value
      }, visitor.Collection && {
        Map: visitor.Collection,
        Seq: visitor.Collection
      }, visitor);
    }
    return visitor;
  }
  function callVisitor(key, node, visitor, path) {
    if (typeof visitor === "function")
      return visitor(key, node, path);
    if (identity.isMap(node))
      return visitor.Map?.(key, node, path);
    if (identity.isSeq(node))
      return visitor.Seq?.(key, node, path);
    if (identity.isPair(node))
      return visitor.Pair?.(key, node, path);
    if (identity.isScalar(node))
      return visitor.Scalar?.(key, node, path);
    if (identity.isAlias(node))
      return visitor.Alias?.(key, node, path);
    return;
  }
  function replaceNode(key, path, node) {
    const parent = path[path.length - 1];
    if (identity.isCollection(parent)) {
      parent.items[key] = node;
    } else if (identity.isPair(parent)) {
      if (key === "key")
        parent.key = node;
      else
        parent.value = node;
    } else if (identity.isDocument(parent)) {
      parent.contents = node;
    } else {
      const pt = identity.isAlias(parent) ? "alias" : "scalar";
      throw new Error(`Cannot replace node with ${pt} parent`);
    }
  }
  exports.visit = visit;
  exports.visitAsync = visitAsync;
});
var require_directives = __commonJS((exports) => {
  var identity = require_identity();
  var visit = require_visit();
  var escapeChars = {
    "!": "%21",
    ",": "%2C",
    "[": "%5B",
    "]": "%5D",
    "{": "%7B",
    "}": "%7D"
  };
  var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);

  class Directives {
    constructor(yaml, tags) {
      this.docStart = null;
      this.docEnd = false;
      this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
      this.tags = Object.assign({}, Directives.defaultTags, tags);
    }
    clone() {
      const copy = new Directives(this.yaml, this.tags);
      copy.docStart = this.docStart;
      return copy;
    }
    atDocument() {
      const res = new Directives(this.yaml, this.tags);
      switch (this.yaml.version) {
        case "1.1":
          this.atNextDocument = true;
          break;
        case "1.2":
          this.atNextDocument = false;
          this.yaml = {
            explicit: Directives.defaultYaml.explicit,
            version: "1.2"
          };
          this.tags = Object.assign({}, Directives.defaultTags);
          break;
      }
      return res;
    }
    add(line, onError) {
      if (this.atNextDocument) {
        this.yaml = { explicit: Directives.defaultYaml.explicit, version: "1.1" };
        this.tags = Object.assign({}, Directives.defaultTags);
        this.atNextDocument = false;
      }
      const parts = line.trim().split(/[ \t]+/);
      const name = parts.shift();
      switch (name) {
        case "%TAG": {
          if (parts.length !== 2) {
            onError(0, "%TAG directive should contain exactly two parts");
            if (parts.length < 2)
              return false;
          }
          const [handle, prefix] = parts;
          this.tags[handle] = prefix;
          return true;
        }
        case "%YAML": {
          this.yaml.explicit = true;
          if (parts.length !== 1) {
            onError(0, "%YAML directive should contain exactly one part");
            return false;
          }
          const [version] = parts;
          if (version === "1.1" || version === "1.2") {
            this.yaml.version = version;
            return true;
          } else {
            const isValid = /^\d+\.\d+$/.test(version);
            onError(6, `Unsupported YAML version ${version}`, isValid);
            return false;
          }
        }
        default:
          onError(0, `Unknown directive ${name}`, true);
          return false;
      }
    }
    tagName(source, onError) {
      if (source === "!")
        return "!";
      if (source[0] !== "!") {
        onError(`Not a valid tag: ${source}`);
        return null;
      }
      if (source[1] === "<") {
        const verbatim = source.slice(2, -1);
        if (verbatim === "!" || verbatim === "!!") {
          onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
          return null;
        }
        if (source[source.length - 1] !== ">")
          onError("Verbatim tags must end with a >");
        return verbatim;
      }
      const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
      if (!suffix)
        onError(`The ${source} tag has no suffix`);
      const prefix = this.tags[handle];
      if (prefix) {
        try {
          return prefix + decodeURIComponent(suffix);
        } catch (error) {
          onError(String(error));
          return null;
        }
      }
      if (handle === "!")
        return source;
      onError(`Could not resolve tag: ${source}`);
      return null;
    }
    tagString(tag) {
      for (const [handle, prefix] of Object.entries(this.tags)) {
        if (tag.startsWith(prefix))
          return handle + escapeTagName(tag.substring(prefix.length));
      }
      return tag[0] === "!" ? tag : `!<${tag}>`;
    }
    toString(doc) {
      const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
      const tagEntries = Object.entries(this.tags);
      let tagNames;
      if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
        const tags = {};
        visit.visit(doc.contents, (_key, node) => {
          if (identity.isNode(node) && node.tag)
            tags[node.tag] = true;
        });
        tagNames = Object.keys(tags);
      } else
        tagNames = [];
      for (const [handle, prefix] of tagEntries) {
        if (handle === "!!" && prefix === "tag:yaml.org,2002:")
          continue;
        if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
          lines.push(`%TAG ${handle} ${prefix}`);
      }
      return lines.join(`
`);
    }
  }
  Directives.defaultYaml = { explicit: false, version: "1.2" };
  Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
  exports.Directives = Directives;
});
var require_anchors = __commonJS((exports) => {
  var identity = require_identity();
  var visit = require_visit();
  function anchorIsValid(anchor) {
    if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
      const sa = JSON.stringify(anchor);
      const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
      throw new Error(msg);
    }
    return true;
  }
  function anchorNames(root) {
    const anchors = new Set;
    visit.visit(root, {
      Value(_key, node) {
        if (node.anchor)
          anchors.add(node.anchor);
      }
    });
    return anchors;
  }
  function findNewAnchor(prefix, exclude) {
    for (let i = 1;; ++i) {
      const name = `${prefix}${i}`;
      if (!exclude.has(name))
        return name;
    }
  }
  function createNodeAnchors(doc, prefix) {
    const aliasObjects = [];
    const sourceObjects = new Map;
    let prevAnchors = null;
    return {
      onAnchor: (source) => {
        aliasObjects.push(source);
        prevAnchors ?? (prevAnchors = anchorNames(doc));
        const anchor = findNewAnchor(prefix, prevAnchors);
        prevAnchors.add(anchor);
        return anchor;
      },
      setAnchors: () => {
        for (const source of aliasObjects) {
          const ref = sourceObjects.get(source);
          if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
            ref.node.anchor = ref.anchor;
          } else {
            const error = new Error("Failed to resolve repeated object (this should not happen)");
            error.source = source;
            throw error;
          }
        }
      },
      sourceObjects
    };
  }
  exports.anchorIsValid = anchorIsValid;
  exports.anchorNames = anchorNames;
  exports.createNodeAnchors = createNodeAnchors;
  exports.findNewAnchor = findNewAnchor;
});
var require_applyReviver = __commonJS((exports) => {
  function applyReviver(reviver, obj, key, val) {
    if (val && typeof val === "object") {
      if (Array.isArray(val)) {
        for (let i = 0, len = val.length;i < len; ++i) {
          const v0 = val[i];
          const v1 = applyReviver(reviver, val, String(i), v0);
          if (v1 === undefined)
            delete val[i];
          else if (v1 !== v0)
            val[i] = v1;
        }
      } else if (val instanceof Map) {
        for (const k of Array.from(val.keys())) {
          const v0 = val.get(k);
          const v1 = applyReviver(reviver, val, k, v0);
          if (v1 === undefined)
            val.delete(k);
          else if (v1 !== v0)
            val.set(k, v1);
        }
      } else if (val instanceof Set) {
        for (const v0 of Array.from(val)) {
          const v1 = applyReviver(reviver, val, v0, v0);
          if (v1 === undefined)
            val.delete(v0);
          else if (v1 !== v0) {
            val.delete(v0);
            val.add(v1);
          }
        }
      } else {
        for (const [k, v0] of Object.entries(val)) {
          const v1 = applyReviver(reviver, val, k, v0);
          if (v1 === undefined)
            delete val[k];
          else if (v1 !== v0)
            val[k] = v1;
        }
      }
    }
    return reviver.call(obj, key, val);
  }
  exports.applyReviver = applyReviver;
});
var require_toJS = __commonJS((exports) => {
  var identity = require_identity();
  function toJS(value, arg, ctx) {
    if (Array.isArray(value))
      return value.map((v, i) => toJS(v, String(i), ctx));
    if (value && typeof value.toJSON === "function") {
      if (!ctx || !identity.hasAnchor(value))
        return value.toJSON(arg, ctx);
      const data = { aliasCount: 0, count: 1, res: undefined };
      ctx.anchors.set(value, data);
      ctx.onCreate = (res2) => {
        data.res = res2;
        delete ctx.onCreate;
      };
      const res = value.toJSON(arg, ctx);
      if (ctx.onCreate)
        ctx.onCreate(res);
      return res;
    }
    if (typeof value === "bigint" && !ctx?.keep)
      return Number(value);
    return value;
  }
  exports.toJS = toJS;
});
var require_Node = __commonJS((exports) => {
  var applyReviver = require_applyReviver();
  var identity = require_identity();
  var toJS = require_toJS();

  class NodeBase {
    constructor(type) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: type });
    }
    clone() {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      if (!identity.isDocument(doc))
        throw new TypeError("A document argument is required");
      const ctx = {
        anchors: new Map,
        doc,
        keep: true,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
      };
      const res = toJS.toJS(this, "", ctx);
      if (typeof onAnchor === "function")
        for (const { count, res: res2 } of ctx.anchors.values())
          onAnchor(res2, count);
      return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
    }
  }
  exports.NodeBase = NodeBase;
});
var require_Alias = __commonJS((exports) => {
  var anchors = require_anchors();
  var visit = require_visit();
  var identity = require_identity();
  var Node = require_Node();
  var toJS = require_toJS();

  class Alias extends Node.NodeBase {
    constructor(source) {
      super(identity.ALIAS);
      this.source = source;
      Object.defineProperty(this, "tag", {
        set() {
          throw new Error("Alias nodes cannot have tags");
        }
      });
    }
    resolve(doc, ctx) {
      let nodes;
      if (ctx?.aliasResolveCache) {
        nodes = ctx.aliasResolveCache;
      } else {
        nodes = [];
        visit.visit(doc, {
          Node: (_key, node) => {
            if (identity.isAlias(node) || identity.hasAnchor(node))
              nodes.push(node);
          }
        });
        if (ctx)
          ctx.aliasResolveCache = nodes;
      }
      let found = undefined;
      for (const node of nodes) {
        if (node === this)
          break;
        if (node.anchor === this.source)
          found = node;
      }
      return found;
    }
    toJSON(_arg, ctx) {
      if (!ctx)
        return { source: this.source };
      const { anchors: anchors2, doc, maxAliasCount } = ctx;
      const source = this.resolve(doc, ctx);
      if (!source) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new ReferenceError(msg);
      }
      let data = anchors2.get(source);
      if (!data) {
        toJS.toJS(source, null, ctx);
        data = anchors2.get(source);
      }
      if (data?.res === undefined) {
        const msg = "This should not happen: Alias anchor was not resolved?";
        throw new ReferenceError(msg);
      }
      if (maxAliasCount >= 0) {
        data.count += 1;
        if (data.aliasCount === 0)
          data.aliasCount = getAliasCount(doc, source, anchors2);
        if (data.count * data.aliasCount > maxAliasCount) {
          const msg = "Excessive alias count indicates a resource exhaustion attack";
          throw new ReferenceError(msg);
        }
      }
      return data.res;
    }
    toString(ctx, _onComment, _onChompKeep) {
      const src = `*${this.source}`;
      if (ctx) {
        anchors.anchorIsValid(this.source);
        if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new Error(msg);
        }
        if (ctx.implicitKey)
          return `${src} `;
      }
      return src;
    }
  }
  function getAliasCount(doc, node, anchors2) {
    if (identity.isAlias(node)) {
      const source = node.resolve(doc);
      const anchor = anchors2 && source && anchors2.get(source);
      return anchor ? anchor.count * anchor.aliasCount : 0;
    } else if (identity.isCollection(node)) {
      let count = 0;
      for (const item of node.items) {
        const c = getAliasCount(doc, item, anchors2);
        if (c > count)
          count = c;
      }
      return count;
    } else if (identity.isPair(node)) {
      const kc = getAliasCount(doc, node.key, anchors2);
      const vc = getAliasCount(doc, node.value, anchors2);
      return Math.max(kc, vc);
    }
    return 1;
  }
  exports.Alias = Alias;
});
var require_Scalar = __commonJS((exports) => {
  var identity = require_identity();
  var Node = require_Node();
  var toJS = require_toJS();
  var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";

  class Scalar extends Node.NodeBase {
    constructor(value) {
      super(identity.SCALAR);
      this.value = value;
    }
    toJSON(arg, ctx) {
      return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
    }
    toString() {
      return String(this.value);
    }
  }
  Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
  Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
  Scalar.PLAIN = "PLAIN";
  Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
  Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
  exports.Scalar = Scalar;
  exports.isScalarValue = isScalarValue;
});
var require_createNode = __commonJS((exports) => {
  var Alias = require_Alias();
  var identity = require_identity();
  var Scalar = require_Scalar();
  var defaultTagPrefix = "tag:yaml.org,2002:";
  function findTagObject(value, tagName, tags) {
    if (tagName) {
      const match = tags.filter((t) => t.tag === tagName);
      const tagObj = match.find((t) => !t.format) ?? match[0];
      if (!tagObj)
        throw new Error(`Tag ${tagName} not found`);
      return tagObj;
    }
    return tags.find((t) => t.identify?.(value) && !t.format);
  }
  function createNode(value, tagName, ctx) {
    if (identity.isDocument(value))
      value = value.contents;
    if (identity.isNode(value))
      return value;
    if (identity.isPair(value)) {
      const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
      map.items.push(value);
      return map;
    }
    if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
      value = value.valueOf();
    }
    const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
    let ref = undefined;
    if (aliasDuplicateObjects && value && typeof value === "object") {
      ref = sourceObjects.get(value);
      if (ref) {
        ref.anchor ?? (ref.anchor = onAnchor(value));
        return new Alias.Alias(ref.anchor);
      } else {
        ref = { anchor: null, node: null };
        sourceObjects.set(value, ref);
      }
    }
    if (tagName?.startsWith("!!"))
      tagName = defaultTagPrefix + tagName.slice(2);
    let tagObj = findTagObject(value, tagName, schema.tags);
    if (!tagObj) {
      if (value && typeof value.toJSON === "function") {
        value = value.toJSON();
      }
      if (!value || typeof value !== "object") {
        const node2 = new Scalar.Scalar(value);
        if (ref)
          ref.node = node2;
        return node2;
      }
      tagObj = value instanceof Map ? schema[identity.MAP] : (Symbol.iterator in Object(value)) ? schema[identity.SEQ] : schema[identity.MAP];
    }
    if (onTagObj) {
      onTagObj(tagObj);
      delete ctx.onTagObj;
    }
    const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
    if (tagName)
      node.tag = tagName;
    else if (!tagObj.default)
      node.tag = tagObj.tag;
    if (ref)
      ref.node = node;
    return node;
  }
  exports.createNode = createNode;
});
var require_Collection = __commonJS((exports) => {
  var createNode = require_createNode();
  var identity = require_identity();
  var Node = require_Node();
  function collectionFromPath(schema, path, value) {
    let v = value;
    for (let i = path.length - 1;i >= 0; --i) {
      const k = path[i];
      if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
        const a = [];
        a[k] = v;
        v = a;
      } else {
        v = new Map([[k, v]]);
      }
    }
    return createNode.createNode(v, undefined, {
      aliasDuplicateObjects: false,
      keepUndefined: false,
      onAnchor: () => {
        throw new Error("This should not happen, please report a bug.");
      },
      schema,
      sourceObjects: new Map
    });
  }
  var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;

  class Collection extends Node.NodeBase {
    constructor(type, schema) {
      super(type);
      Object.defineProperty(this, "schema", {
        value: schema,
        configurable: true,
        enumerable: false,
        writable: true
      });
    }
    clone(schema) {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (schema)
        copy.schema = schema;
      copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    addIn(path, value) {
      if (isEmptyPath(path))
        this.add(value);
      else {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (identity.isCollection(node))
          node.addIn(rest, value);
        else if (node === undefined && this.schema)
          this.set(key, collectionFromPath(this.schema, rest, value));
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
    deleteIn(path) {
      const [key, ...rest] = path;
      if (rest.length === 0)
        return this.delete(key);
      const node = this.get(key, true);
      if (identity.isCollection(node))
        return node.deleteIn(rest);
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
    getIn(path, keepScalar) {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (rest.length === 0)
        return !keepScalar && identity.isScalar(node) ? node.value : node;
      else
        return identity.isCollection(node) ? node.getIn(rest, keepScalar) : undefined;
    }
    hasAllNullValues(allowScalar) {
      return this.items.every((node) => {
        if (!identity.isPair(node))
          return false;
        const n = node.value;
        return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
      });
    }
    hasIn(path) {
      const [key, ...rest] = path;
      if (rest.length === 0)
        return this.has(key);
      const node = this.get(key, true);
      return identity.isCollection(node) ? node.hasIn(rest) : false;
    }
    setIn(path, value) {
      const [key, ...rest] = path;
      if (rest.length === 0) {
        this.set(key, value);
      } else {
        const node = this.get(key, true);
        if (identity.isCollection(node))
          node.setIn(rest, value);
        else if (node === undefined && this.schema)
          this.set(key, collectionFromPath(this.schema, rest, value));
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
  }
  exports.Collection = Collection;
  exports.collectionFromPath = collectionFromPath;
  exports.isEmptyPath = isEmptyPath;
});
var require_stringifyComment = __commonJS((exports) => {
  var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
  function indentComment(comment, indent) {
    if (/^\n+$/.test(comment))
      return comment.substring(1);
    return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
  }
  var lineComment = (str, indent, comment) => str.endsWith(`
`) ? indentComment(comment, indent) : comment.includes(`
`) ? `
` + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
  exports.indentComment = indentComment;
  exports.lineComment = lineComment;
  exports.stringifyComment = stringifyComment;
});
var require_foldFlowLines = __commonJS((exports) => {
  var FOLD_FLOW = "flow";
  var FOLD_BLOCK = "block";
  var FOLD_QUOTED = "quoted";
  function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
    if (!lineWidth || lineWidth < 0)
      return text;
    if (lineWidth < minContentWidth)
      minContentWidth = 0;
    const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
    if (text.length <= endStep)
      return text;
    const folds = [];
    const escapedFolds = {};
    let end = lineWidth - indent.length;
    if (typeof indentAtStart === "number") {
      if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
        folds.push(0);
      else
        end = lineWidth - indentAtStart;
    }
    let split = undefined;
    let prev = undefined;
    let overflow = false;
    let i = -1;
    let escStart = -1;
    let escEnd = -1;
    if (mode === FOLD_BLOCK) {
      i = consumeMoreIndentedLines(text, i, indent.length);
      if (i !== -1)
        end = i + endStep;
    }
    for (let ch;ch = text[i += 1]; ) {
      if (mode === FOLD_QUOTED && ch === "\\") {
        escStart = i;
        switch (text[i + 1]) {
          case "x":
            i += 3;
            break;
          case "u":
            i += 5;
            break;
          case "U":
            i += 9;
            break;
          default:
            i += 1;
        }
        escEnd = i;
      }
      if (ch === `
`) {
        if (mode === FOLD_BLOCK)
          i = consumeMoreIndentedLines(text, i, indent.length);
        end = i + indent.length + endStep;
        split = undefined;
      } else {
        if (ch === " " && prev && prev !== " " && prev !== `
` && prev !== "\t") {
          const next = text[i + 1];
          if (next && next !== " " && next !== `
` && next !== "\t")
            split = i;
        }
        if (i >= end) {
          if (split) {
            folds.push(split);
            end = split + endStep;
            split = undefined;
          } else if (mode === FOLD_QUOTED) {
            while (prev === " " || prev === "\t") {
              prev = ch;
              ch = text[i += 1];
              overflow = true;
            }
            const j = i > escEnd + 1 ? i - 2 : escStart - 1;
            if (escapedFolds[j])
              return text;
            folds.push(j);
            escapedFolds[j] = true;
            end = j + endStep;
            split = undefined;
          } else {
            overflow = true;
          }
        }
      }
      prev = ch;
    }
    if (overflow && onOverflow)
      onOverflow();
    if (folds.length === 0)
      return text;
    if (onFold)
      onFold();
    let res = text.slice(0, folds[0]);
    for (let i2 = 0;i2 < folds.length; ++i2) {
      const fold = folds[i2];
      const end2 = folds[i2 + 1] || text.length;
      if (fold === 0)
        res = `
${indent}${text.slice(0, end2)}`;
      else {
        if (mode === FOLD_QUOTED && escapedFolds[fold])
          res += `${text[fold]}\\`;
        res += `
${indent}${text.slice(fold + 1, end2)}`;
      }
    }
    return res;
  }
  function consumeMoreIndentedLines(text, i, indent) {
    let end = i;
    let start = i + 1;
    let ch = text[start];
    while (ch === " " || ch === "\t") {
      if (i < start + indent) {
        ch = text[++i];
      } else {
        do {
          ch = text[++i];
        } while (ch && ch !== `
`);
        end = i;
        start = i + 1;
        ch = text[start];
      }
    }
    return end;
  }
  exports.FOLD_BLOCK = FOLD_BLOCK;
  exports.FOLD_FLOW = FOLD_FLOW;
  exports.FOLD_QUOTED = FOLD_QUOTED;
  exports.foldFlowLines = foldFlowLines;
});
var require_stringifyString = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var foldFlowLines = require_foldFlowLines();
  var getFoldOptions = (ctx, isBlock) => ({
    indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
    lineWidth: ctx.options.lineWidth,
    minContentWidth: ctx.options.minContentWidth
  });
  var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
  function lineLengthOverLimit(str, lineWidth, indentLength) {
    if (!lineWidth || lineWidth < 0)
      return false;
    const limit = lineWidth - indentLength;
    const strLen = str.length;
    if (strLen <= limit)
      return false;
    for (let i = 0, start = 0;i < strLen; ++i) {
      if (str[i] === `
`) {
        if (i - start > limit)
          return true;
        start = i + 1;
        if (strLen - start <= limit)
          return false;
      }
    }
    return true;
  }
  function doubleQuotedString(value, ctx) {
    const json = JSON.stringify(value);
    if (ctx.options.doubleQuotedAsJSON)
      return json;
    const { implicitKey } = ctx;
    const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
    const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
    let str = "";
    let start = 0;
    for (let i = 0, ch = json[i];ch; ch = json[++i]) {
      if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
        str += json.slice(start, i) + "\\ ";
        i += 1;
        start = i;
        ch = "\\";
      }
      if (ch === "\\")
        switch (json[i + 1]) {
          case "u":
            {
              str += json.slice(start, i);
              const code = json.substr(i + 2, 4);
              switch (code) {
                case "0000":
                  str += "\\0";
                  break;
                case "0007":
                  str += "\\a";
                  break;
                case "000b":
                  str += "\\v";
                  break;
                case "001b":
                  str += "\\e";
                  break;
                case "0085":
                  str += "\\N";
                  break;
                case "00a0":
                  str += "\\_";
                  break;
                case "2028":
                  str += "\\L";
                  break;
                case "2029":
                  str += "\\P";
                  break;
                default:
                  if (code.substr(0, 2) === "00")
                    str += "\\x" + code.substr(2);
                  else
                    str += json.substr(i, 6);
              }
              i += 5;
              start = i + 1;
            }
            break;
          case "n":
            if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
              i += 1;
            } else {
              str += json.slice(start, i) + `

`;
              while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                str += `
`;
                i += 2;
              }
              str += indent;
              if (json[i + 2] === " ")
                str += "\\";
              i += 1;
              start = i + 1;
            }
            break;
          default:
            i += 1;
        }
    }
    str = start ? str + json.slice(start) : json;
    return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
  }
  function singleQuotedString(value, ctx) {
    if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes(`
`) || /[ \t]\n|\n[ \t]/.test(value))
      return doubleQuotedString(value, ctx);
    const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
    const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
    return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function quotedString(value, ctx) {
    const { singleQuote } = ctx.options;
    let qs;
    if (singleQuote === false)
      qs = doubleQuotedString;
    else {
      const hasDouble = value.includes('"');
      const hasSingle = value.includes("'");
      if (hasDouble && !hasSingle)
        qs = singleQuotedString;
      else if (hasSingle && !hasDouble)
        qs = doubleQuotedString;
      else
        qs = singleQuote ? singleQuotedString : doubleQuotedString;
    }
    return qs(value, ctx);
  }
  var blockEndNewlines;
  try {
    blockEndNewlines = new RegExp(`(^|(?<!
))
+(?!
|$)`, "g");
  } catch {
    blockEndNewlines = /\n+(?!\n|$)/g;
  }
  function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
    const { blockQuote, commentString, lineWidth } = ctx.options;
    if (!blockQuote || /\n[\t ]+$/.test(value)) {
      return quotedString(value, ctx);
    }
    const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
    const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
    if (!value)
      return literal ? `|
` : `>
`;
    let chomp;
    let endStart;
    for (endStart = value.length;endStart > 0; --endStart) {
      const ch = value[endStart - 1];
      if (ch !== `
` && ch !== "\t" && ch !== " ")
        break;
    }
    let end = value.substring(endStart);
    const endNlPos = end.indexOf(`
`);
    if (endNlPos === -1) {
      chomp = "-";
    } else if (value === end || endNlPos !== end.length - 1) {
      chomp = "+";
      if (onChompKeep)
        onChompKeep();
    } else {
      chomp = "";
    }
    if (end) {
      value = value.slice(0, -end.length);
      if (end[end.length - 1] === `
`)
        end = end.slice(0, -1);
      end = end.replace(blockEndNewlines, `$&${indent}`);
    }
    let startWithSpace = false;
    let startEnd;
    let startNlPos = -1;
    for (startEnd = 0;startEnd < value.length; ++startEnd) {
      const ch = value[startEnd];
      if (ch === " ")
        startWithSpace = true;
      else if (ch === `
`)
        startNlPos = startEnd;
      else
        break;
    }
    let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
    if (start) {
      value = value.substring(start.length);
      start = start.replace(/\n+/g, `$&${indent}`);
    }
    const indentSize = indent ? "2" : "1";
    let header = (startWithSpace ? indentSize : "") + chomp;
    if (comment) {
      header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
      if (onComment)
        onComment();
    }
    if (!literal) {
      const foldedValue = value.replace(/\n+/g, `
$&`).replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
      let literalFallback = false;
      const foldOptions = getFoldOptions(ctx, true);
      if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
        foldOptions.onOverflow = () => {
          literalFallback = true;
        };
      }
      const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
      if (!literalFallback)
        return `>${header}
${indent}${body}`;
    }
    value = value.replace(/\n+/g, `$&${indent}`);
    return `|${header}
${indent}${start}${value}${end}`;
  }
  function plainString(item, ctx, onComment, onChompKeep) {
    const { type, value } = item;
    const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
    if (implicitKey && value.includes(`
`) || inFlow && /[[\]{},]/.test(value)) {
      return quotedString(value, ctx);
    }
    if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
      return implicitKey || inFlow || !value.includes(`
`) ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
    }
    if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes(`
`)) {
      return blockString(item, ctx, onComment, onChompKeep);
    }
    if (containsDocumentMarker(value)) {
      if (indent === "") {
        ctx.forceBlockIndent = true;
        return blockString(item, ctx, onComment, onChompKeep);
      } else if (implicitKey && indent === indentStep) {
        return quotedString(value, ctx);
      }
    }
    const str = value.replace(/\n+/g, `$&
${indent}`);
    if (actualString) {
      const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
      const { compat, tags } = ctx.doc.schema;
      if (tags.some(test) || compat?.some(test))
        return quotedString(value, ctx);
    }
    return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function stringifyString(item, ctx, onComment, onChompKeep) {
    const { implicitKey, inFlow } = ctx;
    const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
    let { type } = item;
    if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
      if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
        type = Scalar.Scalar.QUOTE_DOUBLE;
    }
    const _stringify = (_type) => {
      switch (_type) {
        case Scalar.Scalar.BLOCK_FOLDED:
        case Scalar.Scalar.BLOCK_LITERAL:
          return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
        case Scalar.Scalar.QUOTE_DOUBLE:
          return doubleQuotedString(ss.value, ctx);
        case Scalar.Scalar.QUOTE_SINGLE:
          return singleQuotedString(ss.value, ctx);
        case Scalar.Scalar.PLAIN:
          return plainString(ss, ctx, onComment, onChompKeep);
        default:
          return null;
      }
    };
    let res = _stringify(type);
    if (res === null) {
      const { defaultKeyType, defaultStringType } = ctx.options;
      const t = implicitKey && defaultKeyType || defaultStringType;
      res = _stringify(t);
      if (res === null)
        throw new Error(`Unsupported default string type ${t}`);
    }
    return res;
  }
  exports.stringifyString = stringifyString;
});
var require_stringify = __commonJS((exports) => {
  var anchors = require_anchors();
  var identity = require_identity();
  var stringifyComment = require_stringifyComment();
  var stringifyString = require_stringifyString();
  function createStringifyContext(doc, options) {
    const opt = Object.assign({
      blockQuote: true,
      commentString: stringifyComment.stringifyComment,
      defaultKeyType: null,
      defaultStringType: "PLAIN",
      directives: null,
      doubleQuotedAsJSON: false,
      doubleQuotedMinMultiLineLength: 40,
      falseStr: "false",
      flowCollectionPadding: true,
      indentSeq: true,
      lineWidth: 80,
      minContentWidth: 20,
      nullStr: "null",
      simpleKeys: false,
      singleQuote: null,
      trailingComma: false,
      trueStr: "true",
      verifyAliasOrder: true
    }, doc.schema.toStringOptions, options);
    let inFlow;
    switch (opt.collectionStyle) {
      case "block":
        inFlow = false;
        break;
      case "flow":
        inFlow = true;
        break;
      default:
        inFlow = null;
    }
    return {
      anchors: new Set,
      doc,
      flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
      indent: "",
      indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
      inFlow,
      options: opt
    };
  }
  function getTagObject(tags, item) {
    if (item.tag) {
      const match = tags.filter((t) => t.tag === item.tag);
      if (match.length > 0)
        return match.find((t) => t.format === item.format) ?? match[0];
    }
    let tagObj = undefined;
    let obj;
    if (identity.isScalar(item)) {
      obj = item.value;
      let match = tags.filter((t) => t.identify?.(obj));
      if (match.length > 1) {
        const testMatch = match.filter((t) => t.test);
        if (testMatch.length > 0)
          match = testMatch;
      }
      tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
    } else {
      obj = item;
      tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
    }
    if (!tagObj) {
      const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
      throw new Error(`Tag not resolved for ${name} value`);
    }
    return tagObj;
  }
  function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
    if (!doc.directives)
      return "";
    const props = [];
    const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
    if (anchor && anchors.anchorIsValid(anchor)) {
      anchors$1.add(anchor);
      props.push(`&${anchor}`);
    }
    const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
    if (tag)
      props.push(doc.directives.tagString(tag));
    return props.join(" ");
  }
  function stringify(item, ctx, onComment, onChompKeep) {
    if (identity.isPair(item))
      return item.toString(ctx, onComment, onChompKeep);
    if (identity.isAlias(item)) {
      if (ctx.doc.directives)
        return item.toString(ctx);
      if (ctx.resolvedAliases?.has(item)) {
        throw new TypeError(`Cannot stringify circular structure without alias nodes`);
      } else {
        if (ctx.resolvedAliases)
          ctx.resolvedAliases.add(item);
        else
          ctx.resolvedAliases = new Set([item]);
        item = item.resolve(ctx.doc);
      }
    }
    let tagObj = undefined;
    const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
    tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
    const props = stringifyProps(node, tagObj, ctx);
    if (props.length > 0)
      ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
    const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
    if (!props)
      return str;
    return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
  }
  exports.createStringifyContext = createStringifyContext;
  exports.stringify = stringify;
});
var require_stringifyPair = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
    const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
    let keyComment = identity.isNode(key) && key.comment || null;
    if (simpleKeys) {
      if (keyComment) {
        throw new Error("With simple keys, key nodes cannot have comments");
      }
      if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
        const msg = "With simple keys, collection cannot be used as a key value";
        throw new Error(msg);
      }
    }
    let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
    ctx = Object.assign({}, ctx, {
      allNullValues: false,
      implicitKey: !explicitKey && (simpleKeys || !allNullValues),
      indent: indent + indentStep
    });
    let keyCommentDone = false;
    let chompKeep = false;
    let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
    if (!explicitKey && !ctx.inFlow && str.length > 1024) {
      if (simpleKeys)
        throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
      explicitKey = true;
    }
    if (ctx.inFlow) {
      if (allNullValues || value == null) {
        if (keyCommentDone && onComment)
          onComment();
        return str === "" ? "?" : explicitKey ? `? ${str}` : str;
      }
    } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
      str = `? ${str}`;
      if (keyComment && !keyCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    if (keyCommentDone)
      keyComment = null;
    if (explicitKey) {
      if (keyComment)
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      str = `? ${str}
${indent}:`;
    } else {
      str = `${str}:`;
      if (keyComment)
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
    }
    let vsb, vcb, valueComment;
    if (identity.isNode(value)) {
      vsb = !!value.spaceBefore;
      vcb = value.commentBefore;
      valueComment = value.comment;
    } else {
      vsb = false;
      vcb = null;
      valueComment = null;
      if (value && typeof value === "object")
        value = doc.createNode(value);
    }
    ctx.implicitKey = false;
    if (!explicitKey && !keyComment && identity.isScalar(value))
      ctx.indentAtStart = str.length + 1;
    chompKeep = false;
    if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
      ctx.indent = ctx.indent.substring(2);
    }
    let valueCommentDone = false;
    const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
    let ws = " ";
    if (keyComment || vsb || vcb) {
      ws = vsb ? `
` : "";
      if (vcb) {
        const cs = commentString(vcb);
        ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
      }
      if (valueStr === "" && !ctx.inFlow) {
        if (ws === `
` && valueComment)
          ws = `

`;
      } else {
        ws += `
${ctx.indent}`;
      }
    } else if (!explicitKey && identity.isCollection(value)) {
      const vs0 = valueStr[0];
      const nl0 = valueStr.indexOf(`
`);
      const hasNewline = nl0 !== -1;
      const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
      if (hasNewline || !flow) {
        let hasPropsLine = false;
        if (hasNewline && (vs0 === "&" || vs0 === "!")) {
          let sp0 = valueStr.indexOf(" ");
          if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
            sp0 = valueStr.indexOf(" ", sp0 + 1);
          }
          if (sp0 === -1 || nl0 < sp0)
            hasPropsLine = true;
        }
        if (!hasPropsLine)
          ws = `
${ctx.indent}`;
      }
    } else if (valueStr === "" || valueStr[0] === `
`) {
      ws = "";
    }
    str += ws + valueStr;
    if (ctx.inFlow) {
      if (valueCommentDone && onComment)
        onComment();
    } else if (valueComment && !valueCommentDone) {
      str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
    } else if (chompKeep && onChompKeep) {
      onChompKeep();
    }
    return str;
  }
  exports.stringifyPair = stringifyPair;
});
var require_log = __commonJS((exports) => {
  var node_process = __require("process");
  function debug(logLevel, ...messages) {
    if (logLevel === "debug")
      console.log(...messages);
  }
  function warn(logLevel, warning) {
    if (logLevel === "debug" || logLevel === "warn") {
      if (typeof node_process.emitWarning === "function")
        node_process.emitWarning(warning);
      else
        console.warn(warning);
    }
  }
  exports.debug = debug;
  exports.warn = warn;
});
var require_merge = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var MERGE_KEY = "<<";
  var merge = {
    identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
    default: "key",
    tag: "tag:yaml.org,2002:merge",
    test: /^<<$/,
    resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
      addToJSMap: addMergeToJSMap
    }),
    stringify: () => MERGE_KEY
  };
  var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
  function addMergeToJSMap(ctx, map, value) {
    value = ctx && identity.isAlias(value) ? value.resolve(ctx.doc) : value;
    if (identity.isSeq(value))
      for (const it of value.items)
        mergeValue(ctx, map, it);
    else if (Array.isArray(value))
      for (const it of value)
        mergeValue(ctx, map, it);
    else
      mergeValue(ctx, map, value);
  }
  function mergeValue(ctx, map, value) {
    const source = ctx && identity.isAlias(value) ? value.resolve(ctx.doc) : value;
    if (!identity.isMap(source))
      throw new Error("Merge sources must be maps or map aliases");
    const srcMap = source.toJSON(null, ctx, Map);
    for (const [key, value2] of srcMap) {
      if (map instanceof Map) {
        if (!map.has(key))
          map.set(key, value2);
      } else if (map instanceof Set) {
        map.add(key);
      } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
        Object.defineProperty(map, key, {
          value: value2,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
    }
    return map;
  }
  exports.addMergeToJSMap = addMergeToJSMap;
  exports.isMergeKey = isMergeKey;
  exports.merge = merge;
});
var require_addPairToJSMap = __commonJS((exports) => {
  var log = require_log();
  var merge = require_merge();
  var stringify = require_stringify();
  var identity = require_identity();
  var toJS = require_toJS();
  function addPairToJSMap(ctx, map, { key, value }) {
    if (identity.isNode(key) && key.addToJSMap)
      key.addToJSMap(ctx, map, value);
    else if (merge.isMergeKey(ctx, key))
      merge.addMergeToJSMap(ctx, map, value);
    else {
      const jsKey = toJS.toJS(key, "", ctx);
      if (map instanceof Map) {
        map.set(jsKey, toJS.toJS(value, jsKey, ctx));
      } else if (map instanceof Set) {
        map.add(jsKey);
      } else {
        const stringKey = stringifyKey(key, jsKey, ctx);
        const jsValue = toJS.toJS(value, stringKey, ctx);
        if (stringKey in map)
          Object.defineProperty(map, stringKey, {
            value: jsValue,
            writable: true,
            enumerable: true,
            configurable: true
          });
        else
          map[stringKey] = jsValue;
      }
    }
    return map;
  }
  function stringifyKey(key, jsKey, ctx) {
    if (jsKey === null)
      return "";
    if (typeof jsKey !== "object")
      return String(jsKey);
    if (identity.isNode(key) && ctx?.doc) {
      const strCtx = stringify.createStringifyContext(ctx.doc, {});
      strCtx.anchors = new Set;
      for (const node of ctx.anchors.keys())
        strCtx.anchors.add(node.anchor);
      strCtx.inFlow = true;
      strCtx.inStringifyKey = true;
      const strKey = key.toString(strCtx);
      if (!ctx.mapKeyWarned) {
        let jsonStr = JSON.stringify(strKey);
        if (jsonStr.length > 40)
          jsonStr = jsonStr.substring(0, 36) + '..."';
        log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
        ctx.mapKeyWarned = true;
      }
      return strKey;
    }
    return JSON.stringify(jsKey);
  }
  exports.addPairToJSMap = addPairToJSMap;
});
var require_Pair = __commonJS((exports) => {
  var createNode = require_createNode();
  var stringifyPair = require_stringifyPair();
  var addPairToJSMap = require_addPairToJSMap();
  var identity = require_identity();
  function createPair(key, value, ctx) {
    const k = createNode.createNode(key, undefined, ctx);
    const v = createNode.createNode(value, undefined, ctx);
    return new Pair(k, v);
  }

  class Pair {
    constructor(key, value = null) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
      this.key = key;
      this.value = value;
    }
    clone(schema) {
      let { key, value } = this;
      if (identity.isNode(key))
        key = key.clone(schema);
      if (identity.isNode(value))
        value = value.clone(schema);
      return new Pair(key, value);
    }
    toJSON(_, ctx) {
      const pair = ctx?.mapAsMap ? new Map : {};
      return addPairToJSMap.addPairToJSMap(ctx, pair, this);
    }
    toString(ctx, onComment, onChompKeep) {
      return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
    }
  }
  exports.Pair = Pair;
  exports.createPair = createPair;
});
var require_stringifyCollection = __commonJS((exports) => {
  var identity = require_identity();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyCollection(collection, ctx, options) {
    const flow = ctx.inFlow ?? collection.flow;
    const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
    return stringify2(collection, ctx, options);
  }
  function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
    const { indent, options: { commentString } } = ctx;
    const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
    let chompKeep = false;
    const lines = [];
    for (let i = 0;i < items.length; ++i) {
      const item = items[i];
      let comment2 = null;
      if (identity.isNode(item)) {
        if (!chompKeep && item.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
        if (item.comment)
          comment2 = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (!chompKeep && ik.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
        }
      }
      chompKeep = false;
      let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
      if (comment2)
        str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
      if (chompKeep && comment2)
        chompKeep = false;
      lines.push(blockItemPrefix + str2);
    }
    let str;
    if (lines.length === 0) {
      str = flowChars.start + flowChars.end;
    } else {
      str = lines[0];
      for (let i = 1;i < lines.length; ++i) {
        const line = lines[i];
        str += line ? `
${indent}${line}` : `
`;
      }
    }
    if (comment) {
      str += `
` + stringifyComment.indentComment(commentString(comment), indent);
      if (onComment)
        onComment();
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
    const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
    itemIndent += indentStep;
    const itemCtx = Object.assign({}, ctx, {
      indent: itemIndent,
      inFlow: true,
      type: null
    });
    let reqNewline = false;
    let linesAtValue = 0;
    const lines = [];
    for (let i = 0;i < items.length; ++i) {
      const item = items[i];
      let comment = null;
      if (identity.isNode(item)) {
        if (item.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, item.commentBefore, false);
        if (item.comment)
          comment = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (ik.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, ik.commentBefore, false);
          if (ik.comment)
            reqNewline = true;
        }
        const iv = identity.isNode(item.value) ? item.value : null;
        if (iv) {
          if (iv.comment)
            comment = iv.comment;
          if (iv.commentBefore)
            reqNewline = true;
        } else if (item.value == null && ik?.comment) {
          comment = ik.comment;
        }
      }
      if (comment)
        reqNewline = true;
      let str = stringify.stringify(item, itemCtx, () => comment = null);
      reqNewline || (reqNewline = lines.length > linesAtValue || str.includes(`
`));
      if (i < items.length - 1) {
        str += ",";
      } else if (ctx.options.trailingComma) {
        if (ctx.options.lineWidth > 0) {
          reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
        }
        if (reqNewline) {
          str += ",";
        }
      }
      if (comment)
        str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
      lines.push(str);
      linesAtValue = lines.length;
    }
    const { start, end } = flowChars;
    if (lines.length === 0) {
      return start + end;
    } else {
      if (!reqNewline) {
        const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
        reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
      }
      if (reqNewline) {
        let str = start;
        for (const line of lines)
          str += line ? `
${indentStep}${indent}${line}` : `
`;
        return `${str}
${indent}${end}`;
      } else {
        return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
      }
    }
  }
  function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
    if (comment && chompKeep)
      comment = comment.replace(/^\n+/, "");
    if (comment) {
      const ic = stringifyComment.indentComment(commentString(comment), indent);
      lines.push(ic.trimStart());
    }
  }
  exports.stringifyCollection = stringifyCollection;
});
var require_YAMLMap = __commonJS((exports) => {
  var stringifyCollection = require_stringifyCollection();
  var addPairToJSMap = require_addPairToJSMap();
  var Collection = require_Collection();
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  function findPair(items, key) {
    const k = identity.isScalar(key) ? key.value : key;
    for (const it of items) {
      if (identity.isPair(it)) {
        if (it.key === key || it.key === k)
          return it;
        if (identity.isScalar(it.key) && it.key.value === k)
          return it;
      }
    }
    return;
  }

  class YAMLMap extends Collection.Collection {
    static get tagName() {
      return "tag:yaml.org,2002:map";
    }
    constructor(schema) {
      super(identity.MAP, schema);
      this.items = [];
    }
    static from(schema, obj, ctx) {
      const { keepUndefined, replacer } = ctx;
      const map = new this(schema);
      const add = (key, value) => {
        if (typeof replacer === "function")
          value = replacer.call(obj, key, value);
        else if (Array.isArray(replacer) && !replacer.includes(key))
          return;
        if (value !== undefined || keepUndefined)
          map.items.push(Pair.createPair(key, value, ctx));
      };
      if (obj instanceof Map) {
        for (const [key, value] of obj)
          add(key, value);
      } else if (obj && typeof obj === "object") {
        for (const key of Object.keys(obj))
          add(key, obj[key]);
      }
      if (typeof schema.sortMapEntries === "function") {
        map.items.sort(schema.sortMapEntries);
      }
      return map;
    }
    add(pair, overwrite) {
      let _pair;
      if (identity.isPair(pair))
        _pair = pair;
      else if (!pair || typeof pair !== "object" || !("key" in pair)) {
        _pair = new Pair.Pair(pair, pair?.value);
      } else
        _pair = new Pair.Pair(pair.key, pair.value);
      const prev = findPair(this.items, _pair.key);
      const sortEntries = this.schema?.sortMapEntries;
      if (prev) {
        if (!overwrite)
          throw new Error(`Key ${_pair.key} already set`);
        if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
          prev.value.value = _pair.value;
        else
          prev.value = _pair.value;
      } else if (sortEntries) {
        const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
        if (i === -1)
          this.items.push(_pair);
        else
          this.items.splice(i, 0, _pair);
      } else {
        this.items.push(_pair);
      }
    }
    delete(key) {
      const it = findPair(this.items, key);
      if (!it)
        return false;
      const del = this.items.splice(this.items.indexOf(it), 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const it = findPair(this.items, key);
      const node = it?.value;
      return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? undefined;
    }
    has(key) {
      return !!findPair(this.items, key);
    }
    set(key, value) {
      this.add(new Pair.Pair(key, value), true);
    }
    toJSON(_, ctx, Type) {
      const map = Type ? new Type : ctx?.mapAsMap ? new Map : {};
      if (ctx?.onCreate)
        ctx.onCreate(map);
      for (const item of this.items)
        addPairToJSMap.addPairToJSMap(ctx, map, item);
      return map;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      for (const item of this.items) {
        if (!identity.isPair(item))
          throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
      }
      if (!ctx.allNullValues && this.hasAllNullValues(false))
        ctx = Object.assign({}, ctx, { allNullValues: true });
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: "",
        flowChars: { start: "{", end: "}" },
        itemIndent: ctx.indent || "",
        onChompKeep,
        onComment
      });
    }
  }
  exports.YAMLMap = YAMLMap;
  exports.findPair = findPair;
});
var require_map = __commonJS((exports) => {
  var identity = require_identity();
  var YAMLMap = require_YAMLMap();
  var map = {
    collection: "map",
    default: true,
    nodeClass: YAMLMap.YAMLMap,
    tag: "tag:yaml.org,2002:map",
    resolve(map2, onError) {
      if (!identity.isMap(map2))
        onError("Expected a mapping for this tag");
      return map2;
    },
    createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
  };
  exports.map = map;
});
var require_YAMLSeq = __commonJS((exports) => {
  var createNode = require_createNode();
  var stringifyCollection = require_stringifyCollection();
  var Collection = require_Collection();
  var identity = require_identity();
  var Scalar = require_Scalar();
  var toJS = require_toJS();

  class YAMLSeq extends Collection.Collection {
    static get tagName() {
      return "tag:yaml.org,2002:seq";
    }
    constructor(schema) {
      super(identity.SEQ, schema);
      this.items = [];
    }
    add(value) {
      this.items.push(value);
    }
    delete(key) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        return false;
      const del = this.items.splice(idx, 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        return;
      const it = this.items[idx];
      return !keepScalar && identity.isScalar(it) ? it.value : it;
    }
    has(key) {
      const idx = asItemIndex(key);
      return typeof idx === "number" && idx < this.items.length;
    }
    set(key, value) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        throw new Error(`Expected a valid index, not ${key}.`);
      const prev = this.items[idx];
      if (identity.isScalar(prev) && Scalar.isScalarValue(value))
        prev.value = value;
      else
        this.items[idx] = value;
    }
    toJSON(_, ctx) {
      const seq = [];
      if (ctx?.onCreate)
        ctx.onCreate(seq);
      let i = 0;
      for (const item of this.items)
        seq.push(toJS.toJS(item, String(i++), ctx));
      return seq;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: "- ",
        flowChars: { start: "[", end: "]" },
        itemIndent: (ctx.indent || "") + "  ",
        onChompKeep,
        onComment
      });
    }
    static from(schema, obj, ctx) {
      const { replacer } = ctx;
      const seq = new this(schema);
      if (obj && Symbol.iterator in Object(obj)) {
        let i = 0;
        for (let it of obj) {
          if (typeof replacer === "function") {
            const key = obj instanceof Set ? it : String(i++);
            it = replacer.call(obj, key, it);
          }
          seq.items.push(createNode.createNode(it, undefined, ctx));
        }
      }
      return seq;
    }
  }
  function asItemIndex(key) {
    let idx = identity.isScalar(key) ? key.value : key;
    if (idx && typeof idx === "string")
      idx = Number(idx);
    return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
  }
  exports.YAMLSeq = YAMLSeq;
});
var require_seq = __commonJS((exports) => {
  var identity = require_identity();
  var YAMLSeq = require_YAMLSeq();
  var seq = {
    collection: "seq",
    default: true,
    nodeClass: YAMLSeq.YAMLSeq,
    tag: "tag:yaml.org,2002:seq",
    resolve(seq2, onError) {
      if (!identity.isSeq(seq2))
        onError("Expected a sequence for this tag");
      return seq2;
    },
    createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
  };
  exports.seq = seq;
});
var require_string = __commonJS((exports) => {
  var stringifyString = require_stringifyString();
  var string = {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str,
    stringify(item, ctx, onComment, onChompKeep) {
      ctx = Object.assign({ actualString: true }, ctx);
      return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
    }
  };
  exports.string = string;
});
var require_null = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var nullTag = {
    identify: (value) => value == null,
    createNode: () => new Scalar.Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^(?:~|[Nn]ull|NULL)?$/,
    resolve: () => new Scalar.Scalar(null),
    stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
  };
  exports.nullTag = nullTag;
});
var require_bool = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var boolTag = {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
    resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
    stringify({ source, value }, ctx) {
      if (source && boolTag.test.test(source)) {
        const sv = source[0] === "t" || source[0] === "T";
        if (value === sv)
          return source;
      }
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
  };
  exports.boolTag = boolTag;
});
var require_stringifyNumber = __commonJS((exports) => {
  function stringifyNumber({ format, minFractionDigits, tag, value }) {
    if (typeof value === "bigint")
      return String(value);
    const num = typeof value === "number" ? value : Number(value);
    if (!isFinite(num))
      return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
    let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
    if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^\d/.test(n)) {
      let i = n.indexOf(".");
      if (i < 0) {
        i = n.length;
        n += ".";
      }
      let d = minFractionDigits - (n.length - i - 1);
      while (d-- > 0)
        n += "0";
    }
    return n;
  }
  exports.stringifyNumber = stringifyNumber;
});
var require_float = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var stringifyNumber = require_stringifyNumber();
  var floatNaN = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber
  };
  var floatExp = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "EXP",
    test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
    resolve: (str) => parseFloat(str),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    }
  };
  var float = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str));
      const dot = str.indexOf(".");
      if (dot !== -1 && str[str.length - 1] === "0")
        node.minFractionDigits = str.length - dot - 1;
      return node;
    },
    stringify: stringifyNumber.stringifyNumber
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});
var require_int = __commonJS((exports) => {
  var stringifyNumber = require_stringifyNumber();
  var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
  var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value) && value >= 0)
      return prefix + value.toString(radix);
    return stringifyNumber.stringifyNumber(node);
  }
  var intOct = {
    identify: (value) => intIdentify(value) && value >= 0,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "OCT",
    test: /^0o[0-7]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
    stringify: (node) => intStringify(node, 8, "0o")
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^[-+]?[0-9]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber
  };
  var intHex = {
    identify: (value) => intIdentify(value) && value >= 0,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "HEX",
    test: /^0x[0-9a-fA-F]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: (node) => intStringify(node, 16, "0x")
  };
  exports.int = int;
  exports.intHex = intHex;
  exports.intOct = intOct;
});
var require_schema = __commonJS((exports) => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var bool = require_bool();
  var float = require_float();
  var int = require_int();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.boolTag,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float
  ];
  exports.schema = schema;
});
var require_schema2 = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var map = require_map();
  var seq = require_seq();
  function intIdentify(value) {
    return typeof value === "bigint" || Number.isInteger(value);
  }
  var stringifyJSON = ({ value }) => JSON.stringify(value);
  var jsonScalars = [
    {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify: stringifyJSON
    },
    {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^null$/,
      resolve: () => null,
      stringify: stringifyJSON
    },
    {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^true$|^false$/,
      resolve: (str) => str === "true",
      stringify: stringifyJSON
    },
    {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^-?(?:0|[1-9][0-9]*)$/,
      resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
      stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
    },
    {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
      resolve: (str) => parseFloat(str),
      stringify: stringifyJSON
    }
  ];
  var jsonError = {
    default: true,
    tag: "",
    test: /^/,
    resolve(str, onError) {
      onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
      return str;
    }
  };
  var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
  exports.schema = schema;
});
var require_binary = __commonJS((exports) => {
  var node_buffer = __require("buffer");
  var Scalar = require_Scalar();
  var stringifyString = require_stringifyString();
  var binary = {
    identify: (value) => value instanceof Uint8Array,
    default: false,
    tag: "tag:yaml.org,2002:binary",
    resolve(src, onError) {
      if (typeof node_buffer.Buffer === "function") {
        return node_buffer.Buffer.from(src, "base64");
      } else if (typeof atob === "function") {
        const str = atob(src.replace(/[\n\r]/g, ""));
        const buffer = new Uint8Array(str.length);
        for (let i = 0;i < str.length; ++i)
          buffer[i] = str.charCodeAt(i);
        return buffer;
      } else {
        onError("This environment does not support reading binary tags; either Buffer or atob is required");
        return src;
      }
    },
    stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
      if (!value)
        return "";
      const buf = value;
      let str;
      if (typeof node_buffer.Buffer === "function") {
        str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
      } else if (typeof btoa === "function") {
        let s = "";
        for (let i = 0;i < buf.length; ++i)
          s += String.fromCharCode(buf[i]);
        str = btoa(s);
      } else {
        throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
      }
      type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
        const n = Math.ceil(str.length / lineWidth);
        const lines = new Array(n);
        for (let i = 0, o = 0;i < n; ++i, o += lineWidth) {
          lines[i] = str.substr(o, lineWidth);
        }
        str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? `
` : " ");
      }
      return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
    }
  };
  exports.binary = binary;
});
var require_pairs = __commonJS((exports) => {
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  var YAMLSeq = require_YAMLSeq();
  function resolvePairs(seq, onError) {
    if (identity.isSeq(seq)) {
      for (let i = 0;i < seq.items.length; ++i) {
        let item = seq.items[i];
        if (identity.isPair(item))
          continue;
        else if (identity.isMap(item)) {
          if (item.items.length > 1)
            onError("Each pair must have its own sequence indicator");
          const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
          if (item.commentBefore)
            pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
          if (item.comment) {
            const cn = pair.value ?? pair.key;
            cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
          }
          item = pair;
        }
        seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
      }
    } else
      onError("Expected a sequence for this tag");
    return seq;
  }
  function createPairs(schema, iterable, ctx) {
    const { replacer } = ctx;
    const pairs2 = new YAMLSeq.YAMLSeq(schema);
    pairs2.tag = "tag:yaml.org,2002:pairs";
    let i = 0;
    if (iterable && Symbol.iterator in Object(iterable))
      for (let it of iterable) {
        if (typeof replacer === "function")
          it = replacer.call(iterable, String(i++), it);
        let key, value;
        if (Array.isArray(it)) {
          if (it.length === 2) {
            key = it[0];
            value = it[1];
          } else
            throw new TypeError(`Expected [key, value] tuple: ${it}`);
        } else if (it && it instanceof Object) {
          const keys = Object.keys(it);
          if (keys.length === 1) {
            key = keys[0];
            value = it[key];
          } else {
            throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
          }
        } else {
          key = it;
        }
        pairs2.items.push(Pair.createPair(key, value, ctx));
      }
    return pairs2;
  }
  var pairs = {
    collection: "seq",
    default: false,
    tag: "tag:yaml.org,2002:pairs",
    resolve: resolvePairs,
    createNode: createPairs
  };
  exports.createPairs = createPairs;
  exports.pairs = pairs;
  exports.resolvePairs = resolvePairs;
});
var require_omap = __commonJS((exports) => {
  var identity = require_identity();
  var toJS = require_toJS();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var pairs = require_pairs();

  class YAMLOMap extends YAMLSeq.YAMLSeq {
    constructor() {
      super();
      this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
      this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
      this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
      this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
      this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
      this.tag = YAMLOMap.tag;
    }
    toJSON(_, ctx) {
      if (!ctx)
        return super.toJSON(_);
      const map = new Map;
      if (ctx?.onCreate)
        ctx.onCreate(map);
      for (const pair of this.items) {
        let key, value;
        if (identity.isPair(pair)) {
          key = toJS.toJS(pair.key, "", ctx);
          value = toJS.toJS(pair.value, key, ctx);
        } else {
          key = toJS.toJS(pair, "", ctx);
        }
        if (map.has(key))
          throw new Error("Ordered maps must not include duplicate keys");
        map.set(key, value);
      }
      return map;
    }
    static from(schema, iterable, ctx) {
      const pairs$1 = pairs.createPairs(schema, iterable, ctx);
      const omap2 = new this;
      omap2.items = pairs$1.items;
      return omap2;
    }
  }
  YAMLOMap.tag = "tag:yaml.org,2002:omap";
  var omap = {
    collection: "seq",
    identify: (value) => value instanceof Map,
    nodeClass: YAMLOMap,
    default: false,
    tag: "tag:yaml.org,2002:omap",
    resolve(seq, onError) {
      const pairs$1 = pairs.resolvePairs(seq, onError);
      const seenKeys = [];
      for (const { key } of pairs$1.items) {
        if (identity.isScalar(key)) {
          if (seenKeys.includes(key.value)) {
            onError(`Ordered maps must not include duplicate keys: ${key.value}`);
          } else {
            seenKeys.push(key.value);
          }
        }
      }
      return Object.assign(new YAMLOMap, pairs$1);
    },
    createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
  };
  exports.YAMLOMap = YAMLOMap;
  exports.omap = omap;
});
var require_bool2 = __commonJS((exports) => {
  var Scalar = require_Scalar();
  function boolStringify({ value, source }, ctx) {
    const boolObj = value ? trueTag : falseTag;
    if (source && boolObj.test.test(source))
      return source;
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
  var trueTag = {
    identify: (value) => value === true,
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
    resolve: () => new Scalar.Scalar(true),
    stringify: boolStringify
  };
  var falseTag = {
    identify: (value) => value === false,
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
    resolve: () => new Scalar.Scalar(false),
    stringify: boolStringify
  };
  exports.falseTag = falseTag;
  exports.trueTag = trueTag;
});
var require_float2 = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var stringifyNumber = require_stringifyNumber();
  var floatNaN = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber
  };
  var floatExp = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "EXP",
    test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
    resolve: (str) => parseFloat(str.replace(/_/g, "")),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    }
  };
  var float = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
      const dot = str.indexOf(".");
      if (dot !== -1) {
        const f = str.substring(dot + 1).replace(/_/g, "");
        if (f[f.length - 1] === "0")
          node.minFractionDigits = f.length;
      }
      return node;
    },
    stringify: stringifyNumber.stringifyNumber
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});
var require_int2 = __commonJS((exports) => {
  var stringifyNumber = require_stringifyNumber();
  var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
  function intResolve(str, offset, radix, { intAsBigInt }) {
    const sign = str[0];
    if (sign === "-" || sign === "+")
      offset += 1;
    str = str.substring(offset).replace(/_/g, "");
    if (intAsBigInt) {
      switch (radix) {
        case 2:
          str = `0b${str}`;
          break;
        case 8:
          str = `0o${str}`;
          break;
        case 16:
          str = `0x${str}`;
          break;
      }
      const n2 = BigInt(str);
      return sign === "-" ? BigInt(-1) * n2 : n2;
    }
    const n = parseInt(str, radix);
    return sign === "-" ? -1 * n : n;
  }
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value)) {
      const str = value.toString(radix);
      return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
    }
    return stringifyNumber.stringifyNumber(node);
  }
  var intBin = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "BIN",
    test: /^[-+]?0b[0-1_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
    stringify: (node) => intStringify(node, 2, "0b")
  };
  var intOct = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "OCT",
    test: /^[-+]?0[0-7_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
    stringify: (node) => intStringify(node, 8, "0")
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^[-+]?[0-9][0-9_]*$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber
  };
  var intHex = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "HEX",
    test: /^[-+]?0x[0-9a-fA-F_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: (node) => intStringify(node, 16, "0x")
  };
  exports.int = int;
  exports.intBin = intBin;
  exports.intHex = intHex;
  exports.intOct = intOct;
});
var require_set = __commonJS((exports) => {
  var identity = require_identity();
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();

  class YAMLSet extends YAMLMap.YAMLMap {
    constructor(schema) {
      super(schema);
      this.tag = YAMLSet.tag;
    }
    add(key) {
      let pair;
      if (identity.isPair(key))
        pair = key;
      else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
        pair = new Pair.Pair(key.key, null);
      else
        pair = new Pair.Pair(key, null);
      const prev = YAMLMap.findPair(this.items, pair.key);
      if (!prev)
        this.items.push(pair);
    }
    get(key, keepPair) {
      const pair = YAMLMap.findPair(this.items, key);
      return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
    }
    set(key, value) {
      if (typeof value !== "boolean")
        throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
      const prev = YAMLMap.findPair(this.items, key);
      if (prev && !value) {
        this.items.splice(this.items.indexOf(prev), 1);
      } else if (!prev && value) {
        this.items.push(new Pair.Pair(key));
      }
    }
    toJSON(_, ctx) {
      return super.toJSON(_, ctx, Set);
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      if (this.hasAllNullValues(true))
        return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
      else
        throw new Error("Set items must all have null values");
    }
    static from(schema, iterable, ctx) {
      const { replacer } = ctx;
      const set2 = new this(schema);
      if (iterable && Symbol.iterator in Object(iterable))
        for (let value of iterable) {
          if (typeof replacer === "function")
            value = replacer.call(iterable, value, value);
          set2.items.push(Pair.createPair(value, null, ctx));
        }
      return set2;
    }
  }
  YAMLSet.tag = "tag:yaml.org,2002:set";
  var set = {
    collection: "map",
    identify: (value) => value instanceof Set,
    nodeClass: YAMLSet,
    default: false,
    tag: "tag:yaml.org,2002:set",
    createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
    resolve(map, onError) {
      if (identity.isMap(map)) {
        if (map.hasAllNullValues(true))
          return Object.assign(new YAMLSet, map);
        else
          onError("Set items must all have null values");
      } else
        onError("Expected a mapping for this tag");
      return map;
    }
  };
  exports.YAMLSet = YAMLSet;
  exports.set = set;
});
var require_timestamp = __commonJS((exports) => {
  var stringifyNumber = require_stringifyNumber();
  function parseSexagesimal(str, asBigInt) {
    const sign = str[0];
    const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
    const num = (n) => asBigInt ? BigInt(n) : Number(n);
    const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
    return sign === "-" ? num(-1) * res : res;
  }
  function stringifySexagesimal(node) {
    let { value } = node;
    let num = (n) => n;
    if (typeof value === "bigint")
      num = (n) => BigInt(n);
    else if (isNaN(value) || !isFinite(value))
      return stringifyNumber.stringifyNumber(node);
    let sign = "";
    if (value < 0) {
      sign = "-";
      value *= num(-1);
    }
    const _60 = num(60);
    const parts = [value % _60];
    if (value < 60) {
      parts.unshift(0);
    } else {
      value = (value - parts[0]) / _60;
      parts.unshift(value % _60);
      if (value >= 60) {
        value = (value - parts[0]) / _60;
        parts.unshift(value);
      }
    }
    return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
  }
  var intTime = {
    identify: (value) => typeof value === "bigint" || Number.isInteger(value),
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "TIME",
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
    resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
    stringify: stringifySexagesimal
  };
  var floatTime = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "TIME",
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
    resolve: (str) => parseSexagesimal(str, false),
    stringify: stringifySexagesimal
  };
  var timestamp = {
    identify: (value) => value instanceof Date,
    default: true,
    tag: "tag:yaml.org,2002:timestamp",
    test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})" + "(?:" + "(?:t|T|[ \\t]+)" + "([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)" + "(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?" + ")?$"),
    resolve(str) {
      const match = str.match(timestamp.test);
      if (!match)
        throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
      const [, year, month, day, hour, minute, second] = match.map(Number);
      const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
      let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
      const tz = match[8];
      if (tz && tz !== "Z") {
        let d = parseSexagesimal(tz, false);
        if (Math.abs(d) < 30)
          d *= 60;
        date -= 60000 * d;
      }
      return new Date(date);
    },
    stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
  };
  exports.floatTime = floatTime;
  exports.intTime = intTime;
  exports.timestamp = timestamp;
});
var require_schema3 = __commonJS((exports) => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var binary = require_binary();
  var bool = require_bool2();
  var float = require_float2();
  var int = require_int2();
  var merge = require_merge();
  var omap = require_omap();
  var pairs = require_pairs();
  var set = require_set();
  var timestamp = require_timestamp();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.trueTag,
    bool.falseTag,
    int.intBin,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float,
    binary.binary,
    merge.merge,
    omap.omap,
    pairs.pairs,
    set.set,
    timestamp.intTime,
    timestamp.floatTime,
    timestamp.timestamp
  ];
  exports.schema = schema;
});
var require_tags = __commonJS((exports) => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var bool = require_bool();
  var float = require_float();
  var int = require_int();
  var schema = require_schema();
  var schema$1 = require_schema2();
  var binary = require_binary();
  var merge = require_merge();
  var omap = require_omap();
  var pairs = require_pairs();
  var schema$2 = require_schema3();
  var set = require_set();
  var timestamp = require_timestamp();
  var schemas = new Map([
    ["core", schema.schema],
    ["failsafe", [map.map, seq.seq, string.string]],
    ["json", schema$1.schema],
    ["yaml11", schema$2.schema],
    ["yaml-1.1", schema$2.schema]
  ]);
  var tagsByName = {
    binary: binary.binary,
    bool: bool.boolTag,
    float: float.float,
    floatExp: float.floatExp,
    floatNaN: float.floatNaN,
    floatTime: timestamp.floatTime,
    int: int.int,
    intHex: int.intHex,
    intOct: int.intOct,
    intTime: timestamp.intTime,
    map: map.map,
    merge: merge.merge,
    null: _null.nullTag,
    omap: omap.omap,
    pairs: pairs.pairs,
    seq: seq.seq,
    set: set.set,
    timestamp: timestamp.timestamp
  };
  var coreKnownTags = {
    "tag:yaml.org,2002:binary": binary.binary,
    "tag:yaml.org,2002:merge": merge.merge,
    "tag:yaml.org,2002:omap": omap.omap,
    "tag:yaml.org,2002:pairs": pairs.pairs,
    "tag:yaml.org,2002:set": set.set,
    "tag:yaml.org,2002:timestamp": timestamp.timestamp
  };
  function getTags(customTags, schemaName, addMergeTag) {
    const schemaTags = schemas.get(schemaName);
    if (schemaTags && !customTags) {
      return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
    }
    let tags = schemaTags;
    if (!tags) {
      if (Array.isArray(customTags))
        tags = [];
      else {
        const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
        throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
      }
    }
    if (Array.isArray(customTags)) {
      for (const tag of customTags)
        tags = tags.concat(tag);
    } else if (typeof customTags === "function") {
      tags = customTags(tags.slice());
    }
    if (addMergeTag)
      tags = tags.concat(merge.merge);
    return tags.reduce((tags2, tag) => {
      const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
      if (!tagObj) {
        const tagName = JSON.stringify(tag);
        const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
        throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
      }
      if (!tags2.includes(tagObj))
        tags2.push(tagObj);
      return tags2;
    }, []);
  }
  exports.coreKnownTags = coreKnownTags;
  exports.getTags = getTags;
});
var require_Schema = __commonJS((exports) => {
  var identity = require_identity();
  var map = require_map();
  var seq = require_seq();
  var string = require_string();
  var tags = require_tags();
  var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

  class Schema {
    constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
      this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
      this.name = typeof schema === "string" && schema || "core";
      this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
      this.tags = tags.getTags(customTags, this.name, merge);
      this.toStringOptions = toStringDefaults ?? null;
      Object.defineProperty(this, identity.MAP, { value: map.map });
      Object.defineProperty(this, identity.SCALAR, { value: string.string });
      Object.defineProperty(this, identity.SEQ, { value: seq.seq });
      this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
    }
    clone() {
      const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
      copy.tags = this.tags.slice();
      return copy;
    }
  }
  exports.Schema = Schema;
});
var require_stringifyDocument = __commonJS((exports) => {
  var identity = require_identity();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyDocument(doc, options) {
    const lines = [];
    let hasDirectives = options.directives === true;
    if (options.directives !== false && doc.directives) {
      const dir = doc.directives.toString(doc);
      if (dir) {
        lines.push(dir);
        hasDirectives = true;
      } else if (doc.directives.docStart)
        hasDirectives = true;
    }
    if (hasDirectives)
      lines.push("---");
    const ctx = stringify.createStringifyContext(doc, options);
    const { commentString } = ctx.options;
    if (doc.commentBefore) {
      if (lines.length !== 1)
        lines.unshift("");
      const cs = commentString(doc.commentBefore);
      lines.unshift(stringifyComment.indentComment(cs, ""));
    }
    let chompKeep = false;
    let contentComment = null;
    if (doc.contents) {
      if (identity.isNode(doc.contents)) {
        if (doc.contents.spaceBefore && hasDirectives)
          lines.push("");
        if (doc.contents.commentBefore) {
          const cs = commentString(doc.contents.commentBefore);
          lines.push(stringifyComment.indentComment(cs, ""));
        }
        ctx.forceBlockIndent = !!doc.comment;
        contentComment = doc.contents.comment;
      }
      const onChompKeep = contentComment ? undefined : () => chompKeep = true;
      let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
      if (contentComment)
        body += stringifyComment.lineComment(body, "", commentString(contentComment));
      if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
        lines[lines.length - 1] = `--- ${body}`;
      } else
        lines.push(body);
    } else {
      lines.push(stringify.stringify(doc.contents, ctx));
    }
    if (doc.directives?.docEnd) {
      if (doc.comment) {
        const cs = commentString(doc.comment);
        if (cs.includes(`
`)) {
          lines.push("...");
          lines.push(stringifyComment.indentComment(cs, ""));
        } else {
          lines.push(`... ${cs}`);
        }
      } else {
        lines.push("...");
      }
    } else {
      let dc = doc.comment;
      if (dc && chompKeep)
        dc = dc.replace(/^\n+/, "");
      if (dc) {
        if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
          lines.push("");
        lines.push(stringifyComment.indentComment(commentString(dc), ""));
      }
    }
    return lines.join(`
`) + `
`;
  }
  exports.stringifyDocument = stringifyDocument;
});
var require_Document = __commonJS((exports) => {
  var Alias = require_Alias();
  var Collection = require_Collection();
  var identity = require_identity();
  var Pair = require_Pair();
  var toJS = require_toJS();
  var Schema = require_Schema();
  var stringifyDocument = require_stringifyDocument();
  var anchors = require_anchors();
  var applyReviver = require_applyReviver();
  var createNode = require_createNode();
  var directives = require_directives();

  class Document {
    constructor(value, replacer, options) {
      this.commentBefore = null;
      this.comment = null;
      this.errors = [];
      this.warnings = [];
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const opt = Object.assign({
        intAsBigInt: false,
        keepSourceTokens: false,
        logLevel: "warn",
        prettyErrors: true,
        strict: true,
        stringKeys: false,
        uniqueKeys: true,
        version: "1.2"
      }, options);
      this.options = opt;
      let { version } = opt;
      if (options?._directives) {
        this.directives = options._directives.atDocument();
        if (this.directives.yaml.explicit)
          version = this.directives.yaml.version;
      } else
        this.directives = new directives.Directives({ version });
      this.setSchema(version, options);
      this.contents = value === undefined ? null : this.createNode(value, _replacer, options);
    }
    clone() {
      const copy = Object.create(Document.prototype, {
        [identity.NODE_TYPE]: { value: identity.DOC }
      });
      copy.commentBefore = this.commentBefore;
      copy.comment = this.comment;
      copy.errors = this.errors.slice();
      copy.warnings = this.warnings.slice();
      copy.options = Object.assign({}, this.options);
      if (this.directives)
        copy.directives = this.directives.clone();
      copy.schema = this.schema.clone();
      copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    add(value) {
      if (assertCollection(this.contents))
        this.contents.add(value);
    }
    addIn(path, value) {
      if (assertCollection(this.contents))
        this.contents.addIn(path, value);
    }
    createAlias(node, name) {
      if (!node.anchor) {
        const prev = anchors.anchorNames(this);
        node.anchor = !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
      }
      return new Alias.Alias(node.anchor);
    }
    createNode(value, replacer, options) {
      let _replacer = undefined;
      if (typeof replacer === "function") {
        value = replacer.call({ "": value }, "", value);
        _replacer = replacer;
      } else if (Array.isArray(replacer)) {
        const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
        const asStr = replacer.filter(keyToStr).map(String);
        if (asStr.length > 0)
          replacer = replacer.concat(asStr);
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
      const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(this, anchorPrefix || "a");
      const ctx = {
        aliasDuplicateObjects: aliasDuplicateObjects ?? true,
        keepUndefined: keepUndefined ?? false,
        onAnchor,
        onTagObj,
        replacer: _replacer,
        schema: this.schema,
        sourceObjects
      };
      const node = createNode.createNode(value, tag, ctx);
      if (flow && identity.isCollection(node))
        node.flow = true;
      setAnchors();
      return node;
    }
    createPair(key, value, options = {}) {
      const k = this.createNode(key, null, options);
      const v = this.createNode(value, null, options);
      return new Pair.Pair(k, v);
    }
    delete(key) {
      return assertCollection(this.contents) ? this.contents.delete(key) : false;
    }
    deleteIn(path) {
      if (Collection.isEmptyPath(path)) {
        if (this.contents == null)
          return false;
        this.contents = null;
        return true;
      }
      return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
    }
    get(key, keepScalar) {
      return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : undefined;
    }
    getIn(path, keepScalar) {
      if (Collection.isEmptyPath(path))
        return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
      return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : undefined;
    }
    has(key) {
      return identity.isCollection(this.contents) ? this.contents.has(key) : false;
    }
    hasIn(path) {
      if (Collection.isEmptyPath(path))
        return this.contents !== undefined;
      return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
    }
    set(key, value) {
      if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, [key], value);
      } else if (assertCollection(this.contents)) {
        this.contents.set(key, value);
      }
    }
    setIn(path, value) {
      if (Collection.isEmptyPath(path)) {
        this.contents = value;
      } else if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
      } else if (assertCollection(this.contents)) {
        this.contents.setIn(path, value);
      }
    }
    setSchema(version, options = {}) {
      if (typeof version === "number")
        version = String(version);
      let opt;
      switch (version) {
        case "1.1":
          if (this.directives)
            this.directives.yaml.version = "1.1";
          else
            this.directives = new directives.Directives({ version: "1.1" });
          opt = { resolveKnownTags: false, schema: "yaml-1.1" };
          break;
        case "1.2":
        case "next":
          if (this.directives)
            this.directives.yaml.version = version;
          else
            this.directives = new directives.Directives({ version });
          opt = { resolveKnownTags: true, schema: "core" };
          break;
        case null:
          if (this.directives)
            delete this.directives;
          opt = null;
          break;
        default: {
          const sv = JSON.stringify(version);
          throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
        }
      }
      if (options.schema instanceof Object)
        this.schema = options.schema;
      else if (opt)
        this.schema = new Schema.Schema(Object.assign(opt, options));
      else
        throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
    }
    toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      const ctx = {
        anchors: new Map,
        doc: this,
        keep: !json,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
      };
      const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
      if (typeof onAnchor === "function")
        for (const { count, res: res2 } of ctx.anchors.values())
          onAnchor(res2, count);
      return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
    }
    toJSON(jsonArg, onAnchor) {
      return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
    }
    toString(options = {}) {
      if (this.errors.length > 0)
        throw new Error("Document with errors cannot be stringified");
      if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
        const s = JSON.stringify(options.indent);
        throw new Error(`"indent" option must be a positive integer, not ${s}`);
      }
      return stringifyDocument.stringifyDocument(this, options);
    }
  }
  function assertCollection(contents) {
    if (identity.isCollection(contents))
      return true;
    throw new Error("Expected a YAML collection as document contents");
  }
  exports.Document = Document;
});
var require_errors = __commonJS((exports) => {

  class YAMLError extends Error {
    constructor(name, pos, code, message) {
      super();
      this.name = name;
      this.code = code;
      this.message = message;
      this.pos = pos;
    }
  }

  class YAMLParseError extends YAMLError {
    constructor(pos, code, message) {
      super("YAMLParseError", pos, code, message);
    }
  }

  class YAMLWarning extends YAMLError {
    constructor(pos, code, message) {
      super("YAMLWarning", pos, code, message);
    }
  }
  var prettifyError = (src, lc) => (error) => {
    if (error.pos[0] === -1)
      return;
    error.linePos = error.pos.map((pos) => lc.linePos(pos));
    const { line, col } = error.linePos[0];
    error.message += ` at line ${line}, column ${col}`;
    let ci = col - 1;
    let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
    if (ci >= 60 && lineStr.length > 80) {
      const trimStart = Math.min(ci - 39, lineStr.length - 79);
      lineStr = "…" + lineStr.substring(trimStart);
      ci -= trimStart - 1;
    }
    if (lineStr.length > 80)
      lineStr = lineStr.substring(0, 79) + "…";
    if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
      let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
      if (prev.length > 80)
        prev = prev.substring(0, 79) + `…
`;
      lineStr = prev + lineStr;
    }
    if (/[^ ]/.test(lineStr)) {
      let count = 1;
      const end = error.linePos[1];
      if (end?.line === line && end.col > col) {
        count = Math.max(1, Math.min(end.col - col, 80 - ci));
      }
      const pointer = " ".repeat(ci) + "^".repeat(count);
      error.message += `:

${lineStr}
${pointer}
`;
    }
  };
  exports.YAMLError = YAMLError;
  exports.YAMLParseError = YAMLParseError;
  exports.YAMLWarning = YAMLWarning;
  exports.prettifyError = prettifyError;
});
var require_resolve_props = __commonJS((exports) => {
  function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
    let spaceBefore = false;
    let atNewline = startOnNewline;
    let hasSpace = startOnNewline;
    let comment = "";
    let commentSep = "";
    let hasNewline = false;
    let reqSpace = false;
    let tab = null;
    let anchor = null;
    let tag = null;
    let newlineAfterProp = null;
    let comma = null;
    let found = null;
    let start = null;
    for (const token of tokens) {
      if (reqSpace) {
        if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
          onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
        reqSpace = false;
      }
      if (tab) {
        if (atNewline && token.type !== "comment" && token.type !== "newline") {
          onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
        }
        tab = null;
      }
      switch (token.type) {
        case "space":
          if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("\t")) {
            tab = token;
          }
          hasSpace = true;
          break;
        case "comment": {
          if (!hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = token.source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += commentSep + cb;
          commentSep = "";
          atNewline = false;
          break;
        }
        case "newline":
          if (atNewline) {
            if (comment)
              comment += token.source;
            else if (!found || indicator !== "seq-item-ind")
              spaceBefore = true;
          } else
            commentSep += token.source;
          atNewline = true;
          hasNewline = true;
          if (anchor || tag)
            newlineAfterProp = token;
          hasSpace = true;
          break;
        case "anchor":
          if (anchor)
            onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
          if (token.source.endsWith(":"))
            onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
          anchor = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        case "tag": {
          if (tag)
            onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
          tag = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        }
        case indicator:
          if (anchor || tag)
            onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
          if (found)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
          found = token;
          atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
          hasSpace = false;
          break;
        case "comma":
          if (flow) {
            if (comma)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
            comma = token;
            atNewline = false;
            hasSpace = false;
            break;
          }
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
          atNewline = false;
          hasSpace = false;
      }
    }
    const last = tokens[tokens.length - 1];
    const end = last ? last.offset + last.source.length : offset;
    if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
      onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
    }
    if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
      onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
    return {
      comma,
      found,
      spaceBefore,
      comment,
      hasNewline,
      anchor,
      tag,
      newlineAfterProp,
      end,
      start: start ?? end
    };
  }
  exports.resolveProps = resolveProps;
});
var require_util_contains_newline = __commonJS((exports) => {
  function containsNewline(key) {
    if (!key)
      return null;
    switch (key.type) {
      case "alias":
      case "scalar":
      case "double-quoted-scalar":
      case "single-quoted-scalar":
        if (key.source.includes(`
`))
          return true;
        if (key.end) {
          for (const st of key.end)
            if (st.type === "newline")
              return true;
        }
        return false;
      case "flow-collection":
        for (const it of key.items) {
          for (const st of it.start)
            if (st.type === "newline")
              return true;
          if (it.sep) {
            for (const st of it.sep)
              if (st.type === "newline")
                return true;
          }
          if (containsNewline(it.key) || containsNewline(it.value))
            return true;
        }
        return false;
      default:
        return true;
    }
  }
  exports.containsNewline = containsNewline;
});
var require_util_flow_indent_check = __commonJS((exports) => {
  var utilContainsNewline = require_util_contains_newline();
  function flowIndentCheck(indent, fc, onError) {
    if (fc?.type === "flow-collection") {
      const end = fc.end[0];
      if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
        const msg = "Flow end indicator should be more indented than parent";
        onError(end, "BAD_INDENT", msg, true);
      }
    }
  }
  exports.flowIndentCheck = flowIndentCheck;
});
var require_util_map_includes = __commonJS((exports) => {
  var identity = require_identity();
  function mapIncludes(ctx, items, search) {
    const { uniqueKeys } = ctx.options;
    if (uniqueKeys === false)
      return false;
    const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
    return items.some((pair) => isEqual(pair.key, search));
  }
  exports.mapIncludes = mapIncludes;
});
var require_resolve_block_map = __commonJS((exports) => {
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();
  var resolveProps = require_resolve_props();
  var utilContainsNewline = require_util_contains_newline();
  var utilFlowIndentCheck = require_util_flow_indent_check();
  var utilMapIncludes = require_util_map_includes();
  var startColMsg = "All mapping items must start at the same column";
  function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
    const map = new NodeClass(ctx.schema);
    if (ctx.atRoot)
      ctx.atRoot = false;
    let offset = bm.offset;
    let commentEnd = null;
    for (const collItem of bm.items) {
      const { start, key, sep, value } = collItem;
      const keyProps = resolveProps.resolveProps(start, {
        indicator: "explicit-key-ind",
        next: key ?? sep?.[0],
        offset,
        onError,
        parentIndent: bm.indent,
        startOnNewline: true
      });
      const implicitKey = !keyProps.found;
      if (implicitKey) {
        if (key) {
          if (key.type === "block-seq")
            onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
          else if ("indent" in key && key.indent !== bm.indent)
            onError(offset, "BAD_INDENT", startColMsg);
        }
        if (!keyProps.anchor && !keyProps.tag && !sep) {
          commentEnd = keyProps.end;
          if (keyProps.comment) {
            if (map.comment)
              map.comment += `
` + keyProps.comment;
            else
              map.comment = keyProps.comment;
          }
          continue;
        }
        if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
          onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
        }
      } else if (keyProps.found?.indent !== bm.indent) {
        onError(offset, "BAD_INDENT", startColMsg);
      }
      ctx.atKey = true;
      const keyStart = keyProps.end;
      const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
      ctx.atKey = false;
      if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
        onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
      const valueProps = resolveProps.resolveProps(sep ?? [], {
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: bm.indent,
        startOnNewline: !key || key.type === "block-scalar"
      });
      offset = valueProps.end;
      if (valueProps.found) {
        if (implicitKey) {
          if (value?.type === "block-map" && !valueProps.hasNewline)
            onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
          if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
            onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
        }
        const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
        offset = valueNode.range[2];
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        map.items.push(pair);
      } else {
        if (implicitKey)
          onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
        if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment += `
` + valueProps.comment;
          else
            keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        map.items.push(pair);
      }
    }
    if (commentEnd && commentEnd < offset)
      onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
    map.range = [bm.offset, offset, commentEnd ?? offset];
    return map;
  }
  exports.resolveBlockMap = resolveBlockMap;
});
var require_resolve_block_seq = __commonJS((exports) => {
  var YAMLSeq = require_YAMLSeq();
  var resolveProps = require_resolve_props();
  var utilFlowIndentCheck = require_util_flow_indent_check();
  function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
    const seq = new NodeClass(ctx.schema);
    if (ctx.atRoot)
      ctx.atRoot = false;
    if (ctx.atKey)
      ctx.atKey = false;
    let offset = bs.offset;
    let commentEnd = null;
    for (const { start, value } of bs.items) {
      const props = resolveProps.resolveProps(start, {
        indicator: "seq-item-ind",
        next: value,
        offset,
        onError,
        parentIndent: bs.indent,
        startOnNewline: true
      });
      if (!props.found) {
        if (props.anchor || props.tag || value) {
          if (value?.type === "block-seq")
            onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
          else
            onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
        } else {
          commentEnd = props.end;
          if (props.comment)
            seq.comment = props.comment;
          continue;
        }
      }
      const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
      offset = node.range[2];
      seq.items.push(node);
    }
    seq.range = [bs.offset, offset, commentEnd ?? offset];
    return seq;
  }
  exports.resolveBlockSeq = resolveBlockSeq;
});
var require_resolve_end = __commonJS((exports) => {
  function resolveEnd(end, offset, reqSpace, onError) {
    let comment = "";
    if (end) {
      let hasSpace = false;
      let sep = "";
      for (const token of end) {
        const { source, type } = token;
        switch (type) {
          case "space":
            hasSpace = true;
            break;
          case "comment": {
            if (reqSpace && !hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += sep + cb;
            sep = "";
            break;
          }
          case "newline":
            if (comment)
              sep += source;
            hasSpace = true;
            break;
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
        }
        offset += source.length;
      }
    }
    return { comment, offset };
  }
  exports.resolveEnd = resolveEnd;
});
var require_resolve_flow_collection = __commonJS((exports) => {
  var identity = require_identity();
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var resolveEnd = require_resolve_end();
  var resolveProps = require_resolve_props();
  var utilContainsNewline = require_util_contains_newline();
  var utilMapIncludes = require_util_map_includes();
  var blockMsg = "Block collections are not allowed within flow collections";
  var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
  function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
    const isMap = fc.start.source === "{";
    const fcName = isMap ? "flow map" : "flow sequence";
    const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
    const coll = new NodeClass(ctx.schema);
    coll.flow = true;
    const atRoot = ctx.atRoot;
    if (atRoot)
      ctx.atRoot = false;
    if (ctx.atKey)
      ctx.atKey = false;
    let offset = fc.offset + fc.start.source.length;
    for (let i = 0;i < fc.items.length; ++i) {
      const collItem = fc.items[i];
      const { start, key, sep, value } = collItem;
      const props = resolveProps.resolveProps(start, {
        flow: fcName,
        indicator: "explicit-key-ind",
        next: key ?? sep?.[0],
        offset,
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (!props.found) {
        if (!props.anchor && !props.tag && !sep && !value) {
          if (i === 0 && props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
          else if (i < fc.items.length - 1)
            onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
          if (props.comment) {
            if (coll.comment)
              coll.comment += `
` + props.comment;
            else
              coll.comment = props.comment;
          }
          offset = props.end;
          continue;
        }
        if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
          onError(key, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
      }
      if (i === 0) {
        if (props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
      } else {
        if (!props.comma)
          onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
        if (props.comment) {
          let prevItemComment = "";
          loop:
            for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
          if (prevItemComment) {
            let prev = coll.items[coll.items.length - 1];
            if (identity.isPair(prev))
              prev = prev.value ?? prev.key;
            if (prev.comment)
              prev.comment += `
` + prevItemComment;
            else
              prev.comment = prevItemComment;
            props.comment = props.comment.substring(prevItemComment.length + 1);
          }
        }
      }
      if (!isMap && !sep && !props.found) {
        const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
        coll.items.push(valueNode);
        offset = valueNode.range[2];
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else {
        ctx.atKey = true;
        const keyStart = props.end;
        const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
        if (isBlock(key))
          onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
        ctx.atKey = false;
        const valueProps = resolveProps.resolveProps(sep ?? [], {
          flow: fcName,
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (valueProps.found) {
          if (!isMap && !props.found && ctx.options.strict) {
            if (sep)
              for (const st of sep) {
                if (st === valueProps.found)
                  break;
                if (st.type === "newline") {
                  onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                  break;
                }
              }
            if (props.start < valueProps.found.offset - 1024)
              onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
          }
        } else if (value) {
          if ("source" in value && value.source?.[0] === ":")
            onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
          else
            onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
        }
        const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
        if (valueNode) {
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment += `
` + valueProps.comment;
          else
            keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        if (isMap) {
          const map = coll;
          if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
            onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
          map.items.push(pair);
        } else {
          const map = new YAMLMap.YAMLMap(ctx.schema);
          map.flow = true;
          map.items.push(pair);
          const endRange = (valueNode ?? keyNode).range;
          map.range = [keyNode.range[0], endRange[1], endRange[2]];
          coll.items.push(map);
        }
        offset = valueNode ? valueNode.range[2] : valueProps.end;
      }
    }
    const expectedEnd = isMap ? "}" : "]";
    const [ce, ...ee] = fc.end;
    let cePos = offset;
    if (ce?.source === expectedEnd)
      cePos = ce.offset + ce.source.length;
    else {
      const name = fcName[0].toUpperCase() + fcName.substring(1);
      const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
      onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
      if (ce && ce.source.length !== 1)
        ee.unshift(ce);
    }
    if (ee.length > 0) {
      const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
      if (end.comment) {
        if (coll.comment)
          coll.comment += `
` + end.comment;
        else
          coll.comment = end.comment;
      }
      coll.range = [fc.offset, cePos, end.offset];
    } else {
      coll.range = [fc.offset, cePos, cePos];
    }
    return coll;
  }
  exports.resolveFlowCollection = resolveFlowCollection;
});
var require_compose_collection = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var resolveBlockMap = require_resolve_block_map();
  var resolveBlockSeq = require_resolve_block_seq();
  var resolveFlowCollection = require_resolve_flow_collection();
  function resolveCollection(CN, ctx, token, onError, tagName, tag) {
    const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
    const Coll = coll.constructor;
    if (tagName === "!" || tagName === Coll.tagName) {
      coll.tag = Coll.tagName;
      return coll;
    }
    if (tagName)
      coll.tag = tagName;
    return coll;
  }
  function composeCollection(CN, ctx, token, props, onError) {
    const tagToken = props.tag;
    const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
    if (token.type === "block-seq") {
      const { anchor, newlineAfterProp: nl } = props;
      const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
      if (lastProp && (!nl || nl.offset < lastProp.offset)) {
        const message = "Missing newline after block sequence props";
        onError(lastProp, "MISSING_CHAR", message);
      }
    }
    const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
    if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
      return resolveCollection(CN, ctx, token, onError, tagName);
    }
    let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
    if (!tag) {
      const kt = ctx.schema.knownTags[tagName];
      if (kt?.collection === expType) {
        ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
        tag = kt;
      } else {
        if (kt) {
          onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
        } else {
          onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
        }
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
    }
    const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
    const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
    const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
    node.range = coll.range;
    node.tag = tagName;
    if (tag?.format)
      node.format = tag.format;
    return node;
  }
  exports.composeCollection = composeCollection;
});
var require_resolve_block_scalar = __commonJS((exports) => {
  var Scalar = require_Scalar();
  function resolveBlockScalar(ctx, scalar, onError) {
    const start = scalar.offset;
    const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
    if (!header)
      return { value: "", type: null, comment: "", range: [start, start, start] };
    const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
    const lines = scalar.source ? splitLines(scalar.source) : [];
    let chompStart = lines.length;
    for (let i = lines.length - 1;i >= 0; --i) {
      const content = lines[i][1];
      if (content === "" || content === "\r")
        chompStart = i;
      else
        break;
    }
    if (chompStart === 0) {
      const value2 = header.chomp === "+" && lines.length > 0 ? `
`.repeat(Math.max(1, lines.length - 1)) : "";
      let end2 = start + header.length;
      if (scalar.source)
        end2 += scalar.source.length;
      return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
    }
    let trimIndent = scalar.indent + header.indent;
    let offset = scalar.offset + header.length;
    let contentStart = 0;
    for (let i = 0;i < chompStart; ++i) {
      const [indent, content] = lines[i];
      if (content === "" || content === "\r") {
        if (header.indent === 0 && indent.length > trimIndent)
          trimIndent = indent.length;
      } else {
        if (indent.length < trimIndent) {
          const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
          onError(offset + indent.length, "MISSING_CHAR", message);
        }
        if (header.indent === 0)
          trimIndent = indent.length;
        contentStart = i;
        if (trimIndent === 0 && !ctx.atRoot) {
          const message = "Block scalar values in collections must be indented";
          onError(offset, "BAD_INDENT", message);
        }
        break;
      }
      offset += indent.length + content.length + 1;
    }
    for (let i = lines.length - 1;i >= chompStart; --i) {
      if (lines[i][0].length > trimIndent)
        chompStart = i + 1;
    }
    let value = "";
    let sep = "";
    let prevMoreIndented = false;
    for (let i = 0;i < contentStart; ++i)
      value += lines[i][0].slice(trimIndent) + `
`;
    for (let i = contentStart;i < chompStart; ++i) {
      let [indent, content] = lines[i];
      offset += indent.length + content.length + 1;
      const crlf = content[content.length - 1] === "\r";
      if (crlf)
        content = content.slice(0, -1);
      if (content && indent.length < trimIndent) {
        const src = header.indent ? "explicit indentation indicator" : "first line";
        const message = `Block scalar lines must not be less indented than their ${src}`;
        onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
        indent = "";
      }
      if (type === Scalar.Scalar.BLOCK_LITERAL) {
        value += sep + indent.slice(trimIndent) + content;
        sep = `
`;
      } else if (indent.length > trimIndent || content[0] === "\t") {
        if (sep === " ")
          sep = `
`;
        else if (!prevMoreIndented && sep === `
`)
          sep = `

`;
        value += sep + indent.slice(trimIndent) + content;
        sep = `
`;
        prevMoreIndented = true;
      } else if (content === "") {
        if (sep === `
`)
          value += `
`;
        else
          sep = `
`;
      } else {
        value += sep + content;
        sep = " ";
        prevMoreIndented = false;
      }
    }
    switch (header.chomp) {
      case "-":
        break;
      case "+":
        for (let i = chompStart;i < lines.length; ++i)
          value += `
` + lines[i][0].slice(trimIndent);
        if (value[value.length - 1] !== `
`)
          value += `
`;
        break;
      default:
        value += `
`;
    }
    const end = start + header.length + scalar.source.length;
    return { value, type, comment: header.comment, range: [start, end, end] };
  }
  function parseBlockScalarHeader({ offset, props }, strict, onError) {
    if (props[0].type !== "block-scalar-header") {
      onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
      return null;
    }
    const { source } = props[0];
    const mode = source[0];
    let indent = 0;
    let chomp = "";
    let error = -1;
    for (let i = 1;i < source.length; ++i) {
      const ch = source[i];
      if (!chomp && (ch === "-" || ch === "+"))
        chomp = ch;
      else {
        const n = Number(ch);
        if (!indent && n)
          indent = n;
        else if (error === -1)
          error = offset + i;
      }
    }
    if (error !== -1)
      onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
    let hasSpace = false;
    let comment = "";
    let length = source.length;
    for (let i = 1;i < props.length; ++i) {
      const token = props[i];
      switch (token.type) {
        case "space":
          hasSpace = true;
        case "newline":
          length += token.source.length;
          break;
        case "comment":
          if (strict && !hasSpace) {
            const message = "Comments must be separated from other tokens by white space characters";
            onError(token, "MISSING_CHAR", message);
          }
          length += token.source.length;
          comment = token.source.substring(1);
          break;
        case "error":
          onError(token, "UNEXPECTED_TOKEN", token.message);
          length += token.source.length;
          break;
        default: {
          const message = `Unexpected token in block scalar header: ${token.type}`;
          onError(token, "UNEXPECTED_TOKEN", message);
          const ts = token.source;
          if (ts && typeof ts === "string")
            length += ts.length;
        }
      }
    }
    return { mode, indent, chomp, comment, length };
  }
  function splitLines(source) {
    const split = source.split(/\n( *)/);
    const first = split[0];
    const m = first.match(/^( *)/);
    const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
    const lines = [line0];
    for (let i = 1;i < split.length; i += 2)
      lines.push([split[i], split[i + 1]]);
    return lines;
  }
  exports.resolveBlockScalar = resolveBlockScalar;
});
var require_resolve_flow_scalar = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var resolveEnd = require_resolve_end();
  function resolveFlowScalar(scalar, strict, onError) {
    const { offset, type, source, end } = scalar;
    let _type;
    let value;
    const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
    switch (type) {
      case "scalar":
        _type = Scalar.Scalar.PLAIN;
        value = plainValue(source, _onError);
        break;
      case "single-quoted-scalar":
        _type = Scalar.Scalar.QUOTE_SINGLE;
        value = singleQuotedValue(source, _onError);
        break;
      case "double-quoted-scalar":
        _type = Scalar.Scalar.QUOTE_DOUBLE;
        value = doubleQuotedValue(source, _onError);
        break;
      default:
        onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
        return {
          value: "",
          type: null,
          comment: "",
          range: [offset, offset + source.length, offset + source.length]
        };
    }
    const valueEnd = offset + source.length;
    const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
    return {
      value,
      type: _type,
      comment: re.comment,
      range: [offset, valueEnd, re.offset]
    };
  }
  function plainValue(source, onError) {
    let badChar = "";
    switch (source[0]) {
      case "\t":
        badChar = "a tab character";
        break;
      case ",":
        badChar = "flow indicator character ,";
        break;
      case "%":
        badChar = "directive indicator character %";
        break;
      case "|":
      case ">": {
        badChar = `block scalar indicator ${source[0]}`;
        break;
      }
      case "@":
      case "`": {
        badChar = `reserved character ${source[0]}`;
        break;
      }
    }
    if (badChar)
      onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
    return foldLines(source);
  }
  function singleQuotedValue(source, onError) {
    if (source[source.length - 1] !== "'" || source.length === 1)
      onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
    return foldLines(source.slice(1, -1)).replace(/''/g, "'");
  }
  function foldLines(source) {
    let first, line;
    try {
      first = new RegExp(`(.*?)(?<![ 	])[ 	]*\r?
`, "sy");
      line = new RegExp(`[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?
`, "sy");
    } catch {
      first = /(.*?)[ \t]*\r?\n/sy;
      line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
    }
    let match = first.exec(source);
    if (!match)
      return source;
    let res = match[1];
    let sep = " ";
    let pos = first.lastIndex;
    line.lastIndex = pos;
    while (match = line.exec(source)) {
      if (match[1] === "") {
        if (sep === `
`)
          res += sep;
        else
          sep = `
`;
      } else {
        res += sep + match[1];
        sep = " ";
      }
      pos = line.lastIndex;
    }
    const last = /[ \t]*(.*)/sy;
    last.lastIndex = pos;
    match = last.exec(source);
    return res + sep + (match?.[1] ?? "");
  }
  function doubleQuotedValue(source, onError) {
    let res = "";
    for (let i = 1;i < source.length - 1; ++i) {
      const ch = source[i];
      if (ch === "\r" && source[i + 1] === `
`)
        continue;
      if (ch === `
`) {
        const { fold, offset } = foldNewline(source, i);
        res += fold;
        i = offset;
      } else if (ch === "\\") {
        let next = source[++i];
        const cc = escapeCodes[next];
        if (cc)
          res += cc;
        else if (next === `
`) {
          next = source[i + 1];
          while (next === " " || next === "\t")
            next = source[++i + 1];
        } else if (next === "\r" && source[i + 1] === `
`) {
          next = source[++i + 1];
          while (next === " " || next === "\t")
            next = source[++i + 1];
        } else if (next === "x" || next === "u" || next === "U") {
          const length = { x: 2, u: 4, U: 8 }[next];
          res += parseCharCode(source, i + 1, length, onError);
          i += length;
        } else {
          const raw = source.substr(i - 1, 2);
          onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
          res += raw;
        }
      } else if (ch === " " || ch === "\t") {
        const wsStart = i;
        let next = source[i + 1];
        while (next === " " || next === "\t")
          next = source[++i + 1];
        if (next !== `
` && !(next === "\r" && source[i + 2] === `
`))
          res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
      } else {
        res += ch;
      }
    }
    if (source[source.length - 1] !== '"' || source.length === 1)
      onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
    return res;
  }
  function foldNewline(source, offset) {
    let fold = "";
    let ch = source[offset + 1];
    while (ch === " " || ch === "\t" || ch === `
` || ch === "\r") {
      if (ch === "\r" && source[offset + 2] !== `
`)
        break;
      if (ch === `
`)
        fold += `
`;
      offset += 1;
      ch = source[offset + 1];
    }
    if (!fold)
      fold = " ";
    return { fold, offset };
  }
  var escapeCodes = {
    "0": "\x00",
    a: "\x07",
    b: "\b",
    e: "\x1B",
    f: "\f",
    n: `
`,
    r: "\r",
    t: "\t",
    v: "\v",
    N: "",
    _: " ",
    L: "\u2028",
    P: "\u2029",
    " ": " ",
    '"': '"',
    "/": "/",
    "\\": "\\",
    "\t": "\t"
  };
  function parseCharCode(source, offset, length, onError) {
    const cc = source.substr(offset, length);
    const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
    const code = ok ? parseInt(cc, 16) : NaN;
    if (isNaN(code)) {
      const raw = source.substr(offset - 2, length + 2);
      onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
      return raw;
    }
    return String.fromCodePoint(code);
  }
  exports.resolveFlowScalar = resolveFlowScalar;
});
var require_compose_scalar = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var resolveBlockScalar = require_resolve_block_scalar();
  var resolveFlowScalar = require_resolve_flow_scalar();
  function composeScalar(ctx, token, tagToken, onError) {
    const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
    const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
    let tag;
    if (ctx.options.stringKeys && ctx.atKey) {
      tag = ctx.schema[identity.SCALAR];
    } else if (tagName)
      tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
    else if (token.type === "scalar")
      tag = findScalarTagByTest(ctx, value, token, onError);
    else
      tag = ctx.schema[identity.SCALAR];
    let scalar;
    try {
      const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
      scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
      scalar = new Scalar.Scalar(value);
    }
    scalar.range = range;
    scalar.source = value;
    if (type)
      scalar.type = type;
    if (tagName)
      scalar.tag = tagName;
    if (tag.format)
      scalar.format = tag.format;
    if (comment)
      scalar.comment = comment;
    return scalar;
  }
  function findScalarTagByName(schema, value, tagName, tagToken, onError) {
    if (tagName === "!")
      return schema[identity.SCALAR];
    const matchWithTest = [];
    for (const tag of schema.tags) {
      if (!tag.collection && tag.tag === tagName) {
        if (tag.default && tag.test)
          matchWithTest.push(tag);
        else
          return tag;
      }
    }
    for (const tag of matchWithTest)
      if (tag.test?.test(value))
        return tag;
    const kt = schema.knownTags[tagName];
    if (kt && !kt.collection) {
      schema.tags.push(Object.assign({}, kt, { default: false, test: undefined }));
      return kt;
    }
    onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
    return schema[identity.SCALAR];
  }
  function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
    const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
    if (schema.compat) {
      const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
      if (tag.tag !== compat.tag) {
        const ts = directives.tagString(tag.tag);
        const cs = directives.tagString(compat.tag);
        const msg = `Value may be parsed as either ${ts} or ${cs}`;
        onError(token, "TAG_RESOLVE_FAILED", msg, true);
      }
    }
    return tag;
  }
  exports.composeScalar = composeScalar;
});
var require_util_empty_scalar_position = __commonJS((exports) => {
  function emptyScalarPosition(offset, before, pos) {
    if (before) {
      pos ?? (pos = before.length);
      for (let i = pos - 1;i >= 0; --i) {
        let st = before[i];
        switch (st.type) {
          case "space":
          case "comment":
          case "newline":
            offset -= st.source.length;
            continue;
        }
        st = before[++i];
        while (st?.type === "space") {
          offset += st.source.length;
          st = before[++i];
        }
        break;
      }
    }
    return offset;
  }
  exports.emptyScalarPosition = emptyScalarPosition;
});
var require_compose_node = __commonJS((exports) => {
  var Alias = require_Alias();
  var identity = require_identity();
  var composeCollection = require_compose_collection();
  var composeScalar = require_compose_scalar();
  var resolveEnd = require_resolve_end();
  var utilEmptyScalarPosition = require_util_empty_scalar_position();
  var CN = { composeNode, composeEmptyNode };
  function composeNode(ctx, token, props, onError) {
    const atKey = ctx.atKey;
    const { spaceBefore, comment, anchor, tag } = props;
    let node;
    let isSrcToken = true;
    switch (token.type) {
      case "alias":
        node = composeAlias(ctx, token, onError);
        if (anchor || tag)
          onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
        break;
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "block-scalar":
        node = composeScalar.composeScalar(ctx, token, tag, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
        break;
      case "block-map":
      case "block-seq":
      case "flow-collection":
        try {
          node = composeCollection.composeCollection(CN, ctx, token, props, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          onError(token, "RESOURCE_EXHAUSTION", message);
        }
        break;
      default: {
        const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
        onError(token, "UNEXPECTED_TOKEN", message);
        isSrcToken = false;
      }
    }
    node ?? (node = composeEmptyNode(ctx, token.offset, undefined, null, props, onError));
    if (anchor && node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
      const msg = "With stringKeys, all keys must be strings";
      onError(tag ?? token, "NON_STRING_KEY", msg);
    }
    if (spaceBefore)
      node.spaceBefore = true;
    if (comment) {
      if (token.type === "scalar" && token.source === "")
        node.comment = comment;
      else
        node.commentBefore = comment;
    }
    if (ctx.options.keepSourceTokens && isSrcToken)
      node.srcToken = token;
    return node;
  }
  function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
    const token = {
      type: "scalar",
      offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
      indent: -1,
      source: ""
    };
    const node = composeScalar.composeScalar(ctx, token, tag, onError);
    if (anchor) {
      node.anchor = anchor.source.substring(1);
      if (node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    }
    if (spaceBefore)
      node.spaceBefore = true;
    if (comment) {
      node.comment = comment;
      node.range[2] = end;
    }
    return node;
  }
  function composeAlias({ options }, { offset, source, end }, onError) {
    const alias = new Alias.Alias(source.substring(1));
    if (alias.source === "")
      onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
    if (alias.source.endsWith(":"))
      onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
    const valueEnd = offset + source.length;
    const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
    alias.range = [offset, valueEnd, re.offset];
    if (re.comment)
      alias.comment = re.comment;
    return alias;
  }
  exports.composeEmptyNode = composeEmptyNode;
  exports.composeNode = composeNode;
});
var require_compose_doc = __commonJS((exports) => {
  var Document = require_Document();
  var composeNode = require_compose_node();
  var resolveEnd = require_resolve_end();
  var resolveProps = require_resolve_props();
  function composeDoc(options, directives, { offset, start, value, end }, onError) {
    const opts = Object.assign({ _directives: directives }, options);
    const doc = new Document.Document(undefined, opts);
    const ctx = {
      atKey: false,
      atRoot: true,
      directives: doc.directives,
      options: doc.options,
      schema: doc.schema
    };
    const props = resolveProps.resolveProps(start, {
      indicator: "doc-start",
      next: value ?? end?.[0],
      offset,
      onError,
      parentIndent: 0,
      startOnNewline: true
    });
    if (props.found) {
      doc.directives.docStart = true;
      if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
        onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
    }
    doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
    const contentEnd = doc.contents.range[2];
    const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
    if (re.comment)
      doc.comment = re.comment;
    doc.range = [offset, contentEnd, re.offset];
    return doc;
  }
  exports.composeDoc = composeDoc;
});
var require_composer = __commonJS((exports) => {
  var node_process = __require("process");
  var directives = require_directives();
  var Document = require_Document();
  var errors = require_errors();
  var identity = require_identity();
  var composeDoc = require_compose_doc();
  var resolveEnd = require_resolve_end();
  function getErrorPos(src) {
    if (typeof src === "number")
      return [src, src + 1];
    if (Array.isArray(src))
      return src.length === 2 ? src : [src[0], src[1]];
    const { offset, source } = src;
    return [offset, offset + (typeof source === "string" ? source.length : 1)];
  }
  function parsePrelude(prelude) {
    let comment = "";
    let atComment = false;
    let afterEmptyLine = false;
    for (let i = 0;i < prelude.length; ++i) {
      const source = prelude[i];
      switch (source[0]) {
        case "#":
          comment += (comment === "" ? "" : afterEmptyLine ? `

` : `
`) + (source.substring(1) || " ");
          atComment = true;
          afterEmptyLine = false;
          break;
        case "%":
          if (prelude[i + 1]?.[0] !== "#")
            i += 1;
          atComment = false;
          break;
        default:
          if (!atComment)
            afterEmptyLine = true;
          atComment = false;
      }
    }
    return { comment, afterEmptyLine };
  }

  class Composer {
    constructor(options = {}) {
      this.doc = null;
      this.atDirectives = false;
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
      this.onError = (source, code, message, warning) => {
        const pos = getErrorPos(source);
        if (warning)
          this.warnings.push(new errors.YAMLWarning(pos, code, message));
        else
          this.errors.push(new errors.YAMLParseError(pos, code, message));
      };
      this.directives = new directives.Directives({ version: options.version || "1.2" });
      this.options = options;
    }
    decorate(doc, afterDoc) {
      const { comment, afterEmptyLine } = parsePrelude(this.prelude);
      if (comment) {
        const dc = doc.contents;
        if (afterDoc) {
          doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
        } else if (afterEmptyLine || doc.directives.docStart || !dc) {
          doc.commentBefore = comment;
        } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
          let it = dc.items[0];
          if (identity.isPair(it))
            it = it.key;
          const cb = it.commentBefore;
          it.commentBefore = cb ? `${comment}
${cb}` : comment;
        } else {
          const cb = dc.commentBefore;
          dc.commentBefore = cb ? `${comment}
${cb}` : comment;
        }
      }
      if (afterDoc) {
        Array.prototype.push.apply(doc.errors, this.errors);
        Array.prototype.push.apply(doc.warnings, this.warnings);
      } else {
        doc.errors = this.errors;
        doc.warnings = this.warnings;
      }
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
    }
    streamInfo() {
      return {
        comment: parsePrelude(this.prelude).comment,
        directives: this.directives,
        errors: this.errors,
        warnings: this.warnings
      };
    }
    *compose(tokens, forceDoc = false, endOffset = -1) {
      for (const token of tokens)
        yield* this.next(token);
      yield* this.end(forceDoc, endOffset);
    }
    *next(token) {
      if (node_process.env.LOG_STREAM)
        console.dir(token, { depth: null });
      switch (token.type) {
        case "directive":
          this.directives.add(token.source, (offset, message, warning) => {
            const pos = getErrorPos(token);
            pos[0] += offset;
            this.onError(pos, "BAD_DIRECTIVE", message, warning);
          });
          this.prelude.push(token.source);
          this.atDirectives = true;
          break;
        case "document": {
          const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
          if (this.atDirectives && !doc.directives.docStart)
            this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
          this.decorate(doc, false);
          if (this.doc)
            yield this.doc;
          this.doc = doc;
          this.atDirectives = false;
          break;
        }
        case "byte-order-mark":
        case "space":
          break;
        case "comment":
        case "newline":
          this.prelude.push(token.source);
          break;
        case "error": {
          const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
          const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
          if (this.atDirectives || !this.doc)
            this.errors.push(error);
          else
            this.doc.errors.push(error);
          break;
        }
        case "doc-end": {
          if (!this.doc) {
            const msg = "Unexpected doc-end without preceding document";
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
            break;
          }
          this.doc.directives.docEnd = true;
          const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
          this.decorate(this.doc, true);
          if (end.comment) {
            const dc = this.doc.comment;
            this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
          }
          this.doc.range[2] = end.offset;
          break;
        }
        default:
          this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
      }
    }
    *end(forceDoc = false, endOffset = -1) {
      if (this.doc) {
        this.decorate(this.doc, true);
        yield this.doc;
        this.doc = null;
      } else if (forceDoc) {
        const opts = Object.assign({ _directives: this.directives }, this.options);
        const doc = new Document.Document(undefined, opts);
        if (this.atDirectives)
          this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
        doc.range = [0, endOffset, endOffset];
        this.decorate(doc, false);
        yield doc;
      }
    }
  }
  exports.Composer = Composer;
});
var require_cst_scalar = __commonJS((exports) => {
  var resolveBlockScalar = require_resolve_block_scalar();
  var resolveFlowScalar = require_resolve_flow_scalar();
  var errors = require_errors();
  var stringifyString = require_stringifyString();
  function resolveAsScalar(token, strict = true, onError) {
    if (token) {
      const _onError = (pos, code, message) => {
        const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
        if (onError)
          onError(offset, code, message);
        else
          throw new errors.YAMLParseError([offset, offset + 1], code, message);
      };
      switch (token.type) {
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
        case "block-scalar":
          return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
      }
    }
    return null;
  }
  function createScalarToken(value, context) {
    const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
    const source = stringifyString.stringifyString({ type, value }, {
      implicitKey,
      indent: indent > 0 ? " ".repeat(indent) : "",
      inFlow,
      options: { blockQuote: true, lineWidth: -1 }
    });
    const end = context.end ?? [
      { type: "newline", offset: -1, indent, source: `
` }
    ];
    switch (source[0]) {
      case "|":
      case ">": {
        const he = source.indexOf(`
`);
        const head = source.substring(0, he);
        const body = source.substring(he + 1) + `
`;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, end))
          props.push({ type: "newline", offset: -1, indent, source: `
` });
        return { type: "block-scalar", offset, indent, props, source: body };
      }
      case '"':
        return { type: "double-quoted-scalar", offset, indent, source, end };
      case "'":
        return { type: "single-quoted-scalar", offset, indent, source, end };
      default:
        return { type: "scalar", offset, indent, source, end };
    }
  }
  function setScalarValue(token, value, context = {}) {
    let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
    let indent = "indent" in token ? token.indent : null;
    if (afterKey && typeof indent === "number")
      indent += 2;
    if (!type)
      switch (token.type) {
        case "single-quoted-scalar":
          type = "QUOTE_SINGLE";
          break;
        case "double-quoted-scalar":
          type = "QUOTE_DOUBLE";
          break;
        case "block-scalar": {
          const header = token.props[0];
          if (header.type !== "block-scalar-header")
            throw new Error("Invalid block scalar header");
          type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
          break;
        }
        default:
          type = "PLAIN";
      }
    const source = stringifyString.stringifyString({ type, value }, {
      implicitKey: implicitKey || indent === null,
      indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
      inFlow,
      options: { blockQuote: true, lineWidth: -1 }
    });
    switch (source[0]) {
      case "|":
      case ">":
        setBlockScalarValue(token, source);
        break;
      case '"':
        setFlowScalarValue(token, source, "double-quoted-scalar");
        break;
      case "'":
        setFlowScalarValue(token, source, "single-quoted-scalar");
        break;
      default:
        setFlowScalarValue(token, source, "scalar");
    }
  }
  function setBlockScalarValue(token, source) {
    const he = source.indexOf(`
`);
    const head = source.substring(0, he);
    const body = source.substring(he + 1) + `
`;
    if (token.type === "block-scalar") {
      const header = token.props[0];
      if (header.type !== "block-scalar-header")
        throw new Error("Invalid block scalar header");
      header.source = head;
      token.source = body;
    } else {
      const { offset } = token;
      const indent = "indent" in token ? token.indent : -1;
      const props = [
        { type: "block-scalar-header", offset, indent, source: head }
      ];
      if (!addEndtoBlockProps(props, "end" in token ? token.end : undefined))
        props.push({ type: "newline", offset: -1, indent, source: `
` });
      for (const key of Object.keys(token))
        if (key !== "type" && key !== "offset")
          delete token[key];
      Object.assign(token, { type: "block-scalar", indent, props, source: body });
    }
  }
  function addEndtoBlockProps(props, end) {
    if (end)
      for (const st of end)
        switch (st.type) {
          case "space":
          case "comment":
            props.push(st);
            break;
          case "newline":
            props.push(st);
            return true;
        }
    return false;
  }
  function setFlowScalarValue(token, source, type) {
    switch (token.type) {
      case "scalar":
      case "double-quoted-scalar":
      case "single-quoted-scalar":
        token.type = type;
        token.source = source;
        break;
      case "block-scalar": {
        const end = token.props.slice(1);
        let oa = source.length;
        if (token.props[0].type === "block-scalar-header")
          oa -= token.props[0].source.length;
        for (const tok of end)
          tok.offset += oa;
        delete token.props;
        Object.assign(token, { type, source, end });
        break;
      }
      case "block-map":
      case "block-seq": {
        const offset = token.offset + source.length;
        const nl = { type: "newline", offset, indent: token.indent, source: `
` };
        delete token.items;
        Object.assign(token, { type, source, end: [nl] });
        break;
      }
      default: {
        const indent = "indent" in token ? token.indent : -1;
        const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type, indent, source, end });
      }
    }
  }
  exports.createScalarToken = createScalarToken;
  exports.resolveAsScalar = resolveAsScalar;
  exports.setScalarValue = setScalarValue;
});
var require_cst_stringify = __commonJS((exports) => {
  var stringify = (cst) => ("type" in cst) ? stringifyToken(cst) : stringifyItem(cst);
  function stringifyToken(token) {
    switch (token.type) {
      case "block-scalar": {
        let res = "";
        for (const tok of token.props)
          res += stringifyToken(tok);
        return res + token.source;
      }
      case "block-map":
      case "block-seq": {
        let res = "";
        for (const item of token.items)
          res += stringifyItem(item);
        return res;
      }
      case "flow-collection": {
        let res = token.start.source;
        for (const item of token.items)
          res += stringifyItem(item);
        for (const st of token.end)
          res += st.source;
        return res;
      }
      case "document": {
        let res = stringifyItem(token);
        if (token.end)
          for (const st of token.end)
            res += st.source;
        return res;
      }
      default: {
        let res = token.source;
        if ("end" in token && token.end)
          for (const st of token.end)
            res += st.source;
        return res;
      }
    }
  }
  function stringifyItem({ start, key, sep, value }) {
    let res = "";
    for (const st of start)
      res += st.source;
    if (key)
      res += stringifyToken(key);
    if (sep)
      for (const st of sep)
        res += st.source;
    if (value)
      res += stringifyToken(value);
    return res;
  }
  exports.stringify = stringify;
});
var require_cst_visit = __commonJS((exports) => {
  var BREAK = Symbol("break visit");
  var SKIP = Symbol("skip children");
  var REMOVE = Symbol("remove item");
  function visit(cst, visitor) {
    if ("type" in cst && cst.type === "document")
      cst = { start: cst.start, value: cst.value };
    _visit(Object.freeze([]), cst, visitor);
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  visit.itemAtPath = (cst, path) => {
    let item = cst;
    for (const [field, index] of path) {
      const tok = item?.[field];
      if (tok && "items" in tok) {
        item = tok.items[index];
      } else
        return;
    }
    return item;
  };
  visit.parentCollection = (cst, path) => {
    const parent = visit.itemAtPath(cst, path.slice(0, -1));
    const field = path[path.length - 1][0];
    const coll = parent?.[field];
    if (coll && "items" in coll)
      return coll;
    throw new Error("Parent collection not found");
  };
  function _visit(path, item, visitor) {
    let ctrl = visitor(item, path);
    if (typeof ctrl === "symbol")
      return ctrl;
    for (const field of ["key", "value"]) {
      const token = item[field];
      if (token && "items" in token) {
        for (let i = 0;i < token.items.length; ++i) {
          const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            token.items.splice(i, 1);
            i -= 1;
          }
        }
        if (typeof ctrl === "function" && field === "key")
          ctrl = ctrl(item, path);
      }
    }
    return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
  }
  exports.visit = visit;
});
var require_cst = __commonJS((exports) => {
  var cstScalar = require_cst_scalar();
  var cstStringify = require_cst_stringify();
  var cstVisit = require_cst_visit();
  var BOM = "\uFEFF";
  var DOCUMENT = "\x02";
  var FLOW_END = "\x18";
  var SCALAR = "\x1F";
  var isCollection = (token) => !!token && ("items" in token);
  var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
  function prettyToken(token) {
    switch (token) {
      case BOM:
        return "<BOM>";
      case DOCUMENT:
        return "<DOC>";
      case FLOW_END:
        return "<FLOW_END>";
      case SCALAR:
        return "<SCALAR>";
      default:
        return JSON.stringify(token);
    }
  }
  function tokenType(source) {
    switch (source) {
      case BOM:
        return "byte-order-mark";
      case DOCUMENT:
        return "doc-mode";
      case FLOW_END:
        return "flow-error-end";
      case SCALAR:
        return "scalar";
      case "---":
        return "doc-start";
      case "...":
        return "doc-end";
      case "":
      case `
`:
      case `\r
`:
        return "newline";
      case "-":
        return "seq-item-ind";
      case "?":
        return "explicit-key-ind";
      case ":":
        return "map-value-ind";
      case "{":
        return "flow-map-start";
      case "}":
        return "flow-map-end";
      case "[":
        return "flow-seq-start";
      case "]":
        return "flow-seq-end";
      case ",":
        return "comma";
    }
    switch (source[0]) {
      case " ":
      case "\t":
        return "space";
      case "#":
        return "comment";
      case "%":
        return "directive-line";
      case "*":
        return "alias";
      case "&":
        return "anchor";
      case "!":
        return "tag";
      case "'":
        return "single-quoted-scalar";
      case '"':
        return "double-quoted-scalar";
      case "|":
      case ">":
        return "block-scalar-header";
    }
    return null;
  }
  exports.createScalarToken = cstScalar.createScalarToken;
  exports.resolveAsScalar = cstScalar.resolveAsScalar;
  exports.setScalarValue = cstScalar.setScalarValue;
  exports.stringify = cstStringify.stringify;
  exports.visit = cstVisit.visit;
  exports.BOM = BOM;
  exports.DOCUMENT = DOCUMENT;
  exports.FLOW_END = FLOW_END;
  exports.SCALAR = SCALAR;
  exports.isCollection = isCollection;
  exports.isScalar = isScalar;
  exports.prettyToken = prettyToken;
  exports.tokenType = tokenType;
});
var require_lexer = __commonJS((exports) => {
  var cst = require_cst();
  function isEmpty(ch) {
    switch (ch) {
      case undefined:
      case " ":
      case `
`:
      case "\r":
      case "\t":
        return true;
      default:
        return false;
    }
  }
  var hexDigits = new Set("0123456789ABCDEFabcdef");
  var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
  var flowIndicatorChars = new Set(",[]{}");
  var invalidAnchorChars = new Set(` ,[]{}
\r	`);
  var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);

  class Lexer {
    constructor() {
      this.atEnd = false;
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      this.buffer = "";
      this.flowKey = false;
      this.flowLevel = 0;
      this.indentNext = 0;
      this.indentValue = 0;
      this.lineEndPos = null;
      this.next = null;
      this.pos = 0;
    }
    *lex(source, incomplete = false) {
      if (source) {
        if (typeof source !== "string")
          throw TypeError("source is not a string");
        this.buffer = this.buffer ? this.buffer + source : source;
        this.lineEndPos = null;
      }
      this.atEnd = !incomplete;
      let next = this.next ?? "stream";
      while (next && (incomplete || this.hasChars(1)))
        next = yield* this.parseNext(next);
    }
    atLineEnd() {
      let i = this.pos;
      let ch = this.buffer[i];
      while (ch === " " || ch === "\t")
        ch = this.buffer[++i];
      if (!ch || ch === "#" || ch === `
`)
        return true;
      if (ch === "\r")
        return this.buffer[i + 1] === `
`;
      return false;
    }
    charAt(n) {
      return this.buffer[this.pos + n];
    }
    continueScalar(offset) {
      let ch = this.buffer[offset];
      if (this.indentNext > 0) {
        let indent = 0;
        while (ch === " ")
          ch = this.buffer[++indent + offset];
        if (ch === "\r") {
          const next = this.buffer[indent + offset + 1];
          if (next === `
` || !next && !this.atEnd)
            return offset + indent + 1;
        }
        return ch === `
` || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
      }
      if (ch === "-" || ch === ".") {
        const dt = this.buffer.substr(offset, 3);
        if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
          return -1;
      }
      return offset;
    }
    getLine() {
      let end = this.lineEndPos;
      if (typeof end !== "number" || end !== -1 && end < this.pos) {
        end = this.buffer.indexOf(`
`, this.pos);
        this.lineEndPos = end;
      }
      if (end === -1)
        return this.atEnd ? this.buffer.substring(this.pos) : null;
      if (this.buffer[end - 1] === "\r")
        end -= 1;
      return this.buffer.substring(this.pos, end);
    }
    hasChars(n) {
      return this.pos + n <= this.buffer.length;
    }
    setNext(state) {
      this.buffer = this.buffer.substring(this.pos);
      this.pos = 0;
      this.lineEndPos = null;
      this.next = state;
      return null;
    }
    peek(n) {
      return this.buffer.substr(this.pos, n);
    }
    *parseNext(next) {
      switch (next) {
        case "stream":
          return yield* this.parseStream();
        case "line-start":
          return yield* this.parseLineStart();
        case "block-start":
          return yield* this.parseBlockStart();
        case "doc":
          return yield* this.parseDocument();
        case "flow":
          return yield* this.parseFlowCollection();
        case "quoted-scalar":
          return yield* this.parseQuotedScalar();
        case "block-scalar":
          return yield* this.parseBlockScalar();
        case "plain-scalar":
          return yield* this.parsePlainScalar();
      }
    }
    *parseStream() {
      let line = this.getLine();
      if (line === null)
        return this.setNext("stream");
      if (line[0] === cst.BOM) {
        yield* this.pushCount(1);
        line = line.substring(1);
      }
      if (line[0] === "%") {
        let dirEnd = line.length;
        let cs = line.indexOf("#");
        while (cs !== -1) {
          const ch = line[cs - 1];
          if (ch === " " || ch === "\t") {
            dirEnd = cs - 1;
            break;
          } else {
            cs = line.indexOf("#", cs + 1);
          }
        }
        while (true) {
          const ch = line[dirEnd - 1];
          if (ch === " " || ch === "\t")
            dirEnd -= 1;
          else
            break;
        }
        const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
        yield* this.pushCount(line.length - n);
        this.pushNewline();
        return "stream";
      }
      if (this.atLineEnd()) {
        const sp = yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - sp);
        yield* this.pushNewline();
        return "stream";
      }
      yield cst.DOCUMENT;
      return yield* this.parseLineStart();
    }
    *parseLineStart() {
      const ch = this.charAt(0);
      if (!ch && !this.atEnd)
        return this.setNext("line-start");
      if (ch === "-" || ch === ".") {
        if (!this.atEnd && !this.hasChars(4))
          return this.setNext("line-start");
        const s = this.peek(3);
        if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
          yield* this.pushCount(3);
          this.indentValue = 0;
          this.indentNext = 0;
          return s === "---" ? "doc" : "stream";
        }
      }
      this.indentValue = yield* this.pushSpaces(false);
      if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
        this.indentNext = this.indentValue;
      return yield* this.parseBlockStart();
    }
    *parseBlockStart() {
      const [ch0, ch1] = this.peek(2);
      if (!ch1 && !this.atEnd)
        return this.setNext("block-start");
      if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
        const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
        this.indentNext = this.indentValue + 1;
        this.indentValue += n;
        return yield* this.parseBlockStart();
      }
      return "doc";
    }
    *parseDocument() {
      yield* this.pushSpaces(true);
      const line = this.getLine();
      if (line === null)
        return this.setNext("doc");
      let n = yield* this.pushIndicators();
      switch (line[n]) {
        case "#":
          yield* this.pushCount(line.length - n);
        case undefined:
          yield* this.pushNewline();
          return yield* this.parseLineStart();
        case "{":
        case "[":
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel = 1;
          return "flow";
        case "}":
        case "]":
          yield* this.pushCount(1);
          return "doc";
        case "*":
          yield* this.pushUntil(isNotAnchorChar);
          return "doc";
        case '"':
        case "'":
          return yield* this.parseQuotedScalar();
        case "|":
        case ">":
          n += yield* this.parseBlockScalarHeader();
          n += yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - n);
          yield* this.pushNewline();
          return yield* this.parseBlockScalar();
        default:
          return yield* this.parsePlainScalar();
      }
    }
    *parseFlowCollection() {
      let nl, sp;
      let indent = -1;
      do {
        nl = yield* this.pushNewline();
        if (nl > 0) {
          sp = yield* this.pushSpaces(false);
          this.indentValue = indent = sp;
        } else {
          sp = 0;
        }
        sp += yield* this.pushSpaces(true);
      } while (nl + sp > 0);
      const line = this.getLine();
      if (line === null)
        return this.setNext("flow");
      if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
        const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
        if (!atFlowEndMarker) {
          this.flowLevel = 0;
          yield cst.FLOW_END;
          return yield* this.parseLineStart();
        }
      }
      let n = 0;
      while (line[n] === ",") {
        n += yield* this.pushCount(1);
        n += yield* this.pushSpaces(true);
        this.flowKey = false;
      }
      n += yield* this.pushIndicators();
      switch (line[n]) {
        case undefined:
          return "flow";
        case "#":
          yield* this.pushCount(line.length - n);
          return "flow";
        case "{":
        case "[":
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel += 1;
          return "flow";
        case "}":
        case "]":
          yield* this.pushCount(1);
          this.flowKey = true;
          this.flowLevel -= 1;
          return this.flowLevel ? "flow" : "doc";
        case "*":
          yield* this.pushUntil(isNotAnchorChar);
          return "flow";
        case '"':
        case "'":
          this.flowKey = true;
          return yield* this.parseQuotedScalar();
        case ":": {
          const next = this.charAt(1);
          if (this.flowKey || isEmpty(next) || next === ",") {
            this.flowKey = false;
            yield* this.pushCount(1);
            yield* this.pushSpaces(true);
            return "flow";
          }
        }
        default:
          this.flowKey = false;
          return yield* this.parsePlainScalar();
      }
    }
    *parseQuotedScalar() {
      const quote = this.charAt(0);
      let end = this.buffer.indexOf(quote, this.pos + 1);
      if (quote === "'") {
        while (end !== -1 && this.buffer[end + 1] === "'")
          end = this.buffer.indexOf("'", end + 2);
      } else {
        while (end !== -1) {
          let n = 0;
          while (this.buffer[end - 1 - n] === "\\")
            n += 1;
          if (n % 2 === 0)
            break;
          end = this.buffer.indexOf('"', end + 1);
        }
      }
      const qb = this.buffer.substring(0, end);
      let nl = qb.indexOf(`
`, this.pos);
      if (nl !== -1) {
        while (nl !== -1) {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1)
            break;
          nl = qb.indexOf(`
`, cs);
        }
        if (nl !== -1) {
          end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
        }
      }
      if (end === -1) {
        if (!this.atEnd)
          return this.setNext("quoted-scalar");
        end = this.buffer.length;
      }
      yield* this.pushToIndex(end + 1, false);
      return this.flowLevel ? "flow" : "doc";
    }
    *parseBlockScalarHeader() {
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      let i = this.pos;
      while (true) {
        const ch = this.buffer[++i];
        if (ch === "+")
          this.blockScalarKeep = true;
        else if (ch > "0" && ch <= "9")
          this.blockScalarIndent = Number(ch) - 1;
        else if (ch !== "-")
          break;
      }
      return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
    }
    *parseBlockScalar() {
      let nl = this.pos - 1;
      let indent = 0;
      let ch;
      loop:
        for (let i2 = this.pos;ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case `
`:
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === `
`)
                break;
            }
            default:
              break loop;
          }
        }
      if (!ch && !this.atEnd)
        return this.setNext("block-scalar");
      if (indent >= this.indentNext) {
        if (this.blockScalarIndent === -1)
          this.indentNext = indent;
        else {
          this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
        }
        do {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1)
            break;
          nl = this.buffer.indexOf(`
`, cs);
        } while (nl !== -1);
        if (nl === -1) {
          if (!this.atEnd)
            return this.setNext("block-scalar");
          nl = this.buffer.length;
        }
      }
      let i = nl + 1;
      ch = this.buffer[i];
      while (ch === " ")
        ch = this.buffer[++i];
      if (ch === "\t") {
        while (ch === "\t" || ch === " " || ch === "\r" || ch === `
`)
          ch = this.buffer[++i];
        nl = i - 1;
      } else if (!this.blockScalarKeep) {
        do {
          let i2 = nl - 1;
          let ch2 = this.buffer[i2];
          if (ch2 === "\r")
            ch2 = this.buffer[--i2];
          const lastChar = i2;
          while (ch2 === " ")
            ch2 = this.buffer[--i2];
          if (ch2 === `
` && i2 >= this.pos && i2 + 1 + indent > lastChar)
            nl = i2;
          else
            break;
        } while (true);
      }
      yield cst.SCALAR;
      yield* this.pushToIndex(nl + 1, true);
      return yield* this.parseLineStart();
    }
    *parsePlainScalar() {
      const inFlow = this.flowLevel > 0;
      let end = this.pos - 1;
      let i = this.pos - 1;
      let ch;
      while (ch = this.buffer[++i]) {
        if (ch === ":") {
          const next = this.buffer[i + 1];
          if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
            break;
          end = i;
        } else if (isEmpty(ch)) {
          let next = this.buffer[i + 1];
          if (ch === "\r") {
            if (next === `
`) {
              i += 1;
              ch = `
`;
              next = this.buffer[i + 1];
            } else
              end = i;
          }
          if (next === "#" || inFlow && flowIndicatorChars.has(next))
            break;
          if (ch === `
`) {
            const cs = this.continueScalar(i + 1);
            if (cs === -1)
              break;
            i = Math.max(i, cs - 2);
          }
        } else {
          if (inFlow && flowIndicatorChars.has(ch))
            break;
          end = i;
        }
      }
      if (!ch && !this.atEnd)
        return this.setNext("plain-scalar");
      yield cst.SCALAR;
      yield* this.pushToIndex(end + 1, true);
      return inFlow ? "flow" : "doc";
    }
    *pushCount(n) {
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos += n;
        return n;
      }
      return 0;
    }
    *pushToIndex(i, allowEmpty) {
      const s = this.buffer.slice(this.pos, i);
      if (s) {
        yield s;
        this.pos += s.length;
        return s.length;
      } else if (allowEmpty)
        yield "";
      return 0;
    }
    *pushIndicators() {
      switch (this.charAt(0)) {
        case "!":
          return (yield* this.pushTag()) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
        case "&":
          return (yield* this.pushUntil(isNotAnchorChar)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
        case "-":
        case "?":
        case ":": {
          const inFlow = this.flowLevel > 0;
          const ch1 = this.charAt(1);
          if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
            if (!inFlow)
              this.indentNext = this.indentValue + 1;
            else if (this.flowKey)
              this.flowKey = false;
            return (yield* this.pushCount(1)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
          }
        }
      }
      return 0;
    }
    *pushTag() {
      if (this.charAt(1) === "<") {
        let i = this.pos + 2;
        let ch = this.buffer[i];
        while (!isEmpty(ch) && ch !== ">")
          ch = this.buffer[++i];
        return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
      } else {
        let i = this.pos + 1;
        let ch = this.buffer[i];
        while (ch) {
          if (tagChars.has(ch))
            ch = this.buffer[++i];
          else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
            ch = this.buffer[i += 3];
          } else
            break;
        }
        return yield* this.pushToIndex(i, false);
      }
    }
    *pushNewline() {
      const ch = this.buffer[this.pos];
      if (ch === `
`)
        return yield* this.pushCount(1);
      else if (ch === "\r" && this.charAt(1) === `
`)
        return yield* this.pushCount(2);
      else
        return 0;
    }
    *pushSpaces(allowTabs) {
      let i = this.pos - 1;
      let ch;
      do {
        ch = this.buffer[++i];
      } while (ch === " " || allowTabs && ch === "\t");
      const n = i - this.pos;
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos = i;
      }
      return n;
    }
    *pushUntil(test) {
      let i = this.pos;
      let ch = this.buffer[i];
      while (!test(ch))
        ch = this.buffer[++i];
      return yield* this.pushToIndex(i, false);
    }
  }
  exports.Lexer = Lexer;
});
var require_line_counter = __commonJS((exports) => {

  class LineCounter {
    constructor() {
      this.lineStarts = [];
      this.addNewLine = (offset) => this.lineStarts.push(offset);
      this.linePos = (offset) => {
        let low = 0;
        let high = this.lineStarts.length;
        while (low < high) {
          const mid = low + high >> 1;
          if (this.lineStarts[mid] < offset)
            low = mid + 1;
          else
            high = mid;
        }
        if (this.lineStarts[low] === offset)
          return { line: low + 1, col: 1 };
        if (low === 0)
          return { line: 0, col: offset };
        const start = this.lineStarts[low - 1];
        return { line: low, col: offset - start + 1 };
      };
    }
  }
  exports.LineCounter = LineCounter;
});
var require_parser = __commonJS((exports) => {
  var node_process = __require("process");
  var cst = require_cst();
  var lexer = require_lexer();
  function includesToken(list, type) {
    for (let i = 0;i < list.length; ++i)
      if (list[i].type === type)
        return true;
    return false;
  }
  function findNonEmptyIndex(list) {
    for (let i = 0;i < list.length; ++i) {
      switch (list[i].type) {
        case "space":
        case "comment":
        case "newline":
          break;
        default:
          return i;
      }
    }
    return -1;
  }
  function isFlowToken(token) {
    switch (token?.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "flow-collection":
        return true;
      default:
        return false;
    }
  }
  function getPrevProps(parent) {
    switch (parent.type) {
      case "document":
        return parent.start;
      case "block-map": {
        const it = parent.items[parent.items.length - 1];
        return it.sep ?? it.start;
      }
      case "block-seq":
        return parent.items[parent.items.length - 1].start;
      default:
        return [];
    }
  }
  function getFirstKeyStartProps(prev) {
    if (prev.length === 0)
      return [];
    let i = prev.length;
    loop:
      while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
    while (prev[++i]?.type === "space") {}
    return prev.splice(i, prev.length);
  }
  function fixFlowSeqItems(fc) {
    if (fc.start.type === "flow-seq-start") {
      for (const it of fc.items) {
        if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
          if (it.key)
            it.value = it.key;
          delete it.key;
          if (isFlowToken(it.value)) {
            if (it.value.end)
              Array.prototype.push.apply(it.value.end, it.sep);
            else
              it.value.end = it.sep;
          } else
            Array.prototype.push.apply(it.start, it.sep);
          delete it.sep;
        }
      }
    }
  }

  class Parser {
    constructor(onNewLine) {
      this.atNewLine = true;
      this.atScalar = false;
      this.indent = 0;
      this.offset = 0;
      this.onKeyLine = false;
      this.stack = [];
      this.source = "";
      this.type = "";
      this.lexer = new lexer.Lexer;
      this.onNewLine = onNewLine;
    }
    *parse(source, incomplete = false) {
      if (this.onNewLine && this.offset === 0)
        this.onNewLine(0);
      for (const lexeme of this.lexer.lex(source, incomplete))
        yield* this.next(lexeme);
      if (!incomplete)
        yield* this.end();
    }
    *next(source) {
      this.source = source;
      if (node_process.env.LOG_TOKENS)
        console.log("|", cst.prettyToken(source));
      if (this.atScalar) {
        this.atScalar = false;
        yield* this.step();
        this.offset += source.length;
        return;
      }
      const type = cst.tokenType(source);
      if (!type) {
        const message = `Not a YAML token: ${source}`;
        yield* this.pop({ type: "error", offset: this.offset, message, source });
        this.offset += source.length;
      } else if (type === "scalar") {
        this.atNewLine = false;
        this.atScalar = true;
        this.type = "scalar";
      } else {
        this.type = type;
        yield* this.step();
        switch (type) {
          case "newline":
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine)
              this.onNewLine(this.offset + source.length);
            break;
          case "space":
            if (this.atNewLine && source[0] === " ")
              this.indent += source.length;
            break;
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
            if (this.atNewLine)
              this.indent += source.length;
            break;
          case "doc-mode":
          case "flow-error-end":
            return;
          default:
            this.atNewLine = false;
        }
        this.offset += source.length;
      }
    }
    *end() {
      while (this.stack.length > 0)
        yield* this.pop();
    }
    get sourceToken() {
      const st = {
        type: this.type,
        offset: this.offset,
        indent: this.indent,
        source: this.source
      };
      return st;
    }
    *step() {
      const top = this.peek(1);
      if (this.type === "doc-end" && top?.type !== "doc-end") {
        while (this.stack.length > 0)
          yield* this.pop();
        this.stack.push({
          type: "doc-end",
          offset: this.offset,
          source: this.source
        });
        return;
      }
      if (!top)
        return yield* this.stream();
      switch (top.type) {
        case "document":
          return yield* this.document(top);
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return yield* this.scalar(top);
        case "block-scalar":
          return yield* this.blockScalar(top);
        case "block-map":
          return yield* this.blockMap(top);
        case "block-seq":
          return yield* this.blockSequence(top);
        case "flow-collection":
          return yield* this.flowCollection(top);
        case "doc-end":
          return yield* this.documentEnd(top);
      }
      yield* this.pop();
    }
    peek(n) {
      return this.stack[this.stack.length - n];
    }
    *pop(error) {
      const token = error ?? this.stack.pop();
      if (!token) {
        const message = "Tried to pop an empty stack";
        yield { type: "error", offset: this.offset, source: "", message };
      } else if (this.stack.length === 0) {
        yield token;
      } else {
        const top = this.peek(1);
        if (token.type === "block-scalar") {
          token.indent = "indent" in top ? top.indent : 0;
        } else if (token.type === "flow-collection" && top.type === "document") {
          token.indent = 0;
        }
        if (token.type === "flow-collection")
          fixFlowSeqItems(token);
        switch (top.type) {
          case "document":
            top.value = token;
            break;
          case "block-scalar":
            top.props.push(token);
            break;
          case "block-map": {
            const it = top.items[top.items.length - 1];
            if (it.value) {
              top.items.push({ start: [], key: token, sep: [] });
              this.onKeyLine = true;
              return;
            } else if (it.sep) {
              it.value = token;
            } else {
              Object.assign(it, { key: token, sep: [] });
              this.onKeyLine = !it.explicitKey;
              return;
            }
            break;
          }
          case "block-seq": {
            const it = top.items[top.items.length - 1];
            if (it.value)
              top.items.push({ start: [], value: token });
            else
              it.value = token;
            break;
          }
          case "flow-collection": {
            const it = top.items[top.items.length - 1];
            if (!it || it.value)
              top.items.push({ start: [], key: token, sep: [] });
            else if (it.sep)
              it.value = token;
            else
              Object.assign(it, { key: token, sep: [] });
            return;
          }
          default:
            yield* this.pop();
            yield* this.pop(token);
        }
        if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
          const last = token.items[token.items.length - 1];
          if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
            if (top.type === "document")
              top.end = last.start;
            else
              top.items.push({ start: last.start });
            token.items.splice(-1, 1);
          }
        }
      }
    }
    *stream() {
      switch (this.type) {
        case "directive-line":
          yield { type: "directive", offset: this.offset, source: this.source };
          return;
        case "byte-order-mark":
        case "space":
        case "comment":
        case "newline":
          yield this.sourceToken;
          return;
        case "doc-mode":
        case "doc-start": {
          const doc = {
            type: "document",
            offset: this.offset,
            start: []
          };
          if (this.type === "doc-start")
            doc.start.push(this.sourceToken);
          this.stack.push(doc);
          return;
        }
      }
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML stream`,
        source: this.source
      };
    }
    *document(doc) {
      if (doc.value)
        return yield* this.lineEnd(doc);
      switch (this.type) {
        case "doc-start": {
          if (findNonEmptyIndex(doc.start) !== -1) {
            yield* this.pop();
            yield* this.step();
          } else
            doc.start.push(this.sourceToken);
          return;
        }
        case "anchor":
        case "tag":
        case "space":
        case "comment":
        case "newline":
          doc.start.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(doc);
      if (bv)
        this.stack.push(bv);
      else {
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML document`,
          source: this.source
        };
      }
    }
    *scalar(scalar) {
      if (this.type === "map-value-ind") {
        const prev = getPrevProps(this.peek(2));
        const start = getFirstKeyStartProps(prev);
        let sep;
        if (scalar.end) {
          sep = scalar.end;
          sep.push(this.sourceToken);
          delete scalar.end;
        } else
          sep = [this.sourceToken];
        const map = {
          type: "block-map",
          offset: scalar.offset,
          indent: scalar.indent,
          items: [{ start, key: scalar, sep }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map;
      } else
        yield* this.lineEnd(scalar);
    }
    *blockScalar(scalar) {
      switch (this.type) {
        case "space":
        case "comment":
        case "newline":
          scalar.props.push(this.sourceToken);
          return;
        case "scalar":
          scalar.source = this.source;
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine) {
            let nl = this.source.indexOf(`
`) + 1;
            while (nl !== 0) {
              this.onNewLine(this.offset + nl);
              nl = this.source.indexOf(`
`, nl) + 1;
            }
          }
          yield* this.pop();
          break;
        default:
          yield* this.pop();
          yield* this.step();
      }
    }
    *blockMap(map) {
      const it = map.items[map.items.length - 1];
      switch (this.type) {
        case "newline":
          this.onKeyLine = false;
          if (it.value) {
            const end = "end" in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === "comment")
              end?.push(this.sourceToken);
            else
              map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "space":
        case "comment":
          if (it.value) {
            map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            if (this.atIndentedComment(it.start, map.indent)) {
              const prev = map.items[map.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                Array.prototype.push.apply(end, it.start);
                end.push(this.sourceToken);
                map.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
      }
      if (this.indent >= map.indent) {
        const atMapIndent = !this.onKeyLine && this.indent === map.indent;
        const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
        let start = [];
        if (atNextItem && it.sep && !it.value) {
          const nl = [];
          for (let i = 0;i < it.sep.length; ++i) {
            const st = it.sep[i];
            switch (st.type) {
              case "newline":
                nl.push(i);
                break;
              case "space":
                break;
              case "comment":
                if (st.indent > map.indent)
                  nl.length = 0;
                break;
              default:
                nl.length = 0;
            }
          }
          if (nl.length >= 2)
            start = it.sep.splice(nl[1]);
        }
        switch (this.type) {
          case "anchor":
          case "tag":
            if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start });
              this.onKeyLine = true;
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "explicit-key-ind":
            if (!it.sep && !it.explicitKey) {
              it.start.push(this.sourceToken);
              it.explicitKey = true;
            } else if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start, explicitKey: true });
            } else {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [this.sourceToken], explicitKey: true }]
              });
            }
            this.onKeyLine = true;
            return;
          case "map-value-ind":
            if (it.explicitKey) {
              if (!it.sep) {
                if (includesToken(it.start, "newline")) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else {
                  const start2 = getFirstKeyStartProps(it.start);
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                  });
                }
              } else if (it.value) {
                map.items.push({ start: [], key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, "map-value-ind")) {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start, key: null, sep: [this.sourceToken] }]
                });
              } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                const start2 = getFirstKeyStartProps(it.start);
                const key = it.key;
                const sep = it.sep;
                sep.push(this.sourceToken);
                delete it.key;
                delete it.sep;
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: start2, key, sep }]
                });
              } else if (start.length > 0) {
                it.sep = it.sep.concat(start, this.sourceToken);
              } else {
                it.sep.push(this.sourceToken);
              }
            } else {
              if (!it.sep) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else if (it.value || atNextItem) {
                map.items.push({ start, key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, "map-value-ind")) {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [], key: null, sep: [this.sourceToken] }]
                });
              } else {
                it.sep.push(this.sourceToken);
              }
            }
            this.onKeyLine = true;
            return;
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar": {
            const fs = this.flowScalar(this.type);
            if (atNextItem || it.value) {
              map.items.push({ start, key: fs, sep: [] });
              this.onKeyLine = true;
            } else if (it.sep) {
              this.stack.push(fs);
            } else {
              Object.assign(it, { key: fs, sep: [] });
              this.onKeyLine = true;
            }
            return;
          }
          default: {
            const bv = this.startBlockValue(map);
            if (bv) {
              if (bv.type === "block-seq") {
                if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                  yield* this.pop({
                    type: "error",
                    offset: this.offset,
                    message: "Unexpected block-seq-ind on same line with key",
                    source: this.source
                  });
                  return;
                }
              } else if (atMapIndent) {
                map.items.push({ start });
              }
              this.stack.push(bv);
              return;
            }
          }
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *blockSequence(seq) {
      const it = seq.items[seq.items.length - 1];
      switch (this.type) {
        case "newline":
          if (it.value) {
            const end = "end" in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === "comment")
              end?.push(this.sourceToken);
            else
              seq.items.push({ start: [this.sourceToken] });
          } else
            it.start.push(this.sourceToken);
          return;
        case "space":
        case "comment":
          if (it.value)
            seq.items.push({ start: [this.sourceToken] });
          else {
            if (this.atIndentedComment(it.start, seq.indent)) {
              const prev = seq.items[seq.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                Array.prototype.push.apply(end, it.start);
                end.push(this.sourceToken);
                seq.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
        case "anchor":
        case "tag":
          if (it.value || this.indent <= seq.indent)
            break;
          it.start.push(this.sourceToken);
          return;
        case "seq-item-ind":
          if (this.indent !== seq.indent)
            break;
          if (it.value || includesToken(it.start, "seq-item-ind"))
            seq.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
      }
      if (this.indent > seq.indent) {
        const bv = this.startBlockValue(seq);
        if (bv) {
          this.stack.push(bv);
          return;
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *flowCollection(fc) {
      const it = fc.items[fc.items.length - 1];
      if (this.type === "flow-error-end") {
        let top;
        do {
          yield* this.pop();
          top = this.peek(1);
        } while (top?.type === "flow-collection");
      } else if (fc.end.length === 0) {
        switch (this.type) {
          case "comma":
          case "explicit-key-ind":
            if (!it || it.sep)
              fc.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
          case "map-value-ind":
            if (!it || it.value)
              fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
            else if (it.sep)
              it.sep.push(this.sourceToken);
            else
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            return;
          case "space":
          case "comment":
          case "newline":
          case "anchor":
          case "tag":
            if (!it || it.value)
              fc.items.push({ start: [this.sourceToken] });
            else if (it.sep)
              it.sep.push(this.sourceToken);
            else
              it.start.push(this.sourceToken);
            return;
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar": {
            const fs = this.flowScalar(this.type);
            if (!it || it.value)
              fc.items.push({ start: [], key: fs, sep: [] });
            else if (it.sep)
              this.stack.push(fs);
            else
              Object.assign(it, { key: fs, sep: [] });
            return;
          }
          case "flow-map-end":
          case "flow-seq-end":
            fc.end.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(fc);
        if (bv)
          this.stack.push(bv);
        else {
          yield* this.pop();
          yield* this.step();
        }
      } else {
        const parent = this.peek(2);
        if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
          yield* this.pop();
          yield* this.step();
        } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          fixFlowSeqItems(fc);
          const sep = fc.end.splice(1, fc.end.length);
          sep.push(this.sourceToken);
          const map = {
            type: "block-map",
            offset: fc.offset,
            indent: fc.indent,
            items: [{ start, key: fc, sep }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else {
          yield* this.lineEnd(fc);
        }
      }
    }
    flowScalar(type) {
      if (this.onNewLine) {
        let nl = this.source.indexOf(`
`) + 1;
        while (nl !== 0) {
          this.onNewLine(this.offset + nl);
          nl = this.source.indexOf(`
`, nl) + 1;
        }
      }
      return {
        type,
        offset: this.offset,
        indent: this.indent,
        source: this.source
      };
    }
    startBlockValue(parent) {
      switch (this.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return this.flowScalar(this.type);
        case "block-scalar-header":
          return {
            type: "block-scalar",
            offset: this.offset,
            indent: this.indent,
            props: [this.sourceToken],
            source: ""
          };
        case "flow-map-start":
        case "flow-seq-start":
          return {
            type: "flow-collection",
            offset: this.offset,
            indent: this.indent,
            start: this.sourceToken,
            items: [],
            end: []
          };
        case "seq-item-ind":
          return {
            type: "block-seq",
            offset: this.offset,
            indent: this.indent,
            items: [{ start: [this.sourceToken] }]
          };
        case "explicit-key-ind": {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          start.push(this.sourceToken);
          return {
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start, explicitKey: true }]
          };
        }
        case "map-value-ind": {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          return {
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start, key: null, sep: [this.sourceToken] }]
          };
        }
      }
      return null;
    }
    atIndentedComment(start, indent) {
      if (this.type !== "comment")
        return false;
      if (this.indent <= indent)
        return false;
      return start.every((st) => st.type === "newline" || st.type === "space");
    }
    *documentEnd(docEnd) {
      if (this.type !== "doc-mode") {
        if (docEnd.end)
          docEnd.end.push(this.sourceToken);
        else
          docEnd.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
      }
    }
    *lineEnd(token) {
      switch (this.type) {
        case "comma":
        case "doc-start":
        case "doc-end":
        case "flow-seq-end":
        case "flow-map-end":
        case "map-value-ind":
          yield* this.pop();
          yield* this.step();
          break;
        case "newline":
          this.onKeyLine = false;
        case "space":
        case "comment":
        default:
          if (token.end)
            token.end.push(this.sourceToken);
          else
            token.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
      }
    }
  }
  exports.Parser = Parser;
});
var require_public_api = __commonJS((exports) => {
  var composer = require_composer();
  var Document = require_Document();
  var errors = require_errors();
  var log = require_log();
  var identity = require_identity();
  var lineCounter = require_line_counter();
  var parser = require_parser();
  function parseOptions(options) {
    const prettyErrors = options.prettyErrors !== false;
    const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter || null;
    return { lineCounter: lineCounter$1, prettyErrors };
  }
  function parseAllDocuments(source, options = {}) {
    const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
    const composer$1 = new composer.Composer(options);
    const docs = Array.from(composer$1.compose(parser$1.parse(source)));
    if (prettyErrors && lineCounter2)
      for (const doc of docs) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
    if (docs.length > 0)
      return docs;
    return Object.assign([], { empty: true }, composer$1.streamInfo());
  }
  function parseDocument(source, options = {}) {
    const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
    const composer$1 = new composer.Composer(options);
    let doc = null;
    for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
      if (!doc)
        doc = _doc;
      else if (doc.options.logLevel !== "silent") {
        doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
        break;
      }
    }
    if (prettyErrors && lineCounter2) {
      doc.errors.forEach(errors.prettifyError(source, lineCounter2));
      doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
    }
    return doc;
  }
  function parse(src, reviver, options) {
    let _reviver = undefined;
    if (typeof reviver === "function") {
      _reviver = reviver;
    } else if (options === undefined && reviver && typeof reviver === "object") {
      options = reviver;
    }
    const doc = parseDocument(src, options);
    if (!doc)
      return null;
    doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
    if (doc.errors.length > 0) {
      if (doc.options.logLevel !== "silent")
        throw doc.errors[0];
      else
        doc.errors = [];
    }
    return doc.toJS(Object.assign({ reviver: _reviver }, options));
  }
  function stringify(value, replacer, options) {
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === undefined && replacer) {
      options = replacer;
    }
    if (typeof options === "string")
      options = options.length;
    if (typeof options === "number") {
      const indent = Math.round(options);
      options = indent < 1 ? undefined : indent > 8 ? { indent: 8 } : { indent };
    }
    if (value === undefined) {
      const { keepUndefined } = options ?? replacer ?? {};
      if (!keepUndefined)
        return;
    }
    if (identity.isDocument(value) && !_replacer)
      return value.toString(options);
    return new Document.Document(value, _replacer, options).toString(options);
  }
  exports.parse = parse;
  exports.parseAllDocuments = parseAllDocuments;
  exports.parseDocument = parseDocument;
  exports.stringify = stringify;
});
var require_dist = __commonJS((exports) => {
  var composer = require_composer();
  var Document = require_Document();
  var Schema = require_Schema();
  var errors = require_errors();
  var Alias = require_Alias();
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var cst = require_cst();
  var lexer = require_lexer();
  var lineCounter = require_line_counter();
  var parser = require_parser();
  var publicApi = require_public_api();
  var visit = require_visit();
  exports.Composer = composer.Composer;
  exports.Document = Document.Document;
  exports.Schema = Schema.Schema;
  exports.YAMLError = errors.YAMLError;
  exports.YAMLParseError = errors.YAMLParseError;
  exports.YAMLWarning = errors.YAMLWarning;
  exports.Alias = Alias.Alias;
  exports.isAlias = identity.isAlias;
  exports.isCollection = identity.isCollection;
  exports.isDocument = identity.isDocument;
  exports.isMap = identity.isMap;
  exports.isNode = identity.isNode;
  exports.isPair = identity.isPair;
  exports.isScalar = identity.isScalar;
  exports.isSeq = identity.isSeq;
  exports.Pair = Pair.Pair;
  exports.Scalar = Scalar.Scalar;
  exports.YAMLMap = YAMLMap.YAMLMap;
  exports.YAMLSeq = YAMLSeq.YAMLSeq;
  exports.CST = cst;
  exports.Lexer = lexer.Lexer;
  exports.LineCounter = lineCounter.LineCounter;
  exports.Parser = parser.Parser;
  exports.parse = publicApi.parse;
  exports.parseAllDocuments = publicApi.parseAllDocuments;
  exports.parseDocument = publicApi.parseDocument;
  exports.stringify = publicApi.stringify;
  exports.visit = visit.visit;
  exports.visitAsync = visit.visitAsync;
});
var PIPELINE_PROVIDER_CHOICES = [
  "none",
  "acpx",
  "llama-cpp",
  "ollama",
  "claude-code",
  "codex",
  "opencode",
  "anthropic",
  "openrouter",
  "openai-compatible",
  "command"
];
var SYNTHESIS_PROVIDER_CHOICES = PIPELINE_PROVIDER_CHOICES.filter((provider) => provider !== "command");
var PIPELINE_PROVIDER_SET = new Set(PIPELINE_PROVIDER_CHOICES);
var SYNTHESIS_PROVIDER_SET = new Set(SYNTHESIS_PROVIDER_CHOICES);
var MEMORIES_FTS_TOKENIZER = "unicode61";
function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}
function createMemoriesFts(db) {
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
			content,
			content='memories',
			content_rowid='rowid',
			tokenize='${MEMORIES_FTS_TOKENIZER}'
		);
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
		END;
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
}
function recreateMemoriesFts(db) {
  db.exec("DROP TRIGGER IF EXISTS memories_ai");
  db.exec("DROP TRIGGER IF EXISTS memories_ad");
  db.exec("DROP TRIGGER IF EXISTS memories_au");
  db.exec("DROP TABLE IF EXISTS memories_fts");
  createMemoriesFts(db);
  db.exec("INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories");
}
function readMemoriesFtsSql(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts' AND type = 'table'").get();
  return typeof row?.sql === "string" ? row.sql : null;
}
function memoriesFtsNeedsTokenizerRepair(sql) {
  if (sql === null)
    return false;
  const normalized = normalizeSql(sql);
  if (normalized.includes("porter unicode61"))
    return true;
  return !normalized.includes(`tokenize='${MEMORIES_FTS_TOKENIZER}'`);
}
function up(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL,
			checksum TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS conversations (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			harness TEXT NOT NULL,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			summary TEXT,
			topics TEXT,
			decisions TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT NOT NULL,
			vector_clock TEXT NOT NULL DEFAULT '{}',
			version INTEGER DEFAULT 1,
			manual_override INTEGER DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS memories (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL DEFAULT 'fact',
			category TEXT,
			content TEXT NOT NULL,
			confidence REAL DEFAULT 1.0,
			importance REAL DEFAULT 0.5,
			source_id TEXT,
			source_type TEXT,
			tags TEXT,
			who TEXT,
			why TEXT,
			project TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT NOT NULL DEFAULT 'system',
			last_accessed TEXT,
			access_count INTEGER DEFAULT 0,
			vector_clock TEXT NOT NULL DEFAULT '{}',
			version INTEGER DEFAULT 1,
			manual_override INTEGER DEFAULT 0,
			pinned INTEGER DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS embeddings (
			id TEXT PRIMARY KEY,
			content_hash TEXT NOT NULL UNIQUE,
			vector BLOB NOT NULL,
			dimensions INTEGER NOT NULL,
			source_type TEXT NOT NULL,
			source_id TEXT NOT NULL,
			chunk_text TEXT NOT NULL,
			created_at TEXT NOT NULL
		);

		-- Indexes
		CREATE INDEX IF NOT EXISTS idx_conversations_session
			ON conversations(session_id);
		CREATE INDEX IF NOT EXISTS idx_conversations_harness
			ON conversations(harness);
		CREATE INDEX IF NOT EXISTS idx_memories_type
			ON memories(type);
		CREATE INDEX IF NOT EXISTS idx_memories_category
			ON memories(category);
		CREATE INDEX IF NOT EXISTS idx_memories_pinned
			ON memories(pinned);
		CREATE INDEX IF NOT EXISTS idx_memories_importance
			ON memories(importance DESC);
		CREATE INDEX IF NOT EXISTS idx_memories_created
			ON memories(created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_embeddings_source
			ON embeddings(source_type, source_id);
		CREATE INDEX IF NOT EXISTS idx_embeddings_hash
			ON embeddings(content_hash);
	`);
  try {
    db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
				embedding FLOAT[768]
			);
		`);
  } catch {}
  createMemoriesFts(db);
}
function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
function addColumnIfMissing(db, table, column, definition) {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up2(db) {
  addColumnIfMissing(db, "memories", "content_hash", "TEXT");
  addColumnIfMissing(db, "memories", "normalized_content", "TEXT");
  addColumnIfMissing(db, "memories", "is_deleted", "INTEGER DEFAULT 0");
  addColumnIfMissing(db, "memories", "deleted_at", "TEXT");
  addColumnIfMissing(db, "memories", "extraction_status", "TEXT DEFAULT 'none'");
  addColumnIfMissing(db, "memories", "embedding_model", "TEXT");
  addColumnIfMissing(db, "memories", "extraction_model", "TEXT");
  addColumnIfMissing(db, "memories", "update_count", "INTEGER DEFAULT 0");
  addColumnIfMissing(db, "memories", "who", "TEXT");
  addColumnIfMissing(db, "memories", "why", "TEXT");
  addColumnIfMissing(db, "memories", "project", "TEXT");
  addColumnIfMissing(db, "memories", "pinned", "INTEGER DEFAULT 0");
  addColumnIfMissing(db, "memories", "importance", "REAL DEFAULT 0.5");
  addColumnIfMissing(db, "memories", "last_accessed", "TEXT");
  addColumnIfMissing(db, "memories", "access_count", "INTEGER DEFAULT 0");
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_history (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			event TEXT NOT NULL,
			old_content TEXT,
			new_content TEXT,
			changed_by TEXT NOT NULL,
			reason TEXT,
			metadata TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY (memory_id) REFERENCES memories(id)
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_jobs (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			job_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			payload TEXT,
			result TEXT,
			attempts INTEGER DEFAULT 0,
			max_attempts INTEGER DEFAULT 3,
			leased_at TEXT,
			completed_at TEXT,
			failed_at TEXT,
			error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			FOREIGN KEY (memory_id) REFERENCES memories(id)
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS entities (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			entity_type TEXT NOT NULL,
			description TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS relations (
			id TEXT PRIMARY KEY,
			source_entity_id TEXT NOT NULL,
			target_entity_id TEXT NOT NULL,
			relation_type TEXT NOT NULL,
			strength REAL DEFAULT 1.0,
			metadata TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY (source_entity_id) REFERENCES entities(id),
			FOREIGN KEY (target_entity_id) REFERENCES entities(id)
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_entity_mentions (
			memory_id TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			PRIMARY KEY (memory_id, entity_id),
			FOREIGN KEY (memory_id) REFERENCES memories(id),
			FOREIGN KEY (entity_id) REFERENCES entities(id)
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			version INTEGER NOT NULL,
			applied_at TEXT NOT NULL,
			duration_ms INTEGER,
			checksum TEXT
		);
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memories_content_hash
			ON memories(content_hash);
		CREATE INDEX IF NOT EXISTS idx_memories_is_deleted
			ON memories(is_deleted);
		CREATE INDEX IF NOT EXISTS idx_memories_extraction_status
			ON memories(extraction_status);
		CREATE INDEX IF NOT EXISTS idx_memory_history_memory_id
			ON memory_history(memory_id);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_status
			ON memory_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_memory_id
			ON memory_jobs(memory_id);
		CREATE INDEX IF NOT EXISTS idx_relations_source
			ON relations(source_entity_id);
		CREATE INDEX IF NOT EXISTS idx_relations_target
			ON relations(target_entity_id);
		CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity
			ON memory_entity_mentions(entity_id);
	`);
}
function addColumnIfMissing2(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (rows.some((r) => r.name === column))
    return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}
function up3(db) {
  addColumnIfMissing2(db, "memories", "why", "TEXT");
  addColumnIfMissing2(db, "memories", "project", "TEXT");
  db.exec(`DROP INDEX IF EXISTS idx_memories_content_hash`);
  db.exec(`
		UPDATE memories
		SET content_hash = NULL
		WHERE content_hash IS NOT NULL
		  AND is_deleted = 0
		  AND id NOT IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (
					PARTITION BY content_hash
					ORDER BY created_at DESC, rowid DESC
				) AS rn
				FROM memories
				WHERE content_hash IS NOT NULL
				  AND is_deleted = 0
			) ranked
			WHERE rn = 1
		  )
	`);
  db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash_unique
			ON memories(content_hash)
			WHERE content_hash IS NOT NULL AND is_deleted = 0
	`);
}
function hasColumn2(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
function addColumnIfMissing3(db, table, column, definition) {
  if (!hasColumn2(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up4(db) {
  addColumnIfMissing3(db, "memory_history", "actor_type", "TEXT");
  addColumnIfMissing3(db, "memory_history", "session_id", "TEXT");
  addColumnIfMissing3(db, "memory_history", "request_id", "TEXT");
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memories_deleted_at
			ON memories(deleted_at)
			WHERE is_deleted = 1;
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_history_created_at
			ON memory_history(created_at);
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_completed_at
			ON memory_jobs(completed_at)
			WHERE status = 'completed';
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_failed_at
			ON memory_jobs(failed_at)
			WHERE status = 'dead';
	`);
}
function hasColumn3(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
function addColumnIfMissing4(db, table, column, definition) {
  if (!hasColumn3(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up5(db) {
  addColumnIfMissing4(db, "entities", "canonical_name", "TEXT");
  addColumnIfMissing4(db, "entities", "mentions", "INTEGER DEFAULT 0");
  addColumnIfMissing4(db, "entities", "embedding", "BLOB");
  addColumnIfMissing4(db, "relations", "mentions", "INTEGER DEFAULT 1");
  addColumnIfMissing4(db, "relations", "confidence", "REAL DEFAULT 0.5");
  addColumnIfMissing4(db, "relations", "updated_at", "TEXT");
  addColumnIfMissing4(db, "memory_entity_mentions", "mention_text", "TEXT");
  addColumnIfMissing4(db, "memory_entity_mentions", "confidence", "REAL");
  addColumnIfMissing4(db, "memory_entity_mentions", "created_at", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entities_canonical_name ON entities(canonical_name)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_relations_composite ON relations(source_entity_id, relation_type)");
}
function hasColumn4(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
function up6(db) {
  if (!hasColumn4(db, "memories", "idempotency_key")) {
    db.exec("ALTER TABLE memories ADD COLUMN idempotency_key TEXT");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_idempotency_key
		 ON memories(idempotency_key)
		 WHERE idempotency_key IS NOT NULL`);
  if (!hasColumn4(db, "memories", "runtime_path")) {
    db.exec("ALTER TABLE memories ADD COLUMN runtime_path TEXT");
  }
}
function hasColumn5(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
function up7(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS documents (
			id TEXT PRIMARY KEY,
			source_url TEXT,
			source_type TEXT NOT NULL,
			content_type TEXT,
			content_hash TEXT,
			title TEXT,
			raw_content TEXT,
			status TEXT NOT NULL DEFAULT 'queued',
			error TEXT,
			connector_id TEXT,
			chunk_count INTEGER NOT NULL DEFAULT 0,
			memory_count INTEGER NOT NULL DEFAULT 0,
			metadata_json TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_status
		 ON documents(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_source_url
		 ON documents(source_url)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_connector_id
		 ON documents(connector_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_content_hash
		 ON documents(content_hash)`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS document_memories (
			document_id TEXT NOT NULL REFERENCES documents(id),
			memory_id TEXT NOT NULL REFERENCES memories(id),
			chunk_index INTEGER,
			PRIMARY KEY (document_id, memory_id)
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS connectors (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			display_name TEXT,
			config_json TEXT NOT NULL,
			cursor_json TEXT,
			status TEXT NOT NULL DEFAULT 'idle',
			last_sync_at TEXT,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_connectors_provider
		 ON connectors(provider)`);
  if (!hasColumn5(db, "memory_jobs", "document_id")) {
    db.exec("ALTER TABLE memory_jobs ADD COLUMN document_id TEXT");
  }
}
function up8(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'").all();
  if (tables.length === 0)
    return;
  db.exec(`
		DELETE FROM embeddings
		WHERE rowid NOT IN (
			SELECT MIN(rowid) FROM embeddings
			GROUP BY content_hash
		)
	`);
  db.exec(`DROP INDEX IF EXISTS idx_embeddings_hash`);
  db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_content_hash_unique
			ON embeddings(content_hash)
	`);
}
function up9(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS summary_jobs (
			id TEXT PRIMARY KEY,
			session_key TEXT,
			harness TEXT NOT NULL,
			project TEXT,
			transcript TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT,
			attempts INTEGER DEFAULT 0,
			max_attempts INTEGER DEFAULT 3,
			created_at TEXT NOT NULL,
			completed_at TEXT,
			error TEXT
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_summary_jobs_status
		 ON summary_jobs(status)`);
}
function up10(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS umap_cache (
			id INTEGER PRIMARY KEY,
			dimensions INTEGER NOT NULL,
			embedding_count INTEGER NOT NULL,
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL
		)
	`);
}
function up11(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_scores (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			project TEXT,
			harness TEXT,
			score REAL NOT NULL,
			memories_recalled INTEGER,
			memories_used INTEGER,
			novel_context_count INTEGER,
			reasoning TEXT,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_session_scores_project
			ON session_scores(project, created_at);
		CREATE INDEX IF NOT EXISTS idx_session_scores_session
			ON session_scores(session_key);
	`);
}
function up12(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS scheduled_tasks (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			prompt TEXT NOT NULL,
			cron_expression TEXT NOT NULL,
			harness TEXT NOT NULL,
			working_directory TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			last_run_at TEXT,
			next_run_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled_next
			ON scheduled_tasks(enabled, next_run_at);

		CREATE TABLE IF NOT EXISTS task_runs (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
			status TEXT NOT NULL DEFAULT 'pending',
			started_at TEXT NOT NULL,
			completed_at TEXT,
			exit_code INTEGER,
			stdout TEXT,
			stderr TEXT,
			error TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_task_runs_task_id
			ON task_runs(task_id);
		CREATE INDEX IF NOT EXISTS idx_task_runs_status
			ON task_runs(status);
	`);
}
function addColumnIfMissing5(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up13(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS ingestion_jobs (
			id TEXT PRIMARY KEY,
			source_path TEXT NOT NULL,
			source_type TEXT NOT NULL,
			file_hash TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			chunks_total INTEGER DEFAULT 0,
			chunks_processed INTEGER DEFAULT 0,
			memories_created INTEGER DEFAULT 0,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			error TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status
			ON ingestion_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_file_hash
			ON ingestion_jobs(file_hash);
		CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_source_path
			ON ingestion_jobs(source_path);
	`);
  addColumnIfMissing5(db, "memories", "source_path", "TEXT");
  addColumnIfMissing5(db, "memories", "source_section", "TEXT");
}
function up14(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS telemetry_events (
			id TEXT PRIMARY KEY,
			event TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			properties TEXT NOT NULL,
			sent_to_posthog INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_telemetry_events_event
			ON telemetry_events(event);
		CREATE INDEX IF NOT EXISTS idx_telemetry_events_timestamp
			ON telemetry_events(timestamp);
		CREATE INDEX IF NOT EXISTS idx_telemetry_events_unsent
			ON telemetry_events(sent_to_posthog) WHERE sent_to_posthog = 0;
	`);
}
function addColumnIfMissing6(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up15(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_memories (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			source TEXT NOT NULL,
			effective_score REAL,
			predictor_score REAL,
			final_score REAL NOT NULL,
			rank INTEGER NOT NULL,
			was_injected INTEGER NOT NULL,
			relevance_score REAL,
			fts_hit_count INTEGER NOT NULL DEFAULT 0,
			agent_preference TEXT,
			created_at TEXT NOT NULL,
			UNIQUE(session_key, memory_id)
		);

		CREATE INDEX IF NOT EXISTS idx_session_memories_session
			ON session_memories(session_key);
		CREATE INDEX IF NOT EXISTS idx_session_memories_memory
			ON session_memories(memory_id);
	`);
  addColumnIfMissing6(db, "session_scores", "confidence", "REAL");
  addColumnIfMissing6(db, "session_scores", "continuity_reasoning", "TEXT");
}
function up16(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_checkpoints (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			harness TEXT NOT NULL,
			project TEXT,
			project_normalized TEXT,
			trigger TEXT NOT NULL,
			digest TEXT NOT NULL,
			prompt_count INTEGER NOT NULL,
			memory_queries TEXT,
			recent_remembers TEXT,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_checkpoints_session
			ON session_checkpoints(session_key, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_checkpoints_project
			ON session_checkpoints(project_normalized, created_at DESC);
	`);
}
function up17(db) {
  const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all();
  const colNames = new Set(cols.flatMap((c) => typeof c.name === "string" ? [c.name] : []));
  if (!colNames.has("skill_name")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN skill_name TEXT");
  }
  if (!colNames.has("skill_mode")) {
    db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN skill_mode TEXT
			 CHECK (skill_mode IN ('inject', 'slash') OR skill_mode IS NULL)`);
  }
}
function up18(db) {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_meta'").get();
  if (existing)
    return;
  db.exec(`
		CREATE TABLE skill_meta (
			entity_id     TEXT PRIMARY KEY REFERENCES entities(id),
			agent_id      TEXT NOT NULL DEFAULT 'default',
			version       TEXT,
			author        TEXT,
			license       TEXT,
			source        TEXT NOT NULL,
			role          TEXT NOT NULL DEFAULT 'utility',
			triggers      TEXT,
			tags          TEXT,
			permissions   TEXT,
			enriched      INTEGER DEFAULT 0,
			installed_at  TEXT NOT NULL,
			last_used_at  TEXT,
			use_count     INTEGER DEFAULT 0,
			importance    REAL DEFAULT 0.7,
			decay_rate    REAL DEFAULT 0.99,
			fs_path       TEXT NOT NULL,
			uninstalled_at TEXT,
			created_at    TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX idx_skill_meta_agent ON skill_meta(agent_id);
		CREATE INDEX idx_skill_meta_source ON skill_meta(source);
	`);
}
function up19(db) {
  const entityCols = db.prepare("PRAGMA table_info(entities)").all();
  const entityColNames = new Set(entityCols.flatMap((c) => typeof c.name === "string" ? [c.name] : []));
  if (!entityColNames.has("agent_id")) {
    db.exec("ALTER TABLE entities ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_entities_agent ON entities(agent_id)");
  db.exec(`
		CREATE TABLE IF NOT EXISTS entity_aspects (
			id             TEXT PRIMARY KEY,
			entity_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			agent_id       TEXT NOT NULL DEFAULT 'default',
			name           TEXT NOT NULL,
			canonical_name TEXT NOT NULL,
			weight         REAL NOT NULL DEFAULT 0.5,
			created_at     TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(entity_id, canonical_name)
		);

		CREATE INDEX IF NOT EXISTS idx_entity_aspects_entity ON entity_aspects(entity_id);
		CREATE INDEX IF NOT EXISTS idx_entity_aspects_agent ON entity_aspects(agent_id);
		CREATE INDEX IF NOT EXISTS idx_entity_aspects_weight ON entity_aspects(weight DESC);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS entity_attributes (
			id                 TEXT PRIMARY KEY,
			aspect_id          TEXT REFERENCES entity_aspects(id) ON DELETE SET NULL,
			agent_id           TEXT NOT NULL DEFAULT 'default',
			memory_id          TEXT REFERENCES memories(id) ON DELETE SET NULL,
			kind               TEXT NOT NULL,
			content            TEXT NOT NULL,
			normalized_content TEXT NOT NULL,
			confidence         REAL NOT NULL DEFAULT 0.0,
			importance         REAL NOT NULL DEFAULT 0.5,
			status             TEXT NOT NULL DEFAULT 'active',
			superseded_by      TEXT,
			created_at         TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_entity_attributes_aspect ON entity_attributes(aspect_id);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_agent ON entity_attributes(agent_id);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_kind ON entity_attributes(kind);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_status ON entity_attributes(status);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS entity_dependencies (
			id                TEXT PRIMARY KEY,
			source_entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			target_entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			agent_id          TEXT NOT NULL DEFAULT 'default',
			aspect_id         TEXT REFERENCES entity_aspects(id) ON DELETE SET NULL,
			dependency_type   TEXT NOT NULL,
			strength          REAL NOT NULL DEFAULT 0.5,
			created_at        TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_entity_dependencies_source ON entity_dependencies(source_entity_id);
		CREATE INDEX IF NOT EXISTS idx_entity_dependencies_target ON entity_dependencies(target_entity_id);
		CREATE INDEX IF NOT EXISTS idx_entity_dependencies_agent ON entity_dependencies(agent_id);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS task_meta (
			entity_id        TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
			agent_id         TEXT NOT NULL DEFAULT 'default',
			status           TEXT NOT NULL,
			expires_at       TEXT,
			retention_until  TEXT,
			completed_at     TEXT,
			updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_task_meta_agent ON task_meta(agent_id);
		CREATE INDEX IF NOT EXISTS idx_task_meta_status ON task_meta(status);
		CREATE INDEX IF NOT EXISTS idx_task_meta_retention ON task_meta(retention_until);
	`);
}
function addColumnIfMissing7(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up20(db) {
  addColumnIfMissing7(db, "session_memories", "entity_slot", "INTEGER");
  addColumnIfMissing7(db, "session_memories", "aspect_slot", "INTEGER");
  addColumnIfMissing7(db, "session_memories", "is_constraint", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing7(db, "session_memories", "structural_density", "INTEGER");
}
function up21(db) {
  const columns = db.prepare("PRAGMA table_info(session_checkpoints)").all();
  const columnNames = new Set(columns.flatMap((column) => typeof column.name === "string" ? [column.name] : []));
  if (!columnNames.has("focal_entity_ids")) {
    db.exec("ALTER TABLE session_checkpoints ADD COLUMN focal_entity_ids TEXT");
  }
  if (!columnNames.has("focal_entity_names")) {
    db.exec("ALTER TABLE session_checkpoints ADD COLUMN focal_entity_names TEXT");
  }
  if (!columnNames.has("active_aspect_ids")) {
    db.exec("ALTER TABLE session_checkpoints ADD COLUMN active_aspect_ids TEXT");
  }
  if (!columnNames.has("surfaced_constraint_count")) {
    db.exec("ALTER TABLE session_checkpoints ADD COLUMN surfaced_constraint_count INTEGER");
  }
  if (!columnNames.has("traversal_memory_count")) {
    db.exec("ALTER TABLE session_checkpoints ADD COLUMN traversal_memory_count INTEGER");
  }
}
function addColumnIfMissing8(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up22(db) {
  addColumnIfMissing8(db, "entities", "pinned", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing8(db, "entities", "pinned_at", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entities_pinned ON entities(agent_id, pinned, pinned_at DESC)");
}
function up23(_db) {}
function up24(_db) {}
function addColumnIfMissing9(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up25(db) {
  addColumnIfMissing9(db, "session_memories", "agent_relevance_score", "REAL");
  addColumnIfMissing9(db, "session_memories", "agent_feedback_count", "INTEGER DEFAULT 0");
}
function up26(_db) {}
function up27(db) {
  db.exec(`
		UPDATE entities
		SET canonical_name = REPLACE(REPLACE(REPLACE(
			LOWER(TRIM(name)),
			'  ', ' '), '  ', ' '), '  ', ' ')
		WHERE canonical_name IS NULL
	`);
}
function up28(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS memories_cold (
			archive_id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			type TEXT DEFAULT 'fact',
			category TEXT,
			content TEXT NOT NULL,
			confidence REAL DEFAULT 1.0,
			importance REAL DEFAULT 0.5,
			source_id TEXT,
			source_type TEXT,
			tags TEXT,
			who TEXT,
			why TEXT,
			project TEXT,
			content_hash TEXT,
			normalized_content TEXT,
			extraction_status TEXT,
			embedding_model TEXT,
			extraction_model TEXT,
			update_count INTEGER DEFAULT 0,
			original_created_at TEXT NOT NULL,
			archived_at TEXT NOT NULL,
			archived_reason TEXT,
			cold_source_id TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			original_row_json TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_cold_memory_id ON memories_cold(memory_id);
		CREATE INDEX IF NOT EXISTS idx_cold_agent ON memories_cold(agent_id);
		CREATE INDEX IF NOT EXISTS idx_cold_project ON memories_cold(project);
		CREATE INDEX IF NOT EXISTS idx_cold_archived_at ON memories_cold(archived_at);
		CREATE INDEX IF NOT EXISTS idx_cold_source ON memories_cold(cold_source_id);
	`);
}
function up29(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_summaries (
			id TEXT PRIMARY KEY,
			project TEXT,
			depth INTEGER NOT NULL DEFAULT 0,
			kind TEXT NOT NULL CHECK(kind IN ('session', 'arc', 'epoch')),
			content TEXT NOT NULL,
			token_count INTEGER,
			earliest_at TEXT NOT NULL,
			latest_at TEXT NOT NULL,
			session_key TEXT,
			harness TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS session_summary_children (
			parent_id TEXT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
			child_id TEXT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
			ordinal INTEGER NOT NULL,
			PRIMARY KEY (parent_id, child_id)
		);

		-- No FK on memory_id: memories may be soft-deleted, purged, or
		-- archived to cold tier. The link is intentionally durable so
		-- summary lineage survives retention sweeps.
		CREATE TABLE IF NOT EXISTS session_summary_memories (
			summary_id TEXT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
			memory_id TEXT NOT NULL,
			PRIMARY KEY (summary_id, memory_id)
		);

		CREATE INDEX IF NOT EXISTS idx_summaries_project_depth ON session_summaries(project, depth);
		CREATE INDEX IF NOT EXISTS idx_summaries_kind ON session_summaries(kind);
		CREATE INDEX IF NOT EXISTS idx_summaries_agent ON session_summaries(agent_id);
		CREATE INDEX IF NOT EXISTS idx_summaries_latest ON session_summaries(latest_at DESC);
		CREATE INDEX IF NOT EXISTS idx_summary_children_child ON session_summary_children(child_id);
		CREATE INDEX IF NOT EXISTS idx_summaries_session_key ON session_summaries(session_key);
		-- Unique constraint prevents duplicate depth-0 rows on retry
		CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_session_depth
			ON session_summaries(session_key, depth)
			WHERE session_key IS NOT NULL;
	`);
}
function up30(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_jobs_new (
			id TEXT PRIMARY KEY,
			memory_id TEXT,
			job_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			payload TEXT,
			result TEXT,
			attempts INTEGER DEFAULT 0,
			max_attempts INTEGER DEFAULT 3,
			leased_at TEXT,
			completed_at TEXT,
			failed_at TEXT,
			error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			document_id TEXT,
			FOREIGN KEY (memory_id) REFERENCES memories(id)
		)
	`);
  db.exec(`
		INSERT INTO memory_jobs_new
			(id, memory_id, job_type, status, payload, result,
			 attempts, max_attempts, leased_at, completed_at, failed_at,
			 error, created_at, updated_at, document_id)
		SELECT
			id, memory_id, job_type, status, payload, result,
			attempts, max_attempts, leased_at, completed_at, failed_at,
			error, created_at, updated_at, document_id
		FROM memory_jobs
	`);
  db.exec("DROP TABLE IF EXISTS memory_jobs");
  db.exec("ALTER TABLE memory_jobs_new RENAME TO memory_jobs");
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_status
			ON memory_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_memory_id
			ON memory_jobs(memory_id);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_completed_at
			ON memory_jobs(completed_at);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_failed_at
			ON memory_jobs(failed_at);
	`);
}
function up31(db) {
  const depCols = db.prepare("PRAGMA table_info(entity_dependencies)").all();
  if (!depCols.some((c) => c.name === "reason")) {
    db.exec("ALTER TABLE entity_dependencies ADD COLUMN reason TEXT");
  }
  const entCols = db.prepare("PRAGMA table_info(entities)").all();
  if (!entCols.some((c) => c.name === "last_synthesized_at")) {
    db.exec("ALTER TABLE entities ADD COLUMN last_synthesized_at TEXT");
  }
}
function up32(db) {
  const cols = db.prepare("PRAGMA table_info(embeddings)").all();
  if (cols.length === 0)
    return;
  if (!cols.some((c) => c.name === "vector")) {
    db.exec("ALTER TABLE embeddings ADD COLUMN vector BLOB");
  }
}
function up33(db) {
  const cols = db.prepare("PRAGMA table_info(memories)").all();
  if (!cols.some((c) => c.name === "scope")) {
    db.exec("ALTER TABLE memories ADD COLUMN scope TEXT DEFAULT NULL");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope) WHERE scope IS NOT NULL");
}
function up34(db) {
  db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
  db.exec(`
		CREATE UNIQUE INDEX idx_memories_content_hash_unique
		ON memories(content_hash, COALESCE(scope, '__NULL__'))
		WHERE content_hash IS NOT NULL AND is_deleted = 0
	`);
}
function up35(db) {
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
			name, canonical_name,
			content='entities', content_rowid='rowid'
		)
	`);
  db.exec(`
		INSERT INTO entities_fts(rowid, name, canonical_name)
		SELECT rowid, name, canonical_name FROM entities
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
			INSERT INTO entities_fts(rowid, name, canonical_name)
			VALUES (new.rowid, new.name, new.canonical_name);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
			INSERT INTO entities_fts(entities_fts, rowid, name, canonical_name)
			VALUES ('delete', old.rowid, old.name, old.canonical_name);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
			INSERT INTO entities_fts(entities_fts, rowid, name, canonical_name)
			VALUES ('delete', old.rowid, old.name, old.canonical_name);
			INSERT INTO entities_fts(rowid, name, canonical_name)
			VALUES (new.rowid, new.name, new.canonical_name);
		END
	`);
}
function up36(db) {
  const cols = db.prepare("PRAGMA table_info(entity_dependencies)").all();
  if (!cols.some((c) => c.name === "confidence")) {
    db.exec("ALTER TABLE entity_dependencies ADD COLUMN confidence REAL DEFAULT 0.7");
  }
}
function up37(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS entity_communities (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			name TEXT,
			cohesion REAL DEFAULT 0.0,
			member_count INTEGER DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_entity_communities_agent ON entity_communities(agent_id)");
  const cols = db.prepare("PRAGMA table_info(entities)").all();
  if (!cols.some((c) => c.name === "community_id")) {
    db.exec("ALTER TABLE entities ADD COLUMN community_id TEXT REFERENCES entity_communities(id)");
  }
}
function up38(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_hints (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
			agent_id TEXT NOT NULL,
			hint TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(memory_id, hint)
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hints_memory ON memory_hints(memory_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hints_agent ON memory_hints(agent_id)`);
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_hints_fts USING fts5(
			hint,
			content='memory_hints', content_rowid='rowid'
		)
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_hints_fts_ai AFTER INSERT ON memory_hints BEGIN
			INSERT INTO memory_hints_fts(rowid, hint)
			VALUES (new.rowid, new.hint);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_hints_fts_ad AFTER DELETE ON memory_hints BEGIN
			INSERT INTO memory_hints_fts(memory_hints_fts, rowid, hint)
			VALUES ('delete', old.rowid, old.hint);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_hints_fts_au AFTER UPDATE ON memory_hints BEGIN
			INSERT INTO memory_hints_fts(memory_hints_fts, rowid, hint)
			VALUES ('delete', old.rowid, old.hint);
			INSERT INTO memory_hints_fts(rowid, hint)
			VALUES (new.rowid, new.hint);
		END
	`);
}
function up39(db) {
  db.exec(`
		DELETE FROM entity_dependencies
		WHERE id NOT IN (
			SELECT MIN(id) FROM entity_dependencies
			GROUP BY source_entity_id, target_entity_id,
			         dependency_type, agent_id
		)
	`);
  db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS
			idx_entity_deps_unique
		ON entity_dependencies(
			source_entity_id, target_entity_id,
			dependency_type, agent_id
		)
	`);
}
function up40(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_transcripts (
			session_key TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			harness TEXT,
			project TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_st_project
			ON session_transcripts(project);
		CREATE INDEX IF NOT EXISTS idx_st_created
			ON session_transcripts(created_at);
	`);
}
function addColumnIfMissing10(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up41(db) {
  addColumnIfMissing10(db, "session_memories", "path_json", "TEXT");
  db.exec(`
		CREATE TABLE IF NOT EXISTS path_feedback_events (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			path_hash TEXT NOT NULL,
			path_json TEXT NOT NULL,
			rating REAL NOT NULL,
			reward REAL NOT NULL DEFAULT 0,
			reward_forward REAL NOT NULL DEFAULT 0,
			reward_update REAL NOT NULL DEFAULT 0,
			reward_downstream REAL NOT NULL DEFAULT 0,
			reward_dead_end REAL NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_path_feedback_events_agent_path
			ON path_feedback_events(agent_id, path_hash);
		CREATE INDEX IF NOT EXISTS idx_path_feedback_events_session
			ON path_feedback_events(session_key);
		CREATE INDEX IF NOT EXISTS idx_path_feedback_events_memory
			ON path_feedback_events(memory_id);

		CREATE TABLE IF NOT EXISTS path_feedback_stats (
			agent_id TEXT NOT NULL,
			path_hash TEXT NOT NULL,
			path_json TEXT NOT NULL,
			q_value REAL NOT NULL DEFAULT 0,
			sample_count INTEGER NOT NULL DEFAULT 0,
			positive_count INTEGER NOT NULL DEFAULT 0,
			negative_count INTEGER NOT NULL DEFAULT 0,
			neutral_count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, path_hash)
		);

		CREATE TABLE IF NOT EXISTS entity_retrieval_stats (
			agent_id TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			session_count INTEGER NOT NULL DEFAULT 0,
			last_session_key TEXT,
			updated_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, entity_id)
		);

		CREATE TABLE IF NOT EXISTS entity_cooccurrence (
			agent_id TEXT NOT NULL,
			source_entity_id TEXT NOT NULL,
			target_entity_id TEXT NOT NULL,
			session_count INTEGER NOT NULL DEFAULT 0,
			last_session_key TEXT,
			updated_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, source_entity_id, target_entity_id)
		);

		CREATE TABLE IF NOT EXISTS path_feedback_sessions (
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, session_key)
		);
	`);
}
function addColumnIfMissing11(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function up42(db) {
  addColumnIfMissing11(db, "session_memories", "entity_slot", "INTEGER");
  addColumnIfMissing11(db, "session_memories", "aspect_slot", "INTEGER");
  addColumnIfMissing11(db, "session_memories", "is_constraint", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing11(db, "session_memories", "structural_density", "INTEGER");
  addColumnIfMissing11(db, "session_memories", "predictor_rank", "INTEGER");
  addColumnIfMissing11(db, "session_memories", "agent_relevance_score", "REAL");
  addColumnIfMissing11(db, "session_memories", "agent_feedback_count", "INTEGER DEFAULT 0");
  addColumnIfMissing11(db, "session_memories", "path_json", "TEXT");
  const cols = db.prepare("PRAGMA table_info(session_memories)").all();
  const hasAgent = cols.some((col) => col.name === "agent_id");
  const agentExpr = hasAgent ? "COALESCE(NULLIF(agent_id, ''), 'default')" : "'default'";
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_memories_new (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			memory_id TEXT NOT NULL,
			source TEXT NOT NULL,
			effective_score REAL,
			predictor_score REAL,
			final_score REAL NOT NULL,
			rank INTEGER NOT NULL,
			was_injected INTEGER NOT NULL,
			relevance_score REAL,
			fts_hit_count INTEGER NOT NULL DEFAULT 0,
			agent_preference TEXT,
			created_at TEXT NOT NULL,
			entity_slot INTEGER,
			aspect_slot INTEGER,
			is_constraint INTEGER NOT NULL DEFAULT 0,
			structural_density INTEGER,
			predictor_rank INTEGER,
			agent_relevance_score REAL,
			agent_feedback_count INTEGER DEFAULT 0,
			path_json TEXT,
			UNIQUE(session_key, agent_id, memory_id)
		);

		INSERT INTO session_memories_new
			(id, session_key, agent_id, memory_id, source,
			 effective_score, predictor_score, final_score, rank,
			 was_injected, relevance_score, fts_hit_count,
			 agent_preference, created_at, entity_slot, aspect_slot,
			 is_constraint, structural_density, predictor_rank,
			 agent_relevance_score, agent_feedback_count, path_json)
		SELECT
			id,
			session_key,
			${agentExpr},
			memory_id,
			source,
			effective_score,
			predictor_score,
			final_score,
			rank,
			was_injected,
			relevance_score,
			fts_hit_count,
			agent_preference,
			created_at,
			entity_slot,
			aspect_slot,
			COALESCE(is_constraint, 0),
			structural_density,
			predictor_rank,
			agent_relevance_score,
			COALESCE(agent_feedback_count, 0),
			path_json
		FROM session_memories;

		DROP TABLE session_memories;
		ALTER TABLE session_memories_new RENAME TO session_memories;

		CREATE INDEX IF NOT EXISTS idx_session_memories_session
			ON session_memories(session_key);
		CREATE INDEX IF NOT EXISTS idx_session_memories_memory
			ON session_memories(memory_id);
		CREATE INDEX IF NOT EXISTS idx_session_memories_agent_session
			ON session_memories(agent_id, session_key);
	`);
}
function addColumnIfMissing12(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function up43(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS agents (
			id           TEXT PRIMARY KEY,
			name         TEXT,
			read_policy  TEXT NOT NULL DEFAULT 'isolated',
			policy_group TEXT,
			created_at   TEXT NOT NULL,
			updated_at   TEXT NOT NULL
		);
	`);
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO agents (id, name, read_policy, created_at, updated_at)
		 VALUES ('default', 'default', 'shared', ?, ?)`).run(now, now);
  addColumnIfMissing12(db, "memories", "agent_id", "TEXT DEFAULT 'default'");
  addColumnIfMissing12(db, "memories", "visibility", "TEXT DEFAULT 'global'");
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memories_agent_id
			ON memories(agent_id);
		CREATE INDEX IF NOT EXISTS idx_memories_agent_visibility
			ON memories(agent_id, visibility);
	`);
}
function addColumnIfMissing13(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function up44(db) {
  addColumnIfMissing13(db, "session_summaries", "source_type", "TEXT");
  addColumnIfMissing13(db, "session_summaries", "source_ref", "TEXT");
  addColumnIfMissing13(db, "session_summaries", "meta_json", "TEXT");
  db.exec(`
		UPDATE session_summaries
		SET source_type = CASE
			WHEN source_type IS NOT NULL THEN source_type
			WHEN kind = 'session' THEN 'summary'
			WHEN kind IN ('arc', 'epoch') THEN 'condensation'
			ELSE kind
		END
		WHERE source_type IS NULL;

		CREATE INDEX IF NOT EXISTS idx_summaries_source_type
			ON session_summaries(source_type);
		CREATE INDEX IF NOT EXISTS idx_summaries_source_ref
			ON session_summaries(source_ref);
	`);
}
function addColumnIfMissing14(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function up45(db) {
  addColumnIfMissing14(db, "session_transcripts", "updated_at", "TEXT");
  addColumnIfMissing14(db, "summary_jobs", "agent_id", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing14(db, "session_scores", "agent_id", "TEXT NOT NULL DEFAULT 'default'");
  db.exec(`
		UPDATE session_transcripts
		SET updated_at = COALESCE(updated_at, created_at)
		WHERE updated_at IS NULL;

		UPDATE summary_jobs
		SET agent_id = COALESCE(agent_id, 'default')
		WHERE agent_id IS NULL;

		UPDATE session_scores
		SET agent_id = COALESCE(agent_id, 'default')
		WHERE agent_id IS NULL;

		CREATE INDEX IF NOT EXISTS idx_st_agent_updated
			ON session_transcripts(agent_id, updated_at);
		CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent
			ON summary_jobs(agent_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_session_scores_agent_session
			ON session_scores(agent_id, session_key, created_at);
	`);
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS session_transcripts_fts USING fts5(
			content,
			content='session_transcripts',
			content_rowid='rowid'
		)
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ai AFTER INSERT ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ad AFTER DELETE ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES ('delete', old.rowid, old.content);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_au AFTER UPDATE ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES ('delete', old.rowid, old.content);
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END
	`);
  db.exec(`
		INSERT INTO session_transcripts_fts(session_transcripts_fts)
		VALUES ('rebuild');
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_md_heads (
			agent_id TEXT PRIMARY KEY,
			content TEXT NOT NULL DEFAULT '',
			content_hash TEXT NOT NULL DEFAULT '',
			revision INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			lease_token TEXT,
			lease_owner TEXT,
			lease_expires_at TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_memory_md_heads_lease
			ON memory_md_heads(lease_expires_at);
	`);
}
function up46(db) {
  db.exec(`
		DROP INDEX IF EXISTS idx_summaries_session_depth;

		CREATE TEMP TABLE IF NOT EXISTS session_summary_duplicate_map AS
		WITH ranked AS (
			SELECT
				id,
				agent_id,
				session_key,
				depth,
				ROW_NUMBER() OVER (
					PARTITION BY agent_id, session_key, depth
					ORDER BY latest_at DESC, created_at DESC, id ASC
				) AS rn
			FROM session_summaries
			WHERE session_key IS NOT NULL
			  AND COALESCE(source_type, 'summary') = 'summary'
		)
		SELECT dup.id AS drop_id, keep.id AS keep_id
		FROM ranked dup
		JOIN ranked keep
		  ON keep.agent_id = dup.agent_id
		 AND keep.session_key = dup.session_key
		 AND keep.depth = dup.depth
		 AND keep.rn = 1
		WHERE dup.rn > 1;

		INSERT OR IGNORE INTO session_summary_memories (summary_id, memory_id)
		SELECT map.keep_id, link.memory_id
		FROM session_summary_duplicate_map map
		JOIN session_summary_memories link ON link.summary_id = map.drop_id;

		INSERT OR IGNORE INTO session_summary_children (parent_id, child_id, ordinal)
		SELECT
			COALESCE(parent_map.keep_id, rel.parent_id),
			COALESCE(child_map.keep_id, rel.child_id),
			rel.ordinal
		FROM session_summary_children rel
		LEFT JOIN session_summary_duplicate_map parent_map ON parent_map.drop_id = rel.parent_id
		LEFT JOIN session_summary_duplicate_map child_map ON child_map.drop_id = rel.child_id
		WHERE parent_map.drop_id IS NOT NULL OR child_map.drop_id IS NOT NULL;

		DELETE FROM session_summary_children
		WHERE parent_id IN (SELECT drop_id FROM session_summary_duplicate_map)
		   OR child_id IN (SELECT drop_id FROM session_summary_duplicate_map);

		DELETE FROM session_summary_memories
		WHERE summary_id IN (SELECT drop_id FROM session_summary_duplicate_map);

		DELETE FROM session_summaries
		WHERE id IN (SELECT drop_id FROM session_summary_duplicate_map);

		DROP TABLE session_summary_duplicate_map;

		CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_session_depth_summary
			ON session_summaries(agent_id, session_key, depth)
			WHERE session_key IS NOT NULL
			  AND COALESCE(source_type, 'summary') = 'summary';
	`);
}
function up47(db) {
  db.exec(`
		DROP TRIGGER IF EXISTS session_transcripts_fts_ai;
		DROP TRIGGER IF EXISTS session_transcripts_fts_ad;
		DROP TRIGGER IF EXISTS session_transcripts_fts_au;
		DROP TABLE IF EXISTS session_transcripts_fts;

		CREATE TABLE IF NOT EXISTS session_transcripts_next (
			session_key TEXT NOT NULL,
			content TEXT NOT NULL,
			harness TEXT,
			project TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL,
			updated_at TEXT,
			PRIMARY KEY (agent_id, session_key)
		);

		INSERT INTO session_transcripts_next (
			session_key,
			content,
			harness,
			project,
			agent_id,
			created_at,
			updated_at
		)
		SELECT
			session_key,
			content,
			harness,
			project,
			agent_id,
			created_at,
			updated_at
		FROM (
			SELECT
				session_key,
				content,
				harness,
				project,
				COALESCE(agent_id, 'default') AS agent_id,
				created_at,
				COALESCE(updated_at, created_at) AS updated_at,
				ROW_NUMBER() OVER (
					PARTITION BY COALESCE(agent_id, 'default'), session_key
					ORDER BY COALESCE(updated_at, created_at) DESC, LENGTH(content) DESC, created_at DESC, rowid DESC
				) AS rn
			FROM session_transcripts
		) ranked
		WHERE rn = 1;

		DROP TABLE session_transcripts;
		ALTER TABLE session_transcripts_next RENAME TO session_transcripts;

		CREATE INDEX IF NOT EXISTS idx_st_project
			ON session_transcripts(project);
		CREATE INDEX IF NOT EXISTS idx_st_created
			ON session_transcripts(created_at);
		CREATE INDEX IF NOT EXISTS idx_st_agent_updated
			ON session_transcripts(agent_id, updated_at);

		CREATE VIRTUAL TABLE IF NOT EXISTS session_transcripts_fts USING fts5(
			content,
			content='session_transcripts',
			content_rowid='rowid'
		);

		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ai AFTER INSERT ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END;

		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ad AFTER DELETE ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES ('delete', old.rowid, old.content);
		END;

		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_au AFTER UPDATE ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES ('delete', old.rowid, old.content);
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END;

		INSERT INTO session_transcripts_fts(session_transcripts_fts)
		VALUES ('rebuild');

		DROP INDEX IF EXISTS idx_summaries_session_depth;
		DROP INDEX IF EXISTS idx_summaries_session_depth_summary;
		CREATE INDEX IF NOT EXISTS idx_summaries_agent_session_key
			ON session_summaries(agent_id, session_key);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_agent_session_depth_summary
			ON session_summaries(agent_id, session_key, depth)
			WHERE session_key IS NOT NULL
			  AND COALESCE(source_type, 'summary') = 'summary';
	`);
}
function up48(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_thread_heads (
			agent_id TEXT NOT NULL DEFAULT 'default',
			thread_key TEXT NOT NULL,
			label TEXT NOT NULL,
			project TEXT,
			session_key TEXT,
			source_type TEXT NOT NULL DEFAULT 'summary',
			source_ref TEXT,
			harness TEXT,
			node_id TEXT NOT NULL,
			latest_at TEXT NOT NULL,
			sample TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, thread_key)
		);

		CREATE INDEX IF NOT EXISTS idx_thread_heads_agent_latest
			ON memory_thread_heads(agent_id, latest_at DESC);
		CREATE INDEX IF NOT EXISTS idx_thread_heads_agent_project
			ON memory_thread_heads(agent_id, project);

		INSERT INTO memory_thread_heads (
			agent_id, thread_key, label, project, session_key, source_type,
			source_ref, harness, node_id, latest_at, sample, updated_at
		)
		SELECT
			ss.agent_id,
			CASE
				WHEN ss.harness IS NOT NULL AND TRIM(ss.harness) != ''
						AND (ss.project IS NULL OR TRIM(ss.project) = '')
						AND (ss.source_ref IS NULL OR TRIM(ss.source_ref) = '')
						AND (ss.session_key IS NULL OR TRIM(ss.session_key) = '')
					THEN 'harness:' || TRIM(ss.harness)
				ELSE
					CASE
						WHEN ss.source_ref IS NOT NULL AND TRIM(ss.source_ref) != '' AND ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN
							'project:' || TRIM(ss.project) || '|source:' || TRIM(ss.source_ref)
						WHEN ss.source_ref IS NOT NULL AND TRIM(ss.source_ref) != '' THEN 'source:' || TRIM(ss.source_ref)
						WHEN ss.session_key IS NOT NULL AND TRIM(ss.session_key) != '' AND ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN
							'project:' || TRIM(ss.project) || '|session:' || TRIM(ss.session_key)
						WHEN ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN 'project:' || TRIM(ss.project)
						WHEN ss.session_key IS NOT NULL AND TRIM(ss.session_key) != '' THEN 'session:' || TRIM(ss.session_key)
						ELSE 'thread:unscoped'
					END ||
					CASE
						WHEN ss.harness IS NOT NULL AND TRIM(ss.harness) != '' THEN '|harness:' || TRIM(ss.harness)
						ELSE ''
					END
			END AS thread_key,
			CASE
				WHEN ss.source_ref IS NOT NULL AND TRIM(ss.source_ref) != '' AND ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN
					'project:' || TRIM(ss.project) || '#source:' || TRIM(ss.source_ref)
				WHEN ss.source_ref IS NOT NULL AND TRIM(ss.source_ref) != '' THEN 'source:' || TRIM(ss.source_ref)
				WHEN ss.session_key IS NOT NULL AND TRIM(ss.session_key) != '' AND ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN
					'project:' || TRIM(ss.project) || '#session:' || TRIM(ss.session_key)
				WHEN ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN 'project:' || TRIM(ss.project)
				WHEN ss.session_key IS NOT NULL AND TRIM(ss.session_key) != '' THEN 'session:' || TRIM(ss.session_key)
				WHEN ss.harness IS NOT NULL AND TRIM(ss.harness) != '' THEN 'harness:' || TRIM(ss.harness)
				ELSE 'thread:unscoped'
			END AS label,
			ss.project,
			ss.session_key,
			COALESCE(ss.source_type, ss.kind, 'summary') AS source_type,
			ss.source_ref,
			ss.harness,
			ss.id AS node_id,
			ss.latest_at,
			SUBSTR(REPLACE(REPLACE(TRIM(ss.content), CHAR(10), ' '), CHAR(13), ' '), 1, 240) AS sample,
			ss.latest_at AS updated_at
		FROM (
			SELECT
				s0.*,
				ROW_NUMBER() OVER (
					PARTITION BY s0.agent_id,
					CASE
						WHEN s0.harness IS NOT NULL AND TRIM(s0.harness) != ''
								AND (s0.project IS NULL OR TRIM(s0.project) = '')
								AND (s0.source_ref IS NULL OR TRIM(s0.source_ref) = '')
								AND (s0.session_key IS NULL OR TRIM(s0.session_key) = '')
							THEN 'harness:' || TRIM(s0.harness)
						ELSE
							CASE
								WHEN s0.source_ref IS NOT NULL AND TRIM(s0.source_ref) != '' AND s0.project IS NOT NULL AND TRIM(s0.project) != '' THEN
									'project:' || TRIM(s0.project) || '|source:' || TRIM(s0.source_ref)
								WHEN s0.source_ref IS NOT NULL AND TRIM(s0.source_ref) != '' THEN 'source:' || TRIM(s0.source_ref)
								WHEN s0.session_key IS NOT NULL AND TRIM(s0.session_key) != '' AND s0.project IS NOT NULL AND TRIM(s0.project) != '' THEN
									'project:' || TRIM(s0.project) || '|session:' || TRIM(s0.session_key)
								WHEN s0.project IS NOT NULL AND TRIM(s0.project) != '' THEN 'project:' || TRIM(s0.project)
								WHEN s0.session_key IS NOT NULL AND TRIM(s0.session_key) != '' THEN 'session:' || TRIM(s0.session_key)
								ELSE 'thread:unscoped'
							END ||
							CASE
								WHEN s0.harness IS NOT NULL AND TRIM(s0.harness) != '' THEN '|harness:' || TRIM(s0.harness)
								ELSE ''
							END
					END
					ORDER BY s0.latest_at DESC, s0.created_at DESC
				) AS rn
			FROM session_summaries s0
			WHERE COALESCE(s0.source_type, s0.kind) != 'chunk'
		) ss
		WHERE ss.rn = 1
		ON CONFLICT(agent_id, thread_key) DO UPDATE SET
			label = excluded.label,
			project = excluded.project,
			session_key = excluded.session_key,
			source_type = excluded.source_type,
			source_ref = excluded.source_ref,
			harness = excluded.harness,
			node_id = excluded.node_id,
			latest_at = excluded.latest_at,
			sample = excluded.sample,
			updated_at = excluded.updated_at
		WHERE excluded.latest_at >= memory_thread_heads.latest_at;
	`);
}
function up49(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_extract_cursors (
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			last_offset INTEGER NOT NULL DEFAULT 0,
			last_extract_at TEXT NOT NULL,
			PRIMARY KEY (session_key, agent_id)
		);
	`);
}
function hasTable(db, name) {
  return db.prepare(`SELECT name
			 FROM sqlite_master
			 WHERE type = 'table' AND name = ?
			 LIMIT 1`).get(name) !== undefined;
}
function up50(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS entity_dependency_history (
			id                TEXT PRIMARY KEY,
			dependency_id     TEXT NOT NULL,
			source_entity_id  TEXT NOT NULL,
			target_entity_id  TEXT NOT NULL,
			agent_id          TEXT NOT NULL DEFAULT 'default',
			dependency_type   TEXT NOT NULL,
			event             TEXT NOT NULL,
			changed_by        TEXT NOT NULL,
			reason            TEXT NOT NULL,
			previous_reason   TEXT,
			metadata          TEXT,
			created_at        TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_entity_dependency_history_dep
			ON entity_dependency_history(dependency_id);
		CREATE INDEX IF NOT EXISTS idx_entity_dependency_history_agent
			ON entity_dependency_history(agent_id);
		CREATE INDEX IF NOT EXISTS idx_entity_dependency_history_created
			ON entity_dependency_history(created_at DESC);
	`);
  if (!hasTable(db, "entity_dependencies"))
    return;
  db.exec("DROP TRIGGER IF EXISTS trg_entity_dependencies_related_to_reason_insert");
  db.exec("DROP TRIGGER IF EXISTS trg_entity_dependencies_related_to_reason_update");
  db.exec("DROP TRIGGER IF EXISTS trg_entity_dependencies_audit_insert");
  db.exec("DROP TRIGGER IF EXISTS trg_entity_dependencies_audit_update");
  db.exec("DROP TRIGGER IF EXISTS trg_entity_dependencies_audit_delete");
  db.exec(`
		CREATE TRIGGER trg_entity_dependencies_related_to_reason_insert
		BEFORE INSERT ON entity_dependencies
		FOR EACH ROW
		WHEN NEW.dependency_type = 'related_to'
		  AND (NEW.reason IS NULL OR length(trim(NEW.reason)) = 0)
		BEGIN
			SELECT RAISE(ABORT, 'related_to dependencies require a non-empty reason');
		END;
	`);
  db.exec(`
		CREATE TRIGGER trg_entity_dependencies_related_to_reason_update
		BEFORE UPDATE OF dependency_type, reason ON entity_dependencies
		FOR EACH ROW
		WHEN NEW.dependency_type = 'related_to'
		  AND (NEW.reason IS NULL OR length(trim(NEW.reason)) = 0)
		BEGIN
			SELECT RAISE(ABORT, 'related_to dependencies require a non-empty reason');
		END;
	`);
  db.exec(`
		CREATE TRIGGER trg_entity_dependencies_audit_insert
		AFTER INSERT ON entity_dependencies
		FOR EACH ROW
		BEGIN
			INSERT INTO entity_dependency_history (
				id, dependency_id, source_entity_id, target_entity_id, agent_id,
				dependency_type, event, changed_by, reason, previous_reason,
				metadata, created_at
			) VALUES (
				lower(hex(randomblob(16))),
				NEW.id,
				NEW.source_entity_id,
				NEW.target_entity_id,
				NEW.agent_id,
				NEW.dependency_type,
				'created',
				'db-trigger',
				COALESCE(NEW.reason, 'created without reason'),
				NULL,
				'{"source":"trg_entity_dependencies_audit_insert"}',
				datetime('now')
			);
		END;
	`);
  db.exec(`
		CREATE TRIGGER trg_entity_dependencies_audit_update
		AFTER UPDATE ON entity_dependencies
		FOR EACH ROW
		BEGIN
			INSERT INTO entity_dependency_history (
				id, dependency_id, source_entity_id, target_entity_id, agent_id,
				dependency_type, event, changed_by, reason, previous_reason,
				metadata, created_at
			) VALUES (
				lower(hex(randomblob(16))),
				NEW.id,
				NEW.source_entity_id,
				NEW.target_entity_id,
				NEW.agent_id,
				NEW.dependency_type,
				'updated',
				'db-trigger',
				COALESCE(NEW.reason, 'updated without reason'),
				OLD.reason,
				'{"source":"trg_entity_dependencies_audit_update"}',
				datetime('now')
			);
		END;
	`);
  db.exec(`
		CREATE TRIGGER trg_entity_dependencies_audit_delete
		AFTER DELETE ON entity_dependencies
		FOR EACH ROW
		BEGIN
			INSERT INTO entity_dependency_history (
				id, dependency_id, source_entity_id, target_entity_id, agent_id,
				dependency_type, event, changed_by, reason, previous_reason,
				metadata, created_at
			) VALUES (
				lower(hex(randomblob(16))),
				OLD.id,
				OLD.source_entity_id,
				OLD.target_entity_id,
				OLD.agent_id,
				OLD.dependency_type,
				'deleted',
				'db-trigger',
				COALESCE(OLD.reason, 'deleted without reason'),
				NULL,
				'{"source":"trg_entity_dependencies_audit_delete"}',
				datetime('now')
			);
		END;
	`);
  db.exec(`
		INSERT INTO entity_dependency_history (
			id, dependency_id, source_entity_id, target_entity_id, agent_id,
			dependency_type, event, changed_by, reason, previous_reason,
			metadata, created_at
		)
		SELECT
			lower(hex(randomblob(16))),
			d.id,
			d.source_entity_id,
			d.target_entity_id,
			d.agent_id,
			d.dependency_type,
			'backfill',
			'migration-050',
			CASE
				WHEN d.reason IS NULL OR length(trim(d.reason)) = 0
					THEN 'legacy dependency without recorded reason'
				ELSE d.reason
			END,
			NULL,
			'{"source":"migration-050"}',
			datetime('now')
		FROM entity_dependencies d
		WHERE NOT EXISTS (
			SELECT 1
			FROM entity_dependency_history h
			WHERE h.dependency_id = d.id
			  AND h.event = 'backfill'
		  )
	`);
  db.exec(`
		UPDATE entity_dependencies
		SET reason = 'legacy-unattributed related_to edge'
		WHERE dependency_type = 'related_to'
		  AND (reason IS NULL OR length(trim(reason)) = 0)
	`);
}
function addColumnIfMissing15(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function up51(db) {
  addColumnIfMissing15(db, "summary_jobs", "session_id", "TEXT");
  addColumnIfMissing15(db, "summary_jobs", "trigger", "TEXT NOT NULL DEFAULT 'session_end'");
  addColumnIfMissing15(db, "summary_jobs", "captured_at", "TEXT");
  addColumnIfMissing15(db, "summary_jobs", "started_at", "TEXT");
  addColumnIfMissing15(db, "summary_jobs", "ended_at", "TEXT");
  db.exec(`
		UPDATE summary_jobs
		SET
			session_id = COALESCE(session_id, session_key, id),
			trigger = COALESCE(NULLIF(trigger, ''), 'session_end'),
			captured_at = COALESCE(captured_at, completed_at, created_at),
			ended_at = COALESCE(ended_at, completed_at)
		WHERE 1 = 1;

		CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent_trigger
			ON summary_jobs(agent_id, trigger, created_at);
		CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent_session
			ON summary_jobs(agent_id, session_key, created_at);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_artifacts (
			agent_id TEXT NOT NULL DEFAULT 'default',
			source_path TEXT NOT NULL,
			source_sha256 TEXT NOT NULL,
			source_kind TEXT NOT NULL,
			session_id TEXT NOT NULL,
			session_key TEXT,
			session_token TEXT NOT NULL,
			project TEXT,
			harness TEXT,
			captured_at TEXT NOT NULL,
			started_at TEXT,
			ended_at TEXT,
			manifest_path TEXT,
			source_node_id TEXT,
			memory_sentence TEXT,
			memory_sentence_quality TEXT,
			content TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, source_path)
		);

		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_kind
			ON memory_artifacts(agent_id, source_kind, captured_at DESC);
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_session
			ON memory_artifacts(agent_id, session_token, captured_at DESC);
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_membership
			ON memory_artifacts(agent_id, COALESCE(ended_at, captured_at) DESC);

		CREATE TABLE IF NOT EXISTS memory_artifact_tombstones (
			agent_id TEXT NOT NULL DEFAULT 'default',
			session_token TEXT NOT NULL,
			removed_at TEXT NOT NULL,
			reason TEXT NOT NULL,
			removed_paths TEXT NOT NULL,
			PRIMARY KEY (agent_id, session_token)
		);
	`);
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_artifacts_fts USING fts5(
			content,
			source_path,
			content='memory_artifacts',
			content_rowid='rowid'
		)
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_artifacts_fts_ai AFTER INSERT ON memory_artifacts BEGIN
			INSERT INTO memory_artifacts_fts(rowid, content, source_path)
			VALUES (new.rowid, new.content, new.source_path);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_artifacts_fts_ad AFTER DELETE ON memory_artifacts BEGIN
			INSERT INTO memory_artifacts_fts(memory_artifacts_fts, rowid, content, source_path)
			VALUES ('delete', old.rowid, old.content, old.source_path);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_artifacts_fts_au AFTER UPDATE ON memory_artifacts BEGIN
			INSERT INTO memory_artifacts_fts(memory_artifacts_fts, rowid, content, source_path)
			VALUES ('delete', old.rowid, old.content, old.source_path);
			INSERT INTO memory_artifacts_fts(rowid, content, source_path)
			VALUES (new.rowid, new.content, new.source_path);
		END
	`);
  db.exec(`
		INSERT INTO memory_artifacts_fts(memory_artifacts_fts)
		VALUES ('rebuild');
	`);
}
function up52(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS mcp_invocations (
			id          TEXT PRIMARY KEY,
			server_id   TEXT NOT NULL,
			tool_name   TEXT NOT NULL,
			agent_id    TEXT NOT NULL DEFAULT 'default',
			source      TEXT NOT NULL CHECK(source IN ('cli','agent','mcp','dashboard')),
			latency_ms  INTEGER NOT NULL,
			success     INTEGER NOT NULL DEFAULT 1,
			error_text  TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_mcp_inv_server ON mcp_invocations(server_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_mcp_inv_agent ON mcp_invocations(agent_id, created_at);
	`);
}
function up53(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS skill_invocations (
			id          TEXT PRIMARY KEY,
			skill_name  TEXT NOT NULL,
			agent_id    TEXT NOT NULL DEFAULT 'default',
			source      TEXT NOT NULL CHECK(source IN ('agent','scheduler','api')),
			latency_ms  INTEGER NOT NULL,
			success     INTEGER NOT NULL DEFAULT 1,
			error_text  TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_skill_inv_name ON skill_invocations(skill_name, created_at);
		CREATE INDEX IF NOT EXISTS idx_skill_inv_agent ON skill_invocations(agent_id, created_at);
	`);
}
function up54(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS task_scope_hints (
			task_id     TEXT PRIMARY KEY REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
			agent_id    TEXT NOT NULL DEFAULT 'default',
			created_at  TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
		);

		INSERT INTO task_scope_hints (task_id, agent_id, created_at, updated_at)
		SELECT st.id,
		       MIN(sm.agent_id),
		       datetime('now'),
		       datetime('now')
		  FROM scheduled_tasks st
		  JOIN entities e
		    ON e.entity_type = 'skill'
		   AND lower(e.name) = lower(st.skill_name)
		  JOIN skill_meta sm
		    ON sm.entity_id = e.id
		   AND sm.agent_id = e.agent_id
		   AND sm.uninstalled_at IS NULL
		 WHERE st.skill_name IS NOT NULL
		 GROUP BY st.id, lower(st.skill_name)
		HAVING COUNT(DISTINCT sm.agent_id) = 1
		ON CONFLICT(task_id) DO NOTHING;

		CREATE INDEX IF NOT EXISTS idx_task_scope_hints_agent
			ON task_scope_hints(agent_id, updated_at);
	`);
}
function up55(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_state (
			agent_id TEXT PRIMARY KEY NOT NULL,
			tokens_since_last_pass INTEGER NOT NULL DEFAULT 0,
			consecutive_failures INTEGER NOT NULL DEFAULT 0,
			last_pass_at TEXT,
			last_pass_id TEXT,
			last_pass_mode TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_passes (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			mode TEXT NOT NULL DEFAULT 'incremental',
			status TEXT NOT NULL DEFAULT 'running',
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			completed_at TEXT,
			tokens_consumed INTEGER,
			mutations_applied INTEGER,
			mutations_skipped INTEGER,
			mutations_failed INTEGER,
			summary TEXT,
			error TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_dreaming_passes_agent
		ON dreaming_passes (agent_id, created_at DESC);
	`);
}
function ensureMemoriesScopeColumns(db) {
  const cols = db.prepare("PRAGMA table_info(memories)").all();
  const names = new Set(cols.map((col) => col.name).filter((name) => typeof name === "string"));
  if (!names.has("agent_id"))
    db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT DEFAULT 'default'");
  if (!names.has("scope"))
    db.exec("ALTER TABLE memories ADD COLUMN scope TEXT");
}
function up56(db) {
  ensureMemoriesScopeColumns(db);
  db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
  db.exec(`
		CREATE UNIQUE INDEX idx_memories_content_hash_unique
		ON memories(
			content_hash,
			COALESCE(NULLIF(agent_id, ''), 'default'),
			COALESCE(scope, '__NULL__')
		)
		WHERE content_hash IS NOT NULL AND is_deleted = 0
	`);
}
function up57(db) {
  const sql = readMemoriesFtsSql(db);
  if (sql !== null && !memoriesFtsNeedsTokenizerRepair(sql))
    return;
  recreateMemoriesFts(db);
}
function up58(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_order
			ON entities(agent_id, pinned DESC, pinned_at DESC, mentions DESC, updated_at DESC, name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_extracted_mentions
			ON entities(entity_type, mentions)
			WHERE entity_type = 'extracted'`);
}
function up59(db) {
  const cols = db.prepare("PRAGMA table_info(entity_attributes)").all();
  if (!cols.some((col) => col.name === "claim_key")) {
    db.exec("ALTER TABLE entity_attributes ADD COLUMN claim_key TEXT");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_attributes_claim_key
			ON entity_attributes(agent_id, aspect_id, claim_key, status)
			WHERE claim_key IS NOT NULL`);
}
function up60(db) {
  const cols = db.prepare("PRAGMA table_info(entity_attributes)").all();
  if (!cols.some((col) => col.name === "group_key")) {
    db.exec("ALTER TABLE entity_attributes ADD COLUMN group_key TEXT");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_attributes_group_key
			ON entity_attributes(agent_id, aspect_id, group_key, status)
			WHERE group_key IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_attributes_group_claim
			ON entity_attributes(agent_id, aspect_id, group_key, claim_key, status)
			WHERE claim_key IS NOT NULL`);
}
function up61(db) {
  const cols = db.prepare("PRAGMA table_info(memory_artifacts)").all();
  if (cols.some((col) => col.name === "source_mtime_ms"))
    return;
  db.exec("ALTER TABLE memory_artifacts ADD COLUMN source_mtime_ms REAL");
}
function up62(db) {
  const cols = db.prepare("PRAGMA table_info(memory_artifacts)").all();
  const names = new Set(cols.map((col) => col.name));
  if (!names.has("is_deleted")) {
    db.exec("ALTER TABLE memory_artifacts ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("deleted_at")) {
    db.exec("ALTER TABLE memory_artifacts ADD COLUMN deleted_at TEXT");
  }
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_deleted
			ON memory_artifacts(agent_id, is_deleted, deleted_at)
	`);
}
function up63(db) {
  db.exec("DROP TRIGGER IF EXISTS memories_au");
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
}
function hasColumn6(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}
function addColumnIfMissing16(db, table, column, definition) {
  if (!hasColumn6(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up64(db) {
  for (const table of ["entities", "entity_communities", "entity_attributes", "entity_dependencies"]) {
    addColumnIfMissing16(db, table, "source_id", "TEXT");
    addColumnIfMissing16(db, table, "source_kind", "TEXT");
    addColumnIfMissing16(db, table, "source_path", "TEXT");
    addColumnIfMissing16(db, table, "source_root", "TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(agent_id, source_id, source_path)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entity_communities_source ON entity_communities(agent_id, source_id, source_path)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entity_attributes_source ON entity_attributes(agent_id, source_id, source_path)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entity_dependencies_source_origin ON entity_dependencies(agent_id, source_id, source_path)");
}
function hasTable2(db, table) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  return row?.name === table;
}
function hasColumn7(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}
function up65(db) {
  if (!hasTable2(db, "embeddings"))
    return;
  if (!hasColumn7(db, "embeddings", "agent_id")) {
    db.exec("ALTER TABLE embeddings ADD COLUMN agent_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_agent_source ON embeddings(agent_id, source_type, source_id)");
}
function up66(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_search_telemetry (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL,
			route TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			session_key TEXT,
			project TEXT,
			query TEXT NOT NULL,
			keyword_query TEXT,
			filters_json TEXT NOT NULL,
			method TEXT NOT NULL,
			result_count INTEGER NOT NULL,
			top_score REAL,
			no_hits INTEGER NOT NULL DEFAULT 0,
			duration_ms REAL NOT NULL DEFAULT 0,
			timings_json TEXT NOT NULL,
			results_json TEXT NOT NULL,
			sources_json TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_memory_search_telemetry_agent_time
			ON memory_search_telemetry(agent_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_memory_search_telemetry_session
			ON memory_search_telemetry(session_key) WHERE session_key IS NOT NULL;
		CREATE INDEX IF NOT EXISTS idx_memory_search_telemetry_route_time
			ON memory_search_telemetry(route, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_memory_search_telemetry_no_hits
			ON memory_search_telemetry(no_hits, created_at DESC);
	`);
}
function hasColumn8(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}
function addColumnIfMissing17(db, table, column, definition) {
  if (!hasColumn8(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up67(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS ontology_proposals (
			id          TEXT PRIMARY KEY,
			agent_id    TEXT NOT NULL DEFAULT 'default',
			operation   TEXT NOT NULL,
			status      TEXT NOT NULL DEFAULT 'pending'
				CHECK (status IN ('pending', 'applied', 'rejected', 'failed')),
			payload     TEXT NOT NULL,
			confidence  REAL NOT NULL DEFAULT 0.0
				CHECK (confidence >= 0.0 AND confidence <= 1.0),
			rationale   TEXT NOT NULL DEFAULT '',
			evidence    TEXT NOT NULL DEFAULT '[]',
			risk        TEXT,
			source_kind TEXT,
			source_id   TEXT,
			source_path TEXT,
			source_root TEXT,
			created_by  TEXT NOT NULL DEFAULT 'ontology-proposal',
			applied_by  TEXT,
			rejected_by TEXT,
			result      TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
			applied_at  TEXT,
			rejected_at TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_ontology_proposals_agent_status
			ON ontology_proposals(agent_id, status, updated_at DESC);

		CREATE INDEX IF NOT EXISTS idx_ontology_proposals_agent_operation
			ON ontology_proposals(agent_id, operation, updated_at DESC);

		CREATE INDEX IF NOT EXISTS idx_ontology_proposals_source
			ON ontology_proposals(agent_id, source_kind, source_id);
	`);
  for (const table of ["entity_attributes", "entity_dependencies"]) {
    addColumnIfMissing17(db, table, "proposal_id", "TEXT");
    addColumnIfMissing17(db, table, "proposal_evidence", "TEXT NOT NULL DEFAULT '[]'");
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_proposal ON ${table}(agent_id, proposal_id)`);
  }
}
function up68(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS daily_reflections (
			id               TEXT PRIMARY KEY,
			agent_id         TEXT NOT NULL DEFAULT 'default',
			date             TEXT NOT NULL,
			summary          TEXT NOT NULL DEFAULT '',
			patterns         TEXT NOT NULL DEFAULT '[]',
			question         TEXT,
			answer           TEXT,
			answer_memory_id TEXT,
			content_key      TEXT,
			memory_ids       TEXT NOT NULL DEFAULT '[]',
			summary_ids      TEXT NOT NULL DEFAULT '[]',
			model            TEXT,
			created_at       TEXT NOT NULL DEFAULT (datetime('now')),
			answered_at      TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_date
			ON daily_reflections(agent_id, date, created_at DESC);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_reflections_agent_content_key
			ON daily_reflections(agent_id, date, content_key)
			WHERE content_key IS NOT NULL;
	`);
}
function up69(db) {
  const cols = db.prepare("PRAGMA table_info(daily_reflections)").all();
  const colNames = new Set(cols.flatMap((c) => typeof c.name === "string" ? [c.name] : []));
  if (!colNames.has("content_key")) {
    db.exec("ALTER TABLE daily_reflections ADD COLUMN content_key TEXT");
  }
  db.exec(`
		DROP INDEX IF EXISTS idx_daily_reflections_agent_date;
		DROP INDEX IF EXISTS idx_daily_reflections_agent_content_key;

		CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_created
			ON daily_reflections(agent_id, created_at DESC);

		CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_date
			ON daily_reflections(agent_id, date, created_at DESC);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_reflections_agent_content_key
			ON daily_reflections(agent_id, date, content_key)
			WHERE content_key IS NOT NULL;
	`);
}
function hasColumn9(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}
function addColumnIfMissing18(db, table, column, definition) {
  if (!hasColumn9(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function backfillVersionRoots(db) {
  db.exec(`
		UPDATE entity_attributes
		SET version_root_id = id
		WHERE version_root_id IS NULL
	`);
}
function up70(db) {
  for (const table of ["entities", "entity_aspects", "entity_dependencies"]) {
    addColumnIfMissing18(db, table, "status", "TEXT NOT NULL DEFAULT 'active'");
    addColumnIfMissing18(db, table, "archived_at", "TEXT");
    addColumnIfMissing18(db, table, "archived_by", "TEXT");
    addColumnIfMissing18(db, table, "archive_reason", "TEXT");
  }
  for (const table of ["entities", "entity_aspects"]) {
    addColumnIfMissing18(db, table, "proposal_id", "TEXT");
    addColumnIfMissing18(db, table, "proposal_evidence", "TEXT NOT NULL DEFAULT '[]'");
  }
  addColumnIfMissing18(db, "entity_attributes", "version", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing18(db, "entity_attributes", "version_root_id", "TEXT");
  addColumnIfMissing18(db, "entity_attributes", "previous_attribute_id", "TEXT");
  addColumnIfMissing18(db, "entity_attributes", "archived_at", "TEXT");
  addColumnIfMissing18(db, "entity_attributes", "archived_by", "TEXT");
  addColumnIfMissing18(db, "entity_attributes", "archive_reason", "TEXT");
  backfillVersionRoots(db);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_entities_status
			ON entities(agent_id, status, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_entity_aspects_status
			ON entity_aspects(agent_id, entity_id, status);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_version_root
			ON entity_attributes(agent_id, version_root_id, version DESC);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_claim_version
			ON entity_attributes(agent_id, aspect_id, group_key, claim_key, version DESC);
		CREATE INDEX IF NOT EXISTS idx_entity_dependencies_status
			ON entity_dependencies(agent_id, status, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_entities_proposal
			ON entities(agent_id, proposal_id);
		CREATE INDEX IF NOT EXISTS idx_entity_aspects_proposal
			ON entity_aspects(agent_id, proposal_id);
	`);
}
function up71(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS epistemic_assertions (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL DEFAULT 'default',
			subject_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			claim_attribute_id TEXT REFERENCES entity_attributes(id) ON DELETE SET NULL,
			predicate TEXT NOT NULL CHECK (
				predicate IN ('claims', 'believes', 'observed', 'decided', 'prefers', 'denies', 'questions')
			),
			content TEXT NOT NULL,
			normalized_content TEXT NOT NULL,
			speaker TEXT,
			asserted_at TEXT NOT NULL,
			confidence REAL NOT NULL DEFAULT 0.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
			evidence TEXT NOT NULL DEFAULT '[]',
			source_kind TEXT,
			source_id TEXT,
			source_path TEXT,
			source_root TEXT,
			status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'superseded')),
			supersedes_assertion_id TEXT REFERENCES epistemic_assertions(id) ON DELETE SET NULL,
			archived_at TEXT,
			archived_by TEXT,
			archive_reason TEXT,
			created_by TEXT NOT NULL DEFAULT 'operator',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_agent_entity
			ON epistemic_assertions(agent_id, subject_entity_id, status, asserted_at DESC);
		CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_agent_speaker
			ON epistemic_assertions(agent_id, speaker, asserted_at DESC);
		CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_agent_predicate
			ON epistemic_assertions(agent_id, predicate, status, asserted_at DESC);
		CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_agent_source
			ON epistemic_assertions(agent_id, source_kind, source_id);
		CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_claim
			ON epistemic_assertions(agent_id, claim_attribute_id);
	`);
}
function ensureMemoriesScopeColumns2(db) {
  const cols = db.prepare("PRAGMA table_info(memories)").all();
  const names = new Set(cols.map((col) => col.name).filter((name) => typeof name === "string"));
  if (!names.has("agent_id"))
    db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT DEFAULT 'default'");
  if (!names.has("visibility"))
    db.exec("ALTER TABLE memories ADD COLUMN visibility TEXT DEFAULT 'global'");
  if (!names.has("scope"))
    db.exec("ALTER TABLE memories ADD COLUMN scope TEXT");
  if (!names.has("idempotency_key"))
    db.exec("ALTER TABLE memories ADD COLUMN idempotency_key TEXT");
  if (!names.has("runtime_path"))
    db.exec("ALTER TABLE memories ADD COLUMN runtime_path TEXT");
}
function up72(db) {
  ensureMemoriesScopeColumns2(db);
  db.exec("DROP INDEX IF EXISTS idx_memories_idempotency_key");
  db.exec(`
		CREATE UNIQUE INDEX idx_memories_idempotency_key
		ON memories(
			idempotency_key,
			COALESCE(NULLIF(agent_id, ''), 'default'),
			COALESCE(visibility, 'global'),
			COALESCE(scope, '__NULL__')
		)
		WHERE idempotency_key IS NOT NULL AND is_deleted = 0
	`);
}
function up73(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_context_epochs (
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			context_epoch INTEGER NOT NULL DEFAULT 0,
			reason TEXT NOT NULL,
			source_ref TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (session_key, agent_id, context_epoch)
		);

		CREATE INDEX IF NOT EXISTS idx_session_context_epochs_created
			ON session_context_epochs(agent_id, created_at DESC);

		CREATE TABLE IF NOT EXISTS session_recall_events (
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			context_epoch INTEGER NOT NULL DEFAULT 0,
			item_kind TEXT NOT NULL,
			item_id TEXT NOT NULL,
			surface TEXT NOT NULL,
			mode TEXT NOT NULL,
			score REAL,
			source TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (session_key, agent_id, context_epoch, item_kind, item_id)
		);

		CREATE INDEX IF NOT EXISTS idx_session_recall_events_session
			ON session_recall_events(session_key, agent_id, context_epoch, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_session_recall_events_item
			ON session_recall_events(item_kind, item_id, created_at DESC);
	`);
}
function up74(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS aggregate_memory_sources (
			aggregate_memory_id TEXT NOT NULL,
			source_memory_id TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL,
			PRIMARY KEY (aggregate_memory_id, source_memory_id)
		);
		CREATE INDEX IF NOT EXISTS idx_aggregate_memory_sources_agent
			ON aggregate_memory_sources(agent_id, aggregate_memory_id);
	`);
}
function addColumnIfMissing19(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function up75(db) {
  addColumnIfMissing19(db, "memory_artifacts", "source_id", "TEXT");
  addColumnIfMissing19(db, "memory_artifacts", "source_root", "TEXT");
  addColumnIfMissing19(db, "memory_artifacts", "source_external_id", "TEXT");
  addColumnIfMissing19(db, "memory_artifacts", "source_parent_path", "TEXT");
  addColumnIfMissing19(db, "memory_artifacts", "source_meta_json", "TEXT");
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_source
			ON memory_artifacts(agent_id, source_id, source_external_id);
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_source_root
			ON memory_artifacts(agent_id, source_id, source_root);
	`);
}
var MIGRATIONS = [
  {
    version: 1,
    name: "baseline",
    up,
    artifacts: { tables: ["memories", "conversations", "embeddings"] }
  },
  {
    version: 2,
    name: "pipeline-v2",
    up: up2,
    artifacts: {
      tables: ["memory_history", "memory_jobs", "entities", "relations", "memory_entity_mentions"]
    }
  },
  {
    version: 3,
    name: "unique-content-hash",
    up: up3
  },
  {
    version: 4,
    name: "history-actor-and-retention",
    up: up4,
    artifacts: {
      columns: [{ table: "memory_history", column: "actor_type" }]
    }
  },
  {
    version: 5,
    name: "graph-extended",
    up: up5,
    artifacts: {
      columns: [{ table: "entities", column: "canonical_name" }]
    }
  },
  {
    version: 6,
    name: "idempotency-key",
    up: up6,
    artifacts: {
      columns: [{ table: "memories", column: "idempotency_key" }]
    }
  },
  {
    version: 7,
    name: "documents-and-connectors",
    up: up7,
    artifacts: { tables: ["documents", "document_memories", "connectors"] }
  },
  {
    version: 8,
    name: "embeddings-unique-hash",
    up: up8
  },
  {
    version: 9,
    name: "summary-jobs",
    up: up9,
    artifacts: { tables: ["summary_jobs"] }
  },
  {
    version: 10,
    name: "umap-cache",
    up: up10,
    artifacts: { tables: ["umap_cache"] }
  },
  {
    version: 11,
    name: "session-scores",
    up: up11,
    artifacts: { tables: ["session_scores"] }
  },
  {
    version: 12,
    name: "scheduled-tasks",
    up: up12,
    artifacts: { tables: ["scheduled_tasks", "task_runs"] }
  },
  {
    version: 13,
    name: "ingestion-tracking",
    up: up13,
    artifacts: {
      tables: ["ingestion_jobs"],
      columns: [
        { table: "memories", column: "source_path" },
        { table: "memories", column: "source_section" }
      ]
    }
  },
  {
    version: 14,
    name: "telemetry",
    up: up14,
    artifacts: { tables: ["telemetry_events"] }
  },
  {
    version: 15,
    name: "session-memories",
    up: up15,
    artifacts: {
      tables: ["session_memories"],
      columns: [
        { table: "session_scores", column: "confidence" },
        { table: "session_scores", column: "continuity_reasoning" }
      ]
    }
  },
  {
    version: 16,
    name: "session-checkpoints",
    up: up16,
    artifacts: { tables: ["session_checkpoints"] }
  },
  {
    version: 17,
    name: "task-skills",
    up: up17,
    artifacts: {
      columns: [{ table: "scheduled_tasks", column: "skill_name" }]
    }
  },
  {
    version: 18,
    name: "skill-meta",
    up: up18,
    artifacts: { tables: ["skill_meta"] }
  },
  {
    version: 19,
    name: "knowledge-structure",
    up: up19,
    artifacts: {
      tables: ["entity_aspects", "entity_attributes", "entity_dependencies", "task_meta"],
      columns: [{ table: "entities", column: "agent_id" }]
    }
  },
  {
    version: 20,
    name: "session-structural-columns",
    up: up20,
    artifacts: {
      columns: [
        { table: "session_memories", column: "entity_slot" },
        { table: "session_memories", column: "aspect_slot" },
        { table: "session_memories", column: "is_constraint" },
        { table: "session_memories", column: "structural_density" }
      ]
    }
  },
  {
    version: 21,
    name: "checkpoint-structural",
    up: up21,
    artifacts: {
      columns: [{ table: "session_checkpoints", column: "focal_entity_ids" }]
    }
  },
  {
    version: 22,
    name: "entity-pinning",
    up: up22,
    artifacts: {
      columns: [
        { table: "entities", column: "pinned" },
        { table: "entities", column: "pinned_at" }
      ]
    }
  },
  {
    version: 23,
    name: "retired-scorer-gap",
    up: up23
  },
  {
    version: 24,
    name: "retired-scorer-gap",
    up: up24
  },
  {
    version: 25,
    name: "agent-feedback",
    up: up25,
    artifacts: {
      columns: [{ table: "session_memories", column: "agent_relevance_score" }]
    }
  },
  {
    version: 26,
    name: "retired-scorer-gap",
    up: up26
  },
  {
    version: 27,
    name: "backfill-canonical-names",
    up: up27
  },
  {
    version: 28,
    name: "lossless-retention",
    up: up28
  },
  {
    version: 29,
    name: "session-summary-dag",
    up: up29
  },
  {
    version: 30,
    name: "nullable-memory-job-memory-id",
    up: up30
  },
  {
    version: 31,
    name: "dependency-reason",
    up: up31,
    artifacts: {
      columns: [
        { table: "entity_dependencies", column: "reason" },
        { table: "entities", column: "last_synthesized_at" }
      ]
    }
  },
  {
    version: 32,
    name: "embeddings-vector-column",
    up: up32,
    artifacts: {
      columns: [{ table: "embeddings", column: "vector", optional: true }]
    }
  },
  {
    version: 33,
    name: "scope",
    up: up33,
    artifacts: {
      columns: [{ table: "memories", column: "scope" }]
    }
  },
  {
    version: 34,
    name: "scope-aware-dedup",
    up: up34
  },
  {
    version: 35,
    name: "entity-fts",
    up: up35
  },
  {
    version: 36,
    name: "dependency-confidence",
    up: up36,
    artifacts: {
      columns: [{ table: "entity_dependencies", column: "confidence" }]
    }
  },
  {
    version: 37,
    name: "entity-communities",
    up: up37,
    artifacts: {
      tables: ["entity_communities"],
      columns: [{ table: "entities", column: "community_id" }]
    }
  },
  {
    version: 38,
    name: "memory-hints",
    up: up38,
    artifacts: { tables: ["memory_hints"] }
  },
  {
    version: 39,
    name: "dedup-entity-dependencies",
    up: up39
  },
  {
    version: 40,
    name: "session-transcripts",
    up: up40,
    artifacts: { tables: ["session_transcripts"] }
  },
  {
    version: 41,
    name: "path-feedback",
    up: up41,
    artifacts: {
      tables: [
        "path_feedback_events",
        "path_feedback_stats",
        "entity_retrieval_stats",
        "entity_cooccurrence",
        "path_feedback_sessions"
      ],
      columns: [{ table: "session_memories", column: "path_json" }]
    }
  },
  {
    version: 42,
    name: "session-memories-agent-id",
    up: up42,
    artifacts: {
      columns: [{ table: "session_memories", column: "agent_id" }]
    }
  },
  {
    version: 43,
    name: "agents-table",
    up: up43,
    artifacts: {
      tables: ["agents"],
      columns: [
        { table: "memories", column: "agent_id" },
        { table: "memories", column: "visibility" }
      ]
    }
  },
  {
    version: 44,
    name: "memory-md-temporal-head",
    up: up44,
    artifacts: {
      columns: [
        { table: "session_summaries", column: "source_type" },
        { table: "session_summaries", column: "source_ref" },
        { table: "session_summaries", column: "meta_json" }
      ]
    }
  },
  {
    version: 45,
    name: "lossless-working-memory-hardening",
    up: up45,
    artifacts: {
      tables: ["session_transcripts_fts", "memory_md_heads"],
      columns: [
        { table: "session_transcripts", column: "updated_at" },
        { table: "summary_jobs", column: "agent_id" },
        { table: "session_scores", column: "agent_id" }
      ]
    }
  },
  {
    version: 46,
    name: "session-summary-uniqueness",
    up: up46
  },
  {
    version: 47,
    name: "agent-scoped-temporal-uniqueness",
    up: up47
  },
  {
    version: 48,
    name: "thread-heads",
    up: up48,
    artifacts: {
      tables: ["memory_thread_heads"]
    }
  },
  {
    version: 49,
    name: "session-extract-cursors",
    up: up49,
    artifacts: {
      tables: ["session_extract_cursors"]
    }
  },
  {
    version: 50,
    name: "related-to-audit",
    up: up50,
    artifacts: {
      tables: ["entity_dependency_history"]
    }
  },
  {
    version: 51,
    name: "memory-md-rolling-window-lineage",
    up: up51,
    artifacts: {
      tables: ["memory_artifacts", "memory_artifact_tombstones", "memory_artifacts_fts"],
      columns: [
        { table: "summary_jobs", column: "session_id" },
        { table: "summary_jobs", column: "trigger" },
        { table: "summary_jobs", column: "captured_at" },
        { table: "summary_jobs", column: "started_at" },
        { table: "summary_jobs", column: "ended_at" }
      ]
    }
  },
  {
    version: 52,
    name: "mcp-invocations",
    up: up52,
    artifacts: {
      tables: ["mcp_invocations"]
    }
  },
  {
    version: 53,
    name: "skill-invocations",
    up: up53,
    artifacts: {
      tables: ["skill_invocations"]
    }
  },
  {
    version: 54,
    name: "task-agent-scope",
    up: up54,
    artifacts: {
      tables: ["task_scope_hints"]
    }
  },
  {
    version: 55,
    name: "dreaming-state",
    up: up55,
    artifacts: {
      tables: ["dreaming_state", "dreaming_passes"]
    }
  },
  {
    version: 56,
    name: "agent-scoped-content-hash",
    up: up56
  },
  {
    version: 57,
    name: "memories-fts-tokenizer-repair",
    up: up57
  },
  {
    version: 58,
    name: "knowledge-graph-indices",
    up: up58
  },
  {
    version: 59,
    name: "entity-attribute-claim-key",
    up: up59,
    artifacts: {
      columns: [{ table: "entity_attributes", column: "claim_key" }]
    }
  },
  {
    version: 60,
    name: "entity-attribute-group-key",
    up: up60,
    artifacts: {
      columns: [{ table: "entity_attributes", column: "group_key" }]
    }
  },
  {
    version: 61,
    name: "memory-artifact-source-mtime",
    up: up61,
    artifacts: {
      columns: [{ table: "memory_artifacts", column: "source_mtime_ms" }]
    }
  },
  {
    version: 62,
    name: "memory-artifact-soft-delete",
    up: up62,
    artifacts: {
      columns: [
        { table: "memory_artifacts", column: "is_deleted" },
        { table: "memory_artifacts", column: "deleted_at" }
      ]
    }
  },
  {
    version: 63,
    name: "content-only-memories-fts-update",
    up: up63
  },
  {
    version: 64,
    name: "source-graph-provenance",
    up: up64,
    artifacts: {
      columns: [
        { table: "entities", column: "source_path" },
        { table: "entity_communities", column: "source_path" },
        { table: "entity_attributes", column: "source_path" },
        { table: "entity_dependencies", column: "source_path" }
      ]
    }
  },
  {
    version: 65,
    name: "source-embedding-agent-scope",
    up: up65,
    artifacts: {
      columns: [{ table: "embeddings", column: "agent_id", optional: true }]
    }
  },
  {
    version: 66,
    name: "memory-search-telemetry",
    up: up66,
    artifacts: {
      tables: ["memory_search_telemetry"]
    }
  },
  {
    version: 67,
    name: "ontology-proposals",
    up: up67,
    artifacts: {
      tables: ["ontology_proposals"],
      columns: [
        { table: "entity_attributes", column: "proposal_id" },
        { table: "entity_attributes", column: "proposal_evidence" },
        { table: "entity_dependencies", column: "proposal_id" },
        { table: "entity_dependencies", column: "proposal_evidence" }
      ]
    }
  },
  {
    version: 68,
    name: "daily-reflections",
    up: up68,
    artifacts: {
      tables: ["daily_reflections"]
    }
  },
  {
    version: 69,
    name: "daily-reflections-multiple-insights",
    up: up69,
    artifacts: {
      tables: ["daily_reflections"]
    }
  },
  {
    version: 70,
    name: "ontology-control-plane-state",
    up: up70,
    artifacts: {
      columns: [
        { table: "entities", column: "status" },
        { table: "entity_aspects", column: "status" },
        { table: "entity_attributes", column: "version" },
        { table: "entity_attributes", column: "version_root_id" },
        { table: "entity_attributes", column: "previous_attribute_id" },
        { table: "entity_dependencies", column: "status" }
      ]
    }
  },
  {
    version: 71,
    name: "epistemic-assertions",
    up: up71,
    artifacts: {
      tables: ["epistemic_assertions"]
    }
  },
  {
    version: 72,
    name: "agent-scoped-idempotency-key",
    up: up72,
    artifacts: {
      columns: [
        { table: "memories", column: "idempotency_key" },
        { table: "memories", column: "runtime_path" }
      ]
    }
  },
  {
    version: 73,
    name: "recall-context-dedupe",
    up: up73,
    artifacts: {
      tables: ["session_context_epochs", "session_recall_events"]
    }
  },
  {
    version: 74,
    name: "aggregate-memory-links",
    up: up74,
    artifacts: {
      tables: ["aggregate_memory_sources"]
    }
  },
  {
    version: 75,
    name: "memory-artifact-source-provenance",
    up: up75,
    artifacts: {
      columns: [
        { table: "memory_artifacts", column: "source_id" },
        { table: "memory_artifacts", column: "source_root" },
        { table: "memory_artifacts", column: "source_external_id" },
        { table: "memory_artifacts", column: "source_parent_path" },
        { table: "memory_artifacts", column: "source_meta_json" }
      ]
    }
  }
];
var LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
var __filename2 = fileURLToPath(import.meta.url);
var __dirname2 = dirname(__filename2);
var import_yaml = __toESM(require_dist(), 1);
var LOCAL_BINDS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
var import_yaml2 = __toESM(require_dist(), 1);
var native = null;
try {
  const esmRequire = createRequire2(import.meta.url);
  native = esmRequire("@signet/native");
} catch {}
var SIGNET_SOURCE_CHECKOUT_DIRNAME = "signetai";
var SIGNET_GIT_PROTECTED_PATHS = [
  "memory/memories.db",
  "memory/memories.db-wal",
  "memory/memories.db-shm",
  "memory/memories.db-journal",
  `${SIGNET_SOURCE_CHECKOUT_DIRNAME}/`
];
var DEFAULT_DISCORD_DESKTOP_CACHE_PATH = defaultDiscordDesktopCachePath();
var DEFAULT_GITHUB_RESOURCE_TYPES = ["issues", "pulls", "discussions", "docs"];
var VALID_GITHUB_RESOURCE_TYPES = new Set(DEFAULT_GITHUB_RESOURCE_TYPES);
function defaultDiscordDesktopCachePath() {
  switch (platform2()) {
    case "darwin":
      return resolve3(homedir3(), "Library", "Application Support", "discord");
    case "win32":
      return resolve3(process.env.APPDATA || resolve3(homedir3(), "AppData", "Roaming"), "discord");
    default:
      return resolve3(process.env.XDG_CONFIG_HOME || resolve3(homedir3(), ".config"), "discord");
  }
}
var IDENTITY_FILES = {
  agents: {
    path: "AGENTS.md",
    description: "Operational rules and behavioral settings",
    optional: false
  },
  soul: {
    path: "SOUL.md",
    description: "Persona, character, and security settings",
    optional: false
  },
  identity: {
    path: "IDENTITY.md",
    description: "Agent name, creature type, and vibe",
    optional: false
  },
  user: {
    path: "USER.md",
    description: "User profile and preferences",
    optional: false
  },
  heartbeat: {
    path: "HEARTBEAT.md",
    description: "Heartbeat prompt used only for heartbeat/background check sessions",
    optional: true,
    context: "session",
    session: "heartbeat"
  },
  memory: {
    path: "MEMORY.md",
    description: "Memory index and summary",
    optional: true
  },
  tools: {
    path: "TOOLS.md",
    description: "Tool preferences and notes",
    optional: true
  },
  bootstrap: {
    path: "BOOTSTRAP.md",
    description: "Setup ritual (typically deleted after first run)",
    optional: true,
    context: "session",
    session: "bootstrap"
  },
  dreaming: {
    path: "DREAMING.md",
    description: "Dreaming/reflection prompt used only for dreaming sessions",
    optional: true,
    context: "session",
    session: "dreaming"
  }
};
var REQUIRED_IDENTITY_KEYS = Object.entries(IDENTITY_FILES).filter(([, spec]) => !spec.optional).map(([key]) => key);
var OPTIONAL_IDENTITY_KEYS = Object.entries(IDENTITY_FILES).filter(([, spec]) => spec.optional).map(([key]) => key);
function linkDirSync(target, path) {
  const type = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(target, path, type);
}
function symlinkSkills(sourceDir, targetDir, options = {}) {
  const result = {
    created: [],
    skipped: [],
    errors: []
  };
  if (!existsSync12(sourceDir)) {
    return result;
  }
  const targetParent = join12(targetDir, "..");
  if (!existsSync12(targetParent)) {
    mkdirSync8(targetParent, { recursive: true });
  }
  if (!existsSync12(targetDir)) {
    mkdirSync8(targetDir, { recursive: true });
  }
  let entries;
  try {
    entries = readdirSync6(sourceDir);
  } catch (e) {
    result.errors.push({
      path: sourceDir,
      error: `Failed to read directory: ${e.message}`
    });
    return result;
  }
  for (const entry of entries) {
    const srcPath = join12(sourceDir, entry);
    const destPath = join12(targetDir, entry);
    try {
      const src = lstatSync(srcPath);
      if (src.isSymbolicLink() || !src.isDirectory()) {
        result.skipped.push(srcPath);
        continue;
      }
    } catch (e) {
      result.errors.push({
        path: srcPath,
        error: `Failed to stat: ${e.message}`
      });
      continue;
    }
    try {
      const destStat = lstatSync(destPath);
      if (destStat.isSymbolicLink()) {
        if (!options.dryRun) {
          unlinkSync(destPath);
        }
      } else {
        result.skipped.push(destPath);
        continue;
      }
    } catch {}
    if (options.dryRun) {
      result.created.push(`${destPath} (dry-run)`);
    } else {
      try {
        linkDirSync(srcPath, destPath);
        result.created.push(destPath);
      } catch (e) {
        result.errors.push({
          path: destPath,
          error: `Failed to create symlink: ${e.message}`
        });
      }
    }
  }
  return result;
}
var home = homedir7();
var SIGNET_BLOCK_START = "<!-- SIGNET:START -->";
var SIGNET_BLOCK_END = "<!-- SIGNET:END -->";
function stripSignetBlock(content) {
  const pattern = new RegExp(`${escapeRegex(SIGNET_BLOCK_START)}[\\s\\S]*?${escapeRegex(SIGNET_BLOCK_END)}\\n?`, "g");
  return content.replace(pattern, "");
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var SKIP_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "pinned_item",
  "unpinned_item",
  "bot_add",
  "bot_remove",
  "tombstone",
  "file_comment",
  "sh_room_created",
  "sh_room_shared"
]);
var SKIP_TYPES = new Set([
  "RecipientAdd",
  "RecipientRemove",
  "ChannelNameChange",
  "ChannelIconChange",
  "ChannelPinnedMessage",
  "GuildMemberJoin",
  "UserPremiumGuildSubscription",
  "UserPremiumGuildSubscriptionTier1",
  "UserPremiumGuildSubscriptionTier2",
  "UserPremiumGuildSubscriptionTier3",
  "ChannelFollowAdd",
  "GuildDiscoveryDisqualified",
  "GuildDiscoveryRequalified",
  "GuildDiscoveryGracePeriodInitialWarning",
  "GuildDiscoveryGracePeriodFinalWarning",
  "ThreadCreated",
  "ApplicationCommand"
]);
var SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "venv",
  ".venv",
  "env",
  "vendor",
  "coverage",
  ".cache",
  ".turbo"
]);
var DOCUMENT_VALID_TYPES = new Set([
  "fact",
  "decision",
  "rationale",
  "preference",
  "procedural",
  "semantic",
  "system",
  "configuration",
  "architectural",
  "relationship",
  "episodic",
  "daily-log"
]);
var ENTIRE_VALID_TYPES = new Set(["skill", "preference", "decision", "rationale", "procedural", "semantic", "fact"]);
var CHAT_VALID_TYPES = new Set(["fact", "decision", "rationale", "preference", "procedural", "semantic", "system"]);
var MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"]);
var TXT_EXTS = new Set([".txt", ".text", ".log", ".rst"]);
var PDF_EXTS = new Set([".pdf"]);
var CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".yaml",
  ".yml",
  ".toml",
  ".json",
  ".xml",
  ".css",
  ".scss",
  ".html",
  ".htm"
]);
var SKIP_FILES = new Set([".DS_Store", "Thumbs.db", ".gitkeep", "node_modules", ".git", ".env", ".env.local"]);

class BaseConnector {
  stripSignetBlock(content) {
    return stripSignetBlock(content);
  }
  stripLegacySignetBlock(basePath) {
    const agentsPath = join3(basePath, "AGENTS.md");
    if (!existsSync(agentsPath))
      return null;
    const raw = readFileSync(agentsPath, "utf-8");
    const cleaned = stripSignetBlock(raw);
    if (cleaned === raw)
      return null;
    const tmp = join3(basePath, `.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, cleaned, "utf-8");
      renameSync(tmp, agentsPath);
    } catch (err) {
      try {
        unlinkSync2(tmp);
      } catch {}
      throw err;
    }
    return agentsPath;
  }
  symlinkSkills(sourceDir, targetDir, options) {
    return symlinkSkills(sourceDir, targetDir, options);
  }
  generateHeader(sourcePath, targetName) {
    const name = targetName || this.name;
    const safe = (p) => p.replace(/[\n\r]/g, "");
    const root = dirname2(sourcePath);
    return `# Auto-generated from ${safe(sourcePath)}
# Source: ${safe(sourcePath)}
# Generated: ${new Date().toISOString()}
# DO NOT EDIT - changes will be overwritten
# Edit the source files in ${safe(root)}/ instead

`;
  }
  composeIdentityExtras(basePath) {
    const files = ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"];
    const parts = [];
    for (const name of files) {
      const filePath = join3(basePath, name);
      if (!existsSync(filePath))
        continue;
      try {
        const content = readFileSync(filePath, "utf-8").trim();
        if (!content)
          continue;
        const header = name.replace(".md", "");
        parts.push(`
## ${header}

${content}`);
      } catch {}
    }
    return parts.join(`
`);
  }
}
function atomicWriteJson(path, data, indent = 2) {
  const content = `${JSON.stringify(data, null, indent)}
`;
  const tmp = join3(dirname2(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync2(tmp);
    } catch {}
    throw err;
  }
}

// ../../../platform/core/dist/index.js
import { createRequire as createRequire3 } from "node:module";
import { dirname as dirname4, join as join2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { homedir as homedir2 } from "os";
import { join as join22 } from "path";
import { createRequire as createRequire22 } from "node:module";
import { homedir as homedir32, platform as platform22 } from "node:os";
import { basename as basename2, dirname as dirname32, resolve as resolve32 } from "node:path";
import { existsSync as existsSync10, readFileSync as readFileSync8, readdirSync as readdirSync4, realpathSync, statSync as statSync4 } from "node:fs";
import { dirname as dirname6, join as join10 } from "node:path";
import { homedir as homedir72 } from "node:os";
var __create2 = Object.create;
var __getProtoOf2 = Object.getPrototypeOf;
var __defProp2 = Object.defineProperty;
var __getOwnPropNames2 = Object.getOwnPropertyNames;
var __hasOwnProp2 = Object.prototype.hasOwnProperty;
function __accessProp2(key) {
  return this[key];
}
var __toESMCache_node2;
var __toESMCache_esm2;
var __toESM2 = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node2 ??= new WeakMap : __toESMCache_esm2 ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create2(__getProtoOf2(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp2(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames2(mod))
    if (!__hasOwnProp2.call(to, key))
      __defProp2(to, key, {
        get: __accessProp2.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS2 = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require2 = /* @__PURE__ */ createRequire3(import.meta.url);
var require_identity2 = __commonJS2((exports) => {
  var ALIAS = Symbol.for("yaml.alias");
  var DOC = Symbol.for("yaml.document");
  var MAP = Symbol.for("yaml.map");
  var PAIR = Symbol.for("yaml.pair");
  var SCALAR = Symbol.for("yaml.scalar");
  var SEQ = Symbol.for("yaml.seq");
  var NODE_TYPE = Symbol.for("yaml.node.type");
  var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
  var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
  var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
  var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
  var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
  var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
  function isCollection(node) {
    if (node && typeof node === "object")
      switch (node[NODE_TYPE]) {
        case MAP:
        case SEQ:
          return true;
      }
    return false;
  }
  function isNode(node) {
    if (node && typeof node === "object")
      switch (node[NODE_TYPE]) {
        case ALIAS:
        case MAP:
        case SCALAR:
        case SEQ:
          return true;
      }
    return false;
  }
  var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
  exports.ALIAS = ALIAS;
  exports.DOC = DOC;
  exports.MAP = MAP;
  exports.NODE_TYPE = NODE_TYPE;
  exports.PAIR = PAIR;
  exports.SCALAR = SCALAR;
  exports.SEQ = SEQ;
  exports.hasAnchor = hasAnchor;
  exports.isAlias = isAlias;
  exports.isCollection = isCollection;
  exports.isDocument = isDocument;
  exports.isMap = isMap;
  exports.isNode = isNode;
  exports.isPair = isPair;
  exports.isScalar = isScalar;
  exports.isSeq = isSeq;
});
var require_visit2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var BREAK = Symbol("break visit");
  var SKIP = Symbol("skip children");
  var REMOVE = Symbol("remove node");
  function visit(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE)
        node.contents = null;
    } else
      visit_(null, node, visitor_, Object.freeze([]));
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  function visit_(key, node, visitor, path) {
    const ctrl = callVisitor(key, node, visitor, path);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path, ctrl);
      return visit_(key, ctrl, visitor, path);
    }
    if (typeof ctrl !== "symbol") {
      if (identity.isCollection(node)) {
        path = Object.freeze(path.concat(node));
        for (let i = 0;i < node.items.length; ++i) {
          const ci = visit_(i, node.items[i], visitor, path);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path = Object.freeze(path.concat(node));
        const ck = visit_("key", node.key, visitor, path);
        if (ck === BREAK)
          return BREAK;
        else if (ck === REMOVE)
          node.key = null;
        const cv = visit_("value", node.value, visitor, path);
        if (cv === BREAK)
          return BREAK;
        else if (cv === REMOVE)
          node.value = null;
      }
    }
    return ctrl;
  }
  async function visitAsync(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE)
        node.contents = null;
    } else
      await visitAsync_(null, node, visitor_, Object.freeze([]));
  }
  visitAsync.BREAK = BREAK;
  visitAsync.SKIP = SKIP;
  visitAsync.REMOVE = REMOVE;
  async function visitAsync_(key, node, visitor, path) {
    const ctrl = await callVisitor(key, node, visitor, path);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path, ctrl);
      return visitAsync_(key, ctrl, visitor, path);
    }
    if (typeof ctrl !== "symbol") {
      if (identity.isCollection(node)) {
        path = Object.freeze(path.concat(node));
        for (let i = 0;i < node.items.length; ++i) {
          const ci = await visitAsync_(i, node.items[i], visitor, path);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path = Object.freeze(path.concat(node));
        const ck = await visitAsync_("key", node.key, visitor, path);
        if (ck === BREAK)
          return BREAK;
        else if (ck === REMOVE)
          node.key = null;
        const cv = await visitAsync_("value", node.value, visitor, path);
        if (cv === BREAK)
          return BREAK;
        else if (cv === REMOVE)
          node.value = null;
      }
    }
    return ctrl;
  }
  function initVisitor(visitor) {
    if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
      return Object.assign({
        Alias: visitor.Node,
        Map: visitor.Node,
        Scalar: visitor.Node,
        Seq: visitor.Node
      }, visitor.Value && {
        Map: visitor.Value,
        Scalar: visitor.Value,
        Seq: visitor.Value
      }, visitor.Collection && {
        Map: visitor.Collection,
        Seq: visitor.Collection
      }, visitor);
    }
    return visitor;
  }
  function callVisitor(key, node, visitor, path) {
    if (typeof visitor === "function")
      return visitor(key, node, path);
    if (identity.isMap(node))
      return visitor.Map?.(key, node, path);
    if (identity.isSeq(node))
      return visitor.Seq?.(key, node, path);
    if (identity.isPair(node))
      return visitor.Pair?.(key, node, path);
    if (identity.isScalar(node))
      return visitor.Scalar?.(key, node, path);
    if (identity.isAlias(node))
      return visitor.Alias?.(key, node, path);
    return;
  }
  function replaceNode(key, path, node) {
    const parent = path[path.length - 1];
    if (identity.isCollection(parent)) {
      parent.items[key] = node;
    } else if (identity.isPair(parent)) {
      if (key === "key")
        parent.key = node;
      else
        parent.value = node;
    } else if (identity.isDocument(parent)) {
      parent.contents = node;
    } else {
      const pt = identity.isAlias(parent) ? "alias" : "scalar";
      throw new Error(`Cannot replace node with ${pt} parent`);
    }
  }
  exports.visit = visit;
  exports.visitAsync = visitAsync;
});
var require_directives2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var visit = require_visit2();
  var escapeChars = {
    "!": "%21",
    ",": "%2C",
    "[": "%5B",
    "]": "%5D",
    "{": "%7B",
    "}": "%7D"
  };
  var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);

  class Directives {
    constructor(yaml, tags) {
      this.docStart = null;
      this.docEnd = false;
      this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
      this.tags = Object.assign({}, Directives.defaultTags, tags);
    }
    clone() {
      const copy = new Directives(this.yaml, this.tags);
      copy.docStart = this.docStart;
      return copy;
    }
    atDocument() {
      const res = new Directives(this.yaml, this.tags);
      switch (this.yaml.version) {
        case "1.1":
          this.atNextDocument = true;
          break;
        case "1.2":
          this.atNextDocument = false;
          this.yaml = {
            explicit: Directives.defaultYaml.explicit,
            version: "1.2"
          };
          this.tags = Object.assign({}, Directives.defaultTags);
          break;
      }
      return res;
    }
    add(line, onError) {
      if (this.atNextDocument) {
        this.yaml = { explicit: Directives.defaultYaml.explicit, version: "1.1" };
        this.tags = Object.assign({}, Directives.defaultTags);
        this.atNextDocument = false;
      }
      const parts = line.trim().split(/[ \t]+/);
      const name = parts.shift();
      switch (name) {
        case "%TAG": {
          if (parts.length !== 2) {
            onError(0, "%TAG directive should contain exactly two parts");
            if (parts.length < 2)
              return false;
          }
          const [handle, prefix] = parts;
          this.tags[handle] = prefix;
          return true;
        }
        case "%YAML": {
          this.yaml.explicit = true;
          if (parts.length !== 1) {
            onError(0, "%YAML directive should contain exactly one part");
            return false;
          }
          const [version] = parts;
          if (version === "1.1" || version === "1.2") {
            this.yaml.version = version;
            return true;
          } else {
            const isValid = /^\d+\.\d+$/.test(version);
            onError(6, `Unsupported YAML version ${version}`, isValid);
            return false;
          }
        }
        default:
          onError(0, `Unknown directive ${name}`, true);
          return false;
      }
    }
    tagName(source, onError) {
      if (source === "!")
        return "!";
      if (source[0] !== "!") {
        onError(`Not a valid tag: ${source}`);
        return null;
      }
      if (source[1] === "<") {
        const verbatim = source.slice(2, -1);
        if (verbatim === "!" || verbatim === "!!") {
          onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
          return null;
        }
        if (source[source.length - 1] !== ">")
          onError("Verbatim tags must end with a >");
        return verbatim;
      }
      const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
      if (!suffix)
        onError(`The ${source} tag has no suffix`);
      const prefix = this.tags[handle];
      if (prefix) {
        try {
          return prefix + decodeURIComponent(suffix);
        } catch (error) {
          onError(String(error));
          return null;
        }
      }
      if (handle === "!")
        return source;
      onError(`Could not resolve tag: ${source}`);
      return null;
    }
    tagString(tag) {
      for (const [handle, prefix] of Object.entries(this.tags)) {
        if (tag.startsWith(prefix))
          return handle + escapeTagName(tag.substring(prefix.length));
      }
      return tag[0] === "!" ? tag : `!<${tag}>`;
    }
    toString(doc) {
      const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
      const tagEntries = Object.entries(this.tags);
      let tagNames;
      if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
        const tags = {};
        visit.visit(doc.contents, (_key, node) => {
          if (identity.isNode(node) && node.tag)
            tags[node.tag] = true;
        });
        tagNames = Object.keys(tags);
      } else
        tagNames = [];
      for (const [handle, prefix] of tagEntries) {
        if (handle === "!!" && prefix === "tag:yaml.org,2002:")
          continue;
        if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
          lines.push(`%TAG ${handle} ${prefix}`);
      }
      return lines.join(`
`);
    }
  }
  Directives.defaultYaml = { explicit: false, version: "1.2" };
  Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
  exports.Directives = Directives;
});
var require_anchors2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var visit = require_visit2();
  function anchorIsValid(anchor) {
    if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
      const sa = JSON.stringify(anchor);
      const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
      throw new Error(msg);
    }
    return true;
  }
  function anchorNames(root) {
    const anchors = new Set;
    visit.visit(root, {
      Value(_key, node) {
        if (node.anchor)
          anchors.add(node.anchor);
      }
    });
    return anchors;
  }
  function findNewAnchor(prefix, exclude) {
    for (let i = 1;; ++i) {
      const name = `${prefix}${i}`;
      if (!exclude.has(name))
        return name;
    }
  }
  function createNodeAnchors(doc, prefix) {
    const aliasObjects = [];
    const sourceObjects = new Map;
    let prevAnchors = null;
    return {
      onAnchor: (source) => {
        aliasObjects.push(source);
        prevAnchors ?? (prevAnchors = anchorNames(doc));
        const anchor = findNewAnchor(prefix, prevAnchors);
        prevAnchors.add(anchor);
        return anchor;
      },
      setAnchors: () => {
        for (const source of aliasObjects) {
          const ref = sourceObjects.get(source);
          if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
            ref.node.anchor = ref.anchor;
          } else {
            const error = new Error("Failed to resolve repeated object (this should not happen)");
            error.source = source;
            throw error;
          }
        }
      },
      sourceObjects
    };
  }
  exports.anchorIsValid = anchorIsValid;
  exports.anchorNames = anchorNames;
  exports.createNodeAnchors = createNodeAnchors;
  exports.findNewAnchor = findNewAnchor;
});
var require_applyReviver2 = __commonJS2((exports) => {
  function applyReviver(reviver, obj, key, val) {
    if (val && typeof val === "object") {
      if (Array.isArray(val)) {
        for (let i = 0, len = val.length;i < len; ++i) {
          const v0 = val[i];
          const v1 = applyReviver(reviver, val, String(i), v0);
          if (v1 === undefined)
            delete val[i];
          else if (v1 !== v0)
            val[i] = v1;
        }
      } else if (val instanceof Map) {
        for (const k of Array.from(val.keys())) {
          const v0 = val.get(k);
          const v1 = applyReviver(reviver, val, k, v0);
          if (v1 === undefined)
            val.delete(k);
          else if (v1 !== v0)
            val.set(k, v1);
        }
      } else if (val instanceof Set) {
        for (const v0 of Array.from(val)) {
          const v1 = applyReviver(reviver, val, v0, v0);
          if (v1 === undefined)
            val.delete(v0);
          else if (v1 !== v0) {
            val.delete(v0);
            val.add(v1);
          }
        }
      } else {
        for (const [k, v0] of Object.entries(val)) {
          const v1 = applyReviver(reviver, val, k, v0);
          if (v1 === undefined)
            delete val[k];
          else if (v1 !== v0)
            val[k] = v1;
        }
      }
    }
    return reviver.call(obj, key, val);
  }
  exports.applyReviver = applyReviver;
});
var require_toJS2 = __commonJS2((exports) => {
  var identity = require_identity2();
  function toJS(value, arg, ctx) {
    if (Array.isArray(value))
      return value.map((v, i) => toJS(v, String(i), ctx));
    if (value && typeof value.toJSON === "function") {
      if (!ctx || !identity.hasAnchor(value))
        return value.toJSON(arg, ctx);
      const data = { aliasCount: 0, count: 1, res: undefined };
      ctx.anchors.set(value, data);
      ctx.onCreate = (res2) => {
        data.res = res2;
        delete ctx.onCreate;
      };
      const res = value.toJSON(arg, ctx);
      if (ctx.onCreate)
        ctx.onCreate(res);
      return res;
    }
    if (typeof value === "bigint" && !ctx?.keep)
      return Number(value);
    return value;
  }
  exports.toJS = toJS;
});
var require_Node2 = __commonJS2((exports) => {
  var applyReviver = require_applyReviver2();
  var identity = require_identity2();
  var toJS = require_toJS2();

  class NodeBase {
    constructor(type) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: type });
    }
    clone() {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      if (!identity.isDocument(doc))
        throw new TypeError("A document argument is required");
      const ctx = {
        anchors: new Map,
        doc,
        keep: true,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
      };
      const res = toJS.toJS(this, "", ctx);
      if (typeof onAnchor === "function")
        for (const { count, res: res2 } of ctx.anchors.values())
          onAnchor(res2, count);
      return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
    }
  }
  exports.NodeBase = NodeBase;
});
var require_Alias2 = __commonJS2((exports) => {
  var anchors = require_anchors2();
  var visit = require_visit2();
  var identity = require_identity2();
  var Node = require_Node2();
  var toJS = require_toJS2();

  class Alias extends Node.NodeBase {
    constructor(source) {
      super(identity.ALIAS);
      this.source = source;
      Object.defineProperty(this, "tag", {
        set() {
          throw new Error("Alias nodes cannot have tags");
        }
      });
    }
    resolve(doc, ctx) {
      let nodes;
      if (ctx?.aliasResolveCache) {
        nodes = ctx.aliasResolveCache;
      } else {
        nodes = [];
        visit.visit(doc, {
          Node: (_key, node) => {
            if (identity.isAlias(node) || identity.hasAnchor(node))
              nodes.push(node);
          }
        });
        if (ctx)
          ctx.aliasResolveCache = nodes;
      }
      let found = undefined;
      for (const node of nodes) {
        if (node === this)
          break;
        if (node.anchor === this.source)
          found = node;
      }
      return found;
    }
    toJSON(_arg, ctx) {
      if (!ctx)
        return { source: this.source };
      const { anchors: anchors2, doc, maxAliasCount } = ctx;
      const source = this.resolve(doc, ctx);
      if (!source) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new ReferenceError(msg);
      }
      let data = anchors2.get(source);
      if (!data) {
        toJS.toJS(source, null, ctx);
        data = anchors2.get(source);
      }
      if (data?.res === undefined) {
        const msg = "This should not happen: Alias anchor was not resolved?";
        throw new ReferenceError(msg);
      }
      if (maxAliasCount >= 0) {
        data.count += 1;
        if (data.aliasCount === 0)
          data.aliasCount = getAliasCount(doc, source, anchors2);
        if (data.count * data.aliasCount > maxAliasCount) {
          const msg = "Excessive alias count indicates a resource exhaustion attack";
          throw new ReferenceError(msg);
        }
      }
      return data.res;
    }
    toString(ctx, _onComment, _onChompKeep) {
      const src = `*${this.source}`;
      if (ctx) {
        anchors.anchorIsValid(this.source);
        if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new Error(msg);
        }
        if (ctx.implicitKey)
          return `${src} `;
      }
      return src;
    }
  }
  function getAliasCount(doc, node, anchors2) {
    if (identity.isAlias(node)) {
      const source = node.resolve(doc);
      const anchor = anchors2 && source && anchors2.get(source);
      return anchor ? anchor.count * anchor.aliasCount : 0;
    } else if (identity.isCollection(node)) {
      let count = 0;
      for (const item of node.items) {
        const c = getAliasCount(doc, item, anchors2);
        if (c > count)
          count = c;
      }
      return count;
    } else if (identity.isPair(node)) {
      const kc = getAliasCount(doc, node.key, anchors2);
      const vc = getAliasCount(doc, node.value, anchors2);
      return Math.max(kc, vc);
    }
    return 1;
  }
  exports.Alias = Alias;
});
var require_Scalar2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var Node = require_Node2();
  var toJS = require_toJS2();
  var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";

  class Scalar extends Node.NodeBase {
    constructor(value) {
      super(identity.SCALAR);
      this.value = value;
    }
    toJSON(arg, ctx) {
      return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
    }
    toString() {
      return String(this.value);
    }
  }
  Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
  Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
  Scalar.PLAIN = "PLAIN";
  Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
  Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
  exports.Scalar = Scalar;
  exports.isScalarValue = isScalarValue;
});
var require_createNode2 = __commonJS2((exports) => {
  var Alias = require_Alias2();
  var identity = require_identity2();
  var Scalar = require_Scalar2();
  var defaultTagPrefix = "tag:yaml.org,2002:";
  function findTagObject(value, tagName, tags) {
    if (tagName) {
      const match = tags.filter((t) => t.tag === tagName);
      const tagObj = match.find((t) => !t.format) ?? match[0];
      if (!tagObj)
        throw new Error(`Tag ${tagName} not found`);
      return tagObj;
    }
    return tags.find((t) => t.identify?.(value) && !t.format);
  }
  function createNode(value, tagName, ctx) {
    if (identity.isDocument(value))
      value = value.contents;
    if (identity.isNode(value))
      return value;
    if (identity.isPair(value)) {
      const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
      map.items.push(value);
      return map;
    }
    if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
      value = value.valueOf();
    }
    const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
    let ref = undefined;
    if (aliasDuplicateObjects && value && typeof value === "object") {
      ref = sourceObjects.get(value);
      if (ref) {
        ref.anchor ?? (ref.anchor = onAnchor(value));
        return new Alias.Alias(ref.anchor);
      } else {
        ref = { anchor: null, node: null };
        sourceObjects.set(value, ref);
      }
    }
    if (tagName?.startsWith("!!"))
      tagName = defaultTagPrefix + tagName.slice(2);
    let tagObj = findTagObject(value, tagName, schema.tags);
    if (!tagObj) {
      if (value && typeof value.toJSON === "function") {
        value = value.toJSON();
      }
      if (!value || typeof value !== "object") {
        const node2 = new Scalar.Scalar(value);
        if (ref)
          ref.node = node2;
        return node2;
      }
      tagObj = value instanceof Map ? schema[identity.MAP] : (Symbol.iterator in Object(value)) ? schema[identity.SEQ] : schema[identity.MAP];
    }
    if (onTagObj) {
      onTagObj(tagObj);
      delete ctx.onTagObj;
    }
    const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
    if (tagName)
      node.tag = tagName;
    else if (!tagObj.default)
      node.tag = tagObj.tag;
    if (ref)
      ref.node = node;
    return node;
  }
  exports.createNode = createNode;
});
var require_Collection2 = __commonJS2((exports) => {
  var createNode = require_createNode2();
  var identity = require_identity2();
  var Node = require_Node2();
  function collectionFromPath(schema, path, value) {
    let v = value;
    for (let i = path.length - 1;i >= 0; --i) {
      const k = path[i];
      if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
        const a = [];
        a[k] = v;
        v = a;
      } else {
        v = new Map([[k, v]]);
      }
    }
    return createNode.createNode(v, undefined, {
      aliasDuplicateObjects: false,
      keepUndefined: false,
      onAnchor: () => {
        throw new Error("This should not happen, please report a bug.");
      },
      schema,
      sourceObjects: new Map
    });
  }
  var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;

  class Collection extends Node.NodeBase {
    constructor(type, schema) {
      super(type);
      Object.defineProperty(this, "schema", {
        value: schema,
        configurable: true,
        enumerable: false,
        writable: true
      });
    }
    clone(schema) {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (schema)
        copy.schema = schema;
      copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    addIn(path, value) {
      if (isEmptyPath(path))
        this.add(value);
      else {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (identity.isCollection(node))
          node.addIn(rest, value);
        else if (node === undefined && this.schema)
          this.set(key, collectionFromPath(this.schema, rest, value));
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
    deleteIn(path) {
      const [key, ...rest] = path;
      if (rest.length === 0)
        return this.delete(key);
      const node = this.get(key, true);
      if (identity.isCollection(node))
        return node.deleteIn(rest);
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
    getIn(path, keepScalar) {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (rest.length === 0)
        return !keepScalar && identity.isScalar(node) ? node.value : node;
      else
        return identity.isCollection(node) ? node.getIn(rest, keepScalar) : undefined;
    }
    hasAllNullValues(allowScalar) {
      return this.items.every((node) => {
        if (!identity.isPair(node))
          return false;
        const n = node.value;
        return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
      });
    }
    hasIn(path) {
      const [key, ...rest] = path;
      if (rest.length === 0)
        return this.has(key);
      const node = this.get(key, true);
      return identity.isCollection(node) ? node.hasIn(rest) : false;
    }
    setIn(path, value) {
      const [key, ...rest] = path;
      if (rest.length === 0) {
        this.set(key, value);
      } else {
        const node = this.get(key, true);
        if (identity.isCollection(node))
          node.setIn(rest, value);
        else if (node === undefined && this.schema)
          this.set(key, collectionFromPath(this.schema, rest, value));
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
  }
  exports.Collection = Collection;
  exports.collectionFromPath = collectionFromPath;
  exports.isEmptyPath = isEmptyPath;
});
var require_stringifyComment2 = __commonJS2((exports) => {
  var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
  function indentComment(comment, indent) {
    if (/^\n+$/.test(comment))
      return comment.substring(1);
    return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
  }
  var lineComment = (str, indent, comment) => str.endsWith(`
`) ? indentComment(comment, indent) : comment.includes(`
`) ? `
` + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
  exports.indentComment = indentComment;
  exports.lineComment = lineComment;
  exports.stringifyComment = stringifyComment;
});
var require_foldFlowLines2 = __commonJS2((exports) => {
  var FOLD_FLOW = "flow";
  var FOLD_BLOCK = "block";
  var FOLD_QUOTED = "quoted";
  function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
    if (!lineWidth || lineWidth < 0)
      return text;
    if (lineWidth < minContentWidth)
      minContentWidth = 0;
    const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
    if (text.length <= endStep)
      return text;
    const folds = [];
    const escapedFolds = {};
    let end = lineWidth - indent.length;
    if (typeof indentAtStart === "number") {
      if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
        folds.push(0);
      else
        end = lineWidth - indentAtStart;
    }
    let split = undefined;
    let prev = undefined;
    let overflow = false;
    let i = -1;
    let escStart = -1;
    let escEnd = -1;
    if (mode === FOLD_BLOCK) {
      i = consumeMoreIndentedLines(text, i, indent.length);
      if (i !== -1)
        end = i + endStep;
    }
    for (let ch;ch = text[i += 1]; ) {
      if (mode === FOLD_QUOTED && ch === "\\") {
        escStart = i;
        switch (text[i + 1]) {
          case "x":
            i += 3;
            break;
          case "u":
            i += 5;
            break;
          case "U":
            i += 9;
            break;
          default:
            i += 1;
        }
        escEnd = i;
      }
      if (ch === `
`) {
        if (mode === FOLD_BLOCK)
          i = consumeMoreIndentedLines(text, i, indent.length);
        end = i + indent.length + endStep;
        split = undefined;
      } else {
        if (ch === " " && prev && prev !== " " && prev !== `
` && prev !== "\t") {
          const next = text[i + 1];
          if (next && next !== " " && next !== `
` && next !== "\t")
            split = i;
        }
        if (i >= end) {
          if (split) {
            folds.push(split);
            end = split + endStep;
            split = undefined;
          } else if (mode === FOLD_QUOTED) {
            while (prev === " " || prev === "\t") {
              prev = ch;
              ch = text[i += 1];
              overflow = true;
            }
            const j = i > escEnd + 1 ? i - 2 : escStart - 1;
            if (escapedFolds[j])
              return text;
            folds.push(j);
            escapedFolds[j] = true;
            end = j + endStep;
            split = undefined;
          } else {
            overflow = true;
          }
        }
      }
      prev = ch;
    }
    if (overflow && onOverflow)
      onOverflow();
    if (folds.length === 0)
      return text;
    if (onFold)
      onFold();
    let res = text.slice(0, folds[0]);
    for (let i2 = 0;i2 < folds.length; ++i2) {
      const fold = folds[i2];
      const end2 = folds[i2 + 1] || text.length;
      if (fold === 0)
        res = `
${indent}${text.slice(0, end2)}`;
      else {
        if (mode === FOLD_QUOTED && escapedFolds[fold])
          res += `${text[fold]}\\`;
        res += `
${indent}${text.slice(fold + 1, end2)}`;
      }
    }
    return res;
  }
  function consumeMoreIndentedLines(text, i, indent) {
    let end = i;
    let start = i + 1;
    let ch = text[start];
    while (ch === " " || ch === "\t") {
      if (i < start + indent) {
        ch = text[++i];
      } else {
        do {
          ch = text[++i];
        } while (ch && ch !== `
`);
        end = i;
        start = i + 1;
        ch = text[start];
      }
    }
    return end;
  }
  exports.FOLD_BLOCK = FOLD_BLOCK;
  exports.FOLD_FLOW = FOLD_FLOW;
  exports.FOLD_QUOTED = FOLD_QUOTED;
  exports.foldFlowLines = foldFlowLines;
});
var require_stringifyString2 = __commonJS2((exports) => {
  var Scalar = require_Scalar2();
  var foldFlowLines = require_foldFlowLines2();
  var getFoldOptions = (ctx, isBlock) => ({
    indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
    lineWidth: ctx.options.lineWidth,
    minContentWidth: ctx.options.minContentWidth
  });
  var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
  function lineLengthOverLimit(str, lineWidth, indentLength) {
    if (!lineWidth || lineWidth < 0)
      return false;
    const limit = lineWidth - indentLength;
    const strLen = str.length;
    if (strLen <= limit)
      return false;
    for (let i = 0, start = 0;i < strLen; ++i) {
      if (str[i] === `
`) {
        if (i - start > limit)
          return true;
        start = i + 1;
        if (strLen - start <= limit)
          return false;
      }
    }
    return true;
  }
  function doubleQuotedString(value, ctx) {
    const json = JSON.stringify(value);
    if (ctx.options.doubleQuotedAsJSON)
      return json;
    const { implicitKey } = ctx;
    const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
    const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
    let str = "";
    let start = 0;
    for (let i = 0, ch = json[i];ch; ch = json[++i]) {
      if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
        str += json.slice(start, i) + "\\ ";
        i += 1;
        start = i;
        ch = "\\";
      }
      if (ch === "\\")
        switch (json[i + 1]) {
          case "u":
            {
              str += json.slice(start, i);
              const code = json.substr(i + 2, 4);
              switch (code) {
                case "0000":
                  str += "\\0";
                  break;
                case "0007":
                  str += "\\a";
                  break;
                case "000b":
                  str += "\\v";
                  break;
                case "001b":
                  str += "\\e";
                  break;
                case "0085":
                  str += "\\N";
                  break;
                case "00a0":
                  str += "\\_";
                  break;
                case "2028":
                  str += "\\L";
                  break;
                case "2029":
                  str += "\\P";
                  break;
                default:
                  if (code.substr(0, 2) === "00")
                    str += "\\x" + code.substr(2);
                  else
                    str += json.substr(i, 6);
              }
              i += 5;
              start = i + 1;
            }
            break;
          case "n":
            if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
              i += 1;
            } else {
              str += json.slice(start, i) + `

`;
              while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                str += `
`;
                i += 2;
              }
              str += indent;
              if (json[i + 2] === " ")
                str += "\\";
              i += 1;
              start = i + 1;
            }
            break;
          default:
            i += 1;
        }
    }
    str = start ? str + json.slice(start) : json;
    return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
  }
  function singleQuotedString(value, ctx) {
    if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes(`
`) || /[ \t]\n|\n[ \t]/.test(value))
      return doubleQuotedString(value, ctx);
    const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
    const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
    return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function quotedString(value, ctx) {
    const { singleQuote } = ctx.options;
    let qs;
    if (singleQuote === false)
      qs = doubleQuotedString;
    else {
      const hasDouble = value.includes('"');
      const hasSingle = value.includes("'");
      if (hasDouble && !hasSingle)
        qs = singleQuotedString;
      else if (hasSingle && !hasDouble)
        qs = doubleQuotedString;
      else
        qs = singleQuote ? singleQuotedString : doubleQuotedString;
    }
    return qs(value, ctx);
  }
  var blockEndNewlines;
  try {
    blockEndNewlines = new RegExp(`(^|(?<!
))
+(?!
|$)`, "g");
  } catch {
    blockEndNewlines = /\n+(?!\n|$)/g;
  }
  function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
    const { blockQuote, commentString, lineWidth } = ctx.options;
    if (!blockQuote || /\n[\t ]+$/.test(value)) {
      return quotedString(value, ctx);
    }
    const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
    const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
    if (!value)
      return literal ? `|
` : `>
`;
    let chomp;
    let endStart;
    for (endStart = value.length;endStart > 0; --endStart) {
      const ch = value[endStart - 1];
      if (ch !== `
` && ch !== "\t" && ch !== " ")
        break;
    }
    let end = value.substring(endStart);
    const endNlPos = end.indexOf(`
`);
    if (endNlPos === -1) {
      chomp = "-";
    } else if (value === end || endNlPos !== end.length - 1) {
      chomp = "+";
      if (onChompKeep)
        onChompKeep();
    } else {
      chomp = "";
    }
    if (end) {
      value = value.slice(0, -end.length);
      if (end[end.length - 1] === `
`)
        end = end.slice(0, -1);
      end = end.replace(blockEndNewlines, `$&${indent}`);
    }
    let startWithSpace = false;
    let startEnd;
    let startNlPos = -1;
    for (startEnd = 0;startEnd < value.length; ++startEnd) {
      const ch = value[startEnd];
      if (ch === " ")
        startWithSpace = true;
      else if (ch === `
`)
        startNlPos = startEnd;
      else
        break;
    }
    let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
    if (start) {
      value = value.substring(start.length);
      start = start.replace(/\n+/g, `$&${indent}`);
    }
    const indentSize = indent ? "2" : "1";
    let header = (startWithSpace ? indentSize : "") + chomp;
    if (comment) {
      header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
      if (onComment)
        onComment();
    }
    if (!literal) {
      const foldedValue = value.replace(/\n+/g, `
$&`).replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
      let literalFallback = false;
      const foldOptions = getFoldOptions(ctx, true);
      if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
        foldOptions.onOverflow = () => {
          literalFallback = true;
        };
      }
      const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
      if (!literalFallback)
        return `>${header}
${indent}${body}`;
    }
    value = value.replace(/\n+/g, `$&${indent}`);
    return `|${header}
${indent}${start}${value}${end}`;
  }
  function plainString(item, ctx, onComment, onChompKeep) {
    const { type, value } = item;
    const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
    if (implicitKey && value.includes(`
`) || inFlow && /[[\]{},]/.test(value)) {
      return quotedString(value, ctx);
    }
    if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
      return implicitKey || inFlow || !value.includes(`
`) ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
    }
    if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes(`
`)) {
      return blockString(item, ctx, onComment, onChompKeep);
    }
    if (containsDocumentMarker(value)) {
      if (indent === "") {
        ctx.forceBlockIndent = true;
        return blockString(item, ctx, onComment, onChompKeep);
      } else if (implicitKey && indent === indentStep) {
        return quotedString(value, ctx);
      }
    }
    const str = value.replace(/\n+/g, `$&
${indent}`);
    if (actualString) {
      const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
      const { compat, tags } = ctx.doc.schema;
      if (tags.some(test) || compat?.some(test))
        return quotedString(value, ctx);
    }
    return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function stringifyString(item, ctx, onComment, onChompKeep) {
    const { implicitKey, inFlow } = ctx;
    const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
    let { type } = item;
    if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
      if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
        type = Scalar.Scalar.QUOTE_DOUBLE;
    }
    const _stringify = (_type) => {
      switch (_type) {
        case Scalar.Scalar.BLOCK_FOLDED:
        case Scalar.Scalar.BLOCK_LITERAL:
          return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
        case Scalar.Scalar.QUOTE_DOUBLE:
          return doubleQuotedString(ss.value, ctx);
        case Scalar.Scalar.QUOTE_SINGLE:
          return singleQuotedString(ss.value, ctx);
        case Scalar.Scalar.PLAIN:
          return plainString(ss, ctx, onComment, onChompKeep);
        default:
          return null;
      }
    };
    let res = _stringify(type);
    if (res === null) {
      const { defaultKeyType, defaultStringType } = ctx.options;
      const t = implicitKey && defaultKeyType || defaultStringType;
      res = _stringify(t);
      if (res === null)
        throw new Error(`Unsupported default string type ${t}`);
    }
    return res;
  }
  exports.stringifyString = stringifyString;
});
var require_stringify2 = __commonJS2((exports) => {
  var anchors = require_anchors2();
  var identity = require_identity2();
  var stringifyComment = require_stringifyComment2();
  var stringifyString = require_stringifyString2();
  function createStringifyContext(doc, options) {
    const opt = Object.assign({
      blockQuote: true,
      commentString: stringifyComment.stringifyComment,
      defaultKeyType: null,
      defaultStringType: "PLAIN",
      directives: null,
      doubleQuotedAsJSON: false,
      doubleQuotedMinMultiLineLength: 40,
      falseStr: "false",
      flowCollectionPadding: true,
      indentSeq: true,
      lineWidth: 80,
      minContentWidth: 20,
      nullStr: "null",
      simpleKeys: false,
      singleQuote: null,
      trailingComma: false,
      trueStr: "true",
      verifyAliasOrder: true
    }, doc.schema.toStringOptions, options);
    let inFlow;
    switch (opt.collectionStyle) {
      case "block":
        inFlow = false;
        break;
      case "flow":
        inFlow = true;
        break;
      default:
        inFlow = null;
    }
    return {
      anchors: new Set,
      doc,
      flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
      indent: "",
      indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
      inFlow,
      options: opt
    };
  }
  function getTagObject(tags, item) {
    if (item.tag) {
      const match = tags.filter((t) => t.tag === item.tag);
      if (match.length > 0)
        return match.find((t) => t.format === item.format) ?? match[0];
    }
    let tagObj = undefined;
    let obj;
    if (identity.isScalar(item)) {
      obj = item.value;
      let match = tags.filter((t) => t.identify?.(obj));
      if (match.length > 1) {
        const testMatch = match.filter((t) => t.test);
        if (testMatch.length > 0)
          match = testMatch;
      }
      tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
    } else {
      obj = item;
      tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
    }
    if (!tagObj) {
      const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
      throw new Error(`Tag not resolved for ${name} value`);
    }
    return tagObj;
  }
  function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
    if (!doc.directives)
      return "";
    const props = [];
    const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
    if (anchor && anchors.anchorIsValid(anchor)) {
      anchors$1.add(anchor);
      props.push(`&${anchor}`);
    }
    const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
    if (tag)
      props.push(doc.directives.tagString(tag));
    return props.join(" ");
  }
  function stringify(item, ctx, onComment, onChompKeep) {
    if (identity.isPair(item))
      return item.toString(ctx, onComment, onChompKeep);
    if (identity.isAlias(item)) {
      if (ctx.doc.directives)
        return item.toString(ctx);
      if (ctx.resolvedAliases?.has(item)) {
        throw new TypeError(`Cannot stringify circular structure without alias nodes`);
      } else {
        if (ctx.resolvedAliases)
          ctx.resolvedAliases.add(item);
        else
          ctx.resolvedAliases = new Set([item]);
        item = item.resolve(ctx.doc);
      }
    }
    let tagObj = undefined;
    const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
    tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
    const props = stringifyProps(node, tagObj, ctx);
    if (props.length > 0)
      ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
    const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
    if (!props)
      return str;
    return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
  }
  exports.createStringifyContext = createStringifyContext;
  exports.stringify = stringify;
});
var require_stringifyPair2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var Scalar = require_Scalar2();
  var stringify = require_stringify2();
  var stringifyComment = require_stringifyComment2();
  function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
    const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
    let keyComment = identity.isNode(key) && key.comment || null;
    if (simpleKeys) {
      if (keyComment) {
        throw new Error("With simple keys, key nodes cannot have comments");
      }
      if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
        const msg = "With simple keys, collection cannot be used as a key value";
        throw new Error(msg);
      }
    }
    let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
    ctx = Object.assign({}, ctx, {
      allNullValues: false,
      implicitKey: !explicitKey && (simpleKeys || !allNullValues),
      indent: indent + indentStep
    });
    let keyCommentDone = false;
    let chompKeep = false;
    let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
    if (!explicitKey && !ctx.inFlow && str.length > 1024) {
      if (simpleKeys)
        throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
      explicitKey = true;
    }
    if (ctx.inFlow) {
      if (allNullValues || value == null) {
        if (keyCommentDone && onComment)
          onComment();
        return str === "" ? "?" : explicitKey ? `? ${str}` : str;
      }
    } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
      str = `? ${str}`;
      if (keyComment && !keyCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    if (keyCommentDone)
      keyComment = null;
    if (explicitKey) {
      if (keyComment)
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      str = `? ${str}
${indent}:`;
    } else {
      str = `${str}:`;
      if (keyComment)
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
    }
    let vsb, vcb, valueComment;
    if (identity.isNode(value)) {
      vsb = !!value.spaceBefore;
      vcb = value.commentBefore;
      valueComment = value.comment;
    } else {
      vsb = false;
      vcb = null;
      valueComment = null;
      if (value && typeof value === "object")
        value = doc.createNode(value);
    }
    ctx.implicitKey = false;
    if (!explicitKey && !keyComment && identity.isScalar(value))
      ctx.indentAtStart = str.length + 1;
    chompKeep = false;
    if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
      ctx.indent = ctx.indent.substring(2);
    }
    let valueCommentDone = false;
    const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
    let ws = " ";
    if (keyComment || vsb || vcb) {
      ws = vsb ? `
` : "";
      if (vcb) {
        const cs = commentString(vcb);
        ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
      }
      if (valueStr === "" && !ctx.inFlow) {
        if (ws === `
` && valueComment)
          ws = `

`;
      } else {
        ws += `
${ctx.indent}`;
      }
    } else if (!explicitKey && identity.isCollection(value)) {
      const vs0 = valueStr[0];
      const nl0 = valueStr.indexOf(`
`);
      const hasNewline = nl0 !== -1;
      const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
      if (hasNewline || !flow) {
        let hasPropsLine = false;
        if (hasNewline && (vs0 === "&" || vs0 === "!")) {
          let sp0 = valueStr.indexOf(" ");
          if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
            sp0 = valueStr.indexOf(" ", sp0 + 1);
          }
          if (sp0 === -1 || nl0 < sp0)
            hasPropsLine = true;
        }
        if (!hasPropsLine)
          ws = `
${ctx.indent}`;
      }
    } else if (valueStr === "" || valueStr[0] === `
`) {
      ws = "";
    }
    str += ws + valueStr;
    if (ctx.inFlow) {
      if (valueCommentDone && onComment)
        onComment();
    } else if (valueComment && !valueCommentDone) {
      str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
    } else if (chompKeep && onChompKeep) {
      onChompKeep();
    }
    return str;
  }
  exports.stringifyPair = stringifyPair;
});
var require_log2 = __commonJS2((exports) => {
  var node_process = __require2("process");
  function debug(logLevel, ...messages) {
    if (logLevel === "debug")
      console.log(...messages);
  }
  function warn(logLevel, warning) {
    if (logLevel === "debug" || logLevel === "warn") {
      if (typeof node_process.emitWarning === "function")
        node_process.emitWarning(warning);
      else
        console.warn(warning);
    }
  }
  exports.debug = debug;
  exports.warn = warn;
});
var require_merge2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var Scalar = require_Scalar2();
  var MERGE_KEY = "<<";
  var merge = {
    identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
    default: "key",
    tag: "tag:yaml.org,2002:merge",
    test: /^<<$/,
    resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
      addToJSMap: addMergeToJSMap
    }),
    stringify: () => MERGE_KEY
  };
  var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
  function addMergeToJSMap(ctx, map, value) {
    value = ctx && identity.isAlias(value) ? value.resolve(ctx.doc) : value;
    if (identity.isSeq(value))
      for (const it of value.items)
        mergeValue(ctx, map, it);
    else if (Array.isArray(value))
      for (const it of value)
        mergeValue(ctx, map, it);
    else
      mergeValue(ctx, map, value);
  }
  function mergeValue(ctx, map, value) {
    const source = ctx && identity.isAlias(value) ? value.resolve(ctx.doc) : value;
    if (!identity.isMap(source))
      throw new Error("Merge sources must be maps or map aliases");
    const srcMap = source.toJSON(null, ctx, Map);
    for (const [key, value2] of srcMap) {
      if (map instanceof Map) {
        if (!map.has(key))
          map.set(key, value2);
      } else if (map instanceof Set) {
        map.add(key);
      } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
        Object.defineProperty(map, key, {
          value: value2,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
    }
    return map;
  }
  exports.addMergeToJSMap = addMergeToJSMap;
  exports.isMergeKey = isMergeKey;
  exports.merge = merge;
});
var require_addPairToJSMap2 = __commonJS2((exports) => {
  var log = require_log2();
  var merge = require_merge2();
  var stringify = require_stringify2();
  var identity = require_identity2();
  var toJS = require_toJS2();
  function addPairToJSMap(ctx, map, { key, value }) {
    if (identity.isNode(key) && key.addToJSMap)
      key.addToJSMap(ctx, map, value);
    else if (merge.isMergeKey(ctx, key))
      merge.addMergeToJSMap(ctx, map, value);
    else {
      const jsKey = toJS.toJS(key, "", ctx);
      if (map instanceof Map) {
        map.set(jsKey, toJS.toJS(value, jsKey, ctx));
      } else if (map instanceof Set) {
        map.add(jsKey);
      } else {
        const stringKey = stringifyKey(key, jsKey, ctx);
        const jsValue = toJS.toJS(value, stringKey, ctx);
        if (stringKey in map)
          Object.defineProperty(map, stringKey, {
            value: jsValue,
            writable: true,
            enumerable: true,
            configurable: true
          });
        else
          map[stringKey] = jsValue;
      }
    }
    return map;
  }
  function stringifyKey(key, jsKey, ctx) {
    if (jsKey === null)
      return "";
    if (typeof jsKey !== "object")
      return String(jsKey);
    if (identity.isNode(key) && ctx?.doc) {
      const strCtx = stringify.createStringifyContext(ctx.doc, {});
      strCtx.anchors = new Set;
      for (const node of ctx.anchors.keys())
        strCtx.anchors.add(node.anchor);
      strCtx.inFlow = true;
      strCtx.inStringifyKey = true;
      const strKey = key.toString(strCtx);
      if (!ctx.mapKeyWarned) {
        let jsonStr = JSON.stringify(strKey);
        if (jsonStr.length > 40)
          jsonStr = jsonStr.substring(0, 36) + '..."';
        log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
        ctx.mapKeyWarned = true;
      }
      return strKey;
    }
    return JSON.stringify(jsKey);
  }
  exports.addPairToJSMap = addPairToJSMap;
});
var require_Pair2 = __commonJS2((exports) => {
  var createNode = require_createNode2();
  var stringifyPair = require_stringifyPair2();
  var addPairToJSMap = require_addPairToJSMap2();
  var identity = require_identity2();
  function createPair(key, value, ctx) {
    const k = createNode.createNode(key, undefined, ctx);
    const v = createNode.createNode(value, undefined, ctx);
    return new Pair(k, v);
  }

  class Pair {
    constructor(key, value = null) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
      this.key = key;
      this.value = value;
    }
    clone(schema) {
      let { key, value } = this;
      if (identity.isNode(key))
        key = key.clone(schema);
      if (identity.isNode(value))
        value = value.clone(schema);
      return new Pair(key, value);
    }
    toJSON(_, ctx) {
      const pair = ctx?.mapAsMap ? new Map : {};
      return addPairToJSMap.addPairToJSMap(ctx, pair, this);
    }
    toString(ctx, onComment, onChompKeep) {
      return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
    }
  }
  exports.Pair = Pair;
  exports.createPair = createPair;
});
var require_stringifyCollection2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var stringify = require_stringify2();
  var stringifyComment = require_stringifyComment2();
  function stringifyCollection(collection, ctx, options) {
    const flow = ctx.inFlow ?? collection.flow;
    const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
    return stringify2(collection, ctx, options);
  }
  function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
    const { indent, options: { commentString } } = ctx;
    const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
    let chompKeep = false;
    const lines = [];
    for (let i = 0;i < items.length; ++i) {
      const item = items[i];
      let comment2 = null;
      if (identity.isNode(item)) {
        if (!chompKeep && item.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
        if (item.comment)
          comment2 = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (!chompKeep && ik.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
        }
      }
      chompKeep = false;
      let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
      if (comment2)
        str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
      if (chompKeep && comment2)
        chompKeep = false;
      lines.push(blockItemPrefix + str2);
    }
    let str;
    if (lines.length === 0) {
      str = flowChars.start + flowChars.end;
    } else {
      str = lines[0];
      for (let i = 1;i < lines.length; ++i) {
        const line = lines[i];
        str += line ? `
${indent}${line}` : `
`;
      }
    }
    if (comment) {
      str += `
` + stringifyComment.indentComment(commentString(comment), indent);
      if (onComment)
        onComment();
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
    const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
    itemIndent += indentStep;
    const itemCtx = Object.assign({}, ctx, {
      indent: itemIndent,
      inFlow: true,
      type: null
    });
    let reqNewline = false;
    let linesAtValue = 0;
    const lines = [];
    for (let i = 0;i < items.length; ++i) {
      const item = items[i];
      let comment = null;
      if (identity.isNode(item)) {
        if (item.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, item.commentBefore, false);
        if (item.comment)
          comment = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (ik.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, ik.commentBefore, false);
          if (ik.comment)
            reqNewline = true;
        }
        const iv = identity.isNode(item.value) ? item.value : null;
        if (iv) {
          if (iv.comment)
            comment = iv.comment;
          if (iv.commentBefore)
            reqNewline = true;
        } else if (item.value == null && ik?.comment) {
          comment = ik.comment;
        }
      }
      if (comment)
        reqNewline = true;
      let str = stringify.stringify(item, itemCtx, () => comment = null);
      reqNewline || (reqNewline = lines.length > linesAtValue || str.includes(`
`));
      if (i < items.length - 1) {
        str += ",";
      } else if (ctx.options.trailingComma) {
        if (ctx.options.lineWidth > 0) {
          reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
        }
        if (reqNewline) {
          str += ",";
        }
      }
      if (comment)
        str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
      lines.push(str);
      linesAtValue = lines.length;
    }
    const { start, end } = flowChars;
    if (lines.length === 0) {
      return start + end;
    } else {
      if (!reqNewline) {
        const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
        reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
      }
      if (reqNewline) {
        let str = start;
        for (const line of lines)
          str += line ? `
${indentStep}${indent}${line}` : `
`;
        return `${str}
${indent}${end}`;
      } else {
        return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
      }
    }
  }
  function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
    if (comment && chompKeep)
      comment = comment.replace(/^\n+/, "");
    if (comment) {
      const ic = stringifyComment.indentComment(commentString(comment), indent);
      lines.push(ic.trimStart());
    }
  }
  exports.stringifyCollection = stringifyCollection;
});
var require_YAMLMap2 = __commonJS2((exports) => {
  var stringifyCollection = require_stringifyCollection2();
  var addPairToJSMap = require_addPairToJSMap2();
  var Collection = require_Collection2();
  var identity = require_identity2();
  var Pair = require_Pair2();
  var Scalar = require_Scalar2();
  function findPair(items, key) {
    const k = identity.isScalar(key) ? key.value : key;
    for (const it of items) {
      if (identity.isPair(it)) {
        if (it.key === key || it.key === k)
          return it;
        if (identity.isScalar(it.key) && it.key.value === k)
          return it;
      }
    }
    return;
  }

  class YAMLMap extends Collection.Collection {
    static get tagName() {
      return "tag:yaml.org,2002:map";
    }
    constructor(schema) {
      super(identity.MAP, schema);
      this.items = [];
    }
    static from(schema, obj, ctx) {
      const { keepUndefined, replacer } = ctx;
      const map = new this(schema);
      const add = (key, value) => {
        if (typeof replacer === "function")
          value = replacer.call(obj, key, value);
        else if (Array.isArray(replacer) && !replacer.includes(key))
          return;
        if (value !== undefined || keepUndefined)
          map.items.push(Pair.createPair(key, value, ctx));
      };
      if (obj instanceof Map) {
        for (const [key, value] of obj)
          add(key, value);
      } else if (obj && typeof obj === "object") {
        for (const key of Object.keys(obj))
          add(key, obj[key]);
      }
      if (typeof schema.sortMapEntries === "function") {
        map.items.sort(schema.sortMapEntries);
      }
      return map;
    }
    add(pair, overwrite) {
      let _pair;
      if (identity.isPair(pair))
        _pair = pair;
      else if (!pair || typeof pair !== "object" || !("key" in pair)) {
        _pair = new Pair.Pair(pair, pair?.value);
      } else
        _pair = new Pair.Pair(pair.key, pair.value);
      const prev = findPair(this.items, _pair.key);
      const sortEntries = this.schema?.sortMapEntries;
      if (prev) {
        if (!overwrite)
          throw new Error(`Key ${_pair.key} already set`);
        if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
          prev.value.value = _pair.value;
        else
          prev.value = _pair.value;
      } else if (sortEntries) {
        const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
        if (i === -1)
          this.items.push(_pair);
        else
          this.items.splice(i, 0, _pair);
      } else {
        this.items.push(_pair);
      }
    }
    delete(key) {
      const it = findPair(this.items, key);
      if (!it)
        return false;
      const del = this.items.splice(this.items.indexOf(it), 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const it = findPair(this.items, key);
      const node = it?.value;
      return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? undefined;
    }
    has(key) {
      return !!findPair(this.items, key);
    }
    set(key, value) {
      this.add(new Pair.Pair(key, value), true);
    }
    toJSON(_, ctx, Type) {
      const map = Type ? new Type : ctx?.mapAsMap ? new Map : {};
      if (ctx?.onCreate)
        ctx.onCreate(map);
      for (const item of this.items)
        addPairToJSMap.addPairToJSMap(ctx, map, item);
      return map;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      for (const item of this.items) {
        if (!identity.isPair(item))
          throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
      }
      if (!ctx.allNullValues && this.hasAllNullValues(false))
        ctx = Object.assign({}, ctx, { allNullValues: true });
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: "",
        flowChars: { start: "{", end: "}" },
        itemIndent: ctx.indent || "",
        onChompKeep,
        onComment
      });
    }
  }
  exports.YAMLMap = YAMLMap;
  exports.findPair = findPair;
});
var require_map2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var YAMLMap = require_YAMLMap2();
  var map = {
    collection: "map",
    default: true,
    nodeClass: YAMLMap.YAMLMap,
    tag: "tag:yaml.org,2002:map",
    resolve(map2, onError) {
      if (!identity.isMap(map2))
        onError("Expected a mapping for this tag");
      return map2;
    },
    createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
  };
  exports.map = map;
});
var require_YAMLSeq2 = __commonJS2((exports) => {
  var createNode = require_createNode2();
  var stringifyCollection = require_stringifyCollection2();
  var Collection = require_Collection2();
  var identity = require_identity2();
  var Scalar = require_Scalar2();
  var toJS = require_toJS2();

  class YAMLSeq extends Collection.Collection {
    static get tagName() {
      return "tag:yaml.org,2002:seq";
    }
    constructor(schema) {
      super(identity.SEQ, schema);
      this.items = [];
    }
    add(value) {
      this.items.push(value);
    }
    delete(key) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        return false;
      const del = this.items.splice(idx, 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        return;
      const it = this.items[idx];
      return !keepScalar && identity.isScalar(it) ? it.value : it;
    }
    has(key) {
      const idx = asItemIndex(key);
      return typeof idx === "number" && idx < this.items.length;
    }
    set(key, value) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        throw new Error(`Expected a valid index, not ${key}.`);
      const prev = this.items[idx];
      if (identity.isScalar(prev) && Scalar.isScalarValue(value))
        prev.value = value;
      else
        this.items[idx] = value;
    }
    toJSON(_, ctx) {
      const seq = [];
      if (ctx?.onCreate)
        ctx.onCreate(seq);
      let i = 0;
      for (const item of this.items)
        seq.push(toJS.toJS(item, String(i++), ctx));
      return seq;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: "- ",
        flowChars: { start: "[", end: "]" },
        itemIndent: (ctx.indent || "") + "  ",
        onChompKeep,
        onComment
      });
    }
    static from(schema, obj, ctx) {
      const { replacer } = ctx;
      const seq = new this(schema);
      if (obj && Symbol.iterator in Object(obj)) {
        let i = 0;
        for (let it of obj) {
          if (typeof replacer === "function") {
            const key = obj instanceof Set ? it : String(i++);
            it = replacer.call(obj, key, it);
          }
          seq.items.push(createNode.createNode(it, undefined, ctx));
        }
      }
      return seq;
    }
  }
  function asItemIndex(key) {
    let idx = identity.isScalar(key) ? key.value : key;
    if (idx && typeof idx === "string")
      idx = Number(idx);
    return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
  }
  exports.YAMLSeq = YAMLSeq;
});
var require_seq2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var YAMLSeq = require_YAMLSeq2();
  var seq = {
    collection: "seq",
    default: true,
    nodeClass: YAMLSeq.YAMLSeq,
    tag: "tag:yaml.org,2002:seq",
    resolve(seq2, onError) {
      if (!identity.isSeq(seq2))
        onError("Expected a sequence for this tag");
      return seq2;
    },
    createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
  };
  exports.seq = seq;
});
var require_string2 = __commonJS2((exports) => {
  var stringifyString = require_stringifyString2();
  var string = {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str,
    stringify(item, ctx, onComment, onChompKeep) {
      ctx = Object.assign({ actualString: true }, ctx);
      return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
    }
  };
  exports.string = string;
});
var require_null2 = __commonJS2((exports) => {
  var Scalar = require_Scalar2();
  var nullTag = {
    identify: (value) => value == null,
    createNode: () => new Scalar.Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^(?:~|[Nn]ull|NULL)?$/,
    resolve: () => new Scalar.Scalar(null),
    stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
  };
  exports.nullTag = nullTag;
});
var require_bool3 = __commonJS2((exports) => {
  var Scalar = require_Scalar2();
  var boolTag = {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
    resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
    stringify({ source, value }, ctx) {
      if (source && boolTag.test.test(source)) {
        const sv = source[0] === "t" || source[0] === "T";
        if (value === sv)
          return source;
      }
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
  };
  exports.boolTag = boolTag;
});
var require_stringifyNumber2 = __commonJS2((exports) => {
  function stringifyNumber({ format, minFractionDigits, tag, value }) {
    if (typeof value === "bigint")
      return String(value);
    const num = typeof value === "number" ? value : Number(value);
    if (!isFinite(num))
      return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
    let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
    if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^\d/.test(n)) {
      let i = n.indexOf(".");
      if (i < 0) {
        i = n.length;
        n += ".";
      }
      let d = minFractionDigits - (n.length - i - 1);
      while (d-- > 0)
        n += "0";
    }
    return n;
  }
  exports.stringifyNumber = stringifyNumber;
});
var require_float3 = __commonJS2((exports) => {
  var Scalar = require_Scalar2();
  var stringifyNumber = require_stringifyNumber2();
  var floatNaN = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber
  };
  var floatExp = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "EXP",
    test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
    resolve: (str) => parseFloat(str),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    }
  };
  var float = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str));
      const dot = str.indexOf(".");
      if (dot !== -1 && str[str.length - 1] === "0")
        node.minFractionDigits = str.length - dot - 1;
      return node;
    },
    stringify: stringifyNumber.stringifyNumber
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});
var require_int3 = __commonJS2((exports) => {
  var stringifyNumber = require_stringifyNumber2();
  var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
  var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value) && value >= 0)
      return prefix + value.toString(radix);
    return stringifyNumber.stringifyNumber(node);
  }
  var intOct = {
    identify: (value) => intIdentify(value) && value >= 0,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "OCT",
    test: /^0o[0-7]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
    stringify: (node) => intStringify(node, 8, "0o")
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^[-+]?[0-9]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber
  };
  var intHex = {
    identify: (value) => intIdentify(value) && value >= 0,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "HEX",
    test: /^0x[0-9a-fA-F]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: (node) => intStringify(node, 16, "0x")
  };
  exports.int = int;
  exports.intHex = intHex;
  exports.intOct = intOct;
});
var require_schema4 = __commonJS2((exports) => {
  var map = require_map2();
  var _null = require_null2();
  var seq = require_seq2();
  var string = require_string2();
  var bool = require_bool3();
  var float = require_float3();
  var int = require_int3();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.boolTag,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float
  ];
  exports.schema = schema;
});
var require_schema22 = __commonJS2((exports) => {
  var Scalar = require_Scalar2();
  var map = require_map2();
  var seq = require_seq2();
  function intIdentify(value) {
    return typeof value === "bigint" || Number.isInteger(value);
  }
  var stringifyJSON = ({ value }) => JSON.stringify(value);
  var jsonScalars = [
    {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify: stringifyJSON
    },
    {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^null$/,
      resolve: () => null,
      stringify: stringifyJSON
    },
    {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^true$|^false$/,
      resolve: (str) => str === "true",
      stringify: stringifyJSON
    },
    {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^-?(?:0|[1-9][0-9]*)$/,
      resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
      stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
    },
    {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
      resolve: (str) => parseFloat(str),
      stringify: stringifyJSON
    }
  ];
  var jsonError = {
    default: true,
    tag: "",
    test: /^/,
    resolve(str, onError) {
      onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
      return str;
    }
  };
  var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
  exports.schema = schema;
});
var require_binary2 = __commonJS2((exports) => {
  var node_buffer = __require2("buffer");
  var Scalar = require_Scalar2();
  var stringifyString = require_stringifyString2();
  var binary = {
    identify: (value) => value instanceof Uint8Array,
    default: false,
    tag: "tag:yaml.org,2002:binary",
    resolve(src, onError) {
      if (typeof node_buffer.Buffer === "function") {
        return node_buffer.Buffer.from(src, "base64");
      } else if (typeof atob === "function") {
        const str = atob(src.replace(/[\n\r]/g, ""));
        const buffer = new Uint8Array(str.length);
        for (let i = 0;i < str.length; ++i)
          buffer[i] = str.charCodeAt(i);
        return buffer;
      } else {
        onError("This environment does not support reading binary tags; either Buffer or atob is required");
        return src;
      }
    },
    stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
      if (!value)
        return "";
      const buf = value;
      let str;
      if (typeof node_buffer.Buffer === "function") {
        str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
      } else if (typeof btoa === "function") {
        let s = "";
        for (let i = 0;i < buf.length; ++i)
          s += String.fromCharCode(buf[i]);
        str = btoa(s);
      } else {
        throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
      }
      type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
        const n = Math.ceil(str.length / lineWidth);
        const lines = new Array(n);
        for (let i = 0, o = 0;i < n; ++i, o += lineWidth) {
          lines[i] = str.substr(o, lineWidth);
        }
        str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? `
` : " ");
      }
      return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
    }
  };
  exports.binary = binary;
});
var require_pairs2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var Pair = require_Pair2();
  var Scalar = require_Scalar2();
  var YAMLSeq = require_YAMLSeq2();
  function resolvePairs(seq, onError) {
    if (identity.isSeq(seq)) {
      for (let i = 0;i < seq.items.length; ++i) {
        let item = seq.items[i];
        if (identity.isPair(item))
          continue;
        else if (identity.isMap(item)) {
          if (item.items.length > 1)
            onError("Each pair must have its own sequence indicator");
          const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
          if (item.commentBefore)
            pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
          if (item.comment) {
            const cn = pair.value ?? pair.key;
            cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
          }
          item = pair;
        }
        seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
      }
    } else
      onError("Expected a sequence for this tag");
    return seq;
  }
  function createPairs(schema, iterable, ctx) {
    const { replacer } = ctx;
    const pairs2 = new YAMLSeq.YAMLSeq(schema);
    pairs2.tag = "tag:yaml.org,2002:pairs";
    let i = 0;
    if (iterable && Symbol.iterator in Object(iterable))
      for (let it of iterable) {
        if (typeof replacer === "function")
          it = replacer.call(iterable, String(i++), it);
        let key, value;
        if (Array.isArray(it)) {
          if (it.length === 2) {
            key = it[0];
            value = it[1];
          } else
            throw new TypeError(`Expected [key, value] tuple: ${it}`);
        } else if (it && it instanceof Object) {
          const keys = Object.keys(it);
          if (keys.length === 1) {
            key = keys[0];
            value = it[key];
          } else {
            throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
          }
        } else {
          key = it;
        }
        pairs2.items.push(Pair.createPair(key, value, ctx));
      }
    return pairs2;
  }
  var pairs = {
    collection: "seq",
    default: false,
    tag: "tag:yaml.org,2002:pairs",
    resolve: resolvePairs,
    createNode: createPairs
  };
  exports.createPairs = createPairs;
  exports.pairs = pairs;
  exports.resolvePairs = resolvePairs;
});
var require_omap2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var toJS = require_toJS2();
  var YAMLMap = require_YAMLMap2();
  var YAMLSeq = require_YAMLSeq2();
  var pairs = require_pairs2();

  class YAMLOMap extends YAMLSeq.YAMLSeq {
    constructor() {
      super();
      this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
      this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
      this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
      this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
      this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
      this.tag = YAMLOMap.tag;
    }
    toJSON(_, ctx) {
      if (!ctx)
        return super.toJSON(_);
      const map = new Map;
      if (ctx?.onCreate)
        ctx.onCreate(map);
      for (const pair of this.items) {
        let key, value;
        if (identity.isPair(pair)) {
          key = toJS.toJS(pair.key, "", ctx);
          value = toJS.toJS(pair.value, key, ctx);
        } else {
          key = toJS.toJS(pair, "", ctx);
        }
        if (map.has(key))
          throw new Error("Ordered maps must not include duplicate keys");
        map.set(key, value);
      }
      return map;
    }
    static from(schema, iterable, ctx) {
      const pairs$1 = pairs.createPairs(schema, iterable, ctx);
      const omap2 = new this;
      omap2.items = pairs$1.items;
      return omap2;
    }
  }
  YAMLOMap.tag = "tag:yaml.org,2002:omap";
  var omap = {
    collection: "seq",
    identify: (value) => value instanceof Map,
    nodeClass: YAMLOMap,
    default: false,
    tag: "tag:yaml.org,2002:omap",
    resolve(seq, onError) {
      const pairs$1 = pairs.resolvePairs(seq, onError);
      const seenKeys = [];
      for (const { key } of pairs$1.items) {
        if (identity.isScalar(key)) {
          if (seenKeys.includes(key.value)) {
            onError(`Ordered maps must not include duplicate keys: ${key.value}`);
          } else {
            seenKeys.push(key.value);
          }
        }
      }
      return Object.assign(new YAMLOMap, pairs$1);
    },
    createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
  };
  exports.YAMLOMap = YAMLOMap;
  exports.omap = omap;
});
var require_bool22 = __commonJS2((exports) => {
  var Scalar = require_Scalar2();
  function boolStringify({ value, source }, ctx) {
    const boolObj = value ? trueTag : falseTag;
    if (source && boolObj.test.test(source))
      return source;
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
  var trueTag = {
    identify: (value) => value === true,
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
    resolve: () => new Scalar.Scalar(true),
    stringify: boolStringify
  };
  var falseTag = {
    identify: (value) => value === false,
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
    resolve: () => new Scalar.Scalar(false),
    stringify: boolStringify
  };
  exports.falseTag = falseTag;
  exports.trueTag = trueTag;
});
var require_float22 = __commonJS2((exports) => {
  var Scalar = require_Scalar2();
  var stringifyNumber = require_stringifyNumber2();
  var floatNaN = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber
  };
  var floatExp = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "EXP",
    test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
    resolve: (str) => parseFloat(str.replace(/_/g, "")),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    }
  };
  var float = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
      const dot = str.indexOf(".");
      if (dot !== -1) {
        const f = str.substring(dot + 1).replace(/_/g, "");
        if (f[f.length - 1] === "0")
          node.minFractionDigits = f.length;
      }
      return node;
    },
    stringify: stringifyNumber.stringifyNumber
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});
var require_int22 = __commonJS2((exports) => {
  var stringifyNumber = require_stringifyNumber2();
  var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
  function intResolve(str, offset, radix, { intAsBigInt }) {
    const sign = str[0];
    if (sign === "-" || sign === "+")
      offset += 1;
    str = str.substring(offset).replace(/_/g, "");
    if (intAsBigInt) {
      switch (radix) {
        case 2:
          str = `0b${str}`;
          break;
        case 8:
          str = `0o${str}`;
          break;
        case 16:
          str = `0x${str}`;
          break;
      }
      const n2 = BigInt(str);
      return sign === "-" ? BigInt(-1) * n2 : n2;
    }
    const n = parseInt(str, radix);
    return sign === "-" ? -1 * n : n;
  }
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value)) {
      const str = value.toString(radix);
      return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
    }
    return stringifyNumber.stringifyNumber(node);
  }
  var intBin = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "BIN",
    test: /^[-+]?0b[0-1_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
    stringify: (node) => intStringify(node, 2, "0b")
  };
  var intOct = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "OCT",
    test: /^[-+]?0[0-7_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
    stringify: (node) => intStringify(node, 8, "0")
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^[-+]?[0-9][0-9_]*$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber
  };
  var intHex = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "HEX",
    test: /^[-+]?0x[0-9a-fA-F_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: (node) => intStringify(node, 16, "0x")
  };
  exports.int = int;
  exports.intBin = intBin;
  exports.intHex = intHex;
  exports.intOct = intOct;
});
var require_set2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var Pair = require_Pair2();
  var YAMLMap = require_YAMLMap2();

  class YAMLSet extends YAMLMap.YAMLMap {
    constructor(schema) {
      super(schema);
      this.tag = YAMLSet.tag;
    }
    add(key) {
      let pair;
      if (identity.isPair(key))
        pair = key;
      else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
        pair = new Pair.Pair(key.key, null);
      else
        pair = new Pair.Pair(key, null);
      const prev = YAMLMap.findPair(this.items, pair.key);
      if (!prev)
        this.items.push(pair);
    }
    get(key, keepPair) {
      const pair = YAMLMap.findPair(this.items, key);
      return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
    }
    set(key, value) {
      if (typeof value !== "boolean")
        throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
      const prev = YAMLMap.findPair(this.items, key);
      if (prev && !value) {
        this.items.splice(this.items.indexOf(prev), 1);
      } else if (!prev && value) {
        this.items.push(new Pair.Pair(key));
      }
    }
    toJSON(_, ctx) {
      return super.toJSON(_, ctx, Set);
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      if (this.hasAllNullValues(true))
        return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
      else
        throw new Error("Set items must all have null values");
    }
    static from(schema, iterable, ctx) {
      const { replacer } = ctx;
      const set2 = new this(schema);
      if (iterable && Symbol.iterator in Object(iterable))
        for (let value of iterable) {
          if (typeof replacer === "function")
            value = replacer.call(iterable, value, value);
          set2.items.push(Pair.createPair(value, null, ctx));
        }
      return set2;
    }
  }
  YAMLSet.tag = "tag:yaml.org,2002:set";
  var set = {
    collection: "map",
    identify: (value) => value instanceof Set,
    nodeClass: YAMLSet,
    default: false,
    tag: "tag:yaml.org,2002:set",
    createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
    resolve(map, onError) {
      if (identity.isMap(map)) {
        if (map.hasAllNullValues(true))
          return Object.assign(new YAMLSet, map);
        else
          onError("Set items must all have null values");
      } else
        onError("Expected a mapping for this tag");
      return map;
    }
  };
  exports.YAMLSet = YAMLSet;
  exports.set = set;
});
var require_timestamp2 = __commonJS2((exports) => {
  var stringifyNumber = require_stringifyNumber2();
  function parseSexagesimal(str, asBigInt) {
    const sign = str[0];
    const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
    const num = (n) => asBigInt ? BigInt(n) : Number(n);
    const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
    return sign === "-" ? num(-1) * res : res;
  }
  function stringifySexagesimal(node) {
    let { value } = node;
    let num = (n) => n;
    if (typeof value === "bigint")
      num = (n) => BigInt(n);
    else if (isNaN(value) || !isFinite(value))
      return stringifyNumber.stringifyNumber(node);
    let sign = "";
    if (value < 0) {
      sign = "-";
      value *= num(-1);
    }
    const _60 = num(60);
    const parts = [value % _60];
    if (value < 60) {
      parts.unshift(0);
    } else {
      value = (value - parts[0]) / _60;
      parts.unshift(value % _60);
      if (value >= 60) {
        value = (value - parts[0]) / _60;
        parts.unshift(value);
      }
    }
    return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
  }
  var intTime = {
    identify: (value) => typeof value === "bigint" || Number.isInteger(value),
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "TIME",
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
    resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
    stringify: stringifySexagesimal
  };
  var floatTime = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "TIME",
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
    resolve: (str) => parseSexagesimal(str, false),
    stringify: stringifySexagesimal
  };
  var timestamp = {
    identify: (value) => value instanceof Date,
    default: true,
    tag: "tag:yaml.org,2002:timestamp",
    test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})" + "(?:" + "(?:t|T|[ \\t]+)" + "([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)" + "(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?" + ")?$"),
    resolve(str) {
      const match = str.match(timestamp.test);
      if (!match)
        throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
      const [, year, month, day, hour, minute, second] = match.map(Number);
      const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
      let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
      const tz = match[8];
      if (tz && tz !== "Z") {
        let d = parseSexagesimal(tz, false);
        if (Math.abs(d) < 30)
          d *= 60;
        date -= 60000 * d;
      }
      return new Date(date);
    },
    stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
  };
  exports.floatTime = floatTime;
  exports.intTime = intTime;
  exports.timestamp = timestamp;
});
var require_schema32 = __commonJS2((exports) => {
  var map = require_map2();
  var _null = require_null2();
  var seq = require_seq2();
  var string = require_string2();
  var binary = require_binary2();
  var bool = require_bool22();
  var float = require_float22();
  var int = require_int22();
  var merge = require_merge2();
  var omap = require_omap2();
  var pairs = require_pairs2();
  var set = require_set2();
  var timestamp = require_timestamp2();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.trueTag,
    bool.falseTag,
    int.intBin,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float,
    binary.binary,
    merge.merge,
    omap.omap,
    pairs.pairs,
    set.set,
    timestamp.intTime,
    timestamp.floatTime,
    timestamp.timestamp
  ];
  exports.schema = schema;
});
var require_tags2 = __commonJS2((exports) => {
  var map = require_map2();
  var _null = require_null2();
  var seq = require_seq2();
  var string = require_string2();
  var bool = require_bool3();
  var float = require_float3();
  var int = require_int3();
  var schema = require_schema4();
  var schema$1 = require_schema22();
  var binary = require_binary2();
  var merge = require_merge2();
  var omap = require_omap2();
  var pairs = require_pairs2();
  var schema$2 = require_schema32();
  var set = require_set2();
  var timestamp = require_timestamp2();
  var schemas = new Map([
    ["core", schema.schema],
    ["failsafe", [map.map, seq.seq, string.string]],
    ["json", schema$1.schema],
    ["yaml11", schema$2.schema],
    ["yaml-1.1", schema$2.schema]
  ]);
  var tagsByName = {
    binary: binary.binary,
    bool: bool.boolTag,
    float: float.float,
    floatExp: float.floatExp,
    floatNaN: float.floatNaN,
    floatTime: timestamp.floatTime,
    int: int.int,
    intHex: int.intHex,
    intOct: int.intOct,
    intTime: timestamp.intTime,
    map: map.map,
    merge: merge.merge,
    null: _null.nullTag,
    omap: omap.omap,
    pairs: pairs.pairs,
    seq: seq.seq,
    set: set.set,
    timestamp: timestamp.timestamp
  };
  var coreKnownTags = {
    "tag:yaml.org,2002:binary": binary.binary,
    "tag:yaml.org,2002:merge": merge.merge,
    "tag:yaml.org,2002:omap": omap.omap,
    "tag:yaml.org,2002:pairs": pairs.pairs,
    "tag:yaml.org,2002:set": set.set,
    "tag:yaml.org,2002:timestamp": timestamp.timestamp
  };
  function getTags(customTags, schemaName, addMergeTag) {
    const schemaTags = schemas.get(schemaName);
    if (schemaTags && !customTags) {
      return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
    }
    let tags = schemaTags;
    if (!tags) {
      if (Array.isArray(customTags))
        tags = [];
      else {
        const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
        throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
      }
    }
    if (Array.isArray(customTags)) {
      for (const tag of customTags)
        tags = tags.concat(tag);
    } else if (typeof customTags === "function") {
      tags = customTags(tags.slice());
    }
    if (addMergeTag)
      tags = tags.concat(merge.merge);
    return tags.reduce((tags2, tag) => {
      const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
      if (!tagObj) {
        const tagName = JSON.stringify(tag);
        const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
        throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
      }
      if (!tags2.includes(tagObj))
        tags2.push(tagObj);
      return tags2;
    }, []);
  }
  exports.coreKnownTags = coreKnownTags;
  exports.getTags = getTags;
});
var require_Schema2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var map = require_map2();
  var seq = require_seq2();
  var string = require_string2();
  var tags = require_tags2();
  var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

  class Schema {
    constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
      this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
      this.name = typeof schema === "string" && schema || "core";
      this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
      this.tags = tags.getTags(customTags, this.name, merge);
      this.toStringOptions = toStringDefaults ?? null;
      Object.defineProperty(this, identity.MAP, { value: map.map });
      Object.defineProperty(this, identity.SCALAR, { value: string.string });
      Object.defineProperty(this, identity.SEQ, { value: seq.seq });
      this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
    }
    clone() {
      const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
      copy.tags = this.tags.slice();
      return copy;
    }
  }
  exports.Schema = Schema;
});
var require_stringifyDocument2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var stringify = require_stringify2();
  var stringifyComment = require_stringifyComment2();
  function stringifyDocument(doc, options) {
    const lines = [];
    let hasDirectives = options.directives === true;
    if (options.directives !== false && doc.directives) {
      const dir = doc.directives.toString(doc);
      if (dir) {
        lines.push(dir);
        hasDirectives = true;
      } else if (doc.directives.docStart)
        hasDirectives = true;
    }
    if (hasDirectives)
      lines.push("---");
    const ctx = stringify.createStringifyContext(doc, options);
    const { commentString } = ctx.options;
    if (doc.commentBefore) {
      if (lines.length !== 1)
        lines.unshift("");
      const cs = commentString(doc.commentBefore);
      lines.unshift(stringifyComment.indentComment(cs, ""));
    }
    let chompKeep = false;
    let contentComment = null;
    if (doc.contents) {
      if (identity.isNode(doc.contents)) {
        if (doc.contents.spaceBefore && hasDirectives)
          lines.push("");
        if (doc.contents.commentBefore) {
          const cs = commentString(doc.contents.commentBefore);
          lines.push(stringifyComment.indentComment(cs, ""));
        }
        ctx.forceBlockIndent = !!doc.comment;
        contentComment = doc.contents.comment;
      }
      const onChompKeep = contentComment ? undefined : () => chompKeep = true;
      let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
      if (contentComment)
        body += stringifyComment.lineComment(body, "", commentString(contentComment));
      if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
        lines[lines.length - 1] = `--- ${body}`;
      } else
        lines.push(body);
    } else {
      lines.push(stringify.stringify(doc.contents, ctx));
    }
    if (doc.directives?.docEnd) {
      if (doc.comment) {
        const cs = commentString(doc.comment);
        if (cs.includes(`
`)) {
          lines.push("...");
          lines.push(stringifyComment.indentComment(cs, ""));
        } else {
          lines.push(`... ${cs}`);
        }
      } else {
        lines.push("...");
      }
    } else {
      let dc = doc.comment;
      if (dc && chompKeep)
        dc = dc.replace(/^\n+/, "");
      if (dc) {
        if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
          lines.push("");
        lines.push(stringifyComment.indentComment(commentString(dc), ""));
      }
    }
    return lines.join(`
`) + `
`;
  }
  exports.stringifyDocument = stringifyDocument;
});
var require_Document2 = __commonJS2((exports) => {
  var Alias = require_Alias2();
  var Collection = require_Collection2();
  var identity = require_identity2();
  var Pair = require_Pair2();
  var toJS = require_toJS2();
  var Schema = require_Schema2();
  var stringifyDocument = require_stringifyDocument2();
  var anchors = require_anchors2();
  var applyReviver = require_applyReviver2();
  var createNode = require_createNode2();
  var directives = require_directives2();

  class Document {
    constructor(value, replacer, options) {
      this.commentBefore = null;
      this.comment = null;
      this.errors = [];
      this.warnings = [];
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const opt = Object.assign({
        intAsBigInt: false,
        keepSourceTokens: false,
        logLevel: "warn",
        prettyErrors: true,
        strict: true,
        stringKeys: false,
        uniqueKeys: true,
        version: "1.2"
      }, options);
      this.options = opt;
      let { version } = opt;
      if (options?._directives) {
        this.directives = options._directives.atDocument();
        if (this.directives.yaml.explicit)
          version = this.directives.yaml.version;
      } else
        this.directives = new directives.Directives({ version });
      this.setSchema(version, options);
      this.contents = value === undefined ? null : this.createNode(value, _replacer, options);
    }
    clone() {
      const copy = Object.create(Document.prototype, {
        [identity.NODE_TYPE]: { value: identity.DOC }
      });
      copy.commentBefore = this.commentBefore;
      copy.comment = this.comment;
      copy.errors = this.errors.slice();
      copy.warnings = this.warnings.slice();
      copy.options = Object.assign({}, this.options);
      if (this.directives)
        copy.directives = this.directives.clone();
      copy.schema = this.schema.clone();
      copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    add(value) {
      if (assertCollection(this.contents))
        this.contents.add(value);
    }
    addIn(path, value) {
      if (assertCollection(this.contents))
        this.contents.addIn(path, value);
    }
    createAlias(node, name) {
      if (!node.anchor) {
        const prev = anchors.anchorNames(this);
        node.anchor = !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
      }
      return new Alias.Alias(node.anchor);
    }
    createNode(value, replacer, options) {
      let _replacer = undefined;
      if (typeof replacer === "function") {
        value = replacer.call({ "": value }, "", value);
        _replacer = replacer;
      } else if (Array.isArray(replacer)) {
        const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
        const asStr = replacer.filter(keyToStr).map(String);
        if (asStr.length > 0)
          replacer = replacer.concat(asStr);
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
      const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(this, anchorPrefix || "a");
      const ctx = {
        aliasDuplicateObjects: aliasDuplicateObjects ?? true,
        keepUndefined: keepUndefined ?? false,
        onAnchor,
        onTagObj,
        replacer: _replacer,
        schema: this.schema,
        sourceObjects
      };
      const node = createNode.createNode(value, tag, ctx);
      if (flow && identity.isCollection(node))
        node.flow = true;
      setAnchors();
      return node;
    }
    createPair(key, value, options = {}) {
      const k = this.createNode(key, null, options);
      const v = this.createNode(value, null, options);
      return new Pair.Pair(k, v);
    }
    delete(key) {
      return assertCollection(this.contents) ? this.contents.delete(key) : false;
    }
    deleteIn(path) {
      if (Collection.isEmptyPath(path)) {
        if (this.contents == null)
          return false;
        this.contents = null;
        return true;
      }
      return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
    }
    get(key, keepScalar) {
      return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : undefined;
    }
    getIn(path, keepScalar) {
      if (Collection.isEmptyPath(path))
        return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
      return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : undefined;
    }
    has(key) {
      return identity.isCollection(this.contents) ? this.contents.has(key) : false;
    }
    hasIn(path) {
      if (Collection.isEmptyPath(path))
        return this.contents !== undefined;
      return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
    }
    set(key, value) {
      if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, [key], value);
      } else if (assertCollection(this.contents)) {
        this.contents.set(key, value);
      }
    }
    setIn(path, value) {
      if (Collection.isEmptyPath(path)) {
        this.contents = value;
      } else if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
      } else if (assertCollection(this.contents)) {
        this.contents.setIn(path, value);
      }
    }
    setSchema(version, options = {}) {
      if (typeof version === "number")
        version = String(version);
      let opt;
      switch (version) {
        case "1.1":
          if (this.directives)
            this.directives.yaml.version = "1.1";
          else
            this.directives = new directives.Directives({ version: "1.1" });
          opt = { resolveKnownTags: false, schema: "yaml-1.1" };
          break;
        case "1.2":
        case "next":
          if (this.directives)
            this.directives.yaml.version = version;
          else
            this.directives = new directives.Directives({ version });
          opt = { resolveKnownTags: true, schema: "core" };
          break;
        case null:
          if (this.directives)
            delete this.directives;
          opt = null;
          break;
        default: {
          const sv = JSON.stringify(version);
          throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
        }
      }
      if (options.schema instanceof Object)
        this.schema = options.schema;
      else if (opt)
        this.schema = new Schema.Schema(Object.assign(opt, options));
      else
        throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
    }
    toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      const ctx = {
        anchors: new Map,
        doc: this,
        keep: !json,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
      };
      const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
      if (typeof onAnchor === "function")
        for (const { count, res: res2 } of ctx.anchors.values())
          onAnchor(res2, count);
      return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
    }
    toJSON(jsonArg, onAnchor) {
      return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
    }
    toString(options = {}) {
      if (this.errors.length > 0)
        throw new Error("Document with errors cannot be stringified");
      if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
        const s = JSON.stringify(options.indent);
        throw new Error(`"indent" option must be a positive integer, not ${s}`);
      }
      return stringifyDocument.stringifyDocument(this, options);
    }
  }
  function assertCollection(contents) {
    if (identity.isCollection(contents))
      return true;
    throw new Error("Expected a YAML collection as document contents");
  }
  exports.Document = Document;
});
var require_errors2 = __commonJS2((exports) => {

  class YAMLError extends Error {
    constructor(name, pos, code, message) {
      super();
      this.name = name;
      this.code = code;
      this.message = message;
      this.pos = pos;
    }
  }

  class YAMLParseError extends YAMLError {
    constructor(pos, code, message) {
      super("YAMLParseError", pos, code, message);
    }
  }

  class YAMLWarning extends YAMLError {
    constructor(pos, code, message) {
      super("YAMLWarning", pos, code, message);
    }
  }
  var prettifyError = (src, lc) => (error) => {
    if (error.pos[0] === -1)
      return;
    error.linePos = error.pos.map((pos) => lc.linePos(pos));
    const { line, col } = error.linePos[0];
    error.message += ` at line ${line}, column ${col}`;
    let ci = col - 1;
    let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
    if (ci >= 60 && lineStr.length > 80) {
      const trimStart = Math.min(ci - 39, lineStr.length - 79);
      lineStr = "…" + lineStr.substring(trimStart);
      ci -= trimStart - 1;
    }
    if (lineStr.length > 80)
      lineStr = lineStr.substring(0, 79) + "…";
    if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
      let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
      if (prev.length > 80)
        prev = prev.substring(0, 79) + `…
`;
      lineStr = prev + lineStr;
    }
    if (/[^ ]/.test(lineStr)) {
      let count = 1;
      const end = error.linePos[1];
      if (end?.line === line && end.col > col) {
        count = Math.max(1, Math.min(end.col - col, 80 - ci));
      }
      const pointer = " ".repeat(ci) + "^".repeat(count);
      error.message += `:

${lineStr}
${pointer}
`;
    }
  };
  exports.YAMLError = YAMLError;
  exports.YAMLParseError = YAMLParseError;
  exports.YAMLWarning = YAMLWarning;
  exports.prettifyError = prettifyError;
});
var require_resolve_props2 = __commonJS2((exports) => {
  function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
    let spaceBefore = false;
    let atNewline = startOnNewline;
    let hasSpace = startOnNewline;
    let comment = "";
    let commentSep = "";
    let hasNewline = false;
    let reqSpace = false;
    let tab = null;
    let anchor = null;
    let tag = null;
    let newlineAfterProp = null;
    let comma = null;
    let found = null;
    let start = null;
    for (const token of tokens) {
      if (reqSpace) {
        if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
          onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
        reqSpace = false;
      }
      if (tab) {
        if (atNewline && token.type !== "comment" && token.type !== "newline") {
          onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
        }
        tab = null;
      }
      switch (token.type) {
        case "space":
          if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("\t")) {
            tab = token;
          }
          hasSpace = true;
          break;
        case "comment": {
          if (!hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = token.source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += commentSep + cb;
          commentSep = "";
          atNewline = false;
          break;
        }
        case "newline":
          if (atNewline) {
            if (comment)
              comment += token.source;
            else if (!found || indicator !== "seq-item-ind")
              spaceBefore = true;
          } else
            commentSep += token.source;
          atNewline = true;
          hasNewline = true;
          if (anchor || tag)
            newlineAfterProp = token;
          hasSpace = true;
          break;
        case "anchor":
          if (anchor)
            onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
          if (token.source.endsWith(":"))
            onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
          anchor = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        case "tag": {
          if (tag)
            onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
          tag = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        }
        case indicator:
          if (anchor || tag)
            onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
          if (found)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
          found = token;
          atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
          hasSpace = false;
          break;
        case "comma":
          if (flow) {
            if (comma)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
            comma = token;
            atNewline = false;
            hasSpace = false;
            break;
          }
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
          atNewline = false;
          hasSpace = false;
      }
    }
    const last = tokens[tokens.length - 1];
    const end = last ? last.offset + last.source.length : offset;
    if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
      onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
    }
    if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
      onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
    return {
      comma,
      found,
      spaceBefore,
      comment,
      hasNewline,
      anchor,
      tag,
      newlineAfterProp,
      end,
      start: start ?? end
    };
  }
  exports.resolveProps = resolveProps;
});
var require_util_contains_newline2 = __commonJS2((exports) => {
  function containsNewline(key) {
    if (!key)
      return null;
    switch (key.type) {
      case "alias":
      case "scalar":
      case "double-quoted-scalar":
      case "single-quoted-scalar":
        if (key.source.includes(`
`))
          return true;
        if (key.end) {
          for (const st of key.end)
            if (st.type === "newline")
              return true;
        }
        return false;
      case "flow-collection":
        for (const it of key.items) {
          for (const st of it.start)
            if (st.type === "newline")
              return true;
          if (it.sep) {
            for (const st of it.sep)
              if (st.type === "newline")
                return true;
          }
          if (containsNewline(it.key) || containsNewline(it.value))
            return true;
        }
        return false;
      default:
        return true;
    }
  }
  exports.containsNewline = containsNewline;
});
var require_util_flow_indent_check2 = __commonJS2((exports) => {
  var utilContainsNewline = require_util_contains_newline2();
  function flowIndentCheck(indent, fc, onError) {
    if (fc?.type === "flow-collection") {
      const end = fc.end[0];
      if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
        const msg = "Flow end indicator should be more indented than parent";
        onError(end, "BAD_INDENT", msg, true);
      }
    }
  }
  exports.flowIndentCheck = flowIndentCheck;
});
var require_util_map_includes2 = __commonJS2((exports) => {
  var identity = require_identity2();
  function mapIncludes(ctx, items, search) {
    const { uniqueKeys } = ctx.options;
    if (uniqueKeys === false)
      return false;
    const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
    return items.some((pair) => isEqual(pair.key, search));
  }
  exports.mapIncludes = mapIncludes;
});
var require_resolve_block_map2 = __commonJS2((exports) => {
  var Pair = require_Pair2();
  var YAMLMap = require_YAMLMap2();
  var resolveProps = require_resolve_props2();
  var utilContainsNewline = require_util_contains_newline2();
  var utilFlowIndentCheck = require_util_flow_indent_check2();
  var utilMapIncludes = require_util_map_includes2();
  var startColMsg = "All mapping items must start at the same column";
  function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
    const map = new NodeClass(ctx.schema);
    if (ctx.atRoot)
      ctx.atRoot = false;
    let offset = bm.offset;
    let commentEnd = null;
    for (const collItem of bm.items) {
      const { start, key, sep, value } = collItem;
      const keyProps = resolveProps.resolveProps(start, {
        indicator: "explicit-key-ind",
        next: key ?? sep?.[0],
        offset,
        onError,
        parentIndent: bm.indent,
        startOnNewline: true
      });
      const implicitKey = !keyProps.found;
      if (implicitKey) {
        if (key) {
          if (key.type === "block-seq")
            onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
          else if ("indent" in key && key.indent !== bm.indent)
            onError(offset, "BAD_INDENT", startColMsg);
        }
        if (!keyProps.anchor && !keyProps.tag && !sep) {
          commentEnd = keyProps.end;
          if (keyProps.comment) {
            if (map.comment)
              map.comment += `
` + keyProps.comment;
            else
              map.comment = keyProps.comment;
          }
          continue;
        }
        if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
          onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
        }
      } else if (keyProps.found?.indent !== bm.indent) {
        onError(offset, "BAD_INDENT", startColMsg);
      }
      ctx.atKey = true;
      const keyStart = keyProps.end;
      const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
      ctx.atKey = false;
      if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
        onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
      const valueProps = resolveProps.resolveProps(sep ?? [], {
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: bm.indent,
        startOnNewline: !key || key.type === "block-scalar"
      });
      offset = valueProps.end;
      if (valueProps.found) {
        if (implicitKey) {
          if (value?.type === "block-map" && !valueProps.hasNewline)
            onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
          if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
            onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
        }
        const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
        offset = valueNode.range[2];
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        map.items.push(pair);
      } else {
        if (implicitKey)
          onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
        if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment += `
` + valueProps.comment;
          else
            keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        map.items.push(pair);
      }
    }
    if (commentEnd && commentEnd < offset)
      onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
    map.range = [bm.offset, offset, commentEnd ?? offset];
    return map;
  }
  exports.resolveBlockMap = resolveBlockMap;
});
var require_resolve_block_seq2 = __commonJS2((exports) => {
  var YAMLSeq = require_YAMLSeq2();
  var resolveProps = require_resolve_props2();
  var utilFlowIndentCheck = require_util_flow_indent_check2();
  function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
    const seq = new NodeClass(ctx.schema);
    if (ctx.atRoot)
      ctx.atRoot = false;
    if (ctx.atKey)
      ctx.atKey = false;
    let offset = bs.offset;
    let commentEnd = null;
    for (const { start, value } of bs.items) {
      const props = resolveProps.resolveProps(start, {
        indicator: "seq-item-ind",
        next: value,
        offset,
        onError,
        parentIndent: bs.indent,
        startOnNewline: true
      });
      if (!props.found) {
        if (props.anchor || props.tag || value) {
          if (value?.type === "block-seq")
            onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
          else
            onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
        } else {
          commentEnd = props.end;
          if (props.comment)
            seq.comment = props.comment;
          continue;
        }
      }
      const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
      offset = node.range[2];
      seq.items.push(node);
    }
    seq.range = [bs.offset, offset, commentEnd ?? offset];
    return seq;
  }
  exports.resolveBlockSeq = resolveBlockSeq;
});
var require_resolve_end2 = __commonJS2((exports) => {
  function resolveEnd(end, offset, reqSpace, onError) {
    let comment = "";
    if (end) {
      let hasSpace = false;
      let sep = "";
      for (const token of end) {
        const { source, type } = token;
        switch (type) {
          case "space":
            hasSpace = true;
            break;
          case "comment": {
            if (reqSpace && !hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += sep + cb;
            sep = "";
            break;
          }
          case "newline":
            if (comment)
              sep += source;
            hasSpace = true;
            break;
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
        }
        offset += source.length;
      }
    }
    return { comment, offset };
  }
  exports.resolveEnd = resolveEnd;
});
var require_resolve_flow_collection2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var Pair = require_Pair2();
  var YAMLMap = require_YAMLMap2();
  var YAMLSeq = require_YAMLSeq2();
  var resolveEnd = require_resolve_end2();
  var resolveProps = require_resolve_props2();
  var utilContainsNewline = require_util_contains_newline2();
  var utilMapIncludes = require_util_map_includes2();
  var blockMsg = "Block collections are not allowed within flow collections";
  var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
  function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
    const isMap = fc.start.source === "{";
    const fcName = isMap ? "flow map" : "flow sequence";
    const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
    const coll = new NodeClass(ctx.schema);
    coll.flow = true;
    const atRoot = ctx.atRoot;
    if (atRoot)
      ctx.atRoot = false;
    if (ctx.atKey)
      ctx.atKey = false;
    let offset = fc.offset + fc.start.source.length;
    for (let i = 0;i < fc.items.length; ++i) {
      const collItem = fc.items[i];
      const { start, key, sep, value } = collItem;
      const props = resolveProps.resolveProps(start, {
        flow: fcName,
        indicator: "explicit-key-ind",
        next: key ?? sep?.[0],
        offset,
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (!props.found) {
        if (!props.anchor && !props.tag && !sep && !value) {
          if (i === 0 && props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
          else if (i < fc.items.length - 1)
            onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
          if (props.comment) {
            if (coll.comment)
              coll.comment += `
` + props.comment;
            else
              coll.comment = props.comment;
          }
          offset = props.end;
          continue;
        }
        if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
          onError(key, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
      }
      if (i === 0) {
        if (props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
      } else {
        if (!props.comma)
          onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
        if (props.comment) {
          let prevItemComment = "";
          loop:
            for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
          if (prevItemComment) {
            let prev = coll.items[coll.items.length - 1];
            if (identity.isPair(prev))
              prev = prev.value ?? prev.key;
            if (prev.comment)
              prev.comment += `
` + prevItemComment;
            else
              prev.comment = prevItemComment;
            props.comment = props.comment.substring(prevItemComment.length + 1);
          }
        }
      }
      if (!isMap && !sep && !props.found) {
        const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
        coll.items.push(valueNode);
        offset = valueNode.range[2];
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else {
        ctx.atKey = true;
        const keyStart = props.end;
        const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
        if (isBlock(key))
          onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
        ctx.atKey = false;
        const valueProps = resolveProps.resolveProps(sep ?? [], {
          flow: fcName,
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (valueProps.found) {
          if (!isMap && !props.found && ctx.options.strict) {
            if (sep)
              for (const st of sep) {
                if (st === valueProps.found)
                  break;
                if (st.type === "newline") {
                  onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                  break;
                }
              }
            if (props.start < valueProps.found.offset - 1024)
              onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
          }
        } else if (value) {
          if ("source" in value && value.source?.[0] === ":")
            onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
          else
            onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
        }
        const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
        if (valueNode) {
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment += `
` + valueProps.comment;
          else
            keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        if (isMap) {
          const map = coll;
          if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
            onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
          map.items.push(pair);
        } else {
          const map = new YAMLMap.YAMLMap(ctx.schema);
          map.flow = true;
          map.items.push(pair);
          const endRange = (valueNode ?? keyNode).range;
          map.range = [keyNode.range[0], endRange[1], endRange[2]];
          coll.items.push(map);
        }
        offset = valueNode ? valueNode.range[2] : valueProps.end;
      }
    }
    const expectedEnd = isMap ? "}" : "]";
    const [ce, ...ee] = fc.end;
    let cePos = offset;
    if (ce?.source === expectedEnd)
      cePos = ce.offset + ce.source.length;
    else {
      const name = fcName[0].toUpperCase() + fcName.substring(1);
      const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
      onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
      if (ce && ce.source.length !== 1)
        ee.unshift(ce);
    }
    if (ee.length > 0) {
      const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
      if (end.comment) {
        if (coll.comment)
          coll.comment += `
` + end.comment;
        else
          coll.comment = end.comment;
      }
      coll.range = [fc.offset, cePos, end.offset];
    } else {
      coll.range = [fc.offset, cePos, cePos];
    }
    return coll;
  }
  exports.resolveFlowCollection = resolveFlowCollection;
});
var require_compose_collection2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var Scalar = require_Scalar2();
  var YAMLMap = require_YAMLMap2();
  var YAMLSeq = require_YAMLSeq2();
  var resolveBlockMap = require_resolve_block_map2();
  var resolveBlockSeq = require_resolve_block_seq2();
  var resolveFlowCollection = require_resolve_flow_collection2();
  function resolveCollection(CN, ctx, token, onError, tagName, tag) {
    const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
    const Coll = coll.constructor;
    if (tagName === "!" || tagName === Coll.tagName) {
      coll.tag = Coll.tagName;
      return coll;
    }
    if (tagName)
      coll.tag = tagName;
    return coll;
  }
  function composeCollection(CN, ctx, token, props, onError) {
    const tagToken = props.tag;
    const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
    if (token.type === "block-seq") {
      const { anchor, newlineAfterProp: nl } = props;
      const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
      if (lastProp && (!nl || nl.offset < lastProp.offset)) {
        const message = "Missing newline after block sequence props";
        onError(lastProp, "MISSING_CHAR", message);
      }
    }
    const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
    if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
      return resolveCollection(CN, ctx, token, onError, tagName);
    }
    let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
    if (!tag) {
      const kt = ctx.schema.knownTags[tagName];
      if (kt?.collection === expType) {
        ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
        tag = kt;
      } else {
        if (kt) {
          onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
        } else {
          onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
        }
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
    }
    const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
    const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
    const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
    node.range = coll.range;
    node.tag = tagName;
    if (tag?.format)
      node.format = tag.format;
    return node;
  }
  exports.composeCollection = composeCollection;
});
var require_resolve_block_scalar2 = __commonJS2((exports) => {
  var Scalar = require_Scalar2();
  function resolveBlockScalar(ctx, scalar, onError) {
    const start = scalar.offset;
    const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
    if (!header)
      return { value: "", type: null, comment: "", range: [start, start, start] };
    const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
    const lines = scalar.source ? splitLines(scalar.source) : [];
    let chompStart = lines.length;
    for (let i = lines.length - 1;i >= 0; --i) {
      const content = lines[i][1];
      if (content === "" || content === "\r")
        chompStart = i;
      else
        break;
    }
    if (chompStart === 0) {
      const value2 = header.chomp === "+" && lines.length > 0 ? `
`.repeat(Math.max(1, lines.length - 1)) : "";
      let end2 = start + header.length;
      if (scalar.source)
        end2 += scalar.source.length;
      return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
    }
    let trimIndent = scalar.indent + header.indent;
    let offset = scalar.offset + header.length;
    let contentStart = 0;
    for (let i = 0;i < chompStart; ++i) {
      const [indent, content] = lines[i];
      if (content === "" || content === "\r") {
        if (header.indent === 0 && indent.length > trimIndent)
          trimIndent = indent.length;
      } else {
        if (indent.length < trimIndent) {
          const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
          onError(offset + indent.length, "MISSING_CHAR", message);
        }
        if (header.indent === 0)
          trimIndent = indent.length;
        contentStart = i;
        if (trimIndent === 0 && !ctx.atRoot) {
          const message = "Block scalar values in collections must be indented";
          onError(offset, "BAD_INDENT", message);
        }
        break;
      }
      offset += indent.length + content.length + 1;
    }
    for (let i = lines.length - 1;i >= chompStart; --i) {
      if (lines[i][0].length > trimIndent)
        chompStart = i + 1;
    }
    let value = "";
    let sep = "";
    let prevMoreIndented = false;
    for (let i = 0;i < contentStart; ++i)
      value += lines[i][0].slice(trimIndent) + `
`;
    for (let i = contentStart;i < chompStart; ++i) {
      let [indent, content] = lines[i];
      offset += indent.length + content.length + 1;
      const crlf = content[content.length - 1] === "\r";
      if (crlf)
        content = content.slice(0, -1);
      if (content && indent.length < trimIndent) {
        const src = header.indent ? "explicit indentation indicator" : "first line";
        const message = `Block scalar lines must not be less indented than their ${src}`;
        onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
        indent = "";
      }
      if (type === Scalar.Scalar.BLOCK_LITERAL) {
        value += sep + indent.slice(trimIndent) + content;
        sep = `
`;
      } else if (indent.length > trimIndent || content[0] === "\t") {
        if (sep === " ")
          sep = `
`;
        else if (!prevMoreIndented && sep === `
`)
          sep = `

`;
        value += sep + indent.slice(trimIndent) + content;
        sep = `
`;
        prevMoreIndented = true;
      } else if (content === "") {
        if (sep === `
`)
          value += `
`;
        else
          sep = `
`;
      } else {
        value += sep + content;
        sep = " ";
        prevMoreIndented = false;
      }
    }
    switch (header.chomp) {
      case "-":
        break;
      case "+":
        for (let i = chompStart;i < lines.length; ++i)
          value += `
` + lines[i][0].slice(trimIndent);
        if (value[value.length - 1] !== `
`)
          value += `
`;
        break;
      default:
        value += `
`;
    }
    const end = start + header.length + scalar.source.length;
    return { value, type, comment: header.comment, range: [start, end, end] };
  }
  function parseBlockScalarHeader({ offset, props }, strict, onError) {
    if (props[0].type !== "block-scalar-header") {
      onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
      return null;
    }
    const { source } = props[0];
    const mode = source[0];
    let indent = 0;
    let chomp = "";
    let error = -1;
    for (let i = 1;i < source.length; ++i) {
      const ch = source[i];
      if (!chomp && (ch === "-" || ch === "+"))
        chomp = ch;
      else {
        const n = Number(ch);
        if (!indent && n)
          indent = n;
        else if (error === -1)
          error = offset + i;
      }
    }
    if (error !== -1)
      onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
    let hasSpace = false;
    let comment = "";
    let length = source.length;
    for (let i = 1;i < props.length; ++i) {
      const token = props[i];
      switch (token.type) {
        case "space":
          hasSpace = true;
        case "newline":
          length += token.source.length;
          break;
        case "comment":
          if (strict && !hasSpace) {
            const message = "Comments must be separated from other tokens by white space characters";
            onError(token, "MISSING_CHAR", message);
          }
          length += token.source.length;
          comment = token.source.substring(1);
          break;
        case "error":
          onError(token, "UNEXPECTED_TOKEN", token.message);
          length += token.source.length;
          break;
        default: {
          const message = `Unexpected token in block scalar header: ${token.type}`;
          onError(token, "UNEXPECTED_TOKEN", message);
          const ts = token.source;
          if (ts && typeof ts === "string")
            length += ts.length;
        }
      }
    }
    return { mode, indent, chomp, comment, length };
  }
  function splitLines(source) {
    const split = source.split(/\n( *)/);
    const first = split[0];
    const m = first.match(/^( *)/);
    const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
    const lines = [line0];
    for (let i = 1;i < split.length; i += 2)
      lines.push([split[i], split[i + 1]]);
    return lines;
  }
  exports.resolveBlockScalar = resolveBlockScalar;
});
var require_resolve_flow_scalar2 = __commonJS2((exports) => {
  var Scalar = require_Scalar2();
  var resolveEnd = require_resolve_end2();
  function resolveFlowScalar(scalar, strict, onError) {
    const { offset, type, source, end } = scalar;
    let _type;
    let value;
    const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
    switch (type) {
      case "scalar":
        _type = Scalar.Scalar.PLAIN;
        value = plainValue(source, _onError);
        break;
      case "single-quoted-scalar":
        _type = Scalar.Scalar.QUOTE_SINGLE;
        value = singleQuotedValue(source, _onError);
        break;
      case "double-quoted-scalar":
        _type = Scalar.Scalar.QUOTE_DOUBLE;
        value = doubleQuotedValue(source, _onError);
        break;
      default:
        onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
        return {
          value: "",
          type: null,
          comment: "",
          range: [offset, offset + source.length, offset + source.length]
        };
    }
    const valueEnd = offset + source.length;
    const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
    return {
      value,
      type: _type,
      comment: re.comment,
      range: [offset, valueEnd, re.offset]
    };
  }
  function plainValue(source, onError) {
    let badChar = "";
    switch (source[0]) {
      case "\t":
        badChar = "a tab character";
        break;
      case ",":
        badChar = "flow indicator character ,";
        break;
      case "%":
        badChar = "directive indicator character %";
        break;
      case "|":
      case ">": {
        badChar = `block scalar indicator ${source[0]}`;
        break;
      }
      case "@":
      case "`": {
        badChar = `reserved character ${source[0]}`;
        break;
      }
    }
    if (badChar)
      onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
    return foldLines(source);
  }
  function singleQuotedValue(source, onError) {
    if (source[source.length - 1] !== "'" || source.length === 1)
      onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
    return foldLines(source.slice(1, -1)).replace(/''/g, "'");
  }
  function foldLines(source) {
    let first, line;
    try {
      first = new RegExp(`(.*?)(?<![ 	])[ 	]*\r?
`, "sy");
      line = new RegExp(`[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?
`, "sy");
    } catch {
      first = /(.*?)[ \t]*\r?\n/sy;
      line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
    }
    let match = first.exec(source);
    if (!match)
      return source;
    let res = match[1];
    let sep = " ";
    let pos = first.lastIndex;
    line.lastIndex = pos;
    while (match = line.exec(source)) {
      if (match[1] === "") {
        if (sep === `
`)
          res += sep;
        else
          sep = `
`;
      } else {
        res += sep + match[1];
        sep = " ";
      }
      pos = line.lastIndex;
    }
    const last = /[ \t]*(.*)/sy;
    last.lastIndex = pos;
    match = last.exec(source);
    return res + sep + (match?.[1] ?? "");
  }
  function doubleQuotedValue(source, onError) {
    let res = "";
    for (let i = 1;i < source.length - 1; ++i) {
      const ch = source[i];
      if (ch === "\r" && source[i + 1] === `
`)
        continue;
      if (ch === `
`) {
        const { fold, offset } = foldNewline(source, i);
        res += fold;
        i = offset;
      } else if (ch === "\\") {
        let next = source[++i];
        const cc = escapeCodes[next];
        if (cc)
          res += cc;
        else if (next === `
`) {
          next = source[i + 1];
          while (next === " " || next === "\t")
            next = source[++i + 1];
        } else if (next === "\r" && source[i + 1] === `
`) {
          next = source[++i + 1];
          while (next === " " || next === "\t")
            next = source[++i + 1];
        } else if (next === "x" || next === "u" || next === "U") {
          const length = { x: 2, u: 4, U: 8 }[next];
          res += parseCharCode(source, i + 1, length, onError);
          i += length;
        } else {
          const raw = source.substr(i - 1, 2);
          onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
          res += raw;
        }
      } else if (ch === " " || ch === "\t") {
        const wsStart = i;
        let next = source[i + 1];
        while (next === " " || next === "\t")
          next = source[++i + 1];
        if (next !== `
` && !(next === "\r" && source[i + 2] === `
`))
          res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
      } else {
        res += ch;
      }
    }
    if (source[source.length - 1] !== '"' || source.length === 1)
      onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
    return res;
  }
  function foldNewline(source, offset) {
    let fold = "";
    let ch = source[offset + 1];
    while (ch === " " || ch === "\t" || ch === `
` || ch === "\r") {
      if (ch === "\r" && source[offset + 2] !== `
`)
        break;
      if (ch === `
`)
        fold += `
`;
      offset += 1;
      ch = source[offset + 1];
    }
    if (!fold)
      fold = " ";
    return { fold, offset };
  }
  var escapeCodes = {
    "0": "\x00",
    a: "\x07",
    b: "\b",
    e: "\x1B",
    f: "\f",
    n: `
`,
    r: "\r",
    t: "\t",
    v: "\v",
    N: "",
    _: " ",
    L: "\u2028",
    P: "\u2029",
    " ": " ",
    '"': '"',
    "/": "/",
    "\\": "\\",
    "\t": "\t"
  };
  function parseCharCode(source, offset, length, onError) {
    const cc = source.substr(offset, length);
    const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
    const code = ok ? parseInt(cc, 16) : NaN;
    if (isNaN(code)) {
      const raw = source.substr(offset - 2, length + 2);
      onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
      return raw;
    }
    return String.fromCodePoint(code);
  }
  exports.resolveFlowScalar = resolveFlowScalar;
});
var require_compose_scalar2 = __commonJS2((exports) => {
  var identity = require_identity2();
  var Scalar = require_Scalar2();
  var resolveBlockScalar = require_resolve_block_scalar2();
  var resolveFlowScalar = require_resolve_flow_scalar2();
  function composeScalar(ctx, token, tagToken, onError) {
    const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
    const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
    let tag;
    if (ctx.options.stringKeys && ctx.atKey) {
      tag = ctx.schema[identity.SCALAR];
    } else if (tagName)
      tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
    else if (token.type === "scalar")
      tag = findScalarTagByTest(ctx, value, token, onError);
    else
      tag = ctx.schema[identity.SCALAR];
    let scalar;
    try {
      const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
      scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
      scalar = new Scalar.Scalar(value);
    }
    scalar.range = range;
    scalar.source = value;
    if (type)
      scalar.type = type;
    if (tagName)
      scalar.tag = tagName;
    if (tag.format)
      scalar.format = tag.format;
    if (comment)
      scalar.comment = comment;
    return scalar;
  }
  function findScalarTagByName(schema, value, tagName, tagToken, onError) {
    if (tagName === "!")
      return schema[identity.SCALAR];
    const matchWithTest = [];
    for (const tag of schema.tags) {
      if (!tag.collection && tag.tag === tagName) {
        if (tag.default && tag.test)
          matchWithTest.push(tag);
        else
          return tag;
      }
    }
    for (const tag of matchWithTest)
      if (tag.test?.test(value))
        return tag;
    const kt = schema.knownTags[tagName];
    if (kt && !kt.collection) {
      schema.tags.push(Object.assign({}, kt, { default: false, test: undefined }));
      return kt;
    }
    onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
    return schema[identity.SCALAR];
  }
  function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
    const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
    if (schema.compat) {
      const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
      if (tag.tag !== compat.tag) {
        const ts = directives.tagString(tag.tag);
        const cs = directives.tagString(compat.tag);
        const msg = `Value may be parsed as either ${ts} or ${cs}`;
        onError(token, "TAG_RESOLVE_FAILED", msg, true);
      }
    }
    return tag;
  }
  exports.composeScalar = composeScalar;
});
var require_util_empty_scalar_position2 = __commonJS2((exports) => {
  function emptyScalarPosition(offset, before, pos) {
    if (before) {
      pos ?? (pos = before.length);
      for (let i = pos - 1;i >= 0; --i) {
        let st = before[i];
        switch (st.type) {
          case "space":
          case "comment":
          case "newline":
            offset -= st.source.length;
            continue;
        }
        st = before[++i];
        while (st?.type === "space") {
          offset += st.source.length;
          st = before[++i];
        }
        break;
      }
    }
    return offset;
  }
  exports.emptyScalarPosition = emptyScalarPosition;
});
var require_compose_node2 = __commonJS2((exports) => {
  var Alias = require_Alias2();
  var identity = require_identity2();
  var composeCollection = require_compose_collection2();
  var composeScalar = require_compose_scalar2();
  var resolveEnd = require_resolve_end2();
  var utilEmptyScalarPosition = require_util_empty_scalar_position2();
  var CN = { composeNode, composeEmptyNode };
  function composeNode(ctx, token, props, onError) {
    const atKey = ctx.atKey;
    const { spaceBefore, comment, anchor, tag } = props;
    let node;
    let isSrcToken = true;
    switch (token.type) {
      case "alias":
        node = composeAlias(ctx, token, onError);
        if (anchor || tag)
          onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
        break;
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "block-scalar":
        node = composeScalar.composeScalar(ctx, token, tag, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
        break;
      case "block-map":
      case "block-seq":
      case "flow-collection":
        try {
          node = composeCollection.composeCollection(CN, ctx, token, props, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          onError(token, "RESOURCE_EXHAUSTION", message);
        }
        break;
      default: {
        const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
        onError(token, "UNEXPECTED_TOKEN", message);
        isSrcToken = false;
      }
    }
    node ?? (node = composeEmptyNode(ctx, token.offset, undefined, null, props, onError));
    if (anchor && node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
      const msg = "With stringKeys, all keys must be strings";
      onError(tag ?? token, "NON_STRING_KEY", msg);
    }
    if (spaceBefore)
      node.spaceBefore = true;
    if (comment) {
      if (token.type === "scalar" && token.source === "")
        node.comment = comment;
      else
        node.commentBefore = comment;
    }
    if (ctx.options.keepSourceTokens && isSrcToken)
      node.srcToken = token;
    return node;
  }
  function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
    const token = {
      type: "scalar",
      offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
      indent: -1,
      source: ""
    };
    const node = composeScalar.composeScalar(ctx, token, tag, onError);
    if (anchor) {
      node.anchor = anchor.source.substring(1);
      if (node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    }
    if (spaceBefore)
      node.spaceBefore = true;
    if (comment) {
      node.comment = comment;
      node.range[2] = end;
    }
    return node;
  }
  function composeAlias({ options }, { offset, source, end }, onError) {
    const alias = new Alias.Alias(source.substring(1));
    if (alias.source === "")
      onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
    if (alias.source.endsWith(":"))
      onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
    const valueEnd = offset + source.length;
    const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
    alias.range = [offset, valueEnd, re.offset];
    if (re.comment)
      alias.comment = re.comment;
    return alias;
  }
  exports.composeEmptyNode = composeEmptyNode;
  exports.composeNode = composeNode;
});
var require_compose_doc2 = __commonJS2((exports) => {
  var Document = require_Document2();
  var composeNode = require_compose_node2();
  var resolveEnd = require_resolve_end2();
  var resolveProps = require_resolve_props2();
  function composeDoc(options, directives, { offset, start, value, end }, onError) {
    const opts = Object.assign({ _directives: directives }, options);
    const doc = new Document.Document(undefined, opts);
    const ctx = {
      atKey: false,
      atRoot: true,
      directives: doc.directives,
      options: doc.options,
      schema: doc.schema
    };
    const props = resolveProps.resolveProps(start, {
      indicator: "doc-start",
      next: value ?? end?.[0],
      offset,
      onError,
      parentIndent: 0,
      startOnNewline: true
    });
    if (props.found) {
      doc.directives.docStart = true;
      if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
        onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
    }
    doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
    const contentEnd = doc.contents.range[2];
    const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
    if (re.comment)
      doc.comment = re.comment;
    doc.range = [offset, contentEnd, re.offset];
    return doc;
  }
  exports.composeDoc = composeDoc;
});
var require_composer2 = __commonJS2((exports) => {
  var node_process = __require2("process");
  var directives = require_directives2();
  var Document = require_Document2();
  var errors = require_errors2();
  var identity = require_identity2();
  var composeDoc = require_compose_doc2();
  var resolveEnd = require_resolve_end2();
  function getErrorPos(src) {
    if (typeof src === "number")
      return [src, src + 1];
    if (Array.isArray(src))
      return src.length === 2 ? src : [src[0], src[1]];
    const { offset, source } = src;
    return [offset, offset + (typeof source === "string" ? source.length : 1)];
  }
  function parsePrelude(prelude) {
    let comment = "";
    let atComment = false;
    let afterEmptyLine = false;
    for (let i = 0;i < prelude.length; ++i) {
      const source = prelude[i];
      switch (source[0]) {
        case "#":
          comment += (comment === "" ? "" : afterEmptyLine ? `

` : `
`) + (source.substring(1) || " ");
          atComment = true;
          afterEmptyLine = false;
          break;
        case "%":
          if (prelude[i + 1]?.[0] !== "#")
            i += 1;
          atComment = false;
          break;
        default:
          if (!atComment)
            afterEmptyLine = true;
          atComment = false;
      }
    }
    return { comment, afterEmptyLine };
  }

  class Composer {
    constructor(options = {}) {
      this.doc = null;
      this.atDirectives = false;
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
      this.onError = (source, code, message, warning) => {
        const pos = getErrorPos(source);
        if (warning)
          this.warnings.push(new errors.YAMLWarning(pos, code, message));
        else
          this.errors.push(new errors.YAMLParseError(pos, code, message));
      };
      this.directives = new directives.Directives({ version: options.version || "1.2" });
      this.options = options;
    }
    decorate(doc, afterDoc) {
      const { comment, afterEmptyLine } = parsePrelude(this.prelude);
      if (comment) {
        const dc = doc.contents;
        if (afterDoc) {
          doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
        } else if (afterEmptyLine || doc.directives.docStart || !dc) {
          doc.commentBefore = comment;
        } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
          let it = dc.items[0];
          if (identity.isPair(it))
            it = it.key;
          const cb = it.commentBefore;
          it.commentBefore = cb ? `${comment}
${cb}` : comment;
        } else {
          const cb = dc.commentBefore;
          dc.commentBefore = cb ? `${comment}
${cb}` : comment;
        }
      }
      if (afterDoc) {
        Array.prototype.push.apply(doc.errors, this.errors);
        Array.prototype.push.apply(doc.warnings, this.warnings);
      } else {
        doc.errors = this.errors;
        doc.warnings = this.warnings;
      }
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
    }
    streamInfo() {
      return {
        comment: parsePrelude(this.prelude).comment,
        directives: this.directives,
        errors: this.errors,
        warnings: this.warnings
      };
    }
    *compose(tokens, forceDoc = false, endOffset = -1) {
      for (const token of tokens)
        yield* this.next(token);
      yield* this.end(forceDoc, endOffset);
    }
    *next(token) {
      if (node_process.env.LOG_STREAM)
        console.dir(token, { depth: null });
      switch (token.type) {
        case "directive":
          this.directives.add(token.source, (offset, message, warning) => {
            const pos = getErrorPos(token);
            pos[0] += offset;
            this.onError(pos, "BAD_DIRECTIVE", message, warning);
          });
          this.prelude.push(token.source);
          this.atDirectives = true;
          break;
        case "document": {
          const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
          if (this.atDirectives && !doc.directives.docStart)
            this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
          this.decorate(doc, false);
          if (this.doc)
            yield this.doc;
          this.doc = doc;
          this.atDirectives = false;
          break;
        }
        case "byte-order-mark":
        case "space":
          break;
        case "comment":
        case "newline":
          this.prelude.push(token.source);
          break;
        case "error": {
          const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
          const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
          if (this.atDirectives || !this.doc)
            this.errors.push(error);
          else
            this.doc.errors.push(error);
          break;
        }
        case "doc-end": {
          if (!this.doc) {
            const msg = "Unexpected doc-end without preceding document";
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
            break;
          }
          this.doc.directives.docEnd = true;
          const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
          this.decorate(this.doc, true);
          if (end.comment) {
            const dc = this.doc.comment;
            this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
          }
          this.doc.range[2] = end.offset;
          break;
        }
        default:
          this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
      }
    }
    *end(forceDoc = false, endOffset = -1) {
      if (this.doc) {
        this.decorate(this.doc, true);
        yield this.doc;
        this.doc = null;
      } else if (forceDoc) {
        const opts = Object.assign({ _directives: this.directives }, this.options);
        const doc = new Document.Document(undefined, opts);
        if (this.atDirectives)
          this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
        doc.range = [0, endOffset, endOffset];
        this.decorate(doc, false);
        yield doc;
      }
    }
  }
  exports.Composer = Composer;
});
var require_cst_scalar2 = __commonJS2((exports) => {
  var resolveBlockScalar = require_resolve_block_scalar2();
  var resolveFlowScalar = require_resolve_flow_scalar2();
  var errors = require_errors2();
  var stringifyString = require_stringifyString2();
  function resolveAsScalar(token, strict = true, onError) {
    if (token) {
      const _onError = (pos, code, message) => {
        const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
        if (onError)
          onError(offset, code, message);
        else
          throw new errors.YAMLParseError([offset, offset + 1], code, message);
      };
      switch (token.type) {
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
        case "block-scalar":
          return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
      }
    }
    return null;
  }
  function createScalarToken(value, context) {
    const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
    const source = stringifyString.stringifyString({ type, value }, {
      implicitKey,
      indent: indent > 0 ? " ".repeat(indent) : "",
      inFlow,
      options: { blockQuote: true, lineWidth: -1 }
    });
    const end = context.end ?? [
      { type: "newline", offset: -1, indent, source: `
` }
    ];
    switch (source[0]) {
      case "|":
      case ">": {
        const he = source.indexOf(`
`);
        const head = source.substring(0, he);
        const body = source.substring(he + 1) + `
`;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, end))
          props.push({ type: "newline", offset: -1, indent, source: `
` });
        return { type: "block-scalar", offset, indent, props, source: body };
      }
      case '"':
        return { type: "double-quoted-scalar", offset, indent, source, end };
      case "'":
        return { type: "single-quoted-scalar", offset, indent, source, end };
      default:
        return { type: "scalar", offset, indent, source, end };
    }
  }
  function setScalarValue(token, value, context = {}) {
    let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
    let indent = "indent" in token ? token.indent : null;
    if (afterKey && typeof indent === "number")
      indent += 2;
    if (!type)
      switch (token.type) {
        case "single-quoted-scalar":
          type = "QUOTE_SINGLE";
          break;
        case "double-quoted-scalar":
          type = "QUOTE_DOUBLE";
          break;
        case "block-scalar": {
          const header = token.props[0];
          if (header.type !== "block-scalar-header")
            throw new Error("Invalid block scalar header");
          type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
          break;
        }
        default:
          type = "PLAIN";
      }
    const source = stringifyString.stringifyString({ type, value }, {
      implicitKey: implicitKey || indent === null,
      indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
      inFlow,
      options: { blockQuote: true, lineWidth: -1 }
    });
    switch (source[0]) {
      case "|":
      case ">":
        setBlockScalarValue(token, source);
        break;
      case '"':
        setFlowScalarValue(token, source, "double-quoted-scalar");
        break;
      case "'":
        setFlowScalarValue(token, source, "single-quoted-scalar");
        break;
      default:
        setFlowScalarValue(token, source, "scalar");
    }
  }
  function setBlockScalarValue(token, source) {
    const he = source.indexOf(`
`);
    const head = source.substring(0, he);
    const body = source.substring(he + 1) + `
`;
    if (token.type === "block-scalar") {
      const header = token.props[0];
      if (header.type !== "block-scalar-header")
        throw new Error("Invalid block scalar header");
      header.source = head;
      token.source = body;
    } else {
      const { offset } = token;
      const indent = "indent" in token ? token.indent : -1;
      const props = [
        { type: "block-scalar-header", offset, indent, source: head }
      ];
      if (!addEndtoBlockProps(props, "end" in token ? token.end : undefined))
        props.push({ type: "newline", offset: -1, indent, source: `
` });
      for (const key of Object.keys(token))
        if (key !== "type" && key !== "offset")
          delete token[key];
      Object.assign(token, { type: "block-scalar", indent, props, source: body });
    }
  }
  function addEndtoBlockProps(props, end) {
    if (end)
      for (const st of end)
        switch (st.type) {
          case "space":
          case "comment":
            props.push(st);
            break;
          case "newline":
            props.push(st);
            return true;
        }
    return false;
  }
  function setFlowScalarValue(token, source, type) {
    switch (token.type) {
      case "scalar":
      case "double-quoted-scalar":
      case "single-quoted-scalar":
        token.type = type;
        token.source = source;
        break;
      case "block-scalar": {
        const end = token.props.slice(1);
        let oa = source.length;
        if (token.props[0].type === "block-scalar-header")
          oa -= token.props[0].source.length;
        for (const tok of end)
          tok.offset += oa;
        delete token.props;
        Object.assign(token, { type, source, end });
        break;
      }
      case "block-map":
      case "block-seq": {
        const offset = token.offset + source.length;
        const nl = { type: "newline", offset, indent: token.indent, source: `
` };
        delete token.items;
        Object.assign(token, { type, source, end: [nl] });
        break;
      }
      default: {
        const indent = "indent" in token ? token.indent : -1;
        const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type, indent, source, end });
      }
    }
  }
  exports.createScalarToken = createScalarToken;
  exports.resolveAsScalar = resolveAsScalar;
  exports.setScalarValue = setScalarValue;
});
var require_cst_stringify2 = __commonJS2((exports) => {
  var stringify = (cst) => ("type" in cst) ? stringifyToken(cst) : stringifyItem(cst);
  function stringifyToken(token) {
    switch (token.type) {
      case "block-scalar": {
        let res = "";
        for (const tok of token.props)
          res += stringifyToken(tok);
        return res + token.source;
      }
      case "block-map":
      case "block-seq": {
        let res = "";
        for (const item of token.items)
          res += stringifyItem(item);
        return res;
      }
      case "flow-collection": {
        let res = token.start.source;
        for (const item of token.items)
          res += stringifyItem(item);
        for (const st of token.end)
          res += st.source;
        return res;
      }
      case "document": {
        let res = stringifyItem(token);
        if (token.end)
          for (const st of token.end)
            res += st.source;
        return res;
      }
      default: {
        let res = token.source;
        if ("end" in token && token.end)
          for (const st of token.end)
            res += st.source;
        return res;
      }
    }
  }
  function stringifyItem({ start, key, sep, value }) {
    let res = "";
    for (const st of start)
      res += st.source;
    if (key)
      res += stringifyToken(key);
    if (sep)
      for (const st of sep)
        res += st.source;
    if (value)
      res += stringifyToken(value);
    return res;
  }
  exports.stringify = stringify;
});
var require_cst_visit2 = __commonJS2((exports) => {
  var BREAK = Symbol("break visit");
  var SKIP = Symbol("skip children");
  var REMOVE = Symbol("remove item");
  function visit(cst, visitor) {
    if ("type" in cst && cst.type === "document")
      cst = { start: cst.start, value: cst.value };
    _visit(Object.freeze([]), cst, visitor);
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  visit.itemAtPath = (cst, path) => {
    let item = cst;
    for (const [field, index] of path) {
      const tok = item?.[field];
      if (tok && "items" in tok) {
        item = tok.items[index];
      } else
        return;
    }
    return item;
  };
  visit.parentCollection = (cst, path) => {
    const parent = visit.itemAtPath(cst, path.slice(0, -1));
    const field = path[path.length - 1][0];
    const coll = parent?.[field];
    if (coll && "items" in coll)
      return coll;
    throw new Error("Parent collection not found");
  };
  function _visit(path, item, visitor) {
    let ctrl = visitor(item, path);
    if (typeof ctrl === "symbol")
      return ctrl;
    for (const field of ["key", "value"]) {
      const token = item[field];
      if (token && "items" in token) {
        for (let i = 0;i < token.items.length; ++i) {
          const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            token.items.splice(i, 1);
            i -= 1;
          }
        }
        if (typeof ctrl === "function" && field === "key")
          ctrl = ctrl(item, path);
      }
    }
    return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
  }
  exports.visit = visit;
});
var require_cst2 = __commonJS2((exports) => {
  var cstScalar = require_cst_scalar2();
  var cstStringify = require_cst_stringify2();
  var cstVisit = require_cst_visit2();
  var BOM = "\uFEFF";
  var DOCUMENT = "\x02";
  var FLOW_END = "\x18";
  var SCALAR = "\x1F";
  var isCollection = (token) => !!token && ("items" in token);
  var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
  function prettyToken(token) {
    switch (token) {
      case BOM:
        return "<BOM>";
      case DOCUMENT:
        return "<DOC>";
      case FLOW_END:
        return "<FLOW_END>";
      case SCALAR:
        return "<SCALAR>";
      default:
        return JSON.stringify(token);
    }
  }
  function tokenType(source) {
    switch (source) {
      case BOM:
        return "byte-order-mark";
      case DOCUMENT:
        return "doc-mode";
      case FLOW_END:
        return "flow-error-end";
      case SCALAR:
        return "scalar";
      case "---":
        return "doc-start";
      case "...":
        return "doc-end";
      case "":
      case `
`:
      case `\r
`:
        return "newline";
      case "-":
        return "seq-item-ind";
      case "?":
        return "explicit-key-ind";
      case ":":
        return "map-value-ind";
      case "{":
        return "flow-map-start";
      case "}":
        return "flow-map-end";
      case "[":
        return "flow-seq-start";
      case "]":
        return "flow-seq-end";
      case ",":
        return "comma";
    }
    switch (source[0]) {
      case " ":
      case "\t":
        return "space";
      case "#":
        return "comment";
      case "%":
        return "directive-line";
      case "*":
        return "alias";
      case "&":
        return "anchor";
      case "!":
        return "tag";
      case "'":
        return "single-quoted-scalar";
      case '"':
        return "double-quoted-scalar";
      case "|":
      case ">":
        return "block-scalar-header";
    }
    return null;
  }
  exports.createScalarToken = cstScalar.createScalarToken;
  exports.resolveAsScalar = cstScalar.resolveAsScalar;
  exports.setScalarValue = cstScalar.setScalarValue;
  exports.stringify = cstStringify.stringify;
  exports.visit = cstVisit.visit;
  exports.BOM = BOM;
  exports.DOCUMENT = DOCUMENT;
  exports.FLOW_END = FLOW_END;
  exports.SCALAR = SCALAR;
  exports.isCollection = isCollection;
  exports.isScalar = isScalar;
  exports.prettyToken = prettyToken;
  exports.tokenType = tokenType;
});
var require_lexer2 = __commonJS2((exports) => {
  var cst = require_cst2();
  function isEmpty(ch) {
    switch (ch) {
      case undefined:
      case " ":
      case `
`:
      case "\r":
      case "\t":
        return true;
      default:
        return false;
    }
  }
  var hexDigits = new Set("0123456789ABCDEFabcdef");
  var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
  var flowIndicatorChars = new Set(",[]{}");
  var invalidAnchorChars = new Set(` ,[]{}
\r	`);
  var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);

  class Lexer {
    constructor() {
      this.atEnd = false;
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      this.buffer = "";
      this.flowKey = false;
      this.flowLevel = 0;
      this.indentNext = 0;
      this.indentValue = 0;
      this.lineEndPos = null;
      this.next = null;
      this.pos = 0;
    }
    *lex(source, incomplete = false) {
      if (source) {
        if (typeof source !== "string")
          throw TypeError("source is not a string");
        this.buffer = this.buffer ? this.buffer + source : source;
        this.lineEndPos = null;
      }
      this.atEnd = !incomplete;
      let next = this.next ?? "stream";
      while (next && (incomplete || this.hasChars(1)))
        next = yield* this.parseNext(next);
    }
    atLineEnd() {
      let i = this.pos;
      let ch = this.buffer[i];
      while (ch === " " || ch === "\t")
        ch = this.buffer[++i];
      if (!ch || ch === "#" || ch === `
`)
        return true;
      if (ch === "\r")
        return this.buffer[i + 1] === `
`;
      return false;
    }
    charAt(n) {
      return this.buffer[this.pos + n];
    }
    continueScalar(offset) {
      let ch = this.buffer[offset];
      if (this.indentNext > 0) {
        let indent = 0;
        while (ch === " ")
          ch = this.buffer[++indent + offset];
        if (ch === "\r") {
          const next = this.buffer[indent + offset + 1];
          if (next === `
` || !next && !this.atEnd)
            return offset + indent + 1;
        }
        return ch === `
` || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
      }
      if (ch === "-" || ch === ".") {
        const dt = this.buffer.substr(offset, 3);
        if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
          return -1;
      }
      return offset;
    }
    getLine() {
      let end = this.lineEndPos;
      if (typeof end !== "number" || end !== -1 && end < this.pos) {
        end = this.buffer.indexOf(`
`, this.pos);
        this.lineEndPos = end;
      }
      if (end === -1)
        return this.atEnd ? this.buffer.substring(this.pos) : null;
      if (this.buffer[end - 1] === "\r")
        end -= 1;
      return this.buffer.substring(this.pos, end);
    }
    hasChars(n) {
      return this.pos + n <= this.buffer.length;
    }
    setNext(state) {
      this.buffer = this.buffer.substring(this.pos);
      this.pos = 0;
      this.lineEndPos = null;
      this.next = state;
      return null;
    }
    peek(n) {
      return this.buffer.substr(this.pos, n);
    }
    *parseNext(next) {
      switch (next) {
        case "stream":
          return yield* this.parseStream();
        case "line-start":
          return yield* this.parseLineStart();
        case "block-start":
          return yield* this.parseBlockStart();
        case "doc":
          return yield* this.parseDocument();
        case "flow":
          return yield* this.parseFlowCollection();
        case "quoted-scalar":
          return yield* this.parseQuotedScalar();
        case "block-scalar":
          return yield* this.parseBlockScalar();
        case "plain-scalar":
          return yield* this.parsePlainScalar();
      }
    }
    *parseStream() {
      let line = this.getLine();
      if (line === null)
        return this.setNext("stream");
      if (line[0] === cst.BOM) {
        yield* this.pushCount(1);
        line = line.substring(1);
      }
      if (line[0] === "%") {
        let dirEnd = line.length;
        let cs = line.indexOf("#");
        while (cs !== -1) {
          const ch = line[cs - 1];
          if (ch === " " || ch === "\t") {
            dirEnd = cs - 1;
            break;
          } else {
            cs = line.indexOf("#", cs + 1);
          }
        }
        while (true) {
          const ch = line[dirEnd - 1];
          if (ch === " " || ch === "\t")
            dirEnd -= 1;
          else
            break;
        }
        const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
        yield* this.pushCount(line.length - n);
        this.pushNewline();
        return "stream";
      }
      if (this.atLineEnd()) {
        const sp = yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - sp);
        yield* this.pushNewline();
        return "stream";
      }
      yield cst.DOCUMENT;
      return yield* this.parseLineStart();
    }
    *parseLineStart() {
      const ch = this.charAt(0);
      if (!ch && !this.atEnd)
        return this.setNext("line-start");
      if (ch === "-" || ch === ".") {
        if (!this.atEnd && !this.hasChars(4))
          return this.setNext("line-start");
        const s = this.peek(3);
        if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
          yield* this.pushCount(3);
          this.indentValue = 0;
          this.indentNext = 0;
          return s === "---" ? "doc" : "stream";
        }
      }
      this.indentValue = yield* this.pushSpaces(false);
      if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
        this.indentNext = this.indentValue;
      return yield* this.parseBlockStart();
    }
    *parseBlockStart() {
      const [ch0, ch1] = this.peek(2);
      if (!ch1 && !this.atEnd)
        return this.setNext("block-start");
      if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
        const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
        this.indentNext = this.indentValue + 1;
        this.indentValue += n;
        return yield* this.parseBlockStart();
      }
      return "doc";
    }
    *parseDocument() {
      yield* this.pushSpaces(true);
      const line = this.getLine();
      if (line === null)
        return this.setNext("doc");
      let n = yield* this.pushIndicators();
      switch (line[n]) {
        case "#":
          yield* this.pushCount(line.length - n);
        case undefined:
          yield* this.pushNewline();
          return yield* this.parseLineStart();
        case "{":
        case "[":
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel = 1;
          return "flow";
        case "}":
        case "]":
          yield* this.pushCount(1);
          return "doc";
        case "*":
          yield* this.pushUntil(isNotAnchorChar);
          return "doc";
        case '"':
        case "'":
          return yield* this.parseQuotedScalar();
        case "|":
        case ">":
          n += yield* this.parseBlockScalarHeader();
          n += yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - n);
          yield* this.pushNewline();
          return yield* this.parseBlockScalar();
        default:
          return yield* this.parsePlainScalar();
      }
    }
    *parseFlowCollection() {
      let nl, sp;
      let indent = -1;
      do {
        nl = yield* this.pushNewline();
        if (nl > 0) {
          sp = yield* this.pushSpaces(false);
          this.indentValue = indent = sp;
        } else {
          sp = 0;
        }
        sp += yield* this.pushSpaces(true);
      } while (nl + sp > 0);
      const line = this.getLine();
      if (line === null)
        return this.setNext("flow");
      if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
        const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
        if (!atFlowEndMarker) {
          this.flowLevel = 0;
          yield cst.FLOW_END;
          return yield* this.parseLineStart();
        }
      }
      let n = 0;
      while (line[n] === ",") {
        n += yield* this.pushCount(1);
        n += yield* this.pushSpaces(true);
        this.flowKey = false;
      }
      n += yield* this.pushIndicators();
      switch (line[n]) {
        case undefined:
          return "flow";
        case "#":
          yield* this.pushCount(line.length - n);
          return "flow";
        case "{":
        case "[":
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel += 1;
          return "flow";
        case "}":
        case "]":
          yield* this.pushCount(1);
          this.flowKey = true;
          this.flowLevel -= 1;
          return this.flowLevel ? "flow" : "doc";
        case "*":
          yield* this.pushUntil(isNotAnchorChar);
          return "flow";
        case '"':
        case "'":
          this.flowKey = true;
          return yield* this.parseQuotedScalar();
        case ":": {
          const next = this.charAt(1);
          if (this.flowKey || isEmpty(next) || next === ",") {
            this.flowKey = false;
            yield* this.pushCount(1);
            yield* this.pushSpaces(true);
            return "flow";
          }
        }
        default:
          this.flowKey = false;
          return yield* this.parsePlainScalar();
      }
    }
    *parseQuotedScalar() {
      const quote = this.charAt(0);
      let end = this.buffer.indexOf(quote, this.pos + 1);
      if (quote === "'") {
        while (end !== -1 && this.buffer[end + 1] === "'")
          end = this.buffer.indexOf("'", end + 2);
      } else {
        while (end !== -1) {
          let n = 0;
          while (this.buffer[end - 1 - n] === "\\")
            n += 1;
          if (n % 2 === 0)
            break;
          end = this.buffer.indexOf('"', end + 1);
        }
      }
      const qb = this.buffer.substring(0, end);
      let nl = qb.indexOf(`
`, this.pos);
      if (nl !== -1) {
        while (nl !== -1) {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1)
            break;
          nl = qb.indexOf(`
`, cs);
        }
        if (nl !== -1) {
          end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
        }
      }
      if (end === -1) {
        if (!this.atEnd)
          return this.setNext("quoted-scalar");
        end = this.buffer.length;
      }
      yield* this.pushToIndex(end + 1, false);
      return this.flowLevel ? "flow" : "doc";
    }
    *parseBlockScalarHeader() {
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      let i = this.pos;
      while (true) {
        const ch = this.buffer[++i];
        if (ch === "+")
          this.blockScalarKeep = true;
        else if (ch > "0" && ch <= "9")
          this.blockScalarIndent = Number(ch) - 1;
        else if (ch !== "-")
          break;
      }
      return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
    }
    *parseBlockScalar() {
      let nl = this.pos - 1;
      let indent = 0;
      let ch;
      loop:
        for (let i2 = this.pos;ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case `
`:
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === `
`)
                break;
            }
            default:
              break loop;
          }
        }
      if (!ch && !this.atEnd)
        return this.setNext("block-scalar");
      if (indent >= this.indentNext) {
        if (this.blockScalarIndent === -1)
          this.indentNext = indent;
        else {
          this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
        }
        do {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1)
            break;
          nl = this.buffer.indexOf(`
`, cs);
        } while (nl !== -1);
        if (nl === -1) {
          if (!this.atEnd)
            return this.setNext("block-scalar");
          nl = this.buffer.length;
        }
      }
      let i = nl + 1;
      ch = this.buffer[i];
      while (ch === " ")
        ch = this.buffer[++i];
      if (ch === "\t") {
        while (ch === "\t" || ch === " " || ch === "\r" || ch === `
`)
          ch = this.buffer[++i];
        nl = i - 1;
      } else if (!this.blockScalarKeep) {
        do {
          let i2 = nl - 1;
          let ch2 = this.buffer[i2];
          if (ch2 === "\r")
            ch2 = this.buffer[--i2];
          const lastChar = i2;
          while (ch2 === " ")
            ch2 = this.buffer[--i2];
          if (ch2 === `
` && i2 >= this.pos && i2 + 1 + indent > lastChar)
            nl = i2;
          else
            break;
        } while (true);
      }
      yield cst.SCALAR;
      yield* this.pushToIndex(nl + 1, true);
      return yield* this.parseLineStart();
    }
    *parsePlainScalar() {
      const inFlow = this.flowLevel > 0;
      let end = this.pos - 1;
      let i = this.pos - 1;
      let ch;
      while (ch = this.buffer[++i]) {
        if (ch === ":") {
          const next = this.buffer[i + 1];
          if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
            break;
          end = i;
        } else if (isEmpty(ch)) {
          let next = this.buffer[i + 1];
          if (ch === "\r") {
            if (next === `
`) {
              i += 1;
              ch = `
`;
              next = this.buffer[i + 1];
            } else
              end = i;
          }
          if (next === "#" || inFlow && flowIndicatorChars.has(next))
            break;
          if (ch === `
`) {
            const cs = this.continueScalar(i + 1);
            if (cs === -1)
              break;
            i = Math.max(i, cs - 2);
          }
        } else {
          if (inFlow && flowIndicatorChars.has(ch))
            break;
          end = i;
        }
      }
      if (!ch && !this.atEnd)
        return this.setNext("plain-scalar");
      yield cst.SCALAR;
      yield* this.pushToIndex(end + 1, true);
      return inFlow ? "flow" : "doc";
    }
    *pushCount(n) {
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos += n;
        return n;
      }
      return 0;
    }
    *pushToIndex(i, allowEmpty) {
      const s = this.buffer.slice(this.pos, i);
      if (s) {
        yield s;
        this.pos += s.length;
        return s.length;
      } else if (allowEmpty)
        yield "";
      return 0;
    }
    *pushIndicators() {
      switch (this.charAt(0)) {
        case "!":
          return (yield* this.pushTag()) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
        case "&":
          return (yield* this.pushUntil(isNotAnchorChar)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
        case "-":
        case "?":
        case ":": {
          const inFlow = this.flowLevel > 0;
          const ch1 = this.charAt(1);
          if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
            if (!inFlow)
              this.indentNext = this.indentValue + 1;
            else if (this.flowKey)
              this.flowKey = false;
            return (yield* this.pushCount(1)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
          }
        }
      }
      return 0;
    }
    *pushTag() {
      if (this.charAt(1) === "<") {
        let i = this.pos + 2;
        let ch = this.buffer[i];
        while (!isEmpty(ch) && ch !== ">")
          ch = this.buffer[++i];
        return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
      } else {
        let i = this.pos + 1;
        let ch = this.buffer[i];
        while (ch) {
          if (tagChars.has(ch))
            ch = this.buffer[++i];
          else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
            ch = this.buffer[i += 3];
          } else
            break;
        }
        return yield* this.pushToIndex(i, false);
      }
    }
    *pushNewline() {
      const ch = this.buffer[this.pos];
      if (ch === `
`)
        return yield* this.pushCount(1);
      else if (ch === "\r" && this.charAt(1) === `
`)
        return yield* this.pushCount(2);
      else
        return 0;
    }
    *pushSpaces(allowTabs) {
      let i = this.pos - 1;
      let ch;
      do {
        ch = this.buffer[++i];
      } while (ch === " " || allowTabs && ch === "\t");
      const n = i - this.pos;
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos = i;
      }
      return n;
    }
    *pushUntil(test) {
      let i = this.pos;
      let ch = this.buffer[i];
      while (!test(ch))
        ch = this.buffer[++i];
      return yield* this.pushToIndex(i, false);
    }
  }
  exports.Lexer = Lexer;
});
var require_line_counter2 = __commonJS2((exports) => {

  class LineCounter {
    constructor() {
      this.lineStarts = [];
      this.addNewLine = (offset) => this.lineStarts.push(offset);
      this.linePos = (offset) => {
        let low = 0;
        let high = this.lineStarts.length;
        while (low < high) {
          const mid = low + high >> 1;
          if (this.lineStarts[mid] < offset)
            low = mid + 1;
          else
            high = mid;
        }
        if (this.lineStarts[low] === offset)
          return { line: low + 1, col: 1 };
        if (low === 0)
          return { line: 0, col: offset };
        const start = this.lineStarts[low - 1];
        return { line: low, col: offset - start + 1 };
      };
    }
  }
  exports.LineCounter = LineCounter;
});
var require_parser2 = __commonJS2((exports) => {
  var node_process = __require2("process");
  var cst = require_cst2();
  var lexer = require_lexer2();
  function includesToken(list, type) {
    for (let i = 0;i < list.length; ++i)
      if (list[i].type === type)
        return true;
    return false;
  }
  function findNonEmptyIndex(list) {
    for (let i = 0;i < list.length; ++i) {
      switch (list[i].type) {
        case "space":
        case "comment":
        case "newline":
          break;
        default:
          return i;
      }
    }
    return -1;
  }
  function isFlowToken(token) {
    switch (token?.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "flow-collection":
        return true;
      default:
        return false;
    }
  }
  function getPrevProps(parent) {
    switch (parent.type) {
      case "document":
        return parent.start;
      case "block-map": {
        const it = parent.items[parent.items.length - 1];
        return it.sep ?? it.start;
      }
      case "block-seq":
        return parent.items[parent.items.length - 1].start;
      default:
        return [];
    }
  }
  function getFirstKeyStartProps(prev) {
    if (prev.length === 0)
      return [];
    let i = prev.length;
    loop:
      while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
    while (prev[++i]?.type === "space") {}
    return prev.splice(i, prev.length);
  }
  function fixFlowSeqItems(fc) {
    if (fc.start.type === "flow-seq-start") {
      for (const it of fc.items) {
        if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
          if (it.key)
            it.value = it.key;
          delete it.key;
          if (isFlowToken(it.value)) {
            if (it.value.end)
              Array.prototype.push.apply(it.value.end, it.sep);
            else
              it.value.end = it.sep;
          } else
            Array.prototype.push.apply(it.start, it.sep);
          delete it.sep;
        }
      }
    }
  }

  class Parser {
    constructor(onNewLine) {
      this.atNewLine = true;
      this.atScalar = false;
      this.indent = 0;
      this.offset = 0;
      this.onKeyLine = false;
      this.stack = [];
      this.source = "";
      this.type = "";
      this.lexer = new lexer.Lexer;
      this.onNewLine = onNewLine;
    }
    *parse(source, incomplete = false) {
      if (this.onNewLine && this.offset === 0)
        this.onNewLine(0);
      for (const lexeme of this.lexer.lex(source, incomplete))
        yield* this.next(lexeme);
      if (!incomplete)
        yield* this.end();
    }
    *next(source) {
      this.source = source;
      if (node_process.env.LOG_TOKENS)
        console.log("|", cst.prettyToken(source));
      if (this.atScalar) {
        this.atScalar = false;
        yield* this.step();
        this.offset += source.length;
        return;
      }
      const type = cst.tokenType(source);
      if (!type) {
        const message = `Not a YAML token: ${source}`;
        yield* this.pop({ type: "error", offset: this.offset, message, source });
        this.offset += source.length;
      } else if (type === "scalar") {
        this.atNewLine = false;
        this.atScalar = true;
        this.type = "scalar";
      } else {
        this.type = type;
        yield* this.step();
        switch (type) {
          case "newline":
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine)
              this.onNewLine(this.offset + source.length);
            break;
          case "space":
            if (this.atNewLine && source[0] === " ")
              this.indent += source.length;
            break;
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
            if (this.atNewLine)
              this.indent += source.length;
            break;
          case "doc-mode":
          case "flow-error-end":
            return;
          default:
            this.atNewLine = false;
        }
        this.offset += source.length;
      }
    }
    *end() {
      while (this.stack.length > 0)
        yield* this.pop();
    }
    get sourceToken() {
      const st = {
        type: this.type,
        offset: this.offset,
        indent: this.indent,
        source: this.source
      };
      return st;
    }
    *step() {
      const top = this.peek(1);
      if (this.type === "doc-end" && top?.type !== "doc-end") {
        while (this.stack.length > 0)
          yield* this.pop();
        this.stack.push({
          type: "doc-end",
          offset: this.offset,
          source: this.source
        });
        return;
      }
      if (!top)
        return yield* this.stream();
      switch (top.type) {
        case "document":
          return yield* this.document(top);
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return yield* this.scalar(top);
        case "block-scalar":
          return yield* this.blockScalar(top);
        case "block-map":
          return yield* this.blockMap(top);
        case "block-seq":
          return yield* this.blockSequence(top);
        case "flow-collection":
          return yield* this.flowCollection(top);
        case "doc-end":
          return yield* this.documentEnd(top);
      }
      yield* this.pop();
    }
    peek(n) {
      return this.stack[this.stack.length - n];
    }
    *pop(error) {
      const token = error ?? this.stack.pop();
      if (!token) {
        const message = "Tried to pop an empty stack";
        yield { type: "error", offset: this.offset, source: "", message };
      } else if (this.stack.length === 0) {
        yield token;
      } else {
        const top = this.peek(1);
        if (token.type === "block-scalar") {
          token.indent = "indent" in top ? top.indent : 0;
        } else if (token.type === "flow-collection" && top.type === "document") {
          token.indent = 0;
        }
        if (token.type === "flow-collection")
          fixFlowSeqItems(token);
        switch (top.type) {
          case "document":
            top.value = token;
            break;
          case "block-scalar":
            top.props.push(token);
            break;
          case "block-map": {
            const it = top.items[top.items.length - 1];
            if (it.value) {
              top.items.push({ start: [], key: token, sep: [] });
              this.onKeyLine = true;
              return;
            } else if (it.sep) {
              it.value = token;
            } else {
              Object.assign(it, { key: token, sep: [] });
              this.onKeyLine = !it.explicitKey;
              return;
            }
            break;
          }
          case "block-seq": {
            const it = top.items[top.items.length - 1];
            if (it.value)
              top.items.push({ start: [], value: token });
            else
              it.value = token;
            break;
          }
          case "flow-collection": {
            const it = top.items[top.items.length - 1];
            if (!it || it.value)
              top.items.push({ start: [], key: token, sep: [] });
            else if (it.sep)
              it.value = token;
            else
              Object.assign(it, { key: token, sep: [] });
            return;
          }
          default:
            yield* this.pop();
            yield* this.pop(token);
        }
        if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
          const last = token.items[token.items.length - 1];
          if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
            if (top.type === "document")
              top.end = last.start;
            else
              top.items.push({ start: last.start });
            token.items.splice(-1, 1);
          }
        }
      }
    }
    *stream() {
      switch (this.type) {
        case "directive-line":
          yield { type: "directive", offset: this.offset, source: this.source };
          return;
        case "byte-order-mark":
        case "space":
        case "comment":
        case "newline":
          yield this.sourceToken;
          return;
        case "doc-mode":
        case "doc-start": {
          const doc = {
            type: "document",
            offset: this.offset,
            start: []
          };
          if (this.type === "doc-start")
            doc.start.push(this.sourceToken);
          this.stack.push(doc);
          return;
        }
      }
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML stream`,
        source: this.source
      };
    }
    *document(doc) {
      if (doc.value)
        return yield* this.lineEnd(doc);
      switch (this.type) {
        case "doc-start": {
          if (findNonEmptyIndex(doc.start) !== -1) {
            yield* this.pop();
            yield* this.step();
          } else
            doc.start.push(this.sourceToken);
          return;
        }
        case "anchor":
        case "tag":
        case "space":
        case "comment":
        case "newline":
          doc.start.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(doc);
      if (bv)
        this.stack.push(bv);
      else {
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML document`,
          source: this.source
        };
      }
    }
    *scalar(scalar) {
      if (this.type === "map-value-ind") {
        const prev = getPrevProps(this.peek(2));
        const start = getFirstKeyStartProps(prev);
        let sep;
        if (scalar.end) {
          sep = scalar.end;
          sep.push(this.sourceToken);
          delete scalar.end;
        } else
          sep = [this.sourceToken];
        const map = {
          type: "block-map",
          offset: scalar.offset,
          indent: scalar.indent,
          items: [{ start, key: scalar, sep }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map;
      } else
        yield* this.lineEnd(scalar);
    }
    *blockScalar(scalar) {
      switch (this.type) {
        case "space":
        case "comment":
        case "newline":
          scalar.props.push(this.sourceToken);
          return;
        case "scalar":
          scalar.source = this.source;
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine) {
            let nl = this.source.indexOf(`
`) + 1;
            while (nl !== 0) {
              this.onNewLine(this.offset + nl);
              nl = this.source.indexOf(`
`, nl) + 1;
            }
          }
          yield* this.pop();
          break;
        default:
          yield* this.pop();
          yield* this.step();
      }
    }
    *blockMap(map) {
      const it = map.items[map.items.length - 1];
      switch (this.type) {
        case "newline":
          this.onKeyLine = false;
          if (it.value) {
            const end = "end" in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === "comment")
              end?.push(this.sourceToken);
            else
              map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "space":
        case "comment":
          if (it.value) {
            map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            if (this.atIndentedComment(it.start, map.indent)) {
              const prev = map.items[map.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                Array.prototype.push.apply(end, it.start);
                end.push(this.sourceToken);
                map.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
      }
      if (this.indent >= map.indent) {
        const atMapIndent = !this.onKeyLine && this.indent === map.indent;
        const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
        let start = [];
        if (atNextItem && it.sep && !it.value) {
          const nl = [];
          for (let i = 0;i < it.sep.length; ++i) {
            const st = it.sep[i];
            switch (st.type) {
              case "newline":
                nl.push(i);
                break;
              case "space":
                break;
              case "comment":
                if (st.indent > map.indent)
                  nl.length = 0;
                break;
              default:
                nl.length = 0;
            }
          }
          if (nl.length >= 2)
            start = it.sep.splice(nl[1]);
        }
        switch (this.type) {
          case "anchor":
          case "tag":
            if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start });
              this.onKeyLine = true;
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "explicit-key-ind":
            if (!it.sep && !it.explicitKey) {
              it.start.push(this.sourceToken);
              it.explicitKey = true;
            } else if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start, explicitKey: true });
            } else {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [this.sourceToken], explicitKey: true }]
              });
            }
            this.onKeyLine = true;
            return;
          case "map-value-ind":
            if (it.explicitKey) {
              if (!it.sep) {
                if (includesToken(it.start, "newline")) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else {
                  const start2 = getFirstKeyStartProps(it.start);
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                  });
                }
              } else if (it.value) {
                map.items.push({ start: [], key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, "map-value-ind")) {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start, key: null, sep: [this.sourceToken] }]
                });
              } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                const start2 = getFirstKeyStartProps(it.start);
                const key = it.key;
                const sep = it.sep;
                sep.push(this.sourceToken);
                delete it.key;
                delete it.sep;
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: start2, key, sep }]
                });
              } else if (start.length > 0) {
                it.sep = it.sep.concat(start, this.sourceToken);
              } else {
                it.sep.push(this.sourceToken);
              }
            } else {
              if (!it.sep) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else if (it.value || atNextItem) {
                map.items.push({ start, key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, "map-value-ind")) {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [], key: null, sep: [this.sourceToken] }]
                });
              } else {
                it.sep.push(this.sourceToken);
              }
            }
            this.onKeyLine = true;
            return;
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar": {
            const fs = this.flowScalar(this.type);
            if (atNextItem || it.value) {
              map.items.push({ start, key: fs, sep: [] });
              this.onKeyLine = true;
            } else if (it.sep) {
              this.stack.push(fs);
            } else {
              Object.assign(it, { key: fs, sep: [] });
              this.onKeyLine = true;
            }
            return;
          }
          default: {
            const bv = this.startBlockValue(map);
            if (bv) {
              if (bv.type === "block-seq") {
                if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                  yield* this.pop({
                    type: "error",
                    offset: this.offset,
                    message: "Unexpected block-seq-ind on same line with key",
                    source: this.source
                  });
                  return;
                }
              } else if (atMapIndent) {
                map.items.push({ start });
              }
              this.stack.push(bv);
              return;
            }
          }
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *blockSequence(seq) {
      const it = seq.items[seq.items.length - 1];
      switch (this.type) {
        case "newline":
          if (it.value) {
            const end = "end" in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === "comment")
              end?.push(this.sourceToken);
            else
              seq.items.push({ start: [this.sourceToken] });
          } else
            it.start.push(this.sourceToken);
          return;
        case "space":
        case "comment":
          if (it.value)
            seq.items.push({ start: [this.sourceToken] });
          else {
            if (this.atIndentedComment(it.start, seq.indent)) {
              const prev = seq.items[seq.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                Array.prototype.push.apply(end, it.start);
                end.push(this.sourceToken);
                seq.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
        case "anchor":
        case "tag":
          if (it.value || this.indent <= seq.indent)
            break;
          it.start.push(this.sourceToken);
          return;
        case "seq-item-ind":
          if (this.indent !== seq.indent)
            break;
          if (it.value || includesToken(it.start, "seq-item-ind"))
            seq.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
      }
      if (this.indent > seq.indent) {
        const bv = this.startBlockValue(seq);
        if (bv) {
          this.stack.push(bv);
          return;
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *flowCollection(fc) {
      const it = fc.items[fc.items.length - 1];
      if (this.type === "flow-error-end") {
        let top;
        do {
          yield* this.pop();
          top = this.peek(1);
        } while (top?.type === "flow-collection");
      } else if (fc.end.length === 0) {
        switch (this.type) {
          case "comma":
          case "explicit-key-ind":
            if (!it || it.sep)
              fc.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
          case "map-value-ind":
            if (!it || it.value)
              fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
            else if (it.sep)
              it.sep.push(this.sourceToken);
            else
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            return;
          case "space":
          case "comment":
          case "newline":
          case "anchor":
          case "tag":
            if (!it || it.value)
              fc.items.push({ start: [this.sourceToken] });
            else if (it.sep)
              it.sep.push(this.sourceToken);
            else
              it.start.push(this.sourceToken);
            return;
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar": {
            const fs = this.flowScalar(this.type);
            if (!it || it.value)
              fc.items.push({ start: [], key: fs, sep: [] });
            else if (it.sep)
              this.stack.push(fs);
            else
              Object.assign(it, { key: fs, sep: [] });
            return;
          }
          case "flow-map-end":
          case "flow-seq-end":
            fc.end.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(fc);
        if (bv)
          this.stack.push(bv);
        else {
          yield* this.pop();
          yield* this.step();
        }
      } else {
        const parent = this.peek(2);
        if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
          yield* this.pop();
          yield* this.step();
        } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          fixFlowSeqItems(fc);
          const sep = fc.end.splice(1, fc.end.length);
          sep.push(this.sourceToken);
          const map = {
            type: "block-map",
            offset: fc.offset,
            indent: fc.indent,
            items: [{ start, key: fc, sep }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else {
          yield* this.lineEnd(fc);
        }
      }
    }
    flowScalar(type) {
      if (this.onNewLine) {
        let nl = this.source.indexOf(`
`) + 1;
        while (nl !== 0) {
          this.onNewLine(this.offset + nl);
          nl = this.source.indexOf(`
`, nl) + 1;
        }
      }
      return {
        type,
        offset: this.offset,
        indent: this.indent,
        source: this.source
      };
    }
    startBlockValue(parent) {
      switch (this.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return this.flowScalar(this.type);
        case "block-scalar-header":
          return {
            type: "block-scalar",
            offset: this.offset,
            indent: this.indent,
            props: [this.sourceToken],
            source: ""
          };
        case "flow-map-start":
        case "flow-seq-start":
          return {
            type: "flow-collection",
            offset: this.offset,
            indent: this.indent,
            start: this.sourceToken,
            items: [],
            end: []
          };
        case "seq-item-ind":
          return {
            type: "block-seq",
            offset: this.offset,
            indent: this.indent,
            items: [{ start: [this.sourceToken] }]
          };
        case "explicit-key-ind": {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          start.push(this.sourceToken);
          return {
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start, explicitKey: true }]
          };
        }
        case "map-value-ind": {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          return {
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start, key: null, sep: [this.sourceToken] }]
          };
        }
      }
      return null;
    }
    atIndentedComment(start, indent) {
      if (this.type !== "comment")
        return false;
      if (this.indent <= indent)
        return false;
      return start.every((st) => st.type === "newline" || st.type === "space");
    }
    *documentEnd(docEnd) {
      if (this.type !== "doc-mode") {
        if (docEnd.end)
          docEnd.end.push(this.sourceToken);
        else
          docEnd.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
      }
    }
    *lineEnd(token) {
      switch (this.type) {
        case "comma":
        case "doc-start":
        case "doc-end":
        case "flow-seq-end":
        case "flow-map-end":
        case "map-value-ind":
          yield* this.pop();
          yield* this.step();
          break;
        case "newline":
          this.onKeyLine = false;
        case "space":
        case "comment":
        default:
          if (token.end)
            token.end.push(this.sourceToken);
          else
            token.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
      }
    }
  }
  exports.Parser = Parser;
});
var require_public_api2 = __commonJS2((exports) => {
  var composer = require_composer2();
  var Document = require_Document2();
  var errors = require_errors2();
  var log = require_log2();
  var identity = require_identity2();
  var lineCounter = require_line_counter2();
  var parser = require_parser2();
  function parseOptions(options) {
    const prettyErrors = options.prettyErrors !== false;
    const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter || null;
    return { lineCounter: lineCounter$1, prettyErrors };
  }
  function parseAllDocuments(source, options = {}) {
    const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
    const composer$1 = new composer.Composer(options);
    const docs = Array.from(composer$1.compose(parser$1.parse(source)));
    if (prettyErrors && lineCounter2)
      for (const doc of docs) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
    if (docs.length > 0)
      return docs;
    return Object.assign([], { empty: true }, composer$1.streamInfo());
  }
  function parseDocument(source, options = {}) {
    const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
    const composer$1 = new composer.Composer(options);
    let doc = null;
    for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
      if (!doc)
        doc = _doc;
      else if (doc.options.logLevel !== "silent") {
        doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
        break;
      }
    }
    if (prettyErrors && lineCounter2) {
      doc.errors.forEach(errors.prettifyError(source, lineCounter2));
      doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
    }
    return doc;
  }
  function parse(src, reviver, options) {
    let _reviver = undefined;
    if (typeof reviver === "function") {
      _reviver = reviver;
    } else if (options === undefined && reviver && typeof reviver === "object") {
      options = reviver;
    }
    const doc = parseDocument(src, options);
    if (!doc)
      return null;
    doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
    if (doc.errors.length > 0) {
      if (doc.options.logLevel !== "silent")
        throw doc.errors[0];
      else
        doc.errors = [];
    }
    return doc.toJS(Object.assign({ reviver: _reviver }, options));
  }
  function stringify(value, replacer, options) {
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === undefined && replacer) {
      options = replacer;
    }
    if (typeof options === "string")
      options = options.length;
    if (typeof options === "number") {
      const indent = Math.round(options);
      options = indent < 1 ? undefined : indent > 8 ? { indent: 8 } : { indent };
    }
    if (value === undefined) {
      const { keepUndefined } = options ?? replacer ?? {};
      if (!keepUndefined)
        return;
    }
    if (identity.isDocument(value) && !_replacer)
      return value.toString(options);
    return new Document.Document(value, _replacer, options).toString(options);
  }
  exports.parse = parse;
  exports.parseAllDocuments = parseAllDocuments;
  exports.parseDocument = parseDocument;
  exports.stringify = stringify;
});
var require_dist2 = __commonJS2((exports) => {
  var composer = require_composer2();
  var Document = require_Document2();
  var Schema = require_Schema2();
  var errors = require_errors2();
  var Alias = require_Alias2();
  var identity = require_identity2();
  var Pair = require_Pair2();
  var Scalar = require_Scalar2();
  var YAMLMap = require_YAMLMap2();
  var YAMLSeq = require_YAMLSeq2();
  var cst = require_cst2();
  var lexer = require_lexer2();
  var lineCounter = require_line_counter2();
  var parser = require_parser2();
  var publicApi = require_public_api2();
  var visit = require_visit2();
  exports.Composer = composer.Composer;
  exports.Document = Document.Document;
  exports.Schema = Schema.Schema;
  exports.YAMLError = errors.YAMLError;
  exports.YAMLParseError = errors.YAMLParseError;
  exports.YAMLWarning = errors.YAMLWarning;
  exports.Alias = Alias.Alias;
  exports.isAlias = identity.isAlias;
  exports.isCollection = identity.isCollection;
  exports.isDocument = identity.isDocument;
  exports.isMap = identity.isMap;
  exports.isNode = identity.isNode;
  exports.isPair = identity.isPair;
  exports.isScalar = identity.isScalar;
  exports.isSeq = identity.isSeq;
  exports.Pair = Pair.Pair;
  exports.Scalar = Scalar.Scalar;
  exports.YAMLMap = YAMLMap.YAMLMap;
  exports.YAMLSeq = YAMLSeq.YAMLSeq;
  exports.CST = cst;
  exports.Lexer = lexer.Lexer;
  exports.LineCounter = lineCounter.LineCounter;
  exports.Parser = parser.Parser;
  exports.parse = publicApi.parse;
  exports.parseAllDocuments = publicApi.parseAllDocuments;
  exports.parseDocument = publicApi.parseDocument;
  exports.stringify = publicApi.stringify;
  exports.visit = visit.visit;
  exports.visitAsync = visit.visitAsync;
});
var PIPELINE_PROVIDER_CHOICES2 = [
  "none",
  "acpx",
  "llama-cpp",
  "ollama",
  "claude-code",
  "codex",
  "opencode",
  "anthropic",
  "openrouter",
  "openai-compatible",
  "command"
];
var SYNTHESIS_PROVIDER_CHOICES2 = PIPELINE_PROVIDER_CHOICES2.filter((provider) => provider !== "command");
var PIPELINE_PROVIDER_SET2 = new Set(PIPELINE_PROVIDER_CHOICES2);
var SYNTHESIS_PROVIDER_SET2 = new Set(SYNTHESIS_PROVIDER_CHOICES2);
var MEMORIES_FTS_TOKENIZER2 = "unicode61";
function normalizeSql2(sql) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}
function createMemoriesFts2(db) {
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
			content,
			content='memories',
			content_rowid='rowid',
			tokenize='${MEMORIES_FTS_TOKENIZER2}'
		);
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
		END;
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
}
function recreateMemoriesFts2(db) {
  db.exec("DROP TRIGGER IF EXISTS memories_ai");
  db.exec("DROP TRIGGER IF EXISTS memories_ad");
  db.exec("DROP TRIGGER IF EXISTS memories_au");
  db.exec("DROP TABLE IF EXISTS memories_fts");
  createMemoriesFts2(db);
  db.exec("INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories");
}
function readMemoriesFtsSql2(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts' AND type = 'table'").get();
  return typeof row?.sql === "string" ? row.sql : null;
}
function memoriesFtsNeedsTokenizerRepair2(sql) {
  if (sql === null)
    return false;
  const normalized = normalizeSql2(sql);
  if (normalized.includes("porter unicode61"))
    return true;
  return !normalized.includes(`tokenize='${MEMORIES_FTS_TOKENIZER2}'`);
}
function up76(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL,
			checksum TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS conversations (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			harness TEXT NOT NULL,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			summary TEXT,
			topics TEXT,
			decisions TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT NOT NULL,
			vector_clock TEXT NOT NULL DEFAULT '{}',
			version INTEGER DEFAULT 1,
			manual_override INTEGER DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS memories (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL DEFAULT 'fact',
			category TEXT,
			content TEXT NOT NULL,
			confidence REAL DEFAULT 1.0,
			importance REAL DEFAULT 0.5,
			source_id TEXT,
			source_type TEXT,
			tags TEXT,
			who TEXT,
			why TEXT,
			project TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT NOT NULL DEFAULT 'system',
			last_accessed TEXT,
			access_count INTEGER DEFAULT 0,
			vector_clock TEXT NOT NULL DEFAULT '{}',
			version INTEGER DEFAULT 1,
			manual_override INTEGER DEFAULT 0,
			pinned INTEGER DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS embeddings (
			id TEXT PRIMARY KEY,
			content_hash TEXT NOT NULL UNIQUE,
			vector BLOB NOT NULL,
			dimensions INTEGER NOT NULL,
			source_type TEXT NOT NULL,
			source_id TEXT NOT NULL,
			chunk_text TEXT NOT NULL,
			created_at TEXT NOT NULL
		);

		-- Indexes
		CREATE INDEX IF NOT EXISTS idx_conversations_session
			ON conversations(session_id);
		CREATE INDEX IF NOT EXISTS idx_conversations_harness
			ON conversations(harness);
		CREATE INDEX IF NOT EXISTS idx_memories_type
			ON memories(type);
		CREATE INDEX IF NOT EXISTS idx_memories_category
			ON memories(category);
		CREATE INDEX IF NOT EXISTS idx_memories_pinned
			ON memories(pinned);
		CREATE INDEX IF NOT EXISTS idx_memories_importance
			ON memories(importance DESC);
		CREATE INDEX IF NOT EXISTS idx_memories_created
			ON memories(created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_embeddings_source
			ON embeddings(source_type, source_id);
		CREATE INDEX IF NOT EXISTS idx_embeddings_hash
			ON embeddings(content_hash);
	`);
  try {
    db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
				embedding FLOAT[768]
			);
		`);
  } catch {}
  createMemoriesFts2(db);
}
function hasColumn10(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
function addColumnIfMissing20(db, table, column, definition) {
  if (!hasColumn10(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up210(db) {
  addColumnIfMissing20(db, "memories", "content_hash", "TEXT");
  addColumnIfMissing20(db, "memories", "normalized_content", "TEXT");
  addColumnIfMissing20(db, "memories", "is_deleted", "INTEGER DEFAULT 0");
  addColumnIfMissing20(db, "memories", "deleted_at", "TEXT");
  addColumnIfMissing20(db, "memories", "extraction_status", "TEXT DEFAULT 'none'");
  addColumnIfMissing20(db, "memories", "embedding_model", "TEXT");
  addColumnIfMissing20(db, "memories", "extraction_model", "TEXT");
  addColumnIfMissing20(db, "memories", "update_count", "INTEGER DEFAULT 0");
  addColumnIfMissing20(db, "memories", "who", "TEXT");
  addColumnIfMissing20(db, "memories", "why", "TEXT");
  addColumnIfMissing20(db, "memories", "project", "TEXT");
  addColumnIfMissing20(db, "memories", "pinned", "INTEGER DEFAULT 0");
  addColumnIfMissing20(db, "memories", "importance", "REAL DEFAULT 0.5");
  addColumnIfMissing20(db, "memories", "last_accessed", "TEXT");
  addColumnIfMissing20(db, "memories", "access_count", "INTEGER DEFAULT 0");
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_history (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			event TEXT NOT NULL,
			old_content TEXT,
			new_content TEXT,
			changed_by TEXT NOT NULL,
			reason TEXT,
			metadata TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY (memory_id) REFERENCES memories(id)
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_jobs (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			job_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			payload TEXT,
			result TEXT,
			attempts INTEGER DEFAULT 0,
			max_attempts INTEGER DEFAULT 3,
			leased_at TEXT,
			completed_at TEXT,
			failed_at TEXT,
			error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			FOREIGN KEY (memory_id) REFERENCES memories(id)
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS entities (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			entity_type TEXT NOT NULL,
			description TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS relations (
			id TEXT PRIMARY KEY,
			source_entity_id TEXT NOT NULL,
			target_entity_id TEXT NOT NULL,
			relation_type TEXT NOT NULL,
			strength REAL DEFAULT 1.0,
			metadata TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY (source_entity_id) REFERENCES entities(id),
			FOREIGN KEY (target_entity_id) REFERENCES entities(id)
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_entity_mentions (
			memory_id TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			PRIMARY KEY (memory_id, entity_id),
			FOREIGN KEY (memory_id) REFERENCES memories(id),
			FOREIGN KEY (entity_id) REFERENCES entities(id)
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			version INTEGER NOT NULL,
			applied_at TEXT NOT NULL,
			duration_ms INTEGER,
			checksum TEXT
		);
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memories_content_hash
			ON memories(content_hash);
		CREATE INDEX IF NOT EXISTS idx_memories_is_deleted
			ON memories(is_deleted);
		CREATE INDEX IF NOT EXISTS idx_memories_extraction_status
			ON memories(extraction_status);
		CREATE INDEX IF NOT EXISTS idx_memory_history_memory_id
			ON memory_history(memory_id);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_status
			ON memory_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_memory_id
			ON memory_jobs(memory_id);
		CREATE INDEX IF NOT EXISTS idx_relations_source
			ON relations(source_entity_id);
		CREATE INDEX IF NOT EXISTS idx_relations_target
			ON relations(target_entity_id);
		CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity
			ON memory_entity_mentions(entity_id);
	`);
}
function addColumnIfMissing22(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (rows.some((r) => r.name === column))
    return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}
function up310(db) {
  addColumnIfMissing22(db, "memories", "why", "TEXT");
  addColumnIfMissing22(db, "memories", "project", "TEXT");
  db.exec(`DROP INDEX IF EXISTS idx_memories_content_hash`);
  db.exec(`
		UPDATE memories
		SET content_hash = NULL
		WHERE content_hash IS NOT NULL
		  AND is_deleted = 0
		  AND id NOT IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (
					PARTITION BY content_hash
					ORDER BY created_at DESC, rowid DESC
				) AS rn
				FROM memories
				WHERE content_hash IS NOT NULL
				  AND is_deleted = 0
			) ranked
			WHERE rn = 1
		  )
	`);
  db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash_unique
			ON memories(content_hash)
			WHERE content_hash IS NOT NULL AND is_deleted = 0
	`);
}
function hasColumn22(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
function addColumnIfMissing32(db, table, column, definition) {
  if (!hasColumn22(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up410(db) {
  addColumnIfMissing32(db, "memory_history", "actor_type", "TEXT");
  addColumnIfMissing32(db, "memory_history", "session_id", "TEXT");
  addColumnIfMissing32(db, "memory_history", "request_id", "TEXT");
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memories_deleted_at
			ON memories(deleted_at)
			WHERE is_deleted = 1;
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_history_created_at
			ON memory_history(created_at);
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_completed_at
			ON memory_jobs(completed_at)
			WHERE status = 'completed';
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_failed_at
			ON memory_jobs(failed_at)
			WHERE status = 'dead';
	`);
}
function hasColumn32(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
function addColumnIfMissing42(db, table, column, definition) {
  if (!hasColumn32(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up510(db) {
  addColumnIfMissing42(db, "entities", "canonical_name", "TEXT");
  addColumnIfMissing42(db, "entities", "mentions", "INTEGER DEFAULT 0");
  addColumnIfMissing42(db, "entities", "embedding", "BLOB");
  addColumnIfMissing42(db, "relations", "mentions", "INTEGER DEFAULT 1");
  addColumnIfMissing42(db, "relations", "confidence", "REAL DEFAULT 0.5");
  addColumnIfMissing42(db, "relations", "updated_at", "TEXT");
  addColumnIfMissing42(db, "memory_entity_mentions", "mention_text", "TEXT");
  addColumnIfMissing42(db, "memory_entity_mentions", "confidence", "REAL");
  addColumnIfMissing42(db, "memory_entity_mentions", "created_at", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entities_canonical_name ON entities(canonical_name)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_relations_composite ON relations(source_entity_id, relation_type)");
}
function hasColumn42(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
function up610(db) {
  if (!hasColumn42(db, "memories", "idempotency_key")) {
    db.exec("ALTER TABLE memories ADD COLUMN idempotency_key TEXT");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_idempotency_key
		 ON memories(idempotency_key)
		 WHERE idempotency_key IS NOT NULL`);
  if (!hasColumn42(db, "memories", "runtime_path")) {
    db.exec("ALTER TABLE memories ADD COLUMN runtime_path TEXT");
  }
}
function hasColumn52(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
function up77(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS documents (
			id TEXT PRIMARY KEY,
			source_url TEXT,
			source_type TEXT NOT NULL,
			content_type TEXT,
			content_hash TEXT,
			title TEXT,
			raw_content TEXT,
			status TEXT NOT NULL DEFAULT 'queued',
			error TEXT,
			connector_id TEXT,
			chunk_count INTEGER NOT NULL DEFAULT 0,
			memory_count INTEGER NOT NULL DEFAULT 0,
			metadata_json TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_status
		 ON documents(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_source_url
		 ON documents(source_url)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_connector_id
		 ON documents(connector_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_content_hash
		 ON documents(content_hash)`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS document_memories (
			document_id TEXT NOT NULL REFERENCES documents(id),
			memory_id TEXT NOT NULL REFERENCES memories(id),
			chunk_index INTEGER,
			PRIMARY KEY (document_id, memory_id)
		)
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS connectors (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			display_name TEXT,
			config_json TEXT NOT NULL,
			cursor_json TEXT,
			status TEXT NOT NULL DEFAULT 'idle',
			last_sync_at TEXT,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_connectors_provider
		 ON connectors(provider)`);
  if (!hasColumn52(db, "memory_jobs", "document_id")) {
    db.exec("ALTER TABLE memory_jobs ADD COLUMN document_id TEXT");
  }
}
function up82(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'").all();
  if (tables.length === 0)
    return;
  db.exec(`
		DELETE FROM embeddings
		WHERE rowid NOT IN (
			SELECT MIN(rowid) FROM embeddings
			GROUP BY content_hash
		)
	`);
  db.exec(`DROP INDEX IF EXISTS idx_embeddings_hash`);
  db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_content_hash_unique
			ON embeddings(content_hash)
	`);
}
function up92(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS summary_jobs (
			id TEXT PRIMARY KEY,
			session_key TEXT,
			harness TEXT NOT NULL,
			project TEXT,
			transcript TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT,
			attempts INTEGER DEFAULT 0,
			max_attempts INTEGER DEFAULT 3,
			created_at TEXT NOT NULL,
			completed_at TEXT,
			error TEXT
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_summary_jobs_status
		 ON summary_jobs(status)`);
}
function up102(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS umap_cache (
			id INTEGER PRIMARY KEY,
			dimensions INTEGER NOT NULL,
			embedding_count INTEGER NOT NULL,
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL
		)
	`);
}
function up112(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_scores (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			project TEXT,
			harness TEXT,
			score REAL NOT NULL,
			memories_recalled INTEGER,
			memories_used INTEGER,
			novel_context_count INTEGER,
			reasoning TEXT,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_session_scores_project
			ON session_scores(project, created_at);
		CREATE INDEX IF NOT EXISTS idx_session_scores_session
			ON session_scores(session_key);
	`);
}
function up122(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS scheduled_tasks (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			prompt TEXT NOT NULL,
			cron_expression TEXT NOT NULL,
			harness TEXT NOT NULL,
			working_directory TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			last_run_at TEXT,
			next_run_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled_next
			ON scheduled_tasks(enabled, next_run_at);

		CREATE TABLE IF NOT EXISTS task_runs (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
			status TEXT NOT NULL DEFAULT 'pending',
			started_at TEXT NOT NULL,
			completed_at TEXT,
			exit_code INTEGER,
			stdout TEXT,
			stderr TEXT,
			error TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_task_runs_task_id
			ON task_runs(task_id);
		CREATE INDEX IF NOT EXISTS idx_task_runs_status
			ON task_runs(status);
	`);
}
function addColumnIfMissing52(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up132(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS ingestion_jobs (
			id TEXT PRIMARY KEY,
			source_path TEXT NOT NULL,
			source_type TEXT NOT NULL,
			file_hash TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			chunks_total INTEGER DEFAULT 0,
			chunks_processed INTEGER DEFAULT 0,
			memories_created INTEGER DEFAULT 0,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			error TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status
			ON ingestion_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_file_hash
			ON ingestion_jobs(file_hash);
		CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_source_path
			ON ingestion_jobs(source_path);
	`);
  addColumnIfMissing52(db, "memories", "source_path", "TEXT");
  addColumnIfMissing52(db, "memories", "source_section", "TEXT");
}
function up142(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS telemetry_events (
			id TEXT PRIMARY KEY,
			event TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			properties TEXT NOT NULL,
			sent_to_posthog INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_telemetry_events_event
			ON telemetry_events(event);
		CREATE INDEX IF NOT EXISTS idx_telemetry_events_timestamp
			ON telemetry_events(timestamp);
		CREATE INDEX IF NOT EXISTS idx_telemetry_events_unsent
			ON telemetry_events(sent_to_posthog) WHERE sent_to_posthog = 0;
	`);
}
function addColumnIfMissing62(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up152(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_memories (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			source TEXT NOT NULL,
			effective_score REAL,
			predictor_score REAL,
			final_score REAL NOT NULL,
			rank INTEGER NOT NULL,
			was_injected INTEGER NOT NULL,
			relevance_score REAL,
			fts_hit_count INTEGER NOT NULL DEFAULT 0,
			agent_preference TEXT,
			created_at TEXT NOT NULL,
			UNIQUE(session_key, memory_id)
		);

		CREATE INDEX IF NOT EXISTS idx_session_memories_session
			ON session_memories(session_key);
		CREATE INDEX IF NOT EXISTS idx_session_memories_memory
			ON session_memories(memory_id);
	`);
  addColumnIfMissing62(db, "session_scores", "confidence", "REAL");
  addColumnIfMissing62(db, "session_scores", "continuity_reasoning", "TEXT");
}
function up162(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_checkpoints (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			harness TEXT NOT NULL,
			project TEXT,
			project_normalized TEXT,
			trigger TEXT NOT NULL,
			digest TEXT NOT NULL,
			prompt_count INTEGER NOT NULL,
			memory_queries TEXT,
			recent_remembers TEXT,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_checkpoints_session
			ON session_checkpoints(session_key, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_checkpoints_project
			ON session_checkpoints(project_normalized, created_at DESC);
	`);
}
function up172(db) {
  const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all();
  const colNames = new Set(cols.flatMap((c) => typeof c.name === "string" ? [c.name] : []));
  if (!colNames.has("skill_name")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN skill_name TEXT");
  }
  if (!colNames.has("skill_mode")) {
    db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN skill_mode TEXT
			 CHECK (skill_mode IN ('inject', 'slash') OR skill_mode IS NULL)`);
  }
}
function up182(db) {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_meta'").get();
  if (existing)
    return;
  db.exec(`
		CREATE TABLE skill_meta (
			entity_id     TEXT PRIMARY KEY REFERENCES entities(id),
			agent_id      TEXT NOT NULL DEFAULT 'default',
			version       TEXT,
			author        TEXT,
			license       TEXT,
			source        TEXT NOT NULL,
			role          TEXT NOT NULL DEFAULT 'utility',
			triggers      TEXT,
			tags          TEXT,
			permissions   TEXT,
			enriched      INTEGER DEFAULT 0,
			installed_at  TEXT NOT NULL,
			last_used_at  TEXT,
			use_count     INTEGER DEFAULT 0,
			importance    REAL DEFAULT 0.7,
			decay_rate    REAL DEFAULT 0.99,
			fs_path       TEXT NOT NULL,
			uninstalled_at TEXT,
			created_at    TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX idx_skill_meta_agent ON skill_meta(agent_id);
		CREATE INDEX idx_skill_meta_source ON skill_meta(source);
	`);
}
function up192(db) {
  const entityCols = db.prepare("PRAGMA table_info(entities)").all();
  const entityColNames = new Set(entityCols.flatMap((c) => typeof c.name === "string" ? [c.name] : []));
  if (!entityColNames.has("agent_id")) {
    db.exec("ALTER TABLE entities ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_entities_agent ON entities(agent_id)");
  db.exec(`
		CREATE TABLE IF NOT EXISTS entity_aspects (
			id             TEXT PRIMARY KEY,
			entity_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			agent_id       TEXT NOT NULL DEFAULT 'default',
			name           TEXT NOT NULL,
			canonical_name TEXT NOT NULL,
			weight         REAL NOT NULL DEFAULT 0.5,
			created_at     TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(entity_id, canonical_name)
		);

		CREATE INDEX IF NOT EXISTS idx_entity_aspects_entity ON entity_aspects(entity_id);
		CREATE INDEX IF NOT EXISTS idx_entity_aspects_agent ON entity_aspects(agent_id);
		CREATE INDEX IF NOT EXISTS idx_entity_aspects_weight ON entity_aspects(weight DESC);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS entity_attributes (
			id                 TEXT PRIMARY KEY,
			aspect_id          TEXT REFERENCES entity_aspects(id) ON DELETE SET NULL,
			agent_id           TEXT NOT NULL DEFAULT 'default',
			memory_id          TEXT REFERENCES memories(id) ON DELETE SET NULL,
			kind               TEXT NOT NULL,
			content            TEXT NOT NULL,
			normalized_content TEXT NOT NULL,
			confidence         REAL NOT NULL DEFAULT 0.0,
			importance         REAL NOT NULL DEFAULT 0.5,
			status             TEXT NOT NULL DEFAULT 'active',
			superseded_by      TEXT,
			created_at         TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_entity_attributes_aspect ON entity_attributes(aspect_id);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_agent ON entity_attributes(agent_id);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_kind ON entity_attributes(kind);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_status ON entity_attributes(status);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS entity_dependencies (
			id                TEXT PRIMARY KEY,
			source_entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			target_entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			agent_id          TEXT NOT NULL DEFAULT 'default',
			aspect_id         TEXT REFERENCES entity_aspects(id) ON DELETE SET NULL,
			dependency_type   TEXT NOT NULL,
			strength          REAL NOT NULL DEFAULT 0.5,
			created_at        TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_entity_dependencies_source ON entity_dependencies(source_entity_id);
		CREATE INDEX IF NOT EXISTS idx_entity_dependencies_target ON entity_dependencies(target_entity_id);
		CREATE INDEX IF NOT EXISTS idx_entity_dependencies_agent ON entity_dependencies(agent_id);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS task_meta (
			entity_id        TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
			agent_id         TEXT NOT NULL DEFAULT 'default',
			status           TEXT NOT NULL,
			expires_at       TEXT,
			retention_until  TEXT,
			completed_at     TEXT,
			updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_task_meta_agent ON task_meta(agent_id);
		CREATE INDEX IF NOT EXISTS idx_task_meta_status ON task_meta(status);
		CREATE INDEX IF NOT EXISTS idx_task_meta_retention ON task_meta(retention_until);
	`);
}
function addColumnIfMissing72(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up202(db) {
  addColumnIfMissing72(db, "session_memories", "entity_slot", "INTEGER");
  addColumnIfMissing72(db, "session_memories", "aspect_slot", "INTEGER");
  addColumnIfMissing72(db, "session_memories", "is_constraint", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing72(db, "session_memories", "structural_density", "INTEGER");
}
function up212(db) {
  const columns = db.prepare("PRAGMA table_info(session_checkpoints)").all();
  const columnNames = new Set(columns.flatMap((column) => typeof column.name === "string" ? [column.name] : []));
  if (!columnNames.has("focal_entity_ids")) {
    db.exec("ALTER TABLE session_checkpoints ADD COLUMN focal_entity_ids TEXT");
  }
  if (!columnNames.has("focal_entity_names")) {
    db.exec("ALTER TABLE session_checkpoints ADD COLUMN focal_entity_names TEXT");
  }
  if (!columnNames.has("active_aspect_ids")) {
    db.exec("ALTER TABLE session_checkpoints ADD COLUMN active_aspect_ids TEXT");
  }
  if (!columnNames.has("surfaced_constraint_count")) {
    db.exec("ALTER TABLE session_checkpoints ADD COLUMN surfaced_constraint_count INTEGER");
  }
  if (!columnNames.has("traversal_memory_count")) {
    db.exec("ALTER TABLE session_checkpoints ADD COLUMN traversal_memory_count INTEGER");
  }
}
function addColumnIfMissing82(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up222(db) {
  addColumnIfMissing82(db, "entities", "pinned", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing82(db, "entities", "pinned_at", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entities_pinned ON entities(agent_id, pinned, pinned_at DESC)");
}
function up232(_db) {}
function up242(_db) {}
function addColumnIfMissing92(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up252(db) {
  addColumnIfMissing92(db, "session_memories", "agent_relevance_score", "REAL");
  addColumnIfMissing92(db, "session_memories", "agent_feedback_count", "INTEGER DEFAULT 0");
}
function up262(_db) {}
function up272(db) {
  db.exec(`
		UPDATE entities
		SET canonical_name = REPLACE(REPLACE(REPLACE(
			LOWER(TRIM(name)),
			'  ', ' '), '  ', ' '), '  ', ' ')
		WHERE canonical_name IS NULL
	`);
}
function up282(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS memories_cold (
			archive_id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			type TEXT DEFAULT 'fact',
			category TEXT,
			content TEXT NOT NULL,
			confidence REAL DEFAULT 1.0,
			importance REAL DEFAULT 0.5,
			source_id TEXT,
			source_type TEXT,
			tags TEXT,
			who TEXT,
			why TEXT,
			project TEXT,
			content_hash TEXT,
			normalized_content TEXT,
			extraction_status TEXT,
			embedding_model TEXT,
			extraction_model TEXT,
			update_count INTEGER DEFAULT 0,
			original_created_at TEXT NOT NULL,
			archived_at TEXT NOT NULL,
			archived_reason TEXT,
			cold_source_id TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			original_row_json TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_cold_memory_id ON memories_cold(memory_id);
		CREATE INDEX IF NOT EXISTS idx_cold_agent ON memories_cold(agent_id);
		CREATE INDEX IF NOT EXISTS idx_cold_project ON memories_cold(project);
		CREATE INDEX IF NOT EXISTS idx_cold_archived_at ON memories_cold(archived_at);
		CREATE INDEX IF NOT EXISTS idx_cold_source ON memories_cold(cold_source_id);
	`);
}
function up292(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_summaries (
			id TEXT PRIMARY KEY,
			project TEXT,
			depth INTEGER NOT NULL DEFAULT 0,
			kind TEXT NOT NULL CHECK(kind IN ('session', 'arc', 'epoch')),
			content TEXT NOT NULL,
			token_count INTEGER,
			earliest_at TEXT NOT NULL,
			latest_at TEXT NOT NULL,
			session_key TEXT,
			harness TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS session_summary_children (
			parent_id TEXT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
			child_id TEXT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
			ordinal INTEGER NOT NULL,
			PRIMARY KEY (parent_id, child_id)
		);

		-- No FK on memory_id: memories may be soft-deleted, purged, or
		-- archived to cold tier. The link is intentionally durable so
		-- summary lineage survives retention sweeps.
		CREATE TABLE IF NOT EXISTS session_summary_memories (
			summary_id TEXT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
			memory_id TEXT NOT NULL,
			PRIMARY KEY (summary_id, memory_id)
		);

		CREATE INDEX IF NOT EXISTS idx_summaries_project_depth ON session_summaries(project, depth);
		CREATE INDEX IF NOT EXISTS idx_summaries_kind ON session_summaries(kind);
		CREATE INDEX IF NOT EXISTS idx_summaries_agent ON session_summaries(agent_id);
		CREATE INDEX IF NOT EXISTS idx_summaries_latest ON session_summaries(latest_at DESC);
		CREATE INDEX IF NOT EXISTS idx_summary_children_child ON session_summary_children(child_id);
		CREATE INDEX IF NOT EXISTS idx_summaries_session_key ON session_summaries(session_key);
		-- Unique constraint prevents duplicate depth-0 rows on retry
		CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_session_depth
			ON session_summaries(session_key, depth)
			WHERE session_key IS NOT NULL;
	`);
}
function up302(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_jobs_new (
			id TEXT PRIMARY KEY,
			memory_id TEXT,
			job_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			payload TEXT,
			result TEXT,
			attempts INTEGER DEFAULT 0,
			max_attempts INTEGER DEFAULT 3,
			leased_at TEXT,
			completed_at TEXT,
			failed_at TEXT,
			error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			document_id TEXT,
			FOREIGN KEY (memory_id) REFERENCES memories(id)
		)
	`);
  db.exec(`
		INSERT INTO memory_jobs_new
			(id, memory_id, job_type, status, payload, result,
			 attempts, max_attempts, leased_at, completed_at, failed_at,
			 error, created_at, updated_at, document_id)
		SELECT
			id, memory_id, job_type, status, payload, result,
			attempts, max_attempts, leased_at, completed_at, failed_at,
			error, created_at, updated_at, document_id
		FROM memory_jobs
	`);
  db.exec("DROP TABLE IF EXISTS memory_jobs");
  db.exec("ALTER TABLE memory_jobs_new RENAME TO memory_jobs");
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_status
			ON memory_jobs(status);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_memory_id
			ON memory_jobs(memory_id);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_completed_at
			ON memory_jobs(completed_at);
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_failed_at
			ON memory_jobs(failed_at);
	`);
}
function up312(db) {
  const depCols = db.prepare("PRAGMA table_info(entity_dependencies)").all();
  if (!depCols.some((c) => c.name === "reason")) {
    db.exec("ALTER TABLE entity_dependencies ADD COLUMN reason TEXT");
  }
  const entCols = db.prepare("PRAGMA table_info(entities)").all();
  if (!entCols.some((c) => c.name === "last_synthesized_at")) {
    db.exec("ALTER TABLE entities ADD COLUMN last_synthesized_at TEXT");
  }
}
function up322(db) {
  const cols = db.prepare("PRAGMA table_info(embeddings)").all();
  if (cols.length === 0)
    return;
  if (!cols.some((c) => c.name === "vector")) {
    db.exec("ALTER TABLE embeddings ADD COLUMN vector BLOB");
  }
}
function up332(db) {
  const cols = db.prepare("PRAGMA table_info(memories)").all();
  if (!cols.some((c) => c.name === "scope")) {
    db.exec("ALTER TABLE memories ADD COLUMN scope TEXT DEFAULT NULL");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope) WHERE scope IS NOT NULL");
}
function up342(db) {
  db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
  db.exec(`
		CREATE UNIQUE INDEX idx_memories_content_hash_unique
		ON memories(content_hash, COALESCE(scope, '__NULL__'))
		WHERE content_hash IS NOT NULL AND is_deleted = 0
	`);
}
function up352(db) {
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
			name, canonical_name,
			content='entities', content_rowid='rowid'
		)
	`);
  db.exec(`
		INSERT INTO entities_fts(rowid, name, canonical_name)
		SELECT rowid, name, canonical_name FROM entities
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
			INSERT INTO entities_fts(rowid, name, canonical_name)
			VALUES (new.rowid, new.name, new.canonical_name);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
			INSERT INTO entities_fts(entities_fts, rowid, name, canonical_name)
			VALUES ('delete', old.rowid, old.name, old.canonical_name);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
			INSERT INTO entities_fts(entities_fts, rowid, name, canonical_name)
			VALUES ('delete', old.rowid, old.name, old.canonical_name);
			INSERT INTO entities_fts(rowid, name, canonical_name)
			VALUES (new.rowid, new.name, new.canonical_name);
		END
	`);
}
function up362(db) {
  const cols = db.prepare("PRAGMA table_info(entity_dependencies)").all();
  if (!cols.some((c) => c.name === "confidence")) {
    db.exec("ALTER TABLE entity_dependencies ADD COLUMN confidence REAL DEFAULT 0.7");
  }
}
function up372(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS entity_communities (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			name TEXT,
			cohesion REAL DEFAULT 0.0,
			member_count INTEGER DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_entity_communities_agent ON entity_communities(agent_id)");
  const cols = db.prepare("PRAGMA table_info(entities)").all();
  if (!cols.some((c) => c.name === "community_id")) {
    db.exec("ALTER TABLE entities ADD COLUMN community_id TEXT REFERENCES entity_communities(id)");
  }
}
function up382(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_hints (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
			agent_id TEXT NOT NULL,
			hint TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(memory_id, hint)
		)
	`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hints_memory ON memory_hints(memory_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_hints_agent ON memory_hints(agent_id)`);
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_hints_fts USING fts5(
			hint,
			content='memory_hints', content_rowid='rowid'
		)
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_hints_fts_ai AFTER INSERT ON memory_hints BEGIN
			INSERT INTO memory_hints_fts(rowid, hint)
			VALUES (new.rowid, new.hint);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_hints_fts_ad AFTER DELETE ON memory_hints BEGIN
			INSERT INTO memory_hints_fts(memory_hints_fts, rowid, hint)
			VALUES ('delete', old.rowid, old.hint);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_hints_fts_au AFTER UPDATE ON memory_hints BEGIN
			INSERT INTO memory_hints_fts(memory_hints_fts, rowid, hint)
			VALUES ('delete', old.rowid, old.hint);
			INSERT INTO memory_hints_fts(rowid, hint)
			VALUES (new.rowid, new.hint);
		END
	`);
}
function up392(db) {
  db.exec(`
		DELETE FROM entity_dependencies
		WHERE id NOT IN (
			SELECT MIN(id) FROM entity_dependencies
			GROUP BY source_entity_id, target_entity_id,
			         dependency_type, agent_id
		)
	`);
  db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS
			idx_entity_deps_unique
		ON entity_dependencies(
			source_entity_id, target_entity_id,
			dependency_type, agent_id
		)
	`);
}
function up402(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_transcripts (
			session_key TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			harness TEXT,
			project TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_st_project
			ON session_transcripts(project);
		CREATE INDEX IF NOT EXISTS idx_st_created
			ON session_transcripts(created_at);
	`);
}
function addColumnIfMissing102(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up412(db) {
  addColumnIfMissing102(db, "session_memories", "path_json", "TEXT");
  db.exec(`
		CREATE TABLE IF NOT EXISTS path_feedback_events (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			path_hash TEXT NOT NULL,
			path_json TEXT NOT NULL,
			rating REAL NOT NULL,
			reward REAL NOT NULL DEFAULT 0,
			reward_forward REAL NOT NULL DEFAULT 0,
			reward_update REAL NOT NULL DEFAULT 0,
			reward_downstream REAL NOT NULL DEFAULT 0,
			reward_dead_end REAL NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_path_feedback_events_agent_path
			ON path_feedback_events(agent_id, path_hash);
		CREATE INDEX IF NOT EXISTS idx_path_feedback_events_session
			ON path_feedback_events(session_key);
		CREATE INDEX IF NOT EXISTS idx_path_feedback_events_memory
			ON path_feedback_events(memory_id);

		CREATE TABLE IF NOT EXISTS path_feedback_stats (
			agent_id TEXT NOT NULL,
			path_hash TEXT NOT NULL,
			path_json TEXT NOT NULL,
			q_value REAL NOT NULL DEFAULT 0,
			sample_count INTEGER NOT NULL DEFAULT 0,
			positive_count INTEGER NOT NULL DEFAULT 0,
			negative_count INTEGER NOT NULL DEFAULT 0,
			neutral_count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, path_hash)
		);

		CREATE TABLE IF NOT EXISTS entity_retrieval_stats (
			agent_id TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			session_count INTEGER NOT NULL DEFAULT 0,
			last_session_key TEXT,
			updated_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, entity_id)
		);

		CREATE TABLE IF NOT EXISTS entity_cooccurrence (
			agent_id TEXT NOT NULL,
			source_entity_id TEXT NOT NULL,
			target_entity_id TEXT NOT NULL,
			session_count INTEGER NOT NULL DEFAULT 0,
			last_session_key TEXT,
			updated_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, source_entity_id, target_entity_id)
		);

		CREATE TABLE IF NOT EXISTS path_feedback_sessions (
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, session_key)
		);
	`);
}
function addColumnIfMissing112(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function up422(db) {
  addColumnIfMissing112(db, "session_memories", "entity_slot", "INTEGER");
  addColumnIfMissing112(db, "session_memories", "aspect_slot", "INTEGER");
  addColumnIfMissing112(db, "session_memories", "is_constraint", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing112(db, "session_memories", "structural_density", "INTEGER");
  addColumnIfMissing112(db, "session_memories", "predictor_rank", "INTEGER");
  addColumnIfMissing112(db, "session_memories", "agent_relevance_score", "REAL");
  addColumnIfMissing112(db, "session_memories", "agent_feedback_count", "INTEGER DEFAULT 0");
  addColumnIfMissing112(db, "session_memories", "path_json", "TEXT");
  const cols = db.prepare("PRAGMA table_info(session_memories)").all();
  const hasAgent = cols.some((col) => col.name === "agent_id");
  const agentExpr = hasAgent ? "COALESCE(NULLIF(agent_id, ''), 'default')" : "'default'";
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_memories_new (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			memory_id TEXT NOT NULL,
			source TEXT NOT NULL,
			effective_score REAL,
			predictor_score REAL,
			final_score REAL NOT NULL,
			rank INTEGER NOT NULL,
			was_injected INTEGER NOT NULL,
			relevance_score REAL,
			fts_hit_count INTEGER NOT NULL DEFAULT 0,
			agent_preference TEXT,
			created_at TEXT NOT NULL,
			entity_slot INTEGER,
			aspect_slot INTEGER,
			is_constraint INTEGER NOT NULL DEFAULT 0,
			structural_density INTEGER,
			predictor_rank INTEGER,
			agent_relevance_score REAL,
			agent_feedback_count INTEGER DEFAULT 0,
			path_json TEXT,
			UNIQUE(session_key, agent_id, memory_id)
		);

		INSERT INTO session_memories_new
			(id, session_key, agent_id, memory_id, source,
			 effective_score, predictor_score, final_score, rank,
			 was_injected, relevance_score, fts_hit_count,
			 agent_preference, created_at, entity_slot, aspect_slot,
			 is_constraint, structural_density, predictor_rank,
			 agent_relevance_score, agent_feedback_count, path_json)
		SELECT
			id,
			session_key,
			${agentExpr},
			memory_id,
			source,
			effective_score,
			predictor_score,
			final_score,
			rank,
			was_injected,
			relevance_score,
			fts_hit_count,
			agent_preference,
			created_at,
			entity_slot,
			aspect_slot,
			COALESCE(is_constraint, 0),
			structural_density,
			predictor_rank,
			agent_relevance_score,
			COALESCE(agent_feedback_count, 0),
			path_json
		FROM session_memories;

		DROP TABLE session_memories;
		ALTER TABLE session_memories_new RENAME TO session_memories;

		CREATE INDEX IF NOT EXISTS idx_session_memories_session
			ON session_memories(session_key);
		CREATE INDEX IF NOT EXISTS idx_session_memories_memory
			ON session_memories(memory_id);
		CREATE INDEX IF NOT EXISTS idx_session_memories_agent_session
			ON session_memories(agent_id, session_key);
	`);
}
function addColumnIfMissing122(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function up432(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS agents (
			id           TEXT PRIMARY KEY,
			name         TEXT,
			read_policy  TEXT NOT NULL DEFAULT 'isolated',
			policy_group TEXT,
			created_at   TEXT NOT NULL,
			updated_at   TEXT NOT NULL
		);
	`);
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO agents (id, name, read_policy, created_at, updated_at)
		 VALUES ('default', 'default', 'shared', ?, ?)`).run(now, now);
  addColumnIfMissing122(db, "memories", "agent_id", "TEXT DEFAULT 'default'");
  addColumnIfMissing122(db, "memories", "visibility", "TEXT DEFAULT 'global'");
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memories_agent_id
			ON memories(agent_id);
		CREATE INDEX IF NOT EXISTS idx_memories_agent_visibility
			ON memories(agent_id, visibility);
	`);
}
function addColumnIfMissing132(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function up442(db) {
  addColumnIfMissing132(db, "session_summaries", "source_type", "TEXT");
  addColumnIfMissing132(db, "session_summaries", "source_ref", "TEXT");
  addColumnIfMissing132(db, "session_summaries", "meta_json", "TEXT");
  db.exec(`
		UPDATE session_summaries
		SET source_type = CASE
			WHEN source_type IS NOT NULL THEN source_type
			WHEN kind = 'session' THEN 'summary'
			WHEN kind IN ('arc', 'epoch') THEN 'condensation'
			ELSE kind
		END
		WHERE source_type IS NULL;

		CREATE INDEX IF NOT EXISTS idx_summaries_source_type
			ON session_summaries(source_type);
		CREATE INDEX IF NOT EXISTS idx_summaries_source_ref
			ON session_summaries(source_ref);
	`);
}
function addColumnIfMissing142(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function up452(db) {
  addColumnIfMissing142(db, "session_transcripts", "updated_at", "TEXT");
  addColumnIfMissing142(db, "summary_jobs", "agent_id", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing142(db, "session_scores", "agent_id", "TEXT NOT NULL DEFAULT 'default'");
  db.exec(`
		UPDATE session_transcripts
		SET updated_at = COALESCE(updated_at, created_at)
		WHERE updated_at IS NULL;

		UPDATE summary_jobs
		SET agent_id = COALESCE(agent_id, 'default')
		WHERE agent_id IS NULL;

		UPDATE session_scores
		SET agent_id = COALESCE(agent_id, 'default')
		WHERE agent_id IS NULL;

		CREATE INDEX IF NOT EXISTS idx_st_agent_updated
			ON session_transcripts(agent_id, updated_at);
		CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent
			ON summary_jobs(agent_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_session_scores_agent_session
			ON session_scores(agent_id, session_key, created_at);
	`);
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS session_transcripts_fts USING fts5(
			content,
			content='session_transcripts',
			content_rowid='rowid'
		)
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ai AFTER INSERT ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ad AFTER DELETE ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES ('delete', old.rowid, old.content);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_au AFTER UPDATE ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES ('delete', old.rowid, old.content);
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END
	`);
  db.exec(`
		INSERT INTO session_transcripts_fts(session_transcripts_fts)
		VALUES ('rebuild');
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_md_heads (
			agent_id TEXT PRIMARY KEY,
			content TEXT NOT NULL DEFAULT '',
			content_hash TEXT NOT NULL DEFAULT '',
			revision INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			lease_token TEXT,
			lease_owner TEXT,
			lease_expires_at TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_memory_md_heads_lease
			ON memory_md_heads(lease_expires_at);
	`);
}
function up462(db) {
  db.exec(`
		DROP INDEX IF EXISTS idx_summaries_session_depth;

		CREATE TEMP TABLE IF NOT EXISTS session_summary_duplicate_map AS
		WITH ranked AS (
			SELECT
				id,
				agent_id,
				session_key,
				depth,
				ROW_NUMBER() OVER (
					PARTITION BY agent_id, session_key, depth
					ORDER BY latest_at DESC, created_at DESC, id ASC
				) AS rn
			FROM session_summaries
			WHERE session_key IS NOT NULL
			  AND COALESCE(source_type, 'summary') = 'summary'
		)
		SELECT dup.id AS drop_id, keep.id AS keep_id
		FROM ranked dup
		JOIN ranked keep
		  ON keep.agent_id = dup.agent_id
		 AND keep.session_key = dup.session_key
		 AND keep.depth = dup.depth
		 AND keep.rn = 1
		WHERE dup.rn > 1;

		INSERT OR IGNORE INTO session_summary_memories (summary_id, memory_id)
		SELECT map.keep_id, link.memory_id
		FROM session_summary_duplicate_map map
		JOIN session_summary_memories link ON link.summary_id = map.drop_id;

		INSERT OR IGNORE INTO session_summary_children (parent_id, child_id, ordinal)
		SELECT
			COALESCE(parent_map.keep_id, rel.parent_id),
			COALESCE(child_map.keep_id, rel.child_id),
			rel.ordinal
		FROM session_summary_children rel
		LEFT JOIN session_summary_duplicate_map parent_map ON parent_map.drop_id = rel.parent_id
		LEFT JOIN session_summary_duplicate_map child_map ON child_map.drop_id = rel.child_id
		WHERE parent_map.drop_id IS NOT NULL OR child_map.drop_id IS NOT NULL;

		DELETE FROM session_summary_children
		WHERE parent_id IN (SELECT drop_id FROM session_summary_duplicate_map)
		   OR child_id IN (SELECT drop_id FROM session_summary_duplicate_map);

		DELETE FROM session_summary_memories
		WHERE summary_id IN (SELECT drop_id FROM session_summary_duplicate_map);

		DELETE FROM session_summaries
		WHERE id IN (SELECT drop_id FROM session_summary_duplicate_map);

		DROP TABLE session_summary_duplicate_map;

		CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_session_depth_summary
			ON session_summaries(agent_id, session_key, depth)
			WHERE session_key IS NOT NULL
			  AND COALESCE(source_type, 'summary') = 'summary';
	`);
}
function up472(db) {
  db.exec(`
		DROP TRIGGER IF EXISTS session_transcripts_fts_ai;
		DROP TRIGGER IF EXISTS session_transcripts_fts_ad;
		DROP TRIGGER IF EXISTS session_transcripts_fts_au;
		DROP TABLE IF EXISTS session_transcripts_fts;

		CREATE TABLE IF NOT EXISTS session_transcripts_next (
			session_key TEXT NOT NULL,
			content TEXT NOT NULL,
			harness TEXT,
			project TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL,
			updated_at TEXT,
			PRIMARY KEY (agent_id, session_key)
		);

		INSERT INTO session_transcripts_next (
			session_key,
			content,
			harness,
			project,
			agent_id,
			created_at,
			updated_at
		)
		SELECT
			session_key,
			content,
			harness,
			project,
			agent_id,
			created_at,
			updated_at
		FROM (
			SELECT
				session_key,
				content,
				harness,
				project,
				COALESCE(agent_id, 'default') AS agent_id,
				created_at,
				COALESCE(updated_at, created_at) AS updated_at,
				ROW_NUMBER() OVER (
					PARTITION BY COALESCE(agent_id, 'default'), session_key
					ORDER BY COALESCE(updated_at, created_at) DESC, LENGTH(content) DESC, created_at DESC, rowid DESC
				) AS rn
			FROM session_transcripts
		) ranked
		WHERE rn = 1;

		DROP TABLE session_transcripts;
		ALTER TABLE session_transcripts_next RENAME TO session_transcripts;

		CREATE INDEX IF NOT EXISTS idx_st_project
			ON session_transcripts(project);
		CREATE INDEX IF NOT EXISTS idx_st_created
			ON session_transcripts(created_at);
		CREATE INDEX IF NOT EXISTS idx_st_agent_updated
			ON session_transcripts(agent_id, updated_at);

		CREATE VIRTUAL TABLE IF NOT EXISTS session_transcripts_fts USING fts5(
			content,
			content='session_transcripts',
			content_rowid='rowid'
		);

		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ai AFTER INSERT ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END;

		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ad AFTER DELETE ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES ('delete', old.rowid, old.content);
		END;

		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_au AFTER UPDATE ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES ('delete', old.rowid, old.content);
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END;

		INSERT INTO session_transcripts_fts(session_transcripts_fts)
		VALUES ('rebuild');

		DROP INDEX IF EXISTS idx_summaries_session_depth;
		DROP INDEX IF EXISTS idx_summaries_session_depth_summary;
		CREATE INDEX IF NOT EXISTS idx_summaries_agent_session_key
			ON session_summaries(agent_id, session_key);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_agent_session_depth_summary
			ON session_summaries(agent_id, session_key, depth)
			WHERE session_key IS NOT NULL
			  AND COALESCE(source_type, 'summary') = 'summary';
	`);
}
function up482(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_thread_heads (
			agent_id TEXT NOT NULL DEFAULT 'default',
			thread_key TEXT NOT NULL,
			label TEXT NOT NULL,
			project TEXT,
			session_key TEXT,
			source_type TEXT NOT NULL DEFAULT 'summary',
			source_ref TEXT,
			harness TEXT,
			node_id TEXT NOT NULL,
			latest_at TEXT NOT NULL,
			sample TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, thread_key)
		);

		CREATE INDEX IF NOT EXISTS idx_thread_heads_agent_latest
			ON memory_thread_heads(agent_id, latest_at DESC);
		CREATE INDEX IF NOT EXISTS idx_thread_heads_agent_project
			ON memory_thread_heads(agent_id, project);

		INSERT INTO memory_thread_heads (
			agent_id, thread_key, label, project, session_key, source_type,
			source_ref, harness, node_id, latest_at, sample, updated_at
		)
		SELECT
			ss.agent_id,
			CASE
				WHEN ss.harness IS NOT NULL AND TRIM(ss.harness) != ''
						AND (ss.project IS NULL OR TRIM(ss.project) = '')
						AND (ss.source_ref IS NULL OR TRIM(ss.source_ref) = '')
						AND (ss.session_key IS NULL OR TRIM(ss.session_key) = '')
					THEN 'harness:' || TRIM(ss.harness)
				ELSE
					CASE
						WHEN ss.source_ref IS NOT NULL AND TRIM(ss.source_ref) != '' AND ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN
							'project:' || TRIM(ss.project) || '|source:' || TRIM(ss.source_ref)
						WHEN ss.source_ref IS NOT NULL AND TRIM(ss.source_ref) != '' THEN 'source:' || TRIM(ss.source_ref)
						WHEN ss.session_key IS NOT NULL AND TRIM(ss.session_key) != '' AND ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN
							'project:' || TRIM(ss.project) || '|session:' || TRIM(ss.session_key)
						WHEN ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN 'project:' || TRIM(ss.project)
						WHEN ss.session_key IS NOT NULL AND TRIM(ss.session_key) != '' THEN 'session:' || TRIM(ss.session_key)
						ELSE 'thread:unscoped'
					END ||
					CASE
						WHEN ss.harness IS NOT NULL AND TRIM(ss.harness) != '' THEN '|harness:' || TRIM(ss.harness)
						ELSE ''
					END
			END AS thread_key,
			CASE
				WHEN ss.source_ref IS NOT NULL AND TRIM(ss.source_ref) != '' AND ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN
					'project:' || TRIM(ss.project) || '#source:' || TRIM(ss.source_ref)
				WHEN ss.source_ref IS NOT NULL AND TRIM(ss.source_ref) != '' THEN 'source:' || TRIM(ss.source_ref)
				WHEN ss.session_key IS NOT NULL AND TRIM(ss.session_key) != '' AND ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN
					'project:' || TRIM(ss.project) || '#session:' || TRIM(ss.session_key)
				WHEN ss.project IS NOT NULL AND TRIM(ss.project) != '' THEN 'project:' || TRIM(ss.project)
				WHEN ss.session_key IS NOT NULL AND TRIM(ss.session_key) != '' THEN 'session:' || TRIM(ss.session_key)
				WHEN ss.harness IS NOT NULL AND TRIM(ss.harness) != '' THEN 'harness:' || TRIM(ss.harness)
				ELSE 'thread:unscoped'
			END AS label,
			ss.project,
			ss.session_key,
			COALESCE(ss.source_type, ss.kind, 'summary') AS source_type,
			ss.source_ref,
			ss.harness,
			ss.id AS node_id,
			ss.latest_at,
			SUBSTR(REPLACE(REPLACE(TRIM(ss.content), CHAR(10), ' '), CHAR(13), ' '), 1, 240) AS sample,
			ss.latest_at AS updated_at
		FROM (
			SELECT
				s0.*,
				ROW_NUMBER() OVER (
					PARTITION BY s0.agent_id,
					CASE
						WHEN s0.harness IS NOT NULL AND TRIM(s0.harness) != ''
								AND (s0.project IS NULL OR TRIM(s0.project) = '')
								AND (s0.source_ref IS NULL OR TRIM(s0.source_ref) = '')
								AND (s0.session_key IS NULL OR TRIM(s0.session_key) = '')
							THEN 'harness:' || TRIM(s0.harness)
						ELSE
							CASE
								WHEN s0.source_ref IS NOT NULL AND TRIM(s0.source_ref) != '' AND s0.project IS NOT NULL AND TRIM(s0.project) != '' THEN
									'project:' || TRIM(s0.project) || '|source:' || TRIM(s0.source_ref)
								WHEN s0.source_ref IS NOT NULL AND TRIM(s0.source_ref) != '' THEN 'source:' || TRIM(s0.source_ref)
								WHEN s0.session_key IS NOT NULL AND TRIM(s0.session_key) != '' AND s0.project IS NOT NULL AND TRIM(s0.project) != '' THEN
									'project:' || TRIM(s0.project) || '|session:' || TRIM(s0.session_key)
								WHEN s0.project IS NOT NULL AND TRIM(s0.project) != '' THEN 'project:' || TRIM(s0.project)
								WHEN s0.session_key IS NOT NULL AND TRIM(s0.session_key) != '' THEN 'session:' || TRIM(s0.session_key)
								ELSE 'thread:unscoped'
							END ||
							CASE
								WHEN s0.harness IS NOT NULL AND TRIM(s0.harness) != '' THEN '|harness:' || TRIM(s0.harness)
								ELSE ''
							END
					END
					ORDER BY s0.latest_at DESC, s0.created_at DESC
				) AS rn
			FROM session_summaries s0
			WHERE COALESCE(s0.source_type, s0.kind) != 'chunk'
		) ss
		WHERE ss.rn = 1
		ON CONFLICT(agent_id, thread_key) DO UPDATE SET
			label = excluded.label,
			project = excluded.project,
			session_key = excluded.session_key,
			source_type = excluded.source_type,
			source_ref = excluded.source_ref,
			harness = excluded.harness,
			node_id = excluded.node_id,
			latest_at = excluded.latest_at,
			sample = excluded.sample,
			updated_at = excluded.updated_at
		WHERE excluded.latest_at >= memory_thread_heads.latest_at;
	`);
}
function up492(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_extract_cursors (
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			last_offset INTEGER NOT NULL DEFAULT 0,
			last_extract_at TEXT NOT NULL,
			PRIMARY KEY (session_key, agent_id)
		);
	`);
}
function hasTable3(db, name) {
  return db.prepare(`SELECT name
			 FROM sqlite_master
			 WHERE type = 'table' AND name = ?
			 LIMIT 1`).get(name) !== undefined;
}
function up502(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS entity_dependency_history (
			id                TEXT PRIMARY KEY,
			dependency_id     TEXT NOT NULL,
			source_entity_id  TEXT NOT NULL,
			target_entity_id  TEXT NOT NULL,
			agent_id          TEXT NOT NULL DEFAULT 'default',
			dependency_type   TEXT NOT NULL,
			event             TEXT NOT NULL,
			changed_by        TEXT NOT NULL,
			reason            TEXT NOT NULL,
			previous_reason   TEXT,
			metadata          TEXT,
			created_at        TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_entity_dependency_history_dep
			ON entity_dependency_history(dependency_id);
		CREATE INDEX IF NOT EXISTS idx_entity_dependency_history_agent
			ON entity_dependency_history(agent_id);
		CREATE INDEX IF NOT EXISTS idx_entity_dependency_history_created
			ON entity_dependency_history(created_at DESC);
	`);
  if (!hasTable3(db, "entity_dependencies"))
    return;
  db.exec("DROP TRIGGER IF EXISTS trg_entity_dependencies_related_to_reason_insert");
  db.exec("DROP TRIGGER IF EXISTS trg_entity_dependencies_related_to_reason_update");
  db.exec("DROP TRIGGER IF EXISTS trg_entity_dependencies_audit_insert");
  db.exec("DROP TRIGGER IF EXISTS trg_entity_dependencies_audit_update");
  db.exec("DROP TRIGGER IF EXISTS trg_entity_dependencies_audit_delete");
  db.exec(`
		CREATE TRIGGER trg_entity_dependencies_related_to_reason_insert
		BEFORE INSERT ON entity_dependencies
		FOR EACH ROW
		WHEN NEW.dependency_type = 'related_to'
		  AND (NEW.reason IS NULL OR length(trim(NEW.reason)) = 0)
		BEGIN
			SELECT RAISE(ABORT, 'related_to dependencies require a non-empty reason');
		END;
	`);
  db.exec(`
		CREATE TRIGGER trg_entity_dependencies_related_to_reason_update
		BEFORE UPDATE OF dependency_type, reason ON entity_dependencies
		FOR EACH ROW
		WHEN NEW.dependency_type = 'related_to'
		  AND (NEW.reason IS NULL OR length(trim(NEW.reason)) = 0)
		BEGIN
			SELECT RAISE(ABORT, 'related_to dependencies require a non-empty reason');
		END;
	`);
  db.exec(`
		CREATE TRIGGER trg_entity_dependencies_audit_insert
		AFTER INSERT ON entity_dependencies
		FOR EACH ROW
		BEGIN
			INSERT INTO entity_dependency_history (
				id, dependency_id, source_entity_id, target_entity_id, agent_id,
				dependency_type, event, changed_by, reason, previous_reason,
				metadata, created_at
			) VALUES (
				lower(hex(randomblob(16))),
				NEW.id,
				NEW.source_entity_id,
				NEW.target_entity_id,
				NEW.agent_id,
				NEW.dependency_type,
				'created',
				'db-trigger',
				COALESCE(NEW.reason, 'created without reason'),
				NULL,
				'{"source":"trg_entity_dependencies_audit_insert"}',
				datetime('now')
			);
		END;
	`);
  db.exec(`
		CREATE TRIGGER trg_entity_dependencies_audit_update
		AFTER UPDATE ON entity_dependencies
		FOR EACH ROW
		BEGIN
			INSERT INTO entity_dependency_history (
				id, dependency_id, source_entity_id, target_entity_id, agent_id,
				dependency_type, event, changed_by, reason, previous_reason,
				metadata, created_at
			) VALUES (
				lower(hex(randomblob(16))),
				NEW.id,
				NEW.source_entity_id,
				NEW.target_entity_id,
				NEW.agent_id,
				NEW.dependency_type,
				'updated',
				'db-trigger',
				COALESCE(NEW.reason, 'updated without reason'),
				OLD.reason,
				'{"source":"trg_entity_dependencies_audit_update"}',
				datetime('now')
			);
		END;
	`);
  db.exec(`
		CREATE TRIGGER trg_entity_dependencies_audit_delete
		AFTER DELETE ON entity_dependencies
		FOR EACH ROW
		BEGIN
			INSERT INTO entity_dependency_history (
				id, dependency_id, source_entity_id, target_entity_id, agent_id,
				dependency_type, event, changed_by, reason, previous_reason,
				metadata, created_at
			) VALUES (
				lower(hex(randomblob(16))),
				OLD.id,
				OLD.source_entity_id,
				OLD.target_entity_id,
				OLD.agent_id,
				OLD.dependency_type,
				'deleted',
				'db-trigger',
				COALESCE(OLD.reason, 'deleted without reason'),
				NULL,
				'{"source":"trg_entity_dependencies_audit_delete"}',
				datetime('now')
			);
		END;
	`);
  db.exec(`
		INSERT INTO entity_dependency_history (
			id, dependency_id, source_entity_id, target_entity_id, agent_id,
			dependency_type, event, changed_by, reason, previous_reason,
			metadata, created_at
		)
		SELECT
			lower(hex(randomblob(16))),
			d.id,
			d.source_entity_id,
			d.target_entity_id,
			d.agent_id,
			d.dependency_type,
			'backfill',
			'migration-050',
			CASE
				WHEN d.reason IS NULL OR length(trim(d.reason)) = 0
					THEN 'legacy dependency without recorded reason'
				ELSE d.reason
			END,
			NULL,
			'{"source":"migration-050"}',
			datetime('now')
		FROM entity_dependencies d
		WHERE NOT EXISTS (
			SELECT 1
			FROM entity_dependency_history h
			WHERE h.dependency_id = d.id
			  AND h.event = 'backfill'
		  )
	`);
  db.exec(`
		UPDATE entity_dependencies
		SET reason = 'legacy-unattributed related_to edge'
		WHERE dependency_type = 'related_to'
		  AND (reason IS NULL OR length(trim(reason)) = 0)
	`);
}
function addColumnIfMissing152(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function up512(db) {
  addColumnIfMissing152(db, "summary_jobs", "session_id", "TEXT");
  addColumnIfMissing152(db, "summary_jobs", "trigger", "TEXT NOT NULL DEFAULT 'session_end'");
  addColumnIfMissing152(db, "summary_jobs", "captured_at", "TEXT");
  addColumnIfMissing152(db, "summary_jobs", "started_at", "TEXT");
  addColumnIfMissing152(db, "summary_jobs", "ended_at", "TEXT");
  db.exec(`
		UPDATE summary_jobs
		SET
			session_id = COALESCE(session_id, session_key, id),
			trigger = COALESCE(NULLIF(trigger, ''), 'session_end'),
			captured_at = COALESCE(captured_at, completed_at, created_at),
			ended_at = COALESCE(ended_at, completed_at)
		WHERE 1 = 1;

		CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent_trigger
			ON summary_jobs(agent_id, trigger, created_at);
		CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent_session
			ON summary_jobs(agent_id, session_key, created_at);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_artifacts (
			agent_id TEXT NOT NULL DEFAULT 'default',
			source_path TEXT NOT NULL,
			source_sha256 TEXT NOT NULL,
			source_kind TEXT NOT NULL,
			session_id TEXT NOT NULL,
			session_key TEXT,
			session_token TEXT NOT NULL,
			project TEXT,
			harness TEXT,
			captured_at TEXT NOT NULL,
			started_at TEXT,
			ended_at TEXT,
			manifest_path TEXT,
			source_node_id TEXT,
			memory_sentence TEXT,
			memory_sentence_quality TEXT,
			content TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, source_path)
		);

		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_kind
			ON memory_artifacts(agent_id, source_kind, captured_at DESC);
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_session
			ON memory_artifacts(agent_id, session_token, captured_at DESC);
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_membership
			ON memory_artifacts(agent_id, COALESCE(ended_at, captured_at) DESC);

		CREATE TABLE IF NOT EXISTS memory_artifact_tombstones (
			agent_id TEXT NOT NULL DEFAULT 'default',
			session_token TEXT NOT NULL,
			removed_at TEXT NOT NULL,
			reason TEXT NOT NULL,
			removed_paths TEXT NOT NULL,
			PRIMARY KEY (agent_id, session_token)
		);
	`);
  db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_artifacts_fts USING fts5(
			content,
			source_path,
			content='memory_artifacts',
			content_rowid='rowid'
		)
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_artifacts_fts_ai AFTER INSERT ON memory_artifacts BEGIN
			INSERT INTO memory_artifacts_fts(rowid, content, source_path)
			VALUES (new.rowid, new.content, new.source_path);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_artifacts_fts_ad AFTER DELETE ON memory_artifacts BEGIN
			INSERT INTO memory_artifacts_fts(memory_artifacts_fts, rowid, content, source_path)
			VALUES ('delete', old.rowid, old.content, old.source_path);
		END
	`);
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_artifacts_fts_au AFTER UPDATE ON memory_artifacts BEGIN
			INSERT INTO memory_artifacts_fts(memory_artifacts_fts, rowid, content, source_path)
			VALUES ('delete', old.rowid, old.content, old.source_path);
			INSERT INTO memory_artifacts_fts(rowid, content, source_path)
			VALUES (new.rowid, new.content, new.source_path);
		END
	`);
  db.exec(`
		INSERT INTO memory_artifacts_fts(memory_artifacts_fts)
		VALUES ('rebuild');
	`);
}
function up522(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS mcp_invocations (
			id          TEXT PRIMARY KEY,
			server_id   TEXT NOT NULL,
			tool_name   TEXT NOT NULL,
			agent_id    TEXT NOT NULL DEFAULT 'default',
			source      TEXT NOT NULL CHECK(source IN ('cli','agent','mcp','dashboard')),
			latency_ms  INTEGER NOT NULL,
			success     INTEGER NOT NULL DEFAULT 1,
			error_text  TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_mcp_inv_server ON mcp_invocations(server_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_mcp_inv_agent ON mcp_invocations(agent_id, created_at);
	`);
}
function up532(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS skill_invocations (
			id          TEXT PRIMARY KEY,
			skill_name  TEXT NOT NULL,
			agent_id    TEXT NOT NULL DEFAULT 'default',
			source      TEXT NOT NULL CHECK(source IN ('agent','scheduler','api')),
			latency_ms  INTEGER NOT NULL,
			success     INTEGER NOT NULL DEFAULT 1,
			error_text  TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_skill_inv_name ON skill_invocations(skill_name, created_at);
		CREATE INDEX IF NOT EXISTS idx_skill_inv_agent ON skill_invocations(agent_id, created_at);
	`);
}
function up542(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS task_scope_hints (
			task_id     TEXT PRIMARY KEY REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
			agent_id    TEXT NOT NULL DEFAULT 'default',
			created_at  TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
		);

		INSERT INTO task_scope_hints (task_id, agent_id, created_at, updated_at)
		SELECT st.id,
		       MIN(sm.agent_id),
		       datetime('now'),
		       datetime('now')
		  FROM scheduled_tasks st
		  JOIN entities e
		    ON e.entity_type = 'skill'
		   AND lower(e.name) = lower(st.skill_name)
		  JOIN skill_meta sm
		    ON sm.entity_id = e.id
		   AND sm.agent_id = e.agent_id
		   AND sm.uninstalled_at IS NULL
		 WHERE st.skill_name IS NOT NULL
		 GROUP BY st.id, lower(st.skill_name)
		HAVING COUNT(DISTINCT sm.agent_id) = 1
		ON CONFLICT(task_id) DO NOTHING;

		CREATE INDEX IF NOT EXISTS idx_task_scope_hints_agent
			ON task_scope_hints(agent_id, updated_at);
	`);
}
function up552(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_state (
			agent_id TEXT PRIMARY KEY NOT NULL,
			tokens_since_last_pass INTEGER NOT NULL DEFAULT 0,
			consecutive_failures INTEGER NOT NULL DEFAULT 0,
			last_pass_at TEXT,
			last_pass_id TEXT,
			last_pass_mode TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_passes (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			mode TEXT NOT NULL DEFAULT 'incremental',
			status TEXT NOT NULL DEFAULT 'running',
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			completed_at TEXT,
			tokens_consumed INTEGER,
			mutations_applied INTEGER,
			mutations_skipped INTEGER,
			mutations_failed INTEGER,
			summary TEXT,
			error TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_dreaming_passes_agent
		ON dreaming_passes (agent_id, created_at DESC);
	`);
}
function ensureMemoriesScopeColumns3(db) {
  const cols = db.prepare("PRAGMA table_info(memories)").all();
  const names = new Set(cols.map((col) => col.name).filter((name) => typeof name === "string"));
  if (!names.has("agent_id"))
    db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT DEFAULT 'default'");
  if (!names.has("scope"))
    db.exec("ALTER TABLE memories ADD COLUMN scope TEXT");
}
function up562(db) {
  ensureMemoriesScopeColumns3(db);
  db.exec("DROP INDEX IF EXISTS idx_memories_content_hash_unique");
  db.exec(`
		CREATE UNIQUE INDEX idx_memories_content_hash_unique
		ON memories(
			content_hash,
			COALESCE(NULLIF(agent_id, ''), 'default'),
			COALESCE(scope, '__NULL__')
		)
		WHERE content_hash IS NOT NULL AND is_deleted = 0
	`);
}
function up572(db) {
  const sql = readMemoriesFtsSql2(db);
  if (sql !== null && !memoriesFtsNeedsTokenizerRepair2(sql))
    return;
  recreateMemoriesFts2(db);
}
function up582(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_order
			ON entities(agent_id, pinned DESC, pinned_at DESC, mentions DESC, updated_at DESC, name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_extracted_mentions
			ON entities(entity_type, mentions)
			WHERE entity_type = 'extracted'`);
}
function up592(db) {
  const cols = db.prepare("PRAGMA table_info(entity_attributes)").all();
  if (!cols.some((col) => col.name === "claim_key")) {
    db.exec("ALTER TABLE entity_attributes ADD COLUMN claim_key TEXT");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_attributes_claim_key
			ON entity_attributes(agent_id, aspect_id, claim_key, status)
			WHERE claim_key IS NOT NULL`);
}
function up602(db) {
  const cols = db.prepare("PRAGMA table_info(entity_attributes)").all();
  if (!cols.some((col) => col.name === "group_key")) {
    db.exec("ALTER TABLE entity_attributes ADD COLUMN group_key TEXT");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_attributes_group_key
			ON entity_attributes(agent_id, aspect_id, group_key, status)
			WHERE group_key IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_attributes_group_claim
			ON entity_attributes(agent_id, aspect_id, group_key, claim_key, status)
			WHERE claim_key IS NOT NULL`);
}
function up612(db) {
  const cols = db.prepare("PRAGMA table_info(memory_artifacts)").all();
  if (cols.some((col) => col.name === "source_mtime_ms"))
    return;
  db.exec("ALTER TABLE memory_artifacts ADD COLUMN source_mtime_ms REAL");
}
function up622(db) {
  const cols = db.prepare("PRAGMA table_info(memory_artifacts)").all();
  const names = new Set(cols.map((col) => col.name));
  if (!names.has("is_deleted")) {
    db.exec("ALTER TABLE memory_artifacts ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("deleted_at")) {
    db.exec("ALTER TABLE memory_artifacts ADD COLUMN deleted_at TEXT");
  }
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_deleted
			ON memory_artifacts(agent_id, is_deleted, deleted_at)
	`);
}
function up632(db) {
  db.exec("DROP TRIGGER IF EXISTS memories_au");
  db.exec(`
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
			INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
	`);
}
function hasColumn62(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}
function addColumnIfMissing162(db, table, column, definition) {
  if (!hasColumn62(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up642(db) {
  for (const table of ["entities", "entity_communities", "entity_attributes", "entity_dependencies"]) {
    addColumnIfMissing162(db, table, "source_id", "TEXT");
    addColumnIfMissing162(db, table, "source_kind", "TEXT");
    addColumnIfMissing162(db, table, "source_path", "TEXT");
    addColumnIfMissing162(db, table, "source_root", "TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(agent_id, source_id, source_path)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entity_communities_source ON entity_communities(agent_id, source_id, source_path)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entity_attributes_source ON entity_attributes(agent_id, source_id, source_path)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entity_dependencies_source_origin ON entity_dependencies(agent_id, source_id, source_path)");
}
function hasTable22(db, table) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  return row?.name === table;
}
function hasColumn72(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}
function up652(db) {
  if (!hasTable22(db, "embeddings"))
    return;
  if (!hasColumn72(db, "embeddings", "agent_id")) {
    db.exec("ALTER TABLE embeddings ADD COLUMN agent_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_embeddings_agent_source ON embeddings(agent_id, source_type, source_id)");
}
function up662(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS memory_search_telemetry (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL,
			route TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			session_key TEXT,
			project TEXT,
			query TEXT NOT NULL,
			keyword_query TEXT,
			filters_json TEXT NOT NULL,
			method TEXT NOT NULL,
			result_count INTEGER NOT NULL,
			top_score REAL,
			no_hits INTEGER NOT NULL DEFAULT 0,
			duration_ms REAL NOT NULL DEFAULT 0,
			timings_json TEXT NOT NULL,
			results_json TEXT NOT NULL,
			sources_json TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_memory_search_telemetry_agent_time
			ON memory_search_telemetry(agent_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_memory_search_telemetry_session
			ON memory_search_telemetry(session_key) WHERE session_key IS NOT NULL;
		CREATE INDEX IF NOT EXISTS idx_memory_search_telemetry_route_time
			ON memory_search_telemetry(route, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_memory_search_telemetry_no_hits
			ON memory_search_telemetry(no_hits, created_at DESC);
	`);
}
function hasColumn82(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}
function addColumnIfMissing172(db, table, column, definition) {
  if (!hasColumn82(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function up672(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS ontology_proposals (
			id          TEXT PRIMARY KEY,
			agent_id    TEXT NOT NULL DEFAULT 'default',
			operation   TEXT NOT NULL,
			status      TEXT NOT NULL DEFAULT 'pending'
				CHECK (status IN ('pending', 'applied', 'rejected', 'failed')),
			payload     TEXT NOT NULL,
			confidence  REAL NOT NULL DEFAULT 0.0
				CHECK (confidence >= 0.0 AND confidence <= 1.0),
			rationale   TEXT NOT NULL DEFAULT '',
			evidence    TEXT NOT NULL DEFAULT '[]',
			risk        TEXT,
			source_kind TEXT,
			source_id   TEXT,
			source_path TEXT,
			source_root TEXT,
			created_by  TEXT NOT NULL DEFAULT 'ontology-proposal',
			applied_by  TEXT,
			rejected_by TEXT,
			result      TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
			applied_at  TEXT,
			rejected_at TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_ontology_proposals_agent_status
			ON ontology_proposals(agent_id, status, updated_at DESC);

		CREATE INDEX IF NOT EXISTS idx_ontology_proposals_agent_operation
			ON ontology_proposals(agent_id, operation, updated_at DESC);

		CREATE INDEX IF NOT EXISTS idx_ontology_proposals_source
			ON ontology_proposals(agent_id, source_kind, source_id);
	`);
  for (const table of ["entity_attributes", "entity_dependencies"]) {
    addColumnIfMissing172(db, table, "proposal_id", "TEXT");
    addColumnIfMissing172(db, table, "proposal_evidence", "TEXT NOT NULL DEFAULT '[]'");
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_proposal ON ${table}(agent_id, proposal_id)`);
  }
}
function up682(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS daily_reflections (
			id               TEXT PRIMARY KEY,
			agent_id         TEXT NOT NULL DEFAULT 'default',
			date             TEXT NOT NULL,
			summary          TEXT NOT NULL DEFAULT '',
			patterns         TEXT NOT NULL DEFAULT '[]',
			question         TEXT,
			answer           TEXT,
			answer_memory_id TEXT,
			content_key      TEXT,
			memory_ids       TEXT NOT NULL DEFAULT '[]',
			summary_ids      TEXT NOT NULL DEFAULT '[]',
			model            TEXT,
			created_at       TEXT NOT NULL DEFAULT (datetime('now')),
			answered_at      TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_date
			ON daily_reflections(agent_id, date, created_at DESC);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_reflections_agent_content_key
			ON daily_reflections(agent_id, date, content_key)
			WHERE content_key IS NOT NULL;
	`);
}
function up692(db) {
  const cols = db.prepare("PRAGMA table_info(daily_reflections)").all();
  const colNames = new Set(cols.flatMap((c) => typeof c.name === "string" ? [c.name] : []));
  if (!colNames.has("content_key")) {
    db.exec("ALTER TABLE daily_reflections ADD COLUMN content_key TEXT");
  }
  db.exec(`
		DROP INDEX IF EXISTS idx_daily_reflections_agent_date;
		DROP INDEX IF EXISTS idx_daily_reflections_agent_content_key;

		CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_created
			ON daily_reflections(agent_id, created_at DESC);

		CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_date
			ON daily_reflections(agent_id, date, created_at DESC);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_reflections_agent_content_key
			ON daily_reflections(agent_id, date, content_key)
			WHERE content_key IS NOT NULL;
	`);
}
function hasColumn92(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}
function addColumnIfMissing182(db, table, column, definition) {
  if (!hasColumn92(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function backfillVersionRoots2(db) {
  db.exec(`
		UPDATE entity_attributes
		SET version_root_id = id
		WHERE version_root_id IS NULL
	`);
}
function up702(db) {
  for (const table of ["entities", "entity_aspects", "entity_dependencies"]) {
    addColumnIfMissing182(db, table, "status", "TEXT NOT NULL DEFAULT 'active'");
    addColumnIfMissing182(db, table, "archived_at", "TEXT");
    addColumnIfMissing182(db, table, "archived_by", "TEXT");
    addColumnIfMissing182(db, table, "archive_reason", "TEXT");
  }
  for (const table of ["entities", "entity_aspects"]) {
    addColumnIfMissing182(db, table, "proposal_id", "TEXT");
    addColumnIfMissing182(db, table, "proposal_evidence", "TEXT NOT NULL DEFAULT '[]'");
  }
  addColumnIfMissing182(db, "entity_attributes", "version", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing182(db, "entity_attributes", "version_root_id", "TEXT");
  addColumnIfMissing182(db, "entity_attributes", "previous_attribute_id", "TEXT");
  addColumnIfMissing182(db, "entity_attributes", "archived_at", "TEXT");
  addColumnIfMissing182(db, "entity_attributes", "archived_by", "TEXT");
  addColumnIfMissing182(db, "entity_attributes", "archive_reason", "TEXT");
  backfillVersionRoots2(db);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_entities_status
			ON entities(agent_id, status, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_entity_aspects_status
			ON entity_aspects(agent_id, entity_id, status);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_version_root
			ON entity_attributes(agent_id, version_root_id, version DESC);
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_claim_version
			ON entity_attributes(agent_id, aspect_id, group_key, claim_key, version DESC);
		CREATE INDEX IF NOT EXISTS idx_entity_dependencies_status
			ON entity_dependencies(agent_id, status, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_entities_proposal
			ON entities(agent_id, proposal_id);
		CREATE INDEX IF NOT EXISTS idx_entity_aspects_proposal
			ON entity_aspects(agent_id, proposal_id);
	`);
}
function up712(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS epistemic_assertions (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL DEFAULT 'default',
			subject_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			claim_attribute_id TEXT REFERENCES entity_attributes(id) ON DELETE SET NULL,
			predicate TEXT NOT NULL CHECK (
				predicate IN ('claims', 'believes', 'observed', 'decided', 'prefers', 'denies', 'questions')
			),
			content TEXT NOT NULL,
			normalized_content TEXT NOT NULL,
			speaker TEXT,
			asserted_at TEXT NOT NULL,
			confidence REAL NOT NULL DEFAULT 0.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
			evidence TEXT NOT NULL DEFAULT '[]',
			source_kind TEXT,
			source_id TEXT,
			source_path TEXT,
			source_root TEXT,
			status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'superseded')),
			supersedes_assertion_id TEXT REFERENCES epistemic_assertions(id) ON DELETE SET NULL,
			archived_at TEXT,
			archived_by TEXT,
			archive_reason TEXT,
			created_by TEXT NOT NULL DEFAULT 'operator',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_agent_entity
			ON epistemic_assertions(agent_id, subject_entity_id, status, asserted_at DESC);
		CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_agent_speaker
			ON epistemic_assertions(agent_id, speaker, asserted_at DESC);
		CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_agent_predicate
			ON epistemic_assertions(agent_id, predicate, status, asserted_at DESC);
		CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_agent_source
			ON epistemic_assertions(agent_id, source_kind, source_id);
		CREATE INDEX IF NOT EXISTS idx_epistemic_assertions_claim
			ON epistemic_assertions(agent_id, claim_attribute_id);
	`);
}
function ensureMemoriesScopeColumns22(db) {
  const cols = db.prepare("PRAGMA table_info(memories)").all();
  const names = new Set(cols.map((col) => col.name).filter((name) => typeof name === "string"));
  if (!names.has("agent_id"))
    db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT DEFAULT 'default'");
  if (!names.has("visibility"))
    db.exec("ALTER TABLE memories ADD COLUMN visibility TEXT DEFAULT 'global'");
  if (!names.has("scope"))
    db.exec("ALTER TABLE memories ADD COLUMN scope TEXT");
  if (!names.has("idempotency_key"))
    db.exec("ALTER TABLE memories ADD COLUMN idempotency_key TEXT");
  if (!names.has("runtime_path"))
    db.exec("ALTER TABLE memories ADD COLUMN runtime_path TEXT");
}
function up722(db) {
  ensureMemoriesScopeColumns22(db);
  db.exec("DROP INDEX IF EXISTS idx_memories_idempotency_key");
  db.exec(`
		CREATE UNIQUE INDEX idx_memories_idempotency_key
		ON memories(
			idempotency_key,
			COALESCE(NULLIF(agent_id, ''), 'default'),
			COALESCE(visibility, 'global'),
			COALESCE(scope, '__NULL__')
		)
		WHERE idempotency_key IS NOT NULL AND is_deleted = 0
	`);
}
function up732(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS session_context_epochs (
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			context_epoch INTEGER NOT NULL DEFAULT 0,
			reason TEXT NOT NULL,
			source_ref TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (session_key, agent_id, context_epoch)
		);

		CREATE INDEX IF NOT EXISTS idx_session_context_epochs_created
			ON session_context_epochs(agent_id, created_at DESC);

		CREATE TABLE IF NOT EXISTS session_recall_events (
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			context_epoch INTEGER NOT NULL DEFAULT 0,
			item_kind TEXT NOT NULL,
			item_id TEXT NOT NULL,
			surface TEXT NOT NULL,
			mode TEXT NOT NULL,
			score REAL,
			source TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (session_key, agent_id, context_epoch, item_kind, item_id)
		);

		CREATE INDEX IF NOT EXISTS idx_session_recall_events_session
			ON session_recall_events(session_key, agent_id, context_epoch, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_session_recall_events_item
			ON session_recall_events(item_kind, item_id, created_at DESC);
	`);
}
function up742(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS aggregate_memory_sources (
			aggregate_memory_id TEXT NOT NULL,
			source_memory_id TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL,
			PRIMARY KEY (aggregate_memory_id, source_memory_id)
		);
		CREATE INDEX IF NOT EXISTS idx_aggregate_memory_sources_agent
			ON aggregate_memory_sources(agent_id, aggregate_memory_id);
	`);
}
function addColumnIfMissing192(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column))
    return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function up752(db) {
  addColumnIfMissing192(db, "memory_artifacts", "source_id", "TEXT");
  addColumnIfMissing192(db, "memory_artifacts", "source_root", "TEXT");
  addColumnIfMissing192(db, "memory_artifacts", "source_external_id", "TEXT");
  addColumnIfMissing192(db, "memory_artifacts", "source_parent_path", "TEXT");
  addColumnIfMissing192(db, "memory_artifacts", "source_meta_json", "TEXT");
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_source
			ON memory_artifacts(agent_id, source_id, source_external_id);
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_source_root
			ON memory_artifacts(agent_id, source_id, source_root);
	`);
}
var MIGRATIONS2 = [
  {
    version: 1,
    name: "baseline",
    up: up76,
    artifacts: { tables: ["memories", "conversations", "embeddings"] }
  },
  {
    version: 2,
    name: "pipeline-v2",
    up: up210,
    artifacts: {
      tables: ["memory_history", "memory_jobs", "entities", "relations", "memory_entity_mentions"]
    }
  },
  {
    version: 3,
    name: "unique-content-hash",
    up: up310
  },
  {
    version: 4,
    name: "history-actor-and-retention",
    up: up410,
    artifacts: {
      columns: [{ table: "memory_history", column: "actor_type" }]
    }
  },
  {
    version: 5,
    name: "graph-extended",
    up: up510,
    artifacts: {
      columns: [{ table: "entities", column: "canonical_name" }]
    }
  },
  {
    version: 6,
    name: "idempotency-key",
    up: up610,
    artifacts: {
      columns: [{ table: "memories", column: "idempotency_key" }]
    }
  },
  {
    version: 7,
    name: "documents-and-connectors",
    up: up77,
    artifacts: { tables: ["documents", "document_memories", "connectors"] }
  },
  {
    version: 8,
    name: "embeddings-unique-hash",
    up: up82
  },
  {
    version: 9,
    name: "summary-jobs",
    up: up92,
    artifacts: { tables: ["summary_jobs"] }
  },
  {
    version: 10,
    name: "umap-cache",
    up: up102,
    artifacts: { tables: ["umap_cache"] }
  },
  {
    version: 11,
    name: "session-scores",
    up: up112,
    artifacts: { tables: ["session_scores"] }
  },
  {
    version: 12,
    name: "scheduled-tasks",
    up: up122,
    artifacts: { tables: ["scheduled_tasks", "task_runs"] }
  },
  {
    version: 13,
    name: "ingestion-tracking",
    up: up132,
    artifacts: {
      tables: ["ingestion_jobs"],
      columns: [
        { table: "memories", column: "source_path" },
        { table: "memories", column: "source_section" }
      ]
    }
  },
  {
    version: 14,
    name: "telemetry",
    up: up142,
    artifacts: { tables: ["telemetry_events"] }
  },
  {
    version: 15,
    name: "session-memories",
    up: up152,
    artifacts: {
      tables: ["session_memories"],
      columns: [
        { table: "session_scores", column: "confidence" },
        { table: "session_scores", column: "continuity_reasoning" }
      ]
    }
  },
  {
    version: 16,
    name: "session-checkpoints",
    up: up162,
    artifacts: { tables: ["session_checkpoints"] }
  },
  {
    version: 17,
    name: "task-skills",
    up: up172,
    artifacts: {
      columns: [{ table: "scheduled_tasks", column: "skill_name" }]
    }
  },
  {
    version: 18,
    name: "skill-meta",
    up: up182,
    artifacts: { tables: ["skill_meta"] }
  },
  {
    version: 19,
    name: "knowledge-structure",
    up: up192,
    artifacts: {
      tables: ["entity_aspects", "entity_attributes", "entity_dependencies", "task_meta"],
      columns: [{ table: "entities", column: "agent_id" }]
    }
  },
  {
    version: 20,
    name: "session-structural-columns",
    up: up202,
    artifacts: {
      columns: [
        { table: "session_memories", column: "entity_slot" },
        { table: "session_memories", column: "aspect_slot" },
        { table: "session_memories", column: "is_constraint" },
        { table: "session_memories", column: "structural_density" }
      ]
    }
  },
  {
    version: 21,
    name: "checkpoint-structural",
    up: up212,
    artifacts: {
      columns: [{ table: "session_checkpoints", column: "focal_entity_ids" }]
    }
  },
  {
    version: 22,
    name: "entity-pinning",
    up: up222,
    artifacts: {
      columns: [
        { table: "entities", column: "pinned" },
        { table: "entities", column: "pinned_at" }
      ]
    }
  },
  {
    version: 23,
    name: "retired-scorer-gap",
    up: up232
  },
  {
    version: 24,
    name: "retired-scorer-gap",
    up: up242
  },
  {
    version: 25,
    name: "agent-feedback",
    up: up252,
    artifacts: {
      columns: [{ table: "session_memories", column: "agent_relevance_score" }]
    }
  },
  {
    version: 26,
    name: "retired-scorer-gap",
    up: up262
  },
  {
    version: 27,
    name: "backfill-canonical-names",
    up: up272
  },
  {
    version: 28,
    name: "lossless-retention",
    up: up282
  },
  {
    version: 29,
    name: "session-summary-dag",
    up: up292
  },
  {
    version: 30,
    name: "nullable-memory-job-memory-id",
    up: up302
  },
  {
    version: 31,
    name: "dependency-reason",
    up: up312,
    artifacts: {
      columns: [
        { table: "entity_dependencies", column: "reason" },
        { table: "entities", column: "last_synthesized_at" }
      ]
    }
  },
  {
    version: 32,
    name: "embeddings-vector-column",
    up: up322,
    artifacts: {
      columns: [{ table: "embeddings", column: "vector", optional: true }]
    }
  },
  {
    version: 33,
    name: "scope",
    up: up332,
    artifacts: {
      columns: [{ table: "memories", column: "scope" }]
    }
  },
  {
    version: 34,
    name: "scope-aware-dedup",
    up: up342
  },
  {
    version: 35,
    name: "entity-fts",
    up: up352
  },
  {
    version: 36,
    name: "dependency-confidence",
    up: up362,
    artifacts: {
      columns: [{ table: "entity_dependencies", column: "confidence" }]
    }
  },
  {
    version: 37,
    name: "entity-communities",
    up: up372,
    artifacts: {
      tables: ["entity_communities"],
      columns: [{ table: "entities", column: "community_id" }]
    }
  },
  {
    version: 38,
    name: "memory-hints",
    up: up382,
    artifacts: { tables: ["memory_hints"] }
  },
  {
    version: 39,
    name: "dedup-entity-dependencies",
    up: up392
  },
  {
    version: 40,
    name: "session-transcripts",
    up: up402,
    artifacts: { tables: ["session_transcripts"] }
  },
  {
    version: 41,
    name: "path-feedback",
    up: up412,
    artifacts: {
      tables: [
        "path_feedback_events",
        "path_feedback_stats",
        "entity_retrieval_stats",
        "entity_cooccurrence",
        "path_feedback_sessions"
      ],
      columns: [{ table: "session_memories", column: "path_json" }]
    }
  },
  {
    version: 42,
    name: "session-memories-agent-id",
    up: up422,
    artifacts: {
      columns: [{ table: "session_memories", column: "agent_id" }]
    }
  },
  {
    version: 43,
    name: "agents-table",
    up: up432,
    artifacts: {
      tables: ["agents"],
      columns: [
        { table: "memories", column: "agent_id" },
        { table: "memories", column: "visibility" }
      ]
    }
  },
  {
    version: 44,
    name: "memory-md-temporal-head",
    up: up442,
    artifacts: {
      columns: [
        { table: "session_summaries", column: "source_type" },
        { table: "session_summaries", column: "source_ref" },
        { table: "session_summaries", column: "meta_json" }
      ]
    }
  },
  {
    version: 45,
    name: "lossless-working-memory-hardening",
    up: up452,
    artifacts: {
      tables: ["session_transcripts_fts", "memory_md_heads"],
      columns: [
        { table: "session_transcripts", column: "updated_at" },
        { table: "summary_jobs", column: "agent_id" },
        { table: "session_scores", column: "agent_id" }
      ]
    }
  },
  {
    version: 46,
    name: "session-summary-uniqueness",
    up: up462
  },
  {
    version: 47,
    name: "agent-scoped-temporal-uniqueness",
    up: up472
  },
  {
    version: 48,
    name: "thread-heads",
    up: up482,
    artifacts: {
      tables: ["memory_thread_heads"]
    }
  },
  {
    version: 49,
    name: "session-extract-cursors",
    up: up492,
    artifacts: {
      tables: ["session_extract_cursors"]
    }
  },
  {
    version: 50,
    name: "related-to-audit",
    up: up502,
    artifacts: {
      tables: ["entity_dependency_history"]
    }
  },
  {
    version: 51,
    name: "memory-md-rolling-window-lineage",
    up: up512,
    artifacts: {
      tables: ["memory_artifacts", "memory_artifact_tombstones", "memory_artifacts_fts"],
      columns: [
        { table: "summary_jobs", column: "session_id" },
        { table: "summary_jobs", column: "trigger" },
        { table: "summary_jobs", column: "captured_at" },
        { table: "summary_jobs", column: "started_at" },
        { table: "summary_jobs", column: "ended_at" }
      ]
    }
  },
  {
    version: 52,
    name: "mcp-invocations",
    up: up522,
    artifacts: {
      tables: ["mcp_invocations"]
    }
  },
  {
    version: 53,
    name: "skill-invocations",
    up: up532,
    artifacts: {
      tables: ["skill_invocations"]
    }
  },
  {
    version: 54,
    name: "task-agent-scope",
    up: up542,
    artifacts: {
      tables: ["task_scope_hints"]
    }
  },
  {
    version: 55,
    name: "dreaming-state",
    up: up552,
    artifacts: {
      tables: ["dreaming_state", "dreaming_passes"]
    }
  },
  {
    version: 56,
    name: "agent-scoped-content-hash",
    up: up562
  },
  {
    version: 57,
    name: "memories-fts-tokenizer-repair",
    up: up572
  },
  {
    version: 58,
    name: "knowledge-graph-indices",
    up: up582
  },
  {
    version: 59,
    name: "entity-attribute-claim-key",
    up: up592,
    artifacts: {
      columns: [{ table: "entity_attributes", column: "claim_key" }]
    }
  },
  {
    version: 60,
    name: "entity-attribute-group-key",
    up: up602,
    artifacts: {
      columns: [{ table: "entity_attributes", column: "group_key" }]
    }
  },
  {
    version: 61,
    name: "memory-artifact-source-mtime",
    up: up612,
    artifacts: {
      columns: [{ table: "memory_artifacts", column: "source_mtime_ms" }]
    }
  },
  {
    version: 62,
    name: "memory-artifact-soft-delete",
    up: up622,
    artifacts: {
      columns: [
        { table: "memory_artifacts", column: "is_deleted" },
        { table: "memory_artifacts", column: "deleted_at" }
      ]
    }
  },
  {
    version: 63,
    name: "content-only-memories-fts-update",
    up: up632
  },
  {
    version: 64,
    name: "source-graph-provenance",
    up: up642,
    artifacts: {
      columns: [
        { table: "entities", column: "source_path" },
        { table: "entity_communities", column: "source_path" },
        { table: "entity_attributes", column: "source_path" },
        { table: "entity_dependencies", column: "source_path" }
      ]
    }
  },
  {
    version: 65,
    name: "source-embedding-agent-scope",
    up: up652,
    artifacts: {
      columns: [{ table: "embeddings", column: "agent_id", optional: true }]
    }
  },
  {
    version: 66,
    name: "memory-search-telemetry",
    up: up662,
    artifacts: {
      tables: ["memory_search_telemetry"]
    }
  },
  {
    version: 67,
    name: "ontology-proposals",
    up: up672,
    artifacts: {
      tables: ["ontology_proposals"],
      columns: [
        { table: "entity_attributes", column: "proposal_id" },
        { table: "entity_attributes", column: "proposal_evidence" },
        { table: "entity_dependencies", column: "proposal_id" },
        { table: "entity_dependencies", column: "proposal_evidence" }
      ]
    }
  },
  {
    version: 68,
    name: "daily-reflections",
    up: up682,
    artifacts: {
      tables: ["daily_reflections"]
    }
  },
  {
    version: 69,
    name: "daily-reflections-multiple-insights",
    up: up692,
    artifacts: {
      tables: ["daily_reflections"]
    }
  },
  {
    version: 70,
    name: "ontology-control-plane-state",
    up: up702,
    artifacts: {
      columns: [
        { table: "entities", column: "status" },
        { table: "entity_aspects", column: "status" },
        { table: "entity_attributes", column: "version" },
        { table: "entity_attributes", column: "version_root_id" },
        { table: "entity_attributes", column: "previous_attribute_id" },
        { table: "entity_dependencies", column: "status" }
      ]
    }
  },
  {
    version: 71,
    name: "epistemic-assertions",
    up: up712,
    artifacts: {
      tables: ["epistemic_assertions"]
    }
  },
  {
    version: 72,
    name: "agent-scoped-idempotency-key",
    up: up722,
    artifacts: {
      columns: [
        { table: "memories", column: "idempotency_key" },
        { table: "memories", column: "runtime_path" }
      ]
    }
  },
  {
    version: 73,
    name: "recall-context-dedupe",
    up: up732,
    artifacts: {
      tables: ["session_context_epochs", "session_recall_events"]
    }
  },
  {
    version: 74,
    name: "aggregate-memory-links",
    up: up742,
    artifacts: {
      tables: ["aggregate_memory_sources"]
    }
  },
  {
    version: 75,
    name: "memory-artifact-source-provenance",
    up: up752,
    artifacts: {
      columns: [
        { table: "memory_artifacts", column: "source_id" },
        { table: "memory_artifacts", column: "source_root" },
        { table: "memory_artifacts", column: "source_external_id" },
        { table: "memory_artifacts", column: "source_parent_path" },
        { table: "memory_artifacts", column: "source_meta_json" }
      ]
    }
  }
];
var LATEST_SCHEMA_VERSION2 = MIGRATIONS2[MIGRATIONS2.length - 1]?.version ?? 0;
var __filename22 = fileURLToPath2(import.meta.url);
var __dirname22 = dirname4(__filename22);
var import_yaml3 = __toESM2(require_dist2(), 1);
function expandHome(p, home2 = homedir2()) {
  if (p === "~")
    return home2;
  if (p.startsWith("~/") || p.startsWith("~\\"))
    return join22(home2, p.slice(2));
  return p;
}
var LOCAL_BINDS2 = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
var import_yaml22 = __toESM2(require_dist2(), 1);
var native2 = null;
try {
  const esmRequire = createRequire22(import.meta.url);
  native2 = esmRequire("@signet/native");
} catch {}
var SIGNET_SOURCE_CHECKOUT_DIRNAME2 = "signetai";
var SIGNET_GIT_PROTECTED_PATHS2 = [
  "memory/memories.db",
  "memory/memories.db-wal",
  "memory/memories.db-shm",
  "memory/memories.db-journal",
  `${SIGNET_SOURCE_CHECKOUT_DIRNAME2}/`
];
var DEFAULT_DISCORD_DESKTOP_CACHE_PATH2 = defaultDiscordDesktopCachePath2();
var DEFAULT_GITHUB_RESOURCE_TYPES2 = ["issues", "pulls", "discussions", "docs"];
var VALID_GITHUB_RESOURCE_TYPES2 = new Set(DEFAULT_GITHUB_RESOURCE_TYPES2);
function defaultDiscordDesktopCachePath2() {
  switch (platform22()) {
    case "darwin":
      return resolve32(homedir32(), "Library", "Application Support", "discord");
    case "win32":
      return resolve32(process.env.APPDATA || resolve32(homedir32(), "AppData", "Roaming"), "discord");
    default:
      return resolve32(process.env.XDG_CONFIG_HOME || resolve32(homedir32(), ".config"), "discord");
  }
}
var IDENTITY_FILES2 = {
  agents: {
    path: "AGENTS.md",
    description: "Operational rules and behavioral settings",
    optional: false
  },
  soul: {
    path: "SOUL.md",
    description: "Persona, character, and security settings",
    optional: false
  },
  identity: {
    path: "IDENTITY.md",
    description: "Agent name, creature type, and vibe",
    optional: false
  },
  user: {
    path: "USER.md",
    description: "User profile and preferences",
    optional: false
  },
  heartbeat: {
    path: "HEARTBEAT.md",
    description: "Heartbeat prompt used only for heartbeat/background check sessions",
    optional: true,
    context: "session",
    session: "heartbeat"
  },
  memory: {
    path: "MEMORY.md",
    description: "Memory index and summary",
    optional: true
  },
  tools: {
    path: "TOOLS.md",
    description: "Tool preferences and notes",
    optional: true
  },
  bootstrap: {
    path: "BOOTSTRAP.md",
    description: "Setup ritual (typically deleted after first run)",
    optional: true,
    context: "session",
    session: "bootstrap"
  },
  dreaming: {
    path: "DREAMING.md",
    description: "Dreaming/reflection prompt used only for dreaming sessions",
    optional: true,
    context: "session",
    session: "dreaming"
  }
};
var REQUIRED_IDENTITY_KEYS2 = Object.entries(IDENTITY_FILES2).filter(([, spec]) => !spec.optional).map(([key]) => key);
var OPTIONAL_IDENTITY_KEYS2 = Object.entries(IDENTITY_FILES2).filter(([, spec]) => spec.optional).map(([key]) => key);
function hasValidIdentity(basePath) {
  for (const key of REQUIRED_IDENTITY_KEYS2) {
    const spec = IDENTITY_FILES2[key];
    if (!existsSync10(join10(basePath, spec.path))) {
      return false;
    }
  }
  return true;
}
var home2 = homedir72();
var SKIP_SUBTYPES2 = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "pinned_item",
  "unpinned_item",
  "bot_add",
  "bot_remove",
  "tombstone",
  "file_comment",
  "sh_room_created",
  "sh_room_shared"
]);
var SKIP_TYPES2 = new Set([
  "RecipientAdd",
  "RecipientRemove",
  "ChannelNameChange",
  "ChannelIconChange",
  "ChannelPinnedMessage",
  "GuildMemberJoin",
  "UserPremiumGuildSubscription",
  "UserPremiumGuildSubscriptionTier1",
  "UserPremiumGuildSubscriptionTier2",
  "UserPremiumGuildSubscriptionTier3",
  "ChannelFollowAdd",
  "GuildDiscoveryDisqualified",
  "GuildDiscoveryRequalified",
  "GuildDiscoveryGracePeriodInitialWarning",
  "GuildDiscoveryGracePeriodFinalWarning",
  "ThreadCreated",
  "ApplicationCommand"
]);
var SKIP_DIRS2 = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "venv",
  ".venv",
  "env",
  "vendor",
  "coverage",
  ".cache",
  ".turbo"
]);
var DOCUMENT_VALID_TYPES2 = new Set([
  "fact",
  "decision",
  "rationale",
  "preference",
  "procedural",
  "semantic",
  "system",
  "configuration",
  "architectural",
  "relationship",
  "episodic",
  "daily-log"
]);
var ENTIRE_VALID_TYPES2 = new Set(["skill", "preference", "decision", "rationale", "procedural", "semantic", "fact"]);
var CHAT_VALID_TYPES2 = new Set(["fact", "decision", "rationale", "preference", "procedural", "semantic", "system"]);
var MARKDOWN_EXTS2 = new Set([".md", ".mdx", ".markdown"]);
var TXT_EXTS2 = new Set([".txt", ".text", ".log", ".rst"]);
var PDF_EXTS2 = new Set([".pdf"]);
var CODE_EXTS2 = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".yaml",
  ".yml",
  ".toml",
  ".json",
  ".xml",
  ".css",
  ".scss",
  ".html",
  ".htm"
]);
var SKIP_FILES2 = new Set([".DS_Store", "Thumbs.db", ".gitkeep", "node_modules", ".git", ".env", ".env.local"]);

// src/index.ts
var SIGNET_FORGE_MARKER = "Managed by Signet (@signet/connector-forge)";
function getHomeDir() {
  const home3 = process.env.HOME?.trim();
  return home3 && home3.length > 0 ? home3 : homedir();
}
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readJsonObject(path) {
  if (!existsSync2(path)) {
    return {};
  }
  const raw = readFileSync2(path, "utf-8");
  const parsed = JSON.parse(raw);
  if (!isJsonObject(parsed)) {
    throw new Error("Forge MCP config must be a top-level object");
  }
  return parsed;
}
function readMcpServers(config) {
  if (!("mcpServers" in config)) {
    return {};
  }
  const current = config.mcpServers;
  if (isJsonObject(current)) {
    return { ...current };
  }
  throw new Error("Forge MCP config field 'mcpServers' must be an object");
}
function resolveSignetMcp() {
  if (process.platform !== "win32") {
    return { command: "signet-mcp", args: [] };
  }
  const cliEntry = process.argv[1] || "";
  const mcpJs = join4(cliEntry, "..", "..", "dist", "mcp-stdio.js");
  if (existsSync2(mcpJs)) {
    return { command: process.execPath, args: [mcpJs] };
  }
  console.warn(`[signet] Warning: could not resolve mcp-stdio.js from argv[1]="${cliEntry}". MCP server config will use "signet-mcp" which may fail on Windows without shell:true.`);
  return { command: "signet-mcp", args: [] };
}
function buildMcpServer(basePath) {
  const mcp = resolveSignetMcp();
  return {
    command: mcp.command,
    ...mcp.args.length > 0 ? { args: mcp.args } : {},
    env: {
      SIGNET_PATH: basePath
    }
  };
}

class ForgeConnector extends BaseConnector {
  name = "ForgeCode";
  harnessId = "forge";
  getForgeHome() {
    return join4(getHomeDir(), "forge");
  }
  getAgentsPath() {
    return join4(this.getForgeHome(), "AGENTS.md");
  }
  getSkillsPath() {
    return join4(this.getForgeHome(), "skills");
  }
  getMcpConfigPath() {
    return join4(this.getForgeHome(), ".mcp.json");
  }
  getConfigPath() {
    return this.getMcpConfigPath();
  }
  async install(basePath) {
    const filesWritten = [];
    const configsPatched = [];
    const expandedBasePath = expandHome(basePath || join4(getHomeDir(), ".agents"));
    if (!hasValidIdentity(expandedBasePath)) {
      return {
        success: false,
        message: `No valid Signet identity found at ${expandedBasePath}`,
        filesWritten,
        configsPatched
      };
    }
    const mcpPath = this.getMcpConfigPath();
    let config;
    try {
      config = readJsonObject(mcpPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return {
        success: false,
        message: `Failed to read Forge MCP config: ${message}`,
        filesWritten,
        configsPatched
      };
    }
    try {
      const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
      if (strippedAgentsPath !== null) {
        filesWritten.push(strippedAgentsPath);
      }
      const forgeHome = this.getForgeHome();
      mkdirSync(forgeHome, { recursive: true });
      const agentsPath = this.generateAgentsMd(expandedBasePath);
      filesWritten.push(agentsPath);
      this.registerMcpServer(config, expandedBasePath);
      atomicWriteJson(mcpPath, config);
      configsPatched.push(mcpPath);
      const skillsSource = join4(expandedBasePath, "skills");
      if (existsSync2(skillsSource)) {
        this.symlinkSkills(skillsSource, this.getSkillsPath());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return {
        success: false,
        message: `ForgeCode integration install failed: ${message}`,
        filesWritten,
        configsPatched
      };
    }
    return {
      success: true,
      message: "ForgeCode integration installed successfully",
      filesWritten,
      configsPatched
    };
  }
  async uninstall() {
    const filesRemoved = [];
    const configsPatched = [];
    const agentsPath = this.getAgentsPath();
    if (existsSync2(agentsPath)) {
      const content = readFileSync2(agentsPath, "utf-8");
      if (content.includes(SIGNET_FORGE_MARKER)) {
        rmSync(agentsPath, { force: true });
        filesRemoved.push(agentsPath);
      }
    }
    const mcpPath = this.getMcpConfigPath();
    let config = {};
    if (existsSync2(mcpPath)) {
      try {
        config = readJsonObject(mcpPath);
      } catch {}
    }
    const signetPath = this.extractSignetPath(config);
    this.removeSkillSymlinks(filesRemoved, signetPath);
    if (Object.keys(config).length > 0) {
      try {
        const patched = this.removeMcpServer(config);
        if (patched) {
          if (Object.keys(config).length === 0) {
            rmSync(mcpPath, { force: true });
            filesRemoved.push(mcpPath);
          } else {
            atomicWriteJson(mcpPath, config);
            configsPatched.push(mcpPath);
          }
        }
      } catch {}
    }
    return { filesRemoved, configsPatched };
  }
  isInstalled() {
    if (existsSync2(this.getAgentsPath())) {
      try {
        const content = readFileSync2(this.getAgentsPath(), "utf-8");
        if (content.includes(SIGNET_FORGE_MARKER)) {
          return true;
        }
      } catch {}
    }
    try {
      const config = readJsonObject(this.getMcpConfigPath());
      const servers = readMcpServers(config);
      return "signet" in servers;
    } catch {
      return false;
    }
  }
  extractSignetPath(config) {
    const servers = config.mcpServers;
    if (!isJsonObject(servers))
      return null;
    const signet = servers.signet;
    if (!isJsonObject(signet))
      return null;
    const env = signet.env;
    if (!isJsonObject(env))
      return null;
    const path = env.SIGNET_PATH;
    return typeof path === "string" && path.length > 0 ? path : null;
  }
  removeSkillSymlinks(filesRemoved, signetPath) {
    const skillsDir = this.getSkillsPath();
    if (!existsSync2(skillsDir))
      return;
    const source = signetPath ?? join4(getHomeDir(), ".agents");
    const signetSkillsSource = join4(source, "skills");
    try {
      for (const entry of readdirSync(skillsDir)) {
        const target = join4(skillsDir, entry);
        if (!lstatSync2(target).isSymbolicLink())
          continue;
        const linkTarget = readlinkSync(target);
        const resolved = isAbsolute(linkTarget) ? linkTarget : resolve2(skillsDir, linkTarget);
        const rel = relative(signetSkillsSource, resolved);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
          continue;
        unlinkSync3(target);
        filesRemoved.push(target);
      }
      if (readdirSync(skillsDir).length === 0) {
        rmSync(skillsDir, { force: true });
      }
    } catch {}
  }
  generateAgentsMd(basePath) {
    const sourcePath = join4(basePath, "AGENTS.md");
    const targetPath = this.getAgentsPath();
    const content = readFileSync2(sourcePath, "utf-8").trim();
    const extras = this.composeIdentityExtras(basePath);
    const body = extras ? `${content}${extras}` : content;
    writeFileSync2(targetPath, `# ${SIGNET_FORGE_MARKER}
${this.generateHeader(sourcePath, this.name)}${body}
`, "utf-8");
    return targetPath;
  }
  registerMcpServer(config, basePath) {
    const servers = readMcpServers(config);
    servers.signet = buildMcpServer(basePath);
    config.mcpServers = servers;
  }
  removeMcpServer(config) {
    const servers = readMcpServers(config);
    if (!("signet" in servers)) {
      return false;
    }
    Reflect.deleteProperty(servers, "signet");
    if (Object.keys(servers).length === 0) {
      Reflect.deleteProperty(config, "mcpServers");
      return true;
    }
    config.mcpServers = servers;
    return true;
  }
}
export {
  ForgeConnector
};
